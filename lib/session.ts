/**
 * Server-side session.
 *
 * A session says only *which continuity id* is talking. It is an HMAC-signed
 * cookie, not a JWT with an identity claim anyone could mint, and it carries no
 * World ID token. RED LINE 2: the signing key never leaves the server, so a
 * client cannot forge a session by editing the cookie.
 *
 * A session proves *who*. It never proves *fresh*. Those are separate checks on
 * purpose — every protected action re-runs the freshness gate even when the
 * session is perfectly valid.
 */
import type { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { serverSigningKey } from '../worldid/config';
import { bearerFrom, hasScope, verifyAgentToken } from './agenttoken';

export const SESSION_COOKIE = 'presence_session';
const TTL_MS = 12 * 60 * 60 * 1000;

interface SessionPayload {
  cid: string;
  iat: number;
  exp: number;
}

function sign(body: string): string {
  return crypto.createHmac('sha256', serverSigningKey()).update(body).digest('base64url');
}

export function issueSession(continuityId: string): { name: string; value: string; maxAge: number } {
  const payload: SessionPayload = {
    cid: continuityId,
    iat: Date.now(),
    exp: Date.now() + TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { name: SESSION_COOKIE, value: `${body}.${sign(body)}`, maxAge: Math.floor(TTL_MS / 1000) };
}

export function readSessionValue(value: string | undefined | null): string | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  const expected = sign(body);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (payload.exp < Date.now()) return null;
    return payload.cid;
  } catch {
    return null;
  }
}

/** Continuity id of the caller, or `null` when anonymous. */
export function currentContinuityId(req: NextRequest): string | null {
  return readSessionValue(req.cookies.get(SESSION_COOKIE)?.value);
}

/**
 * Resolve the caller from either a browser session cookie or an agent bearer
 * token (T-5.2). Both paths end at the same continuity id, which is the only
 * thing the rest of the system cares about — there is no "agent mode" flag
 * anywhere in the business logic, so an agent can never be treated as a
 * privileged caller.
 */
export function resolveCaller(
  req: NextRequest,
  requiredScope?: import('./agenttoken').AgentScope,
): { continuityId: string | null; via: 'cookie' | 'agent-token' | 'none'; scope: string[] } {
  const cookie = currentContinuityId(req);
  if (cookie) return { continuityId: cookie, via: 'cookie', scope: ['human'] };

  const bearer = bearerFrom(req.headers.get('authorization'));
  if (bearer) {
    const verified = verifyAgentToken(bearer);
    if (verified.ok) {
      if (requiredScope && !hasScope(verified.payload, requiredScope)) {
        return { continuityId: null, via: 'agent-token', scope: verified.payload.scope };
      }
      return { continuityId: verified.payload.cid, via: 'agent-token', scope: verified.payload.scope };
    }
  }

  return { continuityId: null, via: 'none', scope: [] };
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
export const SESSION_TTL_SEC = Math.floor(TTL_MS / 1000);
