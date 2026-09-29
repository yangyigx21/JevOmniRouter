/**
 * @module daily-model-sync
 * @implements LLM-sdd.md 三、模型信息库（每日凌晨更新）
 *
 * 模型清单每日同步 —— 每日凌晨执行一次：
 *
 * 1. 重拉 LLM 模型库清单（Models API，失败回落配置/种子），更新模型信息库
 * 2. 从「业界对 LLM 大模型的评价」来源读取行业评分
 * 3. 把评分写入决策信息库（`models[modelId].industryScore` 等字段）
 * 4. 用最新统计重算模型信息库的决策区分度并落盘
 *
 * 行业评分来源不可用时**只刷新清单**，保留决策库中已有的评分（不清空）。
 */
import { resolveRatingsFile, type AppConfig } from './app-config.js';
import type { DecisionStore, IndustrySyncSummary, ModelDecisionStat } from './decision-store.js';
import { loadIndustryRatings, matchRatings, type IndustryRating, type IndustryRatingOrigin } from './industry-ratings.js';
import type { ModelInfoFile, ModelInfoStore } from './model-info-store.js';
import type { CatalogEntry } from './model-catalog.js';

// ---------------------------------------------------------------------------
// Fallback 评分（业界榜单未覆盖的模型）
// ---------------------------------------------------------------------------

/** Fallback 评分来源标记，区别于 LMArena 等业界权威榜单。 */
export const FALLBACK_RATING_SOURCE = '内部画像加权';

/**
 * 为业界榜单未覆盖的模型计算 fallback 评分。
 *
 * LMArena 等公开榜单只覆盖部分模型，未命中时该模型在面板上显示为「未评分」，
 * 与已评分模型无法横向比较。这里用 catalog 画像（能力/质量/成本/时延）叠加
 * 决策统计（胜率/平均置信度）计算一个加权综合分，再 min-max 归一化拉开差距。
 *
 * 归一化区间 [0.40, 0.70] 刻意低于业界权威评分（LMArena 区间约 0.55–0.87），
 * 表示「内部估算」弱于「业界口碑」，避免 fallback 模型反超权威评分模型。
 */
export function computeFallbackRatings(
  entries: readonly CatalogEntry[],
  models: Record<string, ModelDecisionStat>,
  matchedIds: ReadonlySet<string>,
): IndustryRating[] {
  // 1. 计算原始分（画像为主，决策统计叠加拉开同质化画像的差距）
  const raw: { id: string; raw: number }[] = [];
  for (const e of entries) {
    if (matchedIds.has(e.modelId)) continue;
    // 画像分（0..1）：能力/质量为主，成本/时延越低越好
    const profile =
      e.capability * 0.40 +
      e.quality * 0.30 +
      (1 - e.cost) * 0.15 +
      (1 - e.latency) * 0.15;
    const stat = models[e.modelId];
    // 决策分：有候选样本时叠加胜率与置信度，拉开同质化画像的差距
    let decision = 0;
    let hasData = false;
    if (stat && stat.candidateCount > 0) {
      hasData = true;
      decision = stat.winRate * 0.15 + stat.avgConfidence * 0.10;
    }
    const base = hasData ? profile * 0.75 + decision : profile * 0.85;
    raw.push({ id: e.modelId, raw: base });
  }
  if (raw.length === 0) return [];
  // 2. min-max 归一化到 [0.40, 0.70]，拉开差距
  const vals = raw.map((r) => r.raw);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min;
  const LO = 0.4;
  const HI = 0.7;
  return raw.map((r) => {
    const norm = span > 0 ? (r.raw - min) / span : 0.5;
    const score = Math.round((LO + norm * (HI - LO)) * 1000) / 1000;
    return { modelId: r.id, score, source: FALLBACK_RATING_SOURCE };
  });
}

/** 同步任务依赖。 */
export interface ModelSyncDeps {
  config: AppConfig;
  modelInfoStore: ModelInfoStore;
  decisionStore: DecisionStore;
  /** 注入的 fetch（便于测试）。 */
  fetchImpl?: typeof fetch;
  /** 日志出口；缺省 `console.log`。 */
  log?: (message: string) => void;
}

/** 一次同步的结果。 */
export interface ModelSyncResult {
  ok: boolean;
  /** 本次同步时刻（ISO）。 */
  at: string;
  /** 清单来源。 */
  catalogSource: ModelInfoFile['source'];
  modelCount: number;
  /** 评分来源；无可用来源时为 `none`。 */
  ratingsOrigin: IndustryRatingOrigin | 'none';
  /** 成功写入决策库的评分数（业界 + fallback）。 */
  ratedCount: number;
  /** 其中由「内部画像加权」补齐的 fallback 评分数。 */
  fallbackCount: number;
  /** 评分里存在但目录中找不到的模型 id。 */
  unmatched: string[];
  warnings: string[];
  /** 同步摘要（评分来源可用时有值）。 */
  industrySync?: IndustrySyncSummary;
  error?: string;
}

/**
 * 执行一次完整同步：清单刷新 → 行业评分 → 落决策库 → 重算区分度。
 *
 * 任何一步失败都不会抛出，而是记录到返回值的 `error` / `warnings`，
 * 保证定时任务不会因单次失败而中断后续调度。
 */
export async function runModelSync(deps: ModelSyncDeps): Promise<ModelSyncResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const at = new Date().toISOString();
  try {
    // 1. 重拉实时清单（失败自动回落；force=true 忽略"清单未变"短路）。
    const info = await deps.modelInfoStore.ensureCatalog(deps.decisionStore.snapshot(), true);

    // 2. 读取业界评分来源（互联网榜单 → api → 本地文件）。
    const ratings = await loadIndustryRatings({
      web: deps.config.modelScoring.industryRatings.web,
      api: deps.config.modelScoring.industryRatings.api,
      file: resolveRatingsFile(deps.config),
      timeoutMs: deps.config.modelScoring.industryRatings.timeoutMs,
      fetchImpl: deps.fetchImpl,
    });

    // 3. 对齐目录模型 id 后写入决策信息库。
    //    榜单未覆盖的模型用「内部画像加权」fallback 评分补齐，让面板上每个模型都有评分可比较。
    //    仅在业界来源本次取到数据时才补 fallback；来源整体不可用时保留既有评分，不覆写。
    const catalogIds = deps.modelInfoStore.catalogEntries().map((e) => e.modelId);
    const { matched, unmatched } = matchRatings(ratings.ratings, catalogIds);
    const matchedIds = new Set(matched.map((m) => m.modelId));
    const fallback =
      ratings.ratings.length > 0
        ? computeFallbackRatings(
            deps.modelInfoStore.catalogEntries(),
            deps.decisionStore.snapshot().models,
            matchedIds,
          )
        : [];
    const allRatings = [...matched, ...fallback];
    const summary =
      allRatings.length > 0
        ? await deps.decisionStore.applyIndustryRatings({
            ratings: allRatings,
            origin: ratings.origin,
            sourceLabel: ratings.sourceLabel,
            ratingsUpdatedAt: ratings.updatedAt,
            unmatched,
            warnings: ratings.warnings,
          })
        : undefined;

    // 4. 让行业评分进入模型信息库（ModelsTab 展示 + 落盘）。
    await deps.modelInfoStore.rescore(deps.decisionStore.snapshot());

    log(
      `[model-sync] 清单 ${info.models.length} 个（来源 ${info.source}）· 业界评分 ${matched.length} 条（来源 ${ratings.sourceLabel}）· fallback ${fallback.length} 条（${FALLBACK_RATING_SOURCE}）`,
    );
    for (const w of ratings.warnings) log(`[model-sync] ⚠ ${w}`);
    if (matched.length === 0) {
      if (fallback.length > 0) {
        log('[model-sync] ⚠ 本次未取到可用业界评分，已用 fallback 补齐');
      } else {
        log('[model-sync] ⚠ 评分来源整体不可用，保留既有评分（不计算 fallback）');
      }
    }
    if (unmatched.length > 0) {
      log(
        `[model-sync] ℹ 榜单中 ${unmatched.length} 个模型不在当前清单，例如：${unmatched.slice(0, 5).join('、')} …`,
      );
    }

    return {
      ok: true,
      at,
      catalogSource: info.source,
      modelCount: info.models.length,
      ratingsOrigin: matched.length > 0 ? ratings.origin : 'none',
      ratedCount: allRatings.length,
      fallbackCount: fallback.length,
      unmatched,
      warnings: ratings.warnings,
      industrySync: summary,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[model-sync] ✗ 同步失败：${message}`);
    return {
      ok: false,
      at,
      catalogSource: 'config-fallback',
      modelCount: 0,
      ratingsOrigin: 'none',
      ratedCount: 0,
      fallbackCount: 0,
      unmatched: [],
      warnings: [],
      error: message,
    };
  }
}

/**
 * 计算距离下一次 `HH:mm`（本地时间）的毫秒数。
 *
 * @param now   当前时间
 * @param atHHmm 目标时刻，如 `00:00`
 */
export function nextRunDelay(now: Date, atHHmm: string): number {
  return nextRunAt(now, atHHmm).getTime() - now.getTime();
}

/** 计算下一次 `HH:mm` 的本地时间点（当天已过则顺延到次日）。 */
export function nextRunAt(now: Date, atHHmm: string): Date {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(atHHmm);
  const hour = m ? Number(m[1]) : 0;
  const minute = m ? Number(m[2]) : 0;
  const next = new Date(now.getTime());
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

/** 每日同步调度句柄。 */
export interface DailySyncHandle {
  /** 取消调度。 */
  stop(): void;
  /** 下一次执行时间（本地时间）。 */
  nextAt(): Date | null;
}

/**
 * 注册每日同步定时任务（本地时间 `config.modelScoring.dailySyncAt` 触发）。
 *
 * 单次执行失败不影响下次调度；定时器 `unref()`，不阻塞进程退出。
 */
export function scheduleDailyModelSync(deps: ModelSyncDeps): DailySyncHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let next: Date | null = null;
  let stopped = false;

  const arm = (): void => {
    if (stopped) return;
    next = nextRunAt(new Date(), deps.config.modelScoring.dailySyncAt);
    timer = setTimeout(() => {
      void runModelSync(deps)
        .catch(() => undefined)
        .then(() => arm());
    }, next.getTime() - Date.now());
    if (typeof timer.unref === 'function') timer.unref();
  };

  arm();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    nextAt: () => next,
  };
}
