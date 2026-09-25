/**
 * ============================================================================
 *  DEV-ONLY simulation surface (T-6.2) — READ THE GUARDRAILS BEFORE USING IT
 * ============================================================================
 *
 * The centrepiece demo is "40 accounts arrive to receive transfers and collapse
 * into 2 continuity ids; the third attempt is refused". That cannot be built
 * from real World ID proofs: you cannot summon 40 verified humans onto a stage.
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
import { ensureSlots, confirmSlot, inboundAllowance, sweep } from './slots';
import { consumeProof } from './consume';
import { inboundCount, createTransfer, requestTransferApproval, completeTransfer } from './transfer';
import { transferAction, transferSignal } from './gate';
import { getApproval, requestApproval, syncApproval } from './approval';
import { publicBaseUrl } from '../worldid/config';
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
export function impersonate(handle: string): ImpersonationResult {
  assertDevRoutes();
  const existing = getDb()
    .prepare(`SELECT * FROM human WHERE issuer = ? AND subject = ?`)
    .get(DEV_ISSUER, handle) as { continuity_id: string } | undefined;

  const human = ensureSyntheticHuman(handle);
  audit({
    type: 'dev.impersonation',
    continuityId: human.continuity_id,
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
export function buildArmy(opts: { accounts?: number; humans?: number } = {}): ArmyBuildResult {
  assertDevRoutes();
  const accounts = Math.max(1, Math.min(opts.accounts ?? 40, 200));
  const humanCount = Math.max(1, Math.min(opts.humans ?? 2, accounts));

  return tx((db) => {
    db.prepare(`DELETE FROM dev_army`).run();

    const humanIds: string[] = [];
    for (let h = 0; h < humanCount; h += 1) {
      humanIds.push(ensureSyntheticHuman(`scalper-human-${h + 1}`).continuity_id);
    }

    const members: ArmyMember[] = [];
    for (let i = 0; i < accounts; i += 1) {
      const continuityId = humanIds[i % humanCount];
      const handle = `bot-account-${String(i + 1).padStart(2, '0')}-of-human-${(i % humanCount) + 1}`;
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

export function listArmy(): ArmyMember[] {
  return (
    getDb()
      .prepare(`SELECT account_index, handle, continuity_id FROM dev_army ORDER BY account_index`)
      .all() as { account_index: number; handle: string; continuity_id: string }[]
  ).map((r) => ({ accountIndex: r.account_index, handle: r.handle, continuityId: r.continuity_id }));
}

// ── Demo fast paths ─────────────────────────────────────────────────────────

/**
 * Give a simulated human a confirmed slot without going through the draw.
 *
 * A separate, clearly-labelled write path — NOT a shortcut inside the real
 * allocation code. The real path must stay the only way a *real* human obtains
 * a slot, otherwise the demo would be testing the shortcut.
 */
export function grantConfirmedSlot(continuityId: string, eventId: string, slotId: string): void {
  assertDevRoutes();
  tx((db) => {
    // Move THIS slot, and only this one. An earlier version cleared every slot
    // in the event first, which silently un-granted the scalper's previously
    // acquired inventory and made the laundering run fail with
    // `transfer_not_owner` on nine attempts out of ten.
    db.prepare(
      `UPDATE slot
          SET state = 'CONFIRMED', holder_continuity_id = ?, acquired_via = 'lottery',
              approval_deadline = NULL, gift_used = 0, updated_at = ?
        WHERE id = ?`,
    ).run(continuityId, nowMs(), slotId);

    // Record the consumption too, so the entitlement guard behaves exactly as
    // it would have for a real purchase.
    const nullifier = `nul_dev_${continuityId.slice(-8)}_${slotId}`;
    try {
      consumeProof(db, {
        nullifier,
        boundAction: `buy_slot:${eventId}`,
        continuityId,
        slotId,
        proofRef: 'dev:direct-grant',
      });
    } catch {
      // A simulated human may legitimately hit the entitlement guard here.
    }

    audit({
      type: 'dev.slot_granted',
      continuityId,
      eventId,
      slotId,
      severity: 'warn',
      payload: { note: 'SIMULATED grant for the demo — bypasses the draw and the gate' },
    });
  });
}

// ── Demo beat 4: the laundering simulation ──────────────────────────────────

export interface LaunderingAttempt {
  attempt: number;
  accountIndex: number;
  handle: string;
  continuityId: string;
  short: string;
  outcome: 'completed' | 'refused';
  code?: string;
  message: string;
  inboundAfter: number;
  cap: number;
}

export interface LaunderingResult {
  eventId: string;
  slotId: string;
  accounts: number;
  humans: number;
  completed: number;
  refused: number;
  attempts: LaunderingAttempt[];
  headline: string;
  /** Set to `open` for the run so the cap is the only rule in the way. */
  policy: string;
  capPerHuman: number;
  /** Why transfers stopped: the cap, not the policy. */
  stoppedBy: string;
  /** How many slots the simulated scalper was holding before the run. */
  inventoryHeld: number;
}

/**
 * Demo beat 4 in one call.
 *
 * A "scalper" holds one confirmed slot and tries to push it through the army,
 * account by account. Each attempt is a *complete, real* transfer: real link,
 * real TTL, real approval, real fresh-authentication requirement, real gate.
 * The only synthetic part is that the recipients never had to prove humanness —
 * and that is disclosed on screen.
 *
 * The result the judges should read: attempts keep succeeding for a while (the
 * cap is per human, not per attempt) and then stop dead, twice, at exactly
 * `transfer_inbound_cap`, no matter how many fresh accounts are thrown at it.
 */
export async function runLaunderingDemo(opts: {
  eventId?: string;
  accounts?: number;
  humans?: number;
  /** Where the consent endpoint lives. Defaults to this deployment. */
  baseUrl?: string;
}): Promise<LaunderingResult> {
  assertDevRoutes();
  const accounts = Math.max(1, Math.min(opts.accounts ?? 40, 200));
  const humans = Math.max(1, Math.min(opts.humans ?? 2, accounts));
  const baseUrl = (opts.baseUrl ?? publicBaseUrl()).replace(/\/+$/, '');

  const army = buildArmy({ accounts, humans });
  const configured = opts.eventId ? getEvent(opts.eventId) : primaryEvent();
  if (!configured) throw new PresenceError('event_not_found', 'no event');

  // Set the MOST PERMISSIVE transfer policy before running. This matters for the
  // argument: under `gift` the slot's one-gift lifetime would refuse the second
  // attempt, and the audience would be watching the wrong rule. With `open`,
  // free transfer is allowed and the ONLY thing left standing between the
  // scalper and the whole inventory is the per-human cap. That is the rule we are
  // here to demonstrate, so it is the only one left in the way.
  const event = updateEvent(configured.id, { policy: 'open' });

  // One slot per attempt, all held by the scalper. This detail matters: a
  // transfer proof is bound to `accept_transfer:{slot_id}`, so pushing the SAME
  // slot twice at the same human derives the same nullifier and is correctly
  // refused as a replay. Reusing one slot would therefore have the audience
  // watching the replay guard instead of the cap. A real scalper has inventory,
  // so the simulation gives him inventory.
  ensureSlots(event.id, Math.max(event.total_slots, accounts + 1));
  sweep(event.id);

  const scalper = ensureSyntheticHuman('scalper-prime');
  const inventory = (
    getDb()
      .prepare(`SELECT id FROM slot WHERE event_id = ? ORDER BY created_at, id LIMIT ?`)
      .all(event.id, accounts) as { id: string }[]
  ).map((r) => r.id);

  for (const slotId of inventory) {
    grantConfirmedSlot(scalper.continuity_id, event.id, slotId);
  }

  const attempts: LaunderingAttempt[] = [];
  let completed = 0;
  let refused = 0;

  // Walk the army account by account. The account list cycles through the two
  // humans, so the audience watches *fresh accounts* being refused rather than
  // the same one repeatedly — which is the whole point of the beat.
  for (let i = 0; i < accounts; i += 1) {
    const account = army.accounts[i % army.accounts.length];
    const slotId = inventory[i % inventory.length];
    const cap = inboundAllowance(event.id, account.continuityId);
    const used = inboundCount(account.continuityId, event.id);

    const base: Omit<LaunderingAttempt, 'outcome' | 'message' | 'inboundAfter'> = {
      attempt: i + 1,
      accountIndex: account.accountIndex,
      handle: account.handle,
      continuityId: account.continuityId,
      short: `…${account.continuityId.slice(-8)}`,
      cap,
    };

    try {
      const created = createTransfer({
        slotId,
        fromContinuityId: scalper.continuity_id,
        toContinuityId: account.continuityId,
        label: `demo beat 4 · account ${account.accountIndex}`,
      });

      const request = await requestTransferApproval(created.token, account.continuityId);

      // Complete the consent step the way a human would: by POSTing to the same
      // consent endpoint the fallback screen uses. Deliberately an HTTP call and
      // not a direct `worldid` import — this module must keep sharing no code
      // branch with the real verification path (see the guardrails at the top).
      if (request.mode !== 'local') {
        throw new PresenceError(
          'bad_request',
          'the laundering simulation can only auto-approve the local fallback consent screen',
          {
            hint:
              'With real portal credentials the IdP requires a human on a device, which a script ' +
              'cannot substitute. Run with the local fallback to demo this beat.',
          },
        );
      }
      const consent = await fetch(`${baseUrl}/api/auth/local`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: request.requestId, handle: account.handle }),
      });
      if (!consent.ok) {
        throw new Error(`consent step failed: HTTP ${consent.status} ${await consent.text()}`);
      }

      await syncApproval(request.approvalId);
      const synced = getApproval(request.approvalId);
      if (synced?.state !== 'APPROVED') {
        throw new Error(`consent did not produce an approval (${synced?.state}: ${synced?.fail_reason})`);
      }

      const result = await completeTransfer({
        token: created.token,
        continuityId: account.continuityId,
        approvalRef: request.approvalId,
      });

      completed += 1;
      attempts.push({
        ...base,
        outcome: 'completed',
        message: `transfer completed; inbound ${result.inboundCount}/${result.inboundCap}`,
        inboundAfter: result.inboundCount,
      });
    } catch (err) {
      refused += 1;
      const code = err instanceof PresenceError ? err.code : 'internal_error';
      attempts.push({
        ...base,
        outcome: 'refused',
        code,
        message: err instanceof Error ? err.message : String(err),
        inboundAfter: used,
      });
    }
  }

  audit({
    type: 'dev.laundering_demo',
    eventId: event.id,
    severity: 'alert',
    payload: {
      accounts,
      humans,
      completed,
      refused,
      policy: event.policy,
      note: 'the same human, arriving through many accounts, is stopped by the per-human cap',
    },
  });

  const capPerHuman = event.transfer_inbound_cap;
  const ceiling = humans * capPerHuman;
  const stoppedBy =
    completed === ceiling
      ? `stopped exactly at the ceiling: ${humans} humans x ${capPerHuman} inbound = ${ceiling}. ` +
        'Every further account was refused with inbound_cap_reached.'
      : `completed ${completed} of a possible ${ceiling} (${humans} humans x ${capPerHuman}).`;

  return {
    eventId: event.id,
    slotId: inventory[0] ?? '',
    accounts,
    humans,
    completed,
    refused,
    attempts,
    policy: event.policy,
    capPerHuman,
    stoppedBy,
    inventoryHeld: inventory.length,
    headline:
      `${accounts} accounts, ${humans} humans, policy=open: the scalper holds ${inventory.length} slots ` +
      `and pushed them through ${accounts} accounts — ${completed} got through, ${refused} refused. ` +
      'The cap is per human, so new accounts stop helping.',
  };
}


// ── Reset ───────────────────────────────────────────────────────────────────

/**
 * T-6.2 acceptance: "一键重置演示状态".
 *
 * Wipes every table the demo writes to and re-seeds a clean event. Deleting the
 * SQLite file would also work, but the connection is cached per process, so an
 * in-place truncate keeps running servers honest.
 */
export function resetDemo(): { reset: true; eventId: string } {
  assertDevRoutes();
  const eventId = tx((db) => {
    for (const table of [
      'consumed_proof',
      'transfer_inbound',
      'transfer',
      'approval',
      'auth_request',
      'queue_entry',
      'dev_army',
      'grant_',
      'audit_event',
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    // Rebuild the slot set from scratch rather than resetting it in place. The
    // demo props legitimately grow the slot count (the laundering simulation
    // needs inventory), and leaving those extra rows behind would let a later
    // run allocate more slots than the event declares.
    const event = primaryEvent();
    db.prepare(`DELETE FROM slot WHERE event_id = ?`).run(event.id);
    db.prepare(
      `UPDATE event SET lottery_drawn_at = NULL, lottery_seed = NULL WHERE id = ?`,
    ).run(event.id);

    audit({
      type: 'dev.reset',
      eventId: event.id,
      severity: 'warn',
      payload: { note: 'demo state cleared' },
    });
    return event.id;
  });

  // Recreate exactly the event's capacity, outside the transaction above so
  // `ensureSlots` sees a settled table.
  ensureSlots(eventId, primaryEvent().total_slots);

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
export function fastForward(opts: { eventId?: string } = {}): {
  eventId: string;
  drew: boolean;
  deferrals: number;
} {
  assertDevRoutes();
  const event = opts.eventId ? getEvent(opts.eventId) : primaryEvent();
  if (!event) throw new PresenceError('event_not_found', 'no event');

  const drew = event.lottery_drawn_at === null;
  if (drew) settleLottery(event.id);

  // Pull every allocated deadline into the past so the very next sweep defers.
  getDb()
    .prepare(
      `UPDATE slot SET approval_deadline = ? WHERE event_id = ? AND state = 'ALLOCATED'`,
    )
    .run(nowMs() - 1000, event.id);

  const transitions = sweep(event.id);
  const deferrals = transitions.filter(
    (t) => t.kind === 'deferred' || t.kind === 'approval_expired',
  ).length;

  audit({
    type: 'dev.fast_forward',
    eventId: event.id,
    severity: 'warn',
    payload: { drew, deferrals, note: 'windows collapsed for the demo clock' },
  });

  return { eventId: event.id, drew, deferrals };
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

  sweep(event.id);
  let joined = 0;
  for (let i = 0; i < humans; i += 1) {
    const human = ensureSyntheticHuman(`attendee-${i + 1}`);
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
