# JevOmniRouter Prompt 输入 → 输出 全链路判断逻辑核对文档

> 依据：当前工作树代码（含本轮已生效的三处改动：TreeScene 索引错位修复、function calling 全链路、ESCALATE 免费模型优先规则）。
> 范围：从 `POST /v1/routes` 接收到模型结果落库/前端展示的每一环节判断逻辑，逐环节给出「输入 → 判断逻辑（公式/阈值/常量）→ 输出/产物 → 触发事件 → 核对结论」。
> 结论速览：**8 项关键不变量判定正确；发现 11 项疑点（P1×2、P2×5、P3×4）**，详见第 3 章。

---

## 1. 全链路总览

```
POST /v1/routes（server.ts）
  │
 ① HTTP 接入与请求归一化 ────────────── ROUTE_CREATED
 ② 证据提取 prompt → RawEvidence ──────（无独立事件，随 JEV_CALL_STARTED 上报）
 ③ 经验读取 + 候选池过滤 ────────────── EXPERIENCE_RETRIEVED
 ④ 6 段状态装配（GOAL/FACTS/ARTIFACTS/EVIDENCE/CONSTRAINTS/OPTIONS）
 ⑤ Jev 五问决策 ─────────────────────── JEV_CALL_STARTED
        ├─ 成功 → JEV_DECISION_READY（decisionSource=TYPE_SAFE_JEV）
        └─ 失败 → JEV_FALLBACK → 本地重实现兜底（RULE_FALLBACK）→ JEV_DECISION_READY
 ⑥ 硬约束门（8 步）─────────────────── CONSTRAINT_FILTERED / CONSTRAINT_GATE_PASSED
 ⑦ 先验注入 + 加权打分 + 自适应 softmax + tieBreak
 ⑧ 置信度 → 三档路由 ──────────────────（档位写入 JEV_DECISION_READY）
        ├─ ESCALATE → ROUTE_ESCALATED（免费模型优先登记，不自动执行）→ ⑩
        └─ ROUTE / GATE → MODEL_SELECTED
 ⑨ tool_call 循环执行（≤3 轮）───────── MODEL_CALL_STARTED / MODEL_STREAMING / MODEL_COMPLETED
 ⑩ 落库闭环 ─────────────────────────── EXPERIENCE_SAVED（决策库/历史库/模型库重评分 + 动态阈值复算）
 ⑪ 前端展示 ─────────────────────────── SSE 具名事件 → reducer → StageView / TreeScene 星球高亮
```

事件流与状态机的权威定义见 [route-orchestrator.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-orchestrator.ts#L8-L22) 头部注释，编排主方法为 [run()](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-orchestrator.ts#L135)。

---

## 2. 分环节判断逻辑

### 2.1 环节① HTTP 接入与请求归一化

- **入口**：[server.ts L259-273](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/server.ts#L259-L273) `POST /v1/routes`。
- **输入**：`CreateRouteRequest { prompt, modalities?, constraints?: { maxLatencyMs, budgetUsd, allowedModelIds, riskLevel }, consequenceClass?, catalogVersion? }`（[route-api.ts L76-104](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-api.ts#L76-L104)）。
- **判断逻辑**：
  1. `createRoute` 校验 prompt ≤ 5000 字符（否则 `PROMPT_TOO_LONG`）；`catalogVersion` 不一致则 `assertSameCatalogVersion` 抛错；生成 `requestId`，初态 `CREATED`（[route-api.ts L334-355](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-api.ts#L334-L355)）。
  2. `mapPreference(consequenceClass)`：`high`/`irreversible` → `quality`；`low` → `economy`；其余 → `undefined`（用配置默认 `balanced`）（[server.ts L486-492](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/server.ts#L486-L492)）。
  3. `orchestrator.run(...)` **异步推进不阻塞**，HTTP 立即返回 requestId，后续事件经 EventBus → SSE 推送。
- **输出**：`{ requestId, status, catalogVersion, createdAt }`；路由状态机进入 `DECIDING`。
- **触发事件**：`ROUTE_CREATED`。
- **核对结论**：**基本正确**。疑点：请求里的 `modalities` 与 `riskLevel` 两个字段在后续环节从未被消费（见 3.2 疑点 3），属「收了不用的死输入」。

### 2.2 环节② 证据提取（prompt → RawEvidence）

- **代码**：[prompt-evidence.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/prompt-evidence.ts) `extractPromptEvidence(prompt, attachments?)`。
- **输入**：prompt 原文（编排器 [L165](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-orchestrator.ts#L165) 只传 prompt，未传 attachments）。
- **判断逻辑**（全部 `clamp01` 到 [0,1]）：
  | 量 | 公式 |
  |----|------|
  | `tokens` | `ceil(len / 4)` |
  | `codeBlockCount` | `\`\`\`` 出现次数 / 2 |
  | `stepCount` | 编号/列表行数 |
  | `complexity` | `0.15·tokens/600 + 0.25·codeBlock/3 + 0.2·steps/6 + 0.25·信号词/4 + 0.15·问号/5` |
  | `capability` | `0.55·高阶术语/3 + 0.25·codeBlock/2 + 0.2·tokens/800` |
  | `urgency` | `0.25 + 0.75·紧急信号词/2` |
  | `budget` | `0.2 + 0.8·预算信号词/2` |
- **输出**：`RawEvidence { hits(7 类意图关键词计数), imgCount, fileCount, fileTokens, tokens, nCap, scores{complexity,capability}, probabilities{urgency,budget} }`。
- **核对结论**：**公式本身正确**（与 shared §4.1 证据强度口径一致），但 **attachments 恒缺省** → `imgCount/fileCount/fileTokens` 恒 0，多模态信号（vision boost、longCtx boost）实际不生效（疑点 7）。

### 2.3 环节③ 经验读取与候选池过滤

- **判断逻辑**：
  1. `decisionStore.snapshot()` 取当前阈值 `{high, mid}` 与 `thresholdSource`（static/dynamic）——**先读后用**（[L154-155](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-orchestrator.ts#L154-L155)）。
  2. `filterPool(catalog, allowedModelIds)`：[L864-872](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-orchestrator.ts#L864-L872)
     - 先筛 `enabled && health !== 'down'`；
     - 白名单与可用池**无交集** → `poolFallback = true`，回落全量池（JEV-11 正交性登记，保证可用性）。
- **输出**：候选池 `pool` + `poolFallback` 标记。
- **触发事件**：`EXPERIENCE_RETRIEVED`（含 expVersion、sampleCount、thresholds、thresholdSource）。
- **核对结论**：**正确**。阈值先读后用、白名单回落可审计，均符合不变量。

### 2.4 环节④ 6 段状态装配（送入 Jev 之前）

- **代码**：[buildEngineeredState()](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-orchestrator.ts#L715-L761) → `assembleState`（[state-engineering.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/state-engineering.ts)）。
- **判断逻辑**：
  - `GOAL` = 用户原始 prompt；
  - `FACTS` = token 估算、图片/文档数、可用能力档位 `n_cap`；
  - `ARTIFACTS` = `[]`（无附件接入）；
  - `EVIDENCE` = 各意图关键词命中次数 + 复杂度/能力评分 + urgency/budget 先验（`verified:false`）；
  - `CONSTRAINTS` = 预算上限/延迟上限/白名单收窄的自然语言描述；
  - `OPTIONS` = **实时目录**重建的模型菜单（含能力标签）；
  - `stateVersion` 钉住 `requestId:决策库版本`，保证同状态决策可复现（JEV-16）。
- **核对结论**：**正确**。「结论不得冒充证据」由 `assembleState` 强校验，FACTS/EVIDENCE 分离清晰。

### 2.5 环节⑤ Jev 五问决策（真实 Jev + 降级链）

- **代码**：[decide()](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-orchestrator.ts#L624-L699)、[jev-http-adapter.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/jev-http-adapter.ts)、[jev-routing.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/jev-routing.ts)。
- **输入**：prompt、evidence、候选池、阈值、preference。
- **判断逻辑**：
  - 五问单次批量（JEV-3）：`choice×1`（intent）+ `score×2`（complexity、capability）+ `noul×2`（urgency、budget）；
  - `normalizeAnswers`：score 归一化为 `score/(levels−1)`；noul 为概率 P；
  - `deriveConfidence`（[L562-571](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/jev-http-adapter.ts#L562-L571)）：**优先取 choice 的 `evidenceStrength`**，否则取各答案强度均值；
  - `buildJevProfile`：产出 `{intent, complexity, capability, urgency, budget, confidence, model}` 请求画像；
  - **降级链**：Jev 调用失败 → `JEV_FALLBACK`（`degraded:true`）→ `answerQuestionsLocally` 本地重实现（`decisionSource=RULE_FALLBACK`），并用本地 `extractFeatures` 构造等价画像，保证下游先验计算一致。
- **输出**：`{decisionId, confidence, jevRecommendation(=intent), answers, rationale, decisionSource, profile, callLatencyMs, jevUsage}`。
- **核对结论**：**降级链与来源标注正确**（JEV-1/JEV-7）。疑点：confidence 口径（见疑点 4）。

### 2.6 环节⑥ 硬约束门（8 步）

- **代码**：[constraint-selector.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/constraint-selector.ts) `evaluateConstraints` / `selectEligible`。
- **判断逻辑**（固定顺序，首个失败步记为 `primaryEliminationReason`）：

  | 步 | 约束 | 失败码 | 编排器实际传参下是否生效 |
  |----|------|--------|--------------------------|
  | 1 | enabled 且 health ≠ down | MODEL_DISABLED / MODEL_UNAVAILABLE | ✅ 生效 |
  | 2 | 租户/用户许可 | MODEL_NOT_ALLOWED | ❌ 恒 true（未传） |
  | 3 | 模态与能力 | MODALITY_UNSUPPORTED / CAPABILITY_MISSING | ❌ 恒 true（`requiredModalities: []`） |
  | 4 | 上下文/输出上限 | CONTEXT_LIMIT_EXCEEDED | ❌ 恒 true（未传） |
  | 5 | 数据与区域（**混入 riskPolicy 判定**） | DATA_POLICY_MISMATCH / REGION_NOT_ALLOWED | ✅ 生效 |
  | 6 | 风险与安全 | RISK_POLICY_BLOCKED | ✅ 生效 |
  | 7 | 预算与配额 | BUDGET_EXCEEDED / COST_UNKNOWN | ⚠️ 部分生效（见疑点 1） |
  | 8 | 延迟硬上限 | LATENCY_LIMIT_EXCEEDED | ✅ 生效（`p95LatencyMs ≤ maxLatencyMs`） |

- **回落**：`eligible` 为空且池非空 → `hardConstraintFallback=true`（原因 `all_candidates_eliminated`），`usable = pool`（[L201-216](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-orchestrator.ts#L201-L216)）；池为空 → `ROUTE_FAILED(no_candidate)`。
- **触发事件**：每个淘汰模型发 `CONSTRAINT_FILTERED`；通过后发 `CONSTRAINT_GATE_PASSED`（含 `jevRecommendationEliminated`、`constraintFallback`）。
- **核对结论**：**主链路正确**（硬约束优先于 Jev 建议、回落可审计）。疑点：Step 5/6 职责混淆（疑点 3）、Step 7 预算失效（疑点 1）。

### 2.7 环节⑦ 先验注入 + 加权打分 + softmax

- **代码**：[scoreModels.ts](file:///d:/TREAWork/JevOmniRouter/packages/shared/src/scoreModels.ts)、[tieBreak.ts](file:///d:/TREAWork/JevOmniRouter/packages/shared/src/tieBreak.ts)、[jev-routing.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/jev-routing.ts)。
- **判断逻辑**：
  1. **先验修正**（softmax **之前**注入，SCORE-3）：`delta = Σ w_i·(fit_i − 0.5)`，权重 `intentMatch 0.6 / complexityFit 0.4 / capabilityFit 0.25 / urgencyFit 0.2 / budgetFit 0.3`，夹在 ±`EXP_CORR_MAX=4.0`（[L60-69](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/jev-routing.ts#L60-L69)）；
  2. **raw 分**：`raw = w_cap·capability + w_qual·quality + w_cost·cost + w_lat·latency − 26·load^2.2 + priorDelta`（保留 6 位小数）；
  3. **策略权重**（`buildPolicy`，[L875-886](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-orchestrator.ts#L875-L886)）：economy `0.2/0.2/0.35/0.25`；balanced `0.25×4`；quality `0.35/0.35/0.15/0.15`；权重和 ≠1 时归一化；
  4. **自适应温度 softmax**：`T = T0·(1 + α·spread)`，`T0=1`、`α=0.5`，`spread = max(raw)−min(raw)`；
  5. **双序契约**（MODEL-3）：输出同时带 `catalogIndex`（输入序）与 `rankIndex`（raw 降序），身份查询一律走 catalogIndex；
  6. **tieBreak**：raw 降序 → capability 降序 → cost 升序 → latency 升序 → modelId 字典序（ε=1e-9）。
- **输出**：`scores.byRankOrder`（含 raw/probability/rankIndex）、`ranked[0]` = 暂定 winner、`distribution`。
- **核对结论**：**正确**。先验注入点唯一、双序契约、tie-break 全序均符合规范。疑点：`load` 恒 0 导致负载降权项恒 0（疑点 9）。

### 2.8 环节⑧ 置信度 → 三档路由 + ESCALATE 免费规则

- **判断逻辑**（[L268-274](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-orchestrator.ts#L268-L274)、[L309-360](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-orchestrator.ts#L309-L360)）：
  1. **置信度选取**：`decisionSource=TYPE_SAFE_JEV` 且 `confidence>0` → 用 Jev 自评；否则用本地 `calibrate(features.overall)`；
  2. **calibrate 曲线**（[calibrate.ts L35-45](file:///d:/TREAWork/JevOmniRouter/packages/shared/src/calibrate.ts#L35-L45)）：`conf = 0.35 + 0.62·(1−e^{−2.6s})/(1−e^{−2.6})`，夹 `[0.35, 0.97]`，round 2 位；
  3. **routeTier**（[routeTier.ts L42-53](file:///d:/TREAWork/JevOmniRouter/packages/shared/src/routeTier.ts#L42-L53)）：`c ≥ high` → ROUTE；`c ≥ mid` → GATE；否则 ESCALATE；NaN/Infinity → ESCALATE；`high/mid` 夹取保证 `high ≥ mid`；
  4. **阈值来源**：默认静态 `{high: 0.82, mid: 0.60}`；或 DecisionStore 动态（见 2.10）；
  5. **ESCALATE 分支（本轮增补规则）**：可售模型中 `inputPricePer1k=0 && outputPricePer1k=0` 视为免费；`ranked` 中第一个免费模型替换 winner（降本优先）；随后 `ROUTE_ESCALATED`，**不自动执行**，落库 `status='cancelled'`（转人工复核）。
- **触发事件**：`JEV_DECISION_READY`（含 confidence/routeTier/thresholds/candidateScores/priorDeltas）→ `ROUTE_ESCALATED` 或 `MODEL_SELECTED`。
- **核对结论**：**档位判断、ESCALATE 不执行、免费模型优先三处均正确**。疑点：confidence 口径不一致（疑点 4）；`confidence=0` 回落时 `decisionSource` 仍标 `TYPE_SAFE_JEV`（P3，语义瑕疵）；免费模型与预算约束的联动缺陷（疑点 1 关联）。

### 2.9 环节⑨ 模型执行与 tool_call 循环

- **判断逻辑**（[L378-473](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-orchestrator.ts#L378-L473)、[model-gateway.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/model-gateway.ts)、[builtin-tools.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/builtin-tools.ts)）：
  1. **消息装配**：`buildMessagesWithTools` = system（「直接回答、实时信息主动调工具」）+ user prompt；`tools = BUILTIN_TOOLS`（`get_weather`、`web_search`）；
  2. **循环**：`MAX_TOOL_ROUNDS=3`；round 0 注入 `tools` + `tool_choice:'auto'`；round ≥1 回传 `assistant(tool_calls)` + `role:'tool'` 结果，**不再注入 tools**；
  3. **工具执行**：`executeTool` JSON.parse 参数 → 分发 → 失败返回 `{error}` JSON 字符串（不中断循环）；
  4. **无 tool_calls** → 视为最终答案退出循环；
  5. **超时**：`computeTimeout = round(p95LatencyMs × 2)`；**计费**：`cost = (promptTokens/1000)·inPrice + (completionTokens/1000)·outPrice`；
  6. **用量兜底**：网关未上报 usage 时按 `estimateTokens`（len/4）估算，并以 `usageSource:'estimated'` 显式标注；
  7. `MODEL_COMPLETED` 携带完整 `result` 作终态兜底（SSE 增量丢失时前端可回填）。
- **触发事件**：`MODEL_CALL_STARTED` → `MODEL_STREAMING`（增量 + 工具进度提示）→ `MODEL_COMPLETED`；异常发 `ROUTE_FAILED(provider_error)`。
- **核对结论**：**循环、工具回传、用量兜底均正确**。疑点：Responses API 通道丢失 tools（疑点 2）、reasoning_content 回落（疑点 5）、finishReason 粘滞（疑点 10）、断流不重试（疑点 11）。

### 2.10 环节⑩ 落库闭环与动态阈值

- **判断逻辑**（[finishStores](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-orchestrator.ts#L768-L835)、[decision-store.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/decision-store.ts)）：
  1. `DecisionStore.recordDecision`：累计统计（被选/候选次数、概率和、置信度和、延迟和）+ 最近 N 条明细，**原子写**（tmp + rename），并复算动态阈值；
  2. `recomputeThresholds`（[L374-397](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/decision-store.ts#L374-L397)）：`n < 12` → 沿用静态基线（`thresholdSource='static'`）；否则 `high = clamp(p80, 0.6, base.high)`、`mid = clamp(p50, 0.4, high−0.05)`；
  3. `modelInfoStore.rescore`：刷新各模型决策区分度评分（profileSpread/winConcentration/evidenceConfidence，冷启动仅 profileSpread）；
  4. `HistoryStore.append`：按小时桶写历史（含 prompt 摘要、事件序列、执行统计、结果）；
  5. `EXPERIENCE_SAVED`：`outcomeStatus = success ? 'pending' : 'disputed'`。
- **核对结论**：**闭环设计正确**（先读后用、热更新、可审计）。疑点：动态阈值复算的样本口径与注释不符（疑点 6）。

### 2.11 环节⑪ 前端展示（SSE → 3D 星图高亮）

- **判断逻辑**：
  1. [client.ts L121-150](file:///d:/TREAWork/JevOmniRouter/packages/frontend/src/api/client.ts#L121-L150)：必须按**具名事件** `addEventListener`（14 类），`onmessage` 仅作裸帧兜底；EventSource 原生断线重连；
  2. [routeEventReducer.ts](file:///d:/TREAWork/JevOmniRouter/packages/frontend/src/store/routeEventReducer.ts)：`EVENT_NODE_MAP` 点亮节点；`MODEL_NODE_EVENTS`（MODEL_CALL_STARTED/MODEL_SELECTED/MODEL_STREAMING）按 `payload.modelId` 命中厂商星球；`MODEL_SELECTED` 同时置 `winnerModelId` + `isWinner`；
  3. [StageView.vue L70-75](file:///d:/TREAWork/JevOmniRouter/packages/frontend/src/components/StageView.vue#L70-L75)：`winnerIdx = vendorGroups.findIndex(g => g.modelIds.includes(wid))`；`modelProbs` 优先取 `JEV_DECISION_READY` 的真实概率（缺失时按 winner+confidence 粗估）；
  4. [computeRunFrontend.ts L242-246](file:///d:/TREAWork/JevOmniRouter/packages/frontend/src/three/computeRunFrontend.ts#L242-L246)：score 阶段 winner 辉度 ≥2.2，select 起 2.5，execute 起 3.0（保证 winner 全程可辨）；
  5. [TreeScene.ts L1120-1127](file:///d:/TREAWork/JevOmniRouter/packages/frontend/src/three/TreeScene.ts#L1120-L1127)：`candIdx = k`（本轮修复），`isWinner = planet.modelIds.includes(winnerModelId)`。
- **核对结论**：**本轮索引错位修复后，选中模型与高亮星球严格一致**（端到端验证：选中 gpt-5.5 → OpenAI 星球高亮，其余暗淡）。

---

## 3. 逻辑核对结论汇总

### 3.1 判定正确的关键不变量

| # | 不变量 | 实现位置 | 结论 |
|---|--------|----------|------|
| 1 | 先验 MUST 在 softmax 之前注入（SCORE-3） | scoreModels L100-102 | ✅ |
| 2 | 双序契约：catalogIndex / rankIndex 双视图（MODEL-3） | scoreModels L111-136 | ✅ |
| 3 | 硬约束淘汰优先于 Jev 建议（CONSTRAIN-3） | route-orchestrator L182-216 | ✅ |
| 4 | ESCALATE 低置信度 MUST NOT 自动执行 | route-orchestrator L309-360 | ✅ |
| 5 | 约束回落（白名单无交集/全淘汰）可审计登记（JEV-11） | constraintFallback 字段链路 | ✅ |
| 6 | 决策库阈值先读后用；落库原子写不丢决策 | decision-store L399-406 | ✅ |
| 7 | usage 缺失时估算兜底并标注来源 | route-orchestrator L530-542 | ✅ |
| 8 | 取消/失败路径均落 `ROUTE_FAILED` 并写历史 | route-orchestrator L474-528 | ✅ |
| 9 | tool 结果 JSON 化回传，工具失败不中断循环 | route-orchestrator L450-471 | ✅ |
| 10 | 免费模型定义（input/output price 均 0）与 ESCALATE 优先规则 | route-orchestrator L310-317；app-config FREE_MODEL_PATTERNS | ✅ |

### 3.2 疑点清单（按严重度）

#### P1-1 Step 7 预算约束失效，且与「免费模型优先」规则冲突

- **位置**：[constraint-selector.ts L206-225](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/constraint-selector.ts#L206-L225)。
- **问题**：`budgetOk = !constraints.budgetUsd || costKnown` —— 只判断「成本是否已知」，**从未把估算成本与 `budgetUsd` 比较**。因此：
  - `BUDGET_EXCEEDED` 分支是**死代码**，预算上限对任何模型都不设防；
  - 反向地，免费模型（price=0）`costKnown=false`，只要请求带了 `budgetUsd`，免费模型会在 Step 7 以 `COST_UNKNOWN` 被淘汰 —— **ESCALATE「人工决策优先免费模型」规则在带预算的场景下永远不可能生效**（免费模型根本进不了打分环节）。
- **建议**：区分「价格为 0（已知且免费）」与「价格未知」两种语义：免费模型 `costKnown` 应置 true 且 `estimatedCost=0`；`budgetOk = !budgetUsd || estimatedCost ≤ budgetUsd`（用 `estimateTokens` 粗估一次请求成本即够用）。

#### P1-2 Responses API 通道丢失 function calling 能力

- **位置**：[llm-provider-adapter.ts L323-332](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/llm-provider-adapter.ts#L323-L332) `buildResponsesPayload`。
- **问题**：只拼接 `system` + `user` 消息，**既不注入 `tools`/`toolChoice`，也丢弃 `role:'tool'` 与带 `tool_calls` 的 assistant 消息**。一旦 `useResponsesApi=true`（默认 false，可配置开启），工具调用静默失效：模型看不到工具定义，多轮 tool_call 历史也被抹掉。
- **建议**：Responses 通道补齐 `tools` 注入与 tool 消息的 `input` 数组映射（`function_call`/`function_call_output`），或在开启 Responses API 时显式关闭工具循环并在日志告警。

#### P2-3 Step 5 / Step 6 风险策略职责混淆，且 HTTP 层 riskLevel 不透传

- **位置**：[constraint-selector.ts L170-204](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/constraint-selector.ts#L170-L204)。
- **问题**：Step 5（Data & region）里 `dataOk = constraints.riskPolicy !== 'block'` 把风险策略归进了数据/区域步。当 `regionOk=true` 且 `riskPolicy='block'` 时，Step 5 先失败，`primaryEliminationReason` 被记为 `DATA_POLICY_MISMATCH`（而非 Step 6 的 `RISK_POLICY_BLOCKED`），淘汰原因误报。
- **关联**：编排器调用 `selectEligible` 时从不传 `riskPolicy`（[L182-190](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-orchestrator.ts#L182-L190)），HTTP 请求体的 `riskLevel` 字段也被丢弃 —— 该步骤实际恒不触发。
- **建议**：Step 5 只判区域/数据；Step 6 独享 riskPolicy；同时把 `CreateRouteRequest.constraints.riskLevel` 映射为 `riskPolicy` 透传。

#### P2-4 真实 Jev 路径的置信度未经 calibrate，两条路径口径不一致

- **位置**：[route-orchestrator.ts L268-274](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-orchestrator.ts#L268-L274) + [jev-http-adapter.ts L562-571](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/jev-http-adapter.ts#L562-L571)。
- **问题**：`TYPE_SAFE_JEV` 直接用 `choice.evidenceStrength`（`deriveConfidence` 只 round2，**未 clamp 到 [0,1]、未过 [0.35,0.97] 校准曲线**）；降级路径用 `calibrate(features.overall)`。而 `routeTier` 的 0.82/0.60 阈值是为**校准置信度**设计的。Jev 自评若系统性偏高/偏低，档位判定会与降级路径不同尺度。
- **建议**：统一口径 —— 两条路径都过 `calibrate()`；或明确区分「模型自评」与「系统校准」两个字段，阈值只消费校准值。

#### P2-5 `extractDelta` 回落 `reasoning_content`，思考独白流入正文

- **位置**：[llm-provider-adapter.ts L386-398](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/llm-provider-adapter.ts#L386-L398)。
- **问题**：`content` 为空时把 `delta.reasoning_content` 当正文增量返回。推理模型的内心独白（如 `**Explaining closure definition** It sounds like...`）会混入最终结果与 SSE 流。
- **建议**：仅在整轮结束后 `content` 与 `reasoning_content` 均无增量时才回落，或将 reasoning 单独通道暂存、不进 `result`。

#### P2-6 动态阈值复算样本口径与注释不符（低置信度样本会拉低 mid）

- **位置**：[decision-store.ts L374-397](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/decision-store.ts#L374-L397)。
- **问题**：注释称「只用有明确档位判定的样本（ESCALATE 不参与抬高门槛）」，但代码只过滤了 `Number.isFinite`，**未按 tier 排除 ESCALATE**。大量低置信度决策进入 p50 会把 `mid` 阈值拉低，与「中枢越熟悉、门槛越高」的设计意图相反。
- **建议**：`confs` 先 `.filter(r => r.routeTier !== 'ESCALATE')` 再取分位。

#### P2-7 附件证据未接入，多模态信号恒为 0

- **位置**：[route-orchestrator.ts L165](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-orchestrator.ts#L165) `extractPromptEvidence(prompt)` 未传 attachments。
- **问题**：`imgCount/fileCount/fileTokens` 恒 0，下游 vision boost、longCtx boost、ARTIFACTS 段全部空转 —— 图片/长文档请求的路由特征缺失。
- **建议**：若产品不含附件上传，可显式在代码注释与状态装配中标注「MVP 阶段无附件」；若含，则从请求体/INGEST 段填入真实统计。

#### P3-8 p95 延迟是「反推值再乘 2」的恒等式，无真实 P95 语义

- **位置**：[model-info-store.ts L310-315](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/model-info-store.ts#L310-L315)（`p95LatencyMs = round(timeoutMs/2)`）+ [model-gateway.ts L270-272](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/model-gateway.ts#L270-L272)（`computeTimeout = p95 × 2`）。
- **问题**：实时清单路径下超时恰等于 `timeoutMs`（恒等式），`defaultTimeoutMs`/`timeoutMultiplier` 实际不参与；Step 8 的延迟硬约束判据也是配置超时的一半，而非真实 P95。
- **建议**：从网关或探测接口采集真实 P95 后写回 `profileVersion` 触发的目录刷新；至少在文档/注释中明确「p95 为反推占位」。

#### P3-9 `load` 恒 0，负载降权项从未生效

- **位置**：[model-info-store.ts L313](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/model-info-store.ts#L313) `load: 0`。
- **问题**：`26 × load^2.2` 恒 0，`prompt-evidence` 之外唯一的拥塞避让机制空转；打分实际只由四权重项与先验决定。
- **建议**：接入网关在途请求数/队列深度作为 load 源；无数据前可在注释中标注该项暂缺。

#### P3-10 `finishReason` 覆盖逻辑粘滞

- **位置**：[llm-provider-adapter.ts L259](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/llm-provider-adapter.ts#L259) `if (fr && fr !== 'stop') finishReason = fr`。
- **问题**：中间任意块携带非 'stop' 的 finishReason 会被粘滞到流末，可能把正常流误判为 `tool_calls`/`length`。
- **建议**：只接受流末（或最后一个 content block）的 finishReason，或按 `chunk.finishReason` 语义显式判优。

#### P3-11 已产出内容后 SSE 断流按 `length` 完成、不重试

- **位置**：[llm-provider-adapter.ts L287](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/llm-provider-adapter.ts#L287)（流末 done chunk 固定 `finishReason:'length'`）。
- **问题**：与 `streamInvoke` 注释口径一致（不重试），但网络中断被计为「正常截断完成」，`status` 仍为 success，可能掩盖真实失败并产生半截结果。
- **建议**：区分「模型声明 length」与「连接异常中断」两种来源，后者走重试或 `ROUTE_FAILED`。

### 3.3 建议处理顺序

1. **P1-1**（预算失效 + 免费模型被误淘汰）：直接影响用户约束与已上线的 ESCALATE 降本规则，优先修。
2. **P1-2**（Responses API 丢 tools）：配置切换即静默失效，修复成本低，建议随 P1-1 一并处理。
3. **P2 组**（P2-3 ~ P2-7）：均为「语义正确但会误导判定/展示」类，建议排入下一迭代；其中 P2-6 是注释与代码不一致，改一行过滤即可。
4. **P3 组**：当前多为「能力占位」性质，建议以注释/文档显式标注，待真实数据源接入后闭环。

---

## 附：本核对覆盖的代码文件

| 层 | 文件 |
|----|------|
| 后端主链 | [route-orchestrator.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-orchestrator.ts)（883 行，全链路编排） |
| 后端接入 | [server.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/server.ts)、[route-api.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-api.ts) |
| 证据与先验 | [prompt-evidence.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/prompt-evidence.ts)、[jev-routing.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/jev-routing.ts)、[local-jev-reimpl.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/local-jev-reimpl.ts) |
| Jev 适配 | [jev-http-adapter.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/jev-http-adapter.ts) |
| 约束与打分 | [constraint-selector.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/constraint-selector.ts)、shared [scoreModels.ts](file:///d:/TREAWork/JevOmniRouter/packages/shared/src/scoreModels.ts) / [tieBreak.ts](file:///d:/TREAWork/JevOmniRouter/packages/shared/src/tieBreak.ts) / [calibrate.ts](file:///d:/TREAWork/JevOmniRouter/packages/shared/src/calibrate.ts) / [routeTier.ts](file:///d:/TREAWork/JevOmniRouter/packages/shared/src/routeTier.ts) / [extractFeatures.ts](file:///d:/TREAWork/JevOmniRouter/packages/shared/src/extractFeatures.ts) / [constants.ts](file:///d:/TREAWork/JevOmniRouter/packages/shared/src/constants.ts) |
| 执行 | [model-gateway.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/model-gateway.ts)、[llm-provider-adapter.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/llm-provider-adapter.ts)、[builtin-tools.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/builtin-tools.ts) |
| 状态装配 | [state-engineering.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/state-engineering.ts) |
| 存储 | [decision-store.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/decision-store.ts)、[history-store.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/history-store.ts)、[model-info-store.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/model-info-store.ts)、[model-catalog.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/model-catalog.ts)、[app-config.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/app-config.ts) |
| SSE/事件 | [sse-stream.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/sse-stream.ts)、[route-event.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-event.ts) |
| MCP 适配 | [mcp-server/index.ts](file:///d:/TREAWork/JevOmniRouter/packages/mcp-server/src/index.ts)、[backend-client.ts](file:///d:/TREAWork/JevOmniRouter/packages/mcp-server/src/backend-client.ts)（SSE 聚合到终态）、[tools/](file:///d:/TREAWork/JevOmniRouter/packages/mcp-server/src/tools)（6 个 tool） |
| 前端 | [api/client.ts](file:///d:/TREAWork/JevOmniRouter/packages/frontend/src/api/client.ts)、[store/routeEventReducer.ts](file:///d:/TREAWork/JevOmniRouter/packages/frontend/src/store/routeEventReducer.ts)、[components/StageView.vue](file:///d:/TREAWork/JevOmniRouter/packages/frontend/src/components/StageView.vue)、[three/TreeScene.ts](file:///d:/TREAWork/JevOmniRouter/packages/frontend/src/three/TreeScene.ts)、[three/computeRunFrontend.ts](file:///d:/TREAWork/JevOmniRouter/packages/frontend/src/three/computeRunFrontend.ts) |

---

## 附：MCP 无前端调用通道（`packages/mcp-server`）

同一套主链逻辑除前端外，还经 MCP 协议暴露给 AI 客户端，**不依赖任何页面**。MCP server 只做 HTTP/SSE 适配，决策逻辑仍全部在后端进程。

| MCP Tool | 对应主链环节 | 说明 |
|---|---|---|
| `jev_route_decide` | ①→⑩ 全链路 | `POST /v1/routes` + 订阅 SSE 直到终态，返回档位/置信度/选中模型/分布/模型回答 |
| `jev_constraints_audit` | ⑥ 硬约束门 | 直接复用后端的 `evaluateConstraints`（纯函数），本地逐模型跑 8 步，零成本 |
| `jev_score_explain` | ⑦⑧ 打分与分档 | 解释 softmax 分布、先验 Δ、阈值判定；按 `requestId` 可免费解释既有决策 |
| `jev_model_catalog` | 候选池供给 | `GET /v1/models`，含决策区分度与厂商分组 |
| `jev_experience_stats` | ③⑩ 经验读取/落库 | 决策库阈值 + per-model 胜率 + 档位分布 + 业界评分同步 |
| `jev_history_query` | ⑩ 落库闭环 | 历史库检索，支持单条完整明细 |

> 注：`POST /v1/routes` 是唯一的决策入口，后端**没有**"只决策不执行"的端点。故 `jev_score_explain` 在传入 `prompt` 时同样会触发完整编排（消耗一次模型调用）；只有传 `request_id` 解释既有决策时才免费。

