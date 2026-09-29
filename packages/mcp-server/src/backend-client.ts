/**
 * HTTP client for the JevRouter backend API.
 *
 * This module is the only place that knows about the backend's wire format.
 * It wraps the subset of endpoints the MCP tools need and, for routes, drains
 * the SSE event stream until a terminal event is observed so that callers get
 * a complete decision result instead of a fire-and-forget requestId.
 *
 * Backend endpoints used:
 *   GET  /v1/health
 *   GET  /v1/models              (model catalog + discrimination + industry)
 *   POST /v1/routes              (create route)
 *   GET  /v1/routes/:id/events   (SSE event stream)
 */
import type { McpConfig } from './config.js';

// ---------------------------------------------------------------------------
// Backend response shapes (subset actually consumed by the tools)
// ---------------------------------------------------------------------------

/** `GET /v1/health`. */
export interface BackendHealth {
  status: string;
  uptime: number;
  version: string;
  configVersion?: string;
  catalogVersion?: string;
  modelCount?: number;
  decisions?: number;
  jevConfigured?: boolean;
  llmLibrary?: string;
}

/** One model profile (MODEL-1 fields). */
export interface CatalogProfile {
  modelId: string;
  provider: string;
  vendor: string;
  vendorLabel: string;
  capabilityTags: string[];
  capability: number;
  quality: number;
  cost: number;
  latency: number;
  contextWindow: number;
  p95LatencyMs: number;
  inputPricePer1k: number;
  outputPricePer1k: number;
  health: string;
  profileVersion: string;
  enabled: boolean;
  modalities: string[];
}

/** One entry in `GET /v1/models`'s `models[]`. */
export interface ModelInfoEntry {
  modelId: string;
  label: string;
  fromLiveCatalog: boolean;
  profile: CatalogProfile;
  discrimination: {
    score: number;
    profileSpread: number;
    winConcentration: number;
    evidenceConfidence: number;
    coldStart: boolean;
    rating: string;
  };
  stats: {
    selectedCount: number;
    candidateCount: number;
    winRate: number;
    avgProbability: number;
    avgConfidence: number;
    avgLatencyMs: number;
  } | null;
  industry: {
    score: number;
    rank?: number;
    source?: string;
    ratedAt?: string;
  } | null;
  updatedAt: string;
}

/** Vendor grouping computed by the backend. */
export interface VendorGroup {
  vendor: string;
  vendorLabel: string;
  modelCount: number;
  modelIds: string[];
  topDiscrimination: number;
}

/** `GET /v1/models`. */
export interface ModelsResponse {
  infoVersion: string;
  updatedAt: string;
  catalogVersion: string;
  source: 'models-api' | 'config-fallback' | 'seed-fallback';
  sourceError?: string;
  models: ModelInfoEntry[];
  vendors: VendorGroup[];
}

/** `POST /v1/routes` response (API-1). */
export interface CreateRouteResponse {
  requestId: string;
  status: string;
  catalogVersion: string;
  createdAt: string;
}

/** Per-model accumulated decision stats (`decision-store.models[*]`). */
export interface ModelDecisionStat {
  modelId: string;
  selectedCount: number;
  candidateCount: number;
  probabilitySum: number;
  confidenceSum: number;
  latencySumMs: number;
  lastSelectedAt?: string;
  avgProbability: number;
  avgConfidence: number;
  winRate: number;
  industryScore?: number;
  industryRank?: number;
  industrySource?: string;
  industryRatedAt?: string;
}

/** `GET /v1/decision-store` — decisions DB snapshot. */
export interface DecisionStoreSnapshot {
  storeVersion: string;
  updatedAt: string;
  thresholds: { high: number; mid: number };
  thresholdSource: 'static' | 'dynamic';
  totals: { decisions: number; byTier: Record<string, number> };
  models: Record<string, ModelDecisionStat>;
  recent: DecisionRecordEntry[];
  industrySync?: {
    syncedAt: string;
    sourceLabel: string;
    origin: string;
    matched: number;
    unmatched: string[];
  };
}

/** One entry in the decisions DB `recent[]`. */
export interface DecisionRecordEntry {
  requestId: string;
  decisionId: string;
  executionId?: string;
  createdAt: string;
  decisionSource: string;
  jevAnswers: { tag: string; type: string; value: string }[];
  confidence: number;
  thresholds: { high: number; mid: number };
  routeTier: string;
  selectedModelId: string;
  jevRecommendation?: string;
  distribution: { modelId: string; probability: number; rankIndex: number }[];
  eliminated: { modelId: string; reason: string }[];
  constraintFallback?: boolean;
  constraintFallbackReason?: string;
  execution?: {
    modelId: string;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    status: string;
    errorMessage?: string;
  };
  resultLength: number;
}

/** One history entry (`GET /v1/history`). */
export interface HistoryEntry {
  requestId: string;
  decisionId: string;
  executionId?: string;
  createdAt: string;
  hourBucket: string;
  prompt: string;
  promptSummary: string;
  selectedModelId: string;
  jevRecommendation?: string;
  routeTier: string;
  confidence: number;
  thresholds: { high: number; mid: number };
  decisionSource: string;
  execution: {
    modelId: string;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    status: string;
    usageSource?: string;
    errorMessage?: string;
  };
  result: string;
  eventTypes: string[];
}

/** `GET /v1/history` response. */
export interface HistoryQueryResult {
  total: number;
  hours: { hourBucket: string; count: number; updatedAt: string }[];
  entries: HistoryEntry[];
}

/** `GET /v1/history/stats` response. */
export interface HistoryStats {
  hours: number;
  total: number;
  byTier: Record<string, number>;
  byModel: Record<string, number>;
  currentHour: string;
}

/** A single route event (EVENT-1). */
export interface RouteEvent {
  eventId: string;
  requestId: string;
  decisionId?: string;
  executionId?: string;
  type: string;
  timestamp: string;
  sequence: number;
  payload: Record<string, unknown>;
}

/** Payload from the terminal decision/execution events, lifted for convenience. */
export interface RouteOutcome {
  requestId: string;
  status: 'COMPLETED' | 'ESCALATED' | 'FAILED';
  tier: string | null;
  confidence: number | null;
  calibratedConfidence: number | null;
  thresholds: { high: number; mid: number } | null;
  decisionId: string | null;
  executionId: string | null;
  selectedModelId: string | null;
  selectionMode: string | null;
  decisionSource: string | null;
  rationale: string | null;
  winnerReason: string | null;
  jevProfile: Record<string, unknown> | null;
  jevAnswers: { tag: string; type: string; value: string }[];
  candidateScores: {
    modelId: string;
    raw: number;
    probability?: number;
    rankIndex: number;
    priorDelta?: number;
  }[];
  priorDeltas: Record<string, number> | null;
  /** Excluded models from the 8-step hard-constraint pipeline. */
  eliminated: { modelId: string; reason: string }[];
  /** Models that passed the 8-step hard-constraint pipeline (CONSTRAINT_GATE_PASSED). */
  passedModelIds: string[];
  constraintFallback: boolean;
  /** Streamed model output (all MODEL_STREAMING deltas, or terminal `result`). */
  result: string;
  usage: {
    modelId: string | null;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    usageSource: string | null;
  } | null;
  escalationReason: string | null;
  errorReason: string | null;
  errorMessage: string | null;
  events: RouteEvent[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type BackendClientErrorCode =
  | 'BACKEND_UNREACHABLE'
  | 'BACKEND_HTTP_ERROR'
  | 'ROUTE_TIMEOUT'
  | 'SSE_PARSE_ERROR';

export class BackendClientError extends Error {
  constructor(
    readonly code: BackendClientErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'BackendClientError';
  }
}

/** Terminal event types that end the SSE consumption loop. */
const TERMINAL_EVENTS = new Set(['MODEL_COMPLETED', 'ROUTE_ESCALATED', 'ROUTE_FAILED']);

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class JevBackendClient {
  constructor(
    private readonly config: McpConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** `GET /v1/health` — used as a preflight check before routing. */
  async health(): Promise<BackendHealth> {
    return this.getJson<BackendHealth>('/v1/health');
  }

  /** `GET /v1/models` — catalog + discrimination + industry ratings. */
  async models(): Promise<ModelsResponse> {
    return this.getJson<ModelsResponse>('/v1/models');
  }

  /** `GET /v1/decision-store` — decisions DB (thresholds, per-model stats, recent). */
  async decisionStore(): Promise<DecisionStoreSnapshot> {
    return this.getJson<DecisionStoreSnapshot>('/v1/decision-store');
  }

  /** `GET /v1/history` — executions, newest first, optional hour/search filter. */
  async history(opts: { limit?: number; hour?: string; search?: string } = {}): Promise<HistoryQueryResult> {
    const q = new URLSearchParams();
    if (opts.limit !== undefined) q.set('limit', String(opts.limit));
    if (opts.hour !== undefined) q.set('hour', opts.hour);
    if (opts.search !== undefined) q.set('search', opts.search);
    const suffix = q.toString() ? `?${q}` : '';
    return this.getJson<HistoryQueryResult>(`/v1/history${suffix}`);
  }

  /** `GET /v1/history/stats` — cross-hour aggregate counts. */
  async historyStats(): Promise<HistoryStats> {
    return this.getJson<HistoryStats>('/v1/history/stats');
  }

  /**
   * Create a route without waiting for it to run.
   *
   * Split out from {@link decide} so read-only tools (constraints audit, score
   * explanation) can subscribe with an early stop condition and avoid paying
   * the model-execution cost.
   */
  async createRoute(input: {
    prompt: string;
    consequenceClass?: string;
    allowedModelIds?: string[];
    maxLatencyMs?: number;
    budgetUsd?: number;
  }): Promise<CreateRouteResponse> {
    const body: Record<string, unknown> = { prompt: input.prompt, modalities: ['text'] };
    if (input.consequenceClass !== undefined) body.consequenceClass = input.consequenceClass;
    const constraints: Record<string, unknown> = {};
    if (input.allowedModelIds && input.allowedModelIds.length > 0) {
      constraints.allowedModelIds = input.allowedModelIds;
    }
    if (input.maxLatencyMs !== undefined) constraints.maxLatencyMs = input.maxLatencyMs;
    if (input.budgetUsd !== undefined) constraints.budgetUsd = input.budgetUsd;
    if (Object.keys(constraints).length > 0) body.constraints = constraints;

    return this.postJson<CreateRouteResponse>('/v1/routes', body);
  }

  /**
   * Run one full route decision and wait for a terminal event.
   *
   * Flow: `POST /v1/routes` → `GET /v1/routes/:id/events` (SSE) → drain until
   * MODEL_COMPLETED / ROUTE_ESCALATED / ROUTE_FAILED. The SSE subscription is
   * opened immediately after creation so no buffered events are missed
   * (backend replays from sequence 0 on a fresh connection).
   */
  async decide(input: {
    prompt: string;
    consequenceClass?: string;
    allowedModelIds?: string[];
    maxLatencyMs?: number;
    budgetUsd?: number;
  }): Promise<RouteOutcome> {
    const created = await this.createRoute(input);
    return this.collectUntilTerminal(created.requestId);
  }

  /**
   * Drain the SSE event stream for `requestId` until a stop event arrives.
   *
   * @param stopAfter Event types that end the loop. Defaults to the terminal
   *                  set (MODEL_COMPLETED / ROUTE_ESCALATED / ROUTE_FAILED).
   *                  Read-only tools pass an earlier event (e.g.
   *                  `JEV_DECISION_READY`) to skip model execution entirely.
   *
   * Uses `AbortController` + a deadline so a wedged backend cannot block the
   * MCP tool forever.
   */
  async collectUntilTerminal(
    requestId: string,
    stopAfter?: readonly string[],
  ): Promise<RouteOutcome> {
    const stop = stopAfter && stopAfter.length > 0 ? new Set(stopAfter) : TERMINAL_EVENTS;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.config.routeTimeoutMs);
    const events: RouteEvent[] = [];
    let resultText = '';

    try {
      const res = await this.fetchImpl(`${this.config.backendUrl}/v1/routes/${encodeURIComponent(requestId)}/events`, {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new BackendClientError(
          'BACKEND_HTTP_ERROR',
          `SSE stream returned HTTP ${res.status} for ${requestId}`,
        );
      }
      if (!res.body) {
        throw new BackendClientError('SSE_PARSE_ERROR', 'SSE response has no readable body');
      }

      for await (const event of parseSSE(res.body)) {
        events.push(event);
        if (event.type === 'MODEL_STREAMING') {
          const delta = event.payload.delta;
          if (typeof delta === 'string') resultText += delta;
        }
        if (TERMINAL_EVENTS.has(event.type)) {
          if (event.type === 'MODEL_COMPLETED' && typeof event.payload.result === 'string') {
            // Terminal payload carries the authoritative full text; prefer it
            // when SSE deltas were partial (reconnect / proxy buffering).
            if (event.payload.result.length >= resultText.length) {
              resultText = event.payload.result;
            }
          }
        }
        if (stop.has(event.type)) {
          break;
        }
      }
    } catch (err) {
      if (isAbortFromDeadline(err)) {
        throw new BackendClientError(
          'ROUTE_TIMEOUT',
          `Route ${requestId} did not reach a terminal event within ${this.config.routeTimeoutMs}ms`,
          { events: events.map((e) => e.type) },
        );
      }
      if (err instanceof BackendClientError) throw err;
      throw new BackendClientError(
        'BACKEND_UNREACHABLE',
        `Failed to read SSE stream for ${requestId}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    return summarize(requestId, events, resultText);
  }

  // -------------------------------------------------------------------------
  // HTTP helpers
  // -------------------------------------------------------------------------

  private async getJson<T>(path: string): Promise<T> {
    return this.requestJson<T>(path, { method: 'GET' });
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    return this.requestJson<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async requestJson<T>(path: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.backendUrl}${path}`, init);
    } catch (err) {
      throw new BackendClientError(
        'BACKEND_UNREACHABLE',
        `Cannot reach backend at ${this.config.backendUrl}${path}: ${err instanceof Error ? err.message : String(err)}. Is the backend running?`,
        err,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new BackendClientError(
        'BACKEND_HTTP_ERROR',
        `${init.method ?? 'GET'} ${path} → HTTP ${res.status}: ${text.slice(0, 500)}`,
      );
    }
    return (await res.json()) as T;
  }
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

function isAbortFromDeadline(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message));
}

/**
 * Minimal WHATWG-compliant SSE parser over a `ReadableStream<Uint8Array>`.
 *
 * Multi-line `data:` fields are joined with `\n`; comment lines (`:`) and
 * unknown fields are ignored. Yields one parsed {@link RouteEvent} per event
 * block whose `data` is valid JSON.
 */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<RouteEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSSEBlock(chunk);
        if (event) yield event;
        boundary = buffer.indexOf('\n\n');
      }
    }
    // Flush a trailing block without the terminating blank line.
    const trailing = parseSSEBlock(buffer);
    if (trailing) yield trailing;
  } finally {
    reader.releaseLock();
  }
}

function parseSSEBlock(chunk: string): RouteEvent | null {
  const dataLines: string[] = [];
  for (const rawLine of chunk.split(/\r?\n/)) {
    if (rawLine === '' || rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    if (field !== 'data') continue;
    let value = colon === -1 ? '' : rawLine.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  const json = dataLines.join('\n');
  try {
    const parsed = JSON.parse(json) as RouteEvent;
    if (typeof parsed?.type !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Outcome summarization
// ---------------------------------------------------------------------------

/** Fold the raw event list into a flat, tool-friendly outcome. */
export function summarize(requestId: string, events: RouteEvent[], streamedText: string): RouteOutcome {
  const byType = (type: string): RouteEvent | undefined => events.find((e) => e.type === type);
  const decisionReady = byType('JEV_DECISION_READY');
  const selected = byType('MODEL_SELECTED');
  const completed = byType('MODEL_COMPLETED');
  const escalated = byType('ROUTE_ESCALATED');
  const failed = byType('ROUTE_FAILED');
  const gate = byType('CONSTRAINT_GATE_PASSED');

  const filtered = events.filter((e) => e.type === 'CONSTRAINT_FILTERED');
  const eliminated = filtered.map((e) => {
    const ids = (e.payload.excludedModelIds as string[] | undefined) ?? [];
    const reasons = (e.payload.reason as Record<string, string> | undefined) ?? {};
    const modelId = ids[0] ?? (e.payload.modelId as string | undefined) ?? 'unknown';
    return { modelId, reason: reasons[modelId] ?? 'UNKNOWN' };
  });

  const status: RouteOutcome['status'] = failed
    ? 'FAILED'
    : escalated && !completed
      ? 'ESCALATED'
      : 'COMPLETED';

  return {
    requestId,
    status,
    tier: asString(decisionReady?.payload.routeTier) ?? asString(selected?.payload.routeTier),
    confidence: asNumber(decisionReady?.payload.confidence),
    calibratedConfidence: asNumber(decisionReady?.payload.calibratedConfidence),
    thresholds: asThresholds(decisionReady?.payload.thresholds),
    decisionId: decisionReady?.decisionId ?? selected?.decisionId ?? null,
    executionId: completed?.executionId ?? null,
    selectedModelId:
      asString(selected?.payload.modelId) ?? asString(completed?.payload.modelId) ?? null,
    selectionMode: asString(selected?.payload.selectionMode),
    decisionSource: asString(decisionReady?.payload.decisionSource),
    rationale: asString(decisionReady?.payload.rationale),
    winnerReason: asString(decisionReady?.payload.winnerReason),
    jevProfile: asRecord(decisionReady?.payload.jevProfile),
    jevAnswers: asAnswers(decisionReady?.payload.answers),
    candidateScores: asCandidateScores(decisionReady?.payload.candidateScores),
    priorDeltas: asDeltaRecord(decisionReady?.payload.priorDeltas),
    eliminated,
    passedModelIds: asStringArray(gate?.payload.passedModelIds),
    constraintFallback: gate?.payload.constraintFallback === true,
    result: completed && typeof completed.payload.result === 'string' ? completed.payload.result : streamedText,
    usage: completed
      ? {
          modelId: asString(completed.payload.modelId),
          latencyMs: asNumber(completed.payload.latencyMs) ?? 0,
          promptTokens: asNumber(completed.payload.promptTokens) ?? 0,
          completionTokens: asNumber(completed.payload.completionTokens) ?? 0,
          costUsd: asNumber(completed.payload.costUsd) ?? 0,
          usageSource: asString(completed.payload.usageSource),
        }
      : null,
    escalationReason: asString(escalated?.payload.reason),
    errorReason: asString(failed?.payload.reason),
    errorMessage: asString(failed?.payload.message),
    events,
  };
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
function asThresholds(v: unknown): { high: number; mid: number } | null {
  const r = asRecord(v);
  if (!r) return null;
  const high = asNumber(r.high);
  const mid = asNumber(r.mid);
  return high !== null && mid !== null ? { high, mid } : null;
}
function asAnswers(v: unknown): { tag: string; type: string; value: string }[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((item) => {
      const r = asRecord(item);
      if (!r) return null;
      return {
        tag: String(r.tag ?? ''),
        type: String(r.type ?? ''),
        value: String(r.value ?? ''),
      };
    })
    .filter((x): x is { tag: string; type: string; value: string } => x !== null);
}
function asCandidateScores(v: unknown): RouteOutcome['candidateScores'] {
  if (!Array.isArray(v)) return [];
  return v
    .map((item) => {
      const r = asRecord(item);
      if (!r) return null;
      return {
        modelId: String(r.modelId ?? ''),
        raw: asNumber(r.raw) ?? 0,
        ...(asNumber(r.probability) !== null ? { probability: asNumber(r.probability) as number } : {}),
        rankIndex: asNumber(r.rankIndex) ?? 0,
        ...(asNumber(r.priorDelta) !== null ? { priorDelta: asNumber(r.priorDelta) as number } : {}),
      };
    })
    .filter((x): x is RouteOutcome['candidateScores'][number] => x !== null);
}
function asDeltaRecord(v: unknown): Record<string, number> | null {
  // The backend emits `priorDeltas` indexed by catalogIndex (an array).
  if (Array.isArray(v)) {
    const out: Record<string, number> = {};
    v.forEach((val, i) => {
      const n = asNumber(val);
      if (n !== null) out[String(i)] = n;
    });
    return out;
  }
  const r = asRecord(v);
  if (!r) return null;
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(r)) {
    const n = asNumber(val);
    if (n !== null) out[k] = n;
  }
  return out;
}
