import { json, route, requireContinuity } from '@/lib/api';
import { myEntry, lotteryWindowFor, queueStats, listQueue } from '@/lib/queue';
import { primaryEvent, getEvent } from '@/lib/humans';
import { allocatedSlotsFor, heldSlotsFor, slotSummary, sweep } from '@/lib/slots';
import { activeGrants } from '@/lib/grants';
import { openApprovalViews } from '@/lib/approval';

/**
 * Where am I, and what can I do next?
 *
 * Sweeps first, so the answer reflects the clock rather than the last time
 * somebody happened to write to the database.
 */
export const GET = route(async (req) => {
  const continuityId = requireContinuity(req);
  const url = new URL(req.url);
  const eventId = url.searchParams.get('eventId') ?? primaryEvent().id;
  const event = getEvent(eventId);
  if (!event) {
    return json({ ok: false, code: 'event_not_found', message: `no event ${eventId}` }, { status: 404 });
  }

  const transitions = sweep(eventId);
  const entry = myEntry(eventId, continuityId);
  const allocated = allocatedSlotsFor(eventId, continuityId);
  const held = heldSlotsFor(eventId, continuityId);
  const now = Date.now();

  const granted = activeGrants(continuityId, eventId);
  return json({
    ok: true,
    serverNow: now,
    continuityId,
    event: {
      id: event.id,
      name: event.name,
      lotteryMode: event.lottery_mode,
      lotteryDrawn: event.lottery_drawn_at !== null,
    },
    // Everything the console needs to say "a draw is running" instead of looking
    // frozen: when the window opened, when it closes, and who is in it.
    lottery: lotteryWindowFor(eventId, now),
    queue: {
      entryId: entry?.id ?? null,
      joined: Boolean(entry),
      arrivalSeq: entry?.seq ?? null,
      lotteryRank: entry?.lottery_rank ?? null,
      allocatedAt: entry?.allocated_at ?? null,
      stats: queueStats(eventId),
      total: listQueue(eventId).length,
    },
    allocation: allocated.map((s) => ({
      slotId: s.id,
      deadline: s.approval_deadline,
      remainingMs: s.approval_deadline ? Math.max(0, s.approval_deadline - now) : null,
      deferralCount: s.deferral_count,
    })),
    holding: held.map((s) => ({ slotId: s.id, state: s.state })),
    vip: granted.some((g) => g.scope === 'vip:skip_queue'),
    grants: granted.map((g) => ({ id: g.id, scope: g.scope, expiresAt: g.expires_at })),
    // What this human still owes an answer to. The console reads this instead of
    // remembering an approval id across the OAuth redirect — which it cannot do,
    // and which used to leave the flow unfinishable in a browser.
    openApprovals: await openApprovalViews(continuityId),
    slots: slotSummary(eventId),
    recentTransitions: transitions,
  });
});
