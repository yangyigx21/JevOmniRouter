# Jev 智能路由中枢判断逻辑及其与决策库、模型库的关系

> 依据当前工作树代码整理，覆盖 `RouteOrchestrator.run` 主链中 Jev 决策环节与三大存储的交互边界。
> 相关代码：[route-orchestrator.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-orchestrator.ts)、[jev-http-adapter.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/jev-http-adapter.ts)、[decision-store.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/decision-store.ts)、[model-info-store.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/model-info-store.ts)、[jev-routing.ts](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/jev-routing.ts)。

---

## 1. 结论速览

- **Jev 路由中枢判断的是「请求」**：这是一个什么意图、多复杂、需要什么能力、多紧急、多在意成本的请求，以及系统对这个判断**多有把握**——它**不指定最终模型**（CONSTRAIN-3）。
- **模型库回答「有哪些模型、各自什么画像」**：提供实时候选池（Jev 的 OPTIONS 菜单）与打分所需的模型画像。
- **决策库回答「门槛该设多高、历史经验如何」**：提供三档路由阈值（先读后用），并沉淀每次决策结果用于动态复算阈值。
- 三者信息在 `jevPriorDeltas → scoreModels → tieBreak` 处汇合产出最终 winner；模型的区分度评分与历史累计统计目前**只做展示与阈值闭环，不直接改变单次路由结果**。

---

## 2. Jev 智能路由中枢的判断逻辑

### 2.1 定位

Jev（System One `/decision` 的适配层）只判别请求特征，不评模型。它的输出是「请求画像 + 置信度 + 建议」，最终选型由本地打分与硬约束门决定；即使 Jev 给了建议（`jevRecommendation`），被硬约束淘汰时也只记录淘汰原因，不改写最终选择（[L182-216](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-orchestrator.ts#L182-L216)）。

### 2.2 五问原语（单次批量调用，JEV-3）

| 问题 | 原语类型 | 归一化 |
|------|---------|--------|
| intent 意图 | choice × 1 | 多选一胜者 |
| complexity 复杂度 | score × 2 | `score / (levels − 1)` |
| capability 所需能力 | score × 2 | 同上 |
| urgency 紧急度 | noul × 2 | 概率 P |
| budget 成本敏感 | noul × 2 | 概率 P |

### 2.3 输入

1. **6 段工程化状态**（[buildEngineeredState](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-orchestrator.ts#L715-L761)）：GOAL（用户原话）/ FACTS（token 估算、附件计数）/ ARTIFACTS / EVIDENCE（关键词命中、复杂度/能力评分、urgency/budget 先验）/ CONSTRAINTS（预算、延迟、白名单）/ OPTIONS（由实时目录重建的模型菜单，JEV-14）；
2. **候选模型池**（来自模型信息库）；
3. **当前路由阈值**（来自决策库，同时供 Jev 生成 rationale）；
4. **preference**（economy / balanced / quality，影响后续打分权重）。

### 2.4 输出三件套及各自去向

| 输出 | 内容 | 去向 |
|------|------|------|
| ① 请求画像 `profile` | `{intent, complexity, capability, urgency, budget, confidence, model}` | 喂给 `jevPriorDeltas`：与每个模型画像匹配做先验修正——`intentMatch 0.6 / complexityFit 0.4 / capabilityFit 0.25 / urgencyFit 0.2 / budgetFit 0.3`，每维 `(fit − 0.5)` 加权求和，夹 ±`EXP_CORR_MAX = 4.0`（[L60-69](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/jev-routing.ts#L60-L69)）；**在 softmax 之前**注入 `scoreModels` 的 raw 分（SCORE-3） |
| ② 置信度 `confidence` | [deriveConfidence](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/jev-http-adapter.ts#L562-L571)：优先 choice 的 `evidenceStrength`，否则各答案强度均值 | 经 `routeTier` 映射三档：`c ≥ 0.82 → ROUTE`；`c ≥ 0.60 → GATE`；`else → ESCALATE`（NaN 也归 ESCALATE）。ROUTE/GATE 自动执行；ESCALATE 转人工、不执行 |
| ③ jevRecommendation | 真实 Jev 路径 = intent（意图标签） | 仅建议性质（CONSTRAIN-3）：进入硬约束门的审计记录，最终 winner 由 `scoreModels + tieBreak`（raw 降序 → capability 降序 → cost 升序 → latency 升序 → modelId 字典序）产生 |

### 2.5 降级链

Jev 调用失败 → 发 `JEV_FALLBACK`（`degraded: true`）→ 回落 `answerQuestionsLocally` 本地重实现（`decisionSource = RULE_FALLBACK`）：用本地关键词/规则重答五问，并用本地 `extractFeatures + calibrate` 构造等价请求画像，保证下游先验计算与打分逻辑完全一致（[decide()](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-orchestrator.ts#L624-L699)）。降级路径的 `jevRecommendation` 来自本地决策的 `selectedRecommendation`。

---

## 3. 与决策库（DecisionStore）的关系

**决策库是「阈值供给方 + 经验沉淀方」，不参与单次模型选择。**

| 方向 | 内容 |
|------|------|
| **读（路由前）** | `snapshot()` 取当前 `{high, mid}` 与 `thresholdSource`，**先读后用**（[L154-155](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/route-orchestrator.ts#L154-L155)）；阈值随 decide 调用一并传给 Jev（用于 rationale 生成）；经验快照（样本数、先验概览）随 `EXPERIENCE_RETRIEVED` 下发 |
| **写（决策后）** | Jev 的决策结果——置信度、档位、概率分布、淘汰记录、约束回落登记——经 `finishStores` **热写回**决策库（原子写：临时文件 + rename，先落盘再返回）；随后触发 `recomputeThresholds` 动态复算阈值 |
| **边界** | ① 阈值只影响「档位判定」（执行/观察/转人工），不影响 winner 选择；② 历史累计统计（被选次数、胜率等）在 MVP 中仅用于展示与阈值复算，**不直接进入打分**——经验偏置目前只来自本次 Jev 画像（`jevPriorDeltas`），shared 层的 `priorDeltaFor` 回流尚未接入主链；③ 业界评分（LMArena 等）同样只展示 |

**动态阈值复算**（[recomputeThresholds](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/decision-store.ts#L374-L397)）：

- `n < 12` → 沿用配置基线 `{0.82, 0.60}`，`thresholdSource = 'static'`；
- `n ≥ 12` → `high = clamp(p80, 0.6, 基线high)`、`mid = clamp(p50, 0.4, high − 0.05)`，`thresholdSource = 'dynamic'`。

语义：中枢越熟悉某类请求，「有把握」的门槛越高，避免低置信度误路由。**复算的完整判断逻辑见 §4.3**。

---

## 4. 决策库自身的判断逻辑

### 4.1 数据形状（[DecisionStoreFile](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/decision-store.ts#L136-L153)）

| 字段 | 含义 |
|------|------|
| `thresholds` / `thresholdSource` | 当前路由阈值及其来源（`static` 基线 / `dynamic` 计算） |
| `totals.decisions` / `totals.byTier` | 累计决策数、按 ROUTE/GATE/ESCALATE 分档计数 |
| `models[modelId]` | per-model 累计统计（见 4.2） |
| `recent[]` | 最近决策明细环（倒序，上限 `DECISION_RECENT_LIMIT = 200`） |
| `industrySync` | 最近一次业界评分同步摘要（matched/unmatched/warnings） |

### 4.2 每次决策落库时的更新逻辑（[applyEntry](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/decision-store.ts#L335-L362)）

`recordDecision(entry)` 按顺序做三件事：`applyEntry` 合并统计 → `recomputeThresholds` 复算阈值 → `flush` 原子落盘。

**per-model 统计更新**：

- 对 `entry.distribution` 中**每个候选模型**：`candidateCount += 1`、`probabilitySum += probability`、`avgProbability = probabilitySum / candidateCount`、`winRate = selectedCount / candidateCount`；
- 对 **winner**（`selectedModelId`）：`selectedCount += 1`、`confidenceSum += confidence`、`avgConfidence = confidenceSum / selectedCount`、`latencySumMs += execution.latencyMs`（有执行信息时）、`lastSelectedAt = createdAt`，并重算 `winRate`。

**全局统计更新**：`totals.decisions += 1`、`byTier[routeTier] += 1`、`recent.unshift(entry)`（超出 200 条从头截断）。

注意：候选计数以**概率分布条目**为单位（未进分布的模型不计数）；`avgConfidence` 只统计被选时刻的置信度。

### 4.3 动态阈值复算的判断逻辑（[recomputeThresholds](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/decision-store.ts#L374-L397)）

```
n = totals.decisions
├─ n < 12 ─────────────────→ thresholds = 配置基线；source = 'static'
└─ n ≥ 12：
     confs = recent[].confidence 过滤非有限值 → 升序
     ├─ confs 为空 ────────→ thresholds = 配置基线；source = 'static'
     └─ p80 = quantile(confs, 0.8)   # 线性插值分位数
        p50 = quantile(confs, 0.5)
        high = clamp(p80, 0.6, 基线.high)      # 只抬不超基线，防止门槛漂移失控
        mid  = clamp(p50, 0.4, high − 0.05)    # 保证 mid < high，三档划分有效
        thresholds = { round2(high), round2(mid) }；source = 'dynamic'
```

相关常量：

| 常量 | 值 | 作用 |
|------|----|------|
| `DECISION_RECENT_LIMIT` | 200 | 明细环上限；**分位数实际基于最近 ≤200 条** |
| `THRESHOLD_DYNAMIC_MIN_SAMPLES` | 12 | 进入动态计算的累计决策数门槛 |
| `THRESHOLD_FLOOR_HIGH` | 0.6 | `high` 下探下限（避免全部落 ESCALATE） |
| `THRESHOLD_FLOOR_MID` | 0.4 | `mid` 下探下限 |

核对提示（与《prompt-routing-flow》疑点 6 对应）：注释声明「ESCALATE 样本不参与抬高门槛」，但代码只过滤了 `Number.isFinite`，**未按档位排除 ESCALATE**——低置信度样本会进入 p50 并把 `mid` 拉低，与设计意图相反，修复只需在 `confs` 前加 `.filter(r => r.routeTier !== 'ESCALATE')`。

### 4.4 写入与一致性保证

| 机制 | 实现 | 目的 |
|------|------|------|
| 写串行化 | `writeChain` Promise 队列（[enqueue](file:///d:/TREAWork/JevOmniRouter/packages/backend/src/decision-store.ts#L324-L332)） | 同一次决策的 read-modify-write 不交错 |
| 原子写 | `flush`：临时文件 + `rename` | 崩溃不丢决策（先落盘再返回） |
| 加载容错 | `loadFromDisk`：缺失/损坏 → 空库（损坏文件备份 `.corrupt-<ts>`） | 坏文件不阻塞启动 |
| `attachExecution` | 只按 requestId 补执行明细，**不改任何统计** | 执行结果回写不污染经验数据 |
| `applyIndustryRatings` | 权威覆盖：本次清单外模型的旧评分被清除 | 下榜模型不永久保留过期评分 |
| `tierFor` | `routeTier(confidence, 当前阈值)` | 编排器与前端共用同一档位口径 |

---

## 5. 与模型信息库（ModelInfoStore）的关系

**模型库是「候选池与模型画像的提供方」，路由主链对它也是单向读取。**

| 方向 | 内容 |
|------|------|
| **读（决策前）** | `catalogEntries()` 提供实时候选：优先 Models API 实时清单，失败回落配置文件，再回落内置种子（6 个种子模型），并筛掉 `enabled=false` 或 `health='down'` 的项。该池构成：① Jev 的 **OPTIONS 段菜单（实时重建，避免在过期菜单上决策）**；② 先验匹配与打分所需的模型画像（capability/quality/cost/latency/price/contextWindow/capabilityTags） |
| **写（决策后）** | `rescore(decisionStore.snapshot())`：用决策库累计统计刷新各模型的**决策区分度评分**（`profileSpread 0.45 / winConcentration 0.35 / evidenceConfidence 0.20`，冷启动仅 profileSpread 并标 `coldStart`），并对齐每日凌晨同步的业界评分 |
| **边界** | 区分度评分与业界评分**只服务前端「模型库」页签展示与审计，不回流进路由打分**；模型库自身的变化（profileVersion 变更）也不触发经验重置之外的路由行为 |

---

## 6. 三者关系图

```
        ┌──────────────── 模型信息库 ────────────────┐
        │ 实时清单 + 模型画像(cap/cost/latency/price) │
        │        │OPTIONS 菜单(实时重建)   ▲rescore   │
        │        ▼                      │(仅展示)    │
        │  ┌──── Jev 路由中枢 ────┐      │            │
        │  │ 五问→请求画像        │      │            │
        │  │ +置信度+建议        │      │            │
        │  └──┬──────────▲───────┘      │            │
        │     │画像      │阈值(先读后用) │            │
        │     ▼          │              │   ┌── 决策库 ──────────────┐
        │  先验注入→打分  │              └───┤ 动态阈值 + 累计统计      │
        │  scoreModels   │                  │ (决策结果热写回→复算)   │
        │     │          │                  └────────────────────────┘
        │     ▼          │                      ▲
        │  winner + 三档路由(tieBreak 决胜) ────┘ 档位/分布写回
        └─────────────────────────────────────────┘
```

## 7. 关键设计边界小结

| 问题 | 答案 |
|------|------|
| Jev 能直接选模型吗？ | 不能。只给请求画像与置信度；`jevRecommendation` 仅建议，硬约束优先（CONSTRAIN-3） |
| 决策库能改变 winner 吗？ | 不能。只决定三档路由阈值（执行/观察/转人工） |
| 模型库的区分度/业界评分影响路由吗？ | 不影响。仅前端展示与审计 |
| 历史经验（胜率统计）影响单次打分吗？ | MVP 中不影响。`jevPriorDeltas` 只用本次 Jev 画像；`priorDeltaFor` 经验回流未接主链 |
| 三个库的更新时序？ | 先读（阈值/候选池）→ 决策 → 写回（决策库 → 模型库重评分）→ 下次路由生效 |
| 决策库自身如何更新？ | `applyEntry` 合并 per-model/全局统计 → `recomputeThresholds` 复算阈值 → `flush` 原子落盘（详见 §4） |

## 8. 无前端访问通道（MCP）

上述判断逻辑除经前端页面消费外，还通过 `packages/mcp-server`（MCP 协议适配层）暴露给 AI 客户端。该层**不复制任何判断逻辑**：

- **决策类**（`jev_route_decide` / `jev_score_explain`）→ 走 `POST /v1/routes` + SSE，结果与页面完全一致。
- **审计类**（`jev_constraints_audit`）→ 直接 import 后端的 `evaluateConstraints` 纯函数，零成本、与真实流水线同源。
- **只读类**（`jev_model_catalog` / `jev_experience_stats` / `jev_history_query`）→ 复用 `GET /v1/models`、`/v1/decision-store`、`/v1/history*`。

因此上表所有"设计边界"结论对 MCP 通道同样成立。详见 [README MCP Server 章节](file:///d:/TREAWork/JevOmniRouter/README.md) 与 [prompt-routing-flow.md](file:///d:/TREAWork/JevOmniRouter/docs/prompt-routing-flow.md) 附录。

