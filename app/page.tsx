'use client';

/**
 * The participant console.
 *
 * One screen covers the whole human side of the flow: sign in, join the queue,
 * wait, be asked to authorize, approve or deny, and hand the slot on. It calls
 * exactly the same endpoints the standalone agent does — there is no privileged
 * path for the browser, which is what makes the agent's behaviour on stage
 * believable.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Badge,
  Button,
  Card,
  DegradedBanner,
  Notice,
  Refusal,
  call,
  formatSeconds,
  relative,
  usePoll,
  type ReasonBody,
} from './_components/ui';

interface Status {
  serverNow: number;
  continuityId: string;
  event: {
    id: string;
    name: string;
    policy: string;
    lotteryMode: string;
    lotteryDrawn: boolean;
    lotteryClosesAt: number | null;
  };
  queue: {
    entryId: string | null;
    joined: boolean;
    arrivalSeq: number | null;
    lotteryRank: number | null;
    allocatedAt: number | null;
    stats: { total: number; drawn: number; allocated: number; waiting: number };
    total: number;
  };
  allocation: { slotId: string; deadline: number; remainingMs: number; deferralCount: number }[];
  holding: { slotId: string; state: string; acquiredVia: string | null }[];
  vip: boolean;
  grants: { id: string; scope: string; expiresAt: number | null }[];
  inbound: { used: number; cap: number };
  slots: { total: number; available: number; allocated: number; confirmed: number; transfers: number };
  recentTransitions: { kind: string; slotId: string; message: string; at: number }[];
}

interface ApprovalView {
  approvalId: string;
  kind: string;
  state: string;
  stage: string;
  boundAction: string;
  boundSignal: string;
  slotId: string | null;
  failReason: string | null;
  remainingMs: number;
  stages: { key: string; label: string; at: number | null }[];
}

interface Health {
  idp: { mode: string; degraded: boolean; issuer: string; hasCredentials: boolean };
  devRoutes: boolean;
  event: { id: string; name: string; policy: string; lotteryMode: string } | null;
}

export default function ConsolePage() {
  const health = usePoll<Health & { ok: true }>('/api/health', 5000);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [error, setError] = useState<ReasonBody | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [approval, setApproval] = useState<ApprovalView | null>(null);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [linkRequestId, setLinkRequestId] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<{ userCode: string; verificationUriComplete: string } | null>(null);
  const [meta, setMeta] = useState<{ action: string; signal: string } | null>(null);
  const [transferLink, setTransferLink] = useState<string | null>(null);

  // `null` while we are still deciding, and while signed out. This variable must
  // only ever hold a queue-status payload: treating a health response as one is
  // what crashed the console for every signed-out visitor.
  const status = usePoll<Status & { ok: true }>(
    signedIn === true ? '/api/queue/status' : null,
    1000,
  );

  const note = useCallback((line: string) => {
    setLog((prev) => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 40));
  }, []);

  // Establish whether a session exists before showing queue state.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await call('/api/auth/me');
        if (!cancelled) setSignedIn(true);
      } catch {
        if (!cancelled) setSignedIn(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (signedIn === false) setLinkUrl(null);
  }, [signedIn]);

  // Poll the in-flight approval so the four stages animate as they happen.
  useEffect(() => {
    if (!approval) return;
    const timer = setInterval(async () => {
      try {
        const next = await call<ApprovalView & { ok: true }>(`/api/approval/${approval.approvalId}`);
        setApproval(next);
        if (next.stage !== approval.stage) note(`approval → ${next.stage}`);
      } catch {
        /* keep polling; a transient failure is not worth surfacing here */
      }
    }, 900);
    return () => clearInterval(timer);
  }, [approval, note]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      const body = (err as { body?: ReasonBody }).body ?? {
        ok: false,
        code: 'internal_error',
        message: String(err),
      };
      setError(body);
      note(`REFUSED ${body.code}`);
    } finally {
      setBusy(false);
    }
  }

  const startLink = () =>
    run('link', async () => {
      const res = await call<{
        ok: true;
        requestId: string;
        url?: string;
        deviceCode?: { userCode: string; verificationUri: string; verificationUriComplete: string };
        mode: string;
        degraded: boolean;
        note: string;
      }>('/api/auth/world/start', { json: { intent: 'link' } });

      setLinkRequestId(res.requestId);
      setDeviceCode(null);
      note(`link started (${res.mode})`);
      if (res.url) {
        setLinkUrl(res.url);
        note('open the authorization URL to continue');
      }
      if (res.deviceCode) {
        setDeviceCode(res.deviceCode);
        note(`device code: ${res.deviceCode.userCode}`);
      }
      // For the local fallback and OIDC, jumping straight across is the least
      // error-prone thing on stage.
      if (res.url && res.mode !== 'device') window.location.href = res.url;
    });

  const pollLink = () =>
    run('check', async () => {
      if (!linkRequestId) return;
      await call('/api/auth/me');
      setSignedIn(true);
      note('session established');
      window.location.reload();
    });

  const join = () =>
    run('join', async () => {
      const res = await call<{ created: boolean; arrivalSeq: number }>('/api/queue/join', { json: {} });
      note(res.created ? `joined queue at arrival #${res.arrivalSeq}` : 'already in the queue');
    });

  const requestApproval = () =>
    run('request', async () => {
      const res = await call<{
        ok: true;
        approvalId: string;
        requestId: string;
        mode: string;
        degraded: boolean;
        url?: string;
        deviceCode?: { userCode: string; verificationUriComplete: string };
        boundAction: string;
        boundSignal: string;
        slotId: string;
        windowSec: number;
      }>('/api/slot/request', { json: {} });

      setMeta({ action: res.boundAction, signal: res.boundSignal });
      note(`approval requested for ${res.slotId} (${res.mode})`);
      setApproval({
        approvalId: res.approvalId,
        kind: 'purchase',
        state: 'PENDING',
        stage: 'requested',
        boundAction: res.boundAction,
        boundSignal: res.boundSignal,
        slotId: res.slotId,
        failReason: null,
        remainingMs: res.windowSec * 1000,
        stages: [],
      });

      if (res.deviceCode) {
        setDeviceCode(res.deviceCode);
        note(`device code: ${res.deviceCode.userCode}`);
      } else if (res.url) {
        window.location.href = res.url;
      }
    });

  const claim = () =>
    run('claim', async () => {
      if (!approval) throw new Error('no approval in flight');
      const res = await call<{ ok: true; slotId: string; nullifier: string }>('/api/slot/claim', {
        json: { approval: approval.approvalId },
      });
      note(`CONFIRMED ${res.slotId} — nullifier spent`);
      void status.refresh();
    });

  const claimWithoutApproval = () =>
    run('claim-without-approval', async () => {
      // The demo point: the call is well-formed, the caller is authenticated and
      // holds a slot, and it still fails, because tool inputs prove nothing.
      await call('/api/slot/claim', { json: {} });
    });

  const createTransfer = (slotId: string) =>
    run('transfer', async () => {
      const res = await call<{ ok: true; link: string }>('/api/transfer', { json: { slotId } });
      setTransferLink(res.link);
      note('transfer offer created — the window has NOT started yet');
    });

  const deny = () =>
    run('deny', async () => {
      if (!approval) return;
      await call('/api/auth/deny', { json: { requestId: approval.approvalId } }).catch(async () => {
        await call(`/api/approval/${approval.approvalId}`, { json: { reason: 'denied by the human' } });
      });
      note('denied — nothing will execute');
    });

  const remaining = useMemo(() => {
    if (!approval || !status.data) return null;
    const deadline = Date.now() + approval.remainingMs;
    return Math.max(0, deadline - Date.now());
  }, [approval, status.data]);

  const idpMode = health.data?.idp?.mode ?? 'oidc';

  return (
    <main className="mx-auto max-w-5xl p-6">
      <DegradedBanner mode={idpMode} />

      <header className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div>
          <h1 className="text-3xl font-black tracking-tight">PRESENCE</h1>
          <p className="text-sm text-[var(--color-muted)]">
            Your agent queues. When a slot arrives, a real human has to be there — or it moves on.
          </p>
        </div>
        <nav className="flex gap-3 text-sm">
          <Link href="/board" className="underline">
            board
          </Link>
          <Link href="/admin" className="underline">
            controls
          </Link>
          <Link href="/api/health" className="underline">
            health
          </Link>
        </nav>
      </header>

      {error && <Refusal error={error} onDismiss={() => setError(null)} />}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {/* ── Identity ─────────────────────────────────────────────── */}
        <Card title="1 · identity">
          {signedIn === null ? (
            <p className="text-sm text-[var(--color-muted)]">checking your session…</p>
          ) : signedIn === false ? (
            <>
              <p className="text-sm text-[var(--color-muted)]">
                {idpMode === 'local'
                  ? 'No World ID credentials are configured, so the local fallback will simulate the consent screen. The gate downstream is unchanged.'
                  : `Sign in against ${health.data?.idp?.issuer ?? 'the sandbox IdP'}. The browser only receives a URL; the server holds the secret.`}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button tone="brand" onClick={startLink} disabled={busy}>
                  Sign in with World ID
                </Button>
                {linkUrl && (
                  <Button onClick={() => (window.location.href = linkUrl)} disabled={busy}>
                    Open authorization URL
                  </Button>
                )}
                {linkRequestId && (
                  <Button onClick={pollLink} disabled={busy}>
                    I&apos;ve approved — continue
                  </Button>
                )}
              </div>
              {linkUrl && (
                <p className="mono mt-2 truncate text-[10px] text-[var(--color-muted)]">{linkUrl}</p>
              )}
            </>
          ) : (
            <div className="space-y-2 text-sm">
              <Row label="continuity id" value={status.data?.continuityId ?? '—'} mono />
              <Row label="vip" value={status.data?.vip ? 'yes' : 'no'} />
              <Row
                label="inbound received"
                value={`${status.data?.inbound?.used ?? 0} / ${status.data?.inbound?.cap ?? 0}`}
              />
              {status.data?.grants?.map((g) => (
                <Row key={g.id} label="grant" value={g.scope} />
              ))}
              <Button
                size="sm"
                onClick={() => run('logout', async () => {
                  await call('/api/auth/logout', { json: {} });
                  window.location.reload();
                })}
              >
                sign out
              </Button>
            </div>
          )}

          {deviceCode && (
            <Notice tone="warn">
              <strong>Device code</strong> — enter it on your own device:{' '}
              <span className="mono text-lg">{deviceCode.userCode}</span>
              <br />
              <a className="underline" href={deviceCode.verificationUriComplete} target="_blank" rel="noreferrer">
                {deviceCode.verificationUriComplete}
              </a>
            </Notice>
          )}
        </Card>

        {/* ── Queue ────────────────────────────────────────────────── */}
        <Card title="2 · queue">
          {signedIn === null ? (
            <p className="text-sm text-[var(--color-muted)]">checking your session…</p>
          ) : signedIn ? (
            <>
              <div className="grid grid-cols-3 gap-2 text-center">
                <Metric label="in queue" value={status.data?.queue?.total ?? 0} />
                <Metric label="your rank" value={status.data?.queue?.lotteryRank ?? '—'} />
                <Metric label="arrival #" value={status.data?.queue?.arrivalSeq ?? '—'} />
              </div>
              <p className="mt-3 text-xs text-[var(--color-muted)]">
                Rank comes from the draw, not from arrival. Arrival order is recorded only so the
                FCFS control mode has something to sort by.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {!status.data?.queue?.joined && (
                  <Button tone="live" onClick={join} disabled={busy}>
                    Join the queue
                  </Button>
                )}
                {status.data?.queue?.joined && !status.data?.queue?.lotteryRank && (
                  <Badge tone="warn">waiting for the draw</Badge>
                )}
                {status.data?.queue?.allocatedAt && <Badge tone="live">you were served</Badge>}
              </div>
            </>
          ) : (
            <p className="text-sm text-[var(--color-muted)]">Sign in first.</p>
          )}
        </Card>

        {/* ── Allocation / authorization ───────────────────────────── */}
        <Card title="3 · slot handover" className="md:col-span-2">
          {!status.data?.allocation?.length ? (
            <p className="text-sm text-[var(--color-muted)]">
              {status.data?.holding?.length
                ? 'You already hold a confirmed slot.'
                : 'No slot is allocated to you right now.'}
            </p>
          ) : (
            <div className="space-y-3">
              {status.data.allocation.map((a) => (
                <div
                  key={a.slotId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[color-mix(in_srgb,var(--color-live)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-live)_10%,transparent)] p-3"
                >
                  <div>
                    <div className="mono text-sm">{a.slotId}</div>
                    <div className="text-xs text-[var(--color-muted)]">
                      deferrals so far: {a.deferralCount}
                    </div>
                  </div>
                  <div className="tnum text-4xl font-black text-[var(--color-live)]">
                    {formatSeconds(a.remainingMs)}
                  </div>
                  <Button tone="live" onClick={requestApproval} disabled={busy}>
                    Ask me to authorize
                  </Button>
                </div>
              ))}
            </div>
          )}

          {approval && (
            <div className="mt-4 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge tone={approval.state === 'PENDING' ? 'warn' : approval.state === 'CONSUMED' ? 'brand' : 'live'}>
                    {approval.state}
                  </Badge>
                  <span className="mono text-xs">{approval.approvalId}</span>
                </div>
                {approval.state === 'PENDING' && remaining != null && (
                  <span className="tnum text-2xl font-bold">{formatSeconds(remaining)}</span>
                )}
              </div>

              <div className="mono mt-2 space-y-0.5 text-[11px] text-[var(--color-muted)]">
                <div>action {approval.boundAction}</div>
                <div>signal {approval.boundSignal}</div>
              </div>

              {approval.stages.length > 0 && (
                <ol className="mt-3 space-y-1 text-sm">
                  {approval.stages.map((s) => (
                    <li key={s.key} className="flex items-center gap-2">
                      <span
                        className={`h-2 w-2 rounded-full ${
                          s.at ? 'bg-[var(--color-live)]' : 'bg-[var(--color-line)]'
                        }`}
                      />
                      <span className={s.at ? 'text-[var(--color-text)]' : 'text-[var(--color-muted)]'}>
                        {s.label}
                      </span>
                      <span className="tnum ml-auto text-xs text-[var(--color-muted)]">
                        {s.at ? relative(s.at, status.data?.serverNow) : '—'}
                      </span>
                    </li>
                  ))}
                </ol>
              )}

              {meta && (
                <p className="mt-3 text-xs text-[var(--color-muted)]">
                  The runner prints <code className="mono">approvalId</code>; this console holds the
                  same value. Either can present it to the gate.
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <Button tone="brand" onClick={claim} disabled={busy || approval.state !== 'APPROVED'}>
                  Present approval to the gate
                </Button>
                <Button tone="alert" onClick={deny} disabled={busy || approval.state !== 'PENDING'}>
                  Deny
                </Button>
                <Button onClick={claimWithoutApproval} disabled={busy} title="Demonstrates the refusal">
                  Call claim with no approval
                </Button>
              </div>

              {approval.failReason && (
                <p className="mt-2 text-xs text-[var(--color-alert)]">{approval.failReason}</p>
              )}
            </div>
          )}
        </Card>

        {/* ── Held slots / transfer ─────────────────────────────────── */}
        <Card title="4 · held slots" className="md:col-span-2">
          {!status.data?.holding?.length ? (
            <p className="text-sm text-[var(--color-muted)]">Nothing confirmed yet.</p>
          ) : (
            <ul className="space-y-2">
              {status.data.holding.map((s) => (
                <li
                  key={s.slotId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-line)] p-3"
                >
                  <div>
                    <div className="mono text-sm">{s.slotId}</div>
                    <div className="text-xs text-[var(--color-muted)]">
                      {s.state} · acquired via {s.acquiredVia ?? '—'}
                    </div>
                  </div>
                  {s.state === 'CONFIRMED' && (
                    <Button tone="violet" onClick={() => createTransfer(s.slotId)} disabled={busy}>
                      Create a transfer link
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {transferLink && (
            <Notice tone="violet">
              <strong>Transfer link created.</strong> The window has not started — it begins when the
              recipient opens it (RED LINE 7). Send it, wait as long as you like, and it is still good.
              <div className="mono mt-2 truncate text-xs">{transferLink}</div>
              <a className="mt-2 inline-block underline" href={transferLink}>
                open it yourself to preview (does not start the window)
              </a>
            </Notice>
          )}
        </Card>
      </div>

      {/* ── Local event log ──────────────────────────────────────────── */}
      <Card title="what this browser saw" className="mt-4">
        <ul className="mono max-h-56 space-y-0.5 overflow-y-auto text-xs text-[var(--color-muted)]">
          {log.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
          {log.length === 0 && <li>nothing yet</li>}
        </ul>
      </Card>
    </main>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[var(--color-muted)]">{label}</span>
      <span className={`truncate ${mono ? 'mono text-xs' : ''}`}>{value}</span>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg bg-[var(--color-panel-2)] py-2">
      <div className="tnum text-3xl font-black">{value}</div>
      <div className="text-[10px] tracking-wide text-[var(--color-muted)] uppercase">{label}</div>
    </div>
  );
}
