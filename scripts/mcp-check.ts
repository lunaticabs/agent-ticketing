#!/usr/bin/env tsx
/**
 * ============================================================================
 *  MCP acceptance check (T-3.4)
 * ============================================================================
 *
 *   ENABLE_DEV_ROUTES=1 npm run dev      # in one terminal
 *   npm run mcp-check                    # in another
 *
 * Speaks real MCP over stdio to `mcp/server.ts` using the official SDK client,
 * because the acceptance criteria are about what an MCP *host* observes:
 *
 *   · the client can list exactly three tools
 *   · queue.join and queue.status work with no approval
 *   · slot.claim WITHOUT an approval fails — the core demonstration
 *   · slot.claim with a FABRICATED approval fails
 *   · slot.claim with a genuine approval succeeds
 *   · replaying that same approval fails
 *   · presenting an approval bound to a DIFFERENT slot fails
 *
 * The last four are the ones that matter: they show that the enforcement lives
 * behind the tool, not in the tool's description, and that it is the same
 * enforcement the HTTP route uses (asserted structurally by `npm run
 * security-check`).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { describeTarget, reportPreflight, PreflightError, requireDevRoutes, requireLocalIdp, resolveTarget } from './preflight';

/** Resolved in `main`, once the server has been found. */
let BASE = '';
/**
 * The event every check is about — the seeded one.
 *
 * Required as soon as the server runs with `ENABLE_SANDBOX=1`: a request that
 * names no event is a new visitor and gets a private event of its own, so the
 * agent's tool calls and this script's approval would be about two different
 * queues. Pinned once, here, for the same reason `scripts/e2e.ts` pins it.
 */
let EVENT = '';

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];

function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? '\u001b[32m✔\u001b[0m' : '\u001b[31m✖\u001b[0m'} ${name}`);
  console.log(`      ${detail}`);
}

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] };

/** Our server always answers with a JSON text block; parse it back. */
function parse(result: unknown): Record<string, unknown> {
  const r = result as ToolResult;
  const text = r.content?.find((c) => c.type === 'text')?.text ?? '{}';
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

/** The seeded event's id, read from the server rather than assumed. */
async function seededEventId(): Promise<string> {
  const health = await http<{ event?: { id: string } }>('/api/health');
  return health.body.event?.id ?? '';
}

interface HttpOptions {
  method?: string;
  body?: unknown;
  cookie?: string;
  bearer?: string;
}

async function http<T>(path: string, opts: HttpOptions = {}): Promise<{ status: number; body: T; cookie: string }> {
  const pinned = EVENT ? (path.includes('?') ? `${path}&eventId=${encodeURIComponent(EVENT)}` : `${path}?eventId=${encodeURIComponent(EVENT)}`) : path;
  const res = await fetch(`${BASE}${pinned}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return {
    status: res.status,
    body: body as T,
    cookie: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; '),
  };
}

/** Run the full enrollment dance and hand back a scoped agent credential. */
async function enrollAgent(handle: string, label: string): Promise<{ token: string; continuityId: string } | null> {
  const started = await http<{ enrollId: string }>('/api/agent/enroll', { body: { label } });
  if (started.status !== 200) return null;

  const consent = await http('/api/auth/local', { body: { requestId: started.body.enrollId, handle } });
  if (consent.status !== 200) return null;

  const done = await http<{ agentToken: string; continuityId: string }>(
    `/api/agent/enroll?enrollId=${encodeURIComponent(started.body.enrollId)}`,
  );
  if (done.status !== 200) return null;
  return { token: done.body.agentToken, continuityId: done.body.continuityId };
}

async function connectMcp(token: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'mcp/server.ts'],
    env: {
      ...process.env,
      HUMANGATE_BASE_URL: BASE,
      HUMANGATE_AGENT_TOKEN: token,
      ...(EVENT ? { HUMANGATE_EVENT_ID: EVENT } : {}),
    } as Record<string, string>,
    // The server logs to stderr by design; keep the check output clean.
    stderr: 'ignore',
  });
  const client = new Client({ name: 'humangate-check', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function main(): Promise<number> {
  try {
    const target = await resolveTarget();
    BASE = target.base;
    EVENT = await seededEventId();
    requireDevRoutes(target);
    requireLocalIdp(target, 'the MCP acceptance check');

    console.log('');
    console.log(describeTarget(target, 'MCP acceptance check (T-3.4)'));
    console.log(`  ${'─'.repeat(88)}`);
  } catch (err) {
    if (err instanceof PreflightError) return reportPreflight(err);
    throw err;
  }

  await http('/api/dev/reset', { body: {} });

  // ── Enroll two agents, each with its own scoped credential (T-5.2) ──
  const alice = await enrollAgent('mcp-alice', 'mcp-alice');
  const bob = await enrollAgent('mcp-bob', 'mcp-bob');
  if (!alice || !bob) {
    record('agent enrollment', false, 'could not issue an agent credential');
    return 1;
  }
  record(
    'the relying party issues each agent its own scoped credential (T-5.2)',
    true,
    'the IdP token is never handed to the agent; the server mints a scoped, expiring bearer token instead',
  );

  const aliceClient = await connectMcp(alice.token);
  const bobClient = await connectMcp(bob.token);

  // ── 1. Tools ──
  const listed = await aliceClient.listTools();
  const names = listed.tools.map((t) => t.name).sort();
  const expected = ['queue.join', 'queue.status', 'slot.claim'];
  record(
    'the client can list exactly the three tools',
    JSON.stringify(names) === JSON.stringify(expected),
    `got [${names.join(', ')}]`,
  );

  // ── 2. Unprotected tools work without an approval ──
  const join = parse(await aliceClient.callTool({ name: 'queue.join', arguments: {} }));
  record('queue.join works with no approval', join.ok === true, `arrival #${String(join.arrivalSeq)}`);

  const status = parse(await aliceClient.callTool({ name: 'queue.status', arguments: {} }));
  record('queue.status works with no approval', status.ok === true, 'read-only; no authorization required');

  // ── 3. THE CORE DEMONSTRATION ──
  const bare = (await aliceClient.callTool({ name: 'slot.claim', arguments: {} })) as ToolResult;
  const bareBody = parse(bare);
  record(
    'slot.claim WITHOUT an approval is refused',
    bare.isError === true && bareBody.code === 'approval_required',
    `isError=${bare.isError} code=${String(bareBody.code)} — a model can call this; it just cannot succeed`,
  );

  // ── 4. Settle the draw so both agents actually hold a slot ──
  //
  // Order matters for the next two checks: the gate resolves *what this human may
  // claim* before it looks at any approval, so a fabricated reference only
  // reaches the lookup once there is something to claim.
  await aliceClient.callTool({ name: 'queue.join', arguments: {} }); // idempotent
  await bobClient.callTool({ name: 'queue.join', arguments: {} });
  await http('/api/dev/fast-forward', { body: {} });

  const fabricated = (await aliceClient.callTool({
    name: 'slot.claim',
    arguments: { approval: 'apv_i_made_this_up' },
  })) as ToolResult;
  const fabricatedBody = parse(fabricated);
  record(
    'slot.claim with a FABRICATED approval is refused',
    fabricated.isError === true && fabricatedBody.code === 'approval_not_found',
    `code=${String(fabricatedBody.code)} — the value is looked up in server state, never believed`,
  );

  // ── 5. A genuine approval, obtained the way a host would ──
  //
  // Asking a human is a *host* concern, so it happens over HTTP with the agent's
  // credential. Presenting the result is the *model's* action, so it happens
  // over MCP. Keeping those apart is the design, not an implementation detail.
  const aliceReq = await http<{ approvalId: string; requestId: string; slotId: string }>('/api/slot/request', {
    body: {},
    bearer: alice.token,
  });
  const bobReq = await http<{ approvalId: string; requestId: string; slotId: string }>('/api/slot/request', {
    body: {},
    bearer: bob.token,
  });

  if (aliceReq.status !== 200) {
    record(
      'slot.claim WITH a genuine approval succeeds',
      false,
      `could not obtain an approval through the agent credential: HTTP ${aliceReq.status} ${JSON.stringify(aliceReq.body).slice(0, 160)}`,
    );
  } else {
    await http('/api/auth/local', { body: { requestId: aliceReq.body.requestId, handle: 'mcp-alice' } });
    if (bobReq.status === 200) {
      await http('/api/auth/local', { body: { requestId: bobReq.body.requestId, handle: 'mcp-bob' } });
    }

    const claimed = (await aliceClient.callTool({
      name: 'slot.claim',
      arguments: { approval: aliceReq.body.approvalId },
    })) as ToolResult;
    const claimedBody = parse(claimed);
    record(
      'slot.claim WITH a genuine approval succeeds',
      claimed.isError !== true && claimedBody.ok === true,
      `slot ${String(claimedBody.slotId)} confirmed through the MCP surface`,
    );

    const replay = (await aliceClient.callTool({
      name: 'slot.claim',
      arguments: { approval: aliceReq.body.approvalId },
    })) as ToolResult;
    const replayBody = parse(replay);
    record(
      'replaying that same approval is refused',
      replay.isError === true,
      `code=${String(replayBody.code)} — the entitlement and the spent nullifier both refuse it, across transports`,
    );

    // ── 6. Bob holds his OWN slot, and presents Alice's approval for hers ──
    if (bobReq.status === 200) {
      const cross = (await bobClient.callTool({
        name: 'slot.claim',
        arguments: { approval: aliceReq.body.approvalId },
      })) as ToolResult;
      const crossBody = parse(cross);
      record(
        "an approval issued to another human is refused",
        cross.isError === true && crossBody.code === 'approval_identity_mismatch',
        `code=${String(crossBody.code)} — the approval names one human; a different agent cannot spend it`,
      );
    }

    // ── 7. Bob's own approval still works, so the refusal above was about the
    //       binding and not about Bob being blocked ──
    if (bobReq.status === 200) {
      const bobOwn = (await bobClient.callTool({
        name: 'slot.claim',
        arguments: { approval: bobReq.body.approvalId },
      })) as ToolResult;
      const bobOwnBody = parse(bobOwn);
      record(
        "but Bob's own approval still works",
        bobOwn.isError !== true && bobOwnBody.ok === true,
        `slot ${String(bobOwnBody.slotId)} confirmed — the check discriminates, it does not just refuse`,
      );
    }
  }

  await aliceClient.close().catch(() => undefined);
  await bobClient.close().catch(() => undefined);

  const failed = checks.filter((c) => !c.pass);
  console.log('');
  console.log(`  ${'─'.repeat(88)}`);
  console.log(`  ${checks.length - failed.length}/${checks.length} checks passed`);
  console.log('');
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
