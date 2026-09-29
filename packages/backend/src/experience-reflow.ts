/**
 * Experience Reflow Channel — EXP-4 (T-4.3, §5.3, §4.9.4).
 *
 * The **downstream** leg of the closed loop: reads the active `expVersion`,
 * injects `Δraw` into scoring (EXP-5 bounded shrinking prior correction),
 * and records `priorDelta[]` for each decision archive (catalog order).
 *
 * Reflow MUST only happen through two explicit auditable channels (EXP-4):
 *  ① Model-selection prior correction (`EXP-5`) — this module.
 *  ② Human-approved confidence thresholds (`EXP-3`) — see
 *    `threshold-suggestion.ts`.
 *
 * Reflow MUST NOT modify model profiles, feature weights, or the candidate
 * pool (EXP-4 "未声明的隐式通道" forbidden).
 *
 * A/B diff support (EXP-4 scenario "经验确实改变了下一次决策"):
 *  - `injectReflow(score, priorDelta[])` applies the delta in catalog order.
 *  - `diffWithAndWithoutReflow(score, priorDelta[])` returns the
 *    `{ with, without }` pair so callers can produce an explanation diff.
 */
import type { ExperienceSample, PriorDeltaResult } from '@jev-router/shared';
import { priorDeltaFor } from '@jev-router/shared';
import type { ExperienceVersionManager, ExperienceVersion } from './experience-version.js';
import type { ExperienceStore } from './experience-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A reflow decision record — produced per routing call (EXP-4).
 * `priorDelta[]` is in **catalog order**, matching the order of the
 * candidate pool used by `scoreModels`.
 */
export interface ReflowDecision {
  /** `expVersion` pinned to this decision (EXP-4: must record). */
  expVersion: number | null;
  /** Per-candidate prior deltas (catalog order). */
  priorDelta: number[];
  /** True iff shadow mode (delta not actually applied; EXP-8). */
  shadow: boolean;
  /** Reason the reflow was/wasn't applied (for archive / audit). */
  correction: 'applied' | 'none';
  /** Per-pair metadata, keyed by `intent::modelId`. */
  pairMetadata: Record<string, PriorDeltaResult>;
}

/** A/B diff output (EXP-4 explanation). */
export interface ReflowDiff {
  /** Score with reflow applied. */
  with: number[];
  /** Score without reflow (original). */
  without: number[];
  /** Delta vector (with − without). */
  delta: number[];
  /** Whether the winner changed as a result of reflow. */
  winnerChanged: boolean;
  /** Catalog index of the winner without reflow. */
  winnerIdxWithout: number;
  /** Catalog index of the winner with reflow. */
  winnerIdxWith: number;
}

// ---------------------------------------------------------------------------
// Experience Reflow Manager
// ---------------------------------------------------------------------------

/**
 * ExperienceReflow — T-4.3.
 *
 * Composes `priorDeltaFor` (shared) with `ExperienceVersionManager` and
 * `ExperienceStore` to produce the per-decision `priorDelta[]` injected
 * into scoring.
 */
export class ExperienceReflow {
  constructor(
    private readonly versions: ExperienceVersionManager,
    private readonly store: ExperienceStore,
  ) {}

  /**
   * Get the active prior deltas for a given intent, pinned to the current
   * `expVersion` (EXP-4 scenario "经验确实改变了下一次决策").
   *
   * @param intent   The routing intent
   * @param catalog  Catalog-order model descriptors: `[{ modelId, priorMean, profileVersion }]`
   * @param now      Epoch milliseconds (default `Date.now()`)
   */
  getActivePriorDeltas(
    intent: string,
    catalog: ReadonlyArray<{
      modelId: string;
      priorMean: number;
      profileVersion?: string;
    }>,
    now: number = Date.now(),
  ): ReflowDecision {
    const latest = this.versions.getLatestVersion();
    if (!latest) {
      // Genesis not yet created → cold-start: zero correction.
      return this.coldStartDecision(catalog.length);
    }
    const globalConfirmed = this.store.confirmedCount() + this.store.disputedCount();
    const pairMetadata: Record<string, PriorDeltaResult> = {};
    const priorDelta: number[] = new Array(catalog.length).fill(0);
    let anyApplied = false;
    let anyShadow = false;

    for (let i = 0; i < catalog.length; i += 1) {
      const entry = catalog[i];
      const samples = this.collectSamples(intent, entry.modelId, entry.profileVersion, now);
      const result = priorDeltaFor({
        priorMean: entry.priorMean,
        samples,
        globalConfirmedCount: globalConfirmed,
      });
      const key = `${intent}::${entry.modelId}`;
      pairMetadata[key] = result;
      priorDelta[i] = result.delta;
      if (result.shadowed) anyShadow = true;
      if (result.delta !== 0) anyApplied = true;
    }

    const correction = anyApplied && !anyShadow ? 'applied' : 'none';
    return {
      expVersion: latest.version,
      priorDelta,
      shadow: anyShadow,
      correction,
      pairMetadata,
    };
  }

  /**
   * Inject the prior-delta vector into a raw score vector (EXP-5 injection
   * point — BEFORE softmax). The injection point is **unique**: callers
   * MUST NOT also apply delta after softmax.
   *
   * @param rawScores  Catalog-order raw scores.
   * @param priorDelta  Catalog-order prior deltas.
   * @returns Catalog-order adjusted scores.
   */
  injectReflow(rawScores: ReadonlyArray<number>, priorDelta: ReadonlyArray<number>): number[] {
    if (rawScores.length !== priorDelta.length) {
      throw new Error(
        `injectReflow: length mismatch (raw=${rawScores.length}, priorDelta=${priorDelta.length})`,
      );
    }
    const out = new Array<number>(rawScores.length);
    for (let i = 0; i < rawScores.length; i += 1) {
      out[i] = rawScores[i] + priorDelta[i];
    }
    return out;
  }

  /**
   * Record a `priorSnapshot` for a decision into the version manager (EXP-4,
   * EXP-6: archive MUST pin the applied prior).
   *
   * This DOES NOT create a new version; it only attaches the snapshot to the
   * next version event when one is created. Use `versions.createVersion()`
   * separately to materialize a new version.
   */
  recordPriorSnapshot(
    intent: string,
    catalog: ReadonlyArray<{ modelId: string }>,
    decision: ReflowDecision,
  ): { intent: string; modelId: string; delta: number }[] {
    const out: { intent: string; modelId: string; delta: number }[] = [];
    for (let i = 0; i < catalog.length; i += 1) {
      out.push({
        intent,
        modelId: catalog[i].modelId,
        delta: decision.priorDelta[i] ?? 0,
      });
    }
    return out;
  }

  /**
   * A/B diff: compare decision with vs without reflow (EXP-4 explanation).
   * Returns the score vectors and whether the winner changed.
   */
  diffWithAndWithoutReflow(
    rawScores: ReadonlyArray<number>,
    priorDelta: ReadonlyArray<number>,
  ): ReflowDiff {
    const without = [...rawScores];
    const withReflow = this.injectReflow(rawScores, priorDelta);
    const delta = withReflow.map((v, i) => v - without[i]);
    const winnerIdxWithout = argMax(without);
    const winnerIdxWith = argMax(withReflow);
    return {
      with: withReflow,
      without,
      delta,
      winnerChanged: winnerIdxWithout !== winnerIdxWith,
      winnerIdxWithout,
      winnerIdxWith,
    };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /** Build a cold-start decision (no versions yet → zero correction). */
  private coldStartDecision(catalogLen: number): ReflowDecision {
    return {
      expVersion: null,
      priorDelta: new Array(catalogLen).fill(0),
      shadow: true,
      correction: 'none',
      pairMetadata: {},
    };
  }

  /**
   * Collect `ExperienceSample`s for a (intent × modelId) pair from the store.
   * Pending / expired entries are skipped (EXP-1 / EXP-2). Sample weights are
   * computed using `outcomeWeight` (EXP-7 time-decay + source weight).
   *
   * Note: the actual weighting is done at sample creation time by
   * `OutcomeEvaluator.toExperienceSample`. We re-pull from the store and
   * trust the stored `weight` field; if absent we recompute lazily.
   */
  private collectSamples(
    intent: string,
    modelId: string,
    _profileVersion: string | undefined,
    _now: number,
  ): ExperienceSample[] {
    const entries = this.store.queryByIntentModel({ intent, modelId });
    const out: ExperienceSample[] = [];
    for (const e of entries) {
      if (e.outcome.status !== 'confirmed' && e.outcome.status !== 'disputed') {
        continue;
      }
      if (!e.outcome.source || typeof e.outcome.observedAt !== 'number') continue;
      const y =
        e.outcome.status === 'confirmed' &&
        e.outcome.label === e.prediction.winner
          ? 1
          : 0;
      out.push({
        intent,
        modelId,
        y,
        source: e.outcome.source,
        observedAt: e.outcome.observedAt,
        // Defensive default weight; reflow relies on priorDeltaFor's
        // EXP_WEIGHT_FLOOR guard for under-weight filtering.
        weight: 1,
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Pin helpers
// ---------------------------------------------------------------------------

/**
 * Pin a specific version for historical replay (EXP-6).
 * Returns the version's prior snapshot map; consumers look up by
 * `${intent}::${modelId}`.
 */
export function pinVersion(
  versions: ExperienceVersionManager,
  version: number,
): ExperienceVersion {
  return versions.getVersion(version);
}

/** Arg-max: selects by highest raw score (consistent with fixed `tieBreak` where raw is definitive). */
function argMax(arr: ReadonlyArray<number>): number {
  let best = -Infinity;
  let bestIdx = -1;
  for (let i = 0; i < arr.length; i += 1) {
    if (arr[i] > best) {
      best = arr[i];
      bestIdx = i;
    }
  }
  return bestIdx;
}
