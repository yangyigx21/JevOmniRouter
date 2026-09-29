/**
 * 后端 API 客户端。
 *
 * 覆盖本轮新增的四大模块端点：
 * - `GET  /v1/config`          模型配置（脱敏）
 * - `GET  /v1/decision-store` 决策信息库
 * - `GET  /v1/models`         模型信息库（含决策区分度评分）
 * - `GET  /v1/history*`       历史库（按小时拆分）
 *
 * 以及路由主链：
 * - `POST /v1/routes`         创建路由（触发真实编排）
 * - `GET  /v1/routes/:id/events`  SSE 事件流（具名事件）
 */
import type { RouteEvent, RouteEventType } from '../store/types.js';

const API_BASE = import.meta.env.VITE_API_BASE || '';

/** 后端 14 类事件类型（SSE `event:` 字段）。 */
const ROUTE_EVENT_TYPES: RouteEventType[] = [
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
];

/** 统一请求：非 2xx 抛错并带上后端错误码。 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (body?.error) code = body.error;
    } catch {
      /* 响应体非 JSON，保留状态码 */
    }
    throw new Error(`${code} (${res.status})`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// 健康检查
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: string;
  uptime: number;
  version: string;
  configVersion?: string;
  jevConfigured?: boolean;
  llmLibrary?: string;
  catalogVersion?: string;
  modelCount?: number;
  decisions?: number;
}

export async function healthCheck(): Promise<HealthResponse> {
  return request<HealthResponse>('/v1/health');
}

// ---------------------------------------------------------------------------
// 路由主链
// ---------------------------------------------------------------------------

export interface CreateRoutePayload {
  prompt: string;
  modalities?: string[];
  constraints?: {
    maxLatencyMs?: number;
    budgetUsd?: number;
    allowedModelIds?: string[];
    riskLevel?: string;
  };
  consequenceClass?: string;
  catalogVersion?: string;
}

export interface CreateRouteResponse {
  requestId: string;
  status: string;
  catalogVersion: string;
  createdAt: string;
}

export async function createRoute(payload: CreateRoutePayload): Promise<CreateRouteResponse> {
  return request<CreateRouteResponse>('/v1/routes', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function fetchRouteStatus(requestId: string): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(`/v1/routes/${requestId}/status`);
}

/**
 * 订阅路由事件流（SSE）。
 *
 * 后端每条事件都带 `event: <type>` 具名字段，因此**必须**按类型
 * `addEventListener`；只挂 `onmessage` 会一条都收不到。同时保留
 * `onmessage` 作为裸 `data:` 帧的兜底。
 */
export function subscribeEvents(
  requestId: string,
  onEvent: (event: RouteEvent) => void,
  onError?: (err: Error) => void,
): EventSource {
  const es = new EventSource(`${API_BASE}/v1/routes/${requestId}/events`);

  const handle = (raw: MessageEvent): void => {
    try {
      onEvent(JSON.parse(raw.data) as RouteEvent);
    } catch (err) {
      console.warn('[jev-router] SSE 事件解析失败', err);
    }
  };

  for (const type of ROUTE_EVENT_TYPES) {
    es.addEventListener(type, handle as EventListener);
  }
  // 裸帧兜底（部分代理会剥掉 event: 字段）
  es.onmessage = handle;

  es.onerror = () => {
    // EventSource 自带重连；仅在浏览器判定连接彻底失败时上报。
    if (es.readyState === EventSource.CLOSED) {
      onError?.(new Error('SSE 连接已断开'));
      es.close();
    }
  };
  return es;
}

// ---------------------------------------------------------------------------
// 模型配置（脱敏）
// ---------------------------------------------------------------------------

export interface PublicConfig {
  configVersion: string;
  jev: { id: string; label: string; baseUrl: string; hasApiKey: boolean; timeoutMs: number };
  llmLibrary: {
    id: string;
    label: string;
    baseUrl: string;
    modelsApi: string;
    chatCompletionsApi: string;
    responsesApi: string;
    hasApiKey: boolean;
    useResponsesApi: boolean;
    timeoutMs: number;
  };
  storage: { dataDir: string; historyDir: string };
  routing: {
    preference: string;
    thresholds: { high: number; mid: number };
    maxTokens: number;
    temperature: number;
  };
}

export async function fetchConfig(): Promise<PublicConfig> {
  return request<PublicConfig>('/v1/config');
}

// ---------------------------------------------------------------------------
// 决策信息库
// ---------------------------------------------------------------------------

export interface DecisionStoreSnapshot {
  storeVersion: string;
  updatedAt: string;
  thresholds: { high: number; mid: number };
  thresholdSource: 'static' | 'dynamic';
  totals: { decisions: number; byTier: { ROUTE: number; GATE: number; ESCALATE: number } };
  models: Record<
    string,
    {
      modelId: string;
      selectedCount: number;
      candidateCount: number;
      avgProbability: number;
      avgConfidence: number;
      winRate: number;
      lastSelectedAt?: string;
      /** 业界评价评分（0..1），由每日凌晨同步任务写入；未同步则缺省。 */
      industryScore?: number;
      industryRank?: number;
      industrySource?: string;
      industryRatedAt?: string;
    }
  >;
  /** 最近一次行业评分同步摘要。 */
  industrySync?: {
    syncedAt: string;
    sourceLabel: string;
    origin: 'web' | 'api' | 'file';
    ratingsUpdatedAt: string;
    matched: number;
    unmatched: string[];
    warnings: string[];
  };
  recent: {
    requestId: string;
    decisionId: string;
    createdAt: string;
    decisionSource: string;
    confidence: number;
    routeTier: string;
    selectedModelId: string;
    jevRecommendation?: string;
    jevAnswers: { tag: string; type: string; value: string }[];
    thresholds: { high: number; mid: number };
    distribution: { modelId: string; probability: number; rankIndex: number }[];
    eliminated: { modelId: string; reason: string }[];
    resultLength: number;
    execution?: {
      modelId: string;
      latencyMs: number;
      promptTokens: number;
      completionTokens: number;
      costUsd: number;
      status: string;
      usageSource?: 'provider' | 'estimated';
      errorMessage?: string;
    };
  }[];
}

export async function fetchDecisionStore(): Promise<DecisionStoreSnapshot> {
  return request<DecisionStoreSnapshot>('/v1/decision-store');
}

// ---------------------------------------------------------------------------
// 模型信息库
// ---------------------------------------------------------------------------

export interface CatalogEntry {
  modelId: string;
  provider: string;
  /** 模型厂商标识（`deepseek` / `zhipu` / `moonshot` …）。 */
  vendor: string;
  /** 模型厂商展示名（如 `DeepSeek`）。 */
  vendorLabel: string;
  capabilityTags: string[];
  capability: number;
  quality: number;
  cost: number;
  latency: number;
  load: number;
  contextWindow?: number;
  p95LatencyMs: number;
  inputPricePer1k: number;
  outputPricePer1k: number;
  health: string;
  profileVersion: string;
  enabled: boolean;
  modalities?: string[];
}

/** 按厂商聚合的模型分组 —— 3D 星球节点数据源。 */
export interface VendorGroup {
  vendor: string;
  vendorLabel: string;
  modelCount: number;
  modelIds: string[];
  topDiscrimination: number;
}

export interface ModelInfoSnapshot {
  infoVersion: string;
  updatedAt: string;
  catalogVersion: string;
  source: 'models-api' | 'config-fallback' | 'seed-fallback';
  sourceError?: string;
  models: {
    modelId: string;
    label: string;
    fromLiveCatalog: boolean;
    profile: CatalogEntry;
    discrimination: {
      score: number;
      profileSpread: number;
      winConcentration: number;
      evidenceConfidence: number;
      coldStart: boolean;
      rating: '低' | '中' | '高' | '极高';
    };
    stats: {
      selectedCount: number;
      candidateCount: number;
      winRate: number;
      avgProbability: number;
      avgConfidence: number;
      avgLatencyMs: number;
    } | null;
    /** 业界评价评分（来自决策信息库，未同步则为 null）。 */
    industry: {
      score: number;
      rank?: number;
      source?: string;
      ratedAt?: string;
    } | null;
    updatedAt: string;
  }[];
  /** 由 `models` 按厂商聚合而来（后端 `groupByVendor`）。 */
  vendors?: VendorGroup[];
}

export async function fetchModelInfo(): Promise<ModelInfoSnapshot> {
  return request<ModelInfoSnapshot>('/v1/models');
}

export async function refreshModelInfo(): Promise<ModelInfoSnapshot> {
  return request<ModelInfoSnapshot>('/v1/models/refresh', { method: 'POST' });
}

/** 拉取按厂商聚合的模型分组（3D 星球节点直接消费）。 */
export async function fetchVendorGroups(): Promise<{
  catalogVersion: string;
  source: string;
  vendors: VendorGroup[];
}> {
  return request('/v1/models/vendors');
}

export async function fetchCatalog(): Promise<{ catalogVersion: string; entries: CatalogEntry[] }> {
  return request<{ catalogVersion: string; entries: CatalogEntry[] }>('/v1/catalog');
}

// ---------------------------------------------------------------------------
// 历史库
// ---------------------------------------------------------------------------

export interface HistoryEntryDto {
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
    /** `provider` = 网关上报；`estimated` = 网关未上报时按文本估算。 */
    usageSource?: 'provider' | 'estimated';
    errorMessage?: string;
  };
  result: string;
  eventTypes: string[];
}

export interface HistoryQueryResponse {
  total: number;
  hours: { hourBucket: string; count: number; updatedAt: string }[];
  entries: HistoryEntryDto[];
}

export async function fetchHistory(
  opts: { limit?: number; hour?: string; search?: string } = {},
): Promise<HistoryQueryResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.hour) params.set('hour', opts.hour);
  if (opts.search) params.set('search', opts.search);
  const qs = params.toString();
  return request<HistoryQueryResponse>(`/v1/history${qs ? `?${qs}` : ''}`);
}

export interface HistoryStatsResponse {
  hours: number;
  total: number;
  byTier: { ROUTE: number; GATE: number; ESCALATE: number };
  byModel: Record<string, number>;
  currentHour: string;
}

export async function fetchHistoryStats(): Promise<HistoryStatsResponse> {
  return request<HistoryStatsResponse>('/v1/history/stats');
}
