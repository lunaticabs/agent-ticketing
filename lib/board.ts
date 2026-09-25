/**
 * The board snapshot (T-6.1).
 *
 * One flat JSON object, polled once per second. Deliberately not SSE or
 * WebSocket: conference wifi drops long-lived connections, and a 1-second poll
 * fails soft — the next tick simply fixes it. That was a call made in the plan
 * and it has held up.
 *
 * Everything a judge needs to see without narration is in here: queue length,
 * the current holder, the live countdown, and — most importantly — deferrals and
 * refusals with their reasons. `serverNow` is included so the countdown is
 * computed against the server's clock rather than the laptop's.
 */
import { getDb } from './db';
import { listEvents, primaryEvent, type EventRow } from './humans';
import { listQueue, queueStats, recomputeDrawOrder } from './queue';
import { listSlots, slotSummary, sweep } from './slots';
import { listApprovals } from './approval';
import { inboundTable, listTransfers, transferSummary } from './transfer';
import { recentAudit } from './audit';
import { idpMode, WORLDID_ISSUER } from '../worldid/config';

export interface BoardHighlight {
  kind: 'draw' | 'deferral' | 'rejection' | 'allocation' | 'confirmation' | 'transfer' | 'none';
  at: number;
  slotId: string | null;
  continuityId: string | null;
  message: string;
  code?: string;
}

const DEFERRAL_TYPES = new Set(['slot.approval_expired', 'transfer.expired']);
const REJECTION_TYPES = new Set([
  'gate.refused',
  'approval.rejected_at_gate',
  'transfer.rejected',
  'transfer.refused_inbound_cap',
  'attack.blocked',
]);

export function boardState(eventId?: string) {
  // Resolve time before serialising, so the UI never renders a stale window.
  const transitions = sweep(eventId);

  const event = eventId ? listEvents().find((e) => e.id === eventId) : primaryEvent();
  if (!event) throw new Error('no event');

  const entries = listQueue(event.id);
  const slots = listSlots(event.id);
  const approvals = listApprovals({ eventId: event.id, limit: 12 });
  const transfers = listTransfers(event.id).slice(0, 12);
  const auditRows = recentAudit(25, event.id);
  const now = Date.now();

  const highlight = deriveHighlight(auditRows, transitions, slots);

  return {
    serverNow: now,
    event: {
      id: event.id,
      name: event.name,
      policy: event.policy,
      lotteryMode: event.lottery_mode,
      totalSlots: event.total_slots,
      approvalWindowSec: event.approval_window_sec,
      lotteryWindowSec: event.lottery_window_sec,
      transferWindowSec: event.transfer_window_sec,
      transferInboundCap: event.transfer_inbound_cap,
      lotteryDrawnAt: event.lottery_drawn_at,
      lotterySeed: event.lottery_seed,
      lotteryOpen: event.lottery_drawn_at === null,
      lotteryClosesAt:
        event.lottery_drawn_at === null && event.lottery_window_sec > 0
          ? earliestJoin(event.id) + event.lottery_window_sec * 1000
          : null,
    },
    idp: {
      mode: idpMode(),
      degraded: idpMode() === 'local',
      issuer: WORLDID_ISSUER,
    },
    queue: {
      ...queueStats(event.id),
      entries: entries.slice(0, 60).map((e) => ({
        entryId: e.id,
        continuityId: e.continuity_id,
        short: shortId(e.continuity_id),
        seq: e.seq,
        joinedAt: e.joined_at,
        rank: e.lottery_rank,
        allocatedAt: e.allocated_at,
      })),
    },
    slots: {
      ...slotSummary(event.id),
      items: slots.map((s) => ({
        id: s.id,
        state: s.state,
        holder: s.holder_continuity_id,
        holderShort: s.holder_continuity_id ? shortId(s.holder_continuity_id) : null,
        acquiredVia: s.acquired_via,
        approvalDeadline: s.approval_deadline,
        remainingMs: s.approval_deadline ? Math.max(0, s.approval_deadline - now) : null,
        deferralCount: s.deferral_count,
        giftUsed: s.gift_used === 1,
      })),
    },
    approvals: approvals.map((a) => ({
      id: a.id,
      kind: a.kind,
      continuityId: a.continuity_id,
      continuityShort: shortId(a.continuity_id),
      slotId: a.slot_id,
      state: a.state,
      boundAction: a.bound_action,
      boundSignal: a.bound_signal,
      failReason: a.fail_reason,
      expiresAt: a.expires_at,
      remainingMs: Math.max(0, a.expires_at - now),
      // T-3.3: the four stages, straight from the row.
      stages: {
        requested: a.requested_at,
        completed: a.completed_at,
        verified: a.verified_at,
        executed: a.executed_at,
      },
    })),
    transfers: {
      ...transferSummary(event.id),
      items: transfers.map((t) => ({
        id: t.id,
        slotId: t.slot_id,
        from: t.from_continuity_id,
        fromShort: shortId(t.from_continuity_id),
        to: t.to_continuity_id || null,
        toShort: t.to_continuity_id ? shortId(t.to_continuity_id) : null,
        state: t.state,
        openedAt: t.opened_at,
        expiresAt: t.expires_at,
        remainingMs: t.expires_at ? Math.max(0, t.expires_at - now) : null,
        attemptCount: t.attempt_count,
        lastRejectReason: t.last_reject_reason,
      })),
    },
    inbound: inboundTable(event.id).map((r) => ({
      continuityId: r.continuity_id,
      short: shortId(r.continuity_id),
      count: r.count,
      cap: r.cap,
    })),
    humans: {
      total: (getDb().prepare(`SELECT COUNT(*) AS n FROM human`).get() as { n: number }).n,
      distinctInQueue: new Set(entries.map((e) => e.continuity_id)).size,
    },
    drawVerification: verifyDrawIntegrity(event),
    security: securityPanel(),
    audit: auditRows.map((r) => ({
      id: r.id,
      type: r.type,
      severity: r.severity,
      at: r.at,
      continuityShort: r.continuity_id ? shortId(r.continuity_id) : null,
      slotId: r.slot_id,
      payload: safeParse(r.payload),
    })),
    highlight,
  };
}

export type BoardState = ReturnType<typeof boardState>;

function earliestJoin(eventId: string): number {
  const row = getDb()
    .prepare(`SELECT MIN(joined_at) AS t FROM queue_entry WHERE event_id = ?`)
    .get(eventId) as { t: number | null };
  return row.t ?? Date.now();
}

function deriveHighlight(
  auditRows: ReturnType<typeof recentAudit>,
  transitions: ReturnType<typeof sweep>,
  slots: ReturnType<typeof listSlots>,
): BoardHighlight {
  const newest = transitions[transitions.length - 1];
  if (newest) {
    return {
      kind:
        newest.kind === 'lottery_settled'
          ? 'draw'
          : newest.kind === 'transfer_expired'
            ? 'rejection'
            : newest.kind === 'deferred' || newest.kind === 'approval_expired'
              ? 'deferral'
              : 'allocation',
      at: newest.at,
      slotId: newest.slotId,
      continuityId: newest.continuityId ?? null,
      message: newest.message,
    };
  }

  const rejection = auditRows.find((r) => REJECTION_TYPES.has(r.type));
  const deferral = auditRows.find((r) => DEFERRAL_TYPES.has(r.type));

  // Prefer whichever happened most recently, so the board flashes the freshest
  // thing rather than always the same category.
  const pick = [rejection, deferral]
    .filter(Boolean)
    .sort((a, b) => (b!.at ?? 0) - (a!.at ?? 0))[0];

  if (pick) {
    const payload = safeParse(pick.payload);
    return {
      kind: REJECTION_TYPES.has(pick.type) ? 'rejection' : 'deferral',
      at: pick.at,
      slotId: pick.slot_id,
      continuityId: pick.continuity_id,
      message: String(payload.message ?? payload.reason ?? pick.type),
      code: typeof payload.code === 'string' ? payload.code : undefined,
    };
  }

  const allocated = slots.find((s) => s.state === 'ALLOCATED');
  if (allocated) {
    return {
      kind: 'allocation',
      at: allocated.updated_at,
      slotId: allocated.id,
      continuityId: allocated.holder_continuity_id,
      message: 'slot allocated — waiting for the human',
    };
  }

  return { kind: 'none', at: Date.now(), slotId: null, continuityId: null, message: '' };
}

/**
 * Draw-integrity panel.
 *
 * Recomputes the order from the stored seed and compares it with the ranks in
 * the database. If `joined_at` had leaked into the ordering, this is where it
 * would show up. It is on the board because "the draw is fair" is a claim that
 * should be checkable live, not a sentence in a slide.
 */
function verifyDrawIntegrity(event: EventRow) {
  if (event.lottery_drawn_at === null || !event.lottery_seed) {
    return { settled: false as const, matches: null, checked: 0, seed: null };
  }
  const recomputed = recomputeDrawOrder(event.id);
  const stored = listQueue(event.id).map((e) => ({ entryId: e.id, rank: e.lottery_rank ?? 0 }));
  const storedById = new Map(stored.map((s) => [s.entryId, s.rank]));
  const matches = recomputed.every((r) => storedById.get(r.entryId) === r.rank);
  return {
    settled: true as const,
    matches,
    checked: recomputed.length,
    seed: event.lottery_seed,
    algorithm: 'rank = order_by(sha256(lottery_seed || entry_id))',
  };
}

function securityPanel() {
  const consumed = getDb().prepare(`SELECT COUNT(*) AS n FROM consumed_proof`).get() as { n: number };
  const refusals = getDb()
    .prepare(
      `SELECT type, COUNT(*) AS n FROM audit_event
        WHERE type IN ('gate.refused','approval.rejected_at_gate','transfer.rejected',
                       'transfer.refused_inbound_cap','attack.blocked','slot.deferral')
        GROUP BY type`,
    )
    .all() as { type: string; n: number }[];
  const executions = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM audit_event WHERE type IN ('slot.confirmed','transfer.completed')`,
    )
    .get() as { n: number };

  return {
    consumedProofs: consumed.n,
    protectedActionsExecuted: executions.n,
    refusals: Object.fromEntries(refusals.map((r) => [r.type, r.n])),
    totalRefusals: refusals.reduce((sum, r) => sum + r.n, 0),
  };
}

export function shortId(continuityId: string): string {
  return continuityId.replace(/^cid_/, '').slice(0, 8);
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}
