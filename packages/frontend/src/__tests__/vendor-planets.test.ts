/**
 * 星球节点（厂商）reducer 测试。
 *
 * 验证「模型节点由 LLM 模型服务动态下发、按厂商聚成星球」这条链路：
 * `SET_VENDOR_GROUPS` 重建候选节点，且模型级事件能正确命中所属星球。
 */
import { describe, it, expect } from 'vitest';
import {
  createInitialRouteState,
  routeEventReducer,
  withVendorColors,
  type RouteState,
  type RouteAction,
  type VendorGroup,
} from '../store/routeEventReducer.js';
import type { RouteEvent } from '../store/types.js';

function reduce(state: RouteState, action: RouteAction): RouteState {
  return routeEventReducer(state, action);
}

const GROUPS: VendorGroup[] = withVendorColors([
  { vendor: 'zhipu', vendorLabel: '智谱 GLM', modelCount: 3, modelIds: ['glm-5.3', 'glm-5.2', 'glm-5.1'], topDiscrimination: 0.4 },
  { vendor: 'moonshot', vendorLabel: '月之暗面 Kimi', modelCount: 2, modelIds: ['kimi-k3-1', 'kimi-k2.7'], topDiscrimination: 0.2 },
  { vendor: 'deepseek', vendorLabel: 'DeepSeek', modelCount: 1, modelIds: ['deepseek-v4-pro'], topDiscrimination: 0.35 },
]);

function ev(type: RouteEvent['type'], payload: Record<string, unknown>, requestId = 'req-1'): RouteEvent {
  return {
    eventId: 'e1',
    requestId,
    sequence: 1,
    timestamp: new Date().toISOString(),
    type,
    decisionId: 'd1',
    payload,
  };
}

describe('SET_VENDOR_GROUPS', () => {
  it('按厂商分组重建候选星球节点', () => {
    const s0 = createInitialRouteState();
    const s1 = reduce(s0, { type: 'SET_VENDOR_GROUPS', groups: GROUPS });
    const planets = s1.nodes.filter((n) => n.type === 'candidate');
    expect(planets).toHaveLength(3);
    expect(planets.map((p) => p.id)).toEqual([
      'vendor:zhipu',
      'vendor:moonshot',
      'vendor:deepseek',
    ]);
    expect(planets.map((p) => p.label)).toEqual(['智谱 GLM', '月之暗面 Kimi', 'DeepSeek']);
    // 主链仍是 Prompt输入 → Jev智能路由中枢 → 星球 → 决策库
    expect(s1.nodes[0].id).toBe('prompt');
    expect(s1.nodes[1].id).toBe('jev-hub');
    expect(s1.nodes[1].label).toBe('Jev智能路由中枢');
    expect(s1.nodes[s1.nodes.length - 1].id).toBe('knowledge');
  });

  it('星球节点携带所辖 modelIds', () => {
    const s1 = reduce(createInitialRouteState(), { type: 'SET_VENDOR_GROUPS', groups: GROUPS });
    const zhipu = s1.nodes.find((n) => n.id === 'vendor:zhipu')!;
    expect(zhipu.modelIds).toEqual(['glm-5.3', 'glm-5.2', 'glm-5.1']);
  });

  it('空分组时回落离线兜底星球', () => {
    const s1 = reduce(createInitialRouteState(), { type: 'SET_VENDOR_GROUPS', groups: [] });
    expect(s1.vendorGroups.length).toBeGreaterThan(0);
    expect(s1.nodes.filter((n) => n.type === 'candidate')).toHaveLength(s1.vendorGroups.length);
  });

  it('RESET_ROUTE 保留已拉取的星球分组', () => {
    const s1 = reduce(createInitialRouteState(), { type: 'SET_VENDOR_GROUPS', groups: GROUPS });
    const s2 = reduce(s1, { type: 'RESET_ROUTE' });
    expect(s2.vendorGroups).toEqual(GROUPS);
    expect(s2.nodes.filter((n) => n.type === 'candidate')).toHaveLength(3);
  });

  it('星球颜色按厂商稳定分配', () => {
    const s1 = reduce(createInitialRouteState(), { type: 'SET_VENDOR_GROUPS', groups: GROUPS });
    const colors = s1.vendorGroups.map((g) => g.color);
    expect(new Set(colors).size).toBe(colors.length);
  });
});

describe('模型级事件 → 星球节点', () => {
  const base = reduce(createInitialRouteState(), { type: 'SET_VENDOR_GROUPS', groups: GROUPS });

  it('MODEL_SELECTED 命中所属厂商星球', () => {
    const s1 = reduce(base, {
      type: 'ROUTE_EVENT',
      event: ev('MODEL_SELECTED', { modelId: 'kimi-k2.7' }),
    });
    const winner = s1.nodes.filter((n) => n.isWinner);
    expect(winner).toHaveLength(1);
    expect(winner[0].id).toBe('vendor:moonshot');
    expect(s1.winnerModelId).toBe('kimi-k2.7');
  });

  it('MODEL_CALL_STARTED 只激活所属星球', () => {
    const s1 = reduce(base, {
      type: 'ROUTE_EVENT',
      event: ev('MODEL_CALL_STARTED', { modelId: 'glm-5.1' }),
    });
    const active = s1.nodes.filter((n) => n.type === 'candidate' && n.active);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('vendor:zhipu');
  });

  it('CONSTRAINT_FILTERED 灰掉所属星球', () => {
    const s1 = reduce(base, {
      type: 'ROUTE_EVENT',
      event: ev('CONSTRAINT_FILTERED', { modelId: 'deepseek-v4-pro', reason: 'latency' }),
    });
    const greyed = s1.nodes.filter((n) => n.greyedOut);
    expect(greyed).toHaveLength(1);
    expect(greyed[0].id).toBe('vendor:deepseek');
  });

  it('未知 modelId 不误伤任何星球', () => {
    const s1 = reduce(base, {
      type: 'ROUTE_EVENT',
      event: ev('MODEL_SELECTED', { modelId: 'not-in-catalog' }),
    });
    expect(s1.nodes.filter((n) => n.isWinner)).toHaveLength(0);
  });
});
