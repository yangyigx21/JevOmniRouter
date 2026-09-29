# JevRouter

**TypeSafe Jev 驱动多模型智能路由**

JevRouter 是一个基于 TypeSafe Jev（Justifiable Evidence Vector）决策范式的多模型智能路由系统。通过结构化五问提取、自适应校准评分和经验闭环反馈，实现可解释、可审计的模型选型决策。

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    Decision Runtime 主链                     │
│                                                             │
│  STATE → CHOICE/SCORE/NOUL → JEV → PROBABILITY → ROUTE     │
│                                      │            GATE      │
│                                      └─────────── ESCALATE  │
├─────────────┬───────────────┬───────────────────────────────┤
│   shared    │    backend    │          frontend              │
│  (纯逻辑层)  │  (服务端核心)  │   (Vue 3 + Three.js 可视化)   │
│  零副作用    │  Express API  │   云形态 + 离线单文件形态       │
│  双形态共用  │  SSE 事件流   │   ARCH-2 双架构               │
└─────────────┴───────────────┴───────────────────────────────┘
```

### 三层权责模型

| 层 | 职责 | 对应模块 |
|---|---|---|
| **GENERATE** | LLM 生成内容 | ModelGateway + Provider Adapter |
| **DECIDE** | Jev 做出路由决策 | DecisionRuntime + JevAdapter + ConstraintSelector |
| **ENFORCE** | 代码执行与约束 | 8步硬约束流水线 + ConsequenceThresholds |

### 双形态架构 (ARCH-2)

- **云形态**：前端通过 `POST /v1/routes` + SSE 实时消费后端事件流
- **离线形态**：`OfflineAdapter` 在浏览器本地重实现 Jev 决策（JEV-8/JEV-10），含显式偏差声明

## Monorepo 结构

```
packages/
├── shared/          # @jev-router/shared — 纯逻辑层（零副作用，双形态共用）
│   └── src/
│       ├── calibrate.ts          # 校准曲线 (SCORE-1)
│       ├── scoreModels.ts        # 自适应温度 softmax 评分 (SCORE-2/3)
│       ├── tieBreak.ts           # 同分决胜 (SCORE-4)
│       ├── priorDeltaFor.ts      # 经验先验修正 (EXP-1/2)
│       ├── calibrationStats.ts   # ECE 校准统计 (EXP-4)
│       ├── computeRun.ts         # 7阶段确定性时间线 (ANIM-1)
│       ├── extractFeatures.ts    # 特征提取 (INGEST)
│       ├── routeTier.ts          # ROUTE/GATE/ESCALATE 分级 (JEV-5)
│       ├── geometry.ts           # 3D 树几何 (TREE-1~5)
│       ├── constants.ts          # 集中常量 (ARCH-5)
│       └── types.ts              # 共享类型定义
│
├── backend/         # @jev-router/backend — 服务端核心
│   └── src/
│       ├── decision-runtime.ts   # 主链执行 (JEV-1~16)
│       ├── jev-adapter.ts        # TypeSafe Jev 五问适配器 (JEV-1/2/3/9)
│       ├── constraint-selector.ts # 8步硬约束流水线 (CONSTRAIN-1~5)
│       ├── model-gateway.ts      # 多模型网关 (MODEL-1~4)
│       ├── state-engineering.ts  # 6段状态工程 (JEV-14)
│       ├── consequence-thresholds.ts # 后果分级阈值 (JEV-15)
│       ├── decision-contract.ts  # 决策契约 (JEV-12)
│       ├── decision-receipt.ts   # 决策凭据 (JEV-16)
│       ├── primitive-guards.ts   # 三原语语义守卫 (JEV-13)
│       ├── experience-store.ts   # 异步写入经验存储 (EXP-1)
│       ├── experience-reflow.ts  # 经验回流注入 (EXP-2)
│       ├── experience-validator.ts # 前后段验证 (EXP-4)
│       ├── experience-version.ts # 单调递增版本 (EXP-7)
│       ├── experience-rollback.ts # 原子回滚 (EXP-8)
│       ├── experience-replay.ts  # 钉版本重放 (EXP-6)
│       ├── cold-start-guard.ts   # 冷启动保护 (EXP-9)
│       ├── threshold-suggestion.ts # 阈值扫描建议 (EXP-3)
│       ├── human-review.ts       # 人工审批回写 (EXP-10)
│       ├── archive-persistence.ts # 版本化键归档 (ARCHIVE-1~5)
│       ├── route-event.ts        # 14种路由事件 (EVENT-1)
│       ├── event-dedup.ts        # LRU 去重 (EVENT-2)
│       ├── sse-stream.ts         # SSE 事件流 (EVENT-3)
│       ├── trace-aggregator.ts   # 三段追踪链 (EVENT-4)
│       ├── selection-mode.ts     # 选型归属 (EVENT-5)
│       ├── route-api.ts          # API 合约层 (API-1~3, B4)
│       ├── server.ts             # Express HTTP 服务器（12 个端点）
│       ├── tenant-governance.ts  # 租户隔离与审计 (A11Y-3)
│       ├── key-security.ts       # 密钥安全 (C3)
│       ├── local-jev-reimpl.ts   # 本地 Jev 重实现 (JEV-8/10)
│       └── __tests__/            # 测试套件
│
├── mcp-server/      # @jev-router/mcp-server — MCP 协议适配层（无前端）
│   └── src/
│       ├── index.ts             # stdio MCP server 入口（注册 6 个 tool）
│       ├── config.ts            # JEV_BACKEND_URL / JEV_MCP_TIMEOUT_MS
│       ├── backend-client.ts    # 后端 HTTP 封装 + SSE 聚合到终态
│       ├── tools/
│       │   ├── route-decide.ts       # jev_route_decide
│       │   ├── model-catalog.ts      # jev_model_catalog
│       │   ├── constraints-audit.ts  # jev_constraints_audit
│       │   ├── score-explain.ts      # jev_score_explain
│       │   ├── experience-stats.ts   # jev_experience_stats
│       │   └── history-query.ts      # jev_history_query
│       └── __tests__/           # SSE 解析 + tool 测试
│
└── frontend/        # @jev-router/frontend — Vue 3 可视化前端
    └── src/
        ├── App.vue                # 根组件 (离线模式检测)
        ├── main.ts                # 云形态入口
        ├── main-offline.ts        # 离线形态入口
        ├── api/client.ts          # 后端 API 客户端 (SSE)
        ├── store/                 # Redux-pattern 状态管理
        │   ├── createStore.ts     # ARCH-1/3 响应式 store
        │   ├── routeEventReducer.ts # ANIM-6 事件驱动 reducer
        │   └── types.ts           # 路由事件类型 (14种)
        ├── components/
        │   ├── StageView.vue      # 3D 路由树可视化 (TREE-1~5)
        │   ├── PanelView.vue      # 右侧面板 (标签页)
        │   └── tabs/              # InputTab / RoutingTab / ModelsTab / ResultTab / DecisionTab / HistoryTab
        ├── three/
        │   ├── TreeScene.ts       # 二叉分支树图布局
        │   ├── computeRunFrontend.ts # 7阶段动画 + ANIM-3 档位配色
        │   └── AnimationController.ts # 暂停/倍速/中断重路由 (ANIM-5)
        ├── offline/
        │   └── OfflineAdapter.ts  # 离线适配 + JEV-10 偏差声明
        ├── perf/
        │   └── performance-monitor.ts # PERF-1/2/3 性能监控
        └── styles/
            └── tokens.css         # 像素级设计令牌
```

## 快速开始

### 前置要求

- Node.js >= 20.0.0
- pnpm >= 9.0.0

### 安装

```bash
git clone <repo-url> && cd JevOmniRouter
pnpm install
```

### 构建

```bash
# 构建 shared + backend + mcp-server (TypeScript)
pnpm build

# 构建前端 (Vite)
cd packages/frontend && pnpm build

# 构建离线形态
cd packages/frontend && pnpm build:offline
```

### 开发

```bash
# 后端开发服务器
cd packages/backend && pnpm dev

# 前端开发服务器 (热重载)
cd packages/frontend && pnpm dev

# MCP server (stdio，需后端在线)
pnpm --filter @jev-router/mcp-server dev
```

### MCP Server（无前端形态）

`packages/mcp-server` 把路由引擎以 MCP 协议暴露给 AI 客户端，**不需要前端页面**。它是纯协议适配层：所有决策逻辑、模型目录与模型执行都留在后端进程，MCP server 只做 HTTP/SSE 收发。

构建并注册（项目根 `.mcp.json` 已配置）：

```bash
pnpm --filter @jev-router/mcp-server build
```

```json
{
  "mcpServers": {
    "jev-router": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"],
      "env": { "JEV_BACKEND_URL": "http://127.0.0.1:3000" }
    }
  }
}
```

**6 个 Tool**：

| Tool | 语义 | 是否消耗模型调用 |
|---|---|---|
| `jev_route_decide` | 提交 prompt 执行真实路由决策，返回档位/置信度/选中模型/候选分布/模型回答 | 是 |
| `jev_model_catalog` | 读取实时模型清单（画像、区分度、厂商分组），支持过滤/排序 | 否 |
| `jev_constraints_audit` | 本地跑 8 步硬约束流水线，逐模型返回每步 pass/fail 与主淘汰原因 | 否 |
| `jev_score_explain` | 解释评分链：五问画像、softmax 分布、先验 Δ、阈值判定；可按 requestId 免费解释既有决策 | 视入参 |
| `jev_experience_stats` | 决策经验闭环统计：动态阈值、per-model 胜率、档位分布、业界评分同步 | 否 |
| `jev_history_query` | 历史执行记录查询，支持关键词/小时桶过滤与单条完整明细 | 否 |

环境变量：

- `JEV_BACKEND_URL`：后端地址，默认 `http://127.0.0.1:3000`
- `JEV_MCP_TIMEOUT_MS`：单次路由等待终态的超时，默认 `120000`

配套 Skill（`.trae/skills/`）：`jev-route-decide`、`jev-routing-explain`、`jev-catalog-report`、`jev-experience-report`、`jev-history-inspect`。

### 类型检查

```bash
# 全量类型检查
pnpm typecheck

# 或单独检查
npx tsc --project packages/shared/tsconfig.json --noEmit
npx tsc --project packages/backend/tsconfig.json --noEmit
npx tsc --project packages/mcp-server/tsconfig.json --noEmit
npx tsc --project packages/frontend/tsconfig.json --noEmit
```

### 测试

```bash
# 运行全部测试 (vitest)
pnpm test

# 单独运行
npx vitest run packages/shared      # shared 层 (32 用例)
npx vitest run packages/backend     # backend 层
npx vitest run packages/mcp-server  # SSE 解析 + tool 用例
npx vitest run packages/frontend    # A11Y 审计
```

### 代码质量

```bash
# ESLint 检查
pnpm lint

# ESLint 自动修复
pnpm lint:fix

# Prettier 格式化
pnpm format

# Prettier 检查
pnpm format:check
```

## API 端点

后端 Express 服务器 (`packages/backend/src/server.ts`) 暴露 12 个 API 端点：

| 方法 | 路径 | 说明 | 规范 |
|---|---|---|---|
| GET | `/v1/health` | 健康检查 | B4 |
| GET | `/v1/config` | 脱敏运行时配置 | C3 |
| GET | `/v1/decision-store` | 决策信息库快照 | — |
| GET | `/v1/models` | 模型清单 + 决策区分度 | MODEL-4 |
| GET | `/v1/models/vendors` | 按厂商聚合的模型分组 | MODEL-4 |
| POST | `/v1/models/refresh` | 强制重拉实时模型清单 | MODEL-4 |
| GET | `/v1/history` | 历史执行记录（按小时分桶） | — |
| GET | `/v1/history/stats` | 历史统计 | — |
| POST | `/v1/routes` | 创建路由请求 | API-1 |
| GET | `/v1/routes/:id/status` | 查询路由状态 | API-2 |
| GET | `/v1/routes/:id/events` | SSE 事件流 | EVENT-3 |
| GET | `/v1/catalog` | 版本化模型目录 | API-3 |

## 核心概念

### Decision Runtime 主链

```
STATE → CHOICE/SCORE/NOUL → JEV → PROBABILITY → ROUTE / GATE / ESCALATE
```

1. **STATE** — 6 段状态工程组装 (JEV-14)
2. **三原语** — CHOICE 逃逸舱 / SCORE 非测量性守卫 / NOUL 不可区分 (JEV-13)
3. **JEV** — TypeSafe 五问适配器，提取结构化决策依据 (JEV-1/2/3)
4. **PROBABILITY** — 自适应温度 softmax 评分 + 经验先验修正 + 同分决胜 (SCORE-1~4)
5. **ROUTE / GATE / ESCALATE** — 后果分级阈值路由 (JEV-15)

### 8 步硬约束流水线 (CONSTRAIN-1~5)

```
白名单 → 黑名单 → PII 检测 → 长度约束 → 上下文窗口 → 成本预算 → 延迟预算 → Jev 推荐
```

### 经验闭环五段位 (EXP-1~10)

```
沉淀 → 统计 → 应用 → 可复现 → 验证回滚
```

### 14 种路由事件 (EVENT-1)

`TASK_INGESTED` → `STATE_ASSEMBLED` → `FEATURES_EXTRACTED` → `JEV_QUESTIONS_ASKED` → `JEV_DECISION_READY` → `CONSTRAINT_FILTERED` → `MODEL_CALL_STARTED` → `MODEL_SELECTED` → `CONSTRAINT_GATE_PASSED` → `MODEL_STREAMING` → `MODEL_COMPLETED` → `EXPERIENCE_SAVED` → `ROUTE_ESCALATED` → `ROUTE_FAILED`

## 离线形态 (ARCH-4 / JEV-8)

离线形态通过 `OfflineAdapter` 在浏览器本地重实现 Jev 决策，无需后端：

- **6 项偏差声明** (JEV-10)：决策来源、Provider 标签、Schema 校验、延迟、人工审批、经验状态
- **localStorage 经验存储**：版本化键 + LRU 驱逐
- **单端审批**：`本地审批` 标签替代后端审批流
- 构建入口：`index-offline.html` + `main-offline.ts`

## 技术栈

| 层 | 技术 |
|---|---|
| 语言 | TypeScript 5.x (strict mode) |
| 后端 | Node.js + Express 4 |
| 前端 | Vue 3 + Vite 5 + Three.js |
| 构建 | pnpm workspaces (monorepo) |
| 测试 | Vitest + axe-core (A11Y) |
| 代码质量 | ESLint 9 (flat config) + Prettier |
| CI | GitHub Actions (tsc + vitest + vite build) |

## 需求覆盖

86 条需求 (15 域) 覆盖状态：

| 域 | 需求数 | 完整实现 | 部分实现 |
|---|---|---|---|
| ARCH | 5 | 4 | 1 |
| INGEST | 6 | 1 | 5 |
| JEV | 16 | 14 | 2 |
| MODEL | 4 | 3 | 1 |
| CONSTRAIN | 5 | 4 | 1 |
| SCORE | 4 | 4 | 0 |
| TREE | 5 | 3 | 2 |
| ANIM | 6 | 5 | 1 |
| RESULT | 5 | 1 | 4 |
| ARCHIVE | 5 | 4 | 1 |
| EXP | 10 | 8 | 2 |
| EVENT | 4 | 4 | 0 |
| A11Y | 3 | 1 | 2 |
| PERF | 3 | 3 | 0 |
| API | 5 | 3 | 2 |

## CI

GitHub Actions 流水线 (`.github/workflows/ci.yml`)：

```
push/PR → pnpm install → tsc (×3) → vitest → vite build
```

## 许可证

UNLICENSED — 内部项目，未对外开放许可。
