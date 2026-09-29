---
name: sdd-development-workflow
description: SDD 开发（apply）工作流执行手册（开发分身唯一执行权威）：探测 aispec 重流程 / 官方轻量 openspec 两类上游并路由，驱动编码实现（编码前私有技术栈识别）、任务勾选与自动验证，止于 archive 准入判定
version: 1.2.0
updated: 2026-09-02
---

# SDD 开发工作流（开发分身执行手册）

上游（需求分析分身 + 开发设计分身）可能来自 **aispec 重流程**或**轻量官方 openspec 流程**，两者核心产物同为 `openspec/` 目录。本手册驱动 apply 阶段：读 design、消费 tasks、写代码、勾任务、自动验证。

## 定位与边界

| 边界 | 规则 |
|---|---|
| **左边界** | 不做 tasks 生成。入口门禁由 `scripts/gate.py` **按 change 判定**（不按工作区模式）：`decision=GO` 才进入实现；`NO-GO`（tasks 缺失 / 制品校验 ERROR / CLI state=blocked）按左边界退回上游——轻量建议 `openspec-continue-change`，aispec 退回开发设计分身；**本分身永不补写 tasks、永不改制品**。design.md 是**条件性** artifact（官方 `apply.requires=[tasks]`，自举仓库 22 个 change 中 7 个无 design.md 仍 `state=ready`），缺失或 `skipped` 均不构成阻塞，只降级相关检查 |
| **右边界** | apply 完成 → verify **自动执行** → 停在 archive 准入判定。`archive` / `ai-create-e2e` / `context-harvest` / `ai-refine-change` 仅作建议，由用户显式触发 |
| **判据（不是清单）** | 自动执行的判据是**只读且可逆**：verify 只读→自动；refine/archive/commit/迁移脚本会改变状态或不可逆→必须用户同意。遇到本表未列举的新动作（sync-specs、依赖安装、DB 迁移、格式化提交），按此判据自行判断，不要因"没列举"就默认可做 |
| **上游** | 需求分析分身（sdd-requirement-workflow Step 0–8）→ 开发设计分身（technical-designer：design / contracts / tasks + Go/No-Go） |
| **下游** | 用户触发 refine / verify 复检 / e2e / harvest / archive |

## 触发方式

用户说："开始开发"、"apply 这个 change"、"实现这个 change"、"消费 tasks"、"继续实现 / 继续 coding"、"开发分身"。

> **前置：任务分诊已完成。** 本手册只描述**需要走 SDD 的 apply 工作**。人设规定：不改动系统核心设计的简单改动经 `triage.py` 否决检查 + 用户确认后走**直修模式**，**不加载本手册**、不产 openspec 制品、不建台账、不勾选 tasks。
>
> 若在本手册执行过程中发现当前任务其实属于简单改动：**已有可 apply 的 change 时**继续按流程执行即可（流程对小改动只是偏重，不会出错）；**Step 0 门禁返回 NO-GO 或落入空工作区分支时**（简单改动通常本就没有 change），不得为了"凑流程"补写 change/tasks——那是左边界明令禁止的——应退回人设的分诊，按直修模式处理。反之，直修中发现牵连接口/数据模型/跨模块，必须停下转入本手册 Step 0。

## 设计原则

1. **确定性优先于自觉**。凡能由脚本判定的（探测、门禁、进度、版本能力、台账完整性）一律跑 `scripts/`，模型只消费结论并播报；散文规则只用于脚本无法判定的judgment。
2. **Wrapper 优先，不重复造轮子**。aispec 模式委托 `ai-apply-change`（其内部再路由 direct / playbook 并委托 `openspec-apply-change`）；轻量模式包裹 `openspec-apply-change` 七步循环。本分身只管：模式声明、就绪门禁、外层纪律（不补 tasks、不 archive、范围上报、不可逆动作门）、续作台账保全、verify 自动执行、终态汇报。
3. **进度以自解析为准**。`gate.py` 逐行解析 tasks.md（**含缩进子任务**）；CLI < 1.8.0 的 `progress` / `state` 会漏计缩进行，不得作为完成判据。只有任务行为**完全实现**才勾选。
4. **消费 CLI 返回值**。contextFiles、outputPath 一律以 `openspec status --json` / `instructions apply --json` 返回为准（`artifactPaths.<id>.resolvedOutputPath` 是权威绝对路径，天然覆盖 store 场景），禁止假设文件名与路径。
5. **范围蔓延必须上报**。需要超出 spec 的工作、想删减/收窄/推迟任务或接受例外时，上报用户追加范围，不得默默吸收。
6. **轻量流程保持轻量**。官方轻量模式下不注入任何 aispec 增强（不做备份 zip、不读 rules.apply、不做 OUTBOUND/INBOUND 门禁、不建 .ai-sdd 台账、不设待确认项阈值）。**例外**：不可逆动作同意门不是 aispec 增强，两模式均生效。
7. **文档优先级仲裁**：本手册（与人设）> 被包裹技能内部的**推荐选项**（不覆盖其强制步骤——那属于被委托技能的执行语义）。例：ai-apply Phase 7 推荐"执行 refine（推荐）"，但本手册红线规定 refine 由用户触发——以本手册为准。无人值守、无法 ask-questions 时：记录"【待问询】<问题>"，取**保守分支**（更安全方向）继续或停在诊断点，并在终态汇报中列示。

## Step 0 — 环境探测与入口门禁

> **本 Step 的判定一律由 `scripts/gate.py` 给出，不靠模型自觉。** 它一次完成：CLI 版本能力判定、流程探测、任务进度**自解析**、会话类型判定、制品前置校验、台账盘点。模型的职责是按其输出播报与执行分支，不是自己重算。

**0.1 运行门禁**（`<skills-root>` = 本技能目录的父级）：

```bash
python3 <skills-root>/sdd-development-workflow/scripts/gate.py \
  --change <name> --workspace . --text
```

change 名的来源：用户指定 → 直接用；未指定 → `openspec list --json` 按 lastModified 推荐；歧义 → ask-questions 让用户选。`list` 在未初始化工作区会返回**人类可读错误而非 JSON**——以原文为证据，按"失败与降级"表的空工作区分支处理。

**0.2 消费门禁输出**：

| `decision` | 行为 |
|---|---|
| `GO` | 按 `mode` 进入 Step 1（aispec）或 Step 2（轻量）。`session_kind=resume` 时**必须先执行 Step 0.3 台账保全** |
| `VERIFY-ONLY` | 全部任务已勾选：**禁止进入任何 apply 技能**（否则 ai-apply Phase 1.2 会清空上一轮台账），直接跳到本模式的 verify |
| `NO-GO` | 按 `blocking` 停：制品校验 ERROR / tasks 缺失 / CLI state=blocked → 一律按左边界退回上游（轻量建议 `openspec-continue-change`，aispec 退回开发设计分身），**本分身不补写、不改制品** |

播报格式：`Using change: <name>（模式：<mode>；会话：<session_kind>；CLI <version>）`，并附 `mode_evidence` 与全部 `warnings`。

**0.3 续作台账保全**（仅 `session_kind=resume` 且 `mode` 为 aispec 时；轻量模式无台账，跳过）：

委托 ai-apply-change **之前**必须执行，否则其 Phase 1.2 的清空会让历轮台账离线：

```bash
python3 <skills-root>/sdd-development-workflow/scripts/ledger.py \
  snapshot --change <name> --workspace .
```

**0.4 版本能力约束**（门禁的 `capabilities` 字段）：

- `trust_cli_progress=false`（CLI < 1.8.0）：**不得**用 CLI 的 `progress` / `state=all_done` 作为完成判据——该版本不计入缩进子任务，会把未做完的子任务判成全完成。一律以门禁的 `parsed_progress` 为准，并在汇报中声明。
- `operation_guidance=false`（CLI < 1.7.0）：`instructions apply` 返回体无 `operationGuidance`，Step 2 中相关指令不适用，不得臆造。
- `store=false`（CLI < 1.5.0）：store 场景不支持，遇到即停并上报。

**0.5 探测细则与仲裁**：见 `references/flow-detection.md`（模式冲突、子模式解析、`_shared` 缺失降级）。门禁已实现其判定逻辑；该文件仅在需要解释证据或处理冲突时加载。

## Step 1 — aispec 模式（重流程）

1.1 **委托 `ai-apply-change`**：完整读取其 SKILL.md 并进入其执行流程（它自行完成 direct/playbook 路由、artifact 备份、rules.apply 注入、上下文最小加载、契约门禁、单任务循环、台账、占位扫描；direct 子模式止于 Phase 7 refine 同意门，playbook 子模式止于 Step 6 产物交付）。本分身只做外层监督：确认其按 Phase 推进、不越左边界（不补 tasks）、终态汇报材料齐全；其内部推荐选项与本手册冲突时按设计原则 7 仲裁。**编码开始前按人设完成一次技术栈识别**：匹配到私有技术栈则加载对应技能，没有或未匹配到则跳过、正常走流程。

**续作会话（`session_kind=resume`）的额外动作**：Step 0.3 已保全台账；ai-apply 产出后、进入 1.2 之前执行合流，把台账从"轮次级"恢复为"change 级累积"：

```bash
python3 <skills-root>/sdd-development-workflow/scripts/ledger.py merge --change <name> --workspace .
python3 <skills-root>/ai-apply-change/scripts/collect_changed_files.py --change <name> --workspace .
```

合流脚本 exit=1 表示存在"历轮登记但磁盘已不存在"的路径（被删除或改名）——按其 `needs_attention` 在 apply-report 说明后从清单剔除，不得静默忽略。

1.2 **自动执行 `ai-verify-change`**：ai-apply 终态（完成或 BLOCKED 后用户决策继续）后立即执行，不需要用户再次触发。消费其 archive 准入判定（CRITICAL / WARNING / SUGGESTION 分级）。verify 是只读体检，报告不落盘时在终态汇报中原样转述。

**触发前先采集客观变更集**（补 E4 的输入盲区）：ai-verify 的 E4「Tasks → Code」输入来自 E1，而 E1 在 GitNexus 不可用时会被整体跳过——那是缺省常态。分身在触发 verify 前自行采集只读 git 事实并显式声明为"E1 降级时的替代变更集"：

```bash
git status --porcelain ; git diff --stat        # 工作区根与各 repositories[].path 分别执行
```

声明时必须标注"**该变更集不按 change 切分，可能含无关脏文件或其他并行 change 的改动**"，避免给 Tasks→Code 制造假阳性匹配。只读 git 不违反红线（红线只禁 `git commit`，且 ai-verify 的 E3 已有同类先例）。

1.3 verify 报 **CRITICAL** → 汇报 + 建议 `ai-refine-change`（用户决策）。

1.4 **台账核对**：不再手工比对，改跑被委托技能自带的确定性校验（外层再跑一次它自己的脚本，属 Wrapper 姿态，不改任何文件）：

```bash
python3 <skills-root>/ai-apply-change/scripts/validate_phase6_artifacts.py \
  --change <name> --workspace . --expect-source-code    # 本轮无源码变更时去掉该 flag
```

`--expect-source-code` 是 direct-workflow Phase 6 调用命令里**漏传**的开关，它才会检查"written-files.txt 非空"与"changed-files/ 非空"。判读规则：

- exit=0 → 记录 OK。
- exit=2 且**全部**错误均为 `non-source file in changed-files`，同时 `project-profile.yaml` 的 `repositories[].path` 带 `./` 前缀 → 判为已知脚本缺陷（`load_code_repo_roots` 对 `./app` 取首段得 `.`），按"被委托技能的校验脚本误报"条款人工核验后记录降级，**不热修脚本**。
- 其余 exit≠0 → 按真实失败上报。

脚本不做、仍需分身自己做的只有一条**跨文件交叉核对**：`written-files.txt` 为空时，必须与 apply-report 的 `no source code changes` 记录互证。

## Step 2 — 官方轻量模式（纯官方契约）

完整执行契约见 `references/official-apply-workflow.md`。要点：

2.1 `openspec status --change <name> --json` → `openspec instructions apply --change <name> --json`；读返回的 `contextFiles`（proposal / specs / design / tasks 中实际存在者——design.md 是条件性 artifact，缺失属正常，优雅降级）；若返回含 `operationGuidance`（官方 `operations.apply.guidance` 通道）→ 读入并在实现中遵守（advisory，冲突时保留控制方并上报）。

2.2 展示进度（total / complete / remaining）。

2.3 **逐任务循环**：进入 `openspec-apply-change` 技能的执行流程——展示当前任务 → 最小化、聚焦实现 → **立即**把 `- [ ]` 改 `- [x]` → 下一任务。暂停条件：任务含糊 / 实现暴露设计问题（建议更新 artifact）/ 需要超出 spec 的工作（上报而非吸收）/ 遇错 / 用户打断。**编码开始前按人设完成一次技术栈识别**：匹配到私有技术栈则加载对应技能，没有或未匹配到则跳过、正常走流程。

2.4 **verify 触发规则**（统一口径，见 A3）：**正常完成**（全部任务勾选、无暂停）→ 立即自动执行 `openspec-verify-change`，无需用户确认；**异常暂停**（遇错 / 任务含糊 / 范围上报 / 用户打断）→ **不跑 verify**，输出暂停原因并等待用户，用户确认收尾后再自动执行。verify 三维度：Completeness 复选框+spec 覆盖 / Correctness 需求→代码+场景含测试 / Coherence design 遵循+代码模式（无 design.md 时跳过 design 一致性检查并注明）。

2.5 停在归档建议：`openspec-archive-change` 由用户触发。

2.6 轻量模式**不做**的事：备份、rules.apply 注入、契约门禁、.ai-sdd 台账、待确认项阈值、证据注释（`<!-- done: ... -->` 为 aispec 专属，轻量模式只做干净的 `- [x]`）。保留的通用纪律：诚实勾选、最小实现、范围上报、终态汇报。

## Step 3 — 终态汇报（统一格式）

```
【开发分身终态汇报】
- 模式：<aispec-direct | aispec-playbook | 官方轻量>（探测证据：…）
- Change：<name>　进度：<complete>/<total>（本次完成：N.M、N.M …）
- 实现摘要：<改动文件/功能点>
- 验证结论：<verify 维度结果；CRITICAL 项列表；archive 准入判定>
- 人工事项：<待人工确认/配置事项（aispec 模式含 CFG-* 配置项）/ 暂停原因>
- 下一步建议（均需你确认触发）：<refine | archive | e2e | harvest | 无>
```

## 硬约束与红线

- **不可逆动作同意门（模式无关，两种模式均生效）**：任务实现过程中一旦要触发下列动作，**先 ask-questions 取得用户同意**；无人值守时按设计原则 7 取保守分支——保持该任务 `- [ ]`、登记人工事项、继续其余任务：
  - (a) 对数据库或外部系统的**写操作**，含执行任何 `.sql` / migration / seed 脚本；
  - (b) 改写 git 历史，或改动工作区之外的状态；
  - (c) 写入依赖锁文件的安装 / 升级（`npm i`、`mvn`、`pip install` 等改动 lockfile 的调用）。

  该门的来源是分身对"不可逆"的自身判断，**不属于 aispec 台账增强**，因此不受"轻量流程零增强"约束——轻量模式同样生效。维护者请勿按"轻量=删干净"把它删掉（aispec 侧的同类门写在 ai-apply direct Phase 4.1，轻量侧只有这一道）。
- **历史隔离**：禁读 `.ai-sdd/changes/` 与任何旧 apply artifacts 作为**实现依据或代码模式来源**。**显式豁免**：本 change 当前及历轮的 `written-files.txt`、`tasks.md` 复选框、`<change>.carryover/` 目录可作为**进度与幂等事实**读取——盘点做到哪不是"实现依据"，恢复通道不得被红线误锁。
- **不主动 `git commit`**；只读 git（`status --porcelain` / `diff --stat` / `log`）允许且被 Step 1.2 依赖。不调用任何 `aispec` 命令。
- **绝不手改 `openspec-*` 技能文件**；对官方与 ai-* 技能一律包裹调用。
- **进度事实源**：以 `gate.py` 的 `parsed_progress` 为准；CLI < 1.8.0 时**不得**信任 `progress` / `state=all_done`。
- **勾选诚实性**：部分完成 / 被推迟 / 被跳过的任务保持 `- [ ]`。
- **任务体子行不得使用复选框**（新版解析器会计为独立任务；旧版则会漏计——两个方向都出错）。

## 长任务重锚（context re-anchoring）

规则写在文档里只在会话开头生效一次；27–90 任务的 change 必然经历上下文压缩，压缩后最先蒸发的恰是最高频、最无本地锚点的纪律（台账追加 → 勾选诚实性 → 历史隔离 → 范围上报）。因此：

- **每完成 5 个任务**，或**任何一次上下文压缩 / 会话恢复之后**，必须重读本文件的「定位与边界」「硬约束与红线」两节，并在输出中打一行 `[REANCHOR] 已重读红线，进度 N/M`。
- 重锚时同步重跑一次 `gate.py`（它会重新给出 `session_kind` 与 `parsed_progress`），用返回值校正自己对进度的记忆——**不要凭印象续作**。
- 若重锚发现进度与记忆不符（例如自己以为做到第 20 个、实际勾选只有 12 个），以磁盘为准并在终态汇报中列明差异。

## 失败与降级

| 情形 | 行为 |
|---|---|
| `openspec` CLI 不可用 | 中止 + 安装指引 |
| CLI 版本低于能力下限 | 见 Step 0.4：`<1.8.0` 不信任 CLI 进度（用 gate.py 自解析）、`<1.7.0` 无 operationGuidance、`<1.5.0` 不支持 store。一律在汇报中声明降级 |
| **空工作区 / 工程未初始化**（无 openspec/、无 change 可选） | 探测结论拆两层表述：信号基线（全信号缺失 → 官方轻量基线）+ 前置失败（工程未初始化，初始化后仍需重新探测）。输出三选一诊断（init / 换工作区根 / 上游分身产出 change），**零写入**，停在诊断点 |
| **备份因同分钟重跑而失败**（`backup already exists`，exit=2） | `create_backup.py` 的时间戳是分钟粒度且 `target.exists()` 即返回 2，而 direct/playbook 都规定"备份失败立即停止"——崩溃后立刻重启会撞上这个 60 秒窗口。改传该脚本既有的 `--timestamp <唯一值>` 参数重试；仍失败才按硬失败停 |
| aispec 模式但 `.ai-sdd/` 骨架缺失（profile 有、上下文无） | 如实输出缺口清单（context-index / code-patterns / 相关模板），按 ai-apply-change 自身的降级路径执行或阻塞，**不臆造缺失资产** |
| **环境级故障 vs 业务错误的仲裁** | 验收命令/工具链本身不可用（fixture、跨平台脚本缺陷等环境级故障）：透明上报 + **最小等价修复**继续 + 登记待追认（记入台账/人工事项），不静默吸收也不卡死。**"最小等价修复"的对象只限验收手段，严禁用于产品代码**（不得手写替身实现、桩、或注释掉依赖）。业务实现类错误（代码逻辑错、测试断言失败）：必须暂停上报，不得带病继续。**若故障源是被委托技能自带的脚本，按下行（不热修技能脚本）为准** |
| **第三类：存在性 / 可达性不可假设** | 依赖装不上、测试环境起不来、上游接口未就绪、外部系统不可达——既非环境级也非业务错误。统一处理：该任务**保持 `- [ ]`** 并登记联调点/人工事项，跳到下一个不依赖它的任务；剩余任务全部依赖它时停并上报。严禁把"跑不了"记成"通过" |
| 被委托技能的校验脚本误报（如 validate 脚本对 './' 前缀路径解析缺陷） | 复现并定位根因；确属脚本缺陷 → 不热修技能脚本，人工核验产物后在 apply-report / review-notes（aispec 模式）或终态汇报/人工事项（轻量模式）如实记录降级 |
| 非 spec-driven 自定义 schema | 以 `instructions` 返回的 contextFiles / apply.tracks 为准（schema 无关姿态）；D-*/contracts 语义仅在 spec-driven + aispec profile 下作为增强层 |
| verify 技能不可用 | 以 `openspec validate <change> --strict --json` 最低限度替代并声明降级 |

## 引用

**脚本（确定性检查，优先于散文）**
- `scripts/triage.py` — 任务分诊的路径级否决（**只能否决直修、不能批准直修**；由人设分诊调用，本手册流程内不使用）
- `scripts/gate.py` — Step 0 入口门禁：版本能力、流程探测、进度自解析、会话类型、制品校验、台账盘点
- `scripts/ledger.py` — 续作台账保全与跨轮合流（`snapshot` / `merge` / `status`）

**参考文档（按需加载，非常驻）**
- `references/flow-detection.md` — 探测证据与冲突仲裁（仅在需要解释证据或处理模式冲突时加载）
- `references/official-apply-workflow.md` — 官方轻量模式完整执行契约（仅轻量模式加载）
- `references/orchestration-boundaries.md` — 分身 ↔ 技能 ↔ 相邻分身职责边界（仅在职责冲突或交接时加载）
