/**
 * Seed the demo event.
 *
 * The event itself — slots, windows, mode — is defined once in `lib/demo.ts`,
 * because the running app needs it too: `instrumentation.ts` calls
 * `ensureDemoEventIfMissing()` so a container on a fresh volume has a working
 * demo without anyone running a command, and the public site copies every
 * visitor's private event from that template (`lib/sandbox.ts`). Two
 * definitions would eventually disagree, and the symptom would be a deployment
 * whose windows do not match the runbook.
 *
 * Idempotent: re-running updates the configuration of the existing event rather
 * than creating a second one, so `npm run seed` is always safe.
 */
import { DEMO_CONFIG, DEMO_EVENT_ID, ensureDemoEvent } from '../lib/demo';

function main(): void {
  const result = ensureDemoEvent();

  for (const reason of result.reasons) console.log(`· ${reason}`);
  console.log(`· slots: ${result.totalSlots} total (${result.slotsAdded} added)`);
  console.log('');
  console.log('  demo configuration');
  console.log('    slots                 locked to their holder — no transfers');
  console.log(`    lottery mode          ${DEMO_CONFIG.lotteryMode}`);
  console.log(`    lottery window        ${DEMO_CONFIG.lotteryWindowSec}s`);
  console.log(`    approval window       ${DEMO_CONFIG.approvalWindowSec}s`);
  console.log(`    event id              ${DEMO_EVENT_ID}`);
  console.log('');
  console.log('  next: ENABLE_DEV_ROUTES=1 npm run dev    (dev routes power the demo props)');
  console.log('');
}

main();
