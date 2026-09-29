/**
 * Experience Store — EXP-1 / EXP-4 (T-4.2, §5.3, §4.9).
 *
 * Async write (non-blocking), retrieval interface for `ExperienceEntry`
 * records produced by `OutcomeEvaluator` (EXP-1).
 *
 * Key guarantees:
 *  - **Async write queue** with fire-and-forget semantics: callers MUST NOT
 *    block on write completion; writes are coalesced and applied in order.
 *  - **Indexes**: by `intent`, by `modelId`, by `outcome.status`, by
 *    `requestId` (rid) — enabling EXP-2 statistics, EXP-3 threshold scan,
 *    EXP-9 segment split, EXP-10 before/after comparison.
 *  - **Read-your-writes** is NOT guaranteed (async); callers that need a
 *    just-written entry MUST use `getEntry` after awaiting the write
 *    completion token, OR call `flushWriteQueue`.
 *  - Pending entries MUST NOT participate in statistics (EXP-1 / EXP-2).
 *
 *  This module is the **upstream sink** of the closed-loop experience loop;
 *  it does not perform statistics or correction itself (those live in
 *  `@jev-router/shared` and in `experience-reflow.ts`).
 */
import type { OutcomeStatus } from '@jev-router/shared';
import type { ExperienceEntry } from './outcome-evaluator.js';

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/** Composite key for the (intent × modelId) index used by EXP-2 / EXP-5. */
export interface IntentModelKey {
  intent: string;
  modelId: string;
}

/** A pending write in the async queue. */
interface PendingWrite {
  /** The entry to upsert. */
  entry: ExperienceEntry;
  /** Resolve callback invoked once the write hits the store. */
  resolve: () => void;
  /** Reject callback invoked if the write fails validation. */
  reject: (err: Error) => void;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ExperienceStoreErrorCode =
  | 'ENTRY_NOT_FOUND'
  | 'WRITE_FAILED'
  | 'INVALID_ENTRY';

export class ExperienceStoreError extends Error {
  constructor(
    readonly code: ExperienceStoreErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'ExperienceStoreError';
  }
}

// ---------------------------------------------------------------------------
// Experience Store
// ---------------------------------------------------------------------------

/** Configuration for the Experience Store. */
export interface ExperienceStoreConfig {
  /** Maximum write batch size processed per flush cycle. */
  writeBatchSize: number;
  /** Whether to validate entry integrity before persisting. */
  validateOnWrite: boolean;
}

/** Default configuration. */
export const DEFAULT_EXPERIENCE_STORE_CONFIG: ExperienceStoreConfig = {
  writeBatchSize: 32,
  validateOnWrite: true,
};

/**
 * ExperienceStore — T-4.2.
 *
 * Stores `ExperienceEntry` records with async write queue and indexed
 * retrieval. Read paths are synchronous (in-memory); write paths return a
 * `Promise` that resolves once the queue has flushed the entry.
 */
export class ExperienceStore {
  private readonly config: ExperienceStoreConfig;
  private readonly entries = new Map<string, ExperienceEntry>();
  private readonly byIntent = new Map<string, Set<string>>();
  private readonly byModelId = new Map<string, Set<string>>();
  private readonly byStatus = new Map<OutcomeStatus, Set<string>>();
  private readonly byRid = new Map<string, Set<string>>();
  private readonly writeQueue: PendingWrite[] = [];
  private flushing = false;

  constructor(config?: Partial<ExperienceStoreConfig>) {
    this.config = { ...DEFAULT_EXPERIENCE_STORE_CONFIG, ...config };
    // Initialize status index buckets so query-by-status is O(1).
    const statuses: OutcomeStatus[] = ['pending', 'confirmed', 'disputed', 'expired'];
    for (const s of statuses) {
      this.byStatus.set(s, new Set());
    }
  }

  // -------------------------------------------------------------------------
  // Async write (fire-and-forget with explicit await option)
  // -------------------------------------------------------------------------

  /**
   * Queue an entry for asynchronous persistence (EXP-1, EXP-4).
   *
   * Returns a Promise that resolves when the entry has actually been written
   * to the store. Callers MAY ignore the promise for fire-and-forget
   * semantics; callers needing read-your-writes consistency MUST `await` it.
   *
   * @throws synchronously if `entry.eid` is missing.
   */
  writeEntry(entry: ExperienceEntry): Promise<void> {
    if (!entry || !entry.eid) {
      return Promise.reject(
        new ExperienceStoreError('INVALID_ENTRY', 'entry.eid MUST be non-empty'),
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.writeQueue.push({ entry, resolve, reject });
      // Kick off a flush cycle (non-blocking).
      void this.flushWriteQueue();
    });
  }

  /**
   * Process the pending write queue. Recursion-guarded so multiple
   * concurrent `writeEntry` calls coalesce into a single flush loop.
   */
  private async flushWriteQueue(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.writeQueue.length > 0) {
        const batch = this.writeQueue.splice(0, this.config.writeBatchSize);
        for (const pw of batch) {
          try {
            if (this.config.validateOnWrite) {
              const violations = validateExperienceEntry(pw.entry);
              if (violations.length > 0) {
                throw new ExperienceStoreError(
                  'INVALID_ENTRY',
                  `Entry "${pw.entry.eid}" invalid: ${violations.join('; ')}`,
                );
              }
            }
            this.applyWrite(pw.entry);
            pw.resolve();
          } catch (err) {
            pw.reject(
              err instanceof Error
                ? err
                : new ExperienceStoreError('WRITE_FAILED', String(err)),
            );
          }
        }
        // Yield to the microtask loop between batches so the queue cannot
        // starve the event loop (ARCH-3 isolation).
        if (this.writeQueue.length > 0) {
          await Promise.resolve();
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Apply a validated entry to the store and update all indexes.
   * Idempotent: re-writing the same `eid` overwrites in place.
   */
  private applyWrite(entry: ExperienceEntry): void {
    const existing = this.entries.get(entry.eid);
    if (existing) {
      // Remove stale index pointers before re-inserting.
      this.removeFromIndex(this.byIntent, existing.prediction.intent, entry.eid);
      this.removeFromIndex(this.byModelId, existing.modelId, entry.eid);
      this.byStatus.get(existing.outcome.status)?.delete(entry.eid);
      this.removeFromIndex(this.byRid, existing.rid, entry.eid);
    }
    this.entries.set(entry.eid, entry);
    this.addToIndex(this.byIntent, entry.prediction.intent, entry.eid);
    this.addToIndex(this.byModelId, entry.modelId, entry.eid);
    this.byStatus.get(entry.outcome.status)?.add(entry.eid);
    this.addToIndex(this.byRid, entry.rid, entry.eid);
  }

  private addToIndex(idx: Map<string, Set<string>>, key: string, eid: string): void {
    let set = idx.get(key);
    if (!set) {
      set = new Set();
      idx.set(key, set);
    }
    set.add(eid);
  }

  private removeFromIndex(idx: Map<string, Set<string>>, key: string, eid: string): void {
    const set = idx.get(key);
    if (!set) return;
    set.delete(eid);
    if (set.size === 0) idx.delete(key);
  }

  /** Wait for the write queue to drain. Useful in tests / shutdown. */
  async drainWriteQueue(): Promise<void> {
    while (this.writeQueue.length > 0) {
      await Promise.resolve();
      // If a flush is in progress, the loop above will eventually drain.
      if (this.flushing) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Retrieval (synchronous, in-memory)
  // -------------------------------------------------------------------------

  /** Get a single entry by its `eid`. Returns `undefined` if absent. */
  getEntry(eid: string): ExperienceEntry | undefined {
    return this.entries.get(eid);
  }

  /** Get all entries for a given request id (`rid`). */
  queryByRequestId(rid: string): ExperienceEntry[] {
    const eids = this.byRid.get(rid) ?? new Set<string>();
    return Array.from(eids, (eid) => this.entries.get(eid)).filter(
      (e): e is ExperienceEntry => e !== undefined,
    );
  }

  /** Query entries by intent (matches `prediction.intent`). */
  queryByIntent(intent: string): ExperienceEntry[] {
    return this.queryIndex(this.byIntent, intent);
  }

  /** Query entries by modelId. */
  queryByModel(modelId: string): ExperienceEntry[] {
    return this.queryIndex(this.byModelId, modelId);
  }

  /** Query entries by outcome status (EXP-2 filter). */
  queryByStatus(status: OutcomeStatus): ExperienceEntry[] {
    return this.queryIndex(this.byStatus, status);
  }

  /** Query entries by (intent × modelId) pair — used by EXP-5 prior delta. */
  queryByIntentModel(key: IntentModelKey): ExperienceEntry[] {
    const byIntent = this.queryIndex(this.byIntent, key.intent);
    return byIntent.filter((e) => e.modelId === key.modelId);
  }

  private queryIndex(
    idx: Map<string, Set<string>>,
    key: string,
  ): ExperienceEntry[] {
    const eids = idx.get(key);
    if (!eids) return [];
    const out: ExperienceEntry[] = [];
    for (const eid of eids) {
      const e = this.entries.get(eid);
      if (e) out.push(e);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Misc
  // -------------------------------------------------------------------------

  /** Total entry count (all statuses). */
  size(): number {
    return this.entries.size;
  }

  /** Count of confirmed entries (used by EXP-8 cold-start guard). */
  confirmedCount(): number {
    return this.byStatus.get('confirmed')?.size ?? 0;
  }

  /** Count of disputed entries. */
  disputedCount(): number {
    return this.byStatus.get('disputed')?.size ?? 0;
  }

  /** Count of pending entries (excluded from statistics). */
  pendingCount(): number {
    return this.byStatus.get('pending')?.size ?? 0;
  }

  /** Count of expired entries (excluded from statistics). */
  expiredCount(): number {
    return this.byStatus.get('expired')?.size ?? 0;
  }

  /**
   * Snapshot of confirmed + disputed entries eligible for statistics
   * (EXP-2). Pending / expired are excluded by definition.
   */
  confirmedAndDisputed(): ExperienceEntry[] {
    const out: ExperienceEntry[] = [];
    out.push(...this.queryByStatus('confirmed'));
    out.push(...this.queryByStatus('disputed'));
    return out;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate an `ExperienceEntry` for persistence (EXP-1, EXP-4).
 * @returns list of violation strings; empty when valid.
 */
export function validateExperienceEntry(entry: ExperienceEntry): string[] {
  const violations: string[] = [];
  if (!entry.eid || entry.eid.trim() === '') {
    violations.push('eid MUST be non-empty');
  }
  if (!entry.rid || entry.rid.trim() === '') {
    violations.push('rid MUST be non-empty');
  }
  if (!entry.expVersion) {
    violations.push('expVersion MUST be set (EXP-4: must record applied version)');
  }
  if (!entry.prediction.intent || entry.prediction.intent.trim() === '') {
    violations.push('prediction.intent MUST be non-empty');
  }
  if (!entry.prediction.winner || entry.prediction.winner.trim() === '') {
    violations.push('prediction.winner MUST be non-empty');
  }
  if (!Number.isFinite(entry.prediction.confidence)) {
    violations.push('prediction.confidence MUST be finite');
  }
  if (!Array.isArray(entry.prediction.priorSnapshot)) {
    violations.push('prediction.priorSnapshot MUST be an array (catalog-order)');
  }
  if (!entry.modelId || entry.modelId.trim() === '') {
    violations.push('modelId MUST be non-empty');
  }
  if (!entry.catalogVersion) {
    violations.push('catalogVersion MUST be set (MODEL-4)');
  }
  if (!entry.createdAt) {
    violations.push('createdAt MUST be set');
  }
  const validStatuses: OutcomeStatus[] = ['pending', 'confirmed', 'disputed', 'expired'];
  if (!validStatuses.includes(entry.outcome.status)) {
    violations.push(`outcome.status "${entry.outcome.status}" is not a valid status`);
  }
  // If non-pending, source / observedAt MUST be set (EXP-1 lifecycle).
  if (entry.outcome.status !== 'pending') {
    if (!entry.outcome.source) {
      violations.push(`outcome.source MUST be set when status="${entry.outcome.status}"`);
    }
    if (typeof entry.outcome.observedAt !== 'number' || !Number.isFinite(entry.outcome.observedAt)) {
      violations.push(`outcome.observedAt MUST be a finite number when status="${entry.outcome.status}"`);
    }
  }
  return violations;
}
