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
import { openApprovalViews } from '../lib/approval';
import { requestClaimApproval } from '../lib/gate';
import { HumanGateError } from '../lib/errors';

async function refuses(code: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.equal((err as HumanGateError).code, code, `expected refusal "${code}"`);
    return;
  }
  assert.fail(`expected a refusal with code "${code}", but the call succeeded`);
}

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

// ════════════════════════════════════════════════════════════════════════════
//  The console and the board must not disagree about the same slot
// ════════════════════════════════════════════════════════════════════════════

test('X-3 — an authorization stops being "open" when its slot is released', async () => {
  // Reported as a pure front-end problem, and it was: the participant console
  // went on showing "your slot" with a live countdown while the board showed the
  // slot back in the pool. The console was reading an approval row that stayed
  // PENDING after its slot had been deferred away, so one slot had two truths.
  reset();
  const event = freshEvent({ slots: 1, approvalWindowSec: 60 });
  const alice = human('x-open-alice');
  joinQueue(event.id, alice);
  settleLottery(event.id);
  sweep(event.id);

  const slotId = listSlots(event.id)[0].id;
  const requested = await requestClaimApproval(event.id, alice);
  assert.equal(requested.target.slotId, slotId, 'the authorization is bound to the allocated slot');

  const open = await openApprovalViews(alice);
  assert.equal(open.length, 1, 'while the slot is held, the question is open');
  assert.equal(open[0].state, 'PENDING');

  // The window lapses: the slot is released and deferred.
  getDb().prepare(`UPDATE slot SET approval_deadline = ? WHERE id = ?`).run(Date.now() - 1000, slotId);
  sweep(event.id);
  assert.notEqual(slotRow(event.id, slotId).holder_continuity_id, alice, 'the slot moved on');

  const after = await openApprovalViews(alice);
  assert.equal(
    after.length,
    0,
    'the console must not keep rendering a slot the board has already released',
  );

  const retired = getDb()
    .prepare(`SELECT state, fail_reason FROM approval WHERE id = ?`)
    .get(requested.approvalId) as { state: string; fail_reason: string | null };
  assert.equal(retired.state, 'EXPIRED', 'and the stale row is retired, not left PENDING forever');
  assert.match(String(retired.fail_reason), /slot was released/);
});

test('X-4 — a retirement does not block the human from asking again', async () => {
  // Retiring matters for more than tidiness: one outstanding approval per slot is
  // the rule, so a row left PENDING for a slot that no longer exists would refuse
  // every future attempt on behalf of a question nobody can answer.
  reset();
  const event = freshEvent({ slots: 1, approvalWindowSec: 60 });
  const alice = human('x-again-alice');
  joinQueue(event.id, alice);
  settleLottery(event.id);
  sweep(event.id);

  const slotId = listSlots(event.id)[0].id;
  await requestClaimApproval(event.id, alice);
  getDb().prepare(`UPDATE slot SET approval_deadline = ? WHERE id = ?`).run(Date.now() - 1000, slotId);
  sweep(event.id);
  await openApprovalViews(alice);

  // She is not a candidate any more — `allocated_at` marks her served, which is
  // the rule that stops one person being handed the same slot twice. So asking
  // again refuses for a *different*, and correct, reason:
  await refuses('deferred_to_next_candidate', () => requestClaimApproval(event.id, alice));

  // The point of retiring the row: the queue is hers to re-enter, and a fresh
  // authorization is issuable then. A stale PENDING row for a slot that no longer
  // exists would have refused this on behalf of a question nobody could answer.
  getDb().prepare(`DELETE FROM queue_entry WHERE event_id = ? AND continuity_id = ?`).run(event.id, alice);
  // A settled draw refuses new entries — that rule is the whole point of the
  // window — so reopening it is the honest way back in.
  getDb().prepare(`UPDATE event SET lottery_drawn_at = NULL WHERE id = ?`).run(event.id);
  joinQueue(event.id, alice);
  settleLottery(event.id);
  sweep(event.id);
  ensureSlots(event.id, 1);
  sweep(event.id);

  const again = await requestClaimApproval(event.id, alice);
  assert.ok(again.approvalId, 'a fresh authorization must be issuable');
});
