import { DEFAULT_LIMITS, type BoilerLimits } from "../shared/limits";
import type {
  FeatureVector,
  PatternEvent,
  Sensor,
  Severity,
  TelemetryFrame,
} from "../shared/schemas";
import { EventGate } from "./gate";
import type { WindowStats } from "./statistical";
import { SlidingWindow, mean } from "./window";

/*
 * Layer 2: what is the trajectory, and is it a known bad shape?
 *
 * Two detectors, deliberately:
 *   runaway   least-squares slope + linear time-to-threshold. A rolling z-score goes
 *             blind to a steady ramp (the window mean follows it up), so this is what
 *             gives early warning on overpressure and tube rupture.
 *   flatline  identical consecutive readings. Nothing else can see a frozen sensor:
 *             to every other check it looks like a perfectly stable boiler.
 *
 * It also assembles the FeatureVector — the compact summary the SLM classifies, so
 * layer 3 never touches raw telemetry or reaches back into these internals.
 */

export interface TemporalConfig {
  /** Slope window; shorter than layer 1's so a trend change is not diluted by old data. */
  windowSamples: number;
  warmupSamples: number;
  /** Per-second slope magnitudes. Sensor noise yields well under 0.01 of these. */
  slopeWarn: Record<Sensor, number>;
  slopeCritical: Record<Sensor, number>;
  /** Identical consecutive readings that mean a transmitter has frozen. */
  flatlineSamples: number;
  /** Forecast crossings further out than this are not worth alerting on. */
  forecastHorizonSec: number;
  /** A crossing sooner than this is CRITICAL regardless of slope magnitude. */
  urgentHorizonSec: number;
  debounceTicks: number;
  cooldownSec: number;
}

export const DEFAULT_TEMPORAL_CONFIG: TemporalConfig = {
  windowSamples: 30,
  warmupSamples: 15,
  slopeWarn: { t: 0.05, p: 0.005, o2: 0.01 },
  slopeCritical: { t: 0.2, p: 0.015, o2: 0.03 },
  flatlineSamples: 20,
  forecastHorizonSec: 900,
  urgentHorizonSec: 120,
  debounceTicks: 3,
  cooldownSec: 30,
};

export interface TemporalResult {
  events: PatternEvent[];
  features: FeatureVector;
}

const SENSOR_KEYS: readonly Sensor[] = ["t", "p", "o2"];
const SENSOR_UNITS: Record<Sensor, string> = { t: "°C", p: "bar", o2: "%" };

/** Least-squares trend per second. Uses frame timestamps, so gaps don't distort it. */
export function slopePerSecond(frames: readonly TelemetryFrame[], sensor: Sensor): number {
  if (frames.length < 2) return 0;
  const t0 = frames[0].ts;
  const xs = frames.map((f) => (f.ts - t0) / 1000);
  const ys = frames.map((f) => f[sensor]);
  const mx = mean(xs);
  const my = mean(ys);

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx;
    numerator += dx * (ys[i] - my);
    denominator += dx * dx;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * The limit this sensor is heading for, given the direction of travel. Rising pressure
 * targets MAWP rather than the operating maximum: the actionable number for an operator
 * is time until the vessel is over-pressured, not time until it is merely above normal.
 */
export function targetLimit(
  sensor: Sensor,
  slope: number,
  limits: BoilerLimits,
): number | undefined {
  if (slope === 0) return undefined;
  const rising = slope > 0;
  switch (sensor) {
    case "p":
      return rising ? limits.mawpBar : limits.p.min;
    case "t":
      return rising ? limits.t.max : limits.t.min;
    case "o2":
      return rising ? limits.o2.max : limits.o2.min;
  }
}

/** Seconds until a linear trend reaches `limit`, or undefined if it is moving away. */
export function timeToThreshold(
  current: number,
  slope: number,
  limit: number,
): number | undefined {
  if (slope === 0) return undefined;
  const seconds = (limit - current) / slope;
  return seconds > 0 ? seconds : undefined;
}

/** A frozen transmitter repeats its last value exactly; a live one never does. */
export function isFlatline(
  frames: readonly TelemetryFrame[],
  sensor: Sensor,
  samples: number,
): boolean {
  if (frames.length < samples) return false;
  const recent = frames.slice(-samples);
  return recent.every((f) => f[sensor] === recent[0][sensor]);
}

/** Stateful per boiler, like the statistical layer. One instance per boiler id. */
export class TemporalLayer {
  private readonly window: SlidingWindow<TelemetryFrame>;
  private readonly gate: EventGate;

  constructor(
    private readonly boilerId: string,
    private readonly limits: BoilerLimits = DEFAULT_LIMITS,
    private readonly config: TemporalConfig = DEFAULT_TEMPORAL_CONFIG,
  ) {
    this.window = new SlidingWindow<TelemetryFrame>(config.windowSamples);
    this.gate = new EventGate(config.debounceTicks, config.cooldownSec);
  }

  push(frame: TelemetryFrame, stats: WindowStats): TemporalResult {
    this.window.push(frame);
    const frames = this.window.values;
    const warm = frames.length >= this.config.warmupSamples;

    const ref = { from: this.window.oldest?.seq ?? frame.seq, to: frame.seq };
    const events: PatternEvent[] = [];
    const patterns: string[] = [];
    const slope = {} as Record<Sensor, number>;
    let soonestCrossing: number | undefined;

    const emit = (
      pattern: PatternEvent["pattern"],
      sensor: Sensor,
      severity: Severity,
      detail: string,
      timeToThresholdSec?: number,
    ) => {
      if (!this.gate.admit(`${pattern}:${sensor}`, severity, frame.ts)) return;
      events.push({
        v: 1,
        kind: "pattern",
        b: this.boilerId,
        ref,
        severity,
        sensors: [sensor],
        pattern,
        detail: detail.slice(0, 200),
        ...(timeToThresholdSec === undefined
          ? {}
          : { timeToThresholdSec: Math.round(timeToThresholdSec) }),
      });
    };

    for (const sensor of SENSOR_KEYS) {
      slope[sensor] = warm ? slopePerSecond(frames, sensor) : 0;

      // --- flatline -------------------------------------------------------------
      const flat = isFlatline(frames, sensor, this.config.flatlineSamples);
      if (flat) {
        patterns.push(`flatline:${sensor}`);
        emit(
          "flatline",
          sensor,
          "WARN",
          `${sensor} frozen at ${frame[sensor]} ${SENSOR_UNITS[sensor]} for ${this.config.flatlineSamples} samples`,
        );
      } else {
        this.gate.clear(`flatline:${sensor}`);
      }

      // --- runaway --------------------------------------------------------------
      const magnitude = Math.abs(slope[sensor]);
      const limit = targetLimit(sensor, slope[sensor], this.limits);
      const crossing =
        limit === undefined ? undefined : timeToThreshold(frame[sensor], slope[sensor], limit);

      if (crossing !== undefined && crossing < (soonestCrossing ?? Infinity)) {
        soonestCrossing = crossing;
      }

      // Already past the limit and still moving further past it. There is no future
      // crossing to forecast, but this is the most severe case, not the absence of one.
      const diverging =
        limit !== undefined &&
        ((slope[sensor] > 0 && frame[sensor] >= limit) ||
          (slope[sensor] < 0 && frame[sensor] <= limit));

      // A trend only matters if it is both fast enough to be real and pointed at a
      // limit it will actually reach soon; otherwise it is ordinary load-following.
      const trending =
        warm &&
        !flat &&
        magnitude >= this.config.slopeWarn[sensor] &&
        (diverging || (crossing !== undefined && crossing <= this.config.forecastHorizonSec));

      if (trending) {
        patterns.push(`runaway:${sensor}`);
        const severity: Severity =
          diverging ||
          magnitude >= this.config.slopeCritical[sensor] ||
          (crossing !== undefined && crossing <= this.config.urgentHorizonSec)
            ? "CRITICAL"
            : "WARN";
        const signed = slope[sensor] > 0 ? "+" : "";
        const trend = `${sensor} ${signed}${slope[sensor].toFixed(3)} ${SENSOR_UNITS[sensor]}/s`;
        emit(
          "runaway",
          sensor,
          severity,
          diverging
            ? `${trend}, already past ${limit} at ${frame[sensor]}`
            : `${trend} → ${limit} in ${Math.round(crossing ?? 0)}s`,
          crossing,
        );
      } else {
        this.gate.clear(`runaway:${sensor}`);
      }
    }

    const features: FeatureVector = {
      b: this.boilerId,
      ref,
      n: stats.n,
      mean: roundAll(stats.mean, 2),
      sd: roundAll(stats.sd, 3),
      z: roundAll(stats.z, 2),
      slope: roundAll(slope, 4),
      residualC: round(stats.residualC, 2),
      patterns: patterns.slice(0, 8),
      ...(soonestCrossing === undefined || soonestCrossing > this.config.forecastHorizonSec
        ? {}
        : { timeToThresholdSec: Math.round(soonestCrossing) }),
    };

    return { events, features };
  }
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function roundAll(values: Record<Sensor, number>, decimals: number): Record<Sensor, number> {
  return {
    t: round(values.t, decimals),
    p: round(values.p, decimals),
    o2: round(values.o2, decimals),
  };
}
