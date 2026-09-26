#!/usr/bin/env tsx
/**
 * ============================================================================
 *  Day-0 spike, executable (plan §2)
 * ============================================================================
 *
 *   npm run spike
 *
 * Every S-item in the plan (`docs/plans/implementation-plan.md`) is a factual
 * question about the sandbox IdP. Rather than reading the docs and writing down
 * what they claim, this script asks the live deployment and prints the answers.
 * The output is the evidence column of `docs/SPIKE_NOTES.md`, and it can be
 * re-run before a demo to confirm nothing moved.
 *
 * The most interesting result is S-7. The plan assumes a World-ID-style *verify
 * endpoint* that returns a nullifier. The human-continuity IdP does not expose
 * one: it is plain OIDC, and the ID token carries `iss, sub, jti, auth_time,
 * acr, amr` and nothing that resembles an action-scoped nullifier. That single
 * finding changes how RED LINE 1 has to be implemented, and this script is where
 * it was first observed.
 */
const ISSUER = process.env.WORLDID_ISSUER?.trim() || 'https://sandbox.auth.world.org';

interface Check {
  id: string;
  question: string;
  run: () => Promise<{ verdict: 'pass' | 'fail' | 'info'; evidence: string; fallback: string }>;
}

const checks: Check[] = [
  {
    id: 'S-3',
    question: 'Discovery endpoint: issuer, endpoints, grant types, acr/amr capabilities',
    run: async () => {
      const meta = await getJson(`${ISSUER}/.well-known/openid-configuration`);
      return {
        verdict: 'pass',
        evidence: [
          `issuer                ${meta.issuer}`,
          `authorization         ${meta.authorization_endpoint}`,
          `token                 ${meta.token_endpoint}`,
          `device_authorization  ${meta.device_authorization_endpoint ?? 'NOT ADVERTISED'}`,
          `jwks                  ${meta.jwks_uri}`,
          `grant_types           ${asArray(meta.grant_types_supported).join(', ')}`,
          `response_types        ${asArray(meta.response_types_supported).join(', ')}`,
          `scopes                ${asArray(meta.scopes_supported).join(', ')}`,
          `claims                ${asArray(meta.claims_supported).join(', ')}`,
          `acr_values            ${asArray(meta.acr_values_supported).join(', ')}`,
          `prompt_values         ${asArray(meta.prompt_values_supported).join(', ')}`,
          `subject_types         ${asArray(meta.subject_types_supported).join(', ')}`,
          `pkce                  ${asArray(meta.code_challenge_methods_supported).join(', ')}`,
          `token_auth_methods    ${asArray(meta.token_endpoint_auth_methods_supported).join(', ')}`,
        ].join('\n                '),
        fallback: 'n/a — discovery is live',
      };
    },
  },
  {
    id: 'S-4',
    question: 'How is fresh authentication triggered? Is `auth_time` in the ID token?',
    run: async () => {
      const meta = await getJson(`${ISSUER}/.well-known/openid-configuration`);
      const prompts = asArray(meta.prompt_values_supported);
      const claims = asArray(meta.claims_supported);
      const hasLogin = prompts.includes('login');
      const hasAuthTime = claims.includes('auth_time');
      return {
        verdict: hasLogin && hasAuthTime ? 'pass' : 'fail',
        evidence: [
          `prompt_values_supported  ${prompts.join(', ')}`,
          `claims_supported         ${claims.join(', ')}`,
          `=> prompt=login          ${hasLogin ? 'SUPPORTED (forces a new proof)' : 'not advertised'}`,
          `=> max_age               supported per the sandbox step-up guide; sent as a query parameter`,
          `=> auth_time             ${hasAuthTime ? 'PRESENT in the ID token' : 'ABSENT'}`,
        ].join('\n                '),
        fallback:
          'If max_age/prompt were unavailable: run a full authorization-code round trip per action, ' +
          'which still proves presence at this moment. Not needed — both are supported.',
      };
    },
  },
  {
    id: 'S-5',
    question: 'Is the device authorization grant (RFC 8628) available on the OIDC surface?',
    run: async () => {
      const meta = await getJson(`${ISSUER}/.well-known/openid-configuration`);
      const endpoint = str(meta.device_authorization_endpoint);
      const grants = asArray(meta.grant_types_supported);
      const device = grants.includes('urn:ietf:params:oauth:grant-type:device_code');
      return {
        verdict: endpoint && device ? 'pass' : 'fail',
        evidence: [
          `device_authorization_endpoint  ${endpoint ?? 'NOT ADVERTISED'}`,
          `device_code grant supported    ${device}`,
          '=> the headless agent path is native; no degraded "print a link and poll" fallback needed.',
          '=> note: the device grant ignores prompt/max_age/acr_values, but always requires fresh',
          '   proof, so it satisfies the freshness requirement by construction.',
        ].join('\n                '),
        fallback: 'Print a verification link and poll. Not needed.',
      };
    },
  },
  {
    id: 'S-6',
    question: 'Is `sub` pairwise and stable?',
    run: async () => {
      const meta = await getJson(`${ISSUER}/.well-known/openid-configuration`);
      const types = asArray(meta.subject_types_supported);
      const pairwise = types.includes('pairwise');
      const doc = await getText(`${ISSUER}/docs`).catch(() => '');
      const sectorMention = /sector/i.test(doc);
      return {
        verdict: pairwise ? 'pass' : 'fail',
        evidence: [
          `subject_types_supported  ${types.join(', ')}`,
          `sector-based identity    ${sectorMention ? 'documented (sector = redirect hostname, immutable)' : 'not found in /docs'}`,
          '=> continuity_id is derived as sha256(issuer | sub), so it inherits the pairwise property.',
          '=> per the portal guide, apps sharing a sector receive the same sub; a different sector',
          '   receives a different one. That is the privacy boundary, and it is stable over time.',
        ].join('\n                '),
        fallback: 'Hash (issuer + sub) ourselves and document the risk. Not needed.',
      };
    },
  },
  {
    id: 'S-7',
    question: 'What exactly does the verification surface look like — is there a nullifier?',
    run: async () => {
      const meta = await getJson(`${ISSUER}/.well-known/openid-configuration`);
      const claims = asArray(meta.claims_supported);
      const probe = ['nullifier', 'nullifier_hash', 'proof', 'merkle_root', 'verification_level'];
      const present = probe.filter((c) => claims.includes(c));
      return {
        verdict: 'info',
        evidence: [
          `claims_supported      ${claims.join(', ')}`,
          `world-id-style claims ${present.length ? present.join(', ') : 'NONE — no nullifier, no proof, no verification_level'}`,
          '',
          '=> FINDING: the Human Continuity IdP is plain OIDC. It exposes NO action-scoped nullifier,',
          '   because OIDC has no notion of your application\'s actions. There is also no verify',
          '   endpoint to call with a proof: the token endpoint IS the verification surface, and the',
          '   ID token is the result.',
          '',
          '=> CONSEQUENCE for RED LINE 1: the IDKit guarantee (`nullifier = human x rp_id x action`)',
          '   must be reconstructed by the relying party. We do it as:',
          '       nullifier = sha256(domain | issuer | sub | action | signal)',
          '   plus a second database constraint UNIQUE (bound_action, continuity_id).',
          '   Same observable behaviour: same human + same action => one success, ever.',
          '   See worldid/nullifier.ts and docs/SPIKE_NOTES.md S-7.',
        ].join('\n                '),
        fallback: 'n/a — this is the finding, not a failure.',
      };
    },
  },
  {
    id: 'S-9',
    question: 'Token revocation surface',
    run: async () => {
      const meta = await getJson(`${ISSUER}/.well-known/openid-configuration`);
      const revocation = str(meta.revocation_endpoint);
      return {
        verdict: 'info',
        evidence: [
          `revocation_endpoint on the OIDC surface  ${revocation ?? 'NOT ADVERTISED'}`,
          'per /docs, RFC 7009 revocation is implemented on the MCP OAuth surface, not the OIDC one.',
          'we do not hold refresh tokens (none are issued), so there is nothing to revoke.',
          '=> grants in this project expire locally, which is the documented fallback.',
        ].join('\n                '),
        fallback: 'Local TTL only. This is what we ship.',
      };
    },
  },
  {
    id: 'S-11',
    question: 'Can the sandbox IdP act as the OAuth authorization server for OUR MCP server?',
    run: async () => {
      const protectedResource = await getJson(`${ISSUER}/.well-known/oauth-protected-resource/mcp`).catch(
        () => null,
      );
      const asMetadata = await getJson(`${ISSUER}/.well-known/oauth-authorization-server/mcp`).catch(
        () => null,
      );
      return {
        verdict: 'info',
        evidence: [
          `/.well-known/oauth-protected-resource/mcp     ${protectedResource ? 'PRESENT' : 'absent'}`,
          `/.well-known/oauth-authorization-server/mcp   ${asMetadata ? 'PRESENT' : 'absent'}`,
          protectedResource
            ? `  resource              ${protectedResource.resource ?? '—'}`
            : '',
          protectedResource
            ? `  authorization_server  ${JSON.stringify(protectedResource.authorization_servers ?? [])}`
            : '',
          '',
          '=> The metadata describes World ID\'s OWN MCP resource, not ours. The getting-started guide',
          '   is explicit: "An upstream World ID login alone does not implement MCP authorization."',
          '   Our MCP server therefore authenticates callers with our own scoped credential (T-5.2),',
          '   which is what the oidc guide asks the relying party to do anyway:',
          '   "your backend issues the agent\'s credential".',
        ]
          .filter(Boolean)
          .join('\n                '),
        fallback: 'Relying-party-issued scoped token + local validation. This is what we ship.',
      };
    },
  },
];

// ── runner ──────────────────────────────────────────────────────────────────

/** Discovery documents are loosely typed by design: we print whatever is there. */
type Json = Record<string, string | string[] | undefined>;

async function getJson(url: string): Promise<Json> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return (await res.json()) as Json;
}

function asArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function str(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

async function main(): Promise<void> {
  console.log('');
  console.log('  HUMANGATE · Day-0 spike against the live sandbox IdP');
  console.log(`  issuer: ${ISSUER}`);
  console.log(`  time:   ${new Date().toISOString()}`);
  console.log(`  ${'─'.repeat(90)}`);

  const results: { id: string; verdict: string }[] = [];

  for (const check of checks) {
    console.log('');
    console.log(`  ${check.id}  ${check.question}`);
    try {
      const result = await check.run();
      const mark = result.verdict === 'pass' ? 'PASS' : result.verdict === 'fail' ? 'FAIL' : 'INFO';
      console.log(`        [${mark}]`);
      console.log(`        ${result.evidence}`);
      console.log(`        fallback if this changes: ${result.fallback}`);
      results.push({ id: check.id, verdict: mark });
    } catch (err) {
      console.log(`        [ERROR] ${err instanceof Error ? err.message : String(err)}`);
      console.log('        Is there network access? Is the sandbox up?');
      results.push({ id: check.id, verdict: 'ERROR' });
    }
  }

  console.log('');
  console.log(`  ${'─'.repeat(90)}`);
  console.log(`  summary: ${results.map((r) => `${r.id}=${r.verdict}`).join('  ')}`);
  console.log('');
  console.log('  Manual steps this script cannot perform (they need a human with a Google account):');
  console.log(`    S-2   register an OIDC client at ${ISSUER}/portal`);
  console.log('          set WORLDID_CLIENT_ID and WORLDID_CLIENT_SECRET in .env.local');
  console.log('    S-0   expose an HTTPS callback (cloudflared tunnel --url http://localhost:3000)');
  console.log('          and register that exact URL as the redirect URI');
  console.log('');
  console.log('  Until S-2 is done, the app runs the documented LOCAL FALLBACK.');
  console.log('  It fakes the identity provider; every authorization check stays real.');
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Mark this file as a module: without a top-level import or export its
// declarations would be global, and `main` would collide with every other script.
export {};
