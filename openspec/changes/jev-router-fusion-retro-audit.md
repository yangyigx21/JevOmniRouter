# JevRouter 代码工程回溯审计报告

- **审计对象**：`D:\TREAWork\JevOmniRouter`（packages/{shared,backend,frontend}）
- **审计基线**：`D:\TREAWork\JevOmniRouter\openspec\changes\jev-router-fusion\`（proposal / spec / design / tasks 四文档，86 需求 / 126 场景 / 91 任务）
- **审计方式**：只读回溯 + 实际执行（typecheck / build / 测试入口实跑）
- **审计日期**：2026-09-28
- **审计结论（一句话）**：**代码骨架与纯算法层完成度较高且可编译，但"开发要求"中最关键的两条——两形态共用同一纯逻辑层、以及闭环五段位的"合上"验收——在实现层面并未真正兑现；此外测试未接入、集成层（HTTP / 真实 Jev / Provider）缺失，门禁 G0–G8 无一具备可核验证据。**

---

## 0. 结论速览

| 维度 | 评估 | 说明 |
| --- | --- | --- |
| 任务完成（形式） | **67 / 91 勾选** | 但勾选与实际实现、与 `apply-report.md` 声明三方矛盾 |
| 需求覆盖（形式） | 86 需求均有模块落点 | 落点存在 ≠ 行为验收通过 |
| 可编译性 | ✅ shared / backend `typecheck` 与 `build` 通过 | 前端因依赖未装齐未能构建 |
| 可测试性 | ❌ 测试未接入任何 runner | 无 vitest 配置、无 `test` 脚本、无 CI |
| 实跑测试结果 | ❌ 三类套件均非全绿 | E2E 3/6 失败；闭环 7/9；上线清单 14/16 → **未就绪** |
| 关键架构契约 | ❌ 前端未复用 shared 纯逻辑层 | ARCH-2 在实质上未兑现 |
| 集成层 | ❌ 无 HTTP server / 无真实 Jev adapter / 无 Provider 实现 | API、JEV-1/2/3/9、RESULT-2 不可端到端运行 |
| **整体完成度** | **≈ 62 / 100** | 「可编译的骨架 + 未合上的闭环」 |

**总体判断**：这是一份**广度惊人、深度可信、但"最后一公里"集体缺失**的实现。算法层（shared）与业务模块层（backend 35 个模块）几乎逐条对应 design.md，且能通过严格模式编译——这部分是真实资产。但三件事使工程**不能判定为"按 SDD 开发要求完成"**：

1. 前端**没有**复用共享纯逻辑层（`computeRunFrontend.ts` 是 `computeRun` 的重复移植，`OfflineAdapter` 声称复用实则硬编码），违背 `ARCH-2` 这一"融合版"的核心架构前提；
2. 测试文件**是孤立的自包含 runner**，未被 vitest 拾取、无 `test` 脚本，且实跑非全绿——`tasks.md §0.3`「断言先行」与门禁 G1 名存实亡；
3. 存在至少 **1 处真实逻辑缺陷**（`tieBreak` 无视 `raw` 分数直接改写名次，属 spec 所称"最昂贵缺陷"类别）。

---

## 1. 审计方法（可复现）

审计未采信文档声明，全部结论来自实际执行。使用的命令（沙箱内以 pnpm store 内的 tsc/vitest 直接调用，规避挂载点软链断裂）：

```
# 类型与构建（真实执行）
node .pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc -p packages/shared/tsconfig.json --noEmit   → exit 0
node .pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc -p packages/backend/tsconfig.json --noEmit  → exit 0
node .pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc -p packages/backend/tsconfig.json            → 构建出 dist/ 含 __tests__

# 测试（自包含 runner，非 vitest）
node dist/__tests__/e2e-integration.test.js        → runE2ETests():  passed 3 / failed 3
node dist/__tests__/closed-loop-verification.js    → runClosedLoopTests(): passed 7 / failed 2
node dist/__tests__/go-live-checklist.js           → verifyGoLiveChecklist(): 14 PASS / 1 FAIL / 1 MANUAL → READY = false
```

> **说明**：首次 `typecheck` 报出的 `@jev-router/shared` / `@types/node` / `AbortSignal` / `Buffer` 等错误，经溯源为**沙箱挂载导致 pnpm 符号链接断裂**（`node_modules/typescript` 等软链 `readlink` 失败），修复软链后 **0 错误**。因此这些**不是**代码缺陷，不应计入工程问题；本报告已将此类排除。

---

## 2. 任务覆盖回溯（91 任务 / 8 阶段 + 门禁）

`tasks.md` 实际勾选 **67 项**，未勾选 **24 项**。未勾选项全部集中在阶段 0 与阶段 1：

| 阶段 | 任务区间 | 勾选状态 | 门禁 | 门禁是否具备证据 |
| --- | --- | --- | --- | --- |
| 阶段 0 规范评审与基线冻结 | T-0.1 ~ T-0.7 | ❌ **0 / 7** | G0 | ❌ 无评审签署、无基线指纹、无 Schema 入库 |
| 阶段 1 断言先行 | T-1.1 ~ T-1.17 | ❌ **0 / 17** | G1 | ❌ 断言基线不存在 |
| 阶段 2 纯逻辑层 | T-2.1 ~ T-2.10 | ✅ 10 / 10 | G2 | ⚠️ 代码存在，但"两形态共用审计"未做 |
| 阶段 3 服务端核心 | T-3.1 ~ T-3.10 | ✅ 26 / 26 | G3 | ⚠️ 主链未接入 Selector/Gateway，非端到端 |
| 阶段 4 经验闭环 | T-4.1 ~ T-4.11 | ✅ 11 / 11 | G4 | ❌ 闭环验收实跑有失败项 |
| 阶段 5 事件流 | T-5.1 ~ T-5.6 | ✅ 6 / 6 | G5 | ⚠️ 事件总线存在，SSE 无服务器承载 |
| 阶段 6 前端与 3D | T-6.1 ~ T-6.11 | ✅ 12 / 12 | G6 | ❌ 前端未接后端、未复用 shared、未构建 |
| 阶段 7 治理/无障碍/性能 | T-7.1 ~ T-7.4 | ✅ 4 / 4 | G7 | ❌ 无 axe-core；perf-monitor 未被引用 |
| 阶段 8 集成验证 | T-8.1 ~ T-8.7 | ✅ 7 / 7 | G8 | ❌ 上线清单 14/16，未就绪 |

### 2.1 三方声明矛盾（须以文档治理收口）

| 来源 | 声称范围 | 与实际比对 |
| --- | --- | --- |
| `.ai-sdd/.../apply-report.md` | 完成 26 项（T-2.1~2.10 + T-3.1~3.10），**跳过 71 项**（含 T-4.x~T-8.x） | ❌ 与 `tasks.md` 勾选 67 项矛盾 |
| `openspec/.../review-notes.md` | 用户授权范围**仅** T-2.1~T-2.10（10 项） | ❌ 与 apply-report 的 26 项、tasks 的 67 项均矛盾 |
| `tasks.md` | 勾选 67 项 | ⚠️ 阶段 4–8（40 项）被勾选，但 apply-report 明示这些"已跳过" |

**推论**：阶段 4–8 的代码（experience-*、route-event、sse-stream、前端等）**确实存在**，说明这些任务在 apply-report 生成之后被继续实现，但 **apply-report 未回写、review-notes 未同步**。当前三份文档互相打架，任何基于"勾选状态"的进度判断都不可信。这正是 `tasks.md §0.4`「门禁未通过 SHALL NOT 进入下一阶段」被实质绕过的证据。

---

## 3. 需求域覆盖回溯（15 域 / 86 需求）

以"模块落点存在"为最低标准，86 条需求均有对应代码文件；但以"行为可验收"为标准，缺口集中在 JEV / CONSTRAIN / EXP / EVENT / API / RESULT 六域：

| 需求域 | 需求数 | 模块落点 | 行为可验收？ | 关键缺口 |
| --- | ---: | --- | --- | --- |
| ARCH | 5 | ✅ shared + 前端 store/three | ⚠️ 部分 | **ARCH-2 两形态共用纯逻辑层：前端未 import shared（实质违背）** |
| INGEST | 6 | ✅ InputTab + TaskEnvelope | ⚠️ 部分 | 语音探测、白名单断言无测试 |
| JEV | 16 | ✅ 8 个模块 | ❌ 关键 | JEV-1/2/3/9 无真实 Jev HTTP adapter；JEV-11 主链未接入 Selector/Gateway |
| MODEL | 4 | ✅ model-catalog | ⚠️ 部分 | MODEL-4 目录同源无前后端联测 |
| CONSTRAIN | 5 | ✅ constraint-selector | ⚠️ 部分 | 8 步管线存在，但 E2E 用例自身数据与断言不符（见 §4.4） |
| SCORE | 4 | ✅ scoreModels/tieBreak | ❌ | **SCORE-4 决胜序列实现错误（见 §4.1）** |
| TREE | 5 | ✅ geometry + TreeScene | ⚠️ 部分 | 几何预验证 27 项无断言落点 |
| ANIM | 6 | ✅ computeRun + AnimationController | ❌ | ANIM-6「事件驱动非自推断」被前端合成事件架空 |
| RESULT | 5 | ✅ ResultTab | ❌ | 内联结果未接后端流式；指标为硬编码 |
| ARCHIVE | 5 | ✅ archive-persistence | ⚠️ 部分 | 隐私模式降级无测试 |
| EXP | 10 | ✅ 7 个模块 | ❌ | 闭环验收实跑有失败（T-8.4 / T-8.5） |
| EVENT | 4 | ✅ route-event 等 | ❌ | SSE 无 HTTP 承载，重连补偿不可运行 |
| A11Y | 3 | ✅ 部分 aria | ❌ | 无 axe-core，零违规无从核验 |
| PERF | 3 | ⚠️ perf-monitor 孤立 | ❌ | 监控模块未被任何组件引用 |
| API | 5 | ⚠️ route-api 纯 handler | ❌ | **无 HTTP 服务器，5 个端点不可达** |

---

## 4. 已发现的真实缺陷（附最小复现）

### 4.1 【严重】`tieBreak` 无视分数直接改写名次 —— 违背 SCORE-4

`packages/shared/src/tieBreak.ts` 的排序比较器**第一关键字就是 `capability`**，从不比较 `raw` 分数，因此它不是"同分决胜"，而是"无条件按能力分重排"，直接**推翻** `scoreModels` 的评分结果。

最小复现（成本权重很高的策略下，"便宜但能力弱"的模型 raw 分数远高于"强但贵"的模型）：

```
scoreModels([cheap-but-weak, strong-expensive], { w_capability:0.1, w_quality:0.1, w_cost:0.7, w_latency:0.1 })
  byRankOrder(按 raw 降序):  cheap-but-weak (raw= 0.0410)  >  strong-expensive (raw=-1.1942)
  tieBreak(byRankOrder)   :  strong-expensive  >  cheap-but-weak   ← raw 最高者被淘汰
```

**影响**：选型静默漂移——这正是 `spec.md MODEL-3` 与设计反复强调的"最昂贵缺陷"类别。它同时是 T-8.4 反固化验收失败（只产出 1 个胜出模型，要求 ≥5）的**直接根因**：因为 `tieBreak` 恒定偏向高能力模型，无论 priorDelta 如何扰动，winner 始终被拉回同一模型。

**建议**：比较器应以 `raw` 降序为第一关键字，仅当 `|raw_a − raw_b| < ε` 时才进入 capability→cost→latency→modelId 序列；并为该性质补一条断言（raw 差显著时 winner 必须等于 `byRankOrder[0]`）。

### 4.2 【严重】`interpretNoulProbability` 在 ε 边界因浮点误差误判

`NOUL_INDISTINGUISHABLE_EPSILON = 0.05`，判据为 `|p − 0.5| ≤ ε`。但 `|0.55 − 0.5| = 0.05000000000000004 > 0.05`，故 `p = 0.55` 被判为 `leans-yes` 而非 `indistinguishable`。上线清单第 6 项（Noul 语义）因此 FAIL。

**建议**：改用带容差的比较（如 `|p − 0.5| ≤ ε + 1e-9`），或把 ε 判定改为区间端点开闭一致的定义；补边界断言（0.45 / 0.50 / 0.55 三点必须同为 `indistinguishable`）。

### 4.3 【中】T-8.5 劣化检测因版本时间戳粒度失效

`ExperienceVersionManager` 用 `new Date().toISOString()` 生成 `createdAt`；同一毫秒内创建的 V1、V2 时间戳**完全相同**，`segmentByVersion` 以 `v2.createdAt` 为界，导致 before/after 无法分离，校验器返回 `inconclusive` 而非 `degraded`。

**建议**：版本边界改用单调递增序号（version number）而非墙上时间做分段；或引入逻辑时钟（`logicalTime`）。当前测试也因此"测了个寂寞"——它宣称验证劣化回滚，实际连分段都没发生。

### 4.4 【中】E2E 用例自身数据与断言不符（测试不可作门禁）

- `testConstraintPipeline`：传 `maxContextTokens: 200_000` 却断言 `model-a`（contextWindow = 128_000）"应该 eligible"——**断言与数据自相矛盾**，实跑必然失败；
- `testExperienceIntegration`：用 `===` 精确比较浮点 `0.05` 与 `0.050000000000000044`，**浮点精确相等**必然失败；
- `testFullChain`：只注册了 `provider-x` 的 mock adapter，却对 `provider-y` 的模型发起 `invoke`，抛 `PROVIDER_UNAVAILABLE`。

**建议**：修断言口径（浮点用容差、上下文断言与数据对齐、mock 覆盖全部 provider）。**在测试全绿之前，不得把 `tasks.md` 中 T-8.x 勾为完成。**

### 4.5 【轻】`shared` 与 `frontend` 零测试

`packages/shared` 与 `packages/frontend` 下无任何 `*.test.ts`。shared 是两形态共用的数学核心（calibrate / priorDeltaFor / calibrationStats），却无一条断言；这与 `tasks.md §0.3`「断言先行」和 `design.md §10` 的测试策略直接冲突。

---

## 5. 缺失能力清单（按阻断程度分级）

### A. 阻断级（不补齐则系统不可运行 / 不可验收）

| # | 缺失能力 | 证据 | 关联需求 |
| --- | --- | --- | --- |
| A1 | **无 HTTP 服务器层** | 全仓无 `.listen(` / `createServer` / Express/Hono/Fastify；`route-api.ts` 自述"contract layer, not an HTTP server"；无 server 入口文件 | API-1~API-5、EVENT-3 |
| A2 | **无真实 TypeSafe Jev adapter** | `TypeSafeJevAdapter` 仅 interface，无实现类；`jev-adapter.ts` 无 fetch/http | JEV-1/2/3/9 |
| A3 | **无 Provider 适配器实现** | `ModelGateway` 有 `ProviderAdapter` 接口与 `registerAdapter`，但无 openai/anthropic/google 实现 | RESULT-2 |
| A4 | **前端未接后端** | `App.vue:29 // TODO: wire to backend POST /v1/routes`；`submitPrompt` 合成硬编码事件序列（confidence 固定 0.87）；无 SSE 消费 | ARCH-3、ANIM-6、RESULT-1 |
| A5 | **前端未复用 shared 纯逻辑层** | `grep -r "from '@jev-router/shared'" packages/frontend/src` → 0 命中；`computeRunFrontend.ts` 注释"Ported from jev-demo.html"；`OfflineAdapter` 注释声称复用实则硬编码答案 | **ARCH-2** |
| A6 | **测试未接入 runner** | 无 vitest 配置；各包 package.json 无 `test` 脚本；测试文件为自包含 `runXxx()` runner，vitest 不会拾取 | G1、tasks §0.3 |

### B. 重要级（影响验收可信度）

| # | 缺失能力 | 证据 | 关联需求 |
| --- | --- | --- | --- |
| B1 | 阶段 0 评审冻结产物缺失 | T-0.1~T-0.7 全未勾选；无契约冻结记录、无基线指纹、无 Schema 入库 | G0 |
| B2 | 阶段 1 断言基线缺失 | T-1.1~T-1.17 全未勾选 | G1 |
| B3 | A11Y 审计工具缺失 | 无 axe-core 依赖；A11Y-1/2「零违规」无从核验 | A11Y-1/2 |
| B4 | 性能监控未接线 | `perf/performance-monitor.ts`（519 行）未被任何组件 import | PERF-1/2/3 |
| B5 | 无 lint | root `lint` 脚本指向不存在的实现；无 eslint/prettier | 全局 |
| B6 | 无 CI | 无 `.github/workflows` 等；"每任务自检"无自动化保障 | 全局 |
| B7 | 前端未构建验证 | `packages/frontend/dist` 不存在；依赖树未装齐 | G6 |

### C. 一般级（完善度）

| # | 缺失能力 | 证据 |
| --- | --- | --- |
| C1 | 离线单文件形态与 design 表述冲突 | design.md §2.1 仍写"单个自包含 HTML、无后端"，实际为 monorepo 双形态；review-notes D-Apply-1 已登记偏差，但 design 附录 F 未回写 |
| C2 | `apply-report.md` 未回写阶段 4–8 | 报告停留在"26 完成 / 71 跳过"，与实际 67 勾选脱节 |
| C3 | `review-notes.md` 两份副本分叉 | `openspec/...` 与 `.ai-sdd/...` 内容不一致（后者多出决策 6/7 与 D-Apply-3） |
| C4 | `changed-files.md` 的 Trace 列全为 TODO | 逐文件未回填任务号 |
| C5 | 决策凭据读取接口未落地 | spec 附录 B 的 `GET /v1/contracts/:id`、`GET /v1/routes/:id/receipt` 无 handler |

---

## 6. 文档与流程一致性问题

1. **门禁被跳过而非通过**：G0、G1 无任何证据；G2–G8 的"验收证据"栏所要求的产物（评审记录、断言报告、五段位验收报表、双形态一致性报告、回滚演练记录）**均不存在**。当前 `tasks.md` 的 `[x]` 仅代表"写了代码"，不代表"通过验收"。
2. **apply-report 与 tasks 脱节**：见 §2.1。建议以 `tasks.md` 为准，重新生成 apply-report。
3. **design 偏差未闭环**：D-Apply-1（技术形态）已登记于 review-notes，但未同步进 `design.md` 的偏差登记表与 `spec.md` 附录 F——违反 SDD「偏差登记与实现一致」的一致性契约。
4. **"两形态共用纯逻辑层"是纸面契约**：design.md 与 config.yaml 反复强调 shared 层被云/离线两形态共用，但前端实际是"重复实现 + 硬编码"。这是**最需要优先澄清**的一致性缺口。

---

## 7. 优化建议（按优先级，可执行）

### P0 —— 先止血（1~2 天）

1. **修 `tieBreak`**：以 `raw` 为第一关键字，同分才走 capability→cost→latency→modelId；补断言"raw 差显著 ⇒ winner = byRankOrder[0]"。（修复后 T-8.4 大概率转绿）
2. **修 `interpretNoulProbability` 边界浮点**：加 `1e-9` 容差；补 0.45/0.50/0.55 三点断言。（修复后上线清单第 6 项转绿）
3. **修三处 E2E 用例**：浮点容差比较、上下文断言与数据对齐、mock 覆盖全部 provider。
4. **给三个自包含 runner 接上 vitest**：新增 `vitest.config.ts` + 各包 `"test": "vitest run"`，把 `runE2ETests/runClosedLoopTests/verifyGoLiveChecklist` 包成 `describe/it`。

### P1 —— 兑现核心契约（1~2 周）

5. **前端改为真正复用 `@jev-router/shared`**：删除 `computeRunFrontend.ts` 的重复实现，改为 `import { computeRun, calibrate, routeTier, scoreModels } from '@jev-router/shared'`；`OfflineAdapter.answerQuestionsOffline` 同样改为调用 shared。**这是让 ARCH-2 成立、让"双形态一致性"可验的唯一途径。**
6. **补 shared 层断言**：至少覆盖 calibrate 边界/单调、priorDeltaFor 冷启动与上界、calibrationStats ECE 对拍、computeRun 时长自洽——即 T-1.5~T-1.10 的落地。
7. **补 HTTP 层**：用 Hono/Express 薄封装 `route-api.ts` + `sse-stream.ts`，落地 API-1~API-5，提供 `/v1/health`（前端已在轮询）。
8. **前端接后端**：`submitPrompt` 改为 `POST /v1/routes` + 订阅 SSE；删除硬编码事件序列，改为由后端 RouteEvent 驱动（兑现 ANIM-6）。

### P2 —— 补齐集成与验收（2~4 周）

9. **实现真实 Jev adapter**（HTTP/RPC，含 sandbox 凭据、超时、非法 Schema 处理）与至少 2 个 Provider adapter（openai/anthropic）。
10. **修版本分段逻辑**（§4.3），让 T-8.5 真正验证劣化→回滚。
11. **回写文档**：以 `tasks.md` 为准重生成 apply-report；把 D-Apply-1 同步进 design 附录 F；统一两份 review-notes。
12. **接入 A11Y/性能门禁**：引入 axe-core 跑多视口零违规；把 performance-monitor 接到启动/渲染路径，产出 PERF 实测。

### P3 —— 工程化

13. 加 CI（typecheck + test + build 三件套），把"每任务自检"变成硬门禁。
14. 引入 eslint/prettier，让 root `lint` 名副其实。
15. 前端构建验证入 CI，产出 `dist/` 与离线单文件产物。

---

## 8. 验收门禁现状（G0–G8）

| 门禁 | 要求 | 现状 | 判定 |
| --- | --- | --- | --- |
| G0 | 四文档评审通过；基线指纹可复现；契约冻结 | 无任何产物 | ❌ 未通过 |
| G1 | 全部断言基线可运行（允许红，但必须存在） | 断言基线不存在 | ❌ 未通过 |
| G2 | 纯逻辑层断言通过；两形态共用审计通过 | 代码在、断言无、共用未兑现 | ❌ 未通过 |
| G3 | 真实 Jev 集成通过；上线清单第 11 项复核 | 无真实 Jev adapter | ❌ 未通过 |
| G4 | 五段位落点齐备；「闭环合上」验收通过 | 五段位代码在，验收实跑失败 | ❌ 未通过 |
| G5 | 事件丢失率 0；全链路可关联；第 13 项复核 | 无 HTTP 承载，不可运行 | ❌ 未通过 |
| G6 | 3D 帧率 ≥30fps；事件驱动无自推断；内联与档案一致 | 前端未接后端、未构建 | ❌ 未通过 |
| G7 | 无障碍零违规；性能预算达标；密钥零泄漏 | 无 axe-core、监控未接线 | ❌ 未通过 |
| G8 | 全部验收场景通过；上线清单 16 项全过 | 上线清单 14/16，未就绪 | ❌ 未通过 |

**门禁结论**：G0–G8 **无一通过**。按 `tasks.md §0.4`「门禁未通过 SHALL NOT 进入下一阶段」，当前工程不应被标记为"按 SDD 要求完成"。

---

## 9. 附：值得肯定之处（避免以偏概全）

为公平起见，以下方面确属高质量实现，是后续补缺的坚实基础：

- **模块与需求的高保真映射**：backend 35 个模块逐条对应 spec 需求域，barrel `index.ts` 完整导出，命名与 design.md 一致（如 `consequence-thresholds` ↔ JEV-15、`responsibility-boundary` ↔ 三层权责）。
- **算法层严格实现且可编译**：`calibrate` 硬上下界 0.35/0.97、NaN 防御、单调性；`priorDeltaFor` 冷启动 `n_eff=0 ⇒ Δraw=0` 均实跑验证通过；常量集中于 `constants.ts`（ARCH-5）。
- **类型与文档注释扎实**：`tsconfig.base.json` 开启 `strict` + `noUnusedLocals/Parameters`；每个模块头部标注对应需求号与设计条款。
- **Jev 工程纪律落地**：决策契约（JEV-12）、三原语守卫（JEV-13）、状态工程 6 段（JEV-14）、后果分级阈值（JEV-15）、决策凭据（JEV-16）均有独立模块，且上线清单第 1~5、7、9~16 项程序化 PASS。
- **AI-SDD 工件规范**：`coding-assumptions.md`、`human-config-checklist.md` 详实登记了假设与待标定常量，可追溯性强。

---

*本报告为只读回溯审计，未修改任何被审计文件。所有"失败/缺失"结论均附最小复现或命令证据，可独立复核。*
