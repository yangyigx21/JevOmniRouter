/**
 * mockScenario — Rich mock data for local frontend interaction demo.
 *
 * Provides a timed event sequence that simulates the full Decision Runtime
 * main chain with realistic data: 6 candidate models, JEV answers, scores,
 * streaming text, and tier-based outcomes.
 *
 * Three scenarios:
 *   1. ROUTE  — high confidence (0.87), auto-route to gpt-4o
 *   2. GATE   — medium confidence (0.68), route with observation
 *   3. ESCALATE — low confidence (0.52), escalate to human review
 */
import type { RouteEvent, RouteEventType } from '../store/types.js';
import type { JevAnswerEntry, ModelScoreEntry } from '../store/routeEventReducer.js';

// ── Scenario definitions ──

export interface MockScenario {
  id: string;
  label: string;
  prompt: string;
  tier: 'ROUTE' | 'GATE' | 'ESCALATE';
  confidence: number;
  winnerModelId: string;
  jevAnswers: JevAnswerEntry[];
  candidateScores: ModelScoreEntry[];
  streamingText: string;
  eventDelayMs: number; // delay between each event
}

/** Scenario 1: Code review → ROUTE (high confidence, gpt-4o) */
export const SCENARIO_ROUTE: MockScenario = {
  id: 'route-code-review',
  label: '代码审查（高置信度路由）',
  prompt: '帮我审查这段 Python 代码的性能瓶颈，并给出重构方案',
  tier: 'ROUTE',
  confidence: 0.87,
  winnerModelId: 'gpt-4o',
  jevAnswers: [
    { tag: 'INTENT', type: 'choice', value: 'code · 代码审查与重构' },
    { tag: 'COMPLEXITY', type: 'score', value: '0.80 · 高复杂度，需深度推理' },
    { tag: 'URGENCY', type: 'noul', value: 'P(yes)=0.06 · 常规，无紧急时限' },
    { tag: 'BUDGET', type: 'noul', value: 'P(yes)=0.38 · 成本非首要约束' },
    { tag: 'CAPABILITY', type: 'score', value: '0.80 · 代码生成能力优先' },
  ],
  candidateScores: [
    { name: 'gpt-4o', score: 0.87, isWinner: true, color: 'var(--ok)' },
    { name: 'claude-3.5-sonnet', score: 0.72, color: 'var(--acc2)' },
    { name: 'qwen-2.5-coder', score: 0.68, color: 'var(--acc3)' },
    { name: 'gemini-1.5-pro', score: 0.55, color: 'var(--acc2)' },
    { name: 'mistral-large', score: 0.41, color: 'var(--tx2)' },
    { name: 'llama-3.1-70b', score: 0.35, color: 'var(--tx2)' },
  ],
  streamingText:
`经过 JEV 类型化分析，您的请求被归类为「代码审查 · 重构建议」类型，复杂度评分 4/5，需要深度推理能力。

综合评估 6 个候选模型后，gpt-4o 以 0.87 的校准置信度胜出：
- 推理能力：92%（匹配高复杂度需求）
- 代码生成：95%（5/5 capability score）
- 预算约束：成本 0.65 在可接受范围内

置信度 0.87 ≥ 0.82 阈值 → ROUTE 档位，自动执行。
决策来源：TypeSafe Jev（5 个类型化问题 + 校准评分 + 经验修正）`,
  eventDelayMs: 350,
};

/** Scenario 2: Data analysis → GATE (medium confidence, claude-3.5-sonnet) */
export const SCENARIO_GATE: MockScenario = {
  id: 'gate-data-analysis',
  label: '数据分析（中置信度观察）',
  prompt: '分析这份销售数据，找出增长趋势和异常点',
  tier: 'GATE',
  confidence: 0.68,
  winnerModelId: 'claude-3.5-sonnet',
  jevAnswers: [
    { tag: 'INTENT', type: 'choice', value: 'data · 数据趋势分析' },
    { tag: 'COMPLEXITY', type: 'score', value: '0.60 · 中等复杂度，需结构化输出' },
    { tag: 'URGENCY', type: 'noul', value: 'P(yes)=0.52 · 模糊区间' },
    { tag: 'BUDGET', type: 'noul', value: 'P(yes)=0.55 · 预算适中' },
    { tag: 'CAPABILITY', type: 'score', value: '0.60 · 长上下文与数据理解优先' },
  ],
  candidateScores: [
    { name: 'claude-3.5-sonnet', score: 0.68, isWinner: true, color: 'var(--warn)' },
    { name: 'gemini-1.5-pro', score: 0.63, color: 'var(--acc2)' },
    { name: 'gpt-4o', score: 0.61, color: 'var(--acc2)' },
    { name: 'qwen-2.5-coder', score: 0.42, color: 'var(--tx2)' },
    { name: 'mistral-large', score: 0.38, color: 'var(--tx2)' },
    { name: 'llama-3.1-70b', score: 0.28, color: 'var(--tx2)' },
  ],
  streamingText:
`您的请求被归类为「数据分析 · 趋势识别」，复杂度 3/5，但紧迫性和预算的 NOUL 指标接近不可区分区间（P=0.52/0.55），导致置信度下降。

claude-3.5-sonnet 以 0.68 校准置信度微弱胜出：
- 长上下文能力：200K token（匹配数据量需求）
- 数据理解：88%（结构化输出能力）
- 性价比：成本 0.60 适中

置信度 0.68 ∈ [0.60, 0.82) → GATE 档位，路由执行但建议对输出做抽样校验。
决策来源：TypeSafe Jev（5 个类型化问题 + 校准评分 + 经验修正）`,
  eventDelayMs: 400,
};

/** Scenario 3: Ambiguous request → ESCALATE (low confidence) */
export const SCENARIO_ESCALATE: MockScenario = {
  id: 'escalate-ambiguous',
  label: '模糊请求（转兜底模型）',
  prompt: '帮我处理一下那个事情',
  tier: 'ESCALATE',
  confidence: 0.52,
  winnerModelId: 'gpt-4o',
  jevAnswers: [
    { tag: 'INTENT', type: 'noul', value: 'P(yes)=0.38 · 意图模糊，无法归类' },
    { tag: 'COMPLEXITY', type: 'noul', value: 'P(yes)=0.45 · 复杂度不确定' },
    { tag: 'URGENCY', type: 'noul', value: 'P(yes)=0.50 · 紧迫性不明' },
    { tag: 'BUDGET', type: 'noul', value: 'P(yes)=0.55 · 预算偏好未知' },
    { tag: 'CAPABILITY', type: 'noul', value: 'P(yes)=0.42 · 能力需求无法判断' },
  ],
  candidateScores: [
    { name: 'gpt-4o', score: 0.52, isWinner: true, color: 'var(--bad)' },
    { name: 'claude-3.5-sonnet', score: 0.50, color: 'var(--acc2)' },
    { name: 'gemini-1.5-pro', score: 0.48, color: 'var(--acc2)' },
    { name: 'mistral-large', score: 0.45, color: 'var(--tx2)' },
    { name: 'qwen-2.5-coder', score: 0.43, color: 'var(--tx2)' },
    { name: 'llama-3.1-70b', score: 0.40, color: 'var(--tx2)' },
  ],
  streamingText:
`⚠ 低置信度 ESCALATE · 转兜底模型

您的请求意图极度模糊（INTENT: noul P=0.38），5 个类型化问题中有 4 个落入 NOUL（不可区分）区间，导致置信度仅 0.52。

虽然 gpt-4o 以微弱优势（0.52 vs 0.50）排名最高，但所有候选模型的得分分布过于接近，统计上无法区分优劣。

置信度 0.52 < 0.60 → ESCALATE 档位，已转兜底模型（免费模型）自动执行。

建议：请补充描述您的具体需求，例如：
- 您想处理什么类型的任务？（代码/文案/数据/翻译）
- 有没有时间要求？
- 预算范围是什么？`,
  eventDelayMs: 450,
};

export const ALL_SCENARIOS: MockScenario[] = [
  SCENARIO_ROUTE,
  SCENARIO_GATE,
  SCENARIO_ESCALATE,
];

// ── Event sequence builder ──

/**
 * Build a timed event sequence for a given scenario.
 * Returns an array of { delay, event } pairs ready for sequential dispatch.
 */
export function buildMockEventSequence(scenario: MockScenario): Array<{ delayMs: number; event: RouteEvent }> {
  const requestId = `req-mock-${Date.now()}`;
  const now = Date.now();
  let seq = 0;

  function makeEvent(type: RouteEventType, payload: Record<string, unknown> = {}): RouteEvent {
    return {
      eventId: `evt-${requestId}-${seq}`,
      requestId,
      type,
      timestamp: new Date(now + seq * 100).toISOString(),
      sequence: seq++,
      payload,
    };
  }

  const delay = scenario.eventDelayMs;

  return [
    // Stage 1: ingest
    { delayMs: 0, event: makeEvent('ROUTE_CREATED', { text: scenario.prompt }) },

    // Stage 2: experience retrieval
    { delayMs: delay, event: makeEvent('EXPERIENCE_RETRIEVED', {
      expVersion: 7,
      sampleCount: 142,
    }) },

    // Stage 3: JEV analysis
    { delayMs: delay, event: makeEvent('JEV_CALL_STARTED', {
      questionCount: 5,
    }) },

    { delayMs: delay * 2, event: makeEvent('JEV_DECISION_READY', {
      confidence: scenario.confidence,
      routeTier: scenario.tier,
      answers: scenario.jevAnswers,
      candidateScores: scenario.candidateScores.map((m) => ({
        modelId: m.name,
        raw: m.score,
        probability: m.score,
      })),
    }) },

    // Stage 4: constraint gate
    { delayMs: delay, event: makeEvent('CONSTRAINT_FILTERED', {
      modelId: 'llama-3.1-70b',
      reason: 'PII detected in prompt — blocked by constraint #2',
    }) },
    { delayMs: delay * 0.5, event: makeEvent('CONSTRAINT_GATE_PASSED', {
      passedCount: 5,
      filteredCount: 1,
    }) },

    // Stage 5: model execution
    { delayMs: delay, event: makeEvent('MODEL_CALL_STARTED', {
      modelId: scenario.winnerModelId,
    }) },
    { delayMs: delay, event: makeEvent('MODEL_SELECTED', {
      modelId: scenario.winnerModelId,
      selectionMode: scenario.tier === 'ESCALATE' ? 'RULE_FALLBACK' : 'TYPE_SAFE_JEV',
    }) },
    { delayMs: delay, event: makeEvent('MODEL_STREAMING', {
      delta: '', // start streaming
    }) },

    // Stage 6: completion
    { delayMs: delay * 3, event: makeEvent('MODEL_COMPLETED', {
      modelId: scenario.winnerModelId,
      tokenCount: Math.floor(200 + Math.random() * 300),
      latencyMs: Math.floor(800 + Math.random() * 1500),
    }) },

    // Stage 7: experience saved
    { delayMs: delay, event: makeEvent('EXPERIENCE_SAVED', {
      expVersion: 8,
      outcome: 'success',
    }) },
  ];
}

/**
 * Simulate streaming text: split the result into chunks and dispatch APPEND_RESULT_CHUNK.
 * Returns an array of { delay, chunk } pairs.
 */
export function buildStreamingChunks(text: string, chunkSize = 12): Array<{ delayMs: number; chunk: string }> {
  const chunks: Array<{ delayMs: number; chunk: string }> = [];
  let delay = 50;
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push({
      delayMs: delay,
      chunk: text.slice(i, i + chunkSize),
    });
    delay += 30 + Math.floor(Math.random() * 40); // simulate variable speed
  }
  return chunks;
}
