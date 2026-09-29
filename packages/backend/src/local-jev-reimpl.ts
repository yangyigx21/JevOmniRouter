/**
 * LocalJevReimpl — JEV-8 / JEV-10 (§4.10, §3.3).
 *
 * Offline / demo form MAY use a local deterministic re-implementation of
 * Jev; when used, it MUST:
 *  - register deviations from the official contract (附录 F, JEV-10)
 *  - NOT present itself as the official mechanism (JEV-1 scenario 2)
 *  - tag `decisionSource = LOCAL_REIMPL` (JEV-7)
 *  - render the result area with "本地重实现" label (JEV-8 scenario)
 *
 * This adapter implements the same `TypeSafeJevAdapter` interface (T-3.1)
 * so the rest of the system is form-agnostic. It uses the pure-logic
 * layer (`extractFeatures`, `calibrate`, `scoreModels`) to derive a
 * deterministic decision without calling System One.
 *
 * **Deviation register (附录 F, JEV-10)** — this implementation deviates
 * from the official TypeSafe Jev contract in:
 *
 * | # | Deviation                                          | Official                | Local                       |
 * |---|----------------------------------------------------|-------------------------|-----------------------------|
 * | F1 | Decision source                                    | System One HTTP/RPC     | LocalJevReimpl (in-process) |
 * | F2 | Provider tag                                       | `system-one`            | absent                      |
 * | F3 | `decisionSource`                                   | `TYPE_SAFE_JEV`         | `LOCAL_REIMPL`              |
 * | F4 | Schema validation                                  | Network response       | In-memory object            |
 * | F5 | Latency                                            | Network (1.2s target)   | ~0ms (sync)                 |
 * | F6 | Human review                                       | Server-side audit       | Single-end "本地审批" label |
 *
 * No deviation is allowed to bypass JEV-5 (calibrated confidence bounds)
 * or JEV-11 (Decision Runtime main chain) — those are pure-logic and
 * shared across forms.
 */
import {
  calibrate,
  extractFeatures,
  scoreModels,
  tieBreak,
  type ModelDescriptor,
  type PolicySnapshot,
  type RawEvidence,
  type ScoreResult,
} from '@jev-router/shared';
import type { JevDecision, JevCandidateScore } from './decision-validator.js';
import { DECISION_SCHEMA_VERSION } from './decision-validator.js';
import type { DecisionSource } from './decision-source.js';

/** Deviation register entry (附录 F, JEV-10). */
export interface DeviationEntry {
  id: string;
  aspect: string;
  official: string;
  local: string;
  rationale: string;
}

/** The full deviation table for LocalJevReimpl (JEV-10). */
export const LOCAL_JEV_DEVIATIONS: readonly DeviationEntry[] = [
  {
    id: 'F1',
    aspect: 'Decision source',
    official: 'System One HTTP/RPC',
    local: 'LocalJevReimpl (in-process)',
    rationale: 'Offline form has no network; uses pure-logic layer to derive decision',
  },
  {
    id: 'F2',
    aspect: 'Provider tag',
    official: 'jev.provider=system-one',
    local: 'absent',
    rationale: 'JEV-1 scenario 2: LOCAL_REIMPL MUST NOT carry system-one tag',
  },
  {
    id: 'F3',
    aspect: 'decisionSource',
    official: 'TYPE_SAFE_JEV',
    local: 'LOCAL_REIMPL',
    rationale: 'JEV-7: source MUST be tagged for audit',
  },
  {
    id: 'F4',
    aspect: 'Schema validation',
    official: 'Network response parsed',
    local: 'In-memory object validated',
    rationale: 'No network response to parse; validator runs on the constructed object',
  },
  {
    id: 'F5',
    aspect: 'Latency',
    official: 'Network (1.2s P95 target per EVENT-4)',
    local: '~0ms (synchronous)',
    rationale: 'No network roundtrip',
  },
  {
    id: 'F6',
    aspect: 'Human review',
    official: 'Server-side audit + human review queue',
    local: 'Single-end "本地审批" label',
    rationale: 'No server; audit trail is local-only',
  },
];

/** Input to `LocalJevReimpl.answerQuestions`. */
export interface LocalJevInput {
  requestId: string;
  /** Raw evidence from STATE segment. */
  evidence?: RawEvidence;
  /** Candidate pool descriptors (catalog-order). */
  models: ModelDescriptor[];
  /** Locked policy snapshot. */
  policy: PolicySnapshot;
  /** Optional experience priorDeltas (catalog-order). */
  priorDeltas?: number[];
}

/** Output of `LocalJevReimpl.answerQuestions`. */
export interface LocalJevOutput {
  decision: JevDecision;
  decisionSource: DecisionSource;
  scoreResult: ScoreResult;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** Whether the result is labeled "本地重实现" (always true here). */
  localLabeled: true;
}

/**
 * LocalJevReimpl — deterministic in-process re-implementation of Jev.
 *
 * Uses the shared pure-logic layer to derive a decision; produces a
 * `JevDecision` object that passes the JEV-6 validator. The decision is
 * tagged `decisionSource=LOCAL_REIMPL` and the result is `localLabeled`.
 *
 * This function does NOT call System One. It MUST NOT be presented as
 * `TYPE_SAFE_JEV` (JEV-1 scenario 2, JEV-7).
 */
export function answerQuestionsLocally(input: LocalJevInput): LocalJevOutput {
  const createdAt = new Date().toISOString();

  // Stage 1 — extract features (deterministic; JEV-4).
  const features = extractFeatures(input.evidence);

  // Stage 2 — calibrate confidence (JEV-5; [0.35, 0.97]).
  const confidence = calibrate(features.overall);

  // Stage 3 — score models (SCORE-1/2/3).
  const scoreResult = scoreModels(input.models, input.policy, input.priorDeltas);

  // Stage 4 — tiebreak for strict order (SCORE-4).
  const ranked = tieBreak(scoreResult.byRankOrder);
  const winner = ranked[0];

  // Stage 5 — build candidateScores for JevDecision (catalog-order; JEV-16 full distribution).
  const candidateScores: JevCandidateScore[] = scoreResult.byCatalogOrder.map((m) => ({
    modelId: m.modelId,
    raw: m.raw,
    probability: m.probability,
  }));

  // Stage 6 — assemble the decision object.
  const decision: JevDecision = {
    decisionId: `local-${input.requestId}-${Date.now()}`,
    schemaVersion: DECISION_SCHEMA_VERSION,
    createdAt,
    selectedRecommendation: winner?.modelId ?? '',
    candidateScores,
    confidence,
    rationale:
      `LocalJevReimpl: features.overall=${features.overall.toFixed(4)}, ` +
      `confidence=${confidence}, winner=${winner?.modelId ?? '<none'} ` +
      `(raw=${winner?.raw.toFixed(4) ?? 'n/a'}, prob=${(winner?.probability ?? 0).toFixed(4)})`,
    knowledgeReferences: [],
    // No `provider` field — JEV-1 scenario 2 forbids system-one tag for LOCAL_REIMPL.
  };

  return {
    decision,
    decisionSource: 'LOCAL_REIMPL',
    scoreResult,
    createdAt,
    localLabeled: true,
  };
}

/**
 * Get the deviation table for audit / display (JEV-10).
 * Consumers (frontend, audit log) call this to render or verify deviations.
 */
export function getDeviationTable(): readonly DeviationEntry[] {
  return LOCAL_JEV_DEVIATIONS;
}

/**
 * Verify the deviation table is complete (JEV-10 scenario "偏差可核对").
 * Every deviation from the official contract MUST be registered here.
 * @returns list of unverified aspects (empty when all are registered).
 */
export function verifyDeviationsRegistered(): string[] {
  // The deviation table is static; this function serves as a runtime
  // self-check that the table hasn't been tampered with.
  const expectedAspects = [
    'Decision source',
    'Provider tag',
    'decisionSource',
    'Schema validation',
    'Latency',
    'Human review',
  ];
  const registered = new Set(LOCAL_JEV_DEVIATIONS.map((d) => d.aspect));
  return expectedAspects.filter((a) => !registered.has(a));
}
