import { DEFAULT_LIMITS, type BoilerLimits } from "../shared/limits";
import type { OutlierEvent, Sensor, Severity, TelemetryFrame } from "../shared/schemas";
import { tSat } from "../shared/steam";
import { EventGate } from "./gate";
import { SlidingWindow, mean, stdDev } from "./window";

/*
 * Layer 1: is this reading abnormal right now, on its own or against the others?
 *
 * Three checks, deliberately:
 *   hard_limit        deterministic ground truth; the only check that must never miss
 *   physics_residual  t vs tSat(p) — catches low water and a frozen sensor while every
 *                     individual reading is still comfortably inside its limits
 *   zscore            generic "unlike its own recent history", for faults we did not
 *                     anticipate, and a normalised score for the SLM
 *
 * Everything here is deterministic and I/O free, so it can be replayed over recorded
 * telemetry and unit tested against the simulator's labelled faults.
 */

export interface StatConfig {
  /** Samples retained; at 1 Hz this is the window in seconds. */
  windowSamples: number;
  /** Below this, statistics over the window are meaningless and z-scores are skipped. */
  warmupSamples: number;
  zThreshold: number;
  /** Keeps a quiet sensor's tiny sd from turning noise into enormous z-scores. */
  sdFloor: number;
  residualWarnC: number;
  residualCriticalC: number;
  /** Fraction of MAWP that escalates a pressure breach to CRITICAL. */
  mawpCriticalFraction: number;
  /** Below this O₂ percentage combustion is fuel-rich: CO and explosion risk. */
  o2CriticalPct: number;
  /** Degrees above the temperature limit that escalate to CRITICAL. */
  tCriticalMarginC: number;
  /** Consecutive breaches required before emitting; rides out single noisy samples. */
  debounceTicks: number;
  /** Minimum gap between identical repeat emissions. Every event is an HCS transaction. */
  cooldownSec: number;
}

export const DEFAULT_STAT_CONFIG: StatConfig = {
  windowSamples: 60,
  warmupSamples: 30,
  zThreshold: 3,
  sdFloor: 0.05,
  residualWarnC: 5,
  residualCriticalC: 15,
  mawpCriticalFraction: 0.9,
  o2CriticalPct: 1.0,
  tCriticalMarginC: 10,
  debounceTicks: 3,
  cooldownSec: 30,
};

/** Per-window summary handed to the temporal layer, which folds it into the feature vector. */
export interface WindowStats {
  n: number;
  mean: Record<Sensor, number>;
  sd: Record<Sensor, number>;
  z: Record<Sensor, number>;
  residualC: number;
  /** False while the window is still filling: z-scores are not yet trustworthy. */
  warm: boolean;
}

export interface StatResult {
  stats: WindowStats;
  events: OutlierEvent[];
}

const SENSOR_KEYS: readonly Sensor[] = ["t", "p", "o2"];

/** t − tSat(p). Zero in a saturated drum; large when the two readings contradict. */
export function physicsResidual(frame: TelemetryFrame): number {
  return frame.t - tSat(frame.p);
}

interface Breach {
  sensors: Sensor[];
  severity: Severity;
  score: number;
}

/** Deterministic limit check on a single frame — no history, no warm-up. */
export function hardLimitBreaches(
  frame: TelemetryFrame,
  limits: BoilerLimits,
  config: StatConfig,
): Map<Sensor, Breach> {
  const breaches = new Map<Sensor, Breach>();

  if (frame.p >= limits.mawpBar * config.mawpCriticalFraction) {
    breaches.set("p", { sensors: ["p"], severity: "CRITICAL", score: frame.p });
  } else if (frame.p > limits.p.max || frame.p < limits.p.min) {
    breaches.set("p", { sensors: ["p"], severity: "WARN", score: frame.p });
  }

  if (frame.t > limits.t.max + config.tCriticalMarginC) {
    breaches.set("t", { sensors: ["t"], severity: "CRITICAL", score: frame.t });
  } else if (frame.t > limits.t.max || frame.t < limits.t.min) {
    breaches.set("t", { sensors: ["t"], severity: "WARN", score: frame.t });
  }

  if (frame.o2 <= config.o2CriticalPct) {
    breaches.set("o2", { sensors: ["o2"], severity: "CRITICAL", score: frame.o2 });
  } else if (frame.o2 < limits.o2.min || frame.o2 > limits.o2.max) {
    breaches.set("o2", { sensors: ["o2"], severity: "WARN", score: frame.o2 });
  }

  return breaches;
}

/** Stateful per boiler: holds the rolling window and the gate. One instance per boiler id. */
export class StatisticalLayer {
  private readonly window: SlidingWindow<TelemetryFrame>;
  private readonly gate: EventGate;

  constructor(
    private readonly boilerId: string,
    private readonly limits: BoilerLimits = DEFAULT_LIMITS,
    private readonly config: StatConfig = DEFAULT_STAT_CONFIG,
  ) {
    this.window = new SlidingWindow<TelemetryFrame>(config.windowSamples);
    this.gate = new EventGate(config.debounceTicks, config.cooldownSec);
  }

  get frames(): readonly TelemetryFrame[] {
    return this.window.values;
  }

  push(frame: TelemetryFrame): StatResult {
    this.window.push(frame);
    const frames = this.window.values;
    const warm = frames.length >= this.config.warmupSamples;

    const stats: WindowStats = {
      n: frames.length,
      mean: {} as Record<Sensor, number>,
      sd: {} as Record<Sensor, number>,
      z: {} as Record<Sensor, number>,
      residualC: physicsResidual(frame),
      warm,
    };

    for (const sensor of SENSOR_KEYS) {
      const series = frames.map((f) => f[sensor]);
      const m = mean(series);
      const sd = stdDev(series, m);
      stats.mean[sensor] = m;
      stats.sd[sensor] = sd;
      stats.z[sensor] = (frame[sensor] - m) / Math.max(sd, this.config.sdFloor);
    }

    const ref = { from: this.window.oldest?.seq ?? frame.seq, to: frame.seq };
    const events: OutlierEvent[] = [];

    const emit = (
      method: OutlierEvent["method"],
      sensor: Sensor,
      severity: Severity,
      score: number,
      sensors: Sensor[] = [sensor],
    ) => {
      if (this.gate.admit(`${method}:${sensor}`, severity, frame.ts)) {
        events.push({
          v: 1,
          kind: "outlier",
          b: this.boilerId,
          ref,
          severity,
          sensors,
          method,
          score: Math.round(score * 100) / 100,
        });
      }
    };

    // 1. Hard limits — every frame, no warm-up needed.
    const breaches = hardLimitBreaches(frame, this.limits, this.config);
    for (const sensor of SENSOR_KEYS) {
      const breach = breaches.get(sensor);
      if (breach) emit("hard_limit", sensor, breach.severity, breach.score);
      else this.gate.clear(`hard_limit:${sensor}`);
    }

    // 2. Physics residual — also per-frame: it compares two sensors, not history.
    const residual = Math.abs(stats.residualC);
    if (residual >= this.config.residualWarnC) {
      const severity: Severity =
        residual >= this.config.residualCriticalC ? "CRITICAL" : "WARN";
      // Attributed to both sensors: which of the two is lying is not knowable here.
      emit("physics_residual", "t", severity, stats.residualC, ["t", "p"]);
    } else {
      this.gate.clear("physics_residual:t");
    }

    // 3. Z-score — needs a populated window to mean anything.
    for (const sensor of SENSOR_KEYS) {
      const z = stats.z[sensor];
      if (warm && Math.abs(z) > this.config.zThreshold) {
        emit("zscore", sensor, "WARN", z);
      } else {
        this.gate.clear(`zscore:${sensor}`);
      }
    }

    return { stats, events };
  }
}
