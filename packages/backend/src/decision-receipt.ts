/**
 * Decision Receipt — JEV-16 (§4.13).
 *
 * The system MUST store **receipts** for each decision, not just the
 * winning label. A receipt SHALL contain:
 *
 *  - contract version
 *  - state reference (state_version / hash)
 *  - full probability distribution
 *  - thresholds used
 *  - route tier
 *  - actual action
 *
 * Receipts link to ARCHIVE-1 archive, EXP-6 pinned-version replay via the
 * same `requestId` correlation chain (EVENT-4). A decision without a
 * receipt is non-reproducible and non-auditable.
 *
 * **Safe ordering** (three-tier boundary enforcement, §4.13):
 *
 * ```
 * JEV JUDGES  →  CODE CHECKS POLICY  →  TOOL EXECUTES  →  TRACE RECORDS
 * ```
 *
 * The receipt is the TRACE RECORDS step — generated AFTER execution, not
 * before. But the receipt's CONTENT reflects the JEV JUDGES + CODE CHECKS
 * POLICY stages.
 */
import type { RouteTier, RouteTierThresholds } from '@jev-router/shared';
import type { ConsequenceLevel } from './decision-contract.js';
import type { DecisionSource } from './decision-source.js';

/** Full probability distribution entry (catalog-order). */
export interface ProbabilityEntry {
  modelId: string;
  catalogIndex: number;
  raw: number;
  probability: number;
}

/** The decision receipt (JEV-16, spec.md 附录 A.8). */
export interface DecisionReceipt {
  /** Unique decision identifier (correlates with EVENT-4 trace). */
  decisionId: string;
  /** Correlated request identifier. */
  requestId: string;
  /** Decision source (JEV-7). */
  decisionSource: DecisionSource;
  /** Contract version (e.g. `ticket-router@3`). */
  contractVersion: string;
  /** State reference — version string. */
  stateVersion: string;
  /** State reference — content hash. */
  stateHash: string;
  /** Full probability distribution (catalog-order; JEV-16 completeness). */
  probabilityDistribution: ProbabilityEntry[];
  /** Winning modelId (post-Selector; may differ from Jev recommendation). */
  finalModelId: string;
  /** Jev's recommended modelId (for audit, may differ from finalModelId per CONSTRAIN-3). */
  jevRecommendation?: string;
  /** Thresholds used (per consequence level, JEV-15). */
  thresholdsUsed: RouteTierThresholds;
  /** Consequence level applied (JEV-15). */
  consequence: ConsequenceLevel;
  /** Route tier output (ROUTE / GATE / ESCALATE). */
  routeTier: RouteTier;
  /** Whether human review was forced by irreversibility (JEV-15). */
  forcedHumanReview: boolean;
  /** Actual action taken (e.g. `route_only`, `escalate_to_human`). */
  actualAction: string;
  /** Calibrated confidence recorded (JEV-5). */
  confidence: number;
  /** Whether the decision was degraded (CONSTRAIN-4). */
  degraded: boolean;
  /**
   * 约束是否被忽略（JEV-11 正交性登记，附录 G-2）。
   *
   * true 表示候选池经**回落**得到，而非直接由约束筛选结果决定。
   * 使「档位与硬约束正交」这一断言可审计。
   */
  constraintFallback?: boolean;
  /** 回落原因（仅 `constraintFallback` 为 true 时有值）。 */
  constraintFallbackReason?: 'allowed_model_ids_not_in_catalog' | 'all_candidates_eliminated';
  /** Creation timestamp (ISO 8601). */
  createdAt: string;
  /** Schema version of the Jev response (JEV-6). */
  schemaVersion?: string;
  /** Optional rationale text from Jev (for transparency). */
  rationale?: string;
}

/** Input to `generateReceipt`. */
export interface GenerateReceiptInput {
  decisionId: string;
  requestId: string;
  decisionSource: DecisionSource;
  contractVersion: string;
  stateVersion: string;
  stateHash: string;
  probabilityDistribution: ProbabilityEntry[];
  finalModelId: string;
  jevRecommendation?: string;
  thresholdsUsed: RouteTierThresholds;
  consequence: ConsequenceLevel;
  routeTier: RouteTier;
  forcedHumanReview: boolean;
  actualAction: string;
  confidence: number;
  degraded?: boolean;
  /** 约束回落登记（JEV-11 附录 G-2）。 */
  constraintFallback?: boolean;
  constraintFallbackReason?: 'allowed_model_ids_not_in_catalog' | 'all_candidates_eliminated';
  schemaVersion?: string;
  rationale?: string;
}

/**
 * Generate a decision receipt (JEV-16).
 *
 * The receipt is the "TRACE RECORDS" step in the safe ordering
 * (§4.13). It MUST capture the complete decision state so the
 * decision is reproducible and auditable.
 *
 * @throws if any required field is missing (completeness guard).
 */
export function generateReceipt(input: GenerateReceiptInput): DecisionReceipt {
  // Completeness guard (JEV-16 scenario "凭据完整").
  const required: (keyof GenerateReceiptInput)[] = [
    'decisionId',
    'requestId',
    'decisionSource',
    'contractVersion',
    'stateVersion',
    'stateHash',
    'probabilityDistribution',
    'finalModelId',
    'thresholdsUsed',
    'consequence',
    'routeTier',
    'actualAction',
    'confidence',
  ];
  for (const field of required) {
    const value = input[field];
    if (value === undefined || value === null || value === '') {
      throw new ReceiptIncompleteError(
        `Decision receipt incomplete: missing required field "${field}" (JEV-16)`,
      );
    }
  }
  if (input.probabilityDistribution.length === 0) {
    throw new ReceiptIncompleteError(
      'Decision receipt incomplete: probabilityDistribution MUST be non-empty (JEV-16 "完整概率分布")',
    );
  }
  return {
    decisionId: input.decisionId,
    requestId: input.requestId,
    decisionSource: input.decisionSource,
    contractVersion: input.contractVersion,
    stateVersion: input.stateVersion,
    stateHash: input.stateHash,
    probabilityDistribution: input.probabilityDistribution,
    finalModelId: input.finalModelId,
    jevRecommendation: input.jevRecommendation,
    thresholdsUsed: input.thresholdsUsed,
    consequence: input.consequence,
    routeTier: input.routeTier,
    forcedHumanReview: input.forcedHumanReview,
    actualAction: input.actualAction,
    confidence: input.confidence,
    degraded: input.degraded ?? false,
    constraintFallback: input.constraintFallback ?? false,
    constraintFallbackReason: input.constraintFallbackReason,
    createdAt: new Date().toISOString(),
    schemaVersion: input.schemaVersion,
    rationale: input.rationale,
  };
}

/** Error thrown when receipt generation detects incompleteness. */
export class ReceiptIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptIncompleteError';
  }
}

/**
 * Verify that a receipt is reproducible: given the same contract version +
 * state + probability distribution, the same routing decision MUST result
 * (JEV-16 scenario "凭据可复现").
 *
 * @param receipt    The receipt to verify.
 * @param recompute  A function that re-derives the route tier from the
 *                   receipt's confidence + consequence + thresholds.
 * @returns `true` iff recomputed tier matches the receipt's recorded tier.
 */
export function verifyReproducible(
  receipt: DecisionReceipt,
  recompute: (confidence: number, consequence: ConsequenceLevel, thresholds: RouteTierThresholds) => RouteTier,
): boolean {
  const recomputedTier = recompute(
    receipt.confidence,
    receipt.consequence,
    receipt.thresholdsUsed,
  );
  return recomputedTier === receipt.routeTier;
}

/**
 * Audit summary for a receipt (human-readable, for trace and EXP-6 replay).
 */
export function summarizeReceipt(receipt: DecisionReceipt): string {
  const parts = [
    `decisionId=${receipt.decisionId}`,
    `source=${receipt.decisionSource}`,
    `contract=${receipt.contractVersion}`,
    `state=${receipt.stateVersion}#${receipt.stateHash.slice(0, 8)}`,
    `tier=${receipt.routeTier}`,
    `conf=${receipt.confidence}`,
    `consequence=${receipt.consequence}`,
    `forcedHuman=${receipt.forcedHumanReview}`,
    `action=${receipt.actualAction}`,
    `final=${receipt.finalModelId}`,
  ];
  if (receipt.jevRecommendation && receipt.jevRecommendation !== receipt.finalModelId) {
    parts.push(`jevRec=${receipt.jevRecommendation} (NOT final, per CONSTRAIN-3)`);
  }
  if (receipt.degraded) parts.push('degraded=true');
  if (receipt.constraintFallback) {
    parts.push(`constraintFallback=true (${receipt.constraintFallbackReason ?? 'unspecified'})`);
  }
  return parts.join(' · ');
}
