/**
 * ============================================================================
 *  Slot state machine — allocation, expiry, and DEFERRAL
 * ============================================================================
 *
 *   AVAILABLE  → ALLOCATED         draw hands it over, deadline written
 *   ALLOCATED  → CONFIRMED         purchase proof verified, nullifier consumed
 *   ALLOCATED  → EXPIRED           deadline passed → defer to the next candidate
 *   CONFIRMED                      terminal — slots are locked to their holder
 *
 * ---------------------------------------------------------------------------
 *  Deferral is a FEATURE, not error handling
 * ---------------------------------------------------------------------------
 * "名额顺延" is the product. A window that closes and hands the slot to the next
 * human is what stops a queue from stalling behind somebody who walked away: the
 * draw keeps moving, and a slot is never held by an absent person. If the window
 * merely errored out, the event would deadlock on its first no-show.
 *
 * Two invariants fall out of the implementation and are tested explicitly:
 *
 *   * A deferred candidate can never buy that slot afterwards, even holding a
 *     valid proof — the "next candidate" pointer has already moved past them,
 *     and `queue_entry.allocated_at` marks them served.
 *   * The draw is not re-run on deferral. It walks forward through the existing
 *     ranks, so deferring cannot be gamed by timing an expiry.
 *
 * `sweep()` is called at the top of every read and every write. There is no
 * background timer to get out of sync with the clock, and no cron to forget to
 * start: the state you read is always the state as of now.
 */
import { getDb, nowMs, tx } from './db';
import { audit } from './audit';
import { PresenceError } from './errors';
import { getEvent, type EventRow } from './humans';
import { activeGrant } from './grants';
// One-way dependency: queue.ts knows nothing about slots.
import { settleLottery } from './queue';

export type SlotState =
  | 'AVAILABLE'
  | 'ALLOCATED'
  | 'CONFIRMED'
  | 'EXPIRED';

export interface SlotRow {
  id: string;
  event_id: string;
  state: SlotState;
  holder_continuity_id: string | null;
  approval_deadline: number | null;
  deferral_count: number;
  created_at: number;
  updated_at: number;
}

export function getSlot(id: string): SlotRow | undefined {
  return getDb().prepare(`SELECT * FROM slot WHERE id = ?`).get(id) as SlotRow | undefined;
}

export function listSlots(eventId: string): SlotRow[] {
  return getDb()
    .prepare(`SELECT * FROM slot WHERE event_id = ? ORDER BY created_at, id`)
    .all(eventId) as SlotRow[];
}

export function ensureSlots(eventId: string, count: number): number {
  const existing = listSlots(eventId).length;
  if (existing >= count) return 0;
  const now = nowMs();
  const insert = getDb().prepare(
    `INSERT INTO slot (id, event_id, state, created_at, updated_at) VALUES (?, ?, 'AVAILABLE', ?, ?)`,
  );
  const make = getDb().transaction((n: number) => {
    for (let i = 0; i < n; i += 1) {
      insert.run(`slot_${eventId.replace(/^evt_/, '')}_${existing + i + 1}`, eventId, now, now);
    }
  });
  make(count - existing);
  return count - existing;
}

// ── Allocation ──────────────────────────────────────────────────────────────

export interface AllocationEvent {
  slotId: string;
  continuityId: string;
  deadline: number;
  rank: number | null;
}

/**
 * Hand every AVAILABLE slot to the next unserved candidate in draw order.
 *
 * Called after a draw, after a deferral, and after any config change that frees
 * capacity. Idempotent: slots that are not AVAILABLE are left alone.
 */
export function allocateAvailable(eventId: string): AllocationEvent[] {
  return tx((db) => {
    const event = getEvent(eventId);
    if (!event) throw new PresenceError('event_not_found', `no event ${eventId}`);

    // `total_slots` is the event's capacity and it must bound allocations, even
    // when more slot ROWS exist than the event declares. They can diverge — the
    // demo props call `ensureSlots` to build inventory for the laundering
    // simulation, and an earlier version of this function happily allocated all
    // of it, which quietly broke the T-2.2 invariant and made the speed-contrast
    // statistics meaningless (41 slots "filled" in a 24-slot event).
    const committed = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM slot
            WHERE event_id = ? AND state IN ('ALLOCATED','CONFIRMED')`,
        )
        .get(eventId) as { n: number }
    ).n;
    const budget = Math.max(0, event.total_slots - committed);
    if (budget === 0) return [];

    const free = db
      .prepare(
        `SELECT * FROM slot WHERE event_id = ? AND state = 'AVAILABLE'
          ORDER BY created_at, id LIMIT ?`,
      )
      .all(eventId, budget) as SlotRow[];
    if (!free.length) return [];

    const granted: AllocationEvent[] = [];
    const now = nowMs();

    for (const slot of free) {
      const candidate = nextCandidate(eventId);
      if (!candidate) break;

      const deadline = now + event.approval_window_sec * 1000;
      db.prepare(
        `UPDATE slot
            SET state = 'ALLOCATED', holder_continuity_id = ?,
                approval_deadline = ?, updated_at = ?
          WHERE id = ? AND state = 'AVAILABLE'`,
      ).run(candidate.continuity_id, deadline, now, slot.id);

      db.prepare(`UPDATE queue_entry SET allocated_at = ? WHERE id = ?`).run(now, candidate.id);

      audit({
        type: 'slot.allocated',
        continuityId: candidate.continuity_id,
        eventId,
        slotId: slot.id,
        payload: {
          deadline,
          approvalWindowSec: event.approval_window_sec,
          lotteryRank: candidate.lottery_rank,
          queueEntryId: candidate.id,
        },
      });

      granted.push({
        slotId: slot.id,
        continuityId: candidate.continuity_id,
        deadline,
        rank: candidate.lottery_rank,
      });
    }

    return granted;
  });
}

interface CandidateRow {
  id: string;
  continuity_id: string;
  lottery_rank: number | null;
}

/**
 * The next human in draw order who has not already been served.
 *
 * `allocated_at IS NULL` is what makes deferral move forward. Without it, a
 * candidate whose window expired would be picked again on the very next sweep
 * and the slot would loop forever — the classic off-by-one in this design.
 */
function nextCandidate(eventId: string): CandidateRow | undefined {
  return getDb()
    .prepare(
      `SELECT id, continuity_id, lottery_rank
         FROM queue_entry
        WHERE event_id = ?
          AND lottery_rank IS NOT NULL
          AND allocated_at IS NULL
        ORDER BY lottery_rank ASC
        LIMIT 1`,
    )
    .get(eventId) as CandidateRow | undefined;
}

export function nextCandidatePreview(eventId: string): CandidateRow | undefined {
  return nextCandidate(eventId);
}

// ── The sweeper ─────────────────────────────────────────────────────────────

export interface SweepTransition {
  kind:
    | 'lottery_settled'
    | 'approval_expired'
    | 'deferred'
    | 'reallocated'
    | 'no_candidate'
    ;
  /** Empty for `lottery_settled`, which happens before any slot is involved. */
  slotId: string;
  continuityId?: string | null;
  message: string;
  at: number;
}

/**
 * Advance every deadline that has passed.
 *
 * This is the single implementation of "time moved on". It is safe to call from
 * anywhere, as often as you like, including concurrently from two processes:
 * each transition is guarded by a conditional UPDATE that only fires if the row
 * is still in the expected state.
 */
export function sweep(eventId?: string): SweepTransition[] {
  const transitions: SweepTransition[] = [];
  const now = nowMs();

  // ── 0. Close any draw window whose time has come ──────────────────────────
  //
  // This was missing, and the omission was invisible in a specific way: the seed
  // advertises `lottery_window_sec: 15`, the board counts the window down, and
  // the `queue_closed` refusal explains that the window closes before the draw —
  // while nothing anywhere acted on the deadline. Only the /admin buttons and
  // the bot-army scripts ever called `settleLottery`. So a real participant
  // joined, watched the countdown reach zero, and then waited forever.
  //
  // Settling here rather than in a timer keeps the project's rule intact: the
  // state you read is the state as of now, with no background process to drift
  // or to forget to start.
  const windows = getDb()
    .prepare(
      `SELECT e.id, e.lottery_window_sec,
              (SELECT MIN(joined_at) FROM queue_entry q WHERE q.event_id = e.id) AS first_join,
              (SELECT COUNT(*) FROM queue_entry q WHERE q.event_id = e.id) AS entrants
         FROM event e
        WHERE e.lottery_drawn_at IS NULL
          ${eventId ? 'AND e.id = ?' : ''}`,
    )
    .all(...(eventId ? [eventId] : [])) as {
    id: string;
    lottery_window_sec: number;
    first_join: number | null;
    entrants: number;
  }[];

  for (const window of windows) {
    // Nobody to draw. Leave the window open so a late arrival can still enter.
    if (window.first_join === null || window.entrants === 0) continue;

    // The window is measured from the first arrival, not from event creation:
    // an event seeded hours before the demo should not close before anyone
    // arrives. `lottery_window_sec: 0` means "draw as soon as somebody is in".
    const closesAt = window.first_join + Math.max(0, window.lottery_window_sec) * 1000;
    if (now < closesAt) continue;

    const draw = settleLottery(window.id);
    transitions.push({
      kind: 'lottery_settled',
      slotId: '',
      continuityId: null,
      message: `draw settled: ${draw.order.length} entrant${draw.order.length === 1 ? '' : 's'} ranked`,
      at: now,
    });
  }

  // ── 1. Approval windows on allocated slots ──
  const expired = getDb()
    .prepare(
      `SELECT * FROM slot
        WHERE state = 'ALLOCATED' AND approval_deadline IS NOT NULL AND approval_deadline <= ?
          ${eventId ? 'AND event_id = ?' : ''}
        ORDER BY approval_deadline`,
    )
    .all(...(eventId ? [now, eventId] : [now])) as SlotRow[];

  for (const slot of expired) {
    const outcome = tx((db) => {
      // Conditional update: if another process already moved this slot, stop.
      const changed = db
        .prepare(
          `UPDATE slot
              SET state = 'EXPIRED', approval_deadline = NULL, holder_continuity_id = NULL,
                  deferral_count = deferral_count + 1, updated_at = ?
            WHERE id = ? AND state = 'ALLOCATED'`,
        )
        .run(now, slot.id).changes;
      if (!changed) return null;

      audit({
        type: 'slot.approval_expired',
        continuityId: slot.holder_continuity_id,
        eventId: slot.event_id,
        slotId: slot.id,
        severity: 'warn',
        payload: {
          deferralCount: slot.deferral_count + 1,
          // Stated plainly so the board can show why this is a product feature.
          note: 'the human did not approve inside the window; the slot moves on',
        },
      });

      // EXPIRED is a TRANSIENT state, exactly as the state machine describes:
      // "EXPIRED (deadline 过) ──→ 回到 AVAILABLE 并顺延下一位". Record it, then
      // put the slot straight back in the pool so the allocation pass below can
      // hand it to the next candidate. Leaving it in EXPIRED would strand it —
      // the allocation pass only ever looks at AVAILABLE slots.
      db.prepare(`UPDATE slot SET state = 'AVAILABLE' WHERE id = ? AND state = 'EXPIRED'`).run(slot.id);

      return { previousHolder: slot.holder_continuity_id, eventId: slot.event_id };
    });

    if (!outcome) continue;
    transitions.push({
      kind: 'approval_expired',
      slotId: slot.id,
      continuityId: outcome.previousHolder,
      message: 'approval window closed with no decision',
      at: now,
    });

    // Hand it to the next candidate immediately, in the same sweep.
    const granted = allocateAvailable(outcome.eventId);
    const moved = granted.find((g) => g.slotId === slot.id);

    if (moved) {
      transitions.push({
        kind: 'deferred',
        slotId: slot.id,
        continuityId: moved.continuityId,
        message: `deferred to the next candidate (rank ${moved.rank ?? '?'})`,
        at: now,
      });
    } else {
      // Nobody left who is entitled to it. The slot is already back in the pool
      // (see the transient EXPIRED note above), so it simply waits.
      transitions.push({
        kind: 'no_candidate',
        slotId: slot.id,
        continuityId: null,
        message: 'returned to the pool — the draw has nobody left to serve',
        at: now,
      });
    }
  }

  // ── 3. Fill any free capacity ─────────────────────────────────────────────
  //
  // Allocation belongs here rather than at the call sites: "advance every
  // deadline that has passed" and "hand free slots to whoever is next" are the
  // same operation from the caller's point of view, and splitting them is how a
  // slot ends up sitting AVAILABLE because one code path forgot the second half.
  // This also means a slot freed by a deferral is picked up in the same pass.
  const eventIds = eventId
    ? [eventId]
    : (
        getDb()
          .prepare(`SELECT id FROM event WHERE lottery_drawn_at IS NOT NULL`)
          .all() as { id: string }[]
      ).map((r) => r.id);

  for (const id of eventIds) {
    const event = getEvent(id);
    if (!event || event.lottery_drawn_at === null) continue;
    const granted = allocateAvailable(id);
    for (const g of granted) {
      // Skip slots already reported by the deferral pass above.
      if (transitions.some((t) => t.kind === 'deferred' && t.slotId === g.slotId)) continue;
      transitions.push({
        kind: 'reallocated',
        slotId: g.slotId,
        continuityId: g.continuityId,
        message: `allocated to draw rank ${g.rank ?? '?'}`,
        at: now,
      });
    }
  }

  return transitions;
}

// ── Confirmation ────────────────────────────────────────────────────────────

/**
 * Move a slot to CONFIRMED. Must be called inside the transaction that also
 * consumes the proof, so the two commit together.
 */
export function confirmSlot(
  db: ReturnType<typeof getDb>,
  slotId: string,
  continuityId: string,
): void {
  const changed = db
    .prepare(
      `UPDATE slot
          SET state = 'CONFIRMED', holder_continuity_id = ?,
              approval_deadline = NULL, updated_at = ?
        WHERE id = ? AND state = 'ALLOCATED' AND holder_continuity_id = ?`,
    )
    .run(continuityId, nowMs(), slotId, continuityId).changes;

  if (!changed) {
    throw new PresenceError('slot_not_available', 'the slot is no longer allocated to you', {
      invariant: 'RED LINE 7/state machine — allocation is revoked the moment the window closes',
      details: { slotId, continuityId },
    });
  }
}

/** Slots currently allocated to a human. */
export function allocatedSlotsFor(eventId: string, continuityId: string): SlotRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM slot WHERE event_id = ? AND holder_continuity_id = ? AND state = 'ALLOCATED'`,
    )
    .all(eventId, continuityId) as SlotRow[];
}

export function heldSlotsFor(eventId: string, continuityId: string): SlotRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM slot
        WHERE event_id = ? AND holder_continuity_id = ?
          AND state IN ('ALLOCATED','CONFIRMED')`,
    )
    .all(eventId, continuityId) as SlotRow[];
}

/** Has this human ever been handed a slot in this event? */
export function hasBeenServed(eventId: string, continuityId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM queue_entry
        WHERE event_id = ? AND continuity_id = ? AND allocated_at IS NOT NULL`,
    )
    .get(eventId, continuityId) as { n: number };
  if (row.n > 0) return true;
  const slot = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM slot
        WHERE event_id = ? AND holder_continuity_id = ? AND state = 'CONFIRMED'`,
    )
    .get(eventId, continuityId) as { n: number };
  return slot.n > 0;
}

export function hasVipSkip(eventId: string, continuityId: string): boolean {
  return Boolean(activeGrant(continuityId, eventId, 'vip:skip_queue'));
}

export function slotSummary(eventId: string) {
  const slots = listSlots(eventId);
  const by = (s: SlotState) => slots.filter((x) => x.state === s).length;
  return {
    total: slots.length,
    available: by('AVAILABLE'),
    allocated: by('ALLOCATED'),
    confirmed: by('CONFIRMED'),
    deferrals: slots.reduce((sum, s) => sum + s.deferral_count, 0),
  };
}
