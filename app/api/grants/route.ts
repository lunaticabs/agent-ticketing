import { json, route, requireContinuity, readJson } from '@/lib/api';
import { issueGrant, listGrants, activeGrants, describeScope, type GrantScope } from '@/lib/grants';
import { primaryEvent } from '@/lib/humans';

const SCOPES: GrantScope[] = ['mentor:+1', 'mentor:+3', 'mentor:+5', 'vip:skip_queue'];

/**
 * T-5.1 — issue and inspect delegated authorizations.
 *
 * A grant is a scoped, expiring, revocable record, not a role. This route is the
 * whole "authorization admin" surface: the concept doc explicitly rules out a
 * management back office for a 48-hour build, and an enum plus one scope check is
 * all the demo needs.
 */
export const POST = route(async (req) => {
  requireContinuity(req);
  const body = await readJson(req);
  const eventId = typeof body.eventId === 'string' ? body.eventId : primaryEvent().id;

  const scope = String(body.scope ?? '') as GrantScope;
  if (!SCOPES.includes(scope)) {
    return json(
      { ok: false, code: 'bad_request', message: `scope must be one of ${SCOPES.join(', ')}` },
      { status: 400 },
    );
  }
  const grantee = String(body.grantee ?? '').trim();
  if (!grantee) {
    return json({ ok: false, code: 'bad_request', message: 'grantee (continuity id) is required' }, { status: 400 });
  }

  const ttlSec = typeof body.ttlSec === 'number' && body.ttlSec > 0 ? Math.floor(body.ttlSec) : null;

  const grant = issueGrant({
    eventId,
    granteeContinuityId: grantee,
    scope,
    ttlSec,
    note: typeof body.note === 'string' ? body.note : undefined,
  });

  return json({
    ok: true,
    grant: {
      id: grant.id,
      scope: grant.scope,
      description: describeScope(grant.scope),
      grantee: grant.grantee_continuity_id,
      issuedAt: grant.issued_at,
      expiresAt: grant.expires_at,
      revokedAt: grant.revoked_at,
    },
    note: 'Scoped and expiring: privileges decay on their own instead of being permanent god-mode.',
  });
});

export const GET = route(async (req) => {
  const continuityId = requireContinuity(req);
  const url = new URL(req.url);
  const eventId = url.searchParams.get('eventId') ?? primaryEvent().id;
  const now = Date.now();

  return json({
    ok: true,
    mine: activeGrants(continuityId, eventId).map((g) => ({
      id: g.id,
      scope: g.scope,
      description: describeScope(g.scope),
      expiresAt: g.expires_at,
    })),
    all: listGrants(eventId).map((g) => ({
      id: g.id,
      scope: g.scope,
      description: describeScope(g.scope),
      grantee: g.grantee_continuity_id,
      issuedAt: g.issued_at,
      expiresAt: g.expires_at,
      revokedAt: g.revoked_at,
      active: g.revoked_at === null && (g.expires_at === null || g.expires_at > now),
    })),
  });
});
