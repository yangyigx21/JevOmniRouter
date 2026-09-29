/**
 * Full-Chain Trace Aggregator — EVENT-4 (§6.1 design.md).
 *
 * Each route SHALL have unique `requestId` / `decisionId` / `executionId`
 * and they SHALL be mutually correlatable (three-segment trace chain).
 * Metrics SHALL be aggregatable along the dimensions:
 *
 *   - `taskType` / `modality` / `modelId` / `decisionSource` /
 *     `policyVersion` / `catalogVersion`
 *
 * Aggregation SHALL cover: quality, latency, cost, success, fallback,
 * Jev error, constraint rejection.
 *
 * This module:
 *  - Maintains three-segment trace links (requestId → decisionId →
 *    executionId).
 *  - Aggregates metrics along the dimensions above at three granularities
 *    (per-request, per-decision, per-execution).
 *  - Reconstructs the trace timeline from buffered RouteEvents.
 */
import type { RouteEvent } from './route-event.js';
import type { DecisionSource } from './decision-source.js';

// ---------------------------------------------------------------------------
// Trace chain
// ---------------------------------------------------------------------------

/** Aggregation dimensions (EVENT-4). */
export interface TraceDimensions {
  taskType?: string;
  modality?: string | string[];
  modelId?: string;
  decisionSource?: DecisionSource | string;
  policyVersion?: string;
  catalogVersion?: string;
}

/**
 * A single execution segment in the trace chain (one model invocation).
 *
 * A `decisionId` may spawn multiple `executionId`s (retry, cascade);
 * a `requestId` may spawn multiple `decisionId`s (interrupt & re-route).
 */
export interface ExecutionSegment {
  executionId: string;
  decisionId: string;
  requestId: string;
  modelId: string;
  provider?: string;
  /** Latency in ms. */
  latencyMs?: number;
  /** Token usage. */
  promptTokens?: number;
  completionTokens?: number;
  /** Cost in USD. */
  costUsd?: number;
  /** Whether the execution succeeded. */
  success?: boolean;
  /** Whether fallback was used. */
  fallback?: boolean;
  /** Whether a Jev error was observed. */
  jevError?: boolean;
  /** Whether a hard constraint rejected this candidate. */
  constraintRejected?: boolean;
  /** Quality score (0..1) if known. */
  quality?: number;
  /** ISO 8601 start / end. */
  startedAt?: string;
  completedAt?: string;
}

/** A decision segment (one JEV call). */
export interface DecisionSegment {
  decisionId: string;
  requestId: string;
  decisionSource: DecisionSource;
  /** Calibrated confidence at decision time. */
  confidence?: number;
  /** Route tier output (ROUTE / GATE / ESCALATE). */
  tier?: string;
  /** Whether forced human review by irreversibility. */
  forcedHumanReview?: boolean;
  /** Whether the decision was degraded (CONSTRAIN-4). */
  degraded?: boolean;
  /** Linked execution segments (in chronological order). */
  executions: ExecutionSegment[];
  /** ISO 8601 creation. */
  decidedAt?: string;
}

/** Full trace for a request (EVENT-4 three-segment chain). */
export interface RequestTrace {
  requestId: string;
  decisions: DecisionSegment[];
  /** Aggregated dimensions across all decisions (most recent wins). */
  dimensions: TraceDimensions;
  /** ISO 8601 creation. */
  createdAt?: string;
}

// ---------------------------------------------------------------------------
// Aggregated metrics
// ---------------------------------------------------------------------------

/** Aggregated metrics at a given granularity (EVENT-4). */
export interface AggregatedMetrics {
  count: number;
  successCount: number;
  fallbackCount: number;
  jevErrorCount: number;
  constraintRejectionCount: number;
  /** Average latency in ms (only successful executions). */
  avgLatencyMs: number;
  /** P95 latency in ms. */
  p95LatencyMs: number;
  /** Total cost in USD. */
  totalCostUsd: number;
  /** Total prompt tokens. */
  totalPromptTokens: number;
  /** Total completion tokens. */
  totalCompletionTokens: number;
  /** Average quality (0..1) across executions where quality was recorded. */
  avgQuality: number;
  /** Average confidence (0..1) across decisions where confidence was recorded. */
  avgConfidence: number;
}

const EMPTY_METRICS: AggregatedMetrics = {
  count: 0,
  successCount: 0,
  fallbackCount: 0,
  jevErrorCount: 0,
  constraintRejectionCount: 0,
  avgLatencyMs: 0,
  p95LatencyMs: 0,
  totalCostUsd: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  avgQuality: 0,
  avgConfidence: 0,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type TraceErrorCode =
  | 'REQUEST_NOT_FOUND'
  | 'DECISION_NOT_FOUND'
  | 'EXECUTION_NOT_FOUND'
  | 'LINK_MISMATCH';

export class TraceError extends Error {
  constructor(
    readonly code: TraceErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'TraceError';
  }
}

// ---------------------------------------------------------------------------
// TraceAggregator
// ---------------------------------------------------------------------------

/**
 * TraceAggregator — EVENT-4.
 *
 * Records trace segments as they are emitted (ROUTE_CREATED →
 * JEV_DECISION_READY → MODEL_SELECTED → MODEL_COMPLETED) and provides:
 *  - `getTrace(requestId)` — full three-segment chain.
 *  - `aggregateByRequest` / `aggregateByDecision` / `aggregateByExecution`
 *    — metrics at each granularity.
 *  - `reconstructTimeline` — chronological event list from the buffer.
 *
 * The aggregator is in-memory; production adapters MAY persist each segment
 * to a columnar store (ClickHouse / BigQuery) and reconstruct via query.
 */
export class TraceAggregator {
  private readonly requests = new Map<string, RequestTrace>();
  private readonly decisionIndex = new Map<string, DecisionSegment>();
  private readonly executionIndex = new Map<string, ExecutionSegment>();
  private readonly eventBuffer = new Map<string, RouteEvent[]>();

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  /** Record (or upsert) a request trace root. */
  recordRequest(requestId: string, dimensions: TraceDimensions = {}): RequestTrace {
    let trace = this.requests.get(requestId);
    if (!trace) {
      trace = {
        requestId,
        decisions: [],
        dimensions,
        createdAt: new Date().toISOString(),
      };
      this.requests.set(requestId, trace);
    } else {
      // Most-recent-wins for dimensions (later events enrich the trace).
      trace.dimensions = { ...trace.dimensions, ...dimensions };
    }
    return trace;
  }

  /** Record (or upsert) a decision segment under a request. */
  recordDecision(
    requestId: string,
    decisionId: string,
    decisionSource: DecisionSource,
    extras?: Partial<Omit<DecisionSegment, 'requestId' | 'decisionId' | 'decisionSource' | 'executions'>>,
  ): DecisionSegment {
    let trace = this.requests.get(requestId);
    if (!trace) {
      trace = this.recordRequest(requestId);
    }
    let segment = this.decisionIndex.get(decisionId);
    if (!segment) {
      segment = {
        decisionId,
        requestId,
        decisionSource,
        executions: [],
      };
      this.decisionIndex.set(decisionId, segment);
      trace.decisions.push(segment);
    }
    if (extras) {
      if (extras.confidence !== undefined) segment.confidence = extras.confidence;
      if (extras.tier !== undefined) segment.tier = extras.tier;
      if (extras.forcedHumanReview !== undefined)
        segment.forcedHumanReview = extras.forcedHumanReview;
      if (extras.degraded !== undefined) segment.degraded = extras.degraded;
      if (extras.decidedAt !== undefined) segment.decidedAt = extras.decidedAt;
    }
    return segment;
  }

  /** Record (or upsert) an execution segment under a decision. */
  recordExecution(
    requestId: string,
    decisionId: string,
    executionId: string,
    extras?: Partial<Omit<ExecutionSegment, 'requestId' | 'decisionId' | 'executionId' | 'executions'>>,
  ): ExecutionSegment {
    const decision = this.decisionIndex.get(decisionId);
    if (!decision) {
      throw new TraceError(
        'DECISION_NOT_FOUND',
        `Cannot record execution under unknown decisionId=${decisionId}`,
      );
    }
    if (decision.requestId !== requestId) {
      throw new TraceError(
        'LINK_MISMATCH',
        `decisionId=${decisionId} belongs to requestId=${decision.requestId}, not ${requestId}`,
      );
    }
    let segment = this.executionIndex.get(executionId);
    if (!segment) {
      segment = {
        executionId,
        decisionId,
        requestId,
        modelId: extras?.modelId ?? '',
      };
      this.executionIndex.set(executionId, segment);
      decision.executions.push(segment);
    }
    if (extras) {
      if (extras.modelId !== undefined) segment.modelId = extras.modelId;
      if (extras.provider !== undefined) segment.provider = extras.provider;
      if (extras.latencyMs !== undefined) segment.latencyMs = extras.latencyMs;
      if (extras.promptTokens !== undefined) segment.promptTokens = extras.promptTokens;
      if (extras.completionTokens !== undefined) segment.completionTokens = extras.completionTokens;
      if (extras.costUsd !== undefined) segment.costUsd = extras.costUsd;
      if (extras.success !== undefined) segment.success = extras.success;
      if (extras.fallback !== undefined) segment.fallback = extras.fallback;
      if (extras.jevError !== undefined) segment.jevError = extras.jevError;
      if (extras.constraintRejected !== undefined)
        segment.constraintRejected = extras.constraintRejected;
      if (extras.quality !== undefined) segment.quality = extras.quality;
      if (extras.startedAt !== undefined) segment.startedAt = extras.startedAt;
      if (extras.completedAt !== undefined) segment.completedAt = extras.completedAt;
    }
    return segment;
  }

  /** Buffer a RouteEvent for timeline reconstruction (EVENT-1 replay). */
  recordTrace(event: RouteEvent): void {
    let buf = this.eventBuffer.get(event.requestId);
    if (!buf) {
      buf = [];
      this.eventBuffer.set(event.requestId, buf);
    }
    buf.push(event);
  }

  // -------------------------------------------------------------------------
  // Retrieval
  // -------------------------------------------------------------------------

  /** Get the full three-segment trace for a request (EVENT-4 scenario 1). */
  getTrace(requestId: string): RequestTrace {
    const trace = this.requests.get(requestId);
    if (!trace) {
      throw new TraceError('REQUEST_NOT_FOUND', `No trace for requestId=${requestId}`);
    }
    return trace;
  }

  /** Look up a decision segment by id (EVENT-4 cross-link). */
  getDecision(decisionId: string): DecisionSegment {
    const segment = this.decisionIndex.get(decisionId);
    if (!segment) {
      throw new TraceError('DECISION_NOT_FOUND', `No segment for decisionId=${decisionId}`);
    }
    return segment;
  }

  /** Look up an execution segment by id. */
  getExecution(executionId: string): ExecutionSegment {
    const segment = this.executionIndex.get(executionId);
    if (!segment) {
      throw new TraceError('EXECUTION_NOT_FOUND', `No segment for executionId=${executionId}`);
    }
    return segment;
  }

  /**
   * Reconstruct the trace timeline from buffered events (EVENT-1 scenario
   * "事件时间线可重放"). Returns events in ascending `sequence` order.
   */
  reconstructTimeline(requestId: string): RouteEvent[] {
    const buf = this.eventBuffer.get(requestId) ?? [];
    return [...buf].sort((a, b) => a.sequence - b.sequence);
  }

  // -------------------------------------------------------------------------
  // Aggregation
  // -------------------------------------------------------------------------

  /** Aggregate metrics for all executions under a request (EVENT-4). */
  aggregateByRequest(requestId: string): AggregatedMetrics {
    const trace = this.requests.get(requestId);
    if (!trace) return { ...EMPTY_METRICS };
    const executions: ExecutionSegment[] = [];
    for (const d of trace.decisions) executions.push(...d.executions);
    return aggregateExecutions(executions, trace.decisions);
  }

  /** Aggregate metrics for executions under a single decision. */
  aggregateByDecision(decisionId: string): AggregatedMetrics {
    const decision = this.decisionIndex.get(decisionId);
    if (!decision) return { ...EMPTY_METRICS };
    return aggregateExecutions(decision.executions, [decision]);
  }

  /** Aggregate metrics for a single execution (degenerate but useful). */
  aggregateByExecution(executionId: string): AggregatedMetrics {
    const exec = this.executionIndex.get(executionId);
    if (!exec) return { ...EMPTY_METRICS };
    const decision = this.decisionIndex.get(exec.decisionId);
    return aggregateExecutions([exec], decision ? [decision] : []);
  }

  /**
   * Aggregate metrics along a dimension key (EVENT-4).
   *
   * @param dimension one of `taskType` / `modality` / `modelId` /
   *   `decisionSource` / `policyVersion` / `catalogVersion`.
   * @param value dimension value (string). For `modality`, an execution
   *   matches if ANY of its modalities equals `value`.
   */
  aggregateByDimension(
    dimension: keyof TraceDimensions,
    value: string,
  ): AggregatedMetrics {
    const executions: ExecutionSegment[] = [];
    const decisions: DecisionSegment[] = [];
    for (const trace of this.requests.values()) {
      const dimValue = trace.dimensions[dimension];
      const matches =
        (Array.isArray(dimValue) && dimValue.includes(value)) || dimValue === value;
      if (!matches) continue;
      for (const d of trace.decisions) {
        decisions.push(d);
        executions.push(...d.executions);
      }
    }
    return aggregateExecutions(executions, decisions);
  }

  /** Drop a request trace and all its segments (memory reclaim). */
  drop(requestId: string): void {
    const trace = this.requests.get(requestId);
    if (!trace) return;
    for (const d of trace.decisions) {
      for (const e of d.executions) this.executionIndex.delete(e.executionId);
      this.decisionIndex.delete(d.decisionId);
    }
    this.requests.delete(requestId);
    this.eventBuffer.delete(requestId);
  }
}

// ---------------------------------------------------------------------------
// Aggregation helper (pure)
// ---------------------------------------------------------------------------

function aggregateExecutions(
  executions: ExecutionSegment[],
  decisions: DecisionSegment[],
): AggregatedMetrics {
  if (executions.length === 0 && decisions.length === 0) {
    return { ...EMPTY_METRICS };
  }
  const latencies: number[] = [];
  let successCount = 0;
  let fallbackCount = 0;
  let jevErrorCount = 0;
  let constraintRejectionCount = 0;
  let totalCostUsd = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let qualitySum = 0;
  let qualityCount = 0;
  for (const e of executions) {
    if (e.latencyMs !== undefined) latencies.push(e.latencyMs);
    if (e.success) successCount += 1;
    if (e.fallback) fallbackCount += 1;
    if (e.jevError) jevErrorCount += 1;
    if (e.constraintRejected) constraintRejectionCount += 1;
    if (e.costUsd !== undefined) totalCostUsd += e.costUsd;
    if (e.promptTokens !== undefined) totalPromptTokens += e.promptTokens;
    if (e.completionTokens !== undefined) totalCompletionTokens += e.completionTokens;
    if (e.quality !== undefined) {
      qualitySum += e.quality;
      qualityCount += 1;
    }
  }
  let confidenceSum = 0;
  let confidenceCount = 0;
  for (const d of decisions) {
    if (d.confidence !== undefined) {
      confidenceSum += d.confidence;
      confidenceCount += 1;
    }
  }
  const count = executions.length;
  const avgLatencyMs = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const p95LatencyMs = percentile(latencies, 0.95);
  return {
    count,
    successCount,
    fallbackCount,
    jevErrorCount,
    constraintRejectionCount,
    avgLatencyMs,
    p95LatencyMs,
    totalCostUsd,
    totalPromptTokens,
    totalCompletionTokens,
    avgQuality: qualityCount > 0 ? qualitySum / qualityCount : 0,
    avgConfidence: confidenceCount > 0 ? confidenceSum / confidenceCount : 0,
  };
}

/** Nearest-rank percentile. Returns 0 for empty input. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}
