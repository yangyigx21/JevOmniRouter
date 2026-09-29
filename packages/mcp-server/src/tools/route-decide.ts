/**
 * MCP tool: `jev_route_decide`.
 *
 * Given a prompt, runs a real route decision through the JevRouter backend and
 * returns the full outcome: tier, confidence, selected model, candidate score
 * distribution, constraint eliminations, and the model's streamed answer.
 *
 * This is a thin adapter — all decision logic lives in the backend. The tool
 * waits for a terminal event so callers never see a half-finished route.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JevBackendClient, RouteOutcome } from '../backend-client.js';
import { BackendClientError } from '../backend-client.js';

export const routeDecideInputSchema = {
  prompt: z
    .string()
    .min(1)
    .max(5000)
    .describe('The user prompt to route. 1–5000 characters.'),
  consequence_class: z
    .enum(['low', 'medium', 'high', 'irreversible'])
    .optional()
    .describe(
      'Consequence class (JEV-15). Drives the routing preference: high/irreversible → quality, low → economy.',
    ),
  allowed_model_ids: z
    .array(z.string())
    .optional()
    .describe('Optional whitelist of model ids to restrict the candidate pool.'),
  max_latency_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Hard latency budget in milliseconds (8-step constraint pipeline).'),
  budget_usd: z
    .number()
    .positive()
    .optional()
    .describe('Hard cost budget in USD (8-step constraint pipeline).'),
};

export type RouteDecideInput = z.infer<z.ZodObject<typeof routeDecideInputSchema>>;

/** Human-readable summary line describing the route tier. */
const TIER_EXPLAIN: Record<string, string> = {
  ROUTE: '高置信 · 直接路由（≥ high 阈值）',
  GATE: '中置信 · 标记观察（≥ mid 阈值）',
  ESCALATE: '低置信 · 转兜底模型（< mid 阈值）',
};

/**
 * Register `jev_route_decide` on the MCP server.
 *
 * @param server MCP server instance
 * @param client backend HTTP client
 */
export function registerRouteDecideTool(server: McpServer, client: JevBackendClient): void {
  server.registerTool(
    'jev_route_decide',
    {
      title: 'Jev 路由决策',
      description:
        '提交 prompt 给 JevRouter 后端执行真实路由决策，返回档位（ROUTE/GATE/ESCALATE）、置信度、选中模型、候选得分分布、被硬约束淘汰的模型，以及模型的实际回答文本。',
      inputSchema: routeDecideInputSchema,
    },
    async (args) => {
      // Preflight: give a clear error instead of a generic fetch failure.
      try {
        await client.health();
      } catch (err) {
        return errorResult(
          '后端未就绪',
          `无法连接 JevRouter 后端。请先启动：cd packages/backend && pnpm dev。\n\n原因：${describeError(err)}`,
        );
      }

      try {
        const outcome = await client.decide({
          prompt: args.prompt,
          ...(args.consequence_class !== undefined
            ? { consequenceClass: args.consequence_class }
            : {}),
          ...(args.allowed_model_ids !== undefined
            ? { allowedModelIds: args.allowed_model_ids }
            : {}),
          ...(args.max_latency_ms !== undefined ? { maxLatencyMs: args.max_latency_ms } : {}),
          ...(args.budget_usd !== undefined ? { budgetUsd: args.budget_usd } : {}),
        });
        return { content: [{ type: 'text', text: formatOutcome(outcome) }] };
      } catch (err) {
        if (err instanceof BackendClientError && err.code === 'ROUTE_TIMEOUT') {
          return errorResult('路由超时', describeError(err));
        }
        return errorResult('路由失败', describeError(err));
      }
    },
  );
}

/** Render a {@link RouteOutcome} as readable Markdown. */
export function formatOutcome(o: RouteOutcome): string {
  const lines: string[] = [];
  lines.push(`# 路由结果 · ${o.status}`);
  lines.push('');

  if (o.status === 'FAILED') {
    lines.push(`**失败原因**：${o.errorReason ?? 'unknown'} — ${o.errorMessage ?? ''}`);
    lines.push('');
  }

  lines.push('## 决策');
  lines.push(`- 档位：**${o.tier ?? '—'}** ${o.tier ? `（${TIER_EXPLAIN[o.tier] ?? ''}）` : ''}`);
  lines.push(`- 置信度：**${fmt(o.confidence)}**`);
  if (o.thresholds) {
    lines.push(`- 阈值：high ≥ ${o.thresholds.high} / mid ≥ ${o.thresholds.mid}`);
  }
  lines.push(`- 选中模型：**${o.selectedModelId ?? '—'}**`);
  lines.push(`- 决策来源：${o.decisionSource ?? '—'}`);
  if (o.status === 'ESCALATED') {
    // ESCALATE 不自动执行模型（spec ROUTE_ESCALATED），故后端不产
    // MODEL_SELECTED；这里用候选分布的首位作为建议兜底模型。
    const suggestion = o.candidateScores[0]?.modelId;
    if (suggestion) {
      lines.push(`- 建议兜底模型：**${suggestion}**（候选分布首位，未自动执行）`);
    }
    lines.push(`- 升级原因：${o.escalationReason ?? '—'}`);
  }
  lines.push('');

  if (o.constraintFallback) {
    lines.push('> ⚠️ 硬约束回落：候选池经回落得到，约束严格性已放宽（见 constraintFallback 审计）。');
    lines.push('');
  }

  if (o.jevAnswers.length > 0) {
    lines.push('## 类型化答案（Jev 五问）');
    for (const a of o.jevAnswers) {
      lines.push(`- **${a.tag}** [${a.type}] = ${a.value}`);
    }
    lines.push('');
  }

  if (o.rationale) {
    lines.push(`**选型依据**：${o.rationale}`);
    lines.push('');
  }
  if (o.winnerReason) {
    lines.push(`**先验归因**：${o.winnerReason}`);
    lines.push('');
  }

  if (o.candidateScores.length > 0) {
    lines.push('## 候选得分分布（Top 10）');
    lines.push('| # | 模型 | 概率 | raw | 先验Δ |');
    lines.push('|---|---|---|---|---|');
    for (const c of o.candidateScores.slice(0, 10)) {
      lines.push(
        `| ${c.rankIndex} | ${c.modelId} | ${fmt(c.probability)} | ${fmt(c.raw)} | ${fmt(c.priorDelta)} |`,
      );
    }
    lines.push('');
  }

  if (o.eliminated.length > 0) {
    lines.push('## 硬约束淘汰');
    for (const e of o.eliminated) {
      lines.push(`- ${e.modelId}：${e.reason}`);
    }
    lines.push('');
  }

  if (o.usage) {
    lines.push('## 执行');
    lines.push(`- 模型：${o.usage.modelId ?? '—'}`);
    lines.push(`- 耗时：${o.usage.latencyMs} ms`);
    lines.push(`- tokens：${o.usage.promptTokens} in / ${o.usage.completionTokens} out`);
    lines.push(`- 成本：$${o.usage.costUsd.toFixed(6)}（${o.usage.usageSource ?? 'unknown'}）`);
    lines.push('');
  }

  if (o.result.trim() !== '') {
    lines.push('## 模型回答');
    lines.push('```');
    lines.push(o.result);
    lines.push('```');
  }

  lines.push('');
  lines.push(`<sub>事件数：${o.events.length} · requestId: ${o.requestId}</sub>`);
  return lines.join('\n');
}

function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}

function describeError(err: unknown): string {
  if (err instanceof BackendClientError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function errorResult(title: string, detail: string) {
  return {
    content: [{ type: 'text' as const, text: `# ${title}\n\n${detail}` }],
    isError: true,
  };
}
