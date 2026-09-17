import { z } from "zod";

/**
 * Wire formats for every HCS topic. Keys are deliberately short on `TelemetryFrame`
 * because it is published every second and must stay well inside one 1024-byte chunk.
 * Every derived message carries `ref`, the telemetry sequence range it was computed
 * from, so any report or decision can be traced back to the raw readings on chain.
 */

export const SENSORS = ["t", "p", "o2"] as const;
export const SensorSchema = z.enum(SENSORS);
export type Sensor = z.infer<typeof SensorSchema>;

export const SeveritySchema = z.enum(["INFO", "WARN", "CRITICAL"]);
export type Severity = z.infer<typeof SeveritySchema>;

/** One reading per second per boiler: t = drum temperat
ure °C, p = drum pressure bar(abs), o2 = flue-gas O₂ %.
*/
export const TelemetryFrameSchema = z.object({
  v: z.literal(1),
  b: z.string().min(1).max(32),
  seq: z.number().int().nonnegative(),
  ts: z.number().int().positive(),
  t: z.number(),
  p: z.number(),
  o2: z.number(),
});
export type TelemetryFrame = z.infer<typeof TelemetryFrameSchema>;

const RefSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
});

export const OutlierEventSchema = z.object({
  v: z.literal(1),
  kind: z.literal("outlier"),
  b: z.string(),
  ref: RefSchema,
  severity: SeveritySchema,
  sensors: z.array(SensorSchema).min(1),
  method: z.enum([
    "hard_limit",
    "zscore",
    "mad",
    "ewma",
    "hotelling_t2",
    "physics_residual",
  ]),
  score: z.number(),
});
export type OutlierEvent = z.infer<typeof OutlierEventSchema>;

export const PatternEventSchema = z.object({
  v: z.literal(1),
  kind: z.literal("pattern"),
  b: z.string(),
  ref: RefSchema,
  severity: SeveritySchema,
  sensors: z.array(SensorSchema).min(1),
  pattern: z.enum([
    "runaway",
    "flatline",
    "oscillation",
    "step_change",
    "drift",
    "decoupling",
  ]),
  detail: z.string().max(200),
  /** Forecast seconds until the sensor crosses its hard limit, when trending toward one. */
  timeToThresholdSec: z.number().nonnegative().optional(),
});
export type PatternEvent = z.infer<typeof PatternEventSchema>;

export const BOILER_STATES = [
  "NORMAL",
  "EFFICIENCY_LOSS",
  "COMBUSTION_INSTABILITY",
  "OVERPRESSURE_RISK",
  "LOW_WATER_RISK",
  "SENSOR_FAULT",
  "IMMINENT_FAILURE",
] as const;
export const BoilerStateSchema = z.enum(BOILER_STATES);
export type BoilerState = z.infer<typeof BoilerStateSchema>;

export const ClassificationSchema = z.object({
  v: z.literal(1),
  kind: z.literal("classification"),
  b: z.string(),
  ref: RefSchema,
  state: BoilerStateSchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().max(160)).max(6),
  recommendedAction: z.string().max(240),
  urgency: z.number().int().min(1).max(5),
});
export type Classification = z.infer<typeof ClassificationSchema>;

export const AnalysisMessageSchema = z.discriminatedUnion("kind", [
  OutlierEventSchema,
  PatternEventSchema,
  ClassificationSchema,
]);
export type AnalysisMessage = z.infer<typeof AnalysisMessageSchema>;

/**
 * An incident report. The body is carried on chain: the SDK chunks a message over 1024
 * bytes into up to 20 chunks, so a ~2 KB report fits comfortably and needs no off-chain
 * store. `sha256` lets a reader verify the body it reassembled, and `url` is reserved for
 * reports too large for that — mirrored to blob storage with only the hash on chain.
 */
export const ReportRefSchema = z.object({
  v: z.literal(1),
  kind: z.literal("report"),
  id: z.string(),
  b: z.string(),
  ref: RefSchema,
  state: BoilerStateSchema,
  urgency: z.number().int().min(1).max(5),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  summary: z.string().max(400),
  body: z.string().max(18000),
  url: z.string().url().optional(),
});
export type ReportRef = z.infer<typeof ReportRefSchema>;

export const DecisionSchema = z.object({
  v: z.literal(1),
  kind: z.literal("decision"),
  reportId: z.string(),
  action: z.enum([
    "ACKNOWLEDGE",
    "ESCALATE",
    "REQUEST_SHUTDOWN",
    "FALSE_POSITIVE",
  ]),
  operator: z.string(),
  note: z.string().max(400).optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;

/**
 * Compact numeric summary of one window, assembled by the temporal layer from both
 * layer 1 and layer 2 output. This — never raw telemetry — is what the SLM classifies.
 */
export const FeatureVectorSchema = z.object({
  b: z.string(),
  ref: RefSchema,
  /** Samples in the window; small values mean the statistics are still warming up. */
  n: z.number().int().positive(),
  mean: z.object({ t: z.number(), p: z.number(), o2: z.number() }),
  sd: z.object({ t: z.number(), p: z.number(), o2: z.number() }),
  /** Latest reading's distance from the window mean, in standard deviations. */
  z: z.object({ t: z.number(), p: z.number(), o2: z.number() }),
  /** Least-squares trend per second over the window. */
  slope: z.object({ t: z.number(), p: z.number(), o2: z.number() }),
  /** t − tSat(p): 0 when the drum is saturated, large when the readings disagree. */
  residualC: z.number(),
  patterns: z.array(z.string()).max(8),
  timeToThresholdSec: z.number().nonnegative().optional(),
});
export type FeatureVector = z.infer<typeof FeatureVectorSchema>;
