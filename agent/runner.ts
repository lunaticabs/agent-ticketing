#!/usr/bin/env tsx
/**
 * ============================================================================
 *  HumanGate agent runner (T-3.1)
 * ============================================================================
 *
 *   npm run agent
 *   npm run agent -- --handle alice --label "alice's agent"
 *   npm run agent -- --base http://localhost:3000 --timeout 120
 *
 * This is a **separate OS process**, deliberately. The project's claim is that
 * the agent is not the website: it holds no privileged code path, it talks to the
 * same public HTTP API a hostile client would, and it can only do what a human
 * has authorized. Running it in-process would quietly destroy that argument, so
 * it does not share a single import with the server beyond type-free HTTP.
 *
 * What it does, and what it refuses to do:
 *
 *   1. enrolls against the sandbox IdP through the device/consent flow
 *      (the human proves on their own device — the agent never sees a proof)
 *   2. joins the queue and waits. Unattended. This is the part that saves a person
 *      an afternoon of refreshing.
 *   3. the moment a slot is allocated, it asks the human to authorize. It prints
 *      the link or the device code and then *waits*.
 *   4. on approval it presents the approval to the gate, which re-verifies
 *      everything server-side
 *   5. on denial or expiry it prints a structured reason and exits cleanly. It
 *      does not retry, does not improvise, and does not execute anything.
 *
 * Step 5 is the point. A loop that "tries its best" when authorization fails is
 * exactly what the track's rule 3 is about.
 */
import { AgentClient, AgentHttpError, type Refusal } from './client';
import { env } from '../lib/env';

// ── Terminal output ─────────────────────────────────────────────────────────
// The terminal is the demo's second visual focus, so the status line has to be
// legible from across a room: a fixed-width badge, a wall clock, and the state.

const W = 78;

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
};

function stamp(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}`;
}

function line(badge: string, colour: string, message: string): void {
  const label = badge.padEnd(12).slice(0, 12);
  process.stdout.write(`${C.dim}${stamp()}${C.reset} ${colour}${C.bold}${label}${C.reset} ${message}\n`);
}

const say = {
  info: (m: string) => line('·', C.dim, m),
  step: (m: string) => line('STEP', C.blue, m),
  wait: (m: string) => line('WAITING', C.yellow, m),
  good: (m: string) => line('OK', C.green, m),
  bad: (m: string) => line('REFUSED', C.red, m),
  human: (m: string) => line('HUMAN', C.magenta, m),
  data: (m: string) => line('', C.cyan, m),
};

function banner(): void {
  const title = 'HUMANGATE · agent runner';
  console.log('');
  console.log(`  ${C.bold}${title}${C.reset}`);
  console.log(`  ${C.dim}${'─'.repeat(W)}${C.reset}`);
  console.log(`  ${C.dim}separate process · talks only to the public HTTP API${C.reset}`);
  console.log('');
}

// ── Arguments ───────────────────────────────────────────────────────────────

interface Args {
  base: string;
  handle: string;
  label: string;
  approvalTimeoutSec: number;
  once: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    base: get('--base', env('BASE_URL') ?? 'http://localhost:3000'),
    handle: get('--handle', `agent-${Math.random().toString(36).slice(2, 7)}`),
    label: get('--label', 'humangate-agent'),
    approvalTimeoutSec: Number(get('--timeout', '150')),
    once: argv.includes('--once'),
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  banner();

  const client = new AgentClient(args.base);

  // ── Preflight: if the server is not up, say so in plain language ──
  try {
    const health = await client.call<{ ok: true; idp: { mode: string; degraded: boolean } }>(
      '/api/health',
      { timeoutMs: 5000 },
    );
    say.info(`server ${args.base} is up · idp mode ${health.idp.mode}`);
    if (health.idp.degraded) {
      say.info('idp is in LOCAL FALLBACK: identity is simulated, the gate is not');
    }
  } catch (err) {
    console.log('');
    say.bad(`cannot reach ${args.base}`);
    say.info('start the server first:  ENABLE_DEV_ROUTES=1 npm run dev');
    say.info('then run:               npm run agent');
    console.log('');
    return 2;
  }

  // ── 1. Enroll ──
  say.step('enrolling with World ID (device/consent flow)');
  const enroll = await client.call<{
    ok: true;
    enrollId: string;
    mode: string;
    url?: string;
    deviceCode?: { userCode: string; verificationUri: string; verificationUriComplete: string; intervalSec: number };
    instructions: string;
  }>('/api/agent/enroll', { body: { label: args.label } });

  if (enroll.deviceCode) {
    say.human(`USER CODE:  ${C.bold}${enroll.deviceCode.userCode}${C.reset}`);
    say.human(`approve at: ${enroll.deviceCode.verificationUriComplete}`);
  }
  if (enroll.url) {
    say.human(`open this to approve: ${enroll.url}`);
  }

  const token = await pollEnroll(client, enroll.enrollId);
  if (!token) return 1;
  client.setBearer(token.agentToken);
  say.good(`enrolled as ${token.continuityId}`);
  say.info(`agent credential scope: ${token.scope.join(', ')} · expires in 4h`);
  console.log('');

  // ── 2. Join the queue ──
  //
  // `queue_closed` is a precondition, not a dead end. An unattended agent should
  // wait for the organiser to open a new window rather than exit — on stage the
  // draw is often settled before the agent is started, and a runner that gave up
  // there would be useless exactly when it is supposed to shine.
  const join = await joinWithRetry(client);

  if (join.kind === 'refused') {
    console.log('');
    say.bad(`cannot join: ${join.code}`);
    say.info(join.message);
    if (join.hint) say.info(join.hint);
    say.info('the agent did not proceed, and nothing was executed');
    console.log('');
    return 3;
  }

  say.step(
    join.created
      ? `joined the queue at arrival #${join.arrivalSeq} (${join.queueLength} waiting)`
      : `already in the queue (arrival #${join.arrivalSeq})`,
  );
  say.info('arrival order is recorded for the FCFS control mode only; the draw ignores it');

  // ── 3. Wait for an allocation, then ask the human ──
  const allocation = await waitForAllocation(client, args.approvalTimeoutSec);
  if (allocation.kind === 'refused') {
    say.bad(`${allocation.code}: ${allocation.message}`);
    return 1;
  }
  if (allocation.kind === 'timeout') {
    say.wait('no slot arrived inside the wait budget; exiting cleanly');
    return 0;
  }

  console.log('');
  say.human(`a slot is yours: ${allocation.slotId}`);
  say.human(`authorize within ${Math.round(allocation.remainingMs / 1000)}s or it moves on`);
  console.log('');

  const approval = await client.call<{
    ok: true;
    approvalId: string;
    mode: string;
    url?: string;
    deviceCode?: { userCode: string; verificationUriComplete: string };
    boundAction: string;
    boundSignal: string;
    windowSec: number;
  }>('/api/slot/request', { body: {} });

  say.step(`authorization requested (${approval.mode})`);
  say.data(`  action  ${approval.boundAction}`);
  say.data(`  signal  ${approval.boundSignal}`);
  say.data(`  id      ${approval.approvalId}`);
  if (approval.deviceCode) {
    say.human(`USER CODE:  ${C.bold}${approval.deviceCode.userCode}${C.reset}`);
    say.human(`approve at: ${approval.deviceCode.verificationUriComplete}`);
  }
  if (approval.url) say.human(`open this to approve: ${approval.url}`);
  console.log('');
  say.wait('waiting for the human. Nothing executes until they answer.');

  // ── 4. Wait for the outcome ──
  const outcome = await waitForApproval(client, approval.approvalId, approval.windowSec);

  if (outcome.state !== 'APPROVED') {
    console.log('');
    say.bad(`authorization ${outcome.state.toLowerCase()}`);
    if (outcome.failReason) say.info(`reason: ${outcome.failReason}`);
    say.info('the protected action did NOT run');
    say.info('the slot keeps its own countdown and will defer to the next candidate');
    console.log('');
    return 0;
  }

  say.good('human approved — presenting the approval to the gate');

  // ── 5. Present it. The server verifies everything again. ──
  try {
    const claimed = await client.call<{
      ok: true;
      slotId: string;
      nullifier: string;
      stages: { requestedAt: number; completedAt: number; verifiedAt: number; executedAt: number };
    }>('/api/slot/claim', { body: { approval: approval.approvalId } });

    console.log('');
    say.good(`SLOT CONFIRMED: ${claimed.slotId}`);
    say.data(`  nullifier  ${claimed.nullifier.slice(0, 28)}… (now spent)`);
    say.info('four stages: requested → completed → verified → executed');
    say.info('one person, one slot: a second attempt at this action cannot succeed');
    console.log('');
    return 0;
  } catch (err) {
    const refusal = err instanceof AgentHttpError ? err.body : null;
    console.log('');
    say.bad(refusal ? `${refusal.code}: ${refusal.message}` : String(err));
    if (refusal?.invariant) say.info(refusal.invariant);
    if (refusal?.hint) say.info(refusal.hint);
    say.info('the protected action did NOT run');
    console.log('');
    return 1;
  }
}

// ── Polling loops ───────────────────────────────────────────────────────────

type JoinOutcome =
  | { kind: 'joined'; created: boolean; arrivalSeq: number; queueLength: number }
  | { kind: 'refused'; code: string; message: string; hint?: string };

/**
 * Join the queue, waiting out a closed draw window.
 *
 * `queue_closed` means the draw for this event has already been settled — the
 * organiser needs to reset before anyone new can enter. That is a normal thing
 * to hit while setting up a demo, so the agent reports it once and then keeps
 * asking, rather than exiting and leaving the presenter to restart it.
 */
async function joinWithRetry(client: AgentClient, waitSec = 120): Promise<JoinOutcome> {
  const deadline = Date.now() + waitSec * 1000;
  let announced = false;

  for (;;) {
    try {
      const res = await client.call<{
        ok: true;
        created: boolean;
        arrivalSeq: number;
        queueLength: number;
      }>('/api/queue/join', { body: {} });
      if (announced) say.good('a new window is open — joined');
      return { kind: 'joined', ...res };
    } catch (err) {
      if (!(err instanceof AgentHttpError)) throw err;
      const body = err.body;

      if (body.code !== 'queue_closed') {
        return {
          kind: 'refused',
          code: body.code,
          message: body.message,
          hint: body.hint,
        };
      }

      if (!announced) {
        announced = true;
        say.wait('the draw for this event has already been settled');
        say.info('an organiser must open a new window: POST /api/dev/reset');
        say.info(`retrying for up to ${waitSec}s…`);
      }
      if (Date.now() >= deadline) {
        return {
          kind: 'refused',
          code: 'queue_closed',
          message: 'the draw window never reopened inside the wait budget',
          hint: 'Reset the demo (POST /api/dev/reset) or start a new event, then run the agent again.',
        };
      }
      await sleep(2000);
    }
  }
}

async function pollEnroll(
  client: AgentClient,
  enrollId: string,
): Promise<{ agentToken: string; continuityId: string; scope: string[] } | null> {
  say.wait('waiting for the human to complete enrollment…');
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await sleep(1000);
    try {
      const res = await client.call<{ ok: true; agentToken: string; continuityId: string; scope: string[] }>(
        `/api/agent/enroll?enrollId=${encodeURIComponent(enrollId)}`,
      );
      return res;
    } catch (err) {
      if (err instanceof AgentHttpError && err.status === 202) {
        if (attempt % 15 === 14) say.wait('still waiting for approval…');
        continue;
      }
      const refusal = err instanceof AgentHttpError ? err.body : null;
      say.bad(refusal ? `${refusal.code}: ${refusal.message}` : String(err));
      return null;
    }
  }
  say.bad('enrollment timed out');
  return null;
}

type AllocationWait =
  | { kind: 'allocated'; slotId: string; remainingMs: number }
  | { kind: 'timeout' }
  | { kind: 'refused'; code: string; message: string };

async function waitForAllocation(client: AgentClient, timeoutSec: number): Promise<AllocationWait> {
  say.wait('waiting for the draw and the allocation…');
  const deadline = Date.now() + timeoutSec * 1000;
  let lastNote = '';

  while (Date.now() < deadline) {
    await sleep(1000);
    try {
      const status = await client.call<{
        ok: true;
        queue: { lotteryRank: number | null; total: number; stats: { drawn: number } };
        allocation: { slotId: string; remainingMs: number }[];
      }>('/api/queue/status');

      const note = `rank ${status.queue.lotteryRank ?? '—'} · ${status.queue.total} in queue`;
      if (note !== lastNote) {
        say.info(note);
        lastNote = note;
      }

      if (status.allocation.length > 0) {
        return {
          kind: 'allocated',
          slotId: status.allocation[0].slotId,
          remainingMs: status.allocation[0].remainingMs,
        };
      }
    } catch (err) {
      if (err instanceof AgentHttpError) {
        // A refusal here is meaningful: it usually means the window already
        // closed and the slot moved on. Report it rather than spinning.
        if (err.body.code !== 'not_authenticated') {
          return { kind: 'refused', code: err.body.code, message: err.body.message };
        }
      }
      say.info(`transient error, retrying: ${String(err)}`);
    }
  }
  return { kind: 'timeout' };
}

async function waitForApproval(
  client: AgentClient,
  approvalId: string,
  windowSec: number,
): Promise<{ state: string; failReason: string | null }> {
  const deadline = Date.now() + (windowSec + 15) * 1000;
  let lastStage = '';

  while (Date.now() < deadline) {
    await sleep(900);
    try {
      const view = await client.call<{
        ok: true;
        state: string;
        stage: string;
        failReason: string | null;
        remainingMs: number;
      }>(`/api/approval/${approvalId}`);

      if (view.stage !== lastStage) {
        // The four stages, narrated as they happen (T-3.3).
        say.info(`stage → ${view.stage}`);
        lastStage = view.stage;
      }
      if (view.state !== 'PENDING') {
        return { state: view.state, failReason: view.failReason };
      }
      if (view.remainingMs < 12_000 && view.remainingMs > 11_000) {
        say.wait('window closing…');
      }
    } catch (err) {
      say.info(`transient error, retrying: ${String(err)}`);
    }
  }
  return { state: 'EXPIRED', failReason: 'no decision before the window closed' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Entry point ─────────────────────────────────────────────────────────────

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    // A structured refusal is an outcome, not a crash. Anything reaching here is
    // a genuine bug in the runner, so it gets a stack trace.
    if (err instanceof AgentHttpError) {
      const body: Refusal = err.body;
      say.bad(`${body.code}: ${body.message}`);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  });
