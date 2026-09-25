# Demo runbook — five minutes, five beats

Everything below is a button on **`/admin`** except where noted. The board lives
at **`/board`** and should be on the projector before you start.

```bash
npm install && npm run seed
ENABLE_DEV_ROUTES=1 npm run dev
```

Open `/board` on the projector, `/admin` on the laptop.

---

## Pre-flight (30 seconds)

```bash
npm test && npm run e2e && npm run mcp-check
```

Green means the five beats are rehearsed. On `/admin`, press **Reset demo state**.

> **The live checks need the fallback idp.** `e2e` and `mcp-check` press Approve
> on your behalf, which is only possible when the identity provider is simulated.
> If you have registered a real OIDC client, the server runs in `oidc` mode and
> the scripts will say so rather than half-failing:
>
> ```
> ✖ the end-to-end rehearsal needs the local fallback idp, but
>   http://localhost:3000 is running in "oidc" mode
>   restart the server with:  PRESENCE_IDP_MODE=local ENABLE_DEV_ROUTES=1 npm run dev
> ```
>
> `PRESENCE_IDP_MODE=local` forces the fallback even with credentials present, so
> verifying the five beats never means unregistering anything. Run the real
> `oidc` path by hand, the way a judge would: sign in, get a slot, approve on the
> phone.

---

## The participant's loop (what you actually see)

```
/admin  → Reset demo state            # opens a fresh 15-second window
/       → Join the queue              # once
        → wait ~15s                   # nothing to press; the draw closes itself
        → a slot is allocated to you, with a live countdown
        → "Ask me to authorize" → approve on your phone
        → the handover completes on its own once you approve
```

The slot is then **locked to you**. There is nothing to press afterwards — no
transfer, no hand-off — by design.

If you press **Join the queue** and see `queue_closed`, the draw for this event
has already been settled — from a previous run, or by the bot army. Press
**Reset demo state** on `/admin` and the window reopens.

Real World ID sign-in works at every step; nothing about the participant loop
requires the fallback IdP. Only the automated checks do, because they press
Approve on your behalf.

## Opening line

> "Concert Kit proved bots can be kept out of the queue. But a ticket changes
> hands after that — and last year's winning ticketing project shipped tickets
> that were freely transferable, so one `transferFrom` walked past every check.
> We took the other route — the slot never leaves the human who won it. What is
> left to attack is the queue itself, and that is what these five beats are
> about."

## Beat 1 · Speed is purchasable (`/admin` → **Run the comparison**)

Press it. The same 24-account bot script runs twice.

* **FCFS**: the bots take **100%** of the slots, ~7σ above their odds.
* **Draw**: the same bots take their share of the entrant pool, ~0σ.

> "Uniqueness alone doesn't help. Every bot has its own identity; speed decided
> everything. So arrival order decides nothing. Same script, same accounts,
> advantage gone."

## Beat 2 · The human is asked, at the moment it matters

Terminal two:

```bash
npm run agent
```

The agent enrolls, joins, and waits. Press **Fast-forward windows** on `/admin`.

The agent prints an approval URL. Open it, press **Approve** (tick **simulate an
old session** once, before approving, to show the refusal first if you have
time — it comes back `not_fresh`).

The terminal then walks all four stages and confirms the slot.

> "The agent did the waiting. The human only had to be there for the ten seconds
> that mattered."

## Beat 3 · Nobody answers → the slot moves on

Press **Reset**, then **Prime: 6 attendees join**, then **Fast-forward**. Watch a
slot tile count down on the board.

Do nothing. Let it hit zero.

The board flashes **deferral**, the tile shows `deferred ×1`, and the slot is
already allocated to the next candidate.

> "That's not error handling — that's the product. A scalper's time now has to be
> spent inside a window that expires."

## Beat 4 · 40 accounts, 2 humans ⭐️

`/admin` → **Build 40 accounts → 2 humans**, then **Have all 40 join the queue**.

The board's queue grows by **two**. Thirty-eight of the forty attempts land on an
entry that already existed.

> "Forty signups, two humans, two places in line. The second account for the same
> person buys nothing — the constraint is on the human, not the account."

Be precise about this one on stage: it is not forty refusals. The server is
*idempotent* here on purpose, because a person refreshing the page must get their
own entry back rather than an error. So say "two entries created, thirty-eight
landed on one that already existed" — which is the honest and more interesting
version anyway.

## Beat 5 · Three attacks

`/admin` → **Run all three**.

| Attack | Refusal |
|---|---|
| Replay a spent approval | `already_owns_entitlement` **and** `proof_replay_detected` |
| Retarget / swap recipient / cross-action | `approval_signal_mismatch`, `approval_action_mismatch` |
| Claim a laxer environment | `environment_pinned` |

Each card ends with `protected action executed: false` and a database read-back.

> "Every one of these is refused by the server, and every refusal says which
> invariant it protected. That's the difference between a check in a prompt and
> a gate in the database."

## Closer

> "We don't claim to solve scalping. The premium exists; someone will do the
> work. Locking the slot removes every cheap way to do it and leaves only the
> expensive one — hiring real people to queue. What we will not pretend is that
> it is free: you cannot give a ticket to a friend either, and there is no knob
> to loosen that."

---

## If something goes wrong

| Symptom | Fix |
|---|---|
| Board shows "set the database up" | `npm run seed` |
| Everything 404s | server wasn't started with `ENABLE_DEV_ROUTES=1` |
| Yellow "LOCAL IDP FALLBACK" banner | expected — see README. The gate is real; identity is simulated. |
| Nothing works at all | **Fallback**: `npm run e2e` runs every beat headlessly and prints the evidence |
