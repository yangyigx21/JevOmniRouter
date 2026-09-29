/**
 * Experience Replay — Pinned-Version Replay — EXP-6 (T-4.8, §4.9, spec A.6).
 *
 * Historical decisions MUST be reproducible by pinning the `expVersion`
 * and using the **pinned** prior snapshot — NOT the latest version (EXP-6):
 *
 *  - `replayPinned(version, rawScores, catalog)` returns the re-computed
 *    decision using V_version's `priorSnapshots`.
 *  - When the pinned version has been rolled back / purged, replay MUST
 *    degrade to "archive's recorded result presentation" with an explicit
 *    "经验版本不可用，未重算" marker — it MUST NOT silently use the
 *    latest version.
 *  - Replay result vs archive record MUST agree on `winner` /
 *    `winnerIdx` / `priorDelta[]` (EXP-6 scenario 1).
 *
 * Archive pinning (EXP-6 §4.9.7):
 *  - Archives are stamped with the `expVersion` under which they ran.
 *  - Pinning is per-decision; the system MUST support concurrent replays
 *    pinned to different versions.
 */
import type { ExperienceVersion, ExperienceVersionManager } from './experience-version.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The mode the replay ran in (EXP-6 §4.9.7 + "经验版本不可用" degrade).
 *  - `recomputed`   — full recompute using pinned snapshots; output compared
 *                     to archive record for consistency.
 *  - `degraded`     — pinned version unavailable (rolled back / purged);
 *                     archive's recorded result is presented verbatim with
 *                     an explicit "未重算" marker. MUST NOT use latest.
 */
export type ReplayMode = 'recomputed' | 'degraded';

/** Output of a pinned-version replay (EXP-6). */
export interface PinnedReplayResult {
  /** Pinned version number used for replay. */
  pinnedVersion: number | null;
  /** Whether the pinned version was available for full recompute. */
  mode: ReplayMode;
  /** Catalog-order prior deltas actually used (zero in degraded mode). */
  priorDelta: number[];
  /** Catalog-order winner index after recompute (or archive's idx if degraded). */
  winnerIdx: number;
  /** Winner modelId after recompute (or archive's record if degraded). */
  winner: string | null;
  /** Reason for degraded mode, if applicable. */
  degradeReason?: string;
}

/** Input to `replayPinned` (an archive to recompute + the catalog context). */
export interface PinnedReplayInput {
  /** Pinned version to replay against. */
  pinnedVersion: number;
  /** Catalog-order raw scores recorded in the archive. */
  rawScores: number[];
  /** Catalog-order model descriptors used at decision time. */
  catalog: ReadonlyArray<{ modelId: string }>;
  /** Intent that produced the decision (for snapshot lookup). */
  intent: string;
  /** Archive's recorded winnerIdx (for consistency verification). */
  archiveWinnerIdx: number;
  /** Archive's recorded winner modelId (for consistency verification). */
  archiveWinner: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ExperienceReplayErrorCode =
  | 'VERSION_NOT_FOUND'
  | 'LENGTH_MISMATCH'
  | 'INVALID_ARCHIVE';

export class ExperienceReplayError extends Error {
  constructor(
    readonly code: ExperienceReplayErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'ExperienceReplayError';
  }
}

// ---------------------------------------------------------------------------
// Experience Replay
// ---------------------------------------------------------------------------

/**
 * ExperienceReplay — T-4.8.
 *
 * Stateless helper around `ExperienceVersionManager`; safe to instantiate
 * once and call from multiple replay contexts (concurrent pins allowed).
 */
export class ExperienceReplay {
  constructor(private readonly versions: ExperienceVersionManager) {}

  /**
   * Replay a decision using the prior snapshot from `pinnedVersion`
   * (EXP-6 §4.9.7). Returns the recomputed decision or the degraded
   * form when the pinned version is no longer available.
   */
  replayPinned(input: PinnedReplayInput): PinnedReplayResult {
    if (input.rawScores.length !== input.catalog.length) {
      throw new ExperienceReplayError(
        'LENGTH_MISMATCH',
        `rawScores length (${input.rawScores.length}) ≠ catalog length (${input.catalog.length})`,
      );
    }

    // Try to fetch the pinned version. Degrade to archive-record presentation
    // if unavailable.
    let version: ExperienceVersion | null = null;
    try {
      version = this.versions.getVersion(input.pinnedVersion);
    } catch {
      return {
        pinnedVersion: input.pinnedVersion,
        mode: 'degraded',
        priorDelta: new Array(input.rawScores.length).fill(0),
        winnerIdx: input.archiveWinnerIdx,
        winner: input.archiveWinner,
        degradeReason: `Version ${input.pinnedVersion} unavailable (rolled back / purged) — presenting archive's recorded result, not recomputed (EXP-6 §4.9.7)`,
      };
    }

    // Build the priorDelta vector from the pinned snapshot map, in catalog order.
    const priorDelta: number[] = new Array(input.catalog.length).fill(0);
    for (let i = 0; i < input.catalog.length; i += 1) {
      const key = `${input.intent}::${input.catalog[i].modelId}`;
      const delta = version.priorSnapshots[key];
      if (typeof delta === 'number' && Number.isFinite(delta)) {
        priorDelta[i] = delta;
      }
    }

    // Apply the delta to the recorded raw scores (EXP-5 injection point).
    const adjusted = input.rawScores.map((s, i) => s + priorDelta[i]);
    const winnerIdx = argMax(adjusted);
    const winner = input.catalog[winnerIdx]?.modelId ?? null;

    return {
      pinnedVersion: version.version,
      mode: 'recomputed',
      priorDelta,
      winnerIdx,
      winner,
    };
  }

  /**
   * Verify pinned-version consistency (EXP-6 scenario 1: "钉版本重放得到相同选型").
   *
   * The replay result MUST agree with the archive on `winner`,
   * `winnerIdx`, and `priorDelta[]`. Returns `{ ok, violations }`.
   */
  verifyPinnedConsistency(
    result: PinnedReplayResult,
    archive: {
      winnerIdx: number;
      winner: string;
      priorDelta: number[];
    },
  ): { ok: boolean; violations: string[] } {
    const violations: string[] = [];
    if (result.mode !== 'recomputed') {
      violations.push(
        `replay mode "${result.mode}" — cannot verify consistency against archive (EXP-6)`,
      );
    }
    if (result.winnerIdx !== archive.winnerIdx) {
      violations.push(
        `winnerIdx mismatch: replay=${result.winnerIdx}, archive=${archive.winnerIdx}`,
      );
    }
    if (result.winner !== archive.winner) {
      violations.push(
        `winner mismatch: replay=${result.winner}, archive=${archive.winner}`,
      );
    }
    if (result.priorDelta.length !== archive.priorDelta.length) {
      violations.push(
        `priorDelta length mismatch: replay=${result.priorDelta.length}, archive=${archive.priorDelta.length}`,
      );
    } else {
      for (let i = 0; i < result.priorDelta.length; i += 1) {
        if (result.priorDelta[i] !== archive.priorDelta[i]) {
          violations.push(
            `priorDelta[${i}] mismatch: replay=${result.priorDelta[i]}, archive=${archive.priorDelta[i]}`,
          );
        }
      }
    }
    return { ok: violations.length === 0, violations };
  }
}

// ---------------------------------------------------------------------------
// Pin helpers
// ---------------------------------------------------------------------------

/** Pin an archive to a specific version (EXP-6 §4.9.7 archive pinning). */
export function pinArchive(params: {
  requestId: string;
  pinnedVersion: number;
  intent: string;
  catalogVersion: string;
}): {
  requestId: string;
  pinnedVersion: number;
  intent: string;
  catalogVersion: string;
  pinnedAt: string;
} {
  return {
    requestId: params.requestId,
    pinnedVersion: params.pinnedVersion,
    intent: params.intent,
    catalogVersion: params.catalogVersion,
    pinnedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

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
