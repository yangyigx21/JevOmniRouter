# 官方轻量模式执行契约（official-apply-workflow）

> 本文件是 `sdd-development-workflow` SKILL.md Step 2 的执行细则，适用于**官方轻量流程**（无 project-profile.yaml、无 .ai-sdd/、无 rules.apply）。契约来源：`openspec-apply-change` 官方技能 + openspec CLI 源码行为。**纯官方契约，零 aispec 增强**（不做备份、不读 rules.apply、不做契约门禁、不建台账、不写证据注释）。

## 0. 前提

- 官方轻量模式判定已完成（见 flow-detection.md）。
- `openspec instructions apply --change <name> --json` 已返回 `state=ready`；门禁决策（GO / VERIFY-ONLY / NO-GO）由 `scripts/gate.py` 给出，处理见 SKILL.md Step 0.2。

## 1. 七步主循环

> **本节是对 `openspec-apply-change` 技能的阅读辅助，不是它的替代品。** 任何差异一律以该技能 SKILL.md 原文为准；`openspec update` 升级官方技能后，以升级后的原文为准。

1. **选 change**：已在 Step 0 完成并播报，此处不重复播报。
2. **status**：`openspec status --change <name> --json` → 记录 schemaName / planningHome / changeRoot / actionContext。
3. **instructions**：`openspec instructions apply --change <name> --json` → 消费：
   - `contextFiles`：artifact → 文件路径数组。**读其中每一个实际存在的文件**（spec-driven 下为 proposal / specs / design / tasks；design.md 是条件性 artifact，缺失属正常——以返回值为准，禁止假设文件名）。
   - `progress`：total / complete / remaining。
   - `tasks`：带状态的任务清单（复选框行解析，与标题形态无关）。
   - `instruction` / `context` / `operationGuidance`（若有）：context 是必读 prompt 级输入；operationGuidance 是官方 `operations.apply.guidance` 通道的 advisory 约束——读入并在实现中遵守。**注意 CLI < 1.7.0 时该字段不存在**（gate.py 的 `capabilities.operation_guidance=false`），不得臆造。三者**均不构成完成证据、不得用来绕过 blocked 状态**；与内置指令/用户选择冲突时保留控制方并上报。
4. **展示进度**：`Progress: <complete>/<total>`。
5. **逐任务循环**：
   - 展示当前任务（复选框后首行文字）。
   - 写代码：**最小化、聚焦**——只做该任务要求的行为，不顺手重构、不引入额外抽象。
   - **立即**把该任务 `- [ ]` 改 `- [x]`（趁上下文新鲜，不攒批）。
   - 下一任务。
6. **暂停条件**（任一满足即停并询问/上报）：
   - 任务含糊，无法确定要实现什么；
   - 实现暴露设计问题（建议用户更新对应 artifact）；
   - 需要超出 spec 的工作、或想删减 / 收窄 / 推迟任务 / 接受例外——**必须上报追加范围，不得默默吸收**（本分身附加纪律，与 SKILL 设计原则 5 同源；较新版本的官方技能亦含类似条款）；
   - 遇错或阻塞；
   - 用户打断。
7. **完成或暂停时**：展示本次完成任务与总进度。

## 2. 勾选诚实性（硬规则）

- 只有任务行为**完全实现**才勾 `- [x]`；部分完成、被推迟、被跳过一律保持 `- [ ]`。
- 部分完成后需要暂停的：保持 `- [ ]`，在终态汇报中说明进度。
- **进度以 `gate.py` 的 `parsed_progress` 为准**：已部署 CLI（1.3.1）的解析器**忽略缩进复选框**，`progress` 与 `state=all_done` 会漏计子任务——实测两条未勾子任务下仍返回 `all_done`。不得用 CLI 进度判定完成。
- **任务描述文字里不要出现复选框样例**：新版解析器会把它计为独立任务，旧版则漏计——两个方向都出错。

## 2.1 轻量模式的客观完成证据（弥补"零增强"的证据缺口）

轻量模式不建台账，唯一痕迹是勾选；而生态自己规定"勾选不是实现证据"。因此在不引入任何 aispec 台账的前提下，把**任务自带的验证方式**抬为完成证据：

- 官方 tasks 规范要求每个任务自带验证方式。任务含可执行验收命令时，**必须真实执行**，并在终态汇报中记录命令与退出码（例：`npm test → exit=0`）。
- 任务无可执行验收命令时，如实标注"无可执行验收（仅代码审阅）"——不得把"没验证"写成"已验证"。
- 收尾时列出 `git diff --stat` 的文件清单与已勾任务的对照，**把"已勾但变更集中找不到对应文件"的任务单列一行**（这是唯一能自动发现假勾选的信号；不改判级，但必须可见）。非 git 仓库时降级为磁盘比对（grep 目标符号 / 检查导出 / 统计用例数），并声明降级。

### 2.2 发现"已勾但未实现"时怎么办

上一轮勾早了、或勾选后代码被回滚，是真实高频形态。处置规则（按顺序）：

1. **绝不传播假绿**——最高优先级。不得因为"前序任务已勾"就把依赖它的收尾任务（如"运行完整测试确认全部通过"）也勾上。收尾任务的实质是断言整体完成，前序有缺口时它**必须保持 `- [ ]`**，哪怕其字面验收命令（退出码为 0）确实满足：空套件的绿色不是通过。
2. **必须可见**——在终态汇报中**指名**该任务编号与缺失的具体符号/文件，附证据（grep 结果、导出符号、用例计数）。
3. **不自行改判级**——不静默补做、也不擅自反勾。"谁在何时把未做的任务勾上"是流程缺陷，静默补做会抹掉这个信号。
4. **上报并请求裁决**——ask-questions 给出两个选项：(a) 授权本轮补齐（属 spec 内工作，非范围蔓延）；(b) 判为上游/历轮交付缺陷，按左边界退回。无人值守时按设计原则 7 取保守分支：停在诊断点、零写入。

> 注意制品级校验对这类缺陷**完全无感**：`openspec validate --strict` 与 `gate.py` 都只看制品与复选框，无从知晓代码是否存在。发现它唯一靠真实执行验收命令后再做 spec ↔ 代码交叉核对。

## 3. 自动验证（右边界，触发规则与 SKILL Step 2.4 / A3 统一）

- **正常完成**（全部任务勾选、无暂停）→ 立即**自动执行** `openspec-verify-change`，无需用户触发；
- **异常暂停**（遇错 / 任务含糊 / 范围上报 / 用户打断）→ **不跑 verify**，输出暂停原因并等待用户；用户确认收尾后再自动执行。

执行时读取 `openspec-verify-change` 技能并按其三维度检查：

- 三维度：**Completeness**（复选框完成度 + spec 覆盖）、**Correctness**（需求→代码映射 + 场景覆盖含测试）、**Coherence**（design 遵循 + 代码模式一致性；无 design.md 时跳过 design 检查并注明）。
- 问题分级：CRITICAL / WARNING / SUGGESTION。启发式：关键词搜索 + 合理推断，不确定时就低不就高。
- verify 是**只读**检查：不修代码、不改 tasks。
- 结果写入终态汇报的"验证结论"，并给出 archive 准入判定。
- verify 技能不可用时：以 `openspec validate <change>` 最低限度替代并声明降级。

## 4. 终止线

- 停在 archive 准入判定。**不自动归档**：`openspec-archive-change`（确认未完成任务 → delta 与主 spec 比对 → sync-specs 智能合并 → 移入 `changes/archive/YYYY-MM-DD-<name>/`）由用户显式触发。
- blocked 补制品（`openspec-continue-change`）与 artifact 修订（`openspec-update-change`——若该技能未随工作区分发，则建议用户直接编辑 artifact 或先安装/更新 openspec 技能集）同样由用户决定，本分身只在建议中提示。

## 5. 与 aispec 模式的差异备忘（防止串模式）

| 行为 | 官方轻量 | aispec（对照，本模式禁用） |
|---|---|---|
| 勾选证据注释 | 无（干净 `- [x]`） | `<!-- done: … -->`（playbook 子模式另加 `files: …`） |
| 备份 | 无 | 强制 artifact zip 备份 |
| 约束注入 | `operations.apply.guidance`（advisory，需 CLI ≥1.7.0 且 config 有配置） | 手动读 `rules.apply` ≈20 条 |
| 台账 | 无 | written-files.txt / ASM-* / CFG-* / review-notes / apply-report |
| 门禁 | 无（诚实勾选 + 范围上报） | 待确认项 ≥5 BLOCKED；OUTBOUND/INBOUND 字段级完备 |
| 验证 | openspec-verify-change | ai-verify-change（+E1–E5） |
| **不可逆动作同意门** | **有（两模式均生效）** | 有（另有 ai-apply Phase 4.1 的 DDL 门） |

> ⚠️ 最后一行是**故意**的：不可逆动作同意门不属于 aispec 台账增强，它来自分身对"不可逆"的自身判断。维护者请勿按"轻量=删干净"把它删掉——aispec 侧的同类门写在 ai-apply direct Phase 4.1，轻量侧只有这一道。
