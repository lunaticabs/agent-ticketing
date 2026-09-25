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

/** The origin this request arrived on. */
export function selfOrigin(req: NextRequest): string {
  return new URL(req.url).origin;
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
        `point PRESENCE_PUBLIC_URL at an origin with a real certificate.\n` +
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
  const env: Record<string, string> = { PRESENCE_BASE_URL: origin };
  if (origin.startsWith('https://') && isLoopback(origin) && fs.existsSync(LOCAL_CERT)) {
    if (!process.env.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = LOCAL_CERT;
  }
  return env;
}
