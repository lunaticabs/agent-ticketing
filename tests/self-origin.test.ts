/**
 * ============================================================================
 *  "Where am I?" — asked by the server about itself
 * ============================================================================
 *
 * `selfOrigin()` answers the question the server asks when it needs to call
 * *itself*: the MCP agent's child process, the bot army's twenty-four join
 * requests. It used to answer "the origin this request arrived on", which is
 * right on a laptop and wrong in a container: the app binds `0.0.0.0:3000`, so
 * that origin is `https://0.0.0.0:3000` — the wildcard, an address nothing can
 * dial.
 *
 * This is the second time the same root cause reached production. The first was
 * the OIDC callback signing a `0.0.0.0` redirect URI into a token exchange
 * (`lib/callback.ts`); this one made every agent tool call fail with
 * `transport_error — fetch failed`, which names neither the address nor the
 * reason. So the matrix is enumerated here rather than trusted.
 */
import './setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

import { selfOrigin } from '../lib/selfcall';

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const keys = ['HUMANGATE_PUBLIC_URL', 'WORLDID_REDIRECT_URI'] as const;
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

const PUBLIC = 'https://agent-ticket-demo.fly.dev';

/** A request as the server sees it behind Fly's proxy: wildcard host, real headers. */
function proxied(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, { headers });
}

test('S-1 — the wildcard binding never escapes, even with no headers at all', () => {
  withEnv({ HUMANGATE_PUBLIC_URL: PUBLIC }, () => {
    assert.equal(selfOrigin(proxied('https://0.0.0.0:3000/api/dev/agent')), PUBLIC);
  });
});

test('S-2 — a proxy-supplied host is used, with the caller’s scheme', () => {
  withEnv({ HUMANGATE_PUBLIC_URL: PUBLIC }, () => {
    assert.equal(
      selfOrigin(
        proxied('https://0.0.0.0:3000/api/dev/agent', {
          'x-forwarded-host': PUBLIC.replace('https://', ''),
          'x-forwarded-proto': 'https',
        }),
      ),
      PUBLIC,
      'this is the production shape: the proxy knows the real hostname',
    );
  });
});

test('S-3 — only the first value of a multi-valued proxy header is read', () => {
  withEnv({ HUMANGATE_PUBLIC_URL: PUBLIC }, () => {
    assert.equal(
      selfOrigin(
        proxied('https://0.0.0.0:3000/x', {
          'x-forwarded-host': 'agent-ticket-demo.fly.dev, inner-proxy:3000',
          'x-forwarded-proto': 'https, http',
        }),
      ),
      PUBLIC,
    );
  });
});

test('S-4 — loopback is normalised to localhost, keeping the certificate path alive', () => {
  withEnv({ HUMANGATE_PUBLIC_URL: PUBLIC }, () => {
    // `selfCallEnv` attaches NODE_EXTRA_CA_CERTS for loopback origins only, so
    // this must stay loopback — replacing it with the public URL would send a
    // local demo through the internet and break its self-signed certificate.
    assert.equal(selfOrigin(proxied('https://127.0.0.1:3000/api/x')), 'https://localhost:3000');
    assert.equal(selfOrigin(proxied('https://localhost:3000/api/x')), 'https://localhost:3000');
    assert.equal(selfOrigin(proxied('http://localhost:3000/api/x')), 'http://localhost:3000');
  });
});

test('S-5 — a literal wildcard host in the Host header is not dialled', () => {
  withEnv({ HUMANGATE_PUBLIC_URL: PUBLIC }, () => {
    assert.equal(selfOrigin(proxied('https://0.0.0.0:3000/x', { 'x-forwarded-host': '0.0.0.0:3000' })), PUBLIC);
  });
});

test('S-6 — with no configuration at all, a wildcard becomes localhost rather than nothing', () => {
  withEnv({ HUMANGATE_PUBLIC_URL: undefined, WORLDID_REDIRECT_URI: undefined }, () => {
    // The port is carried over: this is `npm run dev:http` on a wildcard bind in
    // a container with no public URL, and localhost:3000 is where it is.
    assert.equal(selfOrigin(proxied('https://0.0.0.0:3000/x', { 'x-forwarded-host': '0.0.0.0:3000' })), 'http://localhost:3000');
  });
});

test('S-7 — the redirect URI answers when HUMANGATE_PUBLIC_URL is unset, as on Fly', () => {
  withEnv(
    { HUMANGATE_PUBLIC_URL: undefined, WORLDID_REDIRECT_URI: `${PUBLIC}/api/auth/world/callback` },
    () => {
      assert.equal(selfOrigin(proxied('https://0.0.0.0:3000/x')), PUBLIC);
    },
  );
});

test('S-8 — plain HTTP on a real host stays HTTP', () => {
  withEnv({ HUMANGATE_PUBLIC_URL: PUBLIC }, () => {
    // A phone on the same wifi hitting `npm run dev:http` by IP. Hardcoding
    // `https` here would break the very flow this function exists to serve.
    assert.equal(selfOrigin(proxied('http://192.168.1.20:3000/api/x')), 'http://192.168.1.20:3000');
  });
});

test('S-9 — a garbage host falls back to configuration instead of throwing', () => {
  withEnv({ HUMANGATE_PUBLIC_URL: PUBLIC }, () => {
    assert.equal(selfOrigin(proxied('https://0.0.0.0:3000/x', { 'x-forwarded-host': 'not a host!!' })), PUBLIC);
    assert.equal(selfOrigin(proxied('https://0.0.0.0:3000/x', { 'x-forwarded-host': '' })), PUBLIC);
  });
});
