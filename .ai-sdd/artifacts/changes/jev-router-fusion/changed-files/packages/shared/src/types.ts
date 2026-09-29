/**
 * Cross-package type contracts for JevRouter.
 *
 * All types here are pure data shapes — no methods, no I/O. They form the
 * shared vocabulary between the decision runtime main chain (`JEV-11`) and
 * the experience loop (`EXP`), and are reused by both cloud-native and
 * offline single-file forms (`ARCH-2`).
 */
// ---------------------------------------------------------------------------
// §0.7 closed-loop five-stage — STATE
// ---------------------------------------------------------------------------

/** Risk tier that influences `routeTier` thresholds (§4.2.1 design trade-off). */
export type RiskLevel = 'low' | 'medium' | 'high';

/** Modality flags surfacing from ingest (`INGEST-1..4`). */
export type Modality = 'text' | 'image' | 'document' | 'voice';

/** Per-attachment summary used by `extractFeatures` (§4.1). */
export interface AttachmentSummary {
  imageCount: number;
  documentCount: number;
  /** Token volume of attached documents (sum across docs). */
  fileTokens: number;
}

/** Hard constraints declared by the task envelope (`CONSTRAIN-7`). */
export interface TaskConstraints {
  maxLatencyMs?: number;
  budgetUsd?: number;
  riskLevel?: RiskLevel;
}

/** Tenant / user / role context (`INGEST` domain). */
export interface TaskContext {
  tenant: string;
  user: string;
  role?: string;
}

/**
 * Raw signal evidence collected by ingest before the three primitive questions
 * are dispatched. Mirrors the inputs referenced by `extractFeatures` §4.1:
 * - `hits`: per-intent keyword counts
 * - `imgCount` / `fileCount`: attachment counts
 * - `fileTokens`: long-context signal source
 * - `scores.complexity` / `scores.capability`: 0..1 score primitives
 * - `probabilities.urgency` / `probabilities.budget`: P(yes) for noul primitives
 * - `nCap`: number of intent candidates (drives share/concentration)
 */
export interface RawEvidence {
  hits?: Record<string, number>;
  imgCount?: number;
  fileCount?: number;
  fileTokens?: number;
  tokens?: number;
  nCap?: number;
  scores?: {
    complexity?: number;
    capability?: number;
  };
  probabilities?: {
    urgency?: number;
    budget?: number;
  };
}

/**
 * `TaskEnvelope` — STATE segment of the main chain (§4.2.1).
 * Carries prompt + attachments + constraints + context + raw evidence.
 */
export interface TaskEnvelope {
  prompt: string;
  attachments: AttachmentSummary;
  modalities: Modality[];
  constraints: TaskConstraints;
  context: TaskContext;
  evidence?: RawEvidence;
}

// ---------------------------------------------------------------------------
// §4.4 scoreModels — SCORE
// ---------------------------------------------------------------------------

/** Static catalog descriptor for a model (`MODEL-1`). */
export interface ModelDescriptor {
  /** Stable model identity; used as catalog key (`MODEL-3`). */
  modelId: string;
  /** Capability score 0..1 (may reference Jev five-question verdict). */
  capability: number;
  /** Quality score 0..1 (static profile). */
  quality: number;
  /** Normalized cost 0..1 (lower is better). */
  cost: number;
  /** Normalized latency 0..1 (lower is better). */
  latency: number;
  /** Current load 0..1 (drives §4.4 penalty `26 × load^2.2`). */
  load: number;
  /** Context window (tokens) used by hard-constraint pipeline (`CONSTRAIN-4`). */
  contextWindow?: number;
  /** Supported modalities (`CONSTRAIN-3`). */
  modalities?: Modality[];
}

/**
 * Locked policy snapshot — weights sum to 1; `T0` and `alpha` drive the
 * adaptive softmax temperature (§4.4). Source of truth for one routing call.
 */
export interface PolicySnapshot {
  w_capability: number;
  w_quality: number;
  w_cost: number;
  w_latency: number;
  /** Base temperature (T0 > 0). */
  T0: number;
  /** Spread sensitivity (α ≥ 0). */
  alpha: number;
}

/** A scored model carrying both catalog and rank coordinates (`MODEL-3`). */
export interface ScoredModel {
  modelId: string;
  /** Position in the input descriptor list (catalog order). */
  catalogIndex: number;
  /** Position by raw score descending (rank order). */
  rankIndex: number;
  /** Soft score before penalty; includes capability/quality/cost/latency. */
  raw: number;
  /** Post-softmax probability (catalog-order injection point, §4.4). */
  probability: number;
  /** Echoed for `tieBreak` (SCORE-4). */
  capability: number;
  cost: number;
  latency: number;
}

/** Dual-order output (§4.4 "双序契约"). */
export interface ScoreResult {
  /** Same order as input descriptors; index === catalogIndex. */
  byCatalogOrder: ScoredModel[];
  /** Sorted by raw descending; index === rankIndex. */
  byRankOrder: ScoredModel[];
  /** Computed temperature used for softmax (for trace / HUD). */
  temperature: number;
  /** Spread of raw scores (max − min) used to derive `temperature`. */
  spread: number;
}

// ---------------------------------------------------------------------------
// §4.9 experience loop — EXP
// ---------------------------------------------------------------------------

export type OutcomeStatus = 'pending' | 'confirmed' | 'disputed' | 'expired';
export type OutcomeSource = 'human' | 'system' | 'implicit';

/**
 * Confirmed outcome of a prior routing decision (`EXP-1`).
 * `label` is the winning modelId at decision time; if outcome status is
 * `disputed`, `label` may differ from the actually-preferred model.
 */
export interface Outcome {
  outcomeId: string;
  status: OutcomeStatus;
  /** Winner at decision time (modelId). */
  label: string;
  source: OutcomeSource;
  /** Epoch milliseconds when the outcome was observed. */
  observedAt: number;
  /** Optional profile version at observation time (for `EXP-7` invalidation). */
  profileVersion?: string;
  /** Intent context that produced this outcome. */
  intent?: string;
  /** Calibrated confidence recorded at decision time (for `EXP-2`). */
  confidence?: number;
}

/**
 * Pre-weighted experience sample for a (intent × model) pair (§4.9.2).
 * `y = 1` iff `status === 'confirmed' && label === winner`; `0` if disputed.
 */
export interface ExperienceSample {
  intent: string;
  modelId: string;
  y: number;
  source: OutcomeSource;
  observedAt: number;
  /** Pre-computed weight from `outcomeWeight` (§4.9.3). */
  weight: number;
}

/** `priorDeltaFor` input (§4.9.4). */
export interface PriorDeltaInput {
  /** Static capability-profile mean; MUST NOT be reverse-derived from experience. */
  priorMean: number;
  /** Pre-weighted samples for the (intent × model) pair. */
  samples: ExperienceSample[];
  /** Total confirmed sample count across all pairs (for global shadow guard). */
  globalConfirmedCount: number;
}

/** `priorDeltaFor` output (§4.9.4 + §4.9.5). */
export interface PriorDeltaResult {
  /** Δraw applied to scoreModels raw. Zero when shadowed or n_eff=0. */
  delta: number;
  /** Effective sample size Σ w_i. */
  nEff: number;
  /** Beta posterior mean (Beta(priorStrength, n_eff) conjugate). */
  postMean: number;
  /** True iff shadow mode (§4.9.5) — `delta` not actually applied. */
  shadowed: boolean;
  /** When shadowed, the would-be delta for the observation log. */
  shadowDelta: number;
  /** Per-pair sample count (after weight floor filtering). */
  pairSampleCount: number;
}

// ---------------------------------------------------------------------------
// §4.7 ANIM-1 timeline + §4.8 geometry
// ---------------------------------------------------------------------------

/**
 * Seven-stage deterministic timeline phase names (§4.7, `ANIM-1`).
 * Maps to the decision runtime main chain (`JEV-11`):
 * STATE → QUESTIONS → JEV → PROBABILITY → ROUTE → EXECUTE → RESULT.
 */
export type StageName =
  | 'state'
  | 'questions'
  | 'jev'
  | 'probability'
  | 'route'
  | 'execute'
  | 'result';

export interface StageTiming {
  index: number;
  name: StageName;
  startMs: number;
  durationMs: number;
  endMs: number;
}

export interface RunTimeline {
  stages: StageTiming[];
  totalMs: number;
}

/** `computeRun` input (§4.7 / ANIM-1). */
export interface ComputeRunInput {
  /** Total run duration in ms; default `RUN_DEFAULT_TOTAL_MS`. */
  totalDurationMs?: number;
  /**
   * Optional 7-element weight vector (any positive numbers; will be normalized).
   * If absent or malformed, equal weights are used.
   */
  stageWeights?: number[];
}

// ---------------------------------------------------------------------------
// §4.2.1 route tier — ROUTE/GATE/ESCALATE
// ---------------------------------------------------------------------------

export type RouteTier = 'ROUTE' | 'GATE' | 'ESCALATE';

export interface RouteTierThresholds {
  /** Confidence at/above this value routes directly. Default 0.82. */
  high: number;
  /** Confidence at/above this value gates (observation). Default 0.60. */
  mid: number;
}

// ---------------------------------------------------------------------------
// §4.9.6 calibrationStats — EXP-2
// ---------------------------------------------------------------------------

export interface CalibrationBin {
  index: number;
  /** Lower bound (inclusive) of the bin in [0,1]. */
  lo: number;
  /** Upper bound (exclusive; final bin inclusive) of the bin in [0,1]. */
  hi: number;
  /** Number of samples whose confidence fell in this bin. */
  count: number;
  /** Average accuracy (0..1) of samples in this bin. */
  accuracy: number;
  /** Average confidence (0..1) of samples in this bin. */
  confidence: number;
}

export interface CalibrationStats {
  /** Expected Calibration Error (10-bin, equal-width). */
  ece: number;
  /** Total samples used (expired excluded). */
  totalSamples: number;
  /** Per-bin breakdown. */
  bins: CalibrationBin[];
  /** High-confidence but incorrect — fraction. */
  falsePositiveRate: number;
  /** Low-confidence but correct — fraction. */
  falseNegativeRate: number;
  /** `true` when total samples < `ECE_MIN_SAMPLE` (no conclusion). */
  insufficient: boolean;
}
