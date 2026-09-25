/**
 * ============================================================================
 *  RED LINE 4 — the environment is pinned HERE, in the server, as a constant.
 * ============================================================================
 *
 * The World ID docs for the human-in-the-loop flow state it plainly:
 *
 *   "The approval is untrusted input: pin the environment so it can't select
 *    'staging' or 'sandbox', which accept test proofs."
 *
 * So: this module is the *only* place an environment appears, it is a literal,
 * it is not read from the request, and — deliberately — **no exported function
 * in `worldid/` accepts an `environment` argument**. If a caller sends one in a
 * request body the API layer rejects the request outright with
 * `environment_pinned` rather than silently ignoring it, because silently
 * ignoring it hides an attempted bypass from the audit trail.
 *
 * ---------------------------------------------------------------------------
 *  A note on the word "sandbox"
 * ---------------------------------------------------------------------------
 * World's docs use "sandbox" for two unrelated things:
 *
 *   ① IDKit's `environment: "sandbox"` — a test *proof* endpoint. No
 *      continuity, no fresh auth, no OAuth surface.
 *   ② https://sandbox.auth.world.org — the Human Continuity **IdP**. An OIDC
 *      provider. This is the one the hackathon track asks for.
 *
 * We use ②. `WORLDID_ENVIRONMENT` below names the assurance profile we accept
 * proofs from; `WORLDID_ISSUER` names the ② deployment we talk to.
 */

/** Assurance profile we accept. Constant. Never a parameter. */
export const WORLDID_ENVIRONMENT = 'sandbox' as const;

/** ② The Human Continuity IdP. Confirmed live via `/.well-known/openid-configuration`. */
export const WORLDID_ISSUER =
  process.env.WORLDID_ISSUER?.trim() || 'https://sandbox.auth.world.org';

/** The one and only supported scope. `profile`, `email`, `offline_access` are rejected by the IdP. */
export const WORLDID_SCOPE = 'openid';

/** The implemented authentication class, per the `step-up` guide. */
export const WORLDID_ACR_ORB_V3 = 'https://world.org/oidc/acr/orb-v3';

/**
 * How the project talks to World ID.
 *
 *  - `oidc`  : real authorization-code + PKCE against `WORLDID_ISSUER`.
 *  - `device`: real RFC 8628 device grant — the headless-agent path. The
 *              sandbox advertises `device_authorization_endpoint`, so agents do
 *              not have to fake anything (spike S-5 answered YES).
 *  - `local` : **documented fallback**, used only when no portal-issued client
 *              credentials exist. It substitutes a locally-signed assertion for
 *              the IdP's ID token. It fakes the *identity provider*; it does NOT
 *              fake the gate — every binding, freshness and one-time-use check
 *              still runs. See `worldid/local.ts`.
 */
export type IdpMode = 'oidc' | 'device' | 'local';

export interface IdpCredentials {
  clientId: string;
  clientSecret: string;
  /** Portal default is `client_secret_basic`; `client_secret_post` also supported. */
  tokenAuthMethod: 'client_secret_basic' | 'client_secret_post';
}

/** Portal-issued client credentials, or `null` when the portal step is not done yet. */
export function idpCredentials(): IdpCredentials | null {
  const clientId = process.env.WORLDID_CLIENT_ID?.trim();
  const clientSecret = process.env.WORLDID_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const method = process.env.WORLDID_TOKEN_AUTH_METHOD?.trim();
  return {
    clientId,
    clientSecret,
    tokenAuthMethod: method === 'client_secret_post' ? 'client_secret_post' : 'client_secret_basic',
  };
}

export function hasRealIdp(): boolean {
  return idpCredentials() !== null;
}

/** Requested mode, downgraded to `local` when credentials are absent. */
export function idpMode(): IdpMode {
  const requested = (process.env.PRESENCE_IDP_MODE?.trim() || 'auto').toLowerCase();
  if (!hasRealIdp()) return 'local';
  if (requested === 'device') return 'device';
  if (requested === 'local') return 'local';
  return 'oidc';
}

/**
 * ============================================================================
 *  Where this deployment lives — ONE answer, derived, never two.
 * ============================================================================
 *
 * There are two settings that describe the same thing, and an earlier version
 * read each one independently:
 *
 *   PRESENCE_PUBLIC_URL   used to build consent links and transfer links
 *   WORLDID_REDIRECT_URI  sent to the IdP, and must match the portal byte for byte
 *
 * Left independent they can disagree, and the failure is silent and confusing:
 * with only `WORLDID_REDIRECT_URI` set to an https:// value, the login redirect
 * went to https while every link the app rendered pointed at http, and the
 * server was listening on http. Three different answers to "where am I", none of
 * them checked against the others.
 *
 * So the redirect URI wins when it is set. It is the one value that *cannot* be
 * approximated — the portal compares it byte for byte, including scheme — which
 * makes it the most reliable statement of where this deployment actually is.
 * Every other absolute URL is then derived from that origin, and
 * `baseUrlConsistency()` reports any remaining disagreement rather than letting
 * it lie.
 */
export function publicBaseUrl(): string {
  const explicit = process.env.PRESENCE_PUBLIC_URL?.trim();
  if (explicit) return stripTrailingSlash(explicit);

  // Derive from the registered redirect URI. It is the authoritative statement
  // of this deployment's origin.
  const redirect = process.env.WORLDID_REDIRECT_URI?.trim();
  if (redirect) {
    try {
      return new URL(redirect).origin;
    } catch {
      // A malformed redirect URI is reported by `baseUrlConsistency`; do not
      // let it crash link building.
    }
  }

  return 'http://localhost:3000';
}

/** The exact redirect URI. Must match the portal registration byte for byte. */
export function redirectUri(): string {
  const explicit = process.env.WORLDID_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  return `${publicBaseUrl()}/api/auth/world/callback`;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Do the two settings agree?
 *
 * Returns `consistent: false` with an explanation when they do not, so startup
 * can say so out loud instead of letting the operator discover it as an
 * `invalid_request` from the IdP or, worse, as a consent link that opens
 * nothing.
 */
export function baseUrlConsistency(): { consistent: boolean; detail: string | null } {
  const raw = process.env.WORLDID_REDIRECT_URI?.trim();
  const explicitBase = process.env.PRESENCE_PUBLIC_URL?.trim();

  if (raw) {
    let redirectOrigin: string;
    try {
      redirectOrigin = new URL(raw).origin;
    } catch {
      return { consistent: false, detail: `WORLDID_REDIRECT_URI is not a valid URL: ${raw}` };
    }
    if (explicitBase && stripTrailingSlash(explicitBase) !== redirectOrigin) {
      return {
        consistent: false,
        detail:
          `PRESENCE_PUBLIC_URL is ${stripTrailingSlash(explicitBase)} but the registered ` +
          `redirect URI is on ${redirectOrigin}`,
      };
    }
  }

  return { consistent: true, detail: null };
}

/** How long an ID token is considered usable for a single consumption (seconds). */
export const ID_TOKEN_MAX_AGE_SEC = 300;

/**
 * RED LINE 2 — the signing key lives here and only here.
 *
 * It is read from a server-side environment variable, is never returned by any
 * API, and is never embedded in a client bundle. `npm run test` greps the built
 * client bundle for it. In `local` fallback mode it signs assertions; on the
 * real OIDC path it is used for session cookies only.
 */
export function serverSigningKey(): Buffer {
  const raw = process.env.PRESENCE_SIGNING_KEY?.trim();
  if (raw && raw.length >= 32) return Buffer.from(raw, 'utf8');
  // Deterministic dev-only key so `npm run dev` works out of the box. Never
  // acceptable in a deployment; `lib/startup.ts` shouts about it.
  return Buffer.from('presence-dev-only-signing-key-do-not-use-in-production!!', 'utf8');
}

export function hasExplicitSigningKey(): boolean {
  const raw = process.env.PRESENCE_SIGNING_KEY?.trim();
  return Boolean(raw && raw.length >= 32);
}
