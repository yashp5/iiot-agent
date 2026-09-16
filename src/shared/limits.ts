/** Boiler nameplate spec and alarm limits. Shared by the simulator and the statistical layer. */
export interface BoilerLimits {
  mawpBar: number; // maximum allowable working pressure
  p: { min: number; max: number; setpoint: number };
  t: { min: number; max: number };
  o2: { min: number; max: number };
}

export const DEFAULT_LIMITS: BoilerLimits = {
  mawpBar: 12.0,
  p: { min: 8.0, max: 11.0, setpoint: 10.0 },
  t: { min: 165, max: 195 },
  o2: { min: 2.0, max: 6.0 },
};
