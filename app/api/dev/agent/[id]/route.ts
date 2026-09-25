import { json, route } from '@/lib/api';
import { assertDevRoutes } from '@/lib/devmode';
import { getSession } from '@/lib/mcpagent';

/** Poll target for one agent run. The transcript is meant to be read aloud. */
export const GET = route(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  assertDevRoutes();
  const { id } = await ctx.params;
  const session = getSession(id);
  if (!session) {
    return json({ ok: false, code: 'not_found', message: `no agent session ${id}` }, { status: 404 });
  }
  return json({ ok: true, ...session });
});
