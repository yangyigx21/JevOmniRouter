/**
 * 服务进程入口。
 *
 * 与 `server.ts` 分离：`server.ts` 只导出 `createServer`（纯工厂，无 import 副作用），
 * 任何 import 该包的调用方（测试、单测、复用）都不会意外启动监听。
 *
 * 启动流程：
 * 1. 加载 `config/models.json`（可用 `JEV_CONFIG` 指定路径）
 * 2. 组装四大存储 + Jev / LLM 适配器 + 路由编排器
 * 3. 启动 HTTP 服务（SSE 事件流）
 */
import { createAppServices, createServer } from './server.js';
import { ConfigError } from './app-config.js';

const port = Number(process.env.PORT) || 3000;
const configPath = process.env.JEV_CONFIG;

async function main(): Promise<void> {
  const services = await createAppServices(configPath);
  await createServer(services, port);
  const { config, modelInfoStore, decisionStore, modelSync } = services;
  const info = modelInfoStore.snapshot();
  console.log('✓ JevRouter API server ready at http://localhost:%d', port);
  console.log('  · 配置版本   : %s', config.configVersion);
  console.log('  · Jev 端点   : %s', config.jev.baseUrl);
  console.log('  · LLM 模型库 : %s (清单来源: %s, %d 个模型)', config.llmLibrary.baseUrl, info.source, info.models.length);
  console.log('  · 决策信息库 : 已有 %d 条决策, 阈值 %s (来源 %s)', decisionStore.snapshot().totals.decisions, JSON.stringify(decisionStore.thresholds()), decisionStore.snapshot().thresholdSource);
  const sync = decisionStore.snapshot().industrySync;
  console.log(
    '  · 行业评分   : %s',
    sync
      ? `已同步 ${sync.matched} 条（来源 ${sync.sourceLabel}，${sync.syncedAt}）`
      : '尚未同步',
  );
  console.log(
    '  · 每日同步   : %s',
    modelSync
      ? `每日 ${config.modelScoring.dailySyncAt}（下次 ${modelSync.nextAt()?.toLocaleString('zh-CN', { hour12: false }) ?? '--'}）`
      : '已关闭（modelScoring.enabled=false）',
  );
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error('✗ 模型配置加载失败 [%s]: %s', err.code, err.message);
    console.error('  请检查 packages/backend/config/models.json，或用环境变量 JEV_API_KEY / LLM_API_KEY 覆盖。');
  } else {
    console.error('✗ 服务启动失败:', err);
  }
  process.exit(1);
});
