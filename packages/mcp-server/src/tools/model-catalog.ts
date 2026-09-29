/**
 * MCP tool: `jev_model_catalog`.
 *
 * Returns the live model catalog: per-model profile (capability / quality /
 * cost / latency / context window / pricing), decision discrimination score,
 * accumulated stats, industry rating, plus vendor groupings.
 *
 * Read-only and side-effect free except for the backend's TTL-based catalog
 * refresh, which the backend already performs on every `/v1/models` call.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  CatalogProfile,
  JevBackendClient,
  ModelInfoEntry,
  ModelsResponse,
} from '../backend-client.js';
import { BackendClientError } from '../backend-client.js';

export const modelCatalogInputSchema = {
  vendor: z
    .string()
    .optional()
    .describe('Only return models from this vendor (e.g. `openai`, `deepseek`). Case-insensitive.'),
  capability_tag: z
    .string()
    .optional()
    .describe('Only return models carrying this capability tag (e.g. `code`, `vision`, `low-cost`).'),
  free_only: z
    .boolean()
    .optional()
    .describe('Only return free models (input & output price both 0) — the ESCALATE fallback pool.'),
  sort_by: z
    .enum(['discrimination', 'capability', 'quality', 'cost', 'latency', 'industry'])
    .optional()
    .describe('Sort key (descending). Defaults to `discrimination`.'),
};

export type ModelCatalogInput = z.infer<z.ZodObject<typeof modelCatalogInputSchema>>;

export function registerModelCatalogTool(server: McpServer, client: JevBackendClient): void {
  server.registerTool(
    'jev_model_catalog',
    {
      title: 'Jev 模型能力清单',
      description:
        '读取 JevRouter 实时模型清单：每个模型的能力/质量/成本/延迟画像、上下文窗口、价格、决策区分度评分、累计选中统计与业界评分，以及按厂商的分组。支持按厂商、能力标签、免费模型过滤与多键排序。',
      inputSchema: modelCatalogInputSchema,
    },
    async (args) => {
      let snapshot: ModelsResponse;
      try {
        snapshot = await client.models();
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

      const filtered = applyFilters(snapshot.models, args);
      const sorted = applySort(filtered, args.sort_by ?? 'discrimination');
      return { content: [{ type: 'text', text: formatCatalog(snapshot, sorted, args) }] };
    },
  );
}

function applyFilters(entries: ModelInfoEntry[], args: ModelCatalogInput): ModelInfoEntry[] {
  let out = entries;
  if (args.vendor) {
    const v = args.vendor.toLowerCase();
    out = out.filter(
      (e) => e.profile.vendor.toLowerCase() === v || e.profile.vendorLabel.toLowerCase() === v,
    );
  }
  if (args.capability_tag) {
    const tag = args.capability_tag.toLowerCase();
    out = out.filter((e) => e.profile.capabilityTags.some((t) => t.toLowerCase() === tag));
  }
  if (args.free_only) {
    out = out.filter((e) => isFree(e.profile));
  }
  return out;
}

function applySort(entries: ModelInfoEntry[], sortBy: NonNullable<ModelCatalogInput['sort_by']>): ModelInfoEntry[] {
  const selectors: Record<typeof sortBy, (e: ModelInfoEntry) => number> = {
    discrimination: (e) => e.discrimination.score,
    capability: (e) => e.profile.capability,
    quality: (e) => e.profile.quality,
    cost: (e) => e.profile.cost,
    latency: (e) => e.profile.latency,
    industry: (e) => e.industry?.score ?? -1,
  };
  const pick = selectors[sortBy];
  return [...entries].sort((a, b) => pick(b) - pick(a) || a.modelId.localeCompare(b.modelId));
}

/** A model is "free" when both prices are zero (ESCALATE fallback pool). */
export function isFree(profile: CatalogProfile): boolean {
  return profile.inputPricePer1k === 0 && profile.outputPricePer1k === 0;
}

function formatCatalog(
  snapshot: ModelsResponse,
  entries: ModelInfoEntry[],
  args: ModelCatalogInput,
): string {
  const lines: string[] = [];
  const filters: string[] = [];
  if (args.vendor) filters.push(`vendor=${args.vendor}`);
  if (args.capability_tag) filters.push(`tag=${args.capability_tag}`);
  if (args.free_only) filters.push('free_only');
  if (args.sort_by) filters.push(`sort=${args.sort_by}`);

  lines.push(`# 模型能力清单`);
  lines.push('');
  lines.push(
    `目录版本 \`${snapshot.catalogVersion}\` · 来源 \`${snapshot.source}\` · 共 ${snapshot.models.length} 个模型` +
      (filters.length > 0 ? ` · 过滤：${filters.join(', ')}` : ''),
  );
  if (snapshot.sourceError) {
    lines.push(`> ⚠️ ${snapshot.sourceError}`);
  }
  lines.push('');

  if (entries.length === 0) {
    lines.push('_无匹配模型。_');
    return lines.join('\n');
  }

  lines.push(`## 模型（${entries.length}）`);
  lines.push('| 模型 | 厂商 | 能力 | 质量 | 成本 | 延迟 | 上下文 | 价格(in/out per 1K) | 区分度 | 选中 | 标签 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const e of entries) {
    const p = e.profile;
    const price = isFree(p)
      ? '**免费**'
      : `$${p.inputPricePer1k} / $${p.outputPricePer1k}`;
    lines.push(
      `| ${p.modelId} | ${p.vendorLabel} | ${p.capability} | ${p.quality} | ${p.cost} | ${p.latency} | ${fmtCtx(p.contextWindow)} | ${price} | ${e.discrimination.score} (${e.discrimination.rating}${e.discrimination.coldStart ? ',冷启动' : ''}) | ${e.stats?.selectedCount ?? 0} | ${p.capabilityTags.join(',')} |`,
    );
  }
  lines.push('');

  lines.push('## 厂商分组');
  lines.push('| 厂商 | 模型数 | 最高区分度 | 模型 |');
  lines.push('|---|---|---|---|');
  for (const g of snapshot.vendors) {
    lines.push(`| ${g.vendorLabel} | ${g.modelCount} | ${g.topDiscrimination} | ${g.modelIds.join(', ')} |`);
  }
  lines.push('');

  const freeOnes = snapshot.models.filter((e) => isFree(e.profile));
  if (freeOnes.length > 0) {
    lines.push(
      `## 免费兜底模型（ESCALATE 用）\n${freeOnes.map((e) => e.modelId).join(', ')}`,
    );
  }

  return lines.join('\n');
}

function fmtCtx(n: number): string {
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

function describeError(err: unknown): string {
  if (err instanceof BackendClientError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
