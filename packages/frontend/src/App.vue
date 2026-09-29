<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import type { RouteState, RouteAction } from './store/routeEventReducer.js';
import { createInitialRouteState, routeEventReducer } from './store/routeEventReducer.js';
import { createStore } from './store/createStore.js';
import StageView from './components/StageView.vue';
import PanelView from './components/PanelView.vue';
import { getMode, type OperationMode } from './offline/OfflineAdapter.js';
import {
  healthCheck,
  createRoute,
  subscribeEvents,
  fetchConfig,
  type PublicConfig,
} from './api/client.js';
import {
  ALL_SCENARIOS,
  buildMockEventSequence,
  buildStreamingChunks,
  type MockScenario,
} from './mock/mockScenario.js';

const store = createStore<RouteState, RouteAction>(
  createInitialRouteState(),
  routeEventReducer,
);

const activeTab = ref<'input' | 'routing' | 'models' | 'decision' | 'history'>('input');
const appMode = ref<OperationMode>(getMode());
const pendingTimers: ReturnType<typeof setTimeout>[] = [];
/** 后端模型配置（脱敏），供页签展示端点与阈值 */
const backendConfig = ref<PublicConfig | null>(null);

/** StageView exposes the 3D routing animation controls */
const stageRef = ref<{
  submitAndAnimate: (speed?: number) => void;
  resetAnimation: () => void;
} | null>(null);

/** Animation timeline (8.3s) vs. mock event stream — keep them roughly in step */
const MOCK_ANIM_SPEED = 2;

onMounted(async () => {
  // Auto-detect mode on startup
  try {
    const resp = await healthCheck();
    appMode.value = resp.status === 'ok' ? 'cloud' : 'offline';
    store.dispatch({ type: 'SET_CONNECTED', connected: resp.status === 'ok' });
  } catch {
    appMode.value = 'offline';
    store.dispatch({ type: 'SET_CONNECTED', connected: false });
  }
  if (appMode.value === 'cloud') {
    fetchConfig()
      .then((cfg) => {
        backendConfig.value = cfg;
      })
      .catch(() => {
        /* 配置拉取失败不阻塞主流程 */
      });
  }
});

onUnmounted(() => {
  // Clean up any pending timers
  for (const t of pendingTimers) clearTimeout(t);
  pendingTimers.length = 0;
});

/** Active EventSource so we can close it on reset */
let activeES: EventSource | null = null;

function clearPendingTimers() {
  for (const t of pendingTimers) clearTimeout(t);
  pendingTimers.length = 0;
}

function submitPrompt({ text, allowedModelIds }: { text: string; allowedModelIds?: string[] }) {
  store.dispatch({ type: 'RESET_ROUTE' });
  clearPendingTimers();

  // Close any previous SSE connection
  if (activeES) {
    activeES.close();
    activeES = null;
  }

  // 在线走真实后端编排；离线/失败回落本地 mock 演示
  if (appMode.value === 'cloud') {
    void runRealRoute(text, allowedModelIds);
  } else {
    runMockScenario(pickScenario(text));
  }
}

/** Pick a mock scenario based on prompt content */
function pickScenario(text: string): MockScenario {
  if (text.includes('处理') || text.includes('那个') || text.length < 15) {
    return ALL_SCENARIOS[2]; // ESCALATE
  }
  if (text.includes('分析') || text.includes('数据') || text.includes('趋势')) {
    return ALL_SCENARIOS[1]; // GATE
  }
  return ALL_SCENARIOS[0]; // ROUTE (default)
}

/** Run a rich mock scenario with timed events and streaming text */
function runMockScenario(scenario: MockScenario) {
  const sequence = buildMockEventSequence(scenario);
  const streamingChunks = buildStreamingChunks(scenario.streamingText);

  // Kick off the 3D routing animation (node highlight + edge flow + packet)
  stageRef.value?.submitAndAnimate(MOCK_ANIM_SPEED);

  let accDelay = 0;

  // Dispatch events with realistic timing
  for (const { delayMs, event } of sequence) {
    accDelay += delayMs;
    const timer = setTimeout(() => {
      store.dispatch({ type: 'ROUTE_EVENT', event });
    }, accDelay);
    pendingTimers.push(timer);
  }

  // Start streaming text after MODEL_STREAMING event (5th event, index 7 in sequence)
  const streamingStartDelay = accDelay - scenario.eventDelayMs * 3;
  let chunkAccDelay = streamingStartDelay;
  for (const { delayMs: chunkDelay, chunk } of streamingChunks) {
    chunkAccDelay += chunkDelay;
    const timer = setTimeout(() => {
      store.dispatch({ type: 'APPEND_RESULT_CHUNK', chunk });
    }, chunkAccDelay);
    pendingTimers.push(timer);
  }

  // After all streaming chunks, ensure streaming is stopped
  const streamingEndDelay = chunkAccDelay + 100;
  const endStreamingTimer = setTimeout(() => {
    store.dispatch({ type: 'SET_RESULT_TEXT', text: scenario.streamingText });
  }, streamingEndDelay);
  pendingTimers.push(endStreamingTimer);

  // After EXPERIENCE_SAVED, set decision source and stay on input tab (result is now embedded)
  const completionDelay = Math.max(accDelay + scenario.eventDelayMs, streamingEndDelay + 50);
  const timer = setTimeout(() => {
    const source = scenario.tier === 'ESCALATE' ? 'LOCAL_REIMPL' : 'TYPE_SAFE_JEV';
    store.dispatch({ type: 'SET_DECISION_SOURCE', source });
    activeTab.value = 'input';
  }, completionDelay);
  pendingTimers.push(timer);
}

/** Reset to initial state */
function resetDemo() {
  store.dispatch({ type: 'RESET_ROUTE' });
  clearPendingTimers();
  stageRef.value?.resetAnimation();
  if (activeES) {
    activeES.close();
    activeES = null;
  }
  activeTab.value = 'input';
  // Clear editor
  const editor = document.getElementById('editor');
  if (editor) {
    editor.innerText = '';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/**
 * 真实路由：调用后端编排器并通过 SSE 接收事件流。
 *
 * 事件流由后端驱动（ROUTE_CREATED → … → EXPERIENCE_SAVED），前端只做
 * dispatch 与展示；收到终态事件后自动切到「结果」页签并刷新配置快照。
 */
async function runRealRoute(text: string, allowedModelIds?: string[]) {
  try {
    // 3D 动画与事件流并行启动：动画负责视觉，事件负责状态（ARCH-3 单一 rAF）
    stageRef.value?.submitAndAnimate(1.5);

    const { requestId } = await createRoute({
      prompt: text,
      modalities: ['text'],
      ...(allowedModelIds?.length ? { constraints: { allowedModelIds } } : {}),
    });

    activeES = subscribeEvents(
      requestId,
      (event) => {
        store.dispatch({ type: 'ROUTE_EVENT', event });

        if (event.type === 'JEV_FALLBACK') {
          store.dispatch({ type: 'SET_DECISION_SOURCE', source: 'LOCAL_REIMPL' });
        }
        if (event.type === 'JEV_DECISION_READY') {
          const source = event.payload.decisionSource as string | undefined;
          if (source === 'RULE_FALLBACK' || source === 'LOCAL_REIMPL') {
            store.dispatch({ type: 'SET_DECISION_SOURCE', source: 'LOCAL_REIMPL' });
          } else {
            store.dispatch({ type: 'SET_DECISION_SOURCE', source: 'TYPE_SAFE_JEV' });
          }
        }
        if (event.type === 'ROUTE_ESCALATED') {
          // ESCALATE 不再阻断流程，改为转兜底模型（免费模型）继续执行
          // 后续 MODEL_SELECTED / MODEL_CALL_STARTED / MODEL_STREAMING 会正常推送
        }
        if (event.type === 'EXPERIENCE_SAVED') {
          activeTab.value = 'input';
          activeES?.close();
          activeES = null;
        }
        if (event.type === 'ROUTE_FAILED') {
          activeTab.value = 'input';
          activeES?.close();
          activeES = null;
        }
      },
      (err) => {
        store.dispatch({ type: 'SET_ERROR', message: err.message });
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : '创建路由失败';
    store.dispatch({ type: 'SET_ERROR', message });
    // 创建路由失败 → 回落离线 mock，保持界面可用
    appMode.value = 'offline';
    runMockScenario(pickScenario(text));
  }
}
</script>

<template>
  <main id="app" role="main" aria-label="JevRouter 主界面">
    <StageView ref="stageRef" :store="store" />

    <PanelView
      :store="store"
      :active-tab="activeTab"
      @update:active-tab="activeTab = $event"
      @submit="submitPrompt"
    />

    <!-- Reset button when a scenario has completed -->
    <button
      v-if="store.state.resultText"
      class="reset-btn"
      title="重置演示"
      aria-label="重置演示"
      @click="resetDemo"
    >⟳ 重置</button>

    <div aria-live="polite" class="sr-only">{{ store.state.resultText }}</div>
  </main>
</template>

<style scoped>
.reset-btn {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 900;
  padding: 8px 20px;
  border-radius: 20px;
  border: 1px solid var(--bd, #21262d);
  background: var(--bg2, #0d1117);
  color: var(--tx, #e6edf3);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}
.reset-btn:hover {
  border-color: var(--acc1, #4ea1ff);
  background: rgba(78, 161, 255, 0.1);
}
</style>
