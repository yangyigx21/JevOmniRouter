# Direct Mode Apply Workflow

> `ai-apply-change` 直接（direct）模式流程。仅当 `sdd.design-mode=direct`（含默认值、`legacy`）时加载。
> 使用本文中的任何 repo / path / scope / 工具示例前，必须先读取 `_shared/sdd-profile-runtime.md`，并从 `project-profile.yaml`、`AGENTS.md` 和当前工作区解析项目事实；本文中出现的已渲染示例仅作参考，不得直接套用。

## 模板与脚本

模板按需读取，不要把正文复制到上下文里：

- `assets/templates/direct-apply-prompts.md`：Phase 0/1.1/2.1/2.2/4.2/5.3/5.4/7 阶段性输出模板（ask-questions JSON、进度回执、约束摘要等）。
- `assets/templates/direct-apply-artifacts.md`：Phase 6 报告文件模板（apply-report.md、human-config-checklist.md、coding-assumptions.md）。

脚本（`<skills-root>/ai-apply-change/scripts/`，`<skills-root>` 为本技能目录的父级，如 `.claude/skills/`）：

| 脚本 | 用途 |
|------|------|
| `create_backup.py` | Phase 1.2 工作区源码备份；旧 artifact 目录备份 |
| `collect_changed_files.py` | Phase 6 根据 written-files.txt 拷贝变更源码至 changed-files/；生成 changed-files.md |
| `validate_phase6_artifacts.py` | Phase 6 产物完整性校验 |

---

## Phase 0：选定 change

如果用户已明确给出 change 名称，直接使用，跳过本步骤。否则运行 `openspec list`，把输出原样展示给用户，再按 `assets/templates/direct-apply-prompts.md` 中的 Phase 0 模板调用 ask-questions 让用户选择。选定后按模板宣告并进入 Phase 1。

---

## Phase 1：前置校验与备份

### 1.1 前置校验

```bash
openspec status --change "<name>" --json
```

检查以下两个 artifact 的 `status` 是否为 **`done`**：

- `design`
- `tasks`

若任意一项未完成，按 `assets/templates/direct-apply-prompts.md` 中的 Phase 1.1 提示立即终止。若两者均已完成，继续 Phase 1.2。

---

### 1.2 备份代码与旧 artifacts

**步骤 1：备份工作区源代码（可选）**

前置校验通过后，询问用户是否先备份工作区源码：

```bash
python3 <skills-root>/ai-apply-change/scripts/create_backup.py \
  --mode workspace \
  --workspace "." \
  --output "."
```

备份文件保存到工作区根目录：`backup-{YYYY-MM-DD-HH-MM}.zip`（自动排除 `.git/`、`.gitnexus/`、`node_modules/`、`target/`、`build/`、`dist/`、`.gradle/` 等可重建目录）。用户拒绝时继续执行，在 apply-report.md 记录 `workspace-backup: skipped_by_user`。

**步骤 2：备份并清空旧 artifacts**

```bash
python3 <skills-root>/ai-apply-change/scripts/create_backup.py \
  --mode artifact \
  --workspace "." \
  --change "<change-name>"
```

- 目录不存在：脚本记录 `artifact-backup: not-needed` 后继续。
- 备份失败：**立即停止**，不得继续执行。

备份成功后，清空并重建目录结构：

```bash
rm -rf .ai-sdd/artifacts/changes/<change-name>
mkdir -p .ai-sdd/artifacts/changes/<change-name>/changed-files
```

---

## Phase 2：加载 apply 规则与编码前置准备

### 2.1 加载 config.yaml apply 规则

> openspec-apply-change 会自动加载 `config.yaml` 的 `context` 块，但**不会注入 `rules.apply`**。本步骤手动读取并在后续编码全程强制执行。

读取文件 `openspec/config.yaml`，仅提取 `rules.apply:` 下的全部条目（YAML 列表），保留在工作记忆中。apply 阶段强制编码约束，每条规则必须在任务实现中遵守。

加载完成后按 `assets/templates/direct-apply-prompts.md` 中的 Phase 2.1 输出确认。

---

### 2.2 编码前置准备

逐步执行以下步骤，不得跳过：

**步骤 1：确定上下文 scope**　读取当前 change 的 `design.md` / `tasks.md`，判定本次涉及的 scope（如 `backend`、`frontend-h5`、`frontend-pc`、`components`、`all`）。`type=fullstack` 的仓库同时归入 `backend` scope 和 `frontend-{frontend_type}` scope（`frontend_type` 取自该仓库 profile 中的 `frontend_type` 字段），因此 fullstack 仓库可能同时出现在后端任务和前端任务中；scope 判定时需将其两侧 scope 均纳入。`type=components` 的仓库归入 `components` scope；修改共享组件库且影响消费方时，scope 应同时包含 `components` 与相关 frontend/backend scope。

**步骤 2：加载 apply 阶段上下文**　按 `openspec/config.yaml` 的 `context` 块读取 `.ai-sdd/context/context-index.yaml`，以 `stage=apply` 和步骤 1 的 scope 为过滤参数最小加载：先读 `load_policy: always`；再读匹配 `stage/scope` 的 `stage-start`；`on-demand` 仅在代码模式、接口契约、枚举、数据、测试或事实查证命中时读取。目录型上下文先读 `README.md`，再按候选或证据需求读取具体文件。`scope: all` 仅表示适用于所有 scope，不表示始终加载。

**步骤 3：加载代码模式样板**　若命中 `.ai-sdd/context/system/代码模式（code-patterns）/` 这个 on-demand 条目：先读取 `README.md`，再按任务类型和 README 加载具体样板文件。若目录不存在或无匹配样板，追加记录到 `review-notes.md`。

**步骤 4：加载 change 专属上下文**　若 `.ai-sdd/context/changes/<change-name>/README.md` 存在：先读取该 README，再按当前阶段和问题加载 `补充设计约束（design-constraints）.md` 等相关文件；若仅存在旧式 `补充设计约束（design-constraints）.md`，可直接读取并记录该目录缺少 README。

**步骤 5：检查原型目录**　若 `.ai-sdd/context/changes/<change-name>/prototype/` 存在：记录到工作记忆，前端任务须对照原型实现。

**步骤 6：契约前置校验（分层处理）**　读取 `openspec/changes/<change-name>/contracts.md`（若存在），并明确区分三类契约：
- **应用接口契约**：用于编码时对齐后端接口、页面/API 调用、数据结构、错误语义和 Apply 不得改变的设计决策。优先来自 `contracts.md` 的接口/前端/数据章节；若 legacy direct change 尚未生成 `contracts.md`，可只从已确认的 `design.md` 章节抽取为本次 apply 的工作记忆，不得自动写回或改写正式 `contracts.md`。
- **OUTBOUND 外部协议契约**：仅用于后端出站调用实现，必须来自已确认设计与外部协议证据，包含外部 body 字段原名、大小写/拼写、必填/类型、内部字段来源、转换/补齐规则和责任层。它不是应用内部接口契约。
- **INBOUND 入站协议契约**：仅用于本仓库作为 CSF 门面/业务服务接收外部系统入站调用时的实现，必须来自已确认设计与外部接口规范，包含外部规范字段原名、大小写/拼写、内部读取 KEY（使用项目字段常量类，禁止裸字符串）和必填缺失处理策略。它不是应用内部接口契约。

按以下规则门禁：
- 若 `design.md` / `tasks.md` 不涉及 OUTBOUND，`contracts.md` 缺失不构成 OUTBOUND 阻塞；继续以 `design.md` 中已确认的应用接口契约作为编码依据。
- 若涉及 OUTBOUND，`design.md` 与 `contracts.md` 必须都包含完整 OUTBOUND 外部协议契约；任一缺失、只在 draft 中存在、或字段映射不含外部字段原名/责任层时，立即阻塞并要求回到 design/contracts 修正，不得在 apply 阶段临时补 OUTBOUND 契约。
- 若 `design.md` / `tasks.md` 不涉及 INBOUND，`contracts.md` 缺失不构成 INBOUND 阻塞；继续以 `design.md` 中已确认的应用接口契约作为编码依据。
- 若涉及 INBOUND，`design.md` 与 `contracts.md` 必须都包含完整 INBOUND 入站协议契约；任一缺失、只在 draft 中存在、或字段映射不含外部规范字段原名/责任层时，立即阻塞并要求回到 design/contracts 修正，不得在 apply 阶段临时补 INBOUND 契约。
- 若应用接口契约不清晰，先按 `tasks.md` 顺序实现可确定任务；涉及不清晰契约的任务暂停并记录到 `review-notes.md`，要求回到 design/contracts 补清。

**步骤 6.1：OUTBOUND / INBOUND 门禁登记（必须登记到 apply-report）**　在所有任务实现之前，必须先在 `apply-report.md` 的 "Review 与修复门禁结果" 表格中预填 OUTBOUND / INBOUND 行（参考 `assets/templates/direct-apply-artifacts.md`）：

- 若本 change 不涉及 OUTBOUND：初检填 `not-applicable`，证据填 `tasks.md 无 OUTBOUND 任务`。
- 若本 change 涉及 OUTBOUND：执行步骤 6 的"按以下规则门禁"判定，把 design/contracts 完备性、字段映射、责任层、证据来源填入证据列。
- INBOUND 同上。
- 后续任务实现完成后回到本步骤复检，把"修复动作"和"复检"列填齐，作为 apply-report 的事实来源。
- **未做门禁登记不得进入下一步骤 7**（接口契约与代码模式专项门禁）。

**步骤 7：接口契约与代码模式专项门禁**

- 每个跨中心调用 / CSF / API / 网关 / SDK 调用在编码前必须确认目标入口真实存在，并记录 `serviceCode/接口标识 -> 目标 CSV/类/方法或端点 -> 必填入参字段 -> 返回结构`；不得凭 serviceCode、接口标识或方法名推导入参或返回结构。
- 若目标实现契约与 design/tasks 冲突，按目标契约修正可隔离实现；会改变业务语义或契约时阻塞并写入 `review-notes.md`。
- 任务或设计命中项目模式（如规则、工作流、出账、外部接口、动态配置等）时，必须加载项目 context 中对应 playbook/code-pattern/checklist；以项目 code-pattern 的落地骨架为准，禁止把内部框架入口设计成业务方直接调用。
- 每个编码任务完成后必须对照项目 `.ai-sdd/context/sdd/编码实现检查清单（apply-checklist）.md` 自检；skill 不复制 checklist 细则。

完成后按 `assets/templates/direct-apply-prompts.md` 中的 Phase 2.2 模板输出加载摘要。

---

## Phase 3：执行策略

direct apply 模式始终按 `tasks.md` 单线程串行编码，不向用户询问执行策略。

按 `tasks.md` 的任务顺序进入 Phase 4 / Phase 5；同一 fullstack 仓库内的后端与前端任务也按顺序执行。

---

## Phase 4：合并约束 → 调用 openspec-apply-change

### 4.1 构建综合约束集

将以下两部分合并为当前 apply 会话的**综合约束集**：

1. **config rules.apply**（来自 Phase 2.1）— 项目级编码约束，强制执行。
2. **用户补充指令**（来自触发时传入的额外参数）— 优先级最高。

若两者冲突，以用户补充指令为准，并在控制台明确提示冲突项及采纳方式。

**人工配置边界**：apply 阶段不自动执行页面网关、BSV/CSF/serviceCode、异步后台任务调度配置。若 tasks 中包含配置任务，编码总结中必须提醒用户完成，并给出联调点。禁止生成配置 SQL 或配置模板来替代人工配置。涉及 DDL/SQL 时，只读取 `project-profile.yaml paths.ddl_directory` 下 SQL；执行前必须征询用户同意。

### 4.2 输出综合约束摘要

按 `assets/templates/direct-apply-prompts.md` 中的 Phase 4.2 模板向用户展示本次约束摘要。

### 4.3 调用 openspec-apply-change

以增强的工作记忆（含以上所有约束）进入 openspec-apply-change 技能执行流程。

**职责边界（K1）**：

- **openspec-apply-change 负责**：读取 `design.md` / `tasks.md` artifact、执行代码生成、将 `- [ ]` 更新为 `- [x]`、写入 outputPath。
- **本技能 Phase 5 负责**：任务执行顺序管理、skip-list 强制执行、依赖回溯处理、终态汇报；Phase 5 的执行纪律约束 openspec-apply-change 的具体实现行为。
- openspec-apply-change 完成后不得直接结束，必须继续执行 Phase 5.5 占位扫描，再进入 Phase 6 生成 apply artifacts。

---

## Phase 5：任务执行与勾选纪律

> 本阶段是对 openspec-apply-change 的**外层执行纪律约束**：openspec-apply-change 负责代码生成与 tasks.md tick mark 更新；Phase 5 负责执行顺序、跳过规则、依赖处理和最终汇报。所有验证命令均由项目本身（README / 构建文件 / config.yaml `rules.apply`）决定，本技能不绑定任何具体语言或框架。

### 5.1 完整性原则

- **目标**：完成 tasks.md 中的全部任务（含所有子任务）。
- **唯一豁免**：用户补充指令中明确跳过的任务（列入 skip-list 不执行）。
- **禁止**：因"任务繁琐 / 上下文长 / 非核心"擅自省略未列入 skip-list 的任务。
- **禁止**：tasks.md 存在 `- [ ]` 时声称完成；剩余未做项必须在摘要中显式列出原因。

### 5.2 顺序与依赖处理

默认按 tasks.md 列出顺序执行。遇到依赖时：

1. 暂存当前任务（T_curr），记录"挂起原因：依赖 T_dep"。
2. 优先完成 T_dep（递归处理依赖链，最多 3 层）。
3. T_dep 完成并勾选后，回到 T_curr 继续实现。

禁止：发现依赖就直接放弃 T_curr；把多任务合并实现后只勾选其中一项。

### 5.3 单任务执行循环

对每个待实现任务：

1. 输出 `▶ Working on N.M: <task title>`。
2. 实施（代码任务最小化实现；测试任务必须真实调用项目测试命令）。
   - **每写入或修改一个源代码文件**，立即将其相对路径追加到 `.ai-sdd/artifacts/changes/{change-name}/written-files.txt`；测试源码、SQL、runner、报告等非源代码文件不写入此清单。格式统一为 `<仓库名>/<模块或子目录>/<文件路径>`（如 `crmbjnew/busi-gsm/src/...`、`crm-pre/busi-pre/src/...`），所有仓库同一规则。
   - 若产生**编码假设**（未知常量/枚举/配置键等），追加到 `.ai-sdd/artifacts/changes/{change-name}/coding-assumptions.md`（字段：依据、假设值、影响文件、验证方式、调整点）。
   - 若需要**人工配置、SQL 执行、联调确认**，追加到 `.ai-sdd/artifacts/changes/{change-name}/human-config-checklist.md`。
3. 把 `- [ ]` 改为 `- [x]`，按 `assets/templates/direct-apply-prompts.md` 中的 Phase 5.3 模板追加证据注释。
4. 进入下一任务。

### 5.4 终态汇报

所有任务处理完成后，按 `assets/templates/direct-apply-prompts.md` 中的 Phase 5.4 模板输出执行摘要。

---

### 5.4.1 待确认项阈值门禁（与 config.rules.apply 一致）

在终态汇报前，必须按 `openspec/config.yaml` 中 `rules.apply` 末尾约定的"待确认项"暂停阈值（本工作区默认 `5 个以上未解决的待确认项`）做门禁检查：

1. 统计 `design.md` / `tasks.md` / `contracts.md` / `review-notes.md` 中未解决的待确认项数量：
   - 形如 `TODO: 待确认` / `待确认项` 段落中未确认行。
   - `review-notes.md` 中未打 `[已解决]` 标签的条目。
2. 若计数 ≥ 5：
   - 暂停并提示用户：`[BLOCKED] 待确认项 N 项（≥ 5），按 config.rules.apply 暂停阈值要求先解决 / 明确延后 / 标记为 deferred 任务后再继续。`
   - 列出清单，**不**继续 Phase 5.5 / 5.6 / 6。
3. 若计数 < 5：把"待确认项 N 项"写进终态汇报（Phase 5.4 模板）。

> 此门禁与 `config.yaml` 的 `rules.apply` 段落一一对应；若 config 调整阈值（如改为 3 或 10），按 config 当前值判定。

---

### 5.5 占位扫描与实现闭环

Phase 5.4 终态汇报完成后，按 Phase 5.3 格式读取 `.ai-sdd/artifacts/changes/{change-name}/written-files.txt`（跳过空行和 `#` 注释；每行一条 workspace 相对路径，在 workspace 根下打开对应源文件），对每个文件执行占位扫描：

- 若 `written-files.txt` 不存在，在 `review-notes.md` 标注 `placeholder-scan: BLOCKED — written-files.txt missing`，并停止扫描。

对每个含 `TODO` 或 `PENDING` 占位的文件：

1. 读取文件，理解占位上下文（所在方法、业务场景、关联 Trace、原始原因）。
2. 依据 design/contracts/tasks、代码模式、API/GitNexus 和现有实现优先补全；补全成功则删除占位注释。
3. 若占位实际不成立，删除并在 `review-notes.md` 写明撤销理由。
4. 若仍依赖外部接口、运行时配置或人工确认，保留 `// PENDING: <原因>`，并在 `human-config-checklist.md` 逐条对应；**不允许原样保留 //TODO**。

扫描结束后，在 `review-notes.md` 追加：`placeholder-scan: X 处已补全/撤销，Y 处仍阻塞（已登记到 human-config-checklist），0 处遗漏登记`。

---

## Phase 6：生成 apply artifacts

artifact 目录已在 Phase 1.2 备份并清空，此阶段直接写入报告文件。

### 步骤 1：写入报告文件

按需读取 `assets/templates/direct-apply-artifacts.md` 获取各报告文件的模板结构，生成并写入以下文件：

- **`apply-report.md`**：变更摘要、Review 入口（主业务流程 / 接口入口 / 页面入口）、人工配置总览与链接；详细假设放 `coding-assumptions.md`，详细人工动作放 `human-config-checklist.md`。
- **`review-notes.md`**：Phase 5 执行中已追加，本步骤可补充汇总；不得覆盖已有内容。
- **`coding-assumptions.md`**：Phase 5 执行中已追加；若无假设，创建空文件并注明 `no-assumptions`。
- **`human-config-checklist.md`**：Phase 5 执行中已追加；若无人工动作，创建空文件并注明 `no-manual-actions`。

### 步骤 2：根据 written-files.txt 归档 changed-files

`changed-files/` 只归档本次 apply 新增或修改的源代码文件；`.ai-sdd/`、`openspec/`、备份 zip、报告、SQL、runner、测试数据等非源代码文件不得进入。

**必须运行**（不得跳过；仅手写 `changed-files.md` 不算完成 Phase 6）：

```bash
python3 <skills-root>/ai-apply-change/scripts/collect_changed_files.py \
  --workspace "." \
  --change "<change-name>" \
  --output ".ai-sdd/artifacts/changes/<change-name>"
```

脚本读取 Phase 5 累积的 `written-files.txt`，从磁盘拷贝源文件到 `changed-files/` 并生成 `changed-files.md`。默认命令发现 `written-files.txt` 缺失时必须失败，不得回退扫描 git；退出码非 0 时补全或修复 `written-files.txt` 后重跑，直到成功。

### 步骤 3：产物完整性校验

```bash
python3 <skills-root>/ai-apply-change/scripts/validate_phase6_artifacts.py \
  --change "<change-name>" \
  --workspace "."
```

校验以下产物存在；报告文件必须非空，`written-files.txt` 在本轮有源代码变更时必须非空，`changed-files/` 可为空目录但须有对应 `changed-files.md` 说明原因：

```text
.ai-sdd/artifacts/changes/{change-name}/changed-files/
.ai-sdd/artifacts/changes/{change-name}/changed-files.md
.ai-sdd/artifacts/changes/{change-name}/apply-report.md
.ai-sdd/artifacts/changes/{change-name}/coding-assumptions.md
.ai-sdd/artifacts/changes/{change-name}/human-config-checklist.md
.ai-sdd/artifacts/changes/{change-name}/review-notes.md
.ai-sdd/artifacts/changes/{change-name}/written-files.txt
```

若本轮确实没有源代码变更，在 `apply-report.md` 写明 `changed-files: no source code changes`，`changed-files.md` 写明原因。

---

## Phase 7：refine 同意门

**目标**：编码与 Phase 6 产物交付完成后，主动询问用户是否进入 `ai-refine-change` 做一轮评估与修复校准。

**触发条件**：满足以下全部条件后进入本步骤，否则跳过并提示用户：

- Phase 5 已达到终态：所有非 skip-list 任务均已勾选 `[x]`（含证据注释），用户明确跳过的任务已保留未勾选状态，并在 skip-list 与终态摘要中记录。
- 已产出 `apply-report.md` / `changed-files/` / `review-notes.md` 等必备产物。
- 本次 change 涉及源代码变更（`changed-files: no source code changes` 场景直接跳过）。

**执行步骤**：按 `assets/templates/direct-apply-prompts.md` 中 Phase 7 模板（`header: "执行 refine"`）调用 ask-questions，给出"执行 refine（推荐）"与"暂不 refine"两个选项。用户选择"执行 refine"时，调用 `ai-refine-change`；选择"暂不 refine"时保留当前实现和报告，本技能结束。

**说明**：本步骤对应 `assets/templates/direct-apply-prompts.md` 中的 Phase 7 模板，与 Phase 5.5 占位扫描使用不同编号。

---

## 注意事项

- 补充指令示例：
  - "暂不生成测试源码" → 跳过测试相关任务（最终摘要说明缺口）。
  - "只实现后端任务" → 前端相关任务加入 skip-list。
  - "DDL 不执行，只生成脚本" → 生成 SQL 文件但不执行。
  - "使用严格模式" → 遇到不确定项立即暂停。
- 若 tasks.md 中有 `TODO: 待确认` 项，在进入编码前统一列出，由用户决定是否先行确认。
