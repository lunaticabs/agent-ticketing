/**
 * ============================================================================
 *  User journeys, driven by clicking things
 * ============================================================================
 *
 * Each test below is a person using the product: it renders a real page, finds a
 * real button, clicks it, and reads the real DOM. Nothing calls an internal
 * function and nothing asserts on a variable; if a control is unreachable or a
 * state is unrenderable, the test fails the way a user would notice.
 *
 * That is deliberate, because the three bugs that reached a human all had the
 * same shape — two copies of one state, with nothing asserting they agreed — and
 * all three were invisible to a suite that drove the API and read JSON:
 *
 *   · the console read `status.data.inbound.used` off a /api/health response and
 *     crashed for every signed-out visitor
 *   · the public base URL and the registered redirect URI sat on different
 *     schemes, so links pointed where the server was not
 *   · the approval id lived in React state and did not survive the redirect to
 *     the consent screen, so the handover could never be completed in a browser
 *
 * The network is stubbed here; `npm run e2e` covers the real one. What is new in
 * this file is the user.
 */
import './setup';
import test from 'node:test';
import assert from 'node:assert/strict';

import { calls, navigationAttempts, render, resetNetwork, stub, teardown } from './ui-drive';

// ── Fixtures: the payloads the API really returns ───────────────────────────

const HEALTH = {
  ok: true,
  service: 'presence',
  environment: 'sandbox',
  idp: {
    mode: 'local',
    issuer: 'https://sandbox.auth.world.org',
    degraded: true,
    hasCredentials: false,
    detail: 'fallback',
  },
  urls: {
    publicBaseUrl: 'http://localhost:3000',
    redirectUri: 'http://localhost:3000/api/auth/world/callback',
    consistent: true,
    problem: null,
  },
  devRoutes: true,
  event: {
    id: 'evt_test',
    name: 'Tokyo Night',
    policy: 'gift',
    lotteryMode: 'lottery',
    lotteryDrawn: false,
    windows: { lotterySec: 15, approvalSec: 90, transferSec: 120 },
  },
};

/**
 * Built fresh on every call.
 *
 * `serverNow` and the slot deadline must be relative to the moment of the
 * request, not to module load. A fixture that freezes the clock also freezes
 * any countdown the page derives from it — which is the inverse of the bug being
 * tested, and would happily hide a genuinely stuck countdown.
 */
function statusPayload(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    serverNow: Date.now(),
    continuityId: 'cid_abc123',
    event: {
      id: 'evt_test',
      name: 'Tokyo Night',
      policy: 'gift',
      lotteryMode: 'lottery',
      lotteryDrawn: true,
      lotteryClosesAt: null,
    },
    queue: { entryId: 'q_1', joined: true, arrivalSeq: 1, lotteryRank: 1, allocatedAt: Date.now(), stats: {}, total: 1 },
    allocation: [],
    holding: [],
    vip: false,
    grants: [],
    inbound: { used: 0, cap: 2 },
    slots: { total: 8, available: 7, allocated: 0, confirmed: 0, transfers: 0 },
    openApprovals: [],
    recentTransitions: [],
    ...overrides,
  };
}

/** A slot allocated right now, with a window that has genuinely just opened. */
const allocated = () => ({
  slotId: 'slot_tokyo_night_1',
  deadline: Date.now() + 90_000,
  remainingMs: 90_000,
  deferralCount: 0,
});

function openApproval(overrides: Record<string, unknown> = {}) {
  return {
    approvalId: 'apv_1',
    state: 'PENDING',
    stage: 'requested',
    kind: 'purchase',
    boundAction: 'buy_slot:evt_test',
    boundSignal: 'evt_test:cid_abc123',
    slotId: 'slot_tokyo_night_1',
    mode: 'local',
    consentUrl: 'http://localhost:3000/auth/local?request=areq_1',
    requestedAt: Date.now(),
    completedAt: null,
    verifiedAt: null,
    executedAt: null,
    expiresAt: Date.now() + 90_000,
    remainingMs: 90_000,
    ...overrides,
  };
}

/** Everything a signed-out visitor needs, and nothing else. */
function stubSignedOut(): void {
  stub('/api/health', HEALTH);
  stub('/api/auth/me', { ok: false, code: 'not_authenticated', message: 'sign in' }, 401);
}

function stubSignedIn(): void {
  stub('/api/health', HEALTH);
  stub('/api/auth/me', { ok: true, continuityId: 'cid_abc123', grants: [] });
}

// ════════════════════════════════════════════════════════════════════════════
//  Journey A — a participant joins, waits, authorizes, and is confirmed
// ════════════════════════════════════════════════════════════════════════════

test('journey · signed-out visitor can find and press the sign-in button', async () => {
  resetNetwork();
  stubSignedOut();

  const ConsolePage = (await import('../app/page')).default;
  const screen = await render(ConsolePage);
  try {
    await screen.waitFor((s) => s.buttons().includes('Sign in with World ID'), 'the sign-in button');
    // The explanation differs by idp mode — "Sign in against <issuer>" on the
    // real provider, "the local fallback will simulate the consent screen"
    // otherwise. Assert that *something* explains it, not which sentence.
    assert.ok(
      /Sign in against|local fallback will simulate/.test(screen.text()),
      `the sign-in card should explain what is about to happen; got: ${screen.text().slice(0, 300)}`,
    );
  } finally {
    await screen.unmount();
  }
});

test('journey · joining the queue opens a slot with a live countdown', async () => {
  resetNetwork();
  stubSignedIn();
  // The slot arrives only after the join, exactly as it does in the real flow.
  stub('/api/queue/join', { ok: true, created: true, arrivalSeq: 1, queueLength: 1 });
  let joined = false;
  // Not joined yet — which is the state the button exists for. A fixture that
  // starts out joined renders "sign out" and no join button at all.
  const notYet = () => statusPayload({ queue: { entryId: null, joined: false, arrivalSeq: null, lotteryRank: null, allocatedAt: null, stats: {}, total: 0 } });
  stub('/api/queue/status', () => (joined ? statusPayload({ allocation: [allocated()] }) : notYet()));

  const ConsolePage = (await import('../app/page')).default;
  const screen = await render(ConsolePage);

  try {
    await screen.waitFor((s) => s.buttons().includes('Join the queue'), 'the join button');
    joined = true;
    await screen.click('Join the queue');

    await screen.waitFor(
      (s) => s.text().includes('slot_tokyo_night_1'),
      'the allocated slot to appear',
    );
    assert.ok(
      screen.buttons().includes('Ask me to authorize'),
      `the authorize button should be offered; got ${JSON.stringify(screen.buttons())}`,
    );
  } finally {
    await screen.unmount();
  }
});

test('journey · pressing authorize sends the human to the consent screen', async () => {
  resetNetwork();
  stubSignedIn();
  stub('/api/queue/status', statusPayload({ allocation: [allocated()] }));
  stub('/api/slot/request', {
    ok: true,
    approvalId: 'apv_1',
    requestId: 'areq_1',
    mode: 'local',
    degraded: true,
    note: 'fallback',
    url: 'http://localhost:3000/auth/local?request=areq_1',
    boundAction: 'buy_slot:evt_test',
    boundSignal: 'evt_test:cid_abc123',
    slotId: 'slot_tokyo_night_1',
    windowSec: 90,
    expiresAt: Date.now() + 90_000,
  });

  const { navigationAttempts } = await import('./ui-drive');
  navigationAttempts.length = 0;

  const ConsolePage = (await import('../app/page')).default;
  const screen = await render(ConsolePage);
  try {
    await screen.waitFor((s) => s.buttons().includes('Ask me to authorize'), 'the authorize button');
    await screen.click('Ask me to authorize');

    await screen.waitFor(
      () => navigationAttempts.length > 0,
      'the browser to be sent to the consent screen',
    );
    assert.ok(
      calls.some((c) => c.method === 'POST' && c.path === '/api/slot/request'),
      'pressing authorize must actually request one',
    );
  } finally {
    await screen.unmount();
  }
});

test('journey · returning from consent completes the handover with no further click', async () => {
  // The exact sequence a person performs: authorize, approve on the phone, come
  // back. The page has never seen this approval before — it must read it from
  // the server rather than remembering it.
  resetNetwork();
  stubSignedIn();
  stub(
    '/api/queue/status',
    statusPayload({
      allocation: [allocated()],
      openApprovals: [
        openApproval({
          state: 'APPROVED',
          stage: 'completed',
          consentUrl: null,
          completedAt: Date.now() - 500,
        }),
      ],
    }),
  );
  stub('/api/slot/claim', {
    ok: true,
    slotId: 'slot_tokyo_night_1',
    nullifier: 'nul_1',
    stages: { requestedAt: 1, completedAt: 2, verifiedAt: 3, executedAt: 4 },
  });

  const ConsolePage = (await import('../app/page')).default;
  const screen = await render(ConsolePage);

  try {
    await screen.waitFor(
      () => calls.some((c) => c.method === 'POST' && c.path === '/api/slot/claim'),
      'the page to present the approval to the gate by itself',
    );

    // And it must not offer to start a second authorization while one is live.
    assert.ok(
      !screen.buttons().includes('Ask me to authorize'),
      'the authorize button must be gone while an authorization is outstanding',
    );
  } finally {
    await screen.unmount();
  }
});

test('journey · the slot countdown stays visible and keeps counting', async () => {
  resetNetwork();
  stubSignedIn();
  stub('/api/queue/status', statusPayload({ allocation: [allocated()] }));

  const ConsolePage = (await import('../app/page')).default;
  const screen = await render(ConsolePage);
  try {
    await screen.waitFor((s) => /\d+\.\ds/.test(s.text()), 'a countdown to render');
    const first = /(\d+\.\d)s/.exec(screen.text())?.[1];
    await screen.settle(500);
    const second = /(\d+\.\d)s/.exec(screen.text())?.[1];
    assert.ok(first && second, `expected a countdown; text was ${screen.text().slice(0, 200)}`);
    assert.notEqual(first, second, 'the countdown must actually tick');
  } finally {
    await screen.unmount();
  }
});

test('journey · a held slot offers a transfer link, and creating one is acknowledged', async () => {
  resetNetwork();
  stubSignedIn();
  stub(
    '/api/queue/status',
    statusPayload({
      holding: [{ slotId: 'slot_tokyo_night_1', state: 'CONFIRMED', acquiredVia: 'lottery' }],
    }),
  );
  stub('/api/transfer', {
    ok: true,
    transferId: 'xfer_1',
    token: 'tok_1',
    link: 'http://localhost:3000/transfer/tok_1',
    expiresAt: null,
    directed: false,
    policy: 'gift',
  });

  const ConsolePage = (await import('../app/page')).default;
  const screen = await render(ConsolePage);

  try {
    await screen.waitFor(
      (s) => s.buttons().includes('Create a transfer link'),
      'the transfer button on a held slot',
    );
    await screen.click('Create a transfer link');

    await screen.waitFor(
      (s) => s.text().includes('/transfer/tok_1'),
      'the new link to be shown back',
    );
    // The window must not start until the recipient opens it — the page says so.
    assert.ok(
      screen.text().includes('has not started'),
      'the page should explain that the window has not started yet',
    );
  } finally {
    await screen.unmount();
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  Journey B — the consent screen
// ════════════════════════════════════════════════════════════════════════════

test('journey · the consent screen approves, and says what happens next', async () => {
  resetNetwork();
  stub('/api/auth/local', { ok: true, linked: false, continuityId: 'cid_abc123', degraded: true, note: 'fresh' });

  const { ApproveForm } = await import('../app/auth/local/form');
  const screen = await render(ApproveForm, {
    requestId: 'areq_1',
    intent: 'purchase',
    existingHandle: 'linked human',
    navigate: () => undefined,
  });

  try {
    assert.ok(screen.buttons().includes('Approve'), `expected an Approve button; got ${JSON.stringify(screen.buttons())}`);
    assert.ok(screen.buttons().includes('Deny'), 'expected a Deny button');

    await screen.click('Approve');
    await screen.waitFor(
      (s) => s.text().includes('server now verifies') || s.text().includes('submitted'),
      'confirmation that the server will verify',
    );
    assert.ok(
      calls.some((c) => c.path === '/api/auth/local'),
      'approving must reach the consent endpoint',
    );
  } finally {
    await screen.unmount();
  }
});

test('journey · the consent screen denies, and states that nothing will run', async () => {
  resetNetwork();
  stub('/api/auth/deny', { ok: true, requestId: 'areq_1', state: 'DENIED', note: 'denied' });

  const { ApproveForm } = await import('../app/auth/local/form');
  const screen = await render(ApproveForm, {
    requestId: 'areq_1',
    intent: 'purchase',
    existingHandle: 'linked human',
    navigate: () => undefined,
  });

  try {
    await screen.click('Deny');
    await screen.waitFor(
      (s) => s.text().includes('will not execute') || s.text().includes('defer'),
      'confirmation that nothing executes',
    );
  } finally {
    await screen.unmount();
  }
});

test('journey · the stale-session checkbox changes what the Approve button says', async () => {
  // This control is how the freshness refusal is demonstrated without waiting an
  // hour, so it has to be reachable and it has to be honest about itself.
  resetNetwork();
  stub('/api/auth/local', { ok: true, linked: false, continuityId: 'cid_abc123', degraded: true, note: 'stale' });

  const { ApproveForm } = await import('../app/auth/local/form');
  const screen = await render(ApproveForm, {
    requestId: 'areq_1',
    intent: 'purchase',
    existingHandle: 'linked human',
    navigate: () => undefined,
  });

  try {
    assert.ok(screen.buttons().includes('Approve'), 'default state should offer a plain Approve');
    await screen.toggle('Simulate an old session', true);
    assert.ok(
      screen.buttons().includes('Approve with an old session'),
      `the button should say what it will do; got ${JSON.stringify(screen.buttons())}`,
    );
    assert.ok(
      screen.text().includes('not_fresh'),
      'and it should name the refusal the gate will produce',
    );
  } finally {
    await screen.unmount();
  }
});

test('journey · a link attempt requires a handle before it can be approved', async () => {
  resetNetwork();
  stub('/api/auth/local', { ok: true, linked: true, continuityId: 'cid_new', degraded: true, note: 'linked' });

  const { ApproveForm } = await import('../app/auth/local/form');
  const screen = await render(ApproveForm, {
    requestId: 'areq_2',
    intent: 'link',
    existingHandle: null,
    navigate: () => undefined,
  });

  try {
    const approveButton = () =>
      [...screen.container.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').includes('Approve'),
      ) as HTMLButtonElement;

    // The handle field is pre-filled so a demo does not stall on typing, so the
    // guard is not "empty by default" — it is "cannot submit with nothing".
    assert.ok(approveButton(), 'expected an Approve button');
    await screen.type('alice', '');
    assert.equal(approveButton().disabled, true, 'clearing the handle must disable approval');

    await screen.type('alice', 'carol');
    assert.equal(approveButton().disabled, false, 'and giving one must enable it again');
  } finally {
    await screen.unmount();
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  Journey C — a recipient receives a transfer
// ════════════════════════════════════════════════════════════════════════════

const TRANSFER_OFFER = {
  ok: true,
  transferId: 'xfer_1',
  slotId: 'slot_tokyo_night_1',
  from: 'cid_sender',
  to: null,
  state: 'CREATED',
  label: null,
  opened: false,
  openedAt: null,
  expiresAt: null,
  remainingMs: null,
  slotState: 'TRANSFER_PENDING',
  note: 'The window starts when you press Accept.',
};

test('journey · a recipient opens a transfer link and is told the clock has not started', async () => {
  resetNetwork();
  stub('/api/transfer/tok_1', TRANSFER_OFFER);
  stub('/api/transfer/tok_1', TRANSFER_OFFER);

  const { TransferView } = await import('../app/transfer/[token]/transfer-view');
  const screen = await render(TransferView, { token: 'tok_1' });

  try {
    await screen.waitFor((s) => s.text().includes('slot_tokyo_night_1'), 'the offer to load');
    assert.ok(
      screen.text().includes('clock has not started'),
      'the recipient should be told the window starts on Accept',
    );
    assert.ok(
      screen.buttons().includes('Accept and start the clock'),
      `expected the accept button; got ${JSON.stringify(screen.buttons())}`,
    );
  } finally {
    await screen.unmount();
  }
});

test('journey · accepting starts the window and offers fresh authorization', async () => {
  resetNetwork();
  // GET previews the offer; POST opens it. One path, two methods — which is
  // exactly why `stub` takes a method.
  let opened = false;
  stub(
    '/api/transfer/tok_2',
    () =>
      opened
        ? {
            ...TRANSFER_OFFER,
            state: 'OPENED',
            opened: true,
            openedAt: Date.now(),
            expiresAt: Date.now() + 120_000,
            remainingMs: 120_000,
            note: 'window running',
          }
        : TRANSFER_OFFER,
    200,
    'GET',
  );
  stub(
    '/api/transfer/tok_2',
    () => {
      opened = true;
      return { ok: true, stage: 'opened', transferId: 'xfer_1', justOpened: true, expiresAt: Date.now() + 120_000, windowSec: 120 };
    },
    200,
    'POST',
  );

  const { TransferView } = await import('../app/transfer/[token]/transfer-view');
  const screen = await render(TransferView, { token: 'tok_2' });

  try {
    await screen.waitFor((s) => s.buttons().includes('Accept and start the clock'), 'the accept button');
    await screen.click('Accept and start the clock');
    await screen.waitFor(
      (s) => s.text().includes('window running') || s.buttons().some((b) => b.includes('Prove it')),
      'the window to start',
    );
  } finally {
    await screen.unmount();
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  Journey D — the board
// ════════════════════════════════════════════════════════════════════════════

test('journey · the board renders a queue, slots and a countdown from one poll', async () => {
  resetNetwork();
  stub('/api/board/state', {
    serverNow: Date.now(),
    event: {
      id: 'evt_test',
      name: 'Tokyo Night',
      policy: 'gift',
      lotteryMode: 'lottery',
      totalSlots: 3,
      approvalWindowSec: 90,
      lotteryWindowSec: 15,
      transferWindowSec: 120,
      transferInboundCap: 2,
      lotteryDrawnAt: Date.now(),
      lotterySeed: 'seed123',
      lotteryOpen: false,
      lotteryClosesAt: null,
    },
    idp: { mode: 'local', degraded: true, issuer: 'https://sandbox.auth.world.org' },
    queue: {
      total: 2,
      drawn: 2,
      allocated: 1,
      waiting: 1,
      entries: [
        { entryId: 'q1', short: 'aaaa1111', seq: 1, joinedAt: Date.now(), rank: 1, allocatedAt: Date.now() },
        { entryId: 'q2', short: 'bbbb2222', seq: 2, joinedAt: Date.now(), rank: 2, allocatedAt: null },
      ],
    },
    slots: {
      total: 3,
      available: 1,
      allocated: 1,
      confirmed: 1,
      transferPending: 0,
      transferred: 0,
      deferrals: 1,
      items: [
        { id: 'slot_1', state: 'ALLOCATED', holder: 'cid_a', holderShort: 'aaaa1111', acquiredVia: 'lottery', approvalDeadline: Date.now() + 45_000, remainingMs: 45_000, deferralCount: 0, giftUsed: false },
        { id: 'slot_2', state: 'CONFIRMED', holder: 'cid_b', holderShort: 'bbbb2222', acquiredVia: 'lottery', approvalDeadline: null, remainingMs: null, deferralCount: 1, giftUsed: false },
        { id: 'slot_3', state: 'AVAILABLE', holder: null, holderShort: null, acquiredVia: null, approvalDeadline: null, remainingMs: null, deferralCount: 0, giftUsed: false },
      ],
    },
    approvals: [
      {
        id: 'apv_1',
        kind: 'purchase',
        continuityId: 'cid_a',
        continuityShort: 'aaaa1111',
        slotId: 'slot_1',
        state: 'PENDING',
        boundAction: 'buy_slot:evt_test',
        boundSignal: 'evt_test:cid_a',
        failReason: null,
        expiresAt: Date.now() + 45_000,
        remainingMs: 45_000,
        stages: { requested: Date.now(), completed: null, verified: null, executed: null },
      },
    ],
    transfers: { total: 0, open: 0, completed: 0, expired: 0, rejectedAttempts: 0, items: [] },
    inbound: [{ continuityId: 'cid_b', short: 'bbbb2222', count: 2, cap: 2 }],
    humans: { total: 2, distinctInQueue: 2 },
    drawVerification: { settled: true, matches: true, checked: 2, seed: 'seed123', algorithm: 'sha256(seed||id)' },
    security: { consumedProofs: 1, protectedActionsExecuted: 1, totalRefusals: 3, refusals: {} },
    audit: [
      { id: 'a1', type: 'slot.approval_expired', severity: 'warn', at: Date.now(), continuityShort: 'aaaa1111', slotId: 'slot_2', payload: { note: 'no decision' } },
    ],
    highlight: { kind: 'deferral', at: Date.now(), slotId: 'slot_2', continuityId: 'cid_b', message: 'deferred to the next candidate' },
  });

  const BoardClient = (await import('../app/board/board-client')).default;
  const screen = await render(BoardClient, { initial: null });

  try {
    await screen.waitFor((s) => s.text().includes('Tokyo Night'), 'the event to render');
    const text = screen.text();
    assert.ok(text.includes('1234') || text.includes('aaaa1111'), 'queue entries should be listed');
    assert.ok(/ALLOCATED|awaiting human/i.test(screen.html()), 'slot states should be visible');
    assert.ok(
      /deferred to the next candidate/.test(text),
      'the headline event — a deferral — must reach the board',
    );
    assert.ok(/2\s*\/\s*2/.test(text), 'the inbound counter should show 2/2');
  } finally {
    await screen.unmount();
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  Journey E — the demo control panel
// ════════════════════════════════════════════════════════════════════════════

test('journey · every demo control is reachable and reports back', async () => {
  resetNetwork();
  stub('/api/health', HEALTH);
  stub('/api/dev/reset', { ok: true, reset: true, eventId: 'evt_test' });
  stub('/api/dev/prime', { ok: true, eventId: 'evt_test', joined: 6, allocated: 0 });
  stub('/api/dev/fast-forward', { ok: true, eventId: 'evt_test', drew: true, deferrals: 2 });
  stub('/api/dev/policy', { ok: true, event: { id: 'evt_test', policy: 'locked' } });

  const AdminPage = (await import('../app/admin/page')).default;
  const screen = await render(AdminPage);

  try {
    await screen.waitFor((s) => s.buttons().includes('Reset demo state'), 'the controls to render');

    const expected = [
      'Reset demo state',
      'Prime: 6 attendees join',
      'Fast-forward windows',
      'Run the comparison (24 bots vs 24 humans)',
      'Build 40 accounts → 2 humans',
      'Run the laundering simulation',
      'Run all three',
    ];
    for (const label of expected) {
      assert.ok(
        screen.buttons().includes(label),
        `missing control "${label}". Got: ${JSON.stringify(screen.buttons())}`,
      );
    }

    // Press the ones whose endpoints are stubbed and confirm each reports back.
    await screen.click('Reset demo state');
    await screen.click('Prime: 6 attendees join');
    await screen.click('Fast-forward windows');

    assert.ok(
      calls.some((c) => c.path === '/api/dev/reset') &&
        calls.some((c) => c.path === '/api/dev/prime') &&
        calls.some((c) => c.path === '/api/dev/fast-forward'),
      `each control must call its endpoint; got ${JSON.stringify(calls.map((c) => c.path))}`,
    );
    assert.ok(
      screen.text().includes('✓') || screen.text().includes('primed'),
      'the panel log should acknowledge what happened',
    );
  } finally {
    await screen.unmount();
  }
});

test('journey · the policy knobs are all present and one is sent', async () => {
  resetNetwork();
  stub('/api/health', HEALTH);
  stub('/api/dev/policy', { ok: true, event: { id: 'evt_test', policy: 'locked' } });

  const AdminPage = (await import('../app/admin/page')).default;
  const screen = await render(AdminPage);

  try {
    await screen.waitFor((s) => s.buttons().includes('locked'), 'the policy knobs');
    for (const label of ['locked', 'gift', 'open']) {
      assert.ok(screen.buttons().includes(label), `missing policy knob "${label}"`);
    }
    for (const label of ['lottery', 'fcfs']) {
      assert.ok(screen.buttons().includes(label), `missing mode knob "${label}"`);
    }

    await screen.click('locked');
    const policyCall = calls.find((c) => c.path === '/api/dev/policy');
    assert.ok(policyCall, 'pressing a policy knob must call the policy endpoint');
    assert.deepEqual(policyCall.body, { policy: 'locked' });
  } finally {
    await screen.unmount();
  }
});

test('journey · the dev-routes banner warns when the bypass is on', async () => {
  resetNetwork();
  stub('/api/health', HEALTH);

  const AdminPage = (await import('../app/admin/page')).default;
  const screen = await render(AdminPage);
  try {
    await screen.waitFor((s) => s.buttons().includes('Reset demo state'), 'the panel');
    // The page must disclose the bypass rather than quietly using it.
    assert.ok(
      /disclosed|bypass|simulat/i.test(screen.text()),
      'the control panel must say out loud that these are simulated identities',
    );
  } finally {
    await screen.unmount();
  }
});

test('journey · the admin panel refuses to pretend when dev routes are off', async () => {
  resetNetwork();
  stub('/api/health', { ...HEALTH, devRoutes: false });

  const AdminPage = (await import('../app/admin/page')).default;
  const screen = await render(AdminPage);
  try {
    await screen.waitFor(
      (s) => s.text().includes('ENABLE_DEV_ROUTES'),
      'the warning to explain why nothing will work',
    );
    const reset = [...screen.container.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('Reset demo state'),
    ) as HTMLButtonElement;
    assert.equal(reset.disabled, true, 'the controls must be disabled, not silently broken');
  } finally {
    await screen.unmount();
  }
});

test('teardown', () => {
  teardown();
});
