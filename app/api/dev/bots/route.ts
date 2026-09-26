import { json, route, readJson } from '@/lib/api';
import { assertDevRoutes } from '@/lib/devmode';
import { selfOrigin } from '@/lib/selfcall';
import { runBotArmy, runSpeedContrast } from '@/lib/botarmy';
import { resolveEventId } from '@/lib/sandbox';

/**
 * T-6.3 — the speed-contrast demo behind a button.
 *
 * `mode: "compare"` runs the SAME bot script twice, once under FCFS and once
 * under the lottery, resetting between runs. That side-by-side is the argument
 * for RED LINE 10, and it is much more convincing as one click than as two
 * rehearsed steps.
 */
export const POST = route(async (req) => {
  assertDevRoutes();
  const body = await readJson(req);
  // Self-calls use the origin the request actually arrived on, NOT the public
  // base URL. Those two can legitimately differ — a TLS-terminating proxy, or a
  // server started on http while the config declares https — and when they do,
  // dialling the public URL from inside the process fails with a bare
  // `fetch failed`. The request's own origin is always reachable.
  const baseUrl = selfOrigin(req);
  const accounts = typeof body.accounts === 'number' ? body.accounts : undefined;
  const humans = typeof body.humans === 'number' ? body.humans : undefined;
  const slots = typeof body.slots === 'number' ? body.slots : undefined;
  // The army's joins are real HTTP requests back into this server, so the event
  // has to be passed explicitly — the caller's request scope does not travel
  // with them. Without this, a visitor's 40-account army would queue in the
  // seeded stage event instead of their own.
  const eventId = resolveEventId(req, typeof body.eventId === 'string' ? body.eventId : undefined);

  if (body.mode === 'compare') {
    const result = await runSpeedContrast({ baseUrl, accounts, humans, slots, eventId });
    return json({ ok: true, ...result });
  }

  const result = await runBotArmy({ baseUrl, accounts, humans, label: 'human', eventId });
  return json({
    ok: true,
    result,
    verdict:
      result.mode === 'fcfs'
        ? `The ${result.accounts}-account army took ${result.allocated.bots}/${result.slots} slots in ` +
          `${result.elapsedMs}ms. Uniqueness did not help: every bot had its own identity, and speed decided everything.`
        : `The same army took ${result.allocated.bots}/${result.slots} slots. Their share is now just their ` +
          'share of the entrant pool, because arrival time is not an input to the draw.',
  });
});
