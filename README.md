# IIoT Boiler Guardian

Anomaly detection for industrial boilers where every interaction is recorded on Hedera.
Sensor readings, the analysis derived from them, and the decisions humans take on that
analysis are all messages on Hedera Consensus Service topics — so the reasoning behind any
alarm can be reconstructed from the chain alone.

```
simulator ──1 Hz frames, device key──► HCS telemetry topic
                                            │ gRPC mirror subscription
                                            ▼
                          pipeline: L1 statistical → L2 temporal
                                            │ events + feature vector
                                            ▼ (gated)
                                   L3 Haiku classification
                                            │ agent key
                                            ▼
                                    HCS analysis topic
```

## The four layers

1. **Statistical** (`src/pipeline/statistical.ts`) — hard limits, rolling z-score, and the
   physics residual `t − tSat(p)`, which catches a temperature/pressure pair that
   contradicts the steam tables while both readings are still inside their limits.
2. **Temporal** (`src/pipeline/temporal.ts`) — least-squares slope, time-to-threshold
   forecasting, and flatline detection. A rolling z-score is blind to a steady ramp, so
   this is where early warning actually comes from.
3. **SLM** (`src/pipeline/classifier.ts`) — Claude Haiku 4.5 classifies the boiler's
   condition from the feature vector alone, never raw telemetry. A guardrail lets it raise
   severity but never lower a deterministic CRITICAL.
4. **Human in the loop** — an operator decides on each report from the dashboard, and the
   decision is published to the decisions topic signed with an operator key. The worker
   subscribes to that topic and acts on it: an acknowledgement quiets reporting for 15
   minutes, a false positive for 30, and neither silences the detectors — events keep
   reaching the analysis topic, and a rise in urgency breaks through the silence anyway.
   Escalations and shutdown requests are recorded and never suppress anything.

When a classification reaches urgency 3 or above, a Sonnet-written incident report
(`src/pipeline/reporter.ts`) goes to the reports topic — body and SHA-256 together, carried
on chain in HCS chunks rather than in an off-chain store.

## Setup

```bash
npm install
cp .env.example .env     # fill in ACCOUNT_ID, PRIVATE_KEY, ANTHROPIC_API_KEY
npm run setup:topics     # creates the four topics, prints the rest of the .env block
```

Each topic enforces its own submit key: telemetry accepts only the device key, analysis
only the agent key, decisions only operator keys. The operator account pays all fees.

This separation is the point of the decisions topic: the analysis worker does not hold the
operator key, so a decision on chain is evidence a human acted rather than software
claiming one did. Verified — the agent key is rejected with `INVALID_SIGNATURE`.

**Prototype limitation:** the operator key currently lives in `.env` and the dashboard
signs server-side, so a decision proves "someone with operator authority on this
deployment", not "this named person". Real non-repudiation means the operator signing in
their own wallet (`hedera-wallet-connect` / HashPack), which replaces only the signing step
in `web/app/api/decision/route.ts` — the message, the topic, and the worker are unchanged.

## Running

`make help` lists every target. The common ones, in two terminals:

```bash
make pipeline                       # the worker: subscribe, analyse, report
make sim FAULT=low_water            # a boiler, with a fault injected
```

Start the pipeline first — it subscribes from "now" unless given `FROM=<seconds>`.

| Target | Purpose |
|---|---|
| `make sim` | simulator → telemetry topic (`FAULT`, `START`, `DURATION`, `SEED`, `RATE`) |
| `make sim-dry` | simulator with no chain writes, frames to stdout |
| `make pipeline` | analysis worker (`FROM=600` to replay history first) |
| `make pipeline-cheap` | worker with layers 1–2 only, no model calls |
| `make dashboard` | the dashboard at http://localhost:3100 |
| `make e2e` | worker + one fault + on-chain verification, end to end |
| `make decide` | publish a decision (`REPORT=<id> ACTION=ACKNOWLEDGE`) |
| `make verify` | read the topics back from the mirror node |
| `make topics` | create the HCS topics |
| `make typecheck` / `make test` | tsc + dashboard build / vitest |

Faults: `overpressure`, `o2_collapse`, `sensor_flatline`, `tube_rupture`, `low_water`.
Every target is a wrapper over the npm scripts, which still work directly if you prefer
them (`npm run sim -- --fault low_water --start 30`).

## Dashboard

`web/` is a Next.js app deployable to Vercel. It reads the topics through the mirror node's
REST API and shares the schemas and steam tables with the pipeline, so there is one
definition of a telemetry frame. It holds no connection to the simulator or the worker —
everything it renders is what the chain can prove.

```bash
npm run web     # http://localhost:3100, reads TOPIC_* from .env
```

Live sensor charts (one measure per chart — never twin axes), the temperature-vs-pressure
combination plot with the saturation curve drawn through it, the detector event feed, and
the incident reports with their on-chain hashes.

## Documentation

- [`docs/e2e-test.md`](docs/e2e-test.md) — how to run the end-to-end test, and a
  layer-by-layer walkthrough of the `low_water` case with real measured values.
- [`PLAN.md`](PLAN.md) — architecture and the remaining milestones.

---

# Why this exists: the ANCHOR problem

Physical AI is being built on an assumption that is not a law of physics: **that the network
is there.** Foundation models for robotics are served from datacenters. Predictive-maintenance
platforms stream telemetry to a central historian. Fleet autonomy assumes continuous policy
updates. Each degrades from intelligent to inert when backhaul drops — and in American plants,
yards, and depots, backhaul drops routinely.

The loss is not only capability. **It is evidence.** During an outage there is no trustworthy
account of what a machine sensed, what an agent decided, or what a human approved. Operators
respond rationally by refusing to automate anything consequential wherever connectivity is
unreliable. That refusal describes a large share of U.S. industrial capacity.

ANCHOR makes disconnection a *governed operating mode* rather than a failure: edge agents that
continue to act inside a bounded policy envelope while partitioned, and a tamper-evident record
of sensing, decision, approval, and command that merges without silent contradiction when
connectivity returns. Today the choice under partition is halt or act blind. In the end state,
autonomous authority narrows on a published, auditable schedule as partition lengthens and
model confidence falls, and reconnection is a **classified merge** rather than a forensic
reconstruction.

**Four layers, one loop. The loop is the contribution — no layer alone is novel.**

```
sense → infer on-box → act or gate → log immutably → reconcile
```

**Non-goals.** Not manipulation or dexterity research. Not a radio or network product. Not a
distributed-ledger company. Not incremental improvement to cloud predictive maintenance. Not a
testbed.

## Where this prototype sits on the loop

This repository is a working instance of **three of the five stages, under the connected
assumption** — which is to say it is a concrete artifact of exactly what has to become
partition-tolerant, not a demonstration that the problem is solved.

| Stage | What ANCHOR requires | This prototype |
|---|---|---|
| **Sense** | heterogeneous OT assets emitting attributable readings | one simulated boiler, three sensors, device-keyed frames at 1 Hz |
| **Infer on-box** | inference that survives partition | layers 1–2 are deterministic and local; **layer 3 is a cloud API call** |
| **Act or gate** | authority that narrows on a defined schedule | gates only, and never actuates; **authority is static** |
| **Log immutably** | tamper-evident record of sense/decide/approve/command | HCS topics with consensus order, running hash, per-role submit keys — **but only while connected** |
| **Reconcile** | classified merge of histories with irreversible side effects | **absent** |

What it does establish, end to end and verifiable by a third party: every reading, every
detector event, every classification, every incident report, and every human decision is on a
public ledger, each derived record naming the telemetry range it came from, and the roles are
cryptographically separated — the analysis agent cannot forge an operator approval, and the
attempt fails with `INVALID_SIGNATURE`. That is the evidentiary property ANCHOR needs, proven
under connectivity.

---

# What the prototype does not cover

Five gaps, in rough order of how badly each would fail in the field.

## 1. The immutable log is itself a network dependency

This is the sharpest irony in the current design, and worth stating plainly: **the evidence
disappears exactly when the evidence matters most.** Every guarantee here — ordering, tamper
evidence, attribution — is delivered by reaching `testnet.mirrornode.hedera.com`. Under
partition there is no consensus timestamp, no running hash, and no record at all. An operator
who distrusts automation during an outage is, against this build, correct.

Worse, the code does not merely fail to record — **it actively discards evidence under
backpressure.** `src/simulator/run.ts:95` drops telemetry frames once 20 submissions are in
flight, and `PublishQueue` in `src/pipeline/run.ts:50` counts a failed publish and moves on.
Both are defensible against transient congestion and indefensible against a partition: a
15-minute outage silently produces a hole in the record with no marker that anything was lost.

**What it would take.** Invert the relationship between the local log and the ledger. The
authoritative record becomes a local append-only, hash-chained WAL, signed by the device or
agent key at the edge — every entry carrying the hash of its predecessor, so the chain is
tamper-evident with no network at all. Connectivity becomes a *notarization* channel rather
than the log itself: on reconnect, anchor a Merkle root of the accumulated segment to HCS, so
one on-chain message proves the integrity of thousands of offline entries. The ledger then
attests to a record it did not have to carry, and cost stops scaling with sample rate. The
prototype's per-message model is the right shape for a 1 Hz boiler with a good link and the
wrong shape for a partitioned cell.

## 2. Inference is not on-box

`src/pipeline/classifier.ts` calls the Anthropic API. Layers 1 and 2 — hard limits, z-scores,
the physics residual, slopes and forecasts — are pure local functions and would keep running on
an unplugged box, which is the half that produces the earliest warnings. But the layer that
*names* the condition and assigns urgency is a network round trip, so under partition the
system degrades to unlabelled anomaly scores with no state and no recommended action.

**What it would take.** The `Classifier` interface already exists as the seam; a partition-
tolerant build swaps `HaikuClassifier` for a quantized small model [use slm, llama, mistral-7b moe, ollama] running on the edge box
(3–8B class, llama.cpp or similar) with the same structured-output contract. The harder part is
not serving the model, it is **calibration**: ANCHOR's authority schedule narrows as *model
confidence* falls, which requires a confidence signal that means something. The current
`confidence` field is a number the model asserts about itself, validated for range and nothing
else. Making it load-bearing means measuring it against labelled outcomes — which the simulator
can generate, since it knows ground truth — and treating a local model's confidence as a
distinct, separately-calibrated quantity from the hosted one's.

## 3. There is no action-authority envelope

The prototype gates rather than acts, which matches ANCHOR's "act or gate" only in the trivial
direction: it never actuates anything, so it never needs to decide whether it *may*. Its gating
is static — urgency ≥ 3 reports, a 300-second cooldown, an operator acknowledgement quiets
reporting for 15 minutes. None of it is a function of connectivity, elapsed partition, or
confidence. Nothing narrows.

**What it would take.** A policy envelope as a first-class, versioned, signed artifact — itself
published to a topic so the authority an agent claimed at time T is auditable after the fact.
It has to be expressive enough to be useful and checkable enough to be trusted: a declarative
form over asset class, action class, bounds, and preconditions, evaluated locally, rather than
code. Then the decay schedule: authority as a function of partition duration and calibrated
confidence, published in advance so an operator knows what the cell will do in hour three of an
outage *before* the outage. The guardrail in `guardrail()` — deterministic findings outrank the
model, severity can be raised but never lowered — is the right instinct at one-hundredth of the
required scope.

## 4. Reconciliation does not exist, and total order is not merge semantics

Nothing in this codebase reconciles anything, because with a single connected writer there is
nothing to reconcile. Worth separating two things that look alike:

- **Total order**, which HCS gives for free: every message gets a consensus timestamp and a
  sequence number, so "what happened, in what order" is settled and tamper-evident.
- **Merge semantics**, which it does not give: when two partitioned peers each took a physical
  action that the other's history contradicts, ordering tells you which was timestamped first
  and nothing about which should stand. The steam is already in the drum.

**What it would take.** The conflict taxonomy and resolution calculus ANCHOR names as Phase 0
deliverables — frozen before measurement, precisely because a taxonomy invented after seeing
the data proves nothing. Concretely for a system like this: what *is* a conflict when one peer
acknowledged an incident and another escalated it during the same partition; when two agents
independently classified overlapping telemetry ranges and disagreed; when an approval was
granted against a report whose underlying readings the other side never saw. The prototype's
`ref` field — every derived record naming the telemetry range it was computed from — is the
primitive such a calculus would key on, which is a real if small head start: provenance is
already explicit rather than reconstructed.

## 5. One asset class, a bespoke schema, and no commands

`src/shared/schemas.ts` is deliberately narrow: one boiler, three sensors, hand-rolled JSON
carrying a `v: 1` version tag. ANCHOR's third barrier is a common event and action schema
across machine tools, automated test equipment, and AGVs — three asset classes, not thirty, and
extending established manufacturing interoperability standards rather than competing with them.
This schema does neither; it is a prototype's shape, not an interoperability layer.

It is also **sense-and-decide only**. The record covers sensing, inference, approval — but
ANCHOR's record covers *command*, and there are no commands here because nothing actuates. That
is the honest boundary of the safety claim below, and it is also the missing quarter of the
evidentiary model.

**What it would take.** Map the event model onto MTConnect (the natural fit for machine tools)
and OPC UA information models, with the bespoke schema retained only as an internal
representation. Add a command record type with the same provenance discipline the analysis
records already have: what was commanded, by whose authority, against which policy envelope
version, with what preconditions observed at the time.

---

## Scope of the safety claim

This is a monitoring and audit system, not a safety system. It never actuates plant equipment,
and it does not replace hard-wired interlocks or pressure relief valves. Every escalation path
in it terminates at a human. That constraint is deliberate and survives into the ANCHOR end
state: an authority envelope that narrows under partition is a bound on what software may
*propose and execute within policy*, never a substitute for the physical protection layer that
must hold when all of it is wrong.
