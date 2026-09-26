/**
 * Startup banner.
 *
 * Three conditions are dangerous enough that they must be impossible to miss in
 * the terminal, because any of them would invalidate the demo if a judge spotted
 * it before we said it out loud:
 *
 *   * `ENABLE_DEV_ROUTES=1` — the impersonation bypass is live
 *   * local IdP fallback    — identity is simulated (the gate is still real)
 *   * `ENABLE_SANDBOX=1`    — visitors get private events, not one shared queue
 *
 * ── Why this module stays free of the database ─────────────────────────────
 *
 * `printStartupBanner` is called from `instrumentation.ts`, which Next compiles
 * for the Edge runtime as well as the Node one, and webpack traces dynamic
 * `import()`s into the Edge bundle regardless of any runtime guard around them.
 * A database import — static or dynamic — therefore fails the whole app with
 * `Module not found: Can't resolve 'fs'`, for every request rather than just the
 * banner. That happened twice while the public demo was being built. So the
 * flag is read straight from `process.env` here, and the one piece of startup
 * bookkeeping that does need the database (seeding, so a container on a fresh
 * volume comes up working) lives in `lib/sandbox.ts`, on the path that actually
 * needs the seeded event.
 */
import {
  baseUrlConsistency,
  hasExplicitSigningKey,
  idpCredentials,
  idpMode,
  publicBaseUrl,
  WORLDID_ISSUER,
  redirectUri,
} from '../worldid/config';
import { devRoutesEnabled } from './errors';

let printed = false;

/** `ENABLE_SANDBOX`, read inline — see the note above about the Edge bundle. */
function privateEventsOn(): boolean {
  return process.env.ENABLE_SANDBOX === '1';
}

/**
 * A one-line box whose width is computed from its contents.
 *
 * The previous version had the border characters and the trailing spaces typed
 * out by hand. That survived exactly until the product was renamed: the new title
 * is longer than the old one, so the right border drifted two columns past the
 * line above it. Counting spaces is not a thing to do twice.
 *
 * A title longer than the minimum simply makes a wider box.
 */
function boxed(text: string, minInner = 62): string[] {
  const inner = Math.max(minInner, text.length + 4);
  return [
    `  ┌${'─'.repeat(inner)}┐`,
    `  │  ${text.padEnd(inner - 2)}│`,
    `  └${'─'.repeat(inner)}┘`,
  ];
}

export function printStartupBanner(): void {
  if (printed) return;
  printed = true;

  const mode = idpMode();
  const lines: string[] = [];
  const title = 'Agent Ticketing Demo — agent queueing, fresh human authorization';
  lines.push('');
  lines.push(...boxed(title));
  const baseUrl = publicBaseUrl();
  const urls = baseUrlConsistency();

  lines.push(`  World ID issuer : ${WORLDID_ISSUER}`);
  lines.push(`  IdP mode        : ${mode}${mode === 'local' ? '   ⚠️  LOCAL FALLBACK' : ''}`);
  lines.push(`  Public base URL : ${baseUrl}`);
  lines.push(`  Redirect URI    : ${redirectUri()}`);
  lines.push(`  Dev routes      : ${devRoutesEnabled() ? 'ENABLED' : 'disabled'}`);
  lines.push(
    `  Private events  : ${
      privateEventsOn() ? 'ON — each visitor gets their own event' : 'off — one shared event'
    }`,
  );
  lines.push('');

  if (!urls.consistent) {
    lines.push('  ⚠️  URL MISMATCH — links the app renders will not open');
    lines.push(`      ${urls.detail}`);
    lines.push('      PRESENCE_PUBLIC_URL is what consent links are built');
    lines.push('      from; WORLDID_REDIRECT_URI is what the IdP sends the browser back');
    lines.push('      to. They must share an origin.');
    lines.push(`      Easiest fix: drop PRESENCE_PUBLIC_URL and let it derive from the`);
    lines.push('      redirect URI, or set it to that origin.');
    lines.push('');
  }

  if (mode !== 'local' && baseUrl.startsWith('http://')) {
    // A real IdP registration requires an https callback — the sandbox portal
    // rejects an http loopback URL outright. Serving http here means the
    // redirect will land on a scheme nothing is listening on.
    lines.push('  ⚠️  REAL IDP CREDENTIALS, BUT THE PUBLIC BASE URL IS http://');
    lines.push('      The sandbox portal only accepts https callbacks, so the browser');
    lines.push('      will be redirected to a scheme this server is not serving.');
    lines.push('      Run `npm run dev:https` instead. See docs/SPIKE_NOTES.md S-0.');
    lines.push('');
  }

  if (mode === 'local') {
    lines.push('  ⚠️  LOCAL IDP FALLBACK IS ACTIVE');
    lines.push('      No portal-issued OIDC client credentials were found, so identity is');
    lines.push('      SIMULATED by worldid/local.ts. Every authorization check still runs:');
    lines.push('      binding, freshness, one-time consumption. But an assertion carries no');
    lines.push('      World ID proof of humanness, and the UI says so on every screen.');
    lines.push('      To use the real sandbox IdP, set WORLDID_CLIENT_ID and');
    lines.push('      WORLDID_CLIENT_SECRET in .env.local. See docs/SPIKE_NOTES.md (S-2).');
    lines.push('');
  }

  if (devRoutesEnabled()) {
    lines.push('  ⚠️  ENABLE_DEV_ROUTES=1 — THE DEMO BYPASS IS LIVE');
    lines.push('      /api/dev/* can create simulated humans that bypass World ID entirely.');
    lines.push('      This is a disclosed demo prop for "40 accounts, 2 humans" (T-6.2).');
    lines.push('      It must never be enabled in a deployment that matters.');
    lines.push('');
  }

  if (!hasExplicitSigningKey()) {
    lines.push('  ⚠️  PRESENCE_SIGNING_KEY is unset; using a deterministic development key.');
    lines.push('      Sessions and local assertions are forgeable by anyone with the source.');
    lines.push('');
  }

  if (idpCredentials()) {
    lines.push('  ✔ Portal-issued client credentials detected. Using the real IdP.');
    lines.push('');
  }

  console.log(lines.join('\n'));
}
