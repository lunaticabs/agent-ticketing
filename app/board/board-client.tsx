'use client';

/**
 * ============================================================================
 *  The board (T-6.1)
 * ============================================================================
 *
 * This is not decoration; it is the demo. Almost every claim the project makes
 * is a claim about something *not* happening — no double-spend, no deferral
 * missed, no refusal unexplained — and an unobservable claim is indistinguishable
 * from a bluff. So the board shows, live:
 *
 *   · queue length and the draw order
 *   · who currently holds which slot, and the second-by-second countdown
 *   · every DEFERRAL, with the reason
 *   · every REFUSAL, with its machine code and the invariant behind it
 *   · the four stages of the authorization loop
 *
 * Readability target is three metres, so the type is large, the palette is
 * five colours with fixed meanings, and figures are tabular so digits do not
 * jitter as they count down.
 */
import { useMemo } from 'react';
import Link from 'next/link';
import {
  Badge,
  Card,
  DegradedBanner,
  formatSeconds,
  relative,
  useCountdown,
  usePoll,
} from '../_components/ui';

interface SlotItem {
  id: string;
  state: string;
  holder: string | null;
  holderShort: string | null;
  approvalDeadline: number | null;
  remainingMs: number | null;
  deferralCount: number;
}

interface ApprovalItem {
  id: string;
  kind: string;
  continuityShort: string;
  slotId: string | null;
  state: string;
  boundAction: string;
  boundSignal: string;
  failReason: string | null;
  remainingMs: number;
  stages: { requested: number | null; completed: number | null; verified: number | null; executed: number | null };
}

interface BoardState {
  serverNow: number;
  event: {
    id: string;
    name: string;
    lotteryMode: string;
    totalSlots: number;
    approvalWindowSec: number;
    lotteryWindowSec: number;
    lotteryDrawnAt: number | null;
    lotterySeed: string | null;
    lotteryOpen: boolean;
    lotteryClosesAt: number | null;
  };
  idp: { mode: string; degraded: boolean; issuer: string };
  queue: {
    total: number;
    drawn: number;
    allocated: number;
    waiting: number;
    entries: {
      entryId: string;
      short: string;
      seq: number;
      joinedAt: number;
      rank: number | null;
      allocatedAt: number | null;
    }[];
  };
  slots: {
    total: number;
    available: number;
    allocated: number;
    confirmed: number;
    deferrals: number;
    items: SlotItem[];
  };
  approvals: ApprovalItem[];
  actors: { human: number; agent: number; system: number };
  humans: { total: number; distinctInQueue: number };
  drawVerification: {
    settled: boolean;
    matches: boolean | null;
    checked: number;
    seed: string | null;
    algorithm?: string;
  };
  security: {
    consumedProofs: number;
    protectedActionsExecuted: number;
    totalRefusals: number;
    refusals: Record<string, number>;
  };
  audit: {
    id: string;
    type: string;
    severity: string;
    at: number;
    continuityShort: string | null;
    slotId: string | null;
    actor: 'human' | 'agent' | 'system';
    payload: Record<string, unknown>;
  }[];
  highlight: {
    kind: string;
    at: number;
    slotId: string | null;
    continuityId: string | null;
    message: string;
    code?: string;
  };
}

const SLOT_TONE: Record<string, { bg: string; label: string }> = {
  AVAILABLE: { bg: 'bg-[var(--color-panel-2)] border-[var(--color-line)] text-[var(--color-muted)]', label: 'available' },
  ALLOCATED: { bg: 'bg-[color-mix(in_srgb,var(--color-live)_18%,transparent)] border-[var(--color-live)] text-[var(--color-live)]', label: 'awaiting human' },
  CONFIRMED: { bg: 'bg-[color-mix(in_srgb,var(--color-brand)_22%,transparent)] border-[var(--color-brand)] text-[var(--color-brand)]', label: 'confirmed' },
  EXPIRED: { bg: 'bg-[color-mix(in_srgb,var(--color-warn)_18%,transparent)] border-[var(--color-warn)] text-[var(--color-warn)]', label: 'expired' },
};

export default function BoardClient({ initial }: { initial: BoardState | null }) {
  const { data, error } = usePoll<BoardState>('/api/board/state', 1000, initial);

  // Recomputed locally every 200ms so the countdown is smooth even though the
  // snapshot arrives once a second.
  const soonestDeadline = useMemo(() => {
    const deadlines = (data?.slots?.items ?? [])
      .filter((s) => s.state === 'ALLOCATED' && s.approvalDeadline)
      .map((s) => s.approvalDeadline as number);
    return deadlines.length ? Math.min(...deadlines) : null;
  }, [data]);

  const remaining = useCountdown(soonestDeadline, data?.serverNow ?? null);
  /** Ticks locally while the draw window is open, so the board never looks hung. */
  const drawRemaining = useCountdown(data?.event?.lotteryClosesAt ?? null, data?.serverNow ?? null);

  if (error && !data) {
    return (
      <main className="p-10">
        <h1 className="text-3xl font-bold">Board unavailable</h1>
        <p className="mt-3 text-[var(--color-alert)]">{error.body.message}</p>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          Is the database seeded? Run <code className="mono">npm run seed</code>.
        </p>
      </main>
    );
  }

  if (!data) {
    return <main className="p-10 text-2xl text-[var(--color-muted)]">connecting…</main>;
  }

  const h = data.highlight;
  const highlightTone =
    h.kind === 'deferral'
      ? 'warn'
      : h.kind === 'rejection'
        ? 'alert'
        : h.kind === 'none'
          ? 'neutral'
          : h.kind === 'draw'
            ? 'brand'
            : 'live';
  const fresh = Date.now() - h.at < 12_000 && h.kind !== 'none';

  return (
    <main className="flex min-h-screen flex-col">
      <DegradedBanner mode={data.idp.mode} />

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-line)] px-6 py-4">
        <div className="flex items-baseline gap-4">
          <h1 className="text-3xl font-black tracking-tight">HumanGate</h1>
          <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--color-muted)]">
            live demo
          </span>
          <span className="text-lg text-[var(--color-muted)]">{data.event.name}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="alert">locked · slots are not transferable</Badge>
          <Badge tone={data.event.lotteryMode === 'lottery' ? 'live' : 'alert'}>
            {data.event.lotteryMode === 'lottery' ? 'DRAW — arrival time irrelevant' : 'FCFS — speed wins'}
          </Badge>
          <Badge tone={data.idp.degraded ? 'warn' : 'brand'}>
            idp · {data.idp.mode}
          </Badge>
          <Badge tone="neutral">window {data.event.approvalWindowSec}s</Badge>
          <Link href="/admin" className="text-xs text-[var(--color-muted)] underline hover:text-white">
            controls
          </Link>
          <Link href="/" className="text-xs text-[var(--color-muted)] underline hover:text-white">
            console
          </Link>
        </div>
      </header>

      {/* ── The headline event: deferral or refusal, live ───────────────── */}
      <div
        className={`flex items-center gap-4 border-b px-6 py-3 text-xl ${
          fresh ? 'flash' : ''
        } ${
          highlightTone === 'alert'
            ? 'border-[color-mix(in_srgb,var(--color-alert)_50%,transparent)] bg-[color-mix(in_srgb,var(--color-alert)_14%,transparent)] text-[var(--color-alert)]'
            : highlightTone === 'warn'
              ? 'border-[color-mix(in_srgb,var(--color-warn)_50%,transparent)] bg-[color-mix(in_srgb,var(--color-warn)_14%,transparent)] text-[var(--color-warn)]'
              : highlightTone === 'live'
                ? 'border-[color-mix(in_srgb,var(--color-live)_50%,transparent)] bg-[color-mix(in_srgb,var(--color-live)_14%,transparent)] text-[var(--color-live)]'
                : 'border-[var(--color-line)] bg-[var(--color-panel)] text-[var(--color-muted)]'
        }`}
      >
        <span className="font-black tracking-[0.2em] uppercase">
          {h.kind === 'none' ? 'idle' : h.kind}
        </span>
        <span className="flex-1 truncate font-semibold">
          {h.kind === 'none' ? 'waiting for the next transition' : h.message}
        </span>
        {h.code && <code className="mono text-sm">{h.code}</code>}
        <span className="tnum text-sm opacity-70">{relative(h.at, data.serverNow)}</span>
      </div>

      {/* ── Big numbers ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-px border-b border-[var(--color-line)] bg-[var(--color-line)] md:grid-cols-7">
        <Big label="in queue" value={data.queue.total} detail={`${data.humans.distinctInQueue} distinct humans`} />
        <Big
          label="slots"
          value={`${data.slots.confirmed}/${data.slots.total}`}
          detail={`${data.slots.allocated} awaiting · ${data.slots.available} free`}
        />
        <Big
          label="next deadline"
          value={remaining == null ? '—' : formatSeconds(remaining)}
          detail={soonestDeadline ? 'approval window' : 'nothing allocated'}
          tone={remaining != null && remaining < 15_000 ? 'alert' : 'live'}
        />
        <Big
          label="by agent"
          value={data.actors.agent}
          detail={`${data.actors.human} by a human directly`}
          tone="brand"
        />
        <Big label="deferrals" value={data.slots.deferrals} detail="slots passed on" tone="warn" />
        <Big label="refusals" value={data.security.totalRefusals} detail="blocked attempts" tone="alert" />
        <Big
          label="proofs spent"
          value={data.security.consumedProofs}
          detail={`${data.security.protectedActionsExecuted} actions executed`}
        />
      </div>

      <div className="grid flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-12">
        {/* ── Queue ──────────────────────────────────────────────────── */}
        <Card
          title={`queue · ${data.queue.total}`}
          className="lg:col-span-3"
          right={
            data.event.lotteryOpen && !data.queue.drawn && data.event.lotteryClosesAt ? (
              <span className="flex items-center gap-1.5 text-xs font-bold tracking-wide text-[var(--color-warn)] uppercase">
                <span className="pulse inline-block h-2 w-2 rounded-full bg-[var(--color-warn)]" aria-hidden />
                {drawRemaining != null && drawRemaining > 0 ? (
                  <span className="tnum">{formatSeconds(drawRemaining)}</span>
                ) : (
                  'drawing'
                )}
              </span>
            ) : (
              <span className="tnum text-xs text-[var(--color-muted)]">
                {data.queue.drawn ? 'drawn' : 'closed'}
              </span>
            )
          }
        >
          <ol className="space-y-1">
            {data.queue.entries.map((e) => (
              <li
                key={e.entryId}
                className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm ${
                  e.allocatedAt
                    ? 'border-[color-mix(in_srgb,var(--color-live)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-live)_10%,transparent)]'
                    : 'border-transparent'
                }`}
              >
                <span className="tnum w-8 text-right font-bold text-[var(--color-muted)]">
                  {e.rank ?? '·'}
                </span>
                <span className="mono flex-1 truncate">{e.short}</span>
                <span className="tnum text-xs text-[var(--color-muted)]">#{e.seq}</span>
                {e.allocatedAt && <Badge tone="live">served</Badge>}
              </li>
            ))}
            {data.queue.entries.length === 0 && (
              <li className="text-sm text-[var(--color-muted)]">nobody has joined yet</li>
            )}
          </ol>
          <div className="mt-3 border-t border-[var(--color-line)] pt-2 text-xs text-[var(--color-muted)]">
            {data.drawVerification.settled ? (
              <>
                <div className="flex items-center gap-2">
                  <Badge tone={data.drawVerification.matches ? 'live' : 'alert'}>
                    {data.drawVerification.matches ? 'draw verified' : 'draw mismatch'}
                  </Badge>
                  <span>{data.drawVerification.checked} entries</span>
                </div>
                <p className="mono mt-1 truncate text-[10px]">
                  {data.drawVerification.algorithm}
                </p>
                <p className="mono truncate text-[10px]">seed {data.drawVerification.seed}</p>
              </>
            ) : (
              // Rank columns are empty and nothing moves while the window is
              // open. On a projector that reads as a crashed screen, so say the
              // draw is running and count it down.
              <div className="rounded-md border border-[color-mix(in_srgb,var(--color-warn)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-warn)_10%,transparent)] p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 font-bold tracking-wide text-[var(--color-warn)] uppercase">
                    <span className="pulse inline-block h-2 w-2 rounded-full bg-[var(--color-warn)]" aria-hidden />
                    {data.event.lotteryMode === 'fcfs' ? 'queue open' : 'draw in progress'}
                  </span>
                  <span className="tnum text-lg font-black text-[var(--color-warn)]">
                    {drawRemaining == null ? '—' : drawRemaining <= 0 ? 'now…' : formatSeconds(drawRemaining)}
                  </span>
                </div>
                <p className="mt-1">
                  {data.queue.total} in the {data.event.lotteryMode === 'fcfs' ? 'queue' : 'draw'}
                  {data.event.lotteryMode === 'fcfs'
                    ? ' — arrival order decides'
                    : ' — everyone here has the same odds'}
                </p>
              </div>
            )}
          </div>
        </Card>

        {/* ── Slots ──────────────────────────────────────────────────── */}
        <Card title={`slots · ${data.slots.total}`} className="lg:col-span-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            {data.slots.items.map((s) => (
              <SlotTile key={s.id} slot={s} serverNow={data.serverNow} />
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 border-t border-[var(--color-line)] pt-3 text-sm">
            <Row label="awaiting human" value={data.slots.allocated} tone="live" />
            <Row label="confirmed" value={data.slots.confirmed} tone="brand" />
            <Row label="free" value={data.slots.available} />
          </div>
        </Card>

        {/* ── Approvals ──────────────────────────────────────────────── */}
        <div className="space-y-4 lg:col-span-4">
          <Card title="authorization loop">
            <ul className="space-y-3">
              {data.approvals.slice(0, 5).map((a) => (
                <li key={a.id} className="rounded-lg border border-[var(--color-line)] p-2">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="mono truncate">{a.continuityShort}</span>
                    <Badge tone={stateTone(a.state)}>{a.state}</Badge>
                  </div>
                  <div className="mono mt-1 truncate text-[10px] text-[var(--color-muted)]">
                    {a.boundAction}
                  </div>
                  <StagePipeline stages={a.stages} />
                  {a.state === 'PENDING' && (
                    <div className="tnum mt-1 text-right text-lg font-bold text-[var(--color-live)]">
                      {formatSeconds(a.remainingMs)}
                    </div>
                  )}
                  {a.failReason && (
                    <p className="mt-1 text-xs text-[var(--color-alert)]">{a.failReason}</p>
                  )}
                </li>
              ))}
              {data.approvals.length === 0 && (
                <li className="text-sm text-[var(--color-muted)]">no authorization requested yet</li>
              )}
            </ul>
          </Card>

        </div>
      </div>

      {/* ── Audit ticker ───────────────────────────────────────────────── */}
      <footer className="border-t border-[var(--color-line)] px-4 py-3">
        <div className="mb-2 text-xs font-semibold tracking-[0.16em] text-[var(--color-muted)] uppercase">
          audit · filed under the human, not the account
        </div>
        <div className="flex gap-3 overflow-x-auto pb-1">
          {data.audit.slice(0, 14).map((a) => (
            <div
              key={a.id}
              className={`min-w-[16rem] shrink-0 rounded-md border px-2 py-1 text-xs ${
                a.severity === 'alert'
                  ? 'border-[color-mix(in_srgb,var(--color-alert)_45%,transparent)] text-[var(--color-alert)]'
                  : a.severity === 'warn'
                    ? 'border-[color-mix(in_srgb,var(--color-warn)_45%,transparent)] text-[var(--color-warn)]'
                    : 'border-[var(--color-line)] text-[var(--color-muted)]'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="mono truncate">{a.type}</span>
                <span className="tnum opacity-70">{relative(a.at, data.serverNow)}</span>
              </div>
              {/* Who acted. The whole claim is that an agent may act for a human,
                  so the board says which of the two did each thing. */}
              {a.actor !== 'system' && (
                <div
                  className={`text-[10px] font-bold tracking-wide uppercase ${
                    a.actor === 'agent' ? 'text-[var(--color-brand)]' : 'text-[var(--color-live)]'
                  }`}
                >
                  {a.actor}
                </div>
              )}
              <div className="mono truncate opacity-70">
                {a.continuityShort ?? '—'}
                {typeof a.payload.note === 'string' ? ` · ${a.payload.note}` : ''}
              </div>
            </div>
          ))}
        </div>
      </footer>
    </main>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function Big({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: string | number;
  detail?: string;
  tone?: 'neutral' | 'live' | 'warn' | 'alert' | 'brand';
}) {
  const color = {
    neutral: 'text-[var(--color-text)]',
    live: 'text-[var(--color-live)]',
    warn: 'text-[var(--color-warn)]',
    alert: 'text-[var(--color-alert)]',
    brand: 'text-[var(--color-brand)]',
  }[tone];
  return (
    <div className="bg-[var(--color-panel)] px-4 py-3">
      <div className="text-xs font-semibold tracking-[0.16em] text-[var(--color-muted)] uppercase">
        {label}
      </div>
      <div className={`tnum text-4xl font-black ${color}`}>{value}</div>
      {detail && <div className="truncate text-xs text-[var(--color-muted)]">{detail}</div>}
    </div>
  );
}

function SlotTile({ slot, serverNow }: { slot: SlotItem; serverNow: number }) {
  const tone = SLOT_TONE[slot.state] ?? SLOT_TONE.AVAILABLE;
  const remaining = useCountdown(slot.approvalDeadline, serverNow);
  return (
    <div className={`rounded-lg border-2 p-2 ${tone.bg} ${slot.deferralCount > 0 ? 'flash' : ''}`}>
      <div className="mono truncate text-[10px] opacity-80">{slot.id}</div>
      <div className="truncate text-sm font-bold">{tone.label}</div>
      <div className="mono truncate text-xs opacity-90">{slot.holderShort ?? '—'}</div>
      {slot.state === 'ALLOCATED' && remaining != null && (
        <div className={`tnum text-2xl font-black ${remaining < 15_000 ? 'pulse' : ''}`}>
          {formatSeconds(remaining)}
        </div>
      )}
      {slot.deferralCount > 0 && (
        <div className="text-[10px] font-bold">deferred ×{slot.deferralCount}</div>
      )}
    </div>
  );
}

function StagePipeline({
  stages,
}: {
  stages: { requested: number | null; completed: number | null; verified: number | null; executed: number | null };
}) {
  const steps = [
    { key: 'req', label: '1 request', at: stages.requested },
    { key: 'cmp', label: '2 completed', at: stages.completed },
    { key: 'vrf', label: '3 verified', at: stages.verified },
    { key: 'exe', label: '4 executed', at: stages.executed },
  ];
  return (
    <div className="mt-2 flex gap-1">
      {steps.map((s) => (
        <div
          key={s.key}
          title={s.label}
          className={`h-1.5 flex-1 rounded-full ${
            s.at ? 'bg-[var(--color-live)]' : 'bg-[var(--color-panel-2)]'
          }`}
        />
      ))}
    </div>
  );
}

function Row({ label, value, tone = 'neutral' }: { label: string; value: number; tone?: 'neutral' | 'live' | 'brand' | 'violet' }) {
  const color = {
    neutral: 'text-[var(--color-text)]',
    live: 'text-[var(--color-live)]',
    brand: 'text-[var(--color-brand)]',
    violet: 'text-[var(--color-violet)]',
  }[tone];
  return (
    <div className="flex items-center justify-between">
      <span className="text-[var(--color-muted)]">{label}</span>
      <span className={`tnum text-xl font-bold ${color}`}>{value}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="tnum text-2xl font-bold">{value}</div>
      <div className="text-[10px] tracking-wide text-[var(--color-muted)] uppercase">{label}</div>
    </div>
  );
}

function stateTone(state: string) {
  switch (state) {
    case 'APPROVED':
      return 'live' as const;
    case 'CONSUMED':
      return 'brand' as const;
    case 'DENIED':
    case 'EXPIRED':
      return 'alert' as const;
    default:
      return 'warn' as const;
  }
}
