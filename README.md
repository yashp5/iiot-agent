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
4. **Human in the loop** — operators sign decisions with their own wallet onto the
   decisions topic. *(Not yet implemented.)*

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

## Running

```bash
npm run pipeline                                         # the worker: subscribe and analyse
npm run sim -- --duration 120 --fault low_water --start 30   # a boiler, with a fault
```

Start the pipeline first — it subscribes from "now" unless given `--from <seconds>`.

| Script | Purpose |
|---|---|
| `npm run sim` | boiler simulator → telemetry topic (`--dry-run` for no chain) |
| `npm run pipeline` | analysis worker (`--no-slm`, `--dry-run`, `--from`) |
| `npm run setup:topics` | create the HCS topics |
| `npm run web` | the dashboard at http://localhost:3100 |
| `npm run build` / `npm test` | compile / vitest |

Faults: `overpressure`, `o2_collapse`, `sensor_flatline`, `tube_rupture`, `low_water`.

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

## Note on scope

This is a monitoring and audit system, not a safety system. It never actuates plant
equipment, and it does not replace hard-wired interlocks or pressure relief valves.
