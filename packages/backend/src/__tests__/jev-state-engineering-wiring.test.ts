/**
 * 状态工程接入生产链测试 —— JEV-14（`spec.md` 附录 G-3）。
 *
 * 背景：`assembleState()` 此前已实现且有测试，但**生产代码零引用**——
 * 真实 System One 调用走 `jev-http-adapter.ts` 的 `buildState()`，
 * 只拼装 `<user_request>` / `<local_evidence>` 两段文本，FACTS /
 * ARTIFACTS / CONSTRAINTS / OPTIONS 四段缺失，导致「结论不得冒充证据」
 * 与「菜单实时重建」两条约束在生产路径上未被强制。
 *
 * 本测试锁定「6 段结构确实到达真实 HTTP 请求体」这一事实，防止回退。
 */
import { describe, it, expect, vi } from 'vitest';
import { SystemOneJevAdapter } from '../jev-http-adapter.js';
import { assembleState, type EngineeredState } from '../state-engineering.js';
import type { CatalogEntry } from '../model-catalog.js';
import type { RawEvidence } from '@jev-router/shared';

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

function catalogEntry(modelId: string, capabilityTags: string[]): CatalogEntry {
  return {
    modelId,
    provider: 'p',
    vendor: 'v',
    vendorLabel: 'V',
    capabilityTags,
    p95LatencyMs: 1000,
    inputPricePer1k: 0.001,
    outputPricePer1k: 0.002,
    health: 'ok',
    profileVersion: 'v1',
    enabled: true,
  } as unknown as CatalogEntry;
}

const EVIDENCE: RawEvidence = {
  hits: { code: 3, data: 1 },
  tokens: 120,
  imgCount: 0,
  fileCount: 0,
  nCap: 2,
  scores: { complexity: 0.4, capability: 0.6 },
  probabilities: { urgency: 0.2, budget: 0.7 },
};

/** 捕获适配器实际发出的 HTTP 请求体。 */
function makeAdapter(): { adapter: SystemOneJevAdapter; sent: () => { state: string } } {
  let captured = { state: '' };
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    captured = JSON.parse(String(init.body)) as { state: string };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: 'jev-1.13.0',
        answers: {
          intent: { type: 'choice', choice: 'code', confidence: 0.9 },
          complexity: { type: 'score', score: 1, confidence: 0.8, legend: {} },
          urgency: { type: 'noul', noul: 0.2 },
          budget: { type: 'noul', noul: 0.7 },
          capability: { type: 'score', score: 1, confidence: 0.8, legend: {} },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    } as unknown as Response;
  });

  const adapter = new SystemOneJevAdapter({
    config: {
      id: 'system-one',
      label: 'TypeSafe System One',
      baseUrl: 'https://api.typesafe.ai/v1/systemone',
      apiKey: 'k',
      timeoutMs: 5000,
      maxRetries: 0,
      authHeader: 'Authorization',
      authScheme: 'Bearer',
    },
    model: 'jev-latest',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { adapter, sent: () => captured };
}

function buildState(prompt = '重构这段 TypeScript 代码'): EngineeredState {
  return assembleState({
    goal: prompt,
    facts: [
      { claim: '输入长度约 120 tokens', verified: true, source: 'tokenizer' },
      { claim: '图片 0 张、文档 0 个', verified: true, source: 'envelope' },
    ],
    artifacts: [],
    evidence: [
      { claim: 'code 类关键词命中 3 次', verified: true, source: 'keyword-scan' },
      { claim: '复杂度评分 0.4', verified: true, source: 'evidence-extractor' },
      { claim: '紧急度先验 0.2', verified: false, source: 'prior' },
    ],
    constraints: ['单次请求预算上限 0.5 USD', '用户已将候选池收窄为 2 个模型'],
    options: ['kimi-k2.7（能力标签：code/reasoning）', 'glm-5.2（能力标签：code）'],
    stateVersion: 'req-1:2026-09-30T08',
  });
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe('JEV-14 · 6 段状态到达真实 System One 请求体', () => {
  it('请求体含全部 6 段标签，且不再使用旧的 user_request/local_evidence', async () => {
    const { adapter, sent } = makeAdapter();

    await adapter.decide({
      requestId: 'req-1',
      state: buildState(),
      evidence: EVIDENCE,
      candidateModels: [catalogEntry('kimi-k2.7', ['code'])],
      thresholds: { high: 0.82, mid: 0.6 },
    });

    const body = sent().state;
    for (const seg of ['goal', 'facts', 'artifacts', 'evidence', 'constraints', 'options']) {
      expect(body, `缺少 <${seg}> 段`).toContain(`<${seg}>`);
      expect(body, `缺少 </${seg}> 段`).toContain(`</${seg}>`);
    }
    // 旧的两段式结构不得复现
    expect(body).not.toContain('<user_request>');
    expect(body).not.toContain('<local_evidence>');
  });

  it('GOAL 段承载用户原始诉求', async () => {
    const { adapter, sent } = makeAdapter();
    const prompt = '评估这段 TypeScript 代码的架构设计';

    await adapter.decide({
      requestId: 'req-2',
      state: buildState(prompt),
      evidence: EVIDENCE,
      candidateModels: [catalogEntry('kimi-k2.7', ['code'])],
      thresholds: { high: 0.82, mid: 0.6 },
    });

    expect(sent().state).toContain(prompt);
  });

  it('EVIDENCE 段保留 verified 标记，区分已核实与待核实', async () => {
    const { adapter, sent } = makeAdapter();

    await adapter.decide({
      requestId: 'req-3',
      state: buildState(),
      evidence: EVIDENCE,
      candidateModels: [catalogEntry('kimi-k2.7', ['code'])],
      thresholds: { high: 0.82, mid: 0.6 },
    });

    const body = sent().state;
    expect(body).toContain('（已核实；来源=keyword-scan）');
    // 紧急度先验是未核实的 prior，必须标为待核实
    expect(body).toContain('（待核实；来源=prior）');
  });

  it('OPTIONS 段由实时目录重建，携带能力标签', async () => {
    const { adapter, sent } = makeAdapter();

    await adapter.decide({
      requestId: 'req-4',
      state: buildState(),
      evidence: EVIDENCE,
      candidateModels: [
        catalogEntry('kimi-k2.7', ['code', 'reasoning']),
        catalogEntry('glm-5.2', ['code']),
      ],
      thresholds: { high: 0.82, mid: 0.6 },
    });

    const body = sent().state;
    expect(body).toContain('kimi-k2.7（能力标签：code/reasoning）');
    expect(body).toContain('glm-5.2（能力标签：code）');
  });

  it('CONSTRAINTS 段承载用户给定的边界', async () => {
    const { adapter, sent } = makeAdapter();

    await adapter.decide({
      requestId: 'req-5',
      state: buildState(),
      evidence: EVIDENCE,
      candidateModels: [catalogEntry('kimi-k2.7', ['code'])],
      thresholds: { high: 0.82, mid: 0.6 },
    });

    const body = sent().state;
    expect(body).toContain('单次请求预算上限 0.5 USD');
    expect(body).toContain('用户已将候选池收窄为 2 个模型');
  });

  it('EVIDENCE 段并入本地抽取的评分与先验', async () => {
    const { adapter, sent } = makeAdapter();

    await adapter.decide({
      requestId: 'req-6',
      state: buildState(),
      evidence: EVIDENCE,
      candidateModels: [catalogEntry('kimi-k2.7', ['code'])],
      thresholds: { high: 0.82, mid: 0.6 },
    });

    const body = sent().state;
    expect(body).toContain('意图关键词命中：code×3, data×1');
    expect(body).toContain('复杂度评分：0.4');
    expect(body).toContain('紧急度先验：0.2');
    expect(body).toContain('估算 token：120');
  });
});

describe('JEV-14 · 结论污染守卫在生产链生效', () => {
  it('FACTS 含结论性短语时 assembleState 抛错（防 JEV-14 反模式）', () => {
    expect(() =>
      assembleState({
        goal: '重构代码',
        // "probably" 属结论性短语，不得冒充事实
        facts: [{ claim: 'research is probably enough', verified: true }],
        evidence: [],
        options: ['a'],
      }),
    ).toThrow(/JEV-14/);
  });

  it('EVIDENCE 含结论性短语时 assembleState 抛错', () => {
    expect(() =>
      assembleState({
        goal: '重构代码',
        facts: [],
        evidence: [{ claim: 'the model looks good enough', verified: true }],
        options: ['a'],
      }),
    ).toThrow(/JEV-14/);
  });

  it('OPTIONS 为空时抛错（过期菜单 = 无效图）', () => {
    expect(() =>
      assembleState({ goal: 'x', facts: [], evidence: [], options: [] }),
    ).toThrow(/OPTIONS/);
  });
});
