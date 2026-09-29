/**
 * Constraint Selector — CONSTRAIN-1 / CONSTRAIN-2 / CONSTRAIN-3 (§4.5).
 *
 * Fixed 8-step hard-constraint pipeline. Any step failure makes the model
 * `ineligible` and records the primary elimination reason + full audit
 * summary.
 *
 * | Step | Constraint                    | Failure codes                              |
 * |------|-------------------------------|--------------------------------------------|
 * | 1    | Catalog enabled & health      | MODEL_DISABLED / MODEL_UNAVAILABLE         |
 * | 2    | Tenant/user permission        | MODEL_NOT_ALLOWED                          |
 * | 3    | Modality & capability         | MODALITY_UNSUPPORTED / CAPABILITY_MISSING   |
 * | 4    | Context & output limits       | CONTEXT_LIMIT_EXCEEDED                      |
 * | 5    | Data & region                 | DATA_POLICY_MISMATCH / REGION_NOT_ALLOWED   |
 * | 6    | Risk & security               | RISK_POLICY_BLOCKED                         |
 * | 7    | Budget & quota                | BUDGET_EXCEEDED / COST_UNKNOWN              |
 * | 8    | Latency hard limit            | LATENCY_LIMIT_EXCEEDED                      |
 *
 * CONSTRAIN-2: Hard constraints MUST NOT be overridden by soft scores or
 * Jev recommendations.
 *
 * CONSTRAIN-3: Jev's `selectedRecommendation` is advisory only; the final
 * model MUST be determined by the Selector after hard constraints.
 */
import type { CatalogEntry } from './model-catalog.js';
import type { Modality } from '@jev-router/shared';

/** Constraint step failure codes (CONSTRAIN-1). */
export type ConstraintErrorCode =
  | 'MODEL_DISABLED'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_NOT_ALLOWED'
  | 'MODALITY_UNSUPPORTED'
  | 'CAPABILITY_MISSING'
  | 'CONTEXT_LIMIT_EXCEEDED'
  | 'DATA_POLICY_MISMATCH'
  | 'REGION_NOT_ALLOWED'
  | 'RISK_POLICY_BLOCKED'
  | 'BUDGET_EXCEEDED'
  | 'COST_UNKNOWN'
  | 'LATENCY_LIMIT_EXCEEDED';

/** Result of a single constraint step for one model. */
export interface ConstraintStepResult {
  step: number;
  name: string;
  passed: boolean;
  code?: ConstraintErrorCode;
  reason?: string;
}

/** Full constraint evaluation for one model. */
export interface ModelConstraintResult {
  modelId: string;
  catalogIndex: number;
  eligible: boolean;
  /** The primary elimination reason (first step that failed). */
  primaryEliminationReason?: ConstraintErrorCode;
  /** Full audit summary (all 8 steps). */
  auditSummary: ConstraintStepResult[];
}

/** Input to the constraint pipeline. */
export interface ConstraintInput {
  model: CatalogEntry;
  catalogIndex: number;
  /** Task constraints from the prompt. */
  constraints: {
    enabled?: boolean;
    health?: boolean;
    allowedByTenant?: boolean;
    requiredModalities?: string[];
    requiredCapabilities?: string[];
    maxContextTokens?: number;
    maxOutputTokens?: number;
    dataRegions?: string[];
    riskPolicy?: 'allow' | 'block';
    budgetUsd?: number;
    costUnknownPolicy?: 'reject' | 'conservative';
    maxLatencyMs?: number;
  };
  /** Jev's recommendation (for CONSTRAIN-3 advisory check). */
  jevRecommendation?: string;
}

/**
 * Run the 8-step hard-constraint pipeline for a single model (CONSTRAIN-1).
 *
 * Steps are executed in fixed order. The first failing step becomes the
 * `primaryEliminationReason`. All steps are evaluated (for audit completeness)
 * even after the first failure.
 */
export function evaluateConstraints(input: ConstraintInput): ModelConstraintResult {
  const { model, catalogIndex, constraints } = input;
  const audit: ConstraintStepResult[] = [];
  let primaryReason: ConstraintErrorCode | undefined;
  let eligible = true;

  // Step 1: Catalog enabled & health
  const step1Passed = (model.enabled ?? true) && (model.health !== 'down');
  audit.push({
    step: 1,
    name: 'Catalog enabled & health',
    passed: step1Passed,
    code: step1Passed ? undefined : (model.enabled ? 'MODEL_UNAVAILABLE' : 'MODEL_DISABLED'),
    reason: step1Passed
      ? undefined
      : model.enabled
        ? `Model health is "${model.health}"`
        : 'Model is disabled in catalog',
  });
  if (!step1Passed && !primaryReason) {
    primaryReason = audit[0].code;
    eligible = false;
  }

  // Step 2: Tenant/user permission
  const step2Passed = constraints.allowedByTenant !== false;
  audit.push({
    step: 2,
    name: 'Tenant/user permission',
    passed: step2Passed,
    code: step2Passed ? undefined : 'MODEL_NOT_ALLOWED',
    reason: step2Passed ? undefined : 'Model not allowed for tenant/user',
  });
  if (!step2Passed && !primaryReason) {
    primaryReason = 'MODEL_NOT_ALLOWED';
    eligible = false;
  }

  // Step 3: Modality & capability
  const requiredMods = constraints.requiredModalities ?? [];
  const requiredCaps = constraints.requiredCapabilities ?? [];
  const modelMods = model.modalities ?? [];
  const modelCaps = model.capabilityTags ?? [];
  const modalityOk = requiredMods.every((m) => modelMods.includes(m as Modality));
  const capabilityOk = requiredCaps.every((c) => modelCaps.includes(c));
  const step3Passed = modalityOk && capabilityOk;
  audit.push({
    step: 3,
    name: 'Modality & capability',
    passed: step3Passed,
    code: step3Passed ? undefined : (modalityOk ? 'CAPABILITY_MISSING' : 'MODALITY_UNSUPPORTED'),
    reason: step3Passed
      ? undefined
      : modalityOk
        ? `Missing capabilities: ${requiredCaps.filter((c) => !modelCaps.includes(c)).join(', ')}`
        : `Missing modalities: ${requiredMods.filter((m) => !modelMods.includes(m as Modality)).join(', ')}`,
  });
  if (!step3Passed && !primaryReason) {
    primaryReason = audit[2].code;
    eligible = false;
  }

  // Step 4: Context & output limits
  const contextOk = !constraints.maxContextTokens || (model.contextWindow ?? Infinity) >= constraints.maxContextTokens;
  const step4Passed = contextOk;
  audit.push({
    step: 4,
    name: 'Context & output limits',
    passed: step4Passed,
    code: step4Passed ? undefined : 'CONTEXT_LIMIT_EXCEEDED',
    reason: step4Passed ? undefined : `Context window ${model.contextWindow} < required ${constraints.maxContextTokens}`,
  });
  if (!step4Passed && !primaryReason) {
    primaryReason = 'CONTEXT_LIMIT_EXCEEDED';
    eligible = false;
  }

  // Step 5: Data & region
  const requiredRegions = constraints.dataRegions ?? [];
  const modelRegions = model.dataRegion ?? [];
  const regionOk = requiredRegions.length === 0 || modelRegions.length === 0 || requiredRegions.some((r) => modelRegions.includes(r));
  const dataOk = constraints.riskPolicy !== 'block';
  const step5Passed = regionOk && dataOk;
  audit.push({
    step: 5,
    name: 'Data & region',
    passed: step5Passed,
    code: step5Passed ? undefined : (regionOk ? 'DATA_POLICY_MISMATCH' : 'REGION_NOT_ALLOWED'),
    reason: step5Passed
      ? undefined
      : regionOk
        ? 'Data policy mismatch'
        : `Model regions [${modelRegions}] don't include required [${requiredRegions}]`,
  });
  if (!step5Passed && !primaryReason) {
    primaryReason = audit[4].code;
    eligible = false;
  }

  // Step 6: Risk & security
  const step6Passed = constraints.riskPolicy !== 'block';
  audit.push({
    step: 6,
    name: 'Risk & security',
    passed: step6Passed,
    code: step6Passed ? undefined : 'RISK_POLICY_BLOCKED',
    reason: step6Passed ? undefined : 'Blocked by risk policy',
  });
  if (!step6Passed && !primaryReason) {
    primaryReason = 'RISK_POLICY_BLOCKED';
    eligible = false;
  }

  // Step 7: Budget & quota
  const costPer1k = model.inputPricePer1k + model.outputPricePer1k;
  const costKnown = costPer1k > 0;
  const budgetOk = !constraints.budgetUsd || costKnown;
  const step7Passed = budgetOk && (costKnown || constraints.costUnknownPolicy !== 'reject');
  audit.push({
    step: 7,
    name: 'Budget & quota',
    passed: step7Passed,
    code: step7Passed ? undefined : (costKnown ? 'BUDGET_EXCEEDED' : 'COST_UNKNOWN'),
    reason: step7Passed
      ? undefined
      : costKnown
        ? `Budget exceeded`
        : 'Cost unknown and policy is reject',
  });
  if (!step7Passed && !primaryReason) {
    primaryReason = audit[6].code;
    eligible = false;
  }

  // Step 8: Latency hard limit
  const latencyOk = !constraints.maxLatencyMs || model.p95LatencyMs <= constraints.maxLatencyMs;
  const step8Passed = latencyOk;
  audit.push({
    step: 8,
    name: 'Latency hard limit',
    passed: step8Passed,
    code: step8Passed ? undefined : 'LATENCY_LIMIT_EXCEEDED',
    reason: step8Passed ? undefined : `P95 latency ${model.p95LatencyMs}ms > limit ${constraints.maxLatencyMs}ms`,
  });
  if (!step8Passed && !primaryReason) {
    primaryReason = 'LATENCY_LIMIT_EXCEEDED';
    eligible = false;
  }

  return {
    modelId: model.modelId,
    catalogIndex,
    eligible,
    primaryEliminationReason: primaryReason,
    auditSummary: audit,
  };
}

/**
 * Run the constraint pipeline for all candidates and return eligible models
 * plus full audit (CONSTRAIN-1/2/3).
 *
 * CONSTRAIN-2: Jev recommendation MUST NOT bypass hard constraints.
 * CONSTRAIN-3: Final model is Selector's choice, not Jev's.
 */
export function selectEligible(
  models: CatalogEntry[],
  constraints: ConstraintInput['constraints'],
  jevRecommendation?: string,
): {
  eligible: CatalogEntry[];
  eliminated: ModelConstraintResult[];
  /** If Jev's recommendation was eliminated, record the reason (CONSTRAIN-3). */
  jevRecommendationEliminated?: ConstraintErrorCode;
} {
  const eliminated: ModelConstraintResult[] = [];
  const eligible: CatalogEntry[] = [];
  let jevRecEliminated: ConstraintErrorCode | undefined;

  for (let i = 0; i < models.length; i += 1) {
    const result = evaluateConstraints({
      model: models[i],
      catalogIndex: i,
      constraints,
      jevRecommendation,
    });
    if (result.eligible) {
      eligible.push(models[i]);
    } else {
      eliminated.push(result);
      // CONSTRAIN-3: if Jev's recommendation was eliminated, record it.
      if (jevRecommendation && models[i].modelId === jevRecommendation) {
        jevRecEliminated = result.primaryEliminationReason;
      }
    }
  }

  return {
    eligible,
    eliminated,
    jevRecommendationEliminated: jevRecEliminated,
  };
}
