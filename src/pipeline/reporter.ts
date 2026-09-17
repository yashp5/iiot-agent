import { createHash, randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type {
  Classification,
  FeatureVector,
  ReportRef,
  TelemetryFrame,
} from "../shared/schemas";
import { tSat } from "../shared/steam";
import type { DetectorEvent } from "./classifier";

/*
 * Incident reports for the human in the loop.
 *
 * The classifier says what the boiler's condition is in one line; a report is what an
 * operator actually reads before deciding. It is written by a larger model than the
 * classifier because it has to argue a case — the evidence, the alternatives it rules
 * out, and what to check to confirm it — rather than pick a label.
 */

/** Sonnet writes the prose; Haiku classifies. Different jobs, different models. */
export const REPORTER_MODEL = "claude-sonnet-5";

/** Above this urgency a classification is worth a human's attention. */
export const REPORT_URGENCY_THRESHOLD = 3;

export interface ReportInput {
  classification: Classification;
  features: FeatureVector;
  events: DetectorEvent[];
  /** A thinned sample of the window, so the report can quote how values moved. */
  frames: readonly TelemetryFrame[];
}

export interface Reporter {
  report(input: ReportInput): Promise<ReportRef>;
}

const SYSTEM_PROMPT = `You write incident reports for boiler plant engineers.

You are given a classification, the numeric features it was based on, the detector events
that fired, and a thinned sample of the sensor readings. Write the report an operator reads
before deciding whether to intervene.

Sensors: t = drum temperature (°C), p = drum pressure (bar absolute), o2 = flue-gas oxygen (%).
In a saturated drum t and p are coupled by the steam tables, so t should track tSat(p);
residualC is t - tSat(p) and a large value means the two readings contradict each other.

Structure the body as markdown with these sections, in this order:
- **What is happening** — two or three sentences, plain language, no hedging.
- **Evidence** — bullets, each citing specific numbers and how they moved over the window.
- **Most likely cause** — name it, and say which competing explanations the data rules out
  and why. This is the part an engineer will argue with, so make the reasoning explicit.
- **Recommended actions** — numbered, most urgent first, each one concrete enough to act on.
- **How to confirm** — what an operator should check on the plant to verify or refute this,
  including which reading would prove you wrong.

Rules:
- Cite only numbers present in the input. Never invent a reading, a tag name, or a trend.
- If a sensor is flagged as frozen, say its readings prove nothing and reason from the others.
- State uncertainty where the data is ambiguous rather than writing around it.
- This system is advisory. Never instruct anyone to bypass an interlock or a relief valve;
  recommending a controlled shutdown is fine.
- Under 2000 characters. An operator reads this during an upset, not at a desk.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "one sentence an operator could act on, under 200 characters",
    },
    body: { type: "string", description: "the markdown report" },
  },
  required: ["summary", "body"],
  additionalProperties: false,
} as const;

export class SonnetReporter implements Reporter {
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly model: string = REPORTER_MODEL) {
    this.client = new Anthropic({ apiKey });
  }

  async report(input: ReportInput): Promise<ReportRef> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      messages: [{ role: "user", content: renderReportInput(input) }],
    });

    if (response.stop_reason === "refusal") {
      throw new Error("reporter refused the request");
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    const { summary, body } = JSON.parse(text) as { summary: string; body: string };

    return buildReportRef(input, summary, body);
  }
}

/** Assembles the on-chain record. Separated from the API call so it can be tested dry. */
export function buildReportRef(
  input: ReportInput,
  summary: string,
  body: string,
): ReportRef {
  const { classification, features } = input;
  const trimmed = body.slice(0, 18000);

  return {
    v: 1,
    kind: "report",
    id: randomUUID(),
    b: classification.b,
    ref: features.ref,
    state: classification.state,
    urgency: classification.urgency,
    // Over the hash of the body as published: a reader that reassembles the chunks can
    // confirm it has the whole thing, and it stays meaningful if the body later moves
    // off-chain with only this hash anchored.
    sha256: createHash("sha256").update(trimmed).digest("hex"),
    summary: summary.slice(0, 400),
    body: trimmed,
  };
}

/** Everything the writer gets. No raw stream — a thinned sample plus the derived numbers. */
export function renderReportInput({
  classification,
  features,
  events,
  frames,
}: ReportInput): string {
  const sample = thin(frames, 8).map(
    (f) =>
      `  seq ${f.seq}: t=${f.t} p=${f.p} o2=${f.o2} (tSat=${tSat(f.p).toFixed(1)}, residual=${(f.t - tSat(f.p)).toFixed(1)})`,
  );

  return [
    `boiler: ${classification.b}`,
    `classification: ${classification.state} (urgency ${classification.urgency}, confidence ${classification.confidence})`,
    `classifier evidence:`,
    ...classification.evidence.map((line) => `  - ${line}`),
    `recommended action from classifier: ${classification.recommendedAction}`,
    "",
    `window: ${features.n} samples, telemetry seq ${features.ref.from}-${features.ref.to}`,
    `mean: t=${features.mean.t} p=${features.mean.p} o2=${features.mean.o2}`,
    `slope/s: t=${features.slope.t} p=${features.slope.p} o2=${features.slope.o2}`,
    `residualC: ${features.residualC}`,
    `patterns: ${features.patterns.length ? features.patterns.join(", ") : "none"}`,
    `timeToThresholdSec: ${features.timeToThresholdSec ?? "none"}`,
    "",
    "detector events:",
    ...(events.length
      ? events.map((e) =>
          e.kind === "outlier"
            ? `  - ${e.severity} ${e.method} on ${e.sensors.join("+")} (score ${e.score})`
            : `  - ${e.severity} ${e.pattern} on ${e.sensors.join("+")}: ${e.detail}`,
        )
      : ["  - none"]),
    "",
    "sampled readings across the window:",
    ...sample,
  ].join("\n");
}

/** Evenly spaced sample, always keeping the first and last frame. */
function thin<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  const step = (items.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => items[Math.round(i * step)]);
}
