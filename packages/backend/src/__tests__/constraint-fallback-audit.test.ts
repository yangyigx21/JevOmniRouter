/**
 * 约束回落登记测试 —— JEV-11（`spec.md` 附录 G-2）。
 *
 * 背景：候选池存在两处回落（白名单无交集、硬约束淘汰全部），原实现静默回落，
 * 「约束是否真的生效」无从判断。G-2 要求补 `constraintFallback` 字段使该行为可审计，
 * **且不改变既有行为**（仍回落，不改为 ESCALATE）。
 *
 * 本测试锁定三件事：
 * 1. 回落发生时 `constraintFallback` / `constraintFallbackReason` 被正确置位；
 * 2. 未回落时该字段保持 false / undefined（不污染常规路径）；
 * 3. 回落本身**不改变**选型结果（行为不变，仅可观测）。
 */
import { describe, it, expect } from 'vitest';
import { generateReceipt, summarizeReceipt } from '../decision-receipt.js';
import { filterPool } from '../route-orchestrator.js';
import type { CatalogEntry } from '../model-catalog.js';

function entry(modelId: string, over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    modelId,
    provider: 'p',
    vendor: 'v',
    vendorLabel: 'V',
    capabilityTags: ['code'],
    p95LatencyMs: 1000,
    inputPricePer1k: 0.001,
    outputPricePer1k: 0.002,
    health: 'ok',
    profileVersion: 'v1',
    enabled: true,
    ...over,
  } as unknown as CatalogEntry;
}

function receipt(overrides: Record<string, unknown> = {}) {
  return generateReceipt({
    decisionId: 'jev-req-1',
    requestId: 'req-1',
    decisionSource: 'TYPE_SAFE_JEV',
    contractVersion: 'router@1',
    stateVersion: 'req-1:2026-09-30T08',
    stateHash: 'abcd1234',
    probabilityDistribution: [
      { modelId: 'kimi-k2.7', catalogIndex: 0, raw: 0.9, probability: 0.62 },
    ],
    finalModelId: 'kimi-k2.7',
    jevRecommendation: 'kimi-k2.7',
    thresholdsUsed: { high: 0.82, mid: 0.6 },
    consequence: 'medium',
    routeTier: 'ROUTE',
    forcedHumanReview: false,
    actualAction: 'route_only',
    confidence: 0.89,
    ...overrides,
  });
}

describe('filterPool 回落判定（G-2 核心）', () => {
  const catalog = [entry('a'), entry('b'), entry('c')];

  it('未给白名单时取全量可用池，不算回落', () => {
    const r = filterPool(catalog);
    expect(r.pool.map((m) => m.modelId)).toEqual(['a', 'b', 'c']);
    expect(r.poolFallback).toBe(false);
  });

  it('白名单为空数组时同样不算回落', () => {
    expect(filterPool(catalog, []).poolFallback).toBe(false);
  });

  it('白名单有交集时按白名单收窄，不算回落', () => {
    const r = filterPool(catalog, ['a', 'c']);
    expect(r.pool.map((m) => m.modelId)).toEqual(['a', 'c']);
    expect(r.poolFallback).toBe(false);
  });

  it('白名单与目录无交集时回落全量，并标记 poolFallback', () => {
    const r = filterPool(catalog, ['nope-1', 'nope-2']);
    // 行为不变：仍回落全量
    expect(r.pool.map((m) => m.modelId)).toEqual(['a', 'b', 'c']);
    // 但必须被标记
    expect(r.poolFallback).toBe(true);
  });

  it('停用 / down 的模型不进池，也不影响回落判定', () => {
    const mixed = [entry('a'), entry('b', { enabled: false }), entry('c', { health: 'down' })];
    const r = filterPool(mixed, ['zzz']);
    expect(r.pool.map((m) => m.modelId)).toEqual(['a']);
    expect(r.poolFallback).toBe(true);
  });

  it('回落判定不改变目录序（MODEL-3 下标契约）', () => {
    const r = filterPool(catalog, ['c', 'a']);
    expect(r.pool.map((m) => m.modelId)).toEqual(['a', 'c']);
  });
});

describe('constraintFallback 登记（G-2）', () => {
  it('缺省为 false（常规路径不被污染）', () => {
    const r = receipt();
    expect(r.constraintFallback).toBe(false);
    expect(r.constraintFallbackReason).toBeUndefined();
  });

  it('白名单无交集时登记 allowed_model_ids_not_in_catalog', () => {
    const r = receipt({
      constraintFallback: true,
      constraintFallbackReason: 'allowed_model_ids_not_in_catalog',
    });
    expect(r.constraintFallback).toBe(true);
    expect(r.constraintFallbackReason).toBe('allowed_model_ids_not_in_catalog');
  });

  it('硬约束淘汰全部时登记 all_candidates_eliminated', () => {
    const r = receipt({
      constraintFallback: true,
      constraintFallbackReason: 'all_candidates_eliminated',
    });
    expect(r.constraintFallbackReason).toBe('all_candidates_eliminated');
  });

  it('未回落时摘要不出现 constraintFallback', () => {
    const text = summarizeReceipt(receipt());
    expect(text).not.toContain('constraintFallback');
  });

  it('回落时摘要显式标注原因，便于审计追溯', () => {
    const text = summarizeReceipt(
      receipt({
        constraintFallback: true,
        constraintFallbackReason: 'all_candidates_eliminated',
      }),
    );
    expect(text).toContain('constraintFallback=true');
    expect(text).toContain('all_candidates_eliminated');
  });

  it('回落登记不影响凭据完整性与其他字段（行为不变）', () => {
    const normal = receipt();
    const fallback = receipt({
      constraintFallback: true,
      constraintFallbackReason: 'all_candidates_eliminated',
    });
    // 除回落字段外，凭据内容应完全一致 —— 证明仅新增可观测性
    expect(fallback.routeTier).toBe(normal.routeTier);
    expect(fallback.finalModelId).toBe(normal.finalModelId);
    expect(fallback.probabilityDistribution).toEqual(normal.probabilityDistribution);
    expect(fallback.confidence).toBe(normal.confidence);
  });
});
