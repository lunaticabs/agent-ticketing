import { json, route, requireContinuity, readJson } from '@/lib/api';
import { getApproval, syncApproval, denyApproval } from '@/lib/approval';

/**
 * Approval status — the polling endpoint behind T-3.3's four-stage display.
 *
 * GET advances the local record by reading the World ID side (stage 2), and
 * returns all four timestamps plus a `stage` label so the UI can render the loop
 * without inferring anything.
 */
export const GET = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const continuityId = requireContinuity(req);
  const { id } = await ctx.params;

  const existing = getApproval(id);
  if (!existing) {
    return json({ ok: false, code: 'approval_not_found', message: `no approval ${id}` }, { status: 404 });
  }

  const row = await syncApproval(id);
  const now = Date.now();

  return json({
    ok: true,
    approvalId: row.id,
    kind: row.kind,
    state: row.state,
    isMine: row.continuity_id === continuityId,
    continuityId: row.continuity_id,
    boundAction: row.bound_action,
    boundSignal: row.bound_signal,
    slotId: row.slot_id,
    failReason: row.fail_reason,
    authTime: row.auth_time,
    expiresAt: row.expires_at,
    remainingMs: Math.max(0, row.expires_at - now),
    stage: stageOf(row),
    // T-3.3 — the four stages, named for the projector.
    stages: [
      { key: 'requested', label: '1 · request issued', at: row.requested_at },
      { key: 'completed', label: '2 · human completed on device', at: row.completed_at },
      { key: 'verified', label: '3 · server verified the proof', at: row.verified_at },
      { key: 'executed', label: '4 · protected action executed', at: row.executed_at },
    ],
    proofHeldByServer: Boolean(row.proof_ref),
    note: 'The raw proof never leaves the server; this response carries only the reference.',
  });
});

/** The human presses deny. Nothing executes, and the slot deferral clock keeps running. */
export const POST = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const continuityId = requireContinuity(req);
  const { id } = await ctx.params;
  const body = await readJson(req);

  const existing = getApproval(id);
  if (!existing) {
    return json({ ok: false, code: 'approval_not_found', message: `no approval ${id}` }, { status: 404 });
  }
  if (existing.continuity_id !== continuityId) {
    return json(
      { ok: false, code: 'approval_identity_mismatch', message: 'this approval is not yours to decide' },
      { status: 403 },
    );
  }

  const row = denyApproval(id, typeof body.reason === 'string' ? body.reason : 'denied by the human');
  return json({
    ok: true,
    approvalId: row.id,
    state: row.state,
    stage: stageOf(row),
    note: 'Denied. The protected action did not run, and the slot will defer when its window closes.',
  });
});

function stageOf(row: { executed_at: number | null; verified_at: number | null; completed_at: number | null; state: string }): string {
  if (row.executed_at) return 'executed';
  if (row.verified_at) return 'verified';
  if (row.completed_at) return 'completed';
  if (row.state === 'DENIED') return 'denied';
  if (row.state === 'EXPIRED') return 'expired';
  return 'requested';
}
