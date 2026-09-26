/**
 * ============================================================================
 *  `worldid/` — THE ONLY DOOR TO WORLD ID
 * ============================================================================
 *
 * T-0.3 acceptance: "上层代码里搜不到任何直接的 OIDC / verify endpoint 调用".
 * Enforced by convention and checked by `tests/invariants.test.ts`, which greps
 * every source file outside this directory for the issuer host, the authorize /
 * token / device endpoints, and `openid-client`.
 *
 * Public API (mirrors the TODO's suggested interface):
 *
 *   startFreshAuth({ action, signal, continuityId? }) -> { url | deviceCode, requestId }
 *   awaitAuthResult(requestId)                        -> { ok, continuityId, nullifier, authTime, proofRef }
 *   verifyOnServer(proofRef, { action, signal })      -> { ok, continuityId, nullifier } | { ok:false, reason }
 *   isFresh(authTime, maxAgeSec)                      -> boolean
 *
 * Note the absent parameter: **there is no `environment` argument anywhere in
 * this file** (RED LINE 4). It is a constant in `config.ts`.
 */
import {
  ID_TOKEN_MAX_AGE_SEC,
  WORLDID_ISSUER,
  idpCredentials,
  idpMode,
  redirectUri,
  publicBaseUrl,
} from './config';
import type {
  AuthResult,
  StartFreshAuthInput,
  StartFreshAuthResult,
  VerifyExpectation,
  VerifyResult,
} from './types';
import { continuityIdFrom, deriveNullifier, isFresh } from './nullifier';
import { getDb } from '../lib/db';
import { getHuman } from '../lib/humans';
import {
  createAuthRequest,
  getAuthRequest,
  markApproved,
  markFailed,
  newAttemptSecrets,
} from './requests';
import type { AuthRequestRow } from './requests';
import { authorizationAttemptTtlMs, beginAuthorization, redeemAuthorizationCode, configuration } from './oidc';
import * as device from './device';
import * as local from './local';

export type {
  AuthResult,
  StartFreshAuthInput,
  StartFreshAuthResult,
  VerifyExpectation,
  VerifyResult,
} from './types';
export { continuityIdFrom, deriveNullifier, isFresh } from './nullifier';
export { WORLDID_ENVIRONMENT, WORLDID_ISSUER, idpMode } from './config';

/**
 * Default freshness window for a slot handover.
 *
 * T-3.2: the human must have authenticated *at this moment*, not at signup. The
 * approval window (90s in the demo seed) is the real bound; this is the
 * protocol-level bound we hand to the IdP as `max_age`.
 */
export const DEFAULT_FRESHNESS_SEC = 0;

// ── 1. Start ────────────────────────────────────────────────────────────────

export async function startFreshAuth(input: StartFreshAuthInput): Promise<StartFreshAuthResult> {
  const mode = idpMode();
  const maxAgeSec = input.maxAgeSec ?? DEFAULT_FRESHNESS_SEC;

  if (mode === 'local') {
    const requestId = createAuthRequest({
      mode: 'local',
      intent: input.intent,
      action: input.action,
      signal: input.signal,
      continuityId: input.continuityId ?? null,
      expiresAt: Date.now() + local.LOCAL_ASSERTION_TTL_MS,
      authorizeUrl: null,
    }).id;

    const url = `${publicBaseUrl()}/auth/local?request=${encodeURIComponent(requestId)}`;
    updateAuthorizeUrl(requestId, url);

    return {
      requestId,
      mode: 'local',
      url,
      expiresAt: Date.now() + local.LOCAL_ASSERTION_TTL_MS,
      degraded: true,
      note:
        'LOCAL FALLBACK: the sandbox IdP could not be used because no portal-issued ' +
        'client credentials are configured. The gate still verifies every binding, ' +
        'but this assertion carries no World ID proof of humanness.',
    };
  }

  const secrets = newAttemptSecrets();
  const expiresAt = Date.now() + authorizationAttemptTtlMs();
  const requestId = createAuthRequest({
    mode,
    intent: input.intent,
    action: input.action,
    signal: input.signal,
    continuityId: input.continuityId ?? null,
    codeVerifier: secrets.codeVerifier,
    nonce: secrets.nonce,
    stateParam: secrets.stateParam,
    expiresAt,
  }).id;

  if (mode === 'device') {
    // The device grant ignores `max_age`/`prompt`/`acr_values` by design; it is
    // fresh on every attempt because the human proves and approves each time.
    const start = await device.initiate(requestId);
    device.startDevicePolling(requestId);
    return {
      requestId,
      mode: 'device',
      deviceCode: {
        userCode: start.userCode,
        verificationUri: start.verificationUri,
        verificationUriComplete: start.verificationUriComplete,
        intervalSec: start.intervalSec,
      },
      expiresAt: start.expiresAt,
      degraded: false,
      note: 'Device authorization grant (RFC 8628). Show the user code; the human approves on their own device.',
    };
  }

  const start = await beginAuthorization({ ...input, maxAgeSec }, secrets);
  updateAuthorizeUrl(requestId, start.url);

  return {
    requestId,
    mode: 'oidc',
    url: start.url,
    expiresAt,
    degraded: false,
    note: `Authorization code + S256 PKCE against ${WORLDID_ISSUER} with max_age=${maxAgeSec}.`,
  };
}

function updateAuthorizeUrl(requestId: string, url: string): void {
  getDb().prepare(`UPDATE auth_request SET authorize_url = ? WHERE id = ?`).run(url, requestId);
}

// ── 2. Await ────────────────────────────────────────────────────────────────

/**
 * Reads the outcome of an attempt. Non-blocking on purpose: the upstream device
 * poll loop runs detached and writes its result into the database, so a caller
 * that polls once per second never blocks and a restarted agent still sees the
 * result it was waiting for.
 */
export async function awaitAuthResult(requestId: string): Promise<AuthResult> {
  const row = getAuthRequest(requestId);
  if (!row) {
    return { ok: false, requestId, code: 'not_found', message: 'unknown authentication request' };
  }

  // Make sure a detached device loop is running, even across a process restart.
  if (row.mode === 'device' && row.state === 'PENDING') {
    device.startDevicePolling(requestId);
  }

  if (row.state === 'PENDING') {
    if (row.expires_at < Date.now()) {
      markFailed(requestId, 'EXPIRED', 'authentication window closed without approval');
      return { ok: false, requestId, code: 'expired', message: 'authentication window closed' };
    }
    return { ok: false, requestId, code: 'pending', message: 'waiting for the human' };
  }

  if (row.state === 'DENIED') {
    return {
      ok: false,
      requestId,
      code: 'denied',
      message: row.reject_reason ?? 'the human denied the request',
      oauthError: 'access_denied',
    };
  }

  if (row.state === 'EXPIRED') {
    return { ok: false, requestId, code: 'expired', message: row.reject_reason ?? 'attempt expired' };
  }

  if (row.state === 'FAILED') {
    return { ok: false, requestId, code: 'failed', message: row.reject_reason ?? 'attempt failed' };
  }

  // APPROVED (or already CONSUMED downstream — proofRef stays reusable for reads).
  const identity = await revalidateArtifact(row);
  if (!identity.ok) {
    return { ok: false, requestId, code: 'failed', message: identity.reason };
  }

  return {
    ok: true,
    requestId,
    continuityId: identity.continuityId,
    issuer: identity.issuer,
    subject: identity.subject,
    nullifier: identity.nullifier,
    authTime: identity.authTime,
    proofRef: requestId,
    acr: identity.acr,
    amr: identity.amr,
    mode: row.mode,
  };
}

// ── 3. Verify on the server ─────────────────────────────────────────────────

/**
 * ============================================================================
 *  RED LINE 3 — the server verifies; it never trusts a client-supplied result.
 * ============================================================================
 *
 * The official warning is worth pasting verbatim, because it is the whole
 * reason this function exists:
 *
 *   "A required `approval` input is **not proof of authorization** — tool inputs
 *    are **LLM-generated**."
 *   "**Never trust that approveAction ran just because this tool was called**:
 *    check the binding, re-verify the proof, and consume it once."
 *
 * So `verifyOnServer` does not read a boolean from anywhere. It re-derives the
 * expected nullifier from `(issuer, subject, action, signal)`, re-validates the
 * stored proof artefact, re-checks freshness against the *current* clock, and
 * confirms the binding. Only then does the caller consume the nullifier.
 *
 * `proofRef` is an opaque handle (an attempt id). The raw ID token never leaves
 * the server and is never placed in a tool result or a model message.
 */
export async function verifyOnServer(
  proofRef: string,
  expected: VerifyExpectation,
): Promise<VerifyResult> {
  const row = getAuthRequest(proofRef);
  if (!row) {
    return {
      ok: false,
      code: 'approval_not_found',
      message: 'no server-side authentication request matches this proof reference',
      reason: 'The reference is unknown, or it was issued by a different environment.',
    };
  }

  if (row.state === 'DENIED') {
    return {
      ok: false,
      code: 'approval_denied',
      message: 'the human denied this request',
      reason: row.reject_reason ?? 'denied on device',
    };
  }
  if (row.state === 'EXPIRED') {
    return {
      ok: false,
      code: 'approval_expired',
      message: 'this request expired before it was used',
      reason: row.reject_reason ?? 'window closed',
    };
  }
  if (row.state !== 'APPROVED' && row.state !== 'PENDING') {
    return {
      ok: false,
      code: 'approval_not_approved',
      message: `request is in state ${row.state}`,
      reason: row.reject_reason ?? 'not approved',
    };
  }
  if (row.state === 'PENDING') {
    return {
      ok: false,
      code: 'approval_not_approved',
      message: 'the human has not finished approving yet',
      reason: 'still pending',
    };
  }

  // ── RED LINE 6: parameters must match, or the proof is not for this action ──
  if (row.action !== expected.action) {
    return {
      ok: false,
      code: 'approval_action_mismatch',
      message: `approval is bound to action "${row.action}", not "${expected.action}"`,
      reason: 'ACTION_MISMATCH',
    };
  }
  if (row.signal !== expected.signal) {
    return {
      ok: false,
      code: 'approval_signal_mismatch',
      message: `approval is bound to signal "${row.signal}", not "${expected.signal}"`,
      reason: 'SIGNAL_MISMATCH',
    };
  }

  // Re-validate the artefact itself, on every single use.
  const artifact = await revalidateArtifact(row);
  if (!artifact.ok) {
    return {
      ok: false,
      code: 'approval_not_approved',
      message: artifact.reason,
      reason: artifact.reason,
    };
  }

  // ── RED LINE: freshness is re-evaluated NOW, not at approval time ──
  const maxAgeSec = expected.maxAgeSec ?? ID_TOKEN_MAX_AGE_SEC;
  if (!isFresh(artifact.authTime, maxAgeSec)) {
    return {
      ok: false,
      code: 'not_fresh',
      message: `authentication is older than the ${maxAgeSec}s freshness window`,
      reason: 'STALE_AUTH',
    };
  }

  // The nullifier must be re-derived from the *expected* operation. A stored
  // value would let a caller change the action and still present the old key.
  const nullifier = deriveNullifier({
    issuer: artifact.issuer,
    subject: artifact.subject,
    action: expected.action,
    signal: expected.signal,
  });

  return {
    ok: true,
    continuityId: artifact.continuityId,
    issuer: artifact.issuer,
    subject: artifact.subject,
    nullifier,
    authTime: artifact.authTime,
    proofRef,
    mode: row.mode,
  };
}

interface ArtifactIdentity {
  ok: boolean;
  reason: string;
  issuer: string;
  subject: string;
  continuityId: string;
  authTime: number;
  nullifier: string;
  acr?: string;
  amr?: string[];
}

/**
 * Re-validate the proof artefact behind an approved request.
 *
 * The two modes validate different things, and it is worth being precise:
 *
 * `local` — full HMAC re-verification on every use. The assertion is ours, so
 *           we can check the signature offline and we do.
 *
 * `oidc`  — the ID token's RS256 signature was validated by `openid-client`
 *           against the discovered JWKS during the code exchange, in the server
 *           process, using the library's bounded JWKS cache. The raw token has
 *           never been in a client's hands. On each later use we re-assert the
 *           claims that matter for authorization: exact issuer (the pinned
 *           one), audience, expiry, and the presence of `auth_time`. Re-doing a
 *           network JWKS fetch per use would add a failure mode without adding
 *           assurance, because the token is stored server-side and single-use.
 */
async function revalidateArtifact(row: AuthRequestRow): Promise<ArtifactIdentity> {
  const fail = (reason: string): ArtifactIdentity => ({
    ok: false,
    reason,
    issuer: '',
    subject: '',
    continuityId: '',
    authTime: 0,
    nullifier: '',
  });

  if (!row.proof_ref) return fail('no proof artefact stored for this request');

  if (row.mode === 'local') {
    const result = local.verifyLocalAssertion(row.proof_ref, audience());
    if (!result.ok || !result.claims) return fail(result.reason ?? 'invalid local assertion');
    const projected = local.claimsProjection(result.claims, row);
    return {
      ok: true,
      reason: 'ok',
      issuer: projected.issuer,
      subject: projected.subject,
      continuityId: projected.continuityId,
      authTime: projected.authTime,
      nullifier: projected.nullifier,
      acr: projected.acr,
      amr: projected.amr,
    };
  }

  const claims = decodeJwtPayload(row.proof_ref);
  if (!claims) return fail('stored ID token could not be parsed');

  if (claims.iss !== WORLDID_ISSUER) {
    return fail(`ID token issuer ${String(claims.iss)} is not the pinned environment`);
  }
  const creds = idpCredentials();
  if (creds && claims.aud !== creds.clientId) {
    return fail('ID token audience does not match this client');
  }
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) {
    return fail('the ID token itself has expired');
  }
  if (typeof claims.auth_time !== 'number') {
    return fail('ID token carries no auth_time, so freshness cannot be proven');
  }

  const issuer = String(claims.iss);
  const subject = String(claims.sub);
  return {
    ok: true,
    reason: 'ok',
    issuer,
    subject,
    continuityId: continuityIdFrom(issuer, subject),
    authTime: claims.auth_time * 1000,
    nullifier: row.nullifier ?? deriveNullifier({ issuer, subject, action: row.action, signal: row.signal }),
    acr: typeof claims.acr === 'string' ? claims.acr : undefined,
    amr: Array.isArray(claims.amr) ? (claims.amr as string[]) : undefined,
  };
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function audience(): string {
  return idpCredentials()?.clientId ?? publicBaseUrl();
}

// ── 4. Callback handling ────────────────────────────────────────────────────

/**
 * Complete an authorization-code attempt. Called by the callback route with the
 * full current URL; validation (state, nonce, PKCE, issuer, signature,
 * audience, expiry, `max_age` vs `auth_time`) happens inside the library.
 */
export async function completeOidcCallback(
  currentUrl: URL,
): Promise<{ ok: true; requestId: string } | { ok: false; error: string }> {
  const stateParam = currentUrl.searchParams.get('state');
  if (!stateParam) return { ok: false, error: 'missing state' };

  const { findAuthRequestByState } = await import('./requests');
  const row = findAuthRequestByState(stateParam);
  if (!row) return { ok: false, error: 'unknown or already-used authorization state' };
  if (row.state !== 'PENDING') return { ok: false, error: `attempt already ${row.state}` };
  if (row.expires_at < Date.now()) {
    markFailed(row.id, 'EXPIRED', 'attempt expired before the callback arrived');
    return { ok: false, error: 'attempt expired' };
  }

  // An authorization error is a first-class outcome, not an exception.
  const oauthError = currentUrl.searchParams.get('error');
  if (oauthError) {
    const description = currentUrl.searchParams.get('error_description') ?? oauthError;
    markFailed(row.id, oauthError === 'access_denied' ? 'DENIED' : 'FAILED', description);
    return { ok: false, error: description };
  }

  try {
    const verified = await redeemAuthorizationCode(currentUrl, row);
    markApproved(row.id, {
      authTime: verified.authTime,
      acr: verified.acr,
      amr: verified.amr,
      nullifier: verified.nullifier,
      proofRef: verified.idToken,
      continuityId: verified.continuityId,
    });
    return { ok: true, requestId: row.id };
  } catch (err) {
    const message = explainOidcError(err);
    markFailed(row.id, 'FAILED', message);
    return { ok: false, error: message };
  }
}

/**
 * Say what the IdP actually said.
 *
 * The first real sign-in on the public deployment failed with, in full:
 *
 *   server responded with an error in the response body
 *
 * which is `oauth4webapi`'s message for "the token endpoint returned 4xx JSON".
 * It is an accurate sentence and a useless one: the interesting part — the
 * `error` code the IdP chose — is one level up, in `ResponseBodyError.cause`,
 * and nothing surfaced it. Diagnosing that took a database query and a read of
 * the library's source, which is not a reasonable thing to ask of whoever is
 * holding the phone.
 *
 * So: unwrap the cause chain and include the IdP's own error code, its
 * description, and the HTTP status. Never the response body wholesale — a token
 * response can carry tokens, and this string is rendered in a URL.
 *
 * Written generically rather than against `ResponseBodyError` so an error shape
 * from a future library version still yields something better than nothing.
 */
export function explainOidcError(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  let node: unknown = err;
  for (let depth = 0; depth < 3 && node && typeof node === 'object' && !seen.has(node); depth += 1) {
    seen.add(node);
    const record = node as Record<string, unknown>;

    if (typeof record.error === 'string' && record.error) {
      const description =
        typeof record.error_description === 'string' ? ` (${record.error_description})` : '';
      parts.push(`${record.error}${description}`);
    } else if (node instanceof Error && node.message && !parts.includes(node.message)) {
      parts.push(node.message);
    }

    const response = record.response as { status?: number } | undefined;
    if (typeof response?.status === 'number') parts.push(`HTTP ${response.status}`);

    node = record.cause;
  }

  return parts.length ? [...new Set(parts)].join(' · ') : String(err);
}

/**
 * Human pressed "approve" on the local fallback page.
 *
 * When the attempt already belongs to a linked human — a step-up for a purchase
 * or a transfer — the subject is taken from that human's stored `(issuer,
 * subject)` pair rather than from whatever handle was typed. Otherwise a step-up
 * could silently switch identity, which is exactly what step-up must never do:
 *
 *   "Require the returned `(iss, sub)` to match the account awaiting step-up.
 *    Reject or separately handle an account change; never upgrade the original
 *    account on that result."
 */
export function completeLocalAuth(
  requestId: string,
  handle: string,
  opts: { authTimeOverride?: number } = {},
): { ok: boolean; error?: string; continuityId?: string } {
  const row = getAuthRequest(requestId);
  if (!row) return { ok: false, error: 'unknown request' };
  if (row.mode !== 'local') return { ok: false, error: 'this request is not a local attempt' };
  if (row.state !== 'PENDING') return { ok: false, error: `attempt already ${row.state}` };

  // Prefer the linked identity so a step-up cannot change who is acting.
  let subject = `local-${handle}`;
  let issuer = local.LOCAL_ISSUER;
  if (row.continuity_id) {
    const human = getHuman(row.continuity_id);
    if (human) {
      issuer = human.issuer;
      subject = human.subject;
    }
  }

  const { assertion, claims } = local.mintLocalAssertion({
    handle: subject,
    issuer,
    audience: audience(),
    authTimeOverride: opts.authTimeOverride,
  });

  const projected = local.claimsProjection(claims, row);
  markApproved(requestId, {
    authTime: projected.authTime,
    acr: projected.acr,
    amr: projected.amr,
    nullifier: projected.nullifier,
    proofRef: assertion,
    continuityId: projected.continuityId,
  });
  return { ok: true, continuityId: projected.continuityId };
}

/** Human pressed "deny" on any authorization surface. */
export function denyAuth(requestId: string, reason = 'denied by the human'): void {
  const row = getAuthRequest(requestId);
  if (!row || row.state !== 'PENDING') return;
  markFailed(requestId, 'DENIED', reason);
}

// ── 5. Status ───────────────────────────────────────────────────────────────

export interface IdpStatus {
  mode: ReturnType<typeof idpMode>;
  degraded: boolean;
  issuer: string;
  redirectUri: string;
  hasCredentials: boolean;
  reachable: boolean | null;
  detail: string;
}

let reachability: { value: boolean; at: number } | null = null;

export async function idpStatus(probe = false): Promise<IdpStatus> {
  const mode = idpMode();
  const creds = idpCredentials();
  let reachable: boolean | null = null;

  if (probe) {
    try {
      await configuration();
      reachable = true;
      reachability = { value: true, at: Date.now() };
    } catch {
      reachable = false;
      reachability = { value: false, at: Date.now() };
    }
  } else {
    reachable = reachability?.value ?? null;
  }

  return {
    mode,
    degraded: mode === 'local',
    issuer: WORLDID_ISSUER,
    redirectUri: redirectUri(),
    hasCredentials: Boolean(creds),
    reachable,
    detail:
      mode === 'local'
        ? 'Running the documented LOCAL FALLBACK: no portal-issued OIDC client credentials. ' +
          'Identity is simulated; every authorization check is real.'
        : `Using the real Human Continuity IdP over OIDC (${mode}).`,
  };
}

export function getAuthRequestRow(requestId: string): AuthRequestRow | undefined {
  return getAuthRequest(requestId);
}
