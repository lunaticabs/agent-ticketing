/**
 * Persistence for in-flight World ID interactions.
 *
 * Why the database and not memory: the web process, the standalone agent
 * process and the background sweeper are three different OS processes. An
 * in-memory map would work on one laptop and break the moment the agent runs as
 * its own process — which is the entire point of the project.
 */
import { getDb, nowMs } from '../lib/db';
import { newId, randomToken } from '../lib/ids';
import type { IdpMode } from './config';
import type { AuthIntent } from './types';

export type AuthRequestState = 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED' | 'FAILED';

export interface AuthRequestRow {
  id: string;
  mode: IdpMode;
  intent: AuthIntent;
  action: string;
  signal: string;
  continuity_id: string | null;
  state: AuthRequestState;
  code_verifier: string | null;
  nonce: string | null;
  state_param: string | null;
  device_code: string | null;
  user_code: string | null;
  verification_uri: string | null;
  verification_uri_complete: string | null;
  interval_sec: number | null;
  poll_after: number | null;
  authorize_url: string | null;
  created_at: number;
  expires_at: number;
  completed_at: number | null;
  auth_time: number | null;
  acr: string | null;
  amr: string | null;
  nullifier: string | null;
  proof_ref: string | null;
  reject_reason: string | null;
}

export function createAuthRequest(input: {
  mode: IdpMode;
  intent: AuthIntent;
  action: string;
  signal: string;
  continuityId?: string | null;
  codeVerifier?: string | null;
  nonce?: string | null;
  stateParam?: string | null;
  expiresAt: number;
  authorizeUrl?: string | null;
}): AuthRequestRow {
  const id = newId('areq');
  getDb()
    .prepare(
      `INSERT INTO auth_request
         (id, mode, intent, action, signal, continuity_id, state,
          code_verifier, nonce, state_param, authorize_url, created_at, expires_at)
       VALUES (?,?,?,?,?,?,'PENDING',?,?,?,?,?,?)`,
    )
    .run(
      id,
      input.mode,
      input.intent,
      input.action,
      input.signal,
      input.continuityId ?? null,
      input.codeVerifier ?? null,
      input.nonce ?? null,
      input.stateParam ?? null,
      input.authorizeUrl ?? null,
      nowMs(),
      input.expiresAt,
    );
  return getAuthRequest(id)!;
}

export function getAuthRequest(id: string): AuthRequestRow | undefined {
  return getDb().prepare(`SELECT * FROM auth_request WHERE id = ?`).get(id) as
    | AuthRequestRow
    | undefined;
}

export function findAuthRequestByState(stateParam: string): AuthRequestRow | undefined {
  return getDb().prepare(`SELECT * FROM auth_request WHERE state_param = ?`).get(stateParam) as
    | AuthRequestRow
    | undefined;
}

export function storeDeviceChallenge(
  id: string,
  challenge: {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    intervalSec: number;
    expiresAt: number;
  },
): void {
  getDb()
    .prepare(
      `UPDATE auth_request
          SET device_code = ?, user_code = ?, verification_uri = ?, verification_uri_complete = ?,
              interval_sec = ?, poll_after = ?, expires_at = ?
        WHERE id = ?`,
    )
    .run(
      challenge.deviceCode,
      challenge.userCode,
      challenge.verificationUri,
      challenge.verificationUriComplete,
      challenge.intervalSec,
      nowMs() + challenge.intervalSec * 1000,
      challenge.expiresAt,
      id,
    );
}

export function notePoll(id: string, intervalSec: number): void {
  getDb()
    .prepare(`UPDATE auth_request SET poll_after = ? WHERE id = ?`)
    .run(nowMs() + intervalSec * 1000, id);
}

/** Stage 2 of T-3.3: the human finished on their device and the IdP confirms. */
export function markApproved(
  id: string,
  claims: {
    authTime: number;
    acr?: string | null;
    amr?: string[] | null;
    nullifier: string;
    proofRef: string;
    continuityId: string;
  },
): void {
  getDb()
    .prepare(
      `UPDATE auth_request
          SET state = 'APPROVED', completed_at = ?, auth_time = ?, acr = ?, amr = ?,
              nullifier = ?, proof_ref = ?, continuity_id = COALESCE(continuity_id, ?)
        WHERE id = ?`,
    )
    .run(
      nowMs(),
      claims.authTime,
      claims.acr ?? null,
      claims.amr ? JSON.stringify(claims.amr) : null,
      claims.nullifier,
      claims.proofRef,
      claims.continuityId,
      id,
    );
}

export function markFailed(
  id: string,
  state: Extract<AuthRequestState, 'DENIED' | 'EXPIRED' | 'FAILED'>,
  reason: string,
): void {
  getDb()
    .prepare(
      `UPDATE auth_request SET state = ?, reject_reason = ?, completed_at = ? WHERE id = ?`,
    )
    .run(state, reason, nowMs(), id);
}

/** A fresh random `state` / `nonce` / PKCE verifier triple. */
export function newAttemptSecrets() {
  return {
    stateParam: randomToken(24),
    nonce: randomToken(24),
    codeVerifier: randomToken(48),
  };
}
