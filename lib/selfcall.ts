/**
 * ============================================================================
 *  Calling this server from inside itself
 * ============================================================================
 *
 * Several demo props are driven by the server making HTTP requests back to its
 * own routes: the bot army impersonates twenty-four accounts and joins them, the
 * MCP agent asks for an authorization and waits on its decision. Those are real
 * requests on purpose — they exercise the same validation a browser would — but
 * they need two things the rest of the code does not.
 *
 * ── 1. The right origin ────────────────────────────────────────────────────
 *
 * `publicBaseUrl()` answers "what URL goes in a link a human will open". It is
 * derived from the registered `redirect_uri`, which is correct for a consent link
 * and wrong for reaching yourself: with a portal-registered HTTPS redirect and a
 * server started over plain HTTP it names an origin nothing is listening on. The
 * origin a request arrived on is the only one guaranteed to work.
 *
 * ── 2. Trusting our own certificate ────────────────────────────────────────
 *
 * The sandbox portal refuses an `http://` callback, so `npm run dev` serves TLS
 * with a certificate this project generates. Node does not trust it, so a
 * self-call over `https://localhost:3000` fails with `fetch failed` — a message
 * that names neither TLS nor the certificate.
 *
 * Two narrower-looking fixes were tried first and both failed, which is worth
 * recording so nobody tries them a third time:
 *
 *   · `NODE_TLS_REJECT_UNAUTHORIZED=0` — works, but disables verification for
 *     every outbound connection, the real IdP included, so a genuine certificate
 *     problem there would be silenced too. The security self-check forbids
 *     naming the IdP host outside `worldid/`, and it is right to: this file has
 *     no business knowing it.
 *
 *   · `NODE_EXTRA_CA_CERTS=<our cert>` — the correct narrow answer in principle,
 *     and it works for a plain Node process. It does NOT work here: `next dev`
 *     does not pass it through to the server process. Verified by reading
 *     `process.env.NODE_EXTRA_CA_CERTS` from inside a route, where it is
 *     `undefined` even when exported by the shell that started Next.
 *
 * So the trust is attached to the request instead of to the process: an undici
 * `Agent` carrying our certificate, passed as `dispatcher` on self-calls only.
 * Verification stays ON everywhere, only our own certificate is trusted, and the
 * scope is exactly the requests this module makes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from 'undici';
import type { NextRequest } from 'next/server';
import { publicBaseUrl } from '../worldid/config';

/** Where `scripts/dev.sh` writes the certificate it generates. */
const LOCAL_CERT = path.join(process.cwd(), 'certificates', 'localhost.pem');

let dispatcher: Agent | null | undefined;

/**
 * A dispatcher that trusts our own certificate, or null when there is none.
 *
 * Built once and cached. Returns null for a non-loopback origin, which is every
 * real deployment, so nothing changes there.
 */
function localDispatcher(origin: string): Agent | null {
  if (!origin.startsWith('https://') || !isLoopback(origin)) return null;
  if (dispatcher !== undefined) return dispatcher;

  try {
    dispatcher = new Agent({
      connect: { ca: fs.readFileSync(LOCAL_CERT, 'utf8') },
    });
  } catch {
    // No certificate on disk: a deployment using a real one. Nothing to add.
    dispatcher = null;
  }
  return dispatcher;
}

/**
 * The origin to dial when calling *this* server.
 *
 * ── Why "the origin the request arrived on" is not enough ──────────────────
 *
 * That was the original rule, and it is right on a laptop and wrong behind a
 * proxy. A container binds `0.0.0.0:3000`, so the server's idea of its own
 * address is the *wildcard* — `https://0.0.0.0:3000` — which is not a place
 * anything can connect to. The MCP agent and the bot army both learned this the
 * hard way on the public deployment: the agent's child process was handed that
 * address and every tool call came back `transport_error — fetch failed`, which
 * names neither the address nor the reason.
 *
 * The rules, in order, and why each one is safe:
 *
 *   1. **A loopback origin is kept**, but normalised to `localhost`. That keeps
 *      the self-signed-certificate path working (`NODE_EXTRA_CA_CERTS` is set
 *      for loopback hosts only) while still dodging a literal `0.0.0.0`.
 *   2. **A host the caller supplied is used when it is a real one.** Fly sets
 *      `x-forwarded-host` to the hostname the visitor asked for, and a forged
 *      value here is harmless: the worst it can do is make this server send a
 *      request to a hostname the attacker already controls. It is never used to
 *      decide a *credential* — the OIDC `redirect_uri` comes from configuration
 *      precisely so that a forged Host cannot be signed into a token exchange
 *      (`lib/callback.ts`).
 *   3. **Otherwise, the configured public URL.** This is the case that matters
 *      in production: `0.0.0.0`, or a bare Host the proxy did not rewrite.
 *
 * `HUMANGATE_PUBLIC_URL` is not imported for this: `publicBaseUrl()` already
 * derives the origin from `WORLDID_REDIRECT_URI`, the one value that cannot be
 * approximated.
 */
export function selfOrigin(req: NextRequest): string {
  const arrivals = new URL(req.url);
  const arrived = arrivals.origin;

  // 1. Loopback: the local dev server, including its self-signed certificate.
  if (isLoopback(arrived)) {
    return `${arrivals.protocol}//localhost${arrivals.port ? `:${arrivals.port}` : ''}`;
  }

  // 2. A real host from the proxy, or the one that came with the request.
  //
  // The scheme is the request's own, not a hardcoded `https`: in production the
  // app is served over TLS either way, and locally `npm run dev:http` serves
  // plain HTTP on a non-loopback address (a phone on the same wifi). Guessing
  // `https` there would break the one flow this function exists to fix.
  const header = (name: string): string | null => req.headers?.get(name) ?? null;
  const scheme = firstHeaderValue(header('x-forwarded-proto')) ?? arrivals.protocol.replace(':', '');
  const host = firstHeaderValue(header('x-forwarded-host')) ?? arrivals.host;
  const resolved = originFromHost(host, scheme);
  if (resolved) return resolved;

  // 3. A wildcard, a header made of punctuation, or nothing usable: ask the
  //    configuration. `localhost` on our own port is the last resort, for the
  //    local case where no public URL is configured at all.
  const configured = publicBaseUrl();
  if (configured) return configured;
  return `http://localhost${arrivals.port ? `:${arrivals.port}` : ''}`;
}

function firstHeaderValue(value: string | null): string | null {
  const first = value?.split(',')[0]?.trim();
  return first ? first : null;
}

/**
 * An origin for `host`, or null when it is not an address worth dialling.
 *
 * `null` for the wildcard is deliberate rather than "map it to localhost here":
 * a `Host: 0.0.0.0` header means the proxy did not rewrite the host, and the
 * right answer to that is the deployment's configured public URL — not a guess
 * that this must be a local bind. Test S-5 pins that distinction, and it was a
 * real bug in the first version of this function.
 */
function originFromHost(host: string, scheme: string): string | null {
  if (!host) return null;
  const [hostname] = host.split(':');
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (bare === '0.0.0.0' || bare === '::' || bare === '') return null;
  if (bare !== 'localhost' && !/^[a-z0-9.-]+$/i.test(bare)) return null;

  try {
    return new URL(`${scheme}://${host}`).origin;
  } catch {
    return null;
  }
}

/** Loopback, i.e. an address whose certificate we might have generated ourselves. */
function isLoopback(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

export class SelfCallError extends Error {
  constructor(
    message: string,
    readonly origin: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SelfCallError';
  }
}

function explain(origin: string, cause: unknown): SelfCallError {
  const code = (cause as { cause?: { code?: string } })?.cause?.code;
  const isTls = origin.startsWith('https://') && isLoopback(origin);

  if (isTls && (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN')) {
    return new SelfCallError(
      `the server could not reach itself at ${origin}: the certificate is self-signed and ` +
        `nothing at ${LOCAL_CERT} was trusted for it.\n` +
        `Start the server with scripts/dev.sh (npm run dev) so the certificate exists, or ` +
        `point HUMANGATE_PUBLIC_URL at an origin with a real certificate.\n` +
        `Underlying error: ${code}`,
      origin,
      cause,
    );
  }

  return new SelfCallError(
    `the server could not reach itself at ${origin}: ` +
      `${cause instanceof Error ? cause.message : String(cause)}`,
    origin,
    cause,
  );
}

/**
 * `fetch`, but aimed at this server, with a failure that explains itself.
 *
 * Every self-call site should use this rather than a bare `fetch`. The two bugs
 * above both surfaced as `fetch failed`, and neither was diagnosable from the
 * message.
 */
export async function fetchSelf(
  req: NextRequest,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const origin = selfOrigin(req);
  return fetchOrigin(origin, path, init);
}

/** Same, for callers that already know the origin (a detached run, a helper). */
export async function fetchOrigin(
  origin: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const agent = localDispatcher(origin);
  try {
    return await fetch(`${origin}${path}`, {
      ...init,
      // `dispatcher` is undici's, which is what Node's fetch runs on. Typed as a
      // plain RequestInit so callers do not have to know that.
      ...(agent ? ({ dispatcher: agent } as Record<string, unknown>) : {}),
    });
  } catch (err) {
    throw explain(origin, err);
  }
}

/**
 * Environment for a child process that will call this server back.
 *
 * The MCP server is its own Node process, so it cannot use the in-process
 * dispatcher above and needs the certificate on disk instead. Unlike `next dev`,
 * a child we spawn ourselves gets exactly the environment we hand it.
 */
export function selfCallEnv(origin: string): Record<string, string> {
  const env: Record<string, string> = { HUMANGATE_BASE_URL: origin };
  if (origin.startsWith('https://') && isLoopback(origin) && fs.existsSync(LOCAL_CERT)) {
    if (!process.env.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = LOCAL_CERT;
  }
  return env;
}
