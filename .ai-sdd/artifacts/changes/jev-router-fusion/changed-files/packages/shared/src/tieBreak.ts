/**
 * `tieBreak` — SCORE-4 robust tiebreak sequence (§4.4).
 *
 * When two models have equal (or near-equal) `raw` scores after
 * `scoreModels`, the ranking between them MUST be deterministic — without
 * this guard, two equal-scored models would tie indefinitely and routing
 * would silently depend on input catalog order, masking drift bugs.
 *
 * Tiebreak sequence (§4.4 "稳健决胜序列"):
 *  1. **Higher capability score** — prefer the more capable model
 *  2. **Lower estimated cost** — prefer the cheaper model
 *  3. **Lower estimated latency** — prefer the faster model
 *  4. **`modelId` dictionary order** — final deterministic anchor
 *
 * The function is pure and total: same input → same output, regardless of
 * caller-side insertion order or runtime environment.
 */
import type { ScoredModel } from './types.js';

/** Epsilon for floating-point "essentially equal" comparison. */
const TIEBREAK_EPSILON = 1e-9;

function compare(a: number, b: number): number {
  if (Math.abs(a - b) < TIEBREAK_EPSILON) return 0;
  return a < b ? -1 : 1;
}

/**
 * Return a strictly-deterministic ordering of the given scored models using
 * the §4.4 tiebreak sequence.
 *
 * @param scored Typically `scoreModels(...).byRankOrder` or `byCatalogOrder`
 */
export function tieBreak(scored: readonly ScoredModel[]): ScoredModel[] {
  const out: ScoredModel[] = scored.map((m) => ({ ...m }));
  out.sort((a, b) => {
    // 1. Higher capability score wins (descending).
    let c = compare(b.capability, a.capability);
    if (c !== 0) return c;
    // 2. Lower cost wins (ascending).
    c = compare(a.cost, b.cost);
    if (c !== 0) return c;
    // 3. Lower latency wins (ascending).
    c = compare(a.latency, b.latency);
    if (c !== 0) return c;
    // 4. modelId dictionary order (ascending).
    if (a.modelId < b.modelId) return -1;
    if (a.modelId > b.modelId) return 1;
    return 0;
  });
  // Reassign rankIndex to reflect the strict order.
  for (let i = 0; i < out.length; i += 1) {
    out[i].rankIndex = i;
  }
  return out;
}
