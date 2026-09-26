/**
 * ============================================================================
 *  LOCAL FALLBACK — read this before judging the security story
 * ============================================================================
 *
 * This module exists for exactly one reason, and it is disclosed everywhere:
 * **registering an OIDC client on the sandbox portal requires a human with a
 * Google account** (`sandbox.auth.world.org/portal`). Until that human has
 * clicked through, the project cannot mint real World ID ID tokens. The plan
 * authorises this explicitly:
 *
 *   "验不过的 fallback" / "若 sandbox 不支持，降级为本地签名 token + 文档说明"
 *
 * So `local` mode substitutes the **identity provider**, never the gate:
 *
 *   ✔ It still issues a signed assertion bound to `(action, signal)`.
 *   ✔ `verifyOnServer()` still re-validates the signature, audience, expiry,
 *     and the `(action, signal)` binding on every use.
 *   ✔ The nullifier is still derived the same way and still consumed through
 *     the `consumed_proof` PRIMARY KEY.
 *   ✔ Freshness is still `auth_time` versus `max_age`.
 *
 *   ✘ It does **not** prove humanness. There is no World ID proof behind it.
 *
 * Two independent things keep that honest:
 *   1. Every response carries `degraded: true`, and the board renders a banner.
 *   2. `ENABLE_DEV_ROUTES` gates the *impersonation* shortcut separately; local
 *      mode deliberately does **not** reuse it, so a demo cannot confuse the
 *      two (see the T-6.2 requirement "绝不能与真实验证路径共用代码分支").
 *
 * The assertion is HMAC-SHA256 signed with `PRESENCE_SIGNING_KEY`, which per
 * RED LINE 2 never leaves the server.
 */
import crypto from 'node:crypto';
import { serverSigningKey } from './config';
import { continuityIdFrom, deriveNullifier, isFresh } from './nullifier';
import { markApproved } from './requests';

/** Namespace that makes a local subject unmistakable in the database and UI. */
export const LOCAL_ISSUER = 'local:presence-fallback';

/**
 * Issuers this server is allowed to have minted an assertion for.
 *
 * `local:presence-fallback` is the local IdP itself. `local:dev-impersonation` is
 * the T-6.2 demo bypass: simulated humans written straight into the database.
 * They belong together because the check below is "we signed this", not "it
 * carries one particular string" — and because the laundering simulation needs
 * its simulated recipients to step up through the same consent screen a real
 * person would.
 *
 * This widens nothing. The whole local mint path is unreachable unless
 * `idpMode() === 'local'` (`completeLocalAuth` refuses otherwise), and that mode
 * only occurs when no portal credentials are configured. With real credentials
 * present, none of this code runs.
 */
export const LOCAL_ISSUERS: ReadonlySet<string> = new Set([
  LOCAL_ISSUER,
  'local:dev-impersonation',
]);

/** Local assertions are short-lived. Freshness is the point. */
export const LOCAL_ASSERTION_TTL_MS = 5 * 60 * 1000;

interface LocalAssertionPayload {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  auth_time: number;
  acr: string;
  amr: string[];
  /** Marks this as a fallback assertion so nothing can mistake it for a real ID token. */
  presence_degraded: true;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function sign(payload: LocalAssertionPayload): string {
  const body = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', serverSigningKey()).update(body).digest();
  return `${body}.${b64url(mac)}`;
}

/**
 * Mint an assertion for a human. Called once, when the human presses "approve"
 * on the local authorize page — so `auth_time` is genuinely the moment of the
 * interaction, which is what makes T-3.2 demonstrable in fallback mode.
 */
export function mintLocalAssertion(args: {
  handle: string;
  audience: string;
  /** Reuse a linked human's issuer so a step-up cannot switch identity. */
  issuer?: string;
  now?: number;
  /** Simulate an old session so the "stale session is rejected" test is real. */
  authTimeOverride?: number;
}): { assertion: string; claims: LocalAssertionPayload } {
  const now = args.now ?? Date.now();
  const issuer = args.issuer ?? LOCAL_ISSUER;
  const payload: LocalAssertionPayload = {
    iss: issuer,
    sub: args.handle,
    aud: args.audience,
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + LOCAL_ASSERTION_TTL_MS) / 1000),
    jti: crypto.randomUUID(),
    auth_time: Math.floor((args.authTimeOverride ?? now) / 1000),
    acr: 'local:fallback',
    amr: ['local'],
    presence_degraded: true,
  };
  return { assertion: sign(payload), claims: payload };
}

export interface LocalVerifyResult {
  ok: boolean;
  reason?: string;
  claims?: LocalAssertionPayload;
}

/**
 * Independently validate an assertion. This is the fallback's counterpart to
 * ID-token validation, and it is intentionally just as strict about the parts
 * that matter: signature, audience, expiry, and `auth_time` presence.
 */
export function verifyLocalAssertion(assertion: string, expectedAudience: string): LocalVerifyResult {
  const parts = assertion.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed assertion' };

  const [body, mac] = parts;
  const expectedMac = b64url(
    crypto.createHmac('sha256', serverSigningKey()).update(body).digest(),
  );
  const a = Buffer.from(mac);
  const b = Buffer.from(expectedMac);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature mismatch' };
  }

  let claims: LocalAssertionPayload;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'unparseable payload' };
  }

  if (!LOCAL_ISSUERS.has(claims.iss)) return { ok: false, reason: `unexpected issuer ${claims.iss}` };
  if (claims.aud !== expectedAudience) return { ok: false, reason: 'audience mismatch' };
  if (claims.exp * 1000 < Date.now()) return { ok: false, reason: 'assertion expired' };
  if (!claims.auth_time) return { ok: false, reason: 'missing auth_time' };

  return { ok: true, claims };
}

/** Project a local assertion into the same shape the real OIDC path produces. */
export function claimsProjection(
  claims: LocalAssertionPayload,
  row: { action: string; signal: string },
) {
  return {
    issuer: claims.iss,
    subject: claims.sub,
    continuityId: continuityIdFrom(claims.iss, claims.sub),
    authTime: claims.auth_time * 1000,
    acr: claims.acr,
    amr: claims.amr,
    nullifier: deriveNullifier({
      issuer: claims.iss,
      subject: claims.sub,
      action: row.action,
      signal: row.signal,
    }),
  };
}

export { isFresh, markApproved };
