/**
 * Three Primitive Semantic Guards — JEV-13 (§4.10, spec.md 附录).
 *
 * The three primitive question types have strict semantics; misusing them
 * silently corrupts decisions. This module enforces:
 *
 * | Primitive | Semantic                                  | Forbidden misuse                                   |
 * |-----------|-------------------------------------------|----------------------------------------------------|
 * | `choice`  | Exactly one option wins                   | Menu may be incomplete without escape hatch        |
 * | `score`   | Ordered rating bands                     | Bands treated as precise measurements (`1.6` ≠ "80% good") |
 * | `noul`    | Yes/No probability                        | `≈0.5` ≠ "medium risk" — it means model CANNOT distinguish |
 *
 * Guards:
 *  - `guardChoiceEscapeHatch`: every `choice` primitive MUST include an
 *    escape hatch (`none` / `other` / `stop` / `escalate`) — refusing
 *    incomplete menus prevents forcing probability mass onto "least wrong".
 *  - `guardScoreNotMeasurement`: `score` primitives MUST declare band
 *    boundaries; inter-band values MUST NOT be interpreted as precise.
 *  - `guardNoulIndistinguishable`: `noul` P(yes) ≈ 0.5 MUST be reported as
 *    "model cannot distinguish" — NOT as "medium risk" or any other label.
 */
import {
  CHOICE_ESCAPE_HATCHES,
  type ContractOption,
  type RubricBand,
} from './decision-contract.js';

/** P(yes) value considered "indistinguishable" (within ±0.05 of 0.5). */
export const NOUL_INDISTINGUISHABLE_EPSILON = 0.05;

/** Minimum number of rubric bands for a `score` primitive (≥ 2 to be ordered). */
export const MIN_RUBRIC_BANDS = 2;

/**
 * Result of a primitive guard check.
 *  - `ok: true` when the primitive passes all guards.
 *  - `ok: false` with `violations` listing each failure.
 */
export interface GuardResult {
  ok: boolean;
  violations: PrimitiveViolation[];
}

export type PrimitiveViolationKind =
  | 'MISSING_ESCAPE_HATCH'
  | 'RUBRIC_TOO_FEW_BANDS'
  | 'RUBRIC_INTER_BAND_INTERPRETED'
  | 'NOUL_INDISTINGUISHABLE_MISLABELED';

export interface PrimitiveViolation {
  kind: PrimitiveViolationKind;
  field: string;
  message: string;
}

/**
 * Guard: every `choice` primitive MUST include an escape hatch (JEV-13).
 *
 * "When the menu may be incomplete, an escape hatch (`none` / `other` /
 * `stop` / `escalate`) MUST be provided; otherwise probability mass gets
 * forced onto the 'least wrong' answer."
 */
export function guardChoiceEscapeHatch(
  options: readonly ContractOption[],
): GuardResult {
  const violations: PrimitiveViolation[] = [];
  if (options.length === 0) {
    violations.push({
      kind: 'MISSING_ESCAPE_HATCH',
      field: 'options',
      message: 'choice primitive requires non-empty options',
    });
    return { ok: false, violations };
  }
  const ids = options.map((o) => o.id);
  const hasHatch = ids.some((id) =>
    (CHOICE_ESCAPE_HATCHES as readonly string[]).includes(id),
  );
  if (!hasHatch) {
    violations.push({
      kind: 'MISSING_ESCAPE_HATCH',
      field: 'options',
      message: `choice primitive MUST include an escape hatch option (${CHOICE_ESCAPE_HATCHES.join('/')}); menu may otherwise be incomplete`,
    });
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Guard: `score` primitives MUST declare ≥ 2 ordered bands, and inter-band
 * values MUST NOT be interpreted as precise measurements (JEV-13).
 *
 * "Bands are ordered; `1.6` is NOT '80% good' — it sits between bands 1
 * and 2 and has no finer interpretation."
 */
export function guardScoreNotMeasurement(
  bands: readonly RubricBand[],
): GuardResult {
  const violations: PrimitiveViolation[] = [];
  if (bands.length < MIN_RUBRIC_BANDS) {
    violations.push({
      kind: 'RUBRIC_TOO_FEW_BANDS',
      field: 'bands',
      message: `score primitive requires ≥ ${MIN_RUBRIC_BANDS} ordered bands (got ${bands.length})`,
    });
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Interpret a `score` primitive's result band index. Returns the band's
 * description; explicitly rejects inter-band interpretation.
 *
 * @param bands   The rubric bands (ordered).
 * @param index   The band index reported by the model (0-based).
 * @throws if `index` is not an integer band position.
 */
export function interpretScoreBand(
  bands: readonly RubricBand[],
  index: number,
): { band: RubricBand; precise: false } {
  if (!Number.isInteger(index) || index < 0 || index >= bands.length) {
    throw new ScoreInterpretationError(
      `score primitive result MUST be an integer band index in [0, ${bands.length - 1}]; got ${index}. Inter-band values are NOT precise measurements (JEV-13).`,
    );
  }
  return { band: bands[index], precise: false };
}

/** Error thrown when a `score` result is interpreted as a precise measurement. */
export class ScoreInterpretationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoreInterpretationError';
  }
}

/**
 * Guard: `noul` P(yes) ≈ 0.5 MUST be reported as "model cannot distinguish"
 * (JEV-13).
 *
 * "≈0.5 means the model CANNOT distinguish between yes and no — MUST NOT be
 * interpreted as 'medium risk' or any other ordinal label."
 *
 * @returns interpretation string: either "indistinguishable" or "leans-yes/leans-no"
 */
export function interpretNoulProbability(pYes: number): {
  indistinguishable: boolean;
  label: 'indistinguishable' | 'leans-yes' | 'leans-no';
} {
  if (!Number.isFinite(pYes)) {
    return { indistinguishable: true, label: 'indistinguishable' };
  }
  const p = Math.max(0, Math.min(1, pYes));
  if (Math.abs(p - 0.5) <= NOUL_INDISTINGUISHABLE_EPSILON + 1e-9) {
    return { indistinguishable: true, label: 'indistinguishable' };
  }
  return {
    indistinguishable: false,
    label: p > 0.5 ? 'leans-yes' : 'leans-no',
  };
}

/**
 * Guard: a `noul` primitive's reported P(yes) MUST NOT be labeled as
 * "medium risk" or any ordinal label when ≈ 0.5.
 */
export function guardNoulIndistinguishable(
  pYes: number,
  externalLabel: string,
): GuardResult {
  const interp = interpretNoulProbability(pYes);
  if (interp.indistinguishable) {
    const forbiddenLabels = ['medium', 'moderate', 'high', 'low', 'elevated'];
    const lower = externalLabel.toLowerCase();
    const misuse = forbiddenLabels.some((f) => lower.includes(f));
    if (misuse) {
      return {
        ok: false,
        violations: [
          {
            kind: 'NOUL_INDISTINGUISHABLE_MISLABELED',
            field: 'label',
            message: `noul P(yes)=${pYes} ≈ 0.5 means "model cannot distinguish"; MUST NOT be labeled "${externalLabel}" (JEV-13)`,
          },
        ],
      };
    }
  }
  return { ok: true, violations: [] };
}
