# IIoT Boiler Guardian — plan for a Hedera-anchored anomaly agent

-----------------------------------------------------------------
TODO:
real time data: temperature, pressure, oxygen
every tx goes through the chain
industries: temperature control -> boiler -> sensors (temp, pressure, oxygen) -> combination plot -> catostrophic failure
-> outlier -> pattern -> time series (second layer) -> slm -> (classify boiler) -> report -> human in the loop
all interaction should be through blockchain
concern: trade data -> not http -> websockets ? telemetry data
1. hosted vercel
1. statistical layer
2. temporal layer time series: time series
3. slm small language model
4. human in the loop
-----------------------------------------------------------------

## Context

`main.ts` is currently a proof-of-concept Hedera Agent Kit + LangGraph + Claude agent. It checks a balance and creates an HCS topic. The TODO at `main.ts:166-182` describes the real product. Boiler sensors (temperature, pressure, O₂) stream in real time. Each reading goes through four layers: statistical outliers → temporal patterns → SLM classification of boiler state → a report reviewed by a human. The aim is to catch conditions that lead to catastrophic failure early. **Every interaction is recorded on the Hedera chain**, and the dashboard is hosted on Vercel.

Decisions made:
- **Data source:** a physics-based simulator with fault injection. It is pluggable, so real MQTT/Modbus hardware can replace it later.
- **SLM:** Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) returning structured JSON. The existing Sonnet agent (`claude-sonnet-5`) writes the reports.
- **On-chain granularity:** 1 Hz. Each second produces one HCS message per boiler with all 3 readings.

---

## Part 1 — Concepts

### 1.1 Why Hedera Consensus Service (HCS) is the "chain" for telemetry
- **HCS topics** are append-only, ordered message logs. Each message gets a **consensus timestamp**, a **sequence number** and a **running hash** that chains it cryptographically to every earlier message. That gives you tamper evidence and ordering without writing a smart contract.
- **Cost and limits:** about $0.0001 per message. Messages are at most 1024 bytes; the SDK can chunk up to 20 chunks. Finality is about 3–5 s. The network handles thousands of TPS. At 1 Hz per boiler that is roughly $8.64 per boiler per day, so it is viable.
- **Submit keys:** a topic can require a specific key (or a threshold KeyList) to post. That is how "all interaction through blockchain" also becomes access control:
  - `telemetry` topic → only the device/gateway key can submit.
  - `analysis` / `reports` topics → only the agent key.
  - `decisions` topic → only operator keys (for example a 1-of-N or 2-of-3 threshold key).
- **Identity:** each boiler gateway has its own Hedera account and key, so every reading is attributable to a device.

### 1.2 Your "not HTTP — websockets?" concern (how the data flows)
- **Writing** to the chain uses the SDK's gRPC (`TopicMessageSubmitTransaction`). It is not REST.
- **Reading in real time:** mirror nodes offer a **gRPC streaming subscription** (`TopicMessageQuery.subscribe`). It is a persistent push stream, which is the protocol-level equivalent of a websocket. The pipeline worker uses it.
- **Browsers can't speak raw gRPC.** The dashboard reads the chain through the mirror node REST API (`/api/v1/topics/{id}/messages?timestamp=gt:<last>`), polling every 1–2 s. Consensus already takes about 3 s, so polling adds almost no latency, and the chain stays the only source of truth.
- **Vercel constraint:** serverless functions are short-lived and can't hold long gRPC or websocket connections. So:
  - **Vercel hosts** the Next.js dashboard, the report viewer and the human-in-the-loop approval UI.
  - **A long-running worker** (Railway/Fly/Render/a VM, or an edge box next to the boiler) runs the simulator/gateway and the analysis pipeline.
  - Vercel and the worker never talk to each other directly. **They only communicate through HCS topics.** That meets "all interaction through blockchain".

### 1.3 Boiler domain: why these three sensors, and the "combination plot"
- **Temperature and pressure are physically coupled.** In a steam drum, saturated steam follows the steam tables: pressure rises with temperature along a known curve. If pressure rises and temperature does not (or the reverse), that points to a sensor fault, a blocked safety valve, or non-condensable gas. Any single sensor can look normal while the *pair* is wrong. That is why the combination plot (a temp-vs-pressure scatter with the saturation curve drawn over it) is the key visual.
- **Flue-gas O₂** measures combustion air:
  - Low O₂ (below about 2%) means incomplete combustion, CO, soot, and a furnace explosion risk.
  - High O₂ (above about 6%) means wasted heat and an efficiency loss.
  - A sudden drop to about 0 can mean flame instability or a fuel-rich condition.
- **Catastrophic failure modes to detect:**
  - Overpressure above MAWP (maximum allowable working pressure).
  - Low water / dry firing, seen as temperature running away from pressure.
  - Furnace explosion precursors (O₂ collapse plus a temperature spike).
  - Tube rupture (a sudden pressure drop).
  - Sensor failure (a flatline or stuck value).
- ⚠️ **Safety principle:** this system is **advisory and for audit**. It does not replace the hard-wired safety interlocks and pressure relief valves (SIS). The plan never lets the AI actuate plant equipment directly.

### 1.4 Layer 1 — Statistical layer (per-frame, milliseconds, deterministic)
It answers one question: *is this reading, alone or together with the others, abnormal right now?*
- **Hard limits:** configured safe ranges (for example P > 0.9·MAWP gives `CRITICAL` immediately and skips the SLM queue).
- **Rolling z-score:** `z = (x − μ_window) / σ_window` over the last N = 60 s. If |z| > 3, flag it.
- **Robust z-score (MAD):** the median absolute deviation isn't pulled around by the outliers it is trying to catch.
- **EWMA control chart:** an exponentially weighted mean with control limits. It catches small persistent shifts faster than a plain z-score.
- **Multivariate: Hotelling's T² / Mahalanobis distance** on the vector [T, P, O₂] using a baseline covariance. This is the math behind the combination plot: it flags readings that are fine one sensor at a time but abnormal *jointly*.
- **Physics residual:** `P_measured − P_sat(T_measured)` from a steam-table approximation. A large residual flags a coupling violation.
- **Output:** an `OutlierEvent { severity, sensor(s), score, method }`.

### 1.5 Layer 2 — Temporal / time-series layer (sliding windows, seconds to minutes)
It answers: *what is the trajectory, and is it a known bad pattern?* One outlier is noise. A pattern is a signal.
- **Rate of change and trend:** linear regression slope over 30 s / 5 min windows. Pressure climbing 0.5 bar/min is dangerous even while it is still in range.
- **CUSUM:** a cumulative sum of deviations. It detects slow drift, such as fouling or a slowly failing valve.
- **Change-point detection:** finds abrupt regime shifts, such as a step drop from a tube rupture.
- **Pattern detectors:**
  - *flatline* (variance ≈ 0, a stuck sensor)
  - *oscillation* (autocorrelation peak, a control loop hunting)
  - *spike-and-recover*
  - *runaway* (monotonic growth plus a rising slope)
- **Cross-correlation / lag:** normally temperature leads pressure with a certain lag. A broken lag relationship means decoupling.
- **Short-horizon forecast:** Holt's linear exponential smoothing. It gives **time-to-threshold**, for example "pressure hits MAWP in about 4 min at the current rate". This is the most actionable output for preventing failure.
- **Output:** a `PatternEvent` plus a compact **feature vector** summarising the window: means, slopes, T², residual, detected patterns, time-to-threshold.

State:
1. LLM will define the state (corrosion_failure etc)
2. patterns not backdate, extrapolate based on current state -> in how many days?
3. example: adas Advanced Driver Assistance Systems
4. no system to predict failures (boilers: maintenance manual, boiler failed but dont know the reason), scada
5. current state of boiler -> future what will happen (failures) -> currently its manual (statistical/temporal -> less manual intervention -> similar to weather prediction); any industry based on what we want to achieve
6. weather prediction based on diff equations (only 10 days), tremendous comp power, nvda: geoearth, 3/4 months of weather prediction, 
7. overtime how does the boiler dataset change, dataset availbale online -> failures

Healthcare: vaccines transport
repeatable arch across multiple industries, change params

### 1.6 Layer 3 — SLM classification (Claude Haiku 4.5)
- **Why an LM here at all:** layers 1–2 produce many separate signals. The LM combines them with domain context ("rising T² + O₂ collapse + temperature spike ⇒ combustion instability") the way an experienced boiler engineer would, and explains its reasoning in words.
- **Input:** only the *feature vector and events*, never raw streams. That makes it cheap, fast and deterministic enough.
- **Gating:** the SLM is called only when layer 1 or 2 raises something, or once every N minutes as a health check. It is not called on every frame.
- **Output uses structured output / tool schema** (validated with zod):
  ```
  { state: NORMAL | EFFICIENCY_LOSS | COMBUSTION_INSTABILITY | OVERPRESSURE_RISK |
           LOW_WATER_RISK | SENSOR_FAULT | IMMINENT_FAILURE,
    confidence: 0-1, evidence: string[], recommendedAction: string, urgency: 1-5 }
  ```
- **Guardrails:** a hard-limit breach from layer 1 always wins. The SLM can *raise* severity but can never downgrade a deterministic CRITICAL.

### 1.7 Report generation (Sonnet agent + Hedera Agent Kit)
- When a classification's urgency is at least 3, the existing LangGraph ReAct agent (`createReactAgent`, already in `main.ts`) writes a human-readable incident report: what happened, the evidence, the trend, a forecast, and recommended actions.
- The full report goes into off-chain storage, such as Vercel Blob. Its **SHA-256 hash, URL, classification and summary** go to the `reports` HCS topic. The hash proves the report was never edited, and the summary stays under 1024 bytes.
- Deterministic high-volume writes (telemetry, events) use the SDK directly. **Don't route 1 Hz telemetry through an LLM tool call.** The agent's Hedera tools (`coreConsensusPlugin`) are for the report and decision steps.

### 1.8 Layer 4 — Human in the loop (on-chain approvals)
- The dashboard shows open reports. The operator connects a Hedera wallet (HashPack via `@hashgraph/hedera-wallet-connect`).
- The operator's decision is `ACKNOWLEDGE | ESCALATE | REQUEST_SHUTDOWN | FALSE_POSITIVE`, plus a note. It is **signed by the operator's own wallet** and submitted to the `decisions` topic. Its submit key allows only authorised operators, so every decision is non-repudiable.
- **Agent Kit `AgentMode.RETURN_BYTES`:** for actions, the agent *prepares* an unsigned transaction and returns its bytes. It is not signed with the agent key. The human signs in the wallet. This is the core HITL mechanism: the AI proposes, the human signs. (Telemetry and analysis stay in `AUTONOMOUS` mode.)
- **Scheduled transactions (optional, for critical actions):** `ScheduleCreateTransaction` with a 2-of-3 operator threshold. The action executes on chain only once enough operators sign.
- **Feedback loop:** `FALSE_POSITIVE` decisions are read back by the pipeline to tune thresholds and are added to the SLM prompt as few-shot counter-examples.

### 1.9 End-to-end flow
```
Simulator/Gateway ──(1 Hz frame, device key)──► HCS telemetry topic
                                                    │ gRPC mirror subscription
                                                    ▼
                                Worker: L1 statistical → L2 temporal
                                         │ events + features ──► HCS analysis topic
                                         ▼ (gated)
                                   L3 Haiku classify ──► HCS analysis topic
                                         ▼ (urgency ≥ 3)
                               Sonnet report agent ──► Blob + HCS reports topic
                                                    │
Vercel dashboard ◄──(mirror REST poll)── all topics │
     │ operator signs via wallet                     │
     └──────────────► HCS decisions topic ───────────┘ (worker subscribes, feedback)
```

---

## Part 2 — Implementation plan

### Project structure (restructure from a single `main.ts`)
```
iiot-agent/
  src/
    shared/
      env.ts          ← move readRequiredEnv from main.ts:25
      hedera.ts       ← move parseOperatorKey from main.ts:76; createClient(); publish(topic, msg)
      schemas.ts      ← zod: TelemetryFrame, OutlierEvent, PatternEvent, Classification, ReportRef, Decision
      topics.ts       ← topic IDs loaded from env
    simulator/
      boiler.ts       ← physics model (burner → temp, steam table → pressure, air ratio → O₂) + noise
      faults.ts       ← injectable scenarios: overpressure, O₂ collapse, sensor flatline, tube rupture, low water
      run.ts          ← publishes a TelemetryFrame every 1 s per boiler
    pipeline/
      subscriber.ts   ← TopicMessageQuery on telemetry + decisions
      statistical.ts  ← Layer 1 (z, MAD, EWMA, Hotelling T², physics residual, hard limits)
      temporal.ts     ← Layer 2 (ring buffers, slope, CUSUM, change-point, patterns, Holt forecast)
      classifier.ts   ← Layer 3 Haiku structured output (Classifier interface)
      reporter.ts     ← Sonnet agent — reuse createReactAgent + latestAgentMessage/renderContentBlocks from main.ts
      run.ts
    scripts/
      setup-topics.ts ← creates the 4 topics with submit keys, prints IDs for .env
  web/                ← Next.js app, deployed to Vercel
    app/page.tsx              live charts (per-sensor + temp-vs-pressure combination plot w/ saturation curve)
    app/reports/[id]/page.tsx report + evidence + decision form
    lib/mirror.ts             mirror REST polling hook
    lib/wallet.ts             hedera-wallet-connect signing
```
Add dependencies: `zod`, `simple-statistics` (or small hand-written math), `@vercel/blob`. In `web/` add `next`, `recharts`, and `@hashgraph/hedera-wallet-connect`.

### Message schemas (compact, under 1024 bytes)
- `TelemetryFrame`: `{v:1, b:"boiler-01", seq, ts, t:182.4, p:10.2, o2:3.1}`. HCS supplies the consensus timestamp and running hash, so there is no need to hash-chain it yourself.
- Every analysis message has a `ref` field pointing to the telemetry sequence numbers it covers, giving a full audit trail from reading → outlier → classification → report → decision.

### Build order (milestones)
1. **Foundation:** split `main.ts` into `shared/`, write `setup-topics.ts`, and create the topics on testnet.
2. **Simulator:** a normal-operation physics model publishing at 1 Hz, then fault injection through a CLI flag.
3. **Layer 1 + Layer 2:** pure functions with unit tests (vitest) on synthetic series where the answer is known.
4. **Subscriber pipeline:** wire L1→L2 and publish events to the `analysis` topic.
5. **Layer 3:** Haiku classifier with gating and the severity-override guardrail.
6. **Reporter:** Sonnet agent → Blob + `reports` topic.
7. **Dashboard on Vercel:** live charts and the combination plot from mirror REST.
8. **HITL:** wallet connect, signed decisions to the `decisions` topic, and the worker feedback loop. Then RETURN_BYTES and scheduled transactions for shutdown requests.
9. **Deploy:** worker to Railway/Fly (Docker), `web/` to Vercel, env vars set in both.

### Verification
- **Unit tests:** each L1/L2 detector against synthetic series (a clean sine gives no alerts, an injected spike is flagged, a ramp gives the correct time-to-threshold, a flatline is detected).
- **Scenario tests:** run the simulator with each fault and check that the expected classification appears on the `analysis` topic within X seconds. Measure detection lead time before the simulated failure point.
- **Chain checks:** on HashScan (testnet), confirm the messages, sequence numbers and submit-key enforcement. An unauthorised account posting to `decisions` must be rejected with `INVALID_SIGNATURE`.
- **End to end:** `npm run sim -- --fault overpressure` → watch the dashboard → a report appears → sign ACKNOWLEDGE in HashPack → the decision is visible on the mirror node and consumed by the worker.
- **Cost sanity check:** count messages per hour and compare with the HBAR balance drop.
