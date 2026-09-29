/**
 * Three-Tier Responsibility Boundary Guard — JEV-12 / CONSTRAIN-1 / CONSTRAIN-3
 * (§4.13 "安全顺序", §2.4 proposal "三层权责").
 *
 * The system separates three responsibilities:
 *
 * | Layer    | Responsibility                              | Who                |
 * |----------|---------------------------------------------|--------------------|
 * | GENERATE | Generate content                             | LLM (Model Gateway)|
 * | DECIDE   | Decide which model / route / action          | Jev                |
 * | ENFORCE  | Enforce policy, hard constraints, selection | Code (Selector)    |
 *
 * Safe ordering (§4.13):
 *
 * ```
 * JEV JUDGES  →  CODE CHECKS POLICY  →  TOOL EXECUTES  →  TRACE RECORDS
 * ```
 *
 * Boundary violations this module guards against:
 *
 * 1. **DECIDE layer granting execution authority**: Jev's
 *    `selectedRecommendation` is advisory only; the ENFORCE layer (Selector)
 *    MUST make the final selection after hard constraints (CONSTRAIN-3).
 *    A high-confidence Jev recommendation does NOT bypass the Selector.
 *
 * 2. **ENFORCE layer overriding Jev judgment**: the Selector MUST NOT
 *    re-derive the route tier; it consumes the tier from the DECIDE layer.
 *    The Selector only filters WHICH models CAN run; the DECIDE layer
 *    decides HOW confidently to route.
 *
 * 3. **High-confidence bypassing policy**: even at `ROUTE` tier (high
 *    confidence), the final model MUST still pass all 8 hard-constraint
 *    steps. Confidence is orthogonal to hard constraints (JEV-11 scenario 2).
 */
import type { RouteTier } from '@jev-router/shared';

/** The three responsibility layers (proposal.md §2.4). */
export type ResponsibilityLayer = 'GENERATE' | 'DECIDE' | 'ENFORCE';

/** Result of a boundary guard check. */
export interface BoundaryGuardResult {
  ok: boolean;
  violations: BoundaryViolation[];
}

export type BoundaryViolationKind =
  | 'DECIDE_GRANTED_EXECUTION'
  | 'ENFORCE_OVERRIDDEN_JEV'
  | 'HIGH_CONFIDENCE_BYPASS_POLICY';

export interface BoundaryViolation {
  kind: BoundaryViolationKind;
  layer: ResponsibilityLayer;
  message: string;
}

/**
 * Guard 1 (CONSTRAIN-3): Jev's recommendation MUST NOT be treated as the
 * final execution model.
 *
 * @param jevRecommendation  ModelId that Jev recommended
 * @param finalModelId       ModelId that the Selector actually selected
 * @returns `ok: false` with `DECIDE_GRANTED_EXECUTION` violation iff
 *          `finalModelId` was set to `jevRecommendation` BEFORE the Selector
 *          ran. (After the Selector, equality is fine.)
 *
 * Note: this guard is a structural check — callers invoke it BEFORE the
 * Selector runs, to ensure `finalModelId` was not pre-populated.
 */
export function guardDecideNotEnforce(
  preSelectorFinalModel: string | undefined,
): BoundaryGuardResult {
  if (preSelectorFinalModel !== undefined && preSelectorFinalModel !== '') {
    return {
      ok: false,
      violations: [
        {
          kind: 'DECIDE_GRANTED_EXECUTION',
          layer: 'DECIDE',
          message:
            'DECIDE layer MUST NOT pre-populate finalModelId before Selector runs (CONSTRAIN-3). Jev recommendation is advisory only.',
        },
      ],
    };
  }
  return { ok: true, violations: [] };
}

/**
 * Guard 2 (JEV-11): the ENFORCE layer (Selector) MUST NOT re-derive the
 * route tier; it MUST consume the tier from the DECIDE layer.
 *
 * @param decideTier       Route tier output by the DECIDE layer (JEV-11)
 * @param enforceTierOverride  Any tier value the Selector tried to set
 * @returns `ok: false` with `ENFORCE_OVERRIDDEN_JEV` violation iff the
 *          Selector tried to override the DECIDE layer's tier.
 */
export function guardEnforceNotOverrideJev(
  decideTier: RouteTier,
  enforceTierOverride?: RouteTier,
): BoundaryGuardResult {
  if (enforceTierOverride !== undefined && enforceTierOverride !== decideTier) {
    return {
      ok: false,
      violations: [
        {
          kind: 'ENFORCE_OVERRIDDEN_JEV',
          layer: 'ENFORCE',
          message: `ENFORCE layer (Selector) MUST NOT re-derive route tier; DECIDE layer set "${decideTier}" but Selector tried to set "${enforceTierOverride}" (JEV-11)`,
        },
      ],
    };
  }
  return { ok: true, violations: [] };
}

/**
 * Guard 3 (CONSTRAIN-2 / JEV-11): high confidence does NOT bypass the
 * Selector's hard-constraint pipeline. Even at `ROUTE` tier, the final
 * model MUST pass all 8 hard-constraint steps.
 *
 * @param routeTier        Route tier from DECIDE layer
 * @param selectorRan      Whether the Selector actually ran (8-step filter)
 * @returns `ok: false` with `HIGH_CONFIDENCE_BYPASS_POLICY` violation iff
 *          the route tier is `ROUTE` but the Selector was skipped.
 */
export function guardHighConfidenceNeedsPolicy(
  routeTier: RouteTier,
  selectorRan: boolean,
): BoundaryGuardResult {
  if (routeTier === 'ROUTE' && !selectorRan) {
    return {
      ok: false,
      violations: [
        {
          kind: 'HIGH_CONFIDENCE_BYPASS_POLICY',
          layer: 'ENFORCE',
          message:
            'High-confidence ROUTE tier MUST still pass Selector 8-step hard constraints (CONSTRAIN-2). Confidence is orthogonal to policy.',
        },
      ],
    };
  }
  return { ok: true, violations: [] };
}

/**
 * Combined guard: run all three boundary checks in safe ordering.
 * Returns aggregated violations (does not short-circuit — all three are
 * checked even if the first fails, for audit completeness).
 */
export function enforceSafeOrdering(input: {
  decideTier: RouteTier;
  preSelectorFinalModel?: string;
  enforceTierOverride?: RouteTier;
  selectorRan: boolean;
}): BoundaryGuardResult {
  const g1 = guardDecideNotEnforce(input.preSelectorFinalModel);
  const g2 = guardEnforceNotOverrideJev(input.decideTier, input.enforceTierOverride);
  const g3 = guardHighConfidenceNeedsPolicy(input.decideTier, input.selectorRan);
  const violations = [...g1.violations, ...g2.violations, ...g3.violations];
  return { ok: violations.length === 0, violations };
}

/**
 * Trace the safe ordering stages (§4.13).
 * Returns the ordered stage list for logging / 3D visualization.
 */
export function safeOrderingStages(): readonly { stage: string; layer: ResponsibilityLayer }[] {
  return [
    { stage: 'JEV JUDGES', layer: 'DECIDE' },
    { stage: 'CODE CHECKS POLICY', layer: 'ENFORCE' },
    { stage: 'TOOL EXECUTES', layer: 'GENERATE' },
    { stage: 'TRACE RECORDS', layer: 'ENFORCE' },
  ] as const;
}
