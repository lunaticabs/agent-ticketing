/**
 * Humans and events: the two nouns everything else hangs off.
 */
import { getDb, nowMs } from './db';
import { newId } from './ids';
import { continuityIdFrom } from '../worldid/nullifier';

export interface HumanRow {
  continuity_id: string;
  issuer: string;
  subject: string;
  created_at: number;
  last_fresh_auth_at: number | null;
}

/**
 * Idempotent identity linking.
 *
 * T-0.4 acceptance: the same human authenticating twice must resolve to the
 * same continuity id, and a different human must not. The `(issuer, subject)`
 * UNIQUE constraint makes the "same" half a database guarantee rather than a
 * code path — a race between two simultaneous first logins cannot mint two rows.
 */
export function ensureHuman(issuer: string, subject: string): HumanRow {
  const continuityId = continuityIdFrom(issuer, subject);
  const db = getDb();
  db.prepare(
    `INSERT INTO human (continuity_id, issuer, subject, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (issuer, subject) DO NOTHING`,
  ).run(continuityId, issuer, subject, nowMs());

  const row = db
    .prepare(`SELECT * FROM human WHERE issuer = ? AND subject = ?`)
    .get(issuer, subject) as HumanRow | undefined;
  if (!row) throw new Error('failed to link human');
  return row;
}

export function getHuman(continuityId: string): HumanRow | undefined {
  return getDb().prepare(`SELECT * FROM human WHERE continuity_id = ?`).get(continuityId) as
    | HumanRow
    | undefined;
}

/**
 * Record that this human just proved presence. Used for the "last seen" column
 * on the board, never as a substitute for a per-action freshness check.
 */
export function touchFreshAuth(continuityId: string, authTimeMs: number): void {
  getDb()
    .prepare(
      `UPDATE human
          SET last_fresh_auth_at = MAX(COALESCE(last_fresh_auth_at, 0), ?)
        WHERE continuity_id = ?`,
    )
    .run(authTimeMs, continuityId);
}

/** Dev-only: create a human row directly. See `lib/devmode.ts` for the gate. */
export function ensureSyntheticHuman(handle: string): HumanRow {
  return ensureHuman('local:dev-impersonation', handle);
}

// ── Events ──────────────────────────────────────────────────────────────────

export type LotteryMode = 'lottery' | 'fcfs';

export interface EventRow {
  id: string;
  name: string;
  total_slots: number;
  approval_window_sec: number;
  lottery_window_sec: number;
  lottery_mode: LotteryMode;
  lottery_drawn_at: number | null;
  lottery_seed: string | null;
  created_at: number;
}

export function getEvent(id: string): EventRow | undefined {
  return getDb().prepare(`SELECT * FROM event WHERE id = ?`).get(id) as EventRow | undefined;
}

export function listEvents(): EventRow[] {
  return getDb().prepare(`SELECT * FROM event ORDER BY created_at DESC`).all() as EventRow[];
}

/** The demo has exactly one event; this keeps the UI from having to know its id. */
export function primaryEvent(): EventRow {
  const events = listEvents();
  if (!events.length) throw new Error('no event seeded — run `npm run seed`');
  return events[0];
}

export function updateEvent(
  id: string,
  patch: Partial<
    Pick<
      EventRow,
      | 'name'
      | 'approval_window_sec'
      | 'lottery_window_sec'
      | 'lottery_mode'
      | 'total_slots'
    >
  >,
): EventRow {
  const current = getEvent(id);
  if (!current) throw new Error(`unknown event ${id}`);
  const next = { ...current, ...patch };
  getDb()
    .prepare(
      `UPDATE event
          SET name = ?, approval_window_sec = ?, lottery_window_sec = ?,
              lottery_mode = ?, total_slots = ?
        WHERE id = ?`,
    )
    .run(
      next.name,
      next.approval_window_sec,
      next.lottery_window_sec,
      next.lottery_mode,
      next.total_slots,
      id,
    );
  return getEvent(id)!;
}

export function createEvent(input: {
  id: string;
  name: string;
  totalSlots: number;
  approvalWindowSec?: number;
  lotteryWindowSec?: number;
  lotteryMode?: LotteryMode;
}): EventRow {
  getDb()
    .prepare(
      `INSERT INTO event
         (id, name, total_slots, approval_window_sec, lottery_window_sec,
          lottery_mode, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      input.id,
      input.name,
      input.totalSlots,
      input.approvalWindowSec ?? 120,
      input.lotteryWindowSec ?? 600,
      input.lotteryMode ?? 'lottery',
      nowMs(),
    );
  return getEvent(input.id)!;
}

export function newEventId(name: string): string {
  return `evt_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}_${newId('').slice(1, 5)}`;
}
