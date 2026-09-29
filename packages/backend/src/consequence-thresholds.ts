/**
 * Consequence-Graded Thresholds — JEV-15 (§4.12).
 *
 * Confidence thresholds MUST bind to **action consequence levels**, NOT
 * a single system-wide threshold.
 *
 * | Action class        | Consequence level | Thresholds               |
 * |---------------------|-------------------|--------------------------|
 * | route_only (low)    | low               | { high: 0.90, mid: 0.70 } |
 * | route_with_audit     | medium            | { high: 0.82, mid: 0.60 } |
 * | publish / external   | high              | { high: 0.95, mid: 0.80 } |
 * | irreversible        | irreversible      | unconditional human review |
 *
 * Reference router (§4.12):
 * ```python
 * def route_decision(choice, confidence, consequence):
 *     if consequence == "irreversible":
 *         return "human_review"
 *     if confidence >= 0.90 and consequence == "low":
 *         return choice
 *     if confidence >= 0.70:
 *         return "collect_more_evidence"
 *     return "human_review"
 * ```
 *
 * Key discipline (§4.12): if confidence doesn't change routing, calibration
 * is just decoration. Retries under the same evidence are forbidden —
 * retries MUST spend **new evidence**, not more tokens (EXP-1, EXP-10).
 *
 * This module pairs with `routeTier` (shared): `routeTier` uses a single
 * threshold pair; `consequenceRouteTier` selects the threshold pair based
 * on consequence level, then delegates to `routeTier`.
 */
import { routeTier } from '@jev-router/shared';
import type { RouteTier } from '@jev-router/shared';
import type { ConsequenceLevel, ConsequenceThresholds } from './decision-contract.js';
import { isIrreversible } from './decision-contract.js';

/** Default threshold matrix by consequence level (§4.12 演示值). */
export const CONSEQUENCE_THRESHOLDS_DEFAULT: Record<ConsequenceLevel, ConsequenceThresholds> = {
  low: {
    consequence: 'low',
    thresholds: { high: 0.9, mid: 0.7 },
  },
  medium: {
    consequence: 'medium',
    thresholds: { high: 0.82, mid: 0.6 },
  },
  high: {
    consequence: 'high',
    thresholds: { high: 0.95, mid: 0.8 },
  },
  irreversible: {
    consequence: 'irreversible',
    // Unconditional human review — thresholds set so any confidence → ESCALATE.
    thresholds: { high: 1.0, mid: 1.0 },
  },
};

/** Policy registry: action class → consequence level. */
export interface ConsequencePolicy {
  /** Map of action class → consequence level (e.g. `route_only → low`). */
  actionConsequences: Record<string, ConsequenceLevel>;
  /** Per-consequence thresholds (overrides defaults if provided). */
  thresholdOverrides?: Partial<Record<ConsequenceLevel, ConsequenceThresholds>>;
}

/** Default action→consequence mapping (§4.12). */
export const DEFAULT_ACTION_CONSEQUENCES: Record<string, ConsequenceLevel> = {
  route_only: 'low',
  route_with_audit: 'medium',
  publish_external: 'high',
  publish_internal: 'medium',
  delete_data: 'irreversible',
  send_payment: 'irreversible',
  modify_account: 'high',
  collect_more_evidence: 'medium',
};

/**
 * Resolve thresholds for a consequence level from policy or defaults.
 */
export function resolveThresholds(
  policy: ConsequencePolicy,
  consequence: ConsequenceLevel,
): ConsequenceThresholds {
  const override = policy.thresholdOverrides?.[consequence];
  if (override) return override;
  return CONSEQUENCE_THRESHOLDS_DEFAULT[consequence];
}

/**
 * Resolve the consequence level for an action class from policy.
 * Defaults to `medium` when action class is unknown (conservative).
 */
export function resolveConsequence(
  policy: ConsequencePolicy,
  actionClass: string,
): ConsequenceLevel {
  return policy.actionConsequences[actionClass] ?? 'medium';
}

/**
 * Consequence-graded route tier (JEV-15).
 *
 * - `irreversible` consequence → unconditional `ESCALATE` regardless of confidence.
 * - Otherwise → delegate to `routeTier` with the consequence-specific thresholds.
 *
 * @returns the route tier AND a flag indicating whether it was forced by
 *   irreversibility (for audit / decision receipt, JEV-16).
 */
export function consequenceRouteTier(
  confidence: number,
  consequence: ConsequenceLevel,
  policy: ConsequencePolicy,
): { tier: RouteTier; forcedHumanReview: boolean; thresholds: ConsequenceThresholds } {
  if (isIrreversible(consequence)) {
    // §4.12: "irreversible → 无条件转人工，与置信度无关"
    return {
      tier: 'ESCALATE',
      forcedHumanReview: true,
      thresholds: CONSEQUENCE_THRESHOLDS_DEFAULT.irreversible,
    };
  }
  const ct = resolveThresholds(policy, consequence);
  const tier = routeTier(confidence, ct.thresholds);
  return { tier, forcedHumanReview: false, thresholds: ct };
}

/**
 * Validate a consequence policy: MUST NOT use a single threshold for all
 * consequence levels (JEV-15 scenario "单一阈值被拒").
 *
 * @returns list of violations; empty when policy is valid.
 */
export function validateConsequencePolicy(
  policy: ConsequencePolicy,
): string[] {
  const violations: string[] = [];
  // Check: at least 2 distinct consequence levels mapped.
  const levels = new Set(Object.values(policy.actionConsequences));
  if (levels.size < 2) {
    violations.push(
      `THRESHOLD_NOT_GRADED: policy maps all actions to a single consequence level (${[...levels][0] ?? 'none'}); MUST grade by consequence (JEV-15)`,
    );
  }
  // Check: irreversible actions MUST exist if any irreversible-mapped action is present.
  // (No-op: presence check is structural; if `delete_data` is mapped, it's there.)
  return violations;
}

/**
 * Check whether a retry is permitted under JEV-15 discipline.
 *
 * "同一证据下的重复不确定决策 MUST NOT 被重试" — retries MUST spend
 * new evidence, not more tokens (EXP-1, EXP-10).
 *
 * @param priorStateHash   Hash of the state at the prior decision attempt
 * @param currentStateHash Hash of the state at the retry attempt
 * @returns `true` iff the state has changed (new evidence collected).
 */
export function retryPermitted(
  priorStateHash: string,
  currentStateHash: string,
): boolean {
  return priorStateHash !== currentStateHash;
}
