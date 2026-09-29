/**
 * Threshold Recalibration Suggestions — EXP-3 (T-4.5, §4.9.7).
 *
 * Deterministic scan over a candidate-threshold grid on **confirmed** data,
 * maximizing coverage (auto-route rate) subject to a low-confidence
 * precision floor.
 *
 * Output (EXP-3 §4.9.7):
 *  - current threshold
 *  - suggested threshold
 *  - optimization target
 *  - sample count
 *  - expected impact
 *  - counterfactual explanation: how many auto-routed / human-routed
 *    archives would flip under the new threshold.
 *
 * Critical guarantees:
 *  - **Determinism**: same dataset → same suggestion (no randomness).
 *  - **No auto-apply**: this module NEVER writes a threshold; production
 *    thresholds only change via `human-review.ts` after operator sign-off.
 *  - **Sample floor**: insufficient confirmed samples → no suggestion,
 *    and a deficit count is reported.
 */
import { ROUTE_TIER_DEFAULT, EXP_MIN_SAMPLE_GLOBAL } from '@jev-router/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Optimization target label (EXP-3 §4.9.7 "优化目标"). */
export type ThresholdOptimizationTarget =
  /** Maximize coverage at fixed low-confidence precision floor. */
  | 'max-coverage-at-precision-floor'
  /** Minimize human-takeover while keeping ECE under target. */
  | 'min-takeover-at-ece-ceiling';

/**
 * A single observation used by the threshold scanner (derived from
 * confirmed `ExperienceEntry` records).
 */
export interface ThresholdSample {
  /** Calibrated confidence recorded at decision time. */
  confidence: number;
  /** True iff the outcome confirmed the winner (status='confirmed', label=winner). */
  hit: boolean;
  /** Original tier at decision time (catalog of decisions). */
  originalTier: 'ROUTE' | 'GATE' | 'ESCALATE';
}

/** The threshold to optimize (one of the three tier boundaries). */
export type ThresholdKind = 'high' | 'mid';

/** Counterfactual explanation (EXP-3 §4.9.7 "反事实说明"). */
export interface CounterfactualExplanation {
  /** How many archives previously auto-routed (ROUTE) would become GATE/ESCALATE under new threshold. */
  routeToHumanCount: number;
  /** How many archives previously human-routed (GATE/ESCALATE) would become ROUTE under new threshold. */
  humanToRouteCount: number;
  /** Net change in auto-route count (positive = more auto). */
  netAutoDelta: number;
  /** Free-text summary suitable for an audit log. */
  summary: string;
}

/** A generated threshold suggestion (EXP-3 §4.9.7 output). */
export interface ThresholdSuggestion {
  /** Which threshold (high = ROUTE boundary, mid = GATE boundary). */
  kind: ThresholdKind;
  /** Currently configured threshold. */
  current: number;
  /** Suggested threshold (MAY equal current if no improvement found). */
  suggested: number;
  /** Optimization target used. */
  optimizationTarget: ThresholdOptimizationTarget;
  /** Number of confirmed samples used. */
  sampleCount: number;
  /** Minimum sample floor (EXP_MIN_SAMPLE_GLOBAL). */
  sampleFloor: number;
  /** True when sampleCount < sampleFloor (no suggestion produced). */
  insufficient: boolean;
  /** Deficit samples (how many more are needed); 0 if sufficient. */
  sampleDeficit: number;
  /** Expected impact (auto-route rate, precision delta, takeover rate). */
  expectedImpact: {
    /** Auto-route coverage at current threshold. */
    coverageCurrent: number;
    /** Auto-route coverage at suggested threshold. */
    coverageSuggested: number;
    /** Precision among auto-routed at low confidence, current. */
    lowConfidencePrecisionCurrent: number;
    /** Precision among auto-routed at low confidence, suggested. */
    lowConfidencePrecisionSuggested: number;
    /** Human-takeover rate, current. */
    takeoverCurrent: number;
    /** Human-takeover rate, suggested. */
    takeoverSuggested: number;
  };
  /** Counterfactual explanation. */
  counterfactual: CounterfactualExplanation;
  /** Generation timestamp. */
  generatedAt: string;
}

/** Configuration for the suggestion generator. */
export interface ThresholdSuggestionConfig {
  /** Target low-confidence precision floor (default 0.90). */
  precisionFloor: number;
  /** Optimization target. */
  optimizationTarget: ThresholdOptimizationTarget;
  /** Step size for the candidate scan (default 0.01). */
  scanStep: number;
  /** Lower bound of the candidate scan range (default 0.50). */
  scanLow: number;
  /** Upper bound of the candidate scan range (default 0.95). */
  scanHigh: number;
  /** Sample floor — defaults to EXP_MIN_SAMPLE_GLOBAL. */
  sampleFloor: number;
}

/** Default configuration. */
export const DEFAULT_THRESHOLD_SUGGESTION_CONFIG: ThresholdSuggestionConfig = {
  precisionFloor: 0.9,
  optimizationTarget: 'max-coverage-at-precision-floor',
  scanStep: 0.01,
  scanLow: 0.5,
  scanHigh: 0.95,
  sampleFloor: EXP_MIN_SAMPLE_GLOBAL,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ThresholdSuggestionErrorCode =
  | 'INSUFFICIENT_SAMPLES'
  | 'INVALID_CONFIG'
  | 'NO_FEASIBLE_THRESHOLD';

export class ThresholdSuggestionError extends Error {
  constructor(
    readonly code: ThresholdSuggestionErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'ThresholdSuggestionError';
  }
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * ThresholdSuggestionGenerator — T-4.5.
 *
 * Stateless; takes samples as input, produces deterministic suggestions.
 *
 * Usage:
 *  1. Build samples from confirmed `ExperienceEntry` records.
 *  2. `generateSuggestions(samples, config)` returns one suggestion per
 *     `ThresholdKind`.
 *  3. Operator reviews via `human-review.ts`; production thresholds only
 *     change after explicit approval.
 */
export class ThresholdSuggestionGenerator {
  /**
   * Generate suggestions for the `high` (ROUTE boundary) and `mid` (GATE
   * boundary) thresholds. Returns both; callers select which to apply.
   *
   * The scan is **deterministic** (same samples + config → same suggestions).
   */
  generateSuggestions(
    samples: ReadonlyArray<ThresholdSample>,
    config: Partial<ThresholdSuggestionConfig> = {},
  ): {
    high: ThresholdSuggestion;
    mid: ThresholdSuggestion;
  } {
    const cfg: ThresholdSuggestionConfig = {
      ...DEFAULT_THRESHOLD_SUGGESTION_CONFIG,
      ...config,
    };
    validateConfig(cfg);

    // Sample-floor guard — even insufficient samples produce a
    // "no suggestion" record so callers know explicitly (EXP-3 §4.9.7).
    const sampleCount = samples.length;
    const insufficient = sampleCount < cfg.sampleFloor;
    const sampleDeficit = insufficient ? cfg.sampleFloor - sampleCount : 0;

    const noOp = (kind: ThresholdKind, current: number): ThresholdSuggestion => {
      return {
        kind,
        current,
        suggested: current,
        optimizationTarget: cfg.optimizationTarget,
        sampleCount,
        sampleFloor: cfg.sampleFloor,
        insufficient,
        sampleDeficit,
        expectedImpact: {
          coverageCurrent: 0,
          coverageSuggested: 0,
          lowConfidencePrecisionCurrent: 0,
          lowConfidencePrecisionSuggested: 0,
          takeoverCurrent: 0,
          takeoverSuggested: 0,
        },
        counterfactual: {
          routeToHumanCount: 0,
          humanToRouteCount: 0,
          netAutoDelta: 0,
          summary: insufficient
            ? `Insufficient confirmed samples (${sampleCount}/${cfg.sampleFloor}); no suggestion produced (EXP-3).`
            : 'No feasible threshold improving the objective without violating precision floor (EXP-3).',
        },
        generatedAt: new Date().toISOString(),
      };
    };

    if (insufficient) {
      return { high: noOp('high', ROUTE_TIER_DEFAULT.high), mid: noOp('mid', ROUTE_TIER_DEFAULT.mid) };
    }

    return {
      high: this.scanThreshold('high', ROUTE_TIER_DEFAULT.high, samples, cfg),
      mid: this.scanThreshold('mid', ROUTE_TIER_DEFAULT.mid, samples, cfg),
    };
  }

  /**
   * Format a counterfactual explanation as human-readable text (EXP-3
   * §4.9.7 "反事实说明"). Suitable for an audit log entry.
   */
  formatCounterfactual(s: ThresholdSuggestion): string {
    const cf = s.counterfactual;
    return [
      `[EXP-3 threshold suggestion — kind=${s.kind}]`,
      `Current=${s.current.toFixed(2)} → Suggested=${s.suggested.toFixed(2)}`,
      `Target=${s.optimizationTarget}; samples=${s.sampleCount}/${s.sampleFloor}`,
      s.insufficient
        ? `INSUFFICIENT: ${s.sampleDeficit} more confirmed samples required.`
        : '',
      `Coverage: current=${pct(s.expectedImpact.coverageCurrent)} → suggested=${pct(s.expectedImpact.coverageSuggested)}`,
      `Low-conf precision: current=${pct(s.expectedImpact.lowConfidencePrecisionCurrent)} → suggested=${pct(s.expectedImpact.lowConfidencePrecisionSuggested)}`,
      `Takeover: current=${pct(s.expectedImpact.takeoverCurrent)} → suggested=${pct(s.expectedImpact.takeoverSuggested)}`,
      `Counterfactual: ${cf.routeToHumanCount} auto→human, ${cf.humanToRouteCount} human→auto (net ${cf.netAutoDelta >= 0 ? '+' : ''}${cf.netAutoDelta} auto).`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Deterministic grid scan over candidate thresholds in `[scanLow, scanHigh]`
   * with step `scanStep`. For each candidate, compute coverage (fraction of
   * samples auto-routed: confidence ≥ candidate) and low-confidence precision
   * (precision among samples in [mid, high) bucket — i.e. low-confidence
   * auto-routed candidates).
   *
   * Picks the candidate maximizing coverage subject to:
   *  - low-confidence precision ≥ cfg.precisionFloor
   *  - tie-broken by smaller absolute delta from current (deterministic)
   *  - if no candidate improves over current without violating the floor,
   *    returns `current` with no-op summary (EXP-3: never auto-apply).
   */
  private scanThreshold(
    kind: ThresholdKind,
    current: number,
    samples: ReadonlyArray<ThresholdSample>,
    cfg: ThresholdSuggestionConfig,
  ): ThresholdSuggestion {
    const candidates: number[] = [];
    for (let t = cfg.scanLow; t <= cfg.scanHigh + 1e-9; t += cfg.scanStep) {
      // Round to avoid float drift.
      candidates.push(Math.round(t * 100) / 100);
    }

    let best = current;
    let bestCoverage = computeCoverage(current, samples);
    let bestLowConfPrec = computeLowConfidencePrecision(current, samples, kind);
    let bestTakeover = computeTakeover(current, samples);
    for (const c of candidates) {
      const coverage = computeCoverage(c, samples);
      const lowConfPrec = computeLowConfidencePrecision(c, samples, kind);
      if (lowConfPrec < cfg.precisionFloor) continue;
      if (
        coverage > bestCoverage + 1e-9 ||
        (Math.abs(coverage - bestCoverage) < 1e-9 && Math.abs(c - current) < Math.abs(best - current))
      ) {
        best = c;
        bestCoverage = coverage;
        bestLowConfPrec = lowConfPrec;
        bestTakeover = computeTakeover(c, samples);
      }
    }

    const coverageCurrent = computeCoverage(current, samples);
    const lowConfPrecCurrent = computeLowConfidencePrecision(current, samples, kind);
    const takeoverCurrent = computeTakeover(current, samples);
    const cf = computeCounterfactual(current, best, samples, kind);

    return {
      kind,
      current,
      suggested: best,
      optimizationTarget: cfg.optimizationTarget,
      sampleCount: samples.length,
      sampleFloor: cfg.sampleFloor,
      insufficient: false,
      sampleDeficit: 0,
      expectedImpact: {
        coverageCurrent,
        coverageSuggested: bestCoverage,
        lowConfidencePrecisionCurrent: lowConfPrecCurrent,
        lowConfidencePrecisionSuggested: bestLowConfPrec,
        takeoverCurrent,
        takeoverSuggested: bestTakeover,
      },
      counterfactual: cf,
      generatedAt: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Fraction of samples whose confidence ≥ threshold (i.e. auto-routed). */
export function computeCoverage(threshold: number, samples: ReadonlyArray<ThresholdSample>): number {
  if (samples.length === 0) return 0;
  let above = 0;
  for (const s of samples) {
    if (s.confidence >= threshold) above += 1;
  }
  return above / samples.length;
}

/**
 * Precision among samples whose confidence is in `[mid, high)` (low-confidence
 * auto-routed). Used as the floor constraint when scanning `high`; used as the
 * floor when scanning `mid` (with `[low, mid)` range; here "low" defaults to 0).
 *
 * Returns 1.0 when there are no samples in the bucket (vacuously precise).
 */
export function computeLowConfidencePrecision(
  threshold: number,
  samples: ReadonlyArray<ThresholdSample>,
  kind: ThresholdKind,
): number {
  // For 'high' kind: low-confidence bucket is [mid, high).
  // For 'mid' kind: low-confidence bucket is [0, mid).
  const lo = kind === 'high' ? ROUTE_TIER_DEFAULT.mid : 0;
  const hi = threshold;
  let inBucket = 0;
  let hits = 0;
  for (const s of samples) {
    if (s.confidence >= lo && s.confidence < hi) {
      inBucket += 1;
      if (s.hit) hits += 1;
    }
  }
  if (inBucket === 0) return 1; // vacuously precise
  return hits / inBucket;
}

/** Human-takeover rate: fraction of samples below threshold (not auto-routed). */
export function computeTakeover(threshold: number, samples: ReadonlyArray<ThresholdSample>): number {
  if (samples.length === 0) return 0;
  let below = 0;
  for (const s of samples) {
    if (s.confidence < threshold) below += 1;
  }
  return below / samples.length;
}

/**
 * Compute the counterfactual flip counts (EXP-3 §4.9.7 "反事实说明").
 * "Auto-routed" = confidence ≥ threshold; "human-routed" = confidence < threshold.
 */
export function computeCounterfactual(
  current: number,
  suggested: number,
  samples: ReadonlyArray<ThresholdSample>,
  _kind: ThresholdKind,
): CounterfactualExplanation {
  let routeToHuman = 0;
  let humanToRoute = 0;
  for (const s of samples) {
    const isAutoCurrent = s.confidence >= current;
    const isAutoSuggested = s.confidence >= suggested;
    if (isAutoCurrent && !isAutoSuggested) routeToHuman += 1;
    if (!isAutoCurrent && isAutoSuggested) humanToRoute += 1;
  }
  const net = humanToRoute - routeToHuman;
  return {
    routeToHumanCount: routeToHuman,
    humanToRouteCount: humanToRoute,
    netAutoDelta: net,
    summary:
      `Under suggested threshold ${suggested.toFixed(2)}: ${routeToHuman} archives previously auto-routed would become human-routed; ` +
      `${humanToRoute} previously human-routed would become auto-routed; ` +
      `net ${net >= 0 ? '+' : ''}${net} auto-route.`,
  };
}

/** Validate generator configuration. */
export function validateConfig(cfg: ThresholdSuggestionConfig): void {
  if (!(cfg.scanStep > 0 && cfg.scanStep < 1)) {
    throw new ThresholdSuggestionError('INVALID_CONFIG', `scanStep must be in (0, 1); got ${cfg.scanStep}`);
  }
  if (!(cfg.scanLow >= 0 && cfg.scanLow < cfg.scanHigh)) {
    throw new ThresholdSuggestionError('INVALID_CONFIG', `scanLow (${cfg.scanLow}) must be < scanHigh (${cfg.scanHigh})`);
  }
  if (!(cfg.scanHigh <= 1)) {
    throw new ThresholdSuggestionError('INVALID_CONFIG', `scanHigh must be ≤ 1; got ${cfg.scanHigh}`);
  }
  if (!(cfg.precisionFloor >= 0 && cfg.precisionFloor <= 1)) {
    throw new ThresholdSuggestionError('INVALID_CONFIG', `precisionFloor must be in [0, 1]; got ${cfg.precisionFloor}`);
  }
  if (!(cfg.sampleFloor > 0)) {
    throw new ThresholdSuggestionError('INVALID_CONFIG', `sampleFloor must be > 0; got ${cfg.sampleFloor}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
