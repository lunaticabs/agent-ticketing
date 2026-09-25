# Presence

**Your agent queues for you. The moment a slot is handed over, it asks a real
human to prove they are there. If nobody answers, the slot moves on.**

A queueing and slot-circulation system for events, built for the World
**"Best Use of World ID for Agents"** track at ETHGlobal Tokyo 2026.

> Not a ticket shop. There is no catalogue, no cart, and no payment integration.
> What this is: **a queue and an authorization gate.** Slots are locked to the
> human who won them.

---

## The 30-second version

```
人 not  →  🎟️
```

Two claims, each demonstrable on stage in under three minutes:

1. **Uniqueness is necessary but not sufficient.** One World ID per person kills
   "one script, 500 tickets" — but a single scalper with a faster client still
   wins a first-come-first-served queue. So arrival order decides nothing: the
   draw gives everyone inside the window equal odds. Flip the switch to FCFS and
   a 24-account bot army takes 100% of the slots; flip it back and the same army
   takes exactly its share of the entrant pool.

2. **The gate is on the server, not in a prompt.** `slot.claim` requires a human
   authorization, and the requirement is enforced behind the tool, not in its
   description. A model can call `slot.claim` with no approval, with a fabricated
   reference, with a reused one, or with one whose parameters have been changed.
   All four are refused, each with a different machine-readable reason.

**Slots are locked.** There is no transfer, no secondary circulation and no
policy knob, because a slot cannot move off the human who won it. That is the
strongest anti-scalping position available and it is the one this build takes;
what it costs is that giving a ticket to a friend is not possible at all.

---

## Quick start

```bash
npm install
cp .env.example .env.local          # optional; the defaults work out of the box
npm run seed
ENABLE_DEV_ROUTES=1 npm run dev     # dev routes power the demo props
```

Open the URL it prints — **http://localhost:3000/board** — and that is the demo.

**`npm run dev` chooses its own scheme, and it prints which one and why.** With
no OIDC client registered it serves plain HTTP, because identity is simulated
locally and TLS would only add a certificate warning. Register a client and it
switches to HTTPS on its own, because the sandbox portal refuses an `http://`
callback: its form says *"Use exact HTTPS callback URLs"* and rejects a loopback
`http://` URL with a generic *"Check the values and try again."*

```
  HTTPS — an https URL is already configured for this deployment
  url            https://localhost:3000
  redirect URI   https://localhost:3000/api/auth/world/callback
```

The certificate is self-signed, so the browser warns once — *Advanced →
Proceed*. Nothing in the OIDC flow needs it to be trusted. Override with
`npm run dev:http` or `npm run dev:https` when you want to be explicit.

> **One origin, or links break.** Every absolute URL the app builds — consent
> links, the OIDC `redirect_uri` — must share an origin. The
> redirect URI is authoritative: when `PRESENCE_PUBLIC_URL` is unset the origin
> is derived from it. If you set both and they disagree, startup says so, and
> `GET /api/health` reports it under `urls`. See SPIKE_NOTES.md S-0.

| Command | What it does |
|---|---|
| `npm run dev` | the app, over whichever scheme this configuration needs |
| `npm run dev:http` / `dev:https` | force the scheme |
| `npm run seed` / `npm run reset` | create / recreate the demo event |
| `npm run agent` | **the agent, as its own process** |
| `npm run mcp` | the MCP server (stdio) |
| `npm run bots` | the bot army (`-- --compare` for the FCFS/lottery side-by-side) |
| `npm run spike` | re-verify every assumption against the live sandbox IdP |
| `npm test` | 75 tests: red-line invariants, **user journeys driven through the DOM**, URL consistency |
| `npm run e2e` | 9 live HTTP checks: all six demo beats + the failure matrix |
| `npm run mcp-check` | 10 live MCP checks |
| `npm run security-check` | the T-7.2 self-check (run after `npm run build`) |

### Surfaces that exist but are not on screen

Two capabilities are deliberately API-only, so they stay reachable without
competing with the demo for attention:

| Endpoint | What it does | Why it is hidden |
|---|---|---|
| `POST /api/grants`, `GET /api/grants`, `DELETE /api/grants/{id}` | issue, list, revoke a scoped `vip:skip_queue` grant | roles are not the pitch. A VIP badge in the corner invites a question the demo does not need to answer |
| `POST /api/lottery` | settle the current draw on demand | the window closes itself; this is the manual primitive behind that |

Both are live and covered by the invariant tests. `/api/queue/status` still
reports `vip` and `grants` in its payload, because an API should tell the truth
whether or not a screen reads it.

```bash
# a VIP grant, start to finish, without touching the UI
curl -sX POST localhost:3000/api/grants -H 'content-type: application/json' \
  -d '{"scope":"vip:skip_queue","grantee":"cid_…","ttlSec":3600}'
```

`npm test` has three layers, and the third exists because the first two let three
bugs reach a human — all of them the same shape, two copies of one piece of state
with nothing asserting they agreed: **red-line invariants**, **URL-consistency
tests**, and **user journeys** that render the real pages, find real buttons,
click them and read the real DOM. Nothing there calls an internal function or
asserts on a variable, because what was broken was never the logic — it was the
*journey*.

Pre-flight before a demo:

```bash
npm test && npm run e2e && npm run mcp-check && npm run security-check
```

The live checks (`e2e`, `mcp-check`, `bots`) find the server themselves, over
http or https, and check their own preconditions before running. They complete
the consent screen programmatically, so they need the fallback IdP — with a real
client registered, start the server with `PRESENCE_IDP_MODE=local` to verify
against the fallback without unregistering anything. See RUN_DEMO.md.

---

## Where the World ID integration lives

**One directory. Nothing outside it may touch World ID.**

```
worldid/
├── index.ts        the only public surface
├── config.ts       ← the environment is pinned here, as a literal constant
├── oidc.ts         authorization code + S256 PKCE (openid-client)
├── device.ts       RFC 8628 device grant — the headless-agent path
├── local.ts        the disclosed fallback; substitutes the IdP, never the gate
├── nullifier.ts    RED LINE 1, reconstructed for an OIDC provider
└── requests.ts     in-flight interactions, in the database
```

Two guards enforce the boundary, and `npm run security-check` fails the build if
either is violated:

* no file outside `worldid/` may import `openid-client`, name the issuer host, or
  call an OIDC endpoint;
* no exported function accepts an `environment` argument — it is a constant, so a
  client cannot select an environment that accepts test proofs.

### The finding that shaped the design

The TODO assumed a World-ID-style verify endpoint that returns a nullifier.
**There isn't one.** The Human Continuity IdP is a plain OIDC provider: the ID
token carries `iss, sub, aud, exp, iat, jti, nonce, auth_time, acr, amr`, and
nothing resembling `nullifier`, `proof`, or `verification_level`.

That matters because the whole anti-scalping argument rests on

```
nullifier = human × rp_id × action
```

which is what makes "one person, one ticket" fall out of the protocol for free.
OIDC has no notion of your application's actions, so the relying party has to
reconstruct it:

```ts
nullifier = sha256("presence/v1/nullifier" | issuer | sub | action | signal)
```

plus `UNIQUE (bound_action, continuity_id)` in the database. Same observable
behaviour. The full reasoning is in `worldid/nullifier.ts`, `SPIKE_NOTES.md` (S-7)
and `INTEGRATION_DEBRIEF.md`.

---

## Is this running the real IdP or the fallback?

`GET /api/health` answers in one line, and the UI shows a permanent banner when
it matters.

```json
{ "idp": { "mode": "local", "degraded": true, "hasCredentials": false } }
```

**Registering an OIDC client requires a human with a Google account**
(`sandbox.auth.world.org/portal`), and the client secret is displayed exactly
once. So until those credentials exist, the app runs the documented local
fallback.

What the fallback does and does not do:

| | |
|---|---|
| ✅ | issues a server-signed, per-attempt assertion |
| ✅ | still enforces binding, freshness (`auth_time` vs `max_age=0`) and one-time consumption |
| ✅ | still consumes a nullifier through a database `PRIMARY KEY` |
| ❌ | **does not prove humanness.** There is no World ID proof behind it. |

To switch to the real IdP, set `WORLDID_CLIENT_ID` and `WORLDID_CLIENT_SECRET` in
`.env.local`, and run over HTTPS (`npm run dev:https`) so the registered callback
matches. **No code changes** — `idpMode()` picks it up and the banner disappears.

### ⚠️ Disclosed demo bypass

`ENABLE_DEV_ROUTES=1` turns on `/api/dev/*`, which can create simulated humans
that bypass World ID entirely. It exists because "40 accounts, 2 humans" cannot
be built from real proofs on a stage — you cannot summon 40 verified people.

* Off by default; when off, `/api/dev/*` returns **404**.
* Shares **no code branch** with the real verification path: simulated humans are
  written straight to the database and never touch `worldid/`.
* The startup banner and the board both say so out loud.
* `npm test` asserts the 404.

Hiding it would be the actual problem. Saying it is fine.

---

## The six demo beats

Drive them from **`/admin`**. Everything is a button.

| # | Beat | What it proves |
|---|---|---|
| 1 | FCFS beaten by a bot army → switch to the draw → the advantage vanishes | A queue that respects arrival order hands the event to whoever has the fastest client. Measured as a z-score against the hypergeometric null, not a hand-picked threshold. |
| 2 | Slot allocated → agent asks → human approves on their own device → confirmed | The track's "at the moment" requirement, with all four stages recorded. |
| 3 | Nobody approves → the window closes → **the slot defers** | The failure path *is* the product. The human who missed it cannot buy afterwards, even holding a perfectly valid proof. |
| 4 | 40 accounts join → collapse into 2 continuity ids → **2 places in line** | The centrepiece. Every extra signup lands on the entry that already exists, because the constraint is on the human, not the account. |
| 5 | Replay / retarget / environment swap | Each refused with its own code, each ending in a database read-back confirming nothing ran. |

---

## Layout

```
app/            Next.js pages + API routes
  board/        the projector board (1s poll)
  admin/        demo controls
  auth/local/   the fallback consent screen
lib/            all business logic
  gate.ts       ← THE gate. every surface calls this one function.
  queue.ts      join, the draw, arrival-order independence
  slots.ts      the state machine: allocate → expire → DEFER
  consume.ts    one-time use, as a database constraint
  approval.ts   the four observable stages
  attacks.ts    the three attack demonstrations
worldid/        the only door to World ID
agent/          the standalone agent process
mcp/            the MCP surface
scripts/        spike, e2e, mcp-check, security-check, bot-army
db/             schema.sql, seed, reset
tests/          red-line invariants + user journeys (real clicks) + URL consistency
```

---

## Design notes worth knowing before you read the code

**The state you read is the state as of now.** There is no background timer
anywhere. `sweep()` advances every expired deadline and is called at the top of
every read and every write. Nothing can drift out of sync with the clock, and
there is no cron to forget to start.

`sweep()` closes the draw window too — measured from the *first arrival*, so an
event seeded hours earlier does not expire before anyone shows up. This was
missing at first, and the omission was invisible in a particular way: the seed
advertised a 15-second window, the board counted it down, and the `queue_closed`
refusal explained that the window closes before the draw — while nothing acted on
the deadline. A participant joined, watched the countdown reach zero, and waited
forever. Only the `/admin` buttons ever settled a draw. `tests/invariants.test.ts`
now covers both halves: the window closes on its own, and an empty window stays
open so a late arrival can still enter.

**Deferral walks forward, never back.** A candidate whose window closed is marked
served (`queue_entry.allocated_at`) and is never a candidate again, so the draw
cannot loop on the same person. `EXPIRED` is deliberately *transient*: the slot
is recorded as expired and immediately returned to the pool, because the
allocation pass only ever looks at `AVAILABLE`.

**`total_slots` is a capacity, not a row count.** These can diverge — the demo
props legitimately build extra inventory — so allocation is budgeted against the
declared capacity. A test covers it; an earlier version got this wrong and made
the speed-contrast statistics meaningless.

**Locked is a real trade-off, not a missing feature.** A transferable ticket turns
a scalper from a rusher into a market maker: he never has to win the queue, he
just offers to buy from whoever did. Locking removes that entirely — the only
remaining attack is hiring people to queue, which is the most expensive one. It
also removes something real: you cannot give a ticket to a friend, and there is
no organiser knob to loosen that for a low-demand event.

**The board is not decoration.** Almost every claim here is about something *not*
happening, and an unobservable claim is indistinguishable from a bluff. So the
countdown, the deferrals and the refusals-with-reasons are all on screen.

---

## Honest limitations

* **Presence is not consent.** Fresh authentication proves a human is there, not
  that they are willing. Someone paid or pressured to press approve defeats every
  defence in this repository.
* **Hired humans beat this.** If the resale premium is large enough, paying people
  to attend is simply a cost of business. Technology changes who collects the
  premium, not whether it exists.
* **The friction lands on normal users too.** Giving a ticket to a friend costs a
  live moment. That is a deliberate trade-off, not a bug.
* **Continuity is stable for an existing World identity, not across
  re-enrolment.** The IdP's own guide notes that a new World identity can resolve
  to a new IdP account, and World ID cannot distinguish a fan from a mercenary.
* **The primary allocation stage is not linked to the purchase in this build** —
  see `INTEGRATION_DEBRIEF.md` for what that would take and why it was left out.

## Documentation

| File | What it is |
|---|---|
| [`SPIKE_NOTES.md`](SPIKE_NOTES.md) | every assumption, checked against the live sandbox, with evidence |
| [`FAILURE_MATRIX.md`](FAILURE_MATRIX.md) | 45 refusal scenarios and how each was verified |
| [`INTEGRATION_DEBRIEF.md`](INTEGRATION_DEBRIEF.md) | the track's required integration retrospective |
| [`RUN_DEMO.md`](RUN_DEMO.md) | the five-minute runbook for the six beats, with the narration |
| [`agent-ticketing-concept.md`](agent-ticketing-concept.md) | why the design is shaped this way |
| [`agent-ticketing-todo.md`](agent-ticketing-todo.md) | the build plan this implements |
