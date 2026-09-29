/**
 * Experience Validator — Closed-Loop Auto-Validator — EXP-10 (T-4.9, §4.9.9).
 *
 * Splits confirmed `ExperienceEntry` records into **before** and **after**
 * segments at the timestamp a specific `expVersion` was applied, then
 * compares metrics across the two segments:
 *
 *  - Tier hit rate (fraction of auto-routed samples whose outcome was confirmed)
 *  - ECE (calibration error)
 *  - Cost savings (avg USD per confirmed auto-route)
 *  - Human-takeover rate (fraction not auto-routed)
 *
 * Verdict rules (§4.9.9):
 *  - `improved`  — at least one metric strictly improved, none strictly worse.
 *  - `neutral`   — no metric changed materially.
 *  - `degraded`  — any of: tier hit rate ↓, ECE ↑, cost savings ↓, takeover ↑.
 *  - `inconclusive` — post-segment samples insufficient. **MUST NOT** emit
 *                   `improved` in this case (EXP-10 scenario 2).
 *
 * `degraded` → produce an alert + a one-click rollback entry (operator
 * approval still required to actually roll back — EXP-9 §4.9.8).
 */
import { calibrationStats, type CalibrationSample } from '@jev-router/shared';
import type { ExperienceEntry } from './outcome-evaluator.js';
import type { ExperienceVersionManager, ExperienceVersion } from './experience-version.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Verdict of a closed-loop validation (EXP-10 §4.9.9). */
export type ValidationVerdict = 'improved' | 'neutral' | 'degraded' | 'inconclusive';

/** Metrics computed on a single segment (EXP-10). */
export interface SegmentMetrics {
  /** Number of confirmed + disputed samples in this segment. */
  sampleCount: number;
  /** Tier hit rate (auto-routed AND confirmed). */
  tierHitRate: number;
  /** Expected Calibration Error (10-bin). */
  ece: number;
  /** Average cost in USD per confirmed auto-routed sample. */
  avgCostPerAutoRoute: number;
  /** Fraction of samples NOT auto-routed (GATE + ESCALATE). */
  humanTakeoverRate: number;
  /** `true` iff ECE statistics are unreliable (sample < ECE_MIN_SAMPLE). */
  insufficient: boolean;
}

/** Output of a single validation run (EXP-10). */
export interface ValidationResult {
  /** `expVersion` whose application timestamp is the split boundary. */
  appliedVersion: number;
  /** Verdict (§4.9.9). */
  verdict: ValidationVerdict;
  /** Metrics on the pre-application segment. */
  before: SegmentMetrics;
  /** Metrics on the post-application segment. */
  after: SegmentMetrics;
  /** Per-metric deltas (after − before; positive = increase). */
  deltas: {
    tierHitRate: number;
    ece: number;
    avgCostPerAutoRoute: number;
    humanTakeoverRate: number;
  };
  /** Rationale for the verdict (machine-readable summary). */
  rationale: string;
  /** When `degraded`: one-click rollback entry (operator must approve). */
  rollbackSuggestion?: {
    targetVersion: number;
    reason: string;
  };
  /** Generation timestamp. */
  generatedAt: string;
}

/** Per-segment grouping input. */
export interface SegmentSplit {
  before: ExperienceEntry[];
  after: ExperienceEntry[];
  /** Boundary timestamp (`appliedAt` of the version event). */
  boundary: number;
  /** Version object providing the boundary. */
  version: ExperienceVersion;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ExperienceValidatorErrorCode =
  | 'VERSION_NOT_FOUND'
  | 'NO_ENTRIES'
  | 'INVALID_SEGMENT';

export class ExperienceValidatorError extends Error {
  constructor(
    readonly code: ExperienceValidatorErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'ExperienceValidatorError';
  }
}

// ---------------------------------------------------------------------------
// Thresholds (module-level per ARCH-5)
// ---------------------------------------------------------------------------

/** Minimum samples in the post-segment to draw any conclusion (EXP-10). */
export const EXP10_MIN_POST_SEGMENT = 30;

/**
 * Material-change threshold below which a metric delta is considered "no
 * meaningful change" (neutral rather than improved/degraded).
 */
export const EXP10_NEUTRAL_DELTA = 0.01;

// ---------------------------------------------------------------------------
// Experience Validator
// ---------------------------------------------------------------------------

/**
 * ExperienceValidator — T-4.9.
 *
 * Stateless; consults `ExperienceVersionManager` for the split boundary
 * and `ExperienceStore`-style entry arrays (passed in by caller).
 */
export class ExperienceValidator {
  constructor(private readonly versions: ExperienceVersionManager) {}

  /**
   * Validate the closed-loop effect of `appliedVersion` (EXP-10).
   *
   * @param appliedVersion  Version whose application timestamp is the boundary.
   * @param entries         Confirmed+disputed entries to segment (caller passes
   *                        pre-filtered data — typically `store.confirmedAndDisputed()`).
   */
  validateLoop(appliedVersion: number, entries: ReadonlyArray<ExperienceEntry>): ValidationResult {
    const split = this.segmentByVersion(appliedVersion, entries);
    const before = computeMetrics(split.before);
    const after = computeMetrics(split.after);

    const deltas = {
      tierHitRate: after.tierHitRate - before.tierHitRate,
      ece: after.ece - before.ece,
      avgCostPerAutoRoute: after.avgCostPerAutoRoute - before.avgCostPerAutoRoute,
      humanTakeoverRate: after.humanTakeoverRate - before.humanTakeoverRate,
    };

    const verdict = decideVerdict(before, after, deltas);
    const rationale = explainVerdict(verdict, deltas);

    const result: ValidationResult = {
      appliedVersion,
      verdict,
      before,
      after,
      deltas,
      rationale,
      generatedAt: new Date().toISOString(),
    };

    // `degraded` → suggest rollback (operator approves via human-review.ts).
    if (verdict === 'degraded') {
      const target = pickRollbackTarget(this.versions, appliedVersion);
      if (target !== null) {
        result.rollbackSuggestion = {
          targetVersion: target,
          reason: `Version V${appliedVersion} application degraded metrics (EXP-10 §4.9.9) — recommend atomic rollback to V${target}.`,
        };
      }
    }
    return result;
  }

  /**
   * Split `entries` into before / after segments at the timestamp the
   * given `appliedVersion` was applied (EXP-10 §4.9.9 split point).
   *
   * Boundary = `version.createdAt`. Entries with `observedAt < boundary`
   * go into `before`; entries with `observedAt >= boundary` go into `after`.
   */
  segmentByVersion(
    appliedVersion: number,
    entries: ReadonlyArray<ExperienceEntry>,
  ): SegmentSplit {
    let version: ExperienceVersion;
    try {
      version = this.versions.getVersion(appliedVersion);
    } catch {
      throw new ExperienceValidatorError(
        'VERSION_NOT_FOUND',
        `Version ${appliedVersion} not found`,
      );
    }
    const boundary = new Date(version.createdAt).getTime();
    if (!Number.isFinite(boundary)) {
      throw new ExperienceValidatorError(
        'INVALID_SEGMENT',
        `Version ${appliedVersion} has non-finite createdAt`,
      );
    }
    const before: ExperienceEntry[] = [];
    const after: ExperienceEntry[] = [];
    for (const e of entries) {
      const observedAt = e.outcome.observedAt;
      if (typeof observedAt !== 'number' || !Number.isFinite(observedAt)) {
        // Skip entries without a valid observation time — they cannot be
        // placed relative to the boundary.
        continue;
      }
      if (observedAt < boundary) before.push(e);
      else after.push(e);
    }
    return { before, after, boundary, version };
  }

  /**
   * Compare two segments head-to-head (EXP-10). Pure function — no
   * `versions` lookup required.
   */
  compareSegments(before: ExperienceEntry[], after: ExperienceEntry[]): {
    before: SegmentMetrics;
    after: SegmentMetrics;
    deltas: {
      tierHitRate: number;
      ece: number;
      avgCostPerAutoRoute: number;
      humanTakeoverRate: number;
    };
    verdict: ValidationVerdict;
    rationale: string;
  } {
    const b = computeMetrics(before);
    const a = computeMetrics(after);
    const deltas = {
      tierHitRate: a.tierHitRate - b.tierHitRate,
      ece: a.ece - b.ece,
      avgCostPerAutoRoute: a.avgCostPerAutoRoute - b.avgCostPerAutoRoute,
      humanTakeoverRate: a.humanTakeoverRate - b.humanTakeoverRate,
    } as const;
    return {
      before: b,
      after: a,
      deltas,
      verdict: decideVerdict(b, a, deltas),
      rationale: explainVerdict(decideVerdict(b, a, deltas), deltas),
    };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing / external use)
// ---------------------------------------------------------------------------

/**
 * Compute the four metrics for a single segment (EXP-10 §4.9.9).
 */
export function computeMetrics(entries: ReadonlyArray<ExperienceEntry>): SegmentMetrics {
  const valid = entries.filter(
    (e) => e.outcome.status === 'confirmed' || e.outcome.status === 'disputed',
  );
  const sampleCount = valid.length;
  if (sampleCount === 0) {
    return {
      sampleCount: 0,
      tierHitRate: 0,
      ece: 0,
      avgCostPerAutoRoute: 0,
      humanTakeoverRate: 0,
      insufficient: true,
    };
  }

  let autoRouted = 0;
  let autoRoutedConfirmed = 0;
  let autoRouteCostSum = 0;
  let takeover = 0;
  const calibrationSamples: CalibrationSample[] = [];

  for (const e of valid) {
    const tier = e.prediction.tier;
    const isAutoRouted = tier === 'ROUTE';
    const hit = e.outcome.status === 'confirmed' && e.outcome.label === e.prediction.winner;
    if (isAutoRouted) {
      autoRouted += 1;
      if (hit) autoRoutedConfirmed += 1;
      if (typeof e.outcome.cost === 'number' && Number.isFinite(e.outcome.cost)) {
        autoRouteCostSum += e.outcome.cost;
      }
    } else {
      takeover += 1;
    }
    calibrationSamples.push({ confidence: e.prediction.confidence, hit });
  }

  const tierHitRate = autoRouted > 0 ? autoRoutedConfirmed / autoRouted : 0;
  const stats = calibrationStats(calibrationSamples);
  const avgCost = autoRouted > 0 ? autoRouteCostSum / autoRouted : 0;
  const takeoverRate = sampleCount > 0 ? takeover / sampleCount : 0;

  return {
    sampleCount,
    tierHitRate,
    ece: stats.ece,
    avgCostPerAutoRoute: avgCost,
    humanTakeoverRate: takeoverRate,
    insufficient: stats.insufficient,
  };
}

/**
 * Decide the verdict (EXP-10 §4.9.9). Verdict rules:
 *  - `inconclusive` if post-segment sample count < `EXP10_MIN_POST_SEGMENT`
 *    (MUST NOT return `improved`).
 *  - `degraded` if any of:
 *      - tier hit rate dropped materially (`delta ≤ -EXP10_NEUTRAL_DELTA`)
 *      - ECE rose materially (`delta ≥ EXP10_NEUTRAL_DELTA`)
 *      - takeover rate rose materially (worse)
 *      - cost per auto-route rose materially (worse)
 *  - `improved` if at least one metric improved materially and none worsened.
 *  - `neutral` otherwise.
 */
export function decideVerdict(
  _before: SegmentMetrics,
  after: SegmentMetrics,
  deltas: {
    tierHitRate: number;
    ece: number;
    avgCostPerAutoRoute: number;
    humanTakeoverRate: number;
  },
): ValidationVerdict {
  // Inconclusive: post-segment insufficient (MUST NOT output improved).
  if (after.sampleCount < EXP10_MIN_POST_SEGMENT || after.insufficient) {
    return 'inconclusive';
  }

  // Material-change check — deltas below this threshold are treated as "no
  // meaningful change" (neutral).
  const T = EXP10_NEUTRAL_DELTA;

  // Degraded: any metric materially worse.
  const hitWorse = deltas.tierHitRate <= -T;
  const eceWorse = deltas.ece >= T;
  const costWorse = deltas.avgCostPerAutoRoute >= T;
  const takeoverWorse = deltas.humanTakeoverRate >= T;
  if (hitWorse || eceWorse || costWorse || takeoverWorse) {
    return 'degraded';
  }

  // Improved: at least one metric materially better, none materially worse.
  const hitBetter = deltas.tierHitRate >= T;
  const eceBetter = deltas.ece <= -T;
  const costBetter = deltas.avgCostPerAutoRoute <= -T;
  const takeoverBetter = deltas.humanTakeoverRate <= -T;
  if (hitBetter || eceBetter || costBetter || takeoverBetter) {
    return 'improved';
  }

  return 'neutral';
}

/** Build a human-readable rationale string for a verdict (EXP-10 audit). */
export function explainVerdict(
  verdict: ValidationVerdict,
  deltas: {
    tierHitRate: number;
    ece: number;
    avgCostPerAutoRoute: number;
    humanTakeoverRate: number;
  },
): string {
  const fmt = (x: number) => x.toFixed(4);
  const summary =
    `deltas {tierHitRate=${fmt(deltas.tierHitRate)}, ece=${fmt(deltas.ece)}, ` +
    `cost=${fmt(deltas.avgCostPerAutoRoute)}, takeover=${fmt(deltas.humanTakeoverRate)}}`;
  switch (verdict) {
    case 'improved':
      return `improved — at least one metric materially improved, none materially worse (${summary})`;
    case 'degraded':
      return `degraded — at least one metric materially worse (${summary}); produce alert + rollback entry (EXP-10 §4.9.9)`;
    case 'neutral':
      return `neutral — no material metric change (${summary})`;
    case 'inconclusive':
      return `inconclusive — post-segment samples insufficient (MUST NOT output improved, EXP-10 scenario 2)`;
    default:
      return `unknown verdict (${verdict})`;
  }
}

/**
 * Pick a rollback target for a `degraded` verdict (EXP-10 → EXP-9).
 * Heuristic: choose the version immediately before the applied version.
 * Returns `null` if no safe target exists (e.g. appliedVersion === 1).
 */
export function pickRollbackTarget(
  versions: ExperienceVersionManager,
  appliedVersion: number,
): number | null {
  if (appliedVersion <= 1) return null;
  const target = appliedVersion - 1;
  try {
    versions.getVersion(target);
    return target;
  } catch {
    return null;
  }
}
