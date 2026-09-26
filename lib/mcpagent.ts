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
 * ── Why the agent must act for the signed-in human ─────────────────────────
 *
 * The first version created a synthetic human from a typed handle and had the
 * agent act for that. It looked fine and could never work against the real IdP:
 * the consent step sends a real person to the real provider, they come back
 * having proved *their own* identity, and the gate compares it with the synthetic
 * one the approval was bound to. It refuses — correctly — with
 * `approval_identity_mismatch`, and the demo stalls with a countdown that never
 * resolves.
 *
 * The gate was right and the demo was wrong. "Your agent acts for you" only means
 * anything if the agent acts for the human who can actually answer the prompt, so
 * the session takes a continuity id resolved from the caller's session. Under the
 * local fallback a simulated human is coherent, because the simulated consent
 * resolves to the requester's own identity; against a real provider there is no
 * such shortcut and the caller has to be signed in.
 *
 * ── Why the run is detached ────────────────────────────────────────────────
 *
 * It waits for a draw and then for a person. Neither finishes inside an HTTP
 * request, so the route starts a row and returns; the panel polls the row. Same
 * shape as the device-code poll loop in `worldid/device.ts`.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, nowMs } from './db';
import { newId } from './ids';
import { audit } from './audit';
import { PresenceError } from './errors';
import { getEvent, getHuman, primaryEvent, type HumanRow } from './humans';
import { issueAgentToken } from './agenttoken';
import { assertDevRoutes } from './devmode';
import { fetchOrigin, selfCallEnv } from './selfcall';
import { currentEventId } from './eventcontext';

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

/**
 * How to refer to a human on screen.
 *
 * A simulated human has a readable subject ("demo-human"). A real one has a
 * pairwise `sub` from the provider — an opaque base32 blob that means nothing to
 * a reader, so the continuity id is shown instead and labelled as such.
 */
function handleOf(human: HumanRow): string {
  if (human.issuer.startsWith('local:')) return human.subject;
  return `${human.continuity_id.slice(0, 16)}…`;
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
  /**
   * The human the agent acts for.
   *
   * Resolved by the route from the caller's session — never typed in. See the
   * header: a synthetic human here can never satisfy a real consent step.
   */
  actingFor: string;
  request?: string;
  /** Origin to call back on — the one the request arrived on, not the configured one. */
  origin: string;
  /**
   * The event the run belongs to.
   *
   * Defaults to the caller's own scope, which on the public site is the
   * visitor's private event: the agent's tool calls, the approval it asks for,
   * and the slot it ends up holding must all land in the same demo as the panel
   * that started it. Without this the agent would queue in whatever event a
   * cookie-less request resolves to and the panel would never see it move.
   */
  eventId?: string | null;
}): StartResult {
  assertDevRoutes();

  const human = getHuman(input.actingFor);
  if (!human) {
    throw new PresenceError('not_authenticated', 'the human this agent would act for does not exist', {
      httpStatus: 401,
      hint: 'Start the agent from a signed-in browser session.',
    });
  }
  const handle = handleOf(human);
  const request =
    input.request?.trim() ||
    `Get me a ticket for ${eventName(input.eventId ?? currentEventId())}. I will confirm when you need me.`;

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
    // No product name: this line is on the projector, and the deployment is
    // called "Agent Ticketing Demo" now. The detail that matters is that a real
    // MCP client is being spawned.
    detail: 'connecting to the demo\u2019s MCP server over stdio',
  });

  audit({
    type: 'dev.agent_requested',
    continuityId: human.continuity_id,
    severity: 'warn',
    payload: { sessionId: id, handle, request, note: 'SIMULATED human asking a real MCP agent to act' },
  });

  void run(id, human.continuity_id, handle, input.origin, input.eventId ?? currentEventId());
  return { sessionId: id, continuityId: human.continuity_id, handle, request };
}

// ── The run ─────────────────────────────────────────────────────────────────

const TOOL_TIMEOUT_MS = 10_000;
const DRAW_WAIT_MS = 90_000;
const HUMAN_WAIT_MS = 120_000;

/**
 * How to start the MCP server in *this* deployment.
 *
 * Two shapes, and the image is the one that broke:
 *
 *   · `dist/mcp-server.mjs` — the bundle the Dockerfile builds. Plain JS, no
 *     interpreter needed, and it exists only in the image.
 *   · `mcp/server.ts` — run through tsx from a checkout, which is how every
 *     local flow works.
 *
 * The distinction is not cosmetic. The production image originally spawned
 * `tsx mcp/server.ts` while never copying `mcp/` into it, so the child process
 * died on spawn with ENOENT and the panel reported the only thing a dead stdio
 * transport can report:
 *
 *   the agent failed — MCP error -32000: Connection closed
 *
 * which names neither the missing file nor the process that never started. The
 * bundle is preferred when present because that is the deployment, and the
 * fallback keeps a checkout working without a build step.
 *
 * The local binary, not `npx`: npx re-resolves the package on every spawn, which
 * turns a 170ms connect into a multi-second one.
 */
function mcpServerCommand(): { command: string; args: string[] } {
  const bundled = path.join(process.cwd(), 'dist', 'mcp-server.mjs');
  if (fs.existsSync(bundled)) return { command: process.execPath, args: [bundled] };
  return { command: './node_modules/.bin/tsx', args: ['mcp/server.ts'] };
}

async function run(
  sessionId: string,
  continuityId: string,
  handle: string,
  base: string,
  /** The private event this run belongs to, if any. See `startAgentSession`. */
  eventId: string | null,
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
        ...mcpServerCommand(),
        env: {
          ...process.env,
          ...selfCallEnv(base),
          PRESENCE_AGENT_TOKEN: token,
          // The MCP server is its own process talking over HTTP, so it does not
          // inherit this request's event scope. Naming it here is what keeps an
          // agent's tool calls inside the visitor's own demo.
          ...(eventId ? { PRESENCE_EVENT_ID: eventId } : {}),
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

    const outcome = await waitForAllocation(client, sessionId);
    if (outcome.kind === 'settled') {
      // Never a bare timeout when there is something specific to say: the whole
      // point of this failure mode is that the reason is legible.
      step(sessionId, { kind: 'error', label: 'the draw is closed', detail: outcome.reason, ok: false });
      step(sessionId, {
        kind: 'note',
        label: 'ask for a new round',
        detail: 'the window never reopens by itself — the board offers "start a new round"',
      });
      finish(sessionId, 'failed', outcome.reason);
      return;
    }
    if (outcome.kind === 'waiting') {
      // Unreachable: `waitForAllocation` folds its own timeout into `settled`.
      finish(sessionId, 'failed', 'no slot arrived inside the wait budget');
      return;
    }
    step(sessionId, {
      kind: 'mcp',
      label: 'queue.status',
      detail: `slot allocated: ${outcome.slotId} — ${Math.round(outcome.remainingMs / 1000)}s to answer`,
      ok: true,
    });

    // ── ask the human (HTTP, by design — see the header) ──
    step(sessionId, {
      kind: 'note',
      label: 'the agent needs a human',
      detail: 'requesting an authorization; max_age=0, so a new proof is required',
    });

    const asked = await fetchJson(`${base}/api/slot/request${eventQuery(eventId)}`, {
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
    const decision = await waitForDecision(base, token, String(asked.approvalId), sessionId, eventId);
    if (decision !== 'APPROVED') {
      step(sessionId, {
        kind: 'error',
        label:
          decision === 'SLOT_GONE'
            ? 'the slot was released before the human answered'
            : `the human did not approve (${decision.toLowerCase()})`,
        detail:
          decision === 'SLOT_GONE'
            ? 'the approval window was ended or lapsed, so the slot moved on — there is nothing left to authorize'
            : 'nothing was executed; the slot will defer',
        ok: false,
      });
      finish(
        sessionId,
        decision === 'DENIED' ? 'cancelled' : 'failed',
        decision === 'SLOT_GONE'
          ? 'the slot moved on before the human answered'
          : `authorization ${decision.toLowerCase()}`,
      );
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

/**
 * Wait for the draw to reach this human — or stop the moment it cannot.
 *
 * ── Why this does not simply poll until the deadline ───────────────────────
 *
 * It did, and the public demo found the hole: when the draw settles and this
 * human is *not* allocated a slot, the window is closed for good. Nothing the
 * agent polls can change that, so it spent the full ninety seconds asking a
 * settled question, and the panel sat on "waiting for the draw" the whole time.
 * A visitor reads that as a hang, which is exactly what was reported.
 *
 * The signal is `event.lotteryDrawn`, straight from `queue.status`: once the
 * draw is settled the answer is final, so the wait ends on that poll. Three
 * outcomes now, and each one is distinguishable to whoever is watching:
 *
 *   allocated   → carry on and ask the human
 *   settled     → stop, and say why (the draw closed without reaching us)
 *   deferred    → stop, the slot moved to the next candidate
 *   timed out   → the only case that deserves the full budget: a window that is
 *                 still open when the budget runs out
 */
export type AllocationOutcome =
  | { kind: 'allocated'; slotId: string; remainingMs: number }
  | { kind: 'settled'; reason: string }
  | { kind: 'waiting' };

/**
 * Read one `queue.status` payload and decide whether waiting is still sensible.
 *
 * Split out from the polling loop so the decision can be tested directly. The
 * bug it fixes was a *decision* bug — "the draw is settled and we have nothing,
 * keep waiting" — and a decision that can only be exercised by running a
 * ninety-second loop against a live server is a decision that will regress.
 */
export function allocationOutcome(status: Record<string, unknown>): AllocationOutcome {
  if (Array.isArray(status.allocation) && status.allocation.length > 0) {
    const first = status.allocation[0] as { slotId: string; remainingMs: number };
    return { kind: 'allocated', slotId: first.slotId, remainingMs: first.remainingMs };
  }

  // A refusal from queue.status means the window closed under us.
  if (status.ok === false && status.code === 'deferred_to_next_candidate') {
    return { kind: 'settled', reason: 'the window closed and the slot moved to the next candidate' };
  }

  // The draw is settled and we are not in the allocation list. No future poll
  // can change that — from here the queue refuses new entries — so this is an
  // answer, not a reason to keep waiting.
  const event = status.event as { lotteryDrawn?: boolean } | undefined;
  if (event?.lotteryDrawn === true) {
    return {
      kind: 'settled',
      reason:
        'the draw was settled without allocating this human a slot — every slot went to an ' +
        'earlier rank in the draw',
    };
  }

  return { kind: 'waiting' };
}

async function waitForAllocation(client: Client, sessionId: string): Promise<AllocationOutcome> {
  const deadline = Date.now() + DRAW_WAIT_MS;
  let polls = 0;

  while (Date.now() < deadline) {
    await sleep(1500);
    const status = await callTool(client, 'queue.status', {});
    polls += 1;

    const outcome = allocationOutcome(status as Record<string, unknown>);
    if (outcome.kind !== 'waiting') return outcome;
  }

  step(sessionId, { kind: 'note', label: `gave up after ${polls} polls` });
  return { kind: 'settled', reason: 'no slot arrived inside the wait budget' };
}

/**
 * Wait for the human — and stop the moment their answer can no longer matter.
 *
 * Polling only the approval row was not enough. Ending the approval window (with
 * Fast-forward, or by letting it lapse) releases the slot and leaves the
 * approval row PENDING, so this waited the full two minutes on a question that
 * had already been settled: measured at 44 seconds and still going, with
 * `allocation: []` on the server the whole time. The slot was gone; no approval
 * could have helped.
 *
 * So the loop watches two things. The approval row says what the human did; the
 * queue status says whether there is still anything to authorize at all. Losing
 * the slot is its own outcome, reported as `SLOT_GONE` rather than dressed up as
 * an expiry — they are different things and the operator can see both.
 */
type Decision = 'APPROVED' | 'DENIED' | 'EXPIRED' | 'SLOT_GONE';

async function waitForDecision(
  base: string,
  token: string,
  approvalId: string,
  sessionId: string,
  eventId: string | null,
): Promise<Decision> {
  const deadline = Date.now() + HUMAN_WAIT_MS;
  let noted = false;

  while (Date.now() < deadline) {
    await sleep(900);
    const view = await fetchJson(`${base}/api/approval/${approvalId}${eventQuery(eventId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const state = String(view.state ?? 'PENDING');
    if (state === 'APPROVED' || state === 'DENIED' || state === 'EXPIRED') {
      return state as Decision;
    }

    // Still pending — but is there anything left to approve *for*?
    const status = await fetchJson(`${base}/api/queue/status${eventQuery(eventId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (status.ok === true && Array.isArray(status.allocation) && status.allocation.length === 0) {
      return 'SLOT_GONE';
    }

    if (!noted && Date.now() > deadline - HUMAN_WAIT_MS + 20_000) {
      noted = true;
      step(sessionId, { kind: 'note', label: 'still waiting for the human' });
    }
  }
  return 'EXPIRED';
}

/**
 * The event the run is about, by id when we have one and by scope otherwise.
 *
 * `primaryEvent()` is the fallback rather than an error: run from a terminal
 * (`npm run mcp`, `npm run agent`) there is no request scope, and "the event" is
 * then exactly what it always was.
 */
function eventName(eventId: string | null): string {
  if (eventId) {
    const event = getEvent(eventId);
    if (event) return event.name;
  }
  return primaryEvent()?.name ?? 'the event';
}

function eventQuery(eventId: string | null): string {
  return eventId ? `?eventId=${encodeURIComponent(eventId)}` : '';
}

async function fetchJson(url: string, init: RequestInit): Promise<ToolResult> {
  // Through `fetchOrigin`, so a certificate problem reports itself as one rather
  // than as `fetch failed` from three frames down.
  const origin = new URL(url).origin;
  const path = url.slice(origin.length);
  let res: Response;
  try {
    res = await fetchOrigin(origin, path, { ...init, signal: AbortSignal.timeout(TOOL_TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, code: 'self_call_failed', message: err instanceof Error ? err.message : String(err) };
  }
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
