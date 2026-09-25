# SPIKE_NOTES.md — Day 0 verification against the live sandbox

> **What this is**: the answers to the TODO's §2 questions, each one checked
> against the running deployment rather than against the documentation.
> **How to reproduce**: `npm run spike`. It re-runs every check below and prints
> the same evidence. Run it before a demo to confirm nothing moved.
> **Date of the recorded run**: 2026-09-25, `https://sandbox.auth.world.org`.

---

## 0. The headline finding

**The Human Continuity IdP is a plain OIDC provider, not a World-ID-style proof
verifier. There is no verify endpoint and there is no nullifier.**

That single sentence changed the implementation of the project's most important
red line, so it is worth stating up front. The detail is in S-7.

---

## 0.1 "Sandbox" means two different things

The TODO warns about this and the warning was correct. Confirmed against the
live services:

| | ① IDKit `environment: "sandbox"` | ② `sandbox.auth.world.org` |
|---|---|---|
| What it is | an IDKit enum value; test proofs still go to the production verify endpoint | the **Human Continuity IdP**: an OpenID Connect provider |
| What it gives you | simulated proof verification | pairwise `sub`, `auth_time`, `acr`/`amr`, device grant |
| Used by us? | **no** | **yes** |

Everything below is about ②. Nothing in this project talks to ①.

---

## S-0 · Callback scheme — **corrected by testing**

| | |
|---|---|
| **Status** | ✅ **resolved, and the documentation is misleading on this point** |
| **First reading (wrong)** | The `oidc` guide says: *"Use HTTPS callbacks for production and sandbox. Local, test, and staging also accept registered HTTP loopback callbacks (`localhost` or a loopback IP)."* Read one way, that permits `http://localhost:3000/...` on this environment. |
| **What the portal actually does** | The registration form labels the field *"Use exact HTTPS callback URLs, one per line"*, and submitting `http://localhost:3000/api/auth/world/callback` is refused with **"Check the values and try again."** — a generic message that names neither the field nor the reason. |
| **Conclusion** | **HTTPS is required even for a loopback callback.** The "local, test, and staging" clause describes *other* deployments of the IdP, not this one. A laptop-only demo still needs TLS. |
| **Cost of getting it wrong** | The failure is at form-submission time with no field-level error, so the natural next guesses are the app name, the optional logo URL, or the auth method — none of which are the problem. |
| **Resolution in this repo** | `npm run dev:https` generates a self-signed certificate for `localhost` and starts Next with it, exporting `PRESENCE_PUBLIC_URL` and `WORLDID_REDIRECT_URI` so every absolute URL the app builds matches. Register `https://localhost:3000/api/auth/world/callback`. |
| **Why not `next dev --experimental-https` alone** | It downloads mkcert into `~/Library/Caches` (`~/.cache` on Linux). Where that path is unwritable it fails and then **silently falls back to HTTP** — which looks like success and surfaces much later as an `invalid_request` at the authorization endpoint. |
| **Browser warning** | Expected. The certificate is self-signed, so choose *Advanced → Proceed* once. Nothing about the OIDC flow depends on the certificate being trusted. |
| **Still needed for a phone demo** | a real tunnel (`cloudflared tunnel --url http://localhost:3000`), because the phone has to reach the consent screen. Note the tunnel hostname becomes the sector, so switching between `localhost` and a tunnel changes every pairwise `sub`. |

## S-1 · IdP access

| | |
|---|---|
| **Status** | ✅ confirmed |
| **Evidence** | `GET https://sandbox.auth.world.org/.well-known/openid-configuration` → `200`. `GET /docs` → `200`. `POST /mcp` → `200` with a full tool catalog. |
| **Conclusion** | the environment is up, public documentation is readable without sign-in, and the MCP integration guide is reachable. |
| **Fallback** | none needed. |

## S-2 · OIDC client registration

| | |
|---|---|
| **Status** | ⚠️ **blocked on a human step — this is the one item the build could not complete** |
| **What is required** | registration happens in a Google-authenticated portal: *"open `https://sandbox.auth.world.org/portal`, sign in with Google, and register the backend's exact callback URL"*. Google sign-in is not something this project can do on its own, and the guide is explicit that portal access is subject to per-deployment account eligibility (`account_not_eligible`). |
| **A path exists for an agent, up to a point** | the MCP server exposes `request_oidc_client_registration`, which *stages* a registration and returns a `portalUrl` for a human to approve. It answers with an `insufficient_scope` challenge for `developer-portal:manage` and requires Google sign-in — so it still ends at a person. |
| **Conclusion** | client registration is a deliberate human-in-the-loop step in this environment, by design and for good reason (the client secret is shown once and must not pass through a model). |
| **Fallback in use** | **the documented local fallback** (`worldid/local.ts`). It substitutes the *identity provider*, never the gate: a server-signed, per-attempt assertion, and every downstream check — binding, freshness, one-time consumption — runs unchanged. Responses carry `degraded: true` and the UI shows a permanent banner saying so. |
| **To complete it** | register a client, then set in `.env.local`: `WORLDID_CLIENT_ID`, `WORLDID_CLIENT_SECRET`, `WORLDID_REDIRECT_URI`, `WORLDID_TOKEN_AUTH_METHOD`. No code changes: `idpMode()` switches to `oidc` on its own. |

## S-3 · Discovery

| | |
|---|---|
| **Status** | ✅ confirmed, live |
| **Evidence** | full document at `/.well-known/openid-configuration` |
| **Endpoints** | `authorization_endpoint` `…/api/v1/authorize` · `token_endpoint` `…/api/v1/token` · `device_authorization_endpoint` `…/api/v1/device_authorization` · `jwks_uri` `…/.well-known/jwks.json` |
| **Grants** | `authorization_code`, `urn:ietf:params:oauth:grant-type:device_code` |
| **Response types** | `code` only (no implicit, no hybrid) |
| **Scopes** | `openid` — exactly one |
| **Claims** | `iss, sub, aud, exp, iat, jti, nonce, auth_time, acr, amr` |
| **`acr_values_supported`** | `https://world.org/oidc/acr/orb-v3` |
| **`prompt_values_supported`** | `none`, `login` (no `consent`, no `select_account`) |
| **`subject_types_supported`** | `pairwise` |
| **PKCE** | `S256` |
| **Client auth** | `client_secret_basic`, `client_secret_post`, `private_key_jwt` |
| **Conclusion** | the environment matches its documentation. `openid-client` v6 discovers and consumes all of it without special-casing. |

## S-4 · Fresh authentication

| | |
|---|---|
| **Status** | ✅ confirmed — **better than the TODO assumed** |
| **Evidence** | `prompt_values_supported: ["none", "login"]`; `claims_supported` includes `auth_time`; the `step-up` guide documents `max_age=N`, `max_age=0` and `prompt=login`. |
| **Implemented controls** | `max_age=N` — accept authentication no older than N seconds. `max_age=0` — "require this transaction's own fresh World proof, even with an existing browser session". `prompt=login` — require fresh proof, overrides a larger `max_age`. |
| **Conclusion** | proper RFC 9470 step-up, no fallback needed. We send `max_age` + `acr_values` and deliberately do **not** send `prompt`, so the IdP can fall back to an interactive login instead of erroring. |
| **Freshness rule adopted** | validate `auth_time`, **never** `iat`. The guide is explicit: *"Browser-session reuse preserves it and the original `acr` and `amr`; a new token's `iat` does not imply a fresh proof."* |
| **`max_age=0` semantics adopted** | *"check that authentication belongs to the newly initiated attempt (using its start time, nonce, and bounded lifetime); do not require its age to remain literally zero during the browser round trip."* Implemented as `auth_time >= approval.requested_at - 5s`. |
| **Fallback** | not needed. |

## S-5 · Device authorization grant

| | |
|---|---|
| **Status** | ✅ **available on the OIDC surface** — the TODO said "don't assume this" and the assumption would have been safe |
| **Evidence** | `device_authorization_endpoint: https://sandbox.auth.world.org/api/v1/device_authorization`, and `device_code` in `grant_types_supported` |
| **Conclusion** | the headless-agent path is native. `agent/runner.ts` uses it for real; there is no "print a link and poll" degradation. |
| **Caveat that shaped the design** | *"Device authorization supports only `scope=openid`; adding `nonce`, `max_age`, `prompt`, or `acr_values` does not provide those controls. Fresh proof is already required."* So we send none of them on this path — freshness is structural, not requested. |
| **Rate limits observed in the docs and respected in code** | starts return `429` with `Retry-After: 60`; polls return `400 slow_down` which adds 5s to every subsequent interval; `503` terminates the attempt and is **never** treated as approval. |
| **Fallback** | not needed. |

## S-6 · Pairwise `sub` and sector

| | |
|---|---|
| **Status** | ✅ confirmed |
| **Evidence** | `subject_types_supported: ["pairwise"]`. `GET /docs`: *"OIDC calls the relationship scope a sector and delivers the private identifier as the pairwise `sub` (subject) claim. The application stores the issuer and subject together to recognize the same person over time."* |
| **Sector rule** | *"Portal registrations use the redirect hostname as the immutable sector… Apps sharing a sector receive the same pairwise `sub`."* |
| **Conclusion** | the subject is stable per (service, human) and differs across services — exactly the continuity property the project needs. We store `(issuer, sub)` together and derive `continuity_id = sha256(issuer | sub)`. |
| **Documented risk** | the guide notes *"a new World identity can resolve to a new IdP account"*. So continuity is stable for an existing identity but is not a promise about a re-enrolled one. Recorded as a limitation in `INTEGRATION_DEBRIEF.md`. |
| **Fallback** | not needed. |

## S-7 · The verification surface — **and the absence of a nullifier** ⭐️

| | |
|---|---|
| **Status** | ✅ answered, and the answer is the project's most consequential finding |
| **Evidence** | `claims_supported` is `iss, sub, aud, exp, iat, jti, nonce, auth_time, acr, amr`. There is **no** `nullifier`, no `nullifier_hash`, no `proof`, no `merkle_root`, no `verification_level`. There is also no verify endpoint in the discovery document: the token endpoint *is* the verification surface, and the ID token is the result. |
| **What the TODO assumed** | an "验证 endpoint 的准确形态" — a World-ID-style endpoint you POST a proof to and receive a nullifier from. |
| **What actually exists** | OIDC. The relying party performs a code exchange and validates an ID token. |

### Consequence for RED LINE 1

On the IDKit path the IdP hands you the key:

```
nullifier = human × rp_id × action
```

Bind `action` to `buy_slot:evt_tokyo` and one-person-one-ticket falls out of the
protocol for free. The Human Continuity IdP cannot do this, because OIDC has no
notion of your application's actions.

So the relying party reconstructs it:

```ts
nullifier = sha256("presence/v1/nullifier" | issuer | sub | action | signal)
```

plus a second, belt-and-braces database constraint:

```sql
UNIQUE (bound_action, continuity_id)
```

The observable behaviour is identical to the IDKit contract:

| Scenario | Result |
|---|---|
| same human, same action | same nullifier → `PRIMARY KEY` rejects the second attempt |
| same human, different action (another event) | different nullifier → allowed |
| different human, same action | different nullifier → allowed |

And there is a genuine **upside** to deriving it ourselves: the derived key is
deterministic across processes and restarts, and it is auditable — anyone can
recompute it from the row. See `worldid/nullifier.ts`, which carries the full
explanation in a comment for whoever reads the code next.

**This difference between the IDKit contract and the OIDC contract is the single
most important integration finding of the project**, and it is reported as such
in `INTEGRATION_DEBRIEF.md`.

## S-8 · Credentials for our own API / MCP server

| | |
|---|---|
| **Status** | ⚠️ partially supported; a relying-party responsibility |
| **Evidence** | the `getting-started` guide: *"For agent experiences, the application uses the same OIDC federation, binds the issuer and subject to its own account or grant, and issues credentials for its APIs or MCP server."* And the `oidc` guide: *"The token response's opaque access token is an OIDC response artifact. It does not authorize calls to this MCP or downstream services."* |
| **Conclusion** | the IdP issues **identity**, not authorization for our API. The `oidc` guide also states it as the intended shape for headless agents: *"An ID token after fresh World proof and explicit approval; your backend issues the agent's credential."* |
| **Implemented** | `POST /api/agent/enroll` (device/consent flow → our own scoped, expiring, HMAC-signed bearer token, scopes `agent:queue`, `agent:claim`, `agent:transfer`). See `lib/agenttoken.ts`. |
| **Fallback** | this *is* the shipped design, not a degradation. |

## S-9 · Revocation

| | |
|---|---|
| **Status** | ✅ answered |
| **Evidence** | no `revocation_endpoint` in the OIDC discovery document. `/docs` lists RFC 7009 under the **MCP OAuth** surface, not the OIDC one. No refresh tokens are issued on the OIDC surface (`grant_types_supported` has no `refresh_token`). |
| **Conclusion** | there is nothing on this surface to revoke — we hold no long-lived credential from the IdP. |
| **Fallback in use** | our own credentials carry a TTL and are validated on every use (`lib/agenttoken.ts`, `lib/grants.ts`). Grants expire and can be revoked; revocation is a row update, and because nothing is cached it takes effect on the next request. |

## S-10 · Does the Developer Portal MCP cover the sandbox?

| | |
|---|---|
| **Status** | ✅ answered — **no, they are separate systems** |
| **Evidence** | `POST sandbox.auth.world.org/mcp` exposes portal tools (`request_oidc_client_registration`, `get_oidc_client`, `update_oidc_client`, …) that operate on **this** environment's portal. The general Developer Portal MCP (`developer.world.org/api/mcp`) manages Developer Portal resources, which are a different environment from `sandbox.auth.world.org`. |
| **Conclusion** | for the sandbox, the sandbox's own MCP is the right surface. `request_oidc_client_registration` there stages a registration and hands back a `portalUrl` for a human to approve. |
| **Why this matters** | the TODO asked whether an agent could complete registration without touching a dashboard. The answer is "it can stage the request, and a human still approves it" — which is the correct design for something that returns a secret exactly once. `get_team_context` is a Developer Portal tool and does not surface sandbox clients. |

## S-11 · Reusing the IdP as our MCP server's authorization server

| | |
|---|---|
| **Status** | ✅ answered — **not reusable as-is**, and the docs say why |
| **Evidence** | `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server/mcp` both exist and both describe **World ID's own** MCP resource: `resource: "https://sandbox.auth.world.org/mcp"`, `authorization_servers: ["https://sandbox.auth.world.org/mcp"]`. The `getting-started` guide: *"Do not use an OIDC client ID or secret in MCP OAuth."* And, decisively: *"An upstream World ID login alone does not implement MCP authorization."* |
| **Conclusion** | the sandbox can act as the authorization server for *its own* MCP, not for ours. Protecting our MCP server is our job, and the same guide says what that looks like: bind the issuer and subject to our own grant and issue our own credential. |
| **Implemented** | `mcp/server.ts` authenticates callers with our scoped bearer token (S-8). Tools are thin wrappers over the same `lib/` functions the HTTP routes call. |
| **Fallback** | this is the shipped design. Had the TODO's assumption held, the upgrade path would be to add RFC 9728 metadata at `/.well-known/oauth-protected-resource` on our own server and validate IdP-issued tokens — `worldid/` is the only module that would change. |

---

## Summary table

| ID | Question | Result | Fallback in use |
|---|---|---|---|
| S-0 | callback scheme | ✅ **HTTPS required even for loopback** | `npm run dev:https` (self-signed) |
| S-1 | IdP access | ✅ | — |
| S-2 | OIDC client registration | ⚠️ **human step** | **local fallback** (identity simulated, gate real) |
| S-3 | discovery | ✅ | — |
| S-4 | fresh authentication | ✅ | — |
| S-5 | device authorization grant | ✅ | — |
| S-6 | pairwise / sector | ✅ | — |
| S-7 | verify endpoint shape | ✅ **no nullifier** | reconstruct it in the RP |
| S-8 | credentials for our own API | ⚠️ RP responsibility | we issue our own |
| S-9 | revocation | ✅ none needed | local TTL |
| S-10 | Developer Portal MCP covers sandbox? | ✅ no | sandbox's own MCP |
| S-11 | reuse IdP as our MCP's AS | ⚠️ no | our own scoped token |

**Two of twelve are unresolved, and both are the same item**: registering an OIDC
client requires a person with a Google account. That is not an oversight — the
environment is designed that way, and the reason is sound (the client secret is
displayed once and must never pass through a model). Everything downstream of it
is built, tested and switched on; supplying the two credentials flips the whole
system from the local fallback to the real IdP with no code change.

---

## Deviations from the documentation

Recorded because the TODO asks for them, and because they are the raw material
for `INTEGRATION_DEBRIEF.md`.

1. **The TODO's model of the verification surface was wrong.** It assumes a
   World-ID-style verify endpoint returning a nullifier (S-7). No such endpoint
   exists on this environment. The documents do not contradict this — they simply
   describe OIDC — but a reader coming from the IDKit path will look for a
   `verify` call that is not there.

2. **`frontend / backend` split assumed by the TODO's `action` binding does not
   map cleanly.** The TODO says `action` must be bound to the purchase so the
   nullifier carries it. On this surface the nullifier is not the IdP's to carry.
   The requirement survives; the mechanism is ours. This is worth flagging
   because a team that assumed the IDKit behaviour would ship a purchase gate
   that does nothing, and would only find out under attack.

3. **`acr_values` is advisory.** *"Unsupported values do not force an error;
   validate the achieved `acr` yourself."* A naive implementation that sends
   `acr_values` and assumes the request was honoured would silently accept a
   weaker class. We validate the returned `acr` instead of trusting the request.

4. **Device grant ignores `max_age`/`prompt`/`acr_values`** and requires fresh
   proof anyway. Correct and documented, but it means the two OIDC paths need
   different freshness reasoning. Both are handled separately and commented.

5. **`prompt` accepts only `login` and `none`.** `consent`, `select_account`, and
   any combination are rejected. Most OIDC libraries default to sending
   `prompt=consent` on some flows; we override that, and the guide explicitly
   warns about library defaults (`profile`, `email`, `offline_access`,
   `prompt=consent`, `prompt=select_account`).

6. **No `UserInfo` endpoint.** *"There is no public UserInfo endpoint: read
   claims from the validated ID token."* Any tutorial that reaches for
   `client.userinfo()` will fail here.

7. **The guide's callback rules do not match the portal's.** The `oidc` guide
   reads as though HTTP loopback is acceptable here ("Local, test, and staging
   also accept registered HTTP loopback callbacks"). The portal requires HTTPS
   and refuses an `http://` callback with a generic "Check the values and try
   again." that names no field. See S-0 — this was recorded as a *wrong first
   reading*, and corrected only by submitting the form.
