/**
 * Pure numeric helpers shared across the decision runtime pure-logic layer.
 *
 * No DOM, no I/O, no side effects. Every function MUST be deterministic so the
 * two-form architecture (cloud-native + offline single-file) can reuse the
 * same compiled output (`ARCH-2`).
 */
/**
 * Clamp `value` into the inclusive range `[lo, hi]`.
 *
 * Defensive: tolerates `NaN` / `Infinity` for `ANIM-1` non-finite input defense.
 * `NaN` is treated as `lo`; `+Infinity` collapses to `hi`; `-Infinity` to `lo`.
 */
export function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) {
    return Number.isNaN(value) ? lo : value > 0 ? hi : lo;
  }
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/**
 * Round to a fixed number of decimal places using "round half away from zero"
 * semantics to match the spec's `round(x, 2)` shorthand (§4.2 calibrate).
 */
export function round(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  const scaled = value * factor;
  const rounded =
    scaled >= 0 ? Math.floor(scaled + 0.5) : Math.ceil(scaled - 0.5);
  return rounded / factor;
}

/** Sum a numeric array; empty array returns 0 (identity element). */
export function sum(values: number[] | readonly number[]): number {
  let acc = 0;
  for (let i = 0; i < values.length; i += 1) acc += values[i];
  return acc;
}

/**
 * Numerically stable softmax: `exp(x_i / T) / Σ exp(x_j / T)`.
 * Subtracts `max(raw) / T` before exponentiation to avoid `exp` overflow.
 * Returns an empty array when given an empty input.
 */
export function softmax(raw: number[] | readonly number[], temperature: number): number[] {
  if (raw.length === 0) return [];
  const T = temperature > 0 ? temperature : Number.EPSILON;
  const scaled = raw.map((r) => r / T);
  const max = scaled.reduce((m, x) => (x > m ? x : m), -Infinity);
  const exps = scaled.map((x) => Math.exp(x - max));
  const total = sum(exps);
  if (total <= 0) return raw.map(() => 1 / raw.length);
  return exps.map((e) => e / total);
}

/**
 * Return the spread (max − min) of a numeric array. Empty array returns 0.
 * Used by §4.4 `scoreModels` adaptive temperature: `T = T0 × (1 + α × spread)`.
 */
export function spread(values: number[] | readonly number[]): number {
  if (values.length === 0) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
  return max - min;
}
