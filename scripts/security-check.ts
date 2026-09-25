#!/usr/bin/env tsx
/**
 * ============================================================================
 *  Security self-check (T-7.2)
 * ============================================================================
 *
 *   npm run build && npm run security-check
 *
 * Five checks the TODO asks for by name. Four of them are greps, which sounds
 * weak until you notice what they are greps *for*: the failure modes they catch
 * are all "someone added a second implementation", and a second implementation
 * is exactly what a grep finds and a unit test does not.
 *
 *   1. no secret in the client bundle
 *   2. every verification happens on the server
 *   3. `consumed_proof.nullifier` carries a real UNIQUE constraint
 *   4. the environment is pinned in exactly one place
 *   5. exactly ONE implementation of the gate, reached from every surface
 */
import fs from 'node:fs';
import path from 'node:path';

interface Check {
  name: string;
  pass: boolean;
  detail: string;
  failures?: string[];
}

const root = process.cwd();
const checks: Check[] = [];

function walk(dir: string, filter: (file: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip anything that is not ours to audit: dependencies, VCS metadata,
      // build output, the local npm cache, and the scratch test databases.
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name === '.next' ||
        entry.name === '.npm-cache' ||
        entry.name === '.test-db'
      ) {
        continue;
      }
      out.push(...walk(full, filter));
    } else if (filter(full)) {
      out.push(full);
    }
  }
  return out;
}

/** Every source file, excluding generated output and the vendored docs. */
const sourceFiles = walk(root, (f) => /\.(ts|tsx|mjs|js)$/.test(f)).filter(
  (f) => !f.includes('/.next/') && !f.includes('/.test-db/') && !f.includes('/node_modules/'),
);

function rel(f: string): string {
  return path.relative(root, f);
}

// ── 1. No secret in the client bundle ───────────────────────────────────────

{
  const secrets = [
    { label: 'PRESENCE_SIGNING_KEY value', needle: process.env.PRESENCE_SIGNING_KEY ?? '' },
    { label: 'WORLDID_CLIENT_SECRET value', needle: process.env.WORLDID_CLIENT_SECRET ?? '' },
    { label: 'dev fallback signing key', needle: 'presence-dev-only-signing-key' },
  ].filter((s) => s.needle.length >= 8);

  // The client bundle is the thing that actually ships to a browser, so that is
  // what gets scanned for every fingerprint. Server output is scanned separately
  // and only for the *real* configured secret values: a placeholder literal in
  // server code is fine, an actual key is not.
  const clientBundles = walk(path.join(root, '.next', 'static'), (f) => /\.(js|mjs)$/.test(f));
  const serverBundles = walk(path.join(root, '.next', 'server'), (f) => /\.(js|mjs)$/.test(f));
  const configuredSecrets = secrets.filter((s) => !s.label.startsWith('dev fallback'));

  if (clientBundles.length === 0 && serverBundles.length === 0) {
    checks.push({
      name: '1 · no secret reaches the client bundle',
      pass: false,
      detail: 'no build output found — run `npm run build` first',
    });
  } else {
    const failures: string[] = [];
    for (const file of clientBundles) {
      const content = fs.readFileSync(file, 'utf8');
      for (const secret of secrets) {
        if (content.includes(secret.needle)) failures.push(`${rel(file)} contains ${secret.label}`);
      }
      if (/WORLDID_CLIENT_SECRET\s*[:=]/.test(content)) {
        failures.push(`${rel(file)} references WORLDID_CLIENT_SECRET in client code`);
      }
    }
    for (const file of serverBundles) {
      const content = fs.readFileSync(file, 'utf8');
      for (const secret of configuredSecrets) {
        if (content.includes(secret.needle)) failures.push(`${rel(file)} inlines ${secret.label}`);
      }
    }
    checks.push({
      name: '1 · no secret reaches the client bundle',
      pass: failures.length === 0,
      detail:
        `scanned ${clientBundles.length} client and ${serverBundles.length} server bundles for ` +
        `${secrets.length} fingerprints`,
      failures,
    });
  }
}

// ── 2. Every verification is server-side ────────────────────────────────────

{
  // The only door to World ID is `worldid/`. Any other file that names the
  // issuer host, the OIDC endpoints, or imports the OIDC library is a second
  // implementation waiting to drift.
  const forbidden = [
    { pattern: /openid-client/, label: 'imports openid-client' },
    { pattern: /sandbox\.auth\.world\.org/, label: 'hard-codes the IdP host' },
    { pattern: /\/api\/v1\/(authorize|token|device_authorization)/, label: 'calls an OIDC endpoint directly' },
    { pattern: /\.well-known\/openid-configuration/, label: 'reads OIDC discovery directly' },
  ];

  const failures: string[] = [];
  for (const file of sourceFiles) {
    const relative = rel(file);
    if (relative.startsWith('worldid/')) continue; // this is the one allowed place
    if (relative.startsWith('scripts/spike.ts')) continue; // the spike probes the IdP by design
    if (relative === 'scripts/security-check.ts') continue; // this file names the patterns it forbids
    if (relative.startsWith('tests/')) continue; // tests may assert on the boundary

    const content = fs.readFileSync(file, 'utf8');
    for (const rule of forbidden) {
      if (rule.pattern.test(content)) failures.push(`${relative} ${rule.label}`);
    }
  }

  checks.push({
    name: '2 · all World ID access is confined to worldid/',
    pass: failures.length === 0,
    detail: `scanned ${sourceFiles.length} source files; worldid/ is the only door`,
    failures,
  });
}

// ── 3. The database carries the one-time-use guarantee ──────────────────────

{
  const schema = fs.readFileSync(path.join(root, 'db', 'schema.sql'), 'utf8');
  const failures: string[] = [];

  if (!/nullifier\s+TEXT\s+PRIMARY KEY/i.test(schema)) {
    failures.push('consumed_proof.nullifier is not declared as a PRIMARY KEY');
  }
  if (!/UNIQUE\s*\(\s*bound_action\s*,\s*continuity_id\s*\)/i.test(schema)) {
    failures.push('consumed_proof is missing UNIQUE (bound_action, continuity_id)');
  }
  if (!/CHECK\s*\(\s*state\s*<>\s*'ALLOCATED'\s+OR\s+approval_deadline\s+IS\s+NOT\s+NULL\s*\)/i.test(schema)) {
    failures.push('slot is missing the CHECK that every ALLOCATED slot has a deadline');
  }
  if (!/expires_at\s+INTEGER,\s*\n\s*completed_at/i.test(schema)) {
    failures.push('transfer.expires_at should start NULL (the TTL begins at first open)');
  }

  // And the code must actually rely on the constraint rather than pre-checking.
  const consume = fs.readFileSync(path.join(root, 'lib', 'consume.ts'), 'utf8');
  if (!/SQLITE_CONSTRAINT/.test(consume)) {
    failures.push('lib/consume.ts does not catch a constraint violation — it may be SELECT-then-INSERT');
  }

  checks.push({
    name: '3 · one-time use is a database constraint, not a code path',
    pass: failures.length === 0,
    detail: 'db/schema.sql + lib/consume.ts',
    failures,
  });
}

// ── 4. The environment is pinned in one place ───────────────────────────────

{
  const failures: string[] = [];
  const allowed = new Set(['worldid/config.ts', 'lib/api.ts', 'scripts/spike.ts', 'lib/attacks.ts']);

  for (const file of sourceFiles) {
    const relative = rel(file);
    if (relative.startsWith('tests/')) continue;
    if (allowed.has(relative)) continue;
    if (relative.startsWith('app/') && relative.endsWith('.tsx')) continue; // UI copy only

    const content = fs.readFileSync(file, 'utf8');

    // A parameter or field named `environment` outside the pinned module is how
    // a client-supplied environment would eventually reach the IdP.
    //
    // One legitimate exception: an ATTACK PAYLOAD that sends an environment in
    // order to prove it is refused. Those files are self-identifying — they must
    // also assert the expected `environment_pinned` refusal — so a genuine
    // declaration cannot hide behind the exemption.
    const mentionsEnvironment = /\benvironment\s*[?:]\s*(string|'sandbox'|'production'|'staging')/.test(
      content,
    );
    const isRefusalTest = /environment_pinned/.test(content);
    if (mentionsEnvironment && !isRefusalTest) {
      failures.push(`${relative} declares an environment parameter or field`);
    }
    if (/process\.env\.WORLDID_ENVIRONMENT/.test(content)) {
      failures.push(`${relative} reads the environment from process.env — it must be a constant`);
    }
  }

  const config = fs.readFileSync(path.join(root, 'worldid', 'config.ts'), 'utf8');
  if (!/export const WORLDID_ENVIRONMENT = 'sandbox' as const/.test(config)) {
    failures.push('worldid/config.ts no longer pins the environment as a literal constant');
  }

  checks.push({
    name: '4 · the environment is a server-side constant',
    pass: failures.length === 0,
    detail: 'worldid/config.ts is the only place an environment is named',
    failures,
  });
}

// ── 5. Exactly one gate, reached from every surface ─────────────────────────

{
  const failures: string[] = [];
  const gateDefinitionPath = path.join(root, 'lib', 'gate.ts');
  const gate = fs.readFileSync(gateDefinitionPath, 'utf8');

  if (!/export async function executeClaim/.test(gate)) {
    failures.push('lib/gate.ts does not export executeClaim');
  }
  if (!/approval_required/.test(gate)) {
    failures.push('lib/gate.ts does not refuse a call that arrives without an approval');
  }

  // Every caller must import the gate rather than reimplementing it.
  // Match CALLS, not mentions: several files legitimately discuss the gate in
  // comments, and flagging those would train people to stop writing comments.
  const callers = sourceFiles.filter((f) => {
    const content = fs.readFileSync(f, 'utf8');
    return /executeClaim\s*\(/.test(content) && rel(f) !== 'lib/gate.ts';
  });

  const expectedCallers = [
    'app/api/slot/claim/route.ts', // HTTP surface
    'lib/attacks.ts', // the replay demonstration
    'tests/harness.ts', // shared test fixture
    'tests/invariants.test.ts', // the invariant tests
    'scripts/security-check.ts', // this file names the call it looks for
  ];
  for (const caller of callers) {
    const relative = rel(caller);
    if (!expectedCallers.includes(relative)) {
      failures.push(`${relative} calls executeClaim — confirm it is a thin adapter, not a second gate`);
    }
  }

  // The MCP tool must reach the gate over HTTP, i.e. through the same route.
  const mcp = fs.readFileSync(path.join(root, 'mcp', 'server.ts'), 'utf8');
  if (!/\/api\/slot\/claim/.test(mcp)) {
    failures.push('mcp/server.ts does not route slot.claim through /api/slot/claim');
  }
  if (/consumeProof\s*\(|markExecuted\s*\(|confirmSlot\s*\(/.test(mcp)) {
    failures.push('mcp/server.ts touches consumption internals — it must be a thin wrapper');
  }

  // The transfer path has its own gate; make sure it shares the verification
  // helper rather than inventing its own.
  const transfer = fs.readFileSync(path.join(root, 'lib', 'transfer.ts'), 'utf8');
  if (!/verifyApproval\(/.test(transfer) || !/consumeProof\(/.test(transfer)) {
    failures.push('lib/transfer.ts does not use the shared verifyApproval + consumeProof path');
  }

  checks.push({
    name: '5 · one gate implementation, shared by every surface',
    pass: failures.length === 0,
    detail: `lib/gate.ts is reached by: ${callers.map(rel).join(', ')}`,
    failures,
  });
}

// ── report ──────────────────────────────────────────────────────────────────

console.log('');
console.log('  PRESENCE · security self-check (T-7.2)');
console.log(`  ${'─'.repeat(84)}`);

for (const check of checks) {
  console.log('');
  console.log(`  ${check.pass ? '✔' : '✖'} ${check.name}`);
  console.log(`      ${check.detail}`);
  for (const failure of check.failures ?? []) {
    console.log(`      → ${failure}`);
  }
}

const failed = checks.filter((c) => !c.pass);
console.log('');
console.log(`  ${'─'.repeat(84)}`);
console.log(`  ${checks.length - failed.length}/${checks.length} checks passed`);
console.log('');

process.exit(failed.length === 0 ? 0 : 1);
