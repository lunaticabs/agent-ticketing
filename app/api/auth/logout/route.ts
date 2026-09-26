import { json, route } from '@/lib/api';
import { SESSION_COOKIE } from '@/lib/session';
import { carrySandboxCookie } from '@/lib/sandboxcookie';

/**
 * Clear the local session.
 *
 * Note what this does not do: it does not revoke anything at the IdP. The
 * sandbox `oidc` guide says so explicitly — "IdP logout ends the IdP browser
 * session. It does not revoke relying-party sessions, tokens, grants, or
 * benefits" — so we only drop our own cookie and say so.
 */
export const POST = route(async (req) => {
  const response = json({
    ok: true,
    note: 'local session cleared; the IdP session and any grants are untouched',
  });
  response.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  // The private event is not part of the session: signing out and back in should
  // return the visitor to the demo they were in the middle of.
  carrySandboxCookie(req, response);
  return response;
});
