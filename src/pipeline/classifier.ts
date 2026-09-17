import Anthropic from "@anthropic-ai/sdk";
import {
  BOILER_STATES,
  type AnalysisMessage,
  type BoilerState,
  type Classification,
  type FeatureVector,
  type OutlierEvent,
  type PatternEvent,
} from "../shared/schemas";

/*
 * Layer 3: the small language model that names the boiler's condition.
 *
 * It sees only the feature vector and the events layers 1 and 2 produced — never raw
 * telemetry. That keeps the call small and cheap, and means the deterministic layers
 * stay the system of record: the model interprets, it does not measure.
 */

export type DetectorEvent = OutlierEvent | PatternEvent;

export interface ClassifierInput {
  features: FeatureVector;
  events: DetectorEvent[];
}

export interface Classifier {
  classify(input: ClassifierInput): Promise<Classification>;
}

/** Haiku 4.5: fast and cheap enough to call on every gated event. */
export const CLASSIFIER_MODEL = "claude-haiku-4-5";

const SYSTEM_PROMPT = `You are a boiler condition monitor for an industrial steam plant.

You receive a numeric summary of one monitoring window and the events raised by
deterministic detectors. You never see raw telemetry. Classify the boiler's condition.

Sensors: t = drum temperature (°C), p = drum pressure (bar absolute), o2 = flue-gas oxygen (%).

Domain facts you must apply:
- In a saturated drum, t and p are physically coupled by the steam tables. residualC is
  t - tSat(p). Near zero is healthy. A large positive residual means temperature has run
  away from pressure, which indicates low water level and exposed, superheating surfaces.
- A frozen transmitter (pattern flatline:<sensor>) means that reading is not evidence of
  anything. Judge the boiler on the other sensors and treat the frozen one as failed.
- o2 below about 2% is incomplete combustion: CO, soot and furnace explosion risk.
  o2 above about 6% wastes heat. A collapse toward 0 means the air/fuel ratio has gone
  fuel-rich, which is dangerous rather than merely inefficient.
- A rising pressure trend matters more than its present value. timeToThresholdSec is the
  forecast seconds until a sensor reaches a limit.
- Both t and p rising together with a residual near zero is normal saturated behaviour
  under load; the danger there is the absolute pressure, not the coupling.

Urgency: 1 routine, 2 watch, 3 investigate now, 4 intervene, 5 emergency.

Report only what the numbers support. Cite specific values in evidence. If the data is
ambiguous, say so in evidence and lower your confidence rather than inventing a cause.`;

// flaws, diff models, another model generates flaws/negation then an aggregator acts as the judge
// traversal pattern, graph structure
// deterministic
// o,t,p graph determine which combinations affect the most
// pattern agents - classifier agent
// negation layers hallucinate or based on facts
// judge layer decides what answer is best

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    state: { type: "string", enum: [...BOILER_STATES] },
    // Numeric bounds are expressed in descriptions, not as minimum/maximum: the API
    // rejects those keywords in output_config schemas. guardrail() clamps both.
    confidence: { type: "number", description: "0 to 1" },
    evidence: {
      type: "array",
      items: { type: "string" },
      description: "at most 4 short findings, each citing specific values",
    },
    recommendedAction: { type: "string", description: "one sentence, imperative" },
    urgency: { type: "integer", description: "1 routine to 5 emergency" },
  },
  required: ["state", "confidence", "evidence", "recommendedAction", "urgency"],
  additionalProperties: false,
} as const;

interface ModelVerdict {
  state: BoilerState;
  confidence: number;
  evidence: string[];
  recommendedAction: string;
  urgency: number;
}

export class HaikuClassifier implements Classifier {
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly model: string = CLASSIFIER_MODEL) {
    this.client = new Anthropic({ apiKey });
  }

  async classify(input: ClassifierInput): Promise<Classification> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      messages: [{ role: "user", content: renderInput(input) }],
    });

    if (response.stop_reason === "refusal") {
      throw new Error("classifier refused the request");
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    const verdict = JSON.parse(text) as ModelVerdict;
    return guardrail(verdict, input);
  }
}

/** Compact, labelled input. Field names match the schema so the model can cite them. */
export function renderInput({ features, events }: ClassifierInput): string {
  const lines = [
    `boiler: ${features.b}`,
    `window: ${features.n} samples, telemetry seq ${features.ref.from}-${features.ref.to}`,
    `mean:  t=${features.mean.t} p=${features.mean.p} o2=${features.mean.o2}`,
    `sd:    t=${features.sd.t} p=${features.sd.p} o2=${features.sd.o2}`,
    `z:     t=${features.z.t} p=${features.z.p} o2=${features.z.o2}`,
    `slope/s: t=${features.slope.t} p=${features.slope.p} o2=${features.slope.o2}`,
    `residualC: ${features.residualC}`,
    `patterns: ${features.patterns.length ? features.patterns.join(", ") : "none"}`,
    `timeToThresholdSec: ${features.timeToThresholdSec ?? "none"}`,
    "",
    "events this window:",
    ...(events.length
      ? events.map((e) =>
          e.kind === "outlier"
            ? `- ${e.severity} ${e.method} on ${e.sensors.join("+")} (score ${e.score})`
            : `- ${e.severity} ${e.pattern} on ${e.sensors.join("+")}: ${e.detail}`,
        )
      : ["- none (periodic health check)"]),
  ];
  return lines.join("\n");
}

/**
 * The deterministic layers outrank the model. It may raise severity but never lower it:
 * a hard limit that is being breached is a measurement, not an interpretation.
 */
export function guardrail(verdict: ModelVerdict, input: ClassifierInput): Classification {
  const { features, events } = input;
  const critical = events.filter((e) => e.severity === "CRITICAL");
  const evidence = [...verdict.evidence];
  let state = verdict.state;
  let urgency = Math.min(5, Math.max(1, Math.round(verdict.urgency)));

  if (critical.length > 0) {
    if (urgency < 4) {
      evidence.push(`guardrail: urgency raised from ${urgency} — ${critical.length} CRITICAL event(s)`);
      urgency = 4;
    }
    if (state === "NORMAL") {
      state = stateForCriticalEvent(critical[0]);
      evidence.push(`guardrail: NORMAL overridden — deterministic CRITICAL present`);
    }
  }

  return {
    v: 1,
    kind: "classification",
    b: features.b,
    ref: features.ref,
    state,
    confidence: Math.min(1, Math.max(0, verdict.confidence)),
    evidence: evidence.slice(0, 6).map((line) => line.slice(0, 160)),
    recommendedAction: verdict.recommendedAction.slice(0, 240),
    urgency,
  };
}

/** Least-surprising state for a CRITICAL the model tried to call NORMAL. */
function stateForCriticalEvent(event: DetectorEvent): BoilerState {
  if (event.kind === "outlier" && event.method === "physics_residual") return "LOW_WATER_RISK";
  if (event.sensors.includes("o2")) return "COMBUSTION_INSTABILITY";
  if (event.sensors.includes("p")) return "OVERPRESSURE_RISK";
  if (event.sensors.includes("t")) return "LOW_WATER_RISK";
  return "SENSOR_FAULT";
}

export interface GateConfig {
  /** Never call the model more often than this for one boiler. */
  minIntervalSec: number;
  /** Call anyway after this long without one, as a health check. */
  heartbeatSec: number;
}

export const DEFAULT_GATE_CONFIG: GateConfig = { minIntervalSec: 60, heartbeatSec: 900 };

/**
 * The model is not called per frame: only when the deterministic layers raise something,
 * or periodically so a quiet boiler still gets an on-chain "normal" record.
 */
export function shouldClassify(
  events: readonly AnalysisMessage[],
  lastCallTs: number | undefined,
  now: number,
  config: GateConfig = DEFAULT_GATE_CONFIG,
): boolean {
  if (lastCallTs === undefined) return events.length > 0;
  const sinceSec = (now - lastCallTs) / 1000;
  if (events.length > 0) return sinceSec >= config.minIntervalSec;
  return sinceSec >= config.heartbeatSec;
}
