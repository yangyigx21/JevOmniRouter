/**
 * HTTP server layer — wires route-api contract handlers to Express routes.
 * API-1~API-3, EVENT-3 (SSE), B4 (health)
 *
 * 本轮新增（LLM-sdd.md）：
 * - 启动时加载 `config/models.json`，构建四大存储 + Jev/LLM 适配器 + 编排器
 * - `POST /v1/routes` 触发真实路由编排（全链路异步推进）
 * - 新增 `/v1/config`、`/v1/decision-store`、`/v1/models`、`/v1/history*` 端点
 * - SSE 重连补偿改为共享 EventBus 缓冲（修 EVENT-3 失效问题）
 */
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { join } from 'node:path';

const { json } = bodyParser;
import {
  createRoute,
  getRouteStatus,
  healthCheck,
  RouteApiError,
  RouteRegistry,
  type CreateRouteRequest,
} from './route-api.js';
import { createSSEStream, parseLastEventId, type SSESink, type SSEStream } from './sse-stream.js';
import { EventBus, type RouteEvent } from './route-event.js';
import { loadConfig, resolveDataDir, toPublicConfig, ConfigError, type AppConfig } from './app-config.js';
import { DecisionStore } from './decision-store.js';
import { ModelInfoStore, groupByVendor } from './model-info-store.js';
import { HistoryStore, hourBucketOf } from './history-store.js';
import { SystemOneJevAdapter } from './jev-http-adapter.js';
import { LlmLibraryProviderAdapter } from './llm-provider-adapter.js';
import { ModelGateway } from './model-gateway.js';
import { RouteOrchestrator } from './route-orchestrator.js';
import { MVP_SEED_CATALOG } from './model-catalog.js';
import { runModelSync, scheduleDailyModelSync, type DailySyncHandle } from './daily-model-sync.js';

/** 服务运行时依赖（由 `createAppServices` 组装）。 */
export interface AppServices {
  config: AppConfig;
  registry: RouteRegistry;
  eventBus: EventBus;
  decisionStore: DecisionStore;
  modelInfoStore: ModelInfoStore;
  historyStore: HistoryStore;
  gateway: ModelGateway;
  orchestrator: RouteOrchestrator;
  /** 每日凌晨模型清单/评分同步任务句柄（`modelScoring.enabled=false` 时为 null）。 */
  modelSync: DailySyncHandle | null;
}

/**
 * 组装运行时服务：加载配置 → 构建存储 → 拉取模型清单 → 装配适配器与编排器。
 *
 * 模型清单与评分生命周期：
 * - 启动时拉取一次实时清单（失败自动回落配置/种子），保证打开页面即为最新清单
 * - `/v1/models` 按 `modelScoring.catalogRefreshTtlMs` 做 TTL 兜底重拉
 * - `modelScoring.enabled` 时注册每日凌晨同步（重拉清单 + 写入业界评分）
 */
export async function createAppServices(
  configPath?: string,
): Promise<AppServices> {
  const config = loadConfig(configPath);
  const dataDir = resolveDataDir(config);

  const decisionStore = new DecisionStore({
    filePath: join(dataDir, config.storage.decisionStoreFile),
    baseThresholds: config.routing.thresholds,
  });
  const modelInfoStore = new ModelInfoStore({
    filePath: join(dataDir, config.storage.modelInfoFile),
    llm: config.llmLibrary,
    catalogTimeoutMs: config.modelScoring.catalogFetchTimeoutMs,
  });
  const historyStore = new HistoryStore({
    dir: join(dataDir, config.storage.historyDir),
  });

  // 启动即拉取实时模型清单（失败回落配置/种子，不阻塞启动）。
  await modelInfoStore.ensureCatalog(decisionStore.snapshot(), true);
  const catalog = modelInfoStore.versionedCatalog();
  const registry = new RouteRegistry(
    catalog.entries.length > 0 ? catalog : MVP_SEED_CATALOG,
  );
  const eventBus = new EventBus();

  // 单次调用超时 = 目录 p95 × 2；模型信息库按 `llmLibrary.timeoutMs / 2`
  // 写入 p95，故实际超时与配置的 LLM 请求超时一致。
  const gateway = new ModelGateway();
  gateway.registerAdapter(new LlmLibraryProviderAdapter({ config: config.llmLibrary }));
  const jevAdapter = new SystemOneJevAdapter({ config: config.jev });

  const orchestrator = new RouteOrchestrator({
    config,
    registry,
    eventBus,
    decisionStore,
    modelInfoStore,
    historyStore,
    gateway,
    jevAdapter,
  });

  // 每日凌晨同步：重拉清单 + 写入业界评分（可配置关闭）。
  const modelSync = config.modelScoring.enabled
    ? scheduleDailyModelSync({ config, modelInfoStore, decisionStore })
    : null;

  // 启动时立即执行一次同步（异步、不阻塞服务就绪），让首次打开页面就能看到
  // 业界评分 + fallback 评分，不必等到凌晨定时任务。
  if (config.modelScoring.enabled) {
    void runModelSync({ config, modelInfoStore, decisionStore }).catch(() => undefined);
  }

  return {
    config,
    registry,
    eventBus,
    decisionStore,
    modelInfoStore,
    historyStore,
    gateway,
    orchestrator,
    modelSync,
  };
}

/**
 * Create and start the JevRouter HTTP API server.
 *
 * @param services - 由 `createAppServices` 组装的运行时依赖
 * @param port     - TCP port (default 3000)
 * @returns Promise that resolves once the server is listening
 */
export function createServer(services: AppServices, port = 3000) {
  const { config, registry, eventBus, decisionStore, modelInfoStore, historyStore, orchestrator } =
    services;
  const app = express();
  app.use(cors());
  app.use(json({ limit: '2mb' }));

  // Central error handler for RouteApiError
  function handleApiError(err: unknown, res: express.Response): void {
    if (err instanceof RouteApiError) {
      const status = err.code === 'ROUTE_NOT_FOUND' ? 404 : 400;
      res.status(status).json({ error: err.code, message: err.message });
    } else {
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Unexpected server error' });
    }
  }

  // ── Health check (B4) ──────────────────────────────────────────────────
  app.get('/v1/health', (_req, res) => {
    res.json({
      ...healthCheck(),
      configVersion: config.configVersion,
      jevConfigured: config.jev.apiKey !== '',
      llmLibrary: config.llmLibrary.baseUrl,
      catalogVersion: modelInfoStore.versionedCatalog().catalogVersion,
      modelCount: modelInfoStore.catalogEntries().length,
      decisions: decisionStore.snapshot().totals.decisions,
    });
  });

  // ── 模型配置（脱敏，C3）────────────────────────────────────────────────
  app.get('/v1/config', (_req, res) => {
    res.json(toPublicConfig(config));
  });

  // ── 决策信息库 ─────────────────────────────────────────────────────────
  app.get('/v1/decision-store', (_req, res) => {
    res.json(decisionStore.snapshot());
  });

  // ── 模型信息库（含决策区分度评分）──────────────────────────────────────
  // 前端每次打开页面都会命中这里：按 TTL 兜底重拉实时清单，保证清单不过期。
  app.get('/v1/models', async (_req, res) => {
    try {
      const snapshot = await modelInfoStore.ensureFresh(
        decisionStore.snapshot(),
        config.modelScoring.catalogRefreshTtlMs,
      );
      res.json({ ...snapshot, vendors: groupByVendor(snapshot.models) });
    } catch (err) {
      handleApiError(err, res);
    }
  });

  // 按厂商聚合的模型分组 —— 前端 3D 星球节点数据源
  app.get('/v1/models/vendors', async (_req, res) => {
    try {
      const snapshot = await modelInfoStore.ensureFresh(
        decisionStore.snapshot(),
        config.modelScoring.catalogRefreshTtlMs,
      );
      res.json({
        catalogVersion: modelInfoStore.versionedCatalog().catalogVersion,
        source: snapshot.source,
        vendors: groupByVendor(snapshot.models),
      });
    } catch (err) {
      handleApiError(err, res);
    }
  });

  app.post('/v1/models/refresh', async (_req, res) => {
    try {
      const snapshot = await modelInfoStore.ensureCatalog(decisionStore.snapshot(), true);
      res.json({ ...snapshot, vendors: groupByVendor(snapshot.models) });
    } catch (err) {
      res.status(502).json({
        error: 'MODELS_REFRESH_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── 历史库（按小时拆分）────────────────────────────────────────────────
  app.get('/v1/history', (req, res) => {
    const limitRaw = req.query.limit;
    const limit = typeof limitRaw === 'string' ? Number(limitRaw) : undefined;
    const hour = typeof req.query.hour === 'string' ? req.query.hour : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    res.json(historyStore.query({ limit, hour, search }));
  });

  app.get('/v1/history/stats', (_req, res) => {
    res.json({ ...historyStore.stats(), currentHour: hourBucketOf() });
  });

  // ── Route lifecycle (API-1) ────────────────────────────────────────────
  app.post('/v1/routes', (req, res) => {
    try {
      const body = req.body as CreateRouteRequest;
      const result = createRoute(registry, eventBus, body);
      // 触发真实路由编排（异步推进，事件经 SSE 推送）。
      const preference = mapPreference(body.consequenceClass);
      void orchestrator
        .run({
          requestId: result.requestId,
          prompt: body.prompt,
          preference,
          allowedModelIds: body.constraints?.allowedModelIds,
          maxLatencyMs: body.constraints?.maxLatencyMs,
          budgetUsd: body.constraints?.budgetUsd,
        })
        .catch((err: unknown) => {
          eventBus.emit({
            requestId: result.requestId,
            type: 'ROUTE_FAILED',
            payload: {
              reason: 'unknown',
              message: err instanceof Error ? err.message : String(err),
            },
          });
        });
      res.status(201).json(result);
    } catch (err) {
      handleApiError(err, res);
    }
  });

  app.get('/v1/routes/:id/status', (req, res) => {
    try {
      const result = getRouteStatus(registry, req.params.id);
      res.json(result);
    } catch (err) {
      handleApiError(err, res);
    }
  });

  // ── SSE event stream (API-2 / EVENT-3) ─────────────────────────────────
  app.get('/v1/routes/:id/events', (req, res) => {
    const requestId = req.params.id;
    const rawLastEventId = req.headers['last-event-id'] as string | undefined;
    // 无 `Last-Event-ID` = 全新订阅者（浏览器 EventSource 首次连接即如此）。
    // POST /v1/routes 响应回来之前，编排器可能已推送完前若干条事件
    // （ROUTE_CREATED / EXPERIENCE_RETRIEVED / JEV_CALL_STARTED …），
    // 短 prompt 甚至可能整条链路已跑完。首连必须从 sequence 0 全量补齐，
    // 否则前端拿不到 MODEL_STREAMING 增量 → 「结果」区空白。
    const hasCursor = typeof rawLastEventId === 'string' && rawLastEventId.trim() !== '';
    // 带游标重连时把 `id:` 里的 eventId 解析回 sequence，避免重复补发。
    const lastSequence = hasCursor
      ? parseLastEventId(rawLastEventId, (eventId) =>
          eventBus.getEvents(requestId).find((e) => e.eventId === eventId)?.sequence,
        )
      : -1;

    // Set SSE response headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sink: SSESink = {
      write(chunk: string): void {
        res.write(chunk);
      },
      close(): void {
        res.end();
      },
    };

    const stream: SSEStream = createSSEStream(sink, requestId);

    // EVENT-3 重连补偿：首连补全量（-1），重连补 sequence > lastSequence。
    // 循环体内无 await，Node 单线程下不会与 emit 交错，写入顺序即 sequence 升序。
    for (const missed of eventBus.replaySince(requestId, lastSequence)) {
      void stream.send(missed);
    }

    // Subscribe to the EventBus for live events matching this requestId
    const subscription = eventBus.subscribe((event: RouteEvent) => {
      if (event.requestId === requestId && !stream.isClosed()) {
        void stream.send(event);
      }
    });

    // Heartbeat timer
    const heartbeatTimer = setInterval(() => {
      if (!stream.isClosed()) {
        void stream.heartbeat();
      }
    }, 15_000);

    // Clean up on client disconnect
    req.on('close', () => {
      clearInterval(heartbeatTimer);
      eventBus.unsubscribe(subscription);
      if (!stream.isClosed()) {
        void stream.close();
      }
    });
  });

  // ── Catalog (API-3) ────────────────────────────────────────────────────
  app.get('/v1/catalog', (_req, res) => {
    const catalog = modelInfoStore.versionedCatalog();
    res.json({ catalogVersion: catalog.catalogVersion, entries: catalog.entries });
  });

  return new Promise<void>((resolve) => {
    app.listen(port, () => {
      console.log(`JevRouter API server listening on port ${port}`);
      resolve();
    });
  });
}

/** 后果等级 → 路由偏好（JEV-9 / JEV-15 的简化映射）。 */
function mapPreference(
  consequenceClass: string | undefined,
): 'economy' | 'balanced' | 'quality' | undefined {
  if (consequenceClass === 'high' || consequenceClass === 'irreversible') return 'quality';
  if (consequenceClass === 'low') return 'economy';
  return undefined;
}

export { ConfigError };
