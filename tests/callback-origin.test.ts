/**
 * ============================================================================
 *  The callback must not trust the origin the request arrived on
 * ============================================================================
 *
 * This is a regression test for a bug that no unit test could see and that only
 * appeared in production, because only production sits behind a proxy.
 *
 * ── What happened ──────────────────────────────────────────────────────────
 *
 * The container binds `0.0.0.0:3000`, so `req.url` inside a route handler reads
 * `https://0.0.0.0:3000/api/auth/world/callback?...`. The route used that URL
 * for two things, and the second one broke sign-in for every user:
 *
 *   1. the post-callback redirect sent the browser to `https://0.0.0.0:3000/` —
 *      an address that exists only inside the container; and
 *   2. `openid-client`'s `authorizationCodeGrant` derives the token request's
 *      `redirect_uri` from that URL (`stripParams(currentUrl)`) rather than from
 *      the configuration, so the code exchange presented a redirect URI that did
 *      not match the portal registration. The IdP refused it, and the user saw
 *      `callback_failed` / `server responded with an error in the response body`.
 *
 * The fix rebuilds the URL against `publicBaseUrl()`, which is derived from
 * `WORLDID_REDIRECT_URI` — the one value that cannot be approximated, because
 * the portal compares it byte for byte.
 *
 * ── What these tests pin down ──────────────────────────────────────────────
 *
 * The origin comes from configuration and never from the request; the query
 * string — which carries `code` and `state`, the entire point of the callback —
 * survives untouched; and no redirect can name an internal address.
 */
import './setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

import { handleCallback, type CallbackDeps } from '../lib/callback';

const PUBLIC_ORIGIN = 'https://agent-ticket-demo.fly.dev';

/** Run `fn` with the URL configuration replaced, restoring it afterwards. */
function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const keys = ['HUMANGATE_PUBLIC_URL', 'WORLDID_REDIRECT_URI'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const key of keys) {
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** A request whose Host header is the container's internal binding. */
function proxiedRequest(query: string): NextRequest {
  return new NextRequest(`https://0.0.0.0:3000/api/auth/world/callback?${query}`, {
    headers: { host: '0.0.0.0:3000' },
  });
}

/** Records what the route handed to the IdP layer. */
function recordingDeps(): CallbackDeps & { seen: URL[] } {
  const seen: URL[] = [];
  return {
    seen,
    async completeOidcCallback(url: URL) {
      seen.push(url);
      return { ok: false, error: 'stubbed refusal' };
    },
    async awaitAuthResult() {
      return { ok: false, code: 'unreachable', message: 'not reached in this test' };
    },
  } as unknown as CallbackDeps & { seen: URL[] };
}

test('C-1 — the origin the IdP sees is the configured one, not the internal binding', async () => {
  await withEnv({ HUMANGATE_PUBLIC_URL: PUBLIC_ORIGIN }, async () => {
    const deps = recordingDeps();
    await handleCallback(proxiedRequest('code=abc&state=xyz'), deps);

    assert.equal(deps.seen.length, 1, 'the route consulted the IdP layer exactly once');
    const url = deps.seen[0];

    // The redirect_uri openid-client will derive from this URL is what the
    // portal compares. It has to be the registered value.
    const derived = new URL(url.origin + url.pathname);
    assert.equal(
      derived.href,
      `${PUBLIC_ORIGIN}/api/auth/world/callback`,
      'the token exchange must present the registered redirect_uri, byte for byte',
    );
    assert.ok(
      !url.href.includes('0.0.0.0'),
      `an internal binding address reached the IdP layer: ${url.href}`,
    );
  });
});

test('C-2 — `code` and `state` survive the rebuild untouched', async () => {
  await withEnv({ HUMANGATE_PUBLIC_URL: PUBLIC_ORIGIN }, async () => {
    const deps = recordingDeps();
    await handleCallback(proxiedRequest('code=the-code&state=the-state&iss=extra'), deps);

    const url = deps.seen[0];
    assert.equal(url.searchParams.get('code'), 'the-code');
    assert.equal(url.searchParams.get('state'), 'the-state');
    assert.equal(url.searchParams.get('iss'), 'extra', 'extra parameters are passed through, not dropped');
  });
});

test('C-3 — a failure redirects to the public origin, never to 0.0.0.0', async () => {
  await withEnv({ HUMANGATE_PUBLIC_URL: PUBLIC_ORIGIN }, async () => {
    const response = await handleCallback(proxiedRequest('code=abc&state=xyz'), recordingDeps());

    assert.equal(response.status, 307, 'a redirect, not an error page');
    const location = response.headers.get('location')!;
    assert.ok(location.startsWith(`${PUBLIC_ORIGIN}/`), `redirect went to ${location}`);
    assert.ok(
      !location.includes('0.0.0.0'),
      `the browser was sent to an address that exists only inside the container: ${location}`,
    );
    assert.match(location, /authError=callback_failed/, 'and it says what went wrong');
  });
});

test('C-4 — the redirect URI wins even when HUMANGATE_PUBLIC_URL is unset, as on Fly', async () => {
  // This is the deployed shape: only WORLDID_REDIRECT_URI is set, and
  // `publicBaseUrl()` derives the origin from it.
  await withEnv(
    { HUMANGATE_PUBLIC_URL: undefined, WORLDID_REDIRECT_URI: `${PUBLIC_ORIGIN}/api/auth/world/callback` },
    async () => {
      const deps = recordingDeps();
      await handleCallback(proxiedRequest('code=abc&state=xyz'), deps);

      assert.equal(
        new URL(deps.seen[0].origin + deps.seen[0].pathname).href,
        `${PUBLIC_ORIGIN}/api/auth/world/callback`,
      );
    },
  );
});

test('C-5 — an IdP-side refusal is reported as itself, and still lands on the public origin', async () => {
  await withEnv({ HUMANGATE_PUBLIC_URL: PUBLIC_ORIGIN }, async () => {
    const response = await handleCallback(
      proxiedRequest('error=access_denied&error_description=user%20said%20no'),
      recordingDeps(),
    );

    const location = response.headers.get('location')!;
    assert.match(location, /authError=access_denied/, 'the IdP\u2019s own code is preserved');
    assert.ok(location.startsWith(`${PUBLIC_ORIGIN}/`), `redirect went to ${location}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  Saying what the IdP actually said
// ════════════════════════════════════════════════════════════════════════════

/**
 * The first real sign-in on the public deployment failed with exactly this and
 * nothing else: `server responded with an error in the response body`. That is
 * `oauth4webapi`'s message for "the token endpoint returned 4xx JSON", and the
 * part that identifies the mistake — the IdP's own `error` code — sits in
 * `ResponseBodyError.cause`, one level up.
 *
 * These cases are the whole point of unwrapping it: each one names a different
 * misconfiguration, and none of them is guessable from the outer message.
 */
test('C-6 — the IdP’s own error code reaches the operator', async () => {
  const { explainOidcError } = await import('../worldid/index');

  const cases: [string, string | undefined, string][] = [
    ['invalid_client', 'client authentication failed', 'client id or secret is wrong'],
    ['invalid_grant', 'redirect_uri does not match', 'the redirect URI or the code is wrong'],
    ['invalid_request', 'code_verifier required', 'PKCE was not carried through'],
  ];

  for (const [code, description, why] of cases) {
    const err = Object.assign(new Error('server responded with an error in the response body'), {
      cause: description ? { error: code, error_description: description } : { error: code },
      response: { status: 400 },
    });
    const explained = explainOidcError(err);

    assert.match(explained, new RegExp(code), `expected the code for: ${why}`);
    assert.match(explained, /HTTP 400/, 'and the status, which separates 4xx from 5xx');
    if (description) assert.ok(explained.includes(description), 'and the IdP’s explanation');
    assert.ok(
      explained !== 'server responded with an error in the response body',
      `the unhelpful message survived for ${code}`,
    );
  }
});

test('C-7 — unwrapping never walks into a cycle, and never returns nothing', () => {
  return import('../worldid/index').then(({ explainOidcError }) => {
    const looped: Record<string, unknown> = { error: 'invalid_grant' };
    looped.cause = looped;

    assert.equal(explainOidcError(looped), 'invalid_grant', 'a self-referential cause terminates');

    const plain = new Error('plain failure');
    assert.equal(explainOidcError(plain), 'plain failure', 'an ordinary Error still reports itself');
    assert.equal(explainOidcError(undefined), 'undefined', 'and a non-error does not crash the route');
  });
});
