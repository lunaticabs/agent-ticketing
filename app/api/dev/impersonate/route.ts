import { json, route, readJson } from '@/lib/api';
import { assertDevRoutes, impersonate } from '@/lib/devmode';
import { issueSession } from '@/lib/session';

/**
 * T-6.2 — the identity stand-in.
 *
 * ⚠️ DISCLOSED BYPASS. `ENABLE_DEV_ROUTES=1` is required; without it this route
 * throws a 404 that is indistinguishable from "not deployed".
 *
 * It exists because "40 accounts" cannot be built from real World ID proofs on a
 * stage. It shares no code branch with the real verification path: it writes a
 * `human` row directly and issues a session, and it can never mint an approval.
 * See `lib/devmode.ts` for the full guardrail list.
 */
export const POST = route(async (req) => {
  assertDevRoutes();
  const body = await readJson(req);
  const handle = String(body.handle ?? body.continuityId ?? '').trim();
  if (!handle) {
    return json({ ok: false, code: 'bad_request', message: 'handle is required' }, { status: 400 });
  }

  const result = impersonate(handle);

  if (body.session === false) {
    return json({ ok: true, ...result, sessionIssued: false });
  }

  const session = issueSession(result.continuityId);
  const response = json({
    ok: true,
    ...result,
    sessionIssued: true,
    warning:
      'SIMULATED SESSION. This human was created directly in the database and never passed ' +
      'World ID verification. It is a demo prop.',
  });
  response.cookies.set(session.name, session.value, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: session.maxAge,
  });
  return response;
});
