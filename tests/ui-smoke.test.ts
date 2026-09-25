/**
 * Client-render smoke tests.
 *
 * ============================================================================
 *  Why this file exists
 * ============================================================================
 *
 * The rest of the suite verifies the *server*: it curls endpoints, renders
 * server components, and asserts on JSON. None of that executes a client
 * component's effects, so none of it catches a page that renders fine in SSR and
 * then throws on the first poll.
 *
 * That is exactly the bug this file was written for. The console polled
 * `/api/health` into a variable typed as the queue-status payload, so on the
 * first tick — for every visitor who was not signed in — it read
 * `status.data.inbound.used` off a health response and crashed. `curl /`
 * returned 200 the whole time; the page was still unusable.
 *
 * So: render the real components into jsdom, drive their polls with stubbed
 * responses, and assert they survive. Slow-ish and unglamorous, and the only
 * thing here that would have caught it.
 */
import './setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ── A DOM, installed before any component module is evaluated ───────────────

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:3000/',
  pretendToBeVisual: true,
});

const g = globalThis as unknown as Record<string, unknown>;

/**
 * Node exposes some of these as getter-only globals (`navigator` since v21), so
 * plain assignment throws. Define them explicitly instead.
 */
function install(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

install('window', dom.window);
install('document', dom.window.document);
install('navigator', dom.window.navigator);
install('HTMLElement', dom.window.HTMLElement);
install('Node', dom.window.Node);
install('Event', dom.window.Event);
install('CustomEvent', dom.window.CustomEvent);
install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
// Next's client runtime reaches for `self` (request-idle-callback, among others).
install('self', dom.window);
install('requestAnimationFrame', (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0) as unknown as number,
);
install('cancelAnimationFrame', (id: number) => clearTimeout(id));
// React 19 asks for this during act(); jsdom does not implement it.
install('IS_REACT_ACT_ENVIRONMENT', true);

// ── Stub transport ──────────────────────────────────────────────────────────

type Route = { status?: number; body: unknown };

const routes = new Map<string, Route>();
const requested: string[] = [];

const realFetch = globalThis.fetch;

install('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const path = new URL(url, 'http://localhost:3000').pathname;
  requested.push(`${init?.method ?? 'GET'} ${path}`);

  // Anything not stubbed is a bug in the test, not a silent 404.
  const route = routes.get(path);
  if (!route) {
    return new Response(JSON.stringify({ ok: false, code: 'not_stubbed', message: path }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify(route.body), {
    status: route.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
});

function stub(path: string, body: unknown, status = 200): void {
  routes.set(path, { body, status });
}

// ── Fixtures: the exact payloads the two endpoints really return ────────────

/** Shape of `GET /api/health`. Notably: no `queue`, no `inbound`, no `grants`. */
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
  devRoutes: true,
  event: { id: 'evt_test', name: 'Test', policy: 'gift', lotteryMode: 'lottery', lotteryDrawn: false, windows: {} },
};

/** Shape of `GET /api/queue/status` for a signed-in human. */
const STATUS = {
  ok: true,
  serverNow: Date.now(),
  continuityId: 'cid_abc123',
  event: { id: 'evt_test', name: 'Test', policy: 'gift', lotteryMode: 'lottery', lotteryDrawn: false, lotteryClosesAt: null },
  queue: { entryId: 'q_1', joined: true, arrivalSeq: 1, lotteryRank: 1, allocatedAt: null, stats: {}, total: 1 },
  allocation: [],
  holding: [],
  vip: false,
  grants: [],
  inbound: { used: 0, cap: 2 },
  slots: { total: 8, available: 8, allocated: 0, confirmed: 0, transfers: 0 },
  recentTransitions: [],
};

// ── Harness ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Collects anything React logs as an error, so a caught-by-boundary throw still fails the test. */
function captureConsoleErrors(): { errors: string[]; restore: () => void } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  return { errors, restore: () => (console.error = original) };
}

async function render(path: string, Component: React.ComponentType<never>) {
  const { createRoot } = await import('react-dom/client');
  const React = await import('react');

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);

  const captured = captureConsoleErrors();
  const root = createRoot(container);

  let thrown: Error | null = null;
  try {
    await React.act(async () => {
      root.render(React.createElement(Component));
    });
    // Let the first poll land — this is the tick that used to crash the console.
    await React.act(async () => {
      await sleep(120);
    });
  } catch (err) {
    thrown = err as Error;
  }

  captured.restore();
  const html = container.innerHTML;
  await React.act(async () => {
    root.unmount();
  });
  container.remove();

  return { html, thrown, consoleErrors: captured.errors, requested: [...requested] };
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('console renders for a signed-out visitor without throwing', async () => {
  requested.length = 0;
  stub('/api/health', HEALTH);
  // `/api/auth/me` 401s when there is no session. This is the path that decides
  // `signedIn === false`, and the path that used to poison `status.data`.
  stub('/api/auth/me', { ok: false, code: 'not_authenticated', message: 'sign in' }, 401);

  const ConsolePage = (await import('../app/page')).default;
  const result = await render('/', ConsolePage as never);

  assert.equal(result.thrown, null, `the console threw: ${result.thrown?.message}`);
  assert.deepEqual(
    result.consoleErrors,
    [],
    `React reported errors: ${result.consoleErrors.join(' | ')}`,
  );
  // It must actually render the signed-out affordance, not just avoid crashing.
  assert.match(result.html, /Sign in with World ID/, 'the sign-in button should be offered');
});

test('console renders for a signed-in human and shows their queue state', async () => {
  requested.length = 0;
  stub('/api/health', HEALTH);
  stub('/api/auth/me', { ok: true, continuityId: 'cid_abc123', grants: [] });
  stub('/api/queue/status', STATUS);

  const ConsolePage = (await import('../app/page')).default;
  const result = await render('/', ConsolePage as never);

  assert.equal(result.thrown, null, `the console threw: ${result.thrown?.message}`);
  assert.deepEqual(result.consoleErrors, [], `React reported errors: ${result.consoleErrors.join(' | ')}`);
  // The status payload only reached the page if the queue numbers rendered.
  assert.match(result.html, /cid_abc123/, 'the continuity id should be shown once signed in');
  assert.match(result.html, /0 \/ 2/, 'the inbound counter should render from the status payload');
});

test('the board renders its first frame and survives its poll', async () => {
  requested.length = 0;
  stub('/api/board/state', {
    serverNow: Date.now(),
    event: {
      id: 'evt_test', name: 'Tokyo Night', policy: 'gift', lotteryMode: 'lottery', totalSlots: 8,
      approvalWindowSec: 90, lotteryWindowSec: 15, transferWindowSec: 120, transferInboundCap: 2,
      lotteryDrawnAt: null, lotterySeed: null, lotteryOpen: true, lotteryClosesAt: null,
    },
    idp: { mode: 'local', degraded: true, issuer: 'https://sandbox.auth.world.org' },
    queue: { total: 0, drawn: 0, allocated: 0, waiting: 0, entries: [] },
    slots: { total: 8, available: 8, allocated: 0, confirmed: 0, transferPending: 0, transferred: 0, deferrals: 0, items: [] },
    approvals: [],
    transfers: { total: 0, open: 0, completed: 0, expired: 0, rejectedAttempts: 0, items: [] },
    inbound: [],
    humans: { total: 0, distinctInQueue: 0 },
    drawVerification: { settled: false, matches: null, checked: 0, seed: null },
    security: { consumedProofs: 0, protectedActionsExecuted: 0, totalRefusals: 0, refusals: {} },
    audit: [],
    highlight: { kind: 'none', at: Date.now(), slotId: null, continuityId: null, message: '' },
  });

  const BoardClient = (await import('../app/board/board-client')).default;
  const result = await render('/', BoardClient as never);

  assert.equal(result.thrown, null, `the board threw: ${result.thrown?.message}`);
  assert.deepEqual(result.consoleErrors, [], `React reported errors: ${result.consoleErrors.join(' | ')}`);
  assert.match(result.html, /Tokyo Night/, 'the board should show the event it is polling');
});

test('teardown', () => {
  // Restore the real fetch so any later test file is unaffected.
  install('fetch', realFetch);
  dom.window.close();
});
