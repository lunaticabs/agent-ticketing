import { json, route } from '@/lib/api';
import { getEvent } from '@/lib/humans';
import { recycleSandbox, resolveEvent, sandboxEnabled, sandboxStats } from '@/lib/sandbox';
import { assertDevRoutes } from '@/lib/devmode';

/**
 * ============================================================================
 *  The visitor's own demo
 * ============================================================================
 *
 * A private event is handed out by `middleware.ts` on first contact, so most
 * callers never need this route. It exists for the two questions the UI has to
 * ask and the middleware cannot answer:
 *
 *   GET  — "which event am I looking at, and is there anything left to do?"
 *   POST — "give me a fresh round."
 *
 * The POST is what makes the public site playable. A visitor's draw closes after
 * fifteen seconds and their eight slots are gone with it; without a way back
 * they would be left looking at a finished event and reasonably conclude the
 * site is broken. Recycling is a demo affordance, so it is gated on
 * `ENABLE_DEV_ROUTES` — the same switch as the rest of the `/admin` surface —
 * and it only ever touches an event with `sandbox = 1`. The seeded stage event
 * is never recyclable through HTTP.
 */
export const GET = route(async (req) => {
  const event = resolveEvent(req);
  return json({
    ok: true,
    enabled: sandboxEnabled(),
    event: {
      id: event.id,
      name: event.name,
      slots: event.total_slots,
      lotteryDrawn: event.lottery_drawn_at !== null,
      approvalWindowSec: event.approval_window_sec,
      lotteryWindowSec: event.lottery_window_sec,
    },
    stats: sandboxStats(),
  });
});

export const POST = route(async (req) => {
  assertDevRoutes();
  const event = resolveEvent(req);

  if (!sandboxEnabled()) {
    return json(
      {
        ok: false,
        code: 'sandbox_disabled',
        message: 'this deployment runs a single shared event; there is no private demo to recycle',
      },
      { status: 404 },
    );
  }
  if (event.sandbox !== 1) {
    // Deliberately refused rather than silently ignored: recycling the seeded
    // event would wipe the stage demo that the whole runbook is written around.
    return json(
      {
        ok: false,
        code: 'not_a_sandbox',
        message: 'this event is the shared demo event and cannot be recycled here',
      },
      { status: 403 },
    );
  }

  const result = recycleSandbox(event.id);
  const after = getEvent(event.id)!;
  return json({
    ok: true,
    ...result,
    eventId: after.id,
    slots: after.total_slots,
    note: 'a fresh draw window; the previous round is gone',
  });
});
