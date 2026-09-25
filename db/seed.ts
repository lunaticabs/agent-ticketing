/**
 * Seed the demo event.
 *
 * The window values are SHORT ON PURPOSE (T-6.1): "否则现场等 10 分钟没法演".
 * A 15-second draw window and a 90-second approval window are long enough to be
 * legible on a projector and short enough to watch a deferral happen live.
 *
 * Idempotent: re-running updates the configuration of the existing event rather
 * than creating a second one, so `npm run seed` is always safe.
 */
import { getDb } from '../lib/db';
import { createEvent, getEvent, updateEvent } from '../lib/humans';
import { ensureSlots } from '../lib/slots';

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

function main(): void {
  const db = getDb();
  const existing = getEvent(DEMO_EVENT_ID);

  if (existing) {
    updateEvent(DEMO_EVENT_ID, DEMO_CONFIG);
    console.log(`· event ${DEMO_EVENT_ID} already exists — configuration refreshed`);
  } else {
    createEvent({ id: DEMO_EVENT_ID, ...DEMO_CONFIG });
    console.log(`· created event ${DEMO_EVENT_ID}`);
  }

  const added = ensureSlots(DEMO_EVENT_ID, DEMO_CONFIG.totalSlots);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM slot WHERE event_id = ?`).get(DEMO_EVENT_ID) as {
    n: number;
  }).n;

  console.log(`· slots: ${total} total (${added} added)`);
  console.log('');
  console.log('  demo configuration');
  console.log('    slots                 locked to their holder — no transfers');
  console.log(`    lottery mode          ${DEMO_CONFIG.lotteryMode}`);
  console.log(`    lottery window        ${DEMO_CONFIG.lotteryWindowSec}s`);
  console.log(`    approval window       ${DEMO_CONFIG.approvalWindowSec}s`);
  console.log('');
  console.log('  next: ENABLE_DEV_ROUTES=1 npm run dev    (dev routes power the demo props)');
  console.log('');
}

main();
