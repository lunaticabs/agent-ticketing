import { json, route } from '@/lib/api';
import { assertDevRoutes, resetDemo } from '@/lib/devmode';

/** T-6.2 — one-button demo reset. */
export const POST = route(async () => {
  assertDevRoutes();
  return json({ ok: true, ...resetDemo(), note: 'demo state cleared; the seeded event remains' });
});
