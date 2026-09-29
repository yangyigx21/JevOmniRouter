/**
 * @module history-store
 * @implements LLM-sdd.md 四、历史库
 *
 * 历史库 —— 记录每次 Prompt 输入执行的信息，存储为 JSON 文件，**按小时拆分**。
 *
 * 文件布局：
 * ```
 * <dataDir>/history/2026-09-30-14.json   ← 14:00–14:59 的所有执行
 * <dataDir>/history/2026-09-30-15.json
 * ```
 *
 * 单条记录包含：prompt 摘要与全文、选中模型、档位、置信度、阈值、执行统计
 * （延迟 / token / 成本 / 状态）、结果文本、以及该次路由的事件摘要。
 *
 * 落盘采用原子写（临时文件 + rename），并对单文件条数设上限以防单文件膨胀。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { RouteTier } from '@jev-router/shared';

// ---------------------------------------------------------------------------
// 数据形状
// ---------------------------------------------------------------------------

/** 单次执行的历史记录。 */
export interface HistoryEntry {
  requestId: string;
  decisionId: string;
  executionId?: string;
  /** ISO 8601 完成时间。 */
  createdAt: string;
  /** 归属小时桶（`YYYY-MM-DD-HH`，本地时区）。 */
  hourBucket: string;
  prompt: string;
  promptSummary: string;
  selectedModelId: string;
  jevRecommendation?: string;
  routeTier: RouteTier;
  confidence: number;
  thresholds: { high: number; mid: number };
  decisionSource: string;
  execution: {
    modelId: string;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    status: 'success' | 'error' | 'cancelled';
    /**
     * token 统计来源：`provider` = 网关上报；`estimated` = 网关未上报
     * （例如流被截断）时按文本长度估算。
     */
    usageSource?: 'provider' | 'estimated';
    errorMessage?: string;
  };
  /** 模型实际输出全文。 */
  result: string;
  /** 该次路由的事件类型序列（便于前端回放与审计）。 */
  eventTypes: string[];
}

/** 单个小时桶文件。 */
export interface HistoryHourFile {
  hourBucket: string;
  updatedAt: string;
  count: number;
  entries: HistoryEntry[];
}

/** 历史库查询结果（跨小时合并，按时间倒序）。 */
export interface HistoryQueryResult {
  total: number;
  hours: { hourBucket: string; count: number; updatedAt: string }[];
  entries: HistoryEntry[];
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 单个小时桶文件保留的最大条数。 */
export const HISTORY_HOUR_LIMIT = 500;
/** 列表查询默认返回条数。 */
export const HISTORY_DEFAULT_LIMIT = 50;
/** 小时桶文件名格式。 */
const HOUR_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{2}\.json$/;

// ---------------------------------------------------------------------------
// HistoryStore
// ---------------------------------------------------------------------------

export interface HistoryStoreOptions {
  /** 历史库目录绝对路径。 */
  dir: string;
  /** 单文件条数上限。 */
  hourLimit?: number;
}

/** 历史库 —— 按小时拆分的 JSON 持久化。 */
export class HistoryStore {
  private readonly dir: string;
  private readonly hourLimit: number;
  private writeChain: Promise<void> = Promise.resolve();
  /** 小时桶内存缓存：避免同一次执行重复读盘。 */
  private cache = new Map<string, HistoryHourFile>();

  constructor(opts: HistoryStoreOptions) {
    this.dir = opts.dir;
    this.hourLimit = opts.hourLimit ?? HISTORY_HOUR_LIMIT;
  }

  /** 追加一条执行记录并落盘。 */
  async append(entry: HistoryEntry): Promise<void> {
    return this.enqueue(async () => {
      const bucket = entry.hourBucket;
      const file = this.loadBucket(bucket);
      file.entries.unshift(entry);
      if (file.entries.length > this.hourLimit) {
        file.entries.length = this.hourLimit;
      }
      file.count = file.entries.length;
      file.updatedAt = new Date().toISOString();
      this.cache.set(bucket, file);
      this.flush(bucket, file);
    });
  }

  /**
   * 查询历史（跨小时合并，倒序）。
   *
   * @param opts.limit  返回条数上限
   * @param opts.hour  只查指定小时桶
   * @param opts.search 关键词（对 prompt / selectedModelId / routeTier 做包含匹配）
   */
  query(opts: { limit?: number; hour?: string; search?: string } = {}): HistoryQueryResult {
    const limit = opts.limit ?? HISTORY_DEFAULT_LIMIT;
    const buckets = opts.hour ? [opts.hour] : this.listHourBuckets();
    const q = opts.search?.trim().toLowerCase() ?? '';
    const entries: HistoryEntry[] = [];
    const hours: HistoryQueryResult['hours'] = [];

    for (const bucket of buckets) {
      const file = this.loadBucket(bucket);
      hours.push({ hourBucket: bucket, count: file.count, updatedAt: file.updatedAt });
      for (const e of file.entries) {
        if (q) {
          const hay = `${e.prompt} ${e.selectedModelId} ${e.routeTier} ${e.decisionSource}`.toLowerCase();
          if (!hay.includes(q)) continue;
        }
        entries.push(e);
      }
    }

    entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return { total: entries.length, hours, entries: entries.slice(0, limit) };
  }

  /** 列出所有小时桶文件名（新的在前）。 */
  listHourBuckets(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => HOUR_PATTERN.test(f))
      .map((f) => f.replace(/\.json$/, ''))
      .sort()
      .reverse();
  }

  /** 统计信息（前端「历史」页签概览）。 */
  stats(): { hours: number; total: number; byTier: Record<RouteTier, number>; byModel: Record<string, number> } {
    const buckets = this.listHourBuckets();
    const byTier: Record<RouteTier, number> = { ROUTE: 0, GATE: 0, ESCALATE: 0 };
    const byModel: Record<string, number> = {};
    let total = 0;
    for (const bucket of buckets) {
      for (const e of this.loadBucket(bucket).entries) {
        total += 1;
        byTier[e.routeTier] = (byTier[e.routeTier] ?? 0) + 1;
        byModel[e.selectedModelId] = (byModel[e.selectedModelId] ?? 0) + 1;
      }
    }
    return { hours: buckets.length, total, byTier, byModel };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private loadBucket(bucket: string): HistoryHourFile {
    const cached = this.cache.get(bucket);
    if (cached) return cached;
    const path = join(this.dir, `${bucket}.json`);
    if (!existsSync(path)) {
      const fresh: HistoryHourFile = {
        hourBucket: bucket,
        updatedAt: new Date().toISOString(),
        count: 0,
        entries: [],
      };
      this.cache.set(bucket, fresh);
      return fresh;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as HistoryHourFile;
      const file: HistoryHourFile = {
        hourBucket: bucket,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
        count: parsed.count ?? parsed.entries?.length ?? 0,
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      };
      this.cache.set(bucket, file);
      return file;
    } catch {
      // 损坏文件：备份后重建空桶，不阻塞服务。
      try {
        renameSync(path, `${path}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      const fresh: HistoryHourFile = {
        hourBucket: bucket,
        updatedAt: new Date().toISOString(),
        count: 0,
        entries: [],
      };
      this.cache.set(bucket, fresh);
      return fresh;
    }
  }

  private flush(bucket: string, file: HistoryHourFile): void {
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, `${bucket}.json`);
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(task, task);
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 生成本地时区的小时桶 key（`YYYY-MM-DD-HH`）。 */
export function hourBucketOf(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}`
  );
}

/**
 * 生成 prompt 摘要（单行，超长截断）。
 *
 * 截断点必须落在 UTF-16 代理对边界之外：直接 `slice(0, max)` 可能把一个
 * 代理对（如 emoji）劈成两个孤立码元，序列化为 JSON 后会变成 `�`，
 * 在「历史」信息区表现为乱码。
 */
export function summarizePrompt(prompt: string, max = 120): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  // 若 max 落在代理对中间（前一码元为高代理、后一码元为低代理），回退一位。
  const code = flat.charCodeAt(max - 1);
  const splitsSurrogatePair = code >= 0xd800 && code <= 0xdbff;
  return `${flat.slice(0, splitsSurrogatePair ? max - 1 : max)}…`;
}
