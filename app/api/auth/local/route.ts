import { json, route, readJson } from '@/lib/api';
import { ensureHuman, touchFreshAuth } from '@/lib/humans';
import { issueSession } from '@/lib/session';
import { audit } from '@/lib/audit';
import * as worldid from '@/worldid';

/**
 * The local fallback's "approve" button.
 *
 * This is the `local` mode counterpart of the OIDC callback, and it is worth
 * being clear about the trust boundary: this route exists because no portal
 * credentials are configured, so the identity provider is simulated. Everything
 * *after* it is the real machinery — the assertion it mints is signed with the
 * server key, stored server-side, re-validated on every use, and still has to
 * pass the binding and freshness checks.
 *
 * `stale: true` mints an assertion whose `auth_time` is an hour old. That is not
 * a bypass; it is how T-3.2's "an old session must be refused" is demonstrated
 * without waiting an hour.
 */
export const POST = route(async (req) => {
  const body = await readJson(req);
  const requestId = String(body.requestId ?? '');
  const handle = String(body.handle ?? '').trim();
  const stale = body.stale === true;

  if (!requestId) return json({ ok: false, code: 'bad_request', message: 'requestId is required' }, { status: 400 });

  const row = worldid.getAuthRequestRow(requestId);
  if (!row) return json({ ok: false, code: 'not_found', message: 'unknown request' }, { status: 404 });

  // For a link attempt a handle is required; for a step-up the identity is
  // already known and the handle is ignored on purpose.
  if (row.intent === 'link' && !handle) {
    return json(
      { ok: false, code: 'bad_request', message: 'choose a handle to link as' },
      { status: 400 },
    );
  }

  const result = worldid.completeLocalAuth(requestId, handle || 'linked-human', {
    authTimeOverride: stale ? Date.now() - 60 * 60 * 1000 : undefined,
  });

  if (!result.ok) {
    return json({ ok: false, code: 'verification_failed', message: result.error ?? 'failed' }, { status: 400 });
  }

  const outcome = await worldid.awaitAuthResult(requestId);
  if (!outcome.ok) {
    return json({ ok: false, code: outcome.code, message: outcome.message }, { status: 400 });
  }

  audit({
    type: 'auth.local_completed',
    continuityId: outcome.continuityId,
    severity: 'warn',
    payload: {
      requestId,
      intent: row.intent,
      stale,
      authTime: outcome.authTime,
      note: 'LOCAL FALLBACK approval — simulated identity, real authorization checks',
    },
  });

  // A link attempt establishes a session; a step-up does not need a new one.
  if (row.intent === 'link') {
    const human = ensureHuman(outcome.issuer, outcome.subject);
    touchFreshAuth(human.continuity_id, outcome.authTime);
    const session = issueSession(human.continuity_id);
    const response = json({
      ok: true,
      linked: true,
      continuityId: human.continuity_id,
      degraded: true,
      note: 'Local fallback: identity is simulated. Every gate still verifies.',
    });
    response.cookies.set(session.name, session.value, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: session.maxAge,
    });
    return response;
  }

  return json({
    ok: true,
    linked: false,
    continuityId: outcome.continuityId,
    stale,
    authTime: outcome.authTime,
    degraded: true,
    note: stale
      ? 'Minted an assertion with an old auth_time — the gate must refuse it as not fresh.'
      : 'Fresh assertion minted. The gate will verify the binding and freshness itself.',
  });
});
