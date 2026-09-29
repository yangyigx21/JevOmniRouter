/**
 * `priorDeltaFor` — EXP-5 bounded shrinking prior correction (§4.9.4).
 *
 * Converts confirmed experience samples into a bounded correction to the
 * `raw` score for a (intent × model) pair, using a Beta posterior mean:
 *
 * ```
 * n_eff    = Σ w_i
 * postMean = (EXP_PRIOR_STRENGTH × priorMean + Σ w_i·y_i)
 *            / (EXP_PRIOR_STRENGTH + n_eff)
 * Δraw     = EXP_CORR_MAX × (postMean − priorMean)
 * ```
 *
 * Three properties MUST hold (§4.9.4 acceptance):
 *  - **Bounded**: `|Δraw| ≤ EXP_CORR_MAX = 4.0` always.
 *  - **Cold-start zero**: when `n_eff = 0`, `postMean === priorMean` ⇒ `Δraw = 0`
 *    (no `if` branch needed — emergent from the formula).
 *  - **Monotone shrinkage**: as `n_eff ↑`, `postMean` approaches the
 *    experience mean but is throttled by `EXP_PRIOR_STRENGTH`.
 *
 * The forbidden implementation (§4.9.4 explicit "禁止的实现方式"):
 *
 * ```js
 * // ❌ Wrong: clamp an unbounded correction. Large samples pin to the limit
 * //    and the correction effectively becomes unbounded bias.
 * delta = clamp(EXP_CORR_MAX * (obsMean - priorMean), -EXP_CORR_MAX, EXP_CORR_MAX)
 * ```
 *
 * We MUST use the pseudo-count shrinkage form (Beta posterior), NOT a
 * post-hoc clamp. The boundedness comes from the formula itself, never from
 * a clamp step.
 *
 * Two guard layers (§4.9.5) sit on top of the formula:
 *  - **Per-pair cold-start**: if `n_eff < EXP_MIN_SAMPLE_PER_PAIR (8)` for
 *    this pair, `Δraw = 0`. The pair is too thinly sampled to correct.
 *  - **Global shadow**: if global confirmed count <
 *    `EXP_MIN_SAMPLE_GLOBAL (30)`, the entire system is in shadow mode —
 *    no `Δraw` is applied to any decision, but the would-be value is
 *    computed and logged for observation. Exiting shadow mode requires
 *    explicit human trigger (SHALL NOT auto-switch).
 */
import {
  EXP_CORR_MAX,
  EXP_MIN_SAMPLE_PER_PAIR,
  EXP_MIN_SAMPLE_GLOBAL,
  EXP_PRIOR_STRENGTH,
  EXP_WEIGHT_FLOOR,
} from './constants.js';
import type { PriorDeltaInput, PriorDeltaResult } from './types.js';
import { clamp } from './utils/math.js';

/**
 * Compute the bounded shrinking prior correction for a (intent × model) pair.
 *
 * @param input.priorMean             Static capability-profile mean (NOT
 *                                    reverse-derived from experience — §4.9.4
 *                                    "priorMean MUST be pinned")
 * @param input.samples               Pre-weighted experience samples
 * @param input.globalConfirmedCount   Total confirmed samples across all
 *                                    pairs (drives shadow mode guard)
 */
export function priorDeltaFor(input: PriorDeltaInput): PriorDeltaResult {
  const priorMean = Number.isFinite(input.priorMean)
    ? clamp(input.priorMean, 0, 1)
    : 0.5;

  // Stage 1 — accumulate effective sample size and weighted successes.
  // Samples below EXP_WEIGHT_FLOOR don't participate (defensive; outcomeWeight
  // is supposed to have already zeroed them out, but we re-check here).
  let nEff = 0;
  let sumWY = 0;
  let pairSampleCount = 0;
  for (const s of input.samples) {
    if (!Number.isFinite(s.weight) || s.weight < EXP_WEIGHT_FLOOR) continue;
    if (!Number.isFinite(s.y)) continue;
    nEff += s.weight;
    sumWY += s.weight * clamp(s.y, 0, 1);
    pairSampleCount += 1;
  }

  // Stage 2 — Beta posterior mean (§4.9.4 core formula).
  // Note: when n_eff = 0, postMean === priorMean naturally ⇒ delta = 0
  // (cold-start zero property, no if-branch needed).
  const denom = EXP_PRIOR_STRENGTH + nEff;
  const postMean = (EXP_PRIOR_STRENGTH * priorMean + sumWY) / denom;
  const rawDelta = EXP_CORR_MAX * (postMean - priorMean);

  // Stage 3 — guard layers (§4.9.5).
  const globalShadow = input.globalConfirmedCount < EXP_MIN_SAMPLE_GLOBAL;
  const pairColdStart = nEff < EXP_MIN_SAMPLE_PER_PAIR;

  let delta: number;
  let shadowDelta: number;
  let shadowed: boolean;
  if (globalShadow) {
    // Shadow mode: don't apply, but log what we would apply (assuming per-pair
    // guard also passes — i.e. shadow value is 0 when per-pair cold-started).
    shadowed = true;
    delta = 0;
    shadowDelta = pairColdStart ? 0 : rawDelta;
  } else if (pairColdStart) {
    shadowed = false;
    delta = 0;
    shadowDelta = 0;
  } else {
    shadowed = false;
    delta = rawDelta;
    shadowDelta = 0;
  }

  return {
    delta,
    nEff,
    postMean,
    shadowed,
    shadowDelta,
    pairSampleCount,
  };
}

export {
  EXP_CORR_MAX,
  EXP_MIN_SAMPLE_GLOBAL,
  EXP_MIN_SAMPLE_PER_PAIR,
  EXP_PRIOR_STRENGTH,
} from './constants.js';
