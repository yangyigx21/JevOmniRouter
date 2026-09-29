/**
 * 历史库文本编码测试。
 *
 * 覆盖「历史」信息区乱码的两个真实风险点：
 * 1. `summarizePrompt` 截断落在 UTF-16 代理对中间 → 孤立码元 → `�`
 * 2. 中文摘要必须能无损 JSON 往返（落盘 → 读出 完全一致）
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryStore, summarizePrompt, type HistoryEntry } from '../history-store.js';

describe('summarizePrompt', () => {
  it('短文本原样返回（中文不截断）', () => {
    expect(summarizePrompt('用一句话解释什么是负载均衡')).toBe('用一句话解释什么是负载均衡');
  });

  it('折叠空白为单空格', () => {
    expect(summarizePrompt('a   b\n\nc')).toBe('a b c');
  });

  it('超长时截断并加省略号', () => {
    const out = summarizePrompt('x'.repeat(200), 10);
    expect(out).toBe(`${'x'.repeat(10)}…`);
  });

  it('截断不落在代理对中间（emoji 场景）', () => {
    // 120 是 max；构造使第 120 位正好是高代理（emoji 首码元）
    const emoji = '😀'; // 2 个 UTF-16 码元
    const pad = 'a'.repeat(119);
    const out = summarizePrompt(pad + emoji + 'tail', 120);
    // 截断后不得含有孤立代理项
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(out.endsWith('…')).toBe(true);
    // 应回退一位，只截到 119 个 a
    expect(out).toBe(`${'a'.repeat(119)}…`);
  });

  it('摘要文本可无损 JSON 往返', () => {
    const original = '混合 emoji 😀 与中文的 prompt 摘要';
    const round = JSON.parse(JSON.stringify({ s: summarizePrompt(original) })).s;
    expect(round).toBe(original);
  });
});

describe('HistoryStore 中文往返', () => {
  it('写入并读回中文 prompt/result 无损', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-history-'));
    try {
      const store = new HistoryStore({ dir });
      const entry: HistoryEntry = {
        requestId: 'req-utf8',
        decisionId: 'd1',
        executionId: 'e1',
        createdAt: new Date().toISOString(),
        hourBucket: '2026-01-01-00',
        prompt: '用一句话解释什么是负载均衡，并给出三种常见实现方式。',
        promptSummary: '用一句话解释什么是负载均衡，并给出三种常见实现方式。',
        selectedModelId: 'glm-5.3',
        routeTier: 'ROUTE',
        confidence: 0.9,
        thresholds: { high: 0.82, mid: 0.6 },
        decisionSource: 'TYPE_SAFE_JEV',
        execution: {
          modelId: 'glm-5.3',
          latencyMs: 1234,
          promptTokens: 10,
          completionTokens: 20,
          costUsd: 0.001,
          status: 'success',
        },
        result: '负载均衡是将网络请求均匀分配到多台服务器上的技术。',
        eventTypes: ['ROUTE_CREATED', 'EXPERIENCE_SAVED'],
      };
      await store.append(entry);

      // 落盘文件本身必须是合法 UTF-8 中文，而非 '?'
      const raw = readFileSync(join(dir, '2026-01-01-00.json'), 'utf8');
      expect(raw).toContain('负载均衡');
      expect(raw).not.toMatch(/\?{2,}/);

      // 换一个 store 实例读回（走磁盘 → 缓存路径）
      const reader = new HistoryStore({ dir });
      const found = reader.query({ limit: 10 }).entries[0];
      expect(found.prompt).toBe(entry.prompt);
      expect(found.promptSummary).toBe(entry.promptSummary);
      expect(found.result).toBe(entry.result);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('损坏文件被备份并重建空桶，不抛异常', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-history-bad-'));
    try {
      writeFileSync(join(dir, '2026-01-01-00.json'), '{ this is not json', 'utf8');
      const store = new HistoryStore({ dir });
      const res = store.query({ limit: 10 });
      expect(res.entries).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
