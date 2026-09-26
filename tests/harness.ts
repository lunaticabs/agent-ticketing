/**
 * Shared fixtures for the invariant tests.
 *
 * Everything here drives the *real* code paths: real queue, real draw, real
 * gate, real transfer engine. The only shortcut is the identity provider, which
 * is the documented local fallback — and a test asserts that the fallback does
 * not weaken the gate, because that is the failure mode worth guarding.
 */
import './setup';
import { getDb } from '../lib/db';
import { createEvent, ensureSyntheticHuman, type EventRow } from '../lib/humans';
import { ensureSlots, sweep } from '../lib/slots';
import { settleLottery, joinQueue } from '../lib/queue';
import { requestClaimApproval, executeClaim } from '../lib/gate';
import { syncApproval } from '../lib/approval';
import * as worldid from '../worldid';

let counter = 0;

/** A fresh event with its own slots, so tests never share state. */
export function freshEvent(opts: {
  slots?: number;
  approvalWindowSec?: number;
  lotteryMode?: 'lottery' | 'fcfs';
} = {}): EventRow {
  counter += 1;
  const id = `evt_test_${counter}_${Math.random().toString(36).slice(2, 7)}`;
  const event = createEvent({
    id,
    name: `Test event ${counter}`,
    totalSlots: opts.slots ?? 4,
    approvalWindowSec: opts.approvalWindowSec ?? 60,
    lotteryWindowSec: 15,
    lotteryMode: opts.lotteryMode ?? 'lottery',
  });
  ensureSlots(id, event.total_slots);
  return event;
}

export function human(handle: string): string {
  return ensureSyntheticHuman(handle).continuity_id;
}

/** Join, settle the draw, allocate. The ordinary path into a slot. */
export function queueAndDraw(
  eventId: string,
  handles: string[],
  actor: 'human' | 'agent' = 'human',
): string[] {
  const ids = handles.map((h) => human(h));
  for (const id of ids) joinQueue(eventId, id, actor);
  settleLottery(eventId);
  sweep(eventId);
  return ids;
}

/**
 * Complete a local authorization for an approval, exactly as the consent page does.
 * Returns the approval id the gate expects.
 */
export async function approveLocally(requestId: string, handle: string, opts: { stale?: boolean } = {}) {
  const result = worldid.completeLocalAuth(requestId, handle, {
    authTimeOverride: opts.stale ? Date.now() - 60 * 60 * 1000 : undefined,
  });
  if (!result.ok) throw new Error(`local approval failed: ${result.error}`);
  return result.continuityId!;
}

/** Ask, approve, and execute a purchase claim in one call. */
export async function purchase(eventId: string, continuityId: string, opts: { stale?: boolean } = {}) {
  const request = await requestClaimApproval(eventId, continuityId);
  await approveLocally(request.requestId, 'unused-for-step-up', opts);
  const synced = await syncApproval(request.approvalId);
  if (synced.state !== 'APPROVED') {
    throw new Error(`expected APPROVED, got ${synced.state}: ${synced.fail_reason}`);
  }
  return executeClaim({ eventId, continuityId, approvalRef: request.approvalId });
}

export function reset(): void {
  const db = getDb();
  for (const table of [
    'consumed_proof',
    'approval',
    'auth_request',
    'queue_entry',
    'dev_army',
    'grant_',
    'audit_event',
    'slot',
    'event',
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}

/** A seeded (non-sandbox) event, which is what `primaryEvent()` falls back to. */
export function seedEvent(slots = 4): EventRow {
  counter += 1;
  const id = `evt_seed_${counter}`;
  const event = createEvent({
    id,
    name: `Seeded event ${counter}`,
    totalSlots: slots,
    approvalWindowSec: 60,
    lotteryWindowSec: 15,
    lotteryMode: 'lottery',
  });
  ensureSlots(id, event.total_slots);
  return event;
}

export function count(sql: string, ...params: unknown[]): number {
  return (getDb().prepare(sql).get(...params) as { n: number }).n;
}

export { getDb };
