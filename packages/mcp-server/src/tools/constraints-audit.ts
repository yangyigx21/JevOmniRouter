/**
 * MCP tool: `jev_constraints_audit`.
 *
 * Runs the 8-step hard-constraint pipeline (CONSTRAIN-1~5) locally against the
 * live catalog and reports, per model, every step's pass/fail plus the primary
 * elimination reason.
 *
 * Why local: the pipeline is a pure function (`evaluateConstraints`) with no
 * I/O and no side effects. Running it in-process avoids creating a route,
 * calling Jev, or executing any model — the whole audit costs nothing and
 * returns in milliseconds.
 *
 * Ordering and semantics come straight from the backend module, so this tool
 * can never drift from the real routing behaviour.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { evaluateConstraints, type ConstraintInput } from '@jev-router/backend';
import type { CatalogEntry } from '@jev-router/backend';
import type { JevBackendClient } from '../backend-client.js';
import { BackendClientError } from '../backend-client.js';

export const constraintsAuditInputSchema = {
  required_modalities: z
    .array(z.string())
    .optional()
    .describe('Required input modalities (e.g. ["text","image"]). Step 3.'),
  required_capabilities: z
    .array(z.string())
    .optional()
    .describe('Required capability tags (e.g. ["code","vision"]). Step 3.'),
  max_context_tokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Minimum required context window in tokens. Step 4.'),
  budget_usd: z
    .number()
    .positive()
    .optional()
    .describe('Cost budget in USD. Step 7.'),
  max_latency_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('P95 latency hard limit in ms. Step 8.'),
  data_regions: z
    .array(z.string())
    .optional()
    .describe('Allowed data regions (e.g. ["eu","us"]). Step 5.'),
  risk_policy: z
    .enum(['allow', 'block'])
    .optional()
    .describe('Risk policy. `block` rejects all models (step 5).'),
  allowed_model_ids: z
    .array(z.string())
    .optional()
    .describe('Restrict the audited pool to these model ids.'),
  only_eliminated: z
    .boolean()
    .optional()
    .describe('Only show eliminated models (skip the eligible list detail).'),
};

export type ConstraintsAuditInput = z.infer<z.ZodObject<typeof constraintsAuditInputSchema>>;

export function registerConstraintsAuditTool(server: McpServer, client: JevBackendClient): void {
  server.registerTool(
    'jev_constraints_audit',
    {
      title: 'Jev 硬约束审计',
      description:
        '对当前模型清单逐模型执行 8 步硬约束流水线（目录/权限/模态能力/上下文/数据区域/风险/预算/延迟），返回每步 pass/fail 与主淘汰原因。纯本地计算，不创建路由、不调用模型、无成本。',
      inputSchema: constraintsAuditInputSchema,
    },
    async (args) => {
      let entries: CatalogEntry[];
      try {
        const snapshot = await client.models();
        entries = snapshot.models.map((m) => m.profile as unknown as CatalogEntry);
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `# 后端未就绪\n\n无法读取模型清单。请先启动：cd packages/backend && pnpm dev。\n\n原因：${describeError(err)}`,
            },
          ],
          isError: true,
        };
      }

      const pool = args.allowed_model_ids?.length
        ? entries.filter((e) => args.allowed_model_ids!.includes(e.modelId))
        : entries;

      const constraints: ConstraintInput['constraints'] = {
        ...(args.required_modalities ? { requiredModalities: args.required_modalities } : {}),
        ...(args.required_capabilities ? { requiredCapabilities: args.required_capabilities } : {}),
        ...(args.max_context_tokens !== undefined ? { maxContextTokens: args.max_context_tokens } : {}),
        ...(args.budget_usd !== undefined ? { budgetUsd: args.budget_usd } : {}),
        ...(args.max_latency_ms !== undefined ? { maxLatencyMs: args.max_latency_ms } : {}),
        ...(args.data_regions ? { dataRegions: args.data_regions } : {}),
        ...(args.risk_policy ? { riskPolicy: args.risk_policy } : {}),
      };

      const results = pool.map((model, i) =>
        evaluateConstraints({ model, catalogIndex: i, constraints }),
      );
      return {
        content: [{ type: 'text', text: formatAudit(results, args, entries.length) }],
      };
    },
  );
}

type ConstraintResult = ReturnType<typeof evaluateConstraints>;

function formatAudit(
  results: ConstraintResult[],
  args: ConstraintsAuditInput,
  totalInCatalog: number,
): string {
  const lines: string[] = [];
  const eligible = results.filter((r) => r.eligible);
  const eliminated = results.filter((r) => !r.eligible);

  lines.push('# 硬约束审计（8 步流水线）');
  lines.push('');
  lines.push(
    `目录共 ${totalInCatalog} 个模型 · 审计 ${results.length} 个 · 通过 **${eligible.length}** · 淘汰 **${eliminated.length}**`,
  );
  lines.push('');

  const applied: string[] = [];
  if (args.required_modalities) applied.push(`模态=${args.required_modalities.join('/')}`);
  if (args.required_capabilities) applied.push(`能力=${args.required_capabilities.join('/')}`);
  if (args.max_context_tokens !== undefined) applied.push(`上下文≥${args.max_context_tokens}`);
  if (args.budget_usd !== undefined) applied.push(`预算≤$${args.budget_usd}`);
  if (args.max_latency_ms !== undefined) applied.push(`延迟≤${args.max_latency_ms}ms`);
  if (args.data_regions) applied.push(`区域=${args.data_regions.join('/')}`);
  if (args.risk_policy) applied.push(`风险=${args.risk_policy}`);
  if (args.allowed_model_ids) applied.push(`白名单=${args.allowed_model_ids.length}个`);
  lines.push(applied.length > 0 ? `**生效约束**：${applied.join(' · ')}` : '_未指定约束（全部通过）_');
  lines.push('');

  lines.push('## 淘汰模型');
  if (eliminated.length === 0) {
    lines.push('_无淘汰。_');
  } else {
    lines.push('| 模型 | 主淘汰原因 | 失败步骤 |');
    lines.push('|---|---|---|');
    for (const r of eliminated) {
      const failed = r.auditSummary.filter((s) => !s.passed);
      const steps = failed.map((s) => `${s.step}.${s.name}`).join('; ') || '—';
      lines.push(`| ${r.modelId} | ${r.primaryEliminationReason ?? 'UNKNOWN'} | ${steps} |`);
    }
  }
  lines.push('');

  if (!args.only_eliminated) {
    lines.push('## 通过模型');
    lines.push(
      eligible.length > 0
        ? eligible.map((r) => r.modelId).join(', ')
        : '_无通过模型 —— 约束过严，真实路由会触发回落（constraintFallback）。_',
    );
    lines.push('');

    if (eliminated.length > 0) {
      lines.push('## 完整 8 步明细');
      for (const r of eliminated.slice(0, 5)) {
        lines.push(`### ${r.modelId}`);
        for (const s of r.auditSummary) {
          lines.push(`- 第${s.step}步 ${s.name}：${s.passed ? '✓' : `✗ ${s.code ?? ''}${s.reason ? ` — ${s.reason}` : ''}`}`);
        }
      }
      if (eliminated.length > 5) {
        lines.push(`\n_（仅展示前 5 个淘汰模型的明细，共 ${eliminated.length} 个）_`);
      }
    }
  }

  return lines.join('\n');
}

function describeError(err: unknown): string {
  if (err instanceof BackendClientError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
