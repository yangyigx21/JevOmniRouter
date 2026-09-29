<script setup lang="ts">
import { ref } from 'vue';
import type { Store } from '../store/createStore.js';
import type { RouteState } from '../store/routeEventReducer.js';
import InputTab from './tabs/InputTab.vue';
import ModelsTab from './tabs/ModelsTab.vue';
import ResultTab from './tabs/ResultTab.vue';
import DecisionTab from './tabs/DecisionTab.vue';
import HistoryTab from './tabs/HistoryTab.vue';
import RoutingTab from './tabs/RoutingTab.vue';

const props = defineProps<{
  store: Store<RouteState, any>;
  activeTab: 'input' | 'routing' | 'models' | 'decision' | 'history';
}>();

const emit = defineEmits<{
  'update:activeTab': [tab: 'input' | 'routing' | 'models' | 'decision' | 'history'];
  submit: [payload: { text: string; allowedModelIds?: string[] }];
}>();

/** 「历史」页签徽标上的记录数（由 HistoryTab 拉取后回传）。 */
const historyCount = ref(0);

const tabs = [
  { id: 'input' as const, label: 'Prompt输入' },
  { id: 'routing' as const, label: '智能路由' },
  { id: 'models' as const, label: '模型能力' },
  { id: 'decision' as const, label: '决策经验库' },
  { id: 'history' as const, label: '历史记录' },
];

function onTabKeydown(e: KeyboardEvent) {
  const activeIdx = tabs.findIndex(t => t.id === props.activeTab);
  let nextIdx = -1;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault();
    nextIdx = (activeIdx + 1) % tabs.length;
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault();
    nextIdx = (activeIdx - 1 + tabs.length) % tabs.length;
  } else if (e.key === 'Home') {
    e.preventDefault();
    nextIdx = 0;
  } else if (e.key === 'End') {
    e.preventDefault();
    nextIdx = tabs.length - 1;
  }
  if (nextIdx >= 0) {
    emit('update:activeTab', tabs[nextIdx].id);
    const el = document.getElementById(`tab-${tabs[nextIdx].id}`);
    el?.focus();
  }
}
</script>

<template>
  <aside id="panel" aria-label="交互输入区">
    <div class="p-head">
      <div class="tabs" role="tablist" aria-label="面板页签" @keydown="onTabKeydown">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          :id="`tab-${tab.id}`"
          class="tab"
          :class="{ act: activeTab === tab.id }"
          role="tab"
          :aria-selected="activeTab === tab.id"
          :aria-controls="`panel-${tab.id}`"
          :tabindex="activeTab === tab.id ? 0 : -1"
          @click="emit('update:activeTab', tab.id)"
        >
          {{ tab.label }}
          <span v-if="tab.id === 'history'" class="cnt">{{ historyCount }}</span>
        </button>
      </div>
    </div>
    <div class="p-body">
      <div class="tabview" :class="{ act: activeTab === 'input' }" role="tabpanel" id="panel-input" aria-labelledby="tab-input" tabindex="0">
        <InputTab :store="store" @submit="emit('submit', $event)" />
        <ResultTab :store="store" />
      </div>
      <div class="tabview" :class="{ act: activeTab === 'routing' }" role="tabpanel" id="panel-routing" aria-labelledby="tab-routing" tabindex="0">
        <RoutingTab :store="store" />
      </div>
      <div class="tabview" :class="{ act: activeTab === 'models' }" role="tabpanel" id="panel-models" aria-labelledby="tab-models" tabindex="0">
        <ModelsTab :store="store" />
      </div>
      <div class="tabview" :class="{ act: activeTab === 'decision' }" role="tabpanel" id="panel-decision" aria-labelledby="tab-decision" tabindex="0">
        <DecisionTab />
      </div>
      <div class="tabview" :class="{ act: activeTab === 'history' }" role="tabpanel" id="panel-history" aria-labelledby="tab-history" tabindex="0">
        <HistoryTab :active="activeTab === 'history'" @update:count="historyCount = $event" />
      </div>
    </div>
  </aside>
</template>
