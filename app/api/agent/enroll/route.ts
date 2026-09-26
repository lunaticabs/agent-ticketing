import { json, route, readJson } from '@/lib/api';
import { ensureHuman, touchFreshAuth } from '@/lib/humans';
import { issueAgentToken } from '@/lib/agenttoken';
import { audit } from '@/lib/audit';
import * as worldid from '@/worldid';
import { printStartupBanner } from '@/lib/startup';

/**
 * ============================================================================
 *  Agent enrollment (T-3.1 + T-5.2) — the headless path
 * ============================================================================
 *
 * This is the flow the sandbox `oidc` guide describes for a CLI or headless
 * agent, end to end:
 *
 *   POST  → our backend starts a World ID device authorization
 *   human → proves and approves on their own phone, using the printed user code
 *   GET   → our backend collects the validated ID token and issues ITS OWN
 *           credential for the agent
 *
 * Two design points that matter:
 *
 *   1. The IdP's token is never handed to the agent. The guide is explicit that
 *      the OIDC access token "does not authorize calls to this MCP or downstream
 *      services" — so the agent gets a scoped credential this server minted.
 *
 *   2. The device grant has no `max_age`/`prompt` controls, and does not need
 *      them: "Device grants always require fresh proof and explicit approval."
 *      Every enrollment is therefore a fresh human presence by construction,
 *      which is why this path also satisfies the freshness requirement.
 */

const ENROLL_ACTION = 'enroll_agent:humangate';

export const POST = route(async (req) => {
  printStartupBanner();
  const body = await readJson(req);
  const { guardClientSuppliedEnvironment } = await import('@/lib/api');
  guardClientSuppliedEnvironment(body);

  const label = typeof body.label === 'string' ? body.label : 'headless-agent';

  const started = await worldid.startFreshAuth({
    action: ENROLL_ACTION,
    signal: `enroll:${label}:${Date.now()}`,
    intent: 'link',
    maxAgeSec: 0,
  });

  audit({
    type: 'agent.enroll_started',
    payload: { requestId: started.requestId, mode: started.mode, label, degraded: started.degraded },
  });

  return json({
    ok: true,
    enrollId: started.requestId,
    mode: started.mode,
    degraded: started.degraded,
    expiresAt: started.expiresAt,
    ...(started.url ? { url: started.url } : {}),
    ...(started.deviceCode ? { deviceCode: started.deviceCode } : {}),
    instructions:
      started.mode === 'local'
        ? 'Open the URL, approve as a human, then poll this endpoint with ?enrollId='
        : 'Enter the user code on your own device (or open the complete URI), then poll this endpoint with ?enrollId=',
  });
});

export const GET = route(async (req) => {
  const url = new URL(req.url);
  const enrollId = url.searchParams.get('enrollId');
  if (!enrollId) {
    return json({ ok: false, code: 'bad_request', message: 'enrollId is required' }, { status: 400 });
  }

  const result = await worldid.awaitAuthResult(enrollId);

  if (!result.ok) {
    // `pending` is not a failure — it is the normal state while a human walks to
    // their phone. Everything else is terminal.
    const status = result.code === 'pending' ? 202 : 400;
    return json({ ok: false, code: result.code, message: result.message, enrollId }, { status });
  }

  const human = ensureHuman(result.issuer, result.subject);
  touchFreshAuth(human.continuity_id, result.authTime);

  const { token, payload } = issueAgentToken({
    continuityId: human.continuity_id,
    scope: ['agent:queue', 'agent:claim'],
    ttlSec: 60 * 60 * 4,
    label: url.searchParams.get('label') ?? 'headless-agent',
  });

  audit({
    type: 'agent.enrolled',
    continuityId: human.continuity_id,
    payload: {
      enrollId,
      scope: payload.scope,
      expiresAt: payload.exp,
      authTime: result.authTime,
      // Worth stating: this credential proves nothing about freshness later. It
      // says who the agent acts for; the gate re-checks everything per action.
      note: 'agent credential issued; it carries identity and scope, never authorization for an action',
    },
  });

  return json({
    ok: true,
    enrollId,
    continuityId: human.continuity_id,
    // The credential itself. It is scoped and expiring, and it says nothing
    // about any specific operation.
    agentToken: token,
    scope: payload.scope,
    expiresAt: payload.exp,
    degraded: result.mode === 'local',
    note:
      'Send this as `Authorization: Bearer <token>`. It identifies the human the agent acts for. ' +
      'Every protected action is still re-verified against a per-operation approval.',
  });
});
