/**
 * ============================================================================
 *  Carrying the private-event cookie across a cookie-setting response.
 * ============================================================================
 *
 * `middleware.ts` sets the private-event cookie only when a visitor does not
 * have one, which is the right shape for a page load: set it once, then leave it
 * alone. But several routes answer with a *new* cookie jar of their own —
 * `/api/auth/local`, the World ID callback, the impersonation route — and a
 * response that replaces the session cookie while dropping the event cookie
 * would move that visitor onto a different event mid-flow. The symptom would be
 * subtle and awful: sign in, and your half-finished queue entry is gone.
 *
 * So any route that sets a cookie re-states this one too. Both helpers are no-ops
 * when `ENABLE_SANDBOX=1` is unset, which is the case for local dev and the test
 * suite.
 *
 * The value is read from the *request*, not re-encoded, so it can only ever name
 * the event the middleware already validated and put in the request store. An
 * edited cookie has already been discarded by then.
 */
import type { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { currentEventId } from './eventcontext';
import { SANDBOX_COOKIE, sandboxCookieFor, sandboxEnabled, sandboxMaxAgeSec } from './sandbox';

/** For route handlers holding both the request and the response. */
export function carrySandboxCookie(req: NextRequest, res: NextResponse): void {
  if (!sandboxEnabled()) return;
  const existing = req.cookies.get(SANDBOX_COOKIE)?.value;
  if (existing) {
    // Already in the visitor's jar and not being replaced: re-state the max-age
    // so an active visitor's event cannot expire underneath them.
    res.cookies.set({
      name: SANDBOX_COOKIE,
      value: existing,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: sandboxMaxAgeSec(),
    });
    return;
  }
  const eventId = currentEventId();
  if (eventId) res.cookies.set({ ...sandboxCookieFor(eventId), httpOnly: true, sameSite: 'lax', path: '/' });
}

/** For server components and route handlers that only need to redirect. */
export async function setSandboxCookieFromRequest(): Promise<void> {
  if (!sandboxEnabled()) return;
  const eventId = currentEventId();
  if (!eventId) return;
  const jar = await cookies();
  if (jar.get(SANDBOX_COOKIE)) return;
  jar.set({ ...sandboxCookieFor(eventId), httpOnly: true, sameSite: 'lax', path: '/' });
}
