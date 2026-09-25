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
  });
  return json({
    ok: true,
    ...result,
    note: result.drew
      ? 'draw settled now and allocation windows collapsed — the next sweep defers'
      : 'draw was already settled; allocation windows collapsed',
  });
});
