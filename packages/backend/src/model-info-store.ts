/**
 * @module model-info-store
 * @implements LLM-sdd.md 三、模型信息库
 *
 * 模型信息库 —— 从模型配置文件读取对应模型清单（优先调用 LLM 模型库的
 * Models API 拉取实时清单，失败时回落配置文件 + 内置种子），并对每个模型
 * 计算**决策区分度评分**（discrimination score）。
 *
 * ## 决策区分度评分（0..1）
 *
 * 区分度 = 「该模型在多大程度上能把不同类型的请求区分开」的能力。评分由三部分
 * 加权而成（`0.45 / 0.35 / 0.20`）：
 *
 * | 维度 | 含义 | 计算 |
 * |------|------|------|
 * | `profileSpread` | 能力画像的**离散度** | 与全体模型均值的马氏距离（归一化） |
 * | `winConcentration` | 胜出**集中度** | 被选次数占比越高，说明在其擅长域越不可替代 |
 * | `evidenceConfidence` | 胜出时的**平均置信度** | 该模型被选时刻的中枢把握程度 |
 *
 * 冷启动（尚无任何决策记录）时，仅用 `profileSpread` 一项，并置
 * `coldStart: true`，让前端明确标注"样本不足，评分仅供参考"。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { CatalogEntry, VersionedCatalog } from './model-catalog.js';
import { MVP_SEED_CATALOG } from './model-catalog.js';
import {
  inferModelProfile,
  ensureVendorFields,
  type LlmLibraryConfig,
  type ModelApiMetadata,
} from './app-config.js';
import type { DecisionStoreFile } from './decision-store.js';

// ---------------------------------------------------------------------------
// 数据形状
// ---------------------------------------------------------------------------

/** 模型信息库中的单模型条目。 */
export interface ModelInfoEntry {
  modelId: string;
  label: string;
  /** 是否来自 Models API 实时清单（false = 配置/种子回落）。 */
  fromLiveCatalog: boolean;
  /** CatalogEntry 形态（供约束流水线与打分复用）。 */
  profile: CatalogEntry;
  /** 决策区分度评分（0..1）。 */
  discrimination: {
    score: number;
    profileSpread: number;
    winConcentration: number;
    evidenceConfidence: number;
    coldStart: boolean;
    /** 人类可读评级。 */
    rating: '低' | '中' | '高' | '极高';
  };
  /** 来自决策信息库的累计统计（无则 null）。 */
  stats: {
    selectedCount: number;
    candidateCount: number;
    winRate: number;
    avgProbability: number;
    avgConfidence: number;
    avgLatencyMs: number;
  } | null;
  /**
   * 业界评价评分（来自决策信息库，由每日凌晨同步任务写入）。
   * 与 `discrimination`（本系统自身的决策区分度）正交，缺省为 null。
   */
  industry: {
    score: number;
    rank?: number;
    source?: string;
    ratedAt?: string;
  } | null;
  updatedAt: string;
}

/** 模型信息库文件结构。 */
export interface ModelInfoFile {
  infoVersion: string;
  updatedAt: string;
  catalogVersion: string;
  /** 清单来源：`models-api` | `config-fallback` | `seed-fallback`。 */
  source: 'models-api' | 'config-fallback' | 'seed-fallback';
  /** 拉取清单时的错误信息（回落时记录原因）。 */
  sourceError?: string;
  models: ModelInfoEntry[];
}

/** Models API 返回的模型条目（本项目网关提供的字段子集）。 */
type RawModelListItem = ModelApiMetadata & { id?: unknown };

// ---------------------------------------------------------------------------
// 评分常量
// ---------------------------------------------------------------------------

const W_PROFILE_SPREAD = 0.45;
const W_WIN_CONCENTRATION = 0.35;
const W_EVIDENCE_CONFIDENCE = 0.2;

const SCORE_COLD_START = 0.4;

/**
 * Provider 名 —— MUST 与 `LlmLibraryProviderAdapter.providerName` 一致。
 *
 * `ModelGateway` 按 `CatalogEntry.provider` 查适配器；不一致会直接
 * `PROVIDER_UNAVAILABLE`。
 */
export const LLM_PROVIDER_NAME = 'llm-library';

const RATING_THRESHOLDS: { min: number; rating: ModelInfoEntry['discrimination']['rating'] }[] = [
  { min: 0.75, rating: '极高' },
  { min: 0.55, rating: '高' },
  { min: 0.3, rating: '中' },
  { min: 0, rating: '低' },
];

function rate(score: number): ModelInfoEntry['discrimination']['rating'] {
  for (const t of RATING_THRESHOLDS) {
    if (score >= t.min) return t.rating;
  }
  return '低';
}
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

// ---------------------------------------------------------------------------
// ModelInfoStore
// ---------------------------------------------------------------------------

export interface ModelInfoStoreOptions {
  filePath: string;
  llm: LlmLibraryConfig;
  /** 拉取 Models API 的超时上限（ms）；缺省用 `llm.timeoutMs`。 */
  catalogTimeoutMs?: number;
  /** 注入的 fetch（便于测试）。 */
  fetchImpl?: typeof fetch;
}

/**
 * 模型信息库 —— 拉取模型清单 + 计算决策区分度 + 落盘。
 *
 * 生命周期：`ensureCatalog()` 在服务启动与每次路由前被调用；命中 Models API
 * 时刷新清单并重算评分，随后原子写盘。
 */
export class ModelInfoStore {
  private readonly filePath: string;
  private readonly llm: LlmLibraryConfig;
  private readonly catalogTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private data: ModelInfoFile | null = null;
  private catalog: CatalogEntry[] = [];
  /** 最近一次实际拉取 Models API 的时刻（ms epoch）；0 = 从未拉取。 */
  private lastLiveFetchAt = 0;

  constructor(opts: ModelInfoStoreOptions) {
    this.filePath = opts.filePath;
    this.llm = opts.llm;
    this.catalogTimeoutMs = opts.catalogTimeoutMs ?? opts.llm.timeoutMs;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** 只读快照。 */
  snapshot(): ModelInfoFile {
    if (!this.data) {
      this.data = this.loadFromDisk() ?? this.emptyFile('config-fallback');
    }
    return JSON.parse(JSON.stringify(this.data)) as ModelInfoFile;
  }

  /** 当前模型清单（CatalogEntry 形态，目录序 = 稳定下标契约 MODEL-3）。 */
  catalogEntries(): CatalogEntry[] {
    return this.catalog.map((e) => ({ ...e }));
  }

  /** 以 `VersionedCatalog` 形态返回，供 `/v1/catalog` 与约束流水线使用。 */
  versionedCatalog(): VersionedCatalog {
    return { catalogVersion: this.data?.catalogVersion ?? 'live-1.0', entries: this.catalogEntries() };
  }

  /**
   * 确保清单最新：优先 Models API，失败回落磁盘缓存 / 内置种子。
   *
   * @param decisionStore 决策信息库快照（用于胜出集中度与置信度统计）
   * @param force         true 时忽略"清单未变化"的短路，强制重算评分
   */
  async ensureCatalog(decisionStore?: DecisionStoreFile, force = false): Promise<ModelInfoFile> {
    if (!this.data) {
      this.data = this.loadFromDisk() ?? this.emptyFile('config-fallback');
    }
    if (this.catalog.length > 0 && !force) {
      // 清单未变，仅用最新决策统计刷新评分。
      this.rescore(decisionStore);
      return this.snapshot();
    }

    const live = await this.fetchLiveModels();
    // 无论成败都记录拉取时刻：失败时同样进入 TTL 静默期，避免每次请求都
    // 重试一个不可达的网关。
    this.lastLiveFetchAt = Date.now();
    if (live && live.length > 0) {
      this.catalog = live;
      this.data.source = 'models-api';
      delete this.data.sourceError;
    } else {
      this.catalog = this.fallbackCatalog();
      this.data.source =
        this.data.source === 'models-api' || this.catalogFromDisk() ? 'config-fallback' : 'seed-fallback';
      this.data.sourceError =
        live === null
          ? 'Models API 请求失败，已回落配置/种子清单'
          : 'Models API 返回空清单，已回落配置/种子清单';
    }
    this.data.catalogVersion = `live-${this.catalog.length}-${hashIds(this.catalog)}`;
    this.rescore(decisionStore);
    this.flush();
    return this.snapshot();
  }

  /**
   * 按 TTL 保证清单新鲜（前端每次打开页面拉 `/v1/models` 时调用）。
   *
   * - 距上次实时拉取未超过 `ttlMs` → 只按最新决策统计重算评分，立即返回
   * - 已超过（或从未拉取过）→ 重拉 Models API（受 `catalogTimeoutMs` 约束）
   *
   * `ttlMs <= 0` 表示不自动重拉，等价于 `rescore`。
   */
  async ensureFresh(
    decisionStore?: DecisionStoreFile,
    ttlMs = 0,
  ): Promise<ModelInfoFile> {
    const fresh =
      ttlMs > 0 && this.lastLiveFetchAt > 0 && Date.now() - this.lastLiveFetchAt < ttlMs;
    if (fresh) {
      this.rescore(decisionStore);
      return this.snapshot();
    }
    return this.ensureCatalog(decisionStore, true);
  }

  /** 用最新决策统计刷新区分度评分并落盘（不重新拉清单）。 */
  rescore(decisionStore?: DecisionStoreFile): ModelInfoFile {
    if (!this.data) return this.emptyFile('config-fallback');
    const prev = this.data.models;
    const fromLive = this.data.source === 'models-api';
    this.data.models = this.catalog.map((entry) =>
      buildEntry(entry, this.catalog, prev, decisionStore, fromLive),
    );
    this.flush();
    return this.snapshot();
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /** 调 Models API 拉取实时清单；失败返回 null。 */
  private async fetchLiveModels(): Promise<CatalogEntry[] | null> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.catalogTimeoutMs);
      try {
        const res = await this.fetchImpl(this.llm.modelsApi, {
          method: 'GET',
          headers: buildAuthHeaders(this.llm),
          signal: ctrl.signal,
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { data?: unknown } | unknown;
        const items = Array.isArray(body)
          ? (body as RawModelListItem[])
          : Array.isArray((body as { data?: unknown })?.data)
            ? ((body as { data: RawModelListItem[] }).data)
            : null;
        if (!items || items.length === 0) return [];
        return items
          .map((item, i) => this.toCatalogEntry(item, i))
          .filter((e): e is CatalogEntry => e !== null);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return null;
    }
  }

  /** 单条原始模型 → CatalogEntry。 */
  private toCatalogEntry(item: RawModelListItem, index: number): CatalogEntry | null {
    const modelId = typeof item.id === 'string' ? item.id : '';
    if (!modelId) return null;
    const profile = inferModelProfile({ modelId, meta: item });
    return {
      modelId,
      // MUST match `LlmLibraryProviderAdapter.providerName` — ModelGateway
      // looks up adapters by `CatalogEntry.provider`.
      provider: LLM_PROVIDER_NAME,
      ...profile,
      // 实时清单的 P95 无从得知，按配置的请求超时反推：ModelGateway 的
      // 单次超时 = p95 × 2，须覆盖推理模型的思考时长。
      p95LatencyMs: Math.round(this.llm.timeoutMs / 2),
      load: 0,
      profileVersion: `live-${index}-${Date.now().toString(36)}`,
      enabled: true,
    };
  }

  /** 回落清单：磁盘缓存 → 内置种子。 */
  private fallbackCatalog(): CatalogEntry[] {
    const cached = this.catalogFromDisk();
    if (cached) return cached;
    return MVP_SEED_CATALOG.entries.map((e) => ({
      ...e,
      provider: LLM_PROVIDER_NAME,
      p95LatencyMs: Math.round(this.llm.timeoutMs / 2),
    }));
  }

  private catalogFromDisk(): CatalogEntry[] | null {
    if (!this.data || this.data.models.length === 0) return null;
    // 旧版缓存没有 vendor/vendorLabel，按 modelId 补齐。
    return this.data.models.map((m) => ensureVendorFields({ ...m.profile }));
  }

  private loadFromDisk(): ModelInfoFile | null {
    if (!existsSync(this.filePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as ModelInfoFile;
      if (!Array.isArray(parsed.models)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private emptyFile(source: ModelInfoFile['source']): ModelInfoFile {
    return {
      infoVersion: '1.0.0',
      updatedAt: new Date().toISOString(),
      catalogVersion: 'live-0-empty',
      source,
      models: [],
    };
  }

  private flush(): void {
    if (!this.data) return;
    this.data.updatedAt = new Date().toISOString();
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.filePath);
  }
}

// ---------------------------------------------------------------------------
// 评分实现
// ---------------------------------------------------------------------------

function buildEntry(
  entry: CatalogEntry,
  peers: CatalogEntry[],
  prev: ModelInfoEntry[] | undefined,
  decisionStore: DecisionStoreFile | undefined,
  fromLiveCatalog: boolean,
): ModelInfoEntry {
  const modelId = entry.modelId;
  const stat = decisionStore?.models?.[modelId];
  const prevStats = prev?.find((m) => m.modelId === modelId)?.stats ?? null;

  // 胜出集中度：被选次数 / 全体被选次数
  const totalSelected = Object.values(decisionStore?.models ?? {}).reduce(
    (acc, s) => acc + s.selectedCount,
    0,
  );
  const selectedCount = stat?.selectedCount ?? prevStats?.selectedCount ?? 0;
  const winConcentration = totalSelected > 0 ? clamp01(selectedCount / totalSelected) : 0;

  // 证据置信度：该模型被选时的平均校准置信度
  const evidenceConfidence = stat?.avgConfidence ?? prevStats?.avgConfidence ?? 0;

  return {
    modelId,
    label: modelId,
    fromLiveCatalog,
    profile: entry,
    discrimination: scoreDiscrimination({
      profile: entry,
      peers,
      winConcentration,
      evidenceConfidence,
      hasHistory: totalSelected > 0,
    }),
    stats: {
      selectedCount,
      candidateCount: stat?.candidateCount ?? prevStats?.candidateCount ?? 0,
      winRate: stat?.winRate ?? prevStats?.winRate ?? 0,
      avgProbability: stat?.avgProbability ?? prevStats?.avgProbability ?? 0,
      avgConfidence: stat?.avgConfidence ?? prevStats?.avgConfidence ?? 0,
      avgLatencyMs:
        stat && stat.selectedCount > 0
          ? Math.round(stat.latencySumMs / stat.selectedCount)
          : (prevStats?.avgLatencyMs ?? 0),
    },
    industry:
      stat && typeof stat.industryScore === 'number'
        ? {
            score: stat.industryScore,
            rank: stat.industryRank,
            source: stat.industrySource,
            ratedAt: stat.industryRatedAt,
          }
        : null,
    updatedAt: new Date().toISOString(),
  };
}

/** 决策区分度评分（导出以便单测）。 */
export function scoreDiscrimination(input: {
  profile: CatalogEntry;
  peers: CatalogEntry[] | null;
  winConcentration: number;
  evidenceConfidence: number;
  hasHistory: boolean;
}): ModelInfoEntry['discrimination'] {
  const { profile, peers, winConcentration, evidenceConfidence, hasHistory } = input;
  const reference = (peers ?? [profile]).filter((p) => p.modelId !== profile.modelId);

  // profileSpread：与同池均值的归一化距离（4 维：capability/quality/cost/latency）
  let profileSpread = 0;
  if (reference.length > 0) {
    const dims: (keyof CatalogEntry)[] = ['capability', 'quality', 'cost', 'latency'];
    const dists = dims.map((d) => {
      const self = Number(profile[d]);
      const mean = reference.reduce((acc, p) => acc + Number(p[d]), 0) / reference.length;
      return Math.abs(self - mean);
    });
    // 各维偏离均值 ~0.25 即视为"明显不同"，据此归一化到 0..1
    const avg = dists.reduce((a, b) => a + b, 0) / dists.length;
    profileSpread = clamp01(avg / 0.25);
  }

  if (!hasHistory) {
    const score = round3(SCORE_COLD_START * 0.5 + profileSpread * 0.5);
    return {
      score,
      profileSpread: round3(profileSpread),
      winConcentration: 0,
      evidenceConfidence: 0,
      coldStart: true,
      rating: rate(score),
    };
  }

  const score = round3(
    clamp01(
      W_PROFILE_SPREAD * profileSpread +
        W_WIN_CONCENTRATION * winConcentration +
        W_EVIDENCE_CONFIDENCE * evidenceConfidence,
    ),
  );
  return {
    score,
    profileSpread: round3(profileSpread),
    winConcentration: round3(winConcentration),
    evidenceConfidence: round3(evidenceConfidence),
    coldStart: false,
    rating: rate(score),
  };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 构造鉴权头。 */
export function buildAuthHeaders(llm: LlmLibraryConfig): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (llm.apiKey) {
    const scheme = llm.authScheme ? `${llm.authScheme} ` : '';
    headers[llm.authHeader || 'Authorization'] = `${scheme}${llm.apiKey}`;
  }
  return headers;
}

/** 按厂商聚合的模型分组（前端 3D 星球节点的数据源）。 */
export interface VendorGroup {
  vendor: string;
  vendorLabel: string;
  modelCount: number;
  modelIds: string[];
  /** 该厂商全部模型的最高区分度评分。 */
  topDiscrimination: number;
}

/**
 * 把模型清单按厂商聚合。
 *
 * 排序：模型数降序 → 区分度降序 → 厂商名升序，保证前端节点顺序稳定。
 */
export function groupByVendor(entries: ModelInfoEntry[]): VendorGroup[] {
  const buckets = new Map<string, VendorGroup>();
  for (const e of entries) {
    const g = buckets.get(e.profile.vendor);
    if (g) {
      g.modelCount += 1;
      g.modelIds.push(e.modelId);
      g.topDiscrimination = Math.max(g.topDiscrimination, e.discrimination.score);
    } else {
      buckets.set(e.profile.vendor, {
        vendor: e.profile.vendor,
        vendorLabel: e.profile.vendorLabel,
        modelCount: 1,
        modelIds: [e.modelId],
        topDiscrimination: e.discrimination.score,
      });
    }
  }
  return [...buckets.values()].sort(
    (a, b) =>
      b.modelCount - a.modelCount ||
      b.topDiscrimination - a.topDiscrimination ||
      a.vendor.localeCompare(b.vendor),
  );
}

/** 目录版本指纹：模型 id 集合的稳定哈希。 */
function hashIds(entries: CatalogEntry[]): string {
  const s = entries.map((e) => e.modelId).sort().join(',');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
