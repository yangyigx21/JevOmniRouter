import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

// pnpm 严格依赖隔离：根目录无法解析前端包的 vue，需显式指向 packages/frontend。
const frontendModules = fileURLToPath(new URL('./packages/frontend/node_modules/', import.meta.url));

export default defineConfig({
  // 组件测试需要 .vue 单文件组件编译（纯逻辑测试不受影响）。
  plugins: [vue()],
  resolve: {
    alias: [{ find: /^vue$/, replacement: `${frontendModules}vue/index.mjs` }],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    exclude: [
      'packages/backend/src/__tests__/closed-loop-verification.test.ts',
      'packages/backend/src/__tests__/e2e-integration.test.ts',
    ],
  },
});
