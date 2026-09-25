import { json, route, readJson } from '@/lib/api';
import { getDb, nowMs } from '@/lib/db';
import { randomToken } from '@/lib/ids';
import { linkAction, linkSignal } from '@/lib/gate';
import * as worldid from '@/worldid';
import { printStartupBanner } from '@/lib/startup';

/**
 * Start a World ID interaction for the *link* intent (T-0.4 / T-1.1).
 *
 * The client learns one of two things here:
 *   * `url`          — open it in a browser (authorization code, or the local fallback page)
 *   * `deviceCode`   — show the user code and wait (headless agents)
 *
 * It never learns anything about the environment, the client secret, or the
 * resulting token. Note also what is absent from the request body: there is no
 * `environment` field, and `guardClientSuppliedEnvironment` refuses one if sent.
 */
export const POST = route(async (req) => {
  printStartupBanner();
  const body = await readJson(req);

  const { guardClientSuppliedEnvironment } = await import('@/lib/api');
  guardClientSuppliedEnvironment(body);

  // A fresh nonce per attempt keeps link proofs from being interchangeable.
  const nonce = randomToken(12);
  const intent = body.intent === 'device' ? 'device' : 'browser';

  const started = await worldid.startFreshAuth({
    action: linkAction(),
    signal: linkSignal(nonce),
    intent: 'link',
    maxAgeSec: 0,
  });

  getDb()
    .prepare(`INSERT INTO audit_event (id, type, severity, payload, at) VALUES (?,?,?,?,?)`)
    .run(
      `aud_${randomToken(9)}`,
      'auth.link_started',
      'info',
      JSON.stringify({ requestId: started.requestId, mode: started.mode, intent, degraded: started.degraded }),
      nowMs(),
    );

  return json({
    ok: true,
    requestId: started.requestId,
    mode: started.mode,
    degraded: started.degraded,
    note: started.note,
    ...(started.url ? { url: started.url } : {}),
    ...(started.deviceCode ? { deviceCode: started.deviceCode } : {}),
    expiresAt: started.expiresAt,
    hint:
      started.mode === 'local'
        ? 'LOCAL FALLBACK: open the URL, pick a handle, and approve. No World ID proof is involved.'
        : 'Open the URL on the phone that has the World App.',
  });
});
