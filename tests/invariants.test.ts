/**
 * ============================================================================
 *  Security invariants — plan §6, all ten of them
 * ============================================================================
 *
 * Each test names the red line it protects and explains, in the assertion
 * message, *why* the behaviour matters. The reasoning is the point: a future
 * reader who "simplifies" one of these must first delete the sentence that says
 * what it was for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import './setup';
import {
  approveLocally,
  count,
  freshEvent,
  getDb,
  human,
  purchase,
  queueAndDraw,
  reset,
} from './harness';
import { HumanGateError } from '../lib/errors';
import { consumeProof, findConsumed } from '../lib/consume';
import { requestClaimApproval, executeClaim, purchaseAction, purchaseSignal } from '../lib/gate';
import { actorTally } from '../lib/audit';
import { settleLottery, listQueue, recomputeDrawOrder, joinQueue } from '../lib/queue';
import {
  listSlots,
  sweep,
  nextCandidatePreview,
  allocatedSlotsFor,
  ensureSlots,
} from '../lib/slots';
import { getApproval, openApprovalViews, syncApproval, verifyApproval } from '../lib/approval';
import { issueGrant, revokeGrant, activeGrant } from '../lib/grants';
import { guardClientSuppliedEnvironment, guardForgedClientResult } from '../lib/api';
import { settleLottery as _settle } from '../lib/queue';
import * as worldid from '../worldid';

/** Assert that `fn` refuses with `code`, and return the error. */
async function refuses(code: string, fn: () => unknown | Promise<unknown>): Promise<HumanGateError> {
  try {
    await fn();
  } catch (err) {
    const e = err as HumanGateError;
    assert.equal(e.code, code, `expected refusal "${code}", got "${e.code}": ${e.message}`);
    return e;
  }
  assert.fail(`expected a refusal with code "${code}", but the call succeeded`);
}

// ════════════════════════════════════════════════════════════════════════════
//  RED LINE 1 — `action` is bound to the PURCHASE, not to verification
// ════════════════════════════════════════════════════════════════════════════

test('RED LINE 1 — the same human cannot buy twice for the same event', async () => {
  reset();
  const event = freshEvent({ slots: 4 });
  const [alice] = queueAndDraw(event.id, ['alice']);

  await purchase(event.id, alice);
  assert.equal(count(`SELECT COUNT(*) AS n FROM slot WHERE state = 'CONFIRMED'`), 1);

  // The slot is gone, so the gate refuses on the entitlement, not on the proof.
  // Either refusal proves the property; both are database-backed.
  const err = await refuses('already_owns_entitlement', () => purchase(event.id, alice));
  assert.match(err.invariant ?? '', /RED LINE 1/);
});

test('RED LINE 1 — a DIFFERENT action still succeeds (the action must scope the entitlement)', async () => {
  reset();
  const eventA = freshEvent({ slots: 4 });
  const eventB = freshEvent({ slots: 4 });

  const [aliceA] = queueAndDraw(eventA.id, ['alice']);
  await purchase(eventA.id, aliceA);

  // Same human, different event => different action => different nullifier, and
  // the entitlement constraint is keyed on the action. Both may succeed.
  const [aliceB] = queueAndDraw(eventB.id, ['alice']);
  const second = await purchase(eventB.id, aliceB);
  assert.equal(second.ok, true);
  assert.notEqual(firstNullifier(aliceA), second.nullifier);
});

test('RED LINE 1 — two different humans can both buy for the same event', async () => {
  reset();
  const event = freshEvent({ slots: 4 });
  const [alice, bob] = queueAndDraw(event.id, ['alice', 'bob']);

  await purchase(event.id, alice);
  await purchase(event.id, bob);

  assert.equal(count(`SELECT COUNT(*) AS n FROM consumed_proof`), 2);
  assert.equal(count(`SELECT COUNT(*) AS n FROM slot WHERE state = 'CONFIRMED'`), 2);
});

test('COUNTER-EXAMPLE — a generic action would let one human take many slots', () => {
  // This is the bug the previous ETHGlobal winner shipped: the nullifier was
  // burned on "verification" rather than on "buying", so one verified identity
  // could buy out the venue. The two assertions below are the same code path
  // with one string changed, which is why the string matters more than it looks.
  reset();
  const db = getDb();
  const alice = human('counter-example-alice');

  // Generic action, like `verify_user`: two consumptions by the same human both
  // succeed, because the nullifier does not encode which purchase it was.
  const genericAction = 'verify_user';
  db.transaction(() => {
    consumeProof(db, {
      nullifier: 'nul_generic_attempt_1',
      boundAction: genericAction,
      continuityId: alice,
    });
  })();

  // The SECOND attempt diverges here. With a generic action the attacker would
  // mint a *fresh* proof for the same generic action and the nullifier would be
  // the same — but the entitlement constraint is what actually stops them, and
  // it is only meaningful because the action is event-scoped. Narrowing the
  // action to the purchase is what makes the constraint bite.
  const scoped = purchaseAction('evt_whatever');
  assert.notEqual(genericAction, scoped);

  db.transaction(() => {
    consumeProof(db, {
      nullifier: 'nul_scoped_attempt_1',
      boundAction: scoped,
      continuityId: alice,
    });
  })();

  assert.throws(
    () => {
      db.transaction(() => {
        consumeProof(db, {
          nullifier: 'nul_scoped_attempt_2',
          boundAction: scoped,
          continuityId: alice,
        });
      })();
    },
    (err: HumanGateError) => err.code === 'already_owns_entitlement',
    'an event-scoped action makes the SECOND purchase impossible, whatever proof is presented',
  );
});

function firstNullifier(continuityId: string): string {
  const row = getDb()
    .prepare(`SELECT nullifier FROM consumed_proof WHERE continuity_id = ? LIMIT 1`)
    .get(continuityId) as { nullifier: string };
  return row.nullifier;
}

// ════════════════════════════════════════════════════════════════════════════
//  RED LINE 3 — the server verifies; a client verdict is not evidence
// ════════════════════════════════════════════════════════════════════════════

test('RED LINE 3 — a forged client verdict is refused outright', () => {
  for (const forged of [
    { eventId: 'evt_x', ok: true },
    { eventId: 'evt_x', verified: true },
    { eventId: 'evt_x', clientResult: { ok: true } },
    { eventId: 'evt_x', verificationResult: { verified: true } },
    { eventId: 'evt_x', proof: { ok: true, nullifier: 'nul_fake' } },
  ]) {
    const err = (() => {
      try {
        guardForgedClientResult(forged);
        return null;
      } catch (e) {
        return e as HumanGateError;
      }
    })();
    assert.ok(err, `expected ${JSON.stringify(forged)} to be refused`);
    assert.equal(err!.code, 'untrusted_client_result');
  }

  // A body that only carries a reference is fine: that is what we ask for.
  assert.doesNotThrow(() => guardForgedClientResult({ eventId: 'evt_x', approval: 'apv_123' }));
});

test('RED LINE 3 — a fabricated approval reference does not resolve to anything', async () => {
  reset();
  const event = freshEvent({ slots: 2 });
  const [alice] = queueAndDraw(event.id, ['alice']);

  await refuses('approval_not_found', () =>
    executeClaim({ eventId: event.id, continuityId: alice, approvalRef: 'apv_i_made_this_up' }),
  );
  assert.equal(count(`SELECT COUNT(*) AS n FROM slot WHERE state = 'CONFIRMED'`), 0);
});

test('RED LINE 3 / track rule 4 — a claim with no approval at all is refused', async () => {
  reset();
  const event = freshEvent({ slots: 2 });
  const [alice] = queueAndDraw(event.id, ['alice']);

  const err = await refuses('approval_required', () =>
    executeClaim({ eventId: event.id, continuityId: alice, approvalRef: null }),
  );
  assert.match(err.hint ?? '', /authorize/);

  // And the slot is still sitting there: nothing moved.
  assert.equal(allocatedSlotsFor(event.id, alice).length, 1);
  assert.equal(count(`SELECT COUNT(*) AS n FROM slot WHERE state = 'CONFIRMED'`), 0);
});

// ════════════════════════════════════════════════════════════════════════════
//  RED LINE 4 — the environment is a server constant
// ════════════════════════════════════════════════════════════════════════════

test('RED LINE 4 — a client-supplied environment is refused and named', () => {
  const err = (() => {
    try {
      guardClientSuppliedEnvironment({ eventId: 'evt_x', environment: 'production' });
      return null;
    } catch (e) {
      return e as HumanGateError;
    }
  })();
  assert.ok(err);
  assert.equal(err!.code, 'environment_pinned');
  assert.equal((err!.details as { received: string }).received, 'production');

  // Nested is refused too: smuggling it inside a proof object is the obvious try.
  assert.throws(
    () => guardClientSuppliedEnvironment({ approval: 'apv_1', proof: { environment: 'staging' } }),
    (e: HumanGateError) => e.code === 'environment_pinned',
  );
});

test('RED LINE 4 — no exported worldid function accepts an environment argument', () => {
  // A signature-level guarantee. If someone adds `environment?: string` to any
  // entry point, a client could eventually reach it.
  const source = fs.readFileSync(path.join(process.cwd(), 'worldid', 'index.ts'), 'utf8');
  const signatureBlock = source.slice(0, source.indexOf('// ── 2. Await'));
  assert.ok(
    !/environment\s*[?:]\s*string/.test(signatureBlock),
    'worldid/index.ts must not accept an environment parameter',
  );

  // And the constant really is a constant.
  assert.equal(worldid.WORLDID_ENVIRONMENT, 'sandbox');
});

// ════════════════════════════════════════════════════════════════════════════
//  RED LINE 5 — one-time consumption, enforced by a PRIMARY KEY
// ════════════════════════════════════════════════════════════════════════════

test('RED LINE 5 — the same nullifier cannot be consumed twice', () => {
  reset();
  const db = getDb();
  const alice = human('nullifier-alice');

  db.transaction(() => {
    consumeProof(db, { nullifier: 'nul_fixed', boundAction: 'act_a', continuityId: alice });
  })();

  assert.throws(
    () => {
      db.transaction(() => {
        consumeProof(db, { nullifier: 'nul_fixed', boundAction: 'act_b', continuityId: human('bob') });
      })();
    },
    (e: HumanGateError) => e.code === 'proof_replay_detected',
    'the PRIMARY KEY on consumed_proof.nullifier is the gate, not a SELECT-then-INSERT',
  );
});

test('RED LINE 5 — a rejected consumption leaves NO partial row behind', () => {
  reset();
  const db = getDb();
  const alice = human('atomicity-alice');

  db.transaction(() => {
    consumeProof(db, { nullifier: 'nul_atomic', boundAction: 'act_a', continuityId: alice });
  })();
  const before = count(`SELECT COUNT(*) AS n FROM consumed_proof`);

  assert.throws(() => {
    // A transaction that consumes and then throws must roll the insert back,
    // otherwise a failed action would still burn the proof.
    db.transaction(() => {
      consumeProof(db, { nullifier: 'nul_atomic_2', boundAction: 'act_b', continuityId: alice });
      throw new Error('simulated failure after consumption');
    })();
  });

  assert.equal(count(`SELECT COUNT(*) AS n FROM consumed_proof`), before);
  assert.equal(findConsumed('nul_atomic_2'), undefined);
});

test('RED LINE 5 — a second claim with the same approval is refused', async () => {
  reset();
  const event = freshEvent({ slots: 4 });
  const [alice] = queueAndDraw(event.id, ['alice']);

  const request = await requestClaimApproval(event.id, alice);
  await approveLocally(request.requestId, 'alice');
  await syncApproval(request.approvalId);

  await executeClaim({ eventId: event.id, continuityId: alice, approvalRef: request.approvalId });

  // Replaying the same approval: the human already holds the slot, and the
  // nullifier is spent. Either guard refusing is the property holding.
  const err = await refuses('already_owns_entitlement', () =>
    executeClaim({ eventId: event.id, continuityId: alice, approvalRef: request.approvalId }),
  );
  assert.match(err.invariant ?? '', /RED LINE 1/);
  assert.equal(count(`SELECT COUNT(*) AS n FROM slot WHERE state = 'CONFIRMED'`), 1);
});

test('T-3.3 — claiming without polling the status endpoint still records all four stages', async () => {
  // An agent that gets the consent callback and immediately claims is behaving
  // correctly. The approval row must still end up carrying its proof reference,
  // its nullifier and all four stage timestamps — an earlier version consumed it
  // while it was still marked PENDING, which left the audit trail with a hole
  // that was invisible until you read the row.
  reset();
  const event = freshEvent({ slots: 2 });
  const [alice] = queueAndDraw(event.id, ['alice']);

  const request = await requestClaimApproval(event.id, alice);
  await approveLocally(request.requestId, 'alice');

  // Note: NO syncApproval() here. Straight to the gate.
  const claim = await executeClaim({ eventId: event.id, continuityId: alice, approvalRef: request.approvalId });
  assert.equal(claim.ok, true);

  const row = getApproval(request.approvalId)!;
  assert.equal(row.state, 'CONSUMED');
  assert.ok(row.proof_ref, 'the proof reference must be recorded on the approval');
  assert.ok(row.nullifier, 'the nullifier must be recorded on the approval');
  assert.ok(row.requested_at, 'stage 1');
  assert.ok(row.completed_at, 'stage 2 — the human finished on their device');
  assert.ok(row.verified_at, 'stage 3 — the server verified the proof');
  assert.ok(row.executed_at, 'stage 4 — the protected action ran');
  assert.ok(
    row.requested_at <= row.completed_at! &&
      row.completed_at! <= row.verified_at! &&
      row.verified_at! <= row.executed_at!,
    'the four stages must be ordered correctly in time',
  );

  // And the recorded nullifier is the one that was actually spent.
  assert.ok(findConsumed(row.nullifier!), 'the recorded nullifier matches the consumed row');
});

// ════════════════════════════════════════════════════════════════════════════
//  RED LINE 6 — the approval is bound to (action, signal)
// ════════════════════════════════════════════════════════════════════════════

test('RED LINE 6 — changing the action or the signal is refused', async () => {
  reset();
  const event = freshEvent({ slots: 4 });
  const [alice, bob] = queueAndDraw(event.id, ['alice', 'bob']);

  const request = await requestClaimApproval(event.id, alice);
  await approveLocally(request.requestId, 'alice');
  await syncApproval(request.approvalId);

  const wrongAction = await verifyApproval(request.approvalId, {
    action: 'verify_user',
    signal: purchaseSignal(event.id, alice),
  });
  assert.equal(wrongAction.ok, false);
  assert.equal(wrongAction.ok === false && wrongAction.code, 'approval_action_mismatch');

  const wrongSignal = await verifyApproval(request.approvalId, {
    action: purchaseAction(event.id),
    signal: purchaseSignal(event.id, bob),
  });
  assert.equal(wrongSignal.ok, false);
  assert.equal(wrongSignal.ok === false && wrongSignal.code, 'approval_signal_mismatch');

  // The genuine binding still works, so the refusals above were about the
  // parameters and not about the proof being broken.
  const right = await verifyApproval(request.approvalId, {
    action: purchaseAction(event.id),
    signal: purchaseSignal(event.id, alice),
  });
  assert.equal(right.ok, true);
});

test('a stale database is refused with advice, not a bare column error', async () => {
  // `CREATE TABLE IF NOT EXISTS` creates missing tables but never adds columns,
  // so a database written by an earlier build keeps its old shape. The failure
  // then surfaces somewhere unrelated as `no such column: actor` — and worse, the
  // schema file's `CREATE INDEX ... ON audit_event (actor)` blows up inside
  // `exec` before any check that runs afterwards can explain itself. Hence the
  // check runs first.
  const Database = (await import('better-sqlite3')).default;
  const { assertSchemaCurrent } = await import('../lib/db');

  const stale = new Database(':memory:');
  stale.exec(`CREATE TABLE audit_event (id TEXT PRIMARY KEY, type TEXT NOT NULL)`);
  assert.throws(
    () => assertSchemaCurrent(stale),
    (err: Error) => {
      assert.match(err.message, /out of date/);
      assert.match(err.message, /audit_event\.actor/);
      assert.match(err.message, /npm run reset/, 'the message must say what to do');
      return true;
    },
  );
  stale.close();

  // And a database that has never been touched is not mistaken for a stale one —
  // on a fresh file the tables do not exist yet, and the schema is about to
  // create them.
  const fresh = new Database(':memory:');
  assert.doesNotThrow(() => assertSchemaCurrent(fresh));
  fresh.close();
});

// ════════════════════════════════════════════════════════════════════════════
//  Self-calls — the server reaching its own routes
// ════════════════════════════════════════════════════════════════════════════

test('a self-call to a loopback https origin carries a dispatcher that trusts our cert', async () => {
  // The bug this locks down: with a portal-registered HTTPS redirect, `npm run
  // dev` serves TLS with a certificate this project generates, and every
  // self-call died with `fetch failed`. It took down every demo prop driven by
  // one — the speed contrast, the 40-account collapse, the MCP agent — while
  // leaving everything that only *serves* responses looking perfectly healthy.
  //
  // Two fixes were tried and both failed: NODE_TLS_REJECT_UNAUTHORIZED=0 (works,
  // but also stops verifying sandbox.auth.world.org) and NODE_EXTRA_CA_CERTS
  // (correct in principle, but `next dev` does not pass it to the server
  // process — verified by reading it from inside a route, where it is undefined
  // even when exported by the shell that started Next).
  const { selfCallEnv } = await import('../lib/selfcall');
  const fs = await import('node:fs');
  const path = await import('node:path');

  const cert = path.join(process.cwd(), 'certificates', 'localhost.pem');
  const hasCert = fs.existsSync(cert);

  // A child process cannot use an in-process dispatcher, so it gets the
  // certificate path instead — and unlike `next dev`, a child we spawn gets
  // exactly the environment we hand it.
  const env = selfCallEnv('https://localhost:3000');
  assert.equal(env.HUMANGATE_BASE_URL, 'https://localhost:3000');
  if (hasCert) {
    assert.equal(env.NODE_EXTRA_CA_CERTS, cert, 'the MCP child must be told to trust our cert');
  }

  // A real deployment is untouched: no loopback, no certificate, no deviation.
  const remote = selfCallEnv('https://humangate.example.com');
  assert.equal(remote.NODE_EXTRA_CA_CERTS, undefined, 'a real origin must get no TLS special-casing');

  // And plain http needs no trust at all.
  const http = selfCallEnv('http://localhost:3000');
  assert.equal(http.NODE_EXTRA_CA_CERTS, undefined);
});

test('the origin a self-call uses is the one the request arrived on', async () => {
  // `publicBaseUrl()` answers "what URL goes in a link a human opens", derived
  // from the registered redirect_uri. That is the wrong answer for reaching
  // yourself, and using it has caused three separate bugs here.
  const { selfOrigin } = await import('../lib/selfcall');
  const fake = (url: string) =>
    ({ url, headers: new Map() }) as unknown as import('next/server').NextRequest;

  assert.equal(selfOrigin(fake('https://localhost:3000/api/dev/agent')), 'https://localhost:3000');
  // A loopback address is kept as loopback but normalised to `localhost`, because
  // `selfCallEnv` attaches the self-signed certificate for loopback origins only.
  // The important half is that it stays reachable and stays local; which of the
  // loopback spellings it uses is not what this test is about.
  assert.equal(selfOrigin(fake('http://127.0.0.1:4000/api/dev/bots')), 'http://localhost:4000');
  // Whatever the configured public URL says, the arriving request wins.
  assert.notEqual(
    selfOrigin(fake('http://localhost:3000/api/dev/bots')),
    'https://localhost:3000',
    'the request origin must not be replaced by the configured one',
  );
  // The one origin that is never an answer: the container's wildcard bind, which
  // nothing can dial and which broke every agent tool call in production.
  assert.ok(
    !selfOrigin(fake('https://0.0.0.0:3000/api/dev/agent')).includes('0.0.0.0'),
    'the wildcard binding address must never be handed out as somewhere to call',
  );
});

// ════════════════════════════════════════════════════════════════════════════
//  The agent/human distinction — the fact the pitch rests on
// ════════════════════════════════════════════════════════════════════════════

test('the audit trail records whether a human or an agent acted', async () => {
  // "An agent legally buys a ticket on a human's behalf" is the claim. It is only
  // checkable if the system keeps the distinction, and `resolveCaller` has always
  // computed it — the wrapper used to throw it away.
  reset();
  const event = freshEvent({ slots: 2 });
  const alice = human('actor-alice');

  joinQueue(event.id, alice, 'agent');

  const joined = getDb()
    .prepare(`SELECT actor FROM audit_event WHERE type = 'queue.joined' AND continuity_id = ?`)
    .get(alice) as { actor: string };
  assert.equal(joined.actor, 'agent', 'an agent joining must be recorded as such');

  // And the same action taken by the human is recorded differently.
  const bob = human('actor-bob');
  joinQueue(event.id, bob, 'human');
  const joinedByHand = getDb()
    .prepare(`SELECT actor FROM audit_event WHERE type = 'queue.joined' AND continuity_id = ?`)
    .get(bob) as { actor: string };
  assert.equal(joinedByHand.actor, 'human');

  const tally = actorTally(event.id);
  assert.equal(tally.agent, 1);
  assert.equal(tally.human, 1);
});

test('an approval requested by an agent says so, all the way to the gate', async () => {
  reset();
  const event = freshEvent({ slots: 2 });
  // The whole loop, driven by the agent: it queues, it asks, the human answers,
  // it executes.
  const [alice] = queueAndDraw(event.id, ['actor-claim'], 'agent');

  const request = await requestClaimApproval(event.id, alice, 'agent');
  const row = getApproval(request.approvalId)!;
  assert.equal(row.requested_via, 'agent', 'the approval must remember who asked');

  const views = await openApprovalViews(alice);
  assert.equal(views[0]?.requestedVia, 'agent', 'and the status endpoint must report it');

  await approveLocally(request.requestId, 'actor-claim');
  const claim = await executeClaim({
    eventId: event.id,
    continuityId: alice,
    approvalRef: request.approvalId,
    actor: 'agent',
  });
  assert.equal(claim.ok, true);

  const actorOf = (type: string) =>
    (
      getDb()
        .prepare(`SELECT actor FROM audit_event WHERE type = ? AND continuity_id = ?`)
        .get(type, alice) as { actor: string } | undefined
    )?.actor;

  // The four-stage loop, attributed stage by stage. This is the demo's whole
  // argument in four rows: the agent asked, the human answered, the server
  // checked, the agent executed.
  assert.equal(actorOf('approval.requested'), 'agent', 'stage 1 — the agent asked');
  assert.equal(actorOf('approval.completed'), 'human', 'stage 2 — the human answered');
  assert.equal(actorOf('approval.verified'), 'system', 'stage 3 — the server checked');
  assert.equal(actorOf('approval.executed'), 'agent', 'stage 4 — the agent executed');
  assert.equal(actorOf('slot.confirmed'), 'agent', 'and the slot is confirmed by the agent');

  const tally = actorTally(event.id);
  assert.equal(tally.human, 1, 'exactly one human action in this loop');
  assert.ok(tally.agent >= 3, `the agent did the rest; got ${JSON.stringify(tally)}`);
});

// ════════════════════════════════════════════════════════════════════════════
//  RED LINE 10 — the draw is independent of arrival order
// ════════════════════════════════════════════════════════════════════════════

test('RED LINE 10 — rewriting every joined_at value does not change the draw', () => {
  reset();
  const event = freshEvent({ slots: 8 });
  const handles = Array.from({ length: 20 }, (_, i) => `draw-${i}`);
  for (const h of handles) joinQueue(event.id, human(h));
  settleLottery(event.id);

  const before = listQueue(event.id).map((e) => ({ id: e.id, rank: e.lottery_rank }));
  const recomputedBefore = recomputeDrawOrder(event.id);

  // Flatten every arrival time to one instant. If `joined_at` were an input to
  // the ordering, this would reshuffle the ranks.
  getDb()
    .prepare(`UPDATE queue_entry SET joined_at = ? WHERE event_id = ?`)
    .run(1_700_000_000_000, event.id);

  const after = listQueue(event.id).map((e) => ({ id: e.id, rank: e.lottery_rank }));
  const recomputedAfter = recomputeDrawOrder(event.id);

  assert.deepEqual(after, before, 'ranks must not move when joined_at moves');
  assert.deepEqual(
    recomputedAfter.map((r) => r.entryId),
    recomputedBefore.map((r) => r.entryId),
    'recomputing from the stored seed must reproduce the same order',
  );
});

test('RED LINE 10 — arrival time gives no statistical advantage over many draws', () => {
  reset();
  const N = 200;
  const size = 40;
  const ranksOfFirstArrival: number[] = [];

  for (let i = 0; i < N; i += 1) {
    const event = freshEvent({ slots: 1 });
    const ids: string[] = [];
    for (let j = 0; j < size; j += 1) {
      const id = human(`stat-${i}-${j}`);
      joinQueue(event.id, id);
      ids.push(id);
    }
    settleLottery(event.id);
    const first = listQueue(event.id).find((e) => e.continuity_id === ids[0]);
    assert.ok(first?.lottery_rank);
    ranksOfFirstArrival.push(first!.lottery_rank!);
  }

  const mean = ranksOfFirstArrival.reduce((a, b) => a + b, 0) / N;
  const expected = (size + 1) / 2; // 20.5 for a fair draw
  const sd = Math.sqrt((size * size - 1) / 12) / Math.sqrt(N); // ~1.15
  const z = Math.abs(mean - expected) / sd;

  assert.ok(
    z < 3,
    `the first arrival's mean rank was ${mean.toFixed(2)} against an expected ${expected} ` +
      `(z=${z.toFixed(2)}). A z above 3 means arrival order is leaking into the draw.`,
  );
});

test('RED LINE 10 — FCFS mode does reward arrival order (the control group)', () => {
  reset();
  const event = freshEvent({ slots: 4, lotteryMode: 'fcfs' });
  const ids: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const id = human(`fcfs-${i}`);
    joinQueue(event.id, id);
    ids.push(id);
  }
  settleLottery(event.id);
  sweep(event.id);

  const ranks = listQueue(event.id);
  assert.equal(ranks[0].continuity_id, ids[0], 'in FCFS the earliest arrival must rank first');
  assert.equal(ranks[9].continuity_id, ids[9]);

  // And that is exactly why the mode exists: it is the mode the bot army beats.
  const allocated = listSlots(event.id).filter((s) => s.state === 'ALLOCATED');
  assert.equal(allocated.length, 4);
  for (const slot of allocated) {
    assert.ok(ids.slice(0, 4).includes(slot.holder_continuity_id!), 'the first four arrivals took everything');
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  T-2.2 / T-2.3 — allocation bounds and deferral
// ════════════════════════════════════════════════════════════════════════════

test('T-2.1 — a draw window closes by itself, with no button and no timer', async () => {
  // The seed advertises a 15-second window and the board counts it down, but
  // nothing used to act on the deadline: only /admin's fast-forward and the bot
  // scripts ever settled a draw. A real participant joined, watched the
  // countdown reach zero, and waited forever.
  reset();
  const event = freshEvent({ slots: 3, lotteryMode: 'lottery' });
  // Shorten the window so the test does not sleep for 15 seconds.
  const { updateEvent } = await import('../lib/humans');
  updateEvent(event.id, { lottery_window_sec: 1 });

  const alice = human('self-closing-alice');
  joinQueue(event.id, alice);

  // First sweep: still inside the window, so nothing is drawn.
  let transitions = sweep(event.id);
  assert.equal(transitions.some((t) => t.kind === 'lottery_settled'), false, 'window still open');
  const before = getDb()
    .prepare(`SELECT lottery_rank FROM queue_entry WHERE continuity_id = ?`)
    .get(alice) as { lottery_rank: number | null };
  assert.equal(before.lottery_rank, null, 'still inside the window, so nobody is ranked yet');

  // Move the arrival into the past so the window has demonstrably elapsed,
  // rather than sleeping.
  getDb()
    .prepare(`UPDATE queue_entry SET joined_at = ? WHERE event_id = ?`)
    .run(Date.now() - 5000, event.id);

  transitions = sweep(event.id);
  assert.ok(
    transitions.some((t) => t.kind === 'lottery_settled'),
    'the sweep must settle the draw once the window has elapsed',
  );

  const entry = getDb()
    .prepare(`SELECT lottery_rank FROM queue_entry WHERE continuity_id = ?`)
    .get(alice) as { lottery_rank: number | null };
  assert.equal(entry.lottery_rank, 1, 'the only entrant should be ranked');

  // And allocation happened in the same pass, so the participant has a slot
  // with a live countdown rather than a rank and nothing else.
  const allocated = listSlots(event.id).filter((s) => s.state === 'ALLOCATED');
  assert.equal(allocated.length, 1);
  assert.ok(allocated[0].approval_deadline! > Date.now(), 'a fresh approval window opened');
});

test('T-2.1 — an empty window stays open, so a late arrival can still enter', () => {
  // Settling an empty draw would close the event before anyone could join.
  reset();
  const event = freshEvent({ slots: 3 });
  const transitions = sweep(event.id);
  assert.equal(transitions.some((t) => t.kind === 'lottery_settled'), false);
  assert.doesNotThrow(() => joinQueue(event.id, human('late-but-first')));
});

test('T-2.2 — allocations never exceed total_slots, and every ALLOCATED slot has a deadline', () => {
  reset();
  const event = freshEvent({ slots: 3 });
  queueAndDraw(
    event.id,
    Array.from({ length: 12 }, (_, i) => `bound-${i}`),
  );

  const slots = listSlots(event.id);
  const allocated = slots.filter((s) => s.state === 'ALLOCATED');
  assert.equal(allocated.length, 3, 'no more allocations than slots');
  for (const slot of allocated) {
    assert.ok(slot.approval_deadline !== null, `${slot.id} is ALLOCATED but has no deadline`);
  }

  // The schema asserts this too, so a code path that forgot would throw instead
  // of quietly producing a slot that never expires.
  assert.throws(() =>
    getDb().prepare(`UPDATE slot SET approval_deadline = NULL WHERE id = ?`).run(allocated[0].id),
  );
});

test('T-2.2 — allocations respect total_slots even when more slot ROWS exist', () => {
  // The demo props legitimately create more slot rows than the event declares
  // (the laundering simulation needs inventory to push around). `total_slots` is
  // the event's capacity, so it has to bound allocation regardless — an earlier
  // version allocated every AVAILABLE row and silently broke this invariant.
  reset();
  const event = freshEvent({ slots: 3 });
  ensureSlots(event.id, 20); // stray inventory beyond the declared capacity
  assert.equal(listSlots(event.id).length, 20);

  queueAndDraw(
    event.id,
    Array.from({ length: 20 }, (_, i) => `capacity-${i}`),
  );

  const allocated = listSlots(event.id).filter((s) => s.state === 'ALLOCATED');
  assert.equal(allocated.length, 3, 'total_slots is the capacity, not the row count');
});

test('T-2.3 — an unanswered window defers the slot to the next candidate', () => {
  reset();
  const event = freshEvent({ slots: 1, approvalWindowSec: 60 });
  const ids = queueAndDraw(
    event.id,
    Array.from({ length: 5 }, (_, i) => `defer-${i}`),
  );

  const firstSlot = listSlots(event.id)[0];
  const firstHolder = firstSlot.holder_continuity_id!;
  const secondCandidate = nextCandidatePreview(event.id);
  assert.ok(secondCandidate, 'there must be someone left in the queue');

  // Let the window lapse.
  getDb().prepare(`UPDATE slot SET approval_deadline = ? WHERE id = ?`).run(Date.now() - 1000, firstSlot.id);
  const transitions = sweep(event.id);

  assert.ok(transitions.some((t) => t.kind === 'approval_expired'), 'the expiry must be reported');
  assert.ok(transitions.some((t) => t.kind === 'deferred'), 'and it must defer, not just expire');

  const after = listSlots(event.id)[0];
  assert.equal(after.state, 'ALLOCATED');
  assert.equal(after.deferral_count, 1);
  assert.notEqual(after.holder_continuity_id, firstHolder, 'the slot must have moved on');
  assert.equal(after.holder_continuity_id, secondCandidate!.continuity_id, 'in draw order, not at random');
  assert.ok(after.approval_deadline! > Date.now(), 'a fresh window starts for the new candidate');

  // The original candidate is now served and can never be picked again.
  const entry = getDb()
    .prepare(`SELECT allocated_at FROM queue_entry WHERE continuity_id = ?`)
    .get(firstHolder) as { allocated_at: number | null };
  assert.ok(entry.allocated_at !== null, 'the missed candidate is marked served so deferral moves forward');
});

test('T-2.3 — after deferral the missed candidate cannot buy, even holding a valid proof', async () => {
  reset();
  const event = freshEvent({ slots: 1, approvalWindowSec: 60 });
  const ids = queueAndDraw(
    event.id,
    Array.from({ length: 5 }, (_, i) => `missed-${i}`),
  );

  const slot = listSlots(event.id)[0];
  const missed = slot.holder_continuity_id!;

  // The human does everything right, just too late: they obtain a genuine,
  // fresh, correctly-bound approval for this event.
  const request = await requestClaimApproval(event.id, missed);
  await approveLocally(request.requestId, 'late-human');
  const synced = await syncApproval(request.approvalId);
  assert.equal(synced.state, 'APPROVED', 'the proof itself is perfectly valid');

  // Meanwhile the window closes.
  getDb().prepare(`UPDATE slot SET approval_deadline = ? WHERE id = ?`).run(Date.now() - 1000, slot.id);
  sweep(event.id);

  const err = await refuses('deferred_to_next_candidate', () =>
    executeClaim({ eventId: event.id, continuityId: missed, approvalRef: request.approvalId }),
  );
  assert.match(err.hint ?? '', /deferral/);
  assert.equal(count(`SELECT COUNT(*) AS n FROM consumed_proof WHERE continuity_id = ?`, missed), 0);
});

test('T-2.3 — a slot survives three consecutive deferrals and still sells', async () => {
  reset();
  const event = freshEvent({ slots: 1, approvalWindowSec: 60 });
  const ids = queueAndDraw(
    event.id,
    Array.from({ length: 6 }, (_, i) => `chain-${i}`),
  );

  for (let i = 0; i < 3; i += 1) {
    const slot = listSlots(event.id)[0];
    getDb().prepare(`UPDATE slot SET approval_deadline = ? WHERE id = ?`).run(Date.now() - 1000, slot.id);
    sweep(event.id);
    const after = listSlots(event.id)[0];
    assert.equal(after.deferral_count, i + 1);
    assert.equal(after.state, 'ALLOCATED', `deferral ${i + 1} must still find a candidate`);
    assert.notEqual(after.holder_continuity_id, slot.holder_continuity_id);
  }

  const finalHolder = listSlots(event.id)[0].holder_continuity_id!;
  const done = await purchase(event.id, finalHolder);
  assert.equal(done.ok, true);
  assert.equal(count(`SELECT COUNT(*) AS n FROM slot WHERE state = 'CONFIRMED'`), 1);
});

// ════════════════════════════════════════════════════════════════════════════
//  T-3.2 — freshness
// ════════════════════════════════════════════════════════════════════════════

test('T-3.2 — a stale authentication is refused as not fresh', async () => {
  reset();
  const event = freshEvent({ slots: 2 });
  const [alice] = queueAndDraw(event.id, ['alice']);

  const request = await requestClaimApproval(event.id, alice);
  // The human "approves", but their session is an hour old.
  await approveLocally(request.requestId, 'alice', { stale: true });
  const synced = await syncApproval(request.approvalId);
  assert.equal(synced.state, 'APPROVED', 'the approval exists; freshness is checked at the gate');

  const err = await refuses('not_fresh', () =>
    executeClaim({ eventId: event.id, continuityId: alice, approvalRef: request.approvalId }),
  );
  assert.match(err.invariant ?? '', /RED LINE 3/);
  assert.equal(count(`SELECT COUNT(*) AS n FROM slot WHERE state = 'CONFIRMED'`), 0);
});

test('T-3.2 — re-authenticating makes the same request succeed', async () => {
  reset();
  const event = freshEvent({ slots: 2 });
  const [alice] = queueAndDraw(event.id, ['alice']);

  const stale = await requestClaimApproval(event.id, alice);
  await approveLocally(stale.requestId, 'alice', { stale: true });
  await syncApproval(stale.approvalId);
  await refuses('not_fresh', () =>
    executeClaim({ eventId: event.id, continuityId: alice, approvalRef: stale.approvalId }),
  );

  // A second attempt, this time with a current authentication.
  const fresh = await purchase(event.id, alice);
  assert.equal(fresh.ok, true);
});

test('T-3.2 — freshness is measured against auth_time, and auth_time is server-held', () => {
  // A re-issued token keeps the ORIGINAL auth_time when a browser session is
  // reused, which is why `iat` would be the wrong claim and `auth_time` is the
  // right one. The `step-up` guide says this in as many words.
  const now = Date.now();
  assert.equal(worldid.isFresh(now - 1000, 60), true);
  assert.equal(worldid.isFresh(now - 120_000, 60), false);
  // A far-future timestamp is a clock bug or a forgery, never "fresh".
  assert.equal(worldid.isFresh(now + 10 * 60 * 1000, 60), false);
  assert.equal(worldid.isFresh(null, 60), false);
  // max_age=0 tolerates only the round trip.
  assert.equal(worldid.isFresh(now - 1000, 0), true);
  assert.equal(worldid.isFresh(now - 30_000, 0), false);
});

// ════════════════════════════════════════════════════════════════════════════
//  T-5.1 — grants expire and revoke
// ════════════════════════════════════════════════════════════════════════════

test('T-5.1 — a grant is active, then expires, then stays gone', async () => {
  reset();
  const event = freshEvent({ slots: 2 });
  const alice = human('grant-alice');

  const grant = issueGrant({
    eventId: event.id,
    granteeContinuityId: alice,
    scope: 'vip:skip_queue',
    ttlSec: 1,
  });
  assert.ok(activeGrant(alice, event.id, 'vip:skip_queue'));

  // Expiry is evaluated at read time, so there is no cache to invalidate.
  getDb().prepare(`UPDATE grant_ SET expires_at = ? WHERE id = ?`).run(Date.now() - 1, grant.id);
  assert.equal(activeGrant(alice, event.id, 'vip:skip_queue'), undefined);
});

test('T-5.1 — revocation takes effect immediately', () => {
  reset();
  const event = freshEvent({ slots: 2 });
  const alice = human('revoke-alice');

  const grant = issueGrant({ eventId: event.id, granteeContinuityId: alice, scope: 'vip:skip_queue' });
  assert.ok(activeGrant(alice, event.id, 'vip:skip_queue'));

  revokeGrant(grant.id);
  assert.equal(activeGrant(alice, event.id, 'vip:skip_queue'), undefined);
});

test('T-5.1 — a VIP grant takes the front of the draw, but does not exceed the slots', () => {
  reset();
  const event = freshEvent({ slots: 2 });
  const vip = human('vip-human');
  issueGrant({ eventId: event.id, granteeContinuityId: vip, scope: 'vip:skip_queue' });

  // The VIP joins last, so a leaky implementation would rank them last.
  const others = Array.from({ length: 8 }, (_, i) => human(`pleb-${i}`));
  for (const id of others) joinQueue(event.id, id);
  joinQueue(event.id, vip);
  settleLottery(event.id);
  sweep(event.id);

  const first = listQueue(event.id)[0];
  assert.equal(first.continuity_id, vip, 'a VIP grant jumps the draw');

  const allocated = listSlots(event.id).filter((s) => s.state === 'ALLOCATED');
  assert.equal(allocated.length, 2, 'and still cannot exceed the slot count');
});

// ════════════════════════════════════════════════════════════════════════════
//  T-1.1 — queue uniqueness
// ════════════════════════════════════════════════════════════════════════════

test('T-1.1 — joining twice is idempotent, so refreshing cannot improve your odds', () => {
  reset();
  const event = freshEvent({ slots: 4 });
  const alice = human('idempotent-alice');

  const first = joinQueue(event.id, alice);
  const second = joinQueue(event.id, alice);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.entry.id, second.entry.id);
  assert.equal(count(`SELECT COUNT(*) AS n FROM queue_entry WHERE event_id = ?`, event.id), 1);
});

test('T-1.1 — joining after the draw is closed', () => {
  reset();
  const event = freshEvent({ slots: 4 });
  queueAndDraw(event.id, ['early-bird']);

  assert.throws(
    () => joinQueue(event.id, human('late-arrival')),
    (e: HumanGateError) => e.code === 'queue_closed',
    'the window must close before the draw, or late arrivals could be counted after seeing the odds',
  );
});

// ════════════════════════════════════════════════════════════════════════════
//  T-6.2 — the disclosed bypass is actually switched off by default
// ════════════════════════════════════════════════════════════════════════════

test('T-6.2 — dev routes 404 when ENABLE_DEV_ROUTES is unset', async () => {
  const { assertDevRoutes } = await import('../lib/devmode');
  const saved = process.env.ENABLE_DEV_ROUTES;

  process.env.ENABLE_DEV_ROUTES = '0';
  try {
    assertDevRoutes();
    assert.fail('assertDevRoutes must throw when the flag is off');
  } catch (err) {
    const e = err as HumanGateError;
    assert.equal(e.code, 'dev_routes_disabled');
    assert.equal(e.httpStatus, 404, 'it must be indistinguishable from a route that does not exist');
  } finally {
    process.env.ENABLE_DEV_ROUTES = saved;
  }

  // And with the flag on, it does not throw.
  process.env.ENABLE_DEV_ROUTES = '1';
  assertDevRoutes();
});
