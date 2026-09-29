/**
 * @module app-config
 * @implements LLM-sdd.md 一、模型配置文件
 *
 * 模型配置加载器 —— 读取 `config/models.json`，供代码实际执行调用。
 *
 * 职责：
 * - 加载并校验模型配置文件（Jev System One + LLM 模型库）
 * - 端点归一化（相对路径 → 绝对 URL；`/v1/models` 与 baseUrl 去重）
 * - 环境变量覆盖（`JEV_API_KEY` / `LLM_API_KEY` 等），便于部署时不出现在磁盘
 * - 提供**脱敏**视图（`toPublicConfig`），满足约束 C3「前端 SHALL NOT 接收密钥」
 * - 提供模型画像推断（`inferModelProfile`），为模型信息库补全 capability/quality 等维度
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HealthStatus, CatalogEntry } from './model-catalog.js';
import type { WebRatingsConfig } from './web-ratings.js';

// ---------------------------------------------------------------------------
// 配置形状
// ---------------------------------------------------------------------------

/** Jev System One 连接配置。 */
export interface JevEndpointConfig {
  id: string;
  label: string;
  /** Jev System One 端点，如 `https://api.typesafe.ai/v1/systemone`。 */
  baseUrl: string;
  apiKey: string;
  authHeader: string;
  authScheme: string;
  timeoutMs: number;
  maxRetries: number;
}

/** LLM 模型库（OpenAI 兼容网关）连接配置。 */
export interface LlmLibraryConfig {
  id: string;
  label: string;
  apiKey: string;
  /** 基础 URL，如 `http://127.0.0.1:8788/v1`。 */
  baseUrl: string;
  /** 模型清单 API（绝对或相对 baseUrl）。 */
  modelsApi: string;
  /** Chat Completions API 路径。 */
  chatCompletionsApi: string;
  /** Responses API 路径。 */
  responsesApi: string;
  authHeader: string;
  authScheme: string;
  timeoutMs: number;
  maxRetries: number;
  /** true 时优先使用 Responses API，false 使用 Chat Completions。 */
  useResponsesApi: boolean;
}

/** 持久化位置配置。 */
export interface StorageConfig {
  dataDir: string;
  decisionStoreFile: string;
  modelInfoFile: string;
  historyDir: string;
}

/** 路由策略配置。 */
export interface RoutingConfig {
  preference: 'economy' | 'balanced' | 'quality';
  thresholds: { high: number; mid: number };
  maxTokens: number;
  temperature: number;
}

/**
 * 行业评分数据源配置 —— 模型清单每日同步用的「业界评价」入口。
 *
 * 三级来源，前者可用即不再往后：
 * 1. `web`  —— 互联网公开榜单（默认 LMArena 总榜，见 `web-ratings.ts`）
 * 2. `api`  —— GET 该 URL，返回 `IndustryRatingsPayload` 结构
 * 3. `file` —— 读取该 JSON 文件（相对 `configDir`），离线回落或人工覆盖
 *
 * 三者都取不到时，同步任务只刷新清单，**保留**决策库中已有的行业评分。
 */
export interface IndustryRatingsConfig {
  /** 互联网榜单来源。 */
  web: WebRatingsConfig;
  /** 行业评分文件（相对 `configDir`）。 */
  file: string;
  /** 可选行业评分 API（绝对 URL）；配置后作为 web 的次级回落。 */
  api: string;
  /** 通用 API / 文件来源的请求超时（ms）。 */
  timeoutMs: number;
}

/** 模型清单刷新 + 行业评分同步配置。 */
export interface ModelScoringConfig {
  /** 是否启用每日同步定时任务。 */
  enabled: boolean;
  /** 每日同步时刻（本地时间，`HH:mm`）。 */
  dailySyncAt: string;
  /** 距上次实时拉取超过该间隔则重拉清单；`0` = 不自动重拉（只读快照）。 */
  catalogRefreshTtlMs: number;
  /** 拉取 Models API 的超时上限（ms）——避免网关挂起拖死页面请求。 */
  catalogFetchTimeoutMs: number;
  industryRatings: IndustryRatingsConfig;
}

/** 完整模型配置（对应 `config/models.json`）。 */
export interface AppConfig {
  configVersion: string;
  description?: string;
  jev: JevEndpointConfig;
  llmLibrary: LlmLibraryConfig;
  storage: StorageConfig;
  routing: RoutingConfig;
  modelScoring: ModelScoringConfig;
  /** 配置文件所在目录（解析相对 dataDir 用）。 */
  configDir: string;
}

/** 脱敏后的公开配置（可安全返回前端）。 */
export interface PublicAppConfig {
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
  routing: RoutingConfig;
}

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

const DEFAULT_JEV: JevEndpointConfig = {
  id: 'typesafe-system-one',
  label: 'TypeSafe Jev (System One)',
  baseUrl: 'https://api.typesafe.ai/v1/systemone',
  apiKey: '',
  authHeader: 'Authorization',
  authScheme: 'Bearer',
  timeoutMs: 30_000,
  maxRetries: 1,
};

const DEFAULT_LLM: LlmLibraryConfig = {
  id: 'local-llm-gateway',
  label: 'LLM 模型库 (OpenAI 兼容网关)',
  apiKey: '',
  baseUrl: 'http://127.0.0.1:8788/v1',
  modelsApi: '',
  chatCompletionsApi: '/v1/chat/completions',
  responsesApi: '/v1/responses',
  authHeader: 'Authorization',
  authScheme: 'Bearer',
  timeoutMs: 120_000,
  maxRetries: 1,
  useResponsesApi: false,
};

const DEFAULT_STORAGE: StorageConfig = {
  dataDir: './data',
  decisionStoreFile: 'decision-store.json',
  modelInfoFile: 'model-info.json',
  historyDir: 'history',
};

const DEFAULT_ROUTING: RoutingConfig = {
  preference: 'balanced',
  thresholds: { high: 0.82, mid: 0.6 },
  maxTokens: 1024,
  temperature: 0.3,
};

const DEFAULT_MODEL_SCORING: ModelScoringConfig = {
  enabled: true,
  dailySyncAt: '00:00',
  catalogRefreshTtlMs: 5 * 60 * 1000,
  catalogFetchTimeoutMs: 8_000,
  industryRatings: {
    web: {
      enabled: true,
      // LMArena（Chatbot Arena）总榜，经 HuggingFace Datasets Server 读取。
      url: 'https://datasets-server.huggingface.co/rows?dataset=lmarena-ai%2Fleaderboard-dataset&config=text&split=latest',
      maxPages: 3,
      pageSize: 100,
      timeoutMs: 15_000,
    },
    file: 'industry-ratings.json',
    api: '',
    timeoutMs: 8_000,
  },
};

const DAILY_SYNC_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

// ---------------------------------------------------------------------------
// 端点归一化
// ---------------------------------------------------------------------------

/** 去掉 baseUrl 末尾的斜杠。 */
function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * 把 baseUrl 与一个端点片段拼成绝对 URL。
 *
 * 规则：
 * - 端点已是绝对 URL → 原样返回
 * - baseUrl 以 `/v1` 结尾且端点也以 `/v1` 开头 → 去掉重复的 `/v1` 前缀
 * - 其他情况 → 简单拼接（baseUrl 末尾斜杠已裁掉）
 */
export function resolveEndpoint(baseUrl: string, endpoint: string): string {
  const base = trimSlash(baseUrl);
  const ep = endpoint.trim();
  if (/^https?:\/\//i.test(ep)) return ep;
  if (!ep) return base;
  const lead = ep.startsWith('/') ? ep : `/${ep}`;
  if (/\/v1$/i.test(base) && /^\/v1(\/|$)/i.test(lead)) {
    return `${base}${lead.slice(3)}`;
  }
  return `${base}${lead}`;
}

// ---------------------------------------------------------------------------
// 加载
// ---------------------------------------------------------------------------

/** 默认配置文件路径：`<backend>/config/models.json`。 */
export function defaultConfigPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ 或 dist/ 的上一级即 backend 包根
  return resolve(here, '..', 'config', 'models.json');
}

/** 配置错误码。 */
export type ConfigErrorCode = 'CONFIG_NOT_FOUND' | 'CONFIG_INVALID' | 'CONFIG_INCOMPLETE';

export class ConfigError extends Error {
  constructor(
    readonly code: ConfigErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'ConfigError';
  }
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 从已解析的 JSON 对象构建 `AppConfig`，并应用环境变量覆盖。
 *
 * 环境变量覆盖（部署时无需改磁盘配置）：
 * - `JEV_BASE_URL` / `JEV_API_KEY`
 * - `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODELS_API`
 * - `INDUSTRY_RATINGS_API`（行业评分数据源 URL）
 * - `JEV_DATA_DIR`
 */
export function buildConfig(
  raw: unknown,
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new ConfigError('CONFIG_INVALID', 'models.json MUST be a JSON object');
  }
  const o = raw as Record<string, unknown>;
  const jevRaw = (o.jev ?? {}) as Record<string, unknown>;
  const llmRaw = (o.llmLibrary ?? {}) as Record<string, unknown>;
  const storageRaw = (o.storage ?? {}) as Record<string, unknown>;
  const routingRaw = (o.routing ?? {}) as Record<string, unknown>;
  const thresholdsRaw = (routingRaw.thresholds ?? {}) as Record<string, unknown>;

  const jevBaseUrl = str(env.JEV_BASE_URL, str(jevRaw.baseUrl, DEFAULT_JEV.baseUrl));
  const llmBaseUrl = str(env.LLM_BASE_URL, str(llmRaw.baseUrl, DEFAULT_LLM.baseUrl));

  const jev: JevEndpointConfig = {
    id: str(jevRaw.id, DEFAULT_JEV.id),
    label: str(jevRaw.label, DEFAULT_JEV.label),
    baseUrl: trimSlash(jevBaseUrl),
    apiKey: str(env.JEV_API_KEY, str(jevRaw.apiKey, DEFAULT_JEV.apiKey)),
    authHeader: str(jevRaw.authHeader, DEFAULT_JEV.authHeader),
    authScheme: str(jevRaw.authScheme, DEFAULT_JEV.authScheme),
    timeoutMs: num(jevRaw.timeoutMs, DEFAULT_JEV.timeoutMs),
    maxRetries: num(jevRaw.maxRetries, DEFAULT_JEV.maxRetries),
  };

  const modelsApiRaw = str(env.LLM_MODELS_API, str(llmRaw.modelsApi, ''));
  const llmLibrary: LlmLibraryConfig = {
    id: str(llmRaw.id, DEFAULT_LLM.id),
    label: str(llmRaw.label, DEFAULT_LLM.label),
    apiKey: str(env.LLM_API_KEY, str(llmRaw.apiKey, DEFAULT_LLM.apiKey)),
    baseUrl: trimSlash(llmBaseUrl),
    modelsApi: modelsApiRaw
      ? resolveEndpoint(llmBaseUrl, modelsApiRaw)
      : resolveEndpoint(llmBaseUrl, '/models'),
    chatCompletionsApi: resolveEndpoint(
      llmBaseUrl,
      str(llmRaw.chatCompletionsApi, DEFAULT_LLM.chatCompletionsApi),
    ),
    responsesApi: resolveEndpoint(
      llmBaseUrl,
      str(llmRaw.responsesApi, DEFAULT_LLM.responsesApi),
    ),
    authHeader: str(llmRaw.authHeader, DEFAULT_LLM.authHeader),
    authScheme: str(llmRaw.authScheme, DEFAULT_LLM.authScheme),
    timeoutMs: num(llmRaw.timeoutMs, DEFAULT_LLM.timeoutMs),
    maxRetries: num(llmRaw.maxRetries, DEFAULT_LLM.maxRetries),
    useResponsesApi: llmRaw.useResponsesApi === true,
  };

  const storage: StorageConfig = {
    dataDir: str(env.JEV_DATA_DIR, str(storageRaw.dataDir, DEFAULT_STORAGE.dataDir)),
    decisionStoreFile: str(
      storageRaw.decisionStoreFile,
      DEFAULT_STORAGE.decisionStoreFile,
    ),
    modelInfoFile: str(storageRaw.modelInfoFile, DEFAULT_STORAGE.modelInfoFile),
    historyDir: str(storageRaw.historyDir, DEFAULT_STORAGE.historyDir),
  };

  const preferenceRaw = str(routingRaw.preference, DEFAULT_ROUTING.preference);
  const preference =
    preferenceRaw === 'economy' || preferenceRaw === 'quality' || preferenceRaw === 'balanced'
      ? preferenceRaw
      : DEFAULT_ROUTING.preference;

  const routing: RoutingConfig = {
    preference,
    thresholds: {
      high: num(thresholdsRaw.high, DEFAULT_ROUTING.thresholds.high),
      mid: num(thresholdsRaw.mid, DEFAULT_ROUTING.thresholds.mid),
    },
    maxTokens: num(routingRaw.maxTokens, DEFAULT_ROUTING.maxTokens),
    temperature: num(routingRaw.temperature, DEFAULT_ROUTING.temperature),
  };

  if (routing.thresholds.mid > routing.thresholds.high) {
    throw new ConfigError(
      'CONFIG_INCOMPLETE',
      `routing.thresholds.mid (${routing.thresholds.mid}) MUST be ≤ high (${routing.thresholds.high})`,
    );
  }

  const scoringRaw = (o.modelScoring ?? {}) as Record<string, unknown>;
  const ratingsRaw = (scoringRaw.industryRatings ?? {}) as Record<string, unknown>;
  const webRaw = (ratingsRaw.web ?? {}) as Record<string, unknown>;
  const dailySyncAt = str(scoringRaw.dailySyncAt, DEFAULT_MODEL_SCORING.dailySyncAt);
  if (!DAILY_SYNC_PATTERN.test(dailySyncAt)) {
    throw new ConfigError(
      'CONFIG_INCOMPLETE',
      `modelScoring.dailySyncAt MUST match HH:mm (got "${dailySyncAt}")`,
    );
  }
  const modelScoring: ModelScoringConfig = {
    enabled: bool(scoringRaw.enabled, DEFAULT_MODEL_SCORING.enabled),
    dailySyncAt,
    catalogRefreshTtlMs: num(
      scoringRaw.catalogRefreshTtlMs,
      DEFAULT_MODEL_SCORING.catalogRefreshTtlMs,
    ),
    catalogFetchTimeoutMs: num(
      scoringRaw.catalogFetchTimeoutMs,
      DEFAULT_MODEL_SCORING.catalogFetchTimeoutMs,
    ),
    industryRatings: {
      web: {
        enabled: bool(webRaw.enabled, DEFAULT_MODEL_SCORING.industryRatings.web.enabled),
        url: str(webRaw.url, DEFAULT_MODEL_SCORING.industryRatings.web.url),
        maxPages: num(webRaw.maxPages, DEFAULT_MODEL_SCORING.industryRatings.web.maxPages),
        pageSize: num(webRaw.pageSize, DEFAULT_MODEL_SCORING.industryRatings.web.pageSize),
        timeoutMs: num(webRaw.timeoutMs, DEFAULT_MODEL_SCORING.industryRatings.web.timeoutMs),
      },
      file: str(ratingsRaw.file, DEFAULT_MODEL_SCORING.industryRatings.file),
      api: str(env.INDUSTRY_RATINGS_API, str(ratingsRaw.api, '')),
      timeoutMs: num(ratingsRaw.timeoutMs, DEFAULT_MODEL_SCORING.industryRatings.timeoutMs),
    },
  };

  if (!llmLibrary.apiKey) {
    throw new ConfigError(
      'CONFIG_INCOMPLETE',
      'llmLibrary.apiKey MUST be non-empty (set in config/models.json or env LLM_API_KEY)',
    );
  }

  return {
    configVersion: str(o.configVersion, '0.0.0'),
    description: typeof o.description === 'string' ? o.description : undefined,
    jev,
    llmLibrary,
    storage,
    routing,
    modelScoring,
    configDir,
  };
}

/** 解析绝对数据目录（相对路径以 configDir 为基准）。 */
export function resolveDataDir(config: AppConfig): string {
  const dir = config.storage.dataDir;
  return isAbsolute(dir) ? dir : resolve(config.configDir, dir);
}

/** 解析行业评分文件的绝对路径（相对 configDir）。 */
export function resolveRatingsFile(config: AppConfig): string {
  const file = config.modelScoring.industryRatings.file;
  return isAbsolute(file) ? file : resolve(config.configDir, file);
}

/**
 * 加载模型配置。
 *
 * @param path 配置文件路径；缺省 `<backend>/config/models.json`
 * @throws ConfigError('CONFIG_NOT_FOUND') 文件不存在
 * @throws ConfigError('CONFIG_INVALID') JSON 解析失败
 * @throws ConfigError('CONFIG_INCOMPLETE') 必填项缺失
 */
export function loadConfig(path: string = defaultConfigPath()): AppConfig {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(abs)) {
    throw new ConfigError('CONFIG_NOT_FOUND', `Model config not found at ${abs}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `Failed to parse ${abs}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return buildConfig(raw, dirname(abs));
}

// ---------------------------------------------------------------------------
// 脱敏（C3）
// ---------------------------------------------------------------------------

/** 生成脱敏后的公开配置 —— 任何返回前端的 payload  MUST 使用本函数。 */
export function toPublicConfig(config: AppConfig): PublicAppConfig {
  return {
    configVersion: config.configVersion,
    jev: {
      id: config.jev.id,
      label: config.jev.label,
      baseUrl: config.jev.baseUrl,
      hasApiKey: config.jev.apiKey !== '',
      timeoutMs: config.jev.timeoutMs,
    },
    llmLibrary: {
      id: config.llmLibrary.id,
      label: config.llmLibrary.label,
      baseUrl: config.llmLibrary.baseUrl,
      modelsApi: config.llmLibrary.modelsApi,
      chatCompletionsApi: config.llmLibrary.chatCompletionsApi,
      responsesApi: config.llmLibrary.responsesApi,
      hasApiKey: config.llmLibrary.apiKey !== '',
      useResponsesApi: config.llmLibrary.useResponsesApi,
      timeoutMs: config.llmLibrary.timeoutMs,
    },
    storage: {
      dataDir: config.storage.dataDir,
      historyDir: config.storage.historyDir,
    },
    routing: config.routing,
  };
}

// ---------------------------------------------------------------------------
// 模型画像推断
// ---------------------------------------------------------------------------

/** 关键词 → capabilityTags 规则（用于从模型名/描述推断能力画像）。 */
const TAG_RULES: { tag: string; patterns: RegExp[] }[] = [
  { tag: 'code', patterns: [/cod|program|dev|repo|qwen|deepseek|coder/i] },
  { tag: 'reasoning', patterns: [/reason|think|o1|o3|qwq|math|logic|step/i] },
  { tag: 'vision', patterns: [/vision|vl|multimodal|image|4o|gemini|llava/i] },
  { tag: 'creative', patterns: [/creative|write|poet|story|nova|hermes/i] },
  { tag: 'long-context', patterns: [/long|128k|200k|1m|context|ultra/i] },
  { tag: 'low-cost', patterns: [/mini|small|nano|flash|lite|haiku|tiny|7b|8b/i] },
];

// ---------------------------------------------------------------------------
// 厂商推断
// ---------------------------------------------------------------------------

/**
 * 模型厂商规则。
 *
 * 网关返回的 `owned_by`（恒为 `workbuddy`）与 `vendor`（单字母分片标记）
 * 都**不是**真实厂商，因此按「模型名 + 展示名 + 描述」做关键词匹配。
 * 顺序即优先级：先匹配到的厂商胜出。
 */
const VENDOR_RULES: { vendor: string; label: string; patterns: RegExp[] }[] = [
  { vendor: 'deepseek', label: 'DeepSeek', patterns: [/deepseek|深度求索/i] },
  { vendor: 'zhipu', label: '智谱 GLM', patterns: [/^glm|zhipu|chatglm|智谱/i] },
  { vendor: 'moonshot', label: '月之暗面 Kimi', patterns: [/kimi|moonshot|月之暗面/i] },
  { vendor: 'minimax', label: 'MiniMax', patterns: [/minimax|稀宇/i] },
  {
    vendor: 'tencent',
    label: '腾讯混元',
    patterns: [/(^|[\s\-_/])hy\d|hunyuan|混元|tencent|腾讯/i],
  },
  { vendor: 'openai', label: 'OpenAI', patterns: [/^gpt|^o\d|openai|chatgpt|^davinci/i] },
  { vendor: 'anthropic', label: 'Anthropic', patterns: [/claude|anthropic/i] },
  { vendor: 'google', label: 'Google', patterns: [/gemini|gemma|google/i] },
  { vendor: 'meta', label: 'Meta', patterns: [/^llama|meta/i] },
  { vendor: 'mistral', label: 'Mistral', patterns: [/mistral|mixtral|codestral/i] },
  { vendor: 'alibaba', label: '阿里通义', patterns: [/qwen|qwq|tongyi|通义|alibaba/i] },
  { vendor: 'xai', label: 'xAI', patterns: [/grok|^xai/i] },
  { vendor: 'cohere', label: 'Cohere', patterns: [/command-r|cohere/i] },
];

/** 未命中任何规则时的兜底厂商。 */
const VENDOR_FALLBACK = { vendor: 'other', label: '其他厂商' } as const;

/**
 * 推断模型厂商。
 *
 * @param haystack 模型 id + 展示名 + 描述（调用方拼好）
 */
export function inferVendor(haystack: string): { vendor: string; label: string } {
  for (const rule of VENDOR_RULES) {
    if (rule.patterns.some((p) => p.test(haystack))) {
      return { vendor: rule.vendor, label: rule.label };
    }
  }
  return { ...VENDOR_FALLBACK };
}

/**
 * 补齐厂商字段（磁盘缓存回落时用 —— 旧版 `model-info.json` 没有这两项）。
 */
export function ensureVendorFields<T extends { modelId: string; vendor: string; vendorLabel: string }>(
  entry: T,
): T {
  if (entry.vendor && entry.vendorLabel) return entry;
  return { ...entry, ...inferVendor(entry.modelId) };
}

/** Models API 返回的模型元数据（本项目网关提供的字段子集）。 */
export interface ModelApiMetadata {
  name?: string;
  description?: string;
  owned_by?: string;
  vendor?: string;
  context_length?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_completion_tokens?: number;
  input_modalities?: string[];
  output_modalities?: string[];
  supports_vision?: boolean;
  supports_reasoning?: boolean;
  supports_tool_calls?: boolean;
  always_reasoning?: boolean;
  reasoning_efforts?: string[];
  capabilities?: Record<string, boolean>;
  temperature?: number;
}

/**
 * 推导模型能力画像。
 *
 * 优先使用 Models API 返回的**真实元数据**（能力标记 / 模态 / 上下文窗口 /
 * 思考能力），仅在元数据缺失时才回退到「模型名 + 描述」的关键词推断。这样
 * 同一网关下不同模型能拉开画像差异，决策区分度评分才有意义。
 *
 * 各维度的来源与语义：
 * - `capabilityTags`：能力标记（reasoning / vision / code / tool-call）+
 *   关键词补充（code / creative / low-cost / long-context）
 * - `capability`：能力面广度（多模态 + 工具调用 + 推理 → 更高）
 * - `quality`：推理强度 + 上下文规模 + 输出上限的综合上限
 * - `cost`：网关未给价格，按「同厂商同代际」的中性定价估算
 * - `latency`：always_reasoning / 高 effort 的模型更慢
 */
export function inferModelProfile(input: {
  modelId: string;
  meta?: ModelApiMetadata;
  contextWindow?: number;
  description?: string;
}): Pick<
  CatalogEntry,
  | 'capabilityTags'
  | 'capability'
  | 'quality'
  | 'cost'
  | 'latency'
  | 'contextWindow'
  | 'health'
  | 'p95LatencyMs'
  | 'inputPricePer1k'
  | 'outputPricePer1k'
  | 'modalities'
  | 'dataRegion'
  | 'vendor'
  | 'vendorLabel'
> {
  const meta = input.meta ?? {};
  const haystack = `${input.modelId} ${meta.name ?? ''} ${meta.description ?? input.description ?? ''}`;
  const isVision =
    meta.supports_vision === true ||
    meta.capabilities?.vision === true ||
    (meta.input_modalities ?? []).some((m) => m === 'image' || m === 'video');
  const isReasoning =
    meta.supports_reasoning === true ||
    meta.capabilities?.reasoning === true ||
    meta.always_reasoning === true ||
    (meta.reasoning_efforts ?? []).length > 0;
  const isTool = meta.supports_tool_calls === true || meta.capabilities?.tool_calls === true;

  const capabilityTags: string[] = [];
  if (isReasoning) capabilityTags.push('reasoning');
  if (isVision) capabilityTags.push('vision');
  if (isTool) capabilityTags.push('tool-call');
  for (const rule of TAG_RULES) {
    if (capabilityTags.includes(rule.tag)) continue;
    if (rule.patterns.some((p) => p.test(haystack))) capabilityTags.push(rule.tag);
  }
  if (capabilityTags.length === 0) capabilityTags.push('general');

  const contextWindow =
    input.contextWindow ??
    firstPositive(meta.max_input_tokens, meta.context_length) ??
    32_000;
  const maxOutput = firstPositive(meta.max_output_tokens, meta.max_completion_tokens) ?? 4096;

  // 规模因子：模型名里的参数量级（7b/8b → 小，70b/405b → 大）；无名参数时按 0.55 中位
  const sizeMatch = haystack.match(/(\d+(?:\.\d+)?)\s*b\b/i);
  const sizeB = sizeMatch ? Number(sizeMatch[1]) : 0;
  const scale = sizeB === 0 ? 0.55 : Math.min(1, Math.log10(Math.max(sizeB, 1)) / log10(400));

  // 上下文与输出上限贡献「能力上限」
  const ctxScore = clamp01(Math.log10(Math.max(contextWindow, 1024)) / 6); // 1K→0.5, 1M→1
  const outScore = clamp01(Math.log10(Math.max(maxOutput, 256)) / 5); // 256→0.4, 64K→1

  const capability = clamp01(
    0.34 +
      0.18 * scale +
      0.14 * (isReasoning ? 1 : 0) +
      0.12 * (isVision ? 1 : 0) +
      0.1 * (isTool ? 1 : 0) +
      0.12 * ctxScore,
  );
  const quality = clamp01(0.3 + 0.28 * scale + 0.16 * (isReasoning ? 1 : 0) + 0.14 * outScore + 0.12 * ctxScore);
  const hasLowCost = capabilityTags.includes('low-cost');
  const cost = clamp01(hasLowCost ? 0.1 + 0.12 * (1 - scale) : 0.4 + 0.35 * scale);
  // 思考型模型首 token 更慢；输出上限越大越慢
  const latency = clamp01(
    0.2 + (meta.always_reasoning ? 0.3 : 0) + 0.25 * outScore + (hasLowCost ? -0.08 : 0.08),
  );

  const modalities: CatalogEntry['modalities'] = isVision ? ['text', 'image'] : ['text'];

  const { vendor, label: vendorLabel } = inferVendor(haystack);

  // 免费模型名单：inputPricePer1k=0 && outputPricePer1k=0
  // ESCALATE 档位优先选择免费模型（人工决策场景降本）
  const FREE_MODEL_PATTERNS = [/^hy[34]/i, /^deepseek/i];
  const isFreeModel = FREE_MODEL_PATTERNS.some((p) => p.test(input.modelId));

  return {
    capabilityTags,
    capability: round2(capability),
    quality: round2(quality),
    cost: round2(cost),
    latency: round2(Math.max(0.05, latency)),
    contextWindow,
    health: 'healthy' as HealthStatus,
    p95LatencyMs: 0, // 由 ModelInfoStore 按网关超时反推覆盖
    inputPricePer1k: isFreeModel ? 0 : round4(0.0005 + cost * 0.012),
    outputPricePer1k: isFreeModel ? 0 : round4(0.0015 + cost * 0.028),
    modalities,
    dataRegion: [],
    vendor,
    vendorLabel,
  };
}

function firstPositive(...vals: (number | undefined)[]): number | undefined {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}
function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
function log10(x: number): number {
  return Math.log(x) / Math.LN10;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
