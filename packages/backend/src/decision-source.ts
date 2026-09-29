/**
 * Decision Source Marking — JEV-7 (§4.10).
 *
 * Every decision MUST carry a `decisionSource` tag, auditable and
 * non-falsifiable:
 *
 * | Tag             | When used                                          |
 * |-----------------|----------------------------------------------------|
 * | `TYPE_SAFE_JEV` | Production path — real System One API call         |
 * | `RULE_FALLBACK` | Jev timeout / invalid schema → fallback rule       |
 * | `LOCAL_REIMPL`  | Offline form — LocalJevReimpl (JEV-8)             |
 * | `USER_OVERRIDE` | Human override                                     |
 *
 * The tag MUST be written to the audit log alongside:
 *  - `jev.provider` (`system-one` only when real; absent otherwise)
 *  - `decisionId`
 *  - call latency
 *  - schema validation result
 *
 * Local reimplementation MUST NOT be presented as the official mechanism —
 * `decisionSource=LOCAL_REIMPL` MUST NOT coexist with `jev.provider=system-one`.
 */
import type { DecisionReceipt } from './decision-receipt.js';

/** The four legitimate decision sources (JEV-7). */
export type DecisionSource =
  | 'TYPE_SAFE_JEV'
  | 'RULE_FALLBACK'
  | 'LOCAL_REIMPL'
  | 'USER_OVERRIDE';

/** Provider tag (only `system-one` when real TypeSafe Jev was called). */
export type JevProvider = 'system-one' | undefined;

/** Audit entry for a decision (JEV-7 + JEV-1 scenario "真实请求留痕"). */
export interface DecisionAuditEntry {
  decisionId: string;
  requestId: string;
  decisionSource: DecisionSource;
  /** `system-one` only when `decisionSource === 'TYPE_SAFE_JEV'`; else absent. */
  jevProvider?: JevProvider;
  /** Call latency in ms (only for TYPE_SAFE_JEV). */
  jevCallLatencyMs?: number;
  /** Schema validation result (only for TYPE_SAFE_JEV). */
  schemaValidationResult?: 'PASS' | 'INVALID_DECISION';
  /** ISO 8601 timestamp. */
  auditedAt: string;
  /** Whether decision was degraded (CONSTRAIN-4). */
  degraded: boolean;
}

/**
 * Build an audit entry from a decision receipt (JEV-7).
 *
 * Enforces the non-falsifiable invariant: `jevProvider=system-one` is
 * ONLY set when `decisionSource === 'TYPE_SAFE_JEV'`. Any other source
 * (RULE_FALLBACK / LOCAL_REIMPL / USER_OVERRIDE) MUST NOT carry the tag.
 */
export function buildAuditEntry(
  receipt: Pick<
    DecisionReceipt,
    'decisionId' | 'requestId' | 'decisionSource' | 'degraded'
  >,
  extras?: {
    jevCallLatencyMs?: number;
    schemaValidationResult?: 'PASS' | 'INVALID_DECISION';
  },
): DecisionAuditEntry {
  const entry: DecisionAuditEntry = {
    decisionId: receipt.decisionId,
    requestId: receipt.requestId,
    decisionSource: receipt.decisionSource,
    auditedAt: new Date().toISOString(),
    degraded: receipt.degraded,
  };
  // Non-falsifiable: only TYPE_SAFE_JEV carries jev.provider=system-one.
  if (receipt.decisionSource === 'TYPE_SAFE_JEV') {
    entry.jevProvider = 'system-one';
    entry.jevCallLatencyMs = extras?.jevCallLatencyMs;
    entry.schemaValidationResult = extras?.schemaValidationResult ?? 'PASS';
  }
  // LOCAL_REIMPL MUST NOT present as official (JEV-1 scenario "本地重实现不得冒充").
  // No jevProvider tag is written — audit consumers check its presence.
  return entry;
}

/**
 * Audit log sink — minimal interface for in-memory / DB / file-based logs.
 * Concrete adapters (T-3.3 service-side wiring) implement this.
 */
export interface AuditLogSink {
  /** Append an audit entry; returns the entry's storage id. */
  append(entry: DecisionAuditEntry): Promise<string> | string;
  /** Query entries by requestId (for trace correlation, EVENT-4). */
  queryByRequestId(requestId: string): Promise<DecisionAuditEntry[]> | DecisionAuditEntry[];
}

/** In-memory audit log (default; production replaces with DB adapter). */
export class InMemoryAuditLog implements AuditLogSink {
  private readonly entries: DecisionAuditEntry[] = [];
  append(entry: DecisionAuditEntry): string {
    this.entries.push(entry);
    return `audit-${this.entries.length - 1}`;
  }
  queryByRequestId(requestId: string): DecisionAuditEntry[] {
    return this.entries.filter((e) => e.requestId === requestId);
  }
  /** Test helper: count entries. */
  count(): number {
    return this.entries.length;
  }
}

/**
 * Validate that a decision source is one of the four legitimate values.
 * @throws if invalid.
 */
export function assertValidDecisionSource(
  source: string,
): asserts source is DecisionSource {
  const valid: DecisionSource[] = [
    'TYPE_SAFE_JEV',
    'RULE_FALLBACK',
    'LOCAL_REIMPL',
    'USER_OVERRIDE',
  ];
  if (!valid.includes(source as DecisionSource)) {
    throw new InvalidDecisionSourceError(
      `Invalid decisionSource "${source}"; MUST be one of ${valid.join('/')}`,
    );
  }
}

/** Error thrown when decision source is invalid. */
export class InvalidDecisionSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDecisionSourceError';
  }
}

/**
 * Check that LOCAL_REIMPL is not falsely presented as system-one.
 * Returns `true` iff the audit entry is consistent (JEV-1 scenario 2).
 */
export function isAuditEntryConsistent(entry: DecisionAuditEntry): boolean {
  if (entry.decisionSource === 'LOCAL_REIMPL' && entry.jevProvider === 'system-one') {
    return false;
  }
  if (entry.decisionSource === 'RULE_FALLBACK' && entry.jevProvider === 'system-one') {
    return false;
  }
  if (entry.decisionSource === 'USER_OVERRIDE' && entry.jevProvider === 'system-one') {
    return false;
  }
  return true;
}
