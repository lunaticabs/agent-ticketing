# Documentation

Every Markdown document in this repository lives here, with one exception: the
root [`README.md`](../README.md), which is the project overview and the entry
point for the code.

HumanGate is verifiable authorization middleware for AI agents: the agent does the
work, but a human verified with World ID has to authorize the operation — bound to
that operation, re-verified on the server, and consumed once. Built for the World
**"Best Use of World ID for Agents"** track at ETHGlobal Tokyo 2026.

---

## Where to start

| If you want to… | Read |
|---|---|
| understand what the project is and run it | [`../README.md`](../README.md) |
| run the five-minute demo in front of an audience | [`RUN_DEMO.md`](RUN_DEMO.md) |
| narrate or film the two-minute video | [`DEMO_VIDEO_SCRIPT.md`](DEMO_VIDEO_SCRIPT.md) |
| put it on a public URL | [`DEPLOY.md`](DEPLOY.md) |
| see the evidence behind every integration claim | [`SPIKE_NOTES.md`](SPIKE_NOTES.md) |
| check what happens when authorization is refused | [`FAILURE_MATRIX.md`](FAILURE_MATRIX.md) |
| read the track's required integration retrospective | [`INTEGRATION_DEBRIEF.md`](INTEGRATION_DEBRIEF.md) |
| know why the design is shaped this way | [`plans/concept.md`](plans/concept.md) |
| know what was planned, in what order, and how it was verified | [`plans/implementation-plan.md`](plans/implementation-plan.md) |

---

## The documents

| File | What it is |
|---|---|
| [`RUN_DEMO.md`](RUN_DEMO.md) | The five-minute runbook: five beats, the pre-flight checks, the narration, and what to do when a beat goes wrong. |
| [`DEMO_VIDEO_SCRIPT.md`](DEMO_VIDEO_SCRIPT.md) | The English script for the two-minute demo video, timed shot by shot. |
| [`DEPLOY.md`](DEPLOY.md) | Deploying to a public URL end to end — the container, the volume, the OIDC client registration, and how to verify the result. |
| [`SPIKE_NOTES.md`](SPIKE_NOTES.md) | Day 0 against the live sandbox: every assumption the plan made, checked against the running deployment, with the evidence and the fallback that was adopted. Reproducible with `npm run spike`. |
| [`FAILURE_MATRIX.md`](FAILURE_MATRIX.md) | Every refusal path — authorization, freshness, replay, expiry, cancellation — with the database read that proves the protected action did not run. Produced by `npm run e2e` and `npm test`. |
| [`INTEGRATION_DEBRIEF.md`](INTEGRATION_DEBRIEF.md) | The track's required retrospective: time to first success, the friction encountered, the missing capabilities, and the single most valuable improvement. Written as a bug report. |

## `plans/` — process records

The two documents in [`plans/`](plans/) are **historical**. They were written in
Chinese before the first line of code, and were translated to English when the
documentation was moved into this directory. They are kept because they explain
the reasoning behind the design and the order in which it was built — not because
they describe the shipped system.

| File | What it is |
|---|---|
| [`plans/concept.md`](plans/concept.md) | The original design plan: the problem, the proposed shape, the competitive analysis, the red lines, and the risks. |
| [`plans/implementation-plan.md`](plans/implementation-plan.md) | The original build plan: stack decisions, data model, state machine, the task list with acceptance criteria, and the Day 0 questions. |

Both carry a **scope-reduction note** at the top recording what changed during the
build — most of all that the allocation-transfer (resale) layer was cut, leaving a
single `locked` mode. Where these documents disagree with the code or with the
root [`README.md`](../README.md), the code and the README win.
