import { json, route, readJson } from '@/lib/api';
import { assertDevRoutes, fastForward } from '@/lib/devmode';

/**
 * T-6.3 — collapse the current window.
 *
 * Judges will not watch a fifteen-minute draw, and a demo that depends on a wall
 * clock is a demo that runs out of time. This settles the draw immediately and
 * drags every live approval deadline into the past so deferrals fire on cue.
 */
export const POST = route(async (req) => {
  assertDevRoutes();
  const body = await readJson(req);
  const result = fastForward({
    eventId: typeof body.eventId === 'string' ? body.eventId : undefined,
    // Read, not dropped. `scripts/e2e.ts` has always sent this parameter and it
    // never arrived, so the deferral demo and the "just end the wait" case were
    // the same request whether the caller wanted that or not.
    deferAllocations: typeof body.deferAllocations === 'boolean' ? body.deferAllocations : undefined,
  });
  return json({
    ok: true,
    ...result,
    note: result.deferAllocations
      ? 'draw settled (if it was open) and every allocation window collapsed — the next sweep defers'
      : 'draw settled (if it was open); live allocations were left alone',
  });
});
