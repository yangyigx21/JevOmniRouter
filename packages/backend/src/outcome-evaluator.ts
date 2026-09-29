/**
 * Outcome Evaluator — EXP-1 (§4.9.2, §4.10).
 *
 * Collects quality, cost, latency, and feedback data for each routing
 * decision. Produces `ExperienceEntry` records with outcome lifecycle:
 * `pending` → `confirmed` / `disputed` / `expired`.
 *
 * Key guarantees:
 *  - EXP-1: Every routing decision MUST produce an experience entry.
 *  - `outcome.status` starts as `pending`; MUST NOT participate in
 *    statistics or prior correction until confirmed/disputed.
 *  - `outcome.source` supports three types: human, system, implicit.
 *  - Implicit signals (weak labels) are weighted at 0.45 (SOURCE_W).
 *  - The Outcome Evaluator MUST NOT directly modify production policy.
 *  - Same-evidence discipline: retry MUST bring new evidence (EXP-1, EXP-10).
 */
import type {
  OutcomeStatus,
  OutcomeSource,
  ExperienceSample,
} from '@jev-router/shared';
import type { TokenUsage } from './model-gateway.js';
import type { DecisionSource } from './decision-source.js';
import type { RouteTier } from '@jev-router/shared';

// ---------------------------------------------------------------------------
// EXP-1: Experience Entry
// ---------------------------------------------------------------------------

/** Source weights per EXP-1 / §4.9.2. */
export const SOURCE_WEIGHTS: Record<OutcomeSource, number> = {
  human: 1.0,
  system: 1.0,
  implicit: 0.45,
};

/**
 * An experience entry produced by each routing decision (EXP-1).
 *
 * Created at decision time with `outcome.status = 'pending'`.
 * The outcome is asynchronously filled when the actual result is known.
 */
export interface ExperienceEntry {
  /** Unique experience entry ID. */
  eid: string;
  /** Request ID (links to EVENT-4 trace chain). */
  rid: string;
  /** Experience version at creation time. */
  expVersion: string;
  /** Decision prediction fields. */
  prediction: {
    intent: string;
    winner: string;
    winnerIdx: number;
    tier: RouteTier;
    confidence: number;
    topProb: number;
    /** Snapshot of prior deltas applied (catalog-order). */
    priorSnapshot: number[];
  };
  /** Outcome (initially pending, filled asynchronously). */
  outcome: {
    status: OutcomeStatus;
    source?: OutcomeSource;
    label?: string;
    observedAt?: number;
    latencyMs?: number;
    cost?: number;
  };
  /** Decision source tag (JEV-7). */
  decisionSource: DecisionSource;
  /** Model that was actually invoked. */
  modelId: string;
  /** Provider name. */
  provider: string;
  /** Catalog version at decision time (MODEL-4). */
  catalogVersion: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp when outcome was last updated. */
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Outcome evaluation
// ---------------------------------------------------------------------------

/** Quality dimensions for outcome evaluation. */
export interface QualityMetrics {
  /** Was the response relevant to the prompt? (0..1) */
  relevance: number;
  /** Was the response factually accurate? (0..1) */
  accuracy: number;
  /** Was the response complete? (0..1) */
  completeness: number;
  /** Overall quality score (weighted average, 0..1). */
  overall: number;
}

/** Default weights for quality dimensions. */
export const QUALITY_WEIGHTS = {
  relevance: 0.4,
  accuracy: 0.35,
  completeness: 0.25,
} as const;

/** Full outcome data for evaluation. */
export interface OutcomeData {
  /** Execution latency in ms. */
  latencyMs: number;
  /** Token usage from the model call. */
  usage: TokenUsage;
  /** Cost in USD. */
  costUsd: number;
  /** Quality metrics (from human or system evaluation). */
  quality?: QualityMetrics;
  /** Whether the user explicitly rejected the result. */
  rejected?: boolean;
  /** Whether the user retried with a different model (implicit signal). */
  retriedWithDifferentModel?: boolean;
  /** Whether the user abandoned the result (implicit signal). */
  abandoned?: boolean;
}

/**
 * Infer outcome source from available signals (EXP-1).
 *
 * Priority: human > system > implicit.
 * - `human`: explicit feedback (thumbs up/down, correction).
 * - `system`: automated quality evaluation or validation.
 * - `implicit`: behavioral signals (retry, abandon, switch model).
 */
export function inferOutcomeSource(signals: {
  hasHumanFeedback?: boolean;
  hasSystemEvaluation?: boolean;
  hasImplicitSignal?: boolean;
}): OutcomeSource | undefined {
  if (signals.hasHumanFeedback) return 'human';
  if (signals.hasSystemEvaluation) return 'system';
  if (signals.hasImplicitSignal) return 'implicit';
  return undefined;
}

/**
 * Infer outcome label from signals (EXP-1).
 *
 * - For `human` source: explicit label (the preferred modelId, or "correct").
 * - For `system` source: evaluated winner modelId.
 * - For `implicit` source: if retried with different model, the new model's id;
 *   if abandoned, the original winner (with disputed status).
 */
export function inferOutcomeLabel(signals: {
  source?: OutcomeSource;
  humanLabel?: string;
  systemWinner?: string;
  retriedWithDifferentModel?: boolean;
  retryModelId?: string;
  originalWinner: string;
}): string {
  if (signals.source === 'human' && signals.humanLabel) {
    return signals.humanLabel;
  }
  if (signals.source === 'system' && signals.systemWinner) {
    return signals.systemWinner;
  }
  if (signals.source === 'implicit') {
    if (signals.retriedWithDifferentModel && signals.retryModelId) {
      return signals.retryModelId;
    }
    return signals.originalWinner;
  }
  return signals.originalWinner;
}

/**
 * Determine outcome status from signals (EXP-1).
 *
 * - `confirmed`: human/system confirms the original winner was correct.
 * - `disputed`: human/system says it was wrong, or implicit signal suggests so.
 * - `pending`: not yet evaluated.
 * - `expired`: timeout or manual expiration.
 */
export function inferOutcomeStatus(signals: {
  confirmed?: boolean;
  disputed?: boolean;
  rejected?: boolean;
  abandoned?: boolean;
  retriedWithDifferentModel?: boolean;
  expired?: boolean;
}): OutcomeStatus {
  if (signals.expired) return 'expired';
  if (signals.confirmed) return 'confirmed';
  if (signals.disputed || signals.rejected) return 'disputed';
  // Implicit: retrying with a different model implies the original was disputed.
  if (signals.retriedWithDifferentModel) return 'disputed';
  // Abandoning without retry: ambiguous, stay pending until expired.
  return 'pending';
}

// ---------------------------------------------------------------------------
// Outcome Evaluator
// ---------------------------------------------------------------------------

/** Configuration for the Outcome Evaluator. */
export interface OutcomeEvaluatorConfig {
  /** Time in ms after which a pending outcome is automatically expired. */
  pendingExpiryMs: number;
  /** Whether implicit signals are enabled for outcome evaluation. */
  implicitSignalsEnabled: boolean;
}

/** Default configuration. */
export const DEFAULT_OUTCOME_CONFIG: OutcomeEvaluatorConfig = {
  pendingExpiryMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  implicitSignalsEnabled: true,
};

/**
 * OutcomeEvaluator — EXP-1.
 *
 * Creates experience entries at decision time and fills outcomes
 * when actual results are available.
 *
 * This module MUST NOT directly modify production policy (design.md §2.2:
 * "直接发布生产策略" is forbidden for Outcome Evaluator).
 */
export class OutcomeEvaluator {
  private readonly config: OutcomeEvaluatorConfig;
  private readonly entries = new Map<string, ExperienceEntry>();

  constructor(config?: Partial<OutcomeEvaluatorConfig>) {
    this.config = { ...DEFAULT_OUTCOME_CONFIG, ...config };
  }

  /**
   * Create a pending experience entry at decision time (EXP-1).
   * Called immediately after a routing decision is made.
   */
  createPendingEntry(params: {
    rid: string;
    expVersion: string;
    intent: string;
    winner: string;
    winnerIdx: number;
    tier: RouteTier;
    confidence: number;
    topProb: number;
    priorSnapshot: number[];
    decisionSource: DecisionSource;
    modelId: string;
    provider: string;
    catalogVersion: string;
  }): ExperienceEntry {
    const eid = `exp-${params.rid}-${Date.now()}`;
    const entry: ExperienceEntry = {
      eid,
      rid: params.rid,
      expVersion: params.expVersion,
      prediction: {
        intent: params.intent,
        winner: params.winner,
        winnerIdx: params.winnerIdx,
        tier: params.tier,
        confidence: params.confidence,
        topProb: params.topProb,
        priorSnapshot: params.priorSnapshot,
      },
      outcome: {
        status: 'pending',
      },
      decisionSource: params.decisionSource,
      modelId: params.modelId,
      provider: params.provider,
      catalogVersion: params.catalogVersion,
      createdAt: new Date().toISOString(),
    };
    this.entries.set(eid, entry);
    return entry;
  }

  /**
   * Fill the outcome of a pending entry (EXP-1).
   *
   * After this call, the entry's status becomes confirmed, disputed, or
   * expired — and it MAY participate in statistics (EXP-2).
   *
   * MUST NOT fill outcomes for degraded decisions (CONSTRAIN-4: "降级决策
   * SHALL NOT 写入 Jev 正常决策经验").
   */
  fillOutcome(
    eid: string,
    outcomeData: OutcomeData,
    source: OutcomeSource,
    label: string,
  ): ExperienceEntry {
    const entry = this.entries.get(eid);
    if (!entry) {
      throw new OutcomeError('ENTRY_NOT_FOUND', `Experience entry "${eid}" not found`);
    }

    if (entry.outcome.status !== 'pending') {
      throw new OutcomeError(
        'OUTCOME_ALREADY_FILLED',
        `Entry "${eid}" already has status "${entry.outcome.status}"`,
      );
    }

    // Determine status from outcome data.
    let status: OutcomeStatus;
    if (outcomeData.rejected || outcomeData.retriedWithDifferentModel) {
      status = 'disputed';
    } else if (source === 'human' || source === 'system') {
      // Human/system explicit confirmation: confirmed if label matches winner.
      status = label === entry.prediction.winner ? 'confirmed' : 'disputed';
    } else {
      // Implicit source: less reliable, mark as confirmed only if no negative signal.
      status = outcomeData.abandoned ? 'disputed' : 'confirmed';
    }

    entry.outcome = {
      status,
      source,
      label,
      observedAt: Date.now(),
      latencyMs: outcomeData.latencyMs,
      cost: outcomeData.costUsd,
    };
    entry.updatedAt = new Date().toISOString();

    return entry;
  }

  /**
   * Mark a pending entry as expired.
   * Expired entries MUST NOT participate in statistics (EXP-2).
   */
  expireEntry(eid: string): ExperienceEntry {
    const entry = this.entries.get(eid);
    if (!entry) {
      throw new OutcomeError('ENTRY_NOT_FOUND', `Experience entry "${eid}" not found`);
    }
    if (entry.outcome.status !== 'pending') {
      throw new OutcomeError(
        'OUTCOME_ALREADY_FILLED',
        `Entry "${eid}" already has status "${entry.outcome.status}"`,
      );
    }
    entry.outcome.status = 'expired';
    entry.outcome.observedAt = Date.now();
    entry.updatedAt = new Date().toISOString();
    return entry;
  }

  /**
   * Auto-expire pending entries older than the configured expiry.
   * @returns number of entries expired.
   */
  autoExpire(): number {
    const cutoff = Date.now() - this.config.pendingExpiryMs;
    let count = 0;
    for (const entry of this.entries.values()) {
      if (
        entry.outcome.status === 'pending' &&
        new Date(entry.createdAt).getTime() < cutoff
      ) {
        entry.outcome.status = 'expired';
        entry.outcome.observedAt = Date.now();
        entry.updatedAt = new Date().toISOString();
        count++;
      }
    }
    return count;
  }

  /**
   * Convert a confirmed/disputed experience entry to an ExperienceSample
   * for the experience loop (EXP-1, EXP-2, EXP-5).
   *
   * Pending and expired entries are excluded (§4.9.2: "pending / expired 不产生样本").
   */
  toExperienceSample(entry: ExperienceEntry): ExperienceSample | null {
    if (entry.outcome.status === 'pending' || entry.outcome.status === 'expired') {
      return null;
    }
    if (!entry.outcome.source || !entry.outcome.observedAt) {
      return null;
    }

    const y =
      entry.outcome.status === 'confirmed' && entry.outcome.label === entry.prediction.winner
        ? 1
        : 0;

    return {
      intent: entry.prediction.intent,
      modelId: entry.modelId,
      y,
      source: entry.outcome.source,
      observedAt: entry.outcome.observedAt,
      weight: SOURCE_WEIGHTS[entry.outcome.source],
    };
  }

  /**
   * Get all experience samples eligible for statistics (EXP-2).
   * Only confirmed and disputed entries are included.
   */
  getExperienceSamples(): ExperienceSample[] {
    const samples: ExperienceSample[] = [];
    for (const entry of this.entries.values()) {
      const sample = this.toExperienceSample(entry);
      if (sample) {
        samples.push(sample);
      }
    }
    return samples;
  }

  /** Get an entry by eid. */
  getEntry(eid: string): ExperienceEntry | undefined {
    return this.entries.get(eid);
  }

  /** Get all entries, optionally filtered by status. */
  getEntries(status?: OutcomeStatus): ExperienceEntry[] {
    const all = Array.from(this.entries.values());
    if (status) {
      return all.filter((e) => e.outcome.status === status);
    }
    return all;
  }

  /**
   * Count entries by status.
   */
  countByStatus(): Record<OutcomeStatus, number> {
    const counts: Record<OutcomeStatus, number> = {
      pending: 0,
      confirmed: 0,
      disputed: 0,
      expired: 0,
    };
    for (const entry of this.entries.values()) {
      counts[entry.outcome.status]++;
    }
    return counts;
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type OutcomeErrorCode = 'ENTRY_NOT_FOUND' | 'OUTCOME_ALREADY_FILLED' | 'INVALID_SOURCE';

export class OutcomeError extends Error {
  constructor(
    readonly code: OutcomeErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'OutcomeError';
  }
}
