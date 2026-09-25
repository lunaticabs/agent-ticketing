import { json, route, readJson } from '@/lib/api';
import { assertDevRoutes, runLaunderingDemo } from '@/lib/devmode';
import { publicBaseUrl } from '@/worldid/config';

/**
 * T-6.2 / demo beat 4 — the laundering simulation, in one call.
 *
 * A simulated scalper holds a slot and pushes it through the army, account by
 * account. Every attempt is a REAL transfer: real link, real TTL, real
 * fresh-authentication requirement, real gate. The only synthetic part is that
 * the recipients never had to prove humanness — disclosed on screen and in the
 * README.
 *
 * Watch the successes stop dead at `transfer_inbound_cap` per human, no matter
 * how many fresh accounts are thrown at it.
 */
export const POST = route(async (req) => {
  assertDevRoutes();
  const body = await readJson(req);
  const result = await runLaunderingDemo({
    eventId: typeof body.eventId === 'string' ? body.eventId : undefined,
    accounts: typeof body.accounts === 'number' ? body.accounts : undefined,
    humans: typeof body.humans === 'number' ? body.humans : undefined,
    // The consent step goes back out over HTTP, to the same endpoint the
    // fallback consent screen posts to.
    baseUrl: publicBaseUrl(),
  });
  return json({ ok: true, ...result });
});
