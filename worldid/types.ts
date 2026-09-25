/**
 * Public types for the World ID adapter.
 *
 * Everything outside `worldid/` sees only these shapes. No route handler, no
 * library function, and no UI component may touch OIDC endpoints, ID tokens, or
 * the verify API directly (T-0.3).
 */

import type { IdpMode } from './config';

/** What the fresh authentication is for. Drives the bound action. */
export type AuthIntent = 'link' | 'purchase';

export interface StartFreshAuthInput {
  /** e.g. `buy_slot:evt_tokyo`. RED LINE 1: bound to the operation. */
  action: string;
  /** e.g. `slot_7:human_abc`. RED LINE 6: parameters are part of the proof. */
  signal: string;
  intent: AuthIntent;
  /**
   * When present the IdP must return this same human, otherwise we reject with
   * `identity_mismatch`. Used for step-up on an already-linked account.
   */
  continuityId?: string;
  /**
   * Freshness requirement in seconds. `0` means "this attempt's own new proof"
   * (`max_age=0`), which is what T-3.2 asks for.
   */
  maxAgeSec?: number;
}

export interface DeviceCodeChallenge {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  intervalSec: number;
}

export interface StartFreshAuthResult {
  requestId: string;
  mode: IdpMode;
  /** Present for `oidc` and `local`: send the human here. */
  url?: string;
  /** Present for `device`: show the code, then poll. */
  deviceCode?: DeviceCodeChallenge;
  expiresAt: number;
  /** True when this is the local fallback rather than the real IdP. */
  degraded: boolean;
  note: string;
}

export interface AuthSuccess {
  ok: true;
  requestId: string;
  continuityId: string;
  issuer: string;
  subject: string;
  /** One-time key: `f(issuer, subject, action, signal)`. See `nullifier.ts`. */
  nullifier: string;
  /** Milliseconds since epoch, normalised from the ID token's `auth_time`. */
  authTime: number;
  /** Opaque handle the business layer passes back into `verifyOnServer`. */
  proofRef: string;
  acr?: string;
  amr?: string[];
  mode: IdpMode;
}

export interface AuthFailure {
  ok: false;
  requestId: string;
  code:
    | 'pending'
    | 'denied'
    | 'expired'
    | 'failed'
    | 'idp_unavailable'
    | 'identity_mismatch'
    | 'not_fresh'
    | 'not_found';
  message: string;
  /** Raw OAuth error code when the IdP supplied one (`access_denied`, ...). */
  oauthError?: string;
}

export type AuthResult = AuthSuccess | AuthFailure;

/** Server-side verification of a stored proof against the operation it must authorize. */
export interface VerifyExpectation {
  action: string;
  signal: string;
  maxAgeSec?: number;
}

export interface VerifySuccess {
  ok: true;
  continuityId: string;
  issuer: string;
  subject: string;
  nullifier: string;
  authTime: number;
  proofRef: string;
  mode: IdpMode;
}

export interface VerifyFailure {
  ok: false;
  code:
    | 'approval_not_found'
    | 'approval_action_mismatch'
    | 'approval_signal_mismatch'
    | 'approval_not_approved'
    | 'approval_expired'
    | 'approval_denied'
    | 'approval_identity_mismatch'
    | 'not_fresh'
    | 'not_a_verified_human'
    | 'idp_unavailable';
  message: string;
  reason: string;
}

export type VerifyResult = VerifySuccess | VerifyFailure;
