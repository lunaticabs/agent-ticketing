# HumanGate

**Verifiable authorization middleware for AI agents.**

An agent can do the work. It cannot authorize it.

HumanGate sits between an agent's tool call and the operation it wants to perform.
The agent holds the credential and does the waiting, the polling and the buying.
Nothing commits until a real human — verified with World ID, present at that
moment — authorizes *that exact operation*. The authorization is bound to the
operation, re-verified on the server, and consumed exactly once.

> **The middleware is the product. The ticket queue is the demo.**
> This repository contains both, and the difference matters: everything under
> [`worldid/`](worldid/) and the authorization layer around it is reusable as-is;
> the event queue is one application scenario, included so you can watch the
> middleware authorize — and refuse — in under three minutes.

Built for the World **"Best Use of World ID for Agents"** track at ETHGlobal Tokyo 2026.

---

## The problem, in one line

An API key proves that someone handed out a credential once. It cannot prove that a
human is accountable for *this* action, *now*.

Agent frameworks are good at giving agents capability and bad at making anyone
answerable for it. Instructions in a prompt are suggestions. API keys are bearer
tokens: they can be copied, delegated and replayed. Neither answers the only
question that matters once an agent books, bids, buys or transfers — **who
authorized this, and were they actually there?**

## Two things in this repository

| | What it is | Where |
|---|---|---|
| **The middleware** | The product. Opens an authorization request bound to one operation, drives the human through World ID on their own device, re-verifies the proof on the server at execution time, and consumes it exactly once — inside your transaction. | [`worldid/`](worldid/), [`lib/approval.ts`](lib/approval.ts), [`lib/consume.ts`](lib/consume.ts), and the gate pattern in [`lib/gate.ts`](lib/gate.ts) |
| **The demo application** | An application scenario. An event with scarce slots, a queue, a countdown and an agent that buys on someone's behalf. It exists to make the middleware's behaviour observable, not to be a ticketing product. | `app/`, `mcp/`, `agent/`, `lib/queue.ts`, `lib/slots.ts` |

The ticket queue is the *smallest* scenario in which every claim is demonstrable:
scarcity creates a reason to cheat, a deadline creates a failure path, and a
purchase creates a decision that must be attributable to one human. Swap the
domain and the middleware does not change — see
[Wiring it to your own domain](#wiring-it-to-your-own-domain).

## What the middleware is

An authorization gate in front of any protected operation, with two transports and
no opinion about your domain.

| | |
|---|---|
| **One gate** | Every surface calls the same function. In the demo that function is `executeClaim()` in [`lib/gate.ts`](lib/gate.ts); the HTTP route and the MCP tool are thin adapters over it, so there is no second implementation to drift. |
| **Two transports** | HTTP for the human's browser, MCP for the agent. Same checks, same machine-readable codes. |
| **Protocol-isolated** | [`worldid/`](worldid/) is the only code in the repository that touches World. Nothing outside it names the issuer, calls an OIDC endpoint, or imports an OIDC library — `npm run security-check` fails the build if that changes. |

What it is **not**: a prompt guardrail, a policy engine, or a wallet. A check that
lives in a tool description is a suggestion; a check that lives behind a function
every transport must call is a gate.

## The loop

Four stages, each attributed to whoever actually performed it:

| # | Stage | Actor | What happens |
|---|---|---|---|
| 1 | `requested` | agent | The agent asks for the operation. The server opens a fresh World ID authentication bound to one `action` and one `signal`. |
| 2 | `completed` | **human** | The human approves on their own device. This is the only stage an agent cannot perform for itself. |
| 3 | `verified` | server | The server re-verifies the proof: binding, freshness against the current clock, one-time use. |
| 4 | `executed` | agent | The operation commits — inside the same transaction that consumes the proof. |

The demo drives this with a real MCP client, so a purchase reads: `agent` asked →
`human` answered on their phone → `agent` executed. The board reports the tally, so
the claim is legible rather than asserted.

## Why this is a gate and not a prompt

A model can put any string it likes in an `approval` field, so the server treats
that argument as a claim, not as evidence. Every one of these is refused, each with
its own code, and each followed by a database read-back proving nothing ran:

| What the model tries | Refusal |
|---|---|
| calls the protected tool with no approval | `approval_required` |
| invents an approval reference | `approval_not_found` |
| presents an approval it already used | `proof_replay_detected` |
| presents one bound to different parameters | `approval_action_mismatch` / `approval_signal_mismatch` |
| reports `{"ok": true}` as the verification result | `untrusted_client_result` |
| asks the server to use another World ID environment | `environment_pinned` |
| presents an authorization older than the request | `not_fresh` |

## The World protocol call

We use the **Human Continuity IdP** (`https://sandbox.auth.world.org`) over
**OpenID Connect** — authorization code + S256 PKCE — plus the RFC 8628 **device
authorization grant** it advertises, which is the headless-agent path. IDKit is
deliberately not used: the OIDC surface is what proves a human is *present now*.

The call site is [`beginAuthorization()`](worldid/oidc.ts). Every request asks for a
proof of *this transaction*, not of a session:

- `max_age=0` — a session established earlier cannot satisfy it;
- `acr_values=https://world.org/oidc/acr/orb-v3` — the implemented class;
- `action` and `signal` — bound to the exact operation;
- freshness is judged by `auth_time`, never `iat`.

**The finding that shaped the design.** The IdP is a plain OIDC provider and returns
**no action-scoped nullifier** — the thing that makes "one person, one action" fall
out of the protocol for free on the IDKit path. So the relying party reconstructs it:

```ts
nullifier = sha256("humangate/v1/nullifier" | issuer | sub | action | signal)
```

and consumes it exactly once through a database `PRIMARY KEY`, with
`UNIQUE (bound_action, continuity_id)` as a second constraint. Same observable
guarantee, on either protocol: one human, one entitlement per action — and a proof
minted for one operation cannot be moved to another.

## Wiring it to your own domain

```ts
const action = `transfer:${accountId}`;        // names the OPERATION, never "verify"
const signal = `${accountId}:${continuityId}`; // names its exact parameters

// 1. open the gate, bound to this operation
const req = await requestApproval({ kind, action, signal, continuityId, requestedVia: 'agent' });
// hand req.url (or req.deviceCode) to the human, then poll for the outcome

// 2. the server re-verifies the proof and re-derives the nullifier itself
const verified = await verifyApproval(req.approvalId, { action, signal });
if (!verified.ok) throw new Error(verified.code);

// 3. consume the proof and commit the operation, atomically
tx((db) => {
  consumeProof(db, { nullifier: verified.nullifier, boundAction: action, continuityId });
  doTheProtectedThing(db);
});
```

Three responsibilities, and the split is the whole design:

| Module | Owns | Domain-specific? |
|---|---|---|
| [`worldid/`](worldid/) | the protocol: OIDC, device grant, freshness, nullifier derivation, pinned environment | **no** |
| [`lib/consume.ts`](lib/consume.ts) | one-time use as a database constraint | **no** |
| [`lib/approval.ts`](lib/approval.ts) | the four stages, and re-verification on use | mostly — its table carries the demo's `event_id` / `slot_id` |
| [`lib/gate.ts`](lib/gate.ts) | the one function every transport must call | **yes** — this is the file you replace |

In the demo, step 1 is reached from `POST /api/slot/request` and step 3 runs inside
`executeClaim()`. The MCP surface is three tools — `queue.join` and `queue.status`
(ungated), `slot.claim` (gated) — defined in [`mcp/server.ts`](mcp/server.ts).
`slot.claim` deliberately does **not** list `approval` as required in its schema:
forbidding the call would hide the interesting failure, so the schema allows it and
the gate refuses it.

## The demo application: an event queue

**Not the product.** One scenario, chosen because it makes the middleware's failure
modes visible on a projector. Three things it demonstrates:

1. **Uniqueness is necessary, not sufficient.** One World ID per human kills "one
   script, 500 tickets" — but a faster client still wins a first-come-first-served
   queue. So arrival order decides nothing and the draw gives everyone inside the
   window equal odds. Flip to FCFS and the same 24-account bot army sweeps the
   slots, many standard deviations above its odds; flip back and it lands within
   noise of its fair share. The comparison is measured as a z-score against the
   hypergeometric null, not against a hand-picked threshold.
2. **Accounts collapse into humans.** Forty signups land on two continuity ids, and
   therefore on two places in line.
3. **The failure path is the product.** If nobody answers inside the window, the slot
   defers to the next candidate — and the human who missed it cannot buy afterwards,
   even holding a perfectly valid proof. An authorization that nobody used has to
   *cost* something, or the deadline is decoration.

## Run it

```bash
npm install
cp .env.example .env.local        # optional; the defaults work out of the box
npm run seed
ENABLE_DEV_ROUTES=1 npm run dev   # open the /board URL it prints
```

`npm run dev` chooses its own scheme and prints which one and why: plain HTTP until
an OIDC client is registered, HTTPS afterwards — because the World portal refuses an
`http://` callback. The certificate is self-signed, so the browser warns once.

| Command | What it does |
|---|---|
| `npm run dev` / `dev:http` / `dev:https` | the app, on the scheme this configuration needs — or one you force |
| `npm run agent` | the agent, as its own process |
| `npm run mcp` | the MCP server over stdio |
| `npm run bots` | the bot army (`-- --compare` for the FCFS/lottery side by side) |
| `npm run spike` | re-check every assumption against the live IdP |
| `npm run seed` / `npm run reset` | create / recreate the demo event |

## Verify it

```bash
npm test && npm run e2e && npm run mcp-check && npm run security-check
```

* **`npm test`** — 127 tests in 10 files: red-line invariants, URL consistency, the
  environment-rename precedence (`tests/env-rename.test.ts`), and user journeys that
  render the real pages, click the real buttons and read the real DOM. Nothing asserts
  on an internal variable, because what broke was never the
  logic — it was the journey.
* **`npm run e2e`** — the live run: setup, the demo beats, and **9 refusal cases**,
  each ending in a read-back that the protected action did not execute.
* **`npm run mcp-check`** — the same properties, driven through a real MCP client.
* **`npm run security-check`** — fails the build if any file outside `worldid/` names
  the issuer or calls an OIDC endpoint, or if any exported function accepts an
  `environment` argument.

## Disclosed bypass, and the fallback

**`ENABLE_DEV_ROUTES=1`** turns on `/api/dev/*`, which can create simulated humans
that bypass World ID entirely. It exists because "40 accounts, 2 humans" cannot be
built from real proofs on a stage — you cannot summon 40 verified people. It is off
by default (`/api/dev/*` returns 404), shares no code branch with the real
verification path, and both the startup banner and the board say so out loud.

**The fallback.** With no portal-issued client credentials the app runs a documented
local fallback which substitutes the *IdP*, never the gate — binding, freshness and
one-time consumption all still run — but it carries no World ID proof of humanness.
`GET /api/health` reports which mode is live in one line:

```json
{ "idp": { "mode": "oidc", "issuer": "https://sandbox.auth.world.org", "degraded": false } }
```

## Honest limitations

**About the middleware**

* **Verification is not consent.** Fresh authentication proves a human is there, not
  that they are willing. Someone paid or pressured to press approve defeats every
  defence in this repository.
* **It authorizes one operation, not a session.** That is the point — but it means an
  agent that needs to make fifty calls needs fifty authorizations, and any design that
  batches them re-opens the hole this closes.
* **A human must be reachable at that moment.** Device-code and consent flows fail
  closed: no answer, no action.

**About the demo scenario**

* **Hired humans beat this.** If the resale premium is large enough, paying people to
  attend is simply a cost of business. Technology changes who collects the premium,
  not whether it exists.
* **The friction lands on normal users too.** Handing a ticket to a friend costs a
  live moment. That is deliberate: a transferable ticket turns a scalper from a rusher
  into a market maker.
* **Continuity is stable for an existing World identity, not across re-enrolment.** A
  new World identity can resolve to a new IdP account, and World ID cannot distinguish
  a fan from a mercenary.

## Layout

```
worldid/        ── THE MIDDLEWARE ──────────────────────────────────────────
                the only door to World ID: OIDC, device grant, freshness,
                nullifier derivation, pinned environment
lib/            ── the authorization layer + the demo's domain ─────────────
  approval.ts     the four stages; binds an approval to (action, signal)
  consume.ts      one-time use, as a database constraint
  gate.ts       ← the gate the demo wires its domain to
  queue.ts        ── THE DEMO SCENARIO ──────────────────────────────────────
  slots.ts        the state machine: allocate → expire → DEFER
  attacks.ts      the three attack demonstrations
app/            Next.js pages + API routes (board, admin, fallback consent screen)
agent/          the standalone agent process (a real MCP client)
mcp/            the MCP surface
scripts/        spike, e2e, mcp-check, security-check, bot-army
db/             schema.sql, seed, reset
tests/          red-line invariants + user journeys (real clicks) + URL consistency
```

## Documentation

Everything else lives in [`docs/`](docs/) — this README is the only Markdown file at
the repository root. Start at [`docs/README.md`](docs/README.md) for a reading order.

| File | What it is |
|---|---|
| [`docs/RUN_DEMO.md`](docs/RUN_DEMO.md) | the runbook for the demo beats, with the narration |
| [`docs/DEMO_VIDEO_SCRIPT.md`](docs/DEMO_VIDEO_SCRIPT.md) | the script for the 2-minute demo video |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | deploying to a public URL: container, volume, OIDC registration |
| [`docs/SPIKE_NOTES.md`](docs/SPIKE_NOTES.md) | every assumption, checked against the live IdP, with evidence |
| [`docs/FAILURE_MATRIX.md`](docs/FAILURE_MATRIX.md) | the refusal scenarios and how each was verified |
| [`docs/INTEGRATION_DEBRIEF.md`](docs/INTEGRATION_DEBRIEF.md) | the track's required integration retrospective |
| [`docs/plans/`](docs/plans/) | *process record*: the original design and build plans (historical; the code wins) |
