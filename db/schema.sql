-- ============================================================================
--  Presence — SQLite schema
-- ============================================================================
--  Design notes that must not be "optimised away":
--
--  * RED LINE 5 (one-time consumption) is enforced by a REAL `PRIMARY KEY` /
--    `UNIQUE` constraint on `consumed_proof.nullifier`. We never do
--    "SELECT ... then INSERT" — two concurrent requests would both pass that.
--    SQLite serialises writers, so the constraint is the actual gate.
--
--  * RED LINE 1 (action bound to purchase) shows up as the extra
--    `UNIQUE (bound_action, continuity_id)` on `consumed_proof`. See the
--    long comment above that constraint.
--
--  * RED LINE 9 (inbound cap counted per human, not per account) is the
--    `transfer_inbound` table, keyed on continuity_id.
--
--  * RED LINE 7 (TTL starts when the RECIPIENT OPENS) is why
--    `transfer.expires_at` is NULL until `opened_at` is set.
--
--  All timestamps are Unix milliseconds (INTEGER). JWT `auth_time` arrives in
--  seconds and is normalised to milliseconds on ingest.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ── Human ───────────────────────────────────────────────────────────────────
-- continuity_id is THE representation of "a person" in this system. It is
-- derived from the IdP's pairwise subject: `{issuer}#{sub}`. Everything that
-- must survive an account switch (audit, inbound caps, bans) keys on this and
-- never on an account id, an address, or an agent id.
CREATE TABLE IF NOT EXISTS human (
  continuity_id       TEXT PRIMARY KEY,
  issuer              TEXT NOT NULL,
  subject             TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  last_fresh_auth_at  INTEGER,
  -- Identity linking is explicit: the same (issuer, sub) must never create two rows.
  UNIQUE (issuer, subject)
);

-- ── Event ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  total_slots           INTEGER NOT NULL CHECK (total_slots > 0),
  -- Organiser-facing transfer policy knob (T-4.5).
  policy                TEXT NOT NULL DEFAULT 'gift'
                          CHECK (policy IN ('locked', 'gift', 'open')),
  approval_window_sec   INTEGER NOT NULL DEFAULT 120 CHECK (approval_window_sec > 0),
  lottery_window_sec    INTEGER NOT NULL DEFAULT 600 CHECK (lottery_window_sec >= 0),
  transfer_inbound_cap  INTEGER NOT NULL DEFAULT 2 CHECK (transfer_inbound_cap >= 0),
  -- How long the RECIPIENT has to complete fresh authentication, counted from
  -- the moment they open the link (RED LINE 7), not from the moment it is sent.
  transfer_window_sec   INTEGER NOT NULL DEFAULT 120 CHECK (transfer_window_sec > 0),
  -- T-6.3 speed-contrast switch: `lottery` gives everyone in the window equal
  -- odds; `fcfs` is first-come-first-served and is only there to be beaten by
  -- the bot army on stage.
  lottery_mode          TEXT NOT NULL DEFAULT 'lottery'
                          CHECK (lottery_mode IN ('lottery', 'fcfs')),
  -- Set once the draw has been settled; NULL means the window is still open.
  lottery_drawn_at      INTEGER,
  -- Seed used for the deterministic shuffle, kept so a draw can be replayed
  -- and audited. Proves the result does not depend on arrival order.
  lottery_seed          TEXT,
  created_at            INTEGER NOT NULL
);

-- ── Slot ────────────────────────────────────────────────────────────────────
-- State machine (must be implemented exactly — see todo §3.2):
--   AVAILABLE  → ALLOCATED        (drawn, approval_deadline written)
--   ALLOCATED  → CONFIRMED        (purchase approval verified + proof consumed)
--   ALLOCATED  → EXPIRED          (deadline passed) → defer to next candidate
--   CONFIRMED  → TRANSFER_PENDING (transfer opened by recipient, TTL started)
--   TRANSFER_PENDING → TRANSFERRED       (recipient's own fresh auth verified)
--   TRANSFER_PENDING → TRANSFER_EXPIRED  (TTL passed) → back to CONFIRMED
CREATE TABLE IF NOT EXISTS slot (
  id                    TEXT PRIMARY KEY,
  event_id              TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  state                 TEXT NOT NULL DEFAULT 'AVAILABLE'
                          CHECK (state IN ('AVAILABLE','ALLOCATED','CONFIRMED',
                                           'TRANSFER_PENDING','TRANSFERRED',
                                           'TRANSFER_EXPIRED','EXPIRED')),
  holder_continuity_id  TEXT REFERENCES human(continuity_id),
  acquired_via          TEXT CHECK (acquired_via IN ('lottery','transfer')),
  -- NULL for every state except ALLOCATED. "Every ALLOCATED slot has a
  -- deadline" is a testable invariant (T-2.2) so we assert it in SQL too.
  approval_deadline     INTEGER,
  deferral_count        INTEGER NOT NULL DEFAULT 0 CHECK (deferral_count >= 0),
  -- `gift` policy: a slot may be gifted at most once in its lifetime.
  gift_used             INTEGER NOT NULL DEFAULT 0 CHECK (gift_used IN (0,1)),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  CHECK (state <> 'ALLOCATED' OR approval_deadline IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_slot_event_state   ON slot (event_id, state);
CREATE INDEX IF NOT EXISTS idx_slot_deadline      ON slot (state, approval_deadline);
CREATE INDEX IF NOT EXISTS idx_slot_holder        ON slot (holder_continuity_id);

-- ── QueueEntry ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS queue_entry (
  id                TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  continuity_id     TEXT NOT NULL REFERENCES human(continuity_id),
  joined_at         INTEGER NOT NULL,
  -- `seq` is insertion order. It is used ONLY by the FCFS comparison mode and
  -- by nothing else. The lottery deliberately never reads it (RED LINE 10).
  seq               INTEGER NOT NULL,
  lottery_drawn_at  INTEGER,
  lottery_rank      INTEGER,
  -- Set the first time this entry is handed a slot. Once set, the entry is
  -- never a candidate again: RED LINE 1 means one person gets one shot per
  -- event, so failing to approve a slot forfeits it rather than re-queuing.
  -- This is what makes deferral walk *forward* through the ranks.
  allocated_at      INTEGER,
  -- The same human cannot occupy the queue twice (T-1.1 idempotency).
  UNIQUE (event_id, continuity_id)
);

CREATE INDEX IF NOT EXISTS idx_queue_event_seq  ON queue_entry (event_id, seq);
CREATE INDEX IF NOT EXISTS idx_queue_event_rank ON queue_entry (event_id, lottery_rank);

-- ── Approval ────────────────────────────────────────────────────────────────
-- State machine: PENDING → APPROVED → CONSUMED
--                PENDING → DENIED
--                PENDING → EXPIRED
CREATE TABLE IF NOT EXISTS approval (
  id                    TEXT PRIMARY KEY,
  kind                  TEXT NOT NULL CHECK (kind IN ('purchase','transfer')),
  -- e.g. 'buy_slot:evt_tokyo'  — RED LINE 1: bound to the OPERATION, never to
  -- a generic 'verify_user'.
  bound_action          TEXT NOT NULL,
  -- e.g. 'slot_7:human_abc'    — RED LINE 6: parameters are part of the proof.
  bound_signal          TEXT NOT NULL,
  continuity_id         TEXT NOT NULL REFERENCES human(continuity_id),
  event_id              TEXT REFERENCES event(id) ON DELETE CASCADE,
  slot_id               TEXT REFERENCES slot(id) ON DELETE CASCADE,
  nonce                 TEXT NOT NULL,
  request_id            TEXT NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'PENDING'
                          CHECK (state IN ('PENDING','APPROVED','CONSUMED','DENIED','EXPIRED')),
  proof_ref             TEXT,
  nullifier             TEXT,
  auth_time             INTEGER,
  fail_reason           TEXT,
  -- ── T-3.3 four-stage observability ──
  requested_at          INTEGER NOT NULL,  -- stage 1: request issued
  completed_at          INTEGER,           -- stage 2: human finished on device
  verified_at           INTEGER,           -- stage 3: server re-verified the proof
  executed_at           INTEGER,           -- stage 4: protected action executed
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  decided_at            INTEGER,
  consumed_at           INTEGER
);

CREATE INDEX IF NOT EXISTS idx_approval_state   ON approval (state, expires_at);
CREATE INDEX IF NOT EXISTS idx_approval_request ON approval (request_id);
CREATE INDEX IF NOT EXISTS idx_approval_human   ON approval (continuity_id);

-- ── ConsumedProof ───────────────────────────────────────────────────────────
-- ⚠️ This table is the reason the project uses a real database.
--
-- RED LINE 5 — one-time use, keyed on the proof's nullifier. The PRIMARY KEY
-- is the gate; an application-level "check then insert" would lose the race.
--
-- RED LINE 1 — `nullifier = human × rp_id × action` is what makes
-- "one person, one ticket" automatic *on the IDKit path*. The Human Continuity
-- IdP used here is a plain OIDC provider: it returns a pairwise `sub` and a
-- per-token `jti`, but it does NOT return an action-scoped nullifier. So the
-- action-scoped half of red line 1 is enforced by the RP with the second
-- constraint below:
--
--     UNIQUE (bound_action, continuity_id)
--
-- Same person + same action ⇒ at most one successful consumption, ever.
-- Different action (different event) ⇒ allowed. Different person ⇒ allowed.
-- That is exactly the observable behaviour T-1.2 asks for, and it is enforced
-- by the database rather than by a code path someone could "simplify".
CREATE TABLE IF NOT EXISTS consumed_proof (
  nullifier       TEXT PRIMARY KEY,
  bound_action    TEXT NOT NULL,
  continuity_id   TEXT NOT NULL REFERENCES human(continuity_id),
  slot_id         TEXT REFERENCES slot(id) ON DELETE SET NULL,
  proof_ref       TEXT,
  consumed_at     INTEGER NOT NULL,
  UNIQUE (bound_action, continuity_id)
);

CREATE INDEX IF NOT EXISTS idx_consumed_action ON consumed_proof (bound_action);

-- ── Transfer ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transfer (
  id                    TEXT PRIMARY KEY,
  slot_id               TEXT NOT NULL REFERENCES slot(id) ON DELETE CASCADE,
  event_id              TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  from_continuity_id    TEXT NOT NULL REFERENCES human(continuity_id),
  to_continuity_id      TEXT NOT NULL REFERENCES human(continuity_id),
  token                 TEXT NOT NULL UNIQUE,
  label                 TEXT,
  state                 TEXT NOT NULL DEFAULT 'CREATED'
                          CHECK (state IN ('CREATED','OPENED','COMPLETED','EXPIRED','CANCELLED')),
  created_at            INTEGER NOT NULL,
  -- ── RED LINE 7 ──
  -- The TTL starts when the RECIPIENT OPENS the link, not when the sender sent
  -- it. `expires_at` stays NULL until `opened_at` is set. Starting the clock on
  -- send would expire the offer before the recipient ever saw the message.
  opened_at             INTEGER,
  expires_at            INTEGER,
  completed_at          INTEGER,
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  last_reject_reason    TEXT
);

CREATE INDEX IF NOT EXISTS idx_transfer_slot  ON transfer (slot_id);
CREATE INDEX IF NOT EXISTS idx_transfer_state ON transfer (state, expires_at);

-- ── TransferInbound ─────────────────────────────────────────────────────────
-- RED LINE 9 — counted per continuity_id, per event. Swapping to a fresh
-- account, device, or agent does not reset this counter; that is the whole
-- point. The scalper's main laundering trick is "new account, same human".
CREATE TABLE IF NOT EXISTS transfer_inbound (
  continuity_id  TEXT NOT NULL REFERENCES human(continuity_id),
  event_id       TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  count          INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (continuity_id, event_id)
);

-- ── Grant (P2) ──────────────────────────────────────────────────────────────
-- Not a `user.role` column: a scoped, expiring, revocable authorization record.
CREATE TABLE IF NOT EXISTS grant_ (
  id                     TEXT PRIMARY KEY,
  event_id               TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  grantee_continuity_id  TEXT NOT NULL REFERENCES human(continuity_id),
  scope                  TEXT NOT NULL CHECK (scope IN ('mentor:+1','mentor:+3','mentor:+5','vip:skip_queue')),
  issued_at              INTEGER NOT NULL,
  expires_at             INTEGER,
  revoked_at             INTEGER,
  note                   TEXT
);

CREATE INDEX IF NOT EXISTS idx_grant_grantee ON grant_ (grantee_continuity_id, event_id);

-- ── AuditEvent ──────────────────────────────────────────────────────────────
-- Every row is filed under a continuity_id, so the trail follows the human.
CREATE TABLE IF NOT EXISTS audit_event (
  id             TEXT PRIMARY KEY,
  continuity_id  TEXT,
  event_id       TEXT,
  slot_id        TEXT,
  type           TEXT NOT NULL,
  severity       TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','alert')),
  payload        TEXT NOT NULL DEFAULT '{}',
  at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_at      ON audit_event (at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_human   ON audit_event (continuity_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_type    ON audit_event (type, at DESC);

-- ── AuthRequest ─────────────────────────────────────────────────────────────
-- One row per World ID interaction. Lives in the DB (not in memory) because the
-- agent process, the API routes, and the sweeper all need to see it.
CREATE TABLE IF NOT EXISTS auth_request (
  id                        TEXT PRIMARY KEY,
  mode                      TEXT NOT NULL CHECK (mode IN ('oidc','device','local')),
  intent                    TEXT NOT NULL CHECK (intent IN ('link','purchase','transfer')),
  action                    TEXT NOT NULL,
  signal                    TEXT NOT NULL,
  continuity_id             TEXT,
  state                     TEXT NOT NULL DEFAULT 'PENDING'
                              CHECK (state IN ('PENDING','APPROVED','DENIED','EXPIRED','FAILED')),
  code_verifier             TEXT,
  nonce                     TEXT,
  state_param               TEXT,
  device_code               TEXT,
  user_code                 TEXT,
  verification_uri          TEXT,
  verification_uri_complete TEXT,
  interval_sec              INTEGER,
  poll_after                INTEGER,
  -- Where the human should be sent. For `oidc` this is the authorize URL; for
  -- `device` it is the verification URI. Never contains a client secret.
  authorize_url             TEXT,
  created_at                INTEGER NOT NULL,
  expires_at                INTEGER NOT NULL,
  completed_at              INTEGER,
  auth_time                 INTEGER,
  acr                       TEXT,
  amr                       TEXT,
  nullifier                 TEXT,
  proof_ref                 TEXT,
  reject_reason             TEXT
);

CREATE INDEX IF NOT EXISTS idx_authreq_state ON auth_request (state, expires_at);

-- ── DevArmy (DEMO PROP — T-6.2) ─────────────────────────────────────────────
-- ⚠️ DELIBERATE BYPASS, DISCLOSED. "40 accounts, 2 humans" cannot be built from
-- real World ID proofs on a hackathon stage — you cannot summon 40 verified
-- people. So this table records simulated accounts, each standing in for a
-- separate signup that maps onto a shared continuity id.
--
-- Guardrails, all of them tested:
--   * every route touching this table is gated behind `ENABLE_DEV_ROUTES=1`
--     and returns 404 when the flag is unset;
--   * it shares NO code branch with the real verification path — simulated
--     humans are issued by `lib/devmode.ts`, never by `worldid/`;
--   * the board renders the collapse and the README discloses it.
CREATE TABLE IF NOT EXISTS dev_army (
  id             TEXT PRIMARY KEY,
  account_index  INTEGER NOT NULL,
  handle         TEXT NOT NULL UNIQUE,
  continuity_id  TEXT NOT NULL REFERENCES human(continuity_id),
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devarmy_human ON dev_army (continuity_id);
