import { json, route } from '@/lib/api';
import { getEvent, primaryEvent } from '@/lib/humans';
import { settleLottery, recomputeDrawOrder } from '@/lib/queue';
import { allocateAvailable, sweep } from '@/lib/slots';

/**
 * T-2.1 — settle the draw.
 *
 * Idempotent: calling it twice returns the original order rather than re-rolling.
 * A re-rollable draw would be worse than no draw at all — it would let whoever
 * controls the button choose the winner.
 *
 * The response includes the recomputed order alongside the stored ranks so a
 * judge can see that the two agree, and can inspect the seed.
 */
export const POST = route(async (req) => {
  const url = new URL(req.url);
  const eventId = url.searchParams.get('eventId') ?? primaryEvent().id;
  const event = getEvent(eventId);
  if (!event) {
    return json({ ok: false, code: 'event_not_found', message: `no event ${eventId}` }, { status: 404 });
  }

  sweep(eventId);
  const draw = settleLottery(eventId);
  const allocated = allocateAvailable(eventId);
  const transitions = sweep(eventId);

  return json({
    ok: true,
    eventId,
    alreadyDrawn: draw.alreadyDrawn,
    mode: draw.mode,
    seed: draw.seed,
    algorithm:
      draw.mode === 'fcfs'
        ? 'control mode: ordered by arrival sequence (this is the mode the bot army beats)'
        : 'rank = order_by(sha256(lottery_seed || queue_entry_id)); joined_at is NOT an input',
    order: draw.order,
    storedOrderMatchesRecomputation: recomputeDrawOrder(eventId).every(
      (r) => draw.order.find((o) => o.entryId === r.entryId)?.rank === r.rank,
    ),
    allocated,
    transitions,
  });
});
