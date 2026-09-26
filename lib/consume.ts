/**
 * ============================================================================
 *  Proof consumption — the one place a proof stops being usable.
 * ============================================================================
 *
 * RED LINE 5: "每份 approval 只能消费一次，以 nullifier 为唯一键".
 *
 * The official human-in-the-loop sample is blunt about how to do it:
 *
 *   if (!(await consumeApproval(`${expectedAction}:${nullifier}`))) {
 *     throw new Error('approval already used')
 *   }
 *   // "One-time use, keyed on the proof's nullifier. Parse it as the verifier
 *   //  does, so '0x01' and '0x1' share a key."
 *
 * The difference here is that the key is not a Map — it is a PRIMARY KEY. Two
 * concurrent double-clicks both reach `INSERT`; exactly one of them gets a row
 * back and the other gets SQLITE_CONSTRAINT_PRIMARYKEY. An application-level
 * "SELECT then INSERT" would let both through, which is precisely the bug that
 * a demo double-click exposes on stage.
 *
 * `consumeProof` deliberately does NOT open its own transaction. Callers pass
 * the consuming statement into a larger transaction (flip the slot, bump the
 * counter, write the audit row) so that "proof consumed" and "protected action
 * executed" commit together or not at all.
 */
import type { DB } from './db';
import { getDb, nowMs } from './db';
import { HumanGateError } from './errors';

export interface ConsumeInput {
  nullifier: string;
  boundAction: string;
  continuityId: string;
  slotId?: string | null;
  proofRef?: string | null;
}

export interface ConsumedRow {
  nullifier: string;
  bound_action: string;
  continuity_id: string;
  slot_id: string | null;
  proof_ref: string | null;
  consumed_at: number;
}

/**
 * Insert the consumption row. Throws a structured refusal if the key is taken.
 *
 * Must be called inside a transaction.
 */
export function consumeProof(db: DB, input: ConsumeInput): void {
  try {
    db.prepare(
      `INSERT INTO consumed_proof (nullifier, bound_action, continuity_id, slot_id, proof_ref, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.nullifier,
      input.boundAction,
      input.continuityId,
      input.slotId ?? null,
      input.proofRef ?? null,
      nowMs(),
    );
    return;
  } catch (err) {
    const code = (err as { code?: string }).code ?? '';
    if (!code.startsWith('SQLITE_CONSTRAINT')) throw err;

    // Which constraint fired decides what we tell the caller. Both are
    // refusals, but they mean different things and the difference is the
    // project's entire argument, so they must not be collapsed.
    const existing = lookup(db, input.nullifier);

    if (code.includes('PRIMARYKEY') || (existing && existing.nullifier === input.nullifier)) {
      throw new HumanGateError(
        'proof_replay_detected',
        'this proof has already been consumed — a proof is single-use',
        {
          invariant: 'RED LINE 5 — one-time consumption keyed on the nullifier',
          details: { nullifier: input.nullifier, boundAction: input.boundAction },
          hint: 'Ask the human for a fresh authorization; the previous one cannot be replayed.',
        },
      );
    }

    throw new HumanGateError(
      'already_owns_entitlement',
      'this human already exercised this action — one person, one entitlement per action',
      {
        invariant: 'RED LINE 1 — action bound to the purchase, so the nullifier is per-person-per-action',
        details: { boundAction: input.boundAction, continuityId: input.continuityId },
        hint: 'A different action (for example a different event) would succeed.',
      },
    );
  }
}

function lookup(db: DB, nullifier: string): ConsumedRow | undefined {
  return db.prepare(`SELECT * FROM consumed_proof WHERE nullifier = ?`).get(nullifier) as
    | ConsumedRow
    | undefined;
}

export function findConsumed(nullifier: string): ConsumedRow | undefined {
  return lookup(getDb(), nullifier);
}

export function consumedCountForAction(boundAction: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM consumed_proof WHERE bound_action = ?`)
    .get(boundAction) as { n: number };
  return row.n;
}

/** Dev/reset helper: wipe consumption state so the demo can be replayed. */
export function clearConsumed(): void {
  getDb().prepare(`DELETE FROM consumed_proof`).run();
}
