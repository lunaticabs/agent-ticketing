*Historical planning document — the original build plan, written in Chinese before implementation and translated to English here for the record. Where it disagrees with the delivered code, the code and `../README.md` win.*

# Agent Ticketing System · Implementation Plan

> **Companion document**: read [`concept.md`](./concept.md) first (why it is built this way)
> **This document**: what to build, in what order, and how to accept it
> **Audience**: a coding agent
> **Time constraint**: ETHGlobal Tokyo 2026, roughly 48 hours. **Work in P0 → P1 → P2 order; do not touch P1 until P0 is all green.**

---

> **Scope reduction at implementation time (2026-09-25)**: this project ultimately ships
> **only the `locked` mode** — a slot is locked to the person who won the draw and cannot be
> transferred. The transfer engine (all of M4), the three-level policy knobs, the
> continuity-based allocation cap, and the transfer portions of demo beats 4/5 have all been
> removed, and the corresponding sections of this document were deleted along with them.
> The red lines that survive are 1–6 and 10; red lines 7/8/9 are voided together with
> transfers (all of them described the recipient's window and caps). This weakens the
> "holding and circulation layer" narrative, and in exchange buys the strongest possible
> anti-scalping stance: the slot never leaves the person who won it.

## 0. Read before you start

### 0.1 What this is

An event queue system: the user's agent queues on his behalf, and when a slot comes through it requires the human to do one **fresh verification**; if the human is not there, the slot **rolls over** to the next human-backed agent. The slot is locked to the person who won it and cannot be transferred.

**This is not a ticketing store.** No product browsing, no shopping cart, no payment gateway integration. The core is **queue + authorization + circulation**.

### 0.2 Tech stack (decided — do not re-select)

Take the path with the least friction. Every item exists to save one more pitfall in 48 hours.

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** | All of World's official examples (IDKit / HITL / AgentKit / MiniKit) are TS, so when something breaks you can copy from them directly |
| App | **Next.js 15 · App Router** | One process serves both the UI and the API routes; no separate frontend and backend to start |
| Styling | **Tailwind CSS** | The board UI comes together fast |
| Data | **SQLite + `better-sqlite3`** | Zero external dependencies, file-based, **synchronous API**; the `UNIQUE` constraint satisfies red line 5 for free; reset = delete the file and re-run seed |
| World ID | **`openid-client`** over the sandbox OIDC | sandbox's "World ID for Agents" is an OIDC shape (Human Continuity IdP); `openid-client` is the standard implementation in the Node ecosystem |
| Agent process | **A standalone Node script**, running TS directly with `tsx` | It must be a separate process (proof that the agent ≠ the website); it can be shown live in a terminal |
| Live board | **1-second polling** | More robust than SSE / WebSocket; venue wifi is not trustworthy |
| Public callback | **`cloudflared` or `ngrok`** | The OIDC redirect URI and phone access both need public HTTPS |

**Do not introduce**: Prisma (codegen eats time), Redis, Docker Compose, or any hosted database that requires an account signup.

> One SQLite file is enough to carry the demo. The only place that needs a "real database" is the concurrent uniqueness constraint, and SQLite already provides that.

### 0.3 Project layout

> **Adjustment at implementation time**: the plan was to create a `presence/` subdirectory,
> but in practice the project sits directly at the repository root, saving one level of
> nesting. The tree below has been updated to match the actual structure.

The project is the repository root. The documentation lives in `docs/`, with the two planning documents under `docs/plans/`, so the coding agent still sees all the context in one workspace.

```
./
├── README.md                    ← one-paragraph overview + how to run
├── docs/
│   ├── README.md                ← index: where to start reading
│   ├── RUN_DEMO.md              ← the six-beat demo runbook
│   ├── SPIKE_NOTES.md           ← Day 0 output
│   ├── FAILURE_MATRIX.md        ← T-7.1 output
│   ├── INTEGRATION_DEBRIEF.md   ← T-7.4 output (hard track requirement)
│   ├── DEPLOY.md
│   ├── DEMO_VIDEO_SCRIPT.md
│   └── plans/
│       ├── concept.md              ← why it is built this way
│       └── implementation-plan.md  ← this document
├── app/                         Next.js pages + API routes
├── lib/                         business logic (queue / lottery / rollover / gate / audit)
├── worldid/                     ⭐ World ID adapter layer, the only exit
├── agent/                       agent process (runs standalone)
├── mcp/                         MCP entry surface (T-3.4)
├── scripts/                     spike · e2e · mcp-check · security-check · bot-army
├── tests/                       invariant tests
└── db/                          schema.sql · seed · reset
```

### 0.4 Wire up the official agent tooling before you start ⭐️

World ships tooling for coding agents. **Wire it up as the very first step — it saves a large amount of "digging through docs" time.**

| Tool | How to use it | Value to us |
|---|---|---|
| **World Docs MCP** | see [the docs](https://docs.world.org/model-context-protocol/world-docs) | lets the coding agent search World docs directly instead of copy-pasting by hand |
| **Developer Portal MCP** | `https://developer.world.org/api/mcp`, `Authorization: Bearer api_...` (team API key, [how to create one](https://docs.world.org/model-context-protocol/developer-portal)) | the agent can `create_app` / `configure_world_id` / `create_world_id_action` on its own, **without clicking around the dashboard** |
| **sandbox's MCP** | `sandbox.auth.world.org/mcp` (the docs' own words: "let it guide you through the integration") | a wizard for sandbox integration |
| **`SKILL.md`** | `https://world.id/SKILL.md` | see the scope caveat below |

#### ⚠️ On the applicable scope of `SKILL.md`

`SKILL.md` is a well-written official Agent Skill (8 Phases + checklist + gotchas table), **but it targets the IDKit / World ID 4.0 production path, not the sandbox Human Continuity IdP.**

- ✅ **Reusable**: its discipline and its traps (do not re-encode the proof JSON, never ship the signing key to the client, the nullifier must have a `UNIQUE` constraint, environments must match end to end, do not use the old `^2.x/^3.x` examples)
- ❌ **Not directly applicable**: the code path. We go through OIDC, not the IDKit widget

> 📝 **Write this discrepancy into `../INTEGRATION_DEBRIEF.md`**: the IDKit path has a complete `SKILL.md`, while the sandbox path has an MCP but no corresponding skill. That is exactly the kind of concrete feedback this track is asking for.

#### The three things the official stack gives a "runtime agent" (know they exist, do not count on them being turnkey)

| Thing | Direction | Use to us |
|---|---|---|
| `@worldcoin/agentkit` + AgentBook | **server-side detection of whether a human backs an agent** (not the agent calling World) | reference its **per-human counting** design (multiple agents of the same human share one counter) — exactly the shape our continuity allocation cap wants |
| `@worldcoin/human-in-the-loop` | in-framework, relies on the prompt to remind the model to call `approveAction` | **a cautionary example**: this is precisely the weakness of "enforcement at the prompt layer" (see the concept document) |
| **the sandbox IdP as an OAuth authorization server for MCP** | MCP clients authenticate users through World ID (RFC 6750/7009/8414/**8628**/**9728**) | ⭐️ **the native approach for our MCP entry surface** — no need to build an authorization layer ourselves |

**Conclusion**: the official stack has nothing turnkey for "expose your own protected actions to arbitrary MCP clients" (only you know what your actions are). But the sandbox IdP can serve directly as MCP's authorization server, which makes T-3.4 less work than expected.

### 0.5 Full inventory of official developer tooling: what **not to build yourself** ⭐️

> **Purpose of this section: keep the TODO from reinventing wheels.**
> Every version in the table below was checked against the npm registry (2026-09-25).

#### A. Runtime SDKs (measured versions)

| Package | Version | Purpose | Do we use it |
|---|---|---|---|
| `@worldcoin/idkit` | 4.3.0 | React widget | only if we also enter the IDKit track |
| `@worldcoin/idkit-core` | 4.3.0 | vanilla JS core (request / session / invite-code) | same as above |
| **`@worldcoin/idkit-server`** | 1.1.1 | **server-side RP signing** | ⚠️ **the moment you take the IDKit path, use it; do not implement signing yourself** |
| `@worldcoin/agentkit` / `-core` | 0.2.1 | x402 + AgentBook (per-human counting) | read it as a **reference implementation**, do not add the dependency |
| `@worldcoin/agentkit-cli` | 0.2.0 | agent registration / status queries | optional |
| `@worldcoin/human-in-the-loop` / `-react` | 0.2.1 / 0.1.1 | the agent waits mid-run for human approval | ❌ **deliberately unused**, see B① |
| `@worldcoin/toolrouter` | 0.1.3 | MCP adapter for ToolRouter | ❌ irrelevant, see B③ |
| `@worldcoin/provekit` | 0.1.1 | Noir proof browser SDK | ❌ belongs to another track |
| `@worldcoin/minikit-js` / `-react` | 2.0.3 | Mini App runtime | ❌ we are not building a Mini App |
| `@worldcoin/create-mini-app` | 0.4.1 | Mini App scaffold | ❌ not applicable |
| `@worldcoin/nucleus` | 0.2.11 | design tokens | ❌ irrelevant |

#### B. Three things that look like time-savers but are not

**① `@worldcoin/human-in-the-loop` — deliberately unused**

It provides `requestHumanAuthorization` and `<HumanApproval>`, which looks like exactly what we need. **But it enforces at the prompt layer**: it constrains the model through system instructions that say *"Before performing any sensitive action, call approveAction first"*.

Our entire argument, however, is that **the gate lives on the server** (see concept document §4.2). Using it would be swapping out the project's single most important design decision.

> ⚠️ **Explicit instruction for the coding agent**: do **not** replace our approval flow with `@worldcoin/human-in-the-loop`. You may read its source as a reference, but **the enforcement point must be on the server**.

**② `@worldcoin/agentkit`'s per-human counting — copy the design, do not add the dependency**

The official wording:

> "Usage counters are tracked **per human** per endpoint. **Two agents backed by the same human share the same counter.**"

That is exactly the shape our continuity allocation cap wants. But it exists for **x402 billing** and does not generalise to our slot model — **copy the design idea, do not add the dependency**.

**③ `@worldcoin/toolrouter` — not a framework**

It is an **MCP adapter for the ToolRouter service** (exposing toolrouter.world's search / email / browser-use and other endpoints to MCP clients), **not a framework for "exposing your actions to MCP clients"**. It does not help with T-3.4.

It is, however, a ready-made reference in the World ecosystem for how an MCP server is packaged: a `npx`-launched stdio adapter + API keys issued to World ID–verified accounts.

#### C. Do-not-reinvent-the-wheel cross-reference ⭐️

| TODO task | Does the official stack already provide it | Verdict |
|---|---|---|
| T-0.1 scaffold | `create-mini-app` (Mini App only) | build Next.js yourself; **not reinventing anything** |
| T-0.2 data layer / nullifier `UNIQUE` | ❌ no official storage; SKILL.md states outright that the in-memory Set in the examples is only illustrative | ✅ **our job** |
| T-0.3 `worldid/` adapter layer | the IdP has **no official SDK** (standard OIDC); the IDKit path has `idkit-server` for RP signing | ⚠️ only wrap OIDC; **do not write RP signing yourself** |
| T-1.1 enqueue uniqueness | the proof is provided by the IdP / IDKit | ✅ the business logic is ours |
| T-1.2 binding `action` to the purchase | the primitive provides it (`nullifier = human × rp_id × action`) | ✅ **just define the action correctly, zero extra code** |
| T-1.3 server-side verification | the verify endpoint | ✅ just call it |
| T-2.x queue / lottery / rollover | ❌ **completely absent** | ✅ **our core increment** |
| T-3.1 agent loop | ❌ not provided | ✅ our job |
| T-3.2 fresh verification | the IdP's fresh auth (RFC 9470) provides the **mechanism** | ⚠️ the mechanism is official, the **policy** (how fresh counts as fresh, which actions require it) is ours |
| T-3.3 end-to-end observability | ❌ not provided | ✅ our job |
| T-3.4 MCP entry surface | ❌ **no framework**; but the IdP can serve as MCP's OAuth AS (RFC 9728) | ⚠️ **use the official MCP TS SDK + the IdP as authorization server**; do not write the protocol layer yourself |
| T-2.x queue / lottery / rollover | ❌ **completely absent** | ✅ **our core increment** |
| approval consumption storage | `signal` binding + one-time nullifier = the primitive | ✅ **consumption storage must be written by us** — in the official HITL example `consumeApproval` is a `declare function` (a declaration only, no implementation) |
| T-5.x grant issuance | provided by the IdP ("issues credentials for its APIs or MCP server") | ⚠️ use the official mechanism |
| T-6.x demo props | ❌ not provided | ✅ our job |
| T-7.1 failure path matrix | SKILL.md's Phase 6 has a test checklist you can copy directly | ⚠️ **copy the checklist, save time** |

**One-line conclusion**:

> The official stack provides **primitives and protocols**, not a **product**.
> Queue, lottery, rollover, audit trail, demo props — **none of these has any official substitute; they are all our increment**;
> whereas RP signing, the MCP protocol layer, the OIDC flow — **all of them already exist; never write them yourself.**

### 0.6 Red lines (violate one and the whole project is meaningless)

> There were ten; seven are in force (1–6, 10).

| # | Red line | Reason |
|---|---|---|
| 1 | **`action` must be bound to the "purchase / transfer" operation, not to "verification"** | `nullifier = human × rp_id × action`. Bind it wrong and one person can buy out the whole venue (this is the pit a previous winning project fell into) |
| 2 | **the signing key stays server-side only**, the frontend only ever receives `rp_context` | leaking it means being impersonated |
| 3 | **never trust a verification result returned by the client**, the server must call verify itself | hard track requirement #4 |
| 4 | **the environment is pinned by the server**, no client-supplied parameter is accepted | otherwise a proof can select sandbox and bypass |
| 5 | **each approval can be consumed only once**, keyed on the nullifier | replay protection |
| 6 | **an approval must be bound to `(action, signal)`**, a parameter mismatch is rejected | prevents changing the amount / the payee |
| ~~7~~ | ~~the TTL of the rollover/receipt window starts when the recipient opens it~~ | **voided with transfers** |
| ~~8~~ | ~~a transfer must be completed by the recipient in person with a fresh verification~~ | **voided with transfers** |
| ~~9~~ | ~~the allocation cap is counted per continuity identifier~~ | **voided with transfers** — but the per-human counting principle survives in queue uniqueness (a second account on the same continuity cannot buy a second position) |
| 10 | **the lottery must be independent of arrival order** | otherwise speed arbitrage eats the uniqueness |

#### Red lines 1 / 4 / 5 / 6 have official code backing ⭐️

These four are not our speculation. The sample code in the official human-in-the-loop docs confirms the same design word for word:

```ts
// ── Red line 1: action must be bound to the "specific operation" ──
action: ({ input }) => `booking:${input.flightNumber}`,
// Comment verbatim:
// "Nullifiers repeat per person and action, so each person can book
//  a flight number once; add a unique booking ID to the action to allow more."

// ── Red line 4: the environment must be pinned by the server ──
body: JSON.stringify({ ...approval, environment: 'production' }),
// Comment verbatim:
// "The approval is untrusted input: pin the environment so it can't
//  select 'staging' or 'sandbox', which accept test proofs."

// ── Red line 5: one-time consumption, keyed on the nullifier ──
if (!(await consumeApproval(`${expectedAction}:${nullifier}`))) {
  throw new Error('approval already used')
}
// Comment verbatim:
// "One-time use, keyed on the proof's nullifier. Parse it as the verifier
//  does, so '0x01' and '0x1' share a key."

// ── Red line 6: reject on any parameter mismatch ──
if (approval.action !== expectedAction) {
  throw new Error(`approval does not match this booking`)
}
```

And the most important warning in the official docs:

> "A required `approval` input is **not proof of authorization** — tool inputs are **LLM-generated**."
> "**Never trust that approveAction ran just because this tool was called**: check the binding, re-verify the proof, and consume it once."

> 📌 **For the coding agent**: when you implement red lines 1/4/5/6, copy the comments above into your code. **That way whoever comes later knows these are officially backed hard constraints, not details that can be "optimised" away.**

### 0.7 Glossary

| Term | Meaning |
|---|---|
| **continuity identifier** | the stable private identifier of the same person within this service (OIDC pairwise `sub`). **The only representation of a "human" in the system** |
| **fresh verification (fresh auth)** | requires re-authenticating right now, signalled by `auth_time`. **It is not a face scan and does not require meeting in person** |
| **slot** | one ticket / one admission |
| **rollover** | once a slot's approval window expires, it is handed to the next candidate automatically. **This is a product feature, not error handling** |
| **approval** | one credential of human authorization for a specific operation |
| ⚠️ **"sandbox" has two meanings** | see the warning at the start of §2 — **this is the single easiest thing to get wrong** |

---

## 1. Definition of Done

### 1.1 The track's 5 hard requirements → verifiable behaviour

| # | Track requirement | Behaviour that must be demonstrable |
|---|---|---|
| 1 | integrate the official sandbox World ID for Agents | the whole flow runs in the sandbox environment, not production |
| 2 | complete closed loop | request initiated → user completes → server verifies → protected action executes (all four stages have log/UI evidence) |
| 3 | **demonstrate failure paths** | on denial / expiry / cancellation, the protected action **genuinely did not happen** |
| 4 | backend security verification | see §6 security invariants; each one needs a corresponding test |
| 5 | integration debrief | produce `../INTEGRATION_DEBRIEF.md` (see T-7.4) |

### 1.2 All five demo beats must pass

- [ ] Beat 1: the FCFS queue is crushed by a script → switch to lottery → the speed advantage drops to zero
- [ ] Beat 2: a slot comes through → the agent is stuck → phone approval → done deal
- [ ] Beat 3: the human does not approve → the countdown hits zero → **the slot rolls over**
- [ ] Beat 4: **40 accounts join the queue → they collapse into 2 continuity identifiers → only 2 queue positions**
- [ ] Beat 5: replay / tampered parameters / swapped environment → three rejections in a row

---

## 2. Day 0: front-loaded verification (do this first, do not write business code first)

### ⚠️ First disambiguate: "sandbox" in the World docs means two **completely different** things

This is the single easiest thing to get wrong, and a coding agent is very likely to charge head-first into the wrong one.

| | **① IDKit's sandbox environment** | **② `sandbox.auth.world.org` (the one we want)** |
|---|---|---|
| What it is | one `environment` value for IDKit, a proof destination for testing | **Human Continuity IdP** — an OIDC identity provider |
| Where it is documented | `docs.world.org/world-id/sandbox/*` | `sandbox.auth.world.org/docs` |
| How to use it | `environment: "sandbox"`, proofs still go to the **production** verify endpoint | register an **OIDC client** in the portal and use the authorization code flow |
| What it provides | simulated verification, sparing you a real device / real credential | **continuity (pairwise `sub`) + fresh auth + grant issuance** |
| Do we want it | ❌ **not this one** | ✅ **this one** |

> The **track requirement's own wording** is "integrate the World ID for Agents dev environment provided by the event", and the link points at `sandbox.auth.world.org` — **that is ②**.
> ① is for integration-testing the IDKit path; **it has no continuity, no fresh auth and no MCP OAuth surface**.

**We have not yet confirmed every aspect of the sandbox's shape. Every item below must be verified first; if it does not verify, take the fallback.**

Output: `../SPIKE_NOTES.md`, recording "conclusion / evidence / fallback taken" for each item.

| ID | To confirm | How to verify | Fallback if it fails |
|---|---|---|---|
| S-0 | **a public HTTPS callback URL** | start `cloudflared tunnel --url http://localhost:3000` (or ngrok), get a stable domain, confirm a phone can open it | switch to another tunnel tool; **this item blocks S-2/S-3, so solve it first** |
| S-1 | **IdP access** (②, not ①) | open [sandbox.auth.world.org](https://sandbox.auth.world.org/), get it working and read [the docs](https://sandbox.auth.world.org/docs); install the sandbox World ID mobile app to complete verification | find a World mentor on site immediately (there is a workshop today at 17:30, 5F) |
| S-2 | OIDC client registration | register a client in the [sandbox portal](https://sandbox.auth.world.org/portal); obtain issuer / client_id / **set the redirect URI to the S-0 domain** | use the public sample client from the docs |
| S-3 | the discovery endpoint | fetch `/.well-known/openid-configuration`; record the issuer, authorization/token endpoints, supported `grant_types`, `acr`/`amr` capabilities | — |
| S-4 | **how to trigger fresh verification** | find out which of `max_age` / `acr_values` / `prompt=login` actually takes effect; verify that `auth_time` appears in the ID token | if none are supported: fall back to "run the full authorization code flow every time", and **record explicitly that this is a fallback** (it still satisfies "present right now") |
| S-5 | **whether the device authorization grant is available** | check `device_authorization_endpoint` in discovery. In the docs RFC 8628 hangs off the MCP OAuth surface, **do not assume the OIDC surface has it too** | the headless agent degrades to "print an authorization link + poll", with the GUI popup as the primary path |
| S-6 | pairwise `sub` / sector | confirm whether `sub` is pairwise, how the sector is configured, and whether a stable identifier can be obtained | if unstable: hash the issuer+sub combination yourself and flag the risk in the docs |
| S-7 | **the exact shape of the verification endpoint** | confirm the exact URL, method, request body and **environment field name** for server-side verification | implement against the verify API shape in `docs.world.org` and keep an adapter layer in reserve |
| S-8 | whether credentials can be issued for our own API / MCP server | verify against the sandbox docs | the grant feature is demoted to P2 (see §5 M5) |
| S-9 | revocation capability | confirm the token revocation endpoint | grant expiry can only rely on a local TTL |
| S-10 | **whether the Developer Portal MCP covers the sandbox** | `developer.world.org/api/mcp` manages Developer Portal resources; the sandbox is a separate environment (`sandbox.auth.world.org/portal`). Try `get_team_context` and see whether the sandbox client shows up | if unsupported, register the sandbox client by hand in the portal (S-2 goes manual); **write this into the debrief** |
| S-11 | **whether the MCP OAuth surface can be reused directly** | fetch `/.well-known/oauth-protected-resource` per RFC 9728, and confirm whether our MCP server can treat the sandbox IdP as its authorization server | if not, degrade to "self-signed token + local verification", with grants demoted to P2 |

> ⚠️ **Do not wait for every S item to be confirmed before you start writing code.** S-0~S-3 and S-7 are blocking — do them first; S-4~S-6 and S-8~S-9 can be confirmed in parallel.
> **Funnel every World ID call into one module, `worldid/`** (see T-0.3), so that when an S conclusion changes you only touch that layer.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────┐
│  Client (Web / Mini App)                         │
│  User: queue up, check status, approve/deny      │
│  Agent panel: queue, monitor, request auth       │
└──────────────────┬───────────────────────────────┘
                   │ HTTP
┌──────────────────▼───────────────────────────────┐
│  Core service                                    │
│  ├─ Queue engine    enqueue / draw / roll over   │
│  ├─ Purchase gate   action = buy, nullifier      │
│  ├─ Approval gate   fresh auth / window / TTL    │
│  ├─ Grant engine    mentor / VIP scope (P2)      │
│  └─ Audit log       keyed by continuity id       │
└──────────────────┬───────────────────────────────┘
                   │
       ┌───────────┴───────────┐
       │                       │
┌──────▼─────────┐   ┌─────────▼──────────┐
│ worldid/       │   │ agent/             │
│ (single exit)  │   │ queue loop / watch │
│ OIDC + fresh   │   │ fetch human / wait │
└────────────────┘   └────────────────────┘
```

### 3.1 Data model

```ts
Human {
  continuity_id      // primary key. A stable mapping of issuer + sub
  created_at
  last_fresh_auth_at // used by the freshness policy
}

Event {
  id
  name
  total_slots
  approval_window_sec     // slot approval window, default 120
  lottery_window_sec      // lottery window, default 600
}

Slot {
  id
  event_id
  state                   // see §3.2
  holder_continuity_id
  acquired_via            // 'lottery' | 'transfer'
  approval_deadline
}

QueueEntry {
  id
  event_id
  continuity_id
  joined_at
  lottery_drawn_at
  lottery_rank            // only present after winning the draw
}

Approval {
  id
  kind                    // 'purchase' | 'transfer'
  bound_action            // of the form 'buy_slot:event_1'
  bound_signal            // of the form '{slot_id}:{recipient_continuity_id}'
  continuity_id
  nonce
  created_at
  expires_at
  state                   // PENDING → APPROVED → CONSUMED
                          //       ↘ DENIED / EXPIRED
  proof_ref
}

ConsumedProof {
  nullifier               // unique key
  bound_action
  consumed_at
}

Grant {                    // P2
  id
  event_id
  grantee_continuity_id
  scope                   // 'mentor:+3' | 'vip:skip_queue'
  issued_at
  expires_at
  revoked_at
}

AuditEvent {
  id
  continuity_id           // all records are grouped by "human", not by account
  type
  payload
  at
}
```

### 3.2 State machine (must be implemented strictly)

```
Slot:
  AVAILABLE
    → ALLOCATED           (won the draw, write approval_deadline)
    → EXPIRED             (deadline passed) ──→ back to AVAILABLE and roll over to the next candidate
  ALLOCATED
    → CONFIRMED           (purchase approval verified + nullifier consumed)
  CONFIRMED               (terminal: the slot is locked to the winner and no longer circulates)

Approval:
  PENDING → APPROVED → CONSUMED     (cannot be used again after consumption)
  PENDING → DENIED
  PENDING → EXPIRED
  APPROVED replayed → rejected (see §6 invariant 5)
```

---

## 4. Task list

> Priorities: **P0 = no demo without it** · **P1 = differentiation, the judges want to see it** · **P2 = stretch, only with time to spare**

### M0 · Skeleton and adapter layer

#### T-0.1 `[P0]` Project init
**What to do**:
```bash
npx create-next-app@latest presence --typescript --tailwind --app --no-src-dir
cd presence && npm i better-sqlite3 openid-client && npm i -D @types/better-sqlite3 tsx
```
Copy the two .md files into the project root, and add `package.json` scripts: `dev` / `agent` (`tsx agent/runner.ts`) / `seed` (`tsx db/seed.ts`) / `reset` (delete the db + seed).

**Also wire up the official tooling** (see §0.4): World Docs MCP + Developer Portal MCP + sandbox MCP. These three take less than 20 minutes but save hours of digging through docs later.
**Acceptance**:
- [ ] `npm run dev` starts the service with one command
- [ ] `/health` returns 200
- [ ] `npm run seed` and `npm run reset` work
- [ ] the README has start-up instructions in 3 lines or fewer

#### T-0.2 `[P0]` Local data layer
**What to do**: implement the §3.1 data model with `better-sqlite3`, keep the schema in `db/schema.sql`, and use one `lib/db.ts` for connection and query wrappers.
**Careful**: do not use in-memory storage — replay protection and one-time consumption **must rest on real unique constraints**.
**Acceptance**:
- [ ] `ConsumedProof.nullifier` carries a `UNIQUE` constraint (not an application-level "check first, then insert")
- [ ] foreign keys and state fields have constraints (`CHECK` or enum validation)
- [ ] the expiry times of `Slot` and `Grant` are queryable
- [ ] `npm run seed` can create one event + N slots

#### T-0.3 `[P0]` The `worldid/` adapter layer (**the single most important module**)
**What to do**: funnel every World ID call in here (`openid-client` + the sandbox verify endpoint). Business code above this layer is **not allowed** to call OIDC or the verify API directly.

**Dependency boundaries (already checked, see §0.5)**:
- **The Human Continuity IdP has no official client SDK** — the official wording is "integrate via OIDC", so you wrap standard OIDC yourself. **This is not reinventing the wheel; there simply was no wheel.**
- **But if you take the IDKit path for RP signing, use `@worldcoin/idkit-server` (1.1.1); do not implement** the Keccak-256 + EIP-191 + secp256k1 stack yourself.
- **Do not add `@worldcoin/human-in-the-loop`** (see §0.5 B①) — it enforces at the prompt layer and conflicts with this project's core design.
Exposed surface (suggested interface, naming adjustable):
```ts
startFreshAuth({ action, signal, continuityId? }) → { url | deviceCode, requestId }
awaitAuthResult(requestId)                        → { ok, continuityId, nullifier, authTime, proofRef }
verifyOnServer(proofRef, { action, signal })      → { ok, continuityId, nullifier } | { ok:false, reason }
isFresh(authTime, maxAgeSec)                      → boolean
```
**Acceptance**:
- [ ] no direct OIDC / verify endpoint call can be found in the layers above
- [ ] **the environment is hard-coded and pinned inside this module**, and no function signature takes an environment parameter
- [ ] the signing key is read only from server-side environment variables (`.env.local`), **and has been added to `.gitignore`**
- [ ] when the S-4 / S-5 / S-7 conclusions change, only this module changes

#### T-0.4 `[P0]` One minimal end-to-end path
**What to do**: **first get "verify one real human and obtain a stable continuity identifier" working**, with no business logic at all.
**Acceptance**:
- [ ] complete one verification with the sandbox app
- [ ] the server obtains the continuity identifier and persists it
- [ ] the same person verifies a second time → **gets the same identifier** (not a new one)
- [ ] a different person → gets a different identifier

> 🚩 **Do not start M1 until T-0.4 is all green.** This is the foundation of the entire project.

---

### M1 · Uniqueness and the purchase gate ⭐️

#### T-1.1 `[P0]` Enqueue: human uniqueness
**What to do**: `POST /queue/join`, requiring a persistent proof (are you human), and persist a `QueueEntry`.
**Acceptance**:
- [ ] an unverified user cannot enqueue
- [ ] the same person enqueueing repeatedly → idempotent (returns the existing entry, creates nothing new)

#### T-1.2 `[P0]` **Purchase gate: `action` bound to the purchase** ⭐️
**What to do**: this is red line 1. Define the action as `buy_slot:{event_id}`, **not** `verify_user`. At purchase time require a proof for that action; the server verifies it and consumes the nullifier.
**Why**: `nullifier = human × rp_id × action`. With the action bound to the purchase, the nullifier naturally becomes a one-time key for "this person bought this event" → **one person, one ticket holds automatically**.
**Acceptance**:
- [ ] the same person submits a **second** purchase proof for the same event → **fails** (nullifier already consumed)
- [ ] the same person against **another** event → succeeds (different action)
- [ ] two different people against the same event → both succeed
- [ ] **counter-example test**: after changing the action to a generic `verify_user`, one person can buy multiple tickets → proving why it must be bound to the purchase (write this into the test comment)

> This is the single most critical design point in the whole project. **Once implemented, state the reason in a code comment** so that later readers cannot "optimise" it away.

#### T-1.3 `[P0]` Server-side verification
**What to do**: every proof must be verified server-side; the client can only say "I finished", it cannot deliver a verdict.
**Acceptance**:
- [ ] forge a client response of `{ok: true}` → the server rejects it
- [ ] when verification fails, the protected action does not happen

---

### M2 · Queue, lottery and rollover

#### T-2.1 `[P0]` Lottery (not first-come-first-served) ⭐️
**What to do**: everyone who enqueues within `lottery_window_sec` has **an equal chance**. Once the window closes, draw the ordering in one shot. A `lottery_mode` switch allows flipping to FCFS in the demo as a control.
**Acceptance**:
- [ ] someone enqueueing in second 1 and someone enqueueing in second 599 have the same win probability (run 1000 trials; the difference is within noise)
- [ ] the draw result is independent of `joined_at` (set every `joined_at` to the same timestamp; the result distribution is unchanged)
- [ ] it is possible to switch to FCFS mode and observe "the early bird takes everything"

#### T-2.2 `[P0]` Slot allocation and approval window
**What to do**: allocate slots in draw order and write `approval_deadline = now + approval_window_sec`.
**Acceptance**:
- [ ] the number of slots never exceeds `total_slots`
- [ ] every `ALLOCATED` slot has a deadline

#### T-2.3 `[P0]` Rollover (the failure path is the product) ⭐️
**What to do**: deadline expires → the slot goes `EXPIRED` → it is handed to the next candidate automatically, and the rollover count is retained.
**Acceptance**:
- [ ] no approval → when the window closes the slot moves to the next person automatically
- [ ] after a rollover, **the original candidate can no longer buy that slot** (even carrying a valid proof)
- [ ] rollover events are written to `AuditEvent`
- [ ] after 3 consecutive rollovers the slot can still be sold normally

---

### M3 · Agent in the loop and fresh verification

#### T-3.1 `[P0]` Agent queue loop
**What to do**: `agent/runner.ts`, started independently with `npm run agent` (**not part of the website**). The loop: enqueue → poll slot state → on winning, initiate an authorization request → wait → continue if approved, exit if denied/timed out. It must print a **readable state transition** to the terminal, because this segment is shown live.
**Acceptance**:
- [ ] `npm run agent` runs standalone, and fails gracefully with a hint when `npm run dev` is not up
- [ ] the agent can complete "enqueue → wait → win" unattended (no verification is involved at this stage)
- [ ] when a slot lands, the agent initiates the authorization request on its own and prints the link/code to the terminal
- [ ] after denial/timeout the agent **does not execute** the protected action and emits a structured reason (it does not crash by throwing)
- [ ] the terminal output is legible on a projector (this is the demo's second visual focus)

#### T-3.2 `[P0]` Fresh verification ⭐️
**What to do**: require a **fresh** verification when a slot lands (`auth_time` inside the window), via the mechanism confirmed in S-4.
**Acceptance**:
- [ ] using a session from "a long time ago" → re-authentication is demanded
- [ ] after re-authentication → it passes
- [ ] `auth_time` is verified by the server, not self-reported by the client
- [ ] **no camera required** (if a face scan shows up in the implementation, you took the wrong path — see insight three in the concept document)

#### T-3.3 `[P0]` The four stages of the closed loop are observable
**What to do**: provide evidence for track requirement #2: request initiated / user completed / server verified / action executed — each of the four stages has its own log and UI state.
**Acceptance**:
- [ ] the four states can be seen advancing in order in the UI
- [ ] the server log can string the four stages together by requestId

#### T-3.4 `[P1]` MCP entry surface — let **any** MCP client take part in the queue

> **Priority note**: P1. **Do not touch this until P0 is all green.** It changes no business logic; it only adds an entry surface.

**What to do**: expose the queue system as an MCP server, so agents are no longer confined to our own `runner.ts`.

Three tools exposed (**thin wrappers that call the existing functions in `lib/` directly; do not copy business logic**):

| Tool | Description | Needs an approval |
|---|---|---|
| `queue.join` | join the queue | no |
| `queue.status` | query slot state | no |
| `slot.claim` | claim a slot | ✅ **must carry a server-verifiable approval** |

**Key design (this is where the transport layer enforces things)**:

`slot.claim` **must** carry an `approval` parameter, and the server **independently re-verifies** it — binding `(action, signal)`, one-time consumption of the nullifier, environment pinned by the server. The model is entirely free to call it without an approval; **the only possible outcome is failure**.

> In the official wording: *"A required `approval` input is **not proof of authorization** — tool inputs are **LLM-generated**."*
> Therefore: **never let a call through just because the parameter is present — you must verify it yourself.**

**Do not write the protocol layer yourself**:
- use the official MCP TypeScript SDK (`@modelcontextprotocol/sdk`); do not hand-roll JSON-RPC
- for the authorization layer, **prefer reusing the sandbox IdP as the OAuth authorization server** (RFC 9728 protected resource metadata lets clients discover it automatically), depending on the S-11 verification result
- for packaging, follow [`@worldcoin/toolrouter`](https://www.npmjs.com/package/@worldcoin/toolrouter): a `npx`-launched stdio adapter

**Acceptance**:
- [ ] an MCP client can list the three tools
- [ ] `queue.join` / `queue.status` work without an approval
- [ ] **calling `slot.claim` without an approval → fails** (this is the core demo point)
- [ ] calling `slot.claim` with an approval that has **already been consumed** → fails
- [ ] carrying an approval **bound to another slot** → fails
- [ ] the MCP path and the HTTP path go through the **same verification function** (search the code to confirm there is no second implementation)
- [ ] `runner.ts` still works (a deterministic fallback — **do not depend on LLM behaviour on stage**)

**If time runs short**: cut the OAuth authorization layer and use a short-lived server-issued token; **but not one item of `slot.claim`'s approval verification may be skipped.**

---

### M4 · (voided)

The original M4, "three lines of defence for transfers", was removed together with the transfer engine. Slots are locked to the person who won them; there is no T-4.1–T-4.5.
Demo beat 4 now shows the collapse of continuity **at the queue layer**: 40 accounts can only
produce as many queue positions as there are "humans".

### M5 · Delegated authorization (P2) — **implemented, but only the API is kept**

> **Decision at implementation time**: roles/permissions are not this project's competitive point
> (the main competitive point is "an agent legitimately buying on someone's behalf"),
> so the **entire VIP / grant UI has been removed** — the console no longer shows VIP badges, and the admin panel no longer
> has an issuance entry point. `/api/grants` and the `Grant` table remain usable, and `/api/queue/status` still returns
> the `vip` / `grants` fields. The acceptance criteria of T-5.1 below should be read as "the API layer".

#### T-5.1 `[P2]` Grant issuance
**What to do**: `mentor` = may bring N people in; `vip` = queue priority / bypass. **Not a database role field**, but an authorization record carrying a scope.
**Acceptance**:
- [ ] a grant takes effect once issued
- [ ] a grant lapses automatically after expiry
- [ ] it lapses immediately after revocation

#### T-5.2 `[P2]` Issue credentials for our own API / MCP server
**What to do**: depends on S-8. If the sandbox does not support it, **degrade to a locally signed token + a note in the docs**.
**Acceptance**:
- [ ] protected endpoints reject requests without a credential
- [ ] credentials carry a scope and an expiry

---

### M6 · Demo props

#### T-6.1 `[P0]` Live queue board ⭐️
**What to do**: a board visible to the naked eye. **This is the demo's core prop, not decoration.**
Implementation: `app/board/page.tsx`, polling `GET /api/board/state` once a second, returning a flat JSON snapshot. **Big type, high contrast**, for projection.
Must be visible: queue length, current winner, approval countdown, **a rollover happening**, **a denial happening**.
**Acceptance**:
- [ ] the countdown is visible and live (error < 1 second)
- [ ] on rollover the board changes noticeably (colour / animation / text)
- [ ] on denial the board changes noticeably and shows the denial reason
- [ ] readable from 3 metres away once projected onto an external screen
- [ ] **demo configuration**: seed presets `lottery_window_sec=15`, `approval_window_sec=90`, otherwise there is no way to perform a 10-minute wait live

#### T-6.2 `[P0]` Bot army simulator (needed for beats 1 and 4) ⭐️
**What to do**: able to produce the scenario "40 accounts, but only 2 continuity identifiers".

**Key implementation point (do not leave this to the end)**: you need a **dev-only impersonation mechanism** — insert a `Human` with a specified `continuity_id` straight into the DB, bypassing real OIDC, and issue a local session:

```
POST /api/dev/impersonate  { continuityId } → set-cookie session
```

Without this mechanism, "40 accounts" simply cannot be demonstrated (you cannot find 40 real people to verify). **So it is infrastructure that must be provisioned as early as M1, not an end-of-project feature.**

**Security requirements**: the whole `/api/dev/*` surface is controlled by `ENABLE_DEV_ROUTES=1`, off by default; when enabled it prints a prominent warning in the startup log. **It must never share a code branch with the real verification path**, so that impersonation cannot be mistaken for real verification during the demo.
**Acceptance**:
- [ ] one click generates 40 "accounts" mapped onto 2 continuity identifiers
- [ ] the board shows them **collapsing into 2 continuity identifiers**
- [ ] a third transfer-in is rejected, with the rejection reason visible
- [ ] one-click reset of the demo state
- [ ] when `ENABLE_DEV_ROUTES` is unset, `/api/dev/*` returns 404

#### T-6.3 `[P0]` Speed comparison mode (needed for beat 1)
**What to do**: an `Event.lottery_mode` switch: one-click toggle between `lottery` ↔ `fcfs`. Plus `scripts/bot-army.ts` — a "ticket-grabbing bot" that hammers `POST /queue/join` concurrently. Add a **"fast-forward" button** to the board that closes the current lottery/approval window immediately (you cannot really wait on stage).
**Acceptance**:
- [ ] in FCFS mode `bot-army` grabs every slot within 1 second → human users get none
- [ ] in lottery mode the same script → win rate **statistically indistinguishable** from human users
- [ ] the "fast-forward" button can settle the lottery immediately / trigger a rollover immediately
- [ ] switching modes does not affect existing data

#### T-6.4 `[P0]` Three-hit attack demo (beat 6)
**What to do**: turn the three invariants of §6 into a visual demo: replay / tampered parameters / swapped environment.
**Acceptance**:
- [ ] three buttons, each triggering one attack, each showing a clear rejection reason
- [ ] after a failed attack, confirm the protected action **did not happen** (check the database / on-chain state)

---

### M7 · Wrap-up

#### T-7.1 `[P0]` Failure path matrix all green
**What to do**: run through and record each one: denial / expiry / cancellation / unverified / credential unavailable / not eligible.
**Acceptance**:
- [ ] every case returns a **structured reason that the model / frontend can read**
- [ ] in every case the protected action does not happen
- [ ] write the results into `../FAILURE_MATRIX.md`

#### T-7.2 `[P0]` Security self-check
**Acceptance**:
- [ ] grepping the frontend bundle finds no signing key / client secret
- [ ] every verify happens server-side
- [ ] `ConsumedProof` has a DB unique constraint
- [ ] the environment is pinned server-side
- [ ] the concurrent replay test passes

#### T-7.3 `[P0]` Demo script rehearsal
**Acceptance**:
- [ ] six beats run back to back, total duration ≤ 3 minutes
- [ ] a network drop / retry does not crash the demo
- [ ] a "one-click reset → one-click full run" fallback path is prepared

#### T-7.4 `[P0]` `../INTEGRATION_DEBRIEF.md` (hard track requirement #5)
**Must contain**:
- [ ] time to first success (from reading the docs to the first proof passing; record the actual number of hours)
- [ ] the concrete friction encountered (the more specific the better, with the original error text)
- [ ] missing capabilities or documentation
- [ ] **the single improvement suggestion with the greatest impact** (the judges will read this one carefully)

> Writing requirements: write it to bug-report spec (reproduction steps / expected / actual / blast radius).
> **Do not write "the docs are clear and the experience was good".** This document is free bonus points, and most teams will phone it in.

---

## 5. Explicitly out of scope

| Not doing | Reason |
|---|---|
| product browsing / shopping cart / payment gateway | not where this project's value lies |
| attendance check-in | `present` is already spent on "fresh verification at the moment of purchase"; adding check-in would repeat the narrative |
| an authorization admin backend | an enum grant + a single scope check is enough |
| i18n / dark mode / responsive polish | the demo does not need them |
| building our own identity system | we are only a consumer of World ID |
| face scan / liveness | the OIDC path **needs no camera**; adding one would actually show you took the wrong path |

---

## 6. Security invariants (each one needs a test)

| # | Invariant | Test |
|---|---|---|
| 1 | `action` is bound to the purchase/transfer | a second purchase by the same human is rejected |
| 2 | the signing key is server-side only | grep the frontend bundle |
| 3 | server-side verification, no trust in the client | forge a successful client response → rejected |
| 4 | the environment is pinned server-side | client passes an environment → ignored / rejected |
| 5 | the nullifier is one-time | concurrent double-click → only one succeeds |
| 6 | an approval is bound to `(action, signal)` | change a parameter → rejected |
| 10 | the lottery is independent of order | distribution statistics test |

### One exception that must be proactively disclosed

T-6.2's `/api/dev/impersonate` is a **deliberately opened bypass**, used to simulate "40 accounts" (you cannot find 40 real people to verify).

How to handle it:

- [ ] controlled by `ENABLE_DEV_ROUTES=1`, off by default; when off, `/api/dev/*` returns 404
- [ ] **does not share a code branch** with the real verification path
- [ ] state explicitly in `../README.md` and `../INTEGRATION_DEBRIEF.md` that this is a demo simulation — proactive disclosure beats being asked about it by a judge

> Simulating multiple users in a demo is industry practice; **saying so plainly is fine** — hiding it is the problem.

---

## 7. Known risks and fallbacks

| Risk | Probability | Fallback |
|---|---|---|
| the sandbox does not support step-up / `max_age` | medium | run the full authorization code flow every time (it still satisfies "present right now"), and spell it out in the debrief |
| no device authorization grant | medium | the headless agent prints an authorization link + polls; the GUI popup is the primary path |
| `sub` is not pairwise / is unstable | low | construct it yourself from a hash of issuer+sub, and flag the risk in the docs |
| the verify endpoint's shape does not match the docs | medium | isolate it in the adapter layer (T-0.3); only one place changes |
| the sandbox environment is unstable / rate-limited | medium | record a complete video beforehand as a fallback |
| **mistaking ①IDKit sandbox for ②the IdP** | **high** | the comparison table at the start of §2; S-1/S-2 point at two different places |
| M5 cannot be finished in 48 hours | high | M5 is P2, cut it outright; grants degrade to a design note in the docs |

---

## 8. Deliverables checklist

- [ ] a runnable system (the six-beat demo passes)
- [ ] `../README.md` — a one-line description + how to start it
- [ ] `../SPIKE_NOTES.md` — the assumption-verification conclusions from Day 0
- [ ] `../FAILURE_MATRIX.md` — the failure path matrix
- [ ] `../INTEGRATION_DEBRIEF.md` — **hard track requirement**
- [ ] a public repository (tracks usually require open, accessible source)
- [ ] a demo video (as a fallback)

---

## 9. How to work, for the coding agent

1. **Read [`concept.md`](./concept.md) first**, especially the "our increment" section corresponding to the §0.4 red lines — **knowing the why keeps you from "optimising" the design away**.
2. **Do the §2 Day 0 spike first**, write the conclusions into `../SPIKE_NOTES.md`; until the blocking items (S-1~S-3, S-7) have results, do not write business code.
3. **Follow P0 → P1 → P2 strictly.** Do not start P1 until P0 is all green.
4. **Self-check the acceptance list after each task**; do not mark it complete if it does not pass.
5. **When the sandbox docs disagree with reality**: reality wins; record it in `../SPIKE_NOTES.md` and in the final `../INTEGRATION_DEBRIEF.md` (that is exactly the feedback the track wants).
6. **Do not call any World ID API outside `worldid/`** (T-0.3).
7. **The red lines (§0.4) may not be compromised for the sake of "simplification".** Especially red line 1 and red line 5 — once those two fall, the whole project's argument falls with them.
