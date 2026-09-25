/**
 * URL consistency.
 *
 * ============================================================================
 *  The bug these lock down
 * ============================================================================
 *
 * Two settings described the same thing and were read independently:
 *
 *   PRESENCE_PUBLIC_URL   used to build consent links and transfer links
 *   WORLDID_REDIRECT_URI  sent to the IdP; must match the portal byte for byte
 *
 * With only the second one set to an `https://` value, the login redirect went
 * to https while every link the app rendered pointed at http, and the dev server
 * was listening on http. Three different answers to "where am I" and nothing
 * compared them. The user-visible symptom was a frontend that still looked like
 * http after being told to run over https.
 *
 * The rule now: the redirect URI is authoritative, everything else derives from
 * its origin, and `baseUrlConsistency()` reports any remaining disagreement.
 */
import './setup';
import test from 'node:test';
import assert from 'node:assert/strict';

import { baseUrlConsistency, publicBaseUrl, redirectUri } from '../worldid/config';

/** Run `fn` with the URL-related environment replaced, restoring it afterwards. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const keys = ['PRESENCE_PUBLIC_URL', 'WORLDID_REDIRECT_URI'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

  for (const key of keys) {
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    fn();
  } finally {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('with nothing configured, both URLs default to plain local http', () => {
  withEnv({ PRESENCE_PUBLIC_URL: undefined, WORLDID_REDIRECT_URI: undefined }, () => {
    assert.equal(publicBaseUrl(), 'http://localhost:3000');
    assert.equal(redirectUri(), 'http://localhost:3000/api/auth/world/callback');
    assert.equal(baseUrlConsistency().consistent, true);
  });
});

test('the registered redirect URI decides the origin when nothing else does', () => {
  // This is the fix. Before it, `publicBaseUrl()` fell back to its http default
  // and every link the app rendered disagreed with the redirect it had just
  // registered with the portal.
  withEnv(
    { PRESENCE_PUBLIC_URL: undefined, WORLDID_REDIRECT_URI: 'https://localhost:3000/api/auth/world/callback' },
    () => {
      assert.equal(publicBaseUrl(), 'https://localhost:3000');
      assert.equal(redirectUri(), 'https://localhost:3000/api/auth/world/callback');
      assert.equal(baseUrlConsistency().consistent, true);
    },
  );
});

test('a tunnel hostname propagates to every derived URL', () => {
  withEnv(
    { PRESENCE_PUBLIC_URL: undefined, WORLDID_REDIRECT_URI: 'https://abc-def.trycloudflare.com/api/auth/world/callback' },
    () => {
      assert.equal(publicBaseUrl(), 'https://abc-def.trycloudflare.com');
      assert.equal(baseUrlConsistency().consistent, true);
    },
  );
});

test('an explicit public base URL is honoured', () => {
  withEnv({ PRESENCE_PUBLIC_URL: 'https://presence.example', WORLDID_REDIRECT_URI: undefined }, () => {
    assert.equal(publicBaseUrl(), 'https://presence.example');
    assert.equal(redirectUri(), 'https://presence.example/api/auth/world/callback');
  });
});

test('a trailing slash on the base URL is stripped, so links do not double up', () => {
  withEnv({ PRESENCE_PUBLIC_URL: 'https://presence.example/', WORLDID_REDIRECT_URI: undefined }, () => {
    assert.equal(publicBaseUrl(), 'https://presence.example');
    assert.equal(redirectUri(), 'https://presence.example/api/auth/world/callback');
  });
});

test('the two settings agreeing on origin is consistent, even with different paths', () => {
  withEnv(
    {
      PRESENCE_PUBLIC_URL: 'https://localhost:3000',
      WORLDID_REDIRECT_URI: 'https://localhost:3000/api/auth/world/callback',
    },
    () => {
      assert.equal(baseUrlConsistency().consistent, true);
    },
  );
});

test('a scheme disagreement is reported, and names both sides', () => {
  // The exact shape that produced the user's report.
  withEnv(
    {
      PRESENCE_PUBLIC_URL: 'http://localhost:3000',
      WORLDID_REDIRECT_URI: 'https://localhost:3000/api/auth/world/callback',
    },
    () => {
      const result = baseUrlConsistency();
      assert.equal(result.consistent, false);
      assert.match(result.detail ?? '', /http:\/\/localhost:3000/);
      assert.match(result.detail ?? '', /https:\/\/localhost:3000/);
    },
  );
});

test('a host disagreement is reported too', () => {
  withEnv(
    {
      PRESENCE_PUBLIC_URL: 'https://localhost:3000',
      WORLDID_REDIRECT_URI: 'https://abc.trycloudflare.com/api/auth/world/callback',
    },
    () => {
      assert.equal(baseUrlConsistency().consistent, false);
    },
  );
});

test('a malformed redirect URI is reported rather than thrown at link-building time', () => {
  withEnv({ PRESENCE_PUBLIC_URL: undefined, WORLDID_REDIRECT_URI: 'not a url' }, () => {
    // Building links must not explode; the misconfiguration is surfaced by the
    // consistency check instead.
    assert.doesNotThrow(() => publicBaseUrl());
    assert.equal(publicBaseUrl(), 'http://localhost:3000');
    const result = baseUrlConsistency();
    assert.equal(result.consistent, false);
    assert.match(result.detail ?? '', /not a valid URL/);
  });
});
