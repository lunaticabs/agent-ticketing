/**
 * Delegated authorization (P2 / M5).
 *
 * Deliberately NOT `user.role = 'vip'`. A role is permanent, unscoped, and
 * invisible in the audit trail. What we want is the thing the concept doc calls
 * for: a scoped, expiring, revocable record that says *what* someone may do,
 * *where*, and *until when* — and that decays on its own.
 *
 * Two scopes:
 *   `vip:skip_queue`  — front of the draw regardless of arrival
 *   `mentor:+N`       — may bring N additional people in, raising this human's
 *                       inbound allowance for the event
 *
 * Every check goes through `activeGrant()`, which re-evaluates expiry and
 * revocation at the moment of use. A cached boolean would let a revoked grant
 * keep working, which is exactly the failure mode revocation exists to prevent.
 */
import { getDb, nowMs } from './db';
import { newId } from './ids';
import { audit } from './audit';
import { PresenceError } from './errors';

export type GrantScope = 'mentor:+1' | 'mentor:+3' | 'mentor:+5' | 'vip:skip_queue';

export interface GrantRow {
  id: string;
  event_id: string;
  grantee_continuity_id: string;
  scope: GrantScope;
  issued_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  note: string | null;
}

export function issueGrant(input: {
  eventId: string;
  granteeContinuityId: string;
  scope: GrantScope;
  ttlSec?: number | null;
  note?: string;
}): GrantRow {
  const id = newId('grant');
  const issuedAt = nowMs();
  const expiresAt = input.ttlSec == null ? null : issuedAt + input.ttlSec * 1000;

  getDb()
    .prepare(
      `INSERT INTO grant_ (id, event_id, grantee_continuity_id, scope, issued_at, expires_at, note)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      input.eventId,
      input.granteeContinuityId,
      input.scope,
      issuedAt,
      expiresAt,
      input.note ?? null,
    );

  audit({
    type: 'grant.issued',
    continuityId: input.granteeContinuityId,
    eventId: input.eventId,
    payload: { grantId: id, scope: input.scope, expiresAt },
  });

  return getDb().prepare(`SELECT * FROM grant_ WHERE id = ?`).get(id) as GrantRow;
}

export function revokeGrant(id: string): GrantRow {
  const grant = getGrant(id);
  if (!grant) throw new PresenceError('grant_not_found', `no grant ${id}`);
  const at = nowMs();
  getDb().prepare(`UPDATE grant_ SET revoked_at = ? WHERE id = ?`).run(at, id);
  audit({
    type: 'grant.revoked',
    continuityId: grant.grantee_continuity_id,
    eventId: grant.event_id,
    payload: { grantId: id, scope: grant.scope },
  });
  return getGrant(id)!;
}

export function getGrant(id: string): GrantRow | undefined {
  return getDb().prepare(`SELECT * FROM grant_ WHERE id = ?`).get(id) as GrantRow | undefined;
}

export function listGrants(eventId?: string): GrantRow[] {
  if (eventId) {
    return getDb()
      .prepare(`SELECT * FROM grant_ WHERE event_id = ? ORDER BY issued_at DESC`)
      .all(eventId) as GrantRow[];
  }
  return getDb().prepare(`SELECT * FROM grant_ ORDER BY issued_at DESC`).all() as GrantRow[];
}

/**
 * T-5.1 acceptance — expired and revoked grants stop working immediately, with
 * no cache to invalidate because there is no cache.
 */
export function activeGrant(
  continuityId: string,
  eventId: string,
  scope: GrantScope,
): GrantRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM grant_
        WHERE grantee_continuity_id = ? AND event_id = ? AND scope = ?
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY issued_at DESC
        LIMIT 1`,
    )
    .get(continuityId, eventId, scope, nowMs()) as GrantRow | undefined;
}

export function activeGrants(continuityId: string, eventId: string): GrantRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM grant_
        WHERE grantee_continuity_id = ? AND event_id = ?
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY issued_at DESC`,
    )
    .all(continuityId, eventId, nowMs()) as GrantRow[];
}

/**
 * How many extra inbound transfers a mentor grant buys. Added on top of the
 * event's `transfer_inbound_cap`; it raises the ceiling for that one human
 * without touching anyone else's.
 */
export function mentorAllowance(continuityId: string, eventId: string): number {
  return activeGrants(continuityId, eventId)
    .filter((g) => g.scope.startsWith('mentor:+'))
    .reduce((sum, g) => sum + Number(g.scope.split('+')[1] ?? 0), 0);
}

export function describeScope(scope: GrantScope): string {
  switch (scope) {
    case 'vip:skip_queue':
      return 'Front of the draw, regardless of arrival time';
    case 'mentor:+1':
      return 'May bring 1 additional person in';
    case 'mentor:+3':
      return 'May bring 3 additional people in';
    case 'mentor:+5':
      return 'May bring 5 additional people in';
  }
}
