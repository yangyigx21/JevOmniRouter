/**
 * Tenant Governance — T-7.1 (§8 "安全与治理" design.md).
 *
 * Implements A11Y-3 privacy/data-minimization, tenant isolation,
 * audit trail, and provider response validation.
 *
 * Key invariants:
 *
 * - A11Y-3: Default MUST NOT store raw Prompt full text or raw images;
 *   Prompt summary SHOULD truncate (≤ 500 chars).
 * - Tenant isolation: All Prompt/decision/result data isolated by
 *   tenant + audit trail.
 * - Provider response validation: Length, type, and renderable content checks.
 * - Audit: Every route decision MUST be auditable with full context
 *   (links to EVENT-4 trace).
 *
 * This module is a pure TypeScript module with no HTTP framework
 * dependencies. It exports pure functions and classes only.
 */

// ---------------------------------------------------------------------------
// SHA-256 hashing (synchronous, Node.js crypto)
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants (A11Y-3)
// ---------------------------------------------------------------------------

/** Maximum characters retained in a prompt summary (A11Y-3). */
const PROMPT_SUMMARY_MAX_LENGTH = 500;

/** Maximum characters allowed in a provider response content field. */
const PROVIDER_RESPONSE_MAX_LENGTH = 100_000;

// ---------------------------------------------------------------------------
// Audit action types
// ---------------------------------------------------------------------------

/** Actions that produce audit entries (T-7.1 §8). */
export type AuditAction =
  | 'ROUTE_CREATED'
  | 'DECISION_MADE'
  | 'MODEL_INVOKED'
  | 'REVIEW_SUBMITTED'
  | 'EXPERIENCE_SAVED'
  | 'ROLLBACK'
  | 'THRESHOLD_CHANGED';

// ---------------------------------------------------------------------------
// TenantContext
// ---------------------------------------------------------------------------

/**
 * Tenant context for all tenant-scoped operations (T-7.1).
 *
 * Every data access MUST be scoped by `tenantId` to prevent
 * cross-tenant data leakage.
 */
export interface TenantContext {
  tenantId: string;
  userId: string;
  /** Optional role within the tenant (e.g. 'admin', 'reviewer'). */
  role?: string;
}

// ---------------------------------------------------------------------------
// AuditEntry
// ---------------------------------------------------------------------------

/**
 * Append-only audit entry (T-7.1 §8).
 *
 * Every route decision MUST be auditable with full context.
 * The `promptHash` field stores the SHA-256 hash of the original prompt
 * (NOT the raw prompt text) per A11Y-3 data-minimization.
 *
 * `requestId` links to the EVENT-4 trace chain for cross-correlation.
 */
export interface AuditEntry {
  /** Unique audit entry identifier. */
  auditId: string;
  /** Tenant that owns this entry — MUST match query tenantId. */
  tenantId: string;
  /** Links to EVENT-4 trace chain (requestId). */
  requestId: string;
  /** The action being audited. */
  action: AuditAction;
  /** Who performed the action. */
  actor: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Arbitrary structured context (modelId, tier, etc.). */
  details: Record<string, unknown>;
  /** SHA-256 hash of the original prompt — NEVER the raw prompt (A11Y-3). */
  promptHash: string;
}

// ---------------------------------------------------------------------------
// Audit query filters
// ---------------------------------------------------------------------------

/** Filters for tenant-scoped audit queries. */
export interface AuditQueryFilters {
  /** Filter by action type. */
  action?: AuditAction;
  /** Filter by requestId (EVENT-4 trace correlation). */
  requestId?: string;
  /** Filter by actor. */
  actor?: string;
  /** ISO 8601 lower bound (inclusive). */
  fromTimestamp?: string;
  /** ISO 8601 upper bound (inclusive). */
  toTimestamp?: string;
}

// ---------------------------------------------------------------------------
// Audit errors
// ---------------------------------------------------------------------------

export type TenantGovernanceErrorCode =
  | 'TENANT_MISMATCH'
  | 'MISSING_TENANT_ID'
  | 'INVALID_PROMPT'
  | 'INVALID_PROVIDER_RESPONSE';

export class TenantGovernanceError extends Error {
  constructor(
    readonly code: TenantGovernanceErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'TenantGovernanceError';
  }
}

// ---------------------------------------------------------------------------
// sanitizePrompt (A11Y-3)
// ---------------------------------------------------------------------------

/**
 * Sanitize a prompt for storage per A11Y-3 data-minimization.
 *
 * - Truncates the prompt to ≤ `PROMPT_SUMMARY_MAX_LENGTH` (500) chars.
 * - Returns a SHA-256 hash of the **full** prompt for traceability.
 * - The raw full prompt MUST NOT be stored anywhere.
 *
 * @param prompt - The full prompt text.
 * @returns `{ summary, hash }` — summary is the truncated version;
 *          hash is the hex-encoded SHA-256 digest of the full prompt.
 */
export function sanitizePrompt(prompt: string): { summary: string; hash: string } {
  const hash = createHash('sha256').update(prompt, 'utf8').digest('hex');
  const summary =
    prompt.length <= PROMPT_SUMMARY_MAX_LENGTH
      ? prompt
      : prompt.slice(0, PROMPT_SUMMARY_MAX_LENGTH);
  return { summary, hash };
}

// ---------------------------------------------------------------------------
// sanitizeModelOutput
// ---------------------------------------------------------------------------

/**
 * Validate and sanitize a model/provider response (T-7.1 §8).
 *
 * - Strips non-renderable content (control characters except newline/tab).
 * - Checks length; flags if truncated.
 * - Returns the renderable version and a truncation indicator.
 *
 * @param output - Raw output string from the provider.
 * @returns `{ renderable, truncated }` — renderable is the sanitized version;
 *          truncated is `true` if content was cut.
 */
export function sanitizeModelOutput(output: string): {
  renderable: string;
  truncated: boolean;
} {
  // Strip non-renderable control characters (keep \n \t \r).
  let renderable = output.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  const truncated = renderable.length > PROVIDER_RESPONSE_MAX_LENGTH;
  if (truncated) {
    renderable = renderable.slice(0, PROVIDER_RESPONSE_MAX_LENGTH);
  }

  return { renderable, truncated };
}

// ---------------------------------------------------------------------------
// ProviderValidationResult
// ---------------------------------------------------------------------------

/** Result of validating a provider response (T-7.1 §8). */
export interface ProviderValidationResult {
  /** Whether the response passes all validation checks. */
  valid: boolean;
  /** Human-readable error messages (empty when valid). */
  errors: string[];
}

// ---------------------------------------------------------------------------
// validateProviderResponse
// ---------------------------------------------------------------------------

/**
 * Validate a provider response for length, type, and content safety
 * (T-7.1 §8).
 *
 * Checks:
 * 1. `content` must be a non-null string.
 * 2. `content` length must be ≤ 100 000 chars.
 * 3. Content must not be binary / null-like.
 * 4. If `usage` is present, `promptTokens` and `completionTokens`
 *    must be non-negative integers.
 *
 * @param response - The raw provider response object.
 * @returns Validation result with `valid` flag and any error messages.
 */
export function validateProviderResponse(response: {
  content: string;
  usage?: { promptTokens: number; completionTokens: number };
}): ProviderValidationResult {
  const errors: string[] = [];

  // 1. Content must be a non-null string.
  if (typeof response.content !== 'string') {
    errors.push('content must be a string');
  } else if (response.content === '') {
    errors.push('content must not be empty');
  }

  // 2. Content length check.
  if (
    typeof response.content === 'string' &&
    response.content.length > PROVIDER_RESPONSE_MAX_LENGTH
  ) {
    errors.push(
      `content length ${response.content.length} exceeds maximum ${PROVIDER_RESPONSE_MAX_LENGTH}`,
    );
  }

  // 3. Content must not be binary/null-like.
  if (typeof response.content === 'string') {
    // Check for obvious binary content: high ratio of non-printable bytes.
    const nonPrintableCount = (
      response.content.match(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g) ?? []
    ).length;
    if (response.content.length > 0 && nonPrintableCount / response.content.length > 0.1) {
      errors.push('content appears to contain binary data (>10% non-printable characters)');
    }
  }

  // 4. Usage tokens must be non-negative integers if present.
  if (response.usage !== undefined) {
    if (!Number.isInteger(response.usage.promptTokens) || response.usage.promptTokens < 0) {
      errors.push(
        `usage.promptTokens must be a non-negative integer, got ${response.usage.promptTokens}`,
      );
    }
    if (
      !Number.isInteger(response.usage.completionTokens) ||
      response.usage.completionTokens < 0
    ) {
      errors.push(
        `usage.completionTokens must be a non-negative integer, got ${response.usage.completionTokens}`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// AuditLog (T-7.1, tenant-isolated)
// ---------------------------------------------------------------------------

let auditCounter = 0;

/**
 * Append-only audit log with tenant isolation (T-7.1 §8).
 *
 * Every route decision MUST be auditable with full context.
 * The log enforces tenant isolation — queries are scoped to a single
 * tenant and MUST NOT leak cross-tenant data.
 *
 * Entries link to EVENT-4 trace chains via `requestId`.
 */
export class AuditLog {
  private readonly entries = new Map<string, AuditEntry>();
  private readonly tenantIndex = new Map<string, Set<string>>();

  /**
   * Append an audit entry. Returns the generated `auditId`.
   *
   * The entry MUST include `tenantId`. If missing, throws
   * `TenantGovernanceError` with code `MISSING_TENANT_ID`.
   *
   * @param entry - The audit entry to append (without `auditId` and
   *                `timestamp` — those are generated automatically).
   * @returns The generated `auditId`.
   */
  append(
    entry: Omit<AuditEntry, 'auditId' | 'timestamp'> & { timestamp?: string },
  ): string {
    if (!entry.tenantId) {
      throw new TenantGovernanceError(
        'MISSING_TENANT_ID',
        'Audit entry MUST include a tenantId',
      );
    }

    const auditId = `audit-${++auditCounter}-${Date.now()}`;
    const timestamp = entry.timestamp ?? new Date().toISOString();

    const full: AuditEntry = {
      ...entry,
      auditId,
      timestamp,
    } as AuditEntry;

    this.entries.set(auditId, full);

    let set = this.tenantIndex.get(entry.tenantId);
    if (!set) {
      set = new Set<string>();
      this.tenantIndex.set(entry.tenantId, set);
    }
    set.add(auditId);

    return auditId;
  }

  /**
   * Query audit entries scoped to a single tenant (T-7.1).
   *
   * MUST NOT return entries belonging to other tenants.
   * Supports optional filters for action, requestId, actor, and time range.
   *
   * @param tenantId - The tenant to query.
   * @param filters  - Optional filter criteria.
   * @returns Matching audit entries (newest first).
   */
  query(tenantId: string, filters: AuditQueryFilters = {}): AuditEntry[] {
    const tenantEntryIds = this.tenantIndex.get(tenantId);
    if (!tenantEntryIds) return [];

    const results: AuditEntry[] = [];
    for (const id of tenantEntryIds) {
      const entry = this.entries.get(id);
      if (!entry) continue;

      if (filters.action !== undefined && entry.action !== filters.action) continue;
      if (filters.requestId !== undefined && entry.requestId !== filters.requestId) continue;
      if (filters.actor !== undefined && entry.actor !== filters.actor) continue;
      if (filters.fromTimestamp !== undefined && entry.timestamp < filters.fromTimestamp) continue;
      if (filters.toTimestamp !== undefined && entry.timestamp > filters.toTimestamp) continue;

      results.push(entry);
    }

    // Newest first.
    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return results;
  }

  /**
   * Get a single audit entry by ID, scoped to a tenant (T-7.1).
   *
   * Returns `null` if the entry does not exist OR if the entry exists
   * but belongs to a different tenant — this prevents cross-tenant
   * data leakage through ID guessing.
   *
   * @param auditId  - The audit entry ID.
   * @param tenantId - The tenant making the request.
   * @returns The entry if found and tenant matches, else `null`.
   */
  getEntry(auditId: string, tenantId: string): AuditEntry | null {
    const entry = this.entries.get(auditId);
    if (!entry) return null;
    if (entry.tenantId !== tenantId) return null;
    return entry;
  }

  /** Test helper: count entries for a tenant. */
  countForTenant(tenantId: string): number {
    return this.tenantIndex.get(tenantId)?.size ?? 0;
  }

  /** Test helper: total entry count across all tenants. */
  totalCount(): number {
    return this.entries.size;
  }
}

// ---------------------------------------------------------------------------
// TenantIsolationGuard (T-7.1)
// ---------------------------------------------------------------------------

/**
 * Guard that ensures all data access is tenant-scoped (T-7.1 §8).
 *
 * Use before any cross-tenant data access to prevent leakage.
 */
export class TenantIsolationGuard {
  /**
   * Assert that a resource belongs to the requesting tenant.
   *
   * Throws `TenantGovernanceError` with code `TENANT_MISMATCH` if
   * `tenantId !== resourceTenantId`.
   *
   * @param tenantId         - The tenant making the request.
   * @param resourceTenantId - The tenant that owns the resource.
   * @throws {TenantGovernanceError} if tenant IDs do not match.
   */
  assertTenantScope(tenantId: string, resourceTenantId: string): void {
    if (tenantId !== resourceTenantId) {
      throw new TenantGovernanceError(
        'TENANT_MISMATCH',
        `Tenant isolation violation: requesting tenant "${tenantId}" cannot access resource owned by "${resourceTenantId}"`,
      );
    }
  }

  /**
   * Filter an array of items to only those belonging to the requesting
   * tenant (T-7.1).
   *
   * @param items    - Array of items with a `tenantId` field.
   * @param tenantId - The tenant making the request.
   * @returns Items belonging to the requesting tenant only.
   */
  filterByTenant<T extends { tenantId: string }>(items: T[], tenantId: string): T[] {
    return items.filter((item) => item.tenantId === tenantId);
  }
}
