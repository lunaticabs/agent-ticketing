import { json, route, requireContinuity, readJson } from '@/lib/api';
import { requestClaimApproval } from '@/lib/gate';
import { primaryEvent } from '@/lib/humans';

/**
 * Stage 1 of the purchase loop: ask the human to authorize *this* slot handover.
 *
 * This is a separate endpoint from `slot.claim` on purpose. Asking a human for
 * authorization is something a *host* does; presenting the resulting approval is
 * something a *model* does. Keeping them apart is what lets `slot.claim` fail
 * cleanly when it is called without an approval — see T-3.4's core demo point.
 *
 * `max_age=0` is requested here, so the IdP must produce a proof for this
 * transaction rather than accepting a session established earlier.
 */
export const POST = route(async (req) => {
  const continuityId = requireContinuity(req);
  const body = await readJson(req);
  const { guardClientSuppliedEnvironment } = await import('@/lib/api');
  guardClientSuppliedEnvironment(body);

  const eventId = typeof body.eventId === 'string' ? body.eventId : primaryEvent().id;
  const requested = await requestClaimApproval(eventId, continuityId);

  return json({
    ok: true,
    approvalId: requested.approvalId,
    requestId: requested.requestId,
    mode: requested.mode,
    degraded: requested.degraded,
    note: requested.note,
    expiresAt: requested.expiresAt,
    windowSec: Math.max(0, Math.round((requested.expiresAt - Date.now()) / 1000)),
    boundAction: requested.target.action,
    boundSignal: requested.target.signal,
    slotId: requested.target.slotId,
    ...(requested.url ? { url: requested.url } : {}),
    ...(requested.deviceCode ? { deviceCode: requested.deviceCode } : {}),
    stage: 'requested',
    hint:
      'The human authorizes on their own device. Poll GET /api/approval/{approvalId} for the ' +
      'outcome, then present the approvalId to POST /api/slot/claim.',
  });
});
