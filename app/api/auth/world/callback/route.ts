import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { ensureHuman, touchFreshAuth } from '@/lib/humans';
import { issueSession } from '@/lib/session';
import { audit } from '@/lib/audit';
import * as worldid from '@/worldid';

/**
 * OIDC redirect target.
 *
 * Everything that makes this safe happens inside `worldid.completeOidcCallback`:
 * the library validates `state`, `nonce`, PKCE, issuer, RS256 signature against
 * the discovered JWKS, audience, expiry, and `max_age` versus `auth_time`. This
 * route only turns a successful result into a local session.
 *
 * Note the direction of trust: the browser arrives with a `code`, not with a
 * verdict. Even here — the one place a client could try to assert a result — the
 * server does its own exchange and ignores anything the client claims.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);

  // An IdP-side refusal is a first-class outcome, not a crash.
  const oauthError = url.searchParams.get('error');
  if (oauthError) {
    const result = await worldid.completeOidcCallback(url);
    return redirectWith(url, '/', {
      authError: oauthError,
      authDetail: result.ok ? 'unexpected' : result.error,
    });
  }

  const result = await worldid.completeOidcCallback(url);
  if (!result.ok) {
    return redirectWith(url, '/', { authError: 'callback_failed', authDetail: result.error });
  }

  const outcome = await worldid.awaitAuthResult(result.requestId);
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
  return response;
}

/** Always land back on the app, carrying the outcome in the query string. */
function redirectWith(url: URL, path: string, params: Record<string, string>): NextResponse {
  const target = new URL(path, url.origin);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return NextResponse.redirect(target);
}
