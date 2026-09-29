/**
 * TypeSafeJevAdapter — JEV-1 / JEV-2 / JEV-3 / JEV-9 (§4.2.1, §4.3).
 *
 * The adapter interface for calling TypeSafe Jev (System One) in the
 * production path. Key guarantees:
 *
 * JEV-1: MUST use the unified adapter; MUST NOT use local rules/heuristics
 *        in the production path. LocalJevReimpl is only for offline form.
 * JEV-2: Five questions MUST cover three primitives (choice/score/noul).
 * JEV-3: Five questions MUST be packed in a single batch request
 *        (Speculative fan-out); MUST NOT split into serial calls.
 * JEV-9: User routing preference (economy/balanced/quality) MUST be
 *        injected as a typed prior; MUST NOT bypass evidence extraction.
 *
 * The HTTP/RPC implementation is deferred to T-3.1 (service wiring).
 * This module defines the interface, the five questions, and the adapter
 * contract so the Decision Runtime (T-3.1b) can be form-agnostic.
 */
import type { PolicySnapshot } from '@jev-router/shared';
import type { DecisionSource } from './decision-source.js';
import type { EngineeredState } from './state-engineering.js';
import type { DecisionContract } from './decision-contract.js';

// ---------------------------------------------------------------------------
// JEV-2: Five questions covering three primitives
// ---------------------------------------------------------------------------

/** The three primitive types (JEV-2, §4.1). */
export type PrimitiveKind = 'choice' | 'score' | 'noul';

/** A single typed question sent to Jev (JEV-3 batch item). */
export interface JevQuestion {
  /** Question id (stable across versions; e.g. "intent", "complexity"). */
  id: string;
  /** Primitive type. */
  primitive: PrimitiveKind;
  /** Full question text (the "instructions" from DecisionContract, JEV-12). */
  text: string;
  /** Contract version this question belongs to. */
  contractVersion: string;
  /** Routing preference prior (JEV-9), if applicable. */
  preferencePrior?: 'economy' | 'balanced' | 'quality';
}

/** The five canonical questions (JEV-2). */
export const FIVE_QUESTIONS: readonly JevQuestion[] = [
  {
    id: 'intent',
    primitive: 'choice',
    text: 'What is the primary intent of this request?',
    contractVersion: 'router@1',
  },
  {
    id: 'complexity',
    primitive: 'score',
    text: 'How complex is this request on a graded scale?',
    contractVersion: 'router@1',
  },
  {
    id: 'urgency',
    primitive: 'noul',
    text: 'Is this request time-sensitive?',
    contractVersion: 'router@1',
  },
  {
    id: 'budget',
    primitive: 'noul',
    text: 'Is cost a primary concern for this request?',
    contractVersion: 'router@1',
  },
  {
    id: 'capability',
    primitive: 'score',
    text: 'What capability level does this request require?',
    contractVersion: 'router@1',
  },
] as const;

/** Answer from Jev for a single question. */
export interface JevAnswer {
  questionId: string;
  primitive: PrimitiveKind;
  /** For 'choice': winning option id. */
  choiceWinner?: string;
  /** For 'score': graded score (0..1, band index interpretation per JEV-13). */
  scoreValue?: number;
  /** For 'noul': P(yes) (0..1). */
  noulProbability?: number;
  /** Evidence strength (computed client-side per §4.1). */
  evidenceStrength?: number;
}

/** Batch request (JEV-3: five questions packed in one). */
export interface JevBatchRequest {
  requestId: string;
  schemaVersion: string;
  batch: JevQuestion[];
  state: EngineeredState;
  contracts: DecisionContract[];
  /** Preference prior for this request (JEV-9). */
  preference?: 'economy' | 'balanced' | 'quality';
}

/** Batch response from Jev. */
export interface JevBatchResponse {
  answers: JevAnswer[];
  decisionId: string;
  modelVersions: Record<string, string>;
  /** Calibrated confidence (post-calibration, §4.2). */
  confidence?: number;
  /** Full candidate scores (if Jev provides them). */
  candidateScores?: { modelId: string; raw: number; probability?: number }[];
  /** Human-readable rationale. */
  rationale?: string;
  /** Knowledge references / citations. */
  knowledgeReferences?: string[];
}

// ---------------------------------------------------------------------------
// JEV-1: TypeSafeJevAdapter interface
// ---------------------------------------------------------------------------

/** Configuration for the adapter (HTTP endpoint, timeout, etc.). */
export interface JevAdapterConfig {
  /** Base URL for the Jev System One endpoint. */
  baseUrl: string;
  /** Request timeout in ms (EVENT-4 P95 target: 1200ms). */
  timeoutMs: number;
  /** Maximum retries on transient failure. */
  maxRetries: number;
  /** API key or auth token (production only). */
  authToken?: string;
}

/**
 * TypeSafeJevAdapter interface (JEV-1).
 *
 * Production form: HTTP/RPC to System One.
 * Offline form: LocalJevReimpl (implements same interface).
 *
 * The adapter MUST:
 *  - Pack five questions in a single batch request (JEV-3).
 *  - NOT split into multiple serial calls.
 *  - NOT use local heuristics in the production path.
 *  - Tag `decisionSource=TYPE_SAFE_JEV` and `jev.provider=system-one`.
 *  - Respect the timeout budget (JEV-3: 1.2s P95).
 */
export interface TypeSafeJevAdapter {
  /** Send five questions as a batch (JEV-3). */
  answerQuestions(request: JevBatchRequest): Promise<JevBatchResponse>;

  /** Check adapter health (for CONSTRAIN-1 step 1 health check). */
  isHealthy(): boolean;

  /** Get the decision source tag for audit (JEV-7). */
  getDecisionSource(): DecisionSource;
}

// ---------------------------------------------------------------------------
// JEV-9: Preference prior injection
// ---------------------------------------------------------------------------

/** Preference weight adjustments per routing preference (JEV-9). */
export const PREFERENCE_PRIOR_WEIGHTS: Record<
  'economy' | 'balanced' | 'quality',
  Partial<PolicySnapshot>
> = {
  economy: {
    w_cost: 0.35,
    w_latency: 0.25,
    w_capability: 0.2,
    w_quality: 0.2,
  },
  balanced: {
    w_cost: 0.25,
    w_latency: 0.25,
    w_capability: 0.25,
    w_quality: 0.25,
  },
  quality: {
    w_cost: 0.15,
    w_latency: 0.15,
    w_capability: 0.35,
    w_quality: 0.35,
  },
};

/**
 * Apply routing preference as a typed prior (JEV-9).
 * MUST NOT bypass evidence extraction — preference only adjusts weights.
 */
export function applyPreferencePrior(
  basePolicy: PolicySnapshot,
  preference: 'economy' | 'balanced' | 'quality',
): PolicySnapshot {
  const prior = PREFERENCE_PRIOR_WEIGHTS[preference];
  // Merge: prior overrides matching fields; keep T0/alpha from base.
  return {
    w_capability: prior.w_capability ?? basePolicy.w_capability,
    w_quality: prior.w_quality ?? basePolicy.w_quality,
    w_cost: prior.w_cost ?? basePolicy.w_cost,
    w_latency: prior.w_latency ?? basePolicy.w_latency,
    T0: basePolicy.T0,
    alpha: basePolicy.alpha,
  };
}

// ---------------------------------------------------------------------------
// JEV-3: Batch validation
// ---------------------------------------------------------------------------

/**
 * Validate that a batch request contains exactly 5 questions covering
 * all three primitives (JEV-2 / JEV-3).
 */
export function validateBatchRequest(
  request: JevBatchRequest,
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];

  if (request.batch.length !== 5) {
    violations.push(
      `Batch MUST contain exactly 5 questions (JEV-3); got ${request.batch.length}`,
    );
  }

  const primitives = new Set(request.batch.map((q) => q.primitive));
  for (const p of ['choice', 'score', 'noul'] as PrimitiveKind[]) {
    if (!primitives.has(p)) {
      violations.push(`Batch MUST cover primitive "${p}" (JEV-2)`);
    }
  }

  // Check that 'choice' has exactly 1 question, 'score' has 2, 'noul' has 2.
  const choiceCount = request.batch.filter((q) => q.primitive === 'choice').length;
  const scoreCount = request.batch.filter((q) => q.primitive === 'score').length;
  const noulCount = request.batch.filter((q) => q.primitive === 'noul').length;
  if (choiceCount !== 1) {
    violations.push(`Batch MUST have exactly 1 choice question; got ${choiceCount}`);
  }
  if (scoreCount !== 2) {
    violations.push(`Batch MUST have exactly 2 score questions; got ${scoreCount}`);
  }
  if (noulCount !== 2) {
    violations.push(`Batch MUST have exactly 2 noul questions; got ${noulCount}`);
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Build the canonical five-question batch (JEV-2 / JEV-3).
 * Merges preference prior into the questions (JEV-9).
 */
export function buildFiveQuestionBatch(
  state: EngineeredState,
  contracts: DecisionContract[],
  requestId: string,
  preference?: 'economy' | 'balanced' | 'quality',
): JevBatchRequest {
  const batch = FIVE_QUESTIONS.map((q) => ({
    ...q,
    preferencePrior: preference,
  }));
  return {
    requestId,
    schemaVersion: '1.0.0',
    batch,
    state,
    contracts,
    preference,
  };
}
