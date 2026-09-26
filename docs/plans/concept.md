*Historical planning document — the original project plan, written in Chinese before implementation and translated to English here for the record. Where it disagrees with the delivered code, the code and `../README.md` win.*

# Agent Ticketing System · Concept Document

> **Working title**: Presence · TBD
> **Setting**: ETHGlobal Tokyo 2026 · World "Best Use of World ID for Agents" track
> **Date**: 2026-09-25

---

> ### ⚠️ Scope-reduction note (updated at implementation time)
>
> This document describes the full concept. The **allocation-transfer (resale) layer was
> ultimately not implemented**. The delivered system has only one mode, `locked`: an
> allocation is locked to the person who won it — not transferable, not holdable on someone
> else's behalf, no recipient window, and no per-continuity cap on allocations. The affected
> sections (§4.1 #3, §4.2 gap two, §5 insight two, the mode table in §6, the five transfer
> rules in §7, beats 4/5 of §9) have been rewritten or deleted to match.
>
> **Why this is worth writing down**: cutting the transfer layer was not just one feature
> fewer — it removed the differentiation this document originally claimed ("others handle who
> can buy; we handle how it moves after it is bought"). What remains is still the hard part: a lottery
> rather than first-come-first-served, the gate installed on the right action, and the
> continuity identifier threaded through the audit trail. But the argument's centre of gravity
> moved from "the transfer layer" back to "the queue itself".

## 0. In one sentence

> **Let your agent queue in your place; the moment the allocation lands, require a real human to authorise it on the spot — if the human is not there, the allocation passes down to the next human.**

What we are building is not "a World ID login bolted onto a ticketing system", but **"a human present, on demand" made into a primitive that the queueing system can call at any moment**.

But the more accurate one-liner is this one:

> **Others build "who can buy a ticket". We build "who is holding the ticket, and whether he is there right now".**

---

## 1. What we are building

A queueing / ticketing system for event organisers:

- Users join the queue as a **unique real human** (anti-script, anti-multi-account)
- The user's **agent waits in the human's place**, watching for allocation releases
- When an allocation is released, the agent triggers a **fresh verification** and the human confirms on their phone
- The human approves inside the window → the sale closes; **the human is not there → the allocation passes down automatically**
- The allocation is **locked** to the winner and cannot be transferred
- The organiser can issue VIPs a **scoped, expiring, revocable** secondary authorisation

---

## 2. Why this is the Agents track, not an ordinary ticketing system

| | Ordinary ticketing system | Us |
|---|---|---|
| Where World ID sits | A login gate at the entrance | **A control loop in the middle of the flow** |
| Who is waiting | The human | **The agent** |
| Number of verifications | 1 (at registration) | **N (at every critical moment)** |
| Failure path | "You have already claimed one" (a state check) | **Window expires → allocation passes down (product semantics)** |

The track's first hard requirement is: **you must integrate the official World ID for Agents on the sandbox**. A pure queueing system uses IDKit's `action` + `nullifier`, and that **does not satisfy the eligibility requirement**. Putting the agent into the loop is what lands this project in this track.

---

## 3. Niche: whose shoulders we stand on

Ticketing is a direction **others have already worked on**, and worked on a lot. This section draws the boundary between us and them cleanly.

### Three layers

| Layer | Question it answers | Who is doing it | Status |
|---|---|---|---|
| **Allocation layer** | Who is **eligible** to buy | **World Concert Kit** (official product) | Already live, with real commercial tours |
| **Purchase layer** | **Selling** the ticket | Eventick / Ticketo (2025 prize-winning projects) + every ticketing platform | Done many times over |
| **Holding and transfer layer** | What happens after the allocation lands and before entry | — | ⬅️ **Empty, and this is where we are** |

### What Concert Kit is, and where its boundary lies

| Item | Fact |
|---|---|
| Product | **Concert Kit** (site brand World Music, `music.world.org`), an official World product |
| Positioning | "concerts are for real fans, not bots" |
| Launch | Around April 2026; already a production product |
| Track record | "Humans Only Concert" (San Francisco, 4/17) — World **claims** it blocked 100,000+ bot requests, with about 1,000 verified humans getting tickets; the **Thirty Seconds to Mars** European tour offers human-only 2-for-1 tickets |
| Aimed at | Artists ("Are you an artist?" → music@toolsforhumanity.com) |

Its official flow has only four steps:

1. Download the World ID App
2. Complete proof of human on an orb
3. **CLAIM YOUR CODE** — unlock one exclusive access code
4. **GET YOUR TICKET** — redeem that code on a third-party ticketing platform

> **World does not hold the ticket, does not hold the queue, does not hold the inventory, and does not hold the transfer right. It holds exactly one thing: who is eligible to get a code.**

### Key insight: Concert Kit's code is a "bearer credential"

What it protects is **"who gets the code"**, not **"who ends up sitting in the seat"**.

Once step 3 has handed out the code, control passes to two things: the user's own good faith, and the third-party platform's rules. And **the place where scalpers actually make money is precisely not "who can buy", but "how it moves after it is bought"**.

World spent enormous effort guarding the entrance, then handed control away at step 3.5.

> **We are not building a competitor to Concert Kit. We are filling in the queue that its
> step 3 is missing — and we are not handing away control at step 3.5.**

### Lessons from the prize-winning projects (this part is hard evidence)

[Eventick](https://github.com/zanchary/ethglobalTaipei) and [Ticketo](https://github.com/ericwang520/ticketing-platform) both took the **World prize pool at ETHGlobal Taipei 2025**. Eventick in particular is solid: 12 contracts, a cross-chain bridge (World Chain ↔ Celo), offline QR verification, organiser identity verification. Its technical density is far above the average hackathon project — **worthy of respect**.

But on anti-scalping it left behind a **gap that can be proven in code**. See the next section.

---

## 4. Our increment ⭐️

**This section is the focus of the entire document.**

### 4.1 Relative to Concert Kit (allocation layer)

| # | Increment | Concert Kit today | What we do |
|---|---|---|---|
| 1 | **Queue and lottery** | The public flow has **no queue and no waiting room**. After getting a code you race to a third-party platform; that is where the speed competition happens, and World has no reach there | Build the queue into the system, and use a **lottery** rather than first-come-first-served — a script's speed advantage goes to zero |
| 2 | **Holding-period management** | Control is lost the moment the code goes out | Auditable all the way from allocation to entry; the allocation is locked to the winner and cannot change hands |
| 3 | **Allocation locked down** | **None.** The code can change hands freely | The allocation is bound to the winner and cannot be transferred. Eventick's `transferFrom` gap does not exist here, because that path is simply not there |
| 4 | **Delegated authorisation** | **None** | Scope issuance for VIPs, with **expiry and revocation** (the API is kept, the UI does not show it) |
| 5 | **Agent in the loop** | **None.** A human has to operate throughout | The agent queues in the human's place and pulls the human in at the critical moment |

### 4.2 Relative to the prize-winning ticketing projects (purchase layer)

#### Gap one: the nullifier is burned on the **wrong action**

Eventick's `WorldIDVerifier` really does implement nullifier replay protection:

```solidity
require(!nullifierHashes[nullifierHash], "Nullifier already used");
...
nullifierHashes[nullifierHash] = true;   // ← burned at "verification" time
```

But it burns on the **"verification"** action, not on the **"purchase"**. Now look at the complete set of checks in `buyTicket()`:

```solidity
require(evt.isActive, "Event is not active");
require(evt.ticketsSold < evt.totalTickets, "No more tickets available");
require(msg.value == evt.ticketPrice, "Incorrect payment");
require(block.timestamp < evt.eventDate, "Event has already occurred");
```

Those four, and that is all. Search the entire codebase for `maxTicket | purchaseLimit | hasPurchased | onePerHuman | limitPer` — **zero hits**.

> **Consequence: one verified address can buy out an entire event's tickets.**
> All it needs is "is a verified address" (a boolean), not "this person has not bought yet".

And their project description says: *"ensures that a single identity can only purchase **limited tickets per event**, preventing mass purchases by scalpers"*.

**✅ Our increment: bind the `action` to the "purchase" operation** (`buy_ticket_event_1`).

Because `nullifier = user × app_id × action` — one ticket per person then holds automatically. **The choice of a single field decides whether the whole anti-scalping scheme holds up.**

#### Gap two: tickets are **completely freely transferable**

Search all 12 of Eventick's contracts for `_transfer` / `transferFrom` / `soulbound` /
`nonTransferable` / `_beforeTokenTransfer` / `_update(` — **zero hits**. 4 contracts inherit
ERC721, with no transfer restriction of any kind. All that World ID verification at purchase
time is bypassed by a single `transferFrom`.

And the two gaps **stack**: one address buys up every ticket, then `transferFrom`s them out to anyone.

**✅ Our increment: the allocation simply does not move.**

At concept stage the plan here was "transfers go through a policy engine" — three modes,
`locked` / `gift` / `open`, with transfers carrying friction, a trail and a cap. It was cut
at implementation time and only `locked` remains. The reasoning: of the three modes, only
`locked` actually stops scalpers; `gift` and `open` both mitigate damage under the premise of
"transferable", and removing the premise is more thorough — and removes a whole block of
attack surface that would otherwise have to be proven.

The cost is real, and not glossed over: **you cannot even give a ticket to a friend**. Low-demand
events could reasonably have opened up transfers; now that knob does not exist.

#### Gap three (shared): there is only "an address", never "a person"

The gate in both projects is `isVerified(msg.sender)` — **a boolean keyed on an address**. So the system has **no concept of "the same person"**, and therefore no per-person cap, no audit trail and no cross-account tracking.

**✅ Our increment: the continuity identifier. The record follows the person — swapping accounts, swapping devices or spinning up a new agent cannot wash it off.**

### 4.3 What nobody has done at all (brand new)

- **An agent queues in the human's place** + **fresh verification** at the moment the allocation lands
- **Window expires → allocation passes down** (the failure path is itself product semantics)
- **A three-tier permission structure** (organiser-granted mentor / VIP) as **expiring, revocable scopes**
- **The sandbox Human Continuity IdP itself** — Concert Kit and both prize-winning projects use the old production stack; the agent layer is **genuinely empty**

### 4.4 One-page summary

| | Others | Us |
|---|---|---|
| Allocation | ✅ Done by Concert Kit | Reused |
| Purchase | ✅ Done by several projects | Reused, but with **the gate installed on the right action** |
| **Queue / lottery** | ❌ | ✅ |
| **Holding period** | ❌ | ✅ |
| **Allocation locked down** | ❌ | ✅ |
| **Continuity audit trail** | ❌ | ✅ |
| **Agent in the loop** | ❌ | ✅ |
| **Fresh verification** | ❌ | ✅ |
| **Delegated authorisation** | ❌ | ✅ |

> **Of the nine dimensions, existing projects cover the first two; we cover five of them** —
> and the emphasis is not on coverage but on the one line "an agent can legitimately buy a
> ticket on a human's behalf": the agent queues, the agent requests authorisation, the human
> approves on their phone, the gate lets it through. Everything else is support around that
> spine.

---

## 5. Three counter-intuitive conclusions ⭐️

**This section is the reasoning that supports the increments above.**

### Insight one: uniqueness is necessary, not sufficient

One World ID per person kills "one script buys 500 tickets". But it does not stop three attacks:

- **Speed arbitrage** — a scalper needs only **one** identity plus faster tooling
- **Hiring real humans** — 50 real people, each with a genuine World ID, one ticket each
- **The secondary market** — see insight two

> **⚠️ This one changes the design directly: the queue must be a lottery, it cannot be first-come-first-served.**
> If you hand out places in arrival order, uniqueness is a dead letter — the speed advantage eats everything.
> The right approach: **everyone who joins inside the time window has an equal chance.**

### Insight two: uniqueness ∩ transferable = the scalper goes from "ticket-grabber" to "market maker"

Once tickets are transferable, a scalper **does not need to win the queue at all**. He just posts a price: "I'll give you ¥3000 for your ticket."

Out of 100 winners, someone will always be willing to sell. No hiring, no scripts, no racing — what he does is **market making**.

> **Transferability reopens, from behind, the very door uniqueness had just closed.**

This insight originally led to "transfers must go through a policy engine". At implementation
time it led to the opposite conclusion: **since transferability is itself that back door, do
not have the door**. The system offers only `locked`.

This is not dodging the problem, it is stating the trade-off plainly: once everything is
locked, the only tool a scalper has left is hiring real people to queue — the most expensive
and least scalable one. What we give up is flexibility, not rigour.

### Insight three: fresh verification is not a wall, it is a tax; the teeth are in the "trail"

Many people assume "fresh verification = a face scan = meeting in person". **Both are wrong.**

- Fresh verification happens on the **recipient's own device**; it authenticates to the
  **service**, not to the **sender**
  → **asynchronous, remote, the two people never need to meet**
- On the sandbox OIDC path, the freshness primitive is `auth_time` (RFC 9470 step-up)
  → **no camera is needed at the protocol level**

So what does it actually do? Two things:

1. **It turns an authorisation into a real cost in time**
   When the allocation lands, it requires a real human to respond inside a **window that
   expires**. It cannot be batched, cannot be pre-authorised, cannot be done by proxy — if
   the human is not there, the allocation passes down to the next person
2. **It leaves a record that cannot be washed off**
   Every join, every win, every approval hangs off the continuity identifier. Swapping
   accounts, swapping devices or spinning up a new agent cannot wash it off — 40 accounts are
   still only 2 people in the system

> The window only makes a scalper **slower**; **it is the continuity audit record that puts him at risk of being caught**.
> Honestly: if this really required meeting in person, anti-scalping would be far stronger — but it does not. So do not oversell it in the demo.

---

## 6. One level deeper: this is not a problem technology can solve

**Scalping exists because tickets are priced below the market price.**

A ticket with a face value of ¥1000 reselling for ¥30000 means that the ¥29000 premium is a **bounty**. As long as it exists, someone will do that job — with bots, with real people, with inside connections, whichever works.

**Technology can only change "who gets that ¥29000", not abolish it.** The live-event ticketing industry has worked at this for decades and has still not produced a design that is both freely transferable and scalper-proof — because those two things cancel each other out by definition.

### So we do not claim to solve scalping

**At concept stage** there was a three-mode knob table here (`locked` / `gift` / `open`),
letting the organiser choose which cost the scalper pays. **At implementation only `locked`
was kept**, for the reason given in §4.2 gap two: `gift` and `open` both mitigate damage
under the premise of "transferable", and transferability is itself that back door.

| Mode | Transfer | Scalper's main attack surface | This implementation |
|---|---|---|---|
| `locked` | Not transferable, the allocation is bound to a person | Only hiring real humans is left (highest cost) | ✅ The only one implemented |
| `gift` | Transferable once, the recipient needs fresh verification | Crowds of people + limited resale | ❌ Removed |
| `open` | Free transfer | The secondary market is fully open | ❌ Removed |

> **Our position: we do not abolish scalping, we choose a structure that makes the scalper pay the highest cost, and we do not pretend it has no price.**
> The price is that you cannot even give a ticket to a friend. That is a trade-off we took on deliberately, not a feature we forgot to build.

---

## 7. System design

### State machine

```
Join (verified) → In queue → [Lottery] → Allocation confirming → Awaiting human approval → Confirmed (locked)
                                                                                         │
                                                                                         └─ Window expires → passes down to the next person
```

### World ID call sites

| Moment | Requirement | Primitive used |
|---|---|---|
| Join | Persistent proof (human, unique) | Proof of Human |
| **Purchase** | **`action` bound to the purchase** ← the key point | `nullifier = user × rp_id × action` |
| Allocation lands → confirm | **Fresh verification** (step-up inside the window) | `auth_time` + RFC 9470 / short TTL |
| Allocation lottery | Equal chance, independent of speed | — |
| Secondary authorisation (VIP) | Issue a scoped grant | sector + issuer/sub binding + revocable |

### Allocation locking

There is no transfer path. Once an allocation is `CONFIRMED`, it is bound to the winner's continuity identifier until the event ends:

- No transfer endpoint exists at the API level
- At the data level there is no `transfer` table, and no `policy` column to configure
- `security-check` asserts that these stores really do not exist — if a deleted feature leaves
  its tables behind, it comes back in unexpected ways

### Secondary permissions (VIP) — implemented as API-only

> Nothing role-related appears in the UI. This is not work left undone, it is deliberately not
> shown: this project's main competitive point is **an agent legitimately buying on someone's
> behalf**, and a VIP badge would pull attention away from that line.

Instead of `user.role = 'vip'`, we **issue a scoped authorisation** to a particular person:

- VIP = queue priority / bypass the lottery, but **with an expiry**
- Revocable at any time, and **the privilege decays too** — it is not permanent god-mode

> The mentor scope was removed along with transfers: its semantics were "may bring N people
> in", and bringing people in needs a path that hands an allocation over. Without transfers
> there is no mechanism for that permission to rest on, and keeping it would only leave a
> button that grants nothing.

---

## 8. Honest list: what we cannot stop

It is written here because **having thought these through is what proves we really understand this domain.**

- **Armies at high-priced events** — when the premium is big enough, hiring real people pays
- **Coercion and holding on someone's behalf** — freshness proves "present", it does not prove "willing", and still less "not hired". World ID cannot tell a fan from a mercenary
- **Friction lands on normal users** — even giving a ticket to a friend means arranging "a live moment". **This is a trade-off we took on deliberately, not a bug**
- **Insider collusion** — nothing to do with technology; it is handled by process audit

---

## 9. Demo script (three minutes)

**The scenario is a concert** — highest recognition, most visceral pain point. But **the opening line has to be this one**, otherwise judges will file it within 5 seconds as "yet another ticketing app / yet another Concert Kit":

> "Concert Kit proved bots can be kept outside the door, but it stops at the queue. Last season's World-prize ticketing project had tickets that were even freely transferable — a single `transferFrom` bypassed all of its verification. Our choice is simpler and harder: the allocation never leaves the person who won it. The only thing left to attack is the queue itself, and that is what these five beats are about."

| Beat | What happens | Purpose |
|---|---|---|
| 1 | An FCFS queue gets crushed by a script → cut to the lottery → the speed advantage goes to zero | Prove we understand the attack surface |
| 2 | The allocation lands → the agent blocks → approval on the phone → confirmed | The "at the moment" the track asks for |
| 3 | The human does not approve → the countdown hits zero → **the allocation passes down** | Failure path = product feature |
| 4 | **40 accounts join the queue → they collapse into 2 continuity identifiers → only 2 queue places** | **⭐️ The centrepiece of the whole demo** |
| 6 | Replay / changed amount / wrong environment → three rejections in a row | Security depth = differentiation |

**Props**: a live queue board (pass-downs and rejections must be visible to the naked eye) + one phone.

> Do **not** cut the countdown in beat 5. Those 15 seconds are our product claim:
> to a friend it is courtesy, to a scalper it is cost.

---

## 10. The 48-hour trade-offs

**✅ Must do (demo quality)**
- Real human joins the queue + uniqueness, with **`action` bound to the purchase**
- Agent queues in your place + fresh verification when the allocation lands
- Window expires → pass down
- Live queue board

**🟡 Downgraded to stretch**
- VIP: build it first as an enum field + one scope check, **no grant-management back office**

**❌ Explicitly not doing**
- Attendance check-in. `present` is already used up by "fresh verification at the moment of purchase"; doing check-in as well would repeat the same story

---

## 11. Open questions (we want your opinion)

1. **Lottery granularity**: one draw for the whole event, or several draws in batches? (affects the feeling of fairness vs system complexity)
2. **How "once" is judged in `gift` mode**: can an allocation be transferred only once in its lifetime, or can a person receive only one transfer in their lifetime?
3. **How long the pass-down window is**: 90 seconds or 120? Too short and normal users cannot make it; too long and scalpers have room
4. **Whether VIP needs "decay"**: should the privilege step down over time, or should only expiry and revocation be kept?
5. ~~Whether to build a fourth `strict` mode~~ — already answered by the implementation: only `locked`.

---

## Appendix A: Track facts

- **Event**: ETHGlobal Tokyo 2026 (ETHTokyo Week, 9/25–9/27, Toranomon Hills Forum)
- **Track**: World "🤖 Best Use of World ID for Agents" — **$7,500, at most 3 teams at $2,500 each**
- **5 hard eligibility requirements**:
  1. Integrate the official World ID for Agents on the sandbox (the dev environment provided by the event)
  2. Demonstrate the complete loop: request → user completes → verify the result → the protected action executes
  3. **Demonstrate the failure path**: on refusal / expiry / cancellation, the protected action does not happen
  4. Backend security checks: do not expose the client secret, do not treat an unverified client response as authorisation
  5. Submit a short integration debrief (time to first success, friction, missing capabilities, the one most valuable improvement)
- **The judges' taste, verbatim**: "a meaningful action that needs a human identity or approval layer, **not simply a login screen added to an existing product**"
- **References**: [track page](https://ethglobal.com/events/tokyo2026/prizes/world) · [sandbox docs](https://sandbox.auth.world.org/docs) · [HITL integration docs](https://docs.world.org/agents/human-in-the-loop/integrate.md)

## Appendix B: Competitors and precedents (all verifiable)

| Project | Nature | Stack used | Conclusion |
|---|---|---|---|
| [Concert Kit](https://music.world.org/) | **Official World product**, launched 2026-04 | Production IDKit / PoH | Allocation layer; the code is a bearer credential, holding and transfer are out of control |
| [Eventick](https://github.com/zanchary/ethglobalTaipei) | ETHGlobal Taipei 2025 **World prize pool**, 12 contracts + cross-chain + offline QR | MiniKit 3.0 (outdated) | Purchase layer; **nullifier burned on the wrong action + tickets freely transferable** |
| [Ticketo](https://github.com/ericwang520/ticketing-platform) | ETHGlobal Taipei 2025 **World prize pool** | MiniKit 3.0, `VerificationLevel.Device` (deprecated) | Payment demo; **no tickets table, verification state stored in localStorage** |

**Two stack warnings**: all three use the **old production stack** (MiniKit `verifyCloudProof` / `app_id` / no `rp_context`).
**The sandbox Human Continuity IdP required by the track (sector / pairwise sub / fresh auth / grant issuance) has not been used by any of these projects — that is genuinely empty space.**
