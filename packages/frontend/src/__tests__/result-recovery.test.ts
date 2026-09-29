/**
 * 「结果」区文本回填测试。
 *
 * 覆盖 SSE 增量丢失时的两条兜底路径：
 * 1. `MODEL_COMPLETED.result` 终态回填（后端携带完整结果文本）
 * 2. `ResultTab` 的 `hasResult` 门控 —— 有事件即展示，不因正文为空而空白
 */
import { describe, it, expect } from 'vitest';
import { createInitialRouteState, routeEventReducer, type RouteState } from '../store/routeEventReducer.js';
import type { RouteEvent } from '../store/types.js';

function ev(type: RouteEvent['type'], payload: Record<string, unknown>, sequence: number): RouteEvent {
  return {
    eventId: `evt-${sequence}`,
    requestId: 'req-1',
    sequence,
    timestamp: new Date().toISOString(),
    type,
    payload,
  };
}

function reduce(state: RouteState, e: RouteEvent): RouteState {
  return routeEventReducer(state, { type: 'ROUTE_EVENT', event: e });
}

describe('MODEL_STREAMING 增量拼接', () => {
  it('逐条累加 delta', () => {
    let s = createInitialRouteState();
    s = reduce(s, ev('MODEL_STREAMING', { modelId: 'm1', delta: 'Hello' }, 1));
    s = reduce(s, ev('MODEL_STREAMING', { modelId: 'm1', delta: ' world' }, 2));
    expect(s.resultText).toBe('Hello world');
    expect(s.streaming).toBe(true);
  });

  it('空 delta 不污染正文', () => {
    let s = createInitialRouteState();
    s = reduce(s, ev('MODEL_STREAMING', { modelId: 'm1', delta: '' }, 1));
    expect(s.resultText).toBe('');
  });
});

describe('MODEL_COMPLETED 终态回填', () => {
  it('增量为空时用 result 回填正文', () => {
    let s = createInitialRouteState();
    s = reduce(s, ev('MODEL_SELECTED', { modelId: 'm1' }, 1));
    s = reduce(s, ev('MODEL_COMPLETED', { modelId: 'm1', result: '完整结果' }, 2));
    expect(s.resultText).toBe('完整结果');
    expect(s.streaming).toBe(false);
  });

  it('增量与 result 一致时不产生重复', () => {
    let s = createInitialRouteState();
    s = reduce(s, ev('MODEL_STREAMING', { modelId: 'm1', delta: 'OK' }, 1));
    s = reduce(s, ev('MODEL_COMPLETED', { modelId: 'm1', result: 'OK' }, 2));
    expect(s.resultText).toBe('OK');
  });

  it('部分增量丢失时以 result 为准（不拼接）', () => {
    let s = createInitialRouteState();
    s = reduce(s, ev('MODEL_STREAMING', { modelId: 'm1', delta: ' partial' }, 1));
    // 终态携带完整文本 → 直接覆盖，避免"半截+全文"拼接错乱
    s = reduce(s, ev('MODEL_COMPLETED', { modelId: 'm1', result: '完整结果' }, 2));
    expect(s.resultText).toBe('完整结果');
  });

  it('无 result 字段时保持原增量', () => {
    let s = createInitialRouteState();
    s = reduce(s, ev('MODEL_STREAMING', { modelId: 'm1', delta: 'kept' }, 1));
    s = reduce(s, ev('MODEL_COMPLETED', { modelId: 'm1' }, 2));
    expect(s.resultText).toBe('kept');
  });
});

describe('结果区门控', () => {
  it('有事件即视为已产生结果（正文为空也不空白）', () => {
    const s = reduce(createInitialRouteState(), ev('MODEL_SELECTED', { modelId: 'm1' }, 1));
    const hasResult = s.resultText.length > 0 || s.events.length > 0;
    expect(hasResult).toBe(true);
  });

  it('初始态无事件 → 不展示', () => {
    const s = createInitialRouteState();
    expect(s.resultText.length > 0 || s.events.length > 0).toBe(false);
  });
});
