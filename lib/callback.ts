/**
 * ============================================================================
 *  The OIDC callback, where it can be tested
 * ============================================================================
 *
 * This lived in `app/api/auth/world/callback/route.ts` until `next build`
 * objected, and the objection is worth recording: `tsc --noEmit` was perfectly
 * happy, but Next validates its route modules against a stricter contract —
 *
 *   Type error: Route "app/api/auth/world/callback/route.ts" does not match the
 *   required types of a Next.js Route.
 *   "handleCallback" is not a valid Route export field.
 *
 * A route file may export HTTP methods and a small set of config values, and
 * nothing else. So the logic moved here, the route became four lines, and the
 * handler became reachable from a test — which is the reason it was exported in
 * the first place. Worth noting that `npm test` and `npm run typecheck` would
 * never have caught this; only building does.
 *
 * ── Why the request URL is rebuilt before it is used ───────────────────────
 *
 * `req.url` is not this deployment's public address. It is whatever the server
 * believes about itself, and behind a proxy that is an internal one: the
 * container binds `0.0.0.0:3000`, so the URL arriving at the callback reads
 * `https://0.0.0.0:3000/api/auth/world/callback?...`. Two things then go wrong
 * at once, and the second is the one that breaks sign-in:
 *
 *   1. the post-callback redirect sends the browser to `https://0.0.0.0:3000/`,
 *      an address that exists only inside the container; and
 *   2. the OIDC library's code exchange derives the token request's
 *      `redirect_uri` from this URL — `stripParams(currentUrl)`, read in its
 *      source, not from the configuration — so the exchange presents a redirect
 *      URI that does not match the portal registration, and the IdP refuses it.
 *
 *      (Written without naming the library package, deliberately: the security
 *      self-check forbids that name anywhere outside `worldid/`, comment or
 *      import, and loosening a check meant to catch a second OIDC implementation
 *      so a comment could mention one would be the wrong trade. The exact call is
 *      named in `lib/selfcall.ts`'s sibling note and in the commit message.)
 *
 * `publicBaseUrl()` is the authoritative answer: it is derived from
 * `WORLDID_REDIRECT_URI`, the one value that cannot be approximated because the
 * portal compares it byte for byte. Rebuilding the URL here fixes both, and it
 * is correct wherever the app runs — on a laptop with no proxy the two origins
 * agree, so nothing changes.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { ensureHuman, touchFreshAuth } from './humans';
import { issueSession } from './session';
import { carrySandboxCookie } from './sandboxcookie';
import { audit } from './audit';
import { publicBaseUrl } from '../worldid/config';
import * as worldid from '../worldid';

/** The IdP calls this route needs, passed in so a test can drive the whole thing. */
export interface CallbackDeps {
  completeOidcCallback: typeof worldid.completeOidcCallback;
  awaitAuthResult: typeof worldid.awaitAuthResult;
}

/** The real thing, wired to the real IdP. */
export const realDeps: CallbackDeps = {
  completeOidcCallback: worldid.completeOidcCallback,
  awaitAuthResult: worldid.awaitAuthResult,
};

export async function handleCallback(req: NextRequest, deps: CallbackDeps): Promise<NextResponse> {
  const url = authoritativeCallbackUrl(req);

  // An IdP-side refusal is a first-class outcome, not a crash.
  const oauthError = url.searchParams.get('error');
  if (oauthError) {
    const result = await deps.completeOidcCallback(url);
    return redirectWith(url, '/', {
      authError: oauthError,
      authDetail: result.ok ? 'unexpected' : result.error,
    });
  }

  const result = await deps.completeOidcCallback(url);
  if (!result.ok) {
    return redirectWith(url, '/', { authError: 'callback_failed', authDetail: result.error });
  }

  const outcome = await deps.awaitAuthResult(result.requestId);
  if (!outcome.ok) {
    return redirectWith(url, '/', { authError: outcome.code, authDetail: outcome.message });
  }

  // T-0.4: the same human must resolve to the same continuity id every time,
  // and a different human to a different one. `ensureHuman` keys on the UNIQUE
  // (issuer, subject) pair, so that is a database guarantee, not a code path.
  const human = ensureHuman(outcome.issuer, outcome.subject);
  touchFreshAuth(human.continuity_id, outcome.authTime);

  audit({
    type: 'auth.linked',
    continuityId: human.continuity_id,
    payload: {
      requestId: result.requestId,
      mode: outcome.mode,
      authTime: outcome.authTime,
      acr: outcome.acr,
      amr: outcome.amr,
      note: 'identity linked from the IdP subject; this proof is not consumed, it only establishes who',
    },
  });

  const session = issueSession(human.continuity_id);
  const response = redirectWith(url, '/', { linked: '1' });
  response.cookies.set(session.name, session.value, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: session.maxAge,
  });
  // Signing in must not move the visitor to a different private event. See
  // `lib/sandboxcookie.ts`.
  carrySandboxCookie(req, response);
  return response;
}

/**
 * The callback URL as the *browser and the IdP* see it, not as the server does.
 *
 * The path and the query are taken from the real request — they carry `code` and
 * `state`, which are the whole point — while the origin is replaced by the
 * configured public base URL. Both halves matter: the query must be untouched,
 * and the origin must be the registered one.
 */
function authoritativeCallbackUrl(req: NextRequest): URL {
  const incoming = new URL(req.url);
  return new URL(`${incoming.pathname}${incoming.search}`, publicBaseUrl());
}

/** Always land back on the app, carrying the outcome in the query string. */
function redirectWith(url: URL, path: string, params: Record<string, string>): NextResponse {
  const target = new URL(path, url.origin);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return NextResponse.redirect(target);
}
