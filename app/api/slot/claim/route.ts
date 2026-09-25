import { json, route, requireContinuity, readJson } from '@/lib/api';
import { executeClaim } from '@/lib/gate';
import { primaryEvent } from '@/lib/humans';

/**
 * ============================================================================
 *  The purchase gate over HTTP.
 * ============================================================================
 *
 * Identical logic to the MCP `slot.claim` tool, because both call
 * `lib/gate.executeClaim`. There is no second implementation to drift.
 *
 * Two guards run before anything else, and both are refusals rather than
 * silent filters:
 *
 *   * `guardClientSuppliedEnvironment` — RED LINE 4. A body that names an
 *     environment (allowed test-proof environments are the classic bypass) is
 *     rejected and audited.
 *   * `guardForgedClientResult` — RED LINE 3. A body that carries a verdict
 *     (`{ok:true}`, `clientResult`, a `proof` object) is rejected. The client may
 *     report what it did; it may not report what the outcome was.
 *
 * Then the gate looks the approval up in server state, re-checks the binding,
 * re-checks freshness, and consumes the nullifier through a PRIMARY KEY. The
 * presence of the `approval` field buys a caller nothing on its own — which is
 * the entire point of T-1.3 and T-3.4.
 */
export const POST = route(async (req) => {
  const continuityId = requireContinuity(req);
  const body = await readJson(req);

  const { guardClientSuppliedEnvironment, guardForgedClientResult } = await import('@/lib/api');
  guardClientSuppliedEnvironment(body);
  guardForgedClientResult(body);

  const eventId = typeof body.eventId === 'string' ? body.eventId : primaryEvent().id;
  const approvalRef =
    typeof body.approval === 'string'
      ? body.approval
      : typeof body.approvalRef === 'string'
        ? body.approvalRef
        : null;

  const result = await executeClaim({ eventId, continuityId, approvalRef });

  return json({
    ...result,
    stage: 'executed',
    note:
      'The server verified the approval itself: binding, freshness and one-time consumption ' +
      'all passed before this slot moved.',
  });
});
