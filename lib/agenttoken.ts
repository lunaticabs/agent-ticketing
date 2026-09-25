/**
 * ============================================================================
 *  Agent credentials (T-5.2)
 * ============================================================================
 *
 * The sandbox `oidc` guide describes the intended shape for a headless agent:
 *
 *   "A CLI, device, or headless agent with a confidential backend → OAuth device
 *    authorization grant → An ID token after fresh World proof and explicit
 *    approval; **your backend issues the agent's credential**."
 *
 * That last clause is the important one. The IdP's token is an *OIDC response
 * artifact* and is explicitly not valid for our API — so the relying party has
 * to mint its own credential, bound to the continuity id it just resolved and
 * scoped to what the agent may do.
 *
 * So: an HMAC-signed, scoped, expiring bearer token. Same key as sessions, same
 * red line — it never leaves the server.
 *
 * Two properties worth noting:
 *
 *   * It is scoped. `agent:queue` may join and poll; `agent:claim` may present an
 *     approval. Neither scope lets the holder *create* an approval, because
 *     creating one is what a human does.
 *   * It carries a continuity id, not an approval. A token says *who the agent
 *     acts for*; it never says *what is authorized*. That is always re-checked
 *     at the gate, per action, from server state.
 */
import crypto from 'node:crypto';
import { serverSigningKey } from '../worldid/config';

export type AgentScope = 'agent:queue' | 'agent:claim';

export interface AgentTokenPayload {
  cid: string;
  scope: AgentScope[];
  iat: number;
  exp: number;
  kid: string;
  label?: string;
}

const DEFAULT_TTL_SEC = 60 * 60 * 4;

function sign(body: string): string {
  return crypto.createHmac('sha256', serverSigningKey()).update(body).digest('base64url');
}

export function issueAgentToken(input: {
  continuityId: string;
  scope?: AgentScope[];
  ttlSec?: number;
  label?: string;
}): { token: string; payload: AgentTokenPayload } {
  const payload: AgentTokenPayload = {
    cid: input.continuityId,
    scope: input.scope ?? ['agent:queue', 'agent:claim'],
    iat: Date.now(),
    exp: Date.now() + (input.ttlSec ?? DEFAULT_TTL_SEC) * 1000,
    kid: crypto.randomUUID(),
    ...(input.label ? { label: input.label } : {}),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `${body}.${sign(body)}`, payload };
}

export function verifyAgentToken(
  token: string | null | undefined,
): { ok: true; payload: AgentTokenPayload } | { ok: false; reason: string } {
  if (!token) return { ok: false, reason: 'missing token' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed token' };

  const [body, mac] = parts;
  const expected = sign(body);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad signature' };
  }

  let payload: AgentTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AgentTokenPayload;
  } catch {
    return { ok: false, reason: 'unreadable payload' };
  }

  if (payload.exp < Date.now()) return { ok: false, reason: 'token expired' };
  if (!payload.cid) return { ok: false, reason: 'token carries no continuity id' };
  return { ok: true, payload };
}

export function hasScope(payload: AgentTokenPayload, scope: AgentScope): boolean {
  return payload.scope.includes(scope);
}

/** Read a bearer credential from an Authorization header. */
export function bearerFrom(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}
