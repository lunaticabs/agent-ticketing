# Demo runbook — five minutes, six beats

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

Green means the six beats are rehearsed. On `/admin`, press **Reset demo state**.

---

## Opening line

> "Concert Kit proved bots can be kept out of the queue. But a ticket changes
> hands after that — and last year's winning ticketing project shipped tickets
> that were freely transferable, so one `transferFrom` walked past every check.
> We built the layer that is missing: what happens to a slot *after* it is won."

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

`/admin` → **Run the laundering simulation**.

Four transfers get through. Then every single fresh account is refused
`inbound_cap_reached`, in a scroll of red.

> "Forty accounts. It doesn't matter — the counter is keyed on the *human*. He
> can buy as many signups as he likes; he's still two people, and he's done."

Point at the inbound bars on the board: `2/2` for each of two continuity ids.

## Beat 5 · The friction is real — don't hide it

Console (`/`) → create a transfer link, **send it, then wait**. Open the link
after a minute or two.

The window has **not** started. Press Accept and it starts, right then.

Complete it as the recipient.

> "That's the fifteen seconds we're not cutting. To a friend it's a formality. To
> a scalper it's hourly labour he can't automate and can't scale."

## Beat 6 · Three attacks

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
> work. What we built is the layer that decides **who** does it and **what it
> costs them** — and unlike the entry gate, this one holds after the ticket
> changes hands."

---

## If something goes wrong

| Symptom | Fix |
|---|---|
| Board shows "set the database up" | `npm run seed` |
| Everything 404s | server wasn't started with `ENABLE_DEV_ROUTES=1` |
| Yellow "LOCAL IDP FALLBACK" banner | expected — see README. The gate is real; identity is simulated. |
| Nothing works at all | **Fallback**: `npm run e2e` runs all six beats headlessly and prints the evidence |
