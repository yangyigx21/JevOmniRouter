/**
 * Human Review Writeback + Calibration Export — EXP-3 / EXP-4 / A11Y-3 (T-4.10).
 *
 * Two responsibilities:
 *
 *  1. **Idempotent review writeback** — operator submits an outcome review
 *     (`confirmed` / `disputed`) for an `ExperienceEntry`. The submission
 *     is idempotent: re-submitting the same `(operator, eid, status, label)`
 *     tuple MUST NOT produce a duplicate record or mutate the entry twice.
 *
 *  2. **Calibration data export** — package the current confirmed/disputed
 *     set into a CSV / JSON-friendly shape for offline analysis. Privacy
 *     mode MUST redact raw prompt text (A11Y-3): only the four fields
 *     `intent` / `modelId` / `confidence` / `outcome` are exported.
 *
 * Threshold approval (EXP-3 §4.9.7): operators approve a threshold change
 * produced by `threshold-suggestion.ts`. This module records the approval
 * but does NOT mutate the production threshold itself — that downstream
 * write is owned by the version manager (`experience-version.ts`).
 */
import type { OutcomeSource, OutcomeStatus } from '@jev-router/shared';
import type { ExperienceEntry } from './outcome-evaluator.js';
import type { ExperienceStore } from './experience-store.js';
import type { ThresholdSuggestion } from './threshold-suggestion.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A human review submission (EXP-1, EXP-3 audit). */
export interface ReviewSubmission {
  /** Target experience entry id. */
  eid: string;
  /** Operator id (auditable; mandatory). */
  operator: string;
  /** Confirmed outcome status (NOT `pending`). */
  status: 'confirmed' | 'disputed';
  /** Outcome source — typically `human` for human-submitted reviews. */
  source: OutcomeSource;
  /** Preferred modelId (or original winner when confirmed). */
  label: string;
  /** Free-text comment (audit-only; never exported). */
  comment?: string;
  /** Submission timestamp (epoch ms). */
  submittedAt: number;
}

/** Result of an idempotent review writeback. */
export interface ReviewWritebackResult {
  /** Whether this submission was applied (false → already exists, no-op). */
  applied: boolean;
  /** Stable idempotency key for this submission. */
  idempotencyKey: string;
  /** Final status of the entry after writeback (or current status if no-op). */
  status: OutcomeStatus;
  /** Audit record id. */
  reviewId: string;
}

/** A persisted review record (audit log). */
export interface ReviewRecord {
  reviewId: string;
  eid: string;
  operator: string;
  status: 'confirmed' | 'disputed';
  source: OutcomeSource;
  label: string;
  comment?: string;
  submittedAt: number;
  /** Idempotency key (deterministic from submission tuple). */
  idempotencyKey: string;
}

/** A threshold approval submission (EXP-3 §4.9.7). */
export interface ThresholdApprovalSubmission {
  /** The suggestion being approved. */
  suggestion: ThresholdSuggestion;
  /** Operator id (auditable). */
  operator: string;
  /** Approval timestamp (epoch ms). */
  approvedAt: number;
}

/** Result of a threshold approval writeback. */
export interface ThresholdApprovalResult {
  /** Whether the approval was newly applied. */
  applied: boolean;
  /** Idempotency key (deterministic). */
  idempotencyKey: string;
  /** Final applied threshold (the suggestion's `suggested` value, if applied). */
  appliedThreshold: number;
}

/**
 * A single row of the calibration export (EXP-2 / EXP-3 offline analysis).
 * Privacy: raw prompt text NEVER appears here (A11Y-3).
 */
export interface CalibrationExportRow {
  intent: string;
  modelId: string;
  confidence: number;
  outcome: 'confirmed' | 'disputed';
}

/** Calibration export bundle. */
export interface CalibrationExport {
  /** Rows — privacy-safe subset of fields. */
  rows: CalibrationExportRow[];
  /** Total rows included. */
  totalRows: number;
  /** Whether privacy redaction was applied (always `true` here). */
  privacyRedacted: true;
  /** Whether some entries were skipped (e.g. pending / invalid). */
  skipped: number;
  /** Export generation timestamp. */
  exportedAt: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type HumanReviewErrorCode =
  | 'ENTRY_NOT_FOUND'
  | 'ENTRY_ALREADY_FILLED'
  | 'OPERATOR_REQUIRED'
  | 'INVALID_STATUS'
  | 'ENTRY_PENDING';

export class HumanReviewError extends Error {
  constructor(
    readonly code: HumanReviewErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'HumanReviewError';
  }
}

// ---------------------------------------------------------------------------
// Human Review Manager
// ---------------------------------------------------------------------------

/**
 * HumanReviewManager — T-4.10.
 *
 * Coordinates human-submitted reviews with the `ExperienceStore` and an
 * audit log of all past reviews (for idempotency deduplication).
 */
export class HumanReviewManager {
  /** Idempotency index: key → ReviewRecord. */
  private readonly reviewIndex = new Map<string, ReviewRecord>();
  /** Approval index: key → suggestion (for threshold approvals). */
  private readonly approvalIndex = new Map<string, ThresholdApprovalSubmission>();
  /** Counter for review ids. */
  private reviewCounter = 0;

  constructor(private readonly store: ExperienceStore) {}

  /**
   * Submit a human review for an experience entry (idempotent).
   *
   * Idempotency contract: the tuple `(operator, eid, status, label)` is
   * hashed into a stable key. Re-submissions with the same key return
   * `applied: false` and the previously-recorded review's status — they
   * do NOT mutate the entry again.
   *
   * Side effect: the linked `ExperienceEntry` is updated in-place via the
   * `ExperienceStore` (asynchronously). The store will validate the entry
   * and surface integrity violations through the write promise.
   *
   * @throws HumanReviewError if `operator` missing, `eid` not found, or
   *         the entry is `pending` (use `expireEntry` for that case).
   */
  async submitReview(submission: ReviewSubmission): Promise<ReviewWritebackResult> {
    if (!submission.operator || submission.operator.trim() === '') {
      throw new HumanReviewError('OPERATOR_REQUIRED', 'operator MUST be non-empty (EXP-3 audit)');
    }
    if (submission.status !== 'confirmed' && submission.status !== 'disputed') {
      throw new HumanReviewError(
        'INVALID_STATUS',
        `status MUST be 'confirmed' or 'disputed' (got "${submission.status}")`,
      );
    }

    const key = idempotencyKey(submission);
    const existing = this.reviewIndex.get(key);
    if (existing) {
      // Idempotent no-op — return the recorded result.
      const entry = this.store.getEntry(existing.eid);
      return {
        applied: false,
        idempotencyKey: key,
        status: entry?.outcome.status ?? existing.status,
        reviewId: existing.reviewId,
      };
    }

    const entry = this.store.getEntry(submission.eid);
    if (!entry) {
      throw new HumanReviewError('ENTRY_NOT_FOUND', `Experience entry "${submission.eid}" not found`);
    }
    if (entry.outcome.status === 'pending') {
      throw new HumanReviewError(
        'ENTRY_PENDING',
        `Entry "${submission.eid}" is pending; cannot review until outcome is filled`,
      );
    }
    if (entry.outcome.status === 'expired') {
      throw new HumanReviewError(
        'INVALID_STATUS',
        `Entry "${submission.eid}" is expired; cannot be reviewed`,
      );
    }

    // Persist the review record.
    const reviewId = `review-${++this.reviewCounter}`;
    const record: ReviewRecord = {
      reviewId,
      eid: submission.eid,
      operator: submission.operator,
      status: submission.status,
      source: submission.source,
      label: submission.label,
      comment: submission.comment,
      submittedAt: submission.submittedAt,
      idempotencyKey: key,
    };
    this.reviewIndex.set(key, record);

    // Mutate the entry in the store. We round-trip via `writeEntry` to keep
    // the write queue + indexes consistent (EXP-4 audit chain).
    const updated: ExperienceEntry = {
      ...entry,
      outcome: {
        ...entry.outcome,
        status: submission.status,
        source: submission.source,
        label: submission.label,
        observedAt: submission.submittedAt,
      },
      updatedAt: new Date(submission.submittedAt).toISOString(),
    };
    await this.store.writeEntry(updated);

    return {
      applied: true,
      idempotencyKey: key,
      status: updated.outcome.status,
      reviewId,
    };
  }

  /**
   * Approve a threshold suggestion (EXP-3 §4.9.7). Idempotent on
   * `(operator, suggestion.kind, suggestion.suggested)`.
   *
   * NOTE: this method records the approval only — it does NOT mutate the
   * production threshold. Production writes go through the version
   * manager, which records the approval as a new `threshold-approval`
   * version event.
   */
  approveThreshold(submission: ThresholdApprovalSubmission): ThresholdApprovalResult {
    if (!submission.operator || submission.operator.trim() === '') {
      throw new HumanReviewError('OPERATOR_REQUIRED', 'operator MUST be non-empty (EXP-3 §4.9.7)');
    }
    const key = thresholdApprovalKey(submission);
    const existing = this.approvalIndex.get(key);
    if (existing) {
      return {
        applied: false,
        idempotencyKey: key,
        appliedThreshold: existing.suggestion.suggested,
      };
    }
    this.approvalIndex.set(key, submission);
    return {
      applied: true,
      idempotencyKey: key,
      appliedThreshold: submission.suggestion.suggested,
    };
  }

  /** Export calibration data (EXP-2 / EXP-3) — privacy-safe subset. */
  exportCalibrationData(): CalibrationExport {
    const rows: CalibrationExportRow[] = [];
    let skipped = 0;
    for (const entry of this.store.confirmedAndDisputed()) {
      if (
        !entry.outcome.source ||
        typeof entry.outcome.observedAt !== 'number' ||
        !Number.isFinite(entry.prediction.confidence)
      ) {
        skipped += 1;
        continue;
      }
      rows.push({
        intent: entry.prediction.intent,
        modelId: entry.modelId,
        confidence: entry.prediction.confidence,
        outcome: entry.outcome.status === 'confirmed' ? 'confirmed' : 'disputed',
      });
    }
    return {
      rows,
      totalRows: rows.length,
      privacyRedacted: true,
      skipped,
      exportedAt: new Date().toISOString(),
    };
  }

  /** Audit log of all reviews (for traceability). */
  listReviews(): ReviewRecord[] {
    return Array.from(this.reviewIndex.values());
  }

  /** Audit log of all threshold approvals. */
  listThresholdApprovals(): ThresholdApprovalSubmission[] {
    return Array.from(this.approvalIndex.values());
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Build a stable idempotency key from a review submission.
 * Same `(operator, eid, status, label)` → same key — re-submission is a no-op.
 */
export function idempotencyKey(s: ReviewSubmission): string {
  return `rev::${s.operator}::${s.eid}::${s.status}::${s.label}`;
}

/** Build a stable idempotency key for threshold approvals. */
export function thresholdApprovalKey(s: ThresholdApprovalSubmission): string {
  return `appr::${s.operator}::${s.suggestion.kind}::${s.suggestion.suggested}`;
}

/**
 * Redact PII from a free-text comment for export (A11Y-3).
 * Naive: replaces email-like / token-like substrings; production should
 * plug in a real redactor.
 */
export function redactComment(comment: string): string {
  return comment
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[token]')
    .replace(/\b\d{4,}\b/g, '[id]');
}
