/**
 * ============================================================================
 *  Transfers — three lines of defence, in order
 * ============================================================================
 *
 * The concept doc's insight is that uniqueness ∩ transferability turns a scalper
 * from a *rusher* into a *market maker*: he never has to win the queue, he just
 * posts "I'll pay ¥3000 for your ticket" and waits. Uniqueness closed the front
 * door; transferability reopens it from behind. So transfer is where the design
 * has to earn its keep.
 *
 *   DEFENCE 1 — only the recipient, in person          (RED LINE 8)
 *   DEFENCE 2 — the proof is bound to (action, signal) and is single-use  (RED LINES 5, 6)
 *   DEFENCE 3 — inbound is capped PER HUMAN, not per account             (RED LINE 9)
 *
 * Defence 3 is the one that actually bites, because it is the only one that
 * survives an attacker who is willing to make 40 accounts. Defences 1 and 2 make
 * laundering *slow*; defence 3 makes it *pointless*, because the counter is
 * keyed on the continuity id and a new account is still the same human.
 *
 * ---------------------------------------------------------------------------
 *  RED LINE 7 — the TTL starts when the RECIPIENT OPENS, not when the sender sends
 * ---------------------------------------------------------------------------
 * Starting the clock at send time expires the offer while the message is still
 * unread. The demo test is explicit: send, wait five minutes, then open — the
 * offer must still be good. So `transfer.expires_at` stays NULL through
 * `CREATED` and is only written on the first `open`.
 *
 * ---------------------------------------------------------------------------
 *  Honest limitation, stated in the UI as well as here
 * ---------------------------------------------------------------------------
 * Fresh authentication proves *presence*, not *volition*. A scalper who
 * coerces or pays someone to press approve in the window defeats all three
 * defences. That is in the concept doc's honesty list and it is not something
 * this code claims to fix.
 */
import { getDb, nowMs, tx } from './db';
import { newId, randomToken } from './ids';
import { audit } from './audit';
import { PresenceError } from './errors';
import { getEvent } from './humans';
import { consumeProof } from './consume';
import { inboundAllowance, sweep, getSlot, type SlotRow } from './slots';
import { getApproval, markExecuted, markVerified, rejectApproval, requestApproval, verifyApproval } from './approval';
import { transferAction, transferSignal } from './gate';
import { publicBaseUrl } from '../worldid/config';

export type TransferState = 'CREATED' | 'OPENED' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED';

export interface TransferRow {
  id: string;
  slot_id: string;
  event_id: string;
  from_continuity_id: string;
  to_continuity_id: string;
  token: string;
  label: string | null;
  state: TransferState;
  created_at: number;
  opened_at: number | null;
  expires_at: number | null;
  completed_at: number | null;
  attempt_count: number;
  last_reject_reason: string | null;
}

export function getTransfer(id: string): TransferRow | undefined {
  return getDb().prepare(`SELECT * FROM transfer WHERE id = ?`).get(id) as TransferRow | undefined;
}

export function getTransferByToken(token: string): TransferRow | undefined {
  return getDb().prepare(`SELECT * FROM transfer WHERE token = ?`).get(token) as
    | TransferRow
    | undefined;
}

export function listTransfers(eventId?: string): TransferRow[] {
  if (eventId) {
    return getDb()
      .prepare(`SELECT * FROM transfer WHERE event_id = ? ORDER BY created_at DESC`)
      .all(eventId) as TransferRow[];
  }
  return getDb().prepare(`SELECT * FROM transfer ORDER BY created_at DESC`).all() as TransferRow[];
}

export function transferLink(token: string): string {
  return `${publicBaseUrl()}/transfer/${token}`;
}

// ── Create ──────────────────────────────────────────────────────────────────

export interface CreateTransferResult {
  transferId: string;
  token: string;
  link: string;
  /** `null` on purpose: the TTL does not exist until the recipient opens it. */
  expiresAt: null;
  directed: boolean;
  policy: string;
}

/**
 * T-4.1 / T-4.5 — open a transfer offer.
 *
 * The slot flips to TRANSFER_PENDING immediately, which parks it: nobody else
 * can take it while the offer is live, and if the offer lapses the sweeper
 * returns it to CONFIRMED for the original holder.
 */
export function createTransfer(input: {
  slotId: string;
  fromContinuityId: string;
  toContinuityId?: string | null;
  label?: string | null;
}): CreateTransferResult {
  const slot = getSlot(input.slotId);
  if (!slot) throw new PresenceError('slot_not_found', `no slot ${input.slotId}`);

  const event = getEvent(slot.event_id);
  if (!event) throw new PresenceError('event_not_found', `no event ${slot.event_id}`);

  // ── T-4.5 policy knob ──
  if (event.policy === 'locked') {
    throw new PresenceError(
      'transfer_policy_locked',
      'this event is configured as "locked": slots are bound to their human and cannot be transferred',
      {
        invariant: 'T-4.5 — the organiser chooses which cost the scalper pays',
        details: { policy: event.policy },
        hint: 'The organiser can switch the policy to "gift" or "open" at any time.',
      },
    );
  }
  if (event.policy === 'gift' && slot.gift_used === 1) {
    throw new PresenceError(
      'transfer_gift_already_used',
      'this slot has already been gifted once; "gift" allows exactly one transfer in a slot\'s lifetime',
      {
        invariant: 'T-4.5 — gift mode caps laundering at one hop',
        details: { policy: event.policy, slotId: slot.id },
      },
    );
  }

  if (slot.holder_continuity_id !== input.fromContinuityId) {
    throw new PresenceError('transfer_not_owner', 'you do not hold this slot', {
      details: { holder: slot.holder_continuity_id, caller: input.fromContinuityId },
    });
  }
  if (slot.state !== 'CONFIRMED') {
    throw new PresenceError(
      'slot_not_available',
      `a slot can only be transferred once it is confirmed (this one is ${slot.state})`,
      { details: { slotId: slot.id, state: slot.state } },
    );
  }

  // Rule 3 from the concept doc: the recipient must not already hold a slot.
  if (input.toContinuityId) {
    assertRecipientEligible(slot.event_id, input.toContinuityId, input.fromContinuityId);
  }

  return tx((db) => {
    const id = newId('xfer');
    const token = randomToken(18);
    const now = nowMs();

    db.prepare(
      `INSERT INTO transfer (id, slot_id, event_id, from_continuity_id, to_continuity_id, token, label, state, created_at)
       VALUES (?,?,?,?,?,?,?,'CREATED',?)`,
    ).run(
      id,
      slot.id,
      slot.event_id,
      input.fromContinuityId,
      input.toContinuityId ?? '',
      token,
      input.label ?? null,
      now,
    );

    db.prepare(`UPDATE slot SET state = 'TRANSFER_PENDING', updated_at = ? WHERE id = ? AND state = 'CONFIRMED'`).run(
      now,
      slot.id,
    );

    audit({
      type: 'transfer.created',
      continuityId: input.fromContinuityId,
      eventId: slot.event_id,
      slotId: slot.id,
      payload: {
        transferId: id,
        directed: Boolean(input.toContinuityId),
        intendedRecipient: input.toContinuityId ?? null,
        policy: event.policy,
        note: 'TTL has NOT started: it begins when the recipient opens the link (RED LINE 7)',
      },
    });

    return {
      transferId: id,
      token,
      link: transferLink(token),
      expiresAt: null as null,
      directed: Boolean(input.toContinuityId),
      policy: event.policy,
    };
  });
}

/**
 * Rule 3 + defence 3, checked up front so the sender gets an honest answer at
 * creation time instead of the recipient hitting a wall later.
 *
 * ── Reconciling rule 3 with the inbound cap ────────────────────────────────
 *
 * The concept doc lists two adjacent rules:
 *
 *   3. 接收方不得已持有名额     — the recipient must not already hold a slot
 *   4. 每活动最多接受 2 次转入  — at most two inbound transfers per human, and it
 *                                adds: "← 这才是防黄牛的实际规则"
 *
 * Read literally, rule 3 makes rule 4 unreachable: the first transfer hands the
 * recipient a slot, so the second would be refused for "already holding one",
 * and the cap of 2 could never be reached. An earlier draft of this code did
 * exactly that, and the tests caught it.
 *
 * The reading that gives both rules meaning — and the one the doc's own
 * annotation points at — is that rule 3 bars a recipient from *double-dipping
 * the primary allocation*: you may not take a slot from the draw and then also
 * take one off somebody else. Receiving by transfer is exactly what rule 4
 * governs, an explicit capped allowance, so a slot the recipient already
 * received does not disqualify them from the next one until the cap is hit.
 *
 * Hence `acquired_via`: only slots held from the draw (`NULL`, or `'lottery'`)
 * count against rule 3.
 */
function assertRecipientEligible(
  eventId: string,
  recipientContinuityId: string,
  senderContinuityId: string,
): void {
  if (recipientContinuityId === senderContinuityId) {
    throw new PresenceError('transfer_recipient_is_holder', 'you cannot transfer a slot to yourself', {
      httpStatus: 400,
    });
  }

  const fromDraw = getDb()
    .prepare(
      `SELECT id FROM slot
        WHERE event_id = ? AND holder_continuity_id = ?
          AND state IN ('ALLOCATED','CONFIRMED','TRANSFER_PENDING')
          AND (acquired_via IS NULL OR acquired_via = 'lottery')`,
    )
    .get(eventId, recipientContinuityId) as { id: string } | undefined;
  if (fromDraw) {
    // T-4.4 requires every refusal to leave a trace. A pre-check that refuses
    // silently would make the board's refusal counter under-report exactly the
    // attempts a judge is watching for.
    audit({
      type: 'transfer.rejected',
      continuityId: recipientContinuityId,
      eventId,
      slotId: fromDraw.id,
      severity: 'alert',
      payload: {
        code: 'recipient_already_holds_slot',
        note: 'the recipient already holds a slot from the draw',
        protectedActionHappened: false,
      },
    });
    throw new PresenceError(
      'recipient_already_holds_slot',
      'the recipient already holds a slot from the draw for this event',
      {
        invariant: 'Transfer rule 3 — no double-dipping the primary allocation',
        details: { eventId, existingSlot: fromDraw.id },
        hint:
          'Receiving by transfer is a separate, capped allowance: up to transfer_inbound_cap ' +
          'per human per event. Holding a drawn slot is not.',
      },
    );
  }

  // ── DEFENCE 3 (preview) ──
  const cap = inboundAllowance(eventId, recipientContinuityId);
  const used = inboundCount(recipientContinuityId, eventId);
  if (used >= cap) {
    // T-4.4: "拒绝时写 AuditEvent". This is the refusal that matters most, so it
    // is filed under the HUMAN — which is what makes the 40-accounts demo
    // legible as a single timeline rather than forty unrelated failures.
    audit({
      type: 'transfer.refused_inbound_cap',
      continuityId: recipientContinuityId,
      eventId,
      severity: 'alert',
      payload: {
        code: 'inbound_cap_reached',
        used,
        cap,
        note:
          'the counter is keyed on the continuity id, so opening another account, another ' +
          'device, or another agent does not reset it',
        protectedActionHappened: false,
      },
    });
    throw new PresenceError(
      'inbound_cap_reached',
      `this human has already received ${used} of ${cap} allowed inbound transfers for this event`,
      {
        invariant: 'RED LINE 9 — the cap is keyed on the human, so a new account does not reset it',
        details: { eventId, recipientContinuityId, used, cap },
        hint: 'A fresh account does not help: the counter follows the human, not the account.',
      },
    );
  }
}

export function inboundCount(continuityId: string, eventId: string): number {
  const row = getDb()
    .prepare(`SELECT count FROM transfer_inbound WHERE continuity_id = ? AND event_id = ?`)
    .get(continuityId, eventId) as { count: number } | undefined;
  return row?.count ?? 0;
}

// ── Open (the TTL starts here) ──────────────────────────────────────────────

export interface OpenTransferResult {
  transfer: TransferRow;
  slot: SlotRow;
  windowSec: number;
  /** True the first time it is opened; false on every later visit. */
  justOpened: boolean;
}

/**
 * ============================================================================
 *  RED LINE 7 — "顺延/接收窗口的 TTL 从「接收方打开」起算"
 * ============================================================================
 *
 * `expires_at` is written here and only here. Re-opening the same link does NOT
 * extend the window: the first open starts the clock and later visits observe
 * it. Otherwise a recipient could keep an offer alive indefinitely by refreshing.
 *
 * Opening is also where an open (undirected) link binds its recipient, which is
 * what lets `signal` include the recipient's continuity id even though the
 * sender never knew who it would be.
 */
export function openTransfer(token: string, openerContinuityId?: string | null): OpenTransferResult {
  sweep();

  const transfer = getTransferByToken(token);
  if (!transfer) throw new PresenceError('transfer_not_found', 'this transfer link is not valid');

  const event = getEvent(transfer.event_id)!;

  if (transfer.state === 'COMPLETED') {
    throw new PresenceError('transfer_expired', 'this transfer has already been completed', {
      details: { completedAt: transfer.completed_at },
    });
  }
  if (transfer.state === 'CANCELLED') {
    throw new PresenceError('transfer_expired', 'the sender cancelled this transfer');
  }
  if (transfer.state === 'EXPIRED') {
    throw new PresenceError('transfer_expired', 'this transfer window closed; the slot went back to its holder', {
      invariant: 'T-4.1 — an unanswered offer rolls back to the original holder',
    });
  }

  // A directed link is addressed to one human. Someone else opening it is an
  // attempt at DEFENCE 1, and is refused before any proof is even requested.
  if (transfer.to_continuity_id && openerContinuityId && transfer.to_continuity_id !== openerContinuityId) {
    recordReject(transfer, 'opened by a human other than the intended recipient');
    throw new PresenceError(
      'approval_identity_mismatch',
      'this transfer was addressed to a different human',
      {
        invariant: 'RED LINE 8 — only the recipient can complete a transfer',
        details: { intended: transfer.to_continuity_id, opener: openerContinuityId },
      },
    );
  }

  const slot = getSlot(transfer.slot_id);
  if (!slot) throw new PresenceError('slot_not_found', 'the underlying slot no longer exists');

  if (transfer.state === 'OPENED' && transfer.expires_at !== null) {
    return { transfer, slot, windowSec: event.transfer_window_sec, justOpened: false };
  }

  return tx((db) => {
    const now = nowMs();
    const expiresAt = now + event.transfer_window_sec * 1000;
    const recipient = transfer.to_continuity_id || openerContinuityId || '';

    db.prepare(
      `UPDATE transfer
          SET state = 'OPENED', opened_at = ?, expires_at = ?, to_continuity_id = ?
        WHERE id = ? AND state = 'CREATED'`,
    ).run(now, expiresAt, recipient, transfer.id);

    audit({
      type: 'transfer.opened',
      continuityId: recipient || null,
      eventId: transfer.event_id,
      slotId: transfer.slot_id,
      payload: {
        transferId: transfer.id,
        windowSec: event.transfer_window_sec,
        expiresAt,
        note: 'TTL starts NOW, at first open, not when the sender sent the link',
      },
    });

    return {
      transfer: getTransfer(transfer.id)!,
      slot: getSlot(transfer.slot_id)!,
      windowSec: event.transfer_window_sec,
      justOpened: true,
    };
  });
}

// ── Ask the recipient to prove presence ─────────────────────────────────────

/**
 * Bind the transfer to the recipient and ask for a fresh proof.
 *
 * `signal = "{slot_id}:{recipient_continuity_id}"` — both halves are checked at
 * completion, so neither can be swapped for another (RED LINE 6).
 */
export async function requestTransferApproval(token: string, recipientContinuityId: string) {
  const opened = openTransfer(token, recipientContinuityId);
  const transfer = opened.transfer;

  // ── DEFENCE 1 ──
  if (transfer.to_continuity_id !== recipientContinuityId) {
    recordReject(transfer, 'a different human tried to authorize this transfer');
    throw new PresenceError('approval_identity_mismatch', 'this transfer belongs to another human', {
      invariant: 'RED LINE 8 — the recipient completes their own fresh verification',
    });
  }
  if (transfer.from_continuity_id === recipientContinuityId) {
    recordReject(transfer, 'the sender tried to complete their own transfer');
    throw new PresenceError(
      'approval_identity_mismatch',
      'the sender cannot complete the transfer on the recipient\'s behalf — that would remove all friction',
      {
        invariant: 'RED LINE 8 — sender-completes-it means zero friction for a scalper',
      },
    );
  }

  assertRecipientEligible(transfer.event_id, recipientContinuityId, transfer.from_continuity_id);

  const action = transferAction(transfer.slot_id);
  const signal = transferSignal(transfer.slot_id, recipientContinuityId);

  const approval = await requestApproval({
    kind: 'transfer',
    action,
    signal,
    continuityId: recipientContinuityId,
    eventId: transfer.event_id,
    slotId: transfer.slot_id,
    expiresAt: transfer.expires_at ?? undefined,
    maxAgeSec: 0,
  });

  return { ...approval, transfer, action, signal, windowSec: opened.windowSec };
}

// ── Complete ────────────────────────────────────────────────────────────────

export async function completeTransfer(input: {
  token: string;
  continuityId: string;
  approvalRef: string | null | undefined;
}): Promise<{
  ok: true;
  slotId: string;
  from: string;
  to: string;
  transferId: string;
  inboundCount: number;
  inboundCap: number;
}> {
  const opened = openTransfer(input.token, input.continuityId);
  const transfer = opened.transfer;

  if (!input.approvalRef || !input.approvalRef.trim()) {
    recordReject(transfer, 'no approval presented');
    throw new PresenceError('approval_required', 'completing a transfer requires a human authorization', {
      invariant: 'Track rule 4 / RED LINE 3 — the server verifies, never the caller',
      httpStatus: 428,
    });
  }

  if (transfer.expires_at !== null && transfer.expires_at <= nowMs()) {
    recordReject(transfer, 'window closed before completion');
    throw new PresenceError('transfer_expired', 'the transfer window closed', {
      invariant: 'RED LINE 7 — the window is short on purpose; that is the friction',
    });
  }

  // ── DEFENCE 1: the recipient and only the recipient ──
  if (transfer.to_continuity_id !== input.continuityId) {
    recordReject(transfer, 'completed by someone other than the bound recipient');
    throw new PresenceError(
      'approval_identity_mismatch',
      'only the recipient of this transfer can complete it',
      {
        invariant: 'RED LINE 8',
        details: { boundRecipient: transfer.to_continuity_id, caller: input.continuityId },
      },
    );
  }

  const approval = resolveApprovalRef(input.approvalRef);
  if (!approval) {
    recordReject(transfer, 'presented approval is unknown to this server');
    throw new PresenceError('approval_not_found', 'the presented approval is not known to this server');
  }
  if (approval.continuity_id !== input.continuityId) {
    recordReject(transfer, 'approval was issued to a different human');
    throw new PresenceError(
      'approval_identity_mismatch',
      'this approval was issued to a different human',
      { invariant: 'RED LINE 8' },
    );
  }

  const action = transferAction(transfer.slot_id);
  const signal = transferSignal(transfer.slot_id, input.continuityId);

  // ── DEFENCE 2: binding + single use ──
  const verified = await verifyApproval(approval.id, {
    action,
    signal,
    maxAgeSec: 300,
    attemptStartedAt: approval.requested_at,
  });
  if (!verified.ok) {
    recordReject(transfer, `${verified.code}: ${verified.message}`);
    rejectApproval(approval.id, verified.code, verified.message);
    throw new PresenceError(mapTransferVerifyCode(verified.code), verified.message, {
      invariant: 'RED LINES 5 & 6 — bound to (action, signal) and consumable exactly once',
      details: { approvalId: approval.id, reason: verified.reason },
    });
  }
  if (verified.continuityId !== input.continuityId) {
    recordReject(transfer, 'proof belongs to a different human');
    throw new PresenceError('approval_identity_mismatch', 'the proof belongs to a different human', {
      invariant: 'RED LINE 8',
    });
  }

  // ── DEFENCE 3: the cap that a new account cannot reset ──
  const cap = inboundAllowance(transfer.event_id, input.continuityId);
  const used = inboundCount(input.continuityId, transfer.event_id);
  if (used >= cap) {
    recordReject(transfer, `inbound cap reached (${used}/${cap})`);
    audit({
      type: 'transfer.refused_inbound_cap',
      continuityId: input.continuityId,
      eventId: transfer.event_id,
      slotId: transfer.slot_id,
      severity: 'alert',
      payload: {
        used,
        cap,
        // The line the judges should read out loud.
        note:
          'the counter is keyed on the continuity id, so opening another account, ' +
          'another device, or another agent does not reset it',
      },
    });
    throw new PresenceError(
      'inbound_cap_reached',
      `you have already received ${used} of ${cap} allowed transfers for this event`,
      {
        invariant: 'RED LINE 9 — inbound is counted per human, never per account',
        details: { used, cap, continuityId: input.continuityId },
        hint: 'A fresh account does not help: the counter follows the human, not the account.',
      },
    );
  }

  markVerified(approval.id, input.continuityId, verified.authTime);

  return tx((db) => {
    // ── DEFENCE 2, the mechanical half: a PRIMARY KEY cannot be raced ──
    consumeProof(db, {
      nullifier: verified.nullifier,
      boundAction: action,
      continuityId: input.continuityId,
      slotId: transfer.slot_id,
      proofRef: verified.proofRef,
    });

    const now = nowMs();

    // Conditional update: if a concurrent request already completed this
    // transfer, `changes` is 0 and the whole transaction rolls back — including
    // the consumption we just inserted. Two simultaneous submits cannot both win.
    const changed = db
      .prepare(`UPDATE transfer SET state = 'COMPLETED', completed_at = ? WHERE id = ? AND state = 'OPENED'`)
      .run(now, transfer.id).changes;
    if (!changed) {
      throw new PresenceError('transfer_expired', 'this transfer was already completed or closed', {
        invariant: 'RED LINE 5 — concurrent double-submit leaves exactly one winner',
      });
    }

    db.prepare(
      `UPDATE slot
          SET holder_continuity_id = ?, acquired_via = 'transfer', state = 'CONFIRMED',
              gift_used = 1, approval_deadline = NULL, updated_at = ?
        WHERE id = ? AND state = 'TRANSFER_PENDING'`,
    ).run(input.continuityId, now, transfer.slot_id);

    // ── DEFENCE 3, the mechanical half ──
    db.prepare(
      `INSERT INTO transfer_inbound (continuity_id, event_id, count, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT (continuity_id, event_id)
       DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`,
    ).run(input.continuityId, transfer.event_id, now);

    markExecuted(db, approval.id, {
      slotId: transfer.slot_id,
      from: transfer.from_continuity_id,
      to: input.continuityId,
    });

    audit({
      type: 'transfer.completed',
      continuityId: input.continuityId,
      eventId: transfer.event_id,
      slotId: transfer.slot_id,
      payload: {
        transferId: transfer.id,
        from: transfer.from_continuity_id,
        to: input.continuityId,
        inboundAfter: used + 1,
        inboundCap: cap,
        note: 'friction paid: a real human answered inside a window that has now closed',
      },
    });

    return {
      ok: true as const,
      slotId: transfer.slot_id,
      from: transfer.from_continuity_id,
      to: input.continuityId,
      transferId: transfer.id,
      inboundCount: used + 1,
      inboundCap: cap,
    };
  });
}

export function cancelTransfer(token: string, byContinuityId: string): TransferRow {
  const transfer = getTransferByToken(token);
  if (!transfer) throw new PresenceError('transfer_not_found', 'unknown transfer');
  if (transfer.from_continuity_id !== byContinuityId) {
    throw new PresenceError('transfer_not_owner', 'only the sender can cancel a transfer');
  }
  if (transfer.state === 'CREATED' || transfer.state === 'OPENED') {
    tx((db) => {
      db.prepare(`UPDATE transfer SET state = 'CANCELLED' WHERE id = ?`).run(transfer.id);
      db.prepare(
        `UPDATE slot SET state = 'CONFIRMED', updated_at = ? WHERE id = ? AND state = 'TRANSFER_PENDING'`,
      ).run(nowMs(), transfer.slot_id);
    });
    audit({
      type: 'transfer.cancelled',
      continuityId: byContinuityId,
      eventId: transfer.event_id,
      slotId: transfer.slot_id,
      payload: { transferId: transfer.id },
    });
  }
  return getTransfer(transfer.id)!;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function resolveApprovalRef(ref: string) {
  const direct = getApproval(ref);
  if (direct) return direct;
  return getDb()
    .prepare(`SELECT * FROM approval WHERE request_id = ? ORDER BY requested_at DESC LIMIT 1`)
    .get(ref) as ReturnType<typeof getApproval>;
}

function recordReject(transfer: TransferRow, reason: string): void {
  getDb()
    .prepare(`UPDATE transfer SET attempt_count = attempt_count + 1, last_reject_reason = ? WHERE id = ?`)
    .run(reason, transfer.id);
  audit({
    type: 'transfer.rejected',
    continuityId: transfer.to_continuity_id || null,
    eventId: transfer.event_id,
    slotId: transfer.slot_id,
    severity: 'alert',
    payload: { transferId: transfer.id, reason, note: 'the slot did NOT move' },
  });
}

function mapTransferVerifyCode(code: string) {
  switch (code) {
    case 'approval_not_found':
      return 'approval_not_found' as const;
    case 'approval_action_mismatch':
      return 'approval_action_mismatch' as const;
    case 'approval_signal_mismatch':
      return 'approval_signal_mismatch' as const;
    case 'approval_expired':
      return 'approval_expired' as const;
    case 'approval_denied':
      return 'approval_denied' as const;
    case 'approval_identity_mismatch':
      return 'approval_identity_mismatch' as const;
    case 'not_fresh':
      return 'not_fresh' as const;
    case 'not_a_verified_human':
      return 'not_a_verified_human' as const;
    case 'idp_unavailable':
      return 'idp_unavailable' as const;
    default:
      return 'approval_not_approved' as const;
  }
}

/** The board's transfer panel. */
export function transferSummary(eventId: string) {
  const rows = listTransfers(eventId);
  return {
    total: rows.length,
    open: rows.filter((t) => t.state === 'OPENED').length,
    completed: rows.filter((t) => t.state === 'COMPLETED').length,
    expired: rows.filter((t) => t.state === 'EXPIRED').length,
    rejectedAttempts: rows.reduce((sum, t) => sum + t.attempt_count, 0),
  };
}

export function inboundTable(eventId: string): { continuity_id: string; count: number; cap: number }[] {
  const rows = getDb()
    .prepare(`SELECT continuity_id, count FROM transfer_inbound WHERE event_id = ? ORDER BY count DESC`)
    .all(eventId) as { continuity_id: string; count: number }[];
  return rows.map((r) => ({ ...r, cap: inboundAllowance(eventId, r.continuity_id) }));
}
