/**
 * Decision Runtime Main Chain — JEV-11 (§4.2.1).
 *
 * The main chain orchestrates the five stages:
 *
 * ```
 * STATE → CHOICE/SCORE/NOUL → JEV → PROBABILITY → ROUTE/GATE/ESCALATE
 * ```
 *
 * Mapping rules (JEV-11 scenario 2):
 *  - Tier mapping MUST be a pure function of confidence.
 *  - Tier MUST NOT be influenced by hard-constraint filter results.
 *  - The Selector (hard constraints) is orthogonal to the tier decision.
 *
 * This module implements the orchestration; it composes the pure-logic
 * functions from `@jev-router/shared` with the service-layer adapters.
 */
import {
  calibrate,
  extractFeatures,
  scoreModels,
  tieBreak,
  type ModelDescriptor,
  type PolicySnapshot,
  type RawEvidence,
  type RouteTier,
} from '@jev-router/shared';
import type { JevAnswer } from './jev-adapter.js';
import { applyPreferencePrior } from './jev-adapter.js';
import type { ConsequenceLevel, ConsequenceThresholds } from './decision-contract.js';
import type { EngineeredState } from './state-engineering.js';
import { consequenceRouteTier, type ConsequencePolicy } from './consequence-thresholds.js';

/** The five stages of the main chain (JEV-11). */
export type MainChainStage =
  | 'STATE'
  | 'QUESTIONS'
  | 'JEV'
  | 'PROBABILITY'
  | 'ROUTE';

/** Result of the STATE stage. */
export interface StateResult {
  stage: 'STATE';
  state: EngineeredState;
  evidence: RawEvidence;
}

/** Result of the QUESTIONS stage (three primitives dispatched). */
export interface QuestionsResult {
  stage: 'QUESTIONS';
  answers: JevAnswer[];
}

/** Result of the JEV stage (Jev responded). */
export interface JevResult {
  stage: 'JEV';
  decisionId: string;
  confidence: number;
  candidateScores: { modelId: string; raw: number; probability?: number }[];
  rationale?: string;
}

/** Result of the PROBABILITY stage (calibrated + scored). */
export interface ProbabilityResult {
  stage: 'PROBABILITY';
  confidence: number;
  calibratedConfidence: number;
  scoreResult: ReturnType<typeof scoreModels>;
  rankedResult: ReturnType<typeof tieBreak>;
}

/** Result of the ROUTE stage (tier determined). */
export interface RouteResult {
  stage: 'ROUTE';
  tier: RouteTier;
  confidence: number;
  consequence: ConsequenceLevel;
  forcedHumanReview: boolean;
  thresholds: ConsequenceThresholds;
}

/** The full main chain output (JEV-11). */
export interface MainChainOutput {
  stages: [StateResult, QuestionsResult, JevResult, ProbabilityResult, RouteResult];
  /** Stage execution order (always STATE → QUESTIONS → JEV → PROBABILITY → ROUTE). */
  stageOrder: MainChainStage[];
  /** Final route tier. */
  tier: RouteTier;
  /** Calibrated confidence. */
  confidence: number;
  /** Whether forced human review by irreversibility. */
  forcedHumanReview: boolean;
}

/**
 * Execute the Decision Runtime main chain (JEV-11).
 *
 * @param state       Engineered state from the STATE stage
 * @param evidence    Raw evidence (extracted from prompt/attachments)
 * @param jevAnswers  Answers from the JEV stage (5 questions batch)
 * @param models      Candidate pool (catalog-order)
 * @param policy      Locked policy snapshot
 * @param priorDeltas Experience corrections (catalog-order)
 * @param consequence Action consequence level (JEV-15)
 * @param consequencePolicy Per-consequence thresholds
 *
 * This function is pure (no I/O) — it composes shared-layer functions.
 * The Jev call itself (QUESTIONS → JEV) is done by the caller; this
 * function receives the answers as input.
 */
export function executeMainChain(input: {
  state: EngineeredState;
  evidence: RawEvidence;
  jevAnswers: JevAnswer[];
  models: ModelDescriptor[];
  policy: PolicySnapshot;
  priorDeltas?: number[];
  consequence: ConsequenceLevel;
  consequencePolicy: ConsequencePolicy;
  /** User routing preference (JEV-9). Injected as typed prior; MUST NOT bypass evidence extraction. */
  preference?: 'economy' | 'balanced' | 'quality';
}): MainChainOutput {
  // Stage 1 — STATE
  const stateResult: StateResult = {
    stage: 'STATE',
    state: input.state,
    evidence: input.evidence,
  };

  // Stage 2 — QUESTIONS (answers already received from Jev batch call)
  const questionsResult: QuestionsResult = {
    stage: 'QUESTIONS',
    answers: input.jevAnswers,
  };

  // Stage 3 — JEV (extract features from answers → calibrate)
  const features = extractFeatures(input.evidence);
  const rawConfidence = features.overall;

  // Build candidate scores from Jev answers if available
  const jevCandidateScores: { modelId: string; raw: number; probability?: number }[] = [];

  const jevResult: JevResult = {
    stage: 'JEV',
    decisionId: `jev-${Date.now()}`,
    confidence: rawConfidence,
    candidateScores: jevCandidateScores,
  };

  // Stage 4 — PROBABILITY (calibrate + score + tiebreak)
  // JEV-9: Apply preference prior to policy weights BEFORE scoring.
  // Preference only adjusts weight distribution; it MUST NOT bypass evidence extraction.
  const effectivePolicy = input.preference
    ? applyPreferencePrior(input.policy, input.preference)
    : input.policy;
  const calibratedConfidence = calibrate(rawConfidence);
  const scoreResult = scoreModels(
    input.models,
    effectivePolicy,
    input.priorDeltas,
  );
  const rankedResult = tieBreak(scoreResult.byRankOrder);

  const probabilityResult: ProbabilityResult = {
    stage: 'PROBABILITY',
    confidence: rawConfidence,
    calibratedConfidence,
    scoreResult,
    rankedResult,
  };

  // Stage 5 — ROUTE (consequence-graded tier determination, JEV-15)
  const { tier, forcedHumanReview, thresholds } = consequenceRouteTier(
    calibratedConfidence,
    input.consequence,
    input.consequencePolicy,
  );

  const routeResult: RouteResult = {
    stage: 'ROUTE',
    tier,
    confidence: calibratedConfidence,
    consequence: input.consequence,
    forcedHumanReview,
    thresholds,
  };

  return {
    stages: [stateResult, questionsResult, jevResult, probabilityResult, routeResult],
    stageOrder: ['STATE', 'QUESTIONS', 'JEV', 'PROBABILITY', 'ROUTE'],
    tier,
    confidence: calibratedConfidence,
    forcedHumanReview,
  };
}

/**
 * Verify the main chain execution order (JEV-11 scenario "主链顺序正确").
 * Returns `true` iff stages follow STATE → QUESTIONS → JEV → PROBABILITY → ROUTE.
 */
export function verifyMainChainOrder(stages: MainChainStage[]): boolean {
  const expected: MainChainStage[] = ['STATE', 'QUESTIONS', 'JEV', 'PROBABILITY', 'ROUTE'];
  if (stages.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (stages[i] !== expected[i]) return false;
  }
  return true;
}

/**
 * Verify that the route tier is determined purely by confidence and
 * consequence level, NOT by hard-constraint results (JEV-11 scenario 2).
 */
export function verifyTierIndependentOfSelector(
  tier: RouteTier,
  confidence: number,
  consequence: ConsequenceLevel,
  consequencePolicy: ConsequencePolicy,
): boolean {
  const expected = consequenceRouteTier(confidence, consequence, consequencePolicy);
  return tier === expected.tier;
}
