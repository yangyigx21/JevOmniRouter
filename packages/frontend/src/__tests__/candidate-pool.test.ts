/**
 * @vitest-environment jsdom
 */

/**
 * 候选模型池动态一致性测试（MODEL-2）。
 *
 * 前端不得内置模型名：候选池必须与后端 `/v1/models` 清单同源，
 * 且勾选结果通过 `allowedModelIds` 回传给后端做池约束。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';

const fetchModelInfo = vi.fn();
vi.mock('../api/client.js', () => ({ fetchModelInfo: () => fetchModelInfo() }));

const { default: InputTab } = await import('../components/tabs/InputTab.vue');
const { createStore } = await import('../store/createStore.js');
const { createInitialRouteState, routeEventReducer } = await import('../store/routeEventReducer.js');

function snapshot(modelIds: string[]) {
  return {
    infoVersion: 'i1',
    updatedAt: '2026-09-30T00:00:00Z',
    catalogVersion: 'c1',
    source: 'models-api' as const,
    models: modelIds.map((modelId) => ({
      modelId,
      label: modelId,
      fromLiveCatalog: true,
      profile: { vendorLabel: 'V' },
      discrimination: { score: 0.5 },
      stats: null,
      updatedAt: '2026-09-30T00:00:00Z',
    })),
  };
}

type Wrapper = VueWrapper<any>;

async function mountTab(): Promise<Wrapper> {
  const store = createStore(createInitialRouteState(), routeEventReducer);
  const w = mount(InputTab, { props: { store }, attachTo: document.body });
  await flushPromises();
  return w;
}

/** 池区（`[data-pool]`）内的按钮。 */
function poolChips(w: Wrapper) {
  return w.findAll('[data-pool] button');
}

function poolHead(w: Wrapper) {
  return w.find('[data-pool-head]').text();
}

function selectedLabels(w: Wrapper) {
  return poolChips(w).filter((c) => c.classes('on')).map((c) => c.text());
}

/** contenteditable 编辑器：写入 innerText 并派发 input 事件供 v-model 捕获。 */
async function typePrompt(w: Wrapper, text: string) {
  const editor = w.find('#editor').element as HTMLElement;
  editor.innerText = text;
  await w.find('#editor').trigger('input');
}

function submitted(w: Wrapper): { text: string; allowedModelIds?: string[] } | undefined {
  return w.emitted('submit')?.[0]?.[0] as { text: string; allowedModelIds?: string[] } | undefined;
}

beforeEach(() => {
  fetchModelInfo.mockReset();
});

describe('候选模型池与模型清单动态一致', () => {
  it('渲染后端清单中的全部模型，不含任何内置模型名', async () => {
    fetchModelInfo.mockResolvedValue(snapshot(['kimi-k2.7', 'glm-5.2', 'deepseek-v4.1-flash']));
    const w = await mountTab();

    expect(poolChips(w).map((c) => c.text())).toEqual(['kimi-k2.7', 'glm-5.2', 'deepseek-v4.1-flash']);
    expect(w.text()).not.toContain('gpt-4o');
  });

  it('默认全选，计数显示 已选 N / N', async () => {
    fetchModelInfo.mockResolvedValue(snapshot(['a', 'b', 'c']));
    const w = await mountTab();

    expect(selectedLabels(w)).toEqual(['a', 'b', 'c']);
    expect(poolHead(w)).toContain('已选 3 / 3');
  });

  it('取消勾选后计数与高亮同步下降', async () => {
    fetchModelInfo.mockResolvedValue(snapshot(['a', 'b', 'c']));
    const w = await mountTab();

    await poolChips(w)[0].trigger('click');

    expect(selectedLabels(w)).toEqual(['b', 'c']);
    expect(poolHead(w)).toContain('已选 2 / 3');
  });

  it('至少保留一个候选：最后一个不可取消', async () => {
    fetchModelInfo.mockResolvedValue(snapshot(['a', 'b']));
    const w = await mountTab();

    await poolChips(w)[0].trigger('click');
    await poolChips(w)[1].trigger('click');
    await poolChips(w)[1].trigger('click');

    expect(selectedLabels(w)).toEqual(['b']);
    expect(poolHead(w)).toContain('已选 1 / 2');
  });

  it('清单拉取失败时提示降级并按目录全量参与，不渲染内置兜底模型', async () => {
    fetchModelInfo.mockRejectedValue(new Error('BOOM'));
    const w = await mountTab();

    expect(w.text()).toContain('BOOM');
    expect(w.text()).toContain('本次按目录全量参与');
    expect(poolChips(w)).toHaveLength(0);
  });
});

describe('提交载荷携带池约束', () => {
  it('全选时不下发 allowedModelIds，交后端按目录全量参与', async () => {
    fetchModelInfo.mockResolvedValue(snapshot(['a', 'b', 'c']));
    const w = await mountTab();
    await typePrompt(w, '分析这段代码');

    await w.find('button[aria-label="提交路由请求"]').trigger('click');

    expect(submitted(w)).toEqual({ text: '分析这段代码' });
  });

  it('收窄池时下发选中的 allowedModelIds', async () => {
    fetchModelInfo.mockResolvedValue(snapshot(['a', 'b', 'c']));
    const w = await mountTab();
    await typePrompt(w, '分析这段代码');

    await poolChips(w)[0].trigger('click');
    await w.find('button[aria-label="提交路由请求"]').trigger('click');

    expect(submitted(w)).toEqual({
      text: '分析这段代码',
      allowedModelIds: ['b', 'c'],
    });
  });

  it('清单为空时提交不携带池约束', async () => {
    fetchModelInfo.mockRejectedValue(new Error('offline'));
    const w = await mountTab();
    await typePrompt(w, '离线提问');

    await w.find('button[aria-label="提交路由请求"]').trigger('click');

    expect(submitted(w)).toEqual({ text: '离线提问' });
  });
});
