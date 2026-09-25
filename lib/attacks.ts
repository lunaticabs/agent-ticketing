/**
 * ============================================================================
 *  Attack demonstrations (T-6.4) — demo beat 6
 * ============================================================================
 *
 * Three attacks, each of which a judge could plausibly try by hand, each of
 * which the server refuses on its own, and each of which ends by *confirming
 * that the protected action did not happen*. That last part is the acceptance
 * criterion: "攻击失败后确认受保护动作没有发生（查数据库状态）".
 *
 *   1. REPLAY      present an already-spent approval a second time
 *   2. PARAMETER   present a valid approval against different (slot, recipient)
 *   3. ENVIRONMENT submit a proof that claims a friendlier environment
 *
 * Every one of these returns a structured reason plus a `verification` block
 * read straight back out of the database, so the claim "nothing happened" is
 * evidence rather than narration.
 */
import { getDb } from './db';
import { PresenceError } from './errors';
import { audit } from './audit';
import { consumeProof } from './consume';
import { listApprovals, verifyApproval } from './approval';
import { transferAction, transferSignal, executeClaim, purchaseAction, purchaseSignal } from './gate';
import { listSlots } from './slots';
import { primaryEvent, getEvent } from './humans';
import { WORLDID_ENVIRONMENT, WORLDID_ISSUER } from '../worldid/config';

export interface AttackOutcome {
  attack: 'replay' | 'parameter_tamper' | 'environment_swap';
  title: string;
  blocked: boolean;
  code: string;
  message: string;
  invariant: string;
  /** What the attacker tried, in plain language, for the projector. */
  narrative: string;
  /** Read back out of the database after the attempt. */
  verification: {
    protectedActionHappened: boolean;
    detail: string;
  };
}

// ── Attack 1: replay ────────────────────────────────────────────────────────

/**
 * Present a spent approval again.
 *
 * Two independent guards should stop it, and it is worth showing both because
 * they protect different things:
 *
 *   * the per-action entitlement (`UNIQUE (bound_action, continuity_id)`) —
 *     RED LINE 1, "this human already bought this event"
 *   * the nullifier PRIMARY KEY — RED LINE 5, "this exact proof is spent"
 */
export async function attackReplay(eventId?: string): Promise<AttackOutcome> {
  const event = eventId ? getEvent(eventId) : primaryEvent();
  if (!event) throw new PresenceError('event_not_found', 'no event');

  const spent = listApprovals({ eventId: event.id, limit: 50 }).find(
    (a) => a.state === 'CONSUMED' && a.kind === 'purchase',
  );

  if (!spent) {
    throw new PresenceError(
      'bad_request',
      'there is no consumed purchase approval to replay yet — claim a slot first',
      { httpStatus: 400, hint: 'Run demo beat 2, then press this button.' },
    );
  }

  const before = protectedActionFingerprint();

  // Attempt A: replay through the real gate.
  let gateCode = 'unknown';
  let gateMessage = '';
  try {
    await executeClaim({
      eventId: event.id,
      continuityId: spent.continuity_id,
      approvalRef: spent.id,
    });
    gateCode = 'NOT_BLOCKED';
    gateMessage = 'the gate accepted a spent approval — this is a bug';
  } catch (err) {
    gateCode = err instanceof PresenceError ? err.code : 'internal_error';
    gateMessage = err instanceof Error ? err.message : String(err);
  }

  // Attempt B: drive the nullifier straight at the primary key, so the guard
  // that protects against a *different* code path is shown to be armed too.
  let constraintCode = 'not_reached';
  let constraintMessage = '';
  if (spent.nullifier) {
    try {
      // Deliberately rolled back: we want the constraint's verdict, not its
      // side effects. `better-sqlite3` transactions roll back on throw.
      getDb().transaction(() => {
        consumeProof(getDb(), {
          nullifier: spent.nullifier!,
          boundAction: spent.bound_action,
          continuityId: spent.continuity_id,
          slotId: spent.slot_id,
        });
      })();
      constraintCode = 'NOT_BLOCKED';
      constraintMessage = 'the nullifier was accepted twice — this is a bug';
    } catch (err) {
      constraintCode = err instanceof PresenceError ? err.code : 'internal_error';
      constraintMessage = err instanceof Error ? err.message : String(err);
    }
  }

  const after = protectedActionFingerprint();
  const blocked = after.slotsHeld === before.slotsHeld && after.consumed === before.consumed;

  audit({
    type: 'attack.blocked',
    continuityId: spent.continuity_id,
    eventId: event.id,
    slotId: spent.slot_id,
    severity: 'alert',
    payload: {
      attack: 'replay',
      gateCode,
      constraintCode,
      protectedActionHappened: !blocked,
    },
  });

  return {
    attack: 'replay',
    title: 'Replay a spent approval',
    blocked,
    code: gateCode,
    message:
      `gate → ${gateCode}: ${gateMessage}` +
      (constraintMessage ? ` | nullifier PRIMARY KEY → ${constraintCode}: ${constraintMessage}` : ''),
    invariant:
      'RED LINE 5 (nullifier consumed exactly once) and RED LINE 1 (one entitlement per human per action)',
    narrative:
      'Take the approval that already bought a slot and submit it again. Two independent guards ' +
      'fire: the per-action entitlement is already recorded for this human, and the nullifier is ' +
      'already in the primary key. Either one alone would have stopped it.',
    verification: {
      protectedActionHappened: !blocked,
      detail:
        blocked
          ? `consumed_proof rows unchanged (${after.consumed}), slots held by this human unchanged (${after.slotsHeld})`
          : 'state changed — investigate immediately',
    },
  };
}

// ── Attack 2: parameter tampering ───────────────────────────────────────────

/**
 * RED LINE 6 — "approval 必须绑定 (action, signal)，参数不符即拒".
 *
 * A proof that is valid for slot A must be worthless for slot B. Three variants
 * are run, because three different bindings have to hold:
 *
 *   a. same human, different slot       → signal mismatch
 *   b. same slot, different recipient   → signal mismatch
 *   c. transfer proof used to buy       → action mismatch
 */
export async function attackParameterTamper(eventId?: string): Promise<AttackOutcome> {
  const event = eventId ? getEvent(eventId) : primaryEvent();
  if (!event) throw new PresenceError('event_not_found', 'no event');

  const approvals = listApprovals({ eventId: event.id, limit: 50 });
  const transferApproval = approvals.find((a) => a.kind === 'transfer');

  if (!transferApproval) {
    throw new PresenceError(
      'bad_request',
      'there is no transfer approval to tamper with yet — run a transfer first',
      { httpStatus: 400, hint: 'Run demo beat 5, then press this button.' },
    );
  }

  const slots = listSlots(event.id);
  const otherSlot = slots.find((s) => s.id !== transferApproval.slot_id);
  const before = protectedActionFingerprint();

  const probes: { variant: string; code: string; message: string }[] = [];

  // (a) point the proof at a different slot
  if (otherSlot) {
    const r = await verifyApproval(transferApproval.id, {
      action: transferAction(otherSlot.id),
      signal: transferSignal(otherSlot.id, transferApproval.continuity_id),
    });
    probes.push({
      variant: `retarget the proof from ${transferApproval.slot_id} to ${otherSlot.id}`,
      code: r.ok ? 'NOT_BLOCKED' : r.code,
      message: r.ok ? 'the server accepted a retargeted proof — this is a bug' : r.message,
    });
  }

  // (b) point the proof at a different recipient
  {
    const r = await verifyApproval(transferApproval.id, {
      action: transferApproval.bound_action,
      signal: transferSignal(transferApproval.slot_id!, 'cid_someone_else_entirely'),
    });
    probes.push({
      variant: 'swap the recipient inside the signal',
      code: r.ok ? 'NOT_BLOCKED' : r.code,
      message: r.ok ? 'the server accepted a swapped recipient — this is a bug' : r.message,
    });
  }

  // (c) use a transfer proof to authorize a purchase
  {
    const r = await verifyApproval(transferApproval.id, {
      action: purchaseAction(event.id),
      signal: purchaseSignal(event.id, transferApproval.continuity_id),
    });
    probes.push({
      variant: 'use a transfer proof to authorize a purchase',
      code: r.ok ? 'NOT_BLOCKED' : r.code,
      message: r.ok ? 'the server accepted a cross-action proof — this is a bug' : r.message,
    });
  }

  const after = protectedActionFingerprint();
  const blocked = probes.every((p) => p.code !== 'NOT_BLOCKED') && after.slotsHeld === before.slotsHeld;

  audit({
    type: 'attack.blocked',
    continuityId: transferApproval.continuity_id,
    eventId: event.id,
    slotId: transferApproval.slot_id,
    severity: 'alert',
    payload: { attack: 'parameter_tamper', probes, protectedActionHappened: !blocked },
  });

  return {
    attack: 'parameter_tamper',
    title: 'Tamper with the approval parameters',
    blocked,
    code: probes.find((p) => p.code !== 'NOT_BLOCKED')?.code ?? 'NOT_BLOCKED',
    message: probes.map((p) => `${p.variant} → ${p.code}`).join('; '),
    invariant: 'RED LINE 6 — the approval is bound to (action, signal); a mismatch is refused',
    narrative:
      'The approval is genuine, the human is genuine, the proof is genuine. Only the parameters ' +
      'are different. Each variant is refused before anything is consumed.',
    verification: {
      protectedActionHappened: !blocked,
      detail: blocked
        ? `all ${probes.length} variants refused; slot holders unchanged (${after.slotsHeld})`
        : 'a variant was accepted — investigate immediately',
    },
  };
}

// ── Attack 3: environment swap ──────────────────────────────────────────────

/**
 * RED LINE 4 — "environment 由服务端 pin 死，不接受客户端传参".
 *
 * The attack is the one the World docs warn about by name: claim a laxer
 * environment so a test proof is accepted. There are two halves to the refusal
 * and both are shown:
 *
 *   * the request-level guard rejects any body that names an environment
 *   * even if it slipped through, the proof reference must resolve to an
 *     attempt this server minted against the pinned issuer
 */
export async function attackEnvironmentSwap(
  eventId?: string,
  presented?: Record<string, unknown>,
): Promise<AttackOutcome> {
  const event = eventId ? getEvent(eventId) : primaryEvent();
  if (!event) throw new PresenceError('event_not_found', 'no event');

  const before = protectedActionFingerprint();
  const body = presented ?? { environment: 'production', proof: { ok: true } };

  // Guard 1: the request-side refusal, exactly as the route would apply it.
  const { guardClientSuppliedEnvironment, guardForgedClientResult } = await import('./api');
  const refusals: { guard: string; code: string; message: string }[] = [];

  try {
    guardClientSuppliedEnvironment(body);
    refusals.push({ guard: 'environment pin', code: 'NOT_BLOCKED', message: 'no environment was rejected' });
  } catch (err) {
    const e = err as PresenceError;
    refusals.push({ guard: 'environment pin', code: e.code, message: e.message });
  }

  try {
    guardForgedClientResult(body);
    refusals.push({ guard: 'forged client verdict', code: 'NOT_BLOCKED', message: 'no verdict was rejected' });
  } catch (err) {
    const e = err as PresenceError;
    refusals.push({ guard: 'forged client verdict', code: e.code, message: e.message });
  }

  // Guard 2: a proof reference that this server never minted resolves to nothing.
  let unknownRefCode = 'not_attempted';
  if (typeof body.proofRef === 'string' && body.proofRef) {
    const { verifyOnServer } = await import('../worldid');
    const r = await verifyOnServer(body.proofRef, {
      action: purchaseAction(event.id),
      signal: purchaseSignal(event.id, 'cid_attacker'),
    });
    unknownRefCode = r.ok ? 'NOT_BLOCKED' : r.code;
  }

  const after = protectedActionFingerprint();
  const blocked = refusals.every((r) => r.code !== 'NOT_BLOCKED') && after.consumed === before.consumed;

  audit({
    type: 'attack.blocked',
    eventId: event.id,
    severity: 'alert',
    payload: { attack: 'environment_swap', presented: body, refusals, unknownRefCode },
  });

  return {
    attack: 'environment_swap',
    title: 'Claim a laxer environment',
    blocked,
    code: refusals[0]?.code ?? 'environment_pinned',
    message: refusals.map((r) => `${r.guard}: ${r.code}`).join('; '),
    invariant:
      'RED LINE 4 — the environment is a server constant, so a client cannot select one that accepts test proofs',
    narrative:
      `The attacker submits environment="production" plus a hand-written {ok:true} verdict. ` +
      `The server pins ${WORLDID_ENVIRONMENT} at ${WORLDID_ISSUER} and refuses both.`,
    verification: {
      protectedActionHappened: !blocked,
      detail: blocked
        ? `no proof consumed (${after.consumed}); the request never reached the gate`
        : 'state changed — investigate immediately',
    },
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** A cheap fingerprint of "did a protected action happen". */
function protectedActionFingerprint(): { slotsHeld: number; consumed: number } {
  const slotsHeld = (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM slot WHERE state IN ('CONFIRMED','TRANSFERRED')`)
      .get() as { n: number }
  ).n;
  const consumed = (
    getDb().prepare(`SELECT COUNT(*) AS n FROM consumed_proof`).get() as { n: number }
  ).n;
  return { slotsHeld, consumed };
}

export async function runAllAttacks(eventId?: string): Promise<AttackOutcome[]> {
  const results: AttackOutcome[] = [];
  // Each attack is independent; a missing precondition is reported rather than
  // aborting the rest, so one button can drive the whole beat on stage.
  for (const run of [attackReplay, attackParameterTamper, attackEnvironmentSwap]) {
    try {
      results.push(await run(eventId));
    } catch (err) {
      const e = err as PresenceError;
      results.push({
        attack:
          run === attackReplay
            ? 'replay'
            : run === attackParameterTamper
              ? 'parameter_tamper'
              : 'environment_swap',
        title: 'not applicable yet',
        blocked: true,
        code: e.code ?? 'bad_request',
        message: e.message,
        invariant: e.invariant ?? '',
        narrative: 'The precondition for this attack has not happened yet on stage.',
        verification: { protectedActionHappened: false, detail: 'nothing was attempted' },
      });
    }
  }
  return results;
}
