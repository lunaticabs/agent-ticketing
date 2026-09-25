import { json, route, requireContinuity } from '@/lib/api';
import { joinQueue, myEntry, queueLength, queueStats } from '@/lib/queue';
import { primaryEvent, getEvent } from '@/lib/humans';
import { sweep } from '@/lib/slots';

/**
 * T-1.1 — join the queue.
 *
 * A session is required, and a session can only come from a verified human, so
 * "未验证用户无法入队" is enforced by the session layer rather than by a flag
 * here. Idempotency comes from the UNIQUE (event_id, continuity_id) constraint:
 * refreshing the page cannot buy a second entry, and therefore cannot improve
 * anyone's odds.
 */
export const POST = route(async (req) => {
  const continuityId = requireContinuity(req);
  const url = new URL(req.url);
  const eventId = url.searchParams.get('eventId') ?? primaryEvent().id;

  const event = getEvent(eventId);
  if (!event) {
    return json({ ok: false, code: 'event_not_found', message: `no event ${eventId}` }, { status: 404 });
  }

  sweep(eventId);
  const result = joinQueue(eventId, continuityId);

  return json({
    ok: true,
    created: result.created,
    eventId,
    continuityId,
    entryId: result.entry.id,
    arrivalSeq: result.entry.seq,
    lotteryRank: result.entry.lottery_rank,
    vip: result.vip,
    queueLength: queueLength(eventId),
    note: result.created
      ? 'joined. Arrival order is recorded for the FCFS control mode only — the draw does not read it.'
      : 'already in the queue; the existing entry was returned unchanged',
  });
});
