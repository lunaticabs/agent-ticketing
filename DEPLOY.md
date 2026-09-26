# Deploying Presence to a public URL

**For:** a hackathon demo that strangers can try on their phones.
**Cost:** ~$3.19/month now, ~$3.69/month after Fly's 1 Oct 2026 price change
(one always-on `shared-cpu-1x`/512MB machine + a 1GB volume).
**Time:** ~40 minutes end to end, of which ~15 is waiting for builds.

---

## Why this shape, in one table

The app has three properties that decide where it can run. They are not
negotiable, and every host that fails one of them is disqualified rather than
merely worse.

| Property | Consequence |
|---|---|
| `better-sqlite3` — a native module with a **file**-backed database (WAL mode) | Rules out every serverless/edge host. GitHub Pages, Vercel, Netlify, Cloudflare Workers: no persistent filesystem, and no native bindings. |
| **One long-lived Node process** (the board polls once a second; sessions are server-side) | Rules out request-scoped runtimes. |
| A **stable public HTTPS origin** | The World ID IdP compares `redirect_uri` byte for byte, and the callback hostname is the *immutable sector* that decides every user's pairwise `sub`. A URL that changes — a laptop tunnel, a rebuilt Codespace — is a new set of identities every time. |

GitHub's own products were checked and none of them work: Pages is static-only,
Actions has no persistent disk and caps job length, and Codespaces is limited to
120 core-hours/month (≈2.5 days of 24/7) with a 30-minute **idle** timeout driven
by *your* activity rather than by visitor traffic — it dies mid-demo. Codespaces
is still the best choice for a *local* rehearsal; it is not a host.

So: one container, one volume, one machine. Fly is the cheapest place that gives
all three plus free TLS on a `*.fly.dev` subdomain.

---

## Step 0 — what only you can do

Three things cannot be automated, and one of them is a hard gate.

### 0a. Install and authenticate `flyctl`

```bash
curl -L https://fly.io/install.sh | sh
# add it to this shell (or restart the shell)
export FLYCTL_INSTALL="$HOME/.fly"
export PATH="$FLYCTL_INSTALL/bin:$PATH"
fly version
fly auth signup      # or: fly auth login
```

Fly requires a credit card on file for every organisation (there is no free tier
for new accounts; the old free allowances were retired in October 2024). A
pre-authorisation of under $10 is normal.

### 0b. Register the OIDC client — the hard gate

The callback hostname is the **immutable sector** of a client registration, and
"sector and authentication method are immutable". The existing client is
registered on `localhost`, so it cannot be pointed at `agent-ticket-demo.fly.dev`
— a public deployment needs its own registration. The side effect is worth
saying out loud: **identities start over on the new hostname.** The same phone
gets a different pairwise `sub`, so it is a different `continuity_id`. For a
fresh demo that is exactly right; it is not something to discover on stage.

1. Open **https://sandbox.auth.world.org/portal** and sign in with Google.
2. Register a client with this exact redirect URI (it matches byte for byte, and
   `path`, `query` and `port` all count):

   ```
   https://agent-ticket-demo.fly.dev/api/auth/world/callback
   ```

3. Token endpoint auth method: **`client_secret_basic`** (the portal default, and
   what `.env.example` documents).
4. Copy the **client id** and the **secret**. The secret is shown **once**.

Keep the `localhost` registration alive too — `npm run dev` and the local
rehearsal still use it. A client may hold several redirect URIs, but only within
one sector, which is why this is a second client rather than an edit.

> Secrets do not belong in a chat transcript. Put them straight into the file
> `.env.deploy.local` (gitignored) or into `fly secrets set` — see step 2.

### 0c. A signing key

```bash
openssl rand -base64 48
```

This signs sessions and local assertions. Without it the app falls back to a
deterministic development key that anyone with the source can forge, and it says
so at startup.

---

## Step 1 — deploy the machine and the volume

From the repository root. `fly.toml` is already written; the app name in it is
`agent-ticket-demo` and the region is `nrt` (Tokyo).

```bash
fly apps create agent-ticket-demo          # skip if it already exists
fly volumes create presence_data -r nrt -s 1 --app agent-ticket-demo
fly deploy --ha=false
```

**`--ha=false` is not optional.** Without it `fly launch`/`deploy` provisions two
machines, and a volume attaches to exactly one — so the second machine starts
with a fresh empty filesystem and creates a *second* database. Two machines, two
SQLite files, two divergent demos. `fly.toml` also pins
`min_machines_running = 1` and `auto_stop_machines = "off"` for the same reason:
a suspended machine makes the volume look empty to whoever visits next.

The first boot seeds itself. `instrumentation.ts` calls
`ensureDemoEventIfMissing()`, which creates the demo event **only** when there is
no seeded event at all. It cannot run at build time or in a `release_command`:
neither has the volume mounted.

```bash
fly logs --app agent-ticket-demo      # expect: "seeded the demo event (8 slots)"
```

---

## Step 2 — the secrets

Run these once. Replace the three placeholder values; keep the line breaks.

```bash
fly secrets set --app agent-ticket-demo \
  PRESENCE_PUBLIC_URL="https://agent-ticket-demo.fly.dev" \
  WORLDID_REDIRECT_URI="https://agent-ticket-demo.fly.dev/api/auth/world/callback" \
  WORLDID_CLIENT_ID="<from the portal>" \
  WORLDID_CLIENT_SECRET="<from the portal>" \
  PRESENCE_SIGNING_KEY="<openssl rand -base64 48>"
```

Setting a secret restarts the machine, which is fine — the database is on the
volume, so no state is lost.

### Why `PRESENCE_PUBLIC_URL` is set here and not in `fly.toml`

`worldid/config.ts` treats `WORLDID_REDIRECT_URI` as authoritative and derives
every other absolute URL from its origin. `PRESENCE_PUBLIC_URL` is only needed
when the two genuinely differ — behind a proxy, say. Here they agree, and setting
both means `baseUrlConsistency()` checks them against each other at startup and
`/api/health` reports the result. If they ever disagree, the app says so loudly
rather than rendering consent links that open nothing.

---

## Step 3 — verify, from the outside, before showing anyone

```bash
curl -s https://agent-ticket-demo.fly.dev/api/health | python3 -m json.tool
```

Read four fields:

| Field | Expected | If it is not |
|---|---|---|
| `idp.mode` | `oidc` | `local` means the client id/secret are missing — every screen will say identity is simulated. |
| `urls.consistent` | `true` | A mismatch means consent links point somewhere the browser cannot go. The `problem` field names it. |
| `sandbox.enabled` | `true` | Private events are off; every visitor shares one queue and the first draw closes it for everyone. |
| `event.id` | `evt_tokyo_night` | Nothing is seeded: check that the volume is mounted at `/data`. |

Then walk the participant loop once on a real phone, because no automated check
can: open the site, sign in with World ID, join the queue, wait for the draw,
press **Ask me to authorize**, approve in the World App, and watch the handover
complete. `RUN_DEMO.md` describes what each step should say.

---

## What the deployment deliberately changes about the demo

The stage build assumed one event and one operator. A public site is neither, so
two behaviours differ from `npm run dev`'s defaults — both switched by
environment, both off unless asked for.

### `ENABLE_SANDBOX=1` — one private event per visitor

Behind a cookie, each visitor gets their own event: their own 8 slots, their own
15-second draw window, their own board. Without it the first visitor's draw
closes the window for everybody else, and every later arrival gets
`queue_closed` and a finished-looking page.

What is **not** isolated, on purpose: **identity**. One World ID is one human
across the whole deployment, so the anti-sybil claim survives inside a private
event — forty accounts still collapse to two continuity ids, because that
constraint is on the human and not on the event.

Read `lib/sandbox.ts` for the full reasoning, including why the cookie is signed
(an unsigned one would make "edit the cookie, read someone else's board" a
one-line attack).

### `ENABLE_DEV_ROUTES=1` — the `/admin` demo props

This is what puts the reset button, the 24-account bot army, the 40-account
collapse and the *tell the agent to buy a ticket* button on the public site. It
is a **disclosed bypass**: `/api/dev/*` can mint simulated humans that skip
World ID entirely, and `lib/startup.ts` prints a warning at boot, the board shows
a permanent badge, and every page that offers one says what it is.

Two things make it safe to leave on:

* **Every destructive route is scoped to the caller's own event.** `resetDemo`
  refuses to touch another visitor's queue; the dev-reset route resolves the
  event from the request rather than from "the" event. This was not true before —
  an unscoped wipe in the hands of the public would clear *everyone's* state at
  once, and it is covered by tests.
* The bot army's handles are namespaced per event, because the identity table is
  global and two visitors' armies would otherwise collide on `bot-account-01`.

Two things it does **not** protect against, so you know the tradeoff:

* `/api/dev/agent` spawns a real MCP client process that waits up to 120 seconds
  for a human decision. It is capped at 200 concurrent sessions, and misuse
  exhausts CPU on a 1-CPU machine — which looks like "the site is slow", not like
  an attack.
* The dev props give a visitor real power over *their own* demo only. Nothing
  they can reach changes what another visitor sees.

Set `ENABLE_DEV_ROUTES=0` in `fly.toml` and redeploy for a participant-only site.

---

## Operating it

```bash
fly logs   --app agent-ticket-demo            # live logs
fly status --app agent-ticket-demo            # machine and health
fly ssh console --app agent-ticket-demo       # a shell on the volume
fly secrets list --app agent-ticket-demo      # names and digests, never values
```

**Rotating the World ID secret.** The portal mints a new secret alongside the old
one (overlapping), so the safe order is: create the new secret in the portal,
`fly secrets set WORLDID_CLIENT_SECRET=…`, confirm `/api/health` still reports
`oidc`, and only then revoke the old one. The guide is explicit that credential
changes take a short time to propagate.

**Resetting the public demo.** Don't. Private events expire on their own twelve
hours after they were last touched (`collectGarbage`, capped at 200 events), and
a visitor can start a fresh round from their own page. There is no global reset
on purpose — it would be a button that wipes every visitor at once.

**Rolling back.** `fly releases --app agent-ticket-demo`, then
`fly deploy --image <previous image ref>`. The volume is untouched by a rollback,
so the database survives — which also means a rollback cannot undo a schema
change. This schema has none.

---

## When something is wrong

| Symptom | Cause | Fix |
|---|---|---|
| `/api/health` says `idp.mode: "local"` | Client credentials not set, or set without `WORLDID_REDIRECT_URI` | Step 2. The screens also say so out loud. |
| Sign-in comes back `invalid_request` at the IdP | `redirect_uri` differs from the registration by so much as a trailing slash | Compare `/api/health`'s `urls.redirectUri` with the portal, character by character. |
| Every visitor sees the same queue | `ENABLE_SANDBOX` is not `1` | `fly.toml`, then redeploy. Check `sandbox.enabled` in `/api/health`. |
| The demo event is missing after a redeploy | Volume not mounted, so `/data` is container-local | `fly volumes list`; check `[[mounts]]` and `primary_region` agree. |
| `/api/health` is 200 but every page 500s with `Can't resolve 'fs'` | Something imported a database-touching module into the Edge bundle — this is what `instrumentation.ts` and the route wrapper are careful about | Look for a new static import in `instrumentation.ts`, `middleware.ts`, or anything Edge-compiled. |
| Two machines, two different boards | Provisioned without `--ha=false` | `fly scale count 1 --app agent-ticket-demo`. |
