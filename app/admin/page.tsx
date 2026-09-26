'use client';

/**
 * ============================================================================
 *  Demo control panel
 * ============================================================================
 *
 * Every one of the six demo beats is a button here, because a live demo should
 * never depend on someone remembering a curl command. The buttons are grouped in
 * the order the beats are performed, and each one narrates what it proved
 * afterwards rather than just turning green.
 *
 * The two dangerous things on this page are labelled as such:
 *   · the impersonation / army controls, which are a disclosed bypass
 *   · the "claim with no approval" probe, which is meant to fail
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Badge,
  Button,
  Card,
  Notice,
  Refusal,
  call,
  usePoll,
  type ReasonBody,
} from '../_components/ui';

interface Health {
  idp: { mode: string; degraded: boolean; issuer: string };
  devRoutes: boolean;
  urls: { publicBaseUrl: string; redirectUri: string; consistent: boolean; problem: string | null };
  event: {
    id: string;
    name: string;
    lotteryMode: string;
    lotteryDrawn: boolean;
    windows: { lotterySec: number; approvalSec: number };
  } | null;
}

interface ArmyMember {
  accountIndex: number;
  handle: string;
  continuityId: string;
}

interface AttackOutcome {
  attack: string;
  title: string;
  blocked: boolean;
  code: string;
  message: string;
  invariant: string;
  narrative: string;
  verification: { protectedActionHappened: boolean; detail: string };
}

export default function AdminPage() {
  const health = usePoll<Health & { ok: true }>('/api/health', 3000);
  const [error, setError] = useState<ReasonBody | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<string[]>([]);
  const [army, setArmy] = useState<{ accounts: ArmyMember[]; humans: { continuityId: string; accounts: number }[]; collapseRatio: string } | null>(null);
  const [attacks, setAttacks] = useState<AttackOutcome[]>([]);
  const [contrast, setContrast] = useState<{ verdict: string } | null>(null);
  const [agentRequest, setAgentRequest] = useState('Get me a ticket for tonight. Ask me when you need me.');
  /**
   * Who the agent acts for.
   *
   * Not a text field. The consent step sends a real person to the real provider,
   * and they come back having proved *their own* identity — so an agent pointed at
   * anyone else produces an approval the gate refuses. The signed-in human is the
   * only value that can work.
   */
  const me = usePoll<{ ok: true; continuityId: string; subject?: string }>('/api/auth/me', 5000);
  const actingFor = me.data?.continuityId ?? null;
  const [agentSession, setAgentSession] = useState<{
    id: string;
    state: string;
    request_text: string;
    handle: string;
    error: string | null;
    steps: { at: number; kind: string; label: string; detail?: string; ok?: boolean }[];
  } | null>(null);

  const [armyQueue, setArmyQueue] = useState<{
    accounts: number;
    humans: number;
    joined: number;
    refused: number;
    headline: string;
  } | null>(null);

  const devRoutes = health.data?.devRoutes ?? false;

  /**
   * Are we being *browsed* at the origin we *generate links for*?
   *
   * Those are different questions, and conflating them has caused three bugs in
   * this project: a public base URL on http against a registered https redirect;
   * dev routes calling themselves on the configured origin; and the MCP agent
   * spawn dialling an origin nothing was listening on. Each time the symptom
   * looked like a network fault.
   *
   * The server cannot detect this on its own — it has no idea which address the
   * browser used — so the browser reports it.
   */
  const [browsingOrigin, setBrowsingOrigin] = useState<string | null>(null);
  useEffect(() => setBrowsingOrigin(window.location.origin), []);
  const configured = health.data?.urls?.publicBaseUrl ?? null;
  const originMismatch =
    browsingOrigin && configured && browsingOrigin !== configured
      ? { browsing: browsingOrigin, configured }
      : null;

  // Poll the agent run once it exists. Bounded by the run itself, which ends in
  // a terminal state.
  useEffect(() => {
    if (!agentSession || ['done', 'failed', 'cancelled'].includes(agentSession.state)) return;
    const timer = setInterval(async () => {
      try {
        const next = await call<{
          ok: true;
          id: string;
          state: string;
          request_text: string;
          handle: string;
          error: string | null;
          steps: { at: number; kind: string; label: string; detail?: string; ok?: boolean }[];
        }>(`/api/dev/agent/${agentSession.id}`);
        setAgentSession(next);
      } catch {
        /* transient */
      }
    }, 900);
    return () => clearInterval(timer);
  }, [agentSession]);

  function log(line: string) {
    setOutput((prev) => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 80));
  }

  async function run<T>(label: string, fn: () => Promise<T>, onDone?: (result: T) => void) {
    setBusy(label);
    setError(null);
    try {
      const result = await fn();
      onDone?.(result);
      log(`${label} ✓`);
    } catch (err) {
      const body = (err as { body?: ReasonBody }).body ?? { ok: false, code: 'internal_error', message: String(err) };
      setError(body);
      log(`${label} ✗ ${body.code}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto max-w-6xl p-6">
      <header className="flex flex-wrap items-center justify-between gap-3 pb-4">
        <div>
          <h1 className="text-3xl font-black tracking-tight">Demo controls</h1>
          <p className="text-sm text-[var(--color-muted)]">
            Six beats, in order. Nothing here is required for the system to work.
          </p>
        </div>
        <nav className="flex gap-3 text-sm">
          <Link href="/" className="underline">console</Link>
          <Link href="/board" className="underline">board</Link>
          <Link href="/api/health" className="underline">health</Link>
        </nav>
      </header>

      {!devRoutes && (
        <Notice tone="alert">
          <strong>ENABLE_DEV_ROUTES is off.</strong> Every button below will return 404 — which is
          exactly what the acceptance criteria require. Start the server with{' '}
          <code className="mono">ENABLE_DEV_ROUTES=1 npm run dev</code> to use them.
        </Notice>
      )}

      {error && <div className="mt-3"><Refusal error={error} onDismiss={() => setError(null)} /></div>}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* ── Setup ─────────────────────────────────────────────────── */}
        <Card title="setup">
          <div className="flex flex-wrap gap-2">
            <Button
              tone="warn"
              disabled={busy !== null || !devRoutes}
              onClick={() => run('reset', () => call('/api/dev/reset', { json: {} }), () => { setAttacks([]); setContrast(null); })}
            >
              Reset demo state
            </Button>
            <Button
              disabled={busy !== null || !devRoutes}
              onClick={() =>
                run('prime', () => call<{ joined: number }>('/api/dev/prime', { json: { humans: 6 } }), (r) =>
                  log(`primed: ${r.joined} simulated attendees joined`),
                )
              }
            >
              Prime: 6 attendees join
            </Button>
            {/*
              ── One button, whichever countdown is running ──────────────
              `deferAllocations: true` is what makes this cover the *approval*
              window and not only the draw. It is the only way to end a human
              authorization countdown on demand, and the runbook needs one: a
              deferral is a beat, and a beat that requires standing still for
              ninety seconds is not a beat.

              Both halves travel together here, which is the opposite of the
              default (`deferAllocations: false`) because the intent is opposite
              too. Pressed while the draw is open, it settles it and then expires
              every window that settling just created, so deferrals fire at once.
              Pressed while a human is being asked to authorize, it ends that
              countdown and the slot moves on — which is exactly what "the human
              did not answer" looks like.

              What it must not do is what it used to: settle a draw and destroy
              the allocation in the same breath when the operator only meant to
              skip the wait. Hence the flag, and hence it being explicit.
            */}
            <Button
              disabled={busy !== null || !devRoutes}
              onClick={() =>
                run(
                  'fast-forward',
                  () =>
                    call<{ drew: boolean; deferrals: number }>('/api/dev/fast-forward', {
                      json: { deferAllocations: true },
                    }),
                  (r) =>
                    log(
                      r.drew
                        ? `draw settled and every window collapsed — ${r.deferrals} deferral(s)`
                        : `every live window collapsed — ${r.deferrals} deferral(s)`,
                    ),
                )
              }
              title="End whatever is counting down: settles an open draw, then expires every approval window so deferrals fire at once"
            >
              Fast-forward windows
            </Button>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-[var(--color-muted)]">
            <div>idp<br /><span className="text-[var(--color-text)]">{health.data?.idp?.mode}</span></div>
            <div>mode<br /><span className="text-[var(--color-text)]">{health.data?.event?.lotteryMode ?? '—'}</span></div>
          </div>
        </Card>

        {/* ── The MCP agent ─────────────────────────────────────────── */}
        <Card title="the agent buys a ticket · MCP" className="lg:col-span-2">
          <p className="mb-3 text-xs text-[var(--color-muted)]">
            A human tells their agent to go and buy a ticket. The agent is a{' '}
            <strong>real MCP client</strong>: it spawns <code className="mono">mcp/server.ts</code> over
            stdio and drives the three tools, so what appears below is an actual JSON-RPC transcript
            rather than a re-enactment. It stops exactly once — to ask the human — and the board files
            every step it takes under <span className="text-[var(--color-brand)]">agent</span>.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <input
              value={agentRequest}
              onChange={(e) => setAgentRequest(e.target.value)}
              placeholder="what the human says to the agent"
              className="mono min-w-[22rem] flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] px-3 py-2 text-xs outline-none focus:border-[var(--color-brand)]"
            />
            <Button
              tone="brand"
              disabled={busy !== null || !devRoutes || !actingFor || (agentSession !== null && !['done', 'failed', 'cancelled'].includes(agentSession.state))}
              onClick={() =>
                run(
                  'agent',
                  () =>
                    call<{ sessionId: string; continuityId: string; handle: string; request: string }>(
                      '/api/dev/agent',
                      { json: { request: agentRequest } },
                    ),
                  (r) => {
                    setAgentSession({
                      id: r.sessionId,
                      state: 'starting',
                      request_text: r.request,
                      handle: r.handle,
                      error: null,
                      steps: [],
                    });
                    log(`agent session ${r.sessionId} started`);
                  },
                )
              }
            >
              Tell the agent to buy a ticket
            </Button>
            {agentSession && ['done', 'failed', 'cancelled'].includes(agentSession.state) && (
              <Button onClick={() => setAgentSession(null)}>clear</Button>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
            <span>acting for</span>
            {actingFor ? (
              <>
                <span className="mono rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] px-2 py-1 text-[var(--color-live)]">
                  you · {actingFor.slice(0, 16)}…
                </span>
                <span>· the agent asks for a fresh World ID proof, and only that step needs a person</span>
              </>
            ) : (
              <>
                <a href="/api/auth/world/start" className="underline text-[var(--color-alert)]">
                  sign in with World ID first
                </a>
                <span>
                  · the agent has to act for the human who can answer the consent prompt. Anyone
                  else, and the gate refuses the approval it produces — correctly.
                </span>
              </>
            )}
          </div>

          {agentSession && (
            <div className="mt-3">
              <div className="flex items-center gap-2">
                <Badge tone={agentSession.state === 'done' ? 'live' : agentSession.state === 'failed' ? 'alert' : 'warn'}>
                  {agentSession.state}
                </Badge>
                <span className="mono text-xs text-[var(--color-muted)]">{agentSession.id}</span>
              </div>

              <ol className="mt-3 space-y-1">
                {agentSession.steps.map((s, i) => (
                  <li
                    key={i}
                    className={`rounded-md border px-2 py-1 text-xs ${
                      s.kind === 'error'
                        ? 'border-[color-mix(in_srgb,var(--color-alert)_40%,transparent)] text-[var(--color-alert)]'
                        : s.kind === 'mcp'
                          ? 'border-[color-mix(in_srgb,var(--color-brand)_40%,transparent)] text-[var(--color-brand)]'
                          : s.kind === 'human'
                            ? 'border-[color-mix(in_srgb,var(--color-live)_40%,transparent)] text-[var(--color-live)]'
                            : 'border-[var(--color-line)] text-[var(--color-muted)]'
                    }`}
                  >
                    <span className="font-bold tracking-wide uppercase">
                      {s.kind === 'mcp' ? 'MCP' : s.kind}
                    </span>{' '}
                    <span className="mono">{s.label}</span>
                    {s.detail && (
                      <span className="ml-1 opacity-80">
                        {s.detail.startsWith('http') ? (
                          <a className="underline" href={s.detail} target="_blank" rel="noreferrer">
                            {s.detail}
                          </a>
                        ) : (
                          `— ${s.detail}`
                        )}
                      </span>
                    )}
                  </li>
                ))}
                {agentSession.steps.length === 0 && (
                  <li className="text-xs text-[var(--color-muted)]">connecting…</li>
                )}
              </ol>

              {agentSession.error && (
                <p className="mt-2 text-xs text-[var(--color-alert)]">{agentSession.error}</p>
              )}
            </div>
          )}
        </Card>

        {/* ── Origin warning ────────────────────────────────────────── */}
        {originMismatch && (
          <Card title="⚠ the links this server generates point somewhere else" className="lg:col-span-2">
            <p className="text-xs">
              You are browsing <code className="mono text-[var(--color-text)]">{originMismatch.browsing}</code>,
              but this server builds links against{' '}
              <code className="mono text-[var(--color-text)]">{originMismatch.configured}</code>.
            </p>
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              Consent links in the agent transcript and the sign-in flow will open the second one. They
              are correct for a real deployment — the portal registered that origin — but they will not
              work while you are on this one.
            </p>
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              This has caused three separate bugs in this project, always the same shape: the URL that
              goes in a link a human opens, and the URL for reaching yourself, are not the same URL.
            </p>
          </Card>
        )}

        {/* ── Beat 1 ────────────────────────────────────────────────── */}
        <Card title="beat 1 · speed contrast">
          <p className="mb-3 text-xs text-[var(--color-muted)]">
            The same bot script, twice: once under first-come-first-served, once under the draw.
            Under FCFS the bots take everything; under the draw their share collapses to their share
            of the entrant pool.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              tone="brand"
              disabled={busy !== null || !devRoutes}
              onClick={() =>
                run(
                  'speed contrast',
                  () =>
                    call<{ verdict: string }>('/api/dev/bots', {
                      json: { mode: 'compare', accounts: 24, humans: 24 },
                    }),
                  (r) => { setContrast(r); log(r.verdict); },
                )
              }
            >
              Run the comparison (24 bots vs 24 humans)
            </Button>
          </div>
          {contrast && <Notice tone="brand">{contrast.verdict}</Notice>}
        </Card>

        {/* ── Beat 4 ────────────────────────────────────────────────── */}
        <Card title="beat 4 · 40 accounts, 2 humans" className="lg:col-span-2">
          <p className="mb-3 text-xs text-[var(--color-muted)]">
            Slots are locked, so circulation is not the attack surface any more — the queue is.
            Build forty signups, point them at one event, and watch them collapse onto two
            continuity ids. The second account for the same human does not get a second place in
            line, because the constraint is on the human and not on the account.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy !== null || !devRoutes}
                  onClick={() =>
                    run(
                      'build army',
                      () =>
                        call<{
                          accounts: ArmyMember[];
                          humans: { continuityId: string; accounts: number }[];
                          collapseRatio: string;
                        }>('/api/dev/army', { json: { accounts: 40, humans: 2 } }),
                      (r) => {
                        setArmy(r);
                        log(r.collapseRatio);
                      },
                    )
                  }
                >
                  Build 40 accounts → 2 humans
                </Button>
                <Button
                  tone="alert"
                  disabled={busy !== null || !devRoutes}
                  onClick={() =>
                    run(
                      'army queues',
                      () => call<{ accounts: number; humans: number; joined: number; refused: number; headline: string }>(
                        '/api/dev/army/queue',
                        { json: { accounts: 40, humans: 2 } },
                      ),
                      (r) => {
                        setArmyQueue(r);
                        log(r.headline);
                      },
                    )
                  }
                >
                  Have all 40 join the queue
                </Button>
              </div>

              {army && (
                <div className="mt-3">
                  <div className="text-lg font-bold text-[var(--color-violet)]">{army.collapseRatio}</div>
                  <ul className="mt-1 space-y-0.5 text-xs text-[var(--color-muted)]">
                    {army.humans.map((h) => (
                      <li key={h.continuityId} className="mono">
                        {h.continuityId.slice(0, 24)}… ← {h.accounts} accounts
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div>
              {armyQueue && (
                <>
                  <div className="text-lg font-bold">{armyQueue.headline}</div>
                  <ul className="mono mt-2 space-y-0.5 text-xs">
                    <li className="text-[var(--color-live)]">
                      {armyQueue.accounts} accounts attempted to join
                    </li>
                    <li className="text-[var(--color-live)]">
                      {armyQueue.joined} queue entries were created
                    </li>
                    <li className="text-[var(--color-alert)]">
                      {armyQueue.refused} refused as already in the queue
                    </li>
                  </ul>
                </>
              )}
            </div>
          </div>
        </Card>

        {/* ── Beat 6 ────────────────────────────────────────────────── */}
        <Card title="beat 6 · three attacks" className="lg:col-span-2">
          <p className="mb-3 text-xs text-[var(--color-muted)]">
            Replay, parameter tampering, and an environment swap. Each is refused with a structured
            reason, and each ends by reading the database back to confirm the protected action did
            not happen.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              tone="alert"
              disabled={busy !== null || !devRoutes}
              onClick={() =>
                run(
                  'attacks',
                  () => call<{ attacks: AttackOutcome[] }>('/api/dev/attack', { json: { attack: 'all' } }),
                  (r) => setAttacks(r.attacks),
                )
              }
            >
              Run all three
            </Button>
            {(['replay', 'parameter_tamper', 'environment_swap'] as const).map((which) => (
              <Button
                key={which}
                disabled={busy !== null || !devRoutes}
                onClick={() =>
                  run(
                    which,
                    () => call<{ attacks: AttackOutcome[] }>('/api/dev/attack', { json: { attack: which } }),
                    (r) => setAttacks((prev) => [...r.attacks, ...prev.filter((p) => p.attack !== which)]),
                  )
                }
              >
                {which.replace('_', ' ')}
              </Button>
            ))}
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {attacks.map((a) => (
              <div
                key={a.attack}
                className={`rounded-lg border p-3 text-sm ${
                  a.blocked
                    ? 'border-[color-mix(in_srgb,var(--color-live)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-live)_8%,transparent)]'
                    : 'border-[color-mix(in_srgb,var(--color-alert)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-alert)_10%,transparent)]'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <strong>{a.title}</strong>
                  <Badge tone={a.blocked ? 'live' : 'alert'}>{a.blocked ? 'BLOCKED' : 'LEAKED'}</Badge>
                </div>
                <code className="mono mt-1 block text-xs text-[var(--color-alert)]">{a.code}</code>
                <p className="mt-2 text-xs text-[var(--color-muted)]">{a.narrative}</p>
                <p className="mt-2 text-xs">{a.message}</p>
                <p className="mt-2 text-xs text-[var(--color-warn)]">{a.invariant}</p>
                <p className="mt-2 text-xs">
                  protected action executed:{' '}
                  <strong className={a.verification.protectedActionHappened ? 'text-[var(--color-alert)]' : 'text-[var(--color-live)]'}>
                    {String(a.verification.protectedActionHappened)}
                  </strong>
                  <br />
                  <span className="text-[var(--color-muted)]">{a.verification.detail}</span>
                </p>
              </div>
            ))}
          </div>
        </Card>

        {/* ── Policy knobs ──────────────────────────────────────────── */}
        <Card title="speed mode (T-6.3)">
          <div className="flex flex-wrap gap-2">
            {(['lottery', 'fcfs'] as const).map((mode) => (
              <Button
                key={mode}
                disabled={busy !== null || !devRoutes}
                onClick={() => run(`mode=${mode}`, () => call('/api/dev/policy', { json: { lotteryMode: mode } }))}
              >
                {mode}
              </Button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              disabled={busy !== null || !devRoutes}
              onClick={() => run('windows', () => call('/api/dev/policy', { json: { approval_window_sec: 20, lottery_window_sec: 10 } }))}
            >
              short windows for the stage
            </Button>
            <Button
              disabled={busy !== null || !devRoutes}
              onClick={() => run('windows', () => call('/api/dev/policy', { json: { approval_window_sec: 90, lottery_window_sec: 15 } }))}
            >
              seeded defaults
            </Button>
          </div>
          <p className="mt-3 text-xs text-[var(--color-muted)]">
            Slots are locked — there is no transfer policy to switch. These two modes exist to show
            why the draw matters: run the comparison above and watch FCFS hand the event to the bot
            army while the draw does not.
          </p>
        </Card>

        {/* ── Output ────────────────────────────────────────────────── */}
        <Card title="panel log" className="lg:col-span-2">
          <ul className="mono max-h-60 space-y-0.5 overflow-y-auto text-xs text-[var(--color-muted)]">
            {output.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
            {output.length === 0 && <li>nothing yet</li>}
          </ul>
        </Card>
      </div>

      <p className="mt-6 text-xs text-[var(--color-muted)]">
        ⚠️ Everything on this page is behind <code className="mono">ENABLE_DEV_ROUTES=1</code> and is
        a disclosed demo prop. Simulated humans are created directly in the database and never pass
        World ID verification. The authorization checks they go through are the real ones.
      </p>
    </main>
  );
}
