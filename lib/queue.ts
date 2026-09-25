/**
 * ============================================================================
 *  The queue: join, then DRAW — never "first to arrive wins"
 * ============================================================================
 *
 * RED LINE 10: "抽签必须与到达顺序无关".
 *
 * The reasoning is in the concept doc and it is worth restating in code,
 * because the naive implementation looks fine and is not:
 *
 *   Uniqueness is necessary but not sufficient. World ID removes "one script,
 *   500 tickets", but a single scalper with one identity and a faster client
 *   still wins every FCFS queue. Uniqueness ∩ speed-race = the fast player
 *   takes everything. The fix is that everyone who arrives inside the window
 *   gets the *same* odds, so speed buys nothing.
 *
 * So the ordering key is `sha256(drawSeed || entryId)` with a seed generated at
 * settlement time. It cannot depend on `joined_at` because `joined_at` is not
 * an input, and the seed does not exist until the window has closed. The
 * `fcfs` mode is kept only as the on-stage control group (T-6.3): flip it,
 * run the same bot script, and watch the speed advantage come back.
 */
import { getDb, nowMs, tx } from './db';
import { newId, randomToken, sha256Hex } from './ids';
import { audit } from './audit';
import { PresenceError } from './errors';
import { getEvent, type EventRow } from './humans';
import { activeGrant } from './grants';

export interface QueueEntryRow {
  id: string;
  event_id: string;
  continuity_id: string;
  joined_at: number;
  seq: number;
  lottery_drawn_at: number | null;
  lottery_rank: number | null;
  allocated_at: number | null;
}

function nextSeq(eventId: string): number {
  const row = getDb()
    .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM queue_entry WHERE event_id = ?`)
    .get(eventId) as { n: number };
  return row.n;
}

export interface JoinResult {
  entry: QueueEntryRow;
  created: boolean;
  queuePosition: number;
  vip: boolean;
}

/**
 * T-1.1 — join the queue as a verified human.
 *
 * Idempotent by `UNIQUE (event_id, continuity_id)`: a second call returns the
 * existing entry instead of stacking duplicate rows, because otherwise a user
 * who refreshes the page would improve their odds.
 */
export function joinQueue(
  eventId: string,
  continuityId: string,
  actor: 'human' | 'agent' = 'human',
): JoinResult {
  const event = getEvent(eventId);
  if (!event) throw new PresenceError('event_not_found', `no event ${eventId}`);

  const existing = getDb()
    .prepare(`SELECT * FROM queue_entry WHERE event_id = ? AND continuity_id = ?`)
    .get(eventId, continuityId) as QueueEntryRow | undefined;

  if (existing) {
    return {
      entry: existing,
      created: false,
      queuePosition: queuePosition(existing),
      vip: Boolean(activeGrant(continuityId, eventId, 'vip:skip_queue')),
    };
  }

  if (event.lottery_drawn_at !== null) {
    throw new PresenceError('queue_closed', 'the draw for this event has already been settled', {
      invariant: 'RED LINE 10 — the window closes before the draw, so late arrivals cannot matter',
      details: { eventId, drawnAt: event.lottery_drawn_at },
      hint:
        'The window is closed for this event. An organiser can open a new one from ' +
        '/admin — "Reset demo state" clears the draw and starts a fresh window.',
    });
  }

  return tx((db) => {
    const entry: QueueEntryRow = {
      id: newId('q'),
      event_id: eventId,
      continuity_id: continuityId,
      joined_at: nowMs(),
      seq: nextSeq(eventId),
      lottery_drawn_at: null,
      lottery_rank: null,
      allocated_at: null,
    };
    db.prepare(
      `INSERT INTO queue_entry (id, event_id, continuity_id, joined_at, seq)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(entry.id, entry.event_id, entry.continuity_id, entry.joined_at, entry.seq);

    audit({
      type: 'queue.joined',
      continuityId,
      eventId,
      actor,
      payload: { seq: entry.seq, mode: event.lottery_mode },
    });

    return {
      entry,
      created: true,
      queuePosition: queuePosition(entry),
      vip: Boolean(activeGrant(continuityId, eventId, 'vip:skip_queue')),
    };
  });
}

export function queuePosition(entry: QueueEntryRow): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) + 1 AS n FROM queue_entry WHERE event_id = ? AND seq < ?`)
    .get(entry.event_id, entry.seq) as { n: number };
  return row.n;
}

export function queueLength(eventId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM queue_entry WHERE event_id = ?`)
    .get(eventId) as { n: number };
  return row.n;
}

export function listQueue(eventId: string): QueueEntryRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM queue_entry WHERE event_id = ?
        ORDER BY COALESCE(lottery_rank, 999999), seq`,
    )
    .all(eventId) as QueueEntryRow[];
}

export function myEntry(eventId: string, continuityId: string): QueueEntryRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM queue_entry WHERE event_id = ? AND continuity_id = ?`)
    .get(eventId, continuityId) as QueueEntryRow | undefined;
}

// ── The draw ────────────────────────────────────────────────────────────────

export interface DrawResult {
  alreadyDrawn: boolean;
  mode: EventRow['lottery_mode'];
  seed: string | null;
  order: { entryId: string; continuityId: string; rank: number }[];
}

/**
 * T-2.1 — settle the draw.
 *
 * Runs once. Everything that can favour one entrant over another is decided
 * here, and none of the inputs are arrival time (except in the deliberate
 * `fcfs` control mode).
 */
export function settleLottery(eventId: string): DrawResult {
  return tx((db) => {
    const event = getEvent(eventId);
    if (!event) throw new PresenceError('event_not_found', `no event ${eventId}`);

    if (event.lottery_drawn_at !== null) {
      const existing = listQueue(eventId).map((e) => ({
        entryId: e.id,
        continuityId: e.continuity_id,
        rank: e.lottery_rank ?? 0,
      }));
      return {
        alreadyDrawn: true,
        mode: event.lottery_mode,
        seed: event.lottery_seed,
        order: existing,
      };
    }

    const entries = db
      .prepare(`SELECT * FROM queue_entry WHERE event_id = ?`)
      .all(eventId) as QueueEntryRow[];

    const seed = randomToken(16);
    const now = nowMs();

    // VIP grants jump the queue. A grant is a scoped, expiring record — not a
    // boolean `is_vip` column — so it is re-checked here rather than trusted.
    const vips = new Set(
      entries
        .filter((e) => activeGrant(e.continuity_id, eventId, 'vip:skip_queue'))
        .map((e) => e.id),
    );

    const ordered = [...entries].sort((a, b) => {
      const av = vips.has(a.id) ? 0 : 1;
      const bv = vips.has(b.id) ? 0 : 1;
      if (av !== bv) return av - bv;
      return drawKey(event.lottery_mode, seed, a) < drawKey(event.lottery_mode, seed, b) ? -1 : 1;
    });

    const order = ordered.map((entry, index) => {
      const rank = index + 1;
      db.prepare(
        `UPDATE queue_entry SET lottery_rank = ?, lottery_drawn_at = ? WHERE id = ?`,
      ).run(rank, now, entry.id);
      return { entryId: entry.id, continuityId: entry.continuity_id, rank };
    });

    db.prepare(`UPDATE event SET lottery_drawn_at = ?, lottery_seed = ? WHERE id = ?`).run(
      now,
      seed,
      eventId,
    );

    audit({
      type: 'lottery.settled',
      eventId,
      severity: 'info',
      payload: {
        mode: event.lottery_mode,
        seed,
        entrants: entries.length,
        // Deliberately included so anyone can recompute the order and see that
        // `joined_at` is not part of it.
        note: 'order = sha256(seed || entryId); joined_at is not an input',
      },
    });

    return { alreadyDrawn: false, mode: event.lottery_mode, seed, order };
  });
}

function drawKey(mode: EventRow['lottery_mode'], seed: string, entry: QueueEntryRow): string {
  if (mode === 'fcfs') {
    // Control group only. Padded so string comparison equals numeric order.
    return String(entry.seq).padStart(12, '0');
  }
  return sha256Hex(`${seed}|${entry.id}`);
}

/**
 * Recompute the draw order for a settled event. Used by the board's
 * "verify the draw was fair" panel and by the statistical test in
 * `tests/invariants.test.ts`.
 */
export function recomputeDrawOrder(eventId: string): { entryId: string; rank: number; key: string }[] {
  const event = getEvent(eventId);
  if (!event || !event.lottery_seed) return [];
  const entries = listQueue(eventId);
  const withKeys = entries.map((e) => ({
    entryId: e.id,
    key: drawKey(event.lottery_mode, event.lottery_seed!, e),
  }));
  withKeys.sort((a, b) => (a.key < b.key ? -1 : 1));
  return withKeys.map((e, i) => ({ ...e, rank: i + 1 }));
}

export function queueStats(eventId: string) {
  const entries = listQueue(eventId);
  return {
    total: entries.length,
    drawn: entries.filter((e) => e.lottery_rank !== null).length,
    allocated: entries.filter((e) => e.allocated_at !== null).length,
    waiting: entries.filter((e) => e.lottery_rank !== null && e.allocated_at === null).length,
  };
}

/** Exposed for tests that need to prove the draw ignores arrival order. */
export { drawKey as _drawKey };

/** Small helper so tests can seed an entry without going through the API. */
export function _insertEntryRaw(eventId: string, continuityId: string, seq: number): string {
  const id = newId('q');
  getDb()
    .prepare(
      `INSERT INTO queue_entry (id, event_id, continuity_id, joined_at, seq) VALUES (?,?,?,?,?)`,
    )
    .run(id, eventId, continuityId, nowMs(), seq);
  return id;
}
