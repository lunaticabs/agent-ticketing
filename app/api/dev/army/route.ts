import { json, route, readJson } from '@/lib/api';
import { assertDevRoutes, buildArmy, listArmy } from '@/lib/devmode';

/** T-6.2 — build "N accounts, M humans". */
export const POST = route(async (req) => {
  assertDevRoutes();
  const body = await readJson(req);
  const result = buildArmy({
    accounts: typeof body.accounts === 'number' ? body.accounts : undefined,
    humans: typeof body.humans === 'number' ? body.humans : undefined,
  });
  return json({ ok: true, ...result });
});

export const GET = route(async () => {
  assertDevRoutes();
  const accounts = listArmy();
  const humans = new Map<string, number>();
  for (const a of accounts) humans.set(a.continuityId, (humans.get(a.continuityId) ?? 0) + 1);
  return json({
    ok: true,
    accounts,
    humans: [...humans.entries()].map(([continuityId, count]) => ({ continuityId, accounts: count })),
    collapseRatio: `${accounts.length} accounts → ${humans.size} continuity ids`,
  });
});
