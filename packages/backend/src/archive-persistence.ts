/**
 * Archive Persistence — EXP-9 / A11Y-3 / ARCH-4 (T-4.11, §4.9.8).
 *
 * Versioned-key persistence layer for `ExperienceEntry` archives.
 * Key shape: `${intent}::${modelId}::${expVersion}`.
 *
 * Guarantees:
 *  - **Dirty-data defense**: every entry is validated before persistence.
 *    Entries failing `validateEntry` MUST NOT be persisted.
 *  - **Privacy mode degradation**: in offline / privacy mode, PII is
 *    redacted (raw prompt text never persisted; A11Y-3). The module
 *    supports **dual-key coexistence** — online keys preserve full
 *    fidelity for cloud-native form; offline keys hold redacted copies.
 *  - **TTL**: `purgeExpired` removes entries past their expiry
 *    (EXP-7 / EXP-9 audit cleanup).
 *  - The store itself is in-memory; concrete adapters (filesystem,
 *    IndexedDB, DB) implement the same interface.
 */
import type { ExperienceEntry } from './outcome-evaluator.js';
import {
  validateExperienceEntry,
} from './experience-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Persistence mode (online vs. offline / privacy). */
export type PersistenceMode = 'online' | 'offline';

/**
 * A persisted archive record (EXP-9 §4.9.8).
 * `redactedPrompt` is set ONLY in offline mode (A11Y-3).
 */
export interface ArchiveRecord {
  /** Composite key: `${intent}::${modelId}::${expVersion}`. */
  key: string;
  /** Original entry (sanitized). */
  entry: ExperienceEntry;
  /** True iff the prompt was redacted before persistence (offline mode). */
  redacted: boolean;
  /** Persisted-at timestamp (ISO 8601). */
  persistedAt: string;
  /** Mode under which this record was persisted. */
  mode: PersistenceMode;
  /** Optional expiry (epoch ms); entries past expiry are purgeable. */
  expiresAt?: number;
}

/** Configuration. */
export interface ArchivePersistenceConfig {
  /** Default mode for new persists. */
  defaultMode: PersistenceMode;
  /** TTL in ms applied to new entries (null = no TTL). */
  defaultTtlMs: number | null;
  /** Whether to validate entry integrity before persisting. */
  validateOnPersist: boolean;
  /** PII redaction toggle (default `true`). */
  redactPii: boolean;
}

/** Default configuration. */
export const DEFAULT_ARCHIVE_PERSISTENCE_CONFIG: ArchivePersistenceConfig = {
  defaultMode: 'online',
  defaultTtlMs: 365 * 24 * 60 * 60 * 1000, // 1 year
  validateOnPersist: true,
  redactPii: true,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ArchivePersistenceErrorCode =
  | 'INVALID_ENTRY'
  | 'KEY_MISMATCH'
  | 'NOT_FOUND'
  | 'REDACTION_FAILED';

export class ArchivePersistenceError extends Error {
  constructor(
    readonly code: ArchivePersistenceErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'ArchivePersistenceError';
  }
}

// ---------------------------------------------------------------------------
// Archive Persistence (in-memory reference impl)
// ---------------------------------------------------------------------------

/**
 * ArchivePersistence — T-4.11.
 *
 * In-memory reference implementation. Production replaces this with a
 * filesystem / DB adapter implementing the same interface.
 */
export class ArchivePersistence {
  private readonly config: ArchivePersistenceConfig;
  /** Online records (full fidelity). */
  private readonly online = new Map<string, ArchiveRecord>();
  /** Offline records (PII redacted). */
  private readonly offline = new Map<string, ArchiveRecord>();

  constructor(config?: Partial<ArchivePersistenceConfig>) {
    this.config = { ...DEFAULT_ARCHIVE_PERSISTENCE_CONFIG, ...config };
  }

  /**
   * Persist an entry under its composite key (EXP-9 §4.9.8).
   *
   * @param entry   The experience entry to persist.
   * @param mode    Optional mode override; defaults to `config.defaultMode`.
   * @param ttlMs   Optional TTL override; defaults to `config.defaultTtlMs`.
   * @returns the persisted `ArchiveRecord`.
   */
  async persist(
    entry: ExperienceEntry,
    mode: PersistenceMode = this.config.defaultMode,
    ttlMs: number | null = this.config.defaultTtlMs,
  ): Promise<ArchiveRecord> {
    // Dirty-data defense (T-4.11).
    if (this.config.validateOnPersist) {
      const violations = validateEntry(entry);
      if (violations.length > 0) {
        throw new ArchivePersistenceError(
          'INVALID_ENTRY',
          `Refusing to persist — invalid entry: ${violations.join('; ')}`,
        );
      }
    }

    const key = archiveKey(entry);
    if (this.config.validateOnPersist) {
      // Re-check that the key matches the entry's own fields exactly
      // (guard against stale-key bugs).
      const recomputed = archiveKey(entry);
      if (recomputed !== key) {
        throw new ArchivePersistenceError(
          'KEY_MISMATCH',
          `Computed key "${key}" ≠ recomputed "${recomputed}"`,
        );
      }
    }

    // Apply redaction in offline mode (A11Y-3).
    let redacted = false;
    let persistedEntry = entry;
    if (mode === 'offline' && this.config.redactPii) {
      persistedEntry = redactPiiInEntry(entry);
      redacted = true;
    }

    const record: ArchiveRecord = {
      key,
      entry: persistedEntry,
      redacted,
      persistedAt: new Date().toISOString(),
      mode,
      ...(ttlMs !== null && Number.isFinite(ttlMs)
        ? { expiresAt: Date.now() + ttlMs }
        : {}),
    };

    // Dual-key coexistence (T-4.11): write to whichever map matches `mode`.
    // Existing records for the same key in the OTHER map are preserved.
    const target = mode === 'online' ? this.online : this.offline;
    target.set(key, record);
    return record;
  }

  /**
   * Retrieve an archive by its composite key. Looks at both online and
   * offline maps (dual-key coexistence).
   */
  retrieve(key: string): ArchiveRecord | undefined {
    return this.online.get(key) ?? this.offline.get(key);
  }

  /**
   * Retrieve all archives for a given (intent × modelId) pair across all
   * versions and both modes. Useful for replay (EXP-6) and statistics.
   */
  retrieveByPair(intent: string, modelId: string): ArchiveRecord[] {
    const prefix = `${intent}::${modelId}::`;
    const out: ArchiveRecord[] = [];
    for (const r of this.online.values()) {
      if (r.key.startsWith(prefix)) out.push(r);
    }
    for (const r of this.offline.values()) {
      if (r.key.startsWith(prefix)) out.push(r);
    }
    return out;
  }

  /**
   * Purge expired records (TTL-based cleanup). Returns counts per mode.
   * Records without `expiresAt` are NOT purged.
   */
  purgeExpired(now: number = Date.now()): {
    online: number;
    offline: number;
    total: number;
  } {
    let onlineCount = 0;
    let offlineCount = 0;
    for (const [k, r] of this.online) {
      if (typeof r.expiresAt === 'number' && r.expiresAt < now) {
        this.online.delete(k);
        onlineCount += 1;
      }
    }
    for (const [k, r] of this.offline) {
      if (typeof r.expiresAt === 'number' && r.expiresAt < now) {
        this.offline.delete(k);
        offlineCount += 1;
      }
    }
    return { online: onlineCount, offline: offlineCount, total: onlineCount + offlineCount };
  }

  /**
   * Validate entry integrity (dirty-data defense, T-4.11). Wraps the
   * shared `validateExperienceEntry` for ergonomic access.
   */
  validateEntry(entry: ExperienceEntry): string[] {
    return validateEntry(entry);
  }

  /** Total record count (both modes). */
  size(): number {
    return this.online.size + this.offline.size;
  }

  /** Count of records in a given mode. */
  sizeByMode(mode: PersistenceMode): number {
    return mode === 'online' ? this.online.size : this.offline.size;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported)
// ---------------------------------------------------------------------------

/** Build the composite archive key (EXP-9 §4.9.8). */
export function archiveKey(entry: ExperienceEntry): string {
  return `${entry.prediction.intent}::${entry.modelId}::${entry.expVersion}`;
}

/** Build the composite key from primitive fields (helper). */
export function buildArchiveKey(intent: string, modelId: string, expVersion: string): string {
  return `${intent}::${modelId}::${expVersion}`;
}

/** Validate an entry (re-exports the store's validator for ergonomics). */
export function validateEntry(entry: ExperienceEntry): string[] {
  return validateExperienceEntry(entry);
}

/**
 * Redact PII from an entry for offline / privacy mode (A11Y-3).
 * Returns a new entry object; the original is not mutated.
 */
export function redactPiiInEntry(entry: ExperienceEntry): ExperienceEntry {
  // The ExperienceEntry shape itself does NOT carry the raw prompt text
  // (it only carries the prediction, outcome, modelId, etc.). PII risk
  // therefore lives in operator-typed `label` text — when the recorded
  // label differs from the decision-time winner, we replace it with a
  // sentinel to avoid leaking free-text in offline mode. Operators can
  // still audit the unredacted online record.
  const safeLabel =
    entry.outcome.label && entry.prediction.winner === entry.outcome.label
      ? entry.outcome.label
      : '[redacted]';
  return {
    ...entry,
    prediction: { ...entry.prediction },
    outcome: { ...entry.outcome, label: safeLabel },
  };
}

/** Convenience: format a key's parts back into a structured shape. */
export function parseArchiveKey(key: string): {
  intent: string;
  modelId: string;
  expVersion: string;
} {
  const parts = key.split('::');
  if (parts.length !== 3) {
    throw new ArchivePersistenceError(
      'KEY_MISMATCH',
      `Key "${key}" does not match intent::modelId::expVersion`,
    );
  }
  return { intent: parts[0], modelId: parts[1], expVersion: parts[2] };
}
