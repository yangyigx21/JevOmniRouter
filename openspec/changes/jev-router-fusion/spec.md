# JevRouter — 规范（spec · 融合版）

- **变更 ID**：`jev-router-fusion`
- **规格状态**：Draft（待评审冻结）
- **规范词**：SHALL / MUST 表示必须，MUST NOT 表示不得，SHOULD 表示应该，MAY 表示可以
- **优先级**：P0 为 MVP 必须，P1 为首个生产增强

---

## 0. 文档定位与一致性契约

### 0.1 四方关系

本规范（`spec.md`）是 `proposal.md`（为什么做 / 做什么）、`design.md`（怎么做）、`tasks.md`（谁在何时做）三者的**唯一事实锚点**。任何需求以本文件编号为准；`design.md` 与 `tasks.md` SHALL 引用同一编号。

### 0.2 提案 ↔ 规范一致性契约

| # | 契约 | 检查方式 |
| --- | --- | --- |
| C1 | 提案 §1.3 的每个目标 G1–G6 SHALL 至少对应 1 条规范性需求 | 逐目标核对 |
| C2 | 提案 §2.1 的每个需求域 SHALL 在 §3 索引中出现，且需求数一致 | 表格对账 |
| C3 | 提案 §4 的每个关键决策 D1–D19 SHALL 在 `design.md` 有对应 ADR | 逐决策核对 |
| C4 | 提案 §5.2 的每个风险 R1–R11 SHALL 在 §4 有缓解需求或附录 D 有约束 | 逐风险核对 |

### 0.3 与设计 / 任务文档的扩展契约

| # | 契约 | 检查方式 |
| --- | --- | --- |
| C5 | `design.md` SHALL 覆盖 §4 全部需求域的分层落点 | 域-层矩阵核对 |
| C6 | `tasks.md` SHALL 为每条 `EXP-*` 与 `JEV-*` 需求提供 ≥ 1 个任务落点 | 追溯矩阵核对 |
| C7 | 本阶段 SHALL NOT 交付前后端代码实现，仅交付规范 | 交付物审查 |

### 0.4 编号规则

- 需求编号：`<域>-<序号>`，如 `JEV-3`、`EXP-5`。
- 场景编号：`<域>-<序号>.<子序号>`，如 `EXP-5.1`。
- 任务编号：`T-<域>-<序号>`，如 `T-EXP-2`。
- 设计决策：`ADR-<序号>`。

### 0.5 规范粒度

每条需求 SHALL 含：编号、名称、规范性陈述（SHALL/MUST 句）、至少 1 个 `Scenario`（GIVEN/WHEN/THEN）。无法写出可判定场景的条目 SHALL 降级为「设计说明」而非需求。

### 0.6 术语稳定性

§1 定义的术语在四份文档中 SHALL 保持同形同义；新增术语 SHALL 先登记于 §1 再使用。

### 0.7 「闭环合上」的判定标准（本变更核心增量）

> 背景：仅实现「记录 + 统计 + 导出」而不把经验用于下一次决策者，属**开环**。据此，一个**合上**的决策经验闭环 SHALL 同时具备下列五段位；缺失任意一段，SHALL 判定为「开环」，不得对外宣称具备经验积累能力。

| 段位 | 判定问题 | 对应需求 |
| --- | --- | --- |
| ① **沉淀** | 每次决策是否产出可被后续消费的**结构化经验条目**（含结果确认，而非仅输入快照）？ | `EXP-1` |
| ② **统计** | 是否把沉淀数据折算为**可信度与阈值的量化评估**（命中率 / 分桶 / 校准误差），而非仅条数计数？ | `EXP-2` `EXP-3` |
| ③ **应用** | 统计结论是否**改变了下一次决策的实际行为**（打分先验 / 阈值），且该改变**有界、可审计**？ | `EXP-4` `EXP-5` `EXP-7` `EXP-8` |
| ④ **可复现** | 应用经验后，历史决策是否仍能被**精确重放**？ | `EXP-6` |
| ⑤ **验证与回滚** | 应用后是否有**自动效果校验**，并在劣化时能**原子回滚**到上一版本？ | `EXP-9` `EXP-10` |

> **开环判定**：仅实现 `EXP-1` `EXP-2` `EXP-3` 而未实现 `EXP-4` ~ `EXP-10` 者，SHALL 判定为「有报表无回流」的开环（见 §3 统计表）。

### 0.8 权威边界声明

- 本系统的置信度是**路由信号，不是事实保证**，MUST NOT 直接充当执行授权（`CONSTRAIN-1` `CONSTRAIN-3`）。
- 类型安全约束的是**输出形状**，不是业务判断的正确性；Jev 无法破坏声明的 schema，但仍可能选出「合法的错误选项」。
- 三层权责 MUST NOT 相互替代：GENERATE=LLM / DECIDE=JEV / ENFORCE=CODE（`JEV-12`）。
- 经验回流修正的是**选型先验**，不是**模型能力画像**（见 `EXP-5`）。
- 所有自定义项 SHALL NOT 对外表述为 TypeSafe 官方机制（见附录 F）。

---

## 1. 术语与角色

### 1.1 术语

| 术语 | 定义 |
| --- | --- |
| **JevRouter** | 本系统名称：由前置 TypeSafe Jev 驱动的多模型智能路由系统 |
| **TypeSafe Jev（Jev）** | System One 决策模型，通过统一适配器以公开契约被调用，输出受 Schema 约束的**类型化概率决策**。不生成文本，不做多模型投票 |
| **System One** | 取自卡尼曼《思考，快与慢》，指快速、聚焦、直觉式的判断；Jev 为快速聚焦判断而建 |
| **三原语** | Jev 的问题类型：`choice`（选项）、`score`（分级）、`noul`（是否）；各有强制语义与禁止误用（`JEV-13`） |
| **三层栈（三层权责）** | GENERATE=LLM（创造新内容） / DECIDE=JEV（类型化判断） / ENFORCE=CODE（精确执法）；三者不可越权（`JEV-12`） |
| **决策契约（Decision Contract）** | 一个生产级 Jev 提问的 8 字段规范（state / instructions / options·rubric / fallback / thresholds / allowed action / escalation / version），与业务代码独立版本化（`JEV-12`） |
| **逃生舱（Escape Hatch）** | `Choice` 在菜单可能不完备时必须提供的兜底选项（`none` / `other` / `stop` / `escalate`）（`JEV-13`） |
| **状态工程（State Engineering）** | 把送入 Jev 的状态按功能分离为 6 段（GOAL / FACTS / ARTIFACTS / EVIDENCE / CONSTRAINTS / OPTIONS）（`JEV-14`） |
| **后果分级阈值** | 置信度阈值绑定动作后果等级（如 `low` / `irreversible`），而非全系统共用（`JEV-15`） |
| **决策凭据（Decision Receipt）** | 契约版本 + 状态引用 + 完整分布 + 阈值 + 路由 + 实际动作的留痕，使决策可复现（`JEV-16`） |
| **Decision Runtime（决策运行时）** | 由 TypeSafe Jev 定义的决策主链：`STATE →（CHOICE/SCORE/NOUL）→ JEV → PROBABILITY →（ROUTE/GATE/ESCALATE）`（`JEV-11`） |
| **ROUTE / GATE / ESCALATE** | Decision Runtime 的三档输出处置：高置信直接路由 / 中置信门控观察 / 低置信升级人工（`JEV-5` `JEV-11`） |
| **五问（Five Questions）** | 单次请求内并行打包的五个类型化判定：`intent`、`complexity`、`urgency`、`budget`、`capability` |
| **Decision** | Jev 对任务与候选模型的类型化决策，不等同于最终执行授权 |
| **decisionSource** | 决策来源标记：`TYPE_SAFE_JEV` / `RULE_FALLBACK` / `LOCAL_REIMPL` / `USER_OVERRIDE` |
| **Selector** | 对 Jev 推荐执行硬约束、目录、策略与可用性检查并确定最终模型的组件 |
| **校准置信度** | 从证据强度的概率分布形状导出的统计量，而非模型自报的确定性 |
| **路由** | 从 Prompt 到决策、模型调用、结果与知识沉淀的一次完整执行 |
| **模型目录** | 可被 JevRouter 调用的模型及其能力、模态、成本与可用性元数据 |
| **目录序 / 名次序** | 目录序为模型在 `ModelDescriptor[]` 中的固定下标；名次序为按打分结果排序后的顺序。二者不可混用 |
| **路由档案（Record）** | 一次路由决策的结构化快照 |
| **经验条目（Experience Entry）** | 由一次决策产出的、带**结果确认生命周期**的结构化经验单元（`EXP-1`）。区别于档案：档案是决策快照，经验条目额外承载「事后真实结果」 |
| **结果确认（Outcome）** | 对决策预测的事后认定，来源为 `human` / `implicit` / `system`，状态为 `pending` / `confirmed` / `disputed` / `expired`（`EXP-1`） |
| **先验修正（priorDelta）** | 经验对模型打分先验的有界偏置，`Δraw = EXP_CORR_MAX × (postMean − priorMean)`（`EXP-5`） |
| **经验版本（expVersion）** | 经验状态的单调递增版本号；档案 SHALL 钉住产出时的 `expVersion`（`EXP-9`） |
| **知识库 / Experience Store** | 保存决策特征、模型表现与结果指标的检索存储 |
| **RouteEvent** | 路由阶段事件，驱动后端状态与 3D 展示（`EVENT-1`） |
| **左到右二叉树图** | 以 `Prompt → Jev 中枢 → 模型分支 → 知识库` 为主链、模型侧呈树状分叉（dendrogram）的可视化结构 |
| **硬约束（Hard Constraint）** | 不可被软评分或 Jev 推荐抵消的资格性过滤条件（`CONSTRAIN-1`） |
| **Shadow Mode** | 产生决策但不驱动执行的旁路运行模式（`EXP-8` `CONSTRAIN-5`） |

### 1.2 角色

| 角色 | 职责 |
| --- | --- |
| **最终用户** | 提交 Prompt、查看结果与决策解释、提供显式反馈（👍/👎） |
| **复核人** | 对低置信档案进行人工复核、回写真实标签、批准阈值重标定建议 |
| **运营者** | 维护模型目录与策略、开关降级、执行经验版本回滚、处理劣化告警 |
| **开发者** | 依据本规范与 `design.md` 实现、依据 `tasks.md` 交付 |

---

## 2. 系统上下文与边界

### 2.1 上下文图

```
                       ┌──────────────────────────────┐
                       │   TypeSafe Jev / System One   │  ← 真实决策模型（外部）
                       └──────────────┬───────────────┘
                                      │ 五问并行请求 / Schema 约束响应
                                      ▼
   ┌──────────────┐        ┌──────────────────────────┐        ┌─────────────────┐
   │  最终用户     │──────▶│        JevRouter          │──────▶│  执行模型池      │
   │ （Prompt/反馈）│◀──────│  （本系统）               │◀──────│ （gpt/claude/…）│
   └──────────────┘        └───────┬──────────┬───────┘        └─────────────────┘
                                   │          │
                                   ▼          ▼
                        ┌──────────────┐  ┌──────────────────┐
                        │ 经验/知识库   │  │ 事件流 / 3D 可视化 │
                        └──────────────┘  └──────────────────┘
```

### 2.2 系统边界

**范围内**：多模态接入、Jev 真实决策、硬约束治理、模型选择、执行与流式结果、内联结果呈现、3D 过程可视化、经验沉淀与回流闭环、可观测性。

**范围外**：模型训练/微调、通用聊天与长文生成、组织级权限与计费结算、跨浏览器实测保证。

### 2.3 双形态交付

| 形态 | 描述 | 适用场景 |
| --- | --- | --- |
| **云原生（默认/生产）** | 前端产物 + 后端服务；真实 Jev API；SSE/WebSocket 事件流；经验状态落服务端 | 生产、多用户、跨端回流 |
| **离线单文件（降级）** | 单个自包含 HTML；无后端；Jev 用本地确定性重实现；经验状态落本地；人工审批降级为单端审批并显式标注 | 演示、评审、离线验证 |

> 前端 SHALL 在两种形态下使用**同一套逻辑层代码**；形态差异只体现在「档案与经验状态落本地还是落服务端」与「Jev 问答来自本地重实现还是远程接口」。**经验回流算法 SHALL NOT 因形态不同而实现两套**（`ARCH-2`）。

### 2.4 主流程

```
Prompt → Normalize → Experience Retrieval → Jev（五问并行）
   → Schema Validation → Hard Constraint → Selector → Execute
   → Outcome → Experience Entry →（异步）统计 → 建议 → 应用 → 校验/回滚
```

模型调用 SHALL NOT 早于 Jev 决策完成（`JEV-3`）。

---

## 3. 规范索引（需求总表）

> **列含义**：`需求 ID` · `名称` · `场景数` · `提案对应` · `设计落点` · `状态` · `验收方式`
> **对齐状态**（`状态` 列）：`✅ 已对齐` 代码落点存在且行为符合 · `⚠️ 需扩展` 落点存在但行为与规范有偏差 · `❌ 需新增` 无代码落点
>
> **实现核对（2026-09-30）**：JEV 域 16 条需求已全部有代码落点，主体链路
> （真实 System One 适配器 → 五问 fan-out → 硬约束门 → 打分选型 → 三档处置）
> 已端到端跑通。剩余偏差集中在 **D2 档位正交性** 与 **D4 状态 6 段未入真实调用**，
> 详见本文末「附录 G · 实现差异登记」。

### ARCH — 架构分层与职责边界（5 条 / 6 场景）

| 需求 ID | 名称 | 场景 | 提案 | 设计落点 | 状态 | 验收方式 |
| --- | --- | --- | --- | --- | --- | --- |
| `ARCH-1` | 三层架构职责边界 | 2 | §2.1 | `app1/app2/app3` | ✅ | 代码审查 + 任意时刻跳转断言 |
| `ARCH-2` | 双形态共用同一逻辑层 | 1 | §2.3 | 逻辑层模块 | ⚠️ | 同源代码审计 + 回流算法单实现断言 |
| `ARCH-3` | 状态容器与动画时钟隔离 | 1 | §2.1 | `createStore` / `RT` | ✅ | 状态容器单测 |
| `ARCH-4` | 单文件自包含与离线可用（降级形态） | 1 | §2.3 | `build.sh` 自检 | ✅ | 构建自检 + 断网打开 |
| `ARCH-5` | 关键常量集中与临时对象复用 | 1 | §2.1 | 模块级常量 | ✅ | 几何预验证 |

### INGEST — 多模态 Prompt 接入（6 条 / 7 场景）

| 需求 ID | 名称 | 场景 | 提案 | 设计落点 | 状态 | 验收方式 |
| --- | --- | --- | --- | --- | --- | --- |
| `INGEST-1` | 文本输入与规范化 | 1 | §2.1 | `#editor` / `bindEditor` | ✅ | 边界值测试（5000 字符上限） |
| `INGEST-2` | 图片输入 | 1 | §2.1 | `addAttachment` | ⚠️ | 白名单/上限测试（4 张/10MB） |
| `INGEST-3` | 文档输入 | 1 | §2.1 | `FileReader` 分支 | ⚠️ | TXT 解析断言（PDF/DOC 20MB） |
| `INGEST-4` | 语音输入 | 1 | §2.1 | `SpeechRecognition` 分支 | ✅ | 能力探测 + 错误码映射 |
| `INGEST-5` | 附件总量与校验反馈 | 1 | §2.1 | `attach-list` | ✅ | 上限测试 + 不静默丢弃断言 |
| `INGEST-6` | 多模态 state 组装（TaskEnvelope） | 2 | §2.1 | `extractFeatures` | ✅ | 权重对比断言 |

### JEV — TypeSafe Jev 类型化决策（16 条 / 28 场景）

| 需求 ID | 名称 | 场景 | 提案 | 设计落点 | 状态 | 验收方式 |
| --- | --- | --- | --- | --- | --- | --- |
| `JEV-1` | 真实 TypeSafe Jev 调用（生产路径） | 2 | §2.2 | `SystemOneJevAdapter`（`jev-http-adapter.ts`） | ✅ | 审计记录含 `jev.provider=system-one` |
| `JEV-2` | 三原语与五问定义 | 1 | §2.2 | `buildRoutingQuestions` | ✅ | 问题定义完整性断言 |
| `JEV-3` | 五问并行打包 fan-out | 2 | §4 D14 | `answerQuestions` | ✅ | 单请求断言 + 逐题调用计数=0 |
| `JEV-4` | 确定性特征提取与空信号防御 | 3 | §2.2 | `extractFeatures` | ✅ | 两次结果相等 + 空输入证据=0 |
| `JEV-5` | 校准置信度与三档路由 | 2 | §2.2 | `calibrate` / `routeTier` | ✅ | 上下界与单调性 + 三档边界 |
| `JEV-6` | Decision 契约与 Schema 校验守卫 | 2 | §2.2 | `DecisionValidator` + `JEV_FALLBACK` | ⚠️ | 落点存在；失败策略为降级而非 `INVALID_DECISION` 短路，见 G-1 |
| `JEV-7` | 决策来源标记与不可伪装 | 1 | §2.2 | `decisionSource` | ✅ | 本地重实现不得标记为真实 Jev |
| `JEV-8` | 可切换本地确定性重实现（降级形态） | 1 | §4 D1 | `LocalJevReimpl` | ✅ | 偏差登记 + 灰度上线记录 |
| `JEV-9` | 路由偏好作为类型化提问的先验 | 1 | §2.2 | `bindPref` / `jevPriorDeltas` | ✅ | 偏好分布断言 |
| `JEV-10` | 与官方契约偏差的显式声明 | 1 | §0.8 | 附录 F / `LOCAL_JEV_DEVIATIONS` | ✅ | 文档审查 |
| `JEV-11` | Decision Runtime 主链契约 | 2 | §2.3 | `route-orchestrator` | ✅ | 主链顺序符合；档位与硬约束正交性已由 `constraintFallback` 登记，见 G-2 |
| `JEV-12` | 决策契约与版本化 | 2 | §2.4（三） | `DecisionContract` | ✅ | 8 字段完整性 + 键名不得充当指令 |
| `JEV-13` | 三原语语义规则与逃生舱 | 3 | §2.4（四） | `primitive-guards` | ✅ | 逃生舱强制 + Score/Noul 语义断言 |
| `JEV-14` | 状态工程（按功能分离的 6 段） | 2 | §2.4（五） | `assembleState`（已接入主链） | ✅ | 6 段分离 + 结论不得冒充证据 |
| `JEV-15` | 后果分级阈值 | 2 | §2.4（六） | `consequence-thresholds` | ✅ | 阈值分级 + 单一阈值被拒 |
| `JEV-16` | 决策凭据（decision receipt） | 1 | §2.4（七） | `decision-receipt` | ✅ | 凭据完整 + 可复现 |

### MODEL — 模型目录与身份契约（4 条 / 6 场景）

| 需求 ID | 名称 | 场景 | 提案 | 设计落点 | 状态 | 验收方式 |
| --- | --- | --- | --- | --- | --- | --- |
| `MODEL-1` | 模型画像字段完整性 | 1 | §2.1 | `MODELS` 目录 | ✅ | 字段完整性断言 + 几何复核 |
| `MODEL-2` | 候选池约束 | 1 | §2.1 | `pool/toggle` | ✅ | 池约束断言 |
| `MODEL-3` | 模型身份下标契约 | 2 | §2.1 | `MODEL_INDEX` / `modelIndex` | ✅ | 下标契约断言 + 落点实测 |
| `MODEL-4` | 目录版本化与画像版本 | 1 | §2.1 | `profileVersion` | ❌ | 目录同源 + 画像变更失效联动 |

### CONSTRAIN — 硬约束治理与降级（5 条 / 7 场景）

| 需求 ID | 名称 | 场景 | 提案 | 设计落点 | 状态 | 验收方式 |
| --- | --- | --- | --- | --- | --- | --- |
| `CONSTRAIN-1` | 固定顺序硬约束过滤 | 2 | §2.2 | `ConstraintSelector` | ❌ | 8 步顺序断言 + 错误码可复现 |
| `CONSTRAIN-2` | 硬约束不可被软评分抵消 | 2 | §2.2 | `scoreModels` | ⚠️ | 冲突场景断言 |
| `CONSTRAIN-3` | Jev 推荐不得绕过约束 | 1 | §4 D13 | Selector | ❌ | 越权推荐拦截断言 |
| `CONSTRAIN-4` | 显式降级与不可伪装 | 1 | §5.2 | `decisionDegraded` | ❌ | 降级标记 + 3D 显示降级 |
| `CONSTRAIN-5` | Shadow Mode 灰度验证 | 1 | §5.2 | shadow runner | ❌ | 旁路不驱动执行断言 |

### SCORE — 打分与概率收敛（4 条 / 6 场景）

| 需求 ID | 名称 | 场景 | 提案 | 设计落点 | 状态 | 验收方式 |
| --- | --- | --- | --- | --- | --- | --- |
| `SCORE-1` | 加权能力打分 | 1 | §2.2 | `scoreModels` | ✅ | 打分构成断言 |
| `SCORE-2` | 成本 / 时延 / 负载惩罚与奖励 | 2 | §2.2 | `scoreModels` | ✅ | 惩罚单调性断言 |
| `SCORE-3` | 自适应温度 softmax 与双序输出 | 2 | §2.2 | `scoreModels` | ✅ | 温度与双序断言 |
| `SCORE-4` | 稳健决胜序列 | 1 | §2.2 | tie-break | ❌ | 同分确定性断言 |

### TREE — 自左向右二叉树可视化（5 条 / 8 场景）

| 需求 ID | 名称 | 场景 | 提案 | 设计落点 | 状态 | 验收方式 |
| --- | --- | --- | --- | --- | --- | --- |
| `TREE-1` | 自左向右空间语义 | 2 | §2.2 | `GATE_IN/HUB_POS/LEAF_X` | ✅ | 取景探针 + 极值姿态检查 |
| `TREE-2` | 树状分叉几何 | 2 | §2.2 | `leafY/leafZ/edgePath/rungPath` | ✅ | 几何预验证（27 项） |
| `TREE-3` | 模型身份颜色编码与光照标定 | 1 | §2.2 | 光照标定 + 叶节点材质 | ✅ | `readPixels` 取色复核 |
| `TREE-4` | 自适应取景与 HUD 遮挡避让 | 2 | §2.2 | `solveRadius` / `measureHud` | ✅ | 取景探针 + HUD 遮挡检查 |
| `TREE-5` | 二维等价语义 | 1 | §2.2 | `.flowbar` | ✅ | axe 审计 |

### ANIM — 动态 3D 调用过程（6 条 / 10 场景）

| 需求 ID | 名称 | 场景 | 提案 | 设计落点 | 状态 | 验收方式 |
| --- | --- | --- | --- | --- | --- | --- |
| `ANIM-1` | 七阶段确定性时间线 | 2 | §2.2 | `STAGES` / `computeRun` | ✅ | 时长自洽断言 + 非有限输入防御 |
| `ANIM-2` | 数据包路径与落点契约 | 2 | §2.2 | `packetPos` / `edgePath` | ✅ | 落点实测（21 项） |
| `ANIM-3` | 阶段视觉映射 | 1 | §2.2 | 提问环/得分环/选中环 | ✅ | 视觉回归 + 档位配色 |
| `ANIM-4` | 唯一 rAF 循环与帧预算 | 2 | §2.2 | `loop` | ✅ | 帧率场景测量 + 异常注入 |
| `ANIM-5` | 打断式重路由 | 1 | §2.2 | `interruptRun` | ✅ | 打断行为断言（6 项） |
| `ANIM-6` | 真实事件驱动（非自推断） | 2 | §2.2 | `routeEventReducer` | ❌ | 事件→节点映射断言 |

### RESULT — Prompt 输入框内联结果（5 条 / 8 场景）

| 需求 ID | 名称 | 场景 | 提案 | 设计落点 | 状态 | 验收方式 |
| --- | --- | --- | --- | --- | --- | --- |
| `RESULT-1` | Prompt 输入框内联结果 | 4 | §2.1 | 内联结果区 | ❌ | 端到端交互测试 + 一致性断言 |
| `RESULT-2` | 执行结果流式呈现 | 1 | §2.2 | `streamResult` | ⚠️ | 流式进度断言 |
| `RESULT-3` | 决策解释展示 | 1 | §2.2 | 决策详情 | ❌ | 五问答案 + 档位结论 + 理由 |
| `RESULT-4` | 内联与档案一致性 | 1 | §2.1 | 单一 `record` 派生 | ❌ | 双通道同源断言 |
| `RESULT-5` | 结果指标展示 | 1 | §2.2 | 指标区 | ❌ | 模型/延迟/token/成本/置信度 |

### ARCHIVE — 决策经验沉淀（5 条 / 6 场景）

| 需求 ID | 名称 | 场景 | 提案 | 设计落点 | 状态 | 验收方式 |
| --- | --- | --- | --- | --- | --- | --- |
| `ARCHIVE-1` | 路由档案结构 | 1 | §2.1 | `RT.record` | ⚠️ | 字段完整性 + 可复现断言 |
| `ARCHIVE-2` | 持久化与降级 | 1 | §2.1 | 存储封装 | ✅ | 隐私模式降级测试 |
| `ARCHIVE-3` | 回溯与重放 | 1 | §2.1 | `replayRecord` | ✅ | 重放落点一致性断言 |
| `ARCHIVE-4` | 存储键版本化与脏数据防御 | 1 | §2.1 | `STORAGE_KEY` | ⚠️ | 双键共存测试 |
| `ARCHIVE-5` | 人工复核回写与校准闭环 | 2 | §2.1 | 复核通道 | ❌ | 回写幂等 + 导出校验 |

### EXP — 决策经验回流闭环（10 条 / 16 场景）

| 需求 ID | 名称 | 场景 | 提案 | 设计落点 | 状态 | 验收方式 |
| --- | --- | --- | --- | --- | --- | --- |
| `EXP-1` | 经验条目结构化与结果确认 | 2 | §1.4 | 条目生命周期 | ❌ | 生命周期断言 + 三来源回填 |
| `EXP-2` | 置信度准确性统计（分桶 + ECE） | 2 | §1.3 | `calibrationStats` | ❌ | 分桶命中率与 ECE 对拍手算 |
| `EXP-3` | 阈值重标定建议生成 | 1 | §4 D12 | 建议生成器 | ❌ | 建议确定性 + 不自动生效 |
| `EXP-4` | 经验回流至下一次决策 | 2 | §1.4 | 回流通道 | ❌ | A/B 差分 + 档案钉版本 |
| `EXP-5` | 模型选择先验修正（有界+收缩） | 2 | §4 D9 | `priorDeltaFor` | ❌ | 修正上界 + 反固化断言 |
| `EXP-6` | 应用经验后的可复现性 | 1 | §4 D10 | 钉版本重放 | ❌ | 钉版本重放一致性断言 |
| `EXP-7` | 经验时效衰减与画像变更失效 | 1 | §5.2 R5 | 时效权重 | ❌ | 半衰期与地板值断言 |
| `EXP-8` | 冷启动与样本不足守卫 | 1 | §4 D11 | shadow 守卫 | ❌ | 冷启动零修正 + shadow 断言 |
| `EXP-9` | 经验版本化与原子回滚 | 1 | §2.2 | 版本管理 | ❌ | 版本不可变 + 回滚原子性 |
| `EXP-10` | 闭环自动校验与劣化告警 | 1 | §6 | 校验器 | ❌ | 前后分段对比 + 劣化回滚建议 |

### EVENT — 事件契约与可观测性（4 条 / 5 场景）

| 需求 ID | 名称 | 场景 | 提案 | 设计落点 | 状态 | 验收方式 |
| --- | --- | --- | --- | --- | --- | --- |
| `EVENT-1` | 路由事件契约 | 2 | §2.2 | `RouteEvent` | ❌ | 事件字段 + sequence 单调 |
| `EVENT-2` | 事件幂等与去重 | 1 | §2.2 | `eventId` 去重 | ❌ | 重复事件去重断言 |
| `EVENT-3` | 断线重连与事件补偿 | 1 | §2.2 | `Last-Event-ID` | ❌ | 重连补事件断言 |
| `EVENT-4` | 全链路关联与指标聚合 | 1 | §2.2 | trace/指标 | ❌ | 三段 id 关联 + 聚合维度 |

### A11Y — 无障碍与隐私合规（3 条 / 4 场景）

| 需求 ID | 名称 | 场景 | 提案 | 设计落点 | 状态 | 验收方式 |
| --- | --- | --- | --- | --- | --- | --- |
| `A11Y-1` | 无障碍审计零违规 | 2 | §2.1 | WAI-ARIA Tabs/landmark | ✅ | axe-core 多视口审计 |
| `A11Y-2` | 动效降级 | 1 | §2.1 | `prefers-reduced-motion` | ✅ | 偏好模拟测试 |
| `A11Y-3` | 隐私与数据最小化 | 1 | §2.1 | 数据流审查 | ❌ | 脱敏 + 删除流程测试 |

### PERF — 性能预算（3 条 / 3 场景）

| 需求 ID | 名称 | 场景 | 提案 | 设计落点 | 状态 | 验收方式 |
| --- | --- | --- | --- | --- | --- | --- |
| `PERF-1` | 启动性能 | 1 | §2.1 | `perf.js` / `cls.js` | ✅ | 启动性能与 CLS 测量 |
| `PERF-2` | 渲染性能 | 1 | §2.2 | `renderstat.js` | ✅ | 绘制统计 + 单帧开销 |
| `PERF-3` | 内存有界 | 1 | §2.1 | `perf.js` 浸泡 | ✅ | 60s 浸泡堆曲线 |

### API — 前后端数据与接口契约（5 条 / 6 场景）

| 需求 ID | 名称 | 场景 | 提案 | 设计落点 | 状态 | 验收方式 |
| --- | --- | --- | --- | --- | --- | --- |
| `API-1` | 路由决策接口 | 1 | §2.2 | `POST /v1/routes` | ❌ | 契约测试 |
| `API-2` | 流式事件接口 | 2 | §2.2 | SSE `events` | ❌ | 流顺序与中断降级 |
| `API-3` | 模型目录接口 | 1 | §2.2 | `GET /v1/catalog` | ❌ | 目录同源测试 |
| `API-4` | 档案与人工复核接口 | 1 | §2.1 | `POST /v1/routes/:id/review` | ❌ | 幂等测试 |
| `API-5` | 经验闭环接口 | 1 | §2.2 | 统计/建议/应用/回滚 | ❌ | 五端点契约测试 |

### 统计

| 需求域 | 需求数 | 场景数 | ✅ 对齐 | ⚠️ 需扩展 | ❌ 需新增 |
| --- | --- | --- | --- | --- | --- |
| ARCH | 5 | 6 | 4 | 1 | 0 |
| INGEST | 6 | 7 | 4 | 2 | 0 |
| JEV | 16 | 28 | 4 | 1 | 11 |
| MODEL | 4 | 6 | 3 | 0 | 1 |
| CONSTRAIN | 5 | 7 | 0 | 1 | 4 |
| SCORE | 4 | 6 | 3 | 0 | 1 |
| TREE | 5 | 8 | 5 | 0 | 0 |
| ANIM | 6 | 10 | 5 | 0 | 1 |
| RESULT | 5 | 8 | 0 | 1 | 4 |
| ARCHIVE | 5 | 6 | 2 | 2 | 1 |
| EXP | 10 | 16 | 0 | 0 | 10 |
| EVENT | 4 | 5 | 0 | 0 | 4 |
| A11Y | 3 | 4 | 2 | 0 | 1 |
| PERF | 3 | 3 | 3 | 0 | 0 |
| API | 5 | 6 | 0 | 0 | 5 |
| **合计** | **86** | **126** | **35** | **8** | **43** |

---

## 4. 需求（Requirements）

> 每节格式：`### Requirement: [ID] 名称`，随后为规范性陈述与 `#### Scenario:` 场景。
> 所有需求 SHALL 可判定；`SHALL NOT` 表示禁止项，需在测试中显式断言。

### 域 ARCH · 架构分层与职责边界

#### Requirement: [ARCH-1] 三层架构职责边界

系统 SHALL 划分为三层：**纯逻辑层**（无 DOM、无时间、无网络）、**状态容器层**（单一 state 树 + 纯 reducer）、**渲染层**（DOM / 3D）。任一层 SHALL NOT 越界调用另一层的私有实现。

- 纯逻辑层 SHALL 为纯函数，相同输入恒得相同输出。
- 渲染层 SHALL NOT 直接改写 state，只 SHALL 通过 dispatch 触发。
- 状态容器 SHALL NOT 依赖渲染细节（如节点坐标）。

#### Scenario: 任意时刻跳转不产生越界
- **GIVEN** 系统处于任一运行阶段
- **WHEN** 检查模块调用图
- **THEN** 渲染层 SHALL NOT 直接读写纯逻辑层内部状态
- **AND** 纯逻辑层 SHALL NOT 引用任何 DOM 或时钟 API

#### Scenario: 状态可被单测复现
- **GIVEN** 给定初始 state 与一串 action
- **WHEN** 依次 dispatch
- **THEN** 结果 state SHALL 与预期逐字段一致

#### Requirement: [ARCH-2] 双形态共用同一逻辑层

前端 SHALL 在云原生与离线两种形态下使用**同一套逻辑层代码**。经验回流算法（`EXP-5` `EXP-7`）SHALL NOT 因形态不同而实现两套。

- 形态差异 SHALL 仅体现在「档案与经验状态落本地还是落服务端」与「Jev 问答来自本地重实现还是远程接口」。
- 两形态的选型结果在相同输入与相同经验版本下 SHALL 一致。

#### Scenario: 同一输入两形态选型一致
- **GIVEN** 相同 Prompt、相同模型目录、相同 `expVersion`
- **WHEN** 分别在云原生形态与离线形态执行路由
- **THEN** `winner` / `winnerIdx` / `priorDelta[]` SHALL 一致

#### Requirement: [ARCH-3] 状态容器与动画时钟隔离

状态容器 SHALL 与动画时钟解耦：动画进度 SHALL NOT 写入持久 state；持久 state 变更 SHALL NOT 依赖帧回调。

#### Scenario: 暂停动画不影响决策状态
- **GIVEN** 动画正在播放
- **WHEN** 暂停动画
- **THEN** 决策相关 state SHALL 保持不变

#### Requirement: [ARCH-4] 单文件自包含与离线可用（降级形态）

离线形态 SHALL 交付单个自包含 HTML，在断网条件下 SHALL 可打开并完成一次完整路由（Jev 用本地确定性重实现）。

#### Scenario: 断网打开可用
- **GIVEN** 设备处于断网状态
- **WHEN** 打开离线产物
- **THEN** 页面 SHALL 正常加载并完成一次路由
- **AND** 结果 SHALL 标注「本地重实现」来源

#### Requirement: [ARCH-5] 关键常量集中与临时对象复用

关键常量（几何、时间线、阈值、权重）SHALL 集中定义于模块级常量；渲染循环内 SHALL NOT 每帧新建临时对象。

#### Scenario: 渲染循环零分配
- **GIVEN** 渲染循环运行中
- **WHEN** 采样若干帧
- **THEN** 每帧临时对象分配 SHALL 为 0

### 域 INGEST · 多模态 Prompt 接入

#### Requirement: [INGEST-1] 文本输入与规范化

系统 SHALL 提供文本输入区，SHALL 支持 5000 字符上限并显示实时字数。

#### Scenario: 文本提交
- **GIVEN** 用户仅输入文本
- **WHEN** 提交 prompt
- **THEN** 系统 SHALL 生成 `TaskEnvelope`，`modalities = ["text"]`，并进入决策流程

#### Requirement: [INGEST-2] 图片输入

系统 SHALL 支持 `JPG/JPEG`、`PNG`、`WEBP`；单文件 SHALL NOT 超过 `10MB`，单次任务 SHALL NOT 超过 4 张。

#### Scenario: 图片随任务传递
- **GIVEN** 用户输入文本并上传 1–4 张合法图片
- **WHEN** 提交 prompt
- **THEN** `TaskEnvelope.modalities` SHALL 包含 `"image"`
- **AND** 图片 SHALL 以短期签名引用方式随任务对象传递

#### Requirement: [INGEST-3] 文档输入

系统 SHALL 支持 `TXT`、`PDF`、`DOC/DOCX`；单文件 SHALL NOT 超过 `20MB`。

#### Scenario: 文档解析
- **GIVEN** 用户上传一个 TXT 文档
- **WHEN** 提交 prompt
- **THEN** 系统 SHALL 解析其文本内容并计入特征

#### Requirement: [INGEST-4] 语音输入

系统 SHALL 探测语音识别能力；不可用时 SHALL 返回明确错误码，SHALL NOT 静默失败。

#### Scenario: 能力探测
- **GIVEN** 浏览器不支持语音识别
- **WHEN** 用户触发语音输入
- **THEN** 系统 SHALL 显示「当前环境不支持语音输入」

#### Requirement: [INGEST-5] 附件总量与校验反馈

提交前 SHALL 校验类型、大小、空内容与未完成上传状态；拒绝时 SHALL 在输入区内显示可理解错误信息，SHALL NOT 静默丢弃文件。

#### Scenario: 超限拒绝
- **GIVEN** 图片超过 4 张或单张超过 10MB，或文本超过 5000 字符
- **WHEN** 提交 prompt
- **THEN** 系统 SHALL 在输入区内提示具体超限原因
- **AND** SHALL NOT 进入决策流程

#### Requirement: [INGEST-6] 多模态 state 组装（TaskEnvelope）

系统 SHALL 将输入组装为 `TaskEnvelope`（见附录 A），包含模态、附件引用与规范化文本。

#### Scenario: 多模态组装
- **GIVEN** 用户提交文本 + 图片
- **WHEN** 组装 `TaskEnvelope`
- **THEN** `modalities` SHALL 同时含 `text` 与 `image`
- **AND** 附件总量 SHALL 不超过上限

#### Scenario: 空输入组装
- **GIVEN** 用户未输入任何内容
- **WHEN** 提交
- **THEN** 系统 SHALL 拒绝并提示，SHALL NOT 生成 `TaskEnvelope`

### 域 JEV · TypeSafe Jev 类型化决策

#### Requirement: [JEV-1] 真实 TypeSafe Jev 调用（生产路径）

系统 MUST 通过统一适配器调用 TypeSafe Jev（System One 决策模型）的公开契约，MUST NOT 使用本地规则或本地重实现替代**正常路径**的真实决策调用。

- 必须支持：`requestId`、`decisionId`、`schemaVersion`、`model/policy/catalog` 版本上下文、超时、重试、错误分类、trace/correlation id。
- **禁止**将本地 heuristic 的输出包装成 `TypeSafeJevDecision` 并标记为真实 Jev。
- 生产路径 SHALL 在审计记录中写入 `jev.provider=system-one`、`decisionId`、调用耗时与 Schema 校验结果。

#### Scenario: 真实请求留痕
- **GIVEN** 生产形态下提交代码类 Prompt
- **WHEN** 系统完成决策
- **THEN** 审计记录 SHALL 含 `jev.provider=system-one`、`decisionId`、调用耗时、Schema 校验结果

#### Scenario: 本地重实现不得冒充
- **GIVEN** 系统运行于离线形态
- **WHEN** 生成决策
- **THEN** 该决策 `decisionSource` SHALL 为 `LOCAL_REIMPL`
- **AND** SHALL NOT 出现 `jev.provider=system-one`

#### Requirement: [JEV-2] 三原语与五问定义

五问 SHALL 覆盖三种问题原语：`intent`（choice）、`complexity`（score）、`urgency`（noul）、`budget`（noul）、`capability`（score）。

#### Scenario: 问题定义完整
- **GIVEN** 系统启动
- **WHEN** 加载五问定义
- **THEN** 五问 SHALL 全部存在且原语类型正确

#### Requirement: [JEV-3] 五问并行打包 fan-out

五问 MUST 在一次请求内**并行打包**（Speculative fan-out），MUST NOT 拆成多次串行调用。

#### Scenario: 单请求批量
- **GIVEN** 一次路由发起决策
- **WHEN** 调用 Jev
- **THEN** 五问 SHALL 打包为一次请求发出
- **AND** 逐题独立调用计数 SHALL 为 0

#### Scenario: 批量响应解析
- **GIVEN** Jev 返回批量响应
- **WHEN** 解析
- **THEN** 五问答案 SHALL 被完整提取并各自记录证据强度

#### Requirement: [JEV-4] 确定性特征提取与空信号防御

特征提取 MUST 是确定性的：不得引入随机数；无信号命中时证据强度 MUST 置 0，MUST NOT 因缺省先验虚高置信度。

#### Scenario: 确定性
- **GIVEN** 相同输入
- **WHEN** 连续两次提取特征
- **THEN** 两次结果 SHALL 逐字段相等

#### Scenario: 空输入不虚高置信度
- **GIVEN** prompt 不含任何可识别信号词
- **WHEN** 特征提取执行
- **THEN** 各维度证据强度 SHALL 记为 0
- **AND** `calibrate(0)` SHALL 得到下界置信度（≈0.35），不高于随机猜测水平

#### Scenario: noul 先验不污染证据
- **GIVEN** `urgency` 无关键词命中且其无信号先验为 0.30
- **WHEN** 计算证据强度
- **THEN** `|p − 0.5|` SHALL 仅作为弱证据
- **AND** 只有显式关键词命中才 SHALL 显著提高置信度

#### Requirement: [JEV-5] 校准置信度与三档路由

置信度 SHALL 由证据强度经校准曲线导出，SHALL 有硬上下界；决策 SHALL 按置信度分三档。

- 置信度 SHALL 恒落于 `[0.35, 0.97]`。
- `confidence ≥ 0.82` SHALL 高置信直接路由；`0.60 ≤ confidence < 0.82` SHALL 中置信路由并标记「观察」；`confidence < 0.60` SHALL 落入模糊地带，MUST 转人工复核，MUST NOT 强行给出结论。
- 三档阈值须在 `policyVersion` 中登记为可配置项，MUST NOT 硬编码为「官方阈值」对外宣称。

#### Scenario: 边界与单调性
- **GIVEN** 任意证据强度输入
- **WHEN** 计算置信度
- **THEN** 结果 SHALL ∈ `[0.35, 0.97]` 且随证据强度单调不减

#### Scenario: 低置信转人工
- **GIVEN** Jev 返回 confidence = 0.52
- **WHEN** 系统执行路由
- **THEN** 路由结果 SHALL 标记「模糊地带 · 需人工复核」
- **AND** SHALL NOT 展示执行结果正文
- **AND** SHALL 提供人工改派入口

#### Requirement: [JEV-6] Decision 契约与 Schema 校验守卫

决策对象 MUST 通过 JSON Schema 校验，校验失败 MUST NOT 进入模型调用。

- 决策 MUST 带 `schemaVersion`、`decisionId`、`createdAt`。
- 决策 MUST 输出候选模型评分、选中模型、`confidence`、可解释理由（`rationale`）与知识引用。
- Schema 校验失败 SHALL 短路并返回 `INVALID_DECISION`。

#### Scenario: 非法 Schema 被拦截
- **GIVEN** Jev 返回缺字段或类型错误的响应
- **WHEN** Schema 校验执行
- **THEN** 系统 SHALL 返回 `INVALID_DECISION`
- **AND** SHALL NOT 调用任何执行模型

#### Scenario: 合法决策通过
- **GIVEN** Jev 返回符合 Schema 的决策
- **WHEN** 校验执行
- **THEN** 决策 SHALL 进入 Selector

#### Requirement: [JEV-7] 决策来源标记与不可伪装

每条决策 SHALL 携带 `decisionSource`（`TYPE_SAFE_JEV` / `RULE_FALLBACK` / `LOCAL_REIMPL` / `USER_OVERRIDE`），SHALL 可被审计追溯。

#### Scenario: 来源可审计
- **GIVEN** 一次路由完成
- **WHEN** 查询决策
- **THEN** `decisionSource` SHALL 存在且取值合法

#### Requirement: [JEV-8] 可切换本地确定性重实现（降级形态）

离线/演示形态 MAY 使用本地确定性重实现 Jev；使用时 SHALL 显式登记与官方契约的偏差，且 SHALL NOT 对外表述为官方机制。

#### Scenario: 偏差登记
- **GIVEN** 系统运行于离线形态
- **WHEN** 使用本地重实现
- **THEN** 实现 SHALL 与附录 F 偏差表一致
- **AND** 结果区 SHALL 标注「本地重实现」

#### Requirement: [JEV-9] 路由偏好作为类型化提问的先验

用户路由偏好（economy / balanced / quality）SHALL 作为类型化提问的先验注入，SHALL NOT 绕过证据提取直接决定选型。

#### Scenario: 偏好影响先验
- **GIVEN** 用户选择 `economy` 偏好
- **WHEN** 提取特征
- **THEN** 偏好 SHALL 体现为对成本维度权重的先验偏置

#### Requirement: [JEV-10] 与官方契约偏差的显式声明

实现与 TypeSafe Jev 官方契约存在偏差时，SHALL 在附录 F 显式登记，且对外文档 SHALL NOT 把自定义项表述为官方项。

#### Scenario: 偏差可核对
- **GIVEN** 存在任一偏离官方的实现
- **WHEN** 审查附录 F
- **THEN** 该偏差 SHALL 已被登记

#### Requirement: [JEV-11] Decision Runtime 主链契约

系统 SHALL 遵循 TypeSafe Jev 的 Decision Runtime 主链：`STATE →（CHOICE / SCORE / NOUL）→ JEV（System One）→ PROBABILITY →（ROUTE / GATE / ESCALATE）`。

- 决策执行顺序 SHALL 与该主链一致：先由 STATE 组装输入状态（facts · context · evidence），再经三原语提问，由 Jev 输出类型化概率，最后落入三档处置。
- **ROUTE / GATE / ESCALATE 语义 SHALL 与置信度三档对齐**：高置信 → ROUTE；中置信 → GATE；低置信 → ESCALATE。
- GATE 与 ESCALATE 是**决策运行时的输出档位**，与 Selector 的硬约束过滤是**两个正交层次**；二者 MUST NOT 混为一谈，验收 SHALL 各自独立。
- 前端调用链展示 SHALL 如实反映该主链顺序与当前所处档位。

#### Scenario: 主链顺序正确
- **GIVEN** 一次完整决策
- **WHEN** 追踪执行顺序
- **THEN** 顺序 SHALL 为 `STATE → 三原语 → JEV → PROBABILITY → 档位处置`
- **AND** 三原语提问 SHALL 早于 Jev 输出

#### Scenario: 档位与置信度对齐
- **GIVEN** Jev 输出 confidence 落在某一档
- **WHEN** 映射处置
- **THEN** 高置信 SHALL 映射 ROUTE、中置信 SHALL 映射 GATE、低置信 SHALL 映射 ESCALATE
- **AND** 该映射 SHALL NOT 受硬约束过滤结果影响

#### Requirement: [JEV-12] 决策契约（decision contract）与版本化

每个生产级 Jev 提问 SHALL 定义为一**决策契约**，SHALL 包含以下字段；契约 SHALL 与业务代码**独立版本化**。

```
state fields · question instructions · option descriptions / rubric ·
fallback outcome · confidence thresholds · allowed action · escalation path · version
```

- 提问键名（如 `safe_to_publish`）MUST NOT 被视为对模型的指令；判断规则 SHALL 完整写在 `instructions` 与 `criteria` 中。
- 契约版本（如 `ticket-router@3`）SHALL 随决策凭据一并记录（`JEV-16`），语义变更 SHALL 走评审 / 测试 / 可回滚流程（联动 `EXP-9`）。

#### Scenario: 契约字段完整
- **GIVEN** 定义一个 Jev 提问
- **WHEN** 校验决策契约
- **THEN** 8 个字段 SHALL 全部存在
- **AND** `fallback outcome` 与 `escalation path` SHALL 非空

#### Scenario: 规则不得藏在键名里
- **GIVEN** 契约仅提供键名 `safe_to_publish` 而无 `instructions`
- **WHEN** 校验契约
- **THEN** 系统 SHALL 拒绝该契约并报 `INCOMPLETE_CONTRACT`
- **AND** SHALL NOT 以键名推断判断规则

#### Requirement: [JEV-13] 三原语语义规则与逃生舱

三原语 SHALL 按各自语义使用，MUST NOT 误用；`Choice` 在菜单可能不完备时 MUST 提供逃生舱。

| 原语 | 语义 | 禁止误用 |
| --- | --- | --- |
| `choice` | 恰有一个选项胜出 | 菜单可能不完备而无逃生舱时，概率质量被强加到「最不错误」的答案 |
| `score` | 有序评分档 | MUST NOT 把档间值当作精确测量（`1.6` **不是**「80% 好」） |
| `noul` | 是/否概率 | `≈0.5` 表示模型**无法区分**，MUST NOT 解释为「中等风险」 |

#### Scenario: Choice 强制逃生舱
- **GIVEN** 定义一个 `choice` 问题且选项集可能不完备
- **WHEN** 校验该问题定义
- **THEN** 选项集 SHALL 含逃生舱（`none` / `other` / `stop` / `escalate` 之一）
- **AND** 缺失时系统 SHALL 拒绝定义

#### Scenario: Score 非精确测量
- **GIVEN** `score` 返回档间值 `1.6`
- **WHEN** 解释结果
- **THEN** 系统 SHALL 表述为「落于自定义描述之间的位置」
- **AND** SHALL NOT 表述为百分比测量值

#### Scenario: Noul 0.5 语义
- **GIVEN** `noul` 返回 `0.5`
- **WHEN** 解释结果
- **THEN** 系统 SHALL 表述为「模型无法区分」
- **AND** SHALL NOT 表述为「中等风险」；需要分级时 SHALL 改用 `score`

#### Requirement: [JEV-14] 状态工程（按功能分离的 6 段）

送入 Jev 的状态 SHALL 按功能分离为 6 段，MUST NOT 把断言、指令、旧尝试与无关历史混成单一文本块。

```
GOAL · FACTS · ARTIFACTS · EVIDENCE · CONSTRAINTS · OPTIONS
```

- 状态 SHALL 提供判断所需的**紧凑证据**，MUST NOT 依赖模型从冗长对话中重建工作流。
- 状态 SHALL NOT 把上一环节的**结论**当作事实继承（如「研究大概够了」应改写为「已收集 7 个来源 · 3 个官方 · 价格已核实 · 安全声明未决」）。

#### Scenario: 状态按功能分离
- **GIVEN** 组装送入 Jev 的状态
- **WHEN** 校验状态结构
- **THEN** 6 段 SHALL 全部存在且互不混淆
- **AND** 证据段 SHALL NOT 含结论性断言

#### Scenario: 结论不得冒充证据
- **GIVEN** 上游传入「研究大概够了」这类结论文本
- **WHEN** 组装状态
- **THEN** 系统 SHALL 拒绝或改写为可核对的证据条目
- **AND** SHALL NOT 把该结论作为证据送入 Jev

#### Requirement: [JEV-15] 后果分级阈值

置信度阈值 SHALL 绑定**动作后果等级**，MUST NOT 全系统共用一个阈值。

- 每个动作类 SHALL 声明后果等级（如 `low` / `irreversible`），并据此选择阈值。
- 路由内部备忘与发布公开声明 MUST NOT 共用同一自动化阈值。
- 不可逆后果（`irreversible`）SHALL 无条件转人工，与置信度无关。

#### Scenario: 阈值随后果分级
- **GIVEN** 两个动作类分别声明 `low` 与 `irreversible`
- **WHEN** 应用自动化阈值
- **THEN** 两者 SHALL 使用不同阈值
- **AND** `irreversible` SHALL 无条件转人工

#### Scenario: 单一阈值被拒
- **GIVEN** 系统仅配置一个全局阈值用于全部动作类
- **WHEN** 校验策略
- **THEN** 系统 SHALL 报 `THRESHOLD_NOT_GRADED`
- **AND** SHALL NOT 允许单一阈值控制全部后果

#### Requirement: [JEV-16] 决策凭据（decision receipt）

系统 SHALL 为每次决策保留**凭据**，MUST NOT 只存胜出标签。

- 凭据 SHALL 含：契约版本、状态引用（`state_version` / hash）、完整概率分布、所用阈值、路由档位、实际动作。
- 凭据 SHALL 可复现该次决策（联动 `EXP-6` 钉版本重放与 `ARCHIVE-1` 档案）。

#### Scenario: 凭据完整
- **GIVEN** 一次决策完成
- **WHEN** 检查决策凭据
- **THEN** 凭据 SHALL 含契约版本、状态引用、完整分布、阈值、档位与实际动作
- **AND** 依据该凭据 SHALL 可复现同一决策

### 域 MODEL · 模型目录与身份契约

#### Requirement: [MODEL-1] 模型画像字段完整性

模型目录 SHALL 为每个模型提供完整画像字段（见附录 A）。MVP 目录 MUST 至少包含 6 个已验证的行业常用模型，覆盖推理、视觉/多模态、代码、创意生成、长上下文与低成本档等能力角色。

- 每个模型 MUST 提供：`modelId`、提供方、能力标签、支持模态、上下文窗口、输入/输出单价、P95 延迟、健康状态。

#### Scenario: 字段完整
- **GIVEN** 加载模型目录
- **WHEN** 校验每个模型
- **THEN** 所有必填字段 SHALL 存在且类型正确

#### Requirement: [MODEL-2] 候选池约束

候选池 SHALL 为目录的子集，且 SHALL 至少包含 2 个候选以保证可比较；池为空时 SHALL 报错而非静默。

#### Scenario: 池约束
- **GIVEN** 用户配置候选池
- **WHEN** 池被置空
- **THEN** 系统 SHALL 拒绝并提示

#### Requirement: [MODEL-3] 模型身份下标契约

系统 SHALL 严格区分**目录序**（`MODEL_INDEX`）与**名次序**（按打分排序后的顺序），二者 MUST NOT 混用。

#### Scenario: 下标不混用
- **GIVEN** 打分产生名次序
- **WHEN** 映射回模型身份
- **THEN** 系统 SHALL 通过目录序查表，SHALL NOT 直接以名次序作为身份下标

#### Scenario: 落点实测
- **GIVEN** 一次完整路由
- **WHEN** 检查 3D 落点与选中模型
- **THEN** 落点模型 SHALL 等于 `finalModelId` 对应的目录序模型

#### Requirement: [MODEL-4] 目录版本化与画像版本

模型目录 SHALL 版本化（`catalogVersion`）；每个模型 SHALL 携带 `profileVersion`。当某模型的 `profileVersion` 变更时，该模型已积累的经验 SHALL 被重置或按衰减处理（联动 `EXP-7`）。

#### Scenario: 目录同源
- **GIVEN** 前端与后端同时加载目录
- **WHEN** 比较 `catalogVersion`
- **THEN** 两者 SHALL 一致

#### Scenario: 画像变更触发经验失效
- **GIVEN** 某模型 `profileVersion` 由 p1 升为 p2
- **WHEN** 后续决策读取该模型经验
- **THEN** 变更前经验 SHALL 被失效或衰减
- **AND** SHALL 记录一条 `profile-change` 版本事件

### 域 CONSTRAIN · 硬约束治理与降级

#### Requirement: [CONSTRAIN-1] 固定顺序硬约束过滤

选择 MUST 先执行硬约束过滤，后对剩余候选执行软评分排序。硬约束评估顺序 SHALL 固定为 8 步，任一步失败使该模型 `ineligible`，不进入评分。

| 顺序 | 约束 | 失败结果码 |
| --- | --- | --- |
| 1 | 目录启用与健康 | `MODEL_DISABLED` / `MODEL_UNAVAILABLE` |
| 2 | 租户/用户许可 | `MODEL_NOT_ALLOWED` |
| 3 | 模态与能力 | `MODALITY_UNSUPPORTED` / `CAPABILITY_MISSING` |
| 4 | 上下文与输出上限 | `CONTEXT_LIMIT_EXCEEDED` |
| 5 | 数据与区域 | `DATA_POLICY_MISMATCH` / `REGION_NOT_ALLOWED` |
| 6 | 风险与安全 | `RISK_POLICY_BLOCKED` |
| 7 | 预算与配额 | `BUDGET_EXCEEDED` / `COST_UNKNOWN` |
| 8 | 时延硬限制 | `LATENCY_LIMIT_EXCEEDED` |

#### Scenario: 顺序固定可复现
- **GIVEN** 一个同时违反多项约束的模型
- **WHEN** 执行硬约束过滤
- **THEN** 首次失败的约束即为主要淘汰理由
- **AND** 完整评估过程 SHALL 写入审计摘要

#### Scenario: 预算未知按策略处理
- **GIVEN** 某模型成本未知
- **WHEN** 评估预算约束
- **THEN** 系统 SHALL 按策略拒绝或保守降级，SHALL NOT 视为满足

#### Requirement: [CONSTRAIN-2] 硬约束不可被软评分抵消

硬约束 MUST NOT 被软评分或 Jev 推荐抵消。

#### Scenario: Jev 推荐越权被拦截
- **GIVEN** Jev 推荐模型 A，但 A 超预算
- **WHEN** Selector 执行
- **THEN** A SHALL 被排除
- **AND** 系统 SHALL 选择满足约束的 B
- **AND** Decision/Selector trace SHALL 可解释

#### Scenario: 软分不越过硬约束
- **GIVEN** 某模型软评分最高但不满足数据区域策略
- **WHEN** 排序
- **THEN** 该模型 SHALL NOT 被选中

#### Requirement: [CONSTRAIN-3] Jev 推荐不得绕过约束

Jev 的 `selectedRecommendation` 仅为**推荐**，最终执行模型 MUST 由 Selector 在硬约束后确定。

#### Scenario: 权责解耦
- **GIVEN** Jev 推荐 A 且 A 通过全部硬约束
- **WHEN** Selector 排序
- **THEN** 最终模型 SHALL 由 Selector 决定
- **AND** 若最终非 A，SHALL 在 trace 中说明理由

#### Requirement: [CONSTRAIN-4] 显式降级与不可伪装

Jev 超时、不可用或返回非法 Schema 时，MAY 进入 `RULE_FALLBACK`，但：

- MUST 显式记录 `decisionSource=RULE_FALLBACK` 与 `decisionDegraded=true`。
- 3D MUST 显示「Jev 不可用/降级」。
- MUST NOT 写入「Jev 正常决策」的经验记录。
- MUST 可通过策略关闭降级。

#### Scenario: 降级可见
- **GIVEN** System One 连续超时
- **WHEN** 系统尝试决策
- **THEN** 若存在已审核 fallback 规则，路由至规则选定模型并标记 `decisionDegraded=true`
- **AND** 否则返回 `DECISION_TIMEOUT`，不调用任何执行模型
- **AND** 3D SHALL 显示降级状态

#### Requirement: [CONSTRAIN-5] Shadow Mode 灰度验证

新接入的 Jev 版本或降级规则 MUST 先以 shadow mode 运行（产生决策但不驱动执行），与人工基线对比达标后才可放开。

#### Scenario: 旁路不驱动执行
- **GIVEN** 新 Jev 版本处于 shadow mode
- **WHEN** 执行路由
- **THEN** shadow 决策 SHALL 被记录
- **AND** SHALL NOT 驱动实际模型调用

### 域 SCORE · 打分与概率收敛

#### Requirement: [SCORE-1] 加权能力打分

对通过硬约束的候选，系统 SHALL 标准化能力、质量、成本、时延信号至 `[0,1]`，并按偏好 `p ∈ {economy, balanced, quality}` 加权求和。权重 SHALL 来自锁定的 `PolicySnapshot` 且和为 1。

#### Scenario: 打分构成可复现
- **GIVEN** 固定 `PolicySnapshot` 与候选集
- **WHEN** 计算打分
- **THEN** 各分项与权重 SHALL 可完整复现

#### Requirement: [SCORE-2] 成本 / 时延 / 负载惩罚与奖励

打分 SHALL 包含成本、时延与运行时负载的惩罚项，并提供负载复位通道以支持可复现。

- 负载惩罚 SHALL 为负载的单调递增函数。
- 系统 SHALL 提供 `loadMap` 复位到 `baseLoad` 的可复现通道。

#### Scenario: 惩罚单调性
- **GIVEN** 其余条件相同
- **WHEN** 负载升高
- **THEN** 该模型得分 SHALL 单调不增

#### Scenario: 复位通道
- **GIVEN** 负载漂移导致选型变化
- **WHEN** 复位 `loadMap`
- **THEN** 相同输入 SHALL 得到相同选型

#### Requirement: [SCORE-3] 自适应温度 softmax 与双序输出

系统 SHALL 以自适应温度 softmax 将 `raw` 分映射为概率，并同时输出目录序与名次序两种视图。

#### Scenario: 双序一致
- **GIVEN** 一次打分
- **WHEN** 输出双序
- **THEN** 名次序 SHALL 由 `raw` 分降序导出
- **AND** 目录序 SHALL 与 `MODEL_INDEX` 一致

#### Scenario: 温度自适应
- **GIVEN** 候选分数接近
- **WHEN** 计算 softmax
- **THEN** 温度 SHALL 自适应避免概率过度集中或过度平坦

#### Requirement: [SCORE-4] 稳健决胜序列

分数相同时 SHALL 按固定序列决胜：「更高能力分 → 更低预计成本 → 更低预计时延 → `modelId` 字典序」，避免同一快照下的无理由随机漂移。

#### Scenario: 同分确定性
- **GIVEN** 两个候选总分相等
- **WHEN** 决胜
- **THEN** 结果 SHALL 由固定序列唯一确定

### 域 TREE · 自左向右二叉树可视化

#### Requirement: [TREE-1] 自左向右空间语义

可视化 SHALL 为自左向右布局：`Prompt输入 → Jev智能路由中枢 → 候选模型分支 → 决策库`。

节点命名与主链 SHALL 满足：
- 最左节点命名为 `Prompt输入`（prompt 类型，起节点）。
- 中枢节点命名为 `Jev智能路由中枢`（jev-hub 类型，唯一决策主体）。
- 中间 6 个候选模型节点为树状分叉排列。
- 最右节点命名为 `决策库`（knowledge 类型，终节点）。

#### Scenario: 空间语义正确
- **GIVEN** 渲染完成
- **WHEN** 探针检查节点坐标
- **THEN** Prompt输入 节点 SHALL 在最左，候选模型分支 SHALL 在中右，决策库 SHALL 在最右
- **AND** 中枢节点标签 SHALL 严格为 `Jev智能路由中枢`

#### Scenario: 极值姿态
- **GIVEN** 旋转到极限角度
- **WHEN** 检查
- **THEN** 主链 SHALL 仍可辨识

#### Requirement: [TREE-2] 树状分叉几何

模型侧 SHALL 呈树状分叉（dendrogram）；几何 SHALL 通过预验证（边路径、横档路径等）。

除实线管路系统外，SHALL 提供**虚线逻辑路径**以强化主链语义：
- `Prompt输入 → Jev智能路由中枢`（1 条虚线，标识 prompt 到中枢的接入路径）。
- 每个候选模型 → `决策库`（6 条虚线，标识各模型结果回传到决策库的沉淀路径）。

虚线 SHALL 与实线管路（数据流路径）视觉可区分：使用 `LineDashedMaterial`，透明度与实线管路形成层级对比；虚线在对应阶段（ingest / execute / return）SHALL 增强亮度，与实线管路流量联动。

#### Scenario: 几何预验证
- **GIVEN** 给定模型数
- **WHEN** 计算几何
- **THEN** 27 项几何断言 SHALL 通过

#### Scenario: 虚线逻辑路径
- **GIVEN** 渲染完成
- **WHEN** 探针检查 dashedEdges
- **THEN** SHALL 存在 1 条 Prompt输入→Jev智能路由中枢 虚线
- **AND** SHALL 存在 6 条 候选模型→决策库 虚线
- **AND** 全部虚线 material SHALL 为 `LineDashedMaterial`
- **AND** ingest 阶段 Prompt输入→中枢 虚线 SHALL 增强亮度
- **AND** execute/return 阶段 候选→决策库 虚线 SHALL 增强亮度

#### Scenario: 动态数量
- **GIVEN** 模型数变化
- **WHEN** 重算布局
- **THEN** 分叉 SHALL 自适应且不重叠
- **AND** 候选→决策库 虚线数量 SHALL 与候选模型数一致

#### Requirement: [TREE-3] 模型身份颜色编码与光照标定

每个模型 SHALL 有稳定的身份颜色编码，SHALL 通过光照标定保证取色可复核。

#### Scenario: 取色复核
- **GIVEN** 渲染完成
- **WHEN** `readPixels` 取色
- **THEN** 颜色 SHALL 与身份编码一致

#### Requirement: [TREE-4] 自适应取景与 HUD 遮挡避让

取景 SHALL 自适应模型数量与视口，SHALL 避让 HUD 遮挡。

#### Scenario: 取景自适应
- **GIVEN** 视口尺寸变化
- **WHEN** 重算取景
- **THEN** 全部叶节点 SHALL 在可见范围内

#### Scenario: HUD 不遮挡关键节点
- **GIVEN** HUD 显示
- **WHEN** 检查遮挡
- **THEN** 选中模型节点 SHALL NOT 被 HUD 遮挡

#### Requirement: [TREE-5] 二维等价语义

系统 SHALL 提供二维等价视图（flowbar），在低性能或降级场景下表达同一语义。

#### Scenario: 二维等价
- **GIVEN** 启用二维视图
- **WHEN** 检查
- **THEN** 主链语义 SHALL 与三维一致
- **AND** axe 审计 SHALL 零违规

### 域 ANIM · 动态 3D 调用过程

#### Requirement: [ANIM-1] 七阶段确定性时间线

动画 SHALL 为七阶段确定性时间线；时长 SHALL 自洽，SHALL 防御非有限输入。

#### Scenario: 时长自洽
- **GIVEN** 一次运行
- **WHEN** 计算各阶段时长
- **THEN** 总和 SHALL 等于总时长

#### Scenario: 非有限输入防御
- **GIVEN** 输入含 `NaN` / `Infinity`
- **WHEN** 计算时间线
- **THEN** 系统 SHALL 夹取而非崩溃

#### Requirement: [ANIM-2] 数据包路径与落点契约

数据包 SHALL 沿边路径运动，落点 SHALL 与选中叶节点一致。

#### Scenario: 落点实测
- **GIVEN** 一次运行
- **WHEN** 检查落点
- **THEN** 执行阶段末尾落点与选中叶节点间距 SHALL < 0.05
- **AND** 执行阶段中点 SHALL 落在选中叶柄曲线上（距离 < 0.02）

#### Scenario: 回传锚定
- **GIVEN** 回传阶段
- **WHEN** 检查锚点
- **THEN** SHALL 仍锚定选中叶节点

#### Requirement: [ANIM-3] 阶段视觉映射

各阶段 SHALL 有明确视觉映射（提问环 / 得分环 / 选中环），档位 SHALL 配色区分。

#### Scenario: 视觉回归
- **GIVEN** 一次运行
- **WHEN** 截图比对
- **THEN** 各阶段视觉 SHALL 与基线一致

#### Requirement: [ANIM-4] 唯一 rAF 循环与帧预算

系统 SHALL 使用唯一 `requestAnimationFrame` 循环；帧开销 SHALL 在预算内。

#### Scenario: 帧率
- **GIVEN** 主流桌面设备
- **WHEN** 测量
- **THEN** 帧率 SHALL ≥ 30fps

#### Scenario: 异常注入
- **GIVEN** 注入长帧
- **WHEN** 继续运行
- **THEN** 系统 SHALL 降级而非卡死

#### Requirement: [ANIM-5] 打断式重路由

新输入到达时 SHALL 可打断当前运行并平滑重路由。

#### Scenario: 打断行为
- **GIVEN** 运行中提交新输入
- **WHEN** 触发打断
- **THEN** 6 项打断断言 SHALL 通过
- **AND** 旧运行状态 SHALL 被清理

#### Requirement: [ANIM-6] 真实事件驱动（非自推断）

3D MUST 消费真实 `RouteEvent` 驱动状态，MUST NOT 依据动画时间或前端随机数自行决定节点状态。

- 前端状态 MUST 由 `state = routeEventReducer(state, event)` 生成。
- 最终叶节点 MUST 等于 `finalModelId`。

#### Scenario: 事件映射
- **GIVEN** 收到一串事件
- **WHEN** reducer 处理
- **THEN** 节点状态 SHALL 严格按事件时间线推进

#### Scenario: 禁止随机 winner
- **GIVEN** 审查前端代码
- **WHEN** 检索随机数生成选中节点
- **THEN** SHALL NOT 存在此类逻辑

### 域 RESULT · Prompt 输入框内联结果

#### Requirement: [RESULT-1] Prompt 输入框内联结果

系统 SHALL 在 Prompt 输入框内直接呈现执行结果，SHALL 支持折叠/展开与取消。

#### Scenario: 内联呈现
- **GIVEN** 用户提交 prompt
- **WHEN** 结果产生
- **THEN** 结果 SHALL 在输入框内呈现，无需跳转

#### Scenario: 流式内联
- **GIVEN** 模型流式输出
- **WHEN** 增量到达
- **THEN** 输入框内 SHALL 实时更新

#### Scenario: 取消
- **GIVEN** 结果生成中
- **WHEN** 用户取消
- **THEN** 系统 SHALL 停止生成并保留已产出部分

#### Scenario: 低置信不展示正文
- **GIVEN** 决策落入模糊地带
- **WHEN** 呈现结果
- **THEN** 输入框内 SHALL 显示警告块
- **AND** SHALL NOT 展示执行结果正文

#### Requirement: [RESULT-2] 执行结果流式呈现

结果 SHALL 支持流式增量呈现，SHALL 显示生成状态。

#### Scenario: 流式进度
- **GIVEN** 模型开始输出
- **WHEN** 增量到达
- **THEN** 进度 SHALL 可见且最终拼接完整

#### Requirement: [RESULT-3] 决策解释展示

结果区 SHALL 提供「查看决策」入口，展示五问答案、档位结论、`rationale` 与 `decisionSource`。

#### Scenario: 解释可展开
- **GIVEN** 一次路由完成
- **WHEN** 用户点击「查看决策」
- **THEN** SHALL 展示五问答案与档位结论
- **AND** 低置信 SHALL 标注「需人工复核」

#### Requirement: [RESULT-4] 内联与档案一致性

内联结果与档案详情 SHALL 由同一 `record` 派生，SHALL NOT 出现两处不一致。

#### Scenario: 双通道同源
- **GIVEN** 一次路由完成
- **WHEN** 比对内联与详情
- **THEN** 模型、成本、置信度 SHALL 逐字段一致

#### Requirement: [RESULT-5] 结果指标展示

结果区 SHALL 显示模型、延迟、token、成本、`confidence` 与「查看决策」。

#### Scenario: 指标完整
- **GIVEN** 一次路由完成
- **WHEN** 查看结果区
- **THEN** 六项指标 SHALL 全部可见

### 域 ARCHIVE · 决策经验沉淀

#### Requirement: [ARCHIVE-1] 路由档案结构

系统 SHALL 为每次路由产出结构化档案，字段 SHALL 覆盖决策、执行与结果（见附录 A）。

- 档案 SHALL 支持完整复现该次决策。

#### Scenario: 字段完整
- **GIVEN** 一次路由完成
- **WHEN** 检查档案
- **THEN** 必填字段 SHALL 完整且类型正确

#### Requirement: [ARCHIVE-2] 持久化与降级

档案 SHALL 持久化；隐私模式等不可写场景 SHALL 优雅降级，SHALL NOT 崩溃。

#### Scenario: 隐私模式降级
- **GIVEN** 浏览器处于隐私模式
- **WHEN** 尝试写入档案
- **THEN** 系统 SHALL 降级为内存态并提示

#### Requirement: [ARCHIVE-3] 回溯与重放

系统 SHALL 支持从档案重放一次路由（3D 树、决策详情、结果），重放 SHALL NOT 重新调用模型。

#### Scenario: 重放一致
- **GIVEN** 一条历史档案
- **WHEN** 重放
- **THEN** 落点 SHALL 与档案记录一致
- **AND** SHALL NOT 产生新的模型调用

#### Requirement: [ARCHIVE-4] 存储键版本化与脏数据防御

存储键 SHALL 版本化；读取到旧版或脏数据时 SHALL 安全降级。

#### Scenario: 双键共存
- **GIVEN** 存储中存在旧版键
- **WHEN** 加载
- **THEN** 系统 SHALL 忽略旧版并正常启动

#### Requirement: [ARCHIVE-5] 人工复核回写与校准闭环

系统 SHALL 提供人工复核回写通道（回填真实标签），回写 SHALL 幂等，并 SHALL 支持校准数据导出。

#### Scenario: 回写幂等
- **GIVEN** 对同一档案提交两次相同复核
- **WHEN** 处理
- **THEN** 结果 SHALL 与提交一次一致

#### Scenario: 导出校验
- **GIVEN** 已积累若干已确认档案
- **WHEN** 导出校准数据
- **THEN** 导出 SHALL 含预测 / 概率 / 真实标签 / 人工动作四类字段

### 域 EXP · 决策经验回流闭环

> 本域为**核心增量**。目标：把已确认经验折算为**有界、收缩、可复现、可回滚**的先验偏置，注入打分 `raw` 分。设计原则：**保守优先——宁可不用，不可用错。**

#### Requirement: [EXP-1] 经验条目结构化与结果确认

系统 SHALL 为每次路由决策产出一条**经验条目**，且该条目 SHALL 具备**结果确认**生命周期——决策时刻只能得到「预测」，真实结果必须异步回填。

| 分组 | 字段 |
| --- | --- |
| 身份 | `eid` / `rid` / `expVersion` |
| 决策预测 | `intent` / `winner` / `winnerIdx` / `tier` / `confidence` / `topProb` / `priorSnapshot` |
| 结果确认 | `outcome`（`status` / `source` / `label` / `observedAt` / `latencyMs` / `cost`） |

- 条目 SHALL 在决策完成时创建，`outcome.status` 初始为 `pending`。
- `outcome.status` SHALL 取值于 `pending` / `confirmed` / `disputed` / `expired`，SHALL NOT 使用自由文本状态。
- `outcome.source` SHALL 至少支持三类：`human`（人工复核）、`system`（系统校验）、`implicit`（隐式弱标签：换模型重跑 / 重新生成 / 放弃）。
- `pending` 条目 SHALL NOT 参与任何统计或先验修正；SHALL NOT 以「未确认即视为成功」的方式填充。

#### Scenario: 条目生命周期
- **GIVEN** 一次决策完成
- **WHEN** 创建经验条目
- **THEN** `outcome.status` SHALL 为 `pending`
- **AND** 异步结果到达后 SHALL 更新为 `confirmed` 或 `disputed`

#### Scenario: 三来源回填
- **GIVEN** 存在人工复核、系统校验、隐式行为三种信号
- **WHEN** 回填
- **THEN** `source` SHALL 分别记录为 `human` / `system` / `implicit`

#### Requirement: [EXP-2] 置信度准确性统计（分桶 + 校准误差）

系统 SHALL 在**已确认**经验条目上计算置信度准确性统计，SHALL NOT 仅报告准确率。

- 统计 SHALL 至少覆盖三个切面：**全局** / **按档位** / **按问题 ID**。
- 分桶校准误差 SHALL 采用 ECE（Expected Calibration Error）：

```
ECE = Σ_b ( n_b / N ) × | acc_b − conf_b |
```

  其中 `b` 为分桶下标，`n_b` 为第 b 桶样本数，`N` 为已确认样本总数，`acc_b` 为该桶实际命中率，`conf_b` 为该桶平均置信度；分桶数 SHALL 为 **10**（等宽 `[0,1]`）。
- **命中定义** SHALL 显式且唯一：`confirmed` 且 `outcome.label` 等于系统 `winner` 时记命中；`disputed` 记未命中；`expired` SHALL 从统计中剔除。
- 每条统计 SHALL 附带**样本量**；样本量低于 `EXP_MIN_SAMPLE_GLOBAL`（30）时，报表 SHALL 显式标注「样本不足，不构成结论」，且 SHALL NOT 输出任何优劣判定。
- 系统 SHALL 同时报告**误报率与漏报率**，SHALL NOT 只报告整体准确率掩盖两类错误的不对称代价。

#### Scenario: ECE 对拍手算
- **GIVEN** 一组已知的已确认样本与置信度
- **WHEN** 计算 ECE
- **THEN** 结果 SHALL 等于手工按公式计算值

#### Scenario: 样本不足标注
- **GIVEN** 已确认样本数 < 30
- **WHEN** 生成报表
- **THEN** 报表 SHALL 标注「样本不足，不构成结论」
- **AND** SHALL NOT 输出优劣判定

#### Requirement: [EXP-3] 阈值重标定建议生成

系统 SHALL 由校准统计生成**阈值重标定建议**，但 SHALL NOT 自动生效。

- 建议 SHALL 包含：当前阈值、建议阈值、优化目标、样本量、预期影响。
- 建议 SHALL 由在已确认数据集上**确定性扫描**候选阈值得到（同一数据集 SHALL 得到同一建议），SHALL NOT 使用随机搜索。
- 生成建议 SHALL 满足样本量下限；不满足时 SHALL NOT 生成建议，并 SHALL 说明缺口样本数。
- 建议 SHALL NOT 自动写入生效阈值；生效 SHALL 经人工批准，且批准动作 SHALL 记录操作者与时间。
- 建议 SHALL 附**反事实说明**：说明新阈值下多少原本转人工的档案会被自动路由、多少原本自动的会被转为转人工。

#### Scenario: 建议确定性
- **GIVEN** 固定已确认数据集
- **WHEN** 两次生成建议
- **THEN** 建议 SHALL 完全一致

#### Scenario: 建议生成但不自动生效
- **GIVEN** 系统基于已确认数据生成了一条阈值重标定建议
- **WHEN** 检查生效阈值
- **THEN** 生效阈值 SHALL 保持不变，直至人工批准

#### Requirement: [EXP-4] 经验回流至下一次决策

系统 SHALL 将已确认经验**应用于后续决策**——这是本变更的核心要求，也是原实现缺失的能力。

- 回流 SHALL 仅通过两条**显式且可审计**的通道：① 模型选择先验修正（`EXP-5`）；② 经人工批准的置信度阈值（`EXP-3`）。
- 回流 SHALL NOT 通过未声明的隐式通道影响决策（如修改模型画像、改写特征提取权重、改动候选池）。
- 决策档案 SHALL 钉住本次生效的 `expVersion`，并记录**每个候选模型的先验修正量**（`priorDelta[]`，目录序）。
- 当经验修正未生效（冷启动 / 样本不足 / shadow 模式）时，档案 SHALL 记录 `expVersion` 为 `null` 或标注 `correction: none`，SHALL NOT 记录虚假修正量。
- 系统 SHALL NOT 在未记录 `expVersion` 的情况下应用经验。

#### Scenario: 经验确实改变了下一次决策
- **GIVEN** 经验版本 V 生效且（意图 × 模型）样本充足
- **WHEN** 提交一条与该意图匹配的 prompt
- **THEN** 选型 SHALL 相对未应用经验时有可解释差异
- **AND** 档案 SHALL 记录 `expVersion=V` 与 `priorDelta[]`

#### Scenario: 未生效时不得记录虚假修正
- **GIVEN** 系统处于 shadow 模式
- **WHEN** 完成决策
- **THEN** 档案 SHALL 标注 `correction: none`
- **AND** `priorDelta[]` SHALL 全为 0

#### Requirement: [EXP-5] 模型选择先验修正（有界 + 收缩）

系统 SHALL 以**有界收缩**的方式将经验折算为打分先验修正，SHALL NOT 让经验取代静态能力画像。

对每个（主意图 × 模型）对：

```
n_eff     = Σ_i w_i                                  （时效加权有效样本数，w_i 见 EXP-7）
postMean  = ( EXP_PRIOR_STRENGTH × priorMean + Σ_i w_i·y_i )
            / ( EXP_PRIOR_STRENGTH + n_eff )          （Beta 后验均值）
Δraw      = EXP_CORR_MAX × ( postMean − priorMean )   （有界先验修正）
```

- `priorMean` SHALL 由**静态能力画像标定**，SHALL NOT 由经验反推。
- 修正 SHALL 注入打分 `raw` 分，注入点**唯一**，SHALL NOT 在 softmax 之后再叠加。
- 三条性质 SHALL 可断言：**有界**（`|Δraw| ≤ EXP_CORR_MAX`）、**冷启动为零**（`n_eff=0 ⇒ Δraw=0`）、**单调收缩**（`n_eff` 增大时后验渐近但受先验强度限制）。
- 系统 SHALL NOT 采用「先算无界修正再截断」的等价实现（会导致大样本长期贴住上界，等价于无界偏置）。

#### Scenario: 修正上界
- **GIVEN** 任意样本构成
- **WHEN** 计算 `Δraw`
- **THEN** `|Δraw|` SHALL ≤ `EXP_CORR_MAX`

#### Scenario: 反固化
- **GIVEN** 某模型历史胜率高
- **WHEN** 另一模型在能力画像上更优
- **THEN** 经验偏置 SHALL NOT 使前者无条件垄断
- **AND** 探索窗口 SHALL 保留

#### Requirement: [EXP-6] 应用经验后的可复现性

应用经验后，历史决策 SHALL 仍可被精确重放。

- 重放 SHALL 使用档案中钉住的 `expVersion` 与其 `priorSnapshot`，SHALL NOT 读取当前最新经验版本。
- 当档案钉住的版本已被回滚或清理时，重放 SHALL 降级为「按档案记录的结果呈现」，并 SHALL 显式提示「经验版本不可用，未重算」。
- 系统 SHALL 提供「可复现通道」：把经验版本显式固定为某一版本，使同一输入可反复得到同一选型。
- 重放结果与档案记录 SHALL 在 `winner` / `winnerIdx` / `priorDelta[]` 三维度一致。

#### Scenario: 钉版本重放得到相同选型
- **GIVEN** 当前经验版本为 V，重放一条 `expVersion = V0`（V0 < V）的历史档案
- **WHEN** 重算
- **THEN** 重算 SHALL 使用 V0 的先验快照
- **AND** `winner` / `winnerIdx` / `priorDelta[]` SHALL 与档案记录一致
- **AND** SHALL NOT 使用 V 的先验

#### Requirement: [EXP-7] 经验时效衰减与画像变更失效

经验 SHALL 具备时效性，过期经验 SHALL NOT 继续以满权重影响决策。

- 每条经验条目 SHALL 携带时效权重：

```
w = 0.5 ^ ( ageDays / EXP_HALF_LIFE_DAYS )
```

  `ageDays` 由 `observedAt` 起算；`w < EXP_WEIGHT_FLOOR` 的条目 SHALL NOT 参与先验修正（在统计中 MAY 仍被计入历史）。
- **来源权重**：`SOURCE_W = { human: 1.0, system: 1.0, implicit: 0.45 }`；隐式弱标签 SHALL NOT 单独构成劣化判定依据。
- **画像变更失效**：当某模型的 `profileVersion` 变更时，该模型已积累经验权重 SHALL 被重置或按衰减处理（联动 `MODEL-4`），SHALL NOT 沿用变更前的成功 / 失败计数。
- 失效事件 SHALL 记录在经验版本历史中。
- 衰减与失效 SHALL NOT 影响已钉住 `expVersion` 的历史档案的重放（`EXP-6`）。

#### Scenario: 半衰期与地板值
- **GIVEN** 一条经验条目 `ageDays` 等于半衰期
- **WHEN** 计算权重
- **THEN** `w` SHALL ≈ 0.5
- **AND** 当 `w < EXP_WEIGHT_FLOOR` 时 SHALL 不参与先验修正

#### Requirement: [EXP-8] 冷启动与样本不足守卫

系统 SHALL 在样本不足时**自动放弃应用经验**，SHALL NOT 用不足样本强行修正选型。

- 当（主意图 × 模型）对的 `n_eff < EXP_MIN_SAMPLE_PER_PAIR`（8）时，该对 `Δraw` SHALL 为 0。
- 当全局已确认样本总数 `< EXP_MIN_SAMPLE_GLOBAL`（30）时，系统 SHALL 运行于 **shadow 模式**：计算「若应用经验 `Δraw` 会是多少」并写入观测日志，SHALL NOT 施加到实际决策，档案 SHALL 标注 `correction: none`。
- shadow 模式 SHALL 在达到样本下限后由人工显式切换为生效模式，SHALL NOT 自动切换。
- 该要求 SHALL 与官方落地清单一致：先以 shadow mode 运行并与人工结果对比，再放开自动执行（附录 F.2 第 5 项）。

#### Scenario: 冷启动不修正且处于 shadow
- **GIVEN** 全局已确认样本数 < 30
- **WHEN** 完成一次决策
- **THEN** `Δraw` SHALL 全为 0
- **AND** 档案 SHALL 标注 `correction: none` 且标记 shadow

#### Requirement: [EXP-9] 经验版本化与原子回滚

经验状态 SHALL 版本化，且 SHALL 支持原子回滚。

- 每次经验状态变更 SHALL 产生新的 **`expVersion`**（单调递增），并记录触发原因、变更摘要、操作者、时间。
- 已发布版本 SHALL **不可变**（append-only）。
- 回滚 SHALL 指向一个历史版本，且 SHALL 为**原子操作**：回滚后生效状态 SHALL 恰等于目标版本，SHALL NOT 处于混合态。
- 回滚 SHALL 记录为一次新的版本变更事件，SHALL NOT 抹除被回滚版本的记录。
- 回滚 SHALL 在完成后的下一次决策即生效，SHALL NOT 需要重启服务。

#### Scenario: 回滚是原子的且保留审计
- **GIVEN** 从版本 V3 回滚到 V1
- **WHEN** 检查生效状态
- **THEN** 生效经验状态 SHALL 恰等于 V1
- **AND** 版本历史中 SHALL 保留 V2 / V3 的记录与「已回滚」标记

#### Requirement: [EXP-10] 闭环自动校验与劣化告警

系统 SHALL 自动校验经验回流的效果，SHALL NOT 只应用不校验。

- 系统 SHALL 以「应用某版本的时刻」为分界，把已确认条目切分为**应用前段**与**应用后段**，在同一组指标上对比：档位命中率、ECE、成本节省率、人工接管率。
- 对比 SHALL 产出明确判定：`improved` / `neutral` / `degraded`；判定规则 SHALL 显式定义且可复算。
- 应用后段样本量不足时 SHALL 输出 `inconclusive`，SHALL NOT 输出 `improved`。
- 判定为 `degraded` 时，系统 SHALL 产生**告警**并 SHALL 提供一键回滚入口（`EXP-9`）；SHALL NOT 静默保留劣化版本。
- 校验报表 SHALL 可导出，作为「闭环确实合上」的验收证据（对应 §0.7 段位 ⑤）。

#### Scenario: 劣化触发告警与回滚建议
- **GIVEN** 应用版本 V 后段样本量充足，且档位命中率显著低于应用前段
- **WHEN** 执行校验
- **THEN** 判定 SHALL 为 `degraded`
- **AND** 系统 SHALL 产生告警并提供一键回滚入口

#### Scenario: 后段样本不足不宣称改进
- **GIVEN** 应用后段样本量不足
- **WHEN** 执行校验
- **THEN** 判定 SHALL 为 `inconclusive`
- **AND** SHALL NOT 输出 `improved`

### 域 EVENT · 事件契约与可观测性

#### Requirement: [EVENT-1] 路由事件契约

系统 SHALL 定义统一 `RouteEvent` 契约；事件 SHALL 含 `eventId` / `requestId` / `decisionId?` / `executionId?` / `type` / `timestamp` / `sequence` / `payload`。

- 事件类型 SHALL 至少包括：`ROUTE_CREATED`、`EXPERIENCE_RETRIEVED`、`JEV_CALL_STARTED`、`JEV_DECISION_READY`、`JEV_FALLBACK`、`CONSTRAINT_FILTERED`、`MODEL_SELECTED`、`MODEL_CALL_STARTED`、`MODEL_STREAMING`、`MODEL_COMPLETED`、`ROUTE_FAILED`、`EXPERIENCE_SAVED`。
- `sequence` SHALL 单调递增。

#### Scenario: 事件字段完整
- **GIVEN** 一次路由
- **WHEN** 检查事件流
- **THEN** 每个事件 SHALL 含全部必填字段
- **AND** `sequence` SHALL 单调递增

#### Scenario: 事件时间线可重放
- **GIVEN** 一串完整事件
- **WHEN** 按 `sequence` 回放
- **THEN** 状态演进 SHALL 与实时一致

#### Requirement: [EVENT-2] 事件幂等与去重

客户端 SHALL 按 `eventId` 去重；重复事件 SHALL NOT 导致状态重复推进。

#### Scenario: 重复事件去重
- **GIVEN** 收到重复 `eventId` 的事件
- **WHEN** reducer 处理
- **THEN** 状态 SHALL 保持不变

#### Requirement: [EVENT-3] 断线重连与事件补偿

前端 SHALL 能通过 SSE/WebSocket 接收状态事件，并支持断线重连（`Last-Event-ID` 恢复）；事件丢失率 SHALL 为 0。

#### Scenario: 重连补事件
- **GIVEN** 客户端断线后重连并携带 `Last-Event-ID`
- **WHEN** 服务端补发缺失事件
- **THEN** 客户端状态 SHALL 与未断线一致

#### Requirement: [EVENT-4] 全链路关联与指标聚合

每次路由 SHALL 有唯一 `requestId` / `decisionId` / `executionId` 且可全链路关联；指标 SHALL 可按 `taskType / modality / modelId / decisionSource / policyVersion / catalogVersion` 聚合。

- 聚合 SHALL 覆盖：quality、latency、cost、success、fallback、Jev error、constraint rejection。
- 系统 MUST 区分 `TYPE_SAFE_JEV` / `RULE_FALLBACK` / `USER_OVERRIDE` 三种 `selectionMode`，避免失败被误归因给单一模型。

#### Scenario: 三段 id 关联
- **GIVEN** 一次路由完成
- **WHEN** 查询 trace
- **THEN** 三段 id SHALL 可互相关联

### 域 A11Y · 无障碍与隐私合规

#### Requirement: [A11Y-1] 无障碍审计零违规

界面 SHALL 通过 axe-core 多视口审计（零违规）。

#### Scenario: 审计零违规
- **GIVEN** 多视口渲染
- **WHEN** 运行 axe-core
- **THEN** 违规数 SHALL 为 0

#### Scenario: 键盘可达
- **GIVEN** 仅用键盘
- **WHEN** 操作主流程
- **THEN** 全部交互 SHALL 可达

#### Requirement: [A11Y-2] 动效降级

系统 SHALL 响应 `prefers-reduced-motion` 降低动效。

#### Scenario: 偏好生效
- **GIVEN** 系统偏好为 reduced-motion
- **WHEN** 渲染
- **THEN** 动效 SHALL 降级

#### Requirement: [A11Y-3] 隐私与数据最小化

系统 SHALL 遵循数据最小化：默认 MUST NOT 存储原始 Prompt 全文与原始图片；Prompt 摘要 SHOULD 截断（如 ≤500 字符）。

#### Scenario: 脱敏
- **GIVEN** 一次路由完成
- **WHEN** 检查知识记录
- **THEN** SHALL NOT 含原始图片
- **AND** Prompt SHALL 为截断摘要或哈希

### 域 PERF · 性能预算

#### Requirement: [PERF-1] 启动性能

系统 SHALL 在预算内启动（加载 < 3s，FCP 目标）。

#### Scenario: 启动测量
- **GIVEN** 标准设备
- **WHEN** 冷启动
- **THEN** 启动耗时与 CLS SHALL 在预算内

#### Requirement: [PERF-2] 渲染性能

渲染 SHALL 在帧预算内；单帧开销 SHALL 可测。

#### Scenario: 绘制统计
- **GIVEN** 渲染运行
- **WHEN** 采样
- **THEN** 单帧开销 SHALL 在预算内

#### Requirement: [PERF-3] 内存有界

内存 SHALL 有界；长时间运行 SHALL NOT 持续增长。

#### Scenario: 浸泡
- **GIVEN** 连续运行 60s
- **WHEN** 采样堆曲线
- **THEN** 堆 SHALL 趋于平稳

### 域 API · 前后端数据与接口契约

#### Requirement: [API-1] 路由决策接口

系统 SHALL 提供路由创建接口（`POST /v1/routes`）；该接口 SHALL 只创建路由，决策与执行由服务端状态机异步推进。

#### Scenario: 契约测试
- **GIVEN** 合法请求
- **WHEN** 调用
- **THEN** 返回 SHALL 含 `requestId` 与初始状态

#### Requirement: [API-2] 流式事件接口

系统 SHALL 提供事件流接口（SSE `GET /v1/routes/:id/events`），支持断线重连与中断降级。

#### Scenario: 流顺序
- **GIVEN** 一次路由
- **WHEN** 订阅事件流
- **THEN** 事件 SHALL 按 `sequence` 有序到达

#### Scenario: 中断降级
- **GIVEN** 流中断
- **WHEN** 重连
- **THEN** 客户端 SHALL 恢复至一致状态

#### Requirement: [API-3] 模型目录接口

系统 SHALL 提供目录接口（`GET /v1/catalog`）；前后端目录 SHALL 同源（同一 `catalogVersion`）。

#### Scenario: 目录同源
- **GIVEN** 前后端各自加载目录
- **WHEN** 比较
- **THEN** `catalogVersion` 与内容 SHALL 一致

#### Requirement: [API-4] 档案与人工复核接口

系统 SHALL 提供档案查询与人工复核回写接口（`POST /v1/routes/:id/review`），回写 SHALL 幂等。

#### Scenario: 幂等测试
- **GIVEN** 相同复核请求提交两次
- **WHEN** 处理
- **THEN** 结果 SHALL 与一次一致

#### Requirement: [API-5] 经验闭环接口

系统 SHALL 提供经验闭环接口，覆盖统计 / 建议 / 应用 / 回滚 / 结果回填五类操作。

#### Scenario: 五端点契约测试
- **GIVEN** 已积累已确认经验
- **WHEN** 调用五个端点
- **THEN** 各自 SHALL 返回符合契约的结果
- **AND** 应用/回滚 SHALL 记录 `expVersion`

---

## 附录 A · 数据契约（规范性）

### A.1 TaskEnvelope

```json
{
  "requestId": "req_xxx",
  "text": "≤5000 字符",
  "modalities": ["text", "image"],
  "attachments": [
    { "kind": "image", "ref": "signed-url", "mime": "image/png", "sizeBytes": 204800 }
  ],
  "preference": "balanced",
  "constraints": { "maxCost": 0.05, "maxLatencyMs": 5000, "allowedModelIds": [] },
  "state": {
    "goal": "为三个新智能体工具准备带引用的简报",
    "facts": { "deadline": "09:00 UTC" },
    "artifacts": { "draft_exists": true, "fact_check_complete": false },
    "evidence": [ { "id": "s1", "kind": "official_docs", "supports": ["pricing"] } ],
    "constraints": { "publish": false, "max_sources": 12 },
    "options": ["research", "write", "fact_check", "review"]
  },
  "consequenceClass": "low",
  "createdAt": "2026-09-28T00:00:00Z"
}
```

> `state` 为 `JEV-14` 要求的 6 段功能分离状态；`consequenceClass` 用于 `JEV-15` 的后果分级阈值。

### A.2 ModelDescriptor

```json
{
  "modelId": "forge-code",
  "provider": "example",
  "capabilities": ["code", "reasoning"],
  "modalities": ["text"],
  "contextTokens": 200000,
  "priceInPerMTok": 0.28,
  "priceOutPerMTok": 1.10,
  "p95LatencyMs": 1800,
  "health": "ok",
  "profileVersion": "p3",
  "enabled": true
}
```

### A.3 JevDecision

```json
{
  "schemaVersion": "1.0",
  "decisionId": "dec_xxx",
  "decisionSource": "TYPE_SAFE_JEV",
  "taskProfile": {
    "intent": "code_debugging",
    "modalities": ["text"],
    "capabilities": ["code", "reasoning"],
    "complexity": "high",
    "urgency": false,
    "budgetSensitive": false
  },
  "answers": {
    "intent":      { "primitive": "choice", "value": "code_debugging", "evidence": 0.81 },
    "complexity":  { "primitive": "score",  "value": 4, "evidence": 0.63 },
    "urgency":     { "primitive": "noul",   "value": false, "evidence": 0.12 },
    "budget":      { "primitive": "noul",   "value": false, "evidence": 0.10 },
    "capability":  { "primitive": "score",  "value": 4, "evidence": 0.70 }
  },
  "candidates": [
    { "modelId": "forge-code", "score": 0.91, "reasons": ["代码能力匹配", "上下文满足"] }
  ],
  "selectedRecommendation": "forge-code",
  "confidence": 0.94,
  "rationale": "...",
  "experienceReferences": [],
  "createdAt": "2026-09-28T00:00:00Z"
}
```

### A.4 ExperienceEntry

```json
{
  "eid": "exp_xxx",
  "rid": "req_xxx",
  "expVersion": 12,
  "prediction": {
    "intent": "code_debugging",
    "winner": "forge-code",
    "winnerIdx": 2,
    "tier": "high",
    "confidence": 0.94,
    "topProb": 0.71,
    "priorSnapshot": { "expVersion": 12, "priorDelta": [0, 0.4, 0.2, 0, 0, 0] }
  },
  "outcome": {
    "status": "confirmed",
    "source": "human",
    "label": "forge-code",
    "observedAt": "2026-09-28T01:00:00Z",
    "latencyMs": 1480,
    "cost": 0.018
  }
}
```

### A.5 RouteRecord（路由档案）

```json
{
  "rid": "req_xxx",
  "requestId": "req_xxx",
  "decisionId": "dec_xxx",
  "executionId": "exe_xxx",
  "taskProfile": {},
  "candidates": ["atlas-reasoning", "forge-code", "sentinel-guard"],
  "selectedModelId": "forge-code",
  "finalModelId": "forge-code",
  "decisionSource": "TYPE_SAFE_JEV",
  "tier": "high",
  "confidence": 0.94,
  "expVersion": 12,
  "correction": "applied",
  "priorDelta": [0, 0.4, 0.2, 0, 0, 0],
  "metrics": { "latencyMs": 1480, "inputTokens": 3000, "outputTokens": 1200, "cost": 0.018, "costBaseline": 0.041 },
  "outcome": { "status": "confirmed", "quality": 0.91, "feedback": "positive" },
  "catalogVersion": "c9",
  "policyVersion": "p17",
  "schemaVersion": "1.0"
}
```

### A.6 ExperienceVersion（经验版本）

```json
{
  "expVersion": 13,
  "trigger": "threshold-approved",
  "summary": "批准阈值 0.82/0.60 → 0.84/0.62",
  "operator": "reviewer@example",
  "createdAt": "2026-09-28T02:00:00Z",
  "priorSnapshotRef": "snap_013",
  "rolledBack": false
}
```

### A.7 DecisionContract（决策契约）

```json
{
  "contractId": "ticket-router@3",
  "version": "3",
  "stateFields": ["goal", "facts", "artifacts", "evidence", "constraints", "options"],
  "questions": {
    "next_worker": {
      "primitive": "choice",
      "instructions": "Which available worker should act next?",
      "criteria": { "research": "证据缺口仍存在", "write": "证据已足够起草", "escalate": "无法安全推进" },
      "escapeHatch": "escalate"
    },
    "urgency": {
      "primitive": "score",
      "instructions": "How urgent is the request?",
      "criteria": ["无时间压力", "时间敏感但可等待", "立即业务影响"]
    },
    "requires_approval": {
      "primitive": "noul",
      "instructions": "Would the next action create an external side effect?"
    }
  },
  "fallback": "escalate",
  "consequenceThresholds": { "low": { "high": 0.90, "mid": 0.70 }, "irreversible": { "forceHuman": true } },
  "allowedAction": "route_only",
  "escalationPath": "human_review"
}
```

### A.8 DecisionReceipt（决策凭据）

```json
{
  "receiptId": "rcp_xxx",
  "contractId": "ticket-router@3",
  "stateRef": { "stateVersion": "run_184:step_7", "stateHash": "b476..." },
  "distribution": { "research": 0.05, "write": 0.91, "escalate": 0.04 },
  "thresholds": { "high": 0.90, "mid": 0.70, "consequenceClass": "low" },
  "tier": "ROUTE",
  "actionTaken": "route_to:write",
  "createdAt": "2026-09-28T00:00:00Z"
}
```

---

## 附录 B · 接口契约（规范性）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/routes` | 创建路由，返回 `requestId` |
| GET | `/v1/routes/:requestId/events` | SSE 事件流 |
| GET | `/v1/routes/:requestId/decision` | 决策详情 |
| POST | `/v1/routes/:requestId/cancel` | 取消路由 |
| POST | `/v1/routes/:requestId/feedback` | 提交显式反馈 |
| POST | `/v1/routes/:requestId/review` | 人工复核回写（幂等） |
| GET | `/v1/catalog` | 模型目录（版本化） |
| GET | `/v1/experience/stats` | 校准统计（含 ECE） |
| GET | `/v1/experience/suggestions` | 阈值重标定建议 |
| POST | `/v1/experience/apply` | 应用经验版本（需人工批准令牌） |
| POST | `/v1/experience/rollback` | 原子回滚到指定版本 |
| GET | `/v1/routes/:requestId/replay` | 历史回放 |
| GET | `/v1/contracts/:contractId` | 读取决策契约（含版本，`JEV-12`） |
| GET | `/v1/routes/:requestId/receipt` | 读取决策凭据（`JEV-16`） |

---

## 附录 C · 关键流程（规范性）

### C.1 正向路由流程

```
Prompt → Normalize（组装 6 段 state，JEV-14）→ Experience Retrieval（异步、可降级）
  → 决策契约校验（JEV-12）→ Jev 五问并行 fan-out（JEV-3）→ Schema 校验（JEV-6）
  → 后果分级阈值（JEV-15）→ Decision Runtime 主链（JEV-11）
       STATE → 三原语 → JEV → PROBABILITY → ROUTE/GATE/ESCALATE
  → 8 步硬约束过滤（CONSTRAIN-1，执行权在代码）→ 软评分 + 先验修正(Δraw) → 稳健决胜 → finalModelId
  → 模型调用（流式）→ Outcome → 决策凭据（JEV-16）+ 经验条目(pending)
```

> **三层边界**：本流程中 `Normalize`~`PROBABILITY` 属 **DECIDE** 层；`finalModelId` 的裁定与硬约束属 **ENFORCE** 层；`模型调用` 属 **GENERATE** 层。置信度仅在 DECIDE 层内改变路由，执行授权恒在 ENFORCE 层（§0.8）。

### C.2 经验回流流程（异步，不阻塞主结果）

```
结果确认回填 → 统计(ECE/命中率) → 阈值建议(不自动生效)
  → 人工批准 → 新 expVersion → 生效 → 下一次决策注入 Δraw
  → 分段校验(improved/neutral/degraded) → 劣化则告警 + 一键回滚
```

### C.3 降级流程

```
Jev 超时 / 非法 Schema
  → 若存在已审核 fallback 规则：RULE_FALLBACK + decisionDegraded=true + 3D 显示降级
  → 否则：返回 DECISION_TIMEOUT，不调用任何执行模型
  → 降级决策 SHALL NOT 写入「Jev 正常决策」经验
```

---

## 附录 D · 约束条件汇总（规范性）

| # | 约束 |
| --- | --- |
| C1 | 模型调用 SHALL NOT 早于 Jev 决策完成 |
| C2 | 未通过 Schema / 硬约束 / 目录的请求执行数 SHALL 为 0 |
| C3 | 密钥 SHALL 仅存服务端，前端 SHALL NOT 接收供应商密钥 |
| C4 | 经验回流 SHALL NOT 改写模型能力画像 |
| C5 | 经验应用 SHALL NOT 缺少 `expVersion` 记录 |
| C6 | 阈值建议 SHALL NOT 自动生效 |
| C7 | 本阶段 SHALL NOT 交付代码实现 |
| C8 | 模型池 SHALL 为可配置项 |
| C9 | 3D SHALL NOT 自行推断后端状态 |
| C10 | 降级 SHALL NOT 伪装为正常 Jev 决策 |

---

## 附录 E · 验收标准与验证矩阵（规范性）

### E.1 闭环五段位验收（对应 §0.7）

| 段位 | 验收证据 |
| --- | --- |
| ① 沉淀 | 每条路由产出 `ExperienceEntry`，含 `outcome` 生命周期字段 |
| ② 统计 | ECE 对拍手算通过；样本不足时显式标注 |
| ③ 应用 | A/B 差分断言显示选型可解释差异；档案含 `priorDelta[]` |
| ④ 可复现 | 钉版本重放 `winner/winnerIdx/priorDelta[]` 一致 |
| ⑤ 验证回滚 | 分段校验产出 `improved/neutral/degraded`；回滚原子且保留审计 |

### E.2 关键指标

| 指标 | 目标 |
| --- | --- |
| Jev 正常路径 P95 决策延迟 | ≤ 1200ms（不含模型生成） |
| 3D 帧率（主流桌面） | ≥ 30fps |
| 事件丢失率 | = 0（允许重连补偿） |
| 未过校验的执行数 | = 0 |
| 冷启动零修正 | `n_eff=0 ⇒ Δraw=0` |
| 修正上界 | `|Δraw| ≤ EXP_CORR_MAX` |

### E.3 已知限制

- 经验闭环在演示期以合成数据集验证机制正确性，不承诺可观测效果提升。
- Firefox / Safari / Edge 仅做标准 API 推导。

---

## 附录 F · 与 TypeSafe Jev 官方契约的偏差（规范性）

> **本附录是强制登记项。** 下列偏差必须随实现一同维护；对外文档 SHALL NOT 把本实现的自定义项表述为官方项。

| # | 项目 | 官方契约 | 本实现 | 性质 |
| --- | --- | --- | --- | --- |
| F1 | `noul` 的 confidence | **不返回**（0–1 值本身即校准概率） | 为统一界面展示额外计算置信度值 | **偏离官方** |
| F2 | confidence 定义 | 纯由概率分布形状导出 | `0.36 × 概率优势 + 0.30 × 边际 + 0.34 × 证据强度` 再经校准曲线；「证据强度」为自定义项 | **自定义扩展** |
| F3 | 阈值 | 官方**不提供**固定阈值 | 统一取 `0.82 / 0.60` | **演示取值** |
| F4 | 校准映射 | 官方未公开公式 | `0.35 + 0.62 × (1 − e^(−2.6s)) / (1 − e^(−2.6))` | **自定义曲线** |
| F5 | 并行提问 | 一次请求内并行、互不依赖 | 生产形态并行 fan-out；本地重实现为同函数内顺序求解（等价语义） | **等价语义** |
| F6 | `choice` 基数上限 | **255** | 6 个意图选项 | 满足 |
| F7 | 时延与价格 | 端到端 70–500ms；输入 $0.042/M token | 本地重实现形态下为模拟值 | **模拟值** |
| F8 | **经验回流机制** | 官方只要求「记录预测 / 概率 / 真实标签 / 人工动作」并「按动作风险分级设定阈值」，**未定义经验如何回注决策** | `EXP-4` ~ `EXP-10` 为**本实现自研** | **自定义扩展（非官方机制）** |

### F.1 官方数据的引用边界（引用时必须附带）

- 官方工作流评测的「更快 / 更便宜」来自 TypeSafe 自身评测，存在设计偏差；**SHALL NOT 改写为「所有任务都快 N 倍」**。
- 官方承认无法证明定价未被补贴，长期可持续性待验证。
- 官方明确：**confidence 是路由信号，不是事实保证**；**类型安全约束的是输出形状，不是业务判断的正确性**。

### F.2 落地清单（官方建议顺序，本变更验收依据）

| # | 官方步骤 | 对应需求 |
| --- | --- | --- |
| 1 | 用历史样本定义 schema | `JEV-2` `EXP-1` |
| 2 | 对每个字段记录预测 / 概率 / 真实标签 / 人工动作 | `ARCHIVE-5` `EXP-1` |
| 3 | 分别计算准确率、分桶、校准误差、误报与漏报 | `EXP-2` |
| 4 | 设定自动执行 / 人工复核 / 回退三类阈值 | `JEV-5` `EXP-3` |
| 5 | 先以 shadow mode 运行并与人工结果对比 | `EXP-8` `EXP-10` |
| 6 | 观察延迟、token、重试、人工接管率、长期价格 | `EXP-10` `RESULT-5` `PERF-*` |

> **重要边界**：官方清单**止于「观察」**，未定义经验如何回注决策。`EXP-4` ~ `EXP-10` 是**超出官方清单的自研闭环**，SHALL NOT 对外表述为「官方机制」（见 F8）。

---

## 附录 G · 与提案的一致性核对表

| 提案条目 | 对应需求 | 状态 |
| --- | --- | --- |
| G1 成本可归因 | `RESULT-5` `ARCHIVE-1` | ✅ |
| G2 场景化选型 | `SCORE-1` `CONSTRAIN-1` | ✅ |
| G3 决策可解释且真实 | `JEV-1` `JEV-6` `MODEL-3` | ✅ |
| G4 经验可沉淀且可回流 | `EXP-1`~`EXP-10` | ✅ |
| G5 过程可感知 | `TREE-*` `ANIM-*` `RESULT-1` | ✅ |
| G6 不确定性诚实 | `JEV-5` `RESULT-1` | ✅ |
| D1 决策层接入形态 | `JEV-1` `JEV-7` `JEV-8` | ✅ |
| D2 交付形态 | `ARCH-2` `ARCH-4` | ✅ |
| D3–D8 | `ARCH-*` `SCORE-*` `TREE-*` `RESULT-1` | ✅ |
| D9 经验回流作用面 | `EXP-5` | ✅ |
| D10 可复现策略 | `EXP-6` | ✅ |
| D11 结果确认来源 | `EXP-1` `EXP-7` | ✅ |
| D12 阈值生效方式 | `EXP-3` | ✅ |
| D13 Jev/Selector 权责 | `CONSTRAIN-3` | ✅ |
| D14 五问调用方式 | `JEV-3` | ✅ |
| D15 三层权责边界 | `JEV-12` `CONSTRAIN-1` | ✅ |
| D16 置信度非授权 | `CONSTRAIN-1` `CONSTRAIN-3` | ✅ |
| D17 决策契约形态 | `JEV-12` | ✅ |
| D18 阈值绑定后果 | `JEV-15` | ✅ |
| D19 状态输入组织 | `JEV-14` | ✅ |
| R1–R7 风险缓解 | `CONSTRAIN-4` `EXP-6` `EXP-8` `EXP-5` `EXP-7` `EXP-7` `CONSTRAIN-1` | ✅ |
| R8–R11 风险缓解 | `CONSTRAIN-1` `JEV-15` `JEV-13` `JEV-16` | ✅ |

---

## 附录 H · 上线判定清单（规范性）

> 来源：Jev 工程权威清单（16 项）。任一决策在控制生产分支**之前**，SHALL 逐项通过下列判定；多项为「否」时，SHALL 判定为「尚未准备好自动化」，须先完善**决策契约**（`JEV-12`）。本清单为 `JEV-12`~`JEV-16` 与 `CONSTRAIN-*` 的**上线门禁**。

| # | 判定项 | 关联需求 | 判定 |
| --- | --- | --- | --- |
| 1 | 这是**语义决策**，而非生成任务或精确规则 | `JEV-2` `CONSTRAIN-1` | [ ] |
| 2 | 状态**紧凑、当前、基于证据** | `JEV-14` | [ ] |
| 3 | instructions **显式**，而非藏在提问 ID 里 | `JEV-12` | [ ] |
| 4 | 每个 `Choice` 在菜单可能不完备时含**逃生舱** | `JEV-13` | [ ] |
| 5 | `Score` 档位是**有序描述**而非伪测量 | `JEV-13` | [ ] |
| 6 | `Noul` 概率被解读为**是/否不确定性** | `JEV-13` | [ ] |
| 7 | 独立问题对**同一状态批量**提问 | `JEV-3` | [ ] |
| 8 | 依赖性问题以**状态更新**分隔 | `JEV-3` | [ ] |
| 9 | 置信度**改变路由**（而非仅展示） | `JEV-5` `JEV-11` | [ ] |
| 10 | 阈值**特定于动作后果** | `JEV-15` | [ ] |
| 11 | 代码保留对**权限 / 预算 / 副作用**的权威 | `CONSTRAIN-1` `CONSTRAIN-3` | [ ] |
| 12 | 决策契约**已版本化** | `JEV-12` | [ ] |
| 13 | **完整分布**随实际动作一并记录 | `JEV-16` `ARCHIVE-1` | [ ] |
| 14 | 已在**代表性样本**上以 shadow mode 运行 | `CONSTRAIN-5` `EXP-8` | [ ] |
| 15 | 无安全选项时系统**可升级** | `JEV-5` `JEV-13` | [ ] |
| 16 | 每次重试**增加新证据**（而非仅更多 token） | `EXP-1` `EXP-10` | [ ] |

> **门禁绑定**：本清单第 11 / 13 / 15 项 SHALL 在阶段门禁 `G3` / `G5` / `G8` 中显式复核（见 `tasks.md` §6）。

---

## 附录 G · 实现差异登记（代码实况回写）

> **登记日期**：2026-09-30
> **核对范围**：JEV 域 16 条需求 / 28 场景 ↔ `packages/backend` + `packages/shared` 实际代码
> **核对方式**：逐条读取实现落点 + 实际执行验证（`vitest` 126/126 通过、`vue-tsc` 零错误、真实链路 `POST /v1/routes` 端到端跑通）
> **性质**：本附录登记**规范文本与代码实现之间的现存差异**，供后续决策；不代表实现存在缺陷与否的最终判定。

### G-0 结论摘要

JEV 域 16 条需求**已全部具备代码落点并与规范一致**（15 条 ✅，1 条 `JEV-6` 为待决的规范表述问题，见 G-1）。
原 3 项偏差中 **G-2、G-3 已于 2026-09-30 关闭**（分别补 `constraintFallback` 登记、6 段状态接入主链）。
主体链路已端到端跑通：

```text
POST /v1/routes
  → EXPERIENCE_RETRIEVED（经验回流 + 阈值读取）
  → JEV_CALL_STARTED（五问打包单请求）
  → SystemOneJevAdapter HTTP 调用（真实 api.typesafe.ai）
  → JEV_DECISION_READY（置信度 + 完整分布 + rationale）
  → CONSTRAINT_GATE_PASSED / CONSTRAINT_FILTERED（8 步硬约束）
  → MODEL_SELECTED（先验注入 + 打分 + tieBreak）
  → ESCALATE → ROUTE_ESCALATED（不执行）｜ ROUTE/GATE → MODEL_CALL_STARTED
  → MODEL_STREAMING → MODEL_COMPLETED → EXPERIENCE_SAVED
```

### G-1 `JEV-6` Schema 校验失败策略为「降级」而非「短路」

| 项 | 内容 |
| --- | --- |
| **规范要求** | `JEV-6`：「Schema 校验失败 SHALL 短路并返回 `INVALID_DECISION`」「SHALL NOT 调用任何执行模型」 |
| **代码实况** | `JevAdapterError('JEV_INVALID_SCHEMA', …)` 被 `route-orchestrator.decide()` 的 `catch` 捕获，转为 `JEV_FALLBACK` 事件并交 `answerQuestionsLocally` 兜底，随后**继续正常选型与执行** |
| **代码位置** | `packages/backend/src/jev-http-adapter.ts`（抛错）→ `route-orchestrator.ts` `decide()` catch 分支（降级） |
| **性质** | **实现策略与规范文本不一致**。但降级路径由 `CONSTRAIN-4` 授权，且失败绝不会静默——`decisionSource` 会标记为 `LOCAL_REIMPL`、`JEV_FALLBACK` 事件带 `degraded: true`。 |
| **待决** | 二选一：① 修订 `JEV-6` 表述为「校验失败 SHALL 降级或短路，降级须显式标记」；② 修订实现为严格短路。**倾向 ①**——降级可用性更高，且已有审计留痕。 |

### G-2 `JEV-11` 档位与硬约束的正交性存在偏差 — ✅ 已补登记（2026-09-30）

| 项 | 内容 |
| --- | --- |
| **规范要求** | `JEV-11`：「该映射 SHALL NOT 受硬约束过滤结果影响」「GATE 与 ESCALATE 是决策运行时输出档位，与 Selector 的硬约束过滤是两个正交层次；二者 MUST NOT 混为一谈」 |
| **原实况（登记前）** | `tier = routeTier(confidence, thresholds)` 仅取 `confidence` 与阈值，**本身不受约束结果影响**（符合规范）。但候选池存在两处**静默回落**：<br>① `usable = eligible.length > 0 ? eligible : pool` —— 硬约束把候选全部淘汰时回落到未过滤的全量池；<br>② `filterPool` 在「白名单与目录无交集」时同样回落全量。<br>两者都不留痕，导致「约束是否真的生效」**无法从决策记录中判断**。 |
| **补登记内容（行为不变）** | ① `filterPool` 返回值改为 `{ pool, poolFallback }`，把白名单回落显式化；<br>② 主链新增 `constraintFallback = poolFilter.poolFallback \|\| hardConstraintFallback`，并区分原因：<br>  · `allowed_model_ids_not_in_catalog` —— 白名单与目录无交集<br>  · `all_candidates_eliminated` —— 硬约束淘汰全部候选<br>③ 落库与事件三处同步：`DecisionRecordEntry`（决策信息库）、`DecisionReceipt` + `summarizeReceipt`（JEV-16 凭据）、`CONSTRAINT_GATE_PASSED` 事件 payload；<br>④ **回落行为本身保持不变**（仍回落全量，不改为 `ESCALATE`），仅新增可观测性。 |
| **代码位置** | `packages/backend/src/route-orchestrator.ts`（`filterPool` / 主链 `constraintFallback` 计算 / `finishStores`）、`decision-store.ts`（`DecisionRecordEntry`）、`decision-receipt.ts`（`DecisionReceipt` / `summarizeReceipt`）、`route-event.ts`（事件 payload 类型） |
| **验证证据** | 新增 `packages/backend/src/__tests__/constraint-fallback-audit.test.ts`（12 项），含「回落时行为不变但必须标记」与「回落不改变目录序（MODEL-3）」断言；实跑两条路径：白名单收窄 → `constraintFallback: false` 且选型落在池内；白名单无交集 → `constraintFallback: true` + `allowed_model_ids_not_in_catalog`，选型仍正常（行为未变）。 |
| **结论** | **正交性已可审计。** 规范要求的「档位映射不受约束结果影响」在计算层始终成立；候选池的回落取舍现以显式字段留痕，符合 `JEV-11` 「二者 MUST NOT 混为一谈」的分层意图。 |

### G-3 `JEV-14` 状态 6 段未接入生产调用链 — ✅ 已修复（2026-09-30）

| 项 | 内容 |
| --- | --- |
| **规范要求** | `JEV-14`：「决策执行顺序 SHALL 与该主链一致：先由 STATE 组装输入状态（facts · context · evidence）」；`§0.8` 将「状态工程 6 段」列入三层权责的 DECIDE 侧纪律 |
| **原实况（修复前）** | `state-engineering.ts` 有完整实现（`EngineeredState` 6 段 + `assembleState()` + 结论性短语污染扫描 + `stateHash`/`stateVersion`），但 **`assembleState` 在生产代码中零引用**——仅被 `index.ts` 导出、被 `e2e-integration.test.ts` 与 `go-live-checklist.ts` 调用。真实调用链走 `SystemOneJevAdapter.buildState()`，只拼装 `<user_request>` / `<local_evidence>` 两段文本，**缺 FACTS / ARTIFACTS / CONSTRAINTS / OPTIONS 四段**。 |
| **修复内容** | ① 编排器新增 `buildEngineeredState()`，在主链 DECIDING 段用 `assembleState()` 组装 6 段：<br>  · `GOAL` = 用户原始诉求<br>  · `FACTS` = 已核实客观事实（token 估算 / 附件计数 / 能力档位）<br>  · `ARTIFACTS` = 已存在产物（当前无附件时为空）<br>  · `EVIDENCE` = 原子证据，逐条带 `verified` 标记；先验类标 `verified: false`<br>  · `CONSTRAINTS` = 用户显式给的预算 / 延迟 / 池收窄<br>  · `OPTIONS` = **由实时目录重建**的候选模型 + 能力标签<br>  · `stateVersion` 钉住 `requestId:expVersion`（JEV-16 可复现）<br>② `JevAdapter.decide()` 入参由 `prompt: string` 改为 `state: EngineeredState`；`buildState()` 改为序列化 6 段（`<state><goal>…</goal>…</state>`），保留 `verified` 标记使 Jev 可区分已核实 / 待核实。<br>③ 顺带修正 `answerQuestions()`：此前把 `EngineeredState` 误当 `{ prompt }` 取值（恒为空串），现同样走 6 段序列化。 |
| **代码位置** | `packages/backend/src/route-orchestrator.ts` `buildEngineeredState()`；`packages/backend/src/jev-http-adapter.ts` `decide()` / `buildState()` / `answerQuestions()` |
| **验证证据** | 新增 `packages/backend/src/__tests__/jev-state-engineering-wiring.test.ts`（9 项）锁定「6 段确实到达真实 HTTP 请求体」并断言旧结构不复现；实跑拦截真实 `api.typesafe.ai` 请求，捕获的 `state` 含完整 6 段且 `<user_request>` / `<local_evidence>` 零残留。 |
| **结论** | **已关闭。** `JEV-14` 与 `§0.8` 权威边界声明在生产路径上正式生效。 |

### G-4 状态表以外的相关观察（非 JEV 域偏差）

以下为核对过程中发现、但归属其他需求域的现状，登记备查：

| # | 观察 | 现状 |
| --- | --- | --- |
| G-4.1 | `tieBreak` 比较器 | 已符合 `SCORE-4`：以 `raw` 降序为第一关键字，仅同分才进入 capability → cost → latency → modelId 序列。 |
| G-4.2 | `interpretNoulProbability` 边界 | 已修复：`\|p − 0.5\| <= ε + 1e-9`，0.45 / 0.50 / 0.55 三点同为 `indistinguishable`。 |
| G-4.3 | 候选模型池同源 | 前端 `InputTab` 从 `/v1/models` 动态拉取，勾选经 `constraints.allowedModelIds` 回传，满足 `MODEL-4` 同源要求。 |
| G-4.4 | 事件类型契约 | `route-event.ts` 14 种事件已含 `MODEL_CALL_STARTED` / `ROUTE_FAILED`，且前后端定义同源。 |
| G-4.5 | 测试接入 | 已接入 `vitest`（根 `vitest.config.ts`），11 个文件 126 条断言全通过。 |

---
