'use client';

/**
 * The recipient's view of a transfer.
 *
 * The whole point of this screen is the fifteen seconds it makes visible. The
 * concept doc is explicit: "第 5 拍的倒计时不要剪掉。那 15 秒就是我们的产品主张:
 * 它对朋友是礼貌，对黄牛是成本."
 *
 * So the flow is deliberately not one click. Opening the link starts a clock,
 * and completing requires the recipient — and only the recipient — to produce a
 * fresh proof on their own device.
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  Badge,
  Button,
  Card,
  Notice,
  Refusal,
  call,
  formatSeconds,
  type ReasonBody,
} from '../../_components/ui';

interface TransferView {
  ok: true;
  transferId: string;
  slotId: string;
  from: string;
  to: string | null;
  state: string;
  label: string | null;
  opened: boolean;
  openedAt: number | null;
  expiresAt: number | null;
  remainingMs: number | null;
  slotState: string | null;
  note: string;
}

export default function TransferPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;

  const [view, setView] = useState<TransferView | null>(null);
  const [error, setError] = useState<ReasonBody | null>(null);
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<{ approvalId: string; state: string; stage: string; failReason: string | null } | null>(null);
  const [done, setDone] = useState<{ inboundCount: number; inboundCap: number } | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      setView(await call<TransferView>(`/api/transfer/${token}`));
    } catch (err) {
      setError((err as { body: ReasonBody }).body);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // Local 200ms tick so the countdown is smooth and obviously running.
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 200);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!approval || approval.state !== 'PENDING') return;
    const timer = setInterval(async () => {
      try {
        const next = await call<{ approvalId: string; state: string; stage: string; failReason: string | null }>(
          `/api/approval/${approval.approvalId}`,
        );
        setApproval(next);
      } catch {
        /* transient */
      }
    }, 900);
    return () => clearInterval(timer);
  }, [approval]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as { body: ReasonBody }).body);
    } finally {
      setBusy(false);
    }
  }

  const accept = () =>
    run(async () => {
      await call(`/api/transfer/${token}`, { json: { action: 'open' } });
      await load();
    });

  const requestProof = () =>
    run(async () => {
      const res = await call<{
        ok: true;
        approvalId: string;
        url?: string;
        deviceCode?: { userCode: string; verificationUriComplete: string };
        windowSec?: number;
      }>(`/api/transfer/${token}`, { json: { action: 'request' } });
      setApproval({ approvalId: res.approvalId, state: 'PENDING', stage: 'requested', failReason: null });
      if (res.deviceCode) {
        window.location.href = res.deviceCode.verificationUriComplete;
      } else if (res.url) {
        window.location.href = res.url;
      }
    });

  const complete = () =>
    run(async () => {
      if (!approval) return;
      const res = await call<{ ok: true; inboundCount: number; inboundCap: number }>(
        `/api/transfer/${token}`,
        { json: { action: 'complete', approval: approval.approvalId } },
      );
      setDone({ inboundCount: res.inboundCount, inboundCap: res.inboundCap });
      await load();
    });

  const remaining = view?.expiresAt ? Math.max(0, view.expiresAt - Date.now()) : null;
  void tick;

  return (
    <main className="mx-auto max-w-2xl p-6">
      <Link href="/" className="text-sm text-[var(--color-muted)] underline">
        ← console
      </Link>

      <h1 className="mt-4 text-3xl font-black">Someone wants to give you a slot</h1>

      {error && <div className="mt-4"><Refusal error={error} onDismiss={() => setError(null)} /></div>}

      {view && (
        <>
          <Card title="the offer" className="mt-4">
            <div className="space-y-2 text-sm">
              <Row label="slot" value={view.slotId} mono />
              <Row label="from" value={view.from} mono />
              <Row label="state" value={view.state} />
              {view.label && <Row label="note" value={view.label} />}
            </div>

            {!view.opened ? (
              <Notice tone="live">
                <strong>The clock has not started.</strong> It starts the moment you press Accept —
                not when the link was sent. That is why a message left unread for an hour is still
                good when you finally get to it.
              </Notice>
            ) : (
              <div className="mt-3 flex items-center justify-between rounded-lg border border-[color-mix(in_srgb,var(--color-warn)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-warn)_10%,transparent)] p-3">
                <span className="text-sm text-[var(--color-warn)]">
                  window running since you opened it
                </span>
                <span className="tnum text-4xl font-black text-[var(--color-warn)]">
                  {formatSeconds(remaining)}
                </span>
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              {!view.opened && (
                <Button tone="live" size="lg" onClick={accept} disabled={busy}>
                  Accept and start the clock
                </Button>
              )}
              {view.opened && !approval && (
                <Button tone="brand" size="lg" onClick={requestProof} disabled={busy}>
                  Prove it&apos;s me — request fresh authorization
                </Button>
              )}
              {approval && approval.state === 'APPROVED' && (
                <Button tone="live" size="lg" onClick={complete} disabled={busy}>
                  Complete the transfer
                </Button>
              )}
            </div>

            {approval && (
              <p className="mt-3 text-sm">
                <Badge tone={approval.state === 'APPROVED' ? 'live' : approval.state === 'PENDING' ? 'warn' : 'alert'}>
                  {approval.stage}
                </Badge>{' '}
                <span className="mono text-xs text-[var(--color-muted)]">{approval.approvalId}</span>
              </p>
            )}

            {done && (
              <Notice tone="live">
                <strong>Transferred.</strong> You have now received {done.inboundCount} of{' '}
                {done.inboundCap} allowed transfers for this event. That counter follows you, not
                this account.
              </Notice>
            )}
          </Card>

          <div className="mt-4 space-y-2 text-xs text-[var(--color-muted)]">
            <p>
              <strong>Why the friction.</strong> A scalper does not have to win the queue if slots
              can be passed on freely — he just buys them afterwards. Requiring a real person to
              answer inside a window that expires turns that into hourly work, and the record it
              leaves follows the human across accounts.
            </p>
            <p>
              <strong>What it does not prove.</strong> Presence is not consent. Someone paid or
              pressured to press this button defeats every check on this page, and the project says
              so rather than claiming otherwise.
            </p>
          </div>
        </>
      )}
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
