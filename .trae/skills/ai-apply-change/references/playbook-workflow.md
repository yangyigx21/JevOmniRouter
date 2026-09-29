# Playbook Apply Workflow

> `ai-apply-change` 专用 playbook 模式流程。仅当有效 `sdd.design-mode=playbook` 时加载。使用本文中的任何 repo/path/scope/tool 示例前，必须先读取 `_shared/sdd-profile-runtime.md`，并从 `project-profile.yaml`、`AGENTS.md` 和当前工作区解析项目事实。本文保留的硬编码 repo 名和备份 include 列表只作为示例；实际 include/path 参数必须从 `repositories[]` 和 `paths.*` 生成。

## 目标

执行 `openspec/changes/{change-name}/tasks.md` 中的实现任务。编码前用 design/contracts、设计手册和代码模式构建 Implementation Context Pack；编码中仅对允许范围内的未知取值做有依据的编码假设并完成实现；编码后生成清晰的 apply artifacts。

## 核心规则

1. `tasks.md` 只说明做什么；本技能负责按现有系统确认怎么做。
2. 每个任务组必须追溯到 `design.md` / `contracts.md` 的 `D-*` Trace；缺 Trace 时从 design 反查并记录缺口。
3. 设计手册和代码模式是默认实现依据；源码、API Registry、GitNexus 只在需要确认事实、编辑现有符号或验证失败时补证。
4. 接口契约、serviceCode/接口标识、方法签名、入参字段、返回结构不得凭名称推导；凡要新增或修改调用，必须从 contracts、API 资料、GitNexus 或目标源码确认。
5. 编码中遇到需要人类确定或当前资料未知的常量、编码、枚举值、配置键、模板 ID、流程 ID、MQ Topic/tag 时，允许先基于当前环境、邻近实现、design/contracts 和代码模式做最小假设并继续编码；代码包、类、接口、方法、字段、配置数据、组件、路由、流程能力、业务规则和不存在的功能不在假设范围内，必须由证据确认或暂停。
6. 所有编码假设必须记录到独立文件 `coding-assumptions.md`，与 `apply-report.md` 位于同一目录。
7. 人工配置、联调、SQL 执行、生产配置和人工确认项必须记录到 `human-config-checklist.md`；不要生成生产配置。
8. 编辑任何现有函数、类、方法或共享符号前，运行 GitNexus impact analysis；完成后对涉及 repo 运行 GitNexus detect_changes。若技能文件或工作区制品不属于任何 GitNexus repo，记录 `not-applicable` 和原因。
9. 每完成一个任务立即勾选 `tasks.md`，并在注释中写明产出和文件。
10. 绝对禁止参考 `.ai-sdd/changes/` 或 `.ai-sdd/artifacts/changes/` 下已有编码历史成果；历史 changed-files、apply-report、review-notes、测试源码、SQL、runner、报告等不得作为实现依据、代码模式、假设依据或源码兜底证据。

## 连续执行规则

除 Step 0 备份确认、证据不足且禁止假设、备份/验证硬失败外，不得因任务多、跨 Phase、跨仓库或预计耗时高而暂停询问。

任务很多时自行按 repo/layer 分批执行到 Step 6。阶段性回复只能报告进度，不得让用户选择是否继续。

## 模板与脚本

模板按需读取，不要把正文复制到 `SKILL.md`：

- `assets/templates/playbook-implementation-context-pack.md`：上下文包与任务组记录模板。
- `assets/templates/playbook-apply-artifacts.md`：Step 6 各报告文件模板。

脚本（`<skills-root>/ai-apply-change/scripts/`，`<skills-root>` 为本技能目录的父级，如 `.claude/skills/`）：

| 脚本 | 用途 |
|------|------|
| `create_backup.py` | Step 0 工作区备份；Step 1 旧 artifact 目录备份 |
| `collect_changed_files.py` | Step 6 读取 `written-files.txt` 汇总拷贝到 `changed-files/` 并生成 `changed-files.md` |
| `validate_phase6_artifacts.py` | Step 6 产物完整性校验 |

## Step 0：选择 change 与前置校验、备份代码

未提供 change-name 时运行：

```bash
openspec list --json
```

让用户选择后运行：

```bash
openspec status --change "<name>" --json
openspec instructions apply --change "<name>" --json
```

必须确认：

- `design` 已完成。
- `tasks` 已完成。
- `openspec/changes/{change-name}/tasks.md` 存在。

若 design/tasks 缺失，停止并提示先运行 `ai-design-change` / `ai-tasks-change` 且保持 `sdd.design-mode=playbook`。

仓库与路径映射以工作区 `AGENTS.md` 和 `.ai-sdd/context/sdd/工作区布局（workspace-layout）.md` 为准；`project-profile.yaml -> repositories[]` 提供仓库名、路径和 `gitnexus_index`。若映射冲突，按真实目录和 AGENTS 执行，并写入 `review-notes.md`。

前置校验通过后，询问用户是否需要先备份已有源代码与 `openspec/`。用户同意时运行（不传 `--include` 时脚本会自动从 `project-profile.yaml -> repositories[].path` 解析仓库目录，并附加 `openspec`）：

```bash
python3 <skills-root>/ai-apply-change/scripts/create_backup.py \
  --mode workspace \
  --workspace "." \
  --output "."
```

如需显式指定，按当前 `project-profile.yaml -> repositories[]` 的 `path` 字段逐个追加 `--include <repo_path>` 即可，禁止在本文档中维护硬编码 repo 列表。

备份文件保存到工作区根目录：`backup-{YYYY-MM-DD-HH-MM}.zip`。默认排除 `.git/`、`.gitnexus/`、`node_modules/`、`target/`、`build/`、`dist/`、`.gradle/` 等非源码/可重建目录。用户拒绝时继续执行，并在 `apply-report.md` 记录 `workspace-backup: skipped_by_user`。

## Step 1：备份并清空旧 artifacts

运行：

```bash
python3 <skills-root>/ai-apply-change/scripts/create_backup.py \
  --mode artifact \
  --workspace "." \
  --change "<change-name>"
```

- 目录不存在：脚本记录 `artifact-backup: not-needed` 后继续。
- 备份失败：**立即停止**，不得继续执行，向用户报告错误。

备份成功后，清空并重建空目录结构供本轮写入：

```bash
rm -rf .ai-sdd/artifacts/changes/<change-name>
mkdir -p .ai-sdd/artifacts/changes/<change-name>/changed-files
```

此后 Step 4–6 写入的 apply-context-pack.md、sql/、test-sources/、runners/、reports/、review-notes.md、coding-assumptions.md 等全部落入这个空目录；Step 6 不再重建目录。

## Step 2：加载基础制品

读取：

- `openspec/config.yaml` 中 `rules.apply`。
- `openspec/changes/{change-name}/proposal.md`。
- `openspec/changes/{change-name}/specs/`。
- `openspec/changes/{change-name}/design.md`。
- `openspec/changes/{change-name}/tasks.md`。
- `openspec/changes/{change-name}/contracts.md`（若存在）。
- `.ai-sdd/context/changes/{change-name}/README.md`（若存在）。
- `project-profile.yaml` 的 `repositories`、`scopes` 和 `paths.*`。

禁止读取或参考 `.ai-sdd/changes/`、`.ai-sdd/artifacts/changes/{other-change}/` 以及当前 change 目录中既有的历史编码产物来指导实现；当前 change artifact 目录只允许用于写入本轮交付记录（Step 1 已完成备份）。

## Step 3：tasks 解析

提取所有未完成任务，按 **repo / layer / scenario / trace** 四维分组：

- repo：运行时按 `project-profile.yaml -> repositories[]` 和 AGENTS.md 列出的代码仓库。
- layer：按 `project-profile.yaml -> architecture.backend_layers[]` 列出的分层顺序（缺省时按 DB → Entity → DAO → BSV-Service → BSV-CSF → PSV-Service → PSV-CSF → ET/Task → Frontend → Test → Config 兜底）。
- scenario：由 tasks 中的业务描述确定。
- trace/refs：`Trace:` / `refs:` / `D-*` / contracts / Context Hints；缺失时从 design 反查并在 `review-notes.md` 记录缺口。

**fullstack 仓库分组规则**：`type=fullstack` 的仓库在单 git 仓库内同时包含前端（h5/pc）和后端（PSV/BSV）组件，分组时应按内部 PSV/BSV/frontend 子目录拆分为独立任务组。同一 fullstack 仓库的不同层任务组应避免并行执行，以防文件冲突；建议按 backend 层优先、frontend 层在后的顺序串行安排。fullstack 仓库的后端层次由 `center_types[]` 确定，前端类型由 `frontend_type` 确定。

**components 仓库分组规则**：`type=components` 的仓库为共享组件库（构建期依赖，无 CSF/HTTP）。任务组按导出面/模块拆分；若 design 列出消费方仓库，须为每个消费方增加联调/回归子任务。修改 components 时 scope 须含 `components`，并视 Impact 纳入相关 frontend/backend scope。

## Step 4：按任务组循环执行

对 Step 3 解析出的每个任务组，按依赖顺序循环执行 4.1 构建上下文包、4.2 执行任务组、4.3 验证与变更范围检查。一个任务组完成验证后，再进入下一个任务组；跨任务组一致性问题留到 Step 5 汇总 review 与修复。

### 4.1 构建 Implementation Context Pack

对每个任务组构建上下文包。简单变更可保留在工作记忆；复杂变更或多 agent 并行时写入：

```text
.ai-sdd/artifacts/changes/{change-name}/apply-context-pack.md
```

对每个任务组按固定步骤加载，不跳步：

1. 基础路由：按 `.ai-sdd/context/context-index.yaml` 以 `stage=apply + scope` 最小加载上下文；目录型上下文先读 README/索引，再读候选文件。
2. Trace 锚点：强制定位 `design.md` / `contracts.md` 的 `D-*` 与对应段落，确认业务义务、边界和契约。
3. change 专属约束：读取 `.ai-sdd/context/changes/{change-name}/README.md`（若存在）并提取本任务组相关约束。
4. 历史隔离：不得读取或引用 `.ai-sdd/changes/`、其他 change 的 `.ai-sdd/artifacts/changes/*/`、当前 change 旧 artifacts 中的编码历史成果；只能使用正式 OpenSpec 制品、当前 change 专属 context、设计手册、代码模式、API/源码/GitNexus 证据。
5. 设计手册：命中典型场景时，读取 `.ai-sdd/context/system/设计手册（design-playbooks）/README.md` 与命中的 playbook。
   - 若命中场景涉及具体编码骨架，必须同时读取对应 `.ai-sdd/context/system/代码模式（code-patterns）/` 文件；code-pattern 是项目落地骨架，优先于 playbook 中的内部机制说明。
   - 若任务、design 或源码命中某个项目模式（例如规则、工作流、出账、外部接口、动态配置等），必须加载项目 context 中对应 playbook/code-pattern/checklist。若 tasks/design 与项目模式冲突，按项目模式修正实现，并在 `review-notes.md` 记录设计偏差。

5.5. **OUTBOUND 出站规约**（条件强制 — 涉及外部协议出站调用的任务组必须完成）：
   - 触发条件：任务组涉及 OUTBOUND 调用（对当前仓库不可控的外部协议：HTTP/RPC/SDK/MQ/ESB/网关代发等任一形式）。不涉及 OUTBOUND 的任务组跳过本子步骤。
   - **在出站 body 组装或调用 SDK 之前**必须完成：
     1. 加载对应外部协议文档（位于 `.ai-sdd/context/system/系统接口目录（api-catalog）/`、`api-drilldown/`、API Registry 或 change 专属 README 中明确列出的外部协议章节），记录 `证据来源 | 字段名 | 必填 | 类型 | 含义 | 置信度`。
     2. 契约门禁：`design.md` 与 `contracts.md` 必须已显式声明内部 Map/Bean 字段 ↔ 外部协议 body key 映射、字段大小写/拼写、必填差异和"由内层 X 补齐"责任层；任一缺失、只存在于 draft、或只准备在 apply 阶段补写时，**立即暂停编码**，在 `review-notes.md` 标注 `OUTBOUND-contract: BLOCKED`，要求先回到 design/contracts 修正后再继续。
     3. 字段级 diff：覆盖外部协议文档列出的全部必填项、字段名（大小写敏感）、字段类型/长度；对其中 1 项不一致立即暂停并在 `review-notes.md` 报告。
   - 本子步骤的目标是"出站 body 字段级契约"在 apply 之前与外部协议文档完成 diff，避免实现期因字段缺失/大小写错误触发联调返工。

5.6. **INBOUND 入站规约**（条件强制 — 涉及本仓库接收外部入站调用的任务组必须完成）：
   - 触发条件：任务组涉及 INBOUND（本仓库接收外部系统入站调用：CSF/跨中心调用 / 网关入站 / 工作流回调 / MQ 入站 / 第三方回调等任一形式）。不涉及 INBOUND 的任务组跳过本子步骤。
   - **在入口适配层解析入参或写入下游数据前**必须完成：
     1. 加载对应外部接口规范（位于 `.ai-sdd/context/system/系统接口目录（api-catalog）/`、`api-drilldown/`、API Registry 或 change 专属 README 中明确列出的外部协议章节），记录 `外部规范字段原名 | 必填 | 类型 | 含义 | 置信度`。
     2. 契约门禁：`design.md` 与 `contracts.md` 必须已显式声明 INBOUND 接收字段映射（外部规范字段原名 / 内部字段或读取 key / 必填缺失处理）；任一缺失、只存在于 draft、或只准备在 apply 阶段补写时，**立即暂停编码**，在 `review-notes.md` 标注 `INBOUND-contract: BLOCKED`，要求先回到 design/contracts 修正后再继续。
     3. 字段级 diff：覆盖外部接口规范列出的全部必填项、字段名（大小写/拼写敏感）、字段类型/长度；对其中 1 项不一致立即暂停并在 `review-notes.md` 报告。
   - 本子步骤的目标是"入站字段级契约"在 apply 之前与外部接口规范完成 diff，避免实现期因字段缺失/拼写错误触发联调返工。

6. 代码模式与分层规范：
   - 只要任务组包含编码动作，就必须先读 `.ai-sdd/context/system/代码模式（code-patterns）/README.md`。
   - 为该任务组选择并读取相关的代码模式文件（按 repo/layer/scenario）；若无命中，记录原因（不允许留空不作答）。
   - 从模式中识别编码模式：包路径、类命名、调用链、事务边界、异常处理、配置闭环、测试写法等。
   - **分层编码规范（按 repo / layer 强制加载，不以"层次单一"为由跳过）**：
     - 运行时按当前任务组 `repo` 与 `layer` 查找 `.ai-sdd/context/engineering/` 下匹配的编码指南目录/文件（命名约定示例：`BSV业务服务层编码指南（bsv-coding-guide）/`、`BFF页面服务层编码指南（bff-coding-guide）.md`、`ET后台调度组件编码指南（et-dispatch-guide）.md`）。命中即必须先读。
     - 涉及跨 Center 调用时，加读对应指南下的 `cross-center.md`（若存在）。
     - 仅当 `.ai-sdd/context/engineering/` 下无任何匹配指南时，可以以当前 repo 内同域现有代码为准；此时必须在 `review-notes.md` 中写明"无对应分层指南，参考代码：<file>"。
     - 编码中发现违反分层方向规则的存量代码时，不得照搬，需记录到 `review-notes.md`。

7. **Pattern Selection 声明（编码前必须输出，不得省略）**：
   步骤 6 完成后，在开始 4.2 实际编码前，必须在 `apply-context-pack.md` 对应任务组摘要下（或直接在回复中）输出以下声明表，三项均不允许留空：

   ```
   Pattern Selection — 任务组 N.x-N.y
   | 维度           | 命中                      | 备注           |
   |----------------|---------------------------|----------------|
   | 代码模式       | [文件名] / 无（原因：...）| [已加载/未加载]|
   | 工程指南       | [文件名] / 不适用（原因：）| [已加载/未加载]|
   | change 专属约束| [来源文件/小节] / 无      | [摘要]         |
   ```

   若工程指南填写"不适用"，必须写出判断依据（例如"repo=<repo_name>，`.ai-sdd/context/engineering/` 下无对应分层指南"）；不允许以"层次单一"或"任务简单"为由跳过命中的工程指南。

8. API 证据：仅在接口、serviceCode/接口标识、字段、枚举或外部能力不明时，补读 API catalog / api-drilldown / API Registry。
9. **接口契约硬门禁**：
   - 每个跨中心调用 / CSF / API / 网关 / SDK 调用在编码前必须确认目标入口真实存在，并记录 `serviceCode/接口标识 -> 目标 CSV/类/方法或端点 -> 必填入参字段 -> 返回结构`。
   - 不得根据 serviceCode、接口标识或方法名推断入参；目标实现要求与 design/tasks 不一致时，先按目标契约修正或阻塞记录。
   - 返回值必须按目标契约或项目 code-pattern 解析。
10. 源码/GitNexus 兜底：仅在代码模式无法提供覆盖，且需要确认精确路径、签名、现有行为、影响面或验证失败时补证。

若证据不足以确定允许假设范围内的取值，进入「假设驱动实现」：仅可对未知常量、编码、枚举值、配置键、模板 ID、流程 ID、MQ Topic/tag 选择最小影响、最易替换、最符合现有命名规律的假设值，必要时集中为常量或配置项；将假设写入 `coding-assumptions.md`（依据、假设值、影响文件、验证方式、调整点）。代码包、类、接口、方法、字段、配置数据、组件、路由、流程能力、业务规则或功能存在性无法确认时必须暂停或列为待确认；严禁编造不存在的功能、接口、流程与业务规则。

当需要落盘 `apply-context-pack.md` 时，使用 `assets/templates/playbook-implementation-context-pack.md` 作为记录结构，逐任务组记录上下文包摘要、已加载依据、Pattern Selection、假设和待确认项；不得复制模板正文或省略 Pattern Selection。

### 4.2 执行任务组

每个任务组：

1. 输出简短开始提示：`Working on {repo}/{layer}/{scenario}: tasks N.1-N.k`。
2. 展示上下文包摘要，不复制长 playbook 或代码模式全文。
3. 按 design/contracts、playbook、code-pattern、必要源码证据和编码假设做完整实现。
4. 代码模式与设计手册是最高优先级的参考，但不是简单的复制与模版参数替换。
5. 仅当必要时才需要调研源代码用以参考。
6. 如果代码模式与源代码冲突，以代码模式为准，并进行记录。
7. 发现 design 与源码事实冲突时，优先做可隔离的环境假设并记录；若冲突影响中心归属、数据主写、接口契约或会造成不可逆生产动作，暂停确认。
8. 代码、测试、SQL、E2E 用例清单、runner、报告等产物写入 tasks 或 `project-profile.yaml paths.*` 指定路径；生产配置仅进入 `human-config-checklist.md`。
9. **每写入或修改一个源代码文件，立即追加一行到 `written-files.txt`**（`.ai-sdd/artifacts/changes/{change-name}/written-files.txt`）。这是 Step 6 汇总 `changed-files/` 的唯一依据。

   - **格式**：每行一条 workspace 相对路径，统一为 `<仓库名>/<模块或子目录>/<文件路径>`，例如 `crmbjnew/busi-gsm/src/main/java/.../Foo.java`、`crm-base/utils-web/src/main/java/.../Bar.java`。所有仓库同一规则，不要只写 `src/main/...`。
   - **只记源代码**；测试、SQL、runner、报告等不写进来。
   - **追加写入**，不要整文件重写；不要写 `M `/`A ` 前缀、分隔线、分组标题或行尾说明。
10. 完成任务后立即勾选：

```markdown
- [x] N.1 ... <!-- done: 产出一句话；files: repo/pathA, repo/pathB -->
```

11. 每个编码任务完成后，按 `openspec/config.yaml` 的 apply 规则执行一次 `apply-checklist` 增量自检；发现不合格项立即修复，不留到最后集中处理。

测试任务写明运行结果：

```markdown
- [x] T.1 ... <!-- done: tests exit=0; command: ... -->
```

用户明确跳过时保持未勾选并写明原因：

```markdown
- [ ] T.1 ... <!-- skipped_by_user: 原因 -->
```

### 4.3 验证与变更范围检查

每个任务组完成编码后：

1. 运行任务要求的测试或仓库既有最小验证命令。
2. 对涉及的每个 repo 运行 GitNexus detect_changes，必须带正确 `repo` 参数。
3. GitNexus 不适用或不可用时，在 `review-notes.md` 和 `apply-report.md` 记录原因与替代验证。
4. 检查本任务组涉及的 `tasks.md` 条目是否仍有未解释的 `- [ ]`。

用户未明确跳过时，不因任务简短或测试耗时跳过验证。

## Step 5：实现汇总 Review 与修复闭环

生成或更新：

```text
.ai-sdd/artifacts/changes/{change-name}/review-notes.md
```

至少记录：

- Trace 一致性：已实现任务对应的 `D-*`、design/contracts 来源；缺 Trace 或冲突项。
- 代码模式：已实现任务所参考的代码模式、裁剪和偏离。
- 设计偏差：实现相对 design/tasks/contracts 的偏离、原因和处理方式。
- 接口契约：新增/修改的跨中心调用、CSF、API、网关或 SDK 调用的目标入口、必填入参字段、返回结构核验证据；与 design/tasks 不一致时记录处理方式。
- 编码假设：新增/沿用的 `ASM-*` 编号和影响面。
- 源码兜底结论：触发原因、读取范围、结论；未触发写 `not-needed`。
- GitNexus：impact 对象、风险级别、HIGH/CRITICAL 处理、detect_changes 结果或不适用原因。
- 验证缺口：未运行测试、失败测试、替代验证及原因。

在同一轮 Review 中执行门禁汇总复检（与 `apply-checklist` 一体化）：

- 本阶段不替代 Step 4.2 的"每任务增量自检"，而是对全量改动做跨任务汇总复检与闭环修复。
- 汇总复检只关注三类事项：Step 4.2 增量检查中失败/阻塞项、跨任务一致性问题（比如不同层次之间需要交换的参数/报文一致性）、交付产物完整性。
- `apply-checklist` 作为唯一检查基线：不再在本节重复定义第二套完整清单。

修复闭环规则：

1. 先执行 Review 与门禁初检，并把 fail 项写入 `review-notes.md`。
2. 对 fail 项立即修复并复检，直到门禁全部通过或确认阻塞。
3. 无法修复的阻塞项必须在 `review-notes.md` 和 `apply-report.md` 标注 `blocked`、影响范围和人类决策点。

**占位代码（`//TODO` / `//PENDING` 等）扫描与实现闭环（Step 5 必须执行）**：

在门禁汇总复检完成后，按 Step 4.2 §9 格式读取 `written-files.txt`（跳过空行和 `#` 注释；每行一条 `<仓库名>/<模块或子目录>/<文件路径>`，在 workspace 根下打开对应源文件），对每个文件执行占位扫描。**TODO 与 PENDING 处理方式一致**：

- 逐文件检查是否存在 `//TODO`、`// TODO`、`# TODO`、`/* TODO */`、`<!-- TODO -->`、`// PENDING:`、`# PENDING:`、`<!-- PENDING -->` 等占位注释。
- 若发现任一占位：
  1. 读取该文件，理解占位的上下文（所在方法、业务场景、关联 D-* Trace、`<原因>` 中的原始诉求）。
  2. 依据 design/contracts、playbook、context/engineering 代码模式、API Registry、GitNexus，**优先尝试补全**：补全成功则替换占位、删除注释；若发现该占位实际不成立（如参数应由前端透传、生成规则在另一处已实现），写明"撤销"理由。
  3. 在 `review-notes.md` 末尾追加一条 `placeholder-closed` 记录，写明文件、原占位内容、实现/撤销摘要。
  4. 更新 `written-files.txt`（该文件应已在列，无需重复追加）。
- 仍无法关闭的（外部接口、运行时配置、人工确认），保留 `// PENDING: <原因>` 标注并在 `human-config-checklist.md` 中**逐条对应**；**不允许原样保留 //TODO 进入 changed-files**。
- 扫描结束后，在 `review-notes.md` 输出摘要：`placeholder-scan: X 处已补全/撤销，Y 处仍阻塞（已登记到 human-config-checklist），0 处遗漏登记`。
- 若 `written-files.txt` 不存在，则属于 Step 4.2 执行缺陷：立即停止并在 `review-notes.md` 标注 `placeholder-scan: BLOCKED — written-files.txt missing`。

## Step 6：生成 apply artifacts

artifact 目录已在 Step 1 备份并清空，此阶段直接写入报告文件，不再重建目录。

### 步骤 1：写入报告文件

读取 `assets/templates/playbook-apply-artifacts.md` 获取各报告文件的模板结构：

- **`apply-report.md`**：按模板填充；是 review 入口，只放摘要与链接。详细假设放 `coding-assumptions.md`，详细人工动作放 `human-config-checklist.md`。
- **`coding-assumptions.md`**、**`review-notes.md`**：Step 5 已写入，**不得覆盖**；如有补充直接追加。
- **`human-config-checklist.md`**：如 Step 4.2 有记录则已存在，否则按模板新建。
- **`changed-files.md`**：在步骤 2 由脚本生成。

### 步骤 2：根据 written-files.txt 汇总 changed-files

**必须运行**（不得跳过；仅手写 `changed-files.md` 不算完成 Step 6）：

```bash
python3 <skills-root>/ai-apply-change/scripts/collect_changed_files.py \
  --workspace "." \
  --change "<change-name>" \
  --output ".ai-sdd/artifacts/changes/<change-name>"
```

脚本读取 Step 4.2 累积的 `written-files.txt`，从磁盘拷贝源文件到 `changed-files/` 并生成 `changed-files.md`。默认命令发现 `written-files.txt` 缺失时必须失败，不得回退扫描 git；退出码非 0 时补全或修复 `written-files.txt` 后重跑，直到成功。

### 步骤 3：完整性检查

Step 6 结束前必须确认以下产物存在；报告文件必须非空，`written-files.txt` 在本轮有源代码变更时必须非空，`changed-files/` 可为空目录但须有对应 `changed-files.md` 说明原因：

```text
.ai-sdd/artifacts/changes/{change-name}/changed-files/
.ai-sdd/artifacts/changes/{change-name}/changed-files.md
.ai-sdd/artifacts/changes/{change-name}/apply-report.md
.ai-sdd/artifacts/changes/{change-name}/coding-assumptions.md
.ai-sdd/artifacts/changes/{change-name}/human-config-checklist.md
.ai-sdd/artifacts/changes/{change-name}/review-notes.md
.ai-sdd/artifacts/changes/{change-name}/written-files.txt
```

任一文件缺失/为空，或 `changed-files/` 包含非源代码文件时，立即补齐或修复；不得进入最终输出。

若本轮确实没有源代码变更，在 `apply-report.md` 写明 `changed-files: no source code changes`，`changed-files.md` 写明原因；若本轮有源代码变更但 `changed-files/` 为空，视为 Step 6 失败。

必须运行 Step 6 校验脚本；本轮有源代码变更时加 `--expect-source-code`：

```bash
python3 <skills-root>/ai-apply-change/scripts/validate_phase6_artifacts.py \
  --change "<change-name>" \
  --workspace "."
```

## 最终输出

最终只输出：

- change 名称。
- 完成任务数 / 跳过任务数 / 阻塞任务数。
- 主要变更文件。
- 编码假设文件路径和未关闭假设数。
- 人类配置清单路径和 pending 数。
- 已运行的测试/验证命令及结果。
- workspace/artifact 备份路径或跳过原因。
- review-notes、changed-files、apply-report 路径。
