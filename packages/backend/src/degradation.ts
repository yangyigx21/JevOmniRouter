/**
 * Degradation & Shadow Mode — CONSTRAIN-4 / CONSTRAIN-5 (§5.2).
 *
 * CONSTRAIN-4 (显式降级与不可伪装):
 *  - Jev timeout / invalid Schema → MAY enter RULE_FALLBACK
 *  - MUST record `decisionSource=RULE_FALLBACK` + `decisionDegraded=true`
 *  - 3D MUST display "Jev 不可用/降级"
 *  - MUST NOT write degraded decisions into "Jev 正常决策" experience
 *  - MUST be toggleable via policy switch
 *
 * CONSTRAIN-5 (Shadow Mode 灰度验证):
 *  - New Jev version / fallback rule → MUST run in shadow mode first
 *  - Shadow decisions are recorded but MUST NOT drive actual execution
 *  - Comparison with human baseline required before promotion
 */
import type { DecisionSource } from './decision-source.js';
import type { JevDecision } from './decision-validator.js';

/** Fallback rule for degradation (CONSTRAIN-4). */
export interface FallbackRule {
  /** Unique rule identifier. */
  ruleId: string;
  /** Description of when this rule applies. */
  condition: string;
  /** The modelId to fall back to. */
  fallbackModelId: string;
  /** Whether this rule is currently enabled. */
  enabled: boolean;
  /** Whether this rule has been audited/approved for production. */
  audited: boolean;
}

/** Degradation result. */
export interface DegradationResult {
  /** Whether degradation occurred. */
  degraded: boolean;
  /** Decision source after degradation. */
  decisionSource: DecisionSource;
  /** Fallback model if degraded, undefined if not. */
  fallbackModelId?: string;
  /** The fallback rule that matched, if any. */
  matchedRule?: FallbackRule;
  /** Whether the decision should be written to experience store (CONSTRAIN-4: MUST NOT for degraded). */
  canWriteToExperience: boolean;
  /** Reason for degradation. */
  reason?: string;
}

/**
 * Evaluate degradation path (CONSTRAIN-4).
 *
 * @param jevError   The error from Jev call (timeout / invalid schema / unavailable).
 * @param rules      Available fallback rules (must be enabled AND audited).
 * @param policy     Whether degradation is allowed by policy.
 */
export function evaluateDegradation(input: {
  jevError?: 'TIMEOUT' | 'INVALID_SCHEMA' | 'UNAVAILABLE' | null;
  rules: FallbackRule[];
  policy: { degradationAllowed: boolean; requireAuditedRule: boolean };
}): DegradationResult {
  // No error → no degradation.
  if (!input.jevError) {
    return {
      degraded: false,
      decisionSource: 'TYPE_SAFE_JEV',
      canWriteToExperience: true,
    };
  }

  // Policy switch: degradation disabled → DECISION_TIMEOUT.
  if (!input.policy.degradationAllowed) {
    return {
      degraded: true,
      decisionSource: 'TYPE_SAFE_JEV',
      canWriteToExperience: false,
      reason: `DECISION_TIMEOUT: Jev error=${input.jevError}, degradation disabled by policy`,
    };
  }

  // Find first enabled + audited fallback rule.
  const eligibleRules = input.rules.filter(
    (r) => r.enabled && (!input.policy.requireAuditedRule || r.audited),
  );
  const matchedRule = eligibleRules[0];

  if (matchedRule) {
    // CONSTRAIN-4: RULE_FALLBACK with explicit marking.
    return {
      degraded: true,
      decisionSource: 'RULE_FALLBACK',
      fallbackModelId: matchedRule.fallbackModelId,
      matchedRule,
      canWriteToExperience: false, // MUST NOT write to "Jev normal" experience.
      reason: `RULE_FALLBACK: Jev error=${input.jevError}, rule=${matchedRule.ruleId}`,
    };
  }

  // No eligible fallback rule → DECISION_TIMEOUT, no model call.
  return {
    degraded: true,
    decisionSource: 'TYPE_SAFE_JEV',
    canWriteToExperience: false,
    reason: `DECISION_TIMEOUT: Jev error=${input.jevError}, no eligible fallback rule`,
  };
}

/** Shadow mode decision (CONSTRAIN-5). */
export interface ShadowDecision {
  /** The shadow decision (produced but not executed). */
  decision: JevDecision;
  /** Source of the shadow decision. */
  decisionSource: DecisionSource;
  /** Whether this is a shadow decision (always true here). */
  isShadow: true;
  /** The version/variant being tested. */
  shadowVariant: string;
  /** Human baseline to compare against. */
  humanBaseline?: string;
  /** Timestamp. */
  createdAt: string;
}

/** Shadow mode configuration. */
export interface ShadowModeConfig {
  /** Whether shadow mode is enabled. */
  enabled: boolean;
  /** The variant being tested (e.g. "jev-v2", "fallback-rule-A"). */
  variant: string;
  /** Whether promotion requires human baseline comparison. */
  requireHumanBaseline: boolean;
}

/**
 * Run a decision in shadow mode (CONSTRAIN-5).
 *
 * Shadow decisions are recorded but MUST NOT drive actual execution.
 * The function wraps the decision and marks it as shadow.
 */
export function runShadow(
  decision: JevDecision,
  decisionSource: DecisionSource,
  config: ShadowModeConfig,
): ShadowDecision | null {
  if (!config.enabled) return null;
  return {
    decision,
    decisionSource,
    isShadow: true,
    shadowVariant: config.variant,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Check whether a shadow decision is eligible for promotion to production.
 *
 * CONSTRAIN-5: promotion requires comparison with human baseline.
 * @returns list of promotion blockers; empty means eligible.
 */
export function checkShadowPromotion(
  shadow: ShadowDecision,
  humanBaseline?: string,
): { eligible: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (!humanBaseline) {
    blockers.push('CONSTRAIN-5: promotion requires human baseline comparison');
  }
  if (!shadow.decision.rationale) {
    blockers.push('CONSTRAIN-5: shadow decision must have rationale for comparison');
  }
  return { eligible: blockers.length === 0, blockers };
}
