/**
 * `outcomeWeight` — EXP-7 time-decay weight and profile-invalidation (§4.9.3).
 *
 * Computes the participation weight of a single confirmed/disputed outcome
 * in the prior-correction formula:
 *
 * ```
 * ageDays = (now − outcome.observedAt) / MS_PER_DAY
 * w_i     = 0.5 ^ (ageDays / EXP_HALF_LIFE_DAYS) × SOURCE_W[source]
 * participates iff w_i ≥ EXP_WEIGHT_FLOOR (0.15)
 * ```
 *
 * Two guard clauses prepend the formula:
 *
 * 1. **Status filter (§4.9.2)**: only `confirmed` / `disputed` outcomes
 *    produce samples. `pending` / `expired` are excluded entirely
 *    (`weight = 0`, `participates = false`).
 *
 * 2. **Profile-version invalidation (§4.9.3 "画像变更失效")**: when the
 *    model's `profileVersion` has changed since the outcome was recorded,
 *    the historical sample is invalidated — its weight collapses to 0
 *    regardless of recency. This is the "model upgrade must not inherit
 *    stale experience" guard.
 *
 * Also defensively clamps `ageDays` to `≥ 0` (a future `observedAt` would
 * otherwise inflate `decay` above 1, which has no semantic meaning).
 */
import {
  EXP_HALF_LIFE_DAYS,
  EXP_WEIGHT_FLOOR,
  MS_PER_DAY,
  SOURCE_W,
} from './constants.js';
import type { Outcome, OutcomeSource } from './types.js';

export interface OutcomeWeightResult {
  /** Time-decayed source-weighted participation weight in [0, 1]. */
  weight: number;
  /** True iff the sample passes all guards and contributes to prior correction. */
  participates: boolean;
  /** Age in days since `observedAt` (clamped ≥ 0); NaN if status-excluded. */
  ageDays: number;
  /** True iff profile-version mismatch invalidated the sample. */
  invalidated: boolean;
  /** Original source weight before time decay. */
  sourceWeight: number;
}

/** Look up source weight with a safe fallback for unknown sources. */
function sourceWeightOf(source: OutcomeSource | undefined): number {
  if (!source) return 0;
  return SOURCE_W[source] ?? 0;
}

/**
 * Compute the participation weight of `outcome` at time `now`.
 *
 * @param outcome              The outcome being weighted
 * @param now                  Current epoch milliseconds
 * @param currentProfileVersion Optional current profile version of the
 *                              associated model — if provided and differs
 *                              from `outcome.profileVersion`, the sample is
 *                              invalidated (weight collapses to 0).
 */
export function outcomeWeight(
  outcome: Outcome,
  now: number,
  currentProfileVersion?: string,
): OutcomeWeightResult {
  // Guard 1 — status filter (§4.9.2).
  if (outcome.status === 'pending' || outcome.status === 'expired') {
    return {
      weight: 0,
      participates: false,
      ageDays: Number.NaN,
      invalidated: false,
      sourceWeight: 0,
    };
  }

  // Guard 2 — profile-version invalidation (§4.9.3).
  const invalidated =
    currentProfileVersion !== undefined &&
    outcome.profileVersion !== undefined &&
    outcome.profileVersion !== currentProfileVersion;
  if (invalidated) {
    return {
      weight: 0,
      participates: false,
      ageDays: Number.NaN,
      invalidated: true,
      sourceWeight: sourceWeightOf(outcome.source),
    };
  }

  // Sanitize timestamps; clamp age to ≥ 0 (future observations are ignored).
  const observedAt = Number.isFinite(outcome.observedAt)
    ? outcome.observedAt
    : now;
  const nowSafe = Number.isFinite(now) ? now : Date.now();
  const ageMs = Math.max(0, nowSafe - observedAt);
  const ageDays = ageMs / MS_PER_DAY;

  const sourceW = sourceWeightOf(outcome.source);
  const decay = Math.pow(0.5, ageDays / EXP_HALF_LIFE_DAYS);
  const weight = decay * sourceW;
  const participates = weight >= EXP_WEIGHT_FLOOR;

  return {
    weight,
    participates,
    ageDays,
    invalidated: false,
    sourceWeight: sourceW,
  };
}

export { EXP_HALF_LIFE_DAYS, EXP_WEIGHT_FLOOR, MS_PER_DAY, SOURCE_W } from './constants.js';
