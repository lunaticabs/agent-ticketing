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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  useCountdown,
  usePoll,
  type ReasonBody,
} from './_components/ui';

interface OpenApproval {
  approvalId: string;
  state: 'PENDING' | 'APPROVED' | 'CONSUMED' | 'DENIED' | 'EXPIRED';
  stage: string;
  kind: string;
  boundAction: string;
  boundSignal: string;
  slotId: string | null;
  mode: string;
  consentUrl: string | null;
  requestedVia: 'human' | 'agent';
  requestedAt: number;
  completedAt: number | null;
  verifiedAt: number | null;
  executedAt: number | null;
  expiresAt: number;
  remainingMs: number;
}

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
  lottery: {
    mode: 'lottery' | 'fcfs';
    drawn: boolean;
    drawnAt: number | null;
    opensAt: number | null;
    closesAt: number | null;
    entrants: number;
    open: boolean;
    msToDraw: number | null;
  } | null;
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
  slots: { total: number; available: number; allocated: number; confirmed: number };
  openApprovals: OpenApproval[];
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
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [linkRequestId, setLinkRequestId] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<{ userCode: string; verificationUriComplete: string } | null>(null);
  const [meta, setMeta] = useState<{ action: string; signal: string } | null>(null);
  /**
   * A local echo of the approval, used only to bridge the instant between
   * pressing "authorize" and the next status poll.
   *
   * It is deliberately NOT the record. The authoritative answer comes from
   * `status.data.openApprovals`, because an approval held only in React state
   * does not survive the trip to the consent screen and back: the human approved
   * on their phone, the IdP redirected here, the state was gone, and the page
   * showed a running countdown and a pressable button as if nothing had
   * happened. Pressing it started a *second* authorization.
   */
  const [localApproval, setLocalApproval] = useState<ApprovalView | null>(null);
  const claimed = useRef<Set<string>>(new Set());

  // `null` while we are still deciding, and while signed out. This variable must
  // only ever hold a queue-status payload: treating a health response as one is
  // what crashed the console for every signed-out visitor.
  const status = usePoll<Status & { ok: true }>(signedIn === true ? '/api/queue/status' : null, 1000);

  const note = useCallback((line: string) => {
    setLog((prev) => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 40));
  }, []);

  const openApprovals = status.data?.openApprovals ?? [];
  const outstanding = openApprovals[0] ?? null;

  /** What the page should show as the current authorization. */
  const approval: ApprovalView | null = useMemo(() => {
    if (!outstanding) return localApproval;
    return {
      approvalId: outstanding.approvalId,
      kind: outstanding.kind,
      state: outstanding.state,
      stage: outstanding.stage,
      boundAction: outstanding.boundAction,
      boundSignal: outstanding.boundSignal,
      slotId: outstanding.slotId,
      failReason: null,
      remainingMs: outstanding.remainingMs,
      stages: [
        { key: 'requested', label: '1 · request issued', at: outstanding.requestedAt },
        { key: 'completed', label: '2 · human completed on device', at: outstanding.completedAt },
        { key: 'verified', label: '3 · server verified the proof', at: outstanding.verifiedAt },
        { key: 'executed', label: '4 · protected action executed', at: outstanding.executedAt },
      ],
    };
  }, [outstanding, localApproval]);

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

  /**
   * Take an approved authorization to the gate.
   *
   * The human already answered on their phone; making them press a third button
   * afterwards is both a worse demo and a worse product. Guarded per approval id
   * so a polling loop cannot fire it twice — the gate would refuse the second
   * anyway, but a duplicate request is a confusing thing to show.
   */
  useEffect(() => {
    const ready = openApprovals.find(
      (a) => a.state === 'APPROVED' && !claimed.current.has(a.approvalId),
    );
    if (!ready) return;
    claimed.current.add(ready.approvalId);

    void (async () => {
      setBusy(true);
      try {
        const res = await call<{ ok: true; slotId: string }>('/api/slot/claim', {
          json: { approval: ready.approvalId },
        });
        note(`CONFIRMED ${res.slotId} — nullifier spent`);
        setLocalApproval(null);
      } catch (err) {
        const body = (err as { body?: ReasonBody }).body;
        setError(body ?? null);
        note(`claim refused: ${body?.code ?? 'unknown'}`);
      } finally {
        setBusy(false);
        void status.refresh();
      }
    })();
    // `status` is stable across renders; including it would re-fire the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openApprovals, note]);

  /**
   * Poll a locally-known approval only until the server starts reporting it.
   * After that the status poll is the single source of truth, and two pollers
   * disagreeing about the same row is exactly the kind of drift that produced
   * this bug in the first place.
   */
  useEffect(() => {
    if (!localApproval || outstanding) return;
    const timer = setInterval(async () => {
      try {
        const next = await call<ApprovalView & { ok: true }>(`/api/approval/${localApproval.approvalId}`);
        setLocalApproval(next);
      } catch {
        /* keep polling; a transient failure is not worth surfacing here */
      }
    }, 900);
    return () => clearInterval(timer);
  }, [localApproval, outstanding]);

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
      setLocalApproval({
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

  const claim = (approvalId: string) =>
    run('claim', async () => {
      const res = await call<{ ok: true; slotId: string; nullifier: string }>('/api/slot/claim', {
        json: { approval: approvalId },
      });
      note(`CONFIRMED ${res.slotId} — nullifier spent`);
      setLocalApproval(null);
      void status.refresh();
    });

  const claimWithoutApproval = () =>
    run('claim-without-approval', async () => {
      // The demo point: the call is well-formed, the caller is authenticated and
      // holds a slot, and it still fails, because tool inputs prove nothing.
      await call('/api/slot/claim', { json: {} });
    });

  const deny = (approvalId: string) =>
    run('deny', async () => {
      await call(`/api/approval/${approvalId}`, { json: { reason: 'denied by the human' } });
      note('denied — nothing will execute');
      setLocalApproval(null);
      void status.refresh();
    });

  const remaining = useMemo(() => {
    if (!approval) return null;
    const deadline = Date.now() + approval.remainingMs;
    return Math.max(0, deadline - Date.now());
  }, [approval, status.data]);

  // The soonest slot deadline, so the handover countdown ticks every 200ms
  // against the server's clock rather than jumping once per poll.
  const soonestDeadline = useMemo(() => {
    const deadlines = (status.data?.allocation ?? []).map((a) => a.deadline).filter(Boolean);
    return deadlines.length ? Math.min(...deadlines) : null;
  }, [status.data]);
  const localRemaining = useCountdown(soonestDeadline, status.data?.serverNow ?? null);
  /** Ticks locally, so the draw countdown moves every 200ms instead of every poll. */
  const drawRemaining = useCountdown(status.data?.lottery?.closesAt ?? null, status.data?.serverNow ?? null);
  const drawPending =
    status.data?.lottery?.open === true &&
    status.data.lottery.opensAt !== null &&
    !status.data.queue?.lotteryRank;
  /** The authorization's own window, on the same ticking clock. */
  const approvalRemaining = useCountdown(outstanding?.expiresAt ?? null, status.data?.serverNow ?? null);
  const slotRemaining = (deadline: number) =>
    deadline === soonestDeadline && localRemaining != null ? localRemaining : Math.max(0, deadline - Date.now());

  const idpMode = health.data?.idp?.mode ?? 'oidc';

  return (
    <main className="mx-auto max-w-5xl p-6">
      <DegradedBanner mode={idpMode} />

      <header className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div>
          <h1 className="text-3xl font-black tracking-tight">Agent Ticketing Demo</h1>
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
                <Metric
                  label="your rank"
                  value={status.data?.queue?.lotteryRank ?? (drawPending ? 'drawing…' : '—')}
                />
                <Metric label="arrival #" value={status.data?.queue?.arrivalSeq ?? '—'} />
              </div>
              <p className="mt-3 text-xs text-[var(--color-muted)]">
                Rank comes from the draw, not from arrival. Arrival order is recorded only so the
                FCFS control mode has something to sort by.
              </p>
              {/*
                The draw window is the one stretch where a correct system looks
                like a broken one: nothing changes for fifteen seconds, and a
                static "—" in the rank column reads as a hung page. Say the draw
                is running, count it down locally, and show how many people are
                in it, so the wait is visibly a wait.
              */}
              {drawPending && (
                <div className="mt-3 rounded-lg border border-[color-mix(in_srgb,var(--color-warn)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-warn)_10%,transparent)] p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span
                        className="pulse inline-block h-2.5 w-2.5 rounded-full bg-[var(--color-warn)]"
                        aria-hidden
                      />
                      <span className="text-sm font-bold tracking-wide text-[var(--color-warn)] uppercase">
                        {status.data?.lottery?.mode === 'fcfs'
                          ? 'queue open'
                          : 'draw in progress'}
                      </span>
                    </div>
                    <span className="tnum text-2xl font-black text-[var(--color-warn)]">
                      {drawRemaining == null
                        ? 'soon'
                        : drawRemaining <= 0
                          ? 'now…'
                          : formatSeconds(drawRemaining)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    {status.data?.lottery?.mode === 'fcfs'
                      ? `${status.data?.lottery?.entrants ?? 0} in the queue. First come, first served — arrival order decides.`
                      : `${status.data?.lottery?.entrants ?? 0} in the draw. Your rank appears the moment the window closes; arrival order does not matter.`}
                  </p>
                </div>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                {!status.data?.queue?.joined && (
                  <Button tone="live" onClick={join} disabled={busy}>
                    Join the queue
                  </Button>
                )}
                {status.data?.queue?.joined && !status.data?.queue?.lotteryRank && !drawPending && (
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
          {!status.data?.allocation?.length && (
            <p className="text-sm text-[var(--color-muted)]">
              {status.data?.holding?.length
                ? 'You already hold a confirmed slot.'
                : 'No slot is allocated to you right now.'}
            </p>
          )}

          {/*
            ── Why this block is not nested inside the allocation branch ──────
            It was: with no allocation, the button disappeared, and with it the
            only way to reach a refusal. That is invisible on the stage — the
            operator always has a slot when they press it — and wrong for a demo
            whose entire point is showing *why* a purchase is refused:

              · after a confirmed purchase there is no allocation and no open
                approval, and the gate answers `already_owns_entitlement`
                (one slot per human per event);
              · after a missed window it answers `deferred_to_next_candidate`;
              · after a settled draw it answers `no_slot_allocated`.

            Every one of those is a beat in the runbook, and every one was
            unreachable from the screen because the button that produces them
            was hidden. So the button is offered whenever there is nothing
            pending, and the server's refusal is what the room reads.
          */}
          {(status.data?.allocation?.length ?? 0) > 0 && (
            <div className="space-y-3">
              {status.data!.allocation.map((a) => (
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
                  {/*
                    Ticked locally against the server's clock, not printed from
                    the polled `remainingMs`. Printing the polled number only
                    moves once a second and stutters; the board already does this
                    properly, and a countdown a judge is watching should not look
                    broken.
                  */}
                  <div className="tnum text-4xl font-black text-[var(--color-live)]">
                    {formatSeconds(slotRemaining(a.deadline))}
                  </div>
                  {/*
                    While an authorization is outstanding there is nothing to ask
                    for. Offering the button anyway is what let a human approve on
                    their phone, come back, and start a *second* authorization
                    because the page looked untouched.
                  */}
                  {approval ? (
                    <Badge tone={approval.state === 'PENDING' ? 'warn' : 'live'}>
                      {approval.state === 'PENDING'
                        ? 'waiting for you to approve'
                        : 'approved — completing…'}
                    </Badge>
                  ) : (
                    <Button tone="live" onClick={requestApproval} disabled={busy}>
                      Ask me to authorize
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* No allocation: the button is still the way to reach a refusal. */}
          {(status.data?.allocation?.length ?? 0) === 0 &&
            !approval &&
            status.data?.queue?.joined && (
              <div className="mt-3">
                <Button tone="live" onClick={requestApproval} disabled={busy}>
                  Ask me to authorize
                </Button>
              </div>
            )}

          {approval && (
            <div className="mt-4 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge tone={approval.state === 'PENDING' ? 'warn' : approval.state === 'CONSUMED' ? 'brand' : 'live'}>
                    {approval.state}
                  </Badge>
                  {outstanding?.requestedVia === 'agent' && (
                    <Badge tone="brand">requested by your agent</Badge>
                  )}
                  <span className="mono text-xs">{approval.approvalId}</span>
                </div>
                {approval.state === 'PENDING' && approvalRemaining != null && (
                  <span className="tnum text-2xl font-bold">
                    {formatSeconds(approvalRemaining)}
                  </span>
                )}
              </div>

              <div className="mono mt-2 space-y-0.5 text-[11px] text-[var(--color-muted)]">
                <div>action {approval.boundAction}</div>
                <div>signal {approval.boundSignal}</div>
              </div>

              {approval.state === 'PENDING' && (
                <div className="mt-3 rounded-md border border-[color-mix(in_srgb,var(--color-warn)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-warn)_8%,transparent)] p-2 text-xs text-[var(--color-warn)]">
                  Waiting for the human. Approve on your device and this page will finish the
                  handover on its own — the countdown above is the slot&apos;s window, not the
                  authorization&apos;s.
                  {outstanding?.consentUrl && (
                    <>
                      {' '}
                      <a className="underline" href={outstanding.consentUrl}>
                        re-open the consent screen
                      </a>
                    </>
                  )}
                </div>
              )}

              {approval.state === 'APPROVED' && (
                <div className="mt-3 rounded-md border border-[color-mix(in_srgb,var(--color-live)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-live)_8%,transparent)] p-2 text-xs text-[var(--color-live)]">
                  Approved and verified. Presenting to the gate…
                </div>
              )}

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
                <Button
                  tone="brand"
                  onClick={() => claim(approval.approvalId)}
                  disabled={busy || approval.state !== 'APPROVED'}
                >
                  Present approval to the gate
                </Button>
                <Button
                  tone="alert"
                  onClick={() => deny(approval.approvalId)}
                  disabled={busy || approval.state !== 'PENDING'}
                >
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

        {/* ── Held slots ────────────────────────────────────────────── */}
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
                      {s.state} · locked to you
                    </div>
                  </div>
                </li>
              ))}
            </ul>
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
