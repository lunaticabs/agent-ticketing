/**
 * ============================================================================
 *  Two failures with the same root cause: an answer was already determined,
 *  and the code kept asking.
 * ============================================================================
 *
 * Both of these were found on the public deployment, by a person using it, and
 * neither is reproducible from the unit suite's fixtures alone — which is why
 * they are written out here with the *shape* of the payload that produced them.
 *
 *   1. The agent's draw wait polled for its full ninety-second budget after the
 *      draw had already settled without allocating it a slot. The window never
 *      reopens on its own, so no later poll could change the answer; the panel
 *      showed "waiting for the draw" and a visitor read it as a hang.
 *
 *   2. Asking for a purchase authorization a second time stacked a second
 *      PENDING approval instead of refusing. The console renders
 *      `openApprovals[0]`, so the stack hid every refusal behind the first
 *      entry: whatever you pressed, the screen said "waiting for you to
 *      approve", and the failure modes this demo exists to show became
 *      unreachable.
 */
import './setup';
import test from 'node:test';
import assert from 'node:assert/strict';

import { freshEvent, getDb, human, purchase, queueAndDraw, reset } from './harness';
import { PresenceError } from '../lib/errors';
import { requestClaimApproval } from '../lib/gate';
import { allocationOutcome } from '../lib/mcpagent';
import { syncApproval } from '../lib/approval';
import { joinQueue } from '../lib/queue';
import { fastForward, resetDemo } from '../lib/devmode';
import { ensureSlots, sweep } from '../lib/slots';

// ════════════════════════════════════════════════════════════════════════════
//  1. The agent stops waiting once the draw is settled
// ════════════════════════════════════════════════════════════════════════════

/** The `queue.status` payload for a live window this human is merely waiting in. */
const STILL_WAITING = {
  ok: true,
  event: { lotteryDrawn: false },
  lottery: { open: true, drawn: false },
  allocation: [],
};

test('W-1 — a settled draw with no allocation is an answer, not a reason to wait', () => {
  // The exact payload the deployed server returned after the draw closed and
  // the slot went to a higher rank: `ok: true`, no allocation, drawn: true.
  const outcome = allocationOutcome({
    ok: true,
    event: { lotteryDrawn: true },
    lottery: { open: false, drawn: true },
    allocation: [],
  });

  assert.equal(outcome.kind, 'settled', 'this must terminate the wait immediately');
  if (outcome.kind === 'settled') {
    assert.match(outcome.reason, /draw was settled/, 'and say which of the two closed-window cases it is');
  }
});

test('W-2 — an open window with no allocation yet is still worth waiting for', () => {
  // The distinction that matters: `drawn: false` means the answer is genuinely
  // unknown, so the budget is deserved.
  assert.equal(allocationOutcome(STILL_WAITING).kind, 'waiting');
});

test('W-3 — an allocation ends the wait, and the slot is carried out', () => {
  const outcome = allocationOutcome({
    ok: true,
    event: { lotteryDrawn: true },
    allocation: [{ slotId: 'slot_7', remainingMs: 42_000 }],
  });

  assert.equal(outcome.kind, 'allocated');
  if (outcome.kind === 'allocated') {
    assert.equal(outcome.slotId, 'slot_7');
    assert.equal(outcome.remainingMs, 42_000);
  }
});

test('W-4 — a deferral refusal ends the wait with its own reason', () => {
  const outcome = allocationOutcome({
    ok: false,
    code: 'deferred_to_next_candidate',
    allocation: [],
  });

  assert.equal(outcome.kind, 'settled');
  if (outcome.kind === 'settled') {
    assert.match(outcome.reason, /moved to the next candidate/);
  }
});

test('W-5 — a payload with no event block keeps waiting rather than guessing', () => {
  // An older or partial payload must not be read as "settled": stopping early
  // would report a closed draw that is actually still open.
  assert.equal(allocationOutcome({ ok: true, allocation: [] }).kind, 'waiting');
  assert.equal(allocationOutcome({}).kind, 'waiting');
});

// ════════════════════════════════════════════════════════════════════════════
//  2. A repeated request does not stack a second pending approval
// ════════════════════════════════════════════════════════════════════════════

function pendingCount(eventId: string, continuityId: string): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM approval
          WHERE event_id = ? AND continuity_id = ? AND state = 'PENDING'`,
      )
      .get(eventId, continuityId) as { n: number }
  ).n;
}

test('W-6 — asking twice yields one pending approval and a refusal that names it', async () => {
  reset();
  const event = freshEvent({ slots: 1, approvalWindowSec: 60 });
  queueAndDraw(event.id, ['stack-alice']);
  const alice = human('stack-alice');

  const first = await requestClaimApproval(event.id, alice);
  assert.equal(pendingCount(event.id, alice), 1, 'the first request is pending');

  // This is what a second button press did before the fix: minted another one.
  let refusal: PresenceError | null = null;
  try {
    await requestClaimApproval(event.id, alice);
  } catch (err) {
    refusal = err as PresenceError;
  }

  assert.ok(refusal, 'a second request must not silently succeed');
  assert.equal(refusal.code, 'approval_already_pending');
  assert.equal(refusal.httpStatus, 409, 'a conflict, not a bad request');
  assert.equal(
    (refusal.details as { approvalId?: string } | undefined)?.approvalId,
    first.approvalId,
    'and it must point at the approval already on the human’s phone',
  );
  assert.equal(
    pendingCount(event.id, alice),
    1,
    'the stack is the bug: the console renders openApprovals[0], so a second ' +
      'pending entry hides every refusal behind the first',
  );
});

test('W-7 — once the outstanding approval is answered, asking again is allowed', async () => {
  reset();
  const event = freshEvent({ slots: 1, approvalWindowSec: 60 });
  queueAndDraw(event.id, ['answered-bob']);
  const bob = human('answered-bob');

  // The full path: request, approve, execute. After this the human holds a slot,
  // so a further request refuses for a *different* and more interesting reason.
  await purchase(event.id, bob);
  assert.equal(pendingCount(event.id, bob), 0, 'nothing is left pending after a completed purchase');

  let refusal: PresenceError | null = null;
  try {
    await requestClaimApproval(event.id, bob);
  } catch (err) {
    refusal = err as PresenceError;
  }
  assert.ok(refusal, 'a human who already holds a slot cannot buy a second');
  assert.equal(
    refusal.code,
    'already_owns_entitlement',
    'this is the failure mode the demo is supposed to be able to show',
  );
});

test('W-8 — an approval whose window has passed does not block the next attempt', async () => {
  reset();
  const event = freshEvent({ slots: 1, approvalWindowSec: 60 });
  queueAndDraw(event.id, ['expired-carol']);
  const carol = human('expired-carol');

  const first = await requestClaimApproval(event.id, carol);

  // Age the approval past its own expiry. The guard must retire it rather than
  // refuse the next request on behalf of something nobody can still answer —
  // otherwise "one outstanding approval" becomes "no way to ask again".
  getDb()
    .prepare(`UPDATE approval SET expires_at = ? WHERE id = ?`)
    .run(Date.now() - 1000, first.approvalId);

  const second = await requestClaimApproval(event.id, carol);
  assert.notEqual(second.approvalId, first.approvalId, 'a fresh authorization is issued');

  const retired = syncApproval(first.approvalId);
  void retired;
  const stale = getDb()
    .prepare(`SELECT state FROM approval WHERE id = ?`)
    .get(first.approvalId) as { state: string };
  assert.equal(stale.state, 'EXPIRED', 'and the stale one is explicitly retired, not left PENDING forever');
  assert.equal(pendingCount(event.id, carol), 1, 'exactly one live authorization remains');
});

// ════════════════════════════════════════════════════════════════════════════
//  3. Fast-forwarding a wait must not destroy what the wait produced
// ════════════════════════════════════════════════════════════════════════════

/**
 * The reported symptom: during an agent run, pressing "Fast-forward windows"
 * (which is meant to end the countdown) left the agent waiting on a phone
 * approval that could never help it.
 *
 * The cause was one operation doing two things that are only compatible by
 * accident. `fastForward` settled the draw — which *creates* allocations — and
 * then dragged every allocation deadline into the past, which destroys them
 * inside the same request. The agent polls every 1.5s, so by the time it looked,
 * its slot had been deferred away; it then requested an authorization for a slot
 * it no longer held.
 *
 * The stage beats never noticed because they read the allocation in the same
 * breath as the call — the window expires on the *next* sweep. A test that reads
 * the state immediately would keep passing with the bug in place, so these read
 * after a sweep.
 */
test('F-1 — ending the wait settles the draw and leaves the allocation standing', () => {
  reset();
  const event = freshEvent({ slots: 4, approvalWindowSec: 60 });
  const [alice] = queueAndDraw(event.id, ['ff-alice']);
  void alice;
  const id = human('ff-alice');

  // A live window the operator wants to skip: a queue with one entrant who has
  // not been served, and a draw that has not happened. `resetDemo` is the honest
  // way to get there — hand-written DELETEs left `allocated_at` behind, which
  // made the draw skip this human entirely and the test fail for its own reason.
  resetDemo({ eventId: event.id });
  joinQueue(event.id, id);
  assert.equal(
    (getDb().prepare(`SELECT lottery_drawn_at FROM event WHERE id = ?`).get(event.id) as { lottery_drawn_at: number | null }).lottery_drawn_at,
    null,
    'the window must be open before the fast-forward',
  );

  const result = fastForward({ eventId: event.id });

  assert.equal(result.drew, true, 'the draw was open, so it settles now');
  assert.equal(result.deferAllocations, false, 'and the destructive half is off by default');

  // The next sweep is where the old bug showed itself.
  sweep(event.id);

  const allocated = getDb()
    .prepare(`SELECT * FROM slot WHERE event_id = ? AND holder_continuity_id = ?`)
    .all(event.id, id) as { state: string; approval_deadline: number | null }[];

  assert.equal(allocated.length, 1, 'the human the draw reached must still hold their slot');
  assert.equal(allocated[0].state, 'ALLOCATED', 'and it must still be claimable, not deferred');
  assert.ok(
    (allocated[0].approval_deadline ?? 0) > Date.now(),
    'the approval window is a real one, so a human can still answer it',
  );
});

test('F-2 — asking for it explicitly still collapses the windows, for the deferral demo', () => {
  reset();
  const event = freshEvent({ slots: 4, approvalWindowSec: 60 });
  queueAndDraw(event.id, ['ff-defer']);
  const id = human('ff-defer');

  const result = fastForward({ eventId: event.id, deferAllocations: true });
  sweep(event.id);

  assert.equal(result.deferAllocations, true);
  const slot = getDb()
    .prepare(`SELECT * FROM slot WHERE event_id = ? AND holder_continuity_id = ?`)
    .get(event.id, id) as { state: string } | undefined;
  assert.ok(
    !slot || slot.state !== 'ALLOCATED',
    'the deferral demo is the one caller that wants the allocation gone',
  );
});
