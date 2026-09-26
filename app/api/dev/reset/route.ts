import { json, route } from '@/lib/api';
import { assertDevRoutes, resetDemo } from '@/lib/devmode';
import { resolveEventId } from '@/lib/sandbox';

/**
 * T-6.2 — one-button demo reset.
 *
 * Scoped to the caller's own event on the public site: the button is reachable
 * by anyone, and an unscoped wipe would clear every other visitor's queue,
 * draw and audit trail at the same moment. See `resetDemo` for why the
 * distinction is not cosmetic.
 */
export const POST = route(async (req) => {
  assertDevRoutes();
  return json({
    ok: true,
    ...resetDemo({ eventId: resolveEventId(req) }),
    note: 'demo state cleared; the event itself remains',
  });
});
