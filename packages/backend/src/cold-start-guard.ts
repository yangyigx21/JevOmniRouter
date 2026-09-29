/**
 * Cold-start Guard & Shadow Protection — EXP-8 (T-4.4).
 *
 * Protects the experience loop from cold-start bias:
 *  - EXP_MIN_SAMPLE_PER_PAIR: minimum samples per (intent, modelId) pair before prior correction
 *  - EXP_MIN_SAMPLE_GLOBAL: minimum global samples before any prior correction
 *  - Cold start → zero correction (no modification to scoring)
 *  - Shadow mode for new expVersions: record but don't apply until human-approved
 */
import type { ExperienceSample } from '@jev-router/shared';
import { EXP_MIN_SAMPLE_PER_PAIR, EXP_MIN_SAMPLE_GLOBAL } from '@jev-router/shared';

// ---------------------------------------------------------------------------
// Cold-start detection
// ---------------------------------------------------------------------------

/** Result of a cold-start check. */
export interface ColdStartResult {
  /** Whether the system is in cold-start mode (insufficient data). */
  isColdStart: boolean;
  /** Total global sample count. */
  globalSampleCount: number;
  /** Per-pair sample counts (intent → modelId → count). */
  pairCounts: Map<string, number>;
  /** Which pairs are below the per-pair threshold. */
  belowThresholdPairs: Array<{ intent: string; modelId: string; count: number }>;
  /** Reason for cold-start, if applicable. */
  reason?: string;
}

/**
 * Check whether the system is in cold-start mode (EXP-8).
 *
 * Cold start is defined as:
 *  - Global sample count < EXP_MIN_SAMPLE_GLOBAL, OR
 *  - Any (intent, modelId) pair with samples < EXP_MIN_SAMPLE_PER_PAIR
 *
 * In cold-start mode, priorDeltaFor MUST return zero correction.
 */
export function checkColdStart(samples: ExperienceSample[]): ColdStartResult {
  const globalCount = samples.length;
  const pairCounts = new Map<string, number>();
  const belowThresholdPairs: Array<{ intent: string; modelId: string; count: number }> = [];

  for (const s of samples) {
    const key = `${s.intent}::${s.modelId}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }

  // Check per-pair thresholds
  for (const s of samples) {
    const key = `${s.intent}::${s.modelId}`;
    const count = pairCounts.get(key) ?? 0;
    if (count < EXP_MIN_SAMPLE_PER_PAIR) {
      // Only add once per unique pair
      if (!belowThresholdPairs.some((p) => `${p.intent}::${p.modelId}` === key)) {
        belowThresholdPairs.push({ intent: s.intent, modelId: s.modelId, count });
      }
    }
  }

  const isColdStart = globalCount < EXP_MIN_SAMPLE_GLOBAL || belowThresholdPairs.length > 0;
  let reason: string | undefined;
  if (globalCount < EXP_MIN_SAMPLE_GLOBAL) {
    reason = `Global sample count ${globalCount} < minimum ${EXP_MIN_SAMPLE_GLOBAL}`;
  } else if (belowThresholdPairs.length > 0) {
    reason = `${belowThresholdPairs.length} pair(s) below per-pair minimum ${EXP_MIN_SAMPLE_PER_PAIR}`;
  }

  return {
    isColdStart,
    globalSampleCount: globalCount,
    pairCounts,
    belowThresholdPairs,
    reason,
  };
}

/**
 * Get the sample count for a specific (intent, modelId) pair.
 */
export function getPairSampleCount(
  samples: ExperienceSample[],
  intent: string,
  modelId: string,
): number {
  return samples.filter((s) => s.intent === intent && s.modelId === modelId).length;
}

// ---------------------------------------------------------------------------
// Shadow mode guard (new expVersion protection)
// ---------------------------------------------------------------------------

/** Configuration for shadow guard. */
export interface ShadowGuardConfig {
  /** Number of decisions to shadow before allowing promotion. */
  shadowMinDecisions: number;
  /** Whether shadow mode is currently active. */
  shadowEnabled: boolean;
}

export const DEFAULT_SHADOW_GUARD_CONFIG: ShadowGuardConfig = {
  shadowMinDecisions: 50,
  shadowEnabled: true,
};

/** Shadow guard decision result. */
export interface ShadowGuardResult {
  /** Whether the decision should be in shadow mode. */
  shouldShadow: boolean;
  /** Reason for shadow mode, if applicable. */
  reason?: string;
}

/**
 * Determine whether a new expVersion should operate in shadow mode.
 *
 * New experience versions MUST run in shadow mode (record but don't apply)
 * until sufficient shadow decisions have been collected and a human approves
 * the promotion (EXP-8).
 */
export function shouldShadow(
  expVersion: string,
  activeVersion: string,
  shadowDecisionsCount: number,
  config: ShadowGuardConfig = DEFAULT_SHADOW_GUARD_CONFIG,
): ShadowGuardResult {
  if (!config.shadowEnabled) {
    return { shouldShadow: false };
  }

  if (expVersion === activeVersion) {
    // This is the active version — not in shadow mode.
    return { shouldShadow: false };
  }

  // New version — must shadow until enough decisions collected.
  if (shadowDecisionsCount < config.shadowMinDecisions) {
    return {
      shouldShadow: true,
      reason: `Version ${expVersion} has ${shadowDecisionsCount}/${config.shadowMinDecisions} shadow decisions; must reach minimum before promotion`,
    };
  }

  // Enough shadow decisions collected, but still requires human approval.
  return {
    shouldShadow: true,
    reason: `Version ${expVersion} has ${shadowDecisionsCount} shadow decisions; awaiting human approval for promotion`,
  };
}

/**
 * Get total sample count across all pairs.
 */
export function getSampleCount(samples: ExperienceSample[]): number {
  return samples.length;
}
