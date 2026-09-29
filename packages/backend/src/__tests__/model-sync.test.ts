/**
 * 模型清单每日同步测试。
 *
 * 覆盖两条新增能力：
 * 1. 启动/TTL 刷新 —— `/v1/models` 触发的清单保鲜（`ModelInfoStore.ensureFresh`）
 * 2. 每日凌晨同步 —— 重拉清单 + 写入业界评分到决策信息库（`runModelSync`）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildConfig, resolveRatingsFile } from '../app-config.js';
import { DecisionStore } from '../decision-store.js';
import { ModelInfoStore } from '../model-info-store.js';
import { loadIndustryRatings, matchRatings, normalizeRatings } from '../industry-ratings.js';
import { fetchWebRatings, rankToScore, REFERENCE_RANK_SPAN } from '../web-ratings.js';
import { nextRunAt, nextRunDelay, runModelSync } from '../daily-model-sync.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jev-sync-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 关闭互联网来源的配置（避免单测访问外网）。 */
const WEB_OFF = { enabled: false, url: '', maxPages: 1, pageSize: 10, timeoutMs: 200 };

/** 构造一份指向临时目录的测试配置。 */
function testConfig(
  ratingsFile = 'industry-ratings.json',
  web: Record<string, unknown> = { enabled: false },
) {
  return buildConfig(
    {
      configVersion: 'test',
      jev: { baseUrl: 'http://127.0.0.1:1/v1/systemone', apiKey: 'jev-key' },
      llmLibrary: {
        baseUrl: 'http://llm.test/v1',
        apiKey: 'llm-key',
        modelsApi: 'http://llm.test/v1/models',
      },
      storage: {
        dataDir: '.',
        decisionStoreFile: 'decision-store.json',
        modelInfoFile: 'model-info.json',
        historyDir: 'history',
      },
      routing: { thresholds: { high: 0.82, mid: 0.6 } },
      modelScoring: { industryRatings: { web, file: ratingsFile } },
    },
    dir,
  );
}

/** Models API 桩：返回给定模型 id 清单。 */
function modelsApiStub(ids: string[], counter?: { calls: number }): typeof fetch {
  return (async () => {
    if (counter) counter.calls += 1;
    return {
      ok: true,
      json: async () => ({ data: ids.map((id) => ({ id, max_input_tokens: 128_000 })) }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** 榜单接口桩：按 offset/length 分页返回行。 */
function webStub(rows: unknown[], counter?: { n: number }): typeof fetch {
  return (async (url: string) => {
    const u = new URL(String(url));
    const offset = Number(u.searchParams.get('offset') ?? 0);
    const length = Number(u.searchParams.get('length') ?? 100);
    if (counter) counter.n += 1;
    return {
      ok: true,
      json: async () => ({ rows: rows.slice(offset, offset + length).map((row) => ({ row })) }),
    };
  }) as unknown as typeof fetch;
}

function makeStores(config: ReturnType<typeof testConfig>, fetchImpl: typeof fetch) {
  const decisionStore = new DecisionStore({
    filePath: join(dir, 'decision-store.json'),
    baseThresholds: config.routing.thresholds,
  });
  const modelInfoStore = new ModelInfoStore({
    filePath: join(dir, 'model-info.json'),
    llm: config.llmLibrary,
    catalogTimeoutMs: 2_000,
    fetchImpl,
  });
  return { decisionStore, modelInfoStore };
}

// ---------------------------------------------------------------------------
// 调度时刻计算
// ---------------------------------------------------------------------------

describe('每日同步时刻计算', () => {
  it('当天尚未到点 → 返回当天该时刻', () => {
    const now = new Date(2026, 8, 30, 23, 30, 0);
    const at = nextRunAt(now, '00:00');
    expect(at.getDate()).toBe(1); // 次日凌晨
    expect(at.getHours()).toBe(0);
    expect(nextRunDelay(now, '00:00')).toBe(30 * 60 * 1000);
  });

  it('当天已过点 → 顺延到次日', () => {
    const now = new Date(2026, 8, 30, 0, 0, 1);
    const at = nextRunAt(now, '00:00');
    expect(at.getDate()).toBe(1);
    expect(at.getTime()).toBeGreaterThan(now.getTime());
  });

  it('HH:mm 支持自定义时刻', () => {
    const now = new Date(2026, 8, 30, 3, 59, 0);
    expect(nextRunDelay(now, '04:00')).toBe(60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// 行业评分解析
// ---------------------------------------------------------------------------

describe('行业评分解析（宽松）', () => {
  it('标准结构：modelId + score', () => {
    const r = normalizeRatings({
      source: 'LMArena',
      updatedAt: '2026-09-30T00:00:00Z',
      ratings: [{ modelId: 'a', score: 0.9, rank: 1 }],
    });
    expect(r.ratings).toEqual([{ modelId: 'a', score: 0.9, rank: 1, source: undefined, notes: undefined }]);
    expect(r.source).toBe('LMArena');
  });

  it('裸数组 + 百分制 + 键名别名', () => {
    const r = normalizeRatings([{ model: 'b', rating: 88 }, { id: 'c', value: 0.5 }]);
    expect(r.ratings.map((x) => [x.modelId, x.score])).toEqual([
      ['b', 0.88],
      ['c', 0.5],
    ]);
  });

  it('脏数据被丢弃并记入 warnings，不影响其他条目', () => {
    const r = normalizeRatings({
      ratings: [{ modelId: 'a', score: 0.7 }, { score: 0.5 }, { modelId: 'b', score: 'x' }, null],
    });
    expect(r.ratings.map((x) => x.modelId)).toEqual(['a']);
    expect(r.warnings.length).toBe(3);
  });

  it('重复 modelId 保留首条', () => {
    const r = normalizeRatings([{ modelId: 'a', score: 0.3 }, { modelId: 'a', score: 0.9 }]);
    expect(r.ratings).toHaveLength(1);
    expect(r.ratings[0].score).toBe(0.3);
    expect(r.warnings[0]).toContain('重复');
  });

  it('评分越界被夹到 0..1', () => {
    const r = normalizeRatings([{ modelId: 'a', score: 500 }, { modelId: 'b', score: -3 }]);
    expect(r.ratings[0].score).toBe(1);
    expect(r.ratings[1].score).toBe(0);
  });
});

describe('评分与目录对齐', () => {
  const catalog = ['kimi-k2.7', 'glm-5.2'];

  it('精确匹配', () => {
    const { matched, unmatched } = matchRatings([{ modelId: 'glm-5.2', score: 0.8 }], catalog);
    expect(matched[0].modelId).toBe('glm-5.2');
    expect(unmatched).toEqual([]);
  });

  it('大小写/分隔符差异按归一化 id 匹配', () => {
    const { matched } = matchRatings([{ modelId: 'Kimi_K2.7', score: 0.8 }], catalog);
    expect(matched[0].modelId).toBe('kimi-k2.7');
  });

  it('目录外模型进入 unmatched', () => {
    const { matched, unmatched } = matchRatings([{ modelId: 'nope', score: 0.8 }], catalog);
    expect(matched).toHaveLength(0);
    expect(unmatched).toEqual(['nope']);
  });

  it('同系列变体：目录 glm-5.2 ↔ 榜单 glm-5.2-max', () => {
    const { matched, unmatched } = matchRatings([{ modelId: 'glm-5.2-max', score: 0.9, rank: 29 }], catalog);
    expect(matched.map((m) => m.modelId)).toEqual(['glm-5.2']);
    expect(unmatched).toEqual([]);
  });

  it('多个同系列变体时取名次最好者', () => {
    const { matched } = matchRatings(
      [
        { modelId: 'glm-5.2-flash', score: 0.5, rank: 40 },
        { modelId: 'glm-5.2-max', score: 0.8, rank: 29 },
      ],
      ['glm-5.2'],
    );
    expect(matched).toHaveLength(1);
    expect(matched[0].score).toBe(0.8);
  });

  it('过短 id 不参与同系列前缀匹配（避免误配）', () => {
    const { matched, unmatched } = matchRatings([{ modelId: 'hy3-ultra', score: 0.9, rank: 5 }], ['hy3']);
    expect(matched).toHaveLength(0);
    expect(unmatched).toEqual(['hy3-ultra']);
  });
});

describe('互联网榜单抓取（LMArena 总榜接口）', () => {
  const webCfg = {
    enabled: true,
    url: 'https://board.test/rows?dataset=x',
    maxPages: 3,
    pageSize: 3,
    timeoutMs: 500,
  };

  it('只取 overall 总榜行，遇到其他分类提前结束翻页', async () => {
    const rows = [
      { model_name: 'm1', rating: 1500, rank: 1, vote_count: 10, category: 'overall', leaderboard_publish_date: '2026-09-25' },
      { model_name: 'm2', rating: 1490, rank: 2, vote_count: 20, category: 'overall', leaderboard_publish_date: '2026-09-25' },
      { model_name: 'm3', rating: 1480, rank: 3, category: 'coding' },
    ];
    const calls = { n: 0 };
    const res = await fetchWebRatings(webCfg, webStub(rows, calls));
    expect(res.ratings.map((r) => r.modelId)).toEqual(['m1', 'm2']);
    expect(calls.n).toBe(1);
    expect(res.updatedAt).toBe('2026-09-25T00:00:00Z');
    expect(res.ratings[0].notes).toContain('Elo 1500');
  });

  it('名次 → 评分按固定参照系换算', () => {
    expect(rankToScore(1)).toBe(1);
    expect(rankToScore(REFERENCE_RANK_SPAN)).toBe(0);
    expect(rankToScore(100)).toBeCloseTo(0.503, 3);
  });

  it('同名多条保留名次更好的一条', async () => {
    const rows = [
      { model_name: 'm1', rating: 1400, rank: 50, category: 'overall' },
      { model_name: 'm1', rating: 1500, rank: 5, category: 'overall' },
    ];
    const res = await fetchWebRatings(webCfg, webStub(rows));
    expect(res.ratings).toHaveLength(1);
    expect(res.ratings[0].rank).toBe(5);
    expect(res.ratings[0].notes).toContain('Elo 1500');
  });

  it('翻页失败保留已抓到的部分并告警', async () => {
    const first = [
      { model_name: 'm1', rating: 1500, rank: 1, category: 'overall' },
      { model_name: 'm2', rating: 1490, rank: 2, category: 'overall' },
      { model_name: 'm3', rating: 1480, rank: 3, category: 'overall' },
    ];
    const fetchImpl = (async (url: string) => {
      const offset = Number(new URL(String(url)).searchParams.get('offset') ?? 0);
      if (offset > 0) throw new Error('network down');
      return { ok: true, json: async () => ({ rows: first.map((row) => ({ row })) }) };
    }) as unknown as typeof fetch;
    const res = await fetchWebRatings(webCfg, fetchImpl);
    expect(res.ratings).toHaveLength(3);
    expect(res.warnings.some((w) => w.includes('抓取失败'))).toBe(true);
  });
});

describe('评分来源载入', () => {
  it('文件来源可用时读出评分', async () => {
    const file = join(dir, 'r.json');
    writeFileSync(file, JSON.stringify({ source: 'file-src', ratings: [{ modelId: 'a', score: 0.6 }] }));
    const res = await loadIndustryRatings({ web: WEB_OFF, api: '', file, timeoutMs: 500 });
    expect(res.origin).toBe('file');
    expect(res.ratings).toHaveLength(1);
  });

  it('API 优先于文件', async () => {
    const file = join(dir, 'r.json');
    writeFileSync(file, JSON.stringify({ ratings: [{ modelId: 'file-model', score: 0.1 }] }));
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({ ratings: [{ modelId: 'api-model', score: 0.9 }] }),
    })) as unknown as typeof fetch;
    const res = await loadIndustryRatings({
      web: WEB_OFF,
      api: 'http://x/ratings',
      file,
      timeoutMs: 500,
      fetchImpl,
    });
    expect(res.origin).toBe('api');
    expect(res.ratings[0].modelId).toBe('api-model');
  });

  it('互联网榜单优先于 api 与 file', async () => {
    const file = join(dir, 'r.json');
    writeFileSync(file, JSON.stringify({ ratings: [{ modelId: 'file-model', score: 0.1 }] }));
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('datasets-server')) {
        return {
          ok: true,
          json: async () => ({
            rows: [{ row: { model_name: 'web-model', rating: 1500, rank: 5, category: 'overall' } }],
          }),
        };
      }
      return { ok: true, json: async () => ({ ratings: [{ modelId: 'api-model', score: 0.9 }] }) };
    }) as unknown as typeof fetch;
    const res = await loadIndustryRatings({
      web: { ...WEB_OFF, enabled: true, url: 'https://datasets-server.huggingface.co/rows?dataset=x' },
      api: 'http://x/ratings',
      file,
      timeoutMs: 500,
      fetchImpl,
    });
    expect(res.origin).toBe('web');
    expect(res.ratings[0].modelId).toBe('web-model');
  });

  it('API 失败时回落文件', async () => {
    const file = join(dir, 'r.json');
    writeFileSync(file, JSON.stringify({ ratings: [{ modelId: 'file-model', score: 0.1 }] }));
    const fetchImpl = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const res = await loadIndustryRatings({
      web: WEB_OFF,
      api: 'http://x/ratings',
      file,
      timeoutMs: 500,
      fetchImpl,
    });
    expect(res.origin).toBe('file');
    expect(res.warnings.some((w) => w.includes('评分 API 请求失败'))).toBe(true);
  });

  it('三种来源都不可用 → 空评分 + 告警（不抛错）', async () => {
    const res = await loadIndustryRatings({
      web: WEB_OFF,
      api: '',
      file: join(dir, 'missing.json'),
      timeoutMs: 500,
    });
    expect(res.ratings).toEqual([]);
    expect(res.warnings.some((w) => w.includes('不存在'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 决策信息库写入
// ---------------------------------------------------------------------------

describe('决策信息库写入行业评分', () => {
  it('写入评分字段并保留既有统计', async () => {
    const store = new DecisionStore({
      filePath: join(dir, 'decision-store.json'),
      baseThresholds: { high: 0.82, mid: 0.6 },
    });
    await store.recordDecision({
      requestId: 'r1',
      decisionId: 'd1',
      createdAt: new Date().toISOString(),
      decisionSource: 'TYPE_SAFE_JEV',
      jevAnswers: [],
      confidence: 0.9,
      thresholds: { high: 0.82, mid: 0.6 },
      routeTier: 'ROUTE',
      selectedModelId: 'kimi-k2.7',
      distribution: [{ modelId: 'kimi-k2.7', probability: 0.9, rankIndex: 0 }],
      eliminated: [],
      resultLength: 10,
    });

    const summary = await store.applyIndustryRatings({
      ratings: [{ modelId: 'kimi-k2.7', score: 0.88, rank: 3, source: 'LMArena' }],
      origin: 'file',
      sourceLabel: 'industry-ratings.json',
      ratingsUpdatedAt: '2026-09-30T00:00:00Z',
      unmatched: ['ghost'],
      warnings: [],
    });

    expect(summary.matched).toBe(1);
    const stat = store.snapshot().models['kimi-k2.7'];
    expect(stat.industryScore).toBe(0.88);
    expect(stat.industryRank).toBe(3);
    expect(stat.industrySource).toBe('LMArena');
    // 既有路由统计不受影响
    expect(stat.selectedCount).toBe(1);
    expect(store.snapshot().industrySync?.unmatched).toEqual(['ghost']);
  });

  it('评分落盘（重新构造实例仍可读到）', async () => {
    const filePath = join(dir, 'decision-store.json');
    const store = new DecisionStore({ filePath, baseThresholds: { high: 0.82, mid: 0.6 } });
    await store.applyIndustryRatings({
      ratings: [{ modelId: 'a', score: 0.5 }],
      origin: 'api',
      sourceLabel: 'api',
      ratingsUpdatedAt: '2026-09-30T00:00:00Z',
      unmatched: [],
      warnings: [],
    });
    const reloaded = new DecisionStore({ filePath, baseThresholds: { high: 0.82, mid: 0.6 } });
    expect(reloaded.snapshot().models['a'].industryScore).toBe(0.5);
    expect(reloaded.snapshot().industrySync?.origin).toBe('api');
  });

  it('清单外的旧评分被清除（权威覆盖，避免下榜模型留过期分）', async () => {
    const store = new DecisionStore({
      filePath: join(dir, 'decision-store.json'),
      baseThresholds: { high: 0.82, mid: 0.6 },
    });
    await store.applyIndustryRatings({
      ratings: [{ modelId: 'a', score: 0.7 }, { modelId: 'b', score: 0.6 }],
      origin: 'file',
      sourceLabel: 's',
      ratingsUpdatedAt: 't1',
      unmatched: [],
      warnings: [],
    });
    await store.applyIndustryRatings({
      ratings: [{ modelId: 'a', score: 0.9 }],
      origin: 'file',
      sourceLabel: 's',
      ratingsUpdatedAt: 't2',
      unmatched: [],
      warnings: [],
    });
    const models = store.snapshot().models;
    expect(models['a'].industryScore).toBe(0.9);
    expect(models['b'].industryScore).toBeUndefined();
    expect(models['b'].industryRank).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 清单 TTL 保鲜
// ---------------------------------------------------------------------------

describe('清单 TTL 保鲜（前端打开页面）', () => {
  it('TTL 内不重拉，TTL 外重拉', async () => {
    const config = testConfig();
    const counter = { calls: 0 };
    const { decisionStore, modelInfoStore } = makeStores(config, modelsApiStub(['a', 'b'], counter));

    await modelInfoStore.ensureCatalog(decisionStore.snapshot(), true);
    expect(counter.calls).toBe(1);
    expect(modelInfoStore.catalogEntries().map((e) => e.modelId)).toEqual(['a', 'b']);

    // TTL 内：只重算评分，不再请求 Models API
    await modelInfoStore.ensureFresh(decisionStore.snapshot(), 60_000);
    expect(counter.calls).toBe(1);

    // TTL = 0：强制重拉
    await modelInfoStore.ensureFresh(decisionStore.snapshot(), 0);
    expect(counter.calls).toBe(2);
  });

  it('清单变化时目录版本随之变化（前端可感知）', async () => {
    const config = testConfig();
    const { decisionStore, modelInfoStore } = makeStores(config, modelsApiStub(['a', 'b']));
    const v1 = (await modelInfoStore.ensureCatalog(decisionStore.snapshot(), true)).catalogVersion;

    const store2 = new ModelInfoStore({
      filePath: join(dir, 'model-info-2.json'),
      llm: config.llmLibrary,
      catalogTimeoutMs: 2_000,
      fetchImpl: modelsApiStub(['a', 'b', 'c']),
    });
    const v2 = (await store2.ensureCatalog(decisionStore.snapshot(), true)).catalogVersion;
    expect(v2).not.toBe(v1);
  });
});

// ---------------------------------------------------------------------------
// 每日同步主流程
// ---------------------------------------------------------------------------

describe('runModelSync 端到端', () => {
  it('刷新清单 + 写入业界评分 + 同步进模型信息库', async () => {
    const config = testConfig();
    const { decisionStore, modelInfoStore } = makeStores(
      config,
      modelsApiStub(['kimi-k2.7', 'glm-5.2', 'gone-model']),
    );
    const file = resolveRatingsFile(config);
    writeFileSync(
      file,
      JSON.stringify({
        source: 'LMArena 2026-09',
        ratings: [
          { modelId: 'kimi-k2.7', score: 0.9, rank: 1 },
          { modelId: 'glm-5.2', score: 80, rank: 2 },
          { modelId: 'unknown-model', score: 0.4 },
        ],
      }),
    );

    const result = await runModelSync({ config, modelInfoStore, decisionStore });

    expect(result.ok).toBe(true);
    expect(result.modelCount).toBe(3);
    // 业界 2 条 + fallback 1 条（gone-model 未命中业界榜单，由内部画像加权补齐）
    expect(result.ratedCount).toBe(3);
    expect(result.fallbackCount).toBe(1);
    expect(result.ratingsOrigin).toBe('file');
    expect(result.unmatched).toEqual(['unknown-model']);

    // 决策信息库拿到评分（业界 2 条，另 1 条 fallback 写入 gone-model）
    const store = decisionStore.snapshot();
    expect(store.models['kimi-k2.7'].industryScore).toBe(0.9);
    expect(store.models['glm-5.2'].industryScore).toBe(0.8);
    expect(store.industrySync?.matched).toBe(3);

    // 模型信息库同步带上 industry，且已落盘
    const info = modelInfoStore.snapshot();
    const kimi = info.models.find((m) => m.modelId === 'kimi-k2.7');
    expect(kimi?.industry?.score).toBe(0.9);
    expect(kimi?.industry?.rank).toBe(1);

    const onDisk = JSON.parse(readFileSync(join(dir, 'model-info.json'), 'utf8'));
    expect(onDisk.models.find((m: { modelId: string }) => m.modelId === 'kimi-k2.7').industry.score).toBe(0.9);
  });

  it('评分来源缺失时只刷新清单，保留既有评分', async () => {
    const config = testConfig();
    const { decisionStore, modelInfoStore } = makeStores(config, modelsApiStub(['a', 'b']));

    // 先写入一次评分
    await decisionStore.applyIndustryRatings({
      ratings: [{ modelId: 'a', score: 0.77 }],
      origin: 'file',
      sourceLabel: 'first',
      ratingsUpdatedAt: 't1',
      unmatched: [],
      warnings: [],
    });

    // 不创建评分文件
    const result = await runModelSync({ config, modelInfoStore, decisionStore });

    expect(result.ok).toBe(true);
    expect(result.ratedCount).toBe(0);
    expect(result.ratingsOrigin).toBe('none');
    expect(result.industrySync).toBeUndefined();
    // 既有评分与摘要均保留
    expect(decisionStore.snapshot().models['a'].industryScore).toBe(0.77);
    expect(decisionStore.snapshot().industrySync?.sourceLabel).toBe('first');
  });

  it('互联网榜单经同系列变体匹配写入决策库', async () => {
    const config = testConfig('industry-ratings.json', {
      enabled: true,
      url: 'https://board.test/rows?dataset=x',
      maxPages: 1,
      pageSize: 100,
      timeoutMs: 500,
    });
    const modelIds = ['glm-5.2', 'glm-5.2-flash', 'minimax-m3', 'unrated-model'];
    const rows = [
      { model_name: 'glm-5.2-max', rating: 1470, rank: 29, category: 'overall' },
      { model_name: 'glm-5.2-flash', rating: 1460, rank: 26, category: 'overall' },
      { model_name: 'minimax-m3', rating: 1432, rank: 86, category: 'overall' },
      { model_name: 'some-other-model', rating: 1400, rank: 120, category: 'overall' },
    ];
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('board.test')) {
        return { ok: true, json: async () => ({ rows: rows.map((row) => ({ row })) }) };
      }
      return {
        ok: true,
        json: async () => ({ data: modelIds.map((id) => ({ id, max_input_tokens: 128_000 })) }),
      };
    }) as unknown as typeof fetch;

    const { decisionStore, modelInfoStore } = makeStores(config, fetchImpl);
    const result = await runModelSync({
      config,
      modelInfoStore,
      decisionStore,
      fetchImpl,
      log: () => undefined,
    });

    expect(result.ok).toBe(true);
    expect(result.ratingsOrigin).toBe('web');
    // 业界 3 条 + fallback 1 条（unrated-model 未命中榜单，由内部画像加权补齐）
    expect(result.ratedCount).toBe(4);
    expect(result.fallbackCount).toBe(1);
    expect(result.unmatched).toEqual(['some-other-model']);

    const models = decisionStore.snapshot().models;
    expect(models['glm-5.2'].industryScore).toBe(rankToScore(29));
    expect(models['glm-5.2'].industryRank).toBe(29);
    expect(models['glm-5.2-flash'].industryScore).toBe(rankToScore(26));
    expect(models['minimax-m3'].industryScore).toBe(rankToScore(86));
  });
});
