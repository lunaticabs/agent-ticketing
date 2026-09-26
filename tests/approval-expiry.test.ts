/**
 * The approval window, measured rather than asserted from intent.
 *
 * Reported: "the countdown ended without authorization and they still kept the
 * slot". The state machine says the opposite — EXPIRED is transient, the slot
 * goes back to AVAILABLE and the next candidate gets it — so either the deadline
 * is not what the screen counts, or the sweep is not reading the clock it thinks
 * it is.
 */
import './setup';
import test from 'node:test';
import assert from 'node:assert/strict';

import { freshEvent, getDb, human, reset } from './harness';
import { joinQueue, settleLottery } from '../lib/queue';
import { ensureSlots, listSlots, sweep } from '../lib/slots';

function slotRow(eventId: string, slotId: string) {
  return getDb().prepare(`SELECT * FROM slot WHERE id = ?`).get(slotId) as {
    state: string;
    holder_continuity_id: string | null;
    approval_deadline: number | null;
    deferral_count: number;
  };
}

test('X-1 — what deadline does an allocated slot actually get?', () => {
  reset();
  const event = freshEvent({ slots: 1, approvalWindowSec: 60 });
  const alice = human('x-alice');
  joinQueue(event.id, alice);
  settleLottery(event.id);
  sweep(event.id);

  const slots = listSlots(event.id);
  const slot = slotRow(event.id, slots[0].id);
  const now = Date.now();

  console.log('   approval_window_sec   :', 60);
  console.log('   approval_deadline     :', slot.approval_deadline);
  console.log('   now                   :', now);
  console.log('   remaining (s)         :', slot.approval_deadline ? ((slot.approval_deadline - now) / 1000).toFixed(1) : 'null');
  console.log('   holder                :', slot.holder_continuity_id);

  assert.equal(slot.state, 'ALLOCATED');
  assert.ok(slot.approval_deadline, 'an allocated slot must carry a deadline');
  const remainingSec = (slot.approval_deadline! - now) / 1000;
  assert.ok(
    remainingSec > 55 && remainingSec <= 60,
    `the deadline must be approval_window_sec from now, got ${remainingSec.toFixed(1)}s`,
  );
});

test('X-2 — when the window lapses, the holder loses it and the next candidate gets it', () => {
  reset();
  const event = freshEvent({ slots: 1, approvalWindowSec: 60 });
  const alice = human('x-first');
  const bob = human('x-second');
  joinQueue(event.id, alice);
  joinQueue(event.id, bob);
  settleLottery(event.id);
  sweep(event.id);

  const slotId = listSlots(event.id)[0].id;
  const before = slotRow(event.id, slotId);
  assert.equal(before.state, 'ALLOCATED');
  const firstHolder = before.holder_continuity_id;
  assert.ok(firstHolder === alice || firstHolder === bob, 'the draw allocated it to one of them');

  // Push the deadline into the past, exactly as the clock would.
  getDb().prepare(`UPDATE slot SET approval_deadline = ? WHERE id = ?`).run(Date.now() - 1000, slotId);

  const transitions = sweep(event.id);
  const after = slotRow(event.id, slotId);

  console.log('   transitions:', transitions.map((t) => t.kind).join(', '));
  console.log('   holder before → after:', firstHolder?.slice(0, 12), '→', after.holder_continuity_id?.slice(0, 12));
  console.log('   deferral_count:', after.deferral_count);

  assert.notEqual(after.holder_continuity_id, firstHolder, 'the lapsed holder must not keep the slot');
  assert.equal(after.deferral_count, 1, 'and the deferral must be recorded');
  assert.equal(
    after.holder_continuity_id,
    firstHolder === alice ? bob : alice,
    'the other candidate must have been handed it',
  );
});
