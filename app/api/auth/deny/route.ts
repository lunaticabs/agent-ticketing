import { json, route, readJson } from '@/lib/api';
import * as worldid from '@/worldid';
import { audit } from '@/lib/audit';

/**
 * The human said no.
 *
 * Denial is a first-class outcome with its own terminal state, not an absence of
 * approval. The distinction matters because the board has to be able to show
 * "refused" — the track's requirement 3 is that a failure path is *demonstrated*,
 * and a failure that leaves no trace cannot be demonstrated.
 *
 * Nothing is consumed and nothing executes: the request moves to DENIED and the
 * slot's own countdown keeps running until it defers.
 */
export const POST = route(async (req) => {
  const body = await readJson(req);
  const requestId = String(body.requestId ?? body.approvalId ?? '');
  if (!requestId) {
    return json({ ok: false, code: 'bad_request', message: 'requestId is required' }, { status: 400 });
  }

  const row = worldid.getAuthRequestRow(requestId);
  if (!row) {
    return json({ ok: false, code: 'not_found', message: 'unknown request' }, { status: 404 });
  }

  worldid.denyAuth(requestId, typeof body.reason === 'string' ? body.reason : 'denied by the human');

  audit({
    type: 'auth.denied',
    continuityId: row.continuity_id,
    eventId: null,
    severity: 'warn',
    payload: {
      requestId,
      action: row.action,
      signal: row.signal,
      note: 'the protected action did NOT run; the slot keeps its own countdown and will defer',
    },
  });

  return json({
    ok: true,
    requestId,
    state: 'DENIED',
    note: 'Denied. No proof was consumed and the protected action will not run.',
  });
});
