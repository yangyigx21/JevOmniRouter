/**
 * RouteEvent Contract & Event Bus — EVENT-1 (§6.1 design.md).
 *
 * The system SHALL define a unified `RouteEvent` contract; each event SHALL
 * contain `eventId` / `requestId` / `decisionId?` / `executionId?` / `type` /
 * `timestamp` / `sequence` / `payload`. `sequence` SHALL be monotonically
 * increasing per request (EVENT-1 scenario "事件字段完整").
 *
 * The 14 event types (ANIM-6 scenario "真实事件驱动", EVENT-1 spec):
 *
 * | RouteEvent               | 3D 行为                                  |
 * |--------------------------|------------------------------------------|
 * | ROUTE_CREATED            | Prompt 节点亮起                          |
 * | EXPERIENCE_RETRIEVED     | Experience 节点出现证据流                |
 * | JEV_CALL_STARTED         | Jev Hub 脉冲                            |
 * | JEV_DECISION_READY       | 候选节点按 score 亮度显示                |
 * | JEV_FALLBACK             | Jev Hub 显示降级状态                     |
 * | CONSTRAINT_FILTERED      | 被排除节点变灰并显示原因                 |
 * | MODEL_CALL_STARTED       | 模型调用开始，selected model 进入执行态  |
 * | MODEL_SELECTED           | 最终路径高亮                             |
 * | MODEL_STREAMING          | 数据包沿 selected edge 流动              |
 * | MODEL_COMPLETED          | Selected Model 完成态                    |
 * | EXPERIENCE_SAVED         | 结果汇聚到 Experience                    |
 * | CONSTRAINT_GATE_PASSED   | Selector 通过硬约束门                   |
 * | ROUTE_ESCALATED          | 路由转人工档位                          |
 * | ROUTE_FAILED             | 路由失败，gate 节点进入错误态            |
 *
 * The event bus MUST guarantee:
 *  - Per-request `sequence` monotonically increases (EVENT-1).
 *  - Subscribers are invoked in subscription order (FIFO).
 *  - Validation rejects malformed events (EVENT-2 dedup precondition).
 */
import type { RouteTier } from '@jev-router/shared';

// ---------------------------------------------------------------------------
// EVENT-1: RouteEvent contract
// ---------------------------------------------------------------------------

/**
 * The 14 RouteEvent types (ANIM-6, EVENT-1).
 *
 * Note: This list is the canonical whitelist used by `validateEvent`. Any
 * event whose `type` is not in this union MUST be rejected.
 */
export type RouteEventType =
  | 'ROUTE_CREATED'
  | 'EXPERIENCE_RETRIEVED'
  | 'JEV_CALL_STARTED'
  | 'JEV_DECISION_READY'
  | 'JEV_FALLBACK'
  | 'CONSTRAINT_FILTERED'
  | 'MODEL_CALL_STARTED'
  | 'MODEL_SELECTED'
  | 'MODEL_STREAMING'
  | 'MODEL_COMPLETED'
  | 'EXPERIENCE_SAVED'
  | 'CONSTRAINT_GATE_PASSED'
  | 'ROUTE_ESCALATED'
  | 'ROUTE_FAILED';

/** Whitelisted event types in canonical emission order (for documentation). */
export const ROUTE_EVENT_TYPES: readonly RouteEventType[] = [
  'ROUTE_CREATED',
  'EXPERIENCE_RETRIEVED',
  'JEV_CALL_STARTED',
  'JEV_DECISION_READY',
  'JEV_FALLBACK',
  'CONSTRAINT_FILTERED',
  'MODEL_CALL_STARTED',
  'MODEL_SELECTED',
  'MODEL_STREAMING',
  'MODEL_COMPLETED',
  'EXPERIENCE_SAVED',
  'CONSTRAINT_GATE_PASSED',
  'ROUTE_ESCALATED',
  'ROUTE_FAILED',
] as const;

/** Common payload shapes — used by callers as guidance, not enforced. */
export interface RouteEventPayloads {
  ROUTE_CREATED: {
    promptSummary: string;
    modalities: string[];
    consequenceClass?: string;
    tier?: RouteTier;
  };
  EXPERIENCE_RETRIEVED: {
    expVersion: number | string;
    priorSnapshot: number[];
    sampleCount: number;
  };
  JEV_CALL_STARTED: {
    contractId: string;
    fiveQuestionsCount: number;
  };
  JEV_DECISION_READY: {
    decisionId: string;
    confidence: number;
    calibratedConfidence: number;
    candidateScores?: { modelId: string; raw: number; probability?: number }[];
  };
  JEV_FALLBACK: {
    reason: 'timeout' | 'invalid_schema' | 'adapter_error' | 'unknown';
    fallbackRuleId?: string;
    degraded: boolean;
  };
  CONSTRAINT_FILTERED: {
    excludedModelIds: string[];
    reason: Record<string, string>;
    remainingCount: number;
  };
  MODEL_CALL_STARTED: {
    modelId: string;
    executionId: string;
    provider: string;
  };
  CONSTRAINT_GATE_PASSED: {
    passedModelIds: string[];
    step: string;
    /**
     * 候选池是否经**回落**得到而非直接由约束筛选决定（JEV-11 附录 G-2）。
     * true 表示约束被忽略，可用性与约束严格性之间的取舍已发生。
     */
    constraintFallback?: boolean;
    /** 回落原因（仅 constraintFallback 为 true 时有值）。 */
    constraintFallbackReason?: 'allowed_model_ids_not_in_catalog' | 'all_candidates_eliminated';
  };
  MODEL_SELECTED: {
    modelId: string;
    catalogIndex: number;
    rankIndex: number;
    probability: number;
    selectionMode: string;
  };
  MODEL_STREAMING: {
    modelId: string;
    executionId: string;
    delta: string;
    cumulativeTokens?: number;
  };
  MODEL_COMPLETED: {
    modelId: string;
    executionId: string;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
  };
  EXPERIENCE_SAVED: {
    eid: string;
    expVersion: number | string;
    outcomeStatus: string;
  };
  ROUTE_ESCALATED: {
    reason: 'low_confidence' | 'irreversible' | 'manual' | 'constraint_violation';
    escalateTo: string;
  };
  ROUTE_FAILED: {
    reason: 'no_candidate' | 'constraint_violation' | 'timeout' | 'provider_error' | 'unknown';
    message: string;
    partialResults?: Record<string, unknown>;
  };
}

/**
 * The unified RouteEvent contract (design.md §6.1).
 *
 * Invariants:
 *  - `eventId` is content-addressed (callers SHOULD derive from a hash of
 *    the rest of the fields) for dedup (EVENT-2).
 *  - `sequence` is monotonically increasing per `requestId` (EVENT-1).
 *  - `decisionId` / `executionId` are optional until those stages run.
 */
export interface RouteEvent {
  /** Content-addressed unique event id (EVENT-2 dedup key). */
  eventId: string;
  /** Correlated request identifier (links to EVENT-4 trace chain). */
  requestId: string;
  /** Decision identifier (set after JEV_DECISION_READY). */
  decisionId?: string;
  /** Execution identifier (set after MODEL_STREAMING / MODEL_COMPLETED). */
  executionId?: string;
  /** One of the 14 whitelisted types. */
  type: RouteEventType;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Monotonically increasing per request (EVENT-1). */
  sequence: number;
  /** Event-specific payload. */
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type RouteEventErrorCode =
  | 'INVALID_TYPE'
  | 'MISSING_REQUIRED_FIELD'
  | 'INVALID_SEQUENCE'
  | 'INVALID_TIMESTAMP'
  | 'PAYLOAD_MISMATCH';

export class RouteEventError extends Error {
  constructor(
    readonly code: RouteEventErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'RouteEventError';
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS: (keyof RouteEvent)[] = [
  'eventId',
  'requestId',
  'type',
  'timestamp',
  'sequence',
  'payload',
];

/**
 * Validate a RouteEvent (EVENT-1).
 *
 * Checks:
 *  - All required fields present (eventId, requestId, type, timestamp,
 *    sequence, payload).
 *  - `type` is in the 14-element whitelist.
 *  - `sequence` is a non-negative finite integer.
 *  - `timestamp` is a non-empty ISO 8601 string.
 *  - `payload` is a non-null object.
 *
 * @throws RouteEventError on first violation.
 */
export function validateEvent(event: unknown): asserts event is RouteEvent {
  if (typeof event !== 'object' || event === null) {
    throw new RouteEventError('MISSING_REQUIRED_FIELD', 'event MUST be a non-null object');
  }
  const e = event as Partial<RouteEvent> & Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (e[field] === undefined || e[field] === null) {
      throw new RouteEventError(
        'MISSING_REQUIRED_FIELD',
        `event MUST contain "${field}" (EVENT-1)`,
      );
    }
  }
  if (typeof e.type !== 'string') {
    throw new RouteEventError('INVALID_TYPE', `event.type MUST be string; got ${typeof e.type}`);
  }
  if (!ROUTE_EVENT_TYPES.includes(e.type as RouteEventType)) {
    throw new RouteEventError(
      'INVALID_TYPE',
      `event.type "${e.type}" not in whitelist ${ROUTE_EVENT_TYPES.join('/')}`,
    );
  }
  if (typeof e.sequence !== 'number' || !Number.isFinite(e.sequence) || e.sequence < 0) {
    throw new RouteEventError(
      'INVALID_SEQUENCE',
      `event.sequence MUST be a non-negative finite number; got ${String(e.sequence)}`,
    );
  }
  if (!Number.isInteger(e.sequence)) {
    throw new RouteEventError(
      'INVALID_SEQUENCE',
      `event.sequence MUST be an integer; got ${String(e.sequence)}`,
    );
  }
  if (typeof e.timestamp !== 'string' || e.timestamp.length === 0) {
    throw new RouteEventError(
      'INVALID_TIMESTAMP',
      'event.timestamp MUST be a non-empty ISO 8601 string',
    );
  }
  if (typeof e.payload !== 'object' || e.payload === null) {
    throw new RouteEventError(
      'PAYLOAD_MISMATCH',
      'event.payload MUST be a non-null object',
    );
  }
}

/** Soft check — returns true iff `event` passes validation. */
export function isValidEvent(event: unknown): event is RouteEvent {
  try {
    validateEvent(event);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Event factory
// ---------------------------------------------------------------------------

/**
 * Create a RouteEvent with deterministic fields.
 *
 * The caller supplies the request-scoped `sequence` (the EventBus will
 * allocate one if omitted). `eventId` defaults to a content-addressed
 * hash of (requestId, type, sequence, payload) — callers MAY override.
 */
export function createEvent(params: {
  requestId: string;
  type: RouteEventType;
  payload: Record<string, unknown>;
  decisionId?: string;
  executionId?: string;
  sequence: number;
  timestamp?: string;
  eventId?: string;
}): RouteEvent {
  const timestamp = params.timestamp ?? new Date().toISOString();
  const eventId =
    params.eventId ??
    contentAddressedEventId({
      requestId: params.requestId,
      type: params.type,
      sequence: params.sequence,
      timestamp,
      payload: params.payload,
    });
  const event: RouteEvent = {
    eventId,
    requestId: params.requestId,
    type: params.type,
    timestamp,
    sequence: params.sequence,
    payload: params.payload,
  };
  if (params.decisionId !== undefined) event.decisionId = params.decisionId;
  if (params.executionId !== undefined) event.executionId = params.executionId;
  validateEvent(event);
  return event;
}

/**
 * Derive a content-addressed eventId (EVENT-2 dedup key).
 *
 * Deterministic: same inputs → same eventId. Uses a simple FNV-1a 32-bit
 * hash over a canonical JSON form — sufficient for in-process dedup;
 * production adapters MAY swap in SHA-256 via a wrapper.
 */
export function contentAddressedEventId(input: {
  requestId: string;
  type: RouteEventType;
  sequence: number;
  timestamp: string;
  payload: Record<string, unknown>;
}): string {
  const canonical = `${input.requestId}|${input.type}|${input.sequence}|${input.timestamp}|${stableStringify(input.payload)}`;
  return `evt-${fnv1a32(canonical).toString(16).padStart(8, '0')}`;
}

/** Stable JSON stringify (sorted object keys) — input is a plain object. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** FNV-1a 32-bit hash (deterministic, non-cryptographic). */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // 32-bit multiply by 16777619
    hash = (hash + ((hash << 24) | (hash << 8) | (hash << 0))) | 0;
    // FNV prime step (Math.imul keeps the lower 32 bits in JS)
    hash = Math.imul(hash, 16777619) | 0;
  }
  // force unsigned
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a RouteEvent to a JSON string for SSE / persistence (EVENT-1,
 * EVENT-3). Output is deterministic (stable object key order).
 */
export function serializeEvent(event: RouteEvent): string {
  validateEvent(event);
  const ordered: Record<string, unknown> = {
    eventId: event.eventId,
    requestId: event.requestId,
  };
  if (event.decisionId !== undefined) ordered.decisionId = event.decisionId;
  if (event.executionId !== undefined) ordered.executionId = event.executionId;
  ordered.type = event.type;
  ordered.timestamp = event.timestamp;
  ordered.sequence = event.sequence;
  ordered.payload = event.payload;
  return JSON.stringify(ordered);
}

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

/** Subscriber callback — receives a validated event. */
export type EventSubscriber = (event: RouteEvent) => void;

/** Subscription handle (for unsubscribe). */
export interface Subscription {
  readonly id: number;
  readonly subscriber: EventSubscriber;
}

/**
 * EventBus — per-process in-memory pub/sub for RouteEvents (EVENT-1).
 *
 * Guarantees:
 *  - Per-request `sequence` is allocated monotonically by `emit()` when the
 *    caller does not supply one; the bus tracks the highest seen sequence
 *    per `requestId` and refuses regressions.
 *  - Subscribers fire in subscription order (FIFO).
 *  - Throwing subscribers do not interrupt delivery to subsequent subscribers
 *    (errors are collected and reported via the `emit()` return value).
 */
export class EventBus {
  private readonly subscribers: Subscription[] = [];
  private readonly sequences = new Map<string, number>();
  private readonly events = new Map<string, RouteEvent[]>();
  private nextSubscriptionId = 1;
  private readonly maxBufferedPerRequest: number;

  constructor(opts?: { maxBufferedPerRequest?: number }) {
    this.maxBufferedPerRequest = opts?.maxBufferedPerRequest ?? 1000;
  }

  /**
   * Subscribe to all events. Returns a handle that MUST be passed to
   * `unsubscribe()` to stop delivery.
   */
  subscribe(subscriber: EventSubscriber): Subscription {
    const sub: Subscription = { id: this.nextSubscriptionId++, subscriber };
    this.subscribers.push(sub);
    return sub;
  }

  /** Remove a subscription. No-op if the handle is unknown. */
  unsubscribe(handle: Subscription): void {
    const idx = this.subscribers.findIndex((s) => s.id === handle.id);
    if (idx >= 0) this.subscribers.splice(idx, 1);
  }

  /**
   * Emit an event to all subscribers (EVENT-1).
   *
   * If `event.sequence` is omitted, the bus allocates the next per-request
   * sequence. If supplied, the bus validates that it strictly exceeds the
   * last seen sequence for that `requestId`.
   *
   * @returns errors thrown by subscribers (delivery continues regardless).
   */
  emit(
    input:
      | (Omit<RouteEvent, 'sequence' | 'eventId' | 'timestamp'> & {
          sequence?: number;
          eventId?: string;
          timestamp?: string;
        })
      | RouteEvent,
  ): { event: RouteEvent; subscriberErrors: unknown[] } {
    const lastSeq = this.sequences.get(input.requestId) ?? -1;
    const sequence = (input as { sequence?: number }).sequence ?? lastSeq + 1;
    if (sequence <= lastSeq) {
      throw new RouteEventError(
        'INVALID_SEQUENCE',
        `sequence ${sequence} MUST strictly exceed last seen ${lastSeq} for requestId=${input.requestId}`,
      );
    }
    const event = createEvent({
      requestId: input.requestId,
      type: input.type,
      payload: input.payload,
      decisionId: (input as { decisionId?: string }).decisionId,
      executionId: (input as { executionId?: string }).executionId,
      sequence,
      timestamp: (input as { timestamp?: string }).timestamp,
      eventId: (input as { eventId?: string }).eventId,
    });
    this.sequences.set(input.requestId, sequence);
    this.bufferEvent(event);

    const errors: unknown[] = [];
    for (const sub of [...this.subscribers]) {
      try {
        sub.subscriber(event);
      } catch (err) {
        errors.push(err);
      }
    }
    return { event, subscriberErrors: errors };
  }

  /**
   * Replay buffered events for a requestId (EVENT-3 reconnection compensation).
   * Returns events with `sequence > lastSequence` in ascending order.
   */
  replaySince(requestId: string, lastSequence: number): RouteEvent[] {
    const buf = this.events.get(requestId) ?? [];
    return buf.filter((e) => e.sequence > lastSequence).sort((a, b) => a.sequence - b.sequence);
  }

  /** Get all buffered events for a requestId (EVENT-4 trace timeline). */
  getEvents(requestId: string): RouteEvent[] {
    return [...(this.events.get(requestId) ?? [])].sort((a, b) => a.sequence - b.sequence);
  }

  /** Drop buffered events for a requestId (memory reclaim after route completion). */
  drop(requestId: string): void {
    this.events.delete(requestId);
    this.sequences.delete(requestId);
  }

  /** Test helper: highest sequence seen for a requestId. */
  lastSequence(requestId: string): number {
    return this.sequences.get(requestId) ?? -1;
  }

  private bufferEvent(event: RouteEvent): void {
    let buf = this.events.get(event.requestId);
    if (!buf) {
      buf = [];
      this.events.set(event.requestId, buf);
    }
    buf.push(event);
    if (buf.length > this.maxBufferedPerRequest) {
      // Drop oldest entries to keep memory bounded (PERF-3).
      buf.splice(0, buf.length - this.maxBufferedPerRequest);
    }
  }
}
