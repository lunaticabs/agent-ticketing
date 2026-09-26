/**
 * ============================================================================
 *  One event per visitor — the public demo is many private demos, not one
 *  shared one.
 * ============================================================================
 *
 * The build was written for a stage: one seeded event, one draw window, one
 * board on a projector, and an operator standing at `/admin` to clear the state
 * between takes. Point that at the open internet and it breaks in a way that has
 * nothing to do with load:
 *
 *   · the draw closes once (`lib/queue.ts` — `lottery_drawn_at` is never
 *     un-set), and every later visitor gets `queue_closed` and nothing to do;
 *   · eight slots are shared by everybody, so the first visitor to arrive
 *     consumes the entire demo;
 *   · the board shows a stranger's handles and a stranger's slots.
 *
 * So a visitor does not join a shared event — they get their own. The schema was
 * already built for this: `slot`, `queue_entry`, `approval` and `grant_` all
 * carry `event_id ... ON DELETE CASCADE`, and `createEvent`/`ensureSlots` are
 * the same functions the seed uses. What was missing was only a way to decide
 * *which* event a request is about, and that is `lib/eventcontext.ts` plus the
 * middleware that fills it.
 *
 * ── What is deliberately NOT isolated ──────────────────────────────────────
 *
 * A visitor's *identity* is global. One World ID is one human across the whole
 * deployment, so the anti-sybil claim still holds inside a private event: you
 * cannot bring forty accounts and take forty slots, because `queue_entry` is
 * unique per (event, continuity id) and every one of those forty sessions is
 * still one continuity id per person. Privacy is per-event; uniqueness is not.
 *
 * ── Why the cookie is signed ───────────────────────────────────────────────
 *
 * The cookie names an event, and an event id is a capability to read that
 * board. Unsigned, "change the cookie, read someone else's board" would be a
 * one-line attack. It carries the same HMAC as a session cookie, under the same
 * server-only key (RED LINE 2), so an edited value is simply discarded and the
 * visitor gets a fresh event.
 */
import crypto from 'node:crypto';
import type { NextRequest } from 'next/server';
import { getDb, nowMs, tx } from './db';
import { audit } from './audit';
import { currentEventId } from './eventcontext';
import { newId } from './ids';
import { createEvent, getEvent, primaryEvent, seedEventTemplate, type EventRow } from './humans';
import { ensureSlots } from './slots';
import { ensureDemoEventIfMissing } from './demo';
import { serverSigningKey } from '../worldid/config';

/**
 * Off by default, on in the deployed demo (`ENABLE_SANDBOX=1`).
 *
 * Default-off is deliberate: it keeps `npm run dev`, the test suite and the
 * scripts behaving exactly as they did — one seeded event, `primaryEvent()` is
 * literally the seeded event — so turning this on cannot silently rewrite the
 * meaning of an existing test.
 */
export function sandboxEnabled(): boolean {
  return process.env.ENABLE_SANDBOX === '1';
}

export const SANDBOX_COOKIE = 'presence_sandbox';

/** Slots per visitor. Small on purpose: it mirrors the seeded demo exactly. */
const SANDBOX_SLOTS = 8;
const SANDBOX_LOTTERY_WINDOW_SEC = 15;
const SANDBOX_APPROVAL_WINDOW_SEC = 90;

/** How long a private event survives without being touched. */
const SANDBOX_TTL_MS = 12 * 60 * 60 * 1000;

/** Hard cap, so a crawler cannot fill the volume. Oldest are dropped first. */
const SANDBOX_MAX_EVENTS = 200;

/** Audit type that doubles as "last touched at" for a sandbox. */
const TOUCH_TYPE = 'sandbox.touched';

// ── The cookie ──────────────────────────────────────────────────────────────

function sign(eventId: string): string {
  return crypto.createHmac('sha256', serverSigningKey()).update(`sandbox:${eventId}`).digest('base64url');
}

function encodeCookie(eventId: string): string {
  return `${eventId}.${sign(eventId)}`;
}

/** The event id a signed cookie names, or null when it is absent or edited. */
export function readSandboxCookie(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const at = raw.lastIndexOf('.');
  if (at <= 0) return null;
  const eventId = raw.slice(0, at);
  const mac = raw.slice(at + 1);
  const expected = sign(eventId);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return eventId;
}

export function sandboxMaxAgeSec(): number {
  return Math.floor(SANDBOX_TTL_MS / 1000);
}

export function sandboxCookieFor(eventId: string, maxAgeSec = sandboxMaxAgeSec()): {
  name: string;
  value: string;
  maxAge: number;
} {
  return { name: SANDBOX_COOKIE, value: encodeCookie(eventId), maxAge: maxAgeSec };
}

// ── Creating and resolving ──────────────────────────────────────────────────

export interface SandboxHandle {
  event: EventRow;
  /** True when this call created the event, so the caller can set a cookie. */
  created: boolean;
}

/**
 * The visitor's event, created on first contact.
 *
 * `requested` is a cookie value that may be stale — an event deleted by the
 * sweeper, or a value from a database that has since been reset. In that case
 * the cookie is treated as absent rather than as an error: the visitor gets a
 * new private event, which is the same thing a first-time visitor gets.
 */
export function ensureSandbox(requested: string | null, continuityId?: string | null): SandboxHandle {
  if (requested) {
    const existing = getEvent(requested);
    if (existing && existing.sandbox === 1) {
      touch(requested);
      return { event: existing, created: false };
    }
  }

  const event = tx((db) => {
    // The template has to exist before it can be copied. On a container with a
    // fresh volume this is the first thing that happens, and it is the reason no
    // deploy step has to run `npm run seed` — which could not work anyway, since
    // a build and a release command both run without the volume mounted.
    //
    // Deliberately here and not at startup: it can only matter when sandboxing
    // is on, and this runs inside a transaction, so the first visitor's event is
    // built from a seeded template rather than from the fallback constants. It
    // only acts when nothing is seeded, so it cannot fight an operator who
    // cleared the database on purpose.
    ensureDemoEventIfMissing();

    const template = seedTemplate();
    const id = newId('evt');
    createEvent({
      id,
      name: 'Tokyo Night — your private demo',
      totalSlots: template?.total_slots ?? SANDBOX_SLOTS,
      approvalWindowSec: template?.approval_window_sec ?? SANDBOX_APPROVAL_WINDOW_SEC,
      lotteryWindowSec: template?.lottery_window_sec ?? SANDBOX_LOTTERY_WINDOW_SEC,
      lotteryMode: template?.lottery_mode ?? 'lottery',
    });
    db.prepare(`UPDATE event SET sandbox = 1 WHERE id = ?`).run(id);
    ensureSlots(id, template?.total_slots ?? SANDBOX_SLOTS);
    return getEvent(id)!;
  });

  audit({
    type: 'sandbox.created',
    eventId: event.id,
    continuityId: continuityId ?? null,
    payload: { slots: event.total_slots, lotteryWindowSec: event.lottery_window_sec },
  });
  touch(event.id);
  collectGarbage();

  return { event, created: true };
}

/**
 * The seeded event, used as the template so a visitor's demo has the windows the
 * runbook describes. Falls back to the constants above when nothing is seeded.
 */
function seedTemplate(): EventRow | null {
  return seedEventTemplate() ?? null;
}

/**
 * Record that a sandbox is still in use.
 *
 * Throttled to one row per minute per event. The demo's board polls once a
 * second, so an unthrottled heartbeat would write 3,600 audit rows per hour per
 * visitor — a write amplification that turns a quiet public site into a growing
 * database for no benefit, since the only question this data answers is "was
 * this event touched in the last twelve hours?". Held in memory rather than
 * read back from the table: one process serves this deployment (one machine, one
 * volume — see fly.toml), and a restart simply writes one extra row.
 */
const lastTouchAt = new Map<string, number>();
const TOUCH_INTERVAL_MS = 60 * 1000;

function touch(eventId: string, now = nowMs()): void {
  const previous = lastTouchAt.get(eventId);
  if (previous !== undefined && now - previous < TOUCH_INTERVAL_MS) return;
  lastTouchAt.set(eventId, now);
  audit({ type: TOUCH_TYPE, eventId, payload: {}, at: now });
}

/**
 * Drop sandboxes nobody has touched, and cap the total.
 *
 * Called when a sandbox is created rather than on a timer: a container that
 * restarts must not depend on a cron having run, and the only moment the table
 * can grow is right here. Both deletes rely on `ON DELETE CASCADE`, so slots,
 * queue entries, approvals and grants go with the event.
 */
export function collectGarbage(now = nowMs()): { deleted: number } {
  return tx((db) => {
    const stale = db
      .prepare(
        `SELECT e.id AS id FROM event e
          WHERE e.sandbox = 1
            AND COALESCE(
                  (SELECT MAX(a.at) FROM audit_event a
                    WHERE a.event_id = e.id AND a.type = ?),
                  e.created_at
                ) < ?`,
      )
      .all(TOUCH_TYPE, now - SANDBOX_TTL_MS) as { id: string }[];

    const excess = db
      .prepare(
        `SELECT id FROM event
          WHERE sandbox = 1
          ORDER BY created_at DESC
          LIMIT -1 OFFSET ?`,
      )
      .all(SANDBOX_MAX_EVENTS) as { id: string }[];

    const doomed = [...new Set([...stale, ...excess].map((r) => r.id))];
    if (!doomed.length) return { deleted: 0 };

    const drop = db.prepare(`DELETE FROM event WHERE id = ? AND sandbox = 1`);
    for (const id of doomed) drop.run(id);
    return { deleted: doomed.length };
  });
}

// ── Request-side resolution ─────────────────────────────────────────────────

/**
 * Which event should this request operate on?
 *
 * Order matters and is the same everywhere:
 *
 *   1. an explicit `eventId` from the caller — the scripts and the automated
 *      checks rely on it, and it is the only way to address a shared event;
 *   2. the event `lib/requestcontext.ts` already resolved for this request. This
 *      step is not optional bookkeeping: the wrapper puts the request's event in
 *      an `AsyncLocalStorage` store, and a route that re-derived it here from the
 *      cookie alone would *mint a second private event* whenever the caller
 *      named one in the URL. That is exactly the bug this line fixes — an
 *      `/api/dev/reset?eventId=…` that silently reset a brand-new empty event
 *      while reporting success;
 *   3. a visitor's private event, from their cookie;
 *   4. with sandboxing off, the single seeded event — the pre-sandbox behaviour.
 */
export function resolveEventId(req: NextRequest, explicit?: string | null): string {
  if (explicit) return explicit;
  if (!sandboxEnabled()) return primaryEvent().id;

  const scoped = currentEventId();
  if (scoped) return scoped;

  const handle = ensureSandbox(readSandboxCookie(req.cookies.get(SANDBOX_COOKIE)?.value));
  return handle.event.id;
}

/** The event this request is about, for callers that want the row. */
export function resolveEvent(req: NextRequest, explicit?: string | null): EventRow {
  const id = resolveEventId(req, explicit);
  const event = getEvent(id);
  if (!event) throw new Error(`no event ${id}`);
  return event;
}

/**
 * Reset a private demo back to "a fresh window, nothing drawn".
 *
 * The public site needs this and the stage did not: a visitor who has settled
 * their draw and spent their slots has nothing left to try, and the alternative
 * — telling them to wait twelve hours for the sweeper — makes the site look
 * broken. The seeded event is never touched by this path.
 *
 * ── Two tables this deliberately does NOT clear ─────────────────────────────
 *
 *   `consumed_proof`  has no `event_id` because a nullifier is a fact about a
 *                     human, not about an event: clearing it on a demo reset
 *                     would let the same World ID proof be spent twice, which
 *                     is the one thing RED LINE 9 exists to prevent. Its rows
 *                     are also what makes "the same proof cannot be replayed"
 *                     survive a reset — so they stay, and they are tiny.
 *   `auth_request`    likewise; its rows are per-attempt and expire on their
 *                     own. Wiping them globally (as an unscoped reset does)
 *                     would reach into other visitors' in-flight sign-ins.
 *
 * `sandbox.touched` audit rows stay too: they are the liveness heartbeat
 * `collectGarbage` reads, and deleting them would make a session that is still
 * being used look abandoned.
 */
export function recycleSandbox(eventId: string): { recycled: boolean } {
  const event = getEvent(eventId);
  if (!event || event.sandbox !== 1) return { recycled: false };

  tx((db) => {
    db.prepare(`DELETE FROM approval WHERE event_id = ?`).run(eventId);
    db.prepare(`DELETE FROM queue_entry WHERE event_id = ?`).run(eventId);
    db.prepare(`DELETE FROM grant_ WHERE event_id = ?`).run(eventId);
    db.prepare(`DELETE FROM dev_army WHERE handle LIKE ?`).run(`${eventId}:%`);
    db.prepare(`DELETE FROM audit_event WHERE event_id = ? AND type <> ?`).run(eventId, TOUCH_TYPE);
    db.prepare(`DELETE FROM slot WHERE event_id = ?`).run(eventId);
    db.prepare(`UPDATE event SET lottery_drawn_at = NULL, lottery_seed = NULL WHERE id = ?`).run(
      eventId,
    );
  });
  ensureSlots(eventId, event.total_slots);
  touch(eventId);
  return { recycled: true };
}

/** Diagnostics for `/api/health` and the startup banner. */
export function sandboxStats(): { enabled: boolean; events: number } {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM event WHERE sandbox = 1`).get() as { n: number };
  return { enabled: sandboxEnabled(), events: row.n };
}
