/**
 * Audit log.
 *
 * Every entry is filed under a continuity_id, never under an account id or a
 * session id. This is what makes the trail survive an account swap: the same
 * human laundering tickets through 40 accounts still produces one timeline.
 */
import { newId } from './ids';
import { getDb, nowMs } from './db';

export type AuditSeverity = 'info' | 'warn' | 'alert';

/**
 * Who performed the action.
 *
 * `human` is a person in a browser; `agent` is a program holding that person's
 * delegated credential; `system` is the server acting on a deadline. The
 * distinction is the whole claim of the project, so it is recorded at the point
 * of action rather than reconstructed from the transport afterwards.
 */
export type Actor = 'human' | 'agent' | 'system';

export interface AuditInput {
  type: string;
  continuityId?: string | null;
  eventId?: string | null;
  slotId?: string | null;
  severity?: AuditSeverity;
  actor?: Actor;
  payload?: Record<string, unknown>;
  at?: number;
}

export function audit(input: AuditInput): void {
  getDb()
    .prepare(
      `INSERT INTO audit_event
         (id, continuity_id, event_id, slot_id, type, severity, actor, payload, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId('aud'),
      input.continuityId ?? null,
      input.eventId ?? null,
      input.slotId ?? null,
      input.type,
      input.severity ?? 'info',
      input.actor ?? 'system',
      JSON.stringify(input.payload ?? {}),
      input.at ?? nowMs(),
    );
}

export interface AuditRow {
  id: string;
  continuity_id: string | null;
  event_id: string | null;
  slot_id: string | null;
  type: string;
  severity: AuditSeverity;
  actor: Actor;
  payload: string;
  at: number;
}

/** How much of the event was driven by agents rather than by people. */
export function actorTally(eventId?: string): { human: number; agent: number; system: number } {
  const rows = getDb()
    .prepare(
      `SELECT actor, COUNT(*) AS n FROM audit_event
        ${eventId ? 'WHERE event_id = ?' : ''}
        GROUP BY actor`,
    )
    .all(...(eventId ? [eventId] : [])) as { actor: Actor; n: number }[];
  const tally = { human: 0, agent: 0, system: 0 };
  for (const row of rows) tally[row.actor] = row.n;
  return tally;
}

export function recentAudit(limit = 60, eventId?: string): AuditRow[] {
  if (eventId) {
    return getDb()
      .prepare(`SELECT * FROM audit_event WHERE event_id = ? ORDER BY at DESC, rowid DESC LIMIT ?`)
      .all(eventId, limit) as AuditRow[];
  }
  return getDb()
    .prepare(`SELECT * FROM audit_event ORDER BY at DESC, rowid DESC LIMIT ?`)
    .all(limit) as AuditRow[];
}

/**
 * Roll-up used by the board: "how many times has this human received a slot in
 * this event, across every account they touched".
 */
export function auditCountByHuman(eventId: string): { continuity_id: string; n: number }[] {
  return getDb()
    .prepare(
      `SELECT continuity_id, COUNT(*) AS n
         FROM audit_event
        WHERE event_id = ? AND continuity_id IS NOT NULL
        GROUP BY continuity_id
        ORDER BY n DESC`,
    )
    .all(eventId) as { continuity_id: string; n: number }[];
}
