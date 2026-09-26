/**
 * ============================================================================
 *  The public demo is many private demos — and they must not touch each other
 * ============================================================================
 *
 * Everything here is about one question: when the site is open to strangers,
 * can one visitor's button press change what another visitor sees? The stage
 * build never had to answer it, because there was one event and one operator.
 *
 * These are invariants, not features. `resetDemo` clearing every table was
 * correct with one event and becomes a cross-visitor data loss bug with many,
 * and the button that does it is on a page anyone can open — so the scoping is
 * asserted here rather than trusted.
 *
 * Sandboxing is off by default (`ENABLE_SANDBOX`), which is what keeps the rest
 * of the suite on the stage behaviour; this file turns it on for itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import './setup';
import { count, getDb, human, reset, seedEvent } from './harness';
import { joinQueue } from '../lib/queue';
import { resetDemo } from '../lib/devmode';
import { currentEventId, runWithEvent } from '../lib/eventcontext';
import { getEvent, primaryEvent } from '../lib/humans';
import {
  SANDBOX_COOKIE,
  collectGarbage,
  ensureSandbox,
  readSandboxCookie,
  recycleSandbox,
  sandboxCookieFor,
  sandboxEnabled,
  sandboxStats,
} from '../lib/sandbox';

process.env.ENABLE_SANDBOX = '1';
process.env.ENABLE_DEV_ROUTES = '1';

test('S-1 — the flag is what turns private events on, and it is on here', () => {
  assert.equal(sandboxEnabled(), true);
});

test('S-2 — a visitor gets their own event, seeded with slots and an open window', () => {
  reset();
  seedEvent(4);

  const first = ensureSandbox(null);
  const second = ensureSandbox(null);

  assert.notEqual(first.event.id, second.event.id, 'two visitors must not share one event');
  assert.equal(first.event.sandbox, 1, 'the visitor event is flagged as a sandbox');
  assert.equal(first.event.lottery_drawn_at, null, 'the draw window starts open');

  const slots = count(`SELECT COUNT(*) AS n FROM slot WHERE event_id = ?`, first.event.id);
  assert.equal(slots, first.event.total_slots, 'a private event arrives with its own inventory');
});

test('S-3 — the cookie names an event, and an edited cookie names nothing', () => {
  reset();
  seedEvent(4);
  const { event } = ensureSandbox(null);

  const cookie = sandboxCookieFor(event.id);
  assert.equal(cookie.name, SANDBOX_COOKIE);
  assert.equal(readSandboxCookie(cookie.value), event.id, 'a signed cookie round-trips');

  const [id] = cookie.value.split('.');
  assert.equal(readSandboxCookie(`${id}.forged`), null, 'a forged signature is refused');
  assert.equal(readSandboxCookie('evt_someone_elses_event.deadbeef'), null);
  assert.equal(readSandboxCookie(undefined), null);
  assert.equal(readSandboxCookie('no-dot-at-all'), null);
});

test('S-4 — a stale cookie is a new visitor, not an error', () => {
  reset();
  seedEvent(4);
  const { event } = ensureSandbox(null);
  const cookie = sandboxCookieFor(event.id).value;

  // The valuable case: the event was collected while the visitor was away.
  getDb().prepare(`DELETE FROM event WHERE id = ?`).run(event.id);

  const again = ensureSandbox(readSandboxCookie(cookie));
  assert.notEqual(again.event.id, event.id);
  assert.equal(again.created, true, 'a visitor whose event is gone gets a new one');
  assert.equal(getEvent(again.event.id)?.sandbox, 1);
});

test('S-5 — `primaryEvent()` follows the request, and the seeded event is still reachable', () => {
  reset();
  const seeded = seedEvent(4);
  const visitor = ensureSandbox(null).event;

  assert.equal(primaryEvent().id, seeded.id, 'outside a request scope, the seeded event answers');

  const inside = runWithEvent({ eventId: visitor.id, kind: 'sandbox' }, () => primaryEvent().id);
  assert.equal(inside, visitor.id, 'inside a request scope, the visitor event answers');
  assert.equal(currentEventId(), null, 'and the scope does not leak past the callback');
});

test('S-6 — one visitor resetting their demo does not touch anyone else', () => {
  reset();
  const seeded = seedEvent(4);
  const a = ensureSandbox(null).event;
  const b = ensureSandbox(null).event;

  // A stranger's finished round, and somebody else's live queue entry.
  joinQueue(a.id, human('a-visitor'));
  joinQueue(seeded.id, human('stage-demo'));

  resetDemo({ eventId: b.id });

  assert.equal(
    count(`SELECT COUNT(*) AS n FROM queue_entry WHERE event_id = ?`, a.id),
    1,
    'visitor A still has their queue entry after visitor B pressed reset',
  );
  assert.equal(
    count(`SELECT COUNT(*) AS n FROM queue_entry WHERE event_id = ?`, seeded.id),
    1,
    'and the stage demo is untouched too',
  );
});

test('S-7 — resetting an event does not make it look abandoned', () => {
  reset();
  seedEvent(4);
  const visitor = ensureSandbox(null).event;
  joinQueue(visitor.id, human('a-visitor'));

  resetDemo({ eventId: visitor.id });

  // The heartbeat is an audit row; a scoped wipe that took it with it would let
  // the sweeper collect a session that is still being used.
  const beats = count(`SELECT COUNT(*) AS n FROM audit_event WHERE event_id = ? AND type = ?`, visitor.id, 'sandbox.touched');
  assert.ok(beats > 0, 'the liveness heartbeat survives a scoped reset');

  const collected = collectGarbage();
  assert.equal(getEvent(visitor.id) !== undefined, true, 'and the event is still alive');
  assert.equal(collected.deleted, 0, 'nothing was collected');
});

test('S-8 — an abandoned private event is collected, the seeded one never is', () => {
  reset();
  const seeded = seedEvent(4);
  const visitor = ensureSandbox(null).event;
  joinQueue(visitor.id, human('gone-visitor'));

  // Age the heartbeat past the TTL instead of waiting twelve hours.
  const longAgo = Date.now() - 13 * 60 * 60 * 1000;
  getDb().prepare(`UPDATE audit_event SET at = ? WHERE event_id = ?`).run(longAgo, visitor.id);
  getDb().prepare(`UPDATE event SET created_at = ? WHERE id = ?`).run(longAgo, visitor.id);

  const result = collectGarbage();

  assert.equal(result.deleted, 1, 'exactly the abandoned private event was dropped');
  assert.equal(getEvent(visitor.id), undefined);
  assert.equal(
    count(`SELECT COUNT(*) AS n FROM queue_entry WHERE event_id = ?`, visitor.id),
    0,
    'ON DELETE CASCADE took its queue entries with it',
  );
  assert.notEqual(getEvent(seeded.id), undefined, 'the seeded stage event is not a collection candidate');
});

test('S-9 — recycling gives a visitor a fresh window, and only their own', () => {
  reset();
  const seeded = seedEvent(4);
  const visitor = ensureSandbox(null).event;
  const other = ensureSandbox(null).event;
  joinQueue(visitor.id, human('round-one'));
  joinQueue(other.id, human('somebody-else'));

  // Spent: draw settled, slot gone.
  getDb().prepare(`UPDATE event SET lottery_drawn_at = ? WHERE id = ?`).run(Date.now(), visitor.id);

  const result = recycleSandbox(visitor.id);
  const after = getEvent(visitor.id)!;

  assert.equal(result.recycled, true);
  assert.equal(after.lottery_drawn_at, null, 'the window is open again');
  assert.equal(count(`SELECT COUNT(*) AS n FROM queue_entry WHERE event_id = ?`, visitor.id), 0);
  assert.equal(
    count(`SELECT COUNT(*) AS n FROM slot WHERE event_id = ?`, visitor.id),
    after.total_slots,
    'inventory is rebuilt to the declared capacity',
  );
  assert.equal(
    count(`SELECT COUNT(*) AS n FROM queue_entry WHERE event_id = ?`, other.id),
    1,
    'the other visitor is untouched',
  );
  assert.equal(recycleSandbox(seeded.id).recycled, false, 'the stage event refuses to be recycled');
});

test('S-10 — health reports the number of live private events', () => {
  reset();
  seedEvent(4);
  ensureSandbox(null);
  ensureSandbox(null);

  const stats = sandboxStats();
  assert.equal(stats.enabled, true);
  assert.equal(stats.events, 2);
});
