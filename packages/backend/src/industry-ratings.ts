/**
 * @module industry-ratings
 * @implements LLM-sdd.md 三、模型信息库（业界评价来源）
 *
 * 行业评分载入器 —— 从「业界对 LLM 大模型的评价」来源读取评分，供每日清单
 * 同步写入决策信息库。
 *
 * 来源优先级（前者可用即不再往后）：
 * 1. `web`  —— 互联网公开榜单（默认 LMArena 总榜，见 `web-ratings.ts`）
 * 2. `api`  —— 任意 GET 接口，返回 `IndustryRatingsPayload` 结构
 * 3. `file` —— 本地 JSON 文件（同结构），可作离线回落或人工覆盖
 *
 * 约定结构（`api` / `file`）：
 * ```json
 * {
 *   "source": "LMArena / 人工维护",
 *   "updatedAt": "2026-09-30T00:00:00Z",
 *   "ratings": [
 *     { "modelId": "kimi-k2.7", "score": 0.88, "rank": 3, "notes": "长上下文稳定" }
 *   ]
 * }
 * ```
 *
 * 也接受裸数组 `[{ modelId, score }]`，以及 `score` 用百分制（`88` → `0.88`）。
 * 解析策略为**宽松**：无法识别的条目会被丢弃并记入 `warnings`，绝不因一条脏
 * 数据中断整次同步。
 */
import { existsSync, readFileSync } from 'node:fs';
import { fetchWebRatings, type WebRatingsConfig } from './web-ratings.js';

/** 评分来源类别。 */
export type IndustryRatingOrigin = 'web' | 'api' | 'file';

/** 单个模型的业界评分。 */
export interface IndustryRating {
  modelId: string;
  /** 归一化到 0..1 的综合评分。 */
  score: number;
  /** 业界排名（可选，越小越好）。 */
  rank?: number;
  /** 评分出处（如 `LMArena`）。 */
  source?: string;
  notes?: string;
}

/** 评分来源返回的载荷。 */
export interface IndustryRatingsPayload {
  source?: string;
  updatedAt?: string;
  ratings: IndustryRating[];
}

/** 载入结果。 */
export interface IndustryRatingsResult {
  ratings: IndustryRating[];
  origin: IndustryRatingOrigin;
  /** 人类可读的来源描述。 */
  sourceLabel: string;
  updatedAt: string;
  warnings: string[];
}

export interface LoadIndustryRatingsOptions {
  /** 互联网榜单来源。 */
  web: WebRatingsConfig;
  /** 评分 API（绝对 URL）；空串表示不使用。 */
  api: string;
  /** 评分文件绝对路径。 */
  file: string;
  /** 单次请求超时（ms）。 */
  timeoutMs: number;
  /** 注入的 fetch（便于测试）。 */
  fetchImpl?: typeof fetch;
}

/**
 * 按优先级载入行业评分：web → api → file。
 *
 * @returns 载入结果；三种来源都不可用时 `ratings` 为空数组、`warnings` 说明原因
 *          （调用方据此保留既有评分，不做覆写）。
 */
export async function loadIndustryRatings(
  opts: LoadIndustryRatingsOptions,
): Promise<IndustryRatingsResult> {
  const warnings: string[] = [];
  const fetchImpl = opts.fetchImpl ?? fetch;

  // 1. 互联网榜单（业界评价主来源）
  if (opts.web.enabled && opts.web.url) {
    const web = await fetchWebRatings(opts.web, fetchImpl);
    warnings.push(...web.warnings);
    if (web.ratings.length > 0) {
      return {
        ratings: web.ratings,
        origin: 'web',
        sourceLabel: web.sourceLabel,
        updatedAt: web.updatedAt,
        warnings,
      };
    }
    warnings.push('互联网榜单未取到可用评分，回落 api / file 来源');
  }

  // 2. 通用评分 API
  if (opts.api) {
    try {
      const payload = await fetchRatingsApi(opts.api, opts.timeoutMs, fetchImpl);
      const normalized = normalizeRatings(payload);
      if (normalized.ratings.length > 0) {
        warnings.push(...normalized.warnings);
        return {
          ratings: normalized.ratings,
          origin: 'api',
          sourceLabel: normalized.source ?? opts.api,
          updatedAt: normalized.updatedAt ?? new Date().toISOString(),
          warnings,
        };
      }
      warnings.push('评分 API 返回空或无法解析的评分清单，回落文件来源');
    } catch (err) {
      warnings.push(
        `评分 API 请求失败（${err instanceof Error ? err.message : String(err)}），回落文件来源`,
      );
    }
  }

  // 3. 本地文件（离线回落 / 人工覆盖）
  if (opts.file && existsSync(opts.file)) {
    try {
      const payload = JSON.parse(readFileSync(opts.file, 'utf8')) as unknown;
      const normalized = normalizeRatings(payload);
      if (normalized.ratings.length > 0) {
        warnings.push(...normalized.warnings);
        return {
          ratings: normalized.ratings,
          origin: 'file',
          sourceLabel: normalized.source ?? opts.file,
          updatedAt: normalized.updatedAt ?? new Date().toISOString(),
          warnings,
        };
      }
      warnings.push('评分文件为空或无法解析');
    } catch (err) {
      warnings.push(
        `评分文件解析失败（${err instanceof Error ? err.message : String(err)}）`,
      );
    }
  } else if (opts.file) {
    warnings.push(`评分文件不存在：${opts.file}`);
  }

  if (warnings.length === 0) warnings.push('未配置行业评分来源（web / api / file 均不可用）');
  return {
    ratings: [],
    origin: opts.web.enabled && opts.web.url ? 'web' : opts.api ? 'api' : 'file',
    sourceLabel: '（无可用评分来源）',
    updatedAt: new Date().toISOString(),
    warnings,
  };
}

/** GET 评分 API（带超时中止）。 */
async function fetchRatingsApi(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 宽松解析评分载荷。
 *
 * 兼容：`{ ratings: [...] }` / 裸数组；`modelId` / `model` / `id` 三种键名；
 * 百分制 `score`。
 */
export function normalizeRatings(raw: unknown): {
  ratings: IndustryRating[];
  source?: string;
  updatedAt?: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  const root = (raw ?? {}) as Record<string, unknown> | unknown[];
  const list: unknown[] = Array.isArray(root)
    ? root
    : Array.isArray((root as Record<string, unknown>).ratings)
      ? ((root as Record<string, unknown>).ratings as unknown[])
      : [];
  const source = Array.isArray(root) ? undefined : (root as Record<string, unknown>).source;
  const updatedAt = Array.isArray(root) ? undefined : (root as Record<string, unknown>).updatedAt;

  if (!Array.isArray(list)) {
    return { ratings: [], warnings: ['评分载荷缺少 ratings 数组'] };
  }

  const ratings: IndustryRating[] = [];
  const seen = new Set<string>();
  for (const [i, item] of list.entries()) {
    if (typeof item !== 'object' || item === null) {
      warnings.push(`第 ${i} 条评分不是对象，已忽略`);
      continue;
    }
    const o = item as Record<string, unknown>;
    const modelId = firstString(o.modelId, o.model, o.id);
    if (!modelId) {
      warnings.push(`第 ${i} 条评分缺少 modelId，已忽略`);
      continue;
    }
    const score = normalizeScore(o.score ?? o.rating ?? o.value);
    if (score === null) {
      warnings.push(`模型 ${modelId} 的评分无法解析为数值，已忽略`);
      continue;
    }
    if (seen.has(modelId)) {
      warnings.push(`模型 ${modelId} 的评分重复，保留首条`);
      continue;
    }
    seen.add(modelId);
    ratings.push({
      modelId,
      score,
      rank: firstPositiveInt(o.rank),
      source: firstString(o.source),
      notes: firstString(o.notes, o.note, o.comment),
    });
  }

  return {
    ratings,
    source: typeof source === 'string' && source.trim() !== '' ? source : undefined,
    updatedAt: typeof updatedAt === 'string' && updatedAt.trim() !== '' ? updatedAt : undefined,
    warnings,
  };
}

/**
 * 把评分与目录模型 id 对齐。
 *
 * 三级匹配（逐级放宽，命中即止）：
 * 1. **精确**：`modelId` 完全一致
 * 2. **归一化**：小写 + 去非字母数字，兼容 `kimi-k2.7` / `kimi_k2.7` / `Kimi K2.7`
 * 3. **同系列变体**：榜单名以目录 id 为前缀（如目录 `glm-5.3` ↔ 榜单 `glm-5.3-max`），
 *    候选多于一个时取名次最好者。前缀长度须 ≥ {@link MIN_PREFIX_LEN}，避免过短 id
 *    误配到无关模型。
 *
 * 每个目录模型最多绑定一条评分。
 */
export function matchRatings(
  ratings: readonly IndustryRating[],
  catalogModelIds: readonly string[],
): { matched: IndustryRating[]; unmatched: string[] } {
  const exact = new Map<string, IndustryRating>();
  const loose = new Map<string, IndustryRating[]>();
  for (const r of ratings) {
    if (!exact.has(r.modelId)) exact.set(r.modelId, r);
    const key = looseKey(r.modelId);
    const bucket = loose.get(key);
    if (bucket) bucket.push(r);
    else loose.set(key, [r]);
  }

  const matched: IndustryRating[] = [];
  const claimed = new Set<string>(); // 已被认领的榜单行名

  // 第 1 轮：精确 / 归一化匹配（最可靠）
  const pending: string[] = [];
  for (const id of catalogModelIds) {
    const hit = exact.get(id) ?? firstUnclaimed(loose.get(looseKey(id)), claimed);
    if (hit) {
      matched.push({ ...hit, modelId: id });
      claimed.add(hit.modelId);
    } else {
      pending.push(id);
    }
  }

  // 第 2 轮：同系列变体（仅在未被认领的榜单行里挑选，避免一个模型抢走变体）
  for (const id of pending) {
    const key = looseKey(id);
    if (key.length < MIN_PREFIX_LEN) continue;
    const variants: IndustryRating[] = [];
    for (const [boardKey, bucket] of loose) {
      if (boardKey.length <= key.length || !boardKey.startsWith(key)) continue;
      variants.push(...bucket.filter((r) => !claimed.has(r.modelId)));
    }
    if (variants.length === 0) continue;
    const hit = bestOf(variants);
    matched.push({ ...hit, modelId: id });
    claimed.add(hit.modelId);
  }

  const unmatched = ratings.map((r) => r.modelId).filter((n) => !claimed.has(n));
  return { matched, unmatched };
}

/** 同系列变体匹配所需的最小前缀长度（归一化后）。 */
export const MIN_PREFIX_LEN = 4;

/** 取桶里第一条尚未被认领的评分。 */
function firstUnclaimed(
  bucket: IndustryRating[] | undefined,
  claimed: ReadonlySet<string>,
): IndustryRating | undefined {
  return bucket?.find((r) => !claimed.has(r.modelId));
}

/** 取候选里名次最好的一条（无名次视为最差）。 */
function bestOf(candidates: readonly IndustryRating[]): IndustryRating {
  return candidates.reduce((best, cur) =>
    (cur.rank ?? Number.MAX_SAFE_INTEGER) < (best.rank ?? Number.MAX_SAFE_INTEGER) ? cur : best,
  );
}

function looseKey(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

function firstPositiveInt(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n);
}

/** 归一化评分到 0..1；支持百分制。无法解析返回 null。 */
function normalizeScore(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const scaled = n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, Math.round(scaled * 1000) / 1000));
}
