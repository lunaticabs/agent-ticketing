import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { handleCallback, realDeps } from '@/lib/callback';

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
 *
 * The body lives in `lib/callback.ts` for two reasons: Next allows a route file
 * to export HTTP methods and nothing else (it rejected the extra export with
 * "not a valid Route export field", at build time only — `tsc` and `npm test`
 * were both happy), and a handler in `lib/` can be driven by a test. Both the
 * origin rebuilding and the error unwrapping there exist because of a real
 * production failure; see that file's header.
 */
export function GET(req: NextRequest): Promise<NextResponse> {
  return handleCallback(req, realDeps);
}
