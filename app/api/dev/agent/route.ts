import { json, route, readJson } from '@/lib/api';
import { assertDevRoutes } from '@/lib/devmode';
import { listSessions, startAgentSession } from '@/lib/mcpagent';
import { selfOrigin } from '@/lib/selfcall';

/**
 * "Human, to their agent: go and buy me a ticket."
 *
 * Starts a session and returns immediately — the run waits for a draw and then
 * for a person, neither of which fits inside a request. The panel polls
 * `GET /api/dev/agent/{id}` for the transcript.
 */
export const POST = route(async (req) => {
  assertDevRoutes();
  const body = await readJson(req);

  const started = startAgentSession({
    handle: typeof body.handle === 'string' ? body.handle : undefined,
    request: typeof body.request === 'string' ? body.request : undefined,
    // The origin this request arrived on. `publicBaseUrl()` would name the
    // registered redirect_uri's origin, which need not be reachable from here.
    origin: selfOrigin(req),
  });

  return json({
    ok: true,
    ...started,
    note:
      'The agent is a real MCP client: it spawns mcp/server.ts over stdio and drives the ' +
      'three tools. Watch the board — every action it takes is filed under "agent".',
  });
});

export const GET = route(async () => {
  assertDevRoutes();
  return json({ ok: true, sessions: listSessions() });
});
