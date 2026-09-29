/**
 * MCP tool: `jev_experience_stats`.
 *
 * Reports the experience-closed-loop state (EXP-1~10): the dynamic confidence
 * thresholds, per-model win stats, the confidence→tier distribution, the tier
 * distribution of executions, and the industry rating sync summary.
 *
 * Read-only. Sources are `GET /v1/decision-store` and `GET /v1/history/stats`.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  DecisionStoreSnapshot,
  HistoryStats,
  JevBackendClient,
  ModelDecisionStat,
} from '../backend-client.js';
import { BackendClientError } from '../backend-client.js';

export const experienceStatsInputSchema = {
  top_n: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('How many models to show in the per-model leaderboard (default 10).'),
  sort_by: z
    .enum(['selected', 'winRate', 'avgConfidence', 'avgProbability', 'industry'])
    .optional()
    .describe('Leaderboard sort key (descending). Defaults to `selected`.'),
};

export type ExperienceStatsInput = z.infer<z.ZodObject<typeof experienceStatsInputSchema>>;

export function registerExperienceStatsTool(server: McpServer, client: JevBackendClient): void {
  server.registerTool(
    'jev_experience_stats',
    {
      title: 'Jev 决策经验统计',
      description:
        '读取决策经验闭环状态：动态置信度阈值（high/mid）与阈值来源、per-model 胜出统计（被选次数/胜率/平均概率/平均置信度）、档位分布、业界评分同步摘要。只读，无成本。',
      inputSchema: experienceStatsInputSchema,
    },
    async (args) => {
      let store: DecisionStoreSnapshot;
      let stats: HistoryStats;
      try {
        [store, stats] = await Promise.all([client.decisionStore(), client.historyStats()]);
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `# 后端未就绪\n\n无法读取决策信息库。请先启动：cd packages/backend && pnpm dev。\n\n原因：${describeError(err)}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: formatStats(store, stats, args) }],
      };
    },
  );
}

function formatStats(
  store: DecisionStoreSnapshot,
  stats: HistoryStats,
  args: ExperienceStatsInput,
): string {
  const lines: string[] = [];
  lines.push('# 决策经验统计');
  lines.push('');

  lines.push('## 置信度阈值（动态）');
  lines.push('');
  lines.push(
    `- high = **${store.thresholds.high}** · mid = **${store.thresholds.mid}**`,
  );
  lines.push(
    `- 来源：**${store.thresholdSource}**${store.thresholdSource === 'static' ? '（样本不足，用静态基线）' : '（由历史置信度分布计算）'}`,
  );
  lines.push(`- 决策库更新时间：${store.updatedAt}`);
  lines.push('');

  lines.push('## 决策/执行分布');
  lines.push('');
  lines.push(`- 累计决策：**${store.totals.decisions}** 条`);
  lines.push(
    `- 决策库档位分布：ROUTE ${store.totals.byTier.ROUTE ?? 0} · GATE ${store.totals.byTier.GATE ?? 0} · ESCALATE ${store.totals.byTier.ESCALATE ?? 0}`,
  );
  lines.push(`- 历史库执行：**${stats.total}** 条，跨 ${stats.hours} 个小时桶（当前桶 ${stats.currentHour}）`);
  lines.push(
    `- 历史库档位分布：ROUTE ${stats.byTier.ROUTE ?? 0} · GATE ${stats.byTier.GATE ?? 0} · ESCALATE ${stats.byTier.ESCALATE ?? 0}`,
  );
  lines.push('');

  if (store.industrySync) {
    const s = store.industrySync;
    lines.push('## 业界评分同步');
    lines.push('');
    lines.push(`- 来源：${s.sourceLabel}（${s.origin}）`);
    lines.push(`- 同步时间：${s.syncedAt}`);
    lines.push(`- 命中模型：${s.matched}${s.unmatched.length > 0 ? ` · 未命中 ${s.unmatched.length} 个` : ''}`);
    lines.push('');
  }

  const models = Object.values(store.models);
  const topN = args.top_n ?? 10;
  const sorted = sortModels(models, args.sort_by ?? 'selected').slice(0, topN);

  lines.push(`## 模型排行榜（Top ${Math.min(topN, models.length)} · 按 ${args.sort_by ?? 'selected'}）`);
  lines.push('');
  if (sorted.length === 0) {
    lines.push('_暂无模型决策统计。_');
  } else {
    lines.push('| 模型 | 被选 | 候选 | 胜率 | 平均概率 | 平均置信度 | 业界评分 |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const m of sorted) {
      lines.push(
        `| ${m.modelId} | ${m.selectedCount} | ${m.candidateCount} | ${fmtPct(m.winRate)} | ${fmt(m.avgProbability)} | ${fmt(m.avgConfidence)} | ${m.industryScore !== undefined ? `${m.industryScore}${m.industryRank !== undefined ? ` (#${m.industryRank})` : ''}` : '—'} |`,
      );
    }
  }
  lines.push('');

  const selectedTotal = models.reduce((a, m) => a + m.selectedCount, 0);
  const neverSelected = models.filter((m) => m.selectedCount === 0).length;
  lines.push('## 提示');
  lines.push('');
  lines.push(
    `- 累计被选 ${selectedTotal} 次，${neverSelected}/${models.length} 个模型从未被选中。`,
  );
  lines.push(
    '- `胜率 = 被选次数 / 进入候选池次数`；`平均置信度` 仅统计被选时刻。',
  );
  if (store.thresholdSource === 'static') {
    lines.push('- 阈值仍为静态：样本积累到阈值后会转为 `dynamic`。');
  }
  return lines.join('\n');
}

function sortModels(
  models: ModelDecisionStat[],
  key: NonNullable<ExperienceStatsInput['sort_by']>,
): ModelDecisionStat[] {
  const pick: Record<typeof key, (m: ModelDecisionStat) => number> = {
    selected: (m) => m.selectedCount,
    winRate: (m) => m.winRate,
    avgConfidence: (m) => m.avgConfidence,
    avgProbability: (m) => m.avgProbability,
    industry: (m) => m.industryScore ?? -1,
  };
  const f = pick[key];
  return [...models].sort((a, b) => f(b) - f(a) || a.modelId.localeCompare(b.modelId));
}

function fmt(v: number): string {
  return Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : '—';
}
function fmtPct(v: number): string {
  return Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—';
}

function describeError(err: unknown): string {
  if (err instanceof BackendClientError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
