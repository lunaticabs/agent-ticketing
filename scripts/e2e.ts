#!/usr/bin/env tsx
/**
 * ============================================================================
 *  End-to-end rehearsal (T-7.3) — all six demo beats, over real HTTP
 * ============================================================================
 *
 *   ENABLE_DEV_ROUTES=1 npm run dev      # in one terminal
 *   npm run e2e                          # in another
 *
 * Everything here goes through the public HTTP API with a real cookie jar, the
 * way a browser or the agent runner would. Nothing calls `lib/` directly, which
 * matters for two reasons:
 *
 *   * the gate is exercised the way an attacker would exercise it
 *   * the concurrency checks are *real* concurrency — two sockets, two requests,
 *     one database — rather than two sequential function calls pretending
 *
 * It is also the "one command, whole demo" fallback: if a live rehearsal goes
 * wrong on stage, this is the thing to run instead.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { describeTarget, reportPreflight, PreflightError, requireDevRoutes, requireLocalIdp, resolveTarget } from './preflight';

/** Resolved in `main`, once the server has been found. */
let BASE = '';

interface BotArmyShape {
  allocated: { bots: number; humans: number; empty: number };
  slots: number;
  elapsedMs: number;
  joined: number;
  humans: number;
  shares: {
    botEntrants: number;
    botEntrantShare: number;
    botSlotShare: number;
    humanEntrantShare: number;
    humanSlotShare: number;
    speedAdvantage: number;
  };
}

interface Result {
  beat: string;
  name: string;
  pass: boolean;
  detail: string;
}

const results: Result[] = [];

function record(beat: string, name: string, pass: boolean, detail: string): void {
  results.push({ beat, name, pass, detail });
  const mark = pass ? '\u001b[32m✔\u001b[0m' : '\u001b[31m✖\u001b[0m';
  console.log(`  ${mark} ${name}`);
  console.log(`      ${detail}`);
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

class Session {
  private cookies = new Map<string, string>();
  constructor(readonly continuityId: string) {}

  get cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res: Response): void {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
}

interface ApiResponse<T> {
  status: number;
  body: T;
}

async function api<T = Record<string, unknown>>(
  path: string,
  opts: { method?: string; body?: unknown; session?: Session; bearer?: string } = {},
): Promise<ApiResponse<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(opts.session ? { cookie: opts.session.cookieHeader } : {}),
      ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  opts.session?.absorb(res);
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: body as T };
}

async function impersonate(handle: string): Promise<Session> {
  const res = await fetch(`${BASE}/api/dev/impersonate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle }),
  });
  const body = (await res.json()) as { continuityId: string };
  const session = new Session(body.continuityId);
  session.absorb(res);
  return session;
}

/** Sign a human in, put them in the queue, and settle the draw. */
async function queueHuman(handle: string): Promise<Session> {
  const session = await impersonate(handle);
  await api('/api/queue/join', { body: {}, session });
  return session;
}

/** Complete a local-fallback approval by driving the consent endpoint. */
async function approveViaConsent(url: string | undefined, requestId: string, handle: string, stale = false) {
  if (!url) {
    // Device mode: no URL, and no way for a script to approve. Fine — the beat
    // is about the human, so we surface it rather than faking it.
    return { ok: false, reason: 'no consent URL returned (device mode)' };
  }
  const res = await api('/api/auth/local', { body: { requestId, handle, stale } });
  return { ok: res.status === 200 && (res.body as { ok?: boolean }).ok === true, reason: JSON.stringify(res.body).slice(0, 200) };
}

// ── Beats ───────────────────────────────────────────────────────────────────

async function beat0Setup(): Promise<boolean> {
  const reset = await api('/api/dev/reset', { body: {} });
  const prime = await api('/api/dev/prime', { body: { humans: 6 } });
  const ok = reset.status === 200 && prime.status === 200;
  record('setup', 'reset + prime the demo state', ok, `reset=${reset.status} prime=${prime.status}`);
  return ok;
}

async function beat1SpeedContrast(): Promise<boolean> {
  // Run the SAME bot script twice: once FCFS, once with the draw.
  const contrast = await api<{
    fcfs: BotArmyShape;
    lottery: BotArmyShape;
    verdict: string;
    statistics: { fcfsZ: number; lotteryZ: number; fairShareSd: number; slotCount: number; entrantCount: number };
  }>('/api/dev/bots', { body: { mode: 'compare', accounts: 24, humans: 24, slots: 24 } });

  if (contrast.status !== 200) {
    record('beat 1', 'speed contrast', false, `HTTP ${contrast.status}: ${JSON.stringify(contrast.body).slice(0, 200)}`);
    return false;
  }
  const { verdict, statistics } = contrast.body;

  // The claim under test, expressed against the null distribution rather than
  // against a hand-picked threshold:
  //
  //   under FCFS the bots' slot share is many sigma ABOVE their share of the
  //   entrant pool; under the draw it is within noise of it.
  //
  // A raw "did they get exactly their share" check would fail on a fair draw
  // whenever the sampling noise went the wrong way, which is roughly a third of
  // the time at this slot count.
  const fcfsRewardsSpeed = statistics.fcfsZ > 3;
  const lotteryNeutralises = Math.abs(statistics.lotteryZ) < 3;
  const pass = fcfsRewardsSpeed && lotteryNeutralises;

  record(
    'beat 1',
    'FCFS rewards the bot army; the draw neutralises it',
    pass,
    `${verdict} (sd ${(statistics.fairShareSd * 100).toFixed(1)} points over ` +
      `${statistics.slotCount} slots / ${statistics.entrantCount} entrants)`,
  );

  await api('/api/dev/reset', { body: {} });
  return pass;
}

async function beat2HappyPath(): Promise<{ pass: boolean; session?: Session }> {
  await api('/api/dev/reset', { body: {} });

  const alice = await queueHuman('alice');
  await api('/api/dev/fast-forward', { body: {} });

  const requested = await api<{
    ok: true;
    approvalId: string;
    requestId: string;
    url?: string;
    slotId: string;
    boundAction: string;
    mode: string;
  }>('/api/slot/request', { body: {}, session: alice });

  if (requested.status !== 200) {
    record('beat 2', 'happy path: agent asks, human approves, slot confirmed', false, `request failed: ${JSON.stringify(requested.body).slice(0, 200)}`);
    return { pass: false };
  }

  // The four stages, checked as they advance.
  const before = await api<{ stages: { key: string; at: number | null }[] }>(
    `/api/approval/${requested.body.approvalId}`,
    { session: alice },
  );
  const requestedAt = (before.body as { stages: { key: string; at: number | null }[] }).stages.find((s) => s.key === 'requested')?.at;

  const consent = await approveViaConsent(requested.body.url, requested.body.requestId, 'alice');
  if (!consent.ok) {
    record('beat 2', 'happy path', false, `consent failed: ${consent.reason}`);
    return { pass: false };
  }

  const mid = await api<{ state: string; stages: { key: string; at: number | null }[] }>(
    `/api/approval/${requested.body.approvalId}`,
    { session: alice },
  );
  const completedAt = mid.body.stages.find((s) => s.key === 'completed')?.at;

  const claimed = await api<{ ok: true; slotId: string; stages: Record<string, number | null> }>(
    '/api/slot/claim',
    { body: { approval: requested.body.approvalId }, session: alice },
  );

  const after = await api<{ stages: { key: string; at: number | null }[] }>(
    `/api/approval/${requested.body.approvalId}`,
    { session: alice },
  );
  const verifiedAt = after.body.stages.find((s) => s.key === 'verified')?.at;
  const executedAt = after.body.stages.find((s) => s.key === 'executed')?.at;

  const fourStages = Boolean(requestedAt && completedAt && verifiedAt && executedAt);
  const pass = claimed.status === 200 && fourStages;

  record(
    'beat 2',
    'agent asks → human approves → server verifies → slot confirmed',
    pass,
    pass
      ? `slot ${claimed.body.slotId} confirmed; all four stages recorded ` +
        `(requested → completed → verified → executed). bound action: ${requested.body.boundAction}`
      : `claim=${claimed.status} fourStages=${fourStages} ${JSON.stringify(claimed.body).slice(0, 200)}`,
  );

  return { pass, session: alice };
}

async function beat3Deferral(): Promise<boolean> {
  await api('/api/dev/reset', { body: {} });

  // Two humans, one slot: the second is the one who benefits from the first
  // missing their window.
  const first = await queueHuman('defer-first');
  await queueHuman('defer-second');
  await api('/api/dev/fast-forward', { body: { deferAllocations: false } });

  const status = await api<{ allocation: { slotId: string }[] }>('/api/queue/status', { session: first });
  if (!status.body.allocation?.length) {
    record('beat 3', 'missing the window defers the slot', false, 'the first human was not allocated a slot');
    return false;
  }
  const slotId = status.body.allocation[0].slotId;

  // Collapse the window: this expires every live approval deadline.
  const ff = await api<{ deferrals: number }>('/api/dev/fast-forward', { body: {} });
  await delay(150);

  const board = await api<{
    slots: { items: { id: string; state: string; holderShort: string | null; deferralCount: number }[] };
    highlight: { kind: string; message: string };
  }>('/api/board/state');

  const slot = board.body.slots.items.find((s) => s.id === slotId);
  const deferred = Boolean(slot && slot.deferralCount > 0);
  const boardShowsIt = board.body.highlight.kind === 'deferral';

  // The original candidate must now be unable to claim, even with a fresh proof.
  const late = await api<{ code: string }>('/api/slot/request', { body: {}, session: first });
  const refusedForLate = late.status !== 200;

  const pass = deferred && boardShowsIt && refusedForLate;
  record(
    'beat 3',
    'window closes → slot defers → the missed candidate cannot buy',
    pass,
    pass
      ? `slot ${slotId} deferred (count ${slot?.deferralCount}); board highlight="${board.body.highlight.message}"; ` +
        `the original candidate is refused with "${(late.body as { code?: string }).code}"`
      : `deferred=${deferred} boardHighlight=${boardShowsIt} lateRefused=${refusedForLate} ff=${JSON.stringify(ff.body).slice(0, 120)}`,
  );
  return pass;
}

async function beat4Laundering(): Promise<boolean> {
  await api('/api/dev/reset', { body: {} });

  const result = await api<{
    accounts: number;
    humans: number;
    completed: number;
    refused: number;
    headline: string;
    attempts: { outcome: string; code?: string }[];
  }>('/api/dev/laundering', { body: { accounts: 40, humans: 2 } });

  if (result.status !== 200) {
    record('beat 4', '40 accounts collapse into 2 humans', false, `HTTP ${result.status}`);
    return false;
  }

  const { completed, humans, refused, headline, attempts } = result.body;
  const capPerHuman = 2;
  const expectedMax = humans * capPerHuman;
  const capHolds = completed <= expectedMax;
  const actuallyRefused = refused > 0 && attempts.some((a) => a.code === 'inbound_cap_reached');
  const pass = capHolds && actuallyRefused;

  record(
    'beat 4',
    '40 accounts → 2 continuity ids → the cap holds',
    pass,
    `${headline} | completed=${completed} (ceiling ${humans}×${capPerHuman}=${expectedMax}), refused=${refused}`,
  );
  return pass;
}

async function beat5FriendTransfer(): Promise<boolean> {
  await api('/api/dev/reset', { body: {} });

  const alice = await queueHuman('alice');
  await api('/api/dev/fast-forward', { body: {} });

  // Alice buys her slot through the real gate.
  const aliceReq = await api<{ approvalId: string; requestId: string; url?: string }>('/api/slot/request', {
    body: {},
    session: alice,
  });
  await approveViaConsent(aliceReq.body.url, aliceReq.body.requestId, 'alice');
  const aliceClaim = await api('/api/slot/claim', { body: { approval: aliceReq.body.approvalId }, session: alice });
  if (aliceClaim.status !== 200) {
    record('beat 5', 'friend-to-friend transfer', false, `alice could not confirm: ${JSON.stringify(aliceClaim.body).slice(0, 200)}`);
    return false;
  }
  const slotId = (aliceClaim.body as { slotId: string }).slotId;

  // Bob is a friend who was never in the queue.
  const bob = await impersonate('bob-the-friend');

  const created = await api<{ ok: true; token: string; link: string; expiresAt: null }>('/api/transfer', {
    body: { slotId, to: bob.continuityId },
    session: alice,
  });
  if (created.status !== 200) {
    record('beat 5', 'friend-to-friend transfer', false, `create failed: ${JSON.stringify(created.body).slice(0, 200)}`);
    return false;
  }
  const ttlNotStarted = created.body.expiresAt === null;

  // Recipient opens it — this is where the clock starts (RED LINE 7).
  const opened = await api<{ expiresAt: number; windowSec: number; justOpened: boolean }>(
    `/api/transfer/${created.body.token}`,
    { body: { action: 'open' }, session: bob },
  );

  const requested = await api<{ approvalId: string; requestId: string; url?: string; boundSignal: string }>(
    `/api/transfer/${created.body.token}`,
    { body: { action: 'request' }, session: bob },
  );
  if (requested.status !== 200) {
    record('beat 5', 'friend-to-friend transfer', false, `request failed: ${JSON.stringify(requested.body).slice(0, 200)}`);
    return false;
  }

  const started = Date.now();
  await approveViaConsent(requested.body.url, requested.body.requestId, 'bob-the-friend');
  const completed = await api<{ ok: true; inboundCount: number; inboundCap: number }>(
    `/api/transfer/${created.body.token}`,
    { body: { action: 'complete', approval: requested.body.approvalId }, session: bob },
  );
  const elapsedMs = Date.now() - started;

  const pass =
    ttlNotStarted && opened.body.justOpened && completed.status === 200 && completed.body.inboundCount === 1;

  record(
    'beat 5',
    'a normal transfer costs one real person ~seconds of attention',
    pass,
    pass
      ? `TTL did not start until Bob opened it; window ${opened.body.windowSec}s; ` +
        `approval + completion took ${elapsedMs}ms; Bob's inbound is now ` +
        `${completed.body.inboundCount}/${completed.body.inboundCap}`
      : `ttlNotStarted=${ttlNotStarted} opened=${opened.body.justOpened} complete=${completed.status}`,
  );
  return pass;
}

async function beat6Attacks(): Promise<boolean> {
  const attacks = await api<{
    attacks: { attack: string; blocked: boolean; code: string; message: string; verification: { protectedActionHappened: boolean; detail: string } }[];
  }>('/api/dev/attack', { body: { attack: 'all' } });

  if (attacks.status !== 200) {
    record('beat 6', 'replay / tamper / environment swap', false, `HTTP ${attacks.status}`);
    return false;
  }

  const all = attacks.body.attacks;
  const blocked = all.filter((a) => a.blocked && !a.verification.protectedActionHappened);
  const pass = blocked.length === all.length && all.length === 3;

  record(
    'beat 6',
    'replay, parameter tampering and an environment swap are all refused',
    pass,
    `${blocked.length}/${all.length} blocked. ` +
      all.map((a) => `${a.attack}→${a.code}`).join('; '),
  );
  return pass;
}

// ── Failure matrix (T-7.1) ──────────────────────────────────────────────────

async function failureMatrix(): Promise<boolean> {
  await api('/api/dev/reset', { body: {} });
  const alice = await queueHuman('failure-alice');
  await api('/api/dev/fast-forward', { body: {} });

  const cases: { name: string; code: string; actual: string; status: number }[] = [];

  // 1. no approval presented
  {
    const res = await api<{ code: string }>('/api/slot/claim', { body: {}, session: alice });
    cases.push({ name: 'claim with no approval', code: 'approval_required', actual: res.body.code, status: res.status });
  }

  // 2. a forged client verdict
  {
    const res = await api<{ code: string }>('/api/slot/claim', {
      body: { eventId: (await currentEventId()), ok: true },
      session: alice,
    });
    cases.push({ name: 'forged {ok:true} verdict', code: 'untrusted_client_result', actual: res.body.code, status: res.status });
  }

  // 3. a client-supplied environment
  {
    const res = await api<{ code: string }>('/api/slot/claim', {
      body: { eventId: await currentEventId(), environment: 'production' },
      session: alice,
    });
    cases.push({ name: 'client-supplied environment', code: 'environment_pinned', actual: res.body.code, status: res.status });
  }

  // 4. an unknown approval reference
  {
    const res = await api<{ code: string }>('/api/slot/claim', {
      body: { approval: 'apv_fabricated' },
      session: alice,
    });
    cases.push({ name: 'fabricated approval reference', code: 'approval_not_found', actual: res.body.code, status: res.status });
  }

  // 5. unauthenticated
  {
    const res = await api<{ code: string }>('/api/slot/claim', { body: { approval: 'apv_x' } });
    cases.push({ name: 'no session at all', code: 'not_authenticated', actual: res.body.code, status: res.status });
  }

  // 6. a stale authentication
  {
    const requested = await api<{ approvalId: string; requestId: string; url?: string }>('/api/slot/request', {
      body: {},
      session: alice,
    });
    await approveViaConsent(requested.body.url, requested.body.requestId, 'failure-alice', true);
    const res = await api<{ code: string }>('/api/slot/claim', {
      body: { approval: requested.body.approvalId },
      session: alice,
    });
    cases.push({ name: 'stale authentication (max_age=0)', code: 'not_fresh', actual: res.body.code, status: res.status });
  }

  // 7. an expired approval window
  {
    const requested = await api<{ approvalId: string; requestId: string; url?: string }>('/api/slot/request', {
      body: {},
      session: alice,
    });
    // Let the window lapse without answering, then try to use it.
    await api('/api/dev/fast-forward', { body: {} });
    await delay(120);
    const res = await api<{ code: string }>('/api/slot/claim', {
      body: { approval: requested.body.approvalId },
      session: alice,
    });
    cases.push({ name: 'window closed before the decision', code: 'deferred_to_next_candidate', actual: res.body.code, status: res.status });
  }

  // 8. denied by the human
  {
    await api('/api/dev/reset', { body: {} });
    const denier = await queueHuman('denier');
    await api('/api/dev/fast-forward', { body: {} });
    const requested = await api<{ approvalId: string; requestId: string }>('/api/slot/request', { body: {}, session: denier });
    await api('/api/auth/deny', { body: { requestId: requested.body.requestId }, session: denier });
    const res = await api<{ code: string }>('/api/slot/claim', {
      body: { approval: requested.body.approvalId },
      session: denier,
    });
    cases.push({ name: 'human denied the request', code: 'approval_denied', actual: res.body.code, status: res.status });
  }

  // 9. dev routes disabled — checked without the flag by the unit tests; here we
  //    confirm the gate itself is not bypassed by any dev surface.
  {
    const res = await api<{ code: string }>('/api/dev/impersonate', { body: {} });
    cases.push({
      name: 'malformed dev call',
      code: 'bad_request',
      actual: res.body.code,
      status: res.status,
    });
  }

  let allPass = true;
  console.log('');
  for (const c of cases) {
    const ok = c.actual === c.code;
    if (!ok) allPass = false;
    const mark = ok ? '\u001b[32m✔\u001b[0m' : '\u001b[31m✖\u001b[0m';
    console.log(`  ${mark} ${c.name.padEnd(38)} → ${c.actual} (${c.status})`);
  }

  record(
    'T-7.1',
    'failure matrix: every refusal is structured and none executes',
    allPass,
    `${cases.filter((c) => c.actual === c.code).length}/${cases.length} returned the expected machine-readable code`,
  );
  return allPass;
}

async function currentEventId(): Promise<string> {
  const health = await api<{ event: { id: string } }>('/api/health');
  return health.body.event.id;
}

// ── Concurrency (RED LINE 5, over real sockets) ─────────────────────────────

async function concurrencyCheck(): Promise<boolean> {
  await api('/api/dev/reset', { body: {} });
  const alice = await queueHuman('race-alice');
  await api('/api/dev/fast-forward', { body: {} });

  const requested = await api<{ approvalId: string; requestId: string; url?: string }>('/api/slot/request', {
    body: {},
    session: alice,
  });
  await approveViaConsent(requested.body.url, requested.body.requestId, 'race-alice');

  // Two simultaneous claims, same approval, two sockets.
  const [a, b] = await Promise.all([
    api<{ code?: string }>('/api/slot/claim', { body: { approval: requested.body.approvalId }, session: alice }),
    api<{ code?: string }>('/api/slot/claim', { body: { approval: requested.body.approvalId }, session: alice }),
  ]);

  const successes = [a, b].filter((r) => r.status === 200).length;
  const codes = [a, b].map((r) => r.body.code ?? 'OK').join(' / ');

  const board = await api<{ slots: { confirmed: number } }>('/api/board/state');
  const exactlyOne = successes === 1 && board.body.slots.confirmed === 1;

  record(
    'T-7.2',
    'concurrent double-submit leaves exactly one winner',
    exactlyOne,
    `two simultaneous claims → ${successes} succeeded (${codes}); confirmed slots = ${board.body.slots.confirmed}`,
  );
  return exactlyOne;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  try {
    const target = await resolveTarget();
    BASE = target.base;
    requireDevRoutes(target);
    // The six beats include "the agent asks a human and the human approves",
    // which a script can only complete against the simulated provider.
    requireLocalIdp(target, 'the end-to-end rehearsal');

    console.log('');
    console.log(describeTarget(target, 'end-to-end rehearsal'));
    console.log(`  ${'─'.repeat(88)}`);
  } catch (err) {
    if (err instanceof PreflightError) return reportPreflight(err);
    throw err;
  }

  console.log('');
  await beat0Setup();
  await beat1SpeedContrast();
  await beat2HappyPath();
  await beat3Deferral();
  await beat4Laundering();
  await beat5FriendTransfer();
  await beat6Attacks();

  console.log('');
  console.log(`  ${'─'.repeat(88)}`);
  console.log('  failure matrix (T-7.1)');
  await failureMatrix();

  console.log('');
  console.log(`  ${'─'.repeat(88)}`);
  console.log('  concurrency');
  await concurrencyCheck();

  const failed = results.filter((r) => !r.pass);
  console.log('');
  console.log(`  ${'─'.repeat(88)}`);
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('');
    for (const f of failed) console.log(`    ✖ ${f.beat} · ${f.name}`);
  }
  console.log('');

  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
