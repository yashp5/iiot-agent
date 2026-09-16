import type { BoilerSim } from "./boiler";

/*
Fault: overpressure
Mechanism: load → 0.05, controller's pressure input frozen, so firing
stays high and pBar ramps about 0.02 bar/s
Detector it should trip: hard limit + runaway pattern +
time-to-threshold
────────────────────────────────────────
Fault: o2_collapse
Mechanism: lambda ramps 1.15 → 0.98 over 60 s, so O₂ heads to ~0
Detector it should trip: O₂ hard limit, z-score, Hotelling's T²
────────────────────────────────────────
Fault: sensor_flatline
Mechanism: freeze overrides.t at the last reported value while true
state moves on
Detector it should trip: flatline (variance ≈ 0) + growing physics
residual
────────────────────────────────────────
Fault: tube_rupture
Mechanism: at t₀ load steps to 1.6, so pressure falls sharply and T
follows it down
Detector it should trip: step_change, negative slope
────────────────────────────────────────
Fault: low_water
Mechanism: superheatC ramps +0.4 °C/s while pressure barely moves
Detector it should trip: physics_residual, decoupling
*/

export const FAULT_NAMES = [
  "overpressure",
  "o2_collapse",
  "sensor_flatline",
  "tube_rupture",
  "low_water",
] as const;

export type FaultName = (typeof FAULT_NAMES)[number];

export interface Fault {
  name: FaultName;
  /** Called every tick once the fault is active. `elapsed` = seconds since it began. */
  apply(sim: BoilerSim, elapsed: number): void;
}

const O2_RAMP_SEC = 60;
const LAMBDA_NORMAL = 1.15;
const LAMBDA_FUEL_RICH = 0.98;
const SUPERHEAT_RATE_C_PER_S = 0.4;
const RUPTURE_LOAD = 1.6;
const STALLED_LOAD = 0.05;

/**
 * Each fault is built fresh per run because some latch state on their first tick.
 * Where possible `apply` is a pure function of `elapsed` rather than an accumulation,
 * so a fault behaves identically no matter when it starts.
 */
const FAULT_FACTORIES: Record<FaultName, () => Fault> = {
  /** Steam demand disappears while the controller's transmitter is stuck at setpoint. */
  overpressure: () => ({
    name: "overpressure",
    apply(sim, elapsed) {
      if (elapsed === 0) {
        // Latch what the controller sees now; from here it believes pressure is fine.
        sim.controllerPressure = sim.state.pBar;
      }
      sim.state.load = STALLED_LOAD;
    },
  }),

  /** Air damper drifts closed: excess air falls through stoichiometric into fuel-rich. */
  o2_collapse: () => ({
    name: "o2_collapse",
    apply(sim, elapsed) {
      const progress = Math.min(1, elapsed / O2_RAMP_SEC);
      sim.state.lambda = LAMBDA_NORMAL + (LAMBDA_FUEL_RICH - LAMBDA_NORMAL) * progress;
    },
  }),

  /**
   * Temperature transmitter freezes. Every reading stays inside its limits — only the
   * relationship to pressure breaks, which is the case a per-sensor threshold misses.
   */
  sensor_flatline: () => {
    let frozen: number | undefined;
    return {
      name: "sensor_flatline",
      apply(sim) {
        frozen ??= Math.round(sim.trueValues().t * 10) / 10;
        sim.overrides.t = frozen;
      },
    };
  },

  /** Tube fails: steam escapes far faster than the burner can replace it. */
  tube_rupture: () => ({
    name: "tube_rupture",
    apply(sim) {
      sim.state.load = RUPTURE_LOAD;
    },
  }),

  /**
   * Water level drops and the exposed surface superheats. Pressure barely moves, so
   * temperature climbs away from its saturation value: a physics-residual signature.
   */
  low_water: () => ({
    name: "low_water",
    apply(sim, elapsed) {
      sim.state.superheatC = SUPERHEAT_RATE_C_PER_S * elapsed;
    },
  }),
};

export function createFault(name: FaultName): Fault {
  return FAULT_FACTORIES[name]();
}
