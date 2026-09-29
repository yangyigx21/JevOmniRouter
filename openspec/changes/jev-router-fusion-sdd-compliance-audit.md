# JevRouter 代码工程 SDD 合规回溯审计（v2）

- **审计对象**：`D:\TREAWork\JevOmniRouter`（`packages/{shared,backend,frontend}`）
- **审计基线**：`D:\TREAWork\JevOmniRouter\openspec\changes\jev-router-fusion\`（proposal / spec / design / tasks）
- **基线规模**：spec.md **86 需求 / 126 场景**；tasks.md **91 任务 / 8 阶段 + 9 门禁**
- **审计方式**：只读回溯 + **实际执行**（类型检查、构建、测试套件实跑、缺陷最小复现）
- **审计日期**：2026-09-28
- **审计结论（一句话）**：算法层与服务端业务模块完成度高、可编译，但**「按 SDD 开发要求完成」不成立**——阶段 0/1 门禁零证据、阶段 4–8 的 `[x]` 缺乏验收支撑、**前端未复用共享纯逻辑层（ARCH-2 实质未兑现）**、**无 HTTP 承载与真实 Jev/Provider 实现**，且存在**至少 2 处已复现的真实逻辑缺陷**；三份过程文档（apply-report / review-notes / tasks.md）互相矛盾。

---

## 0. 结论速览

| 维度 | 评估 | 证据 |
| --- | --- | --- |
| 任务完成（形式） | **67 / 91 勾选**（阶段 2–8 全勾，阶段 0/1 全空） | tasks.md 复选框逐阶段统计 |
| 任务完成（实质） | **不可采信** | apply-report 声明 26 项、review-notes 声明 10 项、tasks.md 勾选 67 项，三方矛盾 |
| 需求覆盖（形式） | 86 需求均有模块落点 | 模块与需求号逐条对应（见 §3） |
| 需求覆盖（实质） | 15 域中 **6 域行为不可验收** | JEV / CONSTRAIN / EXP / EVENT / API / RESULT |
| 可编译性 | ✅ shared / backend `typecheck` + `build` 通过 | 真实执行，exit 0 |
| 可构建性（前端） | ⚠️ 未能验证 | 无 `dist/`；本次环境 pnpm junction 断裂（环境问题，非代码缺陷） |
| 可测试性 | ❌ **测试未接入任何 runner** | 无 vitest 配置、各包无 `test` 脚本、无 CI |
| 实跑测试结果 | ❌ **三类套件均非全绿** | E2E 3/6；闭环 7/9；上线清单 14 PASS / 1 FAIL / 1 MANUAL → **未就绪** |
| 关键架构契约 | ❌ **前端未复用 shared 纯逻辑层** | `packages/frontend` 对 `@jev-router/shared` **零 import**（ARCH-2 未兑现） |
| 集成层 | ❌ 无 HTTP server / 无真实 Jev adapter / 无 Provider 实现 | 全仓无 `.listen(`、无 `fetch(`（后端）、无 adapter 实现类 |
| 工程化 | ❌ 无 lint / 无 CI / 非 git 仓库 | root `lint` 指向不存在实现；无 `.github`；无 `.git` |
| **整体完成度** | **≈ 60 / 100** | 「可编译的骨架 + 未合上的闭环 + 未兑现的融合前提」 |

**判定**：按 tasks.md §0.4「门禁未通过 SHALL NOT 进入下一阶段」与 spec.md §0.7「闭环合上」五段位标准，本工程**不应被标记为「按 SDD 开发要求完成」**。阶段 2（纯逻辑层）与阶段 3（服务端核心）是真实资产；阶段 4–8 属「代码在、验收无」。

---

## 1. 审计方法（可复现）

本审计**不采信文档声明**，全部结论来自实际执行或最小复现。

### 1.1 执行环境说明

被审计工程为 pnpm workspace，`node_modules` 内软链/junction 在当前挂载环境下部分断裂（`@jev-router/shared` 无法解析）。为获得真实执行结果，审计在可写工作区建立镜像（复制 `packages/backend/dist`、为 `@jev-router/shared` 建 junction），再直接调用已编译产物。

> **排除项**：首次 `typecheck` 报出的 `@jev-router/shared` / `@types/node` / `Buffer` 等错误，经溯源为**软链断裂导致的环境故障**，非代码缺陷。此类问题不计入工程问题。

### 1.2 实际执行的命令与结果

```text
# 类型与构建
node <pnpm>/typescript/bin/tsc -p packages/shared/tsconfig.json --noEmit    → exit 0
node <pnpm>/typescript/bin/tsc -p packages/backend/tsconfig.json --noEmit   → exit 0
node <pnpm>/typescript/bin/tsc -p packages/backend/tsconfig.json            → 产出 dist/

# 测试套件（自包含 runner，非 vitest）
node -e "import('./packages/backend/dist/__tests__/e2e-integration.test.js')
         .then(m => m.runE2ETests())"            → passed 3 / failed 3
node -e "... closed-loop-verification.test.js"   → passed 7 / failed 2
node -e "... go-live-checklist.js"               → 14 PASS / 1 FAIL / 1 MANUAL，READY = false

# 前端
node <pnpm>/vue-tsc/bin/vue-tsc.js --noEmit -p tsconfig.json → TS2688（vite/client 类型缺失，junction 断裂）
```

### 1.3 缺陷复现脚本（本审计新建，非工程产物）

| 脚本 | 目的 | 结论 |
| --- | --- | --- |
| `repro2.mjs` | tieBreak 是否尊重 `raw` | **否**，raw 高者被淘汰 |
| `repro5.mjs` | EXP-10 分段边界行为 | 边界依赖 `observedAt` 与 `createdAt` 的墙钟先后 |
| `repro6/7.mjs` | T-8.4 反固化胜出模型数 | 修复 tieBreak 后 3 个，未修复 1 个，**均 < 5** |

---

## 2. 任务覆盖回溯（91 任务 / 8 阶段 + 门禁）

`tasks.md` 实际勾选 **67 项**，未勾选 **24 项**，未勾选项**全部集中在阶段 0 与阶段 1**。

| 阶段 | 名称 | 任务区间 | 勾选 | 门禁 | 门禁是否具备证据 |
| --- | --- | --- | --- | --- | --- |
| 阶段 0 | 规范评审与基线冻结 | T-0.1 ~ T-0.7 | ❌ **0 / 7** | G0 | ❌ 无评审签署、无基线指纹、无 Schema 入库 |
| 阶段 1 | 断言先行 | T-1.1 ~ T-1.17 | ❌ **0 / 17** | G1 | ❌ 断言基线不存在 |
| 阶段 2 | 纯逻辑层 | T-2.1 ~ T-2.10 | ✅ 10 / 10 | G2 | ⚠️ 代码在、可编译；「两形态共用审计」未做 |
| 阶段 3 | 服务端核心 | T-3.1 ~ T-3.10（含 b~h） | ✅ 17 / 17 | G3 | ⚠️ 模块齐备；主链未端到端、无真实 Jev |
| 阶段 4 | 经验闭环 | T-4.1 ~ T-4.11 | ✅ 11 / 11 | G4 | ❌ 闭环验收实跑失败 2 项 |
| 阶段 5 | 事件流与可观测性 | T-5.1 ~ T-5.6 | ✅ 6 / 6 | G5 | ⚠️ 总线在；SSE 无 HTTP 承载，不可运行 |
| 阶段 6 | 前端与 3D | T-6.1 ~ T-6.11（含 b） | ✅ 12 / 12 | G6 | ❌ 未接后端、未复用 shared、未构建 |
| 阶段 7 | 治理/无障碍/性能 | T-7.1 ~ T-7.4 | ✅ 4 / 4 | G7 | ❌ 无 axe-core；性能监控未被引用 |
| 阶段 8 | 集成验证与验收 | T-8.1 ~ T-8.7 | ✅ 7 / 7 | G8 | ❌ 上线清单 14/16，未就绪 |

### 2.1 三方声明矛盾（须以文档治理收口）

| 来源 | 声称范围 | 与 `tasks.md` 比对 |
| --- | --- | --- |
| `.ai-sdd/.../apply-report.md` | completed **26**（T-2.1~2.10 + T-3.1~3.10），skipped **71** | ❌ 与 67 勾选矛盾 |
| `openspec/.../review-notes.md` | 用户授权**仅** T-2.1~T-2.10（**10** 项） | ❌ 与 26、67 均矛盾 |
| `tasks.md` | 勾选 **67** | ⚠️ 阶段 4–8（40 项）被勾选，而 apply-report 明示这些「已跳过」 |

**推论**：阶段 4–8 的代码确实存在（experience-\*、route-event、sse-stream、前端等），说明 apply-report 生成之后**仍有实现活动**，但 **apply-report 未回写、review-notes 未同步**。当前任何基于「勾选状态」的进度判断都不可信。

### 2.2 已交付代码规模（实测行数）

| 包 | 源码行数 | 文件数 | 测试文件 |
| --- | ---: | ---: | --- |
| `packages/shared` | 1,822 | 13 `.ts` | **0** |
| `packages/backend` | 10,085 | 35 `.ts` + 3 测试 | 3（自包含 runner） |
| `packages/frontend` | 3,201 | 19 `.ts/.vue/.css` | **0** |

---

## 3. 需求域覆盖回溯（15 域 / 86 需求）

以「模块落点存在」为最低标准，86 条需求均有对应代码文件；以「行为可验收」为标准，缺口集中在 **JEV / CONSTRAIN / EXP / EVENT / API / RESULT** 六域。

| 需求域 | 需求数 | 模块落点 | 行为可验收？ | 关键缺口 |
| --- | ---: | --- | --- | --- |
| ARCH | 5 | ✅ shared + 前端 store/three | ⚠️ 部分 | **ARCH-2 前端未 import shared（实质违背）**；ARCH-4 无单文件产物 |
| INGEST | 6 | ✅ InputTab + TaskEnvelope | ⚠️ 部分 | 语音探测仅 UI 文案，无实现；白名单断言无测试 |
| JEV | 16 | ✅ 8 个模块 | ❌ 关键 | **JEV-1/2/3/9 无真实 Jev adapter（仅 interface）**；JEV-11 主链未接入 Selector/Gateway |
| MODEL | 4 | ✅ model-catalog | ⚠️ 部分 | MODEL-4 目录同源无前后端联测 |
| CONSTRAIN | 5 | ✅ constraint-selector | ⚠️ 部分 | 8 步管线在；E2E 用例自身数据与断言不符（见 §4.4） |
| SCORE | 4 | ✅ scoreModels / tieBreak | ❌ | **SCORE-4 决胜序列实现与语义不符（见 §4.1）** |
| TREE | 5 | ✅ geometry + TreeScene | ⚠️ 部分 | 几何预验证 27 项无断言落点 |
| ANIM | 6 | ✅ computeRun + AnimationController | ❌ | **ANIM-6「事件驱动非自推断」被前端合成事件架空**；阶段名与 shared 不一致 |
| RESULT | 5 | ✅ ResultTab | ❌ | **指标与模型分硬编码**；内联结果未接后端流式 |
| ARCHIVE | 5 | ✅ archive-persistence | ⚠️ 部分 | 隐私模式降级无测试 |
| EXP | 10 | ✅ 7 个模块 | ❌ | 闭环验收实跑失败（T-8.4 / T-8.5） |
| EVENT | 4 | ✅ route-event 等 | ❌ | **事件类型与 spec 不符（缺 2 个、多 2 个）**；SSE 无 HTTP 承载 |
| A11Y | 3 | ⚠️ 部分 aria 属性（34 处） | ❌ | **无 axe-core**，零违规无从核验 |
| PERF | 3 | ⚠️ perf-monitor 孤立（519 行） | ❌ | **监控模块零引用**，无实测数据 |
| API | 5 | ⚠️ route-api 纯 handler | ❌ | **无 HTTP server，15 端点仅 5 个有 handler** |

---

## 4. 已确认缺陷（附最小复现）

### 4.1 【严重】`tieBreak` 以 capability 为第一关键字，推翻 `raw` 排序 —— 违背 SCORE-4

`packages/shared/src/tieBreak.ts` 的排序比较器**第一关键字是 `capability`**，**从不比较 `raw`**。因此它不是「同分决胜」，而是「无条件按能力分重排」，直接**推翻** `scoreModels` 的评分结果。

**最小复现**（`repro2.mjs`，经验回流使弱能力模型获得大正 Δraw）：

```text
模型：weak-A(capability=0.20) / strong-B(capability=0.95)，等权 policy
priorDeltas = [0.90, 0]   ← 经验回流给 weak-A 的修正

scoreModels.byRankOrder  : weak-A(raw=1.2500)  >  strong-B(raw=0.7250)
tieBreak(byRankOrder)    : strong-B(raw=0.7250)  >  weak-A(raw=1.2500)   ← raw 高者被淘汰
raw 差距 = 0.5250（远超任何 ε）
```

**影响**：选型静默漂移——正是 `spec.md` `MODEL-3` 与设计反复强调的「最昂贵缺陷」类别。它同时是 **T-8.4 反固化验收失败的根因之一**（详见 §4.5）。

**内部不一致佐证**：`experience-reflow.ts` 的 `argMax`（注释自称「matches tieBreak semantics」）实际是**按 raw 取最大**，与 `tieBreak` 的 capability 优先**互相矛盾**。

**建议**：比较器应以 `raw` 降序为第一关键字，仅当 `|raw_a − raw_b| < ε` 时才进入 capability → cost → latency → modelId 序列；补断言「raw 差显著 ⇒ winner 恒等于 `byRankOrder[0]`」。

### 4.2 【严重】`interpretNoulProbability` 在 ε 边界因浮点误差误判 —— 上线清单第 6 项 FAIL

`NOUL_INDISTINGUISHABLE_EPSILON = 0.05`，判据为 `Math.abs(p - 0.5) <= 0.05`。但：

```text
Math.abs(0.55 - 0.5) = 0.050000000000000044  →  > 0.05  →  判为 'leans-yes'
0.45 → indistinguishable ； 0.50 → indistinguishable ； 0.55 → leans   ← 不对称
```

**影响**：`JEV-13`「Noul 0.5 语义」在边界处失效；上线判定清单第 6 项因此 FAIL（证据串 `band-internal indistinguishable=false`）。

**建议**：改用带容差比较（`Math.abs(p - 0.5) <= ε + 1e-9`）或把 ε 判定改为区间端点开闭一致的定义；补 0.45 / 0.50 / 0.55 三点必须同为 `indistinguishable` 的边界断言。

### 4.3 【中】EXP-10 分段边界依赖墙钟先后，T-8.5 证据无效

`ExperienceValidator.segmentByVersion` 以 `version.createdAt` 为界，`observedAt < boundary` 归「前段」，否则归「后段」。

> **对既有审计的更正**：先前的回溯报告称「同一毫秒内 V1/V2 时间戳完全相同导致分段失效」。本审计实测 `v1.createdAt=…27.013Z`、`v2.createdAt=…27.014Z`，**并不相同**，该具体论断不成立。但失败模式**确实存在**，成因不同：

**实测（`repro5.mjs`）**：

```text
[A] after 条目时间戳 = now+1000（晚于 v2 边界）
    after.sampleCount = 40  → verdict = degraded      ✅

[B] after 条目时间戳 = now-10000（早于 v2 边界，即 T-8.5 实际写法）
    after.sampleCount = 0   → verdict = inconclusive  ❌
```

**结论**：`closed-loop-verification.test.ts` 的 T-8.5 把「应用后段」条目时间戳设在**版本边界之前**，导致后段为空、判定 `inconclusive`。校验器逻辑本身在给定数据下是**正确**的；**失效的是测试数据与验收证据**。T-8.5 被勾为完成，但其证据并未真正验证「劣化 → 告警 → 原子回滚」。

**建议**：验收用例改用晚于版本边界的 `observedAt`；更稳健的做法是引入**单调逻辑时钟 / 版本序号**做分段，避免依赖 `Date.now()` 的墙钟先后。

### 4.4 【中】E2E 用例自身数据与断言不符（测试不可作门禁）

`packages/backend/src/__tests__/e2e-integration.test.ts` 实跑 3/6 失败，**三处均为用例自身缺陷**：

| 用例 | 失败原因 | 性质 |
| --- | --- | --- |
| `testConstraintPipeline` | 传 `maxContextTokens: 200_000`，却断言 `model-a`（`contextWindow = 128_000`）「应该 eligible」 | **断言与数据自相矛盾** |
| `testExperienceIntegration` | 用 `===` 精确比较 `0.05` 与 `0.050000000000000044` | 浮点精确相等必然失败 |
| `testFullChain` | 只注册 `provider-x` 的 mock adapter，却对 `provider-y` 的模型发起 `invoke` | mock 覆盖不全，抛 `PROVIDER_UNAVAILABLE` |

**建议**：修断言口径（浮点用容差、上下文断言与数据对齐、mock 覆盖全部 provider）。**在测试全绿之前，不得把 T-8.x 勾为完成。**

### 4.5 【中】T-8.4 反固化验收标准在现网数据下不可达

实测（`repro6/7.mjs`，使用 T-8.4 自带的 8 模型与 10 组 priorDeltas + 4 组 policy 变体）：

```text
使用 tieBreak（当前实现）        : 胜出模型数 = 1   [gpt-4o]
使用 byRankOrder[0]（修复 tieBreak）: 胜出模型数 = 3   [llama-3, gemini-pro, qwen-72b]
验收要求                          : >= 5
```

**结论**：① `tieBreak` 缺陷把胜出模型数从 3 压到 1，是主要恶化因素；② **即使修复 tieBreak，仍达不到 ≥5**——因为 8 个模型的 capability/quality 过于接近（0.73–0.90），10 组 Δraw 幅度（0.1）不足以翻转排序。**验收标准与测试数据不匹配**，须一并复核。

### 4.6 【轻】`shared` 与 `frontend` 零测试

`packages/shared` 与 `packages/frontend` 下**无任何** `*.test.ts`。shared 是两形态共用的数学核心（`calibrate` / `priorDeltaFor` / `calibrationStats` / `tieBreak`），却无一条断言——这与 tasks.md §0.3「断言先行」和 design.md §10 测试策略直接冲突。**§4.1 的缺陷正是「无断言保护」的直接后果。**

---

## 5. 缺失能力清单（按阻断程度分级）

### A. 阻断级（不补齐则系统不可运行 / 不可验收）

| # | 缺失能力 | 证据 | 关联需求 |
| --- | --- | --- | --- |
| A1 | **无 HTTP 服务器层** | 全仓无 `createServer` / `.listen(` / Express/Hono/Fastify；`route-api.ts` 自述「contract layer, not an HTTP server」；无 server 入口文件 | API-1~API-5、EVENT-3 |
| A2 | **无真实 TypeSafe Jev adapter** | `TypeSafeJevAdapter` 仅 interface，无实现类；`jev-adapter.ts` 无任何 fetch/http 调用 | JEV-1/2/3/9 |
| A3 | **无 Provider 适配器实现** | `ModelGateway` 有 `registerAdapter`，但全仓无 openai/anthropic/google 实现；唯一实现是测试里的 `MockProviderAdapter` | RESULT-2 |
| A4 | **前端未接后端** | `App.vue:29` 明写 `// TODO: wire to backend POST /v1/routes`；`submitPrompt` 合成 9 条硬编码事件（confidence 固定 0.87、winner 固定 gpt-4o）；无 `EventSource`/SSE 消费 | ARCH-3、ANIM-6、RESULT-1 |
| A5 | **前端未复用 shared 纯逻辑层** | `packages/frontend` 对 `@jev-router/shared` **零 import**（唯一命中是 `OfflineAdapter.ts:185` 的一句注释）；`computeRunFrontend.ts`（217 行）注释「Ported from jev-demo.html」，与 shared `computeRun.ts`（104 行）**阶段名都不同** | **ARCH-2** |
| A6 | **测试未接入 runner** | 无 `vitest.config.*`；三个包 `package.json` 均无 `test` 脚本（root `test` 转发给不存在的子脚本）；测试文件为自包含 `runXxx()` runner | G1、tasks §0.3 |
| A7 | **事件类型契约不符** | spec `EVENT-1` 要求 `MODEL_CALL_STARTED`、`ROUTE_FAILED` —— 代码**两者皆无**；代码多出 `CONSTRAINT_GATE_PASSED`、`ROUTE_ESCALATED`。前后端两份定义同错 | EVENT-1 |

### B. 重要级（影响验收可信度）

| # | 缺失能力 | 证据 | 关联需求 |
| --- | --- | --- | --- |
| B1 | 阶段 0 评审冻结产物缺失 | T-0.1~T-0.7 全未勾选；无契约冻结记录、无基线指纹、无 Schema 入库 | G0 |
| B2 | 阶段 1 断言基线缺失 | T-1.1~T-1.17 全未勾选 | G1 |
| B3 | 10 个 API 端点无 handler | spec 附录 B 列 15 端点，`route-api.ts` 仅覆盖 5；缺 `/decision` `/cancel` `/feedback` `/replay` `/receipt` `/contracts/:id` `/experience/*` **以及 `/v1/health`** | API-1~API-5、JEV-12、JEV-16 |
| B4 | 健康检查端点缺失但被前端依赖 | `App.vue:21` 轮询 `/v1/health`，全仓无该 handler → 前端**永远**判定为 offline | ARCH-3 |
| B5 | A11Y 审计工具缺失 | 无 axe-core / jsdom / happy-dom 依赖；A11Y-1/2「零违规」无从核验 | A11Y-1/2 |
| B6 | 性能监控未接线 | `perf/performance-monitor.ts`（519 行）**零 import 引用** | PERF-1/2/3 |
| B7 | 无 lint | root `lint` 指向不存在的 per-package 脚本；无 eslint/prettier/editorconfig 配置 | 全局 |
| B8 | 无 CI、非 git 仓库 | 无 `.github/workflows`；**无 `.git`**（无法追溯变更集，「每任务自检」无自动化保障） | 全局 |
| B9 | 前端未构建验证 | 无 `packages/frontend/dist`；`vite.config.ts` 声明了 `index-offline.html` 入口但无单文件内联产物 | G6、ARCH-4 |
| B10 | 前端展示数据硬编码 | `ResultTab.vue` 硬编码 5 个五问答案与 6 个模型分；`ModelsTab.vue` 硬编码模型卡；`HistoryTab.vue` 初始为空数组 | RESULT-3/5、MODEL-4、ARCHIVE-3 |

### C. 一般级（完善度）

| # | 缺失能力 | 证据 |
| --- | --- | --- |
| C1 | 离线单文件形态与 design 表述冲突 | design.md §2.1 仍写「单个自包含 HTML、无后端」；review-notes D-Apply-1 已登记偏差，但 design.md 未回写 |
| C2 | `apply-report.md` 未回写阶段 4–8 | 报告停留「26 完成 / 71 跳过」，与实际 67 勾选脱节 |
| C3 | `review-notes.md` 两份副本分叉 | `openspec/...` 与 `.ai-sdd/...` 内容不一致（后者多出决策 6/7 与 D-Apply-3）；文件哈希不同 |
| C4 | `changed-files.md` 失准 | Trace 列全为 `TODO`；汇总称「added 0 / modified 16」，实际 backend 35 个模块 + 前端 19 个文件未入清单 |
| C5 | 决策凭据读取接口未落地 | spec 附录 B 的 `GET /v1/contracts/:id`、`GET /v1/routes/:id/receipt` 无 handler |
| C6 | INGEST-4 语音能力探测仅 UI 文案 | `InputTab.vue` 只有「语音输入」按钮与说明文字，无能力探测实现 |
| C7 | 阶段名前后端不一致 | shared 用 `state/questions/jev/probability/route/execute/result`；前端 `computeRunFrontend` 用 `ingest/analyze/score/select/execute/return/done` |

---

## 6. 文档与流程一致性问题

1. **门禁被跳过而非通过**：G0、G1 无任何证据；G2–G8 的「验收证据」栏所要求的产物（评审记录、断言报告、五段位验收报表、双形态一致性报告、回滚演练记录）**均不存在**。当前 `[x]` 仅代表「写了代码」，不代表「通过验收」。
2. **C7 门禁被越过**：spec.md C7 明定「本阶段 SHALL NOT 交付前后端代码实现，仅交付规范」，实际交付了大量前后端代码。review-notes D-Apply-2 已登记为用户授权越过，属**已知偏差**，但 proposal 状态仍为 Draft，流程闭环未收口。
3. **apply-report 与 tasks 脱节**：见 §2.1。建议以 `tasks.md` 为准，重新生成 apply-report 与 changed-files。
4. **design 偏差未闭环**：D-Apply-1（技术形态）已登记于 review-notes，但未同步进 `design.md`——违反 SDD「偏差登记与实现一致」的一致性契约。
5. **「两形态共用纯逻辑层」是纸面契约**：design.md、config.yaml、tasks.md 反复强调 shared 层被云/离线两形态共用，但前端实际是「重复实现 + 硬编码」。这是**最需要优先澄清**的一致性缺口。
6. **T-8.3「双形态一致性」是自证式测试**：该用例只调用 shared 的 `scoreModels` 两次比较，**从未加载前端任何代码**，因此它证明的是「纯函数确定性」，而非「两形态选型一致」。验收证据与需求指向不符。

---

## 7. 优化建议（按优先级，可执行）

### P0 —— 先止血（1~2 天）

1. **修 `tieBreak`**（§4.1）：以 `raw` 降序为第一关键字，同分（`|Δraw| < ε`）才走 capability → cost → latency → modelId；补断言「raw 差显著 ⇒ winner = `byRankOrder[0]`」。
2. **修 `interpretNoulProbability` 边界浮点**（§4.2）：加 `1e-9` 容差；补 0.45/0.50/0.55 三点断言。修复后上线清单第 6 项转绿。
3. **修三处 E2E 用例**（§4.4）：浮点容差比较、上下文断言与数据对齐、mock 覆盖全部 provider。
4. **修 T-8.5 时间戳**（§4.3）：after 段条目改用晚于版本边界的 `observedAt`。
5. **给三个自包含 runner 接上 vitest**：新增 `vitest.config.ts` + 各包 `"test": "vitest run"`，把 `runE2ETests` / `runClosedLoopTests` / `verifyGoLiveChecklist` 包成 `describe/it`。

### P1 —— 兑现核心契约（1~2 周）

6. **前端改为真正复用 `@jev-router/shared`**：删除 `computeRunFrontend.ts` 的重复实现，改 `import { computeRun, calibrate, routeTier, scoreModels, tieBreak } from '@jev-router/shared'`；`OfflineAdapter.answerQuestionsOffline` 同样改为调用 shared 或 `LocalJevReimpl`。**这是让 ARCH-2 成立、让「双形态一致性」可验的唯一途径。**
7. **补 shared 层断言**：至少覆盖 `calibrate` 边界/单调、`priorDeltaFor` 冷启动与上界、`calibrationStats` ECE 对拍、`computeRun` 时长自洽、`tieBreak` 决胜语义——即 T-1.5~T-1.10 的落地。
8. **补 HTTP 层**：用 Hono/Express 薄封装 `route-api.ts` + `sse-stream.ts`，落地 spec 附录 B 的 15 个端点，**优先补 `/v1/health`**（前端已在轮询）。
9. **前端接后端**：`submitPrompt` 改为 `POST /v1/routes` + 订阅 SSE；删除硬编码事件序列，改由后端 `RouteEvent` 驱动（兑现 ANIM-6）；`ResultTab` 的 KPI 与模型分改读事件 payload。

### P2 —— 补齐集成与验收（2~4 周）

10. **实现真实 Jev adapter**（HTTP/RPC，含 sandbox 凭据、超时、非法 Schema 处理）与至少 2 个 Provider adapter（openai/anthropic）。
11. **对齐事件类型契约**：补 `MODEL_CALL_STARTED` / `ROUTE_FAILED`，或走变更流程修订 spec `EVENT-1`；前后端两份定义同步。
12. **复核 T-8.4 验收标准与数据**（§4.5）：提高模型画像区分度或扩大 Δraw 幅度，使「≥5 个模型可胜出」成为可达目标。
13. **回写文档**：以 `tasks.md` 为准重生成 apply-report 与 changed-files；把 D-Apply-1 同步进 design.md；统一两份 review-notes。
14. **接入 A11Y/性能门禁**：引入 axe-core 跑多视口零违规；把 `performance-monitor` 接到启动/渲染路径，产出 PERF 实测。

### P3 —— 工程化

15. **加 CI**（typecheck + test + build 三件套），把「每任务自检」变成硬门禁；同时 `git init` 建立变更追溯。
16. **引入 eslint/prettier**，让 root `lint` 名副其实。
17. **前端构建验证入 CI**，产出 `dist/` 与离线单文件产物（`vite-plugin-singlefile` 或等价内联方案）。

---

## 8. 验收门禁现状（G0–G8）

| 门禁 | 要求 | 现状 | 判定 |
| --- | --- | --- | --- |
| G0 | 四文档评审通过；基线指纹可复现；契约冻结 | 无任何产物 | ❌ 未通过 |
| G1 | 全部断言基线可运行（允许红，但必须存在） | 断言基线不存在 | ❌ 未通过 |
| G2 | 纯逻辑层断言通过；两形态共用审计通过 | 代码在、断言无、共用未兑现 | ❌ 未通过 |
| G3 | 真实 Jev 集成通过；上线清单第 11 项复核 | 无真实 Jev adapter | ❌ 未通过 |
| G4 | 闭环五段位落点齐备；「闭环合上」验收通过 | 五段位代码在，验收实跑失败 2 项 | ❌ 未通过 |
| G5 | 事件丢失率 0；全链路可关联；第 13 项复核 | 无 HTTP 承载，不可运行 | ❌ 未通过 |
| G6 | 3D 帧率 ≥30fps；事件驱动无自推断；内联与档案一致 | 前端未接后端、未复用 shared、未构建 | ❌ 未通过 |
| G7 | 无障碍零违规；性能预算达标；密钥零泄漏 | 无 axe-core、监控未接线 | ❌ 未通过 |
| G8 | 全部验收场景通过；上线清单 16 项全过 | 上线清单 14/16（第 6 项 FAIL、第 8 项 MANUAL） | ❌ 未通过 |

**门禁结论**：G0–G8 **无一通过**。按 tasks.md §0.4「门禁未通过 SHALL NOT 进入下一阶段」，当前工程不应被标记为「按 SDD 要求完成」。

---

## 9. 附：值得肯定之处（避免以偏概全）

以下方面确属高质量实现，是后续补缺的坚实基础：

- **模块与需求的高保真映射**：backend 35 个模块逐条对应 spec 需求域，barrel `index.ts` 完整导出，命名与 design.md 一致（`consequence-thresholds` ↔ JEV-15、`responsibility-boundary` ↔ 三层权责、`decision-receipt` ↔ JEV-16）。
- **算法层严格实现且可编译**：`calibrate` 硬上下界 0.35/0.97、NaN 防御、单调性；`priorDeltaFor` 冷启动 `n_eff=0 ⇒ Δraw=0`；`computeRun` 末段取残差保证时长精确自洽——均实跑验证通过。
- **常量集中与工程纪律**：ARCH-5 常量全部集中 `constants.ts`，无内联魔数；`tsconfig.base.json` 开启 `strict` + `noUnusedLocals/Parameters`；`typecheck` 严格模式 0 错误。
- **Jev 工程纪律落地**：决策契约（JEV-12）、三原语守卫（JEV-13）、状态工程 6 段（JEV-14）、后果分级阈值（JEV-15）、决策凭据（JEV-16）均有独立模块；上线清单第 1~5、7、9~16 项**程序化 PASS**（14/16）。
- **降级与影子模式设计完整**：`evaluateDegradation` + `RULE_FALLBACK` + `decisionDegraded` 标记、`runShadow` + `checkShadowPromotion`、`LOCAL_JEV_DEVIATIONS` 偏差登记（F1–F6）前后端一致。
- **AI-SDD 工件规范**：`coding-assumptions.md`、`human-config-checklist.md` 详实登记了假设与待标定常量，可追溯性强。

---

*本报告为只读回溯审计，未修改任何被审计文件。所有「失败/缺失」结论均附最小复现或命令证据，可独立复核。*

