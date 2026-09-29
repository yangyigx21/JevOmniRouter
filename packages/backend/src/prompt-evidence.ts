/**
 * @module prompt-evidence
 * @implements LLM-sdd.md 执行流程 · STATE 段
 *
 * Prompt 证据提取 —— 把用户输入的 prompt 转为 `RawEvidence`（`@jev-router/shared`
 * 的 `TaskEnvelope.evidence` 形状），供 JEV 五问与特征提取使用。
 *
 * **确定性**：同一 prompt 必然产出同一份 evidence（无随机、无时间依赖），
 * 这样决策可复现（EXP-6 钉版本回放的前提）。
 *
 * 提取维度：
 * - `hits`：意图关键词命中（code / vision / longCtx / data / writing / translate / chat）
 * - `scores.complexity` / `scores.capability`：由长度、代码块、步骤数、术语密度推导
 * - `probabilities.urgency` / `probabilities.budget`：由时限/成本类关键词推导
 * - `tokens`：按 4 字符 ≈ 1 token 估算
 */
import type { RawEvidence } from '@jev-router/shared';

// ---------------------------------------------------------------------------
// 关键词表
// ---------------------------------------------------------------------------

/** 意图类别 → 关键词（中文 + 英文，大小写不敏感）。 */
const INTENT_KEYWORDS: Record<string, string[]> = {
  code: [
    '代码', '函数', '重构', '报错', 'bug', 'debug', 'python', 'java', 'javascript', 'typescript',
    'sql', '接口', 'api', '编译', '部署', '算法', '性能', '单元测试', '脚本', '正则',
  ],
  vision: ['图片', '截图', '照片', '识图', '图像', '看图', 'diagram', 'image', 'png', 'jpg', '设计稿'],
  longCtx: ['文档', '论文', '长文', '全文', '汇总', '报告', '手册', '规范', '附件', '整本书', '综述'],
  data: ['数据', '分析', '统计', '趋势', '指标', '报表', '表格', 'csv', 'excel', 'sql', '聚合', '异常'],
  writing: ['文案', '撰写', '写作', '润色', '起草', '宣传', '标题', '脚本创作', '小说', '邮件', '摘要'],
  translate: ['翻译', '英译', '中译', '译文', 'translate', 'translation', '本地化'],
  chat: ['你好', '谢谢', '请问', '聊聊', '解释一下', '什么是', '为什么', '怎么办', '建议'],
  reasoning: ['推理', '推导', '证明', '逻辑', '分析为什么', '权衡', '方案对比', 'step by step'],
};

/** 复杂度信号。 */
const COMPLEXITY_SIGNALS = [
  '架构', '设计', '重构', '优化', '分布式', '并发', '算法', '推导', '证明', '权衡',
  '多步骤', '端到端', '全链路', '方案', '评估', '对比', '迁移',
];

/** 能力强度信号（需要高阶模型）。 */
const CAPABILITY_SIGNALS = [
  '代码', '编程', '架构', '算法', '数学', '推理', '证明', '调试', '重构', '协议',
  '分布式', '编译', '公式', '推导',
];

/** 紧急度信号。 */
const URGENCY_SIGNALS = [
  '紧急', '立即', '马上', '尽快', '急', '现在', '立刻', 'deadline', '截止', '超时', 'asap',
];

/** 成本敏感信号。 */
const BUDGET_SIGNALS = [
  '成本', '预算', '便宜', '省钱', '费用', '价格', '低价', '免费', '性价比', 'token', '额度',
];

/** 估计 token 数：约 4 字符 ≈ 1 token（与前端 InputTab 展示口径一致）。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// 提取
// ---------------------------------------------------------------------------

function countHits(text: string, words: string[]): number {
  let n = 0;
  const lower = text.toLowerCase();
  for (const w of words) {
    const needle = w.toLowerCase();
    let idx = lower.indexOf(needle);
    while (idx !== -1) {
      n += 1;
      idx = lower.indexOf(needle, idx + needle.length);
    }
  }
  return n;
}

/**
 * 从 prompt 提取原始证据。
 *
 * @param prompt      用户输入
 * @param attachments 可选附件统计（多模态接入时由 INGEST 段填充）
 */
export function extractPromptEvidence(
  prompt: string,
  attachments?: { imageCount?: number; documentCount?: number; fileTokens?: number },
): RawEvidence {
  const text = prompt ?? '';
  const hits: Record<string, number> = {};
  for (const [intent, words] of Object.entries(INTENT_KEYWORDS)) {
    const n = countHits(text, words);
    if (n > 0) hits[intent] = n;
  }

  const tokens = estimateTokens(text);
  const codeBlockCount = (text.match(/```/g)?.length ?? 0) / 2;
  const stepCount = (text.match(/(^|\n)\s*(\d+[.、)]|[-*]\s)/g) ?? []).length;
  const questionCount = (text.match(/[?？]/g) ?? []).length;

  // complexity ∈ [0,1]：长度 + 代码块 + 步骤 + 信号词
  const complexity = clamp01(
    0.15 * clamp01(tokens / 600) +
      0.25 * clamp01(codeBlockCount / 3) +
      0.2 * clamp01(stepCount / 6) +
      0.25 * clamp01(countHits(text, COMPLEXITY_SIGNALS) / 4) +
      0.15 * clamp01(questionCount / 5),
  );

  // capability ∈ [0,1]：高阶术语密度
  const capability = clamp01(
    0.55 * clamp01(countHits(text, CAPABILITY_SIGNALS) / 3) +
      0.25 * clamp01(codeBlockCount / 2) +
      0.2 * clamp01(tokens / 800),
  );

  // urgency / budget ∈ [0,1]（P(yes)）
  const urgency = clamp01(0.25 + 0.75 * clamp01(countHits(text, URGENCY_SIGNALS) / 2));
  const budget = clamp01(0.2 + 0.8 * clamp01(countHits(text, BUDGET_SIGNALS) / 2));

  return {
    hits,
    imgCount: attachments?.imageCount ?? 0,
    fileCount: attachments?.documentCount ?? 0,
    fileTokens: attachments?.fileTokens ?? 0,
    tokens,
    nCap: Object.keys(hits).length,
    scores: { complexity: round2(complexity), capability: round2(capability) },
    probabilities: { urgency: round2(urgency), budget: round2(budget) },
  };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
