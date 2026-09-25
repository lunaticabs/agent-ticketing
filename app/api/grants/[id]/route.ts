import { json, route, requireContinuity } from '@/lib/api';
import { revokeGrant } from '@/lib/grants';

/** T-5.1 acceptance — revocation takes effect immediately, because nothing is cached. */
export const DELETE = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  requireContinuity(req);
  const { id } = await ctx.params;
  const grant = revokeGrant(id);
  return json({
    ok: true,
    grant: {
      id: grant.id,
      scope: grant.scope,
      revokedAt: grant.revoked_at,
    },
    note: 'Revoked. The next scope check reads this row, so the privilege is already gone.',
  });
});
