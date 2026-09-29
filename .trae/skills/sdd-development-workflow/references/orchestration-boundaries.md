# 编排边界（orchestration-boundaries）

> 本文件定义开发分身 ↔ 被包裹技能 ↔ 相邻分身之间的职责分配。原则：**每件事只有一个 owner；分身只做编排与监督，重活委托技能**。

## 1. 开发分身自身的职责（不委托）

| 职责 | 说明 |
|---|---|
| 环境检测 | 对话开启时询问一次是否检查/更新技能（人设"主流程开始前环境检测"） |
| 任务分诊 | 判定简单改动 vs 需走 SDD；简单改动提示直修，不加载本手册（人设"任务分诊"） |
| 流程探测与模式声明 | Step 0 探测序 + 交叉验证 + 冲突仲裁（flow-detection.md） |
| change 选择与就绪门禁 | `gate.py` 决策消费；左边界拦截（不补 tasks、不改制品） |
| 外层纪律 | 范围上报、不可逆动作同意门、不 git commit、不手改官方技能、历史隔离、outputPath 消费 |
| 续作台账保全 | `ledger.py` snapshot / merge（仅 aispec 模式） |
| verify 自动执行 | apply 正常完成后立即触发对应 verify 技能（右边界核心） |
| 终态汇报 | 统一格式（SKILL.md Step 3） |

## 2. 分身 ↔ 技能职责边界（A 系列表）

> 编号说明：A 系（A1/A2/A3）是**分身层**边界。`ai-apply-change/references/direct-workflow.md` Phase 4.3 定义的 **K1** 是其**内层**边界（ai-apply-change ↔ openspec-apply-change），与本表 A1 不冲突、互不覆盖——aispec 模式下两层同时生效。

### A1：aispec 模式下 分身 ↔ ai-apply-change

| 归属 | 事项 |
|---|---|
| **ai-apply-change** | direct/playbook 子路由、备份、rules.apply 注入、上下文最小加载、契约门禁、单任务执行循环、依赖回溯、skip-list、占位扫描、Phase 6 产物与校验脚本、（direct）Phase 7 refine 同意门 |
| **开发分身** | 模式声明与探测证据、就绪门禁（design+tasks done）、监督其不越左边界、终态后自动触发 verify、台账核对（见 SKILL Step 1.4）、终态汇报 |

### A2：轻量模式下 分身 ↔ openspec-apply-change

| 归属 | 事项 |
|---|---|
| **openspec-apply-change** | 七步主循环的执行语义：读 contextFiles、逐任务实现、立即勾选、暂停条件 |
| **开发分身** | 进入该技能前：模式声明 + 就绪门禁（state=ready；GO/VERIFY-ONLY/NO-GO 由分身 Step 0.2 依 gate.py 处理，技能内状态语义作为兜底）；进入后监督其最小实现与诚实勾选；退出后自动触发 openspec-verify-change + 终态汇报 |

> 不重复播报：`Using change` 横幅与进度只在分身 Step 0 播报一次，进入技能后不重复。但**官方技能步骤 2–4 仍须按其 SKILL.md 原文过一遍**——分身 Step 2.1–2.2 的产出可作为已知输入直接复用，不得因"已经跑过"而跳过技能原文里该步骤的其余要求（未来官方在步骤 2–4 新增的内容才不会被漏掉）。

### A3：verify 阶段 分身 ↔ ai-verify-change / openspec-verify-change

| 归属 | 事项 |
|---|---|
| **verify 技能** | 三维度（+aispec E1–E5）只读检查、CRITICAL/WARNING/SUGGESTION 分级、archive 准入判定 |
| **开发分身** | 触发规则（与 SKILL Step 2.4 统一）：**正常完成 → 立即自动执行**（无需用户确认）；**异常暂停 → 不执行**，输出原因等待用户，确认收尾后再自动执行。change 名来自用户输入/对话上下文推断（verify 技能允许从上下文推断，不必再问用户）。转述结论；CRITICAL 时建议 refine（用户决策） |

## 3. 相邻分身交接表

| 相邻分身 | 交接物 | 方向 | 约束 |
|---|---|---|---|
| 需求分析分身（sdd-requirement-workflow） | `openspec/changes/<id>/{proposal.md, specs/**}` + `project-profile.yaml` + `.ai-sdd/context/` | 上游 → 本分身 | Step 8 设计交接无落盘信号，本分身必须自行做就绪校验 |
| 开发设计分身（technical-designer） | `design.md` / `contracts.md` / `tasks.md` + Go/No-Go 结论 | 上游 → 本分身 | tasks 缺失退回该分身；本分身不补写 |
| E2E测试分身（test-* 技能族） | 测试产物（`openspec/sdlc-agent/E2E测试分身/**`） | 本分身 → 用户触发 | 单测任务在 apply 循环内可用 test-unit-runner 执行 |
| 代码分析分身（ca-* 技能族） | 审查报告 | 本分身 → 用户触发 | 批次自检可按需调用 ca-code-quality（变更模式）等 |
| 归档（ai-archive-change / openspec-archive-change） | archive 就绪的 change | 本分身 → 用户触发 | verify → harvest → archive 顺序约束由归档技能自身校验 |

## 4. 禁止事项（红线清单）

1. 禁止补写 / 改写 tasks.md 的任务定义（只能勾选状态位 `- [ ]` ↔ `- [x]`）。
2. 禁止手改 `openspec-*` 官方技能与 `.trae/skills/_shared/`（受管目录，整体替换分发）。
3. 禁止在轻量模式注入 aispec 增强（见 official-apply-workflow.md §5 差异备忘）。
4. 禁止自动归档、自动 refine、自动 git commit。
5. 禁止读取 `.ai-sdd/changes/` 与旧 apply artifacts **作为实现依据或代码模式来源**。豁免：本 change 当前及历轮的 `written-files.txt`、`tasks.md` 复选框、`<change>.carryover/` 可作为**进度与幂等事实**读取。
6. 禁止调用任何 `aispec` CLI 命令。
7. 禁止在未取得用户同意时执行**不可逆动作**（数据库/外部系统写、执行 .sql/migration/seed、改写 git 历史、写入依赖锁文件的安装升级）——两种模式均适用，不属 aispec 增强。
