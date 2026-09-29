# JevRouter — 技术设计（design · 融合版）

- **变更 ID**：`jev-router-fusion`
- **文档定位**：本文档回答「怎么做」。所有需求编号引用 `spec.md`（§3 索引与 §4 需求）。本阶段**不交付代码实现**（`spec.md` 约束 C7）。
- **四方关系**：`proposal.md`（为什么）→ `spec.md`（做什么，唯一事实锚点）→ `design.md`（怎么做）→ `tasks.md`（谁在何时做）。

---

## 1. 文档定位与四方关系

| 文档 | 职责 | 与本文档的接口 |
| --- | --- | --- |
| `proposal.md` | Why / 目标 / 决策 / 风险 | 本文档 §11 的 ADR 逐条对应提案 D1–D19 |
| `spec.md` | 需求与场景（唯一编号源） | 本文档所有 `[ID]` 引用其编号 |
| `design.md`（本文档） | 架构 / 分层 / 算法 / 契约 | 为 `tasks.md` 提供落点 |
| `tasks.md` | 阶段 / 任务 / 门禁 | 引用本文档模块名与 `spec.md` 需求号 |

**一致性契约**：`spec.md` §0.3 的 C5 要求本文档覆盖全部需求域的分层落点；§3 的域-层矩阵即为核对依据。

---

## 2. 架构总览

### 2.1 双形态架构

```
┌──────────────────────── 云原生形态（默认 / 生产） ────────────────────────┐
│                                                                            │
│  ┌──────────────── Web / 3D Client ────────────────┐                       │
│  │ Prompt │ Inline Result │ 3D Route Graph │ Decision │ History/Replay   │
│  │ （逻辑层：extractFeatures / calibrate / scoreModels / priorDeltaFor） │
│  └───────────────────────┬─────────────────────────┘                       │
│                          │ REST + SSE                                       │
│                          ▼                                                  │
│  ┌──────────────── JevRouter API Gateway ───────────┐                       │
│  │ Auth │ Tenant │ Request Context │ Validation │ Rate Limit │           │
│  └───────────────────────┬─────────────────────────┘                       │
│                          ▼                                                  │
│  ┌──────────────── Routing Orchestrator ────────────┐                       │
│  │ state machine │ idempotency │ timeout │ cancel │ trace │              │
│  └───┬───────────┬──────────────┬───────────────┬────┘                     │
│      │           │              │               │                          │
│      ▼           ▼              ▼               ▼                          │
│ ┌─────────┐ ┌──────────┐ ┌────────────┐ ┌──────────────┐                  │
│ │Experience│ │ TypeSafe │ │ Model      │ │ Event Bus    │                  │
│ │Retrieval │ │ Jev      │ │ Catalog /  │ │ (SSE 广播)   │                  │
│ │          │ │ Adapter  │ │ Policy     │ │              │                  │
│ └────┬────┘ └────┬─────┘ └─────┬──────┘ └──────────────┘                  │
│      │           │             │                                          │
│      └───────────┼─────────────┘                                          │
│                  ▼                                                          │
│         ┌──────────────────┐   ┌──────────────────┐   ┌───────────────┐   │
│         │ Decision         │──▶│ Constraint       │──▶│ Model Gateway │   │
│         │ Validator        │   │ Selector         │   │ (provider     │   │
│         │ (JSON Schema)    │   │ (8 步硬约束+评分) │   │  adapters)    │   │
│         └──────────────────┘   └──────────────────┘   └───────┬───────┘   │
│                                                                ▼           │
│         ┌──────────────────┐   ┌──────────────────┐      ┌─────────┐      │
│         │ Experience Store │◀──│ Outcome          │◀─────│ Models  │      │
│         │ (+版本/回滚/校验) │   │ Evaluator        │      └─────────┘      │
│         └──────────────────┘   └──────────────────┘                        │
└────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────── 离线单文件形态（降级） ──────────────────────────┐
│  单个自包含 HTML；无后端；Jev = LocalJevReimpl（确定性重实现）；           │
│  经验状态落本地；人工审批降级为单端审批并显式标注；                        │
│  复用同一份纯逻辑层代码（extractFeatures/calibrate/scoreModels/priorDeltaFor）│
└────────────────────────────────────────────────────────────────────────────┘
```

> **实现现状（2026-09-30 核对）**：本图描述的「双形态」在当前工程中表现为
> **pnpm monorepo（`packages/{shared,backend,frontend}`）+ 后端 HTTP 服务**（`server.ts`，Express，port 3000），
> 前端经 Vite dev server（port 5173）以 `fetch` 调 `/v1/*`；单文件离线形态尚未产出构建产物。
> 纯逻辑层（`packages/shared`）确由前后端共同依赖，`ARCH-2` 的「共用同一逻辑层」已成立。
> 本图其余部分（Jev = LocalJevReimpl、显式标注降级）仍为有效设计约束。

### 2.2 模块职责与禁止职责

| 模块 | 负责 | 禁止负责 | 对应需求 |
| --- | --- | --- | --- |
| Prompt UI | 输入、附件、内联结果 | Jev 决策、供应商调用 | `INGEST-*` `RESULT-*` |
| Routing Orchestrator | 生命周期、状态机、超时、取消、幂等、trace | 伪造 Jev Decision | `ARCH-1` `EVENT-*` |
| Experience Retrieval | 相似任务与聚合表现检索 | 修改生产策略、阻塞主流程 | `EXP-1` `JEV-1` |
| TypeSafeJevAdapter | 调用 System One、认证、超时、五问 fan-out、Schema 映射 | 最终授权模型调用 | `JEV-1` `JEV-3` |
| LocalJevReimpl | 离线形态确定性重实现 | 冒充真实 Jev | `JEV-8` |
| Decision Validator | Schema、版本、字段约束 | 自行生成「替代 Jev」结果 | `JEV-6` |
| Constraint Selector | 8 步硬约束、候选过滤、软评分、决胜、最终选择 | 绕过 policy | `CONSTRAIN-*` `SCORE-*` |
| Model Gateway | 模型调用、stream、重试 | 改写 Jev 决策 | `RESULT-2` |
| Outcome Evaluator | 质量 / 成本 / 延迟 / 反馈 | 直接发布生产策略 | `EXP-1` |
| Experience Store | 记录、检索、版本、回滚、校验 | 在线自动修改 policy | `EXP-9` `EXP-10` |
| 3D Visualizer | 消费事件、可视化、回放 | 自己决定 winner | `ANIM-6` `TREE-*` |
| Event Bus | 事件广播、重连补偿 | 决定业务状态 | `EVENT-*` |

---

## 3. 分层设计

### 3.1 三层划分（`ARCH-1`）

| 层 | 内容 | 约束 |
| --- | --- | --- |
| **纯逻辑层** | `extractFeatures` / `calibrate` / `routeTier` / `scoreModels` / `priorDeltaFor` / `calibrationStats` / `softmax` / 几何计算 | 纯函数，无 DOM / 无时间 / 无网络；相同输入恒得相同输出 |
| **状态容器层** | `createStore`（单一 state 树 + 纯 reducer + 订阅） | 不依赖渲染细节；`routeEventReducer` 驱动状态 |
| **渲染层** | DOM、Three.js、HUD、内联结果 | 只通过 dispatch 触发变更；不读写逻辑层内部状态 |

**为什么经验回流必须落在纯逻辑层**：`priorDeltaFor` 与 `calibrationStats` 是纯函数（输入经验状态 + 特征，输出目录序偏置数组 / 统计对象），不含时间判断、不碰 DOM、不依赖网络。这保证两形态（云原生 / 离线）共用同一份实现（`ARCH-2`），并可在测试中直接断言上界、冷启动、反固化等性质。

> **术语消歧**：本节的「三层」是**架构分层**（纯逻辑 / 状态容器 / 渲染）。它与 `proposal.md` §2.4 的「**三层权责**」（GENERATE=LLM / DECIDE=JEV / ENFORCE=CODE）是**两个不同维度**——前者划分**代码职责**，后者划分**系统权责**。二者 MUST NOT 混用；架构分层是实现手段，权责分层是设计约束。

### 3.2 域-层矩阵（对应 `spec.md` §0.3 C5）

| 需求域 | 纯逻辑层 | 状态容器层 | 渲染层 | 服务端 |
| --- | --- | --- | --- | --- |
| ARCH | ● | ● | ● | ○ |
| INGEST | ● | ● | ● | ○ |
| JEV | ● | ○ | ○ | ● |
| MODEL | ● | ○ | ○ | ● |
| CONSTRAIN | ● | ○ | ○ | ● |
| SCORE | ● | ○ | ○ | ○ |
| TREE | ● | ● | ● | — |
| ANIM | ● | ● | ● | ○ |
| RESULT | ○ | ● | ● | ● |
| ARCHIVE | ● | ● | ○ | ● |
| EXP | ● | ○ | ○ | ● |
| EVENT | ○ | ● | ● | ● |
| A11Y | — | ○ | ● | — |
| PERF | ● | ● | ● | ○ |
| API | — | ○ | ● | ● |

（● 主要落点 · ○ 次要落点 · — 无）

### 3.3 双形态差异点（`ARCH-2` `ARCH-4`）

| 差异点 | 云原生 | 离线 |
| --- | --- | --- |
| Jev 来源 | `TypeSafeJevAdapter`（真实 API） | `LocalJevReimpl`（确定性重实现） |
| 档案 / 经验状态 | 服务端 Experience Store | 本地存储（版本化键） |
| 事件传输 | SSE / WebSocket | 进程内事件总线 |
| 人工审批 | 服务端审批 + 审计 | 单端审批 + 显式标注「本地审批」 |
| 逻辑层代码 | **同一份** | **同一份** |

---

## 4. 关键算法设计

### 4.1 特征提取与证据强度（`JEV-4`）

**Q1 `intent`（choice）** —— 命中数最高者胜出，但证据强度必须能表达「没有证据」：

```js
v = (hits[kk] || 0) * 1.0
if (kk === 'vision'  && imgCount  > 0) v += 1 + 0.25 * imgCount
if (kk === 'longCtx' && fileCount > 0) v += 1 + clamp(fileTokens / 4000, 0, 1)

noEvidence = (total <= 0)
share = best / total
conc  = noEvidence ? 0 : clamp((share - 1/nCap) / (1 - 1/nCap), 0, 1)   // 集中度
vol   = noEvidence ? 0 : clamp(best / 4, 0, 1)                          // 信号量
intentStrength = clamp(0.70 * conc + 0.30 * vol, 0, 1)
```

> **必须固化的陷阱**：完全无信号时会回落到某个默认意图。若此时不把 `noEvidence` 显式置 0，就会把「无证据」误报成高置信的意图判定（实测空输入置信度会虚高到 0.8 以上）。

**Q2 `complexity` / Q5 `capability`（score）** —— 证据强度由「是否靠近分级边界」与「规模证据」共同决定：

```js
scoreStrength(score, n, tokenVolume) {
  pos    = clamp(clamp(score, 0, 1) * n, 0, n - 0.001)
  frac   = pos - Math.floor(pos)
  margin = Math.min(frac, 1 - frac) / 0.5    // 恰在边界为 0，居中最稳为 1
  return clamp(0.45 * margin + 0.55 * clamp(tokenVolume, 0, 1), 0, 1)
}
// tokenVolume 传 tokens / 450 —— 450 token 之后规模证据饱和
```

**Q3 `urgency` / Q4 `budget`（noul）** —— 输出 P(是)：

```js
// 0.30 是「无信号」时的先验，因此 |p − 0.5| 只能作为弱证据
uStrength = clamp((hits.urgency || 0) * 0.45 + Math.abs(urgencyP - 0.5) * 0.85, 0, 1)
```

> **必须固化的陷阱**：`noul` 的先验会污染证据。若无信号先验是 0.30，则 `|p − 0.5|` 只有 0.20 的「伪信号」，必须显式命中关键词才显著提高置信度。

整体证据强度按 `EVIDENCE_W` 加权平均（`intent` 权重最高，因为它是最强的语义信号）：

```js
EVIDENCE_W = { intent: 0.34, complexity: 0.16, urgency: 0.14, budget: 0.14, capability: 0.22 }
```

### 4.2 校准置信度与三档路由（`JEV-5`）

置信度从证据强度经校准曲线映射，**两端都有硬边界**：

```js
calibrate(strength) {
  s = clamp(strength, 0, 1)
  k = 2.6
  return round(0.35 + 0.62 * (1 - Math.exp(-k * s)) / (1 - Math.exp(-k)), 2)
}
```

| 边界 | 值 | 语义 |
| --- | --- | --- |
| 下界 | **0.35** | 无证据时不宣称高于随机猜测 |
| 上界 | **0.97** | 从不宣称 100% 确定 |

曲线单调不减、对越界输入做夹取，全部答案的置信度恒落在 `[0.35, 0.97]`。

| 档位 | 阈值 | 处置（Decision Runtime） | 是否需人工 |
| --- | --- | --- | --- |
| 高置信 | `conf ≥ 0.82` | **ROUTE** —— 直接路由 | 否 |
| 中置信 | `0.60 ≤ conf < 0.82` | **GATE** —— 路由并标记观察 | 否 |
| 低置信 | `conf < 0.60` | **ESCALATE** —— 落入模糊地带 · 转人工复核 | **是** |

> **ROUTE / GATE / ESCALATE 是 Decision Runtime 的输出档位**（见 §4.2.1），由 Jev 置信度决定「处置方式」；与 Selector 的硬约束过滤（决定「谁能被选」）是两个正交层次，MUST NOT 混用（`JEV-11`）。

**设计取舍**：阈值统一取 `0.82 / 0.60` 是**演示取值**（官方不给固定阈值，要求按动作风险分级）。`routeTier()` 接受可选阈值参数，默认取全局常量，保留「同一系统内不同动作可用不同阈值」的扩展点。低置信处置是硬约束：不强行给结论、不展示执行正文、显示警告块、提供人工复核入口。

#### 4.2.1 Decision Runtime 主链（`JEV-11`）

```
┌────────┐   ┌───────────────────────────┐   ┌──────────┐   ┌─────────────┐   ┌────────────────────────────┐
│ STATE  │──▶│  CHOICE │ SCORE │ NOUL     │──▶│   JEV    │──▶│ PROBABILITY │──▶│ ROUTE │ GATE │ ESCALATE   │
│ facts  │   │  （三原语并行提问）        │   │ System   │   │ typed ·     │   │ （三档处置）               │
│ context│   │                           │   │ One      │   │ parallel ·  │   │                            │
│ evidence│  └───────────────────────────┘   └──────────┘   │ calibrated  │   └────────────────────────────┘
└────────┘                                                  └─────────────┘
```

| 环节 | 输入 | 输出 | 落点 |
| --- | --- | --- | --- |
| STATE | Prompt / 附件 / 约束 | 结构化状态（facts · context · evidence） | `TaskEnvelope`（附录 A.1） |
| 三原语 | STATE | `choice` / `score` / `noul` 三型问题 | `QUESTIONS` |
| JEV | 三原语批量请求 | 类型化概率决策 | `TypeSafeJevAdapter` |
| PROBABILITY | Jev 原始输出 | 校准置信度 + 候选概率 | `calibrate` / `softmax` |
| ROUTE / GATE / ESCALATE | 置信度档位 | 处置动作 | `routeTier` |

**映射规则**（`JEV-11` 场景 2）：档位映射 SHALL 仅由置信度决定，SHALL NOT 受硬约束过滤结果影响。

```js
routeTier(conf, thresholds = { high: 0.82, mid: 0.60 }) {
  if (conf >= thresholds.high) return 'ROUTE'      // 高置信：直接路由
  if (conf >= thresholds.mid)  return 'GATE'       // 中置信：门控观察
  return 'ESCALATE'                                // 低置信：升级人工
}
```

> **实现现状（2026-09-30 已补登记）**：档位计算严格只取 `confidence` 与阈值，**不受硬约束结果影响**，
> 与本节设计一致。但候选池存在两处**可用性优先的回落**（白名单与目录无交集、硬约束淘汰全部候选），
> 原为静默发生。G-2 已补 `constraintFallback` / `constraintFallbackReason` 字段，
> 随 `DecisionRecordEntry`、`DecisionReceipt` 与 `CONSTRAINT_GATE_PASSED` 事件落库，
> 使「档位不受约束影响」与「约束是否被回落」两件事各自可审计；**回落行为本身未变**。
> 差异登记见 `spec.md` 附录 G-2（已关闭）。

**前端展示契约**（供 `TREE` / `RESULT` 消费）：调用链组件 SHALL 如实反映该主链顺序与当前所处档位；档位高亮 SHALL 与 `routeTier` 输出一致，SHALL NOT 由动画时间或前端状态自行推断（`ANIM-6`）。

### 4.3 五问并行 fan-out（`JEV-3`）

```
JevAdapter.answerQuestions(envelope, questions[5]) → 单请求打包
  → POST /v1/jev/answer { requestId, schemaVersion, batch: [q1..q5] }
  → 响应 { answers: [...], decisionId, modelVersions }
```

- 五问 MUST 在一次请求内并行打包（Speculative fan-out），MUST NOT 拆成多次串行调用。
- 响应解析后逐题记录证据强度；任一题缺失或非法 → `INVALID_DECISION`（`JEV-6`）。
- 成本与延迟预算：单批超时建议 1.2s（`EVENT-4` P95 目标）。

> **实现现状（2026-09-30 核对）**：fan-out 已落地——`SystemOneJevAdapter.answerQuestions()`
> 把五问打包进单次 `POST` 的 `questions` 字段（契约见 `jev-http-adapter.ts` 文件头）。
> 但**失败策略与本节设计不同**：解析失败抛 `JevAdapterError('JEV_INVALID_SCHEMA')`，
> 被编排器 `decide()` 捕获后转为 `JEV_FALLBACK` 事件并交 `answerQuestionsLocally` 兜底，
> **不返回 `INVALID_DECISION`、也不短路后续流程**。降级路径由 `CONSTRAIN-4` 授权且有显式留痕
> （`decisionSource=LOCAL_REIMPL` + `JEV_FALLBACK{degraded:true}`）。
> 差异登记见 `spec.md` 附录 G-1。

### 4.4 打分与概率收敛（`SCORE-1` ~ `SCORE-4`）

**软评分公式**：

```
score(model, p) = w_capability(p) × capability + w_quality(p) × quality
                + w_cost(p) × cost + w_latency(p) × latency
```

`w_*` 来自锁定的 `PolicySnapshot` 且和为 1；`capability` 可引用 Jev 五问判定，但须受目录事实约束（不能超出模型声明的能力标签）。

**负载惩罚**：`penalty = 26 × load^2.2`（单调递增，避免拥塞节点）。

**自适应温度 softmax**：

```
prob_i = exp(raw_i / T) / Σ_j exp(raw_j / T)
T = T0 × (1 + α × spread)     // spread 为 raw 分极差，分数接近时升温度避免过度集中
```

**双序契约**：同时输出目录序（`MODEL_INDEX`）与名次序（按 `raw` 降序）。**注入点唯一**：经验偏置 SHALL NOT 在 softmax 之后再加（否则概率不再由 `raw` 导出，双序推导链断裂）。

**稳健决胜序列**（`SCORE-4`）：「更高能力分 → 更低预计成本 → 更低预计时延 → `modelId` 字典序」。

### 4.5 硬约束过滤流水线（`CONSTRAIN-1`）

固定 8 步顺序（同 `spec.md`），任一步失败使该模型 `ineligible` 并记录主要淘汰理由与完整审计摘要：

```
1 目录启用与健康 → 2 租户/用户许可 → 3 模态与能力 → 4 上下文与输出上限
→ 5 数据与区域 → 6 风险与安全 → 7 预算与配额 → 8 时延硬限制
```

**Jev 与 Selector 权责**（`CONSTRAIN-3`）：Jev 的 `selectedRecommendation` 仅为推荐，最终模型由 Selector 在硬约束后确定。若最终非 Jev 推荐，trace 须说明理由。

### 4.6 下标契约（`MODEL-3`，本项目最贵的缺陷）

严格区分**目录序**与**名次序**：打分产生名次序后，映射回模型身份必须通过目录序查表，SHALL NOT 直接以名次序作为身份下标。3D 落点、`priorDelta[]` 均以目录序存储。

### 4.7 时间线与动画（`ANIM-1` ~ `ANIM-5`）

七阶段确定性时间线；唯一 `requestAnimationFrame` 循环；每帧零分配；数据包沿边路径运动，落点契约：执行阶段末尾落点与选中叶节点间距 < 0.05，中点落在叶柄曲线上（距离 < 0.02）。

**事件驱动**（`ANIM-6`）：3D 状态由 `state = routeEventReducer(state, event)` 生成，SHALL NOT 依据动画时间或随机数自行决定节点状态。

### 4.8 自适应取景求解器（`TREE-4`）

`solveRadius` 根据模型数量与视口计算取景半径；`measureHud` 测量 HUD 占位并避让，保证选中节点不被遮挡。

### 4.9 经验闭环算法设计（`EXP` 域 · 核心增量）

> 目标：把已确认经验折算为**有界、收缩、可复现、可回滚**的先验偏置，注入 `scoreModels` 的 `raw` 分。设计原则：**保守优先——宁可不用，不可用错。**

#### 4.9.1 为什么不是「直接改写画像」或「无界学习」

| 做法 | 问题 | 结论 |
| --- | --- | --- |
| 用经验**改写**模型能力画像字段 | 画像变为经验反推值，静态标定失去意义；一旦经验有偏，画像被永久污染 | ❌ 禁止 |
| 对 `raw` 施加**无界**偏置 | 正反馈：胜出模型获得更多样本 → 偏置更大 → 更常胜出 → **选型固化**，探索能力归零 | ❌ 禁止 |
| 对 `raw` 施加**有界 + 收缩**偏置 | 收敛慢，但静态画像始终主导；小样本自动被压小 | ✅ 采用 |

#### 4.9.2 结果确认的样本构成（`EXP-1`）

经验样本**仅 `confirmed` / `disputed` 参与**，`pending` 与 `expired` 排除：

```
样本 i = { intent, modelId, yᵢ, sourceᵢ, observedAtᵢ }

yᵢ = 1  if outcome.status === 'confirmed' && outcome.label === winner
yᵢ = 0  if outcome.status === 'disputed'
（expired / pending 不产生样本）
```

**来源权重**：`SOURCE_W = { human: 1.0, system: 1.0, implicit: 0.45 }`。理由：隐式信号语义模糊，可能是想对比而非不满意；弱标签单独不得触发劣化判定（`EXP-10`）。

#### 4.9.3 时效权重与画像变更失效（`EXP-7`）

```
ageDays = (now − outcome.observedAt) / 86400000
wᵢ      = 0.5 ^ (ageDays / EXP_HALF_LIFE_DAYS) × SOURCE_W[sourceᵢ]
有效条件：wᵢ ≥ EXP_WEIGHT_FLOOR（0.15），否则不参与先验修正
```

**画像变更失效**：当某模型 `profileVersion` 变更时，该模型全部历史样本被标记失效（或按半衰期重算），记录一条 `ExperienceVersion` 事件（trigger = `profile-change`），说明「哪个模型 / 哪些字段变更 / 失效了多少样本」。这是防止「模型升级后仍沿用旧经验」的关键守卫。

#### 4.9.4 有界收缩先验修正（`EXP-5` 核心式）

对每个（主意图 × 模型）对：

```
n_eff    = Σ wᵢ                                   （时效加权后的有效样本数）
postMean = ( EXP_PRIOR_STRENGTH × priorMean + Σ wᵢ·yᵢ )
           / ( EXP_PRIOR_STRENGTH + n_eff )        （Beta 后验均值）
Δraw     = EXP_CORR_MAX × ( postMean − priorMean )
```

**为什么这个式子是对的**（三条性质，均可断言）：

| 性质 | 推导 | 对应验收 |
| --- | --- | --- |
| **有界** | `postMean, priorMean ∈ [0,1]` ⇒ `\|Δraw\| ≤ EXP_CORR_MAX` | `EXP-5` 场景 1 |
| **冷启动为零** | `n_eff = 0` ⇒ `postMean = priorMean` ⇒ `Δraw = 0`（**无需 if 分支**） | `EXP-5` 场景 1 / `EXP-8` |
| **单调收缩** | `n_eff ↑` ⇒ `postMean` 越靠近经验均值，但被 `EXP_PRIOR_STRENGTH` 限制最大偏移速度 | `EXP-5` 场景 2 |

**`priorMean` 来源（必须钉死）**：由**静态能力画像标定**，SHALL NOT 由经验反推。这是「经验不越界」的形式化保证：经验只改变 `postMean` 相对 `priorMean` 的偏移量，不改变 `priorMean` 本身。

**禁止的实现方式（必须显式写出，避免被「优化」掉）**：

```js
// ❌ 错误：先算无界修正再截断 —— 大样本下长期贴住 ±EXP_CORR_MAX 上界，等价于无界偏置
delta = clamp(EXP_CORR_MAX * (obsMean - priorMean), -EXP_CORR_MAX, EXP_CORR_MAX)

// ✅ 正确：伪计数收缩 —— 小样本自然趋 0，大样本渐近但永不超过上界
postMean = (EXP_PRIOR_STRENGTH * priorMean + sumWY) / (EXP_PRIOR_STRENGTH + nEff)
delta    = EXP_CORR_MAX * (postMean - priorMean)
```

**关键常量**：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `EXP_CORR_MAX` | 4.0 | `raw` 分最大修正幅度 |
| `EXP_PRIOR_STRENGTH` | 20 | 先验伪计数强度（控制收缩速度） |
| `EXP_HALF_LIFE_DAYS` | 30 | 时效半衰期 |
| `EXP_WEIGHT_FLOOR` | 0.15 | 参与修正的最低权重 |
| `EXP_MIN_SAMPLE_PER_PAIR` | 8 | 单对最小有效样本 |
| `EXP_MIN_SAMPLE_GLOBAL` | 30 | 全局最小确认样本（低于则 shadow） |

#### 4.9.5 冷启动与 shadow 守卫（`EXP-8`）

```
若 (主意图 × 模型) 对 n_eff < EXP_MIN_SAMPLE_PER_PAIR(8) → 该对 Δraw = 0
若 全局已确认样本 < EXP_MIN_SAMPLE_GLOBAL(30) → 进入 shadow 模式：
    计算「若应用经验 Δraw 会是多少」写入观测日志；
    SHALL NOT 施加到实际决策；档案标注 correction: none
shadow → 生效 的切换 SHALL 由人工显式触发，SHALL NOT 自动切换
```

#### 4.9.6 校准统计（`EXP-2`）

```
ECE = Σ_b ( n_b / N ) × | acc_b − conf_b |      // b = 10 个等宽 [0,1] 桶
命中定义：confirmed 且 label === winner；disputed 记未命中；expired 剔除
同时报告：误报率（高置信但错误）与漏报率（低置信但正确）
样本 < 30 时标注「样本不足，不构成结论」，不输出优劣判定
```

#### 4.9.7 阈值重标定建议（`EXP-3`）

```
在已确认数据集上确定性扫描候选阈值 → 取「低置信精确率 ≥ 目标前提下覆盖率最大」的解
输出：当前阈值 / 建议阈值 / 优化目标 / 样本量 / 预期影响 + 反事实说明
反事实说明：新阈值下多少原本转人工被自动路由、多少原本自动被转人工
SHALL NOT 自动生效；生效须人工批准并记录操作者与时间
```

#### 4.9.8 版本化与原子回滚（`EXP-9`）

每次经验状态变更产生新 `expVersion`（单调递增，append-only 不可变）；回滚指向历史版本且为**原子操作**（回滚后生效状态恰等于目标版本，无混合态）；回滚记录为新的版本变更事件，保留「曾应用又回滚」审计线索；回滚后下一次决策即生效，无需重启。

#### 4.9.9 闭环自动校验（`EXP-10`）

以「应用某版本时刻」为分界切分为应用前段 / 应用后段，在同一组指标上对比：档位命中率、ECE、成本节省率、人工接管率 → 判定 `improved` / `neutral` / `degraded`；后段样本不足 → `inconclusive`（不得输出 `improved`）；`degraded` → 告警 + 一键回滚入口。

### 4.10 决策契约设计（`JEV-12`）

> 设计原则：**question is part of the program**——一个生产级提问是一份可版本化的契约，不是随手 prompt。

**契约 8 字段**（对应 `spec.md` 附录 A.7）：

| 字段 | 作用 | 设计约束 |
| --- | --- | --- |
| `stateFields` | 声明本决策消费的状态段 | 须是 `JEV-14` 六段的子集 |
| `instructions` | **真正**告诉模型判断规则 | 规则 MUST NOT 藏在键名里 |
| `criteria` / rubric | 选项描述或评分档描述 | 与 `primitive` 匹配 |
| `fallback` | 无选项成立时的兜底 | 非空 |
| `consequenceThresholds` | 该动作类的高/中阈值 | 见 §4.12，按后果分级 |
| `allowedAction` | 允许的动作（如 `route_only`） | 由 ENFORCE 层执行 |
| `escalationPath` | 升级路径 | 低置信 / 不可逆时走此路 |
| `version` | 契约版本（如 `ticket-router@3`） | 与业务代码**独立**版本化 |

**键名 vs instructions（必写对照，防止「键名当指令」的隐形 bug）**：

```python
# ❌ 弱：键名 safe_to_publish 并未告诉模型什么算 safe
"safe_to_publish": Noul(instructions="Is this safe?")

# ✅ 强：规则完整写在 instructions
"safe_to_publish": Noul(instructions=(
  "Does the draft contain only verified claims with citations, avoid "
  "private information, and require no unresolved legal or financial approval?"
))
```

**契约校验**：缺失 `instructions` 或 `fallback` → `INCOMPLETE_CONTRACT`，在调用 Jev **之前**短路（与 `JEV-6` Schema 守卫串联，前者校验**问题**、后者校验**答案**）。

**版本化与漂移**：契约版本独立于应用代码版本递增；语义变更走评审 / 测试 / 回滚（复用 `EXP-9` 的版本机制思路）。示例演进：`router@1` 广选项 → `router@2` 增加 none-of-the-above → `router@3` 拆分 billing 与 account access。

### 4.11 状态工程设计（`JEV-14`）

状态 SHALL 按功能分离为 6 段，MUST NOT 混成一团文本：

```
GOAL          what success means
FACTS         what the system knows
ARTIFACTS     what already exists
EVIDENCE      what supports the next judgment
CONSTRAINTS   what the system may not cross
OPTIONS       what can happen now
```

**核心反模式：状态里装的是「结论」而不是「证据」**：

```
❌ BAD      the research is probably enough
✅ BETTER   7 sources collected · 3 official · pricing verified · security claim unresolved
```

模型 SHALL 判断证据本身，MUST NOT 继承上一环节的置信度当作事实（联动 `JEV-4` 空信号防御：无证据 ⇒ 证据强度 0）。

**菜单实时重建（`OPTIONS` 段）**：可用动作随每次动作变化（worker 上下线、来源过期、预算收缩、文件出现、权限变化、队列变满）。从**过期菜单**中选择不是「坏推理」，而是**在无效图上运行**。设计约束：

```
选项集 SHALL 由实时状态重建，MUST NOT 硬编码静态列表
超大选项集：代码预过滤明显不匹配 → 对存活项打分 → 一次显式 Choice
Jev 只解决语义歧义，MUST NOT 让它重新发现程序已知的事实
```

> **实现现状（2026-09-30 已接入）**：本节设计已由 `packages/backend/src/state-engineering.ts` 实现
> （`EngineeredState` 6 段结构 + `assembleState()` + 结论性短语污染扫描 + `stateHash`/`stateVersion` 留痕），
> 且**已接入生产调用链**——`route-orchestrator.ts` 的 `buildEngineeredState()` 在 DECIDING 段组装 6 段，
> `jev-http-adapter.ts` 的 `buildState()` 序列化为 `<state><goal>…</goal>…</state>` 后送入真实 System One。
> 「结论不得冒充证据」（`assembleState` 对 FACTS / EVIDENCE 的污染扫描）与
> 「菜单实时重建」（`OPTIONS` 由实时目录 `modelInfoStore.catalogEntries()` 重建）均在生产路径上生效。
> 差异登记见 `spec.md` 附录 G-3（已关闭）。

### 4.12 后果分级阈值设计（`JEV-15`）

阈值绑定**动作后果等级**，而非只绑定模型输出。参考路由函数（对应文章语义，映射到本系统的 `routeTier`）：

```python
def route_decision(choice, confidence, consequence):
    if consequence == "irreversible":
        return "human_review"                      # 不可逆 → 无条件转人工
    if confidence >= 0.90 and consequence == "low":
        return choice                              # 高置信 + 低后果 → 自动
    if confidence >= 0.70:
        return "collect_more_evidence"             # 中置信 → 改进状态（GATE）
    return "human_review"                          # 低置信 → 升级（ESCALATE）
```

| 区 | 条件 | 处置 | 映射本系统 |
| --- | --- | --- | --- |
| 高置信 · 低后果 | `conf ≥ 0.90` 且 `low` | 自动化该分支 | ROUTE |
| 中置信 | `0.70 ≤ conf < 0.90` | **改进状态**（取新证据 / 更强模型 / 确定性检查 / 收窄选项） | GATE |
| 低置信 或 高后果 | `conf < 0.70` 或 `irreversible` | 升级 | ESCALATE |

**关键纪律**：置信度若**不改变路由**，就只是装饰；校准只有在 harness 把不确定性**路由到某处**时才有用。**同一证据下的重复不确定决策 MUST NOT 被重试**——重试 SHALL 花费**新证据**，而非更多 token（`EXP-1` `EXP-10`）。

> 阈值取值（`0.90 / 0.70`）为**演示值**，与 `JEV-5` 的 `0.82 / 0.60` 关系：前者示意「按后果分级后的示例」，后者为本系统演示基线；两者 SHALL 在 `policyVersion` 中登记为可配置项（附录 F F3）。

### 4.13 决策凭据设计（`JEV-16`）

系统 SHALL 存**凭据**而非只存胜出标签（对应 `spec.md` 附录 A.8）：

```
契约版本 · 状态引用（state_version / hash） · 完整分布 ·
所用阈值 · 路由档位 · 实际动作
```

凭据与 `ARCHIVE-1` 档案、`EXP-6` 钉版本重放共用同一 `requestId` 关联链（`EVENT-4`）。无凭据的决策不可复现、不可审计——这是「把语义决策当生产逻辑」的落点。

**安全顺序（三层边界的强制执法序）**：

```
JEV JUDGES  →  CODE CHECKS POLICY  →  TOOL EXECUTES  →  TRACE RECORDS
```

---

## 5. 关键流程设计

### 5.1 正向路由（对应 `spec.md` 附录 C.1）

```
[Prompt] → Normalize（组装 6 段 state）→ [决策契约校验] → [Experience Retrieval]（异步、可降级，超时 300ms）
   → [Jev 五问 fan-out] → [Schema 校验] → [后果分级阈值] → [Decision Runtime 主链]
   → [8 步硬约束] → [软评分 + Δraw] → [决胜] → [finalModelId]
   → [Model Gateway 流式] → [Outcome] → [决策凭据 + ExperienceEntry(pending)]

分层：Normalize…主链 = DECIDE(JEV)；硬约束/决胜/授权 = ENFORCE(CODE)；Gateway = GENERATE(LLM)
```

### 5.2 降级设计（`CONSTRAIN-4` `CONSTRAIN-5`）

```
Jev 超时 / 非法 Schema
  ├─ 存在已审核 fallback 规则 → RULE_FALLBACK + decisionDegraded=true + 3D 显示降级
  └─ 否则 → DECISION_TIMEOUT，不调用任何执行模型
降级决策 SHALL NOT 写入「Jev 正常决策」经验
新 Jev 版本 / 新规则先以 shadow mode 运行（产生决策但不驱动执行）
```

### 5.3 经验回流（对应 `spec.md` 附录 C.2）

```
结果确认回填 → 统计(ECE/命中率) → 阈值建议(不自动生效)
   → 人工批准 → 新 expVersion → 生效 → 下一次决策注入 Δraw
   → 分段校验 → 劣化则告警 + 一键回滚
```

**闭环回流的两个方向（务必区分）**：
- **向上**（沉淀路径）：决策完成后产出 `ExperienceEntry`；异步结果确认后更新计数、可能产生新 `expVersion`。**该路径不参与当前决策**，只影响后续决策。
- **向下**（应用路径）：下一次决策读取生效经验版本，注入 `Δraw`。**该路径必须记录 `expVersion` 与 `priorDelta[]`**。

---

## 6. 数据模型与契约

数据契约以 `spec.md` 附录 A 为准：`TaskEnvelope`（A.1）、`ModelDescriptor`（A.2）、`JevDecision`（A.3）、`ExperienceEntry`（A.4）、`RouteRecord`（A.5）、`ExperienceVersion`（A.6）。

### 6.1 事件契约（`EVENT-1`）

```ts
interface RouteEvent {
  eventId: string;
  requestId: string;
  decisionId?: string;
  executionId?: string;
  type: RouteEventType;
  timestamp: string;
  sequence: number;          // 单调递增
  payload: Record<string, unknown>;
}
```

事件类型与 3D 映射（`ANIM-6`）：

| RouteEvent | 3D 行为 |
| --- | --- |
| `ROUTE_CREATED` | Prompt 节点亮起 |
| `EXPERIENCE_RETRIEVED` | Experience 节点出现证据流 |
| `JEV_CALL_STARTED` | Jev Hub 脉冲 |
| `JEV_DECISION_READY` | 候选节点按 score 亮度显示 |
| `JEV_FALLBACK` | Jev Hub 显示降级状态 |
| `CONSTRAINT_FILTERED` | 被排除节点变灰并显示原因 |
| `MODEL_SELECTED` | 最终路径高亮 |
| `MODEL_STREAMING` | 数据包沿 selected edge 流动 |
| `MODEL_COMPLETED` | Selected Model 完成态 |
| `EXPERIENCE_SAVED` | 结果汇聚到 Experience |

---

## 7. 3D 可视化设计

### 7.1 场景布局（`TREE-1`）

```
[Prompt输入] ── ──▶ [Jev智能路由中枢] ──▶（树状分叉）──▶ [候选模型 A/B/C…F] ── ──▶ [决策库]
       虚线（逻辑路径）          实线管路（数据流）                            虚线（逻辑路径）
```

自左向右主链：
- 最左节点 `Prompt输入`（prompt 类型，圆形实心起节点，颜色 `#4ea1ff`，位置 `GATE_IN_POS = (-7.4, 0, 0)`）。
- 中枢节点 `Jev智能路由中枢`（jev-hub 类型，二十面体核 + 线框壳 + 五圈问题环，颜色 `#8b5cff`，位置 `HUB_POS = (0, 0, 0)`）。
- 6 个候选模型节点（candidate 类型，球体 + 线框壳 + 状态环，颜色按模型身份编码，位置 `LEAF_X = 5.85` 一列，Y 方向按 `ROW_DY = 2.10` 分布）。
- 最右节点 `决策库`（knowledge 类型，圆形实心终节点，颜色 `#22d39a`，位置 `KNOWLEDGE_POS = (9.0, 0, 0)`）。

**双路径系统**（本次新增）：

| 路径类型 | 语义 | 视觉 | 阶段联动 |
| --- | --- | --- | --- |
| 实线管路（`TubeGeometry` + `MeshBasicMaterial` + `AdditiveBlending`） | 数据包流动路径（hub→候选→hub→knowledge） | 圆角管路，颜色随模型身份 / 阶段 | 由 `run.edgeFlow[e]` 驱动透明度 |
| 虚线逻辑路径（`THREE.Line` + `LineDashedMaterial`） | 主链语义提示（prompt→hub 接入、候选→决策库沉淀） | 短划虚线，颜色与实线呼应，透明度略低于实线 | 由对应阶段（ingest / execute / return）驱动亮度增强 |

**虚线构成**：
- `Prompt输入 → Jev智能路由中枢`（1 条，直线，颜色 `#4ea1ff`，ingest 阶段增强）
- `每个候选模型 → 决策库`（6 条，二次贝塞尔弧，颜色按模型身份，execute/return 阶段增强）

**与实线管路的区分**：
- 几何：虚线为 1D `THREE.Line`（不占用体积），实线为 3D `TubeGeometry`（可感知厚度）。
- 材质：`LineDashedMaterial`（`dashSize=0.28` / `gapSize=0.20`）vs `MeshBasicMaterial` + `AdditiveBlending`。
- 透明度：虚线基础 0.14–0.20，实线基础 0.06–0.92，形成层级对比。
- 位置：虚线在 Z 轴微前（`+0.6`）避开实线管路，便于辨识。

### 7.2 节点类型

| 类型 | 命名 | 几何 | 角色 |
| --- | --- | --- | --- |
| prompt | `Prompt输入` | 球体 + 线框壳 + 光晕 Sprite | 起节点，接收用户 prompt |
| jev-hub | `Jev智能路由中枢` | 二十面体核 + 线框壳 + 5 圈问题环 | 唯一决策主体（TypeSafe Jev） |
| candidate | 模型身份名（如 `GPT-4o`） | 球体 + 线框壳 + 状态环 | 6 个候选模型 |
| knowledge | `决策库` | 球体 + 线框壳 + 光晕 Sprite | 终节点，决策与经验沉淀 |

节点类型枚举：`NodeType = 'prompt' | 'jev-hub' | 'candidate' | 'knowledge'`（`routeEventReducer.ts`）。

### 7.3 性能（`PERF-2` `ANIM-4`）

- 候选节点使用 instancing / 共享几何；粒子一次绘制。
- 3D 动画使用唯一 `requestAnimationFrame`；事件状态更新与渲染状态解耦。
- DPR 限制；`prefers-reduced-motion` 时降低动效。
- 低性能设备允许降级为 2D / 简化 3D，但必须保留完整事件与文字路径（`TREE-5`）。

### 7.4 二维等价视图（`TREE-5`）

主链语义在 HUD 与 2D 降级场景下由 `.flowbar` 表达：`Prompt输入 → Jev中枢 → 模型执行 → 决策库`。

**已移除组件**：原设计 §7.4 的"左上区 Decision Runtime 二维调用链"技术图纸已按 UX 简化需求**移除**，`DecisionRuntimeSchematic` 不再渲染。`JEV-11` 语义由以下两条通道共同承载：

1. **3D 视图本身**：中枢（jev-hub）的问题环 = 五问 fan-out；状态环 = 档位（ROUTE / GATE / ESCALATE）；候选节点高亮 = 选中模型。
2. **二维等价条 `.flowbar`**：由同一 `RouteEvent` 流驱动（`TREE-5`）。

两者 SHALL 共用同一事件流，SHALL NOT 出现状态不一致（`ANIM-6`）。

#### 7.4.1 与 3D 的关系

| 维度 | 3D 视图 | 二维 flowbar |
| --- | --- | --- |
| 定位 | 主可视化 | 语义摘要 / 降级替身 |
| 事件源 | 同一 `RouteEvent` 流 | 同一 `RouteEvent` 流 |
| 档位 | 高亮选中叶节点 + 状态环颜色 | 阶段条高亮当前位置 |
| 性能 | 重（WebGL） | 极轻（纯 DOM） |

页面**左上区域**原设计为 Decision Runtime 二维调用链展示（技术图纸风格）。**该组件已按 UX 简化轮次移除**，不再渲染。

<!-- 遗留段落：以下为原设计内容，已按 UX 简化移除，保留仅供历史追溯 -->

---

## 8. 安全与治理

| 项 | 设计 |
| --- | --- |
| 密钥 | 仅服务端（`spec.md` 约束 C3） |
| 租户隔离 | 所有 Prompt / 决策 / 结果按租户隔离 + 审计追踪 |
| 脱敏 | 默认不存原始 Prompt 全文与图片；摘要截断（`A11Y-3`） |
| 版本快照 | `catalogVersion` / `policyVersion` / `schemaVersion` / `expVersion` |
| 审批 | 阈值建议与经验应用须人工批准（`EXP-3` `EXP-9`） |
| 灰度回滚 | shadow mode + canary + 原子回滚（`CONSTRAIN-5` `EXP-9`） |
| 供应商响应校验 | 长度、类型与可渲染内容校验 |

---

## 9. API 草案

见 `spec.md` 附录 B。设计要点：`POST /v1/routes` 只创建路由；决策与执行由服务端状态机异步推进；事件通过 SSE 推送，支持 `Last-Event-ID` 重连补偿。

---

## 10. 关键测试策略

| 类别 | 覆盖需求 |
| --- | --- |
| 契约测试 | `JEV-1` `JEV-6` `API-1`~`API-5` |
| Jev adapter 集成（含 sandbox / 超时 / 非法 Schema） | `JEV-1` `JEV-3` `CONSTRAIN-4` |
| Selector 性质测试（硬约束顺序 / 决胜确定性） | `CONSTRAIN-1` `CONSTRAIN-2` `SCORE-4` |
| 经验闭环断言（上界 / 冷启动 / 反固化 / 钉版本 / 原子回滚） | `EXP-4`~`EXP-10` |
| ECE 对拍手算 | `EXP-2` |
| 事件顺序 / 幂等 / 重连 | `EVENT-1`~`EVENT-3` |
| 3D 事件-节点映射 | `ANIM-6` `TREE-2` |
| 视觉回归 | `ANIM-3` `TREE-3` |
| 无障碍 | `A11Y-1` |
| 安全 | `A11Y-3` `CONSTRAIN-*` |
| 决策契约校验（8 字段 / 键名不得充当指令） | `JEV-12` |
| 三原语语义（逃生舱 / Score 非测量 / Noul 0.5） | `JEV-13` |
| 状态工程（6 段分离 / 结论不得冒充证据） | `JEV-14` |
| 后果分级阈值（分级 / 单一阈值被拒 / 不可逆转人工） | `JEV-15` |
| 决策凭据（完整 / 可复现） | `JEV-16` |
| 上线判定清单（16 项） | 附录 H（`spec.md`） |

---

## 11. 架构决策记录（ADR）

> 逐条对应 `proposal.md` §4 的 D1–D19（`spec.md` §0.2 契约 C3）。

| ADR | 决策 | 对应提案 | 关键理由 |
| --- | --- | --- | --- |
| ADR-1 | Jev Adapter 对接真实 TypeSafe Jev API；本地重实现仅作离线显式降级 | D1 | 避免「决策造假」；生产可审计 |
| ADR-2 | 前后端分离为主 + 单文件降级，共用同一逻辑层 | D2 | 经验沉淀需服务端；离线需自包含 |
| ADR-3 | 原生 ES5 + IIFE，不引入框架 | D3 | 满足加载预算 |
| ADR-4 | Three.js 直操作 `Object3D` | D4 | 每帧零分配 |
| ADR-5 | 自实现 Redux 模式容器 | D5 | 满足单一 state 树 + 纯 reducer |
| ADR-6 | 负载感知选型 + `loadMap` 复位通道 | D6 | 避免拥塞 + 可复现 |
| ADR-7 | 阈值按动作风险分级，演示取值 `0.82/0.60` | D7 | 官方要求 |
| ADR-8 | 内联结果 + 详情双通道，同一 `record` 派生 | D8 | 满足需求 5 |
| ADR-9 | 经验回流作用于 `raw` 的**有界偏置 + 伪计数收缩** | D9 | 防选型固化 + 画像不被污染 |
| ADR-10 | 档案钉 `expVersion`，重放用钉住版本 | D10 | 保证历史可复现 |
| ADR-11 | 结果确认来源含隐式弱标签（降权） | D11 | 高频信号 + 噪声隔离 |
| ADR-12 | 阈值建议生成 + 人工批准后生效 | D12 | 防统计噪声改写安全阀 |
| ADR-13 | Jev 推荐 + Selector 硬约束终裁 | D13 | 权责解耦 |
| ADR-14 | 五问单请求内并行 fan-out | D14 | 数量级成本/延迟优势 |
| ADR-15 | 采用 Decision Runtime 主链 `STATE→三原语→JEV→PROBABILITY→ROUTE/GATE/ESCALATE`，三档与置信度对齐 | §2.3 | 与官方决策运行时语义一致 |
| ADR-16 | 左上区调用链采用技术图纸风格二维展示，与 3D 共用同一事件流 | §2.3 | 语义摘要 + 降级替身 |
| ADR-17 | 三层权责分层：GENERATE=LLM / DECIDE=JEV / ENFORCE=CODE，且**置信度不充当执行授权** | D15 D16 §2.4 | 生成与决策混同是成本与不可控根因；防「confidence becomes permission」 |
| ADR-18 | 提问即**决策契约**（8 字段）+ 独立版本化；规则写在 instructions 而非键名 | D17 §2.4（三） | 语义决策是生产逻辑，须可评审 / 测试 / 回滚 |
| ADR-19 | 状态按功能分离 6 段；阈值绑定**动作后果等级**；保留**决策凭据** | D18 D19 §2.4（五/六/七） | 混杂状态致合法却语义错误；单阈值与无凭据不可控 |

---

## 12. 与既有实现的迁移映射

| 既有能力 | 迁移动作 | 需求 |
| --- | --- | --- |
| 本地确定性 Jev | 保留为离线形态，新增真实 API 适配器 | `JEV-1` `JEV-8` |
| 三档路由 | 保留，映射为 Decision Runtime 的 ROUTE/GATE/ESCALATE | `JEV-5` `JEV-11` |
| 决策档案 | 扩展结果确认生命周期与 `expVersion` | `ARCHIVE-1` `EXP-1` |
| 历史回放 | 扩展为钉版本重放 | `ARCHIVE-3` `EXP-6` |
| 经验回流 | 全新引入 | `EXP-1`~`EXP-10` |
| 调用链展示 | 全新引入（左上区技术图纸风格） | `JEV-11` |
| 内联结果 | 全新引入 | `RESULT-1`~`RESULT-5` |
| 三层权责分层 | 全新引入（GENERATE/DECIDE/ENFORCE 边界） | `JEV-12` `CONSTRAIN-1` `CONSTRAIN-3` |
| 决策契约与版本化 | 全新引入（提问即契约） | `JEV-12` |
| 状态工程 6 段 | 扩展 `TaskEnvelope` | `JEV-14` |
| 后果分级阈值 | 扩展三档阈值 | `JEV-15` |
| 决策凭据 | 扩展档案留痕 | `JEV-16` |
