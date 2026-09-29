/**
 * @module web-ratings
 * @implements LLM-sdd.md 三、模型信息库（业界评价 · 互联网来源）
 *
 * 互联网业界评分抓取 —— 从公开榜单接口拉取「业界对 LLM 大模型的评价」，
 * 归一化为本系统可用的 0..1 评分。
 *
 * 默认来源：**LMArena（Chatbot Arena）总榜**，经 HuggingFace Datasets Server
 * 的 rows 接口读取 `lmarena-ai/leaderboard-dataset` 的 `text` 配置：
 *
 * ```
 * GET {url}&offset=0&length=100
 * → { rows: [ { row: { model_name, rating, rank, vote_count, category,
 *                      leaderboard_publish_date } } ], num_rows_total }
 * ```
 *
 * 只取 `category === 'overall'` 的总榜行；该数据集按总榜 rank 升序排列，因此
 * 遇到非 `overall` 行即可提前结束翻页。
 *
 * ## 评分口径
 *
 * LMArena 的 Elo 会随版本漂移，直接线性映射不稳定，故采用**固定名次参照系**：
 *
 * ```
 * score = clamp01(1 - (rank - 1) / (REFERENCE_RANK_SPAN - 1))
 * ```
 *
 * 即第 1 名 = 1.0，第 200 名 = 0.0。原始 Elo 与票数写入 `notes` 供审计。
 */
import type { IndustryRating } from './industry-ratings.js';

/** 互联网评分来源配置。 */
export interface WebRatingsConfig {
  enabled: boolean;
  /** 榜单接口基址（翻页参数 offset / length 由本模块追加）。 */
  url: string;
  /** 最多翻几页（每页 `pageSize` 行）。 */
  maxPages: number;
  /** 每页行数。 */
  pageSize: number;
  /** 单次请求超时（ms）。 */
  timeoutMs: number;
}

/** 固定名次参照系：第 1 名 1.0，第 200 名 0.0。 */
export const REFERENCE_RANK_SPAN = 200;

/** 榜单原始行（本项目关心的字段子集）。 */
interface LeaderboardRow {
  model_name?: unknown;
  rating?: unknown;
  rank?: unknown;
  vote_count?: unknown;
  category?: unknown;
  leaderboard_publish_date?: unknown;
}

/** 抓取结果。 */
export interface WebRatingsResult {
  ratings: IndustryRating[];
  sourceLabel: string;
  updatedAt: string;
  warnings: string[];
}

/**
 * 从公开榜单抓取业界评分。
 *
 * 单页失败不抛错：记录告警并返回已抓到的部分（保证定时任务不会整体失败）。
 */
export async function fetchWebRatings(
  cfg: WebRatingsConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<WebRatingsResult> {
  const warnings: string[] = [];
  const collected: LeaderboardRow[] = [];
  let publishDate = '';

  for (let page = 0; page < Math.max(1, cfg.maxPages); page += 1) {
    const offset = page * cfg.pageSize;
    let body: unknown;
    try {
      body = await getJson(`${cfg.url}&offset=${offset}&length=${cfg.pageSize}`, cfg.timeoutMs, fetchImpl);
    } catch (err) {
      warnings.push(
        `榜单第 ${offset}~${offset + cfg.pageSize} 行抓取失败（${err instanceof Error ? err.message : String(err)}）`,
      );
      break;
    }

    const rows = extractRows(body);
    if (rows.length === 0) break;

    let hitNonOverall = false;
    for (const r of rows) {
      const category = typeof r.category === 'string' ? r.category : 'overall';
      if (category !== 'overall') {
        hitNonOverall = true;
        break;
      }
      collected.push(r);
      const d = typeof r.leaderboard_publish_date === 'string' ? r.leaderboard_publish_date : '';
      if (d > publishDate) publishDate = d;
    }
    if (hitNonOverall) break;
    if (rows.length < cfg.pageSize) break;
  }

  const ratings: IndustryRating[] = [];
  const byName = new Map<string, IndustryRating>();
  for (const row of collected) {
    const name = typeof row.model_name === 'string' ? row.model_name.trim() : '';
    const rank = toFiniteNumber(row.rank);
    if (!name || rank === null || rank < 1) continue;
    const rating = toFiniteNumber(row.rating);
    const votes = toFiniteNumber(row.vote_count);
    const notes = [
      rating !== null ? `Elo ${Math.round(rating)}` : '',
      votes !== null ? `${Math.round(votes)} 票` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const entry: IndustryRating = {
      modelId: name,
      score: rankToScore(rank),
      rank: Math.round(rank),
      notes: notes || undefined,
    };
    const prev = byName.get(name);
    // 同名多次出现时保留名次更好的一条
    if (!prev || (entry.rank ?? Infinity) < (prev.rank ?? Infinity)) byName.set(name, entry);
  }
  ratings.push(...byName.values());

  if (ratings.length === 0) warnings.push('榜单未返回任何 overall 总榜行');

  return {
    ratings,
    sourceLabel: 'LMArena 总榜（HuggingFace leaderboard-dataset）',
    updatedAt: publishDate ? `${publishDate}T00:00:00Z` : new Date().toISOString(),
    warnings: warnings.length > 0 ? warnings : [],
  };
}

/** 名次 → 0..1 评分（固定参照系）。 */
export function rankToScore(rank: number): number {
  const raw = 1 - (rank - 1) / (REFERENCE_RANK_SPAN - 1);
  return Math.round(Math.min(1, Math.max(0, raw)) * 1000) / 1000;
}

/** 从 rows 接口响应里取出原始行。 */
function extractRows(body: unknown): LeaderboardRow[] {
  const rows = (body as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) return [];
  const out: LeaderboardRow[] = [];
  for (const r of rows) {
    const row = (r as { row?: unknown })?.row;
    if (typeof row === 'object' && row !== null) out.push(row as LeaderboardRow);
  }
  return out;
}

async function getJson(url: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<unknown> {
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

function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
