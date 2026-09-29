/**
 * @jev-router/shared — public API barrel.
 *
 * Phase 2 pure-logic layer (T-2.1 ~ T-2.10). All exports are pure functions
 * or type declarations — no I/O, no side effects — to satisfy `ARCH-2`
 * (two-form architecture reuses this same compiled output in both the
 * cloud-native service and the offline single-file form).
 *
 * Each function references the design.md clause that defines it; see the
 * per-module header comments for algorithm details and pinned traps.
 */
// Types — shared vocabulary across the decision runtime + experience loop.
export type {
  AttachmentSummary,
  CalibrationBin,
  CalibrationStats,
  ComputeRunInput,
  ExperienceSample,
  ModelDescriptor,
  Modality,
  Outcome,
  OutcomeSource,
  OutcomeStatus,
  PolicySnapshot,
  PriorDeltaInput,
  PriorDeltaResult,
  RawEvidence,
  RiskLevel,
  RouteTier,
  RouteTierThresholds,
  RunTimeline,
  ScoreResult,
  ScoredModel,
  StageName,
  StageTiming,
  TaskConstraints,
  TaskContext,
  TaskEnvelope,
} from './types.js';

// Constants — centralized per ARCH-5.
export {
  CALIBRATE_HIGH,
  CALIBRATE_K,
  CALIBRATE_LOW,
  CALIBRATE_RANGE,
  ECE_BINS,
  ECE_MIN_SAMPLE,
  EVIDENCE_W,
  EXP_CORR_MAX,
  EXP_HALF_LIFE_DAYS,
  EXP_MIN_SAMPLE_GLOBAL,
  EXP_MIN_SAMPLE_PER_PAIR,
  EXP_PRIOR_STRENGTH,
  EXP_WEIGHT_FLOOR,
  LOAD_PENALTY_COEFF,
  LOAD_PENALTY_EXP,
  MS_PER_DAY,
  NOUL_PRIOR,
  ROUTE_TIER_DEFAULT,
  RUN_DEFAULT_TOTAL_MS,
  RUN_MIN_TOTAL_MS,
  SOFTMAX_ALPHA_DEFAULT,
  SOFTMAX_T0_DEFAULT,
  SOURCE_W,
  STAGE_COUNT,
  STAGE_NAMES,
} from './constants.js';

// Pure-logic functions — T-2.1 ~ T-2.10.
export { extractFeatures } from './extractFeatures.js';
export type { ExtractedFeatures } from './extractFeatures.js';

export { calibrate } from './calibrate.js';

export { routeTier } from './routeTier.js';

export { scoreModels } from './scoreModels.js';

export { tieBreak } from './tieBreak.js';

export { priorDeltaFor } from './priorDeltaFor.js';

export { outcomeWeight } from './outcomeWeight.js';
export type { OutcomeWeightResult } from './outcomeWeight.js';

export { calibrationStats } from './calibrationStats.js';
export type {
  CalibrationSample,
  CalibrationStatsOptions,
} from './calibrationStats.js';

export {
  edgePath,
  leafPosition,
  measureHud,
  rungPath,
  solveRadius,
  verifyLandingContract,
} from './geometry.js';
export type { HudRect, ScreenPos, Vec3, Viewport } from './geometry.js';

export { computeRun } from './computeRun.js';
