import { json, route, readJson } from '@/lib/api';
import { assertDevRoutes } from '@/lib/devmode';
import { runAllAttacks, attackReplay, attackParameterTamper, attackEnvironmentSwap } from '@/lib/attacks';

/**
 * T-6.4 / demo beat 6 — the three attacks, each with its own refusal reason and
 * each ending in a database read-back confirming the protected action did not
 * happen.
 */
export const POST = route(async (req) => {
  assertDevRoutes();
  const body = await readJson(req);
  const eventId = typeof body.eventId === 'string' ? body.eventId : undefined;
  const which = String(body.attack ?? 'all');

  if (which === 'all') {
    const results = await runAllAttacks(eventId);
    return json({
      ok: true,
      attacks: results,
      summary:
        `${results.filter((r) => r.blocked).length}/${results.length} attacks blocked; ` +
        'no protected action executed',
    });
  }

  const presented =
    body.presented && typeof body.presented === 'object'
      ? (body.presented as Record<string, unknown>)
      : undefined;

  const result =
    which === 'replay'
      ? await attackReplay(eventId)
      : which === 'parameter_tamper'
        ? await attackParameterTamper(eventId)
        : await attackEnvironmentSwap(eventId, presented);

  return json({ ok: true, attacks: [result] });
});
