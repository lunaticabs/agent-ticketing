import { json, route, readJson } from '@/lib/api';
import { assertDevRoutes, runArmyQueueDemo } from '@/lib/devmode';

/**
 * Beat 4 for locked slots: forty accounts, two humans, two places in line.
 *
 * The transfer-laundering simulation this replaces needed a transfer engine to
 * demonstrate. With slots locked, the queue is the surface where continuity
 * still does the work — and where a scalper's second signup is worth nothing.
 */
export const POST = route(async (req) => {
  assertDevRoutes();
  const body = await readJson(req);
  return json({
    ok: true,
    ...runArmyQueueDemo({
      eventId: typeof body.eventId === 'string' ? body.eventId : undefined,
      accounts: typeof body.accounts === 'number' ? body.accounts : undefined,
      humans: typeof body.humans === 'number' ? body.humans : undefined,
    }),
  });
});
