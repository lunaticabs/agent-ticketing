import { json, route, readJson } from '@/lib/api';
import { assertDevRoutes } from '@/lib/devmode';
import { getEvent, updateEvent, primaryEvent } from '@/lib/humans';
import { audit } from '@/lib/audit';

/**
 * T-6.3 — the organiser's knobs.
 *
 * The lottery-mode switch and the three windows. The transfer-policy knob that
 * used to live here is gone with the transfer engine: there is exactly one
 * circulation policy now, so there is nothing to switch.
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
  if (body.lotteryMode === 'lottery' || body.lotteryMode === 'fcfs') {
    patch.lottery_mode = body.lotteryMode;
  }
  for (const key of ['approval_window_sec', 'lottery_window_sec', 'total_slots'] as const) {
    const value = body[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      (patch as Record<string, unknown>)[key] = Math.max(1, Math.floor(value));
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
      lotteryMode: after.lottery_mode,
      approvalWindowSec: after.approval_window_sec,
      lotteryWindowSec: after.lottery_window_sec,
      totalSlots: after.total_slots,
    },
    note: 'Existing slots and audit rows are untouched.',
  });
});

function summarise(e: ReturnType<typeof getEvent>) {
  if (!e) return null;
  return {
    lotteryMode: e.lottery_mode,
    approvalWindowSec: e.approval_window_sec,
    lotteryWindowSec: e.lottery_window_sec,
  };
}
