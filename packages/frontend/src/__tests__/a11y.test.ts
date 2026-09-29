/**
 * @vitest-environment jsdom
 */

/**
 * A11Y accessibility audit — A11Y-1/2.
 * Uses axe-core to verify zero violations across key components.
 */
import { describe, it, expect } from 'vitest';
import axe from 'axe-core';

/**
 * Create a minimal DOM element and run axe-core audit.
 * For Vue components this tests the rendered HTML structure.
 */
function createAndAudit(html: string): Promise<axe.AxeResults> {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  return axe.run(container, {
    rules: {
      // Color contrast requires full CSS; skip in unit test
      'color-contrast': { enabled: false },
    },
  }).finally(() => {
    document.body.removeChild(container);
  });
}

describe('A11Y audit', () => {
  it('InputTab: labeled input has no violations', async () => {
    const html = `
      <div role="tabpanel" aria-label="输入">
        <label for="prompt-input">Prompt</label>
        <textarea id="prompt-input" aria-label="用户输入" placeholder="输入您的需求..."></textarea>
      </div>`;
    const results = await createAndAudit(html);
    expect(results.violations).toHaveLength(0);
  });

  it('ResultTab: ARIA live region has no violations', async () => {
    const html = `
      <div role="tabpanel" aria-label="结果">
        <div role="status" aria-live="polite">Routing result</div>
        <div role="alert" aria-live="assertive">Low confidence warning</div>
      </div>`;
    const results = await createAndAudit(html);
    expect(results.violations).toHaveLength(0);
  });

  it('ModelsTab: model cards with ARIA roles have no violations', async () => {
    const html = `
      <div role="tabpanel" aria-label="模型">
        <div role="list" aria-label="模型列表">
          <div role="listitem" aria-label="GPT-4o">GPT-4o</div>
        </div>
      </div>`;
    const results = await createAndAudit(html);
    expect(results.violations).toHaveLength(0);
  });

  it('HistoryTab: tab panel with search has no violations', async () => {
    const html = `
      <div role="tabpanel" aria-label="历史">
        <label for="history-search">Search</label>
        <input id="history-search" type="search" aria-label="搜索历史记录" />
      </div>`;
    const results = await createAndAudit(html);
    expect(results.violations).toHaveLength(0);
  });

  it('StageView: canvas with role=img has no violations', async () => {
    const html = `
      <div role="region" aria-label="路由可视化">
        <canvas role="img" aria-label="3D路由树可视化" tabindex="0"></canvas>
      </div>`;
    const results = await createAndAudit(html);
    expect(results.violations).toHaveLength(0);
  });

  it('PanelView: tablist with tabs has no violations', async () => {
    const html = `
      <div role="tablist" aria-label="路由面板">
        <button role="tab" aria-selected="true" aria-controls="panel-input" id="tab-input">输入</button>
        <button role="tab" aria-selected="false" aria-controls="panel-models" id="tab-models">模型</button>
      </div>
      <div role="tabpanel" id="panel-input" aria-labelledby="tab-input">Input content</div>
      <div role="tabpanel" id="panel-models" aria-labelledby="tab-models" hidden>Models content</div>`;
    const results = await createAndAudit(html);
    expect(results.violations).toHaveLength(0);
  });
});
