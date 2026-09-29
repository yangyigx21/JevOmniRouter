/**
 * @module jev-routing
 * @implements CONSTRAIN-3, SCORE-3, JEV-2/JEV-5
 *
 * Jev 类型化答案 → 候选模型先验。
 *
 * ## 为什么需要这一层
 *
 * 真实 System One 只对**被评估内容**回答类型化问题（intent / complexity /
 * urgency / budget / capability），**不评模型**。因此「Jev 决策路由到哪个模型」
 * 必须由本模块完成：把 Jev 的类型化答案翻译成 per-model 的 `raw` 分修正量，
 * 再交给 `scoreModels` 在 **softmax 之前**注入（SCORE-3 双序契约要求的唯一
 * 注入点），得到最终分布。
 *
 * ## 先验构成
 *
 * | 维度 | 权重 | 含义 |
 * |------|------|------|
 * | `intentMatch`   | 0.60 | Jev 判定的意图是否命中该模型的能力标签 |
 * | `complexityFit` | 0.40 | Jev 复杂度 vs 该模型能力画像（高难需高能） |
 * | `capabilityFit` | 0.25 | Jev 所需能力等级 vs 该模型能力（低难不必用大炮） |
 * | `urgencyFit`    | 0.20 | 紧急时偏向低延迟模型 |
 * | `budgetFit`     | 0.30 | 成本敏感时偏向低成本模型 |
 *
 * 所有修正量最终夹在 ±`MAX_PRIOR_DELTA` 内（对齐 shared 层 `EXP_CORR_MAX`
 * 的量级约束），避免先验压倒静态画像。
 */
import { EXP_CORR_MAX } from '@jev-router/shared';
import type { CatalogEntry } from './model-catalog.js';
import type { JevAnswer } from './jev-adapter.js';

/** Jev 五问归一化后的请求画像。 */
export interface JevRequestProfile {
  /** 主导意图（`choice` 原语的选中项，如 `code` / `data` / `other`）。 */
  intent: string;
  /** 复杂度 0..1（`score` 原语按 rubric 位置归一化）。 */
  complexity: number;
  /** 所需能力等级 0..1（同上）。 */
  capability: number;
  /** 紧急度 P(yes) 0..1。 */
  urgency: number;
  /** 成本敏感 P(yes) 0..1。 */
  budget: number;
  /** Jev 自评置信度 0..1（choice 置信度优先）。 */
  confidence: number;
  /** 实际应答的模型版本。 */
  model: string;
}

/** 先验权重（可按后果等级调整，此处为默认值）。 */
export interface JevPriorWeights {
  intentMatch: number;
  complexityFit: number;
  capabilityFit: number;
  urgencyFit: number;
  budgetFit: number;
}

/** 默认权重。 */
export const DEFAULT_JEV_PRIOR_WEIGHTS: JevPriorWeights = {
  intentMatch: 0.6,
  complexityFit: 0.4,
  capabilityFit: 0.25,
  urgencyFit: 0.2,
  budgetFit: 0.3,
};

/** 单个先验修正量的绝对值上限。 */
export const MAX_PRIOR_DELTA = EXP_CORR_MAX;

/** Jev 意图 → 模型能力标签的映射。 */
const INTENT_TAG_MAP: Record<string, string[]> = {
  code: ['code'],
  data: ['reasoning', 'low-cost'],
  writing: ['creative', 'low-cost'],
  vision: ['vision'],
  reasoning: ['reasoning'],
  longCtx: ['long-context', 'vision'],
  chat: ['general'],
  other: ['general', 'low-cost'],
};

/** 归一化 Jev 原始答案 → 请求画像。 */
export function buildJevProfile(input: {
  answers: readonly JevAnswer[];
  model: string;
}): JevRequestProfile {
  const pick = (id: string) => input.answers.find((a) => a.questionId === id);
  const choice = input.answers.find((a) => a.primitive === 'choice');
  const choiceConfidence =
    pick('intent')?.evidenceStrength ??
    input.answers
      .map((a) => a.evidenceStrength)
      .find((v): v is number => typeof v === 'number') ??
    0;

  return {
    intent: choice?.choiceWinner ?? pick('intent')?.choiceWinner ?? 'other',
    complexity: pick('complexity')?.scoreValue ?? 0,
    capability: pick('capability')?.scoreValue ?? 0,
    urgency: pick('urgency')?.noulProbability ?? 0.3,
    budget: pick('budget')?.noulProbability ?? 0.3,
    confidence: choiceConfidence,
    model: input.model,
  };
}

/**
 * 计算 per-model 先验修正量（**目录序**，与 `scoreModels` 输入对齐）。
 *
 * 注入点在 softmax 之前（SCORE-3），因此这里返回的是 `raw` 的加性修正。
 */
export function jevPriorDeltas(
  profile: JevRequestProfile,
  pool: readonly CatalogEntry[],
  weights: JevPriorWeights = DEFAULT_JEV_PRIOR_WEIGHTS,
): number[] {
  const wantTags = INTENT_TAG_MAP[profile.intent] ?? INTENT_TAG_MAP.other;
  return pool.map((entry) => {
    const tags = entry.capabilityTags ?? [];

    // 1) 意图命中：完全命中 1.0，部分命中按比例，无命中 0。
    const hits = wantTags.filter((t) => tags.includes(t)).length;
    const intentAffinity = wantTags.length === 0 ? 0 : Math.min(1, hits / wantTags.length);

    // 2) 复杂度适配：高难需高能力；低难度时大模型也有优势（避免只用贵的）。
    const complexityFit = profile.complexity * entry.capability;

    // 3) 能力适配：所需能力与模型能力接近时最优（既不不够，也不过度）。
    const capabilityFit = 1 - Math.abs(profile.capability - entry.capability);

    // 4) 紧急度：越紧急越偏向低延迟（latency 越小越好）。
    const urgencyFit = profile.urgency * (1 - entry.latency);

    // 5) 成本敏感：越敏感越偏向低成本（cost 越小越好）。
    const budgetFit = profile.budget * (1 - entry.cost);

    const delta =
      weights.intentMatch * (intentAffinity - 0.5) +
      weights.complexityFit * (complexityFit - 0.5) +
      weights.capabilityFit * (capabilityFit - 0.5) +
      weights.urgencyFit * (urgencyFit - 0.5) +
      weights.budgetFit * (budgetFit - 0.5);

    return clampDelta(delta);
  });
}

/** 供前端 / 决策库展示的可读先验说明。 */
export function explainJevPrior(
  profile: JevRequestProfile,
  entry: CatalogEntry,
): string {
  const wantTags = INTENT_TAG_MAP[profile.intent] ?? INTENT_TAG_MAP.other;
  const hits = wantTags.filter((t) => (entry.capabilityTags ?? []).includes(t));
  return hits.length > 0
    ? `Jev 意图「${profile.intent}」命中该模型能力标签：${hits.join('/')}`
    : `Jev 意图「${profile.intent}」未命中该模型能力标签（${wantTags.join('/')}）`;
}

function clampDelta(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(MAX_PRIOR_DELTA, Math.max(-MAX_PRIOR_DELTA, x));
}
