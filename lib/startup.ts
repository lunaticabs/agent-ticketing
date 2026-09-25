/**
 * Startup banner.
 *
 * Two conditions are dangerous enough that they must be impossible to miss in
 * the terminal, because both of them would invalidate the demo if a judge
 * spotted them before we said them out loud:
 *
 *   * `ENABLE_DEV_ROUTES=1` — the impersonation bypass is live
 *   * local IdP fallback    — identity is simulated (the gate is still real)
 */
import { hasExplicitSigningKey, idpCredentials, idpMode, WORLDID_ISSUER, redirectUri } from '../worldid/config';
import { devRoutesEnabled } from './errors';

let printed = false;

export function printStartupBanner(): void {
  if (printed) return;
  printed = true;

  const mode = idpMode();
  const lines: string[] = [];
  lines.push('');
  lines.push('  ┌────────────────────────────────────────────────────────────────────┐');
  lines.push('  │  PRESENCE · agent queueing with fresh human authorization          │');
  lines.push('  └────────────────────────────────────────────────────────────────────┘');
  lines.push(`  World ID issuer : ${WORLDID_ISSUER}`);
  lines.push(`  IdP mode        : ${mode}${mode === 'local' ? '   ⚠️  LOCAL FALLBACK' : ''}`);
  lines.push(`  Redirect URI    : ${redirectUri()}`);
  lines.push(`  Dev routes      : ${devRoutesEnabled() ? 'ENABLED' : 'disabled'}`);
  lines.push('');

  if (mode === 'local') {
    lines.push('  ⚠️  LOCAL IDP FALLBACK IS ACTIVE');
    lines.push('      No portal-issued OIDC client credentials were found, so identity is');
    lines.push('      SIMULATED by worldid/local.ts. Every authorization check still runs:');
    lines.push('      binding, freshness, one-time consumption. But an assertion carries no');
    lines.push('      World ID proof of humanness, and the UI says so on every screen.');
    lines.push('      To use the real sandbox IdP, set WORLDID_CLIENT_ID and');
    lines.push('      WORLDID_CLIENT_SECRET in .env.local. See SPIKE_NOTES.md (S-2).');
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
