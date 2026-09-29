/**
 * @module jev-http-adapter
 * @implements JEV-1 / JEV-2 / JEV-3 / JEV-9, LLM-sdd.md 执行流程
 *
 * 真实 Jev System One HTTP 适配器 —— 调用 `config/models.json` 中配置的
 * `https://api.typesafe.ai/v1/systemone`。
 *
 * ## 真实接口契约（源自 `GET https://api.typesafe.ai/openapi.json`）
 *
 * 请求 `SystemOneRequest`：
 * ```json
 * {
 *   "state": "<被评估内容，string | object | array>",
 *   "model": "jev-latest",
 *   "questions": {
 *     "<自定义问题名>": { "type": "noul" | "choice" | "score", "instructions": "...", "criteria": ... }
 *   }
 * }
 * ```
 * - `choice.criteria`：**对象映射** `{ 选项名: 描述 }`，必填
 * - `score.criteria`：**有序数组** `["最低档描述", ..., "最高档描述"]`，必填，位置即分数（从 0 起）
 * - `noul.criteria`：可选 `{ "true": "...", "false": "..." }`
 *
 * 响应 `SystemOneResponse`：
 * ```json
 * {
 *   "model": "jev-1.13.0",
 *   "answers": { "<问题名>": { "type": ..., ... } },
 *   "usage": { "input_tokens": 302, "output_tokens": 21 }
 * }
 * ```
 * - `NoulAnswer`  = `{ type, noul }`（P(yes)）
 * - `ScoreAnswer` = `{ type, score, confidence, legend, probabilities }`（期望分 0..n-1）
 * - `ChoiceAnswer`= `{ type, choice, confidence, probabilities }`
 *
 * 契约要点：
 * - **JEV-3**：五问 MUST 打包在**单次**请求的 `questions` 里（MUST NOT 串行拆分）。
 * - **JEV-14**：`state` MUST 承载 `assembleState()` 的 6 段结构
 *   （GOAL / FACTS / ARTIFACTS / EVIDENCE / CONSTRAINTS / OPTIONS），
 *   使「结论不得冒充证据」与「菜单实时重建」在生产调用上生效。
 * - **JEV-1**：生产路径 MUST 走真实适配器，MUST NOT 用本地启发式冒充。
 * - **JEV-7**：真实调用打 `decisionSource=TYPE_SAFE_JEV` + `jev.provider=system-one`。
 * - **降级**：网络失败 / 超时 / 响应不可解析 → 抛 `JevAdapterError`，由编排器按
 *   CONSTRAIN-4 降级。
 */
import type { RawEvidence } from '@jev-router/shared';
import type { JevEndpointConfig } from './app-config.js';
import type {
  JevAnswer,
  JevBatchRequest,
  JevBatchResponse,
  PrimitiveKind,
  TypeSafeJevAdapter,
} from './jev-adapter.js';
import type { DecisionSource } from './decision-source.js';
import type { JevDecision, JevCandidateScore } from './decision-validator.js';
import { DECISION_SCHEMA_VERSION } from './decision-validator.js';
import type { CatalogEntry } from './model-catalog.js';
import type { EngineeredState, EvidenceEntry } from './state-engineering.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export type JevAdapterErrorCode =
  | 'JEV_TIMEOUT'
  | 'JEV_HTTP_ERROR'
  | 'JEV_INVALID_SCHEMA'
  | 'JEV_NOT_CONFIGURED'
  | 'JEV_NETWORK_ERROR';

export class JevAdapterError extends Error {
  constructor(
    readonly code: JevAdapterErrorCode,
    message: string,
    /** 供 CONSTRAIN-4 fallback 规则选择的降级原因。 */
    readonly fallbackReason: 'timeout' | 'invalid_schema' | 'adapter_error',
  ) {
    super(`[${code}] ${message}`);
    this.name = 'JevAdapterError';
  }
}

// ---------------------------------------------------------------------------
// 请求 / 响应形状（对齐 OpenAPI）
// ---------------------------------------------------------------------------

/** `noul` 原语的可选判据。 */
export interface NoulCriteria {
  true?: string;
  false?: string;
}

/** 单个问题（三原语之一）。 */
export type SystemOneQuestion =
  | { type: 'noul'; instructions: string; criteria?: NoulCriteria }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

/** System One 请求体。 */
export interface SystemOneRequest {
  state: string;
  model: string;
  questions: Record<string, SystemOneQuestion>;
}

/** System One 响应（按 answers 的原语类型分别解析）。 */
export interface SystemOneResponse {
  model?: string;
  answers: Record<string, SystemOneNoulAnswer | SystemOneScoreAnswer | SystemOneChoiceAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface SystemOneNoulAnswer {
  type: 'noul';
  noul: number;
}
export interface SystemOneScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}
export interface SystemOneChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, string | number>;
}

/** 一次 Jev 调用的完整结果。 */
export interface JevDecisionResult {
  decision: JevDecision;
  answers: JevAnswer[];
  /** 实际应答的模型版本（如 `jev-1.13.0`）。 */
  model: string;
  callLatencyMs: number;
  usage: { input_tokens: number; output_tokens: number };
}

// ---------------------------------------------------------------------------
// 五问定义（JEV-2：覆盖三原语）
// ---------------------------------------------------------------------------

/** `choice` 原语的候选意图（与 shared 层 `extractFeatures` 的 intent 键对齐）。 */
export const INTENT_CHOICES: Record<string, string> = {
  code: '代码编写 / 调试 / 重构 / 代码审查',
  data: '数据分析 / 统计 / 趋势 / 报表',
  writing: '文案 / 摘要 / 翻译 / 创作',
  vision: '图像理解 / 多模态',
  reasoning: '复杂推理 / 权衡 / 推导',
  longCtx: '长文档 / 论文 / 汇总',
  chat: '闲聊 / 概念解释 / 建议咨询',
  other: '以上皆非',
};

/** `score` 原语的复杂度分级（位置即分数 0..2）。 */
export const COMPLEXITY_LEVELS: string[] = [
  '简单：单步即可完成，无需推理',
  '中等：需要少量推理与常规知识',
  '复杂：需要深度推理、多步权衡或长链条推导',
];

/** `score` 原语的能力等级（位置即分数 0..2）。 */
export const CAPABILITY_LEVELS: string[] = [
  '基础：通识问答与简单生成',
  '专业：需要领域知识与工程经验',
  '专家：需要深度专业判断与创造',
];

/** `noul` 原语的判据（明确 yes/no 含义，JEV-13）。 */
const URGENCY_CRITERIA: NoulCriteria = {
  true: '消息表达了时间紧迫、要求立即或尽快处理',
  false: '消息没有时间压力，可以按常规节奏处理',
};
const BUDGET_CRITERIA: NoulCriteria = {
  true: '用户明确关心成本、预算、性价比或额度',
  false: '用户没有提及成本约束',
};

/** 默认 Jev 模型别名（`GET /v1/models` 可查询实际可用名）。 */
export const DEFAULT_JEV_MODEL = 'jev-latest';

/**
 * 构造路由决策用的五问（JEV-2：choice×1 + score×2 + noul×2）。
 *
 * 全部打包进单次请求的 `questions`（JEV-3）。
 */
export function buildRoutingQuestions(): Record<string, SystemOneQuestion> {
  return {
    intent: {
      type: 'choice',
      instructions: 'What is the primary intent of this request?',
      criteria: INTENT_CHOICES,
    },
    complexity: {
      type: 'score',
      instructions: 'How complex is this request?',
      criteria: COMPLEXITY_LEVELS,
    },
    urgency: {
      type: 'noul',
      instructions: 'Does this message express urgency?',
      criteria: URGENCY_CRITERIA,
    },
    budget: {
      type: 'noul',
      instructions: 'Is cost a primary concern for this request?',
      criteria: BUDGET_CRITERIA,
    },
    capability: {
      type: 'score',
      instructions: 'What capability level does this request require?',
      criteria: CAPABILITY_LEVELS,
    },
  };
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

export interface JevHttpAdapterOptions {
  config: JevEndpointConfig;
  /** Jev 模型别名，默认 `jev-latest`。 */
  model?: string;
  /** 注入 fetch（测试用）。 */
  fetchImpl?: typeof fetch;
  /** 注入 id 生成（测试用，保证可复现）。 */
  idFactory?: () => string;
}

/**
 * `SystemOneJevAdapter` —— 真实 Jev 调用的 HTTP 实现。
 *
 * 生命周期：`decide()` 每次路由调用一次；失败抛 `JevAdapterError`，
 * 由编排器降级。
 */
export class SystemOneJevAdapter implements TypeSafeJevAdapter {
  private readonly config: JevEndpointConfig;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly idFactory: () => string;
  private lastCallOk = false;

  constructor(opts: JevHttpAdapterOptions) {
    this.config = opts.config;
    this.model = opts.model ?? DEFAULT_JEV_MODEL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.idFactory = opts.idFactory ?? (() => `jev-${Date.now().toString(36)}`);
  }

  /** JEV-7：生产路径恒为 `TYPE_SAFE_JEV`。 */
  getDecisionSource(): DecisionSource {
    return 'TYPE_SAFE_JEV';
  }

  isHealthy(): boolean {
    return this.config.baseUrl !== '' && this.config.apiKey !== '';
  }

  /** 最近一次调用是否成功（供 `/v1/health` 展示）。 */
  lastCallSucceeded(): boolean {
    return this.lastCallOk;
  }

  /** 本适配器使用的 Jev 模型别名。 */
  get modelAlias(): string {
    return this.model;
  }

  // -------------------------------------------------------------------------
  // 主入口
  // -------------------------------------------------------------------------

  /**
   * 提问并取回决策。
   *
   * 置信度来源优先级（JEV-5 校准语义）：
   * 1. `intent` 原语的 `choice` 置信度（最贴近「模型能否判别请求」的语义）
   * 2. 全部答案置信度的加权平均（无 choice 时）
   * 3. 调用方给定的兜底值
   */
  async decide(input: {
    requestId: string;
    /** JEV-14：6 段状态，由编排器用 `assembleState()` 组装。 */
    state: EngineeredState;
    evidence: RawEvidence;
    candidateModels: CatalogEntry[];
    thresholds: { high: number; mid: number };
    preference?: 'economy' | 'balanced' | 'quality';
  }): Promise<JevDecisionResult> {
    if (!this.isHealthy()) {
      throw new JevAdapterError(
        'JEV_NOT_CONFIGURED',
        'Jev baseUrl or apiKey missing in config/models.json',
        'adapter_error',
      );
    }

    // JEV-3：五问打包为单次请求。`preference` 以指令形式注入（JEV-9）。
    const questions = buildRoutingQuestions();
    if (input.preference) {
      questions.intent.instructions +=
        ` The user prefers ${input.preference} routing; keep the intent classification neutral.`;
    }

    const body: SystemOneRequest = {
      state: this.buildState(input.state, input.evidence),
      model: this.model,
      questions,
    };

    const startedAt = Date.now();
    const raw = await this.post(body);
    const callLatencyMs = Date.now() - startedAt;
    this.lastCallOk = true;

    const answers = normalizeAnswers(raw.answers);
    if (answers.length === 0) {
      throw new JevAdapterError(
        'JEV_INVALID_SCHEMA',
        'System One response contains no parsable answers',
        'invalid_schema',
      );
    }

    const answeredModel = raw.model ?? this.model;
    const decisionId = `jev-${input.requestId}-${this.idFactory()}`;
    const usage = {
      input_tokens: raw.usage?.input_tokens ?? 0,
      output_tokens: raw.usage?.output_tokens ?? 0,
    };

    const decision: JevDecision = {
      decisionId,
      schemaVersion: DECISION_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      // Jev 只判别请求特征，不评模型；模型打分由本地纯逻辑层完成（CONSTRAIN-3）。
      selectedRecommendation: answers.find((a) => a.questionId === 'intent')?.choiceWinner ?? '',
      candidateScores: [],
      confidence: deriveConfidence(answers),
      rationale: buildRationale(answeredModel, answers, input.thresholds),
      knowledgeReferences: [],
      provider: 'system-one',
      modelVersions: { jev: answeredModel },
    };

    return { decision, answers, model: answeredModel, callLatencyMs, usage };
  }

  /**
   * `TypeSafeJevAdapter` 接口方法（JEV-3 批量）。
   *
   * 编排器走 `decide()`；此方法把 `JevBatchRequest.state` 的 `prompt` 取出后
   * 转为真实契约的 `state` 字段。
   */
  async answerQuestions(request: JevBatchRequest): Promise<JevBatchResponse> {
    if (!this.isHealthy()) {
      throw new JevAdapterError(
        'JEV_NOT_CONFIGURED',
        'Jev baseUrl or apiKey missing in config/models.json',
        'adapter_error',
      );
    }
    const raw = await this.post({
      state: this.buildState(request.state, {}),
      model: this.model,
      questions: buildRoutingQuestions(),
    });
    this.lastCallOk = true;
    const answers = normalizeAnswers(raw.answers);
    return {
      answers,
      decisionId: `jev-${request.requestId}-${this.idFactory()}`,
      modelVersions: { jev: raw.model ?? this.model },
      confidence: deriveConfidence(answers),
      candidateScores: [],
      rationale: buildRationale(raw.model ?? this.model, answers, undefined),
    };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /**
   * 构造 `state` 字段。
   *
   * JEV-14：消费 `assembleState()` 产出的 6 段结构（GOAL / FACTS /
   * ARTIFACTS / EVIDENCE / CONSTRAINTS / OPTIONS），使「结论不得冒充证据」
   * 与「菜单实时重建」在**真实 System One 调用**上生效，而不只是单元测试里的
   * 既有能力。
   *
   * GOAL 段直接给 Jev 原始 prompt（最贴近用户表达），其余 5 段以带标签的
   * 纯文本序列化；EVIDENCE 段内的原子证据保留 `verified` 标记，
   * 使 Jev 能区分「已核实」与「待核实」。
   */
  private buildState(state: EngineeredState, evidence: RawEvidence): string {
    const intents = Object.entries(evidence.hits ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}×${v}`)
      .join(', ');

    const renderEntries = (entries: readonly EvidenceEntry[]): string =>
      entries.length === 0
        ? '（无）'
        : entries
            .map((e) => {
              const mark = e.verified ? '已核实' : '待核实';
              const src = e.source ? `；来源=${e.source}` : '';
              return `- ${e.claim}（${mark}${src}）`;
            })
            .join('\n');
    const renderList = (items: readonly string[]): string =>
      items.length === 0 ? '（无）' : items.map((i) => `- ${i}`).join('\n');

    return [
      '<state>',
      '',
      '<goal>',
      state.goal,
      '</goal>',
      '',
      '<facts>',
      renderEntries(state.facts),
      '</facts>',
      '',
      '<artifacts>',
      renderList(state.artifacts),
      '</artifacts>',
      '',
      '<evidence>',
      [
        renderEntries(state.evidence),
        `意图关键词命中：${intents || '无'}`,
        `复杂度评分：${evidence.scores?.complexity ?? 0}`,
        `所需能力评分：${evidence.scores?.capability ?? 0}`,
        `紧急度先验：${evidence.probabilities?.urgency ?? 0}`,
        `成本敏感先验：${evidence.probabilities?.budget ?? 0}`,
        `估算 token：${evidence.tokens ?? 0}`,
      ].join('\n'),
      '</evidence>',
      '',
      '<constraints>',
      renderList(state.constraints),
      '</constraints>',
      '',
      '<options>',
      renderList(state.options),
      '</options>',
      '',
      '</state>',
    ].join('\n');
  }

  /** 单次 HTTP POST（带超时与一次重试）。 */
  private async post(body: SystemOneRequest): Promise<SystemOneResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      const scheme = this.config.authScheme ? `${this.config.authScheme} ` : '';
      headers[this.config.authHeader || 'Authorization'] = `${scheme}${this.config.apiKey}`;
    }

    let lastErr: JevAdapterError | undefined;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.config.timeoutMs);
      try {
        const res = await this.fetchImpl(this.config.baseUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const text = await safeText(res);
          throw new JevAdapterError(
            'JEV_HTTP_ERROR',
            `System One responded ${res.status}: ${text.slice(0, 300)}`,
            res.status >= 500 ? 'adapter_error' : 'invalid_schema',
          );
        }
        const json = (await res.json()) as SystemOneResponse;
        if (!json || typeof json !== 'object' || !json.answers) {
          throw new JevAdapterError(
            'JEV_INVALID_SCHEMA',
            'System One response has no `answers` field',
            'invalid_schema',
          );
        }
        return json;
      } catch (err) {
        if (err instanceof JevAdapterError) {
          lastErr = err;
          // 4xx 属于请求本身有问题，重试无意义。
          if (err.code === 'JEV_HTTP_ERROR' || err.code === 'JEV_INVALID_SCHEMA') throw err;
        } else if (isAbortError(err)) {
          lastErr = new JevAdapterError(
            'JEV_TIMEOUT',
            `System One request timed out after ${this.config.timeoutMs}ms`,
            'timeout',
          );
        } else {
          lastErr = new JevAdapterError(
            'JEV_NETWORK_ERROR',
            err instanceof Error ? err.message : String(err),
            'adapter_error',
          );
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw (
      lastErr ?? new JevAdapterError('JEV_NETWORK_ERROR', 'unknown failure', 'adapter_error')
    );
  }
}

// ---------------------------------------------------------------------------
// 响应归一化
// ---------------------------------------------------------------------------

/** `answers` 对象 → `JevAnswer[]`。 */
function normalizeAnswers(
  input: SystemOneResponse['answers'],
): JevAnswer[] {
  if (!input || typeof input !== 'object') return [];
  const out: JevAnswer[] = [];
  for (const [questionId, raw] of Object.entries(input)) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as unknown as Record<string, unknown>;
    const type = a.type as PrimitiveKind | undefined;
    if (type === 'noul') {
      const noul = num(a.noul);
      if (noul === undefined) continue;
      out.push({ questionId, primitive: 'noul', noulProbability: clamp01(noul) });
    } else if (type === 'score') {
      const score = num(a.score);
      if (score === undefined) continue;
      const levels = legendSize(a.legend);
      // score 为期望分（位置从 0 起），归一化到 0..1 便于与 confidence 同量纲比较。
      const normalized = levels > 1 ? clamp01(score / (levels - 1)) : clamp01(score);
      const answer: JevAnswer = { questionId, primitive: 'score', scoreValue: normalized };
      const conf = num(a.confidence);
      if (conf !== undefined) answer.evidenceStrength = clamp01(conf);
      out.push(answer);
    } else if (type === 'choice') {
      const choice = typeof a.choice === 'string' ? a.choice : undefined;
      if (!choice) continue;
      const answer: JevAnswer = { questionId, primitive: 'choice', choiceWinner: choice };
      const conf = num(a.confidence);
      if (conf !== undefined) answer.evidenceStrength = clamp01(conf);
      out.push(answer);
    }
  }
  return out;
}

/** 置信度推导：优先 choice 置信度，其次各答案置信度均值。 */
function deriveConfidence(answers: JevAnswer[]): number {
  const choice = answers.find((a) => a.primitive === 'choice');
  if (choice?.evidenceStrength !== undefined) return round2(choice.evidenceStrength);
  const strengths = answers
    .map((a) => a.evidenceStrength)
    .filter((v): v is number => typeof v === 'number');
  if (strengths.length > 0) {
    return round2(strengths.reduce((a, b) => a + b, 0) / strengths.length);
  }
  return 0;
}

function buildRationale(
  model: string,
  answers: JevAnswer[],
  thresholds: { high: number; mid: number } | undefined,
): string {
  const parts = answers.map((a) => {
    if (a.primitive === 'choice') return `${a.questionId}=${a.choiceWinner}`;
    if (a.primitive === 'score') return `${a.questionId}=${(a.scoreValue ?? 0).toFixed(2)}`;
    return `${a.questionId}=P(${(a.noulProbability ?? 0).toFixed(2)})`;
  });
  const th = thresholds ? ` 阈值 high=${thresholds.high}/mid=${thresholds.mid}` : '';
  return `Jev ${model} typed answers: ${parts.join(' · ')}.${th}`;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function legendSize(legend: unknown): number {
  if (legend && typeof legend === 'object') return Object.keys(legend).length;
  return 0;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: string }).name === 'AbortError'
  );
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export type { JevCandidateScore };
