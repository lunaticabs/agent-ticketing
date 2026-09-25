import { json, route } from '@/lib/api';
import { getEvent, listEvents } from '@/lib/humans';
import { idpStatus } from '@/worldid';
import { devRoutesEnabled } from '@/lib/errors';
import { WORLDID_ENVIRONMENT } from '@/worldid/config';

/**
 * T-0.1 acceptance: `/health` returns 200.
 *
 * Also the fastest way to answer the two questions that matter during setup:
 * which IdP mode are we in, and are the demo bypass routes on?
 */
export const GET = route(async () => {
  const events = listEvents();
  const event = events[0] ? getEvent(events[0].id) : undefined;
  const idp = await idpStatus(false);

  return json({
    ok: true,
    service: 'presence',
    environment: WORLDID_ENVIRONMENT,
    idp: {
      mode: idp.mode,
      issuer: idp.issuer,
      degraded: idp.degraded,
      hasCredentials: idp.hasCredentials,
      detail: idp.detail,
    },
    devRoutes: devRoutesEnabled(),
    event: event
      ? {
          id: event.id,
          name: event.name,
          policy: event.policy,
          lotteryMode: event.lottery_mode,
          lotteryDrawn: event.lottery_drawn_at !== null,
          windows: {
            lotterySec: event.lottery_window_sec,
            approvalSec: event.approval_window_sec,
            transferSec: event.transfer_window_sec,
          },
        }
      : null,
  });
});
