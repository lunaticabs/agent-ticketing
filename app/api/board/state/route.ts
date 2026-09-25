import { json, route } from '@/lib/api';
import { boardState } from '@/lib/board';
import { printStartupBanner } from '@/lib/startup';

/**
 * T-6.1 — the board snapshot. One flat JSON object, polled once per second.
 *
 * Deliberately not SSE or WebSocket: conference wifi drops long-lived
 * connections and a poll fails soft. `sweep()` runs inside `boardState`, so the
 * countdown a judge is watching is computed against the same clock the state
 * machine uses.
 *
 * `serverNow` comes along so the client renders a countdown from the server's
 * clock rather than the laptop's.
 */
export const GET = route(async (req) => {
  printStartupBanner();
  const url = new URL(req.url);
  const eventId = url.searchParams.get('eventId') ?? undefined;
  return json(boardState(eventId));
});

export const dynamic = 'force-dynamic';
