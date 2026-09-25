/**
 * ============================================================================
 *  THE GATE — one implementation, reached from HTTP and from MCP
 * ============================================================================
 *
 * T-3.4 acceptance: "MCP 路径与 HTTP 路径走同一套校验函数（搜代码确认没有第二条
 * 实现）". So there is exactly one `executeClaim` in this repository. The HTTP
 * route and the MCP `slot.claim` tool are both thin adapters over it. If you are
 * reading this because you want to add a third surface: call this function.
 *
 * ---------------------------------------------------------------------------
 *  Why an `approval` argument is not proof of anything
 * ---------------------------------------------------------------------------
 * The official human-in-the-loop guidance, quoted because it is the design:
 *
 *   "A required `approval` input is **not proof of authorization** — tool inputs
 *    are **LLM-generated**."
 *
 *   "**Never trust that approveAction ran just because this tool was called**:
 *    check the binding, re-verify the proof, and consume it once."
 *
 * A model can put any string it likes in an `approval` field. So the presence of
 * the argument changes nothing; what changes the outcome is that the server
 * looks the value up in its own table, re-checks `(action, signal)`, re-checks
 * freshness against the current clock, and consumes a nullifier through a
 * database PRIMARY KEY. A fabricated value simply is not found.
 *
 * This is also why the gate is in `lib/` rather than in the tool definition:
 * a check that lives in a prompt, a tool description, or a schema is a
 * suggestion. A check that lives behind a function every transport must call is
 * a gate. That distinction is the project's whole argument.
 */
import { getDb, nowMs, tx } from './db';
import { audit } from './audit';
import { PresenceError } from './errors';
import { getEvent } from './humans';
import { consumeProof } from './consume';
import {
  allocateAvailable,
  allocatedSlotsFor,
  confirmSlot,
  getSlot,
  hasBeenServed,
  hasVipSkip,
  sweep,
  type SlotRow,
} from './slots';
import {
  getApproval,
  markExecuted,
  markVerified,
  rejectApproval,
  requestApproval,
  verifyApproval,
  type ApprovalRow,
  type RequestApprovalResult,
} from './approval';

// ── Action / signal definition ──────────────────────────────────────────────
//
// RED LINE 1 lives in these four functions. `action` names the OPERATION
// ("buy a slot for this event"), never the act of verifying. `signal` names the
// exact parameters, so a proof cannot be moved to a different slot or a
// different recipient (RED LINE 6).

/** e.g. `buy_slot:evt_tokyo`. NOT `verify_user`. */
export function purchaseAction(eventId: string): string {
  return `buy_slot:${eventId}`;
}

/** e.g. `evt_tokyo:cid_ab12…` */
export function purchaseSignal(eventId: string, continuityId: string): string {
  return `${eventId}:${continuityId}`;
}

/**
 * The action for the *link* flow (T-0.4 / T-1.1).
 *
 * Note what this is not: it is not the purchase gate. Linking only answers "is
 * this a verified human, and have we seen them before". Making that the action
 * for *buying* is the exact mistake the previous ETHGlobal winner made — see
 * the long comment in `worldid/nullifier.ts`. This action governs nothing but
 * identity linking, and its nullifier is deliberately never consumed.
 */
export function linkAction(): string {
  return 'link_identity:presence';
}

/** Each link attempt gets its own signal, so link proofs are not interchangeable. */
export function linkSignal(nonce: string): string {
  return `link:${nonce}`;
}

// ── Step 1: what is this human allowed to claim right now? ──────────────────

export interface ClaimTarget {
  slotId: string;
  deadline: number;
  action: string;
  signal: string;
  deferralCount: number;
}

/**
 * Resolve the slot this human may currently claim, or refuse with a specific
 * reason. Always sweeps first, so an expired window is already resolved before
 * anyone gets to act on it.
 */
export function describeClaimTarget(eventId: string, continuityId: string): ClaimTarget {
  const event = getEvent(eventId);
  if (!event) throw new PresenceError('event_not_found', `no event ${eventId}`);

  sweep(eventId);

  const allocated = allocatedSlotsFor(eventId, continuityId);
  if (allocated.length > 0) {
    const slot = allocated[0];
    if (slot.approval_deadline === null) {
      // The schema's CHECK makes this unreachable; assert anyway rather than
      // silently treating a deadline-less allocation as claimable forever.
      throw new PresenceError('internal_error', 'allocated slot is missing its approval deadline');
    }
    return {
      slotId: slot.id,
      deadline: slot.approval_deadline,
      action: purchaseAction(eventId),
      signal: purchaseSignal(eventId, continuityId),
      deferralCount: slot.deferral_count,
    };
  }

  // No allocation. Work out which refusal tells the human the most.
  const held = getDb()
    .prepare(
      `SELECT * FROM slot WHERE event_id = ? AND holder_continuity_id = ?
        AND state = 'CONFIRMED'`,
    )
    .all(eventId, continuityId) as SlotRow[];
  if (held.length > 0) {
    throw new PresenceError('already_owns_entitlement', 'you already hold a confirmed slot', {
      invariant: 'RED LINE 1 — action bound to the purchase gives one slot per human per event',
      details: { slotId: held[0].id },
    });
  }

  if (hasBeenServed(eventId, continuityId)) {
    throw new PresenceError(
      'deferred_to_next_candidate',
      'your approval window closed, so this slot was passed to the next candidate in the draw',
      {
        invariant: 'T-2.3 — deferral is final for the candidate who missed the window',
        details: { eventId },
        hint:
          'A valid proof does not help here: the allocation is gone. This is the deferral ' +
          'feature working, not an error.',
      },
    );
  }

  if (event.lottery_drawn_at === null) {
    throw new PresenceError('no_slot_allocated', 'the draw for this event has not been settled yet', {
      details: { eventId, lotteryMode: event.lottery_mode },
    });
  }

  throw new PresenceError(
    'no_slot_allocated',
    'you are in the queue but the draw did not reach you — every slot is spoken for',
    { details: { eventId } },
  );
}

// ── Step 2: ask the human ───────────────────────────────────────────────────

/**
 * Stage 1 of the observable loop, for the purchase gate.
 *
 * The freshness requirement is 0 seconds: `max_age=0`, "require this
 * transaction's own fresh World proof, even with an existing browser session".
 * That is T-3.2 in one parameter.
 */
export async function requestClaimApproval(
  eventId: string,
  continuityId: string,
  requestedVia: 'human' | 'agent' = 'human',
): Promise<RequestApprovalResult & { target: ClaimTarget }> {
  const target = describeClaimTarget(eventId, continuityId);

  const result = await requestApproval({
    kind: 'purchase',
    action: target.action,
    signal: target.signal,
    continuityId,
    eventId,
    slotId: target.slotId,
    // The approval is worth exactly as long as the slot's window. Two clocks
    // for one handover would be a bug waiting to happen.
    expiresAt: target.deadline,
    maxAgeSec: 0,
    requestedVia,
  });

  return { ...result, target };
}

// ── Step 3: the gate itself ─────────────────────────────────────────────────

export interface ExecuteClaimInput {
  eventId: string;
  continuityId: string;
  /**
   * The value a caller presented. Treated as untrusted: it is looked up, never
   * believed. Accepts either an approval id or a World ID proof reference.
   */
  approvalRef: string | null | undefined;
  /** Who is presenting the approval: the human, or the agent acting for them. */
  actor?: 'human' | 'agent';
}

export interface ExecuteClaimSuccess {
  ok: true;
  slotId: string;
  eventId: string;
  continuityId: string;
  acquiredVia: 'lottery';
  confirmedAt: number;
  approvalId: string;
  nullifier: string;
  authTime: number;
  stages: {
    requestedAt: number | null;
    completedAt: number | null;
    verifiedAt: number | null;
    executedAt: number | null;
  };
}

export async function executeClaim(input: ExecuteClaimInput): Promise<ExecuteClaimSuccess> {
  const { eventId, continuityId } = input;
  const actor = input.actor ?? 'human';

  // ── The gate's first act: refuse if no approval was presented at all ──
  if (!input.approvalRef || !input.approvalRef.trim()) {
    audit({
      type: 'gate.refused',
      continuityId,
      eventId,
      actor,
      severity: 'alert',
      payload: {
        code: 'approval_required',
        note: 'slot.claim was called without an approval — tool inputs are LLM-generated and prove nothing',
      },
    });
    throw new PresenceError(
      'approval_required',
      'this action requires a human authorization; a proof of authorization must accompany the call',
      {
        invariant: 'Track rule 4 / RED LINE 3 — the server verifies, and never trusts the caller',
        hint:
          'Ask the human to authorize first (POST /api/slot/claim/request), then present the ' +
          'returned approval reference. The server re-verifies it independently.',
        httpStatus: 428,
      },
    );
  }

  // An expired window is resolved before we look at the proof.
  const target = describeClaimTarget(eventId, continuityId);

  const approval = resolveApprovalRef(input.approvalRef);
  if (!approval) {
    throw new PresenceError('approval_not_found', 'the presented approval is not known to this server', {
      invariant: 'RED LINE 3 — an approval is only real if the server issued it',
      details: { presented: truncate(input.approvalRef) },
    });
  }

  // The approval must belong to the human making the claim, and to this slot.
  if (approval.continuity_id !== continuityId) {
    throw new PresenceError(
      'approval_identity_mismatch',
      'this approval was issued to a different human',
      {
        invariant: 'RED LINE 8 — only the recipient completes their own fresh verification',
        details: { issuedTo: approval.continuity_id, presentedBy: continuityId },
      },
    );
  }
  if (approval.slot_id && approval.slot_id !== target.slotId) {
    throw new PresenceError('approval_signal_mismatch', 'this approval was issued for a different slot', {
      invariant: 'RED LINE 6 — the approval is bound to (action, signal)',
      details: { boundTo: approval.slot_id, expected: target.slotId },
    });
  }

  // ── RED LINE 3: the server re-verifies. The caller's word is not evidence. ──
  const verified = await verifyApproval(approval.id, {
    action: target.action,
    signal: target.signal,
    maxAgeSec: 300,
    // `max_age=0`: the proof must belong to THIS attempt, not merely be recent.
    attemptStartedAt: approval.requested_at,
  });

  if (!verified.ok) {
    rejectApproval(approval.id, verified.code, verified.message);
    throw new PresenceError(mapVerifyCode(verified.code), verified.message, {
      invariant: 'RED LINE 3/5/6 — the server re-verifies every binding before acting',
      details: { approvalId: approval.id, reason: verified.reason },
    });
  }

  if (verified.continuityId !== continuityId) {
    rejectApproval(approval.id, 'approval_identity_mismatch', 'proof belongs to another human');
    throw new PresenceError('approval_identity_mismatch', 'the proof belongs to a different human', {
      invariant: 'RED LINE 8',
      details: { proofHuman: verified.continuityId, caller: continuityId },
    });
  }

  markVerified(approval.id, continuityId, verified.authTime);

  // ── Atomic commit: consume the proof and move the slot together ──
  return tx((db) => {
    consumeProof(db, {
      nullifier: verified.nullifier,
      boundAction: target.action,
      continuityId,
      slotId: target.slotId,
      proofRef: verified.proofRef,
    });

    confirmSlot(db, target.slotId, continuityId);
    markExecuted(
      db,
      approval.id,
      { slotId: target.slotId, acquiredVia: 'lottery', nullifier: verified.nullifier },
      actor,
    );

    const now = nowMs();
    audit({
      type: 'slot.confirmed',
      continuityId,
      eventId,
      slotId: target.slotId,
      actor,
      payload: {
        approvalId: approval.id,
        acquiredVia: 'lottery',
        authTime: verified.authTime,
        freshForSec: Math.round((now - verified.authTime) / 1000),
        note: 'one person, one slot: the nullifier is now spent for this action',
      },
    });

    const fresh = getApproval(approval.id)!;
    return {
      ok: true as const,
      slotId: target.slotId,
      eventId,
      continuityId,
      acquiredVia: 'lottery' as const,
      confirmedAt: now,
      approvalId: approval.id,
      nullifier: verified.nullifier,
      authTime: verified.authTime,
      stages: {
        requestedAt: fresh.requested_at,
        completedAt: fresh.completed_at,
        verifiedAt: fresh.verified_at,
        executedAt: fresh.executed_at,
      },
    };
  });
}

/**
 * Look up a presented reference. Both an approval id and a proof reference are
 * accepted because different callers hold different handles; neither is
 * trusted, both are looked up in server state.
 */
function resolveApprovalRef(ref: string): ApprovalRow | undefined {
  const direct = getApproval(ref);
  if (direct) return direct;
  return getDb()
    .prepare(`SELECT * FROM approval WHERE request_id = ? ORDER BY requested_at DESC LIMIT 1`)
    .get(ref) as ApprovalRow | undefined;
}

function mapVerifyCode(code: string) {
  switch (code) {
    case 'approval_not_found':
      return 'approval_not_found' as const;
    case 'approval_action_mismatch':
      return 'approval_action_mismatch' as const;
    case 'approval_signal_mismatch':
      return 'approval_signal_mismatch' as const;
    case 'approval_expired':
      return 'approval_expired' as const;
    case 'approval_denied':
      return 'approval_denied' as const;
    case 'approval_identity_mismatch':
      return 'approval_identity_mismatch' as const;
    case 'not_fresh':
      return 'not_fresh' as const;
    case 'not_a_verified_human':
      return 'not_a_verified_human' as const;
    case 'idp_unavailable':
      return 'idp_unavailable' as const;
    default:
      return 'approval_not_approved' as const;
  }
}

function truncate(value: string): string {
  return value.length > 16 ? `${value.slice(0, 16)}…` : value;
}

// ── Re-exports for surfaces that only need to read ──────────────────────────

export { getSlot, allocateAvailable, hasVipSkip };
