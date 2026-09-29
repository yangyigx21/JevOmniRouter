/**
 * Offline entry point — ARCHIVE-4 (T-6.11).
 *
 * Self-contained HTML mode: no backend, Jev uses LocalJevReimpl,
 * experience state falls to localStorage, human review is single-endpoint.
 *
 * This module is imported only when building the offline variant.
 * The cloud entry point (main.ts) is unaffected.
 */
import { createApp } from 'vue';
import App from './App.vue';
import './styles/tokens.css';

// Force offline mode at startup
import { setMode } from './offline/OfflineAdapter.js';
setMode('offline');

const app = createApp(App);

// Provide a global property so components can check mode
app.config.globalProperties.$offlineMode = true;

app.mount('#app');

// Log deviation declaration (JEV-10)
console.warn(
  '[JEV Router — 离线形态] 本地确定性重实现已启用。\n' +
  '偏差声明:\n' +
  '  F1: 决策来源 → LocalJevReimpl (非 TypeSafe Jev API)\n' +
  '  F2: Provider 标签 → LOCAL_REIMPL (非 system-one)\n' +
  '  F3: Schema 校验 → 前端简化校验\n' +
  '  F4: 延迟 → 本地计算 <5ms (非网络延迟)\n' +
  '  F5: 人工审批 → 单端审批 + 显式标注「本地审批」\n' +
  '  F6: 经验状态 → localStorage (非服务端 Experience Store)\n' +
  '结果区将标注「本地重实现」来源。'
);
