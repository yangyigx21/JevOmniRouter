/**
 * `computeRun` — ANIM-1 seven-stage deterministic timeline (§4.7).
 *
 * The 3D animation timeline is divided into exactly seven stages matching
 * the decision runtime main chain (`JEV-11`):
 *
 *   STATE → QUESTIONS → JEV → PROBABILITY → ROUTE → EXECUTE → RESULT
 *
 * Two formal contracts (`ANIM-1` scenarios):
 *
 * 1. **时长自洽 (Duration consistency)**: `Σ stage.durationMs === totalMs`.
 *    Verified by construction — the function normalizes stage weights to
 *    sum to 1 before distributing `totalDurationMs` across stages.
 *
 * 2. **非有限输入防御 (Non-finite input defense)**: when the caller passes
 *    `NaN` / `±Infinity` for `totalDurationMs` or any stage weight, the
 *    function clamps/substitutes rather than throwing. This is the
 *    "system SHALL 夹取而非崩溃" guarantee from `ANIM-1` scenario 2.
 *
 * Stage weights are caller-supplied positive numbers in any scale; they are
 * normalized internally. An omitted / malformed weight vector falls back
 * to equal weights (`1/7` per stage).
 */
import {
  RUN_DEFAULT_TOTAL_MS,
  RUN_MIN_TOTAL_MS,
  STAGE_COUNT,
  STAGE_NAMES,
} from './constants.js';
import type { ComputeRunInput, RunTimeline, StageTiming } from './types.js';

/**
 * Sanitize the total duration: non-finite → default; below floor → floor.
 */
function sanitizeTotal(total: number | undefined): number {
  if (total === undefined || !Number.isFinite(total)) {
    return RUN_DEFAULT_TOTAL_MS;
  }
  if (total < RUN_MIN_TOTAL_MS) {
    return RUN_MIN_TOTAL_MS;
  }
  return total;
}

/**
 * Normalize stage weights to a probability vector (sum = 1).
 * Falls back to equal weights if the input is missing, wrong length, or
 * contains any non-finite / non-positive values.
 */
function normalizeWeights(weights: number[] | undefined): number[] {
  const fallback = new Array<number>(STAGE_COUNT).fill(1 / STAGE_COUNT);
  if (!weights || !Array.isArray(weights)) return fallback;
  if (weights.length !== STAGE_COUNT) return fallback;
  const safe: number[] = [];
  let sum = 0;
  for (let i = 0; i < STAGE_COUNT; i += 1) {
    const w = weights[i];
    if (!Number.isFinite(w) || w <= 0) {
      return fallback;
    }
    safe.push(w);
    sum += w;
  }
  if (sum <= 0) return fallback;
  return safe.map((w) => w / sum);
}

/**
 * Compute the seven-stage deterministic timeline.
 *
 * @param input.totalDurationMs Total run duration; defaults to 4200ms.
 * @param input.stageWeights    Optional 7-element weight vector (any positive
 *                             scale); defaults to equal weights.
 */
export function computeRun(input: ComputeRunInput = {}): RunTimeline {
  const totalMs = sanitizeTotal(input.totalDurationMs);
  const weights = normalizeWeights(input.stageWeights);

  const stages: StageTiming[] = new Array(STAGE_COUNT);
  let cursor = 0;
  // Use the residual (totalMs - accumulated) for the final stage to absorb
  // any floating-point drift and guarantee exact self-consistency.
  let accumulated = 0;
  for (let i = 0; i < STAGE_COUNT; i += 1) {
    const isLast = i === STAGE_COUNT - 1;
    const duration = isLast
      ? totalMs - accumulated
      : totalMs * weights[i];
    const start = cursor;
    const end = start + duration;
    stages[i] = {
      index: i,
      name: STAGE_NAMES[i],
      startMs: start,
      durationMs: duration,
      endMs: end,
    };
    cursor = end;
    accumulated += duration;
  }

  return { stages, totalMs };
}

export {
  RUN_DEFAULT_TOTAL_MS,
  RUN_MIN_TOTAL_MS,
  STAGE_COUNT,
  STAGE_NAMES,
} from './constants.js';
