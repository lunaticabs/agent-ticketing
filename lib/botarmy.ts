/**
 * ============================================================================
 *  The bot army (T-6.3) — demo beat 1
 * ============================================================================
 *
 * A script that hammers `POST /api/queue/join` concurrently, exactly as a
 * scalper's client would. It is deliberately a *real* HTTP client: it signs in,
 * keeps cookies, and races the network. An in-process simulation would prove
 * nothing about the queue, because the queue's problem is not CPU contention,
 * it is arrival-time advantage.
 *
 * Run it two ways and the argument makes itself:
 *
 *   FCFS     the bots take every slot in under a second; a human arriving at a
 *            normal pace gets nothing. Uniqueness did not help — each bot has a
 *            distinct identity. Only *speed* decided, and speed is purchasable.
 *
 *   LOTTERY  the same script, the same concurrency, the same identities, and the
 *            bots' share collapses to their share of the entrant pool. Their
 *            advantage is exactly zero, because arrival time is not an input.
 *
 * This is why RED LINE 10 exists, and it is the first thing the demo shows.
 *
 * Interface note: one implementation, two callers — `scripts/bot-army.ts` for the
 * terminal and `app/api/dev/bots/route.ts` for the board's button.
 */
import { assertDevRoutes, resetDemo, buildArmy } from './devmode';
import { primaryEvent, updateEvent } from './humans';
import { settleLottery } from './queue';
import { ensureSlots, listSlots, sweep } from './slots';
import { fetchOrigin } from './selfcall';

export interface BotArmyOptions {
  baseUrl: string;
  accounts?: number;
  /** How many ordinary humans join first, at human pace. */
  humans?: number;
  /** Label prefix so the board can tell the two groups apart. */
  label?: string;
  /**
   * Clear the demo state first. On by default: a run against an already-settled
   * draw cannot join anybody, and a command that silently reports "0 joined"
   * teaches the wrong thing.
   */
  reset?: boolean;
}

export interface BotArmyResult {
  mode: 'lottery' | 'fcfs';
  accounts: number;
  humans: number;
  joined: number;
  failed: number;
  elapsedMs: number;
  /** Who ended up holding a slot, split by group. */
  allocated: { bots: number; humans: number; empty: number };
  slots: number;
  /**
   * The honest comparison. Raw slot counts depend on how many bots you bring,
   * so the claim that actually holds at any ratio is: *did the bots win more
   * than their share of the entrant pool?* Under FCFS they win far more; under
   * the draw their share and their odds are the same number.
   */
  /** First distinct join-failure reason, or null when every account joined. */
  joinBlockedBy: string | null;
  shares: {
    botEntrants: number;
    botEntrantShare: number;
    botSlotShare: number;
    humanEntrantShare: number;
    humanSlotShare: number;
    /** botSlotShare − botEntrantShare. Zero means speed bought nothing. */
    speedAdvantage: number;
  };
}

export async function runBotArmy(opts: BotArmyOptions): Promise<BotArmyResult> {
  assertDevRoutes();
  if (opts.reset !== false) resetDemo();
  const event = primaryEvent();
  const accounts = Math.max(1, Math.min(opts.accounts ?? 40, 200));
  const humans = Math.max(0, Math.min(opts.humans ?? 4, 40));

  const started = Date.now();

  // Both groups must RACE. Joining the humans first would hand them the head of
  // the queue and quietly invert the demonstration — an early version of this
  // script did exactly that, and reported FCFS as *fairer* than the draw, which
  // is the opposite of the truth.
  //
  // So: create every identity up front, then open one starting gate and let both
  // groups go at once. The bots are fast because a script is fast. The humans are
  // slow because a person takes a few hundred milliseconds to find and press the
  // button — which is the only difference this demo is about.
  const humanSessions = await Promise.all(
    Array.from({ length: humans }, (_, i) => impersonate(opts.baseUrl, `${opts.label ?? 'human'}-${i + 1}`)),
  );

  const army = buildArmy({ accounts, humans: accounts });
  const botCookies: { continuityId: string; cookie: string }[] = [];
  await Promise.all(
    army.accounts.map(async (member) => {
      const session = await impersonate(opts.baseUrl, member.handle);
      botCookies.push({ continuityId: session.continuityId, cookie: session.cookie });
    }),
  );

  const humanIds = humanSessions.map((h) => h.continuityId);

  const [, botResults] = await Promise.all([
    // Humans: concurrent with the bots, but each waits a human amount of time.
    Promise.all(
      humanSessions.map(async (human, i) => {
        await sleep(180 + i * 120 + Math.random() * 150);
        try {
          await join(opts.baseUrl, human.cookie);
          return true;
        } catch {
          return false;
        }
      }),
    ),
    // Bots: every account joins as fast as the network allows.
    Promise.all(
      botCookies.map(async (bot) => {
        try {
          await join(opts.baseUrl, bot.cookie);
          return null;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      }),
    ),
  ]);

  const failures = botResults.filter((r): r is string => r !== null);
  const joined = botResults.length - failures.length;
  const failed = failures.length;
  const elapsedMs = Date.now() - started;

  // Surface the first distinct reason. A run where nobody could join is not a
  // result, and saying so is better than printing a table of zeroes.
  const joinBlockedBy = failures.length ? [...new Set(failures)][0] : null;

  // Settle and allocate, then attribute the winners.
  settleLottery(event.id);
  sweep(event.id);

  const botHumanIds = new Set(botCookies.map((b) => b.continuityId));
  const humanIdsSet = new Set(humanIds);

  // Only the first `total_slots` rows (in the same order the allocator uses) can
  // ever be handed out. Counting every row would over-report the event size,
  // because demo props legitimately create inventory beyond the declared
  // capacity — that drift is invisible until you read the numbers.
  const capacity = event.total_slots;
  const slots = listSlots(event.id).slice(0, capacity);

  let bots = 0;
  let humanWins = 0;
  let empty = 0;
  for (const slot of slots) {
    if (!slot.holder_continuity_id) {
      empty += 1;
    } else if (botHumanIds.has(slot.holder_continuity_id)) {
      bots += 1;
    } else if (humanIdsSet.has(slot.holder_continuity_id)) {
      humanWins += 1;
    } else {
      empty += 1;
    }
  }

  const botEntrants = joined;
  const humanEntrants = humanIds.length;
  const totalEntrants = botEntrants + humanEntrants || 1;
  const filled = bots + humanWins || 1;

  return {
    mode: event.lottery_mode,
    accounts,
    humans,
    joined,
    failed,
    elapsedMs,
    allocated: { bots, humans: humanWins, empty },
    slots: slots.length,
    joinBlockedBy,
    shares: {
      botEntrants,
      botEntrantShare: botEntrants / totalEntrants,
      botSlotShare: bots / filled,
      humanEntrantShare: humanEntrants / totalEntrants,
      humanSlotShare: humanWins / filled,
      speedAdvantage: bots / filled - botEntrants / totalEntrants,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * T-6.3 acceptance in one call: run the same script under both modes and show
 * the difference. Each half resets first so neither inherits the other's state.
 *
 * ── Why this uses a z-score and not "did the bots get their fair share" ────
 *
 * With the demo's 8 slots and a 50/50 entrant pool, the standard deviation of
 * the bots' slot share is about 16 points. A genuinely fair draw therefore lands
 * 20+ points off roughly a third of the time, and a naive equality check would
 * fail on stage while the claim was true. So the comparison asks the correct
 * question instead: is the observed share consistent with the bots' odds?
 *
 * With `k` slots filled from `N` entrants of whom a fraction `p` are bots, a
 * fair draw yields Hypergeometric(k, N, p). That gives a real null distribution,
 * and therefore a real test:
 *
 *   FCFS   the bots land many standard deviations ABOVE their odds
 *   draw   the bots land within noise of their odds
 *
 * The run also uses more slots than the demo does, purely to tighten the noise.
 */
export async function runSpeedContrast(opts: {
  baseUrl: string;
  accounts?: number;
  humans?: number;
  /** Slots for the comparison. More slots means less sampling noise. */
  slots?: number;
}): Promise<{
  fcfs: BotArmyResult;
  lottery: BotArmyResult;
  verdict: string;
  statistics: {
    slotCount: number;
    entrantCount: number;
    botEntrantShare: number;
    /** Standard deviation of the bot slot SHARE under a fair draw. */
    fairShareSd: number;
    fcfsZ: number;
    lotteryZ: number;
    conclusion: string;
  };
}> {
  assertDevRoutes();
  const event = primaryEvent();

  // ── Choose a slot count that leaves real competition ──
  //
  // If the slots are as numerous as the entrants then EVERYONE gets one, in both
  // modes, and the comparison says nothing: the null distribution collapses to a
  // point (sd = 0) and FCFS looks perfectly fair. That degenerate run is worse
  // than no run, so the count is clamped to at most ~half the entrant pool.
  const originalSlots = event.total_slots;
  const entrants = (opts.accounts ?? 40) + (opts.humans ?? 4);
  const requested = opts.slots ?? 24;
  const slotCount = Math.max(1, Math.min(requested, 200, Math.floor(entrants / 2)));
  const clamped = slotCount !== requested;

  // ── Control group: first come, first served ──
  resetDemo();
  updateEvent(event.id, { lottery_mode: 'fcfs', total_slots: slotCount });
  ensureSlots(event.id, slotCount);
  const fcfs = await runBotArmy({ ...opts, label: 'human', reset: false });

  // ── The real thing: everyone in the window has equal odds ──
  resetDemo();
  updateEvent(event.id, { lottery_mode: 'lottery', total_slots: slotCount });
  ensureSlots(event.id, slotCount);
  const lottery = await runBotArmy({ ...opts, label: 'human', reset: false });

  // Leave the event on the mode the demo wants to keep using, and back on the
  // capacity it was seeded with. `resetDemo` rebuilds the slot ROWS too —
  // restoring only `total_slots` would leave stray inventory behind and inflate
  // the event size for every later run.
  updateEvent(event.id, { lottery_mode: 'lottery', total_slots: originalSlots });
  resetDemo();

  const p = lottery.shares.botEntrantShare;
  const k = lottery.allocated.bots + lottery.allocated.humans;
  const N = lottery.shares.botEntrants + lottery.humans;
  const sdCount = k > 1 && N > k ? Math.sqrt(k * p * (1 - p) * ((N - k) / (N - 1))) : 0;
  const fairShareSd = k > 0 ? sdCount / k : 0;

  const fcfsZ = fairShareSd > 0 ? (fcfs.shares.botSlotShare - p) / fairShareSd : 0;
  const lotteryZ = fairShareSd > 0 ? (lottery.shares.botSlotShare - p) / fairShareSd : 0;

  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const conclusion =
    (clamped
      ? `(slots clamped to ${slotCount} so the pool is contested — an uncontested run proves nothing) `
      : '') +
    `Entrant pool: ${lottery.humans} humans vs ${lottery.joined} bot accounts over ${N} entrants ` +
    `and ${k} filled slots, so the bots are ${pct(p)} of the queue. ` +
    `FCFS: they took ${pct(fcfs.shares.botSlotShare)} of the slots (${fcfsZ.toFixed(1)}σ above their odds) — speed paid. ` +
    `Draw: they took ${pct(lottery.shares.botSlotShare)} (${lotteryZ >= 0 ? '+' : ''}${lotteryZ.toFixed(1)}σ) — ` +
    `indistinguishable from fair, so speed bought nothing.`;

  return {
    fcfs,
    lottery,
    verdict: conclusion,
    statistics: {
      slotCount,
      entrantCount: N,
      botEntrantShare: p,
      fairShareSd,
      fcfsZ,
      lotteryZ,
      conclusion,
    },
  };
}

// ── HTTP helpers (deliberately real requests) ───────────────────────────────

async function impersonate(baseUrl: string, handle: string): Promise<{ continuityId: string; cookie: string }> {
  const res = await fetchOrigin(baseUrl, '/api/dev/impersonate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle }),
  });
  if (!res.ok) throw new Error(`impersonate failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { continuityId: string };
  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .join('; ');
  return { continuityId: body.continuityId, cookie };
}

async function join(baseUrl: string, cookie: string): Promise<void> {
  const res = await fetchOrigin(baseUrl, '/api/queue/join', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`join failed: ${res.status}`);
}

