import { json, route, readJson } from '@/lib/api';
import { assertDevRoutes, primeScenario } from '@/lib/devmode';

/** Seed a self-contained scenario: simulated attendees, a queue, a draw, allocations. */
export const POST = route(async (req) => {
  assertDevRoutes();
  const body = await readJson(req);
  const result = primeScenario({
    eventId: typeof body.eventId === 'string' ? body.eventId : undefined,
    humans: typeof body.humans === 'number' ? body.humans : undefined,
  });
  return json({ ok: true, ...result });
});
