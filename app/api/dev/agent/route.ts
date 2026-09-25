import type { NextRequest } from 'next/server';
import { json, route, readJson } from '@/lib/api';
import { assertDevRoutes } from '@/lib/devmode';
import { PresenceError } from '@/lib/errors';
import { ensureSyntheticHuman } from '@/lib/humans';
import { resolveCaller } from '@/lib/session';
import { idpMode } from '@/worldid/config';
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
    actingFor: actingHuman(req, body),
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

/**
 * Decide which human the agent acts for.
 *
 * A signed-in session wins, and is the only thing that can work against a real
 * provider: the consent step sends the human to the IdP, they come back having
 * proved their own identity, and the gate compares that with whoever the
 * approval was bound to. Point the agent at anybody else and the gate refuses —
 * correctly — with `approval_identity_mismatch`, leaving a countdown on screen
 * that never resolves.
 *
 * Under the local fallback a simulated human is coherent, because the simulated
 * consent resolves to the requester's own identity rather than to whoever typed
 * a name. So the fallback keeps working without a sign-in, and a real
 * configuration asks for one.
 */
function actingHuman(req: NextRequest, body: Record<string, unknown>): string {
  const caller = resolveCaller(req);
  if (caller.continuityId) return caller.continuityId;

  if (idpMode() === 'local') {
    const handle = (typeof body.handle === 'string' ? body.handle.trim() : '') || 'demo-human';
    return ensureSyntheticHuman(handle.slice(0, 40)).continuity_id;
  }

  throw new PresenceError('not_authenticated', 'sign in with World ID before handing the job to an agent', {
    httpStatus: 401,
    invariant: 'RED LINE 1 — the agent acts for a verified human, and for nobody else',
    hint: 'The human has to be the one who can answer the consent prompt, or the gate will refuse the result.',
  });
}

export const GET = route(async () => {
  assertDevRoutes();
  return json({ ok: true, sessions: listSessions() });
});
