import { json, route, requireContinuity, readJson } from '@/lib/api';
import {
  completeTransfer,
  getTransferByToken,
  openTransfer,
  requestTransferApproval,
  cancelTransfer,
} from '@/lib/transfer';
import { getSlot } from '@/lib/slots';

/**
 * The recipient's side of a transfer.
 *
 * `GET` deliberately does NOT open the transfer: viewing a link and accepting it
 * are different acts, and the TTL must start on the second one. A preview
 * request from a chat client's link unfurler should not burn the window.
 *
 * `POST` with `action`:
 *   `open`      — start the window and bind the recipient
 *   `request`   — bind, then ask this human for a fresh proof
 *   `complete`  — present the approval; the server verifies and moves the slot
 *   `cancel`    — sender withdraws the offer
 */
export const GET = route(async (req, ctx: { params: Promise<{ token: string }> }) => {
  const { token } = await ctx.params;
  const transfer = getTransferByToken(token);
  if (!transfer) {
    return json({ ok: false, code: 'transfer_not_found', message: 'this link is not valid' }, { status: 404 });
  }
  const slot = getSlot(transfer.slot_id);
  const now = Date.now();
  return json({
    ok: true,
    transferId: transfer.id,
    slotId: transfer.slot_id,
    from: transfer.from_continuity_id,
    to: transfer.to_continuity_id || null,
    state: transfer.state,
    label: transfer.label,
    opened: transfer.opened_at !== null,
    openedAt: transfer.opened_at,
    expiresAt: transfer.expires_at,
    remainingMs: transfer.expires_at ? Math.max(0, transfer.expires_at - now) : null,
    slotState: slot?.state ?? null,
    note: transfer.opened_at
      ? 'The window is already running; opening the page again does not extend it.'
      : 'The window starts when you press Accept (RED LINE 7).',
  });
});

export const POST = route(async (req, ctx: { params: Promise<{ token: string }> }) => {
  const { token } = await ctx.params;
  const body = await readJson(req);
  const { guardClientSuppliedEnvironment } = await import('@/lib/api');
  guardClientSuppliedEnvironment(body);

  const action = String(body.action ?? 'open');

  if (action === 'cancel') {
    const continuityId = requireContinuity(req);
    const row = cancelTransfer(token, continuityId);
    return json({ ok: true, state: row.state, note: 'offer withdrawn; the slot is back with you' });
  }

  const continuityId = requireContinuity(req);

  if (action === 'open') {
    const opened = openTransfer(token, continuityId);
    return json({
      ok: true,
      stage: 'opened',
      transferId: opened.transfer.id,
      state: opened.transfer.state,
      justOpened: opened.justOpened,
      expiresAt: opened.transfer.expires_at,
      windowSec: opened.windowSec,
      note: opened.justOpened
        ? `Window started now: ${opened.windowSec}s from this moment, as the recipient opened it.`
        : 'Already open; the original window is still the one that counts.',
    });
  }

  if (action === 'request') {
    const requested = await requestTransferApproval(token, continuityId);
    return json({
      ok: true,
      stage: 'requested',
      approvalId: requested.approvalId,
      requestId: requested.requestId,
      mode: requested.mode,
      degraded: requested.degraded,
      boundAction: requested.action,
      boundSignal: requested.signal,
      expiresAt: requested.expiresAt,
      ...(requested.url ? { url: requested.url } : {}),
      ...(requested.deviceCode ? { deviceCode: requested.deviceCode } : {}),
      note: requested.note,
    });
  }

  if (action === 'complete') {
    const approvalRef =
      typeof body.approval === 'string'
        ? body.approval
        : typeof body.approvalRef === 'string'
          ? body.approvalRef
          : null;

    const result = await completeTransfer({ token, continuityId, approvalRef });
    return json({
      ...result,
      stage: 'transferred',
      note:
        'Friction paid: one real human answered inside a window that has now closed, and the ' +
        'receipt is filed under their continuity id.',
    });
  }

  return json({ ok: false, code: 'bad_request', message: `unknown action "${action}"` }, { status: 400 });
});
