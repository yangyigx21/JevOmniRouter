/**
 * Unit tests for the read-only MCP tools.
 *
 * A stubbed `JevBackendClient` provides canned backend responses, so these
 * tests exercise the real tool handlers + formatters without any network or
 * backend process.
 */
import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JevBackendClient } from '../backend-client.js';
import { registerConstraintsAuditTool } from '../tools/constraints-audit.js';
import { registerScoreExplainTool } from '../tools/score-explain.js';
import { registerExperienceStatsTool } from '../tools/experience-stats.js';
import { registerHistoryQueryTool } from '../tools/history-query.js';

/** Minimal in-memory stand-in exposing only what the tools call. */
function stubClient(overrides: Partial<Record<keyof JevBackendClient, unknown>>): JevBackendClient {
  return overrides as unknown as JevBackendClient;
}

/** Invoke a tool handler directly and return the text payload. */
async function callTool(
  register: (server: McpServer, client: JevBackendClient) => void,
  client: JevBackendClient,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const server = new McpServer({ name: 't', version: '0' });
  register(server, client);
  // Access the registered callback through the SDK's internal registry.
  const registered = (server as unknown as {
    _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }>;
  })._registeredTools[name];
  const res = (await registered.handler(args, {})) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { text: res.content[0].text, isError: res.isError === true };
}

// ---------------------------------------------------------------------------
// jev_constraints_audit
// ---------------------------------------------------------------------------

const CATALOG = {
  catalogVersion: 'live-3-test',
  source: 'models-api',
  models: [
    {
      modelId: 'coder-1',
      profile: {
        modelId: 'coder-1',
        provider: 'llm-library',
        vendor: 'acme',
        vendorLabel: 'Acme',
        capabilityTags: ['code'],
        capability: 0.9,
        quality: 0.9,
        cost: 0.1,
        latency: 0.9,
        contextWindow: 1_000_000,
        p95LatencyMs: 1000,
        inputPricePer1k: 0,
        outputPricePer1k: 0,
        health: 'healthy',
        profileVersion: 'v1',
        enabled: true,
        modalities: ['text'],
      },
    },
    {
      modelId: 'chat-1',
      profile: {
        modelId: 'chat-1',
        provider: 'llm-library',
        vendor: 'acme',
        vendorLabel: 'Acme',
        capabilityTags: ['vision'],
        capability: 0.8,
        quality: 0.8,
        cost: 0.5,
        latency: 0.5,
        contextWindow: 8192,
        p95LatencyMs: 99_999,
        inputPricePer1k: 0.01,
        outputPricePer1k: 0.02,
        health: 'healthy',
        profileVersion: 'v2',
        enabled: true,
        modalities: ['text', 'image'],
      },
    },
  ],
  vendors: [],
};

describe('jev_constraints_audit', () => {
  it('eliminates models failing capability / context / latency steps', async () => {
    const { text } = await callTool(registerConstraintsAuditTool, stubClient({ models: async () => CATALOG }), 'jev_constraints_audit', {
      required_capabilities: ['code'],
      max_context_tokens: 100_000,
      max_latency_ms: 5000,
    });
    // coder-1 passes all; chat-1 fails capability + context + latency.
    expect(text).toContain('通过 **1**');
    expect(text).toContain('淘汰 **1**');
    expect(text).toContain('CAPABILITY_MISSING');
    expect(text).toContain('coder-1');
  });

  it('reports zero eligible models when constraints are over-tight', async () => {
    const { text } = await callTool(registerConstraintsAuditTool, stubClient({ models: async () => CATALOG }), 'jev_constraints_audit', {
      required_capabilities: ['nonexistent-tag'],
    });
    expect(text).toContain('通过 **0**');
    expect(text).toContain('constraintFallback');
  });
});

// ---------------------------------------------------------------------------
// jev_experience_stats
// ---------------------------------------------------------------------------

const DECISION_STORE = {
  storeVersion: '1.0.0',
  updatedAt: '2026-10-10T00:00:00.000Z',
  thresholds: { high: 0.82, mid: 0.77 },
  thresholdSource: 'dynamic',
  totals: { decisions: 10, byTier: { ROUTE: 6, GATE: 2, ESCALATE: 2 } },
  models: {
    'coder-1': {
      modelId: 'coder-1',
      selectedCount: 7,
      candidateCount: 10,
      probabilitySum: 3,
      confidenceSum: 6,
      latencySumMs: 7000,
      avgProbability: 0.43,
      avgConfidence: 0.86,
      winRate: 0.7,
      industryScore: 0.8,
      industryRank: 3,
    },
  },
  recent: [],
};

const HISTORY_STATS = {
  hours: 2,
  total: 9,
  byTier: { ROUTE: 5, GATE: 2, ESCALATE: 2 },
  byModel: { 'coder-1': 7 },
  currentHour: '2026-10-10-14',
};

describe('jev_experience_stats', () => {
  it('reports thresholds, distributions and the leaderboard', async () => {
    const { text } = await callTool(
      registerExperienceStatsTool,
      stubClient({ decisionStore: async () => DECISION_STORE, historyStats: async () => HISTORY_STATS }),
      'jev_experience_stats',
      { top_n: 5 },
    );
    expect(text).toContain('high = **0.82**');
    expect(text).toContain('来源：**dynamic**');
    expect(text).toContain('coder-1');
    expect(text).toContain('70.0%'); // winRate formatted as percent
    expect(text).toContain('累计决策：**10**');
  });
});

// ---------------------------------------------------------------------------
// jev_history_query
// ---------------------------------------------------------------------------

const HISTORY_ENTRY = {
  requestId: 'req-1',
  decisionId: 'dec-1',
  createdAt: '2026-10-10T01:55:22.000Z',
  hourBucket: '2026-10-10-09',
  prompt: '审查代码',
  promptSummary: '审查代码',
  selectedModelId: 'coder-1',
  routeTier: 'ROUTE',
  confidence: 1,
  thresholds: { high: 0.82, mid: 0.77 },
  decisionSource: 'TYPE_SAFE_JEV',
  execution: {
    modelId: 'coder-1',
    latencyMs: 5844,
    promptTokens: 212,
    completionTokens: 114,
    costUsd: 0.00367,
    status: 'success',
  },
  result: '这是模型输出',
  eventTypes: ['ROUTE_CREATED', 'MODEL_COMPLETED'],
};

describe('jev_history_query', () => {
  it('renders the list view with a summary row', async () => {
    const { text } = await callTool(
      registerHistoryQueryTool,
      stubClient({ history: async () => ({ total: 1, hours: [], entries: [HISTORY_ENTRY] }) }),
      'jev_history_query',
      { limit: 10 },
    );
    expect(text).toContain('coder-1');
    expect(text).toContain('ROUTE');
    expect(text).toContain('$0.00367');
    expect(text).toContain('本页汇总');
  });

  it('renders the detail view with the full model output', async () => {
    const { text } = await callTool(
      registerHistoryQueryTool,
      stubClient({ history: async () => ({ total: 1, hours: [], entries: [HISTORY_ENTRY] }) }),
      'jev_history_query',
      { request_id: 'req-1' },
    );
    expect(text).toContain('执行明细');
    expect(text).toContain('这是模型输出');
    expect(text).toContain('req-1');
  });

  it('errors clearly when the requestId is absent', async () => {
    const { text, isError } = await callTool(
      registerHistoryQueryTool,
      stubClient({ history: async () => ({ total: 0, hours: [], entries: [] }) }),
      'jev_history_query',
      { request_id: 'req-missing' },
    );
    expect(isError).toBe(true);
    expect(text).toContain('未找到记录');
  });
});

// ---------------------------------------------------------------------------
// jev_score_explain
// ---------------------------------------------------------------------------

describe('jev_score_explain', () => {
  it('requires either prompt or request_id', async () => {
    const { text, isError } = await callTool(
      registerScoreExplainTool,
      stubClient({}),
      'jev_score_explain',
      {},
    );
    expect(isError).toBe(true);
    expect(text).toContain('参数缺失');
  });

  it('explains a stored decision from the decisions DB (no model call)', async () => {
    const record = {
      requestId: 'req-9',
      decisionId: 'dec-9',
      createdAt: '2026-10-10T00:00:00.000Z',
      decisionSource: 'TYPE_SAFE_JEV',
      jevAnswers: [{ tag: 'INTENT', type: 'choice', value: 'code' }],
      confidence: 1,
      thresholds: { high: 0.82, mid: 0.77 },
      routeTier: 'ROUTE',
      selectedModelId: 'coder-1',
      distribution: [{ modelId: 'coder-1', probability: 0.4, rankIndex: 0 }],
      eliminated: [{ modelId: 'chat-1', reason: 'CAPABILITY_MISSING' }],
      resultLength: 10,
    };
    const { text } = await callTool(
      registerScoreExplainTool,
      stubClient({ decisionStore: async () => ({ ...DECISION_STORE, recent: [record] }) }),
      'jev_score_explain',
      { request_id: 'req-9', top_n: 3 },
    );
    expect(text).toContain('评分归因（决策库既有记录）');
    expect(text).toContain('档位判定');
    expect(text).toContain('CAPABILITY_MISSING');
    expect(text).toContain('coder-1');
  });

  it('errors when the requestId is not in the decisions DB', async () => {
    const { text, isError } = await callTool(
      registerScoreExplainTool,
      stubClient({ decisionStore: async () => ({ ...DECISION_STORE, recent: [] }) }),
      'jev_score_explain',
      { request_id: 'nope' },
    );
    expect(isError).toBe(true);
    expect(text).toContain('未找到决策');
  });
});
