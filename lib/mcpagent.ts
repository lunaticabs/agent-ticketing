/**
 * ============================================================================
 *  An MCP agent, driven from the demo panel
 * ============================================================================
 *
 * The premise of the demo, in one button: a human tells their agent to go and buy
 * a ticket, and the agent does it — over MCP, on the human's behalf, stopping
 * exactly once to ask them.
 *
 * ── This is a real MCP client ──────────────────────────────────────────────
 *
 * The agent spawns `mcp/server.ts` over stdio and drives the three tools through
 * the official SDK. What the panel renders is a genuine MCP transcript, not a
 * re-enactment: every `queue.join`, `queue.status` and `slot.claim` below really
 * is a JSON-RPC round trip to a child process.
 *
 * ── Why one step is HTTP and the rest is MCP ───────────────────────────────
 *
 * Asking a human for authorization is not an MCP tool, deliberately. It is what
 * the *host* does with the person; presenting the resulting approval is what the
 * *model* does. That split is why `slot.claim` can fail cleanly when it arrives
 * without one, which is the point the MCP acceptance check makes.
 *
 * So the agent asks over HTTP and claims over MCP — the same division the
 * standalone runner uses, for the same reason.
 *
 * ── Why it is told its own address rather than deriving one ────────────────
 *
 * `publicBaseUrl()` answers "what URL goes in a link a human will open", and it
 * derives that from the registered `redirect_uri`. That is the right answer for a
 * consent link and the wrong one for a self-call: with a portal-registered HTTPS
 * redirect and a server started over plain HTTP, it names an origin nothing is
 * listening on, and the agent dies with a TLS error that reads like a network
 * fault. The route passes the origin the request actually arrived on instead.
 *
 * This is the third time this distinction has bitten — `/api/dev/bots` and the
 * laundrying demo both had it. The rule: `publicBaseUrl()` for links a human
 * opens, request origin for reaching yourself.
 *
 * ── Why the run is detached ────────────────────────────────────────────────
 *
 * It waits for a draw and then for a person. Neither finishes inside an HTTP
 * request, so the route starts a row and returns; the panel polls the row. Same
 * shape as the device-code poll loop in `worldid/device.ts`.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getDb, nowMs } from './db';
import { newId } from './ids';
import { audit } from './audit';
import { PresenceError } from './errors';
import { ensureSyntheticHuman } from './humans';
import { issueAgentToken } from './agenttoken';
import { primaryEvent } from './humans';
import { assertDevRoutes } from './devmode';

export type SessionState =
  | 'starting'
  | 'queued'
  | 'waiting_draw'
  | 'awaiting_human'
  | 'claiming'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface AgentStep {
  at: number;
  /** `human` is the prompt, `mcp` a tool call, `http` the consent request, `note` narration. */
  kind: 'human' | 'mcp' | 'http' | 'note' | 'error' | 'done';
  label: string;
  detail?: string;
  ok?: boolean;
}

export interface AgentSessionRow {
  id: string;
  handle: string;
  continuity_id: string;
  request_text: string;
  state: SessionState;
  transcript: string;
  error: string | null;
  created_at: number;
  updated_at: number;
}

/** Sessions whose runner is alive in this process. */
const running = new Set<string>();

export function getSession(id: string): (AgentSessionRow & { steps: AgentStep[] }) | undefined {
  const row = getDb().prepare(`SELECT * FROM dev_agent_session WHERE id = ?`).get(id) as
    | AgentSessionRow
    | undefined;
  if (!row) return undefined;
  return { ...row, steps: JSON.parse(row.transcript) as AgentStep[] };
}

export function listSessions(limit = 5): (AgentSessionRow & { steps: AgentStep[] })[] {
  const rows = getDb()
    .prepare(`SELECT * FROM dev_agent_session ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as AgentSessionRow[];
  return rows.map((row) => ({ ...row, steps: JSON.parse(row.transcript) as AgentStep[] }));
}

function step(
  id: string,
  entry: Omit<AgentStep, 'at'>,
  state?: SessionState,
  error?: string,
): void {
  const row = getDb().prepare(`SELECT transcript FROM dev_agent_session WHERE id = ?`).get(id) as
    | { transcript: string }
    | undefined;
  if (!row) return;
  const steps = JSON.parse(row.transcript) as AgentStep[];
  steps.push({ ...entry, at: nowMs() });
  getDb()
    .prepare(
      `UPDATE dev_agent_session SET transcript = ?, updated_at = ?${state ? ', state = ?' : ''}${
        error !== undefined ? ', error = ?' : ''
      } WHERE id = ?`,
    )
    .run(
      ...[
        JSON.stringify(steps),
        nowMs(),
        ...(state ? [state] : []),
        ...(error !== undefined ? [error] : []),
        id,
      ],
    );
}

export interface StartResult {
  sessionId: string;
  continuityId: string;
  handle: string;
  request: string;
}

/**
 * "Human asks their agent to buy a ticket."
 *
 * Creates the session and returns immediately; the run continues in the
 * background so the panel can watch it.
 */
export function startAgentSession(input: {
  handle?: string;
  request?: string;
  /** Origin to call back on — the one the request arrived on, not the configured one. */
  origin: string;
}): StartResult {
  assertDevRoutes();

  const handle = (input.handle?.trim() || 'demo-human').slice(0, 40);
  const request =
    input.request?.trim() ||
    `Get me a ticket for ${primaryEvent()?.name ?? 'the event'}. I will confirm when you need me.`;

  const human = ensureSyntheticHuman(handle);
  const id = newId('agent');
  const now = nowMs();

  getDb()
    .prepare(
      `INSERT INTO dev_agent_session
         (id, handle, continuity_id, request_text, state, transcript, created_at, updated_at)
       VALUES (?,?,?,?,'starting','[]',?,?)`,
    )
    .run(id, handle, human.continuity_id, request, now, now);

  step(id, { kind: 'human', label: `"${request}"`, detail: `from ${handle}` }, 'starting');
  step(id, {
    kind: 'note',
    label: 'the agent takes the job',
    detail: 'connecting to the Presence MCP server over stdio',
  });

  audit({
    type: 'dev.agent_requested',
    continuityId: human.continuity_id,
    severity: 'warn',
    payload: { sessionId: id, handle, request, note: 'SIMULATED human asking a real MCP agent to act' },
  });

  void run(id, human.continuity_id, handle, input.origin);
  return { sessionId: id, continuityId: human.continuity_id, handle, request };
}

// ── The run ─────────────────────────────────────────────────────────────────

const TOOL_TIMEOUT_MS = 10_000;
const DRAW_WAIT_MS = 90_000;
const HUMAN_WAIT_MS = 120_000;

async function run(
  sessionId: string,
  continuityId: string,
  handle: string,
  base: string,
): Promise<void> {
  if (running.has(sessionId)) return;
  running.add(sessionId);

  let client: Client | null = null;
  const token = issueAgentToken({
    continuityId,
    scope: ['agent:queue', 'agent:claim'],
    ttlSec: 60 * 30,
    label: `demo-agent:${handle}`,
  }).token;

  try {
    // ── Connect ──
    client = new Client({ name: 'presence-demo-agent', version: '1.0.0' }, { capabilities: {} });
    await client.connect(
      new StdioClientTransport({
        // The local binary, not `npx`: npx re-resolves the package on every spawn,
        // which turns a 170ms connect into a multi-second one.
        command: './node_modules/.bin/tsx',
        args: ['mcp/server.ts'],
        env: {
          ...process.env,
          PRESENCE_BASE_URL: base,
          PRESENCE_AGENT_TOKEN: token,
        } as Record<string, string>,
        stderr: 'ignore',
      }),
    );
    const tools = await client.listTools();
    step(sessionId, {
      kind: 'mcp',
      label: 'tools/list',
      detail: tools.tools.map((t) => t.name).join(' · '),
      ok: true,
    });

    // ── queue.join ──
    const joined = await callTool(client, 'queue.join', {});
    if (!joined.ok) {
      step(sessionId, {
        kind: 'error',
        label: 'queue.join refused',
        detail: `${joined.code} — ${joined.message ?? ''}`,
        ok: false,
      });
      // The likeliest reason to land here mid-demo is that a previous run already
      // settled the draw, so joining is closed for the event. Say what to press.
      if (joined.code === 'queue_closed') {
        step(sessionId, {
          kind: 'note',
          label: 'press "Reset demo state" first',
          detail: 'this event has already been drawn; the agent cannot join a closed queue',
        });
      }
      finish(sessionId, 'failed', joined.message);
      return;
    }
    step(sessionId, {
      kind: 'mcp',
      label: 'queue.join',
      detail: joined.created
        ? `joined at arrival #${joined.arrivalSeq}`
        : 'already in the queue; the same entry came back',
      ok: true,
    });

    // ── wait for the draw ──
    step(sessionId, {
      kind: 'note',
      label: 'waiting for the draw',
      detail: 'the agent polls queue.status; the human is not involved yet',
    }, 'waiting_draw');

    const allocation = await waitForAllocation(client, sessionId);
    if (!allocation) {
      // Distinguish "the draw never reached us" from "we gave up waiting".
      const status = await callTool(client, 'queue.status', {});
      finish(
        sessionId,
        'failed',
        status.code === 'deferred_to_next_candidate'
          ? 'the window closed and the slot moved on'
          : 'no slot arrived inside the wait budget',
      );
      return;
    }
    step(sessionId, {
      kind: 'mcp',
      label: 'queue.status',
      detail: `slot allocated: ${allocation.slotId} — ${Math.round(allocation.remainingMs / 1000)}s to answer`,
      ok: true,
    });

    // ── ask the human (HTTP, by design — see the header) ──
    step(sessionId, {
      kind: 'note',
      label: 'the agent needs a human',
      detail: 'requesting an authorization; max_age=0, so a new proof is required',
    });

    const asked = await fetchJson(`${base}/api/slot/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });

    if (!asked.ok) {
      step(sessionId, { kind: 'error', label: 'authorization request refused', detail: String(asked.code), ok: false });
      finish(sessionId, 'failed', asked.message);
      return;
    }

    step(
      sessionId,
      {
        kind: 'http',
        label: 'POST /api/slot/request',
        detail: asked.url ? 'consent link ready — waiting for the human' : 'waiting for the human',
        ok: true,
      },
      'awaiting_human',
    );

    if (asked.url) {
      step(sessionId, { kind: 'human', label: 'Approve here', detail: String(asked.url) });
    }

    // ── wait for the human ──
    const decision = await waitForDecision(base, token, String(asked.approvalId), sessionId);
    if (decision !== 'APPROVED') {
      step(sessionId, {
        kind: 'error',
        label: `the human did not approve (${decision.toLowerCase()})`,
        detail: 'nothing was executed; the slot will defer',
        ok: false,
      });
      finish(sessionId, decision === 'EXPIRED' ? 'failed' : 'cancelled', `authorization ${decision.toLowerCase()}`);
      return;
    }

    step(sessionId, { kind: 'note', label: 'the human approved', detail: 'presenting it to the gate over MCP' }, 'claiming');

    // ── slot.claim, over MCP ──
    const claimed = await callTool(client, 'slot.claim', { approval: asked.approvalId });
    if (!claimed.ok) {
      step(sessionId, { kind: 'error', label: 'slot.claim refused', detail: String(claimed.code ?? ''), ok: false });
      finish(sessionId, 'failed', claimed.message);
      return;
    }

    step(sessionId, {
      kind: 'mcp',
      label: 'slot.claim',
      detail: `confirmed ${claimed.slotId} — nullifier spent`,
      ok: true,
    });
    finish(sessionId, 'done');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    step(sessionId, { kind: 'error', label: 'the agent failed', detail: message, ok: false });
    finish(sessionId, 'failed', message);
  } finally {
    running.delete(sessionId);
    await client?.close().catch(() => undefined);
  }
}

function finish(sessionId: string, state: SessionState, error?: string): void {
  step(sessionId, { kind: 'done', label: `session ${state}` }, state, error);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

interface ToolResult {
  ok: boolean;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

/** One `tools/call`, with its result parsed back out of the text block. */
async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const result = (await client.callTool({ name, arguments: args }, undefined, {
    timeout: TOOL_TIMEOUT_MS,
  })) as { isError?: boolean; content?: { type: string; text?: string }[] };

  const text = result.content?.find((c) => c.type === 'text')?.text ?? '{}';
  let parsed: ToolResult;
  try {
    parsed = JSON.parse(text) as ToolResult;
  } catch {
    parsed = { ok: false, code: 'unparseable', message: text.slice(0, 200) };
  }
  // A refusal arrives as a successful tool result carrying `isError`; the agent
  // reads it as a refusal, which is the whole point of the shape.
  if (result.isError) return { ...parsed, ok: false };
  return parsed;
}

async function waitForAllocation(
  client: Client,
  sessionId: string,
): Promise<{ slotId: string; remainingMs: number } | null> {
  const deadline = Date.now() + DRAW_WAIT_MS;
  let polls = 0;

  while (Date.now() < deadline) {
    await sleep(1500);
    const status = await callTool(client, 'queue.status', {});
    polls += 1;

    if (Array.isArray(status.allocation) && status.allocation.length > 0) {
      const first = status.allocation[0] as { slotId: string; remainingMs: number };
      return first;
    }
    // A refusal from queue.status means the window closed under us.
    if (!status.ok && status.code === 'deferred_to_next_candidate') return null;
  }

  step(sessionId, { kind: 'note', label: `gave up after ${polls} polls` });
  return null;
}

async function waitForDecision(
  base: string,
  token: string,
  approvalId: string,
  sessionId: string,
): Promise<'APPROVED' | 'DENIED' | 'EXPIRED'> {
  const deadline = Date.now() + HUMAN_WAIT_MS;
  let noted = false;

  while (Date.now() < deadline) {
    await sleep(900);
    const view = await fetchJson(`${base}/api/approval/${approvalId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const state = String(view.state ?? 'PENDING');
    if (state === 'APPROVED' || state === 'DENIED' || state === 'EXPIRED') {
      return state as 'APPROVED' | 'DENIED' | 'EXPIRED';
    }
    if (!noted && Date.now() > deadline - HUMAN_WAIT_MS + 20_000) {
      noted = true;
      step(sessionId, { kind: 'note', label: 'still waiting for the human' });
    }
  }
  return 'EXPIRED';
}

async function fetchJson(url: string, init: RequestInit): Promise<ToolResult> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TOOL_TIMEOUT_MS) });
  const text = await res.text();
  try {
    return JSON.parse(text) as ToolResult;
  } catch {
    return { ok: false, code: 'bad_response', message: text.slice(0, 200) };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Kept so a future caller gets a structured refusal rather than a bare throw. */
export function assertSessionExists(id: string): AgentSessionRow {
  const row = getDb().prepare(`SELECT * FROM dev_agent_session WHERE id = ?`).get(id) as
    | AgentSessionRow
    | undefined;
  if (!row) throw new PresenceError('not_found', `no agent session ${id}`, { httpStatus: 404 });
  return row;
}
