/**
 * @vitest-environment jsdom
 */

/**
 * 历史记录详情对话框测试（UI-1）。
 *
 * 点击历史列表项应弹出对话框（而非内联展开），完整呈现该次执行的关键信息，
 * 并支持遮罩点击 / 关闭按钮 / Esc 三种关闭方式。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';

const fetchHistory = vi.fn();
const fetchHistoryStats = vi.fn();
vi.mock('../api/client.js', () => ({
  fetchHistory: (o: unknown) => fetchHistory(o),
  fetchHistoryStats: () => fetchHistoryStats(),
}));

const { default: HistoryTab } = await import('../components/tabs/HistoryTab.vue');

type Wrapper = VueWrapper<any>;

function entry(requestId: string, overrides: Record<string, any> = {}) {
  return {
    requestId,
    decisionId: `dec-${requestId}`,
    executionId: `exe-${requestId}`,
    createdAt: '2026-09-30T08:12:00Z',
    hourBucket: '2026-09-30T08',
    prompt: `原始 prompt ${requestId}`,
    promptSummary: `摘要 ${requestId}`,
    selectedModelId: 'kimi-k2.7',
    jevRecommendation: 'kimi-k2.7',
    routeTier: 'ROUTE',
    confidence: 0.87,
    thresholds: { high: 0.85, mid: 0.6 },
    decisionSource: 'jev-runtime',
    execution: {
      modelId: 'kimi-k2.7',
      latencyMs: 1234,
      promptTokens: 120,
      completionTokens: 340,
      costUsd: 0.00123,
      status: 'ok',
      usageSource: 'provider' as const,
    },
    result: `模型输出 ${requestId}`,
    eventTypes: ['JEV_CALL_STARTED', 'JEV_DECISION_READY'],
    ...overrides,
  };
}

async function mountTab(): Promise<Wrapper> {
  const w = mount(HistoryTab, { props: { active: true }, attachTo: document.body });
  await flushPromises();
  return w;
}

/** 对话框被 Teleport 到 body，需在 document 上查询而非 wrapper 内。 */
function dialog(): HTMLElement | null {
  return document.body.querySelector('[data-hdetail]');
}

function dialogBox(): HTMLElement | null {
  return dialog()?.querySelector('.box') ?? null;
}

function dialogText(): string {
  return dialogBox()?.textContent ?? '';
}

beforeEach(() => {
  fetchHistory.mockReset();
  fetchHistoryStats.mockReset();
  document.body.innerHTML = '';
  fetchHistoryStats.mockResolvedValue({
    total: 2,
    hours: 1,
    currentHour: '2026-09-30T08',
    byTier: { ROUTE: 2, GATE: 0, ESCALATE: 0 },
  });
  fetchHistory.mockResolvedValue({
    total: 2,
    hours: [{ hourBucket: '2026-09-30T08', count: 2, updatedAt: '2026-09-30T08:59:00Z' }],
    entries: [entry('req-1'), entry('req-2')],
  });
});

describe('历史记录详情对话框', () => {
  it('列表项是可聚焦按钮，初始不显示对话框', async () => {
    const w = await mountTab();

    const cards = w.findAll('.hcard');
    expect(cards).toHaveLength(2);
    expect(cards[0].element.tagName).toBe('BUTTON');
    expect(cards[0].attributes('type')).toBe('button');
    expect(dialog()).toBeNull();
  });

  it('点击记录弹出对话框而非在列表内联展开', async () => {
    const w = await mountTab();

    await w.findAll('.hcard')[0].trigger('click');

    expect(dialog()).not.toBeNull();
    // 对话框不应留在列表容器内
    expect(w.findAll('.hcard')).toHaveLength(2);
    expect(w.text()).not.toContain('原始 prompt req-1');
  });

  it('对话框呈现选型、置信度、执行回执与事件序列等完整信息', async () => {
    const w = await mountTab();

    await w.findAll('.hcard')[0].trigger('click');

    expect(dialogText()).toContain('摘要 req-1');
    expect(dialogText()).toContain('req-1');
    expect(dialogText()).toContain('kimi-k2.7');
    expect(dialogText()).toContain('0.87');
    expect(dialogText()).toContain('1234 ms');
    expect(dialogText()).toContain('120 prompt + 340 completion');
    expect(dialogText()).toContain('原始 prompt req-1');
    expect(dialogText()).toContain('模型输出 req-1');
    expect(dialogText()).toContain('调用 Jev 决策中枢');
  });

  it('展示被点击的那条记录，再次点击同项则关闭', async () => {
    const w = await mountTab();
    const cards = w.findAll('.hcard');

    await cards[1].trigger('click');
    expect(dialogText()).toContain('req-2');

    await cards[1].trigger('click');
    expect(dialog()).toBeNull();
  });

  it('点击遮罩空白处关闭', async () => {
    const w = await mountTab();
    await w.findAll('.hcard')[0].trigger('click');

    dialog()!.click();
    await flushPromises();

    expect(dialog()).toBeNull();
  });

  it('点击关闭按钮关闭', async () => {
    const w = await mountTab();
    await w.findAll('.hcard')[0].trigger('click');

    (dialogBox()!.querySelector('[data-hd-close]') as HTMLElement).click();
    await flushPromises();

    expect(dialog()).toBeNull();
  });

  it('按 Esc 关闭', async () => {
    const w = await mountTab();
    await w.findAll('.hcard')[0].trigger('click');

    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();

    expect(dialog()).toBeNull();
  });

  it('执行失败时展示错误信息与告警样式', async () => {
    fetchHistory.mockResolvedValue({
      total: 1,
      hours: [{ hourBucket: '2026-09-30T08', count: 1, updatedAt: '2026-09-30T08:59:00Z' }],
      entries: [
        entry('req-err', {
          execution: {
            modelId: 'kimi-k2.7',
            latencyMs: 900,
            promptTokens: 10,
            completionTokens: 0,
            costUsd: 0,
            status: 'error',
            errorMessage: '上游超时',
          },
        }),
      ],
    });
    const w = await mountTab();

    await w.findAll('.hcard')[0].trigger('click');

    expect(dialogBox()!.querySelector('.warnbox')?.textContent).toContain('上游超时');
    expect(dialogText()).toContain('error');
  });
});

describe('事件序列可读化', () => {
  /** 单条记录挂载并打开对话框，返回对话框元素。 */
  async function openWith(eventTypes: string[]): Promise<HTMLElement> {
    fetchHistory.mockResolvedValue({
      total: 1,
      hours: [{ hourBucket: '2026-09-30T08', count: 1, updatedAt: '2026-09-30T08:59:00Z' }],
      entries: [entry('req-1', { eventTypes })],
    });
    const w = await mountTab();
    await w.findAll('.hcard')[0].trigger('click');
    return dialogBox()!;
  }

  it('英文事件常量渲染为中文名称', async () => {
    const box = await openWith([
      'ROUTE_CREATED',
      'EXPERIENCE_RETRIEVED',
      'JEV_CALL_STARTED',
      'JEV_DECISION_READY',
      'CONSTRAINT_GATE_PASSED',
      'MODEL_SELECTED',
      'MODEL_CALL_STARTED',
      'MODEL_COMPLETED',
      'EXPERIENCE_SAVED',
    ]);

    const names = [...box.querySelectorAll('.evname')].map((n) => n.textContent);
    expect(names).toEqual([
      '创建路由请求',
      '读取历史决策经验',
      '调用 Jev 决策中枢',
      'Jev 决策就绪',
      '通过硬约束校验',
      '选定执行模型',
      '开始调用模型',
      '模型调用完成',
      '回写决策经验',
    ]);
  });

  it('异常与降级事件使用警示色标记', async () => {
    const box = await openWith(['JEV_CALL_STARTED', 'JEV_FALLBACK', 'ROUTE_ESCALATED']);

    const dots = [...box.querySelectorAll('.evdot')];
    expect(dots[1].className).toContain('jev_fallback');
    expect(dots[2].className).toContain('route_escalated');
    expect([...box.querySelectorAll('.evname')].map((n) => n.textContent)).toContain('转人工复核');
  });

  it('重复的流式事件折叠为一条并显示次数', async () => {
    const box = await openWith([
      'MODEL_CALL_STARTED',
      ...Array(48).fill('MODEL_STREAMING'),
      'MODEL_COMPLETED',
    ]);

    const items = [...box.querySelectorAll('.evitem')];
    expect(items).toHaveLength(3);
    expect(items[1].querySelector('.evname')!.textContent).toBe('模型流式输出');
    expect(items[1].querySelector('.evcount')!.textContent).toBe('×48');
    expect(box.textContent).toContain('共 50 条');
  });

  it('非连续的同名事件不合并', async () => {
    const box = await openWith(['MODEL_STREAMING', 'MODEL_COMPLETED', 'MODEL_STREAMING']);

    const counts = [...box.querySelectorAll('.evcount')].map((c) => c.textContent);
    expect(counts).toEqual([]);
    expect(box.querySelectorAll('.evitem')).toHaveLength(3);
  });

  it('未知事件类型回退显示原始常量', async () => {
    const box = await openWith(['SOME_FUTURE_EVENT']);

    expect(box.querySelector('.evname')!.textContent).toBe('SOME_FUTURE_EVENT');
    expect(box.querySelector('.evraw')!.textContent).toBe('SOME_FUTURE_EVENT');
  });

  it('无事件时显示占位符', async () => {
    const box = await openWith([]);

    expect(box.querySelector('.evlist')).toBeNull();
    expect(box.textContent).toContain('—');
  });
});
