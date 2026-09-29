/**
 * @module decision-store
 * @implements LLM-sdd.md 二、决策信息库
 *
 * 决策信息库 —— 用 JSON 文件存储 Jev 的决策信息。每次 Prompt 输入完成模型智能
 * 路由决策后，**热更新**该文件（write-through：先落盘再返回，保证进程崩溃后
 * 决策不丢）。
 *
 * 存储内容（对齐 `jev-router-fusion` 规范的决策契约）：
 * - 置信度路由阈值（`high` / `mid`），由历史决策的置信度分布**动态计算**
 * - 每个模型的决策累计统计（被选次数 / 平均置信度 / 平均胜出概率 / 胜率）
 * - 最近 N 条决策明细（供前端「决策库」页签展示与审计追溯）
 *
 * 落盘策略：原子写（临时文件 + rename），避免读到半截 JSON。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { RouteTier, RouteTierThresholds } from '@jev-router/shared';
import { routeTier } from '@jev-router/shared';
import type { IndustryRating, IndustryRatingOrigin } from './industry-ratings.js';

// ---------------------------------------------------------------------------
// 数据形状
// ---------------------------------------------------------------------------

/** 单模型累计决策统计。 */
export interface ModelDecisionStat {
  modelId: string;
  /** 累计被选为最终模型的次数。 */
  selectedCount: number;
  /** 累计进入候选池的次数。 */
  candidateCount: number;
  /** 累计胜出概率之和（用于算平均概率）。 */
  probabilitySum: number;
  /** 累计校准置信度之和（该模型被选时的 confidence）。 */
  confidenceSum: number;
  /** 累计延迟（ms）。 */
  latencySumMs: number;
  /** 最近一次被选时间。 */
  lastSelectedAt?: string;
  /** 平均胜出概率（0..1）。 */
  avgProbability: number;
  /** 平均校准置信度（0..1）。 */
  avgConfidence: number;
  /** 胜率 = selectedCount / candidateCount（0..1）。 */
  winRate: number;
  /**
   * 业界评价评分（0..1）—— 由每日凌晨同步任务从行业评分来源写入。
   *
   * 与 `avgConfidence`（本系统自身的置信度统计）正交：前者是**外部业界口碑**，
   * 后者是**本系统路由经验**。缺省表示尚未同步过。
   */
  industryScore?: number;
  /** 业界排名（越小越好）。 */
  industryRank?: number;
  /** 评分出处（如 `LMArena`）。 */
  industrySource?: string;
  /** 该评分写入时间（ISO）。 */
  industryRatedAt?: string;
}

/** 行业评分同步摘要（决策信息库根节点，供审计与前端展示）。 */
export interface IndustrySyncSummary {
  /** 本次同步时间（ISO）。 */
  syncedAt: string;
  /** 来源描述（榜单名 / API URL / 文件路径）。 */
  sourceLabel: string;
  /** 评分来源类别。 */
  origin: IndustryRatingOrigin;
  /** 评分载荷自身的更新时间。 */
  ratingsUpdatedAt: string;
  /** 成功对齐目录的模型数。 */
  matched: number;
  /** 评分里存在但目录中找不到的模型 id。 */
  unmatched: string[];
  /** 解析期告警。 */
  warnings: string[];
}

/** 单条决策明细。 */
export interface DecisionRecordEntry {
  requestId: string;
  decisionId: string;
  executionId?: string;
  createdAt: string;
  /** 决策来源（JEV-7）。 */
  decisionSource: 'TYPE_SAFE_JEV' | 'RULE_FALLBACK' | 'LOCAL_REIMPL' | 'USER_OVERRIDE';
  /** Jev 五问摘要。 */
  jevAnswers: { tag: string; type: 'choice' | 'score' | 'noul'; value: string }[];
  /** 校准置信度（0..1）。 */
  confidence: number;
  /** 置信度路由阈值（本次实际使用）。 */
  thresholds: RouteTierThresholds;
  routeTier: RouteTier;
  /** 最终选中模型（Jev 建议经硬约束过滤后的结果）。 */
  selectedModelId: string;
  /** Jev 原始建议（可能因硬约束被过滤，CONSTRAIN-3）。 */
  jevRecommendation?: string;
  /** 候选模型概率分布。 */
  distribution: { modelId: string; probability: number; rankIndex: number }[];
  /** 硬约束淘汰记录。 */
  eliminated: { modelId: string; reason: string }[];
  /**
   * 约束是否被忽略（JEV-11 正交性登记，附录 G-2）。
   *
   * true 表示候选池经**回落**得到，而非直接由约束筛选结果决定：
   * - `allowed_model_ids_not_in_catalog`：白名单与目录无交集，回落全量可用池
   * - `all_candidates_eliminated`：硬约束淘汰全部候选，回落未过滤池
   *
   * 该字段使「约束是否真的生效」可审计；缺省视为 `false`（历史数据兼容）。
   */
  constraintFallback?: boolean;
  /** 回落原因（仅 `constraintFallback` 为 true 时有值）。 */
  constraintFallbackReason?: 'allowed_model_ids_not_in_catalog' | 'all_candidates_eliminated';
  /** 执行统计。 */
  execution?: {
    modelId: string;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    status: 'success' | 'error' | 'cancelled';
    errorMessage?: string;
  };
  /** 结果文本长度（不落全文，历史库另存）。 */
  resultLength: number;
}

/** 决策信息库文件结构。 */
export interface DecisionStoreFile {
  storeVersion: string;
  updatedAt: string;
  /** 置信度路由阈值（动态计算结果）。 */
  thresholds: RouteTierThresholds;
  /** 阈值来源：`static` 未积累足够样本；`dynamic` 由历史分布计算。 */
  thresholdSource: 'static' | 'dynamic';
  totals: {
    decisions: number;
    byTier: Record<RouteTier, number>;
  };
  /** per-model 累计统计，key = modelId。 */
  models: Record<string, ModelDecisionStat>;
  /** 最近决策明细（倒序，最新在前）。 */
  recent: DecisionRecordEntry[];
  /** 最近一次行业评分同步摘要（未同步过则为 undefined）。 */
  industrySync?: IndustrySyncSummary;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 决策明细保留条数上限（避免文件无限膨胀）。 */
export const DECISION_RECENT_LIMIT = 200;
/** 动态阈值所需的最小决策样本数。 */
export const THRESHOLD_DYNAMIC_MIN_SAMPLES = 12;
/** 动态阈值下探下限（不得超过此值，避免全部落 ESCALATE）。 */
export const THRESHOLD_FLOOR_HIGH = 0.6;
export const THRESHOLD_FLOOR_MID = 0.4;

function emptyFile(base: RouteTierThresholds): DecisionStoreFile {
  return {
    storeVersion: '1.0.0',
    updatedAt: new Date().toISOString(),
    thresholds: { ...base },
    thresholdSource: 'static',
    totals: { decisions: 0, byTier: { ROUTE: 0, GATE: 0, ESCALATE: 0 } },
    models: {},
    recent: [],
  };
}

// ---------------------------------------------------------------------------
// DecisionStore
// ---------------------------------------------------------------------------

export interface DecisionStoreOptions {
  /** 决策信息库 JSON 文件绝对路径。 */
  filePath: string;
  /** 静态基线阈值（样本不足时使用）。 */
  baseThresholds: RouteTierThresholds;
}

/**
 * 决策信息库 —— JSON 文件持久化 + 热更新。
 *
 * 线程/并发安全：所有写入串行化在内存 Promise 队列上，避免同一次决策的
 * read-modify-write 交错。
 */
export class DecisionStore {
  private readonly filePath: string;
  private readonly baseThresholds: RouteTierThresholds;
  private data: DecisionStoreFile;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: DecisionStoreOptions) {
    this.filePath = opts.filePath;
    this.baseThresholds = opts.baseThresholds;
    this.data = this.loadFromDisk(opts.baseThresholds);
  }

  /** 从磁盘加载；文件不存在或损坏时回落为基线空库。 */
  private loadFromDisk(base: RouteTierThresholds): DecisionStoreFile {
    if (!existsSync(this.filePath)) return emptyFile(base);
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as DecisionStoreFile;
      const baseEmpty = emptyFile(base);
      return {
        ...baseEmpty,
        ...parsed,
        totals: { ...baseEmpty.totals, ...(parsed.totals ?? {}) },
        models: parsed.models ?? {},
        recent: Array.isArray(parsed.recent) ? parsed.recent : [],
      };
    } catch {
      // 损坏文件不阻塞启动：备份后重建空库。
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        /* 备份失败也不阻塞 */
      }
      return emptyFile(base);
    }
  }

  /** 只读快照（返回深拷贝，调用方无法篡改内部状态）。 */
  snapshot(): DecisionStoreFile {
    return JSON.parse(JSON.stringify(this.data)) as DecisionStoreFile;
  }

  /** 当前置信度路由阈值。 */
  thresholds(): RouteTierThresholds {
    return { ...this.data.thresholds };
  }

  /**
   * 记录一次决策并热更新文件。
   *
   * 更新内容：per-model 统计、档位计数、最近明细、**动态阈值**。
   */
  async recordDecision(entry: DecisionRecordEntry): Promise<DecisionStoreFile> {
    return this.enqueue(async () => {
      this.applyEntry(entry);
      this.recomputeThresholds();
      await this.flush();
      return this.snapshot();
    });
  }

  /** 把一次执行结果回写到已记录的决策上（不改统计，只补执行信息）。 */
  async attachExecution(
    requestId: string,
    execution: NonNullable<DecisionRecordEntry['execution']>,
  ): Promise<void> {
    return this.enqueue(async () => {
      const hit = this.data.recent.find((r) => r.requestId === requestId);
      if (hit) {
        hit.execution = execution;
        this.data.updatedAt = new Date().toISOString();
        await this.flush();
      }
    });
  }

  /**
   * 写入业界评价评分（每日凌晨同步任务调用）。
   *
   * 语义为**权威覆盖**：本次清单外的模型，其旧评分会被清除——否则来源里已经
   * 下榜的模型会永久保留过期评分。来源整体不可用时调用方不应调用本方法（保留
   * 上一次结果）。
   *
   * @returns 本次同步摘要（同时持久化到库根节点 `industrySync`）。
   */
  async applyIndustryRatings(input: {
    ratings: readonly IndustryRating[];
    origin: IndustryRatingOrigin;
    sourceLabel: string;
    ratingsUpdatedAt: string;
    unmatched: readonly string[];
    warnings: readonly string[];
  }): Promise<IndustrySyncSummary> {
    return this.enqueue(async () => {
      const ratedAt = new Date().toISOString();
      const rated = new Set(input.ratings.map((r) => r.modelId));

      // 清除本次清单外的旧评分（模型已下榜 / 来源不再覆盖）
      for (const stat of Object.values(this.data.models)) {
        if (rated.has(stat.modelId)) continue;
        delete stat.industryScore;
        delete stat.industryRank;
        delete stat.industrySource;
        delete stat.industryRatedAt;
      }

      for (const r of input.ratings) {
        const stat = this.ensureStat(r.modelId);
        stat.industryScore = r.score;
        stat.industryRank = r.rank;
        stat.industrySource = r.source ?? input.sourceLabel;
        stat.industryRatedAt = ratedAt;
      }
      const summary: IndustrySyncSummary = {
        syncedAt: ratedAt,
        sourceLabel: input.sourceLabel,
        origin: input.origin,
        ratingsUpdatedAt: input.ratingsUpdatedAt,
        matched: input.ratings.length,
        unmatched: [...input.unmatched],
        warnings: [...input.warnings],
      };
      this.data.industrySync = summary;
      await this.flush();
      return summary;
    });
  }

  /** 串行化所有写操作。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(task, task);
    // 吞掉错误以保持队列存活，错误由调用方的 Promise 接收。
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** 把决策明细合并进内存状态。 */
  private applyEntry(entry: DecisionRecordEntry): void {
    for (const d of entry.distribution) {
      const stat = this.ensureStat(d.modelId);
      stat.candidateCount += 1;
      stat.probabilitySum += d.probability;
      stat.avgProbability = stat.probabilitySum / stat.candidateCount;
      stat.winRate = stat.candidateCount > 0 ? stat.selectedCount / stat.candidateCount : 0;
    }
    if (entry.selectedModelId) {
      const winner = this.ensureStat(entry.selectedModelId);
      winner.selectedCount += 1;
      winner.confidenceSum += entry.confidence;
      winner.avgConfidence = winner.confidenceSum / winner.selectedCount;
      winner.winRate =
        winner.candidateCount > 0 ? winner.selectedCount / winner.candidateCount : 0;
      if (entry.execution) {
        winner.latencySumMs += entry.execution.latencyMs;
      }
      winner.lastSelectedAt = entry.createdAt;
    }

    this.data.totals.decisions += 1;
    this.data.totals.byTier[entry.routeTier] += 1;
    this.data.recent.unshift(entry);
    if (this.data.recent.length > DECISION_RECENT_LIMIT) {
      this.data.recent.length = DECISION_RECENT_LIMIT;
    }
  }

  /**
   * 动态阈值计算。
   *
   * 样本不足 → 沿用配置基线（`thresholdSource='static'`）。
   * 样本充足 → 依据最近决策的置信度分布抬高阈值：
   *   - `high` 取高分位（80 分位）并夹在 `[FLOOR_HIGH, base.high]` 之间
   *   - `mid` 取中位（50 分位）并夹在 `[FLOOR_MID, high - 0.05]`
   *
   * 语义：中枢越熟悉某类请求，判定「有把握」的门槛越高，避免低置信度误路由。
   */
  private recomputeThresholds(): void {
    const n = this.data.totals.decisions;
    if (n < THRESHOLD_DYNAMIC_MIN_SAMPLES) {
      this.data.thresholds = { ...this.baseThresholds };
      this.data.thresholdSource = 'static';
      return;
    }
    // 只用有明确档位判定的样本（ESCALATE 是「没把握」，不参与抬高门槛）。
    const confs = this.data.recent
      .map((r) => r.confidence)
      .filter((c) => Number.isFinite(c))
      .sort((a, b) => a - b);
    if (confs.length === 0) {
      this.data.thresholds = { ...this.baseThresholds };
      this.data.thresholdSource = 'static';
      return;
    }
    const p80 = quantile(confs, 0.8);
    const p50 = quantile(confs, 0.5);
    const high = clamp(p80, THRESHOLD_FLOOR_HIGH, this.baseThresholds.high);
    const mid = clamp(p50, THRESHOLD_FLOOR_MID, high - 0.05);
    this.data.thresholds = { high: round2(high), mid: round2(mid) };
    this.data.thresholdSource = 'dynamic';
  }

  /** 原子写：临时文件 → rename。 */
  private async flush(): Promise<void> {
    this.data.updatedAt = new Date().toISOString();
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.filePath);
  }

  private ensureStat(modelId: string): ModelDecisionStat {
    let stat = this.data.models[modelId];
    if (!stat) {
      stat = {
        modelId,
        selectedCount: 0,
        candidateCount: 0,
        probabilitySum: 0,
        confidenceSum: 0,
        latencySumMs: 0,
        avgProbability: 0,
        avgConfidence: 0,
        winRate: 0,
      };
      this.data.models[modelId] = stat;
    }
    return stat;
  }

  /** 依据当前阈值把置信度映射为档位（编排器与前端共用同一口径）。 */
  tierFor(confidence: number): RouteTier {
    return routeTier(confidence, this.data.thresholds);
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
/** 线性插值分位数（输入 MUST 已升序）。 */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
