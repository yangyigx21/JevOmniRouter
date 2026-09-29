/**
 * `calibrate` — JEV-5 calibrated confidence (§4.2).
 *
 * Maps evidence strength `s ∈ [0,1]` to a calibrated confidence in
 * `[CALIBRATE_LOW, CALIBRATE_HIGH] = [0.35, 0.97]`. The two hard bounds
 * implement the design principle:
 *  - At `s = 0` (no evidence), confidence collapses to `0.35` — we never
 *    claim above random guessing.
 *  - As `s → 1` (perfect evidence), confidence asymptotes to `0.97` — we
 *    never claim 100% certainty.
 *
 * Curve: `0.35 + 0.62 × (1 − e^{−k s}) / (1 − e^{−k})` with `k = 2.6`.
 * Monotonically non-decreasing in `s`; rounded to 2 decimals (§4.2).
 *
 * Non-finite inputs (`NaN` / `±Infinity`) are clamped to the lower bound
 * per `ANIM-1` non-finite input defense posture.
 */
import {
  CALIBRATE_DECIMALS,
  CALIBRATE_HIGH,
  CALIBRATE_K,
  CALIBRATE_LOW,
  CALIBRATE_RANGE,
} from './constants.js';
import { clamp, round } from './utils/math.js';

/** Pre-computed normalizer `(1 − e^{−k})` for the §4.2 curve. */
const CALIBRATE_NORMALIZER = 1 - Math.exp(-CALIBRATE_K);

/**
 * Calibrate evidence strength into a confidence value in [0.35, 0.97].
 *
 * @param strength Evidence strength; clamped to [0,1] before applying the curve
 */
export function calibrate(strength: number): number {
  if (!Number.isFinite(strength)) {
    return CALIBRATE_LOW;
  }
  const s = clamp(strength, 0, 1);
  const curve = (1 - Math.exp(-CALIBRATE_K * s)) / CALIBRATE_NORMALIZER;
  const value = CALIBRATE_LOW + CALIBRATE_RANGE * curve;
  // Hard upper bound — `round` could in theory round 0.9699... up to 0.97,
  // but we still clamp defensively to guarantee the contract.
  const clamped = clamp(value, CALIBRATE_LOW, CALIBRATE_HIGH);
  return round(clamped, CALIBRATE_DECIMALS);
}

export { CALIBRATE_HIGH, CALIBRATE_LOW } from './constants.js';
