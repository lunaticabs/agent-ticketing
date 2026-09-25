/**
 * Structured rejection reasons.
 *
 * T-7.1 requires every failure path to produce a reason that is readable by
 * both a model and a front-end, and that the protected action provably did not
 * happen. So: no thrown strings, no bare `Error`. Every refusal is a
 * `PresenceError` with a stable machine code, a human sentence, and the
 * context needed to render it on the board.
 */

export type ReasonCode =
  // identity / session
  | 'not_authenticated'
  | 'not_a_verified_human'
  | 'identity_mismatch'
  | 'continuity_unknown'
  // queue
  | 'already_in_queue'
  | 'queue_closed'
  | 'lottery_already_drawn'
  // slot
  | 'event_not_found'
  | 'slot_not_found'
  | 'slot_not_available'
  | 'slot_already_allocated_to_someone_else'
  | 'no_slot_allocated'
  | 'window_expired'
  | 'deferred_to_next_candidate'
  // gate / proof
  | 'approval_required'
  | 'approval_not_found'
  | 'approval_action_mismatch'
  | 'approval_signal_mismatch'
  | 'approval_not_approved'
  | 'approval_expired'
  | 'approval_denied'
  | 'approval_identity_mismatch'
  | 'approval_already_consumed'
  | 'proof_replay_detected'
  | 'already_owns_entitlement'
  | 'verification_failed'
  | 'not_fresh'
  | 'untrusted_client_result'
  | 'environment_pinned'
  // grants
  | 'grant_not_found'
  | 'grant_expired'
  | 'grant_revoked'
  | 'grant_scope_insufficient'
  // generic
  | 'idp_unavailable'
  | 'dev_routes_disabled'
  | 'bad_request'
  | 'not_found'
  | 'internal_error';

export interface ReasonBody {
  ok: false;
  code: ReasonCode;
  /** Short sentence safe to show a judge on the projector. */
  message: string;
  /** Which red line / invariant this refusal protects. Shown in the UI. */
  invariant?: string;
  details?: Record<string, unknown>;
  /** Free-form hint for a model driving the MCP surface. */
  hint?: string;
}

export class PresenceError extends Error {
  readonly code: ReasonCode;
  readonly httpStatus: number;
  readonly invariant?: string;
  readonly details?: Record<string, unknown>;
  readonly hint?: string;

  constructor(
    code: ReasonCode,
    message: string,
    opts: {
      httpStatus?: number;
      invariant?: string;
      details?: Record<string, unknown>;
      hint?: string;
    } = {},
  ) {
    super(message);
    this.name = 'PresenceError';
    this.code = code;
    this.httpStatus = opts.httpStatus ?? defaultStatus(code);
    this.invariant = opts.invariant;
    this.details = opts.details;
    this.hint = opts.hint;
  }

  toBody(): ReasonBody {
    return {
      ok: false,
      code: this.code,
      message: this.message,
      ...(this.invariant ? { invariant: this.invariant } : {}),
      ...(this.details ? { details: this.details } : {}),
      ...(this.hint ? { hint: this.hint } : {}),
    };
  }
}

function defaultStatus(code: ReasonCode): number {
  switch (code) {
    case 'not_authenticated':
    case 'not_a_verified_human':
      return 401;
    case 'identity_mismatch':
    case 'approval_identity_mismatch':
    case 'approval_action_mismatch':
    case 'approval_signal_mismatch':
    case 'untrusted_client_result':
    case 'environment_pinned':
      return 403;
    case 'event_not_found':
    case 'slot_not_found':
    case 'approval_not_found':
    case 'grant_not_found':
    case 'not_found':
    case 'dev_routes_disabled':
      return 404;
    case 'proof_replay_detected':
    case 'approval_already_consumed':
    case 'already_owns_entitlement':
    case 'slot_already_allocated_to_someone_else':
      return 409;
    case 'window_expired':
    case 'deferred_to_next_candidate':
    case 'approval_expired':
    case 'grant_expired':
      return 410;
    case 'internal_error':
    case 'idp_unavailable':
      return 500;
    default:
      return 400;
  }
}

/** Convenience: refuse with a structured reason. */
export function refuse(
  code: ReasonCode,
  message: string,
  opts?: ConstructorParameters<typeof PresenceError>[2],
): never {
  throw new PresenceError(code, message, opts);
}

/** Feature flags referenced from several layers. */
export function devRoutesEnabled(): boolean {
  return process.env.ENABLE_DEV_ROUTES === '1';
}
