/**
 * `calibrationStats` — EXP-2 calibration statistics (§4.9.6).
 *
 * Computes the 10-bin Expected Calibration Error (ECE) over a set of
 * historical routing decisions, plus diagnostic rates for high-confidence
 * misses and low-confidence hits:
 *
 * ```
 * ECE = Σ_b ( n_b / N ) × | acc_b − conf_b |     // b ∈ 10 equal [0,1] bins
 * hit  := status === 'confirmed'   (label === winner at decision time)
 * miss := status === 'disputed'    (label rejected)
 * excluded := status ∈ { 'pending', 'expired' }
 * ```
 *
 * Diagnostics (§4.9.6 "同时报告"):
 *  - **误报率 (falsePositiveRate)**: high-confidence (`conf ≥ 0.82`) but
 *    incorrect — fraction of high-conf samples that missed.
 *  - **漏报率 (falseNegativeRate)**: low-confidence (`conf < 0.60`) but
 *    correct — fraction of low-conf samples that hit.
 *
 * **Sample guard (§4.9.6)**: when total samples < `ECE_MIN_SAMPLE (30)`,
 * the result carries `insufficient: true` and no conclusion should be
 * drawn (the ECE number is still computed for trace, but downstream callers
 * MUST NOT treat it as a verdict).
 */
import {
  ECE_BINS,
  ECE_MIN_SAMPLE,
} from './constants.js';
import { ROUTE_TIER_DEFAULT } from './constants.js';
import type { CalibrationBin, CalibrationStats } from './types.js';
import { clamp } from './utils/math.js';

/** Single observation used by `calibrationStats`. */
export interface CalibrationSample {
  /** Calibrated confidence recorded at decision time (0..1). */
  confidence: number;
  /** True iff the prediction was correct (status === 'confirmed'). */
  hit: boolean;
}

export interface CalibrationStatsOptions {
  /** Confidence at/above which a sample is "high-confidence". Default 0.82. */
  highConfidenceThreshold?: number;
  /** Confidence below which a sample is "low-confidence". Default 0.60. */
  lowConfidenceThreshold?: number;
}

/** Assign a confidence to its 0-indexed bin in [0, ECE_BINS). */
function binOf(confidence: number): number {
  const c = clamp(confidence, 0, 1);
  const idx = Math.floor(c * ECE_BINS);
  // Right-edge inclusivity for the top bin: confidence === 1 lands in bin 9.
  return idx >= ECE_BINS ? ECE_BINS - 1 : idx;
}

/**
 * Compute ECE, per-bin breakdown, and diagnostic rates.
 *
 * @param samples  Pre-filtered samples (pending/expired already excluded by caller)
 * @param options  Optional threshold overrides for diagnostics
 */
export function calibrationStats(
  samples: readonly CalibrationSample[],
  options: CalibrationStatsOptions = {},
): CalibrationStats {
  // Filter out non-finite confidences defensively.
  const valid: CalibrationSample[] = [];
  for (const s of samples) {
    if (!Number.isFinite(s.confidence)) continue;
    valid.push({ confidence: s.confidence, hit: Boolean(s.hit) });
  }
  const N = valid.length;

  // Build 10 equal-width bins in [0, 1].
  const binSize = 1 / ECE_BINS;
  const bins: CalibrationBin[] = [];
  for (let b = 0; b < ECE_BINS; b += 1) {
    const lo = b * binSize;
    const hi = (b + 1) * binSize;
    let count = 0;
    let hitCount = 0;
    let confSum = 0;
    for (const s of valid) {
      if (binOf(s.confidence) === b) {
        count += 1;
        if (s.hit) hitCount += 1;
        confSum += s.confidence;
      }
    }
    bins.push({
      index: b,
      lo,
      hi,
      count,
      accuracy: count > 0 ? hitCount / count : 0,
      confidence: count > 0 ? confSum / count : 0,
    });
  }

  // ECE = Σ_b (n_b / N) × | acc_b − conf_b |.
  let ece = 0;
  if (N > 0) {
    for (const b of bins) {
      ece += (b.count / N) * Math.abs(b.accuracy - b.confidence);
    }
  }

  // Diagnostics — false positive rate (high-conf but missed) and
  // false negative rate (low-conf but hit).
  const highT =
    options.highConfidenceThreshold ?? ROUTE_TIER_DEFAULT.high;
  const lowT =
    options.lowConfidenceThreshold ?? ROUTE_TIER_DEFAULT.mid;
  let highCount = 0;
  let highMiss = 0;
  let lowCount = 0;
  let lowHit = 0;
  for (const s of valid) {
    const c = clamp(s.confidence, 0, 1);
    if (c >= highT) {
      highCount += 1;
      if (!s.hit) highMiss += 1;
    } else if (c < lowT) {
      lowCount += 1;
      if (s.hit) lowHit += 1;
    }
  }
  const falsePositiveRate = highCount > 0 ? highMiss / highCount : 0;
  const falseNegativeRate = lowCount > 0 ? lowHit / lowCount : 0;

  return {
    ece,
    totalSamples: N,
    bins,
    falsePositiveRate,
    falseNegativeRate,
    insufficient: N < ECE_MIN_SAMPLE,
  };
}

export { ECE_BINS, ECE_MIN_SAMPLE } from './constants.js';
