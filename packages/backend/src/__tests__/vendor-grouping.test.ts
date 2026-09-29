/**
 * 厂商推断 + 厂商聚合分组测试。
 *
 * 覆盖左侧看板「按厂商动态生成星球节点」的数据链路：
 * Models API 元数据 → `inferModelProfile` 的 vendor 字段 → `groupByVendor` 聚合。
 */
import { describe, it, expect } from 'vitest';
import { inferVendor, ensureVendorFields, inferModelProfile } from '../app-config.js';
import { groupByVendor, type ModelInfoEntry } from '../model-info-store.js';
import type { CatalogEntry } from '../model-catalog.js';

describe('inferVendor', () => {
  it('识别真实网关在用的厂商', () => {
    expect(inferVendor('glm-5.3 GLM-5.3').vendor).toBe('zhipu');
    expect(inferVendor('kimi-k3-1 Kimi-K3').vendor).toBe('moonshot');
    expect(inferVendor('deepseek-v4.1-flash Deepseek-V4.1-Flash').vendor).toBe('deepseek');
    expect(inferVendor('minimax-m3 MiniMax-M3').vendor).toBe('minimax');
    expect(inferVendor('hy4-preview-f Hy4 preview').vendor).toBe('tencent');
  });

  it('hy 前缀不会误伤其他厂商', () => {
    expect(inferVendor('hy3 Hy3').vendor).toBe('tencent');
    expect(inferVendor('qwen-2.5-coder Qwen').vendor).toBe('alibaba');
  });

  it('未命中规则时回落 other', () => {
    expect(inferVendor('totally-unknown-xyz')).toEqual({ vendor: 'other', label: '其他厂商' });
  });
});

describe('inferModelProfile vendor 字段', () => {
  it('从模型名 + 展示名 + 描述推断厂商', () => {
    const p = inferModelProfile({
      modelId: 'glm-5.3',
      meta: { name: 'GLM-5.3', description: 'Zhipu GLM flagship' },
    });
    expect(p.vendor).toBe('zhipu');
    expect(p.vendorLabel).toBe('智谱 GLM');
  });
});

describe('ensureVendorFields', () => {
  it('旧缓存缺字段时补齐', () => {
    const legacy = { modelId: 'kimi-k2.7', vendor: '', vendorLabel: '' };
    const fixed = ensureVendorFields(legacy);
    expect(fixed.vendor).toBe('moonshot');
  });

  it('已有字段时保持不变', () => {
    const cur = { modelId: 'kimi-k2.7', vendor: 'moonshot', vendorLabel: '月之暗面 Kimi' };
    expect(ensureVendorFields(cur)).toBe(cur);
  });
});

function mkEntry(modelId: string, vendor: string, vendorLabel: string, score: number): ModelInfoEntry {
  return {
    modelId,
    label: modelId,
    fromLiveCatalog: true,
    profile: {
      modelId,
      provider: 'llm-library',
      vendor,
      vendorLabel,
      capabilityTags: ['reasoning'],
      capability: 0.8,
      quality: 0.8,
      cost: 0.3,
      latency: 0.4,
      load: 0,
      contextWindow: 128_000,
      p95LatencyMs: 1500,
      inputPricePer1k: 0.001,
      outputPricePer1k: 0.003,
      health: 'healthy',
      profileVersion: 'p1',
      enabled: true,
    } as CatalogEntry,
    discrimination: {
      score,
      profileSpread: score,
      winConcentration: 0,
      evidenceConfidence: 0,
      coldStart: true,
      rating: '中',
    },
    stats: null,
    industry: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('groupByVendor', () => {
  it('同厂模型聚为一组，星球数 = 厂商数', () => {
    const groups = groupByVendor([
      mkEntry('glm-5.3', 'zhipu', '智谱 GLM', 0.4),
      mkEntry('glm-5.2', 'zhipu', '智谱 GLM', 0.3),
      mkEntry('kimi-k3-1', 'moonshot', '月之暗面 Kimi', 0.2),
      mkEntry('deepseek-v4-pro', 'deepseek', 'DeepSeek', 0.35),
    ]);
    expect(groups).toHaveLength(3);
    const zhipu = groups.find((g) => g.vendor === 'zhipu')!;
    expect(zhipu.modelCount).toBe(2);
    expect(zhipu.modelIds).toEqual(['glm-5.3', 'glm-5.2']);
  });

  it('按模型数降序 → 区分度降序 → 厂商名升序，顺序稳定', () => {
    const groups = groupByVendor([
      mkEntry('minimax-m3', 'minimax', 'MiniMax', 0.9),
      mkEntry('kimi-k3-1', 'moonshot', '月之暗面 Kimi', 0.2),
      mkEntry('glm-5.3', 'zhipu', '智谱 GLM', 0.4),
      mkEntry('glm-5.2', 'zhipu', '智谱 GLM', 0.3),
    ]);
    expect(groups.map((g) => g.vendor)).toEqual(['zhipu', 'minimax', 'moonshot']);
  });

  it('topDiscrimination 取组内最高分', () => {
    const groups = groupByVendor([
      mkEntry('glm-5.3', 'zhipu', '智谱 GLM', 0.4),
      mkEntry('glm-5.2', 'zhipu', '智谱 GLM', 0.62),
    ]);
    expect(groups[0].topDiscrimination).toBe(0.62);
  });
});
