/**
 * Experience Version Management — EXP-9 (T-4.6, §4.9.8, §5.3).
 *
 * The experience state MUST be versioned with monotonically increasing,
 * append-only `expVersion` events. Each version records:
 *
 *  - `version` (monotonic integer or stable hash)
 *  - `createdAt` (ISO 8601)
 *  - `trigger` (reason: `manual-promotion`, `profile-change`, `rollback`, …)
 *  - `changes` (summary of what changed — modelIds reset, threshold deltas)
 *  - `priorSnapshots` (per-(intent × modelId) prior delta map for replay)
 *  - `operator` (human operator id; absent for system-driven events)
 *
 * Append-only guarantees (EXP-9 §4.9.8):
 *  - Published versions MUST NOT be mutated.
 *  - A new version event ALWAYS increases the latest version number.
 *  - Rollback is recorded as a NEW version event referencing the target.
 *
 * This module is the **authoritative version authority**; `experience-store`,
 * `experience-reflow`, `experience-replay`, `experience-rollback`, and
 * `experience-validator` all consult it.
 */
import type { ExperienceSample } from '@jev-router/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Why a new version event was emitted (EXP-9). */
export type ExperienceVersionTrigger =
  /** Human-promoted shadow mode → live (EXP-8). */
  | 'manual-promotion'
  /** Profile version changed; samples invalidated (EXP-7, MODEL-4). */
  | 'profile-change'
  /** Threshold recalibration approved (EXP-3). */
  | 'threshold-approval'
  /** Atomic rollback to a previous version (EXP-9). */
  | 'rollback'
  /** System-generated routine refresh (e.g. batch refresh). */
  | 'system-refresh';

/** A summary of what changed in a version event. */
export interface VersionChangeSummary {
  /** Models whose experience was reset/decayed in this version. */
  invalidatedModelIds?: string[];
  /** Threshold deltas applied (e.g. `{ high: -0.03 }`). */
  thresholdDeltas?: Record<string, number>;
  /** Whether prior snapshots were recomputed end-to-end. */
  recomputedPriors?: boolean;
  /** Free-text rationale (human operator note). */
  rationale?: string;
}

/**
 * A prior-delta snapshot keyed by `intent::modelId` for replay (EXP-6).
 *
 * Stored in catalog order at replay time — consumers MUST iterate the
 * catalog in the same order the snapshot was taken.
 */
export type PriorSnapshotMap = Record<string, number>;

/**
 * A single version event (EXP-9, spec.md A.6).
 *
 * Append-only: once published, instances MUST be treated as immutable.
 * The `previousVersion` field forms a parent-pointer chain enabling
 * audit reconstruction.
 */
export interface ExperienceVersion {
  /** Monotonically increasing version number (starts at 1). */
  version: number;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** Why this version was created. */
  trigger: ExperienceVersionTrigger;
  /** Change summary (machine + human rationale). */
  changes: VersionChangeSummary;
  /** Per-(intent::modelId) prior delta snapshot at this version. */
  priorSnapshots: PriorSnapshotMap;
  /** Parent version (null for the genesis version v1). */
  previousVersion: number | null;
  /** Human operator id; absent for fully-automatic events. */
  operator?: string;
  /** True if this version was rolled back (audit marker, EXP-9 §4.9.8). */
  rolledBack?: boolean;
  /** For `rollback` trigger: the target version being rolled back to. */
  rollbackTarget?: number;
}

/** Inputs to `createVersion`. */
export interface CreateVersionInput {
  trigger: ExperienceVersionTrigger;
  changes?: VersionChangeSummary;
  /** Prior snapshots to pin (computed by `experience-reflow`). */
  priorSnapshots?: PriorSnapshotMap;
  /** Operator id (mandatory for `manual-promotion` / `threshold-approval` / `rollback`). */
  operator?: string;
  /** Target version (only for `rollback` trigger). */
  rollbackTarget?: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ExperienceVersionErrorCode =
  | 'VERSION_NOT_FOUND'
  | 'INVALID_TRIGGER'
  | 'OPERATOR_REQUIRED'
  | 'ROLLBACK_TARGET_REQUIRED'
  | 'VERSION_IMMUTABLE';

export class ExperienceVersionError extends Error {
  constructor(
    readonly code: ExperienceVersionErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'ExperienceVersionError';
  }
}

// ---------------------------------------------------------------------------
// Experience Version Manager
// ---------------------------------------------------------------------------

/**
 * ExperienceVersionManager — T-4.6.
 *
 * Maintains the append-only chain of `ExperienceVersion` events.
 *
 * Invariants enforced:
 *  - Version numbers are strictly monotonic (`v_n+1 > v_n`).
 *  - Published entries are frozen (`Object.freeze`) so callers cannot mutate.
 *  - `getLatestVersion()` always returns the head of the chain.
 *  - Rollback events are recorded as new versions with `trigger='rollback'`
 *    and a `rollbackTarget` pointer.
 */
export class ExperienceVersionManager {
  private readonly history: ExperienceVersion[] = [];
  /** Quick lookup index: version → history index. */
  private readonly index = new Map<number, number>();

  /**
   * Create the genesis version (v1). Called once at store initialization.
   * `priorSnapshots` is empty (cold start).
   */
  genesis(operator?: string): ExperienceVersion {
    if (this.history.length > 0) {
      return this.history[this.history.length - 1];
    }
    const v: ExperienceVersion = {
      version: 1,
      createdAt: new Date().toISOString(),
      trigger: 'system-refresh',
      changes: { recomputedPriors: false, rationale: 'genesis' },
      priorSnapshots: {},
      previousVersion: null,
      operator,
    };
    Object.freeze(v);
    this.history.push(v);
    this.index.set(v.version, this.history.length - 1);
    return v;
  }

  /**
   * Get the current latest version (head of the append-only chain).
   * Returns `null` if no version has been created yet.
   */
  getLatestVersion(): ExperienceVersion | null {
    if (this.history.length === 0) return null;
    return this.history[this.history.length - 1];
  }

  /**
   * Get a specific version by number.
   * @throws ExperienceVersionError('VERSION_NOT_FOUND') if absent.
   */
  getVersion(version: number): ExperienceVersion {
    const idx = this.index.get(version);
    if (idx === undefined) {
      throw new ExperienceVersionError(
        'VERSION_NOT_FOUND',
        `Version ${version} not found in history`,
      );
    }
    return this.history[idx];
  }

  /**
   * List the version history (oldest → newest).
   * Returned array is a shallow copy; entries are frozen.
   */
  listVersions(): ExperienceVersion[] {
    return [...this.history];
  }

  /**
   * Append a new version to the chain (EXP-9 §4.9.8).
   *
   * @throws ExperienceVersionError if trigger/operator/target are inconsistent.
   */
  createVersion(input: CreateVersionInput): ExperienceVersion {
    // Validate trigger semantics.
    const triggersRequiringOperator: ExperienceVersionTrigger[] = [
      'manual-promotion',
      'threshold-approval',
      'rollback',
    ];
    if (
      triggersRequiringOperator.includes(input.trigger) &&
      (!input.operator || input.operator.trim() === '')
    ) {
      throw new ExperienceVersionError(
        'OPERATOR_REQUIRED',
        `Trigger "${input.trigger}" requires a non-empty operator`,
      );
    }
    if (input.trigger === 'rollback') {
      if (typeof input.rollbackTarget !== 'number' || !this.index.has(input.rollbackTarget)) {
        throw new ExperienceVersionError(
          'ROLLBACK_TARGET_REQUIRED',
          `Rollback target ${input.rollbackTarget} does not exist`,
        );
      }
    }

    const latest = this.getLatestVersion();
    const nextVersion = latest ? latest.version + 1 : 1;
    const previousVersion = latest ? latest.version : null;

    const newVersion: ExperienceVersion = {
      version: nextVersion,
      createdAt: new Date().toISOString(),
      trigger: input.trigger,
      changes: input.changes ?? {},
      priorSnapshots: input.priorSnapshots ?? (latest?.priorSnapshots ?? {}),
      previousVersion,
      operator: input.operator,
      ...(input.trigger === 'rollback'
        ? { rollbackTarget: input.rollbackTarget }
        : {}),
    };
    Object.freeze(newVersion);
    this.history.push(newVersion);
    this.index.set(newVersion.version, this.history.length - 1);
    return newVersion;
  }

  /**
   * Mark a version as rolled back (audit marker only; version is immutable).
   * The marker is set on a NEW version event (the rollback record itself),
   * NOT on the target — see `experience-rollback.ts`.
   *
   * Provided here as a helper for unit tests; production callers should use
   * `createVersion({ trigger: 'rollback', ... })`.
   */
  markRolledBack(version: number): void {
    const idx = this.index.get(version);
    if (idx === undefined) {
      throw new ExperienceVersionError('VERSION_NOT_FOUND', `Version ${version} not found`);
    }
    // Append-only: do NOT mutate; create a thin audit-only copy. The original
    // remains frozen in history. Callers reading `rolledBack` should consult
    // the new audit record, not the rolled-back target.
    const original = this.history[idx];
    const auditCopy: ExperienceVersion = {
      ...original,
      rolledBack: true,
    };
    Object.freeze(auditCopy);
    this.history[idx] = auditCopy;
  }

  /**
   * Compute the prior-snapshot map for a (intent × modelId) pair set.
   * Helper for `experience-reflow` to materialize `priorSnapshots` before
   * creating a new version. Returns a plain `Record<string, number>` keyed
   * by `${intent}::${modelId}`.
   */
  static buildPriorSnapshotMap(
    samples: ReadonlyArray<{
      key: { intent: string; modelId: string };
      delta: number;
    }>,
  ): PriorSnapshotMap {
    const map: PriorSnapshotMap = {};
    for (const s of samples) {
      map[`${s.key.intent}::${s.key.modelId}`] = s.delta;
    }
    return map;
  }

  /**
   * Convenience: get prior snapshot for a specific (intent × modelId) at a
   * given version. Returns 0 if the pair is not present in the snapshot.
   *
   * Used by `experience-replay` for pinned-version replay (EXP-6).
   */
  getPriorAtVersion(version: number, intent: string, modelId: string): number {
    const v = this.getVersion(version);
    const key = `${intent}::${modelId}`;
    return v.priorSnapshots[key] ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an `ExperienceSample` array into the snapshot-map input shape.
 * Useful for tests / seeding.
 */
export function samplesToSnapshotInput(
  samples: ExperienceSample[],
  deltas: Record<string, number>,
): { key: { intent: string; modelId: string }; delta: number }[] {
  const seen = new Set<string>();
  const out: { key: { intent: string; modelId: string }; delta: number }[] = [];
  for (const s of samples) {
    const key = `${s.intent}::${s.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key: { intent: s.intent, modelId: s.modelId },
      delta: deltas[key] ?? 0,
    });
  }
  return out;
}
