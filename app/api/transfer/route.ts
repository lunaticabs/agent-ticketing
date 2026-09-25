import { json, route, requireContinuity, readJson } from '@/lib/api';
import { createTransfer, listTransfers } from '@/lib/transfer';
import { primaryEvent } from '@/lib/humans';
import { sweep } from '@/lib/slots';

/** Create a transfer offer. The TTL does NOT start yet (RED LINE 7). */
export const POST = route(async (req) => {
  const continuityId = requireContinuity(req);
  const body = await readJson(req);
  const { guardClientSuppliedEnvironment } = await import('@/lib/api');
  guardClientSuppliedEnvironment(body);

  const slotId = String(body.slotId ?? '');
  if (!slotId) {
    return json({ ok: false, code: 'bad_request', message: 'slotId is required' }, { status: 400 });
  }

  const result = createTransfer({
    slotId,
    fromContinuityId: continuityId,
    toContinuityId: typeof body.to === 'string' && body.to ? body.to : null,
    label: typeof body.label === 'string' ? body.label : null,
  });

  return json({
    ok: true,
    ...result,
    stage: 'created',
    note:
      'The window has not started. It begins when the recipient opens the link (RED LINE 7), ' +
      'so a message that sits unread does not burn the offer.',
  });
});

export const GET = route(async (req) => {
  requireContinuity(req);
  const url = new URL(req.url);
  const eventId = url.searchParams.get('eventId') ?? primaryEvent().id;
  sweep(eventId);
  const rows = listTransfers(eventId);
  const now = Date.now();
  return json({
    ok: true,
    transfers: rows.map((t) => ({
      id: t.id,
      slotId: t.slot_id,
      from: t.from_continuity_id,
      to: t.to_continuity_id || null,
      state: t.state,
      openedAt: t.opened_at,
      expiresAt: t.expires_at,
      remainingMs: t.expires_at ? Math.max(0, t.expires_at - now) : null,
      attemptCount: t.attempt_count,
      lastRejectReason: t.last_reject_reason,
    })),
  });
});
