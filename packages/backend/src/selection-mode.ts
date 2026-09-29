/**
 * Selection Mode Attribution — EVENT-4 (§6.1 design.md).
 *
 * The system MUST distinguish three `selectionMode` values to avoid failures
 * being mis-attributed to a single model:
 *
 *   `TYPE_SAFE_JEV` | `RULE_FALLBACK` | `USER_OVERRIDE`
 *
 * Each RouteRecord (spec.md A.5) carries a `selectionMode` tag derived from
 * the `DecisionSource` (JEV-7). The mapping is:
 *
 * | DecisionSource   | selectionMode   | Rationale                                |
 * |------------------|-----------------|------------------------------------------|
 * | TYPE_SAFE_JEV    | TYPE_SAFE_JEV   | Production path (real System One API).   |
 * | LOCAL_REIMPL     | TYPE_SAFE_JEV   | Offline form of the TypeSafe Jev path    |
 * |                  |                 | (JEV-8); still a Jev path, not a rule.   |
 * | RULE_FALLBACK    | RULE_FALLBACK   | Jev timeout / invalid schema → fallback.|
 * | USER_OVERRIDE    | USER_OVERRIDE   | Human override.                          |
 *
 * The tag MUST be written to the RouteRecord and surfaced in aggregated
 * metrics (EVENT-4 scenario "归因区分断言") so that downstream consumers
 * can attribute latency / failure correctly (e.g. a `RULE_FALLBACK`
 * failure MUST NOT lower the recorded quality of the winning model from
 * `TYPE_SAFE_JEV` runs).
 */
import type { DecisionSource } from './decision-source.js';

// ---------------------------------------------------------------------------
// selectionMode contract
// ---------------------------------------------------------------------------

/** The three legitimate selection modes (EVENT-4). */
export type SelectionMode = 'TYPE_SAFE_JEV' | 'RULE_FALLBACK' | 'USER_OVERRIDE';

/** Whitelist of selectionMode values (for validation). */
export const SELECTION_MODES: readonly SelectionMode[] = [
  'TYPE_SAFE_JEV',
  'RULE_FALLBACK',
  'USER_OVERRIDE',
] as const;

/**
 * A RouteRecord excerpt carrying the selection-mode tag (spec.md A.5).
 *
 * Only the fields this module cares about are surfaced; the full
 * RouteRecord is owned by the archive module (Phase 4).
 */
export interface SelectionTaggedRecord {
  requestId: string;
  decisionId: string;
  executionId?: string;
  modelId: string;
  decisionSource: DecisionSource;
  selectionMode: SelectionMode;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SelectionModeErrorCode = 'INVALID_SELECTION_MODE' | 'SOURCE_MODE_MISMATCH';

export class SelectionModeError extends Error {
  constructor(
    readonly code: SelectionModeErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'SelectionModeError';
  }
}

// ---------------------------------------------------------------------------
// Tagging
// ---------------------------------------------------------------------------

/**
 * Map a `DecisionSource` to its `SelectionMode` (EVENT-4).
 *
 * LOCAL_REIMPL is folded into TYPE_SAFE_JEV because it is the offline form
 * of the same Jev path (JEV-8) — still not a rule fallback. The audit entry
 * still carries `decisionSource=LOCAL_REIMPL` (JEV-7 non-falsifiable) so
 * consumers can distinguish offline vs online Jev when needed.
 */
export function toSelectionMode(source: DecisionSource): SelectionMode {
  switch (source) {
    case 'TYPE_SAFE_JEV':
    case 'LOCAL_REIMPL':
      return 'TYPE_SAFE_JEV';
    case 'RULE_FALLBACK':
      return 'RULE_FALLBACK';
    case 'USER_OVERRIDE':
      return 'USER_OVERRIDE';
  }
}

/**
 * Tag a route record with its `selectionMode` (EVENT-4).
 *
 * The tag is derived PURELY from `decisionSource` to guarantee
 * non-falsifiability — callers cannot fabricate a `selectionMode`
 * inconsistent with the audit trail.
 */
export function tagSelectionMode(
  record: Pick<SelectionTaggedRecord, 'requestId' | 'decisionId' | 'modelId' | 'decisionSource'> & {
    executionId?: string;
  },
): SelectionTaggedRecord {
  const selectionMode = toSelectionMode(record.decisionSource);
  const tagged: SelectionTaggedRecord = {
    requestId: record.requestId,
    decisionId: record.decisionId,
    modelId: record.modelId,
    decisionSource: record.decisionSource,
    selectionMode,
  };
  if (record.executionId !== undefined) tagged.executionId = record.executionId;
  validateSelectionMode(tagged);
  return tagged;
}

// ---------------------------------------------------------------------------
// Retrieval & validation
// ---------------------------------------------------------------------------

/** Get the `selectionMode` for a DecisionSource (pure wrapper). */
export function getSelectionMode(source: DecisionSource): SelectionMode {
  return toSelectionMode(source);
}

/**
 * Validate that a tagged record's `selectionMode` is consistent with its
 * `decisionSource` (EVENT-4 non-falsifiability).
 *
 * @throws SelectionModeError on mismatch.
 */
export function validateSelectionMode(
  tagged: Pick<SelectionTaggedRecord, 'decisionSource' | 'selectionMode'>,
): asserts tagged is SelectionTaggedRecord {
  if (!SELECTION_MODES.includes(tagged.selectionMode)) {
    throw new SelectionModeError(
      'INVALID_SELECTION_MODE',
      `selectionMode "${tagged.selectionMode}" not in ${SELECTION_MODES.join('/')}`,
    );
  }
  const expected = toSelectionMode(tagged.decisionSource);
  if (tagged.selectionMode !== expected) {
    throw new SelectionModeError(
      'SOURCE_MODE_MISMATCH',
      `selectionMode "${tagged.selectionMode}" MUST equal "${expected}" for decisionSource=${tagged.decisionSource}`,
    );
  }
}

/**
 * Attribution helper — split a population of tagged records by
 * `selectionMode`. Used by the trace aggregator (EVENT-4) and the
 * experience loop (EXP-*) so that `RULE_FALLBACK` failures are not
 * charged to the winning model's quality score.
 *
 * @returns a map keyed by selectionMode with arrays of records.
 */
export function groupBySelectionMode<T extends SelectionTaggedRecord>(
  records: readonly T[],
): Record<SelectionMode, T[]> {
  const groups: Record<SelectionMode, T[]> = {
    TYPE_SAFE_JEV: [],
    RULE_FALLBACK: [],
    USER_OVERRIDE: [],
  };
  for (const r of records) {
    groups[r.selectionMode].push(r);
  }
  return groups;
}

/**
 * Filter records by attribution (EVENT-4 scenario "归因区分断言").
 *
 * Returns the subset of records whose `selectionMode` matches. Useful when
 * computing per-model quality so that fallback / override runs do not
 * pollute the TYPE_SAFE_JEV signal.
 */
export function filterBySelectionMode<T extends SelectionTaggedRecord>(
  records: readonly T[],
  mode: SelectionMode,
): T[] {
  return records.filter((r) => r.selectionMode === mode);
}
