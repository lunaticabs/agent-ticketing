/**
 * Shared preflight for the live verification scripts.
 *
 * ============================================================================
 *  Why this exists
 * ============================================================================
 *
 * `e2e`, `mcp-check` and `bot-army` all talk to a running server, and each one
 * used to assume three things silently:
 *
 *   1. the server is on `http://localhost:3000`
 *   2. dev routes are enabled
 *   3. the server runs the LOCAL FALLBACK idp, so consent can be completed
 *      programmatically
 *
 * All three were true until an OIDC client got registered. Then `npm run dev`
 * started choosing https on its own, the server switched to `oidc` mode, and the
 * suite failed with things like "this request is not a local attempt" — accurate
 * but not obviously about configuration.
 *
 * So the assumptions are now checked and reported. A verification harness that
 * fails with a clear reason is worth a great deal more than one that fails with
 * a true-but-unhelpful message.
 */
import nextEnv from '@next/env';

(nextEnv as { loadEnvConfig: (dir: string, dev: boolean) => unknown }).loadEnvConfig(process.cwd(), true);

export interface Health {
  ok: boolean;
  devRoutes: boolean;
  idp: { mode: 'oidc' | 'device' | 'local'; degraded: boolean; issuer: string; hasCredentials: boolean };
  urls?: { publicBaseUrl: string; redirectUri: string; consistent: boolean; problem: string | null };
  event: { id: string } | null;
}

export interface Target {
  base: string;
  health: Health;
}

export class PreflightError extends Error {
  constructor(
    message: string,
    readonly remedy: string[],
  ) {
    super(message);
  }
}

const CANDIDATES = ['http://localhost:3000', 'https://localhost:3000'];

/**
 * Find the running server and report what it is.
 *
 * Tries http before https because a server started without TLS is the common
 * case, and a failed HTTPS handshake against a plain HTTP port is slow to time
 * out. `PRESENCE_BASE_URL` short-circuits the probing.
 */
export async function resolveTarget(): Promise<Target> {
  const explicit = process.env.PRESENCE_BASE_URL?.trim().replace(/\/+$/, '');
  const candidates = explicit ? [explicit] : CANDIDATES;

  const failures: string[] = [];

  for (const base of candidates) {
    // A self-signed certificate is expected on the https path and is not worth
    // failing over: this is a loopback check against a dev server.
    if (base.startsWith('https://') && /localhost|127\.0\.0\.1/.test(base)) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) {
        failures.push(`${base} → HTTP ${res.status}`);
        continue;
      }
      const health = (await res.json()) as Health;
      return { base, health };
    } catch (err) {
      failures.push(`${base} → ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new PreflightError('no running server found', [
    `tried: ${failures.join('; ')}`,
    'start one with:  ENABLE_DEV_ROUTES=1 npm run dev',
  ]);
}

/** Assert the server can actually be verified against. */
export function requireDevRoutes(target: Target): void {
  if (!target.health.devRoutes) {
    throw new PreflightError(`dev routes are disabled on ${target.base}`, [
      'The demo props (simulated identities, fast-forward, attacks) live behind this flag.',
      'restart the server with:  ENABLE_DEV_ROUTES=1 npm run dev',
    ]);
  }
}

/**
 * Assert the server is on the local fallback, which is what lets a script
 * complete the consent screen on a human's behalf.
 *
 * With real credentials configured, `idpMode()` returns `oidc` and the consent
 * step genuinely requires a person with a device. That is correct behaviour, and
 * it is why this is a configuration error rather than something to work around:
 * set `PRESENCE_IDP_MODE=local` to verify against the fallback without
 * unregistering anything.
 */
export function requireLocalIdp(target: Target, what: string): void {
  if (target.health.idp.mode === 'local') return;

  throw new PreflightError(
    `${what} needs the local fallback idp, but ${target.base} is running in "${target.health.idp.mode}" mode`,
    [
      'These checks complete the consent screen programmatically, which is only',
      'possible when the identity provider is simulated. With a real client',
      'registered, consent requires a person with a device — by design.',
      '',
      'restart the server with:  PRESENCE_IDP_MODE=local ENABLE_DEV_ROUTES=1 npm run dev',
      '',
      '(PRESENCE_IDP_MODE=local forces the fallback even with credentials set, so',
      ' nothing has to be unregistered.)',
    ],
  );
}

/** Print the standard failure block and return the exit code to use. */
export function reportPreflight(err: PreflightError): number {
  console.error('');
  console.error(`  ✖ ${err.message}`);
  console.error('');
  for (const line of err.remedy) console.error(`    ${line}`);
  console.error('');
  return 2;
}

/**
 * A summary of what we are about to verify against, including the one mismatch
 * that is easy to miss: the server being reachable on a different origin from
 * the one the configuration declares.
 *
 * That is not hypothetical. With `WORLDID_REDIRECT_URI=https://localhost:3000/...`
 * set and the server started on plain http, everything is self-consistent on
 * paper — both config values agree — while the browser is sent to a scheme
 * nothing is listening on. The two checks below (`urls.consistent` and this one)
 * cover the two different ways for that to go wrong.
 */
export function describeTarget(target: Target, what: string): string {
  const urls = target.health.urls;
  const lines = [
    `  PRESENCE · ${what}`,
    `  target: ${target.base}`,
    `  idp:    ${target.health.idp.mode}${target.health.idp.degraded ? ' (degraded — identity simulated)' : ''}`,
  ];

  if (urls) {
    lines.push(`  origin: publicBaseUrl=${urls.publicBaseUrl} redirectUri=${urls.redirectUri}`);
    lines.push(`  config: ${urls.consistent ? 'internally consistent' : `MISMATCH — ${urls.problem}`}`);

    const reachable = new URL(target.base).origin;
    if (new URL(urls.publicBaseUrl).origin !== reachable) {
      lines.push(
        `  ⚠ the server is reachable at ${reachable}, but the config declares ` +
          `${urls.publicBaseUrl}.`,
      );
      lines.push(
        '    Anything that must survive a browser round trip — the OIDC redirect in ' +
          'particular —',
      );
      lines.push(
        `    goes to ${urls.publicBaseUrl}. Start the server on that scheme ` +
          '(`npm run dev` picks it) or change the config.',
      );
    }
  }

  return lines.join('\n');
}
