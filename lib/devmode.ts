/**
 * ============================================================================
 *  DEV-ONLY simulation surface (T-6.2) — READ THE GUARDRAILS BEFORE USING IT
 * ============================================================================
 *
 * The centrepiece demo is "40 accounts arrive and collapse into 2 continuity
 * ids". That cannot be built from real World ID proofs: you cannot summon 40
 * verified humans onto a stage.
 *
 * So this module manufactures them. That is normal for a demo, and the TODO is
 * explicit that the right move is to disclose it rather than hide it:
 *
 *   "demo 里模拟多个用户是行业惯例，说明白就没有问题；藏起来才是问题。"
 *
 * Guardrails, each one enforced in code and covered by a test:
 *
 *   1. Every route that reaches this module is wrapped in `assertDevRoutes()`,
 *      which throws a 404 unless `ENABLE_DEV_ROUTES=1`. Default off.
 *   2. This module shares **no code branch** with the real verification path.
 *      Simulated humans are created by `ensureSyntheticHuman()` against the
 *      issuer `local:dev-impersonation`; `worldid/` is never involved and an
 *      impersonated session can never produce an approval.
 *   3. Startup prints a loud warning when the flag is on (`lib/startup.ts`), and
 *      the board renders a permanent "DEV ROUTES ENABLED" badge.
 *   4. It is documented in README.md and INTEGRATION_DEBRIEF.md.
 *
 * The tail of this file implements the laundering simulation used for demo beat
 * 4. Its whole purpose is to show the same attack failing for the same reason
 * every time, which is what makes it worth scripting rather than improvising.
 */
import { getDb, nowMs, tx } from './db';
import { newId } from './ids';
import { audit } from './audit';
import { PresenceError } from './errors';
import { ensureSyntheticHuman } from './humans';
import { primaryEvent, getEvent, updateEvent } from './humans';
import { ensureSlots, sweep } from './slots';
import { settleLottery, joinQueue } from './queue';

/** Issuer namespace for simulated humans. Distinct from the local IdP fallback. */
export const DEV_ISSUER = 'local:dev-impersonation';

/** T-6.2 acceptance: `/api/dev/*` returns 404 when the flag is unset. */
export function assertDevRoutes(): void {
  if (process.env.ENABLE_DEV_ROUTES !== '1') {
    // Same shape as a genuinely missing route: the demo surface must be
    // indistinguishable from "not deployed" when it is switched off.
    throw new PresenceError('dev_routes_disabled', 'Not Found', { httpStatus: 404 });
  }
}

export function devRoutesEnabled(): boolean {
  return process.env.ENABLE_DEV_ROUTES === '1';
}

// ── Impersonation ───────────────────────────────────────────────────────────

export interface ImpersonationResult {
  handle: string;
  continuityId: string;
  created: boolean;
}

/**
 * Mint (or reuse) a simulated human and return its continuity id.
 *
 * Note what this does NOT do: it does not create an approval, does not touch
 * `auth_request`, and does not call `worldid/`. A simulated session can queue
 * and can be *shown* to hold a slot, but it cannot satisfy a proof — so if the
 * demo accidentally routed a protected action through it, the gate would refuse.
 * That separation is the point of requirement 2 above.
 */
export function impersonate(handle: string, eventId?: string): ImpersonationResult {
  assertDevRoutes();
  const existing = getDb()
    .prepare(`SELECT * FROM human WHERE issuer = ? AND subject = ?`)
    .get(DEV_ISSUER, handle) as { continuity_id: string } | undefined;

  const human = ensureSyntheticHuman(handle);
  audit({
    type: 'dev.impersonation',
    continuityId: human.continuity_id,
    // Filed under the event the caller is working in, so a private demo's audit
    // trail reads as one story instead of leaking into the seeded event's.
    eventId: eventId ?? null,
    severity: 'warn',
    payload: {
      handle,
      note: 'SIMULATED identity — ENABLE_DEV_ROUTES is on. Not a World ID verification.',
    },
  });
  return { handle, continuityId: human.continuity_id, created: !existing };
}

// ── The army ────────────────────────────────────────────────────────────────

export interface ArmyMember {
  accountIndex: number;
  handle: string;
  continuityId: string;
}

export interface ArmyBuildResult {
  accounts: ArmyMember[];
  humans: { continuityId: string; accounts: number }[];
  /** The number a judge should remember: accounts ÷ humans. */
  collapseRatio: string;
  note: string;
}

/**
 * Build `accounts` simulated signups that resolve to only `humanCount` humans.
 *
 * This is the shape of the attack defence 3 exists for: a scalper buys 40
 * accounts, and from the system's point of view there are still two people.
 */
export function buildArmy(opts: { accounts?: number; humans?: number; eventId?: string } = {}): ArmyBuildResult {
  assertDevRoutes();
  const accounts = Math.max(1, Math.min(opts.accounts ?? 40, 200));
  const humanCount = Math.max(1, Math.min(opts.humans ?? 2, accounts));
  // Handles are UNIQUE across the whole database, so with one private event per
  // visitor two bot armies would collide on `bot-account-01`. Namespacing by
  // event keeps every visitor's army — and therefore every visitor's board —
  // their own.
  const scope = opts.eventId ?? '';

  return tx((db) => {
    if (scope) db.prepare(`DELETE FROM dev_army WHERE handle LIKE ?`).run(`${scope}:%`);
    else db.prepare(`DELETE FROM dev_army`).run();

    const humanIds: string[] = [];
    for (let h = 0; h < humanCount; h += 1) {
      humanIds.push(ensureSyntheticHuman(`${scope}${scope ? ':' : ''}scalper-human-${h + 1}`).continuity_id);
    }

    const members: ArmyMember[] = [];
    for (let i = 0; i < accounts; i += 1) {
      const continuityId = humanIds[i % humanCount];
      const handle = `${scope}${scope ? ':' : ''}bot-account-${String(i + 1).padStart(2, '0')}-of-human-${(i % humanCount) + 1}`;
      db.prepare(
        `INSERT INTO dev_army (id, account_index, handle, continuity_id, created_at) VALUES (?,?,?,?,?)`,
      ).run(newId('army'), i + 1, handle, continuityId, nowMs());
      members.push({ accountIndex: i + 1, handle, continuityId });
    }

    const humans = humanIds.map((continuityId) => ({
      continuityId,
      accounts: members.filter((m) => m.continuityId === continuityId).length,
    }));

    audit({
      type: 'dev.army_built',
      severity: 'warn',
      payload: {
        accounts,
        humans: humanCount,
        note: 'SIMULATED accounts. The collapse is the point: 40 accounts, 2 humans.',
      },
    });

    return {
      accounts: members,
      humans,
      collapseRatio: `${accounts} accounts → ${humanCount} continuity ${humanCount === 1 ? 'id' : 'ids'}`,
      note: 'Simulated signups for the demo. No World ID verification is involved.',
    };
  });
}

export function listArmy(eventId?: string): ArmyMember[] {
  const rows = (
    eventId
      ? getDb()
          .prepare(
            `SELECT account_index, handle, continuity_id FROM dev_army
              WHERE handle LIKE ? ORDER BY account_index`,
          )
          .all(`${eventId}:%`)
      : getDb()
          .prepare(`SELECT account_index, handle, continuity_id FROM dev_army ORDER BY account_index`)
          .all()
  ) as { account_index: number; handle: string; continuity_id: string }[];
  return rows.map((r) => ({ accountIndex: r.account_index, handle: r.handle, continuityId: r.continuity_id }));
}

// ── Demo fast paths ─────────────────────────────────────────────────────────

// ── Demo beat 4: the collapse ───────────────────────────────────────────────

export interface ArmyQueueResult {
  eventId: string;
  accounts: number;
  humans: number;
  attempted: number;
  created: number;
  reused: number;
  queueLength: number;
  headline: string;
}

/**
 * Demo beat 4, restated for locked slots.
 *
 * Before, the centrepiece was laundering slots through forty accounts. With
 * circulation gone, the interesting surface is the queue itself: forty signups
 * pointed at one event collapse onto two continuity ids, because the uniqueness
 * constraint is on `(event_id, continuity_id)` and a continuity id is a human.
 *
 * Note what this is *not*: it is not forty refusals. `joinQueue` is idempotent
 * by design — a person refreshing the page must get their existing entry, not an
 * error — so the honest reading is "forty attempts produced two entries". The
 * demo shows that rather than manufacturing forty red lines.
 */
export function runArmyQueueDemo(opts: { eventId?: string; accounts?: number; humans?: number } = {}): ArmyQueueResult {
  assertDevRoutes();
  const accounts = Math.max(1, Math.min(opts.accounts ?? 40, 200));
  const humans = Math.max(1, Math.min(opts.humans ?? 2, accounts));

  const army = buildArmy({ accounts, humans, eventId: opts.eventId });
  const event = opts.eventId ? getEvent(opts.eventId) : primaryEvent();
  if (!event) throw new PresenceError('event_not_found', 'no event');

  // A fresh window, or the draw would already have closed and every join would
  // be refused for the wrong reason. Scoped to this event: on the public site
  // the other visitors' queues are none of this button's business.
  resetDemo({ eventId: event.id });
  sweep(event.id);

  let created = 0;
  let reused = 0;
  for (const account of army.accounts) {
    const result = joinQueue(event.id, account.continuityId);
    if (result.created) created += 1;
    else reused += 1;
  }

  const queueLength = (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM queue_entry WHERE event_id = ?`)
      .get(event.id) as { n: number }
  ).n;

  audit({
    type: 'dev.army_queue',
    eventId: event.id,
    severity: 'warn',
    payload: {
      accounts,
      humans,
      attempted: army.accounts.length,
      created,
      reused,
      queueLength,
      note: 'forty accounts, two humans, two places in line — the constraint is on the human',
    },
  });

  return {
    eventId: event.id,
    accounts,
    humans,
    attempted: army.accounts.length,
    created,
    reused,
    queueLength,
    headline:
      `${army.accounts.length} accounts joined: ${created} queue ` +
      `${created === 1 ? 'entry' : 'entries'} created, ${reused} landed on an entry that already ` +
      `existed. ${humans} humans, ${created} places in line — a new account buys nothing.`,
  };
}

// ── Reset ───────────────────────────────────────────────────────────────────

/**
 * T-6.2 acceptance: "一键重置演示状态".
 *
 * Wipes every table the demo writes to and re-seeds a clean event. Deleting the
 * SQLite file would also work, but the connection is cached per process, so an
 * in-place truncate keeps running servers honest.
 *
 * The table list is the whole set of writable tables. It is worth re-reading
 * after removing a feature: this one still named the two transfer tables long
 * after they stopped existing, and every demo route failed with
 * `no such table: transfer_inbound` until it was caught by running the suite
 * against a freshly built server.
 */
/**
 * "Back to a fresh window."
 *
 * ── Why this is now event-scoped ───────────────────────────────────────────
 *
 * On the stage there was one event, so "clear the demo state" and "clear every
 * table" were the same instruction and the second one was shorter. On the public
 * site they are catastrophically different: an unscoped `DELETE FROM queue_entry`
 * run by one visitor would empty *every other visitor's* queue at the same
 * moment, and the button that does it is on a page anyone can open. So the wipe
 * is now narrowed to one event, and only the identity-level tables — which have
 * no `event_id` because one World ID is one human everywhere — are still global.
 *
 * `opts` is optional so `npm run reset` and the scripts keep their old meaning:
 * with no `eventId`, every event's demo state is cleared, which is what "reset
 * the demo database" should mean from a terminal.
 */
export function resetDemo(opts: { eventId?: string } = {}): { reset: true; eventId: string } {
  assertDevRoutes();
  const target = opts.eventId;
  // `sandbox.touched` rows are the liveness heartbeat the sandbox sweeper reads,
  // so a scoped reset must not delete them — otherwise resetting a private demo
  // would make it look abandoned and it would be collected mid-session.
  const KEEP = 'sandbox.touched';

  const eventId = tx((db) => {
    if (target) {
      db.prepare(`DELETE FROM approval WHERE event_id = ?`).run(target);
      db.prepare(`DELETE FROM queue_entry WHERE event_id = ?`).run(target);
      db.prepare(`DELETE FROM grant_ WHERE event_id = ?`).run(target);
      db.prepare(`DELETE FROM dev_army WHERE handle LIKE ?`).run(`${target}:%`);
      // `consumed_proof` has no `event_id`; the purchase action encodes it, so
      // that is what identifies this event's proofs among the global ones.
      db.prepare(`DELETE FROM consumed_proof WHERE bound_action = ?`).run(`buy_slot:${target}`);
      db.prepare(`DELETE FROM audit_event WHERE event_id = ? AND type <> ?`).run(target, KEEP);
    } else {
      for (const table of ['consumed_proof', 'approval', 'auth_request', 'queue_entry', 'dev_army', 'grant_']) {
        db.prepare(`DELETE FROM ${table}`).run();
      }
      db.prepare(`DELETE FROM audit_event WHERE type <> ?`).run(KEEP);
    }

    // Rebuild the slot set from scratch rather than resetting it in place. The
    // demo props legitimately grow the slot count (the laundering simulation
    // needs inventory), and leaving those extra rows behind would let a later
    // run allocate more slots than the event declares.
    const event = target ? getEvent(target) : primaryEvent();
    if (!event) throw new PresenceError('event_not_found', `no event ${target}`);
    db.prepare(`DELETE FROM slot WHERE event_id = ?`).run(event.id);
    db.prepare(
      `UPDATE event SET lottery_drawn_at = NULL, lottery_seed = NULL WHERE id = ?`,
    ).run(event.id);

    audit({
      type: 'dev.reset',
      eventId: event.id,
      severity: 'warn',
      payload: { note: 'demo state cleared', scoped: Boolean(target) },
    });
    return event.id;
  });

  // Recreate exactly the event's capacity, outside the transaction above so
  // `ensureSlots` sees a settled table.
  ensureSlots(eventId, getEvent(eventId)!.total_slots);

  return { reset: true, eventId };
}

/**
 * Fast-forward (T-6.3): close the current window immediately and settle.
 *
 * Judges cannot wait ten minutes for a lottery window, and a demo that depends
 * on a wall clock is a demo that runs out of time. This collapses both windows:
 * it settles the draw and then expires every live approval window so deferrals
 * fire on cue.
 */
export function fastForward(opts: { eventId?: string; deferAllocations?: boolean } = {}): {
  eventId: string;
  drew: boolean;
  deferrals: number;
  deferAllocations: boolean;
} {
  assertDevRoutes();
  const event = opts.eventId ? getEvent(opts.eventId) : primaryEvent();
  if (!event) throw new PresenceError('event_not_found', 'no event');

  // Default FALSE, and that default is the fix for a real bug.
  //
  // This one operation used to do two things that are only compatible by
  // accident: settle the draw (which *creates* allocations) and drag every
  // allocation deadline into the past (which destroys them). Pressed during an
  // agent run — the agent joins, the operator fast-forwards the wait — the slot
  // the agent had just been given was expired inside the same request, so the
  // agent went on to request an authorization for a slot that no longer existed
  // and sat waiting for a phone approval that could never help. The countdown
  // the operator meant to end was the *draw* window.
  //
  // It read as working for the stage beats only because they read the allocation
  // immediately, before the next sweep: the deferral demo (`scripts/e2e.ts`
  // beat 3) wants exactly this behaviour and now asks for it by name.
  const deferAllocations = opts.deferAllocations ?? false;

  const drew = event.lottery_drawn_at === null;
  if (drew) settleLottery(event.id);

  if (deferAllocations) {
    // Pull every allocated deadline into the past so the very next sweep defers.
    getDb()
      .prepare(
        `UPDATE slot SET approval_deadline = ? WHERE event_id = ? AND state = 'ALLOCATED'`,
      )
      .run(nowMs() - 1000, event.id);
  }

  const transitions = sweep(event.id);
  const deferrals = transitions.filter(
    (t) => t.kind === 'deferred' || t.kind === 'approval_expired',
  ).length;

  audit({
    type: 'dev.fast_forward',
    eventId: event.id,
    severity: 'warn',
    payload: { drew, deferrals, deferAllocations, note: 'windows collapsed for the demo clock' },
  });

  return { eventId: event.id, drew, deferrals, deferAllocations };
}

/** Seed a self-contained scenario: queue + draw + allocations, ready to demo. */
export function primeScenario(opts: {
  eventId?: string;
  humans?: number;
} = {}): { eventId: string; joined: number; allocated: number } {
  assertDevRoutes();
  const event = opts.eventId ? getEvent(opts.eventId) : primaryEvent();
  if (!event) throw new PresenceError('event_not_found', 'no event');
  const humans = Math.max(1, Math.min(opts.humans ?? 6, 40));

  // Two things this has to be on the public site, and was not on the stage:
  // handles are namespaced per event (the identity table is global, and two
  // visitors' scenarios would otherwise share one synthetic crowd), and any
  // previous state for THIS event goes first, or the draw it just settled would
  // refuse the joins below with `queue_closed`.
  const scope = `${event.id}:`;
  resetDemo({ eventId: event.id });

  sweep(event.id);
  let joined = 0;
  for (let i = 0; i < humans; i += 1) {
    const human = ensureSyntheticHuman(`${scope}attendee-${i + 1}`);
    try {
      joinQueue(event.id, human.continuity_id);
      joined += 1;
    } catch {
      // already in the queue
    }
  }
  settleLottery(event.id);
  const allocated = sweep(event.id).length;
  return { eventId: event.id, joined, allocated };
}

export { getDb };
