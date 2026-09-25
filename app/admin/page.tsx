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
import { useState } from 'react';
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
  const [armyQueue, setArmyQueue] = useState<{
    accounts: number;
    humans: number;
    joined: number;
    refused: number;
    headline: string;
  } | null>(null);

  const devRoutes = health.data?.devRoutes ?? false;

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
            <Button
              disabled={busy !== null || !devRoutes}
              onClick={() => run('fast-forward', () => call('/api/dev/fast-forward', { json: {} }))}
              title="Settle the draw now and expire every live approval window"
            >
              Fast-forward windows
            </Button>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-[var(--color-muted)]">
            <div>idp<br /><span className="text-[var(--color-text)]">{health.data?.idp?.mode}</span></div>
            <div>mode<br /><span className="text-[var(--color-text)]">{health.data?.event?.lotteryMode ?? '—'}</span></div>
          </div>
        </Card>

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
