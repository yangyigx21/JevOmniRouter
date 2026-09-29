/**
 * MCP tool: `jev_score_explain`.
 *
 * Explains *why* a model won: the Jev five-question profile, the softmax score
 * distribution, per-model experience-prior deltas, the trial-break result, and
 * the confidence → tier threshold decision.
 *
 * Two modes:
 *  - `request_id` given → explain an existing decision read from the decisions
 *    DB (free, no model call).
 *  - `prompt` given     → run a real decision and explain its scoring chain.
 *    NOTE: the backend triggers the full orchestration on `POST /v1/routes`
 *    (there is no decision-only endpoint), so this costs one model call —
 *    identical to `jev_route_decide`.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DecisionRecordEntry, JevBackendClient, RouteOutcome } from '../backend-client.js';
import { BackendClientError } from '../backend-client.js';

export const scoreExplainInputSchema = {
  prompt: z
    .string()
    .min(1)
    .max(5000)
    .optional()
    .describe('Prompt to route and explain. Runs a real decision (costs one model call).'),
  request_id: z
    .string()
    .optional()
    .describe('Explain an existing decision by requestId (read from the decisions DB, free).'),
  consequence_class: z
    .enum(['low', 'medium', 'high', 'irreversible'])
    .optional()
    .describe('Consequence class, only meaningful together with `prompt`.'),
  top_n: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('How many candidates to show in the distribution table (default 10).'),
};

export type ScoreExplainInput = z.infer<z.ZodObject<typeof scoreExplainInputSchema>>;

export function registerScoreExplainTool(server: McpServer, client: JevBackendClient): void {
  server.registerTool(
    'jev_score_explain',
    {
      title: 'Jev 评分归因',
      description:
        '解释模型为何胜出：Jev 五问画像、softmax 得分分布、per-model 经验先验 Δ、同分决胜、置信度→档位阈值判定。支持按 requestId 解释既有决策（免费），或给定 prompt 跑一次真实决策再解释。',
      inputSchema: scoreExplainInputSchema,
    },
    async (args) => {
      if (!args.prompt && !args.request_id) {
        return {
          content: [
            {
              type: 'text' as const,
              text: '# 参数缺失\n\n请提供 `prompt`（跑一次真实决策）或 `request_id`（解释既有决策）。',
            },
          ],
          isError: true,
        };
      }

      const topN = args.top_n ?? 10;

      // Free path: explain an existing decision from the decisions DB.
      if (!args.prompt && args.request_id) {
        try {
          const store = await client.decisionStore();
          const record = store.recent.find(
            (r) => r.requestId === args.request_id || r.decisionId === args.request_id,
          );
          if (!record) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `# 未找到决策\n\n决策库 recent 中无 requestId/decisionId = \`${args.request_id}\` 的记录（近期仅保留 ${store.recent.length} 条）。`,
                },
              ],
              isError: true,
            };
          }
          return { content: [{ type: 'text', text: formatFromRecord(record, topN) }] };
        } catch (err) {
          return errorResult('读取决策库失败', describeError(err));
        }
      }

      // Live path: run a real decision, then explain its scoring chain.
      try {
        const outcome = await client.decide({
          prompt: args.prompt!,
          ...(args.consequence_class !== undefined
            ? { consequenceClass: args.consequence_class }
            : {}),
        });
        return { content: [{ type: 'text', text: formatFromOutcome(outcome, topN) }] };
      } catch (err) {
        return errorResult('路由失败', describeError(err));
      }
    },
  );
}

/** Explain a live outcome (has priorΔ and raw, the richest form). */
function formatFromOutcome(o: RouteOutcome, topN: number): string {
  const lines: string[] = [];
  lines.push('# 评分归因（实时决策）');
  lines.push('');
  lines.push(
    `档位 **${o.tier ?? '—'}** · 置信度 **${fmt(o.confidence)}** · 选中 **${o.selectedModelId ?? '（ESCALATE，未自动执行）'}**`,
  );
  lines.push('');

  pushChain(lines);
  pushJevAnswers(lines, o.jevAnswers);
  pushThresholds(lines, o.thresholds, o.confidence, o.tier);
  pushRationale(lines, o.rationale, o.winnerReason);
  pushDistribution(lines, o.candidateScores, topN);
  pushEliminated(lines, o.eliminated);
  pushPriorNote(lines, o.priorDeltas);
  pushFooter(lines, o.requestId, o.events.length);
  return lines.join('\n');
}

/** Explain a stored decision (no raw/priorΔ — the DB keeps only probabilities). */
function formatFromRecord(r: DecisionRecordEntry, topN: number): string {
  const lines: string[] = [];
  lines.push('# 评分归因（决策库既有记录）');
  lines.push('');
  lines.push(
    `档位 **${r.routeTier}** · 置信度 **${fmt(r.confidence)}** · 选中 **${r.selectedModelId}**`,
  );
  lines.push(`> 决策时间：${r.createdAt} · 来源：${r.decisionSource}`);
  lines.push('');

  pushChain(lines);
  pushJevAnswers(lines, r.jevAnswers);
  pushThresholds(lines, r.thresholds, r.confidence, r.routeTier);
  if (r.jevRecommendation) {
    lines.push(`**Jev 原始建议**：${r.jevRecommendation}${r.jevRecommendation !== r.selectedModelId ? '（经硬约束后被改选，CONSTRAIN-3）' : ''}`);
    lines.push('');
  }
  pushDistribution(
    lines,
    r.distribution.map((d) => ({ ...d, raw: Number.NaN })),
    topN,
  );
  pushEliminated(lines, r.eliminated);
  if (r.constraintFallback) {
    lines.push(`> ⚠️ 本次存在硬约束回落（${r.constraintFallbackReason ?? 'unknown'}），约束严格性已放宽。`);
    lines.push('');
  }
  pushFooter(lines, r.requestId, null);
  return lines.join('\n');
}

function pushChain(lines: string[]): void {
  lines.push('## 评分链路');
  lines.push('');
  lines.push('```');
  lines.push('STATE（证据提取）→ 三原语 CHOICE/SCORE/NOUL（Jev 五问）→ JEV（类型化答案）');
  lines.push('  → PROBABILITY（softmax + 先验注入 + 同分决胜）→ 阈值分档 ROUTE/GATE/ESCALATE');
  lines.push('```');
  lines.push('');
  lines.push(
    '关键：经验先验 **在 softmax 之前** 注入（SCORE-3 双序契约）；`Δprior` 即该模型在 softmax 前获得的分数修正量。',
  );
  lines.push('');
}

function pushJevAnswers(
  lines: string[],
  answers: { tag: string; type: string; value: string }[],
): void {
  if (answers.length === 0) return;
  lines.push('## Jev 五问画像');
  lines.push('| 问题 | 原语 | 答案 |');
  lines.push('|---|---|---|');
  for (const a of answers) lines.push(`| ${a.tag} | ${a.type} | ${a.value} |`);
  lines.push('');
}

function pushThresholds(
  lines: string[],
  thresholds: { high: number; mid: number } | null,
  confidence: number | null,
  tier: string | null,
): void {
  if (!thresholds) return;
  lines.push('## 档位判定');
  lines.push('');
  const c = confidence ?? 0;
  const verdict =
    c >= thresholds.high
      ? `≥ high(${thresholds.high}) → ROUTE`
      : c >= thresholds.mid
        ? `∈ [mid(${thresholds.mid}), high(${thresholds.high})) → GATE`
        : `< mid(${thresholds.mid}) → ESCALATE`;
  lines.push(`置信度 ${fmt(confidence)} ${verdict}（实际档位：**${tier ?? '—'}**）`);
  lines.push('');
}

function pushRationale(
  lines: string[],
  rationale: string | null,
  winnerReason: string | null,
): void {
  if (rationale) {
    lines.push(`**选型依据**：${rationale}`);
    lines.push('');
  }
  if (winnerReason) {
    lines.push(`**先验归因**：${winnerReason}`);
    lines.push('');
  }
}

function pushDistribution(
  lines: string[],
  scores: { modelId: string; raw: number; probability?: number; rankIndex: number; priorDelta?: number }[],
  topN: number,
): void {
  if (scores.length === 0) return;
  const hasRaw = scores.some((s) => Number.isFinite(s.raw));
  lines.push(`## 候选得分分布（Top ${Math.min(topN, scores.length)}）`);
  if (hasRaw) {
    lines.push('| # | 模型 | 概率 | raw | Δprior |');
    lines.push('|---|---|---|---|---|');
    for (const s of scores.slice(0, topN)) {
      lines.push(
        `| ${s.rankIndex} | ${s.modelId} | ${fmt(s.probability)} | ${fmt(s.raw)} | ${fmt(s.priorDelta)} |`,
      );
    }
  } else {
    lines.push('| # | 模型 | 概率 |');
    lines.push('|---|---|---|');
    for (const s of scores.slice(0, topN)) {
      lines.push(`| ${s.rankIndex} | ${s.modelId} | ${fmt(s.probability)} |`);
    }
    lines.push('');
    lines.push('_决策库仅保留概率分布；raw 分与先验 Δ 需实时决策才有。_');
  }
  lines.push('');
}

function pushEliminated(lines: string[], eliminated: { modelId: string; reason: string }[]): void {
  if (eliminated.length === 0) return;
  lines.push('## 硬约束淘汰（CONSTRAIN-1）');
  lines.push('| 模型 | 淘汰原因 |');
  lines.push('|---|---|');
  for (const e of eliminated) lines.push(`| ${e.modelId} | ${e.reason} |`);
  lines.push('');
  lines.push('> 硬约束优先于 Jev 建议（CONSTRAIN-2/3）：Jev 推荐的模型若被淘汰，改选次优。');
  lines.push('');
}

function pushPriorNote(lines: string[], priorDeltas: Record<string, number> | null): void {
  if (!priorDeltas) return;
  const vals = Object.values(priorDeltas);
  if (vals.length === 0) return;
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  lines.push(
    `**先验 Δ 区间**：[${min.toFixed(3)}, ${max.toFixed(3)}]。权重默认 intentMatch 0.60 / complexityFit 0.40 / budgetFit 0.30 / capabilityFit 0.25 / urgencyFit 0.20，受 \`MAX_PRIOR_DELTA\` 夹紧。`,
  );
  lines.push('');
}

function pushFooter(lines: string[], requestId: string, eventCount: number | null): void {
  lines.push('---');
  lines.push(
    `<sub>requestId: ${requestId}${eventCount !== null ? ` · 事件数：${eventCount}` : ''}</sub>`,
  );
}

function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (!Number.isFinite(v)) return '—';
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
