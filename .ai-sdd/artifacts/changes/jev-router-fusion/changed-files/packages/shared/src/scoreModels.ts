/**
 * `scoreModels` — SCORE-1 / SCORE-2 / SCORE-3 weighted capability scoring (§4.4).
 *
 * Computes per-model `raw` score via a weighted sum of capability/quality/
 * cost/latency minus a load penalty, then converts to a probability
 * distribution via adaptive-temperature softmax.
 *
 * Two-form contract guarantees:
 *  - **双序契约**: output carries both catalog order (matches input descriptor
 *    order) and rank order (sorted by raw desc). All identity lookups MUST
 *    go through `catalogIndex`, never `rankIndex` (§4.6 下标契约).
 *  - **注入点唯一**: experience bias (`priorDelta[]` from `priorDeltaFor`)
 *    MUST be added to `raw` BEFORE softmax. Adding it afterwards would break
 *    the derivation `prob_i = exp(raw_i / T) / Σ exp(...)` and invalidate the
 *    dual-order invariant (§4.4 "经验偏置 SHALL NOT 在 softmax 之后再加").
 *
 * The `penalty = 26 × load^2.2` formula is monotonically increasing in `load`
 * to discourage routing toward congested nodes (§4.4).
 */
import {
  LOAD_PENALTY_COEFF,
  LOAD_PENALTY_EXP,
  RAW_DECIMALS,
  SOFTMAX_ALPHA_DEFAULT,
  SOFTMAX_T0_DEFAULT,
} from './constants.js';
import type {
  ModelDescriptor,
  PolicySnapshot,
  ScoreResult,
  ScoredModel,
} from './types.js';
import { clamp, round, softmax, spread } from './utils/math.js';

/** Normalize a PolicySnapshot, filling missing fields with defaults. */
function resolvePolicy(policy: PolicySnapshot): PolicySnapshot {
  const wCap = Number.isFinite(policy.w_capability)
    ? policy.w_capability
    : 0;
  const wQual = Number.isFinite(policy.w_quality) ? policy.w_quality : 0;
  const wCost = Number.isFinite(policy.w_cost) ? policy.w_cost : 0;
  const wLat = Number.isFinite(policy.w_latency) ? policy.w_latency : 0;
  const sumW = wCap + wQual + wCost + wLat;
  // Spec: weights MUST sum to 1. If they don't (e.g. user error), normalize.
  const norm = sumW > 0 ? 1 / sumW : 1;
  return {
    w_capability: wCap * norm,
    w_quality: wQual * norm,
    w_cost: wCost * norm,
    w_latency: wLat * norm,
    T0: policy.T0 > 0 ? policy.T0 : SOFTMAX_T0_DEFAULT,
    alpha: policy.alpha >= 0 ? policy.alpha : SOFTMAX_ALPHA_DEFAULT,
  };
}

/** Sanitize a ModelDescriptor field to a finite 0..1 value. */
function safe01(x: number | undefined, fallback = 0): number {
  if (x === undefined || !Number.isFinite(x)) return fallback;
  return clamp(x, 0, 1);
}

/**
 * Score a set of models under a locked policy snapshot.
 *
 * @param models       Catalog of model descriptors (input order = catalog order)
 * @param policy       Locked policy snapshot (weights, softmax T0/α)
 * @param priorDeltas  Optional experience-bias corrections aligned to catalog
 *                     order (output of `priorDeltaFor`). Defaults to 0.
 */
export function scoreModels(
  models: readonly ModelDescriptor[],
  policy: PolicySnapshot,
  priorDeltas?: readonly number[],
): ScoreResult {
  if (models.length === 0) {
    return {
      byCatalogOrder: [],
      byRankOrder: [],
      temperature: resolvePolicy(policy).T0,
      spread: 0,
    };
  }
  const p = resolvePolicy(policy);

  // Stage 1 — raw score per model (catalog order preserved).
  const raws: number[] = new Array(models.length);
  for (let i = 0; i < models.length; i += 1) {
    const m = models[i];
    const capability = safe01(m.capability);
    const quality = safe01(m.quality);
    const cost = safe01(m.cost);
    const latency = safe01(m.latency);
    const load = safe01(m.load);
    const score =
      p.w_capability * capability +
      p.w_quality * quality +
      p.w_cost * cost +
      p.w_latency * latency;
    const penalty = LOAD_PENALTY_COEFF * Math.pow(load, LOAD_PENALTY_EXP);
    const priorDelta = priorDeltas && i < priorDeltas.length ? priorDeltas[i] : 0;
    const safePriorDelta = Number.isFinite(priorDelta) ? priorDelta : 0;
    raws[i] = round(score - penalty + safePriorDelta, RAW_DECIMALS);
  }

  // Stage 2 — adaptive temperature softmax (§4.4: T = T0 × (1 + α × spread)).
  const sp = spread(raws);
  const temperature = p.T0 * (1 + p.alpha * sp);
  const probabilities = softmax(raws, temperature);

  // Stage 3 — assemble catalog-order view.
  const byCatalogOrder: ScoredModel[] = raws.map((raw, i) => {
    const m = models[i];
    return {
      modelId: m.modelId,
      catalogIndex: i,
      rankIndex: 0, // filled after sort
      raw,
      probability: probabilities[i],
      capability: safe01(m.capability),
      cost: safe01(m.cost),
      latency: safe01(m.latency),
    };
  });

  // Stage 4 — rank-order view (stable sort by raw desc; ties resolved by
  // input catalog order — `tieBreak` produces a strict order when needed).
  const byRankOrder: ScoredModel[] = byCatalogOrder
    .map((m) => ({ ...m }))
    .sort((a, b) => (a.raw > b.raw ? -1 : a.raw < b.raw ? 1 : 0));

  // Backfill `rankIndex` in both views so callers can cross-reference.
  for (let r = 0; r < byRankOrder.length; r += 1) {
    const model = byRankOrder[r];
    model.rankIndex = r;
    byCatalogOrder[model.catalogIndex].rankIndex = r;
  }

  return { byCatalogOrder, byRankOrder, temperature, spread: sp };
}

export { LOAD_PENALTY_COEFF, LOAD_PENALTY_EXP } from './constants.js';
