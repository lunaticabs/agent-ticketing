/**
 * The rename, pinned.
 *
 * ============================================================================
 *  Why this test exists
 * ============================================================================
 *
 * The project shipped as *Presence* and is now *HumanGate*, but the environment
 * variables live in a deployment's secret store, which cannot be renamed in the
 * same instant as a `git push`. `lib/env.ts` therefore resolves two names with a
 * fixed precedence: `HUMANGATE_*` wins, `PRESENCE_*` still works.
 *
 * Two names for one value is exactly the failure shape this codebase spends the
 * rest of its tests hunting — two copies of one piece of state with nothing
 * asserting they agree. So the precedence is a rule with a test rather than a
 * convention with a comment:
 *
 *   1. `HUMANGATE_*` beats `PRESENCE_*`;
 *   2. the legacy name alone is enough;
 *   3. an empty or whitespace value is *absent*, not empty — otherwise a
 *      half-filled secret would silently defeat a `?? default`;
 *   4. it holds through a real reader, not only through the helper.
 *
 * Delete this file, and the legacy branch in `lib/env.ts`, once no deployment
 * sets the old names.
 */
import './setup';
import test from 'node:test';
import assert from 'node:assert/strict';

import { env, hasEnv } from '../lib/env';
import { publicBaseUrl } from '../worldid/config';
import { dbPath } from '../lib/db';

const KEYS = [
  'HUMANGATE_PUBLIC_URL',
  'PRESENCE_PUBLIC_URL',
  'WORLDID_REDIRECT_URI',
  'HUMANGATE_DB',
  'PRESENCE_DB',
] as const;

/** Run `fn` with the environment replaced, restoring every key afterwards. */
function withEnv(vars: Partial<Record<(typeof KEYS)[number], string | undefined>>, fn: () => void): void {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const key of KEYS) {
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ── 1. The precedence rule ──────────────────────────────────────────────────

test('R-1 — the current name wins when both are set', () => {
  withEnv(
    { HUMANGATE_PUBLIC_URL: 'https://humangate.example', PRESENCE_PUBLIC_URL: 'https://presence.example' },
    () => {
      assert.equal(env('PUBLIC_URL'), 'https://humangate.example');
      assert.equal(publicBaseUrl(), 'https://humangate.example');
    },
  );
});

test('R-2 — the legacy name alone still resolves', () => {
  withEnv({ HUMANGATE_PUBLIC_URL: undefined, PRESENCE_PUBLIC_URL: 'https://legacy.example' }, () => {
    assert.equal(env('PUBLIC_URL'), 'https://legacy.example');
    assert.equal(publicBaseUrl(), 'https://legacy.example');
  });
});

test('R-3 — neither name set means absent, not empty', () => {
  withEnv({ HUMANGATE_PUBLIC_URL: undefined, PRESENCE_PUBLIC_URL: undefined, WORLDID_REDIRECT_URI: undefined }, () => {
    assert.equal(env('PUBLIC_URL'), undefined);
    assert.equal(hasEnv('PUBLIC_URL'), false);
    assert.equal(publicBaseUrl(), 'http://localhost:3000');
  });
});

test('R-4 — whitespace is absent, so a half-filled secret cannot defeat a default', () => {
  withEnv({ HUMANGATE_PUBLIC_URL: '   ', PRESENCE_PUBLIC_URL: undefined, WORLDID_REDIRECT_URI: undefined }, () => {
    assert.equal(env('PUBLIC_URL'), undefined);
    assert.equal(publicBaseUrl(), 'http://localhost:3000');
  });

  // And an empty current name must not mask a real legacy value.
  withEnv({ HUMANGATE_PUBLIC_URL: '', PRESENCE_PUBLIC_URL: 'https://legacy.example' }, () => {
    assert.equal(env('PUBLIC_URL'), 'https://legacy.example');
  });
});

test('R-5 — values are trimmed on the way out, under either name', () => {
  withEnv({ HUMANGATE_PUBLIC_URL: '  https://humangate.example  ' }, () => {
    assert.equal(env('PUBLIC_URL'), 'https://humangate.example');
  });
  withEnv({ HUMANGATE_PUBLIC_URL: undefined, PRESENCE_PUBLIC_URL: '  https://legacy.example  ' }, () => {
    assert.equal(env('PUBLIC_URL'), 'https://legacy.example');
  });
});

// ── 2. Through a real reader ────────────────────────────────────────────────

test('R-6 — the database path reader honours both names', () => {
  withEnv({ HUMANGATE_DB: undefined, PRESENCE_DB: '/tmp/presence-legacy.db' }, () => {
    assert.equal(dbPath(), '/tmp/presence-legacy.db');
  });
  withEnv({ HUMANGATE_DB: '/tmp/humangate-current.db', PRESENCE_DB: '/tmp/presence-legacy.db' }, () => {
    assert.equal(dbPath(), '/tmp/humangate-current.db');
  });
});

// ── 3. What was deliberately not renamed ────────────────────────────────────

test('R-7 — the database FILE keeps its name, whatever the variable is called', () => {
  // A renamed file would point a running deployment at an empty database on its
  // mounted volume. The variable may be re-spelled; the path may not.
  withEnv({ HUMANGATE_DB: undefined, PRESENCE_DB: undefined }, () => {
    assert.match(dbPath(), /db[/\\]presence\.db$/);
  });
});
