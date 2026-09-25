import { json, route, readJson } from '@/lib/api';
import { assertDevRoutes } from '@/lib/devmode';
import { getEvent, updateEvent, primaryEvent } from '@/lib/humans';
import { audit } from '@/lib/audit';

/**
 * T-4.5 / T-6.3 — the organiser's knobs.
 *
 * One endpoint drives the policy switch, the lottery-mode switch and the three
 * windows, because "drag the slider and watch the same attack behave differently"
 * is the product argument. Changing the policy must not corrupt existing data,
 * and it does not: the policy is read at transfer time, never baked into a slot.
 */
export const POST = route(async (req) => {
  assertDevRoutes();
  const body = await readJson(req);
  const eventId = typeof body.eventId === 'string' ? body.eventId : primaryEvent().id;
  const before = getEvent(eventId);
  if (!before) {
    return json({ ok: false, code: 'event_not_found', message: `no event ${eventId}` }, { status: 404 });
  }

  const patch: Parameters<typeof updateEvent>[1] = {};
  if (body.policy === 'locked' || body.policy === 'gift' || body.policy === 'open') {
    patch.policy = body.policy;
  }
  if (body.lotteryMode === 'lottery' || body.lotteryMode === 'fcfs') {
    patch.lottery_mode = body.lotteryMode;
  }
  for (const key of ['approval_window_sec', 'lottery_window_sec', 'transfer_window_sec', 'transfer_inbound_cap', 'total_slots'] as const) {
    const value = body[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      (patch as Record<string, unknown>)[key] = Math.max(key === 'transfer_inbound_cap' ? 0 : 1, Math.floor(value));
    }
  }

  const after = updateEvent(eventId, patch);

  audit({
    type: 'event.reconfigured',
    eventId,
    severity: 'warn',
    payload: { before: summarise(before), after: summarise(after) },
  });

  return json({
    ok: true,
    event: {
      id: after.id,
      name: after.name,
      policy: after.policy,
      lotteryMode: after.lottery_mode,
      approvalWindowSec: after.approval_window_sec,
      lotteryWindowSec: after.lottery_window_sec,
      transferWindowSec: after.transfer_window_sec,
      transferInboundCap: after.transfer_inbound_cap,
      totalSlots: after.total_slots,
    },
    note: 'Existing slots, transfers and audit rows are untouched: the policy is evaluated at use time.',
  });
});

function summarise(e: ReturnType<typeof getEvent>) {
  if (!e) return null;
  return {
    policy: e.policy,
    lotteryMode: e.lottery_mode,
    approvalWindowSec: e.approval_window_sec,
    lotteryWindowSec: e.lottery_window_sec,
    transferWindowSec: e.transfer_window_sec,
    transferInboundCap: e.transfer_inbound_cap,
  };
}
