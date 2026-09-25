#!/usr/bin/env tsx
/**
 * Which scheme should the dev server use?
 *
 * `scripts/dev.sh` asks this before starting Next, so the answer cannot be
 * wrong. It exists because "run dev:https, not dev" is exactly the kind of
 * instruction that gets forgotten under time pressure, and the failure is
 * confusing rather than obvious: the server comes up looking healthy and the
 * browser is later redirected to a scheme nothing is listening on.
 *
 * The rule:
 *
 *   registered for the real IdP  ->  https   (the portal refuses an http callback)
 *   local fallback only          ->  http    (no certificate warning, one less
 *                                             thing between you and the demo)
 *
 * Uses Next's own env loader, so `.env.local`, `.env.development.local` and the
 * real environment are read with exactly the same precedence the app will use.
 * A shell `grep` over `.env.local` would drift from that.
 *
 * Prints one line of JSON on stdout; anything explanatory goes to stderr.
 */
import nextEnv from '@next/env';

(nextEnv as { loadEnvConfig: (dir: string, dev: boolean) => unknown }).loadEnvConfig(process.cwd(), true);

interface Decision {
  scheme: 'http' | 'https';
  reason: string;
}

function decide(): Decision {
  const clientId = process.env.WORLDID_CLIENT_ID?.trim();
  const redirect = process.env.WORLDID_REDIRECT_URI?.trim();
  const base = process.env.PRESENCE_PUBLIC_URL?.trim();

  // An explicit https anywhere means the deployment has declared itself https.
  if (redirect?.startsWith('https://') || base?.startsWith('https://')) {
    return {
      scheme: 'https',
      reason: 'an https URL is already configured for this deployment',
    };
  }

  if (clientId) {
    return {
      scheme: 'https',
      reason:
        'WORLDID_CLIENT_ID is set, so this run talks to the real IdP — and the ' +
        'sandbox portal only accepts https callbacks',
    };
  }

  return {
    scheme: 'http',
    reason:
      'no OIDC client is registered, so identity is simulated locally and no ' +
      'callback is involved',
  };
}

const decision = decide();
process.stderr.write(`  ${decision.scheme.toUpperCase()} — ${decision.reason}\n`);
process.stdout.write(JSON.stringify(decision));
