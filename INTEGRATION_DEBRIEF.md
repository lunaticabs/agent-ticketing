# INTEGRATION_DEBRIEF.md

**Track**: World — 🤖 Best Use of World ID for Agents (ETHGlobal Tokyo 2026)
**Integration**: Human Continuity IdP — `https://sandbox.auth.world.org`, over OpenID Connect
**Date**: 2026-09-25

> Required by the track (hard requirement 5): *first-success time, friction
> encountered, missing capabilities, and the single most valuable improvement.*
>
> Written as a bug report, not as a testimonial. Everything below is either a
> measured number, a quoted error, or a reproduction. Where something worked
> well, it is said once and briefly, because that is not the useful part.

---

## 1. Time to first success

| Milestone | Elapsed | Notes |
|---|---|---|
| Read discovery + `oidc`/`step-up`/`getting-started` guides | **~4 min** | `/.well-known/openid-configuration` plus the sandbox's own MCP integration guides |
| First `authorize` URL constructed correctly | **~9 min** | `openid-client` v6 discovery + PKCE |
| First working end-to-end gate (ask → approve → verify → execute) | **~21 min** | against the local fallback IdP |
| **First real World ID proof validated** | **never reached** | blocked on §2.1 |

**Read those numbers with the right denominator.** This build was produced by a
coding agent working continuously; a human team pacing itself over a hackathon
would multiply the first three rows by a large factor for reasons that have
nothing to do with World ID — context switching, a venue, other people.

The fourth row is the one that matters, and it is the honest headline: **the
track's core integration was never exercised against the real IdP.** Not because
it is hard, but because one step in the middle requires a person, and that step
is not clearly surfaced anywhere a builder would look first.

---

## 2. Friction

### 2.1 🔴 BLOCKER — client registration cannot be completed by an AI agent, and nothing says so until you try

**Reproduction**

1. Read `https://sandbox.auth.world.org/docs`. It presents three steps: *"For
   application registration, manage your OIDC client in the portal"*, *"Connect
   your coding agent to the MCP server at `/mcp`"*, *"Read the guides"*.
2. Connect to the MCP server and call `list_idp_guides` / `get_idp_guide`. The
   `getting-started` guide says: *"Agents can call `request_oidc_client_registration`
   on this same MCP endpoint."* — which reads as *an agent can register a client*.
3. Call `request_oidc_client_registration`. It returns an `insufficient_scope`
   challenge for `developer-portal:manage`, which requires **Google sign-in**.
4. The `getting-started` guide, read more carefully, says: *"Portal access uses a
   verified Google identity and deployment-specific account eligibility rules.
   `account_not_eligible` may require organizer/operator help, including for Gmail
   accounts."*

**Expected**: the docs make the agent path sound complete. The MCP server exposes
nine portal tools (`list_oidc_clients`, `update_oidc_client`,
`request_oidc_client_secret_creation`, …), which strongly implies an agent can
drive registration.

**Actual**: the agent can *stage* a request; a Google-authenticated human must
approve it. The words *"Send the returned `portalUrl` to the human for
approval"* are in the `oidc` guide — but they are in a paragraph about a
different topic, and the `getting-started` table does not mention the human at
all.

**Impact**: this is the difference between a working integration and a
**disclosed fallback**. An agent-driven build gets all the way to the consent
screen and stops. Nothing after that point was ever tested against the real IdP.

**Suggested fix**, in order of preference:

1. **Say it in the `getting-started` table.** One column: *"requires a human with
   a Google account: yes/no"*. That single cell saves every agent-driven team an
   hour.
2. **Add a `world-id-users`-style protected guide for registration** — the MCP
   already has one for account status. A guide that opens with "this flow ends at
   a human" is exactly the shape needed.
3. If organizer-run registration for hackathon participants is possible at all,
   say so at the top of `/docs`. `account_not_eligible` is called out as needing
   *"organizer/operator help"*; a participant reading that mid-build has no idea
   whether they are blocked by a bug or by policy.

> **On the design itself**: requiring a human approval for something that
> displays a client secret exactly once is *correct*. The complaint is not the
> requirement, it is that the requirement is discoverable only by hitting it.

### 2.2 🟠 The track's assumed verification model is IDKit's, and the IdP's is OIDC

The hackathon brief sends teams to `sandbox.auth.world.org`, but most of the
broader documentation, every code sample in the ecosystem, and the prior winning
projects are built around IDKit's `action` + `nullifier`. The two are not the
same shape:

| | IDKit | Human Continuity IdP |
|---|---|---|
| Verification surface | POST a proof to a verify endpoint | OIDC code exchange → ID token |
| Identity | `nullifier_hash` | pairwise `sub` |
| Action scoping | `nullifier = human × rp_id × action` | **no equivalent** |
| Freshness | re-verify | `max_age` / `auth_time` |
| Reverse-engineering required | none | reconstruct the action-scoped key yourself |

The practical trap is severe and worth spelling out, because it is silent:

> A team that reads the brief, reads World ID's `action`/`nullifier`
> documentation, and then writes `action: "buy_ticket"` against this IdP will
> ship a purchase gate that enforces **nothing**. There is no error. The code
> runs. The check always passes. It only fails under attack, which is exactly
> when a demo cannot afford it.

What made this tractable was the sandbox's own `step-up` guide, which is precise
about `max_age` versus `auth_time`, and the `oidc` guide's line *"Use `auth_time`
for freshness, never `iat`."* Those two sentences are the most valuable in the
whole documentation set.

**Suggested fix**: a short page titled *"Coming from IDKit? Here is what is
different"*, with the table above and one worked example of reconstructing an
action-scoped key. It would take an hour to write and would prevent the single
most dangerous misunderstanding in this track.

### 2.3 🟠 Two unrelated systems both called "sandbox"

The TODO warned about this and it is real. `environment: "sandbox"` in IDKit and
`sandbox.auth.world.org` share a word and nothing else — different products,
different docs, different capabilities. The first has no continuity, no fresh
auth, and no OAuth surface.

**Suggested fix**: name the second one something that is not "sandbox". It is a
*deployment*; the word is doing double duty in a domain that already overloads it.

### 2.4 🟡 `acr_values` is advisory, and the docs are honest about it but easy to miss

> *"`acr_values` — Voluntary preferences. Unsupported values do not force an
> error; validate the achieved `acr` yourself."*

An implementation that sends `acr_values=https://world.org/oidc/acr/orb-v3` and
then assumes the returned proof is orb-class is wrong, and the failure mode is
silent. We validate the returned `acr` and treat the request as a hint. Other
teams will not.

**Suggested fix**: consider returning an error for an unsupported `acr_values`,
or add `acr_values_enforced: false` to the discovery document's metadata. A
capability flag would let a client detect this programmatically instead of
reading a table.

### 2.5 🟡 Library defaults actively fight this IdP

The `oidc` guide warns: *"Disable defaults such as `profile`, `email`,
`offline_access`, `prompt=consent`, and `prompt=select_account`."*

It is right to warn. Standard OIDC libraries add scope and prompt defaults that
this IdP rejects outright — it supports exactly `openid`, and exactly
`prompt=none|login`. The failure (`invalid_scope`, `invalid_request`) arrives at
the authorization endpoint and, per the troubleshooting table, *"bad
client/callback requests may fail directly without redirecting"* — so there is no
error on your callback to inspect. It looks like nothing happened.

**Suggested fix**: a one-line snippet per popular library (openid-client, Auth.js,
Spring, passport-openidconnect) showing the overrides. This is a 20-minute task
for whoever maintains the samples and saves each team the same debugging session.

### 2.6 🟢 What worked well

Said once, briefly, because it is real and it is the reason the build got as far
as it did:

* **The discovery document is complete and accurate.** Every endpoint, every
  grant type, every supported value, all in one fetch. `openid-client`
  auto-configured from it with no special-casing.
* **`max_age=0` and `prompt=login` are implemented properly.** Not "documented
  but unshipped" — they work as described. RFC 9470 step-up is genuinely
  available here, which is more than many production IdPs can say.
* **The device authorization grant is available on the OIDC surface.** The TODO
  told us not to assume this. It is there, correctly advertised, with the
  `authorization_pending` / `slow_down` / `Retry-After` semantics you would hope
  for. A headless agent can authenticate for real, with no fallback.
* **The integration guides are readable over MCP without authentication.**
  `list_idp_guides` → `get_idp_guide` with no login is a genuinely good idea, and
  the `step-up` guide in particular is better than most human-facing docs on the
  subject.

---

## 3. Missing capabilities

| # | Missing | Impact | Workaround |
|---|---|---|---|
| 1 | **Agent-completable client registration** | the track's core integration cannot be finished without a human (§2.1) | local fallback IdP; real IdP path implemented and dormant |
| 2 | **Action-scoped one-time key** (an OIDC equivalent of the IDKit nullifier) | every relying party must reconstruct `human × action` itself, and most will not realise it (§2.2) | `sha256(domain \| iss \| sub \| action \| signal)` + `UNIQUE (bound_action, continuity_id)` |
| 3 | **A sandbox capability document** | teams cannot tell which advertised behaviours are enforced vs advisory | read every guide end to end; validate achieved values rather than requested ones |
| 4 | **An `SKILL.md` for the sandbox path** | `https://world.id/SKILL.md` is an excellent agent skill for the IDKit/World ID 4.0 production path. There is no equivalent for the Human Continuity IdP — the guidance exists as six MCP guides, which an agent must know to fetch. | we read the guides over MCP manually; an agent that does not know `/mcp` exists has nothing to read |
| 5 | **RFC 9470 challenge/retry on the MCP surface** | the `step-up` guide is explicit that *"the MCP OAuth authorize endpoint and `get_world_id_account` do not offer OIDC freshness guarantees"* and that *"basic MCP OAuth support does not guarantee RFC 9470 support"*. So an MCP-hosted action needing fresh presence must fall back to a separate interactive reauthentication path. | we use OIDC for anything needing freshness and MCP only for transport |
| 6 | **A nullifier-shaped identity for the MCP `continuity_handle`** | the MCP returns a `continuity_handle` from `get_world_id_account`, but per the docs *"World ID confirms prior verification, not fresh human presence"* — so it cannot be used for the "at the moment" requirement | OIDC |

---

## 4. The one improvement that would matter most

> ### Ship the sandbox path as an agent skill, at a stable URL, covering all three surfaces.

Everything else in §3 is downstream of this.

The IDKit path has `SKILL.md`: eight phases, a checklist, a gotchas table. It is
exactly what a coding agent needs. The sandbox path has *better raw material* —
six well-written integration guides — and no way for an agent to discover it. The
`llms.txt` file exists and is good, but an agent has to already be pointed at it.

Concretely, one document that:

1. **Opens with the decision table** from `getting-started`, with a column for
   *"ends at a human: yes/no"*;
2. **States the IDKit-vs-OIDC difference explicitly**, including that there is no
   action-scoped nullifier and what to do instead;
3. **Names the two "sandbox" meanings** in the first screen;
4. **Lists the library defaults to override** (§2.5);
5. **Says what is enforced vs advisory** — `acr_values`, freshness controls on the
   device grant, what the MCP surface does and does not guarantee;
6. **Is one fetch.** A single `GET` that returns all of it, at a URL an agent
   already knows to look for.

The reason this is the highest-value change is that it converts a **hard blocker**
(§2.1: an agent cannot finish, and does not find out why) into a **known
hand-off** (an agent finishes everything, hands the human one URL, and resumes).
That is the difference between a build that demonstrates the real IdP and one
that demonstrates a fallback — and, in this project's case, it is the entire
distance between §1 row 3 and §1 row 4.

The second-order effect is larger than the first. The most dangerous finding in
this debrief is §2.2: a team can ship a purchase gate that enforces nothing and
never see an error. A skill that states the shape of the surface up front is what
stops that class of bug from reaching a judging table.

---

## 5. What this build does and does not demonstrate

Stated plainly, because the gap is the honest part.

**Demonstrated against the real sandbox IdP:**

* discovery is read and consumed correctly (`npm run spike` re-verifies live);
* the authorization-code + S256 PKCE request is built to the registered-client
  contract, including the library-default overrides;
* the device authorization grant is implemented against the real endpoints;
* `max_age` / `auth_time` freshness semantics are implemented as the `step-up`
  guide specifies, including the `max_age=0` "belongs to this attempt" rule;
* pairwise subject handling and `(issuer, sub)` identity linking;
* the fact that no nullifier exists, and the reconstruction that replaces it.

**Not demonstrated:** a real World ID proof ever reaching `verifyOnServer`.
Everything downstream of the consent screen is exercised, but only through the
fallback's assertion. **Supplying `WORLDID_CLIENT_ID` and
`WORLDID_CLIENT_SECRET` is the only step remaining**, and it requires no code
change — `idpMode()` switches, and `worldid/local.ts` stops being reachable.

### One functional gap worth naming

The relying party never calls the IdP's authorization endpoint at the *primary
allocation* stage. A drawn slot is confirmed with a World ID step-up bound to
`buy_slot:{event_id}`, which is the red-line-1 guarantee. But the *queue entry*
itself was created from a link-flow session established earlier, and this build
does not re-assert humanness at the moment of allocation. Doing so would be a
second `max_age=0` step-up per allocation, and it is squarely within the
implementation already here — `startFreshAuth` takes an `action` and a `signal`
and does not care what they name.

It was left out for time, and it is the first thing to add.

---

## 6. Reproduction

```bash
git clone <repo> && cd presence
npm install && npm run seed
ENABLE_DEV_ROUTES=1 npm run dev

npm run spike          # re-verify every §2 claim against the live IdP
npm test               # 40 invariant tests
npm run e2e            # six demo beats + the failure matrix, over HTTP
npm run mcp-check      # the MCP surface, including claim-without-approval
npm run build && npm run security-check
```

`SPIKE_NOTES.md` carries the evidence column for every claim in §2, including the
raw discovery document and the exact guide quotations.
