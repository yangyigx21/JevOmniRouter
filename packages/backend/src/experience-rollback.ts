/**
 * Experience Rollback — EXP-9 (T-4.7, §4.9.8, §5.3).
 *
 * Atomic rollback to a target version. Rollback invariants (EXP-9):
 *
 *  - Rollback to `V_target` MUST restore the active state to **exactly**
 *    `V_target.priorSnapshots` — never a mixed state.
 *  - Rollback is recorded as a NEW version event (append-only audit trail):
 *    `trigger='rollback'`, `rollbackTarget=V_target`.
 *  - The rolled-back-from versions are NOT erased from history; they
 *    carry an `rolledBack: true` audit marker.
 *  - Rollback takes effect on the NEXT decision — no service restart
 *    required (the active version pointer just moves forward to a new
 *    rollback record whose `priorSnapshots === V_target.priorSnapshots`).
 *
 * "Atomic" here means: after `rollbackTo`, `getLatestVersion().priorSnapshots`
 * MUST deep-equal `V_target.priorSnapshots`. The implementation MUST NOT
 * leave the system in a partially-rolled-back state.
 */
import type { ExperienceVersion, ExperienceVersionManager } from './experience-version.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a rollback operation (EXP-9). */
export interface RollbackResult {
  /** The version record produced by the rollback (new version event). */
  rollbackVersion: ExperienceVersion;
  /** The target version we rolled back to. */
  targetVersion: ExperienceVersion;
  /** Whether the active prior-snapshot state exactly equals the target. */
  atomicityVerified: boolean;
  /** Any violation strings if atomicity failed. */
  violations: string[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ExperienceRollbackErrorCode =
  | 'TARGET_NOT_FOUND'
  | 'TARGET_ALREADY_LATEST'
  | 'ATOMICITY_VIOLATION'
  | 'OPERATOR_REQUIRED';

export class ExperienceRollbackError extends Error {
  constructor(
    readonly code: ExperienceRollbackErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'ExperienceRollbackError';
  }
}

// ---------------------------------------------------------------------------
// Experience Rollback Manager
// ---------------------------------------------------------------------------

/**
 * ExperienceRollback — T-4.7.
 *
 * Wraps `ExperienceVersionManager` to provide atomic rollback semantics.
 * Each `rollbackTo(target)` call:
 *  1. Resolves the target version.
 *  2. Creates a NEW version event with `trigger='rollback'` and
 *     `priorSnapshots` copied from the target (immutable).
 *  3. Verifies the new active state deep-equals the target's snapshots.
 *
 * Rollback MUST NOT mutate the existing history (append-only).
 */
export class ExperienceRollback {
  constructor(private readonly versions: ExperienceVersionManager) {}

  /**
   * Atomically roll back to `targetVersion` (EXP-9).
   *
   * @throws ExperienceRollbackError if target missing, target is latest,
   *         or atomicity verification fails.
   */
  rollbackTo(targetVersion: number, operator: string): RollbackResult {
    if (!operator || operator.trim() === '') {
      throw new ExperienceRollbackError(
        'OPERATOR_REQUIRED',
        'Rollback requires a non-empty operator (EXP-9 audit)',
      );
    }
    const latest = this.versions.getLatestVersion();
    if (!latest) {
      throw new ExperienceRollbackError(
        'TARGET_NOT_FOUND',
        'No versions exist; cannot roll back',
      );
    }
    if (targetVersion === latest.version) {
      throw new ExperienceRollbackError(
        'TARGET_ALREADY_LATEST',
        `Target ${targetVersion} is already the latest version`,
      );
    }

    // Resolve target — getVersion throws VERSION_NOT_FOUND on absence.
    let target: ExperienceVersion;
    try {
      target = this.versions.getVersion(targetVersion);
    } catch {
      throw new ExperienceRollbackError(
        'TARGET_NOT_FOUND',
        `Target version ${targetVersion} not found`,
      );
    }

    // Create a new version event that pins the target's prior snapshots.
    // This is the "append-only audit" record — the target itself stays
    // immutable in history.
    const rollbackVersion = this.versions.createVersion({
      trigger: 'rollback',
      operator,
      rollbackTarget: targetVersion,
      priorSnapshots: { ...target.priorSnapshots },
      changes: {
        rationale: `Atomic rollback to V${targetVersion}`,
        recomputedPriors: false,
      },
    });

    // Verify atomicity: active state MUST deep-equal target's snapshots.
    const { ok, violations } = verifyRollbackAtomicity(rollbackVersion, target);
    if (!ok) {
      throw new ExperienceRollbackError(
        'ATOMICITY_VIOLATION',
        `Rollback atomicity violated: ${violations.join('; ')}`,
      );
    }

    return {
      rollbackVersion,
      targetVersion: target,
      atomicityVerified: ok,
      violations,
    };
  }

  /**
   * Verify that an existing rollback record is atomic (EXP-9 audit helper).
   * Returns the violation list; empty means atomic.
   */
  verifyRollbackAtomicity(rollbackVersion: ExperienceVersion): {
    ok: boolean;
    violations: string[];
  } {
    if (rollbackVersion.trigger !== 'rollback') {
      return {
        ok: false,
        violations: [
          `Version ${rollbackVersion.version} is not a rollback record (trigger=${rollbackVersion.trigger})`,
        ],
      };
    }
    if (typeof rollbackVersion.rollbackTarget !== 'number') {
      return {
        ok: false,
        violations: ['rollback record missing rollbackTarget'],
      };
    }
    let target: ExperienceVersion;
    try {
      target = this.versions.getVersion(rollbackVersion.rollbackTarget);
    } catch {
      return {
        ok: false,
        violations: [`rollback target ${rollbackVersion.rollbackTarget} not found`],
      };
    }
    return verifyRollbackAtomicity(rollbackVersion, target);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Verify rollback atomicity (EXP-9 §4.9.8 "回滚后生效状态 SHALL 恰等于目标版本").
 * @returns `{ ok, violations }` — `ok` is true iff the rollback record's
 *          prior snapshots deep-equal the target's prior snapshots.
 */
export function verifyRollbackAtomicity(
  rollback: ExperienceVersion,
  target: ExperienceVersion,
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  if (rollback.trigger !== 'rollback') {
    violations.push(`rollback record's trigger MUST be 'rollback' (got "${rollback.trigger}")`);
  }
  if (rollback.rollbackTarget !== target.version) {
    violations.push(
      `rollbackTarget ${rollback.rollbackTarget} ≠ target.version ${target.version}`,
    );
  }
  // Deep-equal check on prior snapshots (keys + values).
  const a = rollback.priorSnapshots;
  const b = target.priorSnapshots;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) {
    violations.push(
      `prior snapshot key count mismatch (rollback=${aKeys.length}, target=${bKeys.length})`,
    );
  } else {
    for (let i = 0; i < aKeys.length; i += 1) {
      if (aKeys[i] !== bKeys[i]) {
        violations.push(`prior snapshot key mismatch at idx ${i}: "${aKeys[i]}" ≠ "${bKeys[i]}"`);
        break;
      }
    }
  }
  for (const k of aKeys) {
    if (b[k] === undefined) continue; // already reported above
    if (a[k] !== b[k]) {
      violations.push(`prior snapshot value mismatch for key "${k}": ${a[k]} ≠ ${b[k]}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Get the "effective" version — i.e., the target of the latest rollback
 * record if the latest is a rollback, else the latest itself.
 *
 * Useful for `experience-validator` to determine where the "version applied"
 * boundary lies (EXP-10 split point).
 */
export function getEffectiveVersion(
  versions: ExperienceVersionManager,
): ExperienceVersion | null {
  const latest = versions.getLatestVersion();
  if (!latest) return null;
  if (latest.trigger === 'rollback' && typeof latest.rollbackTarget === 'number') {
    try {
      return versions.getVersion(latest.rollbackTarget);
    } catch {
      return latest;
    }
  }
  return latest;
}
