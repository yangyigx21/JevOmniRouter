import { createApp } from 'vue';
import App from './App.vue';
import './styles/tokens.css';
import { StartupMonitor } from './perf/performance-monitor.js';

const startup = new StartupMonitor();
startup.markStart();

const app = createApp(App);
app.mount('#app');

startup.markFCP();

requestAnimationFrame(() => {
  startup.markReady();
  if (import.meta.env.DEV) {
    console.log('[perf] Startup report:', startup.getReport());
  }
});
