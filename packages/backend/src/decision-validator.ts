/**
 * Decision Validator — JEV-6 (§4.10).
 *
 * Decision objects MUST pass JSON Schema validation. Validation failure
 * MUST NOT enter model call. Decisions carry `schemaVersion`, `decisionId`,
 * `createdAt`, and output candidate model scores, selected model,
 * `confidence`, `rationale`, knowledge references.
 *
 * Schema validation failure → short-circuit and return `INVALID_DECISION`.
 *
 * This module pairs with `decision-contract.ts` (JEV-12):
 *  - JEV-12 validates the **question** (the contract) → `INCOMPLETE_CONTRACT`
 *  - JEV-6 (here) validates the **answer** (the decision) → `INVALID_DECISION`
 *
 * Per JEV-1: local heuristics MUST NOT be wrapped as `TypeSafeJevDecision`
 * with `decisionSource=TYPE_SAFE_JEV`. The validator does not check
 * `decisionSource` (that's JEV-7's job) — it only checks structural validity.
 */
import type { JevProvider } from './decision-source.js';

/** Schema version of the Jev response (JEV-6). */
export const DECISION_SCHEMA_VERSION = '1.0.0';

/** A single candidate model score in a Jev decision (JEV-6). */
export interface JevCandidateScore {
  modelId: string;
  raw: number;
  probability?: number;
}

/** The TypeSafe Jev decision object (spec.md 附录 A.3). */
export interface JevDecision {
  decisionId: string;
  schemaVersion: string;
  createdAt: string;
  /** Jev's selected recommendation (advisory only per CONSTRAIN-3). */
  selectedRecommendation: string;
  /** Full candidate scores (catalog-order; full distribution for JEV-16). */
  candidateScores: JevCandidateScore[];
  /** Calibrated confidence (0..1). */
  confidence: number;
  /** Human-readable rationale. */
  rationale: string;
  /** Knowledge references (citations, sources). */
  knowledgeReferences: string[];
  /** Provider tag (only `system-one` when real; absent for local). */
  provider?: JevProvider;
  /** Jev's model version (for audit). */
  modelVersions?: Record<string, string>;
}

/** Validation result. */
export interface ValidationResult {
  ok: boolean;
  /** `INVALID_DECISION` when validation fails; `OK` when valid. */
  code: 'OK' | 'INVALID_DECISION';
  violations: ValidationViolation[];
}

export interface ValidationViolation {
  field: string;
  message: string;
}

/**
 * Validate a Jev decision object (JEV-6).
 *
 * Rules:
 *  1. `decisionId` MUST be non-empty.
 *  2. `schemaVersion` MUST equal `DECISION_SCHEMA_VERSION`.
 *  3. `createdAt` MUST be a valid ISO 8601 string.
 *  4. `selectedRecommendation` MUST be non-empty.
 *  5. `candidateScores` MUST be a non-empty array.
 *  6. Each candidate score MUST have `modelId` + `raw` (number).
 *  7. `confidence` MUST be a finite number in [0, 1].
 *  8. `rationale` MUST be non-empty (no silent decisions).
 *
 * @returns `{ ok: false, code: 'INVALID_DECISION', violations }` on failure.
 */
export function validateDecision(
  decision: Partial<JevDecision>,
): ValidationResult {
  const violations: ValidationViolation[] = [];

  // 1. decisionId
  if (typeof decision.decisionId !== 'string' || decision.decisionId.trim() === '') {
    violations.push({
      field: 'decisionId',
      message: 'MUST be a non-empty string',
    });
  }

  // 2. schemaVersion
  if (decision.schemaVersion !== DECISION_SCHEMA_VERSION) {
    violations.push({
      field: 'schemaVersion',
      message: `MUST equal "${DECISION_SCHEMA_VERSION}"; got "${decision.schemaVersion ?? '<missing>'}"`,
    });
  }

  // 3. createdAt
  if (typeof decision.createdAt !== 'string' || Number.isNaN(Date.parse(decision.createdAt))) {
    violations.push({
      field: 'createdAt',
      message: 'MUST be a valid ISO 8601 string',
    });
  }

  // 4. selectedRecommendation
  if (
    typeof decision.selectedRecommendation !== 'string' ||
    decision.selectedRecommendation.trim() === ''
  ) {
    violations.push({
      field: 'selectedRecommendation',
      message: 'MUST be non-empty (advisory; final selection by Selector per CONSTRAIN-3)',
    });
  }

  // 5. candidateScores
  if (!Array.isArray(decision.candidateScores) || decision.candidateScores.length === 0) {
    violations.push({
      field: 'candidateScores',
      message: 'MUST be a non-empty array (full distribution for JEV-16)',
    });
  } else {
    // 6. Each candidate score
    for (let i = 0; i < decision.candidateScores.length; i += 1) {
      const cs = decision.candidateScores[i];
      if (!cs || typeof cs.modelId !== 'string' || cs.modelId.trim() === '') {
        violations.push({
          field: `candidateScores[${i}].modelId`,
          message: 'MUST be a non-empty string',
        });
      }
      if (cs && (!Number.isFinite(cs.raw) || cs.raw < 0)) {
        violations.push({
          field: `candidateScores[${i}].raw`,
          message: 'MUST be a finite non-negative number',
        });
      }
    }
  }

  // 7. confidence
  if (
    typeof decision.confidence !== 'number' ||
    !Number.isFinite(decision.confidence) ||
    decision.confidence < 0 ||
    decision.confidence > 1
  ) {
    violations.push({
      field: 'confidence',
      message: 'MUST be a finite number in [0, 1]',
    });
  }

  // 8. rationale
  if (typeof decision.rationale !== 'string' || decision.rationale.trim() === '') {
    violations.push({
      field: 'rationale',
      message: 'MUST be non-empty (no silent decisions)',
    });
  }

  return {
    ok: violations.length === 0,
    code: violations.length === 0 ? 'OK' : 'INVALID_DECISION',
    violations,
  };
}

/**
 * Assert a decision is valid; throws on failure.
 * Used at the JEV → PROBABILITY → ROUTE boundary to short-circuit invalid
 * decisions before they enter the Selector.
 */
export function assertValidDecision(decision: Partial<JevDecision>): JevDecision {
  const result = validateDecision(decision);
  if (!result.ok) {
    const summary = result.violations
      .map((v) => `${v.field}: ${v.message}`)
      .join('; ');
    throw new InvalidDecisionError(
      `INVALID_DECISION: ${summary}`,
    );
  }
  return decision as JevDecision;
}

/** Error thrown when decision validation fails (JEV-6). */
export class InvalidDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDecisionError';
  }
}
