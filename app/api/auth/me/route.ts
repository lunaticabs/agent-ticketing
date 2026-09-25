import { json, route, requireContinuity } from '@/lib/api';
import { getHuman } from '@/lib/humans';
import { activeGrants } from '@/lib/grants';
import { idpStatus } from '@/worldid';
import { primaryEvent } from '@/lib/humans';

/** Who does this session belong to, and what may they do? */
export const GET = route(async (req) => {
  const continuityId = requireContinuity(req);
  const human = getHuman(continuityId);
  const event = primaryEvent();
  const idp = await idpStatus(false);

  return json({
    ok: true,
    continuityId,
    issuer: human?.issuer ?? null,
    lastFreshAuthAt: human?.last_fresh_auth_at ?? null,
    grants: activeGrants(continuityId, event.id).map((g) => ({
      id: g.id,
      scope: g.scope,
      expiresAt: g.expires_at,
    })),
    idp: { mode: idp.mode, degraded: idp.degraded },
  });
});
