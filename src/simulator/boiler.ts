import { DEFAULT_LIMITS } from "../shared/limits";
import { TelemetryFrame } from "../shared/schemas";
import { tSat } from "../shared/steam";
import { gaussian } from "./random";

// Re-exported so simulator code and tests keep one import site for the steam tables.
export { pSat, tSat } from "../shared/steam";

export interface BoilerState {
  pBar: number; // true drum pressure
  firing: number; // 0..1 burner output
  lambda: number; // excess-air ratio
  load: number; // 0..1 steam demand
  superheatC: number; // °C above saturation — normally ~0, grows when water level drops
  integral: number; // PI controller accumulator
}

export interface SensorOverrides {
  t?: number;
  p?: number;
  o2?: number; // set by sensor-fault injection
}

/** Noise-free physical values behind the reported frame. */
export interface TrueValues {
  t: number;
  p: number;
  o2: number;
}

const DT = 1; // seconds per tick
const GAIN_BAR_PER_S = 0.05; // pressure change at full firing/load mismatch
const KP = 2.0,
  KI = 0.05; // PI gains on pressure error

/** Antoine is only valid above ~1 bar, and a real drum vents rather than pulling vacuum. */
const MIN_PRESSURE_BAR = 1.0;

export class BoilerSim {
  readonly state: BoilerState;
  overrides: SensorOverrides = {};
  /**
   * Pressure the controller believes it sees. Faults set this to simulate a control
   * loop acting on a stuck transmitter — how real overpressure events happen: the
   * boiler keeps firing because its own instrument says everything is fine.
   */
  controllerPressure?: number;
  private tick = 0;

  constructor(
    private readonly rng: () => number,
    private readonly limits = DEFAULT_LIMITS,
  ) {
    this.state = {
      pBar: limits.p.setpoint,
      firing: 0.5,
      lambda: 1.15,
      load: 0.5,
      superheatC: 0,
      integral: 0,
    };
  }

  /* Advances the true physical state by one second. */
  step(): void {
    const s = this.state;
    const error = this.limits.p.setpoint - (this.controllerPressure ?? s.pBar);
    s.integral = clamp(s.integral + error * KI * DT, -1, 1);
    s.firing = clamp(0.5 + KP * error * 0.1 + s.integral, 0, 1);
    s.pBar = Math.max(MIN_PRESSURE_BAR, s.pBar + GAIN_BAR_PER_S * (s.firing - s.load) * DT);
    this.tick += 1;
  }

  /** Physical truth, before sensor noise or fault overrides. */
  trueValues(): TrueValues {
    const s = this.state;
    return {
      t: tSat(s.pBar) + s.superheatC,
      p: s.pBar,
      // Fuel-rich combustion (lambda < 1) leaves no free oxygen; the formula goes
      // negative there, so floor it at zero.
      o2: Math.max(0, (21 * (s.lambda - 1)) / s.lambda),
    };
  }

  /* Produces the published reading: true state + saturation cou+ noise + overrides. */
  read(boilerId: string): TelemetryFrame {
    const truth = this.trueValues();

    return {
      v: 1,
      b: boilerId,
      seq: this.tick,
      ts: Date.now(),
      t: round1(this.overrides.t ?? gaussian(this.rng, truth.t, 0.4)),
      p: round2(this.overrides.p ?? gaussian(this.rng, truth.p, 0.03)),
      o2: round2(Math.max(0, this.overrides.o2 ?? gaussian(this.rng, truth.o2, 0.08))),
    };
  }
}

function clamp(x: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, x));
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
