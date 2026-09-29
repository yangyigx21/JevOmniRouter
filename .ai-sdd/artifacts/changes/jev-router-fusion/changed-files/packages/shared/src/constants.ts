/**
 * Module-level constants — centralized per `ARCH-5`.
 *
 * Every constant here is referenced by a design.md or spec.md clause; do not
 * inline magic numbers in the algorithm modules. Two-form (cloud + offline)
 * builds MUST consume the same compiled output, so constants must remain
 * runtime-environment agnostic (no `process.env`, no DOM globals).
 */
// ---------------------------------------------------------------------------
// §4.1 extractFeatures — evidence weights and signal normalization
// ---------------------------------------------------------------------------

/**
 * Evidence-strength weights (§4.1). `intent` carries the strongest semantic
 * signal; `complexity` and `capability` are secondary; `urgency` / `budget`
 * are noul primitives whose priors must be discounted to avoid contamination.
 */
export const EVIDENCE_W = {
  intent: 0.34,
  complexity: 0.16,
  urgency: 0.14,
  budget: 0.14,
  capability: 0.22,
} as const;

/** Token volume at which `scoreStrength` saturates (§4.1: `tokens / 450`). */
export const SCORE_TOKEN_SATURATION = 450;

/** Long-context signal saturation point (§4.1: `fileTokens / 4000`). */
export const LONG_CTX_SATURATION = 4000;

/**
 * Pseudo-prior for `noul` primitives (§4.1 trap).
 * `|p − 0.5|` only acts as weak evidence; keyword hits are required to lift
 * confidence. Spec pins this at 0.30.
 */
export const NOUL_PRIOR = 0.3;

/** noul sensitivity to keyword hits (§4.1: `hits.urgency × 0.45`). */
export const NOUL_HIT_WEIGHT = 0.45;

/** noul sensitivity to `|p − 0.5|` (§4.1: `× 0.85`). */
export const NOUL_P_SIGNAL_WEIGHT = 0.85;

/**
 * Linear combination weights for `intentStrength` (§4.1):
 * `0.70 * conc + 0.30 * vol`.
 */
export const INTENT_CONC_WEIGHT = 0.7;
export const INTENT_VOL_WEIGHT = 0.3;

/**
 * `scoreStrength` weights (§4.1):
 * `0.45 * margin + 0.55 * tokenVolume`.
 */
export const SCORE_MARGIN_WEIGHT = 0.45;
export const SCORE_VOLUME_WEIGHT = 0.55;

/** Vision intent boost (§4.1: `1 + 0.25 × imgCount`). */
export const VISION_BASE_BOOST = 1;
export const VISION_PER_IMG_BOOST = 0.25;

/** Long-context intent boost (§4.1: `1 + clamp(fileTokens / 4000, 0, 1)`). */
export const LONG_CTX_BASE_BOOST = 1;

/** Intent signal saturation for `vol` (§4.1: `clamp(best / 4, 0, 1)`). */
export const INTENT_VOL_SATURATION = 4;

// ---------------------------------------------------------------------------
// §4.2 calibrate — calibration curve parameters
// ---------------------------------------------------------------------------

/** Hard lower bound — no evidence should not claim above random guess (§4.2). */
export const CALIBRATE_LOW = 0.35;
/** Hard upper bound — never claim 100% certainty (§4.2). */
export const CALIBRATE_HIGH = 0.97;
/** Curve steepness `k` (§4.2). */
export const CALIBRATE_K = 2.6;
/**
 * Range constant: `0.62` — ensures `calibrate(0) = 0.35` and
 * `calibrate(1) ≈ 0.97` after rounding to 2 decimals (§4.2).
 */
export const CALIBRATE_RANGE = CALIBRATE_HIGH - CALIBRATE_LOW;

/** Decimal rounding for calibrated confidence (§4.2: `round(x, 2)`). */
export const CALIBRATE_DECIMALS = 2;

// ---------------------------------------------------------------------------
// §4.2.1 routeTier — three-tier default thresholds
// ---------------------------------------------------------------------------

export const ROUTE_TIER_DEFAULT = {
  high: 0.82,
  mid: 0.6,
} as const;

// ---------------------------------------------------------------------------
// §4.4 scoreModels — soft-scoring + penalty + softmax
// ---------------------------------------------------------------------------

/** Load penalty coefficient (§4.4: `penalty = 26 × load^2.2`). */
export const LOAD_PENALTY_COEFF = 26;
/** Load penalty exponent (§4.4). */
export const LOAD_PENALTY_EXP = 2.2;

/** Default base temperature `T0` for adaptive softmax (§4.4). */
export const SOFTMAX_T0_DEFAULT = 1;
/** Default spread sensitivity `α` for adaptive softmax (§4.4). */
export const SOFTMAX_ALPHA_DEFAULT = 0.5;

/** Decimal places preserved for raw score (§4.4). */
export const RAW_DECIMALS = 6;

// ---------------------------------------------------------------------------
// §4.9 experience loop constants (§4.9.4 table)
// ---------------------------------------------------------------------------

/** `raw`-score maximum correction magnitude (EXP-5). */
export const EXP_CORR_MAX = 4;
/** Pseudo-count strength for prior shrinkage (EXP-5). */
export const EXP_PRIOR_STRENGTH = 20;
/** Time-decay half-life in days (EXP-7). */
export const EXP_HALF_LIFE_DAYS = 30;
/** Minimum sample weight to participate in prior correction (EXP-7). */
export const EXP_WEIGHT_FLOOR = 0.15;
/** Minimum per-pair sample count (after weight floor) to apply correction (EXP-8). */
export const EXP_MIN_SAMPLE_PER_PAIR = 8;
/** Minimum global confirmed samples to leave shadow mode (EXP-8). */
export const EXP_MIN_SAMPLE_GLOBAL = 30;

/** Source weights (§4.9.2). */
export const SOURCE_W = {
  human: 1,
  system: 1,
  implicit: 0.45,
} as const;

/** Day length in milliseconds (used by `outcomeWeight` for age computation). */
export const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// §4.9.6 calibrationStats — ECE
// ---------------------------------------------------------------------------

/** Number of equal-width bins in [0,1] for ECE (§4.9.6). */
export const ECE_BINS = 10;
/** Minimum sample size to draw calibration conclusions (§4.9.6). */
export const ECE_MIN_SAMPLE = 30;

// ---------------------------------------------------------------------------
// §4.7 computeRun — seven-stage timeline defaults
// ---------------------------------------------------------------------------

/** Stage count for the deterministic timeline (§4.7 / ANIM-1). */
export const STAGE_COUNT = 7;

/**
 * Stage names matching the decision runtime main chain (§4.2.1):
 * STATE → QUESTIONS → JEV → PROBABILITY → ROUTE → EXECUTE → RESULT.
 */
export const STAGE_NAMES = [
  'state',
  'questions',
  'jev',
  'probability',
  'route',
  'execute',
  'result',
] as const;

/** Default total run duration in ms (used when input omits total). */
export const RUN_DEFAULT_TOTAL_MS = 4200;

/** Minimum total duration floor; below this we still emit 7 stages. */
export const RUN_MIN_TOTAL_MS = 1;

// ---------------------------------------------------------------------------
// §4.7–4.8 geometry — TREE-2 / TREE-4 / ANIM-2 constants
// ---------------------------------------------------------------------------

/**
 * Default 3D tree layout parameters (§4.7–4.8, `TREE-2`):
 * - `TREE_RADIUS_BASE`: base framing radius when only one model
 * - `TREE_RADIUS_PER_LEAF`: radius growth per additional leaf
 * - `TREE_RADIUS_MAX`: hard cap on computed radius
 * - `TREE_LEAF_Y_SPAN`: vertical span for leaves
 * - `TREE_LEAF_Z_OFFSET`: depth offset for leaves
 *
 * `solveRadius` returns a finite positive number for any non-negative input
 * (defended against `NaN` / `Infinity`, see ANIM-1 non-finite input defense).
 */
export const TREE_RADIUS_BASE = 2;
export const TREE_RADIUS_PER_LEAF = 0.5;
export const TREE_RADIUS_MAX = 12;
export const TREE_LEAF_Y_SPAN = 1.2;
export const TREE_LEAF_Z_OFFSET = 0.3;

/**
 * HUD occlusion margin (`TREE-4` `measureHud`). Selected node MUST be at
 * least this many world-space units clear of any HUD rectangle.
 */
export const TREE_HUD_MARGIN = 0.4;

/**
 * Landing precision contracts (`ANIM-2`):
 * - `LANDING_DISTANCE_MAX`: end-of-execute stage distance to selected leaf
 * - `LANDING_MIDPOINT_MAX`: midpoint of execute stage to leaf-stem curve
 */
export const LANDING_DISTANCE_MAX = 0.05;
export const LANDING_MIDPOINT_MAX = 0.02;

/** Number of pre-validated geometry assertions (§spec TREE-2). */
export const GEOMETRY_PREVALIDATION_COUNT = 27;
