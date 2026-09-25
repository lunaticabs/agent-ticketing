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

export interface AuditInput {
  type: string;
  continuityId?: string | null;
  eventId?: string | null;
  slotId?: string | null;
  severity?: AuditSeverity;
  payload?: Record<string, unknown>;
  at?: number;
}

export function audit(input: AuditInput): void {
  getDb()
    .prepare(
      `INSERT INTO audit_event (id, continuity_id, event_id, slot_id, type, severity, payload, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId('aud'),
      input.continuityId ?? null,
      input.eventId ?? null,
      input.slotId ?? null,
      input.type,
      input.severity ?? 'info',
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
  payload: string;
  at: number;
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
