/**
 * ============================================================================
 *  Approvals — the business-level record of "a human authorized this operation"
 * ============================================================================
 *
 * An `approval` is not a boolean and not a session flag. It is a row that binds
 * one specific operation `(action, signal)` to one human, with a lifetime and a
 * lifecycle, and it records the four stages T-3.3 has to make observable:
 *
 *   1. `requested_at`  the request was issued to the human
 *   2. `completed_at`  the human finished on their own device (IdP confirms)
 *   3. `verified_at`   the SERVER re-verified the proof for this operation
 *   4. `executed_at`   the protected action actually ran
 *
 * Stage 3 is the one the track's rule 4 is about. Stages 2 and 3 are separate
 * on purpose: a client saying "I finished" moves nothing. Only the server's own
 * exchange with the IdP advances the record, and only the gate advances it past
 * stage 3.
 *
 * The underlying World ID interaction lives in `worldid/`; this module never
 * touches OIDC, tokens, or endpoints. That separation is what lets the sandbox
 * integration details change without touching a single business rule.
 */
import { getDb, nowMs } from './db';
import { newId } from './ids';
import { audit } from './audit';
import { PresenceError, type ReasonCode } from './errors';
import * as worldid from '../worldid';

export type ApprovalKind = 'purchase';
export type ApprovalState = 'PENDING' | 'APPROVED' | 'CONSUMED' | 'DENIED' | 'EXPIRED';

export interface ApprovalRow {
  id: string;
  kind: ApprovalKind;
  bound_action: string;
  bound_signal: string;
  continuity_id: string;
  event_id: string | null;
  slot_id: string | null;
  nonce: string;
  request_id: string;
  state: ApprovalState;
  proof_ref: string | null;
  nullifier: string | null;
  auth_time: number | null;
  fail_reason: string | null;
  requested_via: 'human' | 'agent';
  requested_at: number;
  completed_at: number | null;
  verified_at: number | null;
  executed_at: number | null;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
  consumed_at: number | null;
}

export function getApproval(id: string): ApprovalRow | undefined {
  return getDb().prepare(`SELECT * FROM approval WHERE id = ?`).get(id) as ApprovalRow | undefined;
}

export function listApprovals(opts: { eventId?: string; limit?: number; continuityId?: string } = {}): ApprovalRow[] {
  const limit = opts.limit ?? 25;
  if (opts.eventId && opts.continuityId) {
    return getDb()
      .prepare(
        `SELECT * FROM approval WHERE event_id = ? AND continuity_id = ?
          ORDER BY requested_at DESC LIMIT ?`,
      )
      .all(opts.eventId, opts.continuityId, limit) as ApprovalRow[];
  }
  if (opts.eventId) {
    return getDb()
      .prepare(`SELECT * FROM approval WHERE event_id = ? ORDER BY requested_at DESC LIMIT ?`)
      .all(opts.eventId, limit) as ApprovalRow[];
  }
  return getDb()
    .prepare(`SELECT * FROM approval ORDER BY requested_at DESC LIMIT ?`)
    .all(limit) as ApprovalRow[];
}

export interface RequestApprovalInput {
  kind: ApprovalKind;
  action: string;
  signal: string;
  continuityId: string;
  eventId?: string | null;
  slotId?: string | null;
  /**
   * Hard deadline for the whole interaction. For a slot handover this is the
   * slot's `approval_deadline`, so the approval and the slot expire together.
   */
  expiresAt?: number;
  maxAgeSec?: number;
  /** Who asked. An agent requesting on the human's behalf is the normal case. */
  requestedVia?: 'human' | 'agent';
}

export interface RequestApprovalResult {
  approvalId: string;
  requestId: string;
  mode: 'oidc' | 'device' | 'local';
  url?: string;
  deviceCode?: {
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    intervalSec: number;
  };
  expiresAt: number;
  degraded: boolean;
  note: string;
}

/**
 * Issue a fresh-authentication request for a specific operation.
 *
 * Stage 1 of the observable loop. Everything the human needs is returned here
 * (a URL, or a device code) — never a token, never a secret.
 */
export async function requestApproval(input: RequestApprovalInput): Promise<RequestApprovalResult> {
  const started = await worldid.startFreshAuth({
    action: input.action,
    signal: input.signal,
    intent: input.kind,
    continuityId: input.continuityId,
    maxAgeSec: input.maxAgeSec,
  });

  const expiresAt = Math.min(started.expiresAt, input.expiresAt ?? started.expiresAt);
  const id = newId('apv');
  const requestedVia = input.requestedVia ?? 'human';

  getDb()
    .prepare(
      `INSERT INTO approval
         (id, kind, bound_action, bound_signal, continuity_id, event_id, slot_id,
          nonce, request_id, requested_via, state, requested_at, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'PENDING',?,?,?)`,
    )
    .run(
      id,
      input.kind,
      input.action,
      input.signal,
      input.continuityId,
      input.eventId ?? null,
      input.slotId ?? null,
      newId('nonce'),
      started.requestId,
      requestedVia,
      nowMs(),
      nowMs(),
      expiresAt,
    );

  audit({
    type: 'approval.requested',
    continuityId: input.continuityId,
    eventId: input.eventId ?? null,
    slotId: input.slotId ?? null,
    actor: requestedVia,
    payload: {
      approvalId: id,
      requestId: started.requestId,
      scene: 'stage:1-requested',
      kind: input.kind,
      boundAction: input.action,
      boundSignal: input.signal,
      mode: started.mode,
      degraded: started.degraded,
      expiresAt,
    },
  });

  return {
    approvalId: id,
    requestId: started.requestId,
    mode: started.mode,
    url: started.url,
    deviceCode: started.deviceCode,
    expiresAt,
    degraded: started.degraded,
    note: started.note,
  };
}

/**
 * Pull the World ID outcome into the approval row.
 *
 * Safe to call in a polling loop: it is idempotent and it never advances an
 * approval past APPROVED — moving beyond that is the gate's job, and only after
 * it has re-verified the proof itself.
 */
export async function syncApproval(approvalId: string): Promise<ApprovalRow> {
  const row = getApproval(approvalId);
  if (!row) throw new PresenceError('approval_not_found', `no approval ${approvalId}`);

  if (row.state === 'CONSUMED' || row.state === 'DENIED' || row.state === 'EXPIRED') return row;

  // The window can close before the human answers. Reflect that here rather
  // than letting a late approval look usable.
  if (row.state === 'PENDING' && row.expires_at <= nowMs()) {
    const result = await worldid.awaitAuthResult(row.request_id);
    if (!result.ok && result.code === 'pending') {
      markExpired(row, 'approval window closed before the human decided');
      return getApproval(approvalId)!;
    }
  }

  const result = await worldid.awaitAuthResult(row.request_id);

  if (result.ok) {
    if (row.state === 'PENDING') {
      getDb()
        .prepare(
          `UPDATE approval
              SET state = 'APPROVED', completed_at = ?, proof_ref = ?, nullifier = ?, auth_time = ?
            WHERE id = ? AND state = 'PENDING'`,
        )
        .run(nowMs(), result.proofRef, result.nullifier, result.authTime, approvalId);

      audit({
        type: 'approval.completed',
        continuityId: row.continuity_id,
        eventId: row.event_id,
        slotId: row.slot_id,
        // Stage 2 is the human, and only the human. Attributing it to the server
        // because the server noticed would erase the one part of the loop the
        // agent cannot do — which is the entire argument.
        actor: 'human',
        payload: {
          approvalId,
          requestId: row.request_id,
          scene: 'stage:2-completed',
          authTime: result.authTime,
          mode: result.mode,
          note: 'the human finished on their own device; server verification is still pending',
        },
      });
    }
    return getApproval(approvalId)!;
  }

  if (result.code === 'denied') {
    getDb()
      .prepare(
        `UPDATE approval SET state = 'DENIED', decided_at = ?, fail_reason = ? WHERE id = ? AND state IN ('PENDING','APPROVED')`,
      )
      .run(nowMs(), result.message, approvalId);
    audit({
      type: 'approval.denied',
      continuityId: row.continuity_id,
      eventId: row.event_id,
      slotId: row.slot_id,
      severity: 'warn',
      payload: { approvalId, requestId: row.request_id, reason: result.message },
    });
    return getApproval(approvalId)!;
  }

  if (result.code === 'expired') {
    markExpired(row, result.message);
    return getApproval(approvalId)!;
  }

  if (result.code === 'failed') {
    getDb()
      .prepare(`UPDATE approval SET state = 'DENIED', decided_at = ?, fail_reason = ? WHERE id = ? AND state = 'PENDING'`)
      .run(nowMs(), result.message, approvalId);
    audit({
      type: 'approval.failed',
      continuityId: row.continuity_id,
      eventId: row.event_id,
      slotId: row.slot_id,
      severity: 'alert',
      payload: { approvalId, requestId: row.request_id, reason: result.message },
    });
    return getApproval(approvalId)!;
  }

  return row;
}

function markExpired(row: ApprovalRow, reason: string): void {
  getDb()
    .prepare(
      `UPDATE approval SET state = 'EXPIRED', decided_at = ?, fail_reason = ?
        WHERE id = ? AND state IN ('PENDING','APPROVED')`,
    )
    .run(nowMs(), reason, row.id);
  audit({
    type: 'approval.expired',
    continuityId: row.continuity_id,
    eventId: row.event_id,
    slotId: row.slot_id,
    severity: 'warn',
    payload: { approvalId: row.id, requestId: row.request_id, reason },
  });
}

/** Convenience for the UI: "what am I being asked to approve right now". */
export function openApprovalsFor(continuityId: string): ApprovalRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM approval
        WHERE continuity_id = ? AND state IN ('PENDING','APPROVED')
        ORDER BY requested_at DESC`,
    )
    .all(continuityId) as ApprovalRow[];
}

export interface OpenApprovalView {
  approvalId: string;
  state: ApprovalState;
  stage: 'requested' | 'completed' | 'verified' | 'executed' | 'denied' | 'expired';
  kind: ApprovalKind;
  boundAction: string;
  boundSignal: string;
  slotId: string | null;
  mode: 'oidc' | 'device' | 'local';
  /** Where the human goes to approve, while the request is still PENDING. */
  consentUrl: string | null;
  requestedVia: 'human' | 'agent';
  requestedAt: number;
  completedAt: number | null;
  verifiedAt: number | null;
  executedAt: number | null;
  expiresAt: number;
  remainingMs: number;
}

/**
 * What this human still owes an answer to.
 *
 * This is the piece that was missing, and its absence was invisible from the
 * server's side: the browser starts an authorization, gets redirected to the
 * consent screen, comes back — and has forgotten the approval id, because it
 * only ever lived in React state. The approval row then sat at PENDING forever
 * unless something happened to poll `GET /api/approval/{id}`, while the slot's
 * countdown kept running and the "authorize" button stayed pressable. Pressing
 * it again started a *second* authorization, so the flow could never be
 * completed from the browser at all.
 *
 * The fix is not to persist the id on the client. It is to stop treating the
 * client as the record: the server knows what is outstanding, so the page asks.
 * That also makes the flow survive a refresh, a second tab, or a different
 * browser, none of which client-side storage would have handled well.
 *
 * `sync` advances any request the IdP has since resolved. It matters: the
 * approval row only moves when something looks at it, and a browser that
 * navigated away to a consent screen is exactly the something that is not
 * looking.
 */
export async function openApprovalViews(continuityId: string): Promise<OpenApprovalView[]> {
  const open = openApprovalsFor(continuityId);

  // Advance the ones still marked PENDING — the human may already have approved
  // on their device while this page was away.
  await Promise.all(
    open.filter((row) => row.state === 'PENDING').map((row) => syncApproval(row.id).catch(() => undefined)),
  );

  const fresh = openApprovalsFor(continuityId);
  const now = Date.now();

  return fresh.map((row) => {
    const request = getDb()
      .prepare(`SELECT authorize_url, mode FROM auth_request WHERE id = ?`)
      .get(row.request_id) as { authorize_url: string | null; mode: OpenApprovalView['mode'] } | undefined;

    return {
      approvalId: row.id,
      state: row.state,
      stage: stageOf(row),
      kind: row.kind,
      boundAction: row.bound_action,
      boundSignal: row.bound_signal,
      slotId: row.slot_id,
      mode: request?.mode ?? 'local',
      consentUrl: row.state === 'PENDING' ? (request?.authorize_url ?? null) : null,
      requestedVia: row.requested_via,
      requestedAt: row.requested_at,
      completedAt: row.completed_at,
      verifiedAt: row.verified_at,
      executedAt: row.executed_at,
      expiresAt: row.expires_at,
      remainingMs: Math.max(0, row.expires_at - now),
    };
  });
}

/** Which of the four stages an approval has reached. */
export function stageOf(row: Pick<ApprovalRow, 'executed_at' | 'verified_at' | 'completed_at' | 'state'>): OpenApprovalView['stage'] {
  if (row.executed_at) return 'executed';
  if (row.verified_at) return 'verified';
  if (row.completed_at) return 'completed';
  if (row.state === 'DENIED') return 'denied';
  if (row.state === 'EXPIRED') return 'expired';
  return 'requested';
}

/**
 * Server-side verification for a specific approval row.
 *
 * This is the ONLY way the business layer asks "is this authorized". It
 * delegates to `worldid.verifyOnServer`, which re-derives the nullifier from
 * `(issuer, subject, action, signal)`, re-validates the stored artefact, and
 * re-checks freshness against the current clock. A client-supplied `{ok:true}`
 * has no path into this function.
 */
export async function verifyApproval(
  approvalId: string,
  expected: {
    action: string;
    signal: string;
    maxAgeSec?: number;
    /**
     * When set, the authentication must belong to *this* attempt — i.e.
     * `auth_time >= attemptStartedAt`. This is the precise meaning of
     * `max_age=0`, and the sandbox `step-up` guide is explicit about how to
     * check it:
     *
     *   "For `max_age=0`, check that authentication belongs to the newly
     *    initiated attempt (using its start time, nonce, and bounded lifetime);
     *    do not require its age to remain literally zero during the browser
     *    round trip."
     *
     * A flat max-age alone would accept a session that happened to be refreshed
     * a minute ago for a different reason. This binds freshness to the attempt.
     */
    attemptStartedAt?: number | null;
  },
): Promise<worldid.VerifyResult> {
  let row = getApproval(approvalId);
  if (!row) {
    return {
      ok: false,
      code: 'approval_not_found',
      message: 'unknown approval',
      reason: 'NOT_FOUND',
    };
  }

  // Pull the World ID outcome in BEFORE verifying against the row.
  //
  // A caller is allowed to present an approval without first polling
  // `GET /api/approval/{id}` — an agent that gets the consent callback and
  // immediately claims is behaving correctly. `worldid.verifyOnServer` falls back
  // to the request id, so such a claim *works*; but the approval row would then
  // be consumed while still marked PENDING, with no `proof_ref`, no `nullifier`
  // and no `completed_at`. That is a hole in the audit trail and a gap in the
  // four-stage record T-3.3 asks for, and it is invisible until you read the row.
  if (row.state === 'PENDING') {
    row = await syncApproval(approvalId);
  }

  // Re-check the local bindings first: they are cheap and they catch the
  // "same approval, different parameters" attack without any crypto at all.
  if (row.bound_action !== expected.action) {
    return {
      ok: false,
      code: 'approval_action_mismatch',
      message: `this approval authorizes "${row.bound_action}", not "${expected.action}"`,
      reason: 'ACTION_MISMATCH',
    };
  }
  if (row.bound_signal !== expected.signal) {
    return {
      ok: false,
      code: 'approval_signal_mismatch',
      message: `this approval authorizes signal "${row.bound_signal}", not "${expected.signal}"`,
      reason: 'SIGNAL_MISMATCH',
    };
  }

  const verified = await worldid.verifyOnServer(row.proof_ref ?? row.request_id, expected);
  if (!verified.ok) return verified;

  // `max_age=0` semantics: the proof must postdate the request that asked for it.
  const attemptStartedAt = expected.attemptStartedAt ?? row.requested_at;
  if (attemptStartedAt && verified.authTime < attemptStartedAt - CLOCK_SKEW_MS) {
    return {
      ok: false,
      code: 'not_fresh',
      message:
        'this authentication predates the authorization request, so it is not a fresh proof for this action',
      reason: 'AUTH_PREDATES_ATTEMPT',
    };
  }

  return verified;
}

/** Small explicit skew allowance, mirroring the one in `worldid/nullifier.ts`. */
const CLOCK_SKEW_MS = 5_000;

/** Stage 3. Records that the server (not the client) confirmed the proof. */
export function markVerified(approvalId: string, continuityId: string, authTime: number): void {
  getDb()
    .prepare(`UPDATE approval SET verified_at = ? WHERE id = ? AND verified_at IS NULL`)
    .run(nowMs(), approvalId);
  const row = getApproval(approvalId);
  audit({
    type: 'approval.verified',
    continuityId,
    eventId: row?.event_id ?? null,
    slotId: row?.slot_id ?? null,
    payload: {
      approvalId,
      scene: 'stage:3-verified',
      authTime,
      note: 'the server re-verified the proof and re-derived the nullifier itself',
    },
  });
}

/** Stage 4. Records that the protected action ran. Called inside the transaction. */
export function markExecuted(
  db: ReturnType<typeof getDb>,
  approvalId: string,
  detail: Record<string, unknown>,
  actor: 'human' | 'agent' = 'human',
): void {
  db.prepare(`UPDATE approval SET state = 'CONSUMED', consumed_at = ?, executed_at = ? WHERE id = ?`).run(
    nowMs(),
    nowMs(),
    approvalId,
  );
  const row = getApproval(approvalId);
  audit({
    type: 'approval.executed',
    continuityId: row?.continuity_id ?? null,
    eventId: row?.event_id ?? null,
    slotId: row?.slot_id ?? null,
    actor,
    payload: { approvalId, scene: 'stage:4-executed', ...detail },
  });
}

export function rejectApproval(approvalId: string, code: ReasonCode, message: string): void {
  const row = getApproval(approvalId);
  if (!row) return;
  audit({
    type: 'approval.rejected_at_gate',
    continuityId: row.continuity_id,
    eventId: row.event_id,
    slotId: row.slot_id,
    severity: 'alert',
    payload: { approvalId, code, message, note: 'protected action did NOT run' },
  });
}

/** The UI/agent calls this after the human presses deny, so the state is immediate. */
export function denyApproval(approvalId: string, reason: string): ApprovalRow {
  const row = getApproval(approvalId);
  if (!row) throw new PresenceError('approval_not_found', `no approval ${approvalId}`);
  if (row.state === 'PENDING') {
    worldid.denyAuth(row.request_id, reason);
    getDb()
      .prepare(`UPDATE approval SET state = 'DENIED', decided_at = ?, fail_reason = ? WHERE id = ?`)
      .run(nowMs(), reason, approvalId);
    audit({
      type: 'approval.denied',
      continuityId: row.continuity_id,
      eventId: row.event_id,
      slotId: row.slot_id,
      severity: 'warn',
      payload: { approvalId, reason, note: 'no protected action will run for this approval' },
    });
  }
  return getApproval(approvalId)!;
}

/** Re-run the approval read inside a transaction (used by the gate). */
export function reloadApproval(db: ReturnType<typeof getDb>, id: string): ApprovalRow | undefined {
  return db.prepare(`SELECT * FROM approval WHERE id = ?`).get(id) as ApprovalRow | undefined;
}
