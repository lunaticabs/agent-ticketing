/**
 * Route-handler helpers and the two request-side guards.
 *
 * The guards exist because two of the ten red lines are about things a *client*
 * must not be able to say, and the cleanest place to refuse them is before any
 * business logic runs.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { PresenceError } from './errors';
import { resolveCaller } from './session';
import { applySandboxCookie, runInRequestContext } from './requestcontext';
import type { AgentScope } from './agenttoken';
import { WORLDID_ENVIRONMENT, WORLDID_ISSUER } from '../worldid/config';

export function json(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data as object, {
    ...init,
    headers: { 'cache-control': 'no-store', ...(init?.headers ?? {}) },
  });
}

/** Map anything thrown into the structured refusal shape the UI and models read. */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof PresenceError) {
    return json(err.toBody(), { status: err.httpStatus });
  }
  const message = err instanceof Error ? err.message : String(err);
  // Never leak a stack trace to a client; log it server-side instead.
  console.error('[presence] unhandled error:', err);
  return json(
    {
      ok: false,
      code: 'internal_error',
      message: 'internal error',
      details: { detail: message },
    },
    { status: 500 },
  );
}

export async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * ============================================================================
 *  RED LINE 4 — environment is pinned on the server; a client may not name one.
 * ============================================================================
 *
 * Official guidance:
 *
 *   "The approval is untrusted input: pin the environment so it can't select
 *    'staging' or 'sandbox', which accept test proofs."
 *
 * We do not merely ignore a client-supplied environment — we reject the request
 * and write it to the audit trail. Ignoring it quietly would let an attacker
 * probe for a bypass without ever showing up in the logs, and it would hide from
 * the judges that an attempt was made.
 */
export function guardClientSuppliedEnvironment(body: Record<string, unknown>): void {
  const hit = findKey(body, (k) => k.toLowerCase() === 'environment' || k.toLowerCase() === 'env');
  if (!hit) return;

  throw new PresenceError(
    'environment_pinned',
    'the environment is pinned by the server and cannot be supplied by a client',
    {
      httpStatus: 400,
      invariant: 'RED LINE 4 — a client that could choose the environment could choose one that accepts test proofs',
      details: { receivedAt: hit.path, received: String(hit.value), pinnedTo: WORLDID_ENVIRONMENT },
      hint: `This deployment only accepts proofs from ${WORLDID_ISSUER} (${WORLDID_ENVIRONMENT}).`,
    },
  );
}

/**
 * ============================================================================
 *  RED LINE 3 — a client may not hand the server a verdict.
 * ============================================================================
 *
 * The track's rule 4 in one sentence: "不把未校验的客户端响应当作授权".
 *
 * A client may report *what it did* ("I finished the flow") but never *what the
 * result was* ("verification passed"). So any body that carries a verification
 * verdict is refused outright, whether or not it also carries an approval. The
 * presence of a forged verdict is itself the signal worth recording.
 */
export function guardForgedClientResult(body: Record<string, unknown>): void {
  const verdictKeys = ['clientresult', 'client_result', 'verificationresult', 'verification_result',
    'verifiedbyclient', 'verified_by_client', 'proofresult', 'proof_result'];
  const booleanVerdictKeys = ['ok', 'verified', 'isverified', 'is_verified', 'verifiedhuman',
    'verified_human', 'success', 'passed', 'authorized'];

  let reason: string | null = null;

  for (const key of Object.keys(body)) {
    const lower = key.toLowerCase();
    if (verdictKeys.includes(lower)) {
      reason = `body carries a client-supplied verification result at "${key}"`;
      break;
    }
    if (booleanVerdictKeys.includes(lower) && typeof body[key] === 'boolean') {
      reason = `body asserts "${key}": ${String(body[key])} as if the client's word settled verification`;
      break;
    }
  }

  // A nested `proof` object from the client is equally meaningless: only the
  // server's own stored reference can be verified.
  if (!reason && body.proof && typeof body.proof === 'object' && !Array.isArray(body.proof)) {
    reason = 'body carries a client-supplied proof object';
  }

  if (!reason) return;

  throw new PresenceError('untrusted_client_result', reason, {
    httpStatus: 400,
    invariant: 'Track rule 4 / RED LINE 3 — the server verifies the proof itself and never trusts a client verdict',
    hint:
      'Send only an opaque approval reference. The server looks it up in its own state, re-checks ' +
      'the binding, re-checks freshness, and consumes the nullifier once.',
  });
}

interface KeyHit {
  path: string;
  value: unknown;
}

function findKey(
  node: unknown,
  predicate: (key: string) => boolean,
  path = '$',
  depth = 0,
): KeyHit | null {
  if (depth > 4 || node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const found = findKey(node[i], predicate, `${path}[${i}]`, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (predicate(key)) return { path: `${path}.${key}`, value };
    const found = findKey(value, predicate, `${path}.${key}`, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Gate for "who is calling". Accepts a browser session cookie or an agent bearer
 * token (T-5.2) and resolves both to a continuity id. An optional `scope`
 * narrows what an agent token may do; a human cookie always passes, because a
 * person sitting in front of the console is not acting through a delegated
 * credential.
 */
export interface Caller {
  continuityId: string;
  /** The human in a browser, or a program holding their delegated credential. */
  actor: 'human' | 'agent';
  scope: string[];
}

/**
 * Resolve the caller, keeping *how* they authenticated.
 *
 * `resolveCaller` has always computed this; the wrapper discarded it, which left
 * the system unable to answer the one question its pitch turns on — was this
 * action taken by the human or by their agent? The distinction is now carried
 * through to the audit trail.
 */
export function requireCaller(req: NextRequest, scope?: AgentScope): Caller {
  const caller = resolveCaller(req, scope);
  const continuityId = requireContinuity(req, scope);
  return { continuityId, actor: caller.via === 'agent-token' ? 'agent' : 'human', scope: caller.scope };
}

export function requireContinuity(req: NextRequest, scope?: AgentScope): string {
  const caller = resolveCaller(req, scope);
  if (!caller.continuityId) {
    if (caller.via === 'agent-token') {
      throw new PresenceError('grant_scope_insufficient', `this agent token lacks the ${scope} scope`, {
        httpStatus: 403,
        invariant: 'T-5.2 — an agent credential carries a scope and an expiry, not blanket authority',
        details: { held: caller.scope, required: scope },
      });
    }
    throw new PresenceError('not_authenticated', 'sign in with World ID before joining the queue', {
      httpStatus: 401,
      invariant: 'T-1.1 — only a verified human may enter the queue',
      hint: 'Start the sign-in flow at /api/auth/world/start, or enroll an agent at /api/agent/enroll.',
    });
  }
  return caller.continuityId;
}

/**
 * Wrap a handler so every thrown refusal becomes a structured JSON body — and so
 * the request's event is established before the handler runs.
 *
 * The second half is why this is the single entry point for the private-event
 * scheme (`lib/requestcontext.ts`). `primaryEvent()` answers "which event?" from
 * an `AsyncLocalStorage` store, and the store can only be filled by something
 * that wraps the handler. Doing it here means all 35 handlers are scoped
 * correctly and a new one is correct by default, rather than each author having
 * to remember. Two of them take a route context as a second argument, so the
 * arguments are forwarded generically.
 */
export function route<T extends unknown[]>(
  handler: (req: NextRequest, ...rest: T) => Promise<NextResponse> | NextResponse,
) {
  return async (req: NextRequest, ...rest: T): Promise<NextResponse> => {
    try {
      const { result, cookie } = await runInRequestContext(req, async () => handler(req, ...rest));
      return applySandboxCookie(result, cookie);
    } catch (err) {
      return toErrorResponse(err);
    }
  };
}
