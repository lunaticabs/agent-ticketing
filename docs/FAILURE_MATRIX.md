# FAILURE_MATRIX.md — every refusal, and proof that nothing ran

> **Task**: T-7.1 · **Produced by**: `npm run e2e` (live HTTP) and `npm test` (in-process)
> **Track requirement 3**: *"演示失败路径：拒绝 / 过期 / 取消时，受保护动作不发生"*
> — "demonstrate the failure paths: on refusal, expiry or cancellation, the
> protected action does not happen".

Every row below was **executed**, not reasoned about. The `verify` column is a
database read taken after the refusal, because "it returned an error" and "the
slot did not move" are different claims and only the second one matters.

The governing rule for all of it:

> A protected action happens **only** inside the single transaction in
> `lib/gate.ts` that consumes a nullifier. A refusal
> returns before that transaction opens. There is no code path where a check
> fails and the write still happens — that is a structural property, not a
> convention.

---

## 1. Authorization failures

| # | Scenario | Machine code | HTTP | What the caller is told | Protected action | Verified by |
|---|---|---|---|---|---|---|
| 1 | `slot.claim` with no approval at all | `approval_required` | 428 | "this action requires a human authorization; a proof of authorization must accompany the call" + a hint to obtain one | **did not run** | `slot.state` still `ALLOCATED`; `consumed_proof` count unchanged |
| 2 | `slot.claim` with a fabricated reference | `approval_not_found` | 404 | "the presented approval is not known to this server" | **did not run** | same |
| 3 | A body carrying `{ok: true}` or `clientResult` | `untrusted_client_result` | 400 | names the offending field and states the server verifies itself | **did not run** | request rejected before the gate |
| 4 | A body carrying `environment` (any nesting) | `environment_pinned` | 400 | echoes what was received and what the server pins | **did not run** | request rejected before the gate |
| 5 | No session and no agent credential | `not_authenticated` | 401 | "sign in with World ID before joining the queue" | **did not run** | 401 |
| 6 | Agent token without the required scope | `grant_scope_insufficient` | 403 | lists held vs required scopes | **did not run** | 403 |
| 7 | Human pressed Deny | `approval_denied` | 400 | "the human denied this request" | **did not run** | approval state `DENIED`; slot untouched |
| 8 | Stale authentication (`max_age=0` violated) | `not_fresh` | 400 | "authentication is older than the freshness window" / "predates the authorization request" | **did not run** | `consumed_proof` count unchanged |
| 9 | Proof predates the approval request | `not_fresh` | 400 | "this authentication predates the authorization request, so it is not a fresh proof for this action" | **did not run** | same |
| 10 | Approval expired before use | `approval_expired` | 410 | "this request expired before it was used" | **did not run** | same |
| 11 | Proof belongs to a different human | `approval_identity_mismatch` | 403 | names both humans | **did not run** | same |
| 12 | IdP unreachable / attempt failed | `approval_not_approved` | 400 | the underlying failure text | **did not run** | same |

## 2. Binding failures (RED LINE 6)

| # | Scenario | Machine code | HTTP | Protected action | Verified by |
|---|---|---|---|---|---|
| 13 | Approval re-targeted at a different event | `approval_action_mismatch` | 403 | **did not run** | slot holders unchanged |
| 14 | Approval with a different human swapped into the signal | `approval_signal_mismatch` | 403 | **did not run** | same |
| 15 | A purchase proof presented for a different event's action | `approval_action_mismatch` | 403 | **did not run** | same |
| 16 | A purchase proof presented for a generic `verify_user` action | `approval_action_mismatch` | 403 | **did not run** | same |

## 3. Replay and duplication (RED LINE 5)

| # | Scenario | Machine code | HTTP | Protected action | Verified by |
|---|---|---|---|---|---|
| 17 | The same approval presented twice | `already_owns_entitlement` | 409 | **did not run** | one `CONFIRMED` slot, not two |
| 18 | The same nullifier driven straight at the table | `proof_replay_detected` | 409 | **did not run** | rolled-back transaction; row count unchanged |
| 19 | **Two simultaneous claims, same approval, two sockets** | one 200 + one `already_owns_entitlement` | — | **ran exactly once** | `confirmed slots = 1` |
| 20 | Same human, second purchase of the same event | `already_owns_entitlement` | 409 | **did not run** | `consumed_proof` = 1 for that action |
| 21 | A consumption inside a transaction that then throws | — | — | **did not run** | the inserted row rolled back with it |

## 4. Queue and slot lifecycle (T-2.2, T-2.3)

| # | Scenario | Machine code | HTTP | Protected action | Verified by |
|---|---|---|---|---|---|
| 22 | Joining after the draw was settled | `queue_closed` | 400 | entry not created | `queue_entry` count unchanged |
| 23 | Joining twice, from the same human | — (idempotent) | 200 | returns the existing entry | count stays 1 |
| 23b | 40 accounts for one human joining | — (idempotent) | 200 | every attempt after the first returns the existing entry | queue length equals the number of **humans**, not accounts |
| 24 | Claiming with no allocation | `no_slot_allocated` | 400 | **did not run** | — |
| 25 | Claiming after the window closed and the slot deferred | `deferred_to_next_candidate` | 410 | **did not run** | `consumed_proof` = 0 for that human; the slot is held by someone else |
| 26 | **Claiming after deferral with a fully valid, fresh, correctly-bound proof** | `deferred_to_next_candidate` | 410 | **did not run** | same — this is the row that shows deferral is final |
| 27 | Slot already confirmed to this human | `already_owns_entitlement` | 409 | **did not run** | — |
| 28 | Allocating more slots than `total_slots` | — | — | capped | allocation count = `total_slots` |

## 5. Grants (T-5.1) — API-only

Roles are not part of the demo surface: the console and the control panel render
nothing about VIP status or grants. The endpoints below remain live and tested,
and `/api/queue/status` still reports `vip` and `grants` as part of its payload,
so the capability is reachable by curl and by an agent without appearing on
screen.

| # | Scenario | Machine code | HTTP | Verified by |
|---|---|---|---|---|
| 41 | Using an expired grant | — (no grant found) | — | `activeGrant()` returns `undefined` at read time, so the privilege is already gone |
| 42 | Using a revoked grant | — | — | same; revocation is a row update with no cache in front of it |
| 43 | Unknown scope | `bad_request` | 400 | — |

## 6. Misconfiguration failures (caught at startup, not at the IdP)

| # | Scenario | Where it surfaces | What the operator is told |
|---|---|---|---|
| 43a | `HUMANGATE_PUBLIC_URL` and `WORLDID_REDIRECT_URI` disagree on origin | startup banner + `GET /api/health` → `urls.consistent: false` | both sides named, plus *"links the app renders will not open"* and the easiest fix |
| 43b | Real IdP credentials configured, but the public base URL is `http://` | startup banner | *"The sandbox portal only accepts https callbacks, so the browser will be redirected to a scheme this server is not serving."* |
| 43c | `WORLDID_REDIRECT_URI` is not a parseable URL | startup banner + `urls.problem` | named as such; link building keeps working off the default rather than throwing mid-request |

All three are printed before the first request (`instrumentation.ts`), because a
consistency warning that only appears once somebody happens to load a particular
page is not a warning.

## 7. Demo-surface failures (T-6.2)

| # | Scenario | Machine code | HTTP | Verified by |
|---|---|---|---|---|
| 44 | Any `/api/dev/*` route with `ENABLE_DEV_ROUTES` unset | `dev_routes_disabled` | **404** | indistinguishable from a route that was never deployed |
| 45 | `/api/dev/impersonate` with no handle | `bad_request` | 400 | — |
| 45b | Any request to a removed endpoint (`/api/humans`) | `not_found` | **404** | the route is gone, and a journey test asserts the console offers no role surface |
| 46 | A grant scope the server does not accept | `bad_request` | 400 | the server is the only gate on scopes now that no UI offers them |

---

## What a failure looks like to a caller

Every refusal is the same JSON shape, which is what makes the MCP surface work
without special-casing:

```json
{
  "ok": false,
  "code": "deferred_to_next_candidate",
  "message": "your approval window closed, so this slot was passed to the next candidate in the draw",
  "invariant": "RED LINE 10 — the window closes before the draw, so late arrivals cannot matter",
  "details": { "eventId": "evt_tokyo_night", "drawnAt": 1790341460428 },
  "hint": "The window is closed for this event. An organiser can open a new one from /admin."
}
```

| Field | Purpose |
|---|---|
| `code` | stable, machine-readable; safe to branch on; never changes wording |
| `message` | one sentence, safe to put on a projector |
| `invariant` | **which red line this refusal protects** — so a refusal explains the design rather than just reporting an error |
| `details` | the values involved, for logs and debugging |
| `hint` | what a model or a person should do next |

`hint` exists because of a specific requirement: the MCP surface must return
*something a model can act on*. A refusal that says only "forbidden" invites
retries and workarounds; a refusal that says "the window closed and the slot
moved on; do not retry" ends the loop.

---

## How this file was produced

```
npm test              # red-line invariants, user journeys, URL consistency
npm run e2e           # the demo beats + this failure matrix over real HTTP
                      #   + a real two-socket concurrency race
npm run mcp-check     # the MCP surface, incl. claim-without-approval
npm run security-check
```

Sections 1–7 are covered between them. Run all four before a demo; each exits
non-zero on failure, so `npm test && npm run e2e && npm run mcp-check &&
npm run security-check` is the pre-flight.
