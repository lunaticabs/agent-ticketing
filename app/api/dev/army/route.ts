import { json, route, readJson } from '@/lib/api';
import { assertDevRoutes, buildArmy, listArmy } from '@/lib/devmode';
import { resolveEventId } from '@/lib/sandbox';

/**
 * T-6.2 — build "N accounts, M humans".
 *
 * Scoped to the caller's event: handles are unique database-wide (the identity
 * table is global, because one World ID is one human everywhere), so two
 * visitors building an army at the same time would otherwise overwrite each
 * other's handles and share one crowd.
 */
export const POST = route(async (req) => {
  assertDevRoutes();
  const body = await readJson(req);
  const result = buildArmy({
    eventId: resolveEventId(req, typeof body.eventId === 'string' ? body.eventId : undefined),
    accounts: typeof body.accounts === 'number' ? body.accounts : undefined,
    humans: typeof body.humans === 'number' ? body.humans : undefined,
  });
  return json({ ok: true, ...result });
});

export const GET = route(async (req) => {
  assertDevRoutes();
  const accounts = listArmy(resolveEventId(req));
  const humans = new Map<string, number>();
  for (const a of accounts) humans.set(a.continuityId, (humans.get(a.continuityId) ?? 0) + 1);
  return json({
    ok: true,
    accounts,
    humans: [...humans.entries()].map(([continuityId, count]) => ({ continuityId, accounts: count })),
    collapseRatio: `${accounts.length} accounts → ${humans.size} continuity ids`,
  });
});
