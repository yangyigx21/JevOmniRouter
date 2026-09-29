/**
 * MCP tool: `jev_history_query`.
 *
 * Queries execution history (stored per hour bucket by the backend). Returns
 * either a list view (prompt summary, model, tier, latency/cost) or a single
 * detail view with the full model output.
 *
 * Read-only. Source is `GET /v1/history`.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HistoryEntry, JevBackendClient } from '../backend-client.js';
import { BackendClientError } from '../backend-client.js';

export const historyQueryInputSchema = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Max entries to return (default 20).'),
  hour: z
    .string()
    .optional()
    .describe('Only this hour bucket, format `YYYY-MM-DD-HH` (local timezone).'),
  search: z
    .string()
    .optional()
    .describe('Keyword matched against prompt / model / tier / decision source.'),
  request_id: z
    .string()
    .optional()
    .describe('Return the full detail (including model output) for one requestId.'),
  include_result: z
    .boolean()
    .optional()
    .describe('Include model output text in list view (default false; can be long).'),
};

export type HistoryQueryInput = z.infer<z.ZodObject<typeof historyQueryInputSchema>>;

export function registerHistoryQueryTool(server: McpServer, client: JevBackendClient): void {
  server.registerTool(
    'jev_history_query',
    {
      title: 'Jev 历史执行查询',
      description:
        '查询历史执行记录（按小时分桶）：prompt 摘要、选中模型、档位、置信度、延迟/token/成本/状态。支持关键词搜索、指定小时桶，或按 requestId 取单条完整明细（含模型回答全文）。只读，无成本。',
      inputSchema: historyQueryInputSchema,
    },
    async (args) => {
      try {
        // Detail view: fetch a wider window then pick the matching requestId.
        if (args.request_id) {
          const res = await client.history({ limit: 200, search: args.request_id });
          const hit =
            res.entries.find((e) => e.requestId === args.request_id) ??
            (await client.history({ limit: 200 })).entries.find(
              (e) => e.requestId === args.request_id,
            );
          if (!hit) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `# 未找到记录\n\n历史库中无 requestId = \`${args.request_id}\` 的执行记录（共 ${res.total} 条）。`,
                },
              ],
              isError: true,
            };
          }
          return { content: [{ type: 'text', text: formatDetail(hit) }] };
        }

        const res = await client.history({
          limit: args.limit ?? 20,
          ...(args.hour !== undefined ? { hour: args.hour } : {}),
          ...(args.search !== undefined ? { search: args.search } : {}),
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: formatList(res.entries, res.total, res.hours.length, args),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `# 后端未就绪\n\n无法读取历史库。请先启动：cd packages/backend && pnpm dev。\n\n原因：${describeError(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

function formatList(
  entries: HistoryEntry[],
  total: number,
  hourCount: number,
  args: HistoryQueryInput,
): string {
  const lines: string[] = [];
  lines.push('# 历史执行记录');
  lines.push('');
  const filters: string[] = [];
  if (args.hour) filters.push(`hour=${args.hour}`);
  if (args.search) filters.push(`search=${args.search}`);
  lines.push(
    `匹配 **${total}** 条，展示 ${entries.length} 条 · 覆盖 ${hourCount} 个小时桶` +
      (filters.length > 0 ? ` · 过滤：${filters.join(', ')}` : ''),
  );
  lines.push('');

  if (entries.length === 0) {
    lines.push('_无匹配记录。_');
    return lines.join('\n');
  }

  lines.push('| 时间 | 档位 | 置信度 | 模型 | 延迟 | 成本 | 状态 | Prompt 摘要 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const e of entries) {
    const statusIcon = e.execution.status === 'success' ? '✓' : e.execution.status === 'error' ? '✗' : '⊘';
    lines.push(
      `| ${fmtTime(e.createdAt)} | ${e.routeTier} | ${fmt(e.confidence)} | ${e.selectedModelId} | ${e.execution.latencyMs}ms | $${e.execution.costUsd.toFixed(5)} | ${statusIcon} ${e.execution.status} | ${truncate(e.promptSummary || e.prompt, 40)} |`,
    );
  }
  lines.push('');

  const totalCost = entries.reduce((a, e) => a + e.execution.costUsd, 0);
  const totalTokens = entries.reduce(
    (a, e) => a + e.execution.promptTokens + e.execution.completionTokens,
    0,
  );
  lines.push(
    `**本页汇总**：成本 $${totalCost.toFixed(5)} · tokens ${totalTokens} · 平均延迟 ${Math.round(entries.reduce((a, e) => a + e.execution.latencyMs, 0) / entries.length)}ms`,
  );
  lines.push('');
  lines.push('_提示：加 `request_id` 取单条完整明细（含模型回答全文）。_');
  return lines.join('\n');
}

function formatDetail(e: HistoryEntry): string {
  const lines: string[] = [];
  lines.push('# 执行明细');
  lines.push('');
  lines.push(`- requestId：\`${e.requestId}\``);
  lines.push(`- decisionId：\`${e.decisionId}\`${e.executionId ? ` · executionId：\`${e.executionId}\`` : ''}`);
  lines.push(`- 时间：${e.createdAt}（小时桶 ${e.hourBucket}）`);
  lines.push(`- 档位：**${e.routeTier}** · 置信度 **${fmt(e.confidence)}** · 阈值 high ${e.thresholds.high} / mid ${e.thresholds.mid}`);
  lines.push(`- 决策来源：${e.decisionSource}`);
  lines.push(`- 选中模型：**${e.selectedModelId}**${e.jevRecommendation ? ` · Jev 建议：${e.jevRecommendation}` : ''}`);
  lines.push('');
  lines.push('## Prompt');
  lines.push('```');
  lines.push(e.prompt);
  lines.push('```');
  lines.push('');
  lines.push('## 执行');
  lines.push(`- 模型：${e.execution.modelId}`);
  lines.push(`- 耗时：${e.execution.latencyMs} ms`);
  lines.push(`- tokens：${e.execution.promptTokens} in / ${e.execution.completionTokens} out`);
  lines.push(`- 成本：$${e.execution.costUsd.toFixed(6)}${e.execution.usageSource ? `（${e.execution.usageSource}）` : ''}`);
  lines.push(`- 状态：${e.execution.status}${e.execution.errorMessage ? ` — ${e.execution.errorMessage}` : ''}`);
  lines.push('');
  lines.push(`## 事件序列（${e.eventTypes.length}）`);
  lines.push(e.eventTypes.join(' → '));
  lines.push('');
  if (e.result.trim() !== '') {
    lines.push('## 模型回答');
    lines.push('```');
    lines.push(e.result);
    lines.push('```');
  }
  return lines.join('\n');
}

function fmtTime(iso: string): string {
  // Keep it compact: `MM-DD HH:mm:ss`.
  return iso.length >= 19 ? iso.slice(5, 19).replace('T', ' ') : iso;
}
function fmt(v: number): string {
  return Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : '—';
}
function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

function describeError(err: unknown): string {
  if (err instanceof BackendClientError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
