/**
 * ============================================================================
 *  RED LINE 1 — why the nullifier is derived from the ACTION, not from "verify"
 * ============================================================================
 *
 * On the IDKit path the IdP hands you a nullifier directly, and its definition
 * is the whole trick:
 *
 *     nullifier = human × rp_id × action
 *
 * Bind `action` to `buy_slot:evt_tokyo` and the nullifier *becomes* the
 * one-time key "this person has not yet bought this event". Bind it to a
 * generic `verify_user` instead and the nullifier only means "this person is
 * verified", which anyone can reuse to buy the whole venue. The previous
 * ETHGlobal winner bound it to verification, and a single verified address
 * could buy out the event. That is the gap this project exists to close.
 *
 * ---------------------------------------------------------------------------
 *  What the Human Continuity IdP actually returns
 * ---------------------------------------------------------------------------
 * The sandbox IdP is a plain OIDC provider. Per its own `oidc` guide, the ID
 * token carries `iss, sub, aud, exp, iat, jti, auth_time, acr, amr` — and
 * explicitly "no email, name, or raw World proof". There is **no action-scoped
 * nullifier claim**, because OIDC has no notion of your application's actions.
 *
 * So the relying party must reconstruct the IDKit guarantee itself:
 *
 *     nullifier = H(domain | issuer | subject | action | signal)
 *
 * That reproduces `human × rp_id × action` one-for-one:
 *
 *   - same human, same action  ⇒ same nullifier ⇒ the `consumed_proof` PRIMARY
 *     KEY rejects the second attempt. `one person, one ticket` is automatic.
 *   - same human, other action ⇒ different nullifier ⇒ allowed (T-1.2).
 *   - other human              ⇒ different nullifier ⇒ allowed (T-1.2).
 *
 * `signal` is folded in as well, so a proof minted for slot A cannot be
 * replayed for slot B (RED LINE 6). `consumed_proof` carries a second,
 * belt-and-braces `UNIQUE (bound_action, continuity_id)` so the action-scoped
 * guarantee survives even if someone later changes how the hash is built.
 *
 * This difference between the IDKit contract and the OIDC contract is recorded
 * in SPIKE_NOTES.md (S-7) and INTEGRATION_DEBRIEF.md. It is the single most
 * important integration finding of the project.
 */

import { sha256Hex } from '../lib/ids';

/** Domain separator so this hash can never collide with another system's. */
const DOMAIN = 'presence/v1/nullifier';

/**
 * Stable per-service identifier for a human.
 *
 * The IdP returns a **pairwise** `sub` (sandbox discovery confirms
 * `subject_types_supported: ["pairwise"]`), so the subject already differs per
 * sector. We still namespace it with the issuer, because the current docs note
 * that "a new World identity can resolve to a new IdP account" and because the
 * pair is what we must store to recognise a returning human.
 */
export function continuityIdFrom(issuer: string, subject: string): string {
  return `cid_${sha256Hex(`${issuer}|${subject}`).slice(0, 32)}`;
}

/**
 * The one-time key for `(human, action, signal)`.
 *
 * Deterministic on purpose: the second attempt at the same operation must
 * produce the *same* key so the database can reject it. A random key would make
 * replay protection impossible.
 */
export function deriveNullifier(args: {
  issuer: string;
  subject: string;
  action: string;
  signal: string;
}): string {
  return `nul_${sha256Hex(
    [DOMAIN, args.issuer, args.subject, args.action, args.signal].join('|'),
  )}`;
}

/**
 * Freshness check against `auth_time`, **never** `iat`.
 *
 * The IdP guide is explicit: "Use `auth_time` for freshness, never `iat`." A
 * re-issued token keeps the original `auth_time` when a browser session is
 * reused, so `iat` would report a fresh login where none happened.
 *
 * @param authTimeMs authentication time in milliseconds
 * @param maxAgeSec  allowed age in seconds; `0` means "must be this attempt's own proof"
 */
export function isFresh(
  authTimeMs: number | null | undefined,
  maxAgeSec: number,
  nowMs: number = Date.now(),
): boolean {
  if (authTimeMs == null || !Number.isFinite(authTimeMs)) return false;
  const ageMs = nowMs - authTimeMs;
  // Reject implausibly future timestamps (the `step-up` guide asks for a small,
  // explicit clock tolerance) — a far-future `auth_time` is either a clock bug
  // or a forged token, and neither should read as "fresh".
  if (ageMs < -CLOCK_TOLERANCE_MS) return false;
  return ageMs <= maxAgeSec * 1000 + CLOCK_TOLERANCE_MS;
}

/** Small explicit skew allowance, per the `step-up` guide. */
export const CLOCK_TOLERANCE_MS = 5_000;
