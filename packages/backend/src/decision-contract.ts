/**
 * Decision Contract — JEV-12 (§4.10).
 *
 * "question is part of the program" — a production-grade Jev question is a
 * versioned contract, not an ad-hoc prompt.
 *
 * 8 required fields (spec.md 附录 A.7):
 *  1. `stateFields`    — declares which of the JEV-14 6 state segments this decision consumes
 *  2. `instructions`   — **actually** tells the model the judgment rules (MUST NOT hide rules in key names)
 *  3. `criteria`       — option descriptions or rubric
 *  4. `fallback`       — outcome when no option holds (non-empty)
 *  5. `consequenceThresholds` — high/mid thresholds graded by consequence (§4.12)
 *  6. `allowedAction`  — action permitted (e.g. `route_only`); enforced by ENFORCE layer
 *  7. `escalationPath` — escalation route for low-confidence / irreversible
 *  8. `version`        — contract version (e.g. `ticket-router@3`); independent from app code
 *
 * Contract validation: missing `instructions` or `fallback` → `INCOMPLETE_CONTRACT`,
 * short-circuits BEFORE calling Jev (paired with JEV-6 Schema guard: the former
 * validates the **question**, the latter validates the **answer**).
 */
import type { RouteTierThresholds } from '@jev-router/shared';

/** Three primitive question types (JEV-2, §4.10). */
export type PrimitiveType = 'choice' | 'score' | 'noul';

/** Consequence tier for `consequenceThresholds` (JEV-15, §4.12). */
export type ConsequenceLevel = 'low' | 'medium' | 'high' | 'irreversible';

/** Per-consequence thresholds (JEV-15). */
export interface ConsequenceThresholds {
  consequence: ConsequenceLevel;
  thresholds: RouteTierThresholds;
}

/** Option for a `choice` primitive (JEV-13 — must include escape hatch). */
export interface ContractOption {
  id: string;
  description: string;
}

/** Rubric band for a `score` primitive (JEV-13 — bands are ordered, not precise measurements). */
export interface RubricBand {
  band: string;
  description: string;
}

/** The 8-field decision contract (JEV-12, spec.md 附录 A.7). */
export interface DecisionContract {
  /** 1. State segments this decision consumes (subset of JEV-14 6 segments). */
  stateFields: readonly StateSegment[];
  /** 2. Judgment rules — MUST be complete in `instructions`, not hidden in key names. */
  instructions: string;
  /** 3. Option descriptions (choice) or rubric (score). */
  criteria: ContractOption[] | RubricBand[];
  /** 4. Fallback outcome when no option holds (non-empty). */
  fallback: string;
  /** 5. Per-consequence thresholds (JEV-15). */
  consequenceThresholds: ConsequenceThresholds[];
  /** 6. Action permitted (e.g. `route_only`); enforced by ENFORCE layer. */
  allowedAction: string;
  /** 7. Escalation route for low-confidence / irreversible. */
  escalationPath: string;
  /** 8. Contract version (e.g. `ticket-router@3`); independent from app code. */
  version: string;
  /** Primitive type (derived from criteria shape). */
  primitive: PrimitiveType;
  /** Optional preference prior (JEV-9 — routing preference as typed prior). */
  preferencePrior?: 'economy' | 'balanced' | 'quality';
}

/** JEV-14 six state segments. */
export type StateSegment =
  | 'GOAL'
  | 'FACTS'
  | 'ARTIFACTS'
  | 'EVIDENCE'
  | 'CONSTRAINTS'
  | 'OPTIONS';

/** Escape-hatch option ids for `choice` primitive (JEV-13 — required when menu may be incomplete). */
export const CHOICE_ESCAPE_HATCHES = ['none', 'other', 'stop', 'escalate'] as const;

/** Contract validation error codes. */
export type ContractErrorCode = 'INCOMPLETE_CONTRACT' | 'ESCAPE_HATCH_MISSING' | 'CRITERIA_MISMATCH';

export interface ContractValidationError {
  code: ContractErrorCode;
  field: string;
  message: string;
}

/** All 8 required field names for parity check. */
const REQUIRED_FIELDS = [
  'stateFields',
  'instructions',
  'criteria',
  'fallback',
  'consequenceThresholds',
  'allowedAction',
  'escalationPath',
  'version',
] as const;

/**
 * Validate a decision contract per JEV-12.
 *
 * Rules:
 *  - All 8 fields MUST exist → else `INCOMPLETE_CONTRACT`.
 *  - `instructions` MUST be non-empty (rules MUST NOT hide in key names).
 *  - `fallback` MUST be non-empty.
 *  - `choice` primitive MUST include an escape hatch option (JEV-13).
 *  - `criteria` shape MUST match `primitive` (options for choice, bands for score).
 *  - `stateFields` MUST be a subset of JEV-14 6 segments.
 *  - `consequenceThresholds` MUST NOT be empty; each entry needs consequence + thresholds.
 */
export function validateContract(
  contract: Partial<DecisionContract>,
): ContractValidationError[] {
  const errors: ContractValidationError[] = [];

  // 1. Field presence (INCOMPLETE_CONTRACT).
  for (const field of REQUIRED_FIELDS) {
    const value = contract[field];
    if (value === undefined || value === null) {
      errors.push({
        code: 'INCOMPLETE_CONTRACT',
        field,
        message: `Missing required field: ${field}`,
      });
    }
  }

  // 2. instructions non-empty (rules not hidden in key names).
  if (typeof contract.instructions === 'string' && contract.instructions.trim() === '') {
    errors.push({
      code: 'INCOMPLETE_CONTRACT',
      field: 'instructions',
      message: 'instructions MUST be non-empty; rules MUST NOT be hidden in key names',
    });
  }

  // 3. fallback non-empty.
  if (typeof contract.fallback === 'string' && contract.fallback.trim() === '') {
    errors.push({
      code: 'INCOMPLETE_CONTRACT',
      field: 'fallback',
      message: 'fallback MUST be non-empty',
    });
  }

  // 4. stateFields subset of 6 segments.
  const allSegments: StateSegment[] = ['GOAL', 'FACTS', 'ARTIFACTS', 'EVIDENCE', 'CONSTRAINTS', 'OPTIONS'];
  if (Array.isArray(contract.stateFields)) {
    for (const sf of contract.stateFields) {
      if (!allSegments.includes(sf)) {
        errors.push({
          code: 'INCOMPLETE_CONTRACT',
          field: 'stateFields',
          message: `Unknown state segment: ${sf}; MUST be one of GOAL/FACTS/ARTIFACTS/EVIDENCE/CONSTRAINTS/OPTIONS`,
        });
      }
    }
  }

  // 5. consequenceThresholds non-empty + each has consequence + thresholds.
  if (Array.isArray(contract.consequenceThresholds)) {
    if (contract.consequenceThresholds.length === 0) {
      errors.push({
        code: 'INCOMPLETE_CONTRACT',
        field: 'consequenceThresholds',
        message: 'consequenceThresholds MUST NOT be empty (JEV-15: thresholds MUST be graded by consequence)',
      });
    } else {
      for (const ct of contract.consequenceThresholds) {
        if (!ct || !ct.consequence || !ct.thresholds) {
          errors.push({
            code: 'INCOMPLETE_CONTRACT',
            field: 'consequenceThresholds',
            message: 'Each consequenceThreshold MUST have consequence + thresholds',
          });
        }
      }
    }
  }

  // 6. primitive + criteria shape + escape hatch (JEV-13).
  const primitive = contract.primitive;
  const criteria = contract.criteria;
  if (primitive && criteria) {
    if (primitive === 'choice') {
      if (!Array.isArray(criteria) || criteria.length === 0) {
        errors.push({
          code: 'CRITERIA_MISMATCH',
          field: 'criteria',
          message: 'choice primitive requires non-empty options array',
        });
      } else {
        // Escape hatch required (JEV-13).
        const ids = (criteria as ContractOption[]).map((o) => o.id);
        const hasHatch = ids.some((id) =>
          (CHOICE_ESCAPE_HATCHES as readonly string[]).includes(id),
        );
        if (!hasHatch) {
          errors.push({
            code: 'ESCAPE_HATCH_MISSING',
            field: 'criteria',
            message: `choice primitive MUST include an escape hatch option (${CHOICE_ESCAPE_HATCHES.join('/')})`,
          });
        }
      }
    } else if (primitive === 'score') {
      if (!Array.isArray(criteria) || criteria.length === 0) {
        errors.push({
          code: 'CRITERIA_MISMATCH',
          field: 'criteria',
          message: 'score primitive requires non-empty rubric bands array',
        });
      }
    } else if (primitive === 'noul') {
      // noul has no criteria array; just instructions.
      if (Array.isArray(criteria) && criteria.length > 0) {
        errors.push({
          code: 'CRITERIA_MISMATCH',
          field: 'criteria',
          message: 'noul primitive MUST NOT have criteria options',
        });
      }
    }
  }

  return errors;
}

/**
 * Register a decision contract; throws on validation failure.
 * Short-circuits BEFORE calling Jev (paired with JEV-6 answer-side guard).
 */
export function registerContract(
  contract: DecisionContract,
): DecisionContract {
  const errors = validateContract(contract);
  if (errors.length > 0) {
    const summary = errors.map((e) => `${e.code}[${e.field}]: ${e.message}`).join('; ');
    throw new ContractValidationError_(errors[0].code, summary, errors);
  }
  return contract;
}

/** Error class thrown by `registerContract`. */
export class ContractValidationError_ extends Error {
  readonly errors: ContractValidationError[];
  constructor(
    readonly code: ContractErrorCode,
    message: string,
    errors: ContractValidationError[],
  ) {
    super(`${code}: ${message}`);
    this.name = 'ContractValidationError';
    this.errors = errors;
  }
}

/**
 * Infer `primitive` from `criteria` shape (helper for contract authors).
 *  - `ContractOption[]` → `choice`
 *  - `RubricBand[]` → `score`
 *  - absent / empty → `noul`
 */
export function inferPrimitive(
  criteria: ContractOption[] | RubricBand[] | undefined,
): PrimitiveType {
  if (!Array.isArray(criteria) || criteria.length === 0) return 'noul';
  const first = criteria[0];
  if (first && typeof first === 'object' && 'band' in first) return 'score';
  if (first && typeof first === 'object' && 'id' in first) return 'choice';
  return 'noul';
}

/** Look up thresholds for a given consequence level (JEV-15). */
export function thresholdsFor(
  contract: DecisionContract,
  consequence: ConsequenceLevel,
): RouteTierThresholds {
  for (const ct of contract.consequenceThresholds) {
    if (ct.consequence === consequence) return ct.thresholds;
  }
  // Fallback: irreversible → strictest (high=1.0, mid=1.0 → always ESCALATE).
  if (consequence === 'irreversible') {
    return { high: 1.0, mid: 1.0 };
  }
  // Default: route tier defaults.
  return { high: 0.82, mid: 0.6 };
}

/** Check whether a consequence level is irreversible (JEV-15 → unconditional human review). */
export function isIrreversible(consequence: ConsequenceLevel): boolean {
  return consequence === 'irreversible';
}

/** Re-export shared types for convenience. */
export type { RouteTierThresholds } from '@jev-router/shared';
