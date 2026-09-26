/**
 * ============================================================================
 *  The request context: which event, and the cookie that remembers it.
 * ============================================================================
 *
 * This was a `middleware.ts` first, and that does not work here. Next compiles
 * middleware for the Edge runtime, so importing anything that reaches
 * `better-sqlite3` fails the build with `Module not found: Can't resolve 'fs'` —
 * and the first version only escaped that by accident, because nothing in the
 * middleware's import graph touched the database until `ensureSandbox()` ran.
 * The moment it did, the server returned a 500 for every request.
 *
 * So the work happens in the Node runtime instead, at exactly one place: the
 * `route()` wrapper every API handler already goes through. That keeps the
 * property the middleware was there for — a new route is scoped correctly
 * without its author knowing sandboxes exist — without depending on an
 * experimental Node middleware flag.
 *
 * Pages are not covered by the wrapper, and do not need to be: a server-rendered
 * page reads its data through the same API routes, so the visitor's first poll
 * establishes the event. `/board` renders on the server for a faster first
 * paint, and on a visitor's very first load that paint is momentarily the seeded
 * event rather than their own; the poll that follows replaces it.
 */
import type { NextRequest, NextResponse } from 'next/server';
import { runWithEvent } from './eventcontext';
import { getEvent } from './humans';
import {
  SANDBOX_COOKIE,
  ensureSandbox,
  readSandboxCookie,
  sandboxCookieFor,
  sandboxEnabled,
} from './sandbox';

/** What the wrapper needs in order to finish the response. */
export interface SandboxCookie {
  name: string;
  value: string;
  maxAge: number;
}

export function sandboxCookieOptions(cookie: SandboxCookie): {
  name: string;
  value: string;
  httpOnly: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  return { ...cookie, httpOnly: true, sameSite: 'lax', path: '/', maxAge: cookie.maxAge };
}

/**
 * Run `fn` with this request's event established.
 *
 * ── The cookie names the event this request used, whatever chose it ─────────
 *
 * Not "the visitor's event, created on first sight". An explicit `?eventId=` in
 * the request wins over the cookie — the scripts and the automated checks rely
 * on that — and when it does, the cookie has to be updated to match. Otherwise a
 * session drifts: the handler works on the event the caller named while the jar
 * still points at an older one, and the next request goes somewhere else again.
 * That is not hypothetical: it is what made `npm run e2e` fail with a perfectly
 * healthy-looking server, because the queue join and the approval it was later
 * checked against ended up in different events.
 *
 * `cookie` is non-null exactly when the visitor's jar needs correcting, which is
 * the first sight of a new visitor and any request that named a different event.
 */
export async function runInRequestContext<T>(
  req: NextRequest,
  fn: () => Promise<T>,
): Promise<{ result: T; cookie: SandboxCookie | null }> {
  if (!sandboxEnabled()) return { result: await fn(), cookie: null };

  const requested = readSandboxCookie(req.cookies.get(SANDBOX_COOKIE)?.value);

  // An explicit event id is the caller stating where it wants to be. It is not
  // sandbox-scoped by itself — it may name the seeded stage event — so a sandbox
  // is only minted when nothing was named at all.
  const named = new URL(req.url).searchParams.get('eventId');

  if (named) {
    // Verify the event exists before scoping to it, so a typo is a clear 404
    // from the handler rather than a confusing fallback.
    const target = getEvent(named);
    if (target) {
      const result = await runWithEvent({ eventId: named, kind: 'sandbox' }, fn);
      // The cookie follows the caller onto a *private* event, so a script that
      // impersonates an account gets a session that stays where it was put.
      // It does not follow them onto the seeded stage event: that is shared
      // ground, and a visitor who once named it would otherwise be pinned to it
      // for the rest of their session instead of their own demo.
      const cookie = target.sandbox === 1 && requested !== named ? sandboxCookieFor(named) : null;
      return { result, cookie };
    }
  }

  const handle = ensureSandbox(requested);
  const result = await runWithEvent({ eventId: handle.event.id, kind: 'sandbox' }, fn);

  return {
    result,
    cookie: requested === handle.event.id ? null : sandboxCookieFor(handle.event.id),
  };
}

/** Attach the cookie when one was minted. A no-op otherwise. */
export function applySandboxCookie(res: NextResponse, cookie: SandboxCookie | null): NextResponse {
  if (cookie) res.cookies.set(sandboxCookieOptions(cookie));
  return res;
}
