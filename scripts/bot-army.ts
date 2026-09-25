#!/usr/bin/env tsx
/**
 * Bot army (T-6.3) — the standalone CLI.
 *
 *   npm run bots
 *   npm run bots -- --accounts 24 --humans 24
 *   npm run bots -- --compare            # FCFS and the draw, side by side
 *
 * ── Why this is a thin HTTP client and not a library call ──────────────────
 *
 * An earlier version imported `runBotArmy` directly. That was wrong twice over:
 *
 *   1. It tripped the `ENABLE_DEV_ROUTES` guard in the *script's* process rather
 *      than the server's, so the command failed with `dev_routes_disabled` even
 *      though the server had the flag on.
 *   2. It wrote the simulated identities straight into SQLite from a second
 *      process, bypassing the one route that is supposed to gate them.
 *
 * So the work happens where the guard lives, over HTTP, and this file only
 * renders the answer. That also means it keeps working if the database ever
 * stops being a local file.
 */
import { describeTarget, reportPreflight, PreflightError, requireDevRoutes, resolveTarget } from './preflight';

interface Shares {
  botEntrants: number;
  botEntrantShare: number;
  botSlotShare: number;
  speedAdvantage: number;
}

interface ArmyResult {
  mode: 'lottery' | 'fcfs';
  accounts: number;
  humans: number;
  joined: number;
  failed: number;
  elapsedMs: number;
  slots: number;
  allocated: { bots: number; humans: number; empty: number };
  shares: Shares;
}

interface Statistics {
  slotCount: number;
  entrantCount: number;
  botEntrantShare: number;
  fairShareSd: number;
  fcfsZ: number;
  lotteryZ: number;
  conclusion: string;
}

function render(result: ArmyResult): string {
  const pct = result.slots ? Math.round((result.allocated.bots / result.slots) * 100) : 0;
  return [
    `  mode            ${result.mode}`,
    `  bot accounts    ${result.accounts} (joined ${result.joined}, failed ${result.failed})`,
    `  humans          ${result.humans}`,
    `  elapsed         ${result.elapsedMs}ms`,
    `  slots           ${result.slots}`,
    `  bots took       ${result.allocated.bots} (${pct}%)`,
    `  humans took     ${result.allocated.humans}`,
    `  share check     bots are ${Math.round(result.shares.botEntrantShare * 100)}% of entrants ` +
      `and took ${Math.round(result.shares.botSlotShare * 100)}% of slots ` +
      `→ speed advantage ${(result.shares.speedAdvantage * 100).toFixed(0)} points`,
  ].join('\n');
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };

  const accounts = Number(get('--accounts', '24'));
  const humans = Number(get('--humans', '24'));
  const slots = Number(get('--slots', '24'));
  const compare = argv.includes('--compare');

  // Fail early and legibly if the server is not usable.
  let BASE: string;
  try {
    const target = await resolveTarget();
    BASE = target.base;
    requireDevRoutes(target);
    console.log(describeTarget(target, 'bot army'));
  } catch (err) {
    if (err instanceof PreflightError) return reportPreflight(err);
    throw err;
  }

  const res = await fetch(`${BASE}/api/dev/bots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(compare ? { mode: 'compare', accounts, humans, slots } : { accounts, humans }),
  });

  const payload = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    console.error(`\n  ${res.status}: ${JSON.stringify(payload).slice(0, 400)}\n`);
    return 1;
  }

  if (compare) {
    const result = payload as unknown as {
      fcfs: ArmyResult;
      lottery: ArmyResult;
      verdict: string;
      statistics: Statistics;
    };
    console.log('\n  running the same script under both modes…\n');
    console.log('  ── FCFS (control) ──');
    console.log(render(result.fcfs));
    console.log('\n  ── DRAW (the real thing) ──');
    console.log(render(result.lottery));
    console.log(`\n  ${result.verdict}`);
    console.log(
      `  (fair-draw sd ${(result.statistics.fairShareSd * 100).toFixed(1)} points over ` +
        `${result.statistics.slotCount} slots / ${result.statistics.entrantCount} entrants)\n`,
    );
    return 0;
  }

  console.log(`\n${render(payload.result as unknown as ArmyResult)}\n`);
  console.log(`  ${String(payload.verdict)}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

// Mark this file as a module: without a top-level import or export its
// declarations would be global, and `main` would collide with every other script.
export {};
