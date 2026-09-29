/**
 * Route Creation API (thin handler layer) — API-1 ~ API-4 (§9 design.md).
 *
 * This module is the **contract layer**, not an HTTP server. It exposes
 * pure handler functions that the HTTP adapter (Express / Hono / Node http)
 * wraps; the handlers do NOT touch sockets directly. This makes them
 * trivially testable without spinning up a server.
 *
 * State machine (API-1):
 *
 *   CREATED → DECIDING → EXECUTING → COMPLETED
 *                                  ↘ FAILED
 *
 * `POST /v1/routes` SHALL only create a route; decision and execution are
 * pushed forward asynchronously by the service-side state machine. Events
 * are pushed through the EventBus → SSE stream (EVENT-3 / API-2).
 *
 * Contract handlers exposed here:
 *   POST  /v1/routes              → createRoute        (API-1)
 *   GET   /v1/routes/:id          → getRouteStatus     (API-1)
 *   GET   /v1/routes/:id/events   → getRouteEvents     (API-2 / EVENT-3)
 *   GET   /v1/catalog             → getCatalog         (API-3)
 *   GET   /v1/health              → healthCheck        (B4 frontend poll)
 *   GET   /v1/experience/stats    → getExperienceStats (EXP-2 calibration)
 */
import type { EventBus, RouteEvent } from './route-event.js';
import type { VersionedCatalog, CatalogEntry } from './model-catalog.js';
import { MVP_SEED_CATALOG, assertSameCatalogVersion } from './model-catalog.js';
import type { TraceAggregator } from './trace-aggregator.js';
import type { SelectionMode } from './selection-mode.js';
import { tagSelectionMode } from './selection-mode.js';
import type { DecisionReceipt } from './decision-receipt.js';
import type { DecisionContract } from './decision-contract.js';

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/** Route lifecycle states (API-1). */
export type RouteStatus =
  | 'CREATED'
  | 'DECIDING'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'FAILED';

/** Allowed transitions (CREATED → DECIDING → EXECUTING → COMPLETED/FAILED). */
const ALLOWED_TRANSITIONS: Record<RouteStatus, RouteStatus[]> = {
  CREATED: ['DECIDING', 'FAILED'],
  DECIDING: ['EXECUTING', 'FAILED'],
  EXECUTING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
};

// ---------------------------------------------------------------------------
// Route record
// ---------------------------------------------------------------------------

/** Route creation request body (POST /v1/routes). */
export interface CreateRouteRequest {
  prompt: string;
  modalities?: string[];
  /** Optional explicit constraint overrides. */
  constraints?: {
    maxLatencyMs?: number;
    budgetUsd?: number;
    allowedModelIds?: string[];
    riskLevel?: string;
  };
  /** Optional consequence class (JEV-15). */
  consequenceClass?: string;
  /** Tenant / user / role context. */
  context?: {
    tenant: string;
    user: string;
    role?: string;
  };
  /** Optional client-requested catalog version (MODEL-4). */
  catalogVersion?: string;
}

/** Response from POST /v1/routes (API-1). */
export interface CreateRouteResponse {
  requestId: string;
  status: RouteStatus;
  catalogVersion: string;
  createdAt: string;
}

/** Full route state (internal; surfaced by GET /v1/routes/:id). */
export interface RouteRecord {
  requestId: string;
  status: RouteStatus;
  prompt: string;
  modalities: string[];
  consequenceClass?: string;
  context?: {
    tenant: string;
    user: string;
    role?: string;
  };
  decisionId?: string;
  executionId?: string;
  selectedModelId?: string;
  selectionMode?: SelectionMode;
  tier?: string;
  confidence?: number;
  errorMessage?: string;
  catalogVersion: string;
  createdAt: string;
  updatedAt: string;
}

/** Response from GET /v1/routes/:id/events (snapshot; SSE pushes live). */
export interface RouteEventsResponse {
  requestId: string;
  events: RouteEvent[];
  /** Highest sequence seen so far. */
  lastSequence: number;
}

/** Response from GET /v1/catalog (API-3). */
export interface CatalogResponse {
  catalogVersion: string;
  entries: CatalogEntry[];
}

// ---------------------------------------------------------------------------
// Health / experience types (B4 / EXP-2)
// ---------------------------------------------------------------------------

/** Response from GET /v1/health (B4). */
export interface HealthCheckResponse {
  status: 'ok';
  uptime: number;
  version: string;
}

/** Response from GET /v1/experience/stats (EXP-2). */
export interface ExperienceStatsResponse {
  /** Total number of confirmed experience entries. */
  confirmedCount: number;
  /** Total number of disputed experience entries. */
  disputedCount: number;
  /** Total number of pending experience entries (excluded from stats). */
  pendingCount: number;
  /** Total number of expired experience entries. */
  expiredCount: number;
  /** Current experience version number (null if no version yet). */
  currentVersion: number | null;
  /** Timestamp of the stats snapshot. */
  snapshotAt: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type RouteApiErrorCode =
  | 'ROUTE_NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'PROMPT_TOO_LONG';

export class RouteApiError extends Error {
  constructor(
    readonly code: RouteApiErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'RouteApiError';
  }
}

// ---------------------------------------------------------------------------
// Route registry (in-process; production swaps with a persisted store)
// ---------------------------------------------------------------------------

/** A stored decision record. */
export interface DecisionRecord {
  decisionId: string;
  requestId: string;
  decisionSource: string;
  confidence: number;
  routeTier: string;
  selectedModelId?: string;
  degraded: boolean;
  createdAt: string;
}

/**
 * RouteRegistry — in-memory store of RouteRecords keyed by requestId.
 *
 * The registry enforces:
 *  - State machine transition legality (API-1).
 *  - Update timestamp tracking.
 *  - Catalog version consistency vs the registry default (MODEL-4).
 */
export class RouteRegistry {
  private readonly routes = new Map<string, RouteRecord>();
  private readonly receiptStore = new Map<string, DecisionReceipt>();
  private readonly contractStore = new Map<string, DecisionContract>();
  private readonly decisionStore = new Map<string, DecisionRecord>();
  private readonly catalog: VersionedCatalog;

  constructor(catalog: VersionedCatalog = MVP_SEED_CATALOG) {
    this.catalog = catalog;
  }

  /** Create a new route in the CREATED state (API-1). */
  createRoute(input: CreateRouteRequest): CreateRouteResponse {
    if (input.prompt.length > 5000) {
      throw new RouteApiError(
        'PROMPT_TOO_LONG',
        `Prompt MUST be ≤ 5000 chars; got ${input.prompt.length}`,
      );
    }
    if (input.catalogVersion) {
      assertSameCatalogVersion(this.catalog, { catalogVersion: input.catalogVersion });
    }
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const now = new Date().toISOString();
    const record: RouteRecord = {
      requestId,
      status: 'CREATED',
      prompt: input.prompt,
      modalities: input.modalities ?? ['text'],
      catalogVersion: this.catalog.catalogVersion,
      createdAt: now,
      updatedAt: now,
    };
    if (input.consequenceClass !== undefined) record.consequenceClass = input.consequenceClass;
    if (input.context !== undefined) record.context = input.context;
    this.routes.set(requestId, record);
    return {
      requestId,
      status: 'CREATED',
      catalogVersion: this.catalog.catalogVersion,
      createdAt: now,
    };
  }

  /** Transition a route to the next status (API-1 state machine). */
  transition(requestId: string, next: RouteStatus, patch?: Partial<RouteRecord>): RouteRecord {
    const record = this.getOrThrow(requestId);
    const allowed = ALLOWED_TRANSITIONS[record.status];
    if (!allowed.includes(next)) {
      throw new RouteApiError(
        'INVALID_TRANSITION',
        `Cannot transition ${record.status} → ${next}`,
      );
    }
    record.status = next;
    record.updatedAt = new Date().toISOString();
    if (patch) {
      if (patch.decisionId !== undefined) record.decisionId = patch.decisionId;
      if (patch.executionId !== undefined) record.executionId = patch.executionId;
      if (patch.selectedModelId !== undefined) record.selectedModelId = patch.selectedModelId;
      if (patch.selectionMode !== undefined) record.selectionMode = patch.selectionMode;
      if (patch.tier !== undefined) record.tier = patch.tier;
      if (patch.confidence !== undefined) record.confidence = patch.confidence;
      if (patch.errorMessage !== undefined) record.errorMessage = patch.errorMessage;
    }
    return record;
  }

  /** Get a route's current status / state (GET /v1/routes/:id). */
  getRouteStatus(requestId: string): RouteRecord {
    return this.getOrThrow(requestId);
  }

  /**
   * Store a decision receipt keyed by requestId (JEV-16).
   */
  setReceipt(requestId: string, receipt: DecisionReceipt): void {
    this.receiptStore.set(requestId, receipt);
  }

  /**
   * Retrieve a decision receipt by requestId (JEV-16).
   * Returns undefined if not found.
   */
  getReceipt(requestId: string): DecisionReceipt | undefined {
    return this.receiptStore.get(requestId);
  }

  /**
   * Store a decision contract keyed by contractId (JEV-12).
   */
  setContract(contractId: string, contract: DecisionContract): void {
    this.contractStore.set(contractId, contract);
  }

  /**
   * Retrieve a decision contract by contractId (JEV-12).
   * Returns undefined if not found.
   */
  getContract(contractId: string): DecisionContract | undefined {
    return this.contractStore.get(contractId);
  }

  /**
   * Store a decision record keyed by decisionId.
   */
  setDecision(decisionId: string, record: DecisionRecord): void {
    this.decisionStore.set(decisionId, record);
  }

  /**
   * Retrieve a decision record by decisionId.
   * Returns undefined if not found.
   */
  getDecision(decisionId: string): DecisionRecord | undefined {
    return this.decisionStore.get(decisionId);
  }

  /** List all known requestIds (test / admin helper). */
  list(): RouteRecord[] {
    return [...this.routes.values()];
  }

  /** Drop a route from the registry (memory reclaim). */
  drop(requestId: string): void {
    this.routes.delete(requestId);
    this.receiptStore.delete(requestId);
  }

  /** Catalog accessor (for API-3 / MODEL-4). */
  getCatalog(): VersionedCatalog {
    return this.catalog;
  }

  private getOrThrow(requestId: string): RouteRecord {
    const record = this.routes.get(requestId);
    if (!record) {
      throw new RouteApiError('ROUTE_NOT_FOUND', `requestId=${requestId} not found`);
    }
    return record;
  }
}

// ---------------------------------------------------------------------------
// Handler functions (thin contract layer)
// ---------------------------------------------------------------------------

/**
 * Create a route (POST /v1/routes, API-1).
 *
 * Emits a `ROUTE_CREATED` event on the EventBus so subscribers (SSE
 * stream, trace aggregator) are notified. The route starts in `CREATED`
 * state; downstream stages (DECIDING / EXECUTING / COMPLETED / FAILED)
 * are pushed by the service-side state machine.
 */
export function createRoute(
  registry: RouteRegistry,
  eventBus: EventBus,
  body: CreateRouteRequest,
): CreateRouteResponse {
  const response = registry.createRoute(body);
  eventBus.emit({
    requestId: response.requestId,
    type: 'ROUTE_CREATED',
    payload: {
      promptSummary: body.prompt.slice(0, 500),
      modalities: body.modalities ?? ['text'],
      consequenceClass: body.consequenceClass,
    },
  });
  return response;
}

/** GET /v1/routes/:id (API-1). */
export function getRouteStatus(
  registry: RouteRegistry,
  requestId: string,
): RouteRecord {
  return registry.getRouteStatus(requestId);
}

/**
 * GET /v1/routes/:id/events (API-2 / EVENT-3 snapshot).
 *
 * Returns the buffered event stream up to the caller's cursor. The SSE
 * stream is fed by `EventBus` directly; this handler is for snapshot
 * consumers.
 */
export function getRouteEvents(
  eventBus: EventBus,
  requestId: string,
): RouteEventsResponse {
  const events = eventBus.getEvents(requestId);
  const lastSequence = events.length > 0 ? events[events.length - 1].sequence : -1;
  return { requestId, events, lastSequence };
}

/** GET /v1/catalog (API-3). */
export function getCatalog(
  registry: RouteRegistry,
  expectedVersion?: string,
): CatalogResponse {
  const catalog = registry.getCatalog();
  if (expectedVersion) {
    assertSameCatalogVersion(catalog, { catalogVersion: expectedVersion });
  }
  return { catalogVersion: catalog.catalogVersion, entries: catalog.entries };
}

// ---------------------------------------------------------------------------
// Health / experience handlers (B4 / EXP-2)
// ---------------------------------------------------------------------------

/** Application start time for uptime calculation. */
const APP_START_TIME = Date.now();

/** Package version — matches package.json version. */
const APP_VERSION = '0.1.0';

/**
 * GET /v1/health (B4).
 *
 * Health check endpoint polled by the frontend. Returns system status,
 * uptime (seconds), and the current package version.
 */
export function healthCheck(): HealthCheckResponse {
  return {
    status: 'ok',
    uptime: (Date.now() - APP_START_TIME) / 1000,
    version: APP_VERSION,
  };
}

/**
 * GET /v1/experience/stats (EXP-2).
 *
 * Get experience statistics for calibration. Draws from the
 * ExperienceStore and ExperienceVersionManager to provide a snapshot
 * of current experience state.
 */
export function getExperienceStats(params: {
  confirmedCount: number;
  disputedCount: number;
  pendingCount: number;
  expiredCount: number;
  currentVersion: number | null;
}): ExperienceStatsResponse {
  return {
    confirmedCount: params.confirmedCount,
    disputedCount: params.disputedCount,
    pendingCount: params.pendingCount,
    expiredCount: params.expiredCount,
    currentVersion: params.currentVersion,
    snapshotAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Store registration helpers (for wiring in the service layer)
// ---------------------------------------------------------------------------

/**
 * Register a decision receipt in the registry (JEV-16).
 * Called by the decision-runtime driver after a receipt is generated.
 */
export function registerReceipt(registry: RouteRegistry, requestId: string, receipt: DecisionReceipt): void {
  registry.setReceipt(requestId, receipt);
}

/**
 * Store a decision contract in the registry (JEV-12).
 * Called during system initialization or contract hot-reload.
 */
export function storeContract(registry: RouteRegistry, contractId: string, contract: DecisionContract): void {
  registry.setContract(contractId, contract);
}

/**
 * Register a decision record in the registry.
 * Called by the decision-runtime driver after a decision is made.
 */
export function registerDecision(registry: RouteRegistry, record: DecisionRecord): void {
  registry.setDecision(record.decisionId, record);
}

// ---------------------------------------------------------------------------
// State machine helpers (used by the async driver, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Advance a route to the DECIDING state, attaching the decisionId.
 * Emits no event — the JEV call lifecycle events are emitted by the
 * decision-runtime driver.
 */
export function beginDeciding(
  registry: RouteRegistry,
  requestId: string,
  decisionId: string,
): RouteRecord {
  return registry.transition(requestId, 'DECIDING', { decisionId });
}

/**
 * Advance a route to the EXECUTING state, attaching the executionId and
 * selected model. Tags the record with `selectionMode` (EVENT-4) derived
 * non-falsifiably from the decision source.
 */
export function beginExecuting(
  registry: RouteRegistry,
  requestId: string,
  decisionId: string,
  executionId: string,
  selectedModelId: string,
  decisionSource: 'TYPE_SAFE_JEV' | 'RULE_FALLBACK' | 'LOCAL_REIMPL' | 'USER_OVERRIDE',
  extras?: { tier?: string; confidence?: number },
): RouteRecord {
  const tagged = tagSelectionMode({
    requestId,
    decisionId,
    modelId: selectedModelId,
    decisionSource,
  });
  return registry.transition(requestId, 'EXECUTING', {
    executionId,
    selectedModelId,
    selectionMode: tagged.selectionMode,
    tier: extras?.tier,
    confidence: extras?.confidence,
  });
}

/** Mark a route COMPLETED. */
export function completeRoute(registry: RouteRegistry, requestId: string): RouteRecord {
  return registry.transition(requestId, 'COMPLETED');
}

/** Mark a route FAILED with an error message. */
export function failRoute(
  registry: RouteRegistry,
  requestId: string,
  errorMessage: string,
): RouteRecord {
  return registry.transition(requestId, 'FAILED', { errorMessage });
}

/**
 * Emit a `ROUTE_ESCALATED` event (JEV-15 low-confidence / manual).
 * The route status transitions to FAILED via `failRoute` by the caller
 * (escalation does not by itself terminate the route; the reviewer may
 * still confirm).
 */
export function emitRouteEscalated(
  eventBus: EventBus,
  requestId: string,
  reason: 'low_confidence' | 'irreversible' | 'manual' | 'constraint_violation',
  escalateTo: string,
  decisionId?: string,
): RouteEvent {
  const { event } = eventBus.emit({
    requestId,
    type: 'ROUTE_ESCALATED',
    decisionId,
    payload: { reason, escalateTo },
  });
  return event;
}

/**
 * Emit a `MODEL_COMPLETED` event and update the trace aggregator.
 * Used by the model-gateway driver when a streaming call finishes.
 */
export function emitModelCompleted(
  eventBus: EventBus,
  trace: TraceAggregator,
  params: {
    requestId: string;
    decisionId: string;
    executionId: string;
    modelId: string;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
  },
): RouteEvent {
  const { event } = eventBus.emit({
    requestId: params.requestId,
    decisionId: params.decisionId,
    executionId: params.executionId,
    type: 'MODEL_COMPLETED',
    payload: {
      modelId: params.modelId,
      executionId: params.executionId,
      latencyMs: params.latencyMs,
      promptTokens: params.promptTokens,
      completionTokens: params.completionTokens,
      costUsd: params.costUsd,
    },
  });
  trace.recordTrace(event);
  trace.recordExecution(params.requestId, params.decisionId, params.executionId, {
    modelId: params.modelId,
    latencyMs: params.latencyMs,
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    costUsd: params.costUsd,
    success: true,
    completedAt: event.timestamp,
  });
  return event;
}

/**
 * Emit a `MODEL_STREAMING` chunk event (MODEL_STREAMING).
 * Stateless helper — does not touch the trace aggregator (chunks are
 * high-frequency; only the terminal MODEL_COMPLETED is recorded).
 */
export function emitModelStreaming(
  eventBus: EventBus,
  params: {
    requestId: string;
    decisionId: string;
    executionId: string;
    modelId: string;
    delta: string;
    cumulativeTokens?: number;
  },
): RouteEvent {
  const { event } = eventBus.emit({
    requestId: params.requestId,
    decisionId: params.decisionId,
    executionId: params.executionId,
    type: 'MODEL_STREAMING',
    payload: {
      modelId: params.modelId,
      executionId: params.executionId,
      delta: params.delta,
      cumulativeTokens: params.cumulativeTokens,
    },
  });
  return event;
}

/** Helper retained for type-only re-export stability in `index.ts`. */
export type { RouteEvent };
