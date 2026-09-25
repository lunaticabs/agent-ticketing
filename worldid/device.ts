/**
 * RFC 8628 device authorization grant — the headless-agent path.
 *
 * Spike result S-5: the sandbox **does** advertise
 * `device_authorization_endpoint` on the OIDC surface, so a headless agent can
 * authenticate for real instead of degrading to "print a link and hope".
 *
 * The `oidc` guide's step-up note applies and shapes the design here:
 *
 *   "Device grants always require fresh proof and explicit approval, but do not
 *    implement `prompt`, `max_age`, or `acr_values` request controls."
 *
 * In other words the device flow cannot be *asked* for freshness — it is fresh
 * by construction, because the human must prove and approve on their phone for
 * every single attempt. That still satisfies T-3.2; we simply do not send the
 * controls we know are ignored.
 *
 * ---------------------------------------------------------------------------
 *  Why the poll loop lives in the background
 * ---------------------------------------------------------------------------
 * The library's poll loop waits `interval` seconds *before* its first request
 * and then keeps going until the human answers. Blocking an HTTP request
 * handler on that would make `awaitAuthResult()` hang for up to 20 minutes.
 *
 * So the loop is detached: `startDevicePolling()` runs it once per attempt and
 * writes the outcome into `auth_request`. `awaitAuthResult()` is then a pure
 * database read, which also means the agent can restart and still pick up the
 * result it was waiting for.
 */
import * as oidc from 'openid-client';
import { WORLDID_SCOPE } from './config';
import { configuration, claimsFromIdToken } from './oidc';
import { getAuthRequest, markApproved, markFailed, storeDeviceChallenge } from './requests';
import type { AuthRequestRow } from './requests';

/** Device codes last 20 minutes per the guide. */
const DEVICE_CODE_TTL_MS = 20 * 60 * 1000;

/** Attempt ids whose poll loop is currently running in this process. */
const inFlight = new Set<string>();

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  intervalSec: number;
  expiresAt: number;
}

export async function initiate(rowId: string): Promise<DeviceStart> {
  const config = await configuration();
  const res = await oidc.initiateDeviceAuthorization(config, { scope: WORLDID_SCOPE });

  const start: DeviceStart = {
    deviceCode: res.device_code,
    userCode: res.user_code,
    verificationUri: res.verification_uri,
    verificationUriComplete: res.verification_uri_complete ?? res.verification_uri,
    intervalSec: res.interval ?? 5,
    expiresAt: Date.now() + (res.expires_in ? res.expires_in * 1000 : DEVICE_CODE_TTL_MS),
  };

  storeDeviceChallenge(rowId, start);
  return start;
}

/**
 * Run the upstream poll loop to completion, writing the outcome into the DB.
 * Safe to call repeatedly: only one loop per attempt id runs per process.
 */
export function startDevicePolling(rowId: string): void {
  if (inFlight.has(rowId)) return;
  inFlight.add(rowId);
  void loop(rowId).finally(() => inFlight.delete(rowId));
}

async function loop(rowId: string): Promise<void> {
  const row = getAuthRequest(rowId);
  if (!row || row.state !== 'PENDING' || !row.device_code) return;

  const remainingMs = row.expires_at - Date.now();
  if (remainingMs <= 0) {
    markFailed(rowId, 'EXPIRED', 'device code expired before approval');
    return;
  }

  const config = await configuration();
  // The library aborts on this signal; it is what bounds the whole attempt.
  const signal = AbortSignal.timeout(remainingMs);

  try {
    const tokens = await oidc.pollDeviceAuthorizationGrant(
      config,
      {
        device_code: row.device_code,
        user_code: row.user_code ?? '',
        verification_uri: row.verification_uri ?? '',
        verification_uri_complete: row.verification_uri_complete ?? undefined,
        expires_in: Math.floor(remainingMs / 1000),
        interval: row.interval_sec ?? 5,
      },
      { scope: WORLDID_SCOPE },
      { signal },
    );

    const claims = tokens.claims();
    if (!claims) throw new Error('device grant returned no ID token');

    const verified = claimsFromIdToken(tokens.id_token!, claims, row);
    markApproved(rowId, {
      authTime: verified.authTime,
      acr: verified.acr,
      amr: verified.amr,
      nullifier: verified.nullifier,
      proofRef: tokens.id_token!,
      continuityId: verified.continuityId,
    });
  } catch (err) {
    const current = getAuthRequest(rowId);
    if (!current || current.state !== 'PENDING') return;
    const message = describe(err);
    // An abort here is our own deadline, not a transport failure.
    const timedOut = signal.aborted || /abort/i.test(message);
    markFailed(
      rowId,
      timedOut ? 'EXPIRED' : 'FAILED',
      timedOut ? 'device authorization window closed without approval' : message,
    );
  }
}

function describe(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { error?: string; error_description?: string; message?: string };
    const parts = [e.error, e.error_description, e.message].filter(Boolean);
    if (parts.length) return parts.join(': ');
  }
  return String(err);
}

/**
 * When the next upstream poll is due. The `oidc` guide asks callers to respect
 * `interval` and to add five seconds after a `slow_down`; the library owns that
 * arithmetic, we only surface the schedule.
 */
export function nextPollAt(row: AuthRequestRow): number | null {
  return row.poll_after ?? null;
}
