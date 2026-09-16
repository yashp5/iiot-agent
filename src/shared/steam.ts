/**
 * Saturated-steam relationships. These belong to the boiler's physics, not to the
 * simulator: the statistical layer uses them on real telemetry to test whether the
 * temperature and pressure readings are consistent with each other at all.
 */

// Antoine constants for water, valid 99–374 °C (P in mmHg).
const A = 8.14019,
  B = 1810.94,
  C = 244.485;
const MMHG_PER_BAR = 750.062;

/** Saturation pressure (bar abs) of water at temperature T (°C). */
export function pSat(tC: number): number {
  return 10 ** (A - B / (C + tC)) / MMHG_PER_BAR;
}

/** Saturation temperature (°C) of water at pressure P (bar abs). Inverse of pSat. */
export function tSat(pBar: number): number {
  return B / (A - Math.log10(pBar * MMHG_PER_BAR)) - C;
}
