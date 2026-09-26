/**
 * Authorization-code + S256 PKCE, wrapped.
 *
 * Nothing outside `worldid/` imports `openid-client`. That is deliberate: the
 * sandbox endpoints have already changed shape once during this build (see
 * `docs/SPIKE_NOTES.md`), and when they change again there is exactly one file
 * to fix.
 */
import * as oidc from 'openid-client';
import {
  ID_TOKEN_MAX_AGE_SEC,
  WORLDID_ACR_ORB_V3,
  WORLDID_ISSUER,
  WORLDID_SCOPE,
  idpCredentials,
  redirectUri,
} from './config';
import { continuityIdFrom, deriveNullifier } from './nullifier';
import { markApproved, markFailed, newAttemptSecrets } from './requests';
import type { AuthRequestRow } from './requests';

// ── Discovery ───────────────────────────────────────────────────────────────

let cached: { config: oidc.Configuration; at: number } | null = null;
const DISCOVERY_TTL_MS = 10 * 60 * 1000;

/**
 * Discovered server metadata, cached with a bounded refresh. The `oidc` guide
 * asks for bounded JWKS refresh and signing-key overlap handling; the library
 * owns the JWKS cache, we only bound how often we re-read the metadata.
 */
export async function configuration(): Promise<oidc.Configuration> {
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.config;
  const creds = idpCredentials();
  if (!creds) throw new Error('no World ID client credentials configured');

  const auth =
    creds.tokenAuthMethod === 'client_secret_post'
      ? oidc.ClientSecretPost(creds.clientSecret)
      : oidc.ClientSecretBasic(creds.clientSecret);

  const config = await oidc.discovery(new URL(WORLDID_ISSUER), creds.clientId, creds.clientSecret, auth);
  cached = { config, at: Date.now() };
  return config;
}

export function resetDiscoveryCache(): void {
  cached = null;
}

// ── Stage 1: build the authorization request ────────────────────────────────

export interface AuthorizationStart {
  url: string;
  stateParam: string;
  nonce: string;
  codeVerifier: string;
}

/**
 * Build the authorization URL for a fresh-authentication attempt.
 *
 * The freshness controls come straight from the `step-up` guide:
 *
 *   `max_age=0`    — "Require this transaction's own fresh World proof, even
 *                     with an existing browser session."
 *   `prompt=login` — "Require fresh World proof; overrides a larger max_age."
 *
 * `T-3.2` needs exactly this: a session established long ago must be forced
 * through a new proof, and `auth_time` must come back new. We send `max_age`
 * and `acr_values`, and deliberately do NOT send `prompt` so the IdP can fall
 * back to an interactive login instead of erroring.
 */
export async function beginAuthorization(
  input: { action: string; signal: string; maxAgeSec: number },
  secrets = newAttemptSecrets(),
): Promise<AuthorizationStart> {
  const config = await configuration();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(secrets.codeVerifier);

  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: WORLDID_SCOPE,
    state: secrets.stateParam,
    nonce: secrets.nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    // Freshness: `max_age` is the RFC 9470 knob the IdP implements.
    max_age: String(Math.max(0, Math.floor(input.maxAgeSec))),
    // Ask for the implemented class. The guide notes unsupported values do not
    // error, so the achieved `acr` is validated after the fact instead.
    acr_values: WORLDID_ACR_ORB_V3,
  });

  return { url: url.toString(), ...secrets };
}

// ── Stage 2 → 3: redeem the code, validate the ID token ─────────────────────

export interface VerifiedClaims {
  issuer: string;
  subject: string;
  continuityId: string;
  authTime: number;
  acr?: string;
  amr?: string[];
  /** Raw ID token, kept server-side. Used as the opaque `proofRef`. */
  idToken: string;
  nullifier: string;
}

/**
 * Exchange the authorization code and validate the ID token.
 *
 * `authorizationCodeGrant` performs full validation: exact issuer, RS256
 * signature against the discovered JWKS, audience, expiry, and the `state` and
 * `nonce` we bound to this attempt. It also enforces `maxAge` against the
 * token's `auth_time` when we pass it — so a stale browser session cannot
 * satisfy a `max_age=0` request.
 *
 * The guide's warning is the reason this function exists at all:
 * "Merely decoding a JWT is not validation."
 */
export async function redeemAuthorizationCode(
  currentUrl: URL,
  row: AuthRequestRow,
): Promise<VerifiedClaims> {
  const config = await configuration();
  const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: row.code_verifier ?? undefined,
    expectedState: row.state_param ?? undefined,
    expectedNonce: row.nonce ?? undefined,
    idTokenExpected: true,
  });

  const claims = tokens.claims();
  if (!claims) throw new Error('token response carried no ID token');

  return claimsFromIdToken(tokens.id_token!, claims, row);
}

/**
 * Shared claim projection.
 *
 * `auth_time` arrives in **seconds** (JWT convention) and is normalised to
 * milliseconds here so nothing downstream has to remember which unit it holds.
 */
export function claimsFromIdToken(
  idToken: string,
  claims: Record<string, unknown>,
  row: Pick<AuthRequestRow, 'action' | 'signal'>,
): VerifiedClaims {
  const issuer = String(claims.iss ?? '');
  const subject = String(claims.sub ?? '');
  if (!issuer || !subject) throw new Error('ID token is missing iss/sub');

  const authTimeSec = Number(claims.auth_time ?? claims.iat ?? 0);
  const authTime = authTimeSec * 1000;

  return {
    issuer,
    subject,
    continuityId: continuityIdFrom(issuer, subject),
    authTime,
    acr: typeof claims.acr === 'string' ? claims.acr : undefined,
    amr: Array.isArray(claims.amr) ? (claims.amr as string[]) : undefined,
    idToken,
    nullifier: deriveNullifier({
      issuer,
      subject,
      action: row.action,
      signal: row.signal,
    }),
  };
}

/**
 * Bound the lifetime of an authorization attempt. An authorization code is
 * single-use and lasts five minutes, so an attempt that is older than that
 * cannot be redeemed anyway.
 */
export function authorizationAttemptTtlMs(): number {
  return ID_TOKEN_MAX_AGE_SEC * 2 * 1000;
}

export { markApproved, markFailed };
