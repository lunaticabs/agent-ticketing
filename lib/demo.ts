/**
 * ============================================================================
 *  The demo event, defined once
 * ============================================================================
 *
 * Two callers need this and they must not disagree:
 *
 *   * `db/seed.ts` — the explicit `npm run seed` / `npm run reset`.
 *   * `ensureDemoEvent()` — started once per process (`instrumentation.ts`), so
 *     a container with a fresh volume has a working demo without anyone having
 *     to remember a command. That is the whole point: on the public site the
 *     seeded event is the *template* every visitor's private event is copied
 *     from (`lib/sandbox.ts`), so a deployment where nobody ran the seed would
 *     serve private demos built from hardcoded fallbacks instead of the
 *     windows the runbook describes.
 *
 * It lives in its own module because `db/seed.ts` imports `lib/sandbox.ts`
 * through the next chain along, and a cycle between "the seed" and "the thing
 * that creates sandboxes" is the kind of thing that works until it does not.
 *
 * The window values are SHORT ON PURPOSE (T-6.1): a 15-second draw window and a
 * 90-second approval window are long enough to be legible on a projector and
 * short enough to watch a deferral happen live — and on the public site, short
 * enough that a visitor's round finishes while they are still looking at it.
 */
import { getDb, tx } from './db';
import { audit } from './audit';
import { createEvent, getEvent, seedEventTemplate, updateEvent } from './humans';
import { ensureSlots } from './slots';

export const DEMO_EVENT_ID = 'evt_tokyo_night';

export const DEMO_CONFIG = {
  name: 'Tokyo Night — Human Continuity Tour',
  totalSlots: 8,
  /** T-6.1: 90s, not the 120s default, so a deferral fits inside a demo beat. */
  approvalWindowSec: 90,
  /** T-6.1: 15s, so the draw settles while the audience is still watching. */
  lotteryWindowSec: 15,
  lotteryMode: 'lottery' as const,
};

export interface SeedResult {
  created: boolean;
  slotsAdded: number;
  totalSlots: number;
  /** True when this call created the event, so a caller can say so out loud. */
  reasons: string[];
}

/**
 * Create or refresh the demo event. Idempotent: re-running updates the
 * configuration of the existing event rather than creating a second one, so it
 * is safe on every boot.
 */
export function ensureDemoEvent(): SeedResult {
  const reasons: string[] = [];
  const existing = getEvent(DEMO_EVENT_ID);

  if (existing) {
    updateEvent(DEMO_EVENT_ID, DEMO_CONFIG);
    reasons.push(`event ${DEMO_EVENT_ID} already exists — configuration refreshed`);
  } else {
    createEvent({ id: DEMO_EVENT_ID, ...DEMO_CONFIG });
    reasons.push(`created event ${DEMO_EVENT_ID}`);
  }

  const slotsAdded = ensureSlots(DEMO_EVENT_ID, DEMO_CONFIG.totalSlots);
  const total = (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM slot WHERE event_id = ?`)
      .get(DEMO_EVENT_ID) as { n: number }
  ).n;

  return { created: !existing, slotsAdded, totalSlots: total, reasons };
}

/**
 * The missing-event check, run at startup.
 *
 * Deliberately NOT "seed on every boot". A database that has been through
 * `npm run reset` and had its event removed on purpose must stay that way —
 * silently recreating it would fight the operator. This only acts when there is
 * no seeded event at all, which is a database that has never been set up.
 */
export function ensureDemoEventIfMissing(): SeedResult | null {
  try {
    if (seedEventTemplate()) return null;
    return tx(() => {
      const result = ensureDemoEvent();
      audit({
        type: 'demo.seeded',
        eventId: DEMO_EVENT_ID,
        severity: 'info',
        payload: { reason: 'no seeded event found at startup', slots: result.totalSlots },
      });
      return result;
    });
  } catch (err) {
    // A startup hook must never be the reason a deployment stops serving. The
    // banner and `/api/health` both report the state, so an operator finds out
    // there instead of from a container that will not boot.
    console.error('[humangate] could not ensure the demo event:', err);
    return null;
  }
}

/** The seeded event row, or undefined when nothing has been seeded. */
export function seedEvent(): ReturnType<typeof getEvent> {
  return getEvent(DEMO_EVENT_ID);
}
