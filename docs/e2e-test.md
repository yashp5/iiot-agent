# End-to-end test

Exercises the whole system against Hedera testnet: a simulated boiler publishes telemetry
to a consensus topic, a worker subscribes to that topic, runs three analysis layers, and
publishes what it finds back to another topic. Nothing passes between the two processes
except messages on chain.

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

## Prerequisites

- `.env` with `ACCOUNT_ID`, `PRIVATE_KEY`, `DEVICE_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, and
  the four `TOPIC_*` ids. Run `npm run setup:topics` once if the topics do not exist yet.
- Testnet HBAR in the operator account. A full run costs roughly 130 messages, about
  $0.013 equivalent.
- The operator account pays every fee, but each topic enforces its own submit key:
  telemetry accepts only `DEVICE_PRIVATE_KEY`, analysis only the agent key.

## Running it

Two processes. Start the pipeline **first** — by default it subscribes from "now", so
anything published before it starts is not seen.

```bash
# terminal 1 — the worker
npm run pipeline

# terminal 2 — the boiler, once the worker prints "watching telemetry topic"
npm run sim -- --duration 120 --fault low_water --start 30
```

Stop the pipeline with Ctrl-C when the simulator finishes; it drains any queued writes
before exiting and prints a summary:

```
frames=120 events=9 classifications=2 gaps=0 publishFailures=0
```

Useful variations:

| Flag | Effect |
|---|---|
| `npm run pipeline -- --from 3600` | replay the last hour of telemetry before going live |
| `npm run pipeline -- --dry-run` | analyse and print, publish nothing |
| `npm run pipeline -- --no-slm` | layers 1 and 2 only, no Anthropic API calls |
| `npm run sim -- --dry-run` | print frames to stdout instead of the chain |
| `npm run sim -- --rate 100` | run 10× faster than wall clock (1 tick is still 1 simulated second) |

## The test case: `low_water`

`low_water` is the scenario worth running by default, because it is the one a
conventional per-sensor alarm cannot catch in time.

**What the simulator does.** At `--start`, water level begins dropping, so heating surfaces
are exposed and superheat the steam: reported temperature rises 0.4 °C/s while the burner
and steam demand are untouched. Drum pressure therefore stays flat at about 10 bar.

**Why that is dangerous and hard to see.** For the first 40 seconds every individual
reading is inside its limits — pressure is perfect, temperature is merely "a bit high",
oxygen is normal. A threshold alarm on any single sensor stays silent. But in a saturated
drum, temperature and pressure are bound together by the steam tables: at 10 bar the drum
should read about 180 °C. Temperature climbing while pressure does not means the two
readings contradict each other physically, and that is only visible if something compares
them. `physicsResidual` is that check: `t − tSat(p)`.

**What each layer should contribute:**

| Layer | Detection | Why it matters here |
|---|---|---|
| L2 temporal | `runaway` on `t` at about t+11s | earliest signal; the slope is abnormal long before the value is |
| L1 statistical | `physics_residual` WARN at about t+17s, CRITICAL at t+39s | the diagnosis — temperature has decoupled from pressure |
| L1 statistical | `hard_limit` on `t` at about t+41s | when a conventional alarm would finally fire |
| L3 SLM | `LOW_WATER_RISK`, urgency 5 | names the cause and rules out the alternatives |

Note what layer 1 does *not* produce: no z-score event. A steady ramp is invisible to a
rolling z-score, because the window mean climbs along with it. That is why the temporal
layer exists.

The classification is the part to read closely. A correct one cites the decoupling, not
just the temperature — for example:

> *Pressure flat (slope 0.0005 bar/s) while temperature soars confirms water-level loss,
> not load increase.*

Rising temperature **with** rising pressure is normal saturated behaviour under load. The
model has to distinguish those two cases, and the feature vector gives it what it needs to:
`slope.p` near zero alongside a large `residualC`.

## Layer-by-layer walkthrough (`low_water`)

All numbers below come from a deterministic replay with `--seed 42` and `--start 30`, so
`npm run sim -- --dry-run --fault low_water --start 30 --duration 140 --seed 42` reproduces
the frames exactly, and feeding them through the two layers reproduces the rest.

### Stage 1 — what the simulator generates

The simulator keeps two things apart: the **true physical state** and the **reported
reading**. A sensor fault distorts the second while the first carries on, which is the only
way faults like a frozen transmitter can be expressed at all.

For `low_water`, the fault sets one field: `superheatC` grows by 0.4 °C per simulated
second. Nothing else is touched — the burner, the steam demand and the air damper are all
left exactly as they were. Reported values are then derived per tick:

```
trueT = tSat(pBar) + superheatC      reported t  = gaussian(trueT, 0.4) rounded to 0.1
trueO2 = 21·(λ−1)/λ                  reported p  = gaussian(pBar, 0.03) rounded to 0.01
                                     reported o2 = gaussian(trueO2, 0.08) rounded to 0.01
```

Because pressure is an energy balance (`dP/dt = k·(firing − load)`) and the fault touches
neither term, pressure simply stays at its setpoint. That is the whole scenario: **one
variable moves, and it is not the one an operator watches.**

| Sim time | superheat | true t | reported frame | tSat(p) |
|---|---|---|---|---|
| baseline | 0.0 | 180.0 | `t=179.4 p=10.01 o2=2.79` | 180.1 |
| t+5s | 2.0 | 182.1 | `t=181.4 p=10.02 o2=2.71` | 180.2 |
| t+11s | 4.4 | 184.5 | `t=184.0 p=9.96 o2=2.78` | 179.9 |
| t+17s | 6.8 | 186.9 | `t=186.8 p=9.99 o2=2.59` | 180.1 |
| t+39s | 15.6 | 195.7 | `t=195.9 p=9.93 o2=2.86` | 179.8 |
| t+71s | 28.4 | 208.5 | `t=208.4 p=10.06 o2=2.67` | 180.4 |

Pressure never leaves 9.93–10.06 bar. Temperature climbs 29 °C. Oxygen is untouched.

### Stage 2 — layer 1, the statistical layer

Layer 1 sees one frame at a time against a 60-sample rolling window. Three checks run:

**Hard limits** — silent until t+39s. Temperature only crosses its 195 °C limit then, and
pressure never crosses anything. For 39 seconds a conventional per-sensor alarm has nothing
to say.

**Z-score** — never fires at all, and this is the instructive part:

| Sim time | z.t | sd.t |
|---|---|---|
| t+5s | 2.00 | 0.59 |
| t+11s | 2.71 | 1.23 |
| t+17s | 2.57 | 2.13 |
| t+39s | 1.99 | 5.33 |
| t+71s | 1.70 | 6.90 |

The z-score peaks early and then *falls* while the boiler gets steadily worse. A sustained
ramp pulls the window mean up behind it and inflates the window's standard deviation from
0.59 to 6.90, so the latest reading never looks unusual relative to its own recent history.
A rolling z-score is structurally blind to the trend it is sitting on.

**Physics residual** — `t − tSat(p)`, and the one check that tracks the fault:

| Sim time | residual | severity |
|---|---|---|
| t+5s | 1.20 | — |
| t+11s | 4.06 | — (below the 5 °C threshold) |
| t+17s | 6.73 | WARN |
| t+37s | ~15 | CRITICAL |
| t+71s | 28.03 | CRITICAL |

This is a two-sensor comparison, so it needs no history and no warm-up: at 10 bar the drum
must read about 180 °C, and anything else means the two readings disagree with physics.
It reaches WARN 22 seconds before the temperature limit does.

### Stage 3 — layer 2, the temporal layer

Layer 2 runs a 30-sample window and computes a least-squares slope per sensor:

| Sim time | slope.t (°C/s) | slope.p (bar/s) | forecast |
|---|---|---|---|
| t+5s | 0.0227 | 0.0002 | 599 s — beyond the horizon, ignored |
| t+11s | 0.1228 | −0.0007 | 90 s → `runaway:t` |
| t+17s | 0.2548 | −0.0007 | 32 s |
| t+39s | 0.4025 | −0.0006 | already past 195 °C |
| t+71s | 0.4053 | 0.0005 | already past |

The slope converges on 0.4 °C/s, recovering the fault's actual rate from noisy, rounded
readings. `slope.p` stays within ±0.0007 bar/s — statistically indistinguishable from zero.

Two guards keep this honest. A trend is only a `runaway` if it is both fast enough
(≥ 0.05 °C/s) **and** forecast to reach a limit within 900 s; at t+5s the slope is real but
the forecast is 599 s away, so nothing is emitted. And once temperature passes 195 °C there
is no future crossing to forecast, so the event switches to "already past 195" rather than
disappearing.

**First detection is `runaway:t` at t+9s — 30 seconds before any hard limit.**

Events are then debounced (3 consecutive breaches) and rate-limited (30 s cooldown per
detector and sensor), which is why the t+11s and t+71s rows show live patterns but no new
events: the condition is unchanged and already reported.

### Stage 4 — the feature vector handed to the classifier

Layer 2 assembles both layers' output into one compact record. This is the **entire** input
the model receives — no raw telemetry:

```
boiler: boiler-01
window: 40 samples, telemetry seq 11-40
mean:  t=180.49 p=9.99 o2=2.76
sd:    t=1.015 p=0.029 o2=0.074
z:     t=3.06 p=-0.47 o2=-1.49
slope/s: t=0.0871 p=-0.0004 o2=-0.0013
residualC: 3.62
patterns: runaway:t
timeToThresholdSec: 131

events this window:
- WARN runaway on t: t +0.087 °C/s → 195 in 131s
```

Two design points. The vector carries signals nothing flagged — `slope.p`, `z.o2`,
`sd` — because ruling a cause **out** needs the quiet sensors as much as the loud one. And
`ref` (here seq 11–40) ties the record to exact telemetry frames on chain, so any verdict
downstream is traceable to raw readings.

### Stage 5 — how the classifier reads it

Given the vector above, at t+9s:

> **`EFFICIENCY_LOSS`, urgency 3, confidence 0.72**
> *Reduce fuel input immediately and verify water level, then inspect furnace air/fuel control.*
> - Temperature rising at +0.087°C/s with runaway pattern; will reach 195°C in 131s
> - Residual 3.62°C above saturation indicates slight decoupling from pressure
> - O2 at 2.76% is near lower combustion limit; borderline incomplete combustion risk
> - Pressure stable at 9.99 bar with negligible drift

Appropriately hedged: a 3.6 °C residual is real but small, and the model says so rather
than escalating. Note it already mentions water level in the action.

At t+71s, with `residualC: 28.03` and `slope.t: 0.4053`:

> **`LOW_WATER_RISK`, urgency 4, confidence 0.92**
> *Reduce firing immediately and verify boiler water level by independent measurement.*
> - residualC=28.03°C indicates temperature significantly above saturation for 10 bar pressure
> - t rising at 0.4053°C/s with runaway pattern suggests sustained deviation from equilibrium
> - mean t=196.68°C vs tSat(10 bar)≈179.9°C points to exposed superheating surfaces
> - o2=2.75% near lower combustion limit adds secondary risk but not primary driver

The discrimination that matters is in the third and fourth lines. Rising temperature alone
has several explanations — higher load, higher firing, low water. The model separates them
using the sensor that *didn't* move: pressure flat while temperature climbs excludes a load
change, because in a saturated drum those move together. It also explicitly demotes the
low-oxygen reading to a secondary concern rather than chasing it.

The layers stay in charge of severity. `guardrail()` in `classifier.ts` raises urgency to at
least 4 when any CRITICAL event is present and replaces a `NORMAL` verdict outright, so the
model can escalate a deterministic finding but never talk one down. In the live run the same
late window scored urgency **5** rather than 4, because that window carried CRITICAL events
and the guardrail lifted it.

### Summary of the chain

| Stage | Produces | For `low_water` |
|---|---|---|
| simulator | reported frames | `t` climbs 29 °C, `p` flat, `o2` normal |
| L1 hard limits | breaches | silent until t+39s |
| L1 z-score | per-sensor anomaly | never fires — blind to a ramp |
| L1 residual | two-sensor physics check | WARN t+17s, CRITICAL t+37s |
| L2 slope | trend and forecast | `runaway:t` at **t+9s** |
| L2 vector | numeric summary | residual + slopes + patterns |
| L3 SLM | named condition | `EFFICIENCY_LOSS` → `LOW_WATER_RISK` |
| guardrail | severity floor | urgency ≥ 4 whenever a CRITICAL exists |

## Verifying on chain

Nothing above is trusted from the console output — the chain is the record.

```bash
export $(grep -E '^TOPIC_' .env | xargs)
MIRROR=https://testnet.mirrornode.hedera.com/api/v1
```

**Telemetry landed, in order, at 1 Hz:**

```bash
curl -s "$MIRROR/topics/$TOPIC_TELEMETRY/messages?limit=5&order=desc" \
  | jq -r '.messages[] | "\(.consensus_timestamp) hcs#\(.sequence_number) \(.message|@base64d)"'
```

The device's own `seq` inside each payload should equal the HCS `sequence_number`, and
consensus timestamps should be about 1 s apart. Measured latency from reading to consensus
is roughly 280–750 ms.

**Analysis messages, in detection order:**

```bash
curl -s "$MIRROR/topics/$TOPIC_ANALYSIS/messages?limit=25&order=desc" \
  | jq -r '[.messages[] | (.message|@base64d|fromjson) as $m
            | "hcs#\(.sequence_number)  \($m.kind)  \($m.severity // ("urgency=" + ($m.urgency|tostring)))  ref=\($m.ref.from)-\($m.ref.to)  \($m.method // $m.pattern // $m.state)"]
           | reverse | .[]'
```

Severity should never appear to go backwards. The pipeline serialises its writes for
exactly this reason, so HCS order matches detection order.

**The audit trail resolves.** Every derived message carries `ref`, the telemetry sequence
range it was computed from. Take the `ref` of a classification and fetch those frames:

```bash
curl -s "$MIRROR/topics/$TOPIC_TELEMETRY/messages?limit=200&order=desc" \
  | jq -r '[.messages[] | (.message|@base64d|fromjson) as $m
            | select($m.b=="boiler-01" and $m.seq >= 72 and $m.seq <= 101)
            | {seq: $m.seq, t: $m.t, p: $m.p}] | sort_by(.seq) | .[0], .[-1]'
```

For the `low_water` run this returns temperature climbing (196.5 → 207.7 °C) while
pressure holds flat (9.94 → 10.01 bar) — the raw evidence behind the verdict, readable by
anyone with the topic id and no access to either process.

## Other scenarios

Same command, different `--fault`:

| Fault | Signature | Primary detector |
|---|---|---|
| `overpressure` | pressure ramps +0.022 bar/s toward MAWP while the controller's transmitter is stuck | `runaway` on `p`, then `hard_limit` |
| `o2_collapse` | air damper drifts closed, O₂ falls to 0 over 60 s | `runaway` then `hard_limit` on `o2` |
| `tube_rupture` | steam escapes, pressure falls −0.03 bar/s | `zscore`, then `runaway` on `p` and `t` |
| `sensor_flatline` | temperature transmitter freezes at its last value | `flatline` — nothing else sees it |
| `low_water` | temperature decouples from pressure | `physics_residual` |

`sensor_flatline` is the useful contrast case: layer 1 produces **zero** events, correctly.
A frozen sensor in a steady-state boiler contradicts nothing, so only "the variance is
exactly zero" identifies it.

## Troubleshooting

**Pipeline sees no frames.** It was started after the simulator. Restart it, or use
`--from 300` to replay.

**`INVALID_SIGNATURE` from the simulator.** Telemetry is signed with `DEVICE_PRIVATE_KEY`,
which must match the telemetry topic's submit key:

```bash
curl -s "$MIRROR/topics/$TOPIC_TELEMETRY" | jq '.submit_key.key'
```

Note that a submit-key failure happens at **consensus**, not precheck, so a plain
`execute()` still succeeds. Only the receipt reveals it — which is why the simulator's
"submitted" count means "passed precheck", and the pipeline's `gaps` counter is the real
check that frames landed.

**No events for the first 30 seconds.** Expected. Layer 1 needs 30 samples before its
statistics mean anything and layer 2 needs 15; `--start 30` gives the window time to fill
with clean data first.

**Classifier errors.** `output_config` schemas reject `minimum`/`maximum` on numeric types;
bounds live in field descriptions and are clamped in `guardrail()`. The model id is
`claude-haiku-4-5` with no date suffix.

**Test data is permanent.** Topics are append-only, so every run stays on the topic
forever, including boiler ids used in one-off tests. Pick boiler ids deliberately.
