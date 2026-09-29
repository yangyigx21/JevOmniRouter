# Apply Artifacts Template

在 `ai-apply-change` 的 playbook 模式 Step 6 中读取本模板。

## Output Directory

```text
.ai-sdd/artifacts/changes/{change-name}-{YYYY-MM-DD-HH-MM}.zip   ← Step 1 备份旧目录生成
.ai-sdd/artifacts/changes/{change-name}/
  changed-files/          ← Step 6 步骤 2 由脚本填充
  changed-files.md        ← Step 6 步骤 2 由脚本生成
  apply-report.md         ← Step 6 步骤 1 按模板填充
  coding-assumptions.md   ← Step 4/5 写入，Step 6 不覆盖
  human-config-checklist.md ← Step 4 写入，Step 6 如缺则按模板新建
  review-notes.md         ← Step 5 写入，Step 6 不覆盖
  apply-context-pack.md   ← Step 4.1 写入（仅复杂变更）
  sql/                    ← Step 4 DDL 写入（按 paths.ddl_directory）
  test-sources/{repo}/    ← Step 4 测试源码（按 paths.test_source_directory）
  runners/{repo}/         ← Step 4 测试 runner（按 paths.test_runner_directory）
  reports/{repo}/         ← Step 5 测试报告（按 paths.test_report_directory）
  test-cases/{repo}/      ← Step 4 用例清单（按 paths.test_cases_directory）
  e2e/                    ← Step 4 E2E 用例（按 paths.e2e_directory）
```

备份 zip 在 **Step 1** 写入前创建，而不是 Step 6；Step 6 只写入已经准备好的空目录。

## `changed-files.md`

Generate this with `collect_changed_files.py`. The file must include the actual archive directory:
`changed-files/` only contains source files added, modified, or renamed by the current coding task. Generated SDD/OpenSpec artifacts, backups, reports, runners, historical artifacts, and other non-source files must appear only as omitted candidates.

```markdown
# 变更文件清单：{change-name}

- 生成时间：{YYYY-MM-DD HH:mm}
- 来源：runner-session | explicit-list | git-status | mixed
- 变更文件归档目录：`.ai-sdd/artifacts/changes/{change-name}/changed-files/`
- 归档口径：仅本次编码任务新增/修改/重命名后的源代码文件；`.ai-sdd/`、`openspec/`、报告、备份、runner、历史 artifacts 等不归档。

## 汇总
| 状态 | 数量 |
|---|---:|
| added | {N} |
| modified | {N} |
| renamed | {N} |

## 文件列表
| 状态 | 文件路径 | 归档副本 | 来源/原因 |
|---|---|---|---|
| modified | `{repo/path}` | `changed-files/{repo/path}` | {task/Trace/source} |

## 按层次汇总
| 层次 | 模块/仓库 | 状态 | 文件路径 | 任务/Trace |
|---|---|---|---|---|
| `<layer_alias>` | `<repo_name>` | modified | `{path}` | task {N.n} / {D-*} |

## 未归档候选文件
| 文件路径 | 原因 |
|---|---|
| {path} | {reason} |
```

## `apply-report.md`

```markdown
# 编码执行报告：{change-name}

## 范围
- 变更：{change-name}
- 模式：serial | parallel
- 执行时间：{YYYY-MM-DD HH:mm}
- artifact root：`.ai-sdd/artifacts/changes/{change-name}/`

## 产物索引
| 产物 | 路径 | 用途 |
|---|---|---|
| changed-files | `changed-files.md` / `changed-files/` | 变更清单与文件快照 |
| apply-report | `apply-report.md` | review 入口 |
| coding assumptions | `coding-assumptions.md` | 编码假设与待确认事实 |
| human config checklist | `human-config-checklist.md` | 人工配置、联调和生产动作 |
| review notes | `review-notes.md` | Trace、偏差、GitNexus、验证记录 |
| artifact backup | `../{change-name}-{YYYY-MM-DD-HH-MM}.zip` 或 `not-needed` | 生成本轮 artifacts 前的历史快照 |

## 任务结果
| 状态 | 数量 | 说明 |
|---|---:|---|
| completed | {N} | {summary} |
| skipped_by_user | {N} | {summary} |
| blocked | {N} | {summary} |

## Implementation Context 摘要
| Task group | Design refs | Playbooks | Code patterns | Source/GitNexus checks |
|---|---|---|---|---|
| {repo/layer/scenario} | {D-*} | {paths | none} | {paths | none} | {checks | not-needed} |

## 按层次的代码清单
| 层次 | 模块/仓库 | 状态 | 文件 | 关键符号/入口 | 任务/Trace | Review 重点 |
|---|---|---|---|---|---|---|
| {layer} | {repo} | {status} | `{path}` | `{symbol}` | task {N.n} / {D-*} | {risk focus} |

## 编码假设摘要
- 文件：`coding-assumptions.md`
- total：{N}
- pending human validation：{N}

## 人类配置摘要
- 文件：`human-config-checklist.md`
- pending：{N}
- done/not-needed：{N}

## 验证结果
| 命令/检查项 | 结果 | 备注 |
|---|---|---|
| `{command}` | pass | {notes} |

## 备份记录
| 类型 | 路径/状态 | 备注 |
|---|---|---|
| workspace | `backup-{YYYY-MM-DD-HH-MM}.zip` / skipped_by_user / not-run | Step 0 源代码备份 |
| artifact | `.ai-sdd/artifacts/changes/{change-name}-{YYYY-MM-DD-HH-MM}.zip` / not-needed | Step 1 生成 artifacts 前备份 |

## Review 与修复门禁结果
| 门禁 | 初检 | 修复动作 | 复检 | 证据 |
|---|---|---|---|---|
| 无跨中心直接 import 对方业务包 | pass/fail | `{fix or n/a}` | pass/fail/blocked | `{scan command or file refs}` |
| 跨中心仅 CSF 或 design 明确数据层互访 | pass/fail | `{fix or n/a}` | pass/fail/blocked | `{design refs + call path}` |
| serviceCode/API 契约逐字段核实 | pass/fail | `{fix or n/a}` | pass/fail/blocked | `{target CSV/class/method + 入参字段 + 返回结构}` |
| 项目模式业务方接入骨架 | pass/fail/not-applicable | `{fix or n/a}` | pass/fail/blocked | `{code-pattern refs + files}` |
| OUTBOUND 外部协议契约 diff | pass/fail/not-applicable | `{fix or n/a}` | pass/fail/blocked | `{api-catalog/contracts §2.1 + 字段 diff}` |
| INBOUND 入站协议契约 diff | pass/fail/not-applicable | `{fix or n/a}` | pass/fail/blocked | `{外部规范来源/contracts §2.2 + KEY 一致性确认}` |
| SV 层仅经 DAO/BO 访问数据 | pass/fail | `{fix or n/a}` | pass/fail/blocked | `{files/symbols}` |
| import 规范（文件头、无 `*`、无 unused） | pass/fail | `{fix or n/a}` | pass/fail/blocked | `{lint/scan output}` |
| 硬编码治理（关键编码常量化/配置化） | pass/fail | `{fix or n/a}` | pass/fail/blocked | `{constants/config/review-notes}` |

## GitNexus
| Repo | Impact | detect_changes | 备注 |
|---|---|---|---|
| {repo} | {risk/not-applicable} | {result/not-applicable} | {notes} |
```

Layer labels:

| 层次 | 典型文件/任务 |
|---|---|
| DB/DDL | SQL、表、字段、索引、初始化数据 |
| Entity/BO/IValue | BO, Bean, IValue, DTO, VO |
| DAO/Repository | DAO、Mapper、Engine 持久化/查询方法 |
| BSV-Service | BSV/SV/ServiceImpl 编排 |
| BSV-Task/ET | 后台组件、异步任务/扫描（按项目实际框架，如 ET/TF/xxl-job/quartz 等） |
| BSV-CSF/API | BSV 对外接口、CSF 适配、API 注册代码 |
| PSV-Service | PSV 页面服务聚合 |
| PSV-CSF/API | PSV 对外接口和 serviceCode 适配 |
| Frontend-Route | 路由、菜单、入口注册 |
| Frontend-API | 前端 API client、SDK wrapper |
| Frontend-Component | 页面、组件、状态、交互 |
| Test/Runner/Report | 测试、runner、用例、报告 |
| OpenSpec/Artifact | tasks、review notes、contracts、change artifacts |
| Manual-Config | 人工网关、CSF、ET、模板、MQ、DB 执行 |

## `coding-assumptions.md`

```markdown
# 编码假设：{change-name}

## 说明

当参数、编码、枚举、报文格式、配置项或外部配置需要人类确认但当前环境无法直接确认时，先基于 design/contracts、现有代码、配置样例和代码模式做环境假设并完成编码。本文件记录所有假设，供人类确认或后续修正。

## 汇总
| 状态 | 数量 |
|---|---:|
| pending-human-validation | {N} |
| validated | {N} |
| replaced | {N} |
| not-needed | {N} |

## 假设列表
| ID | 类型 | 任务/Trace | 未知项 | 环境依据 | 假设值/格式 | 影响文件 | 验证方式 | 状态 |
|---|---|---|---|---|---|---|---|---|
| ASM-001 | enum/config/message/serviceCode/field | task {N.n} / {D-*} | {unknown} | {evidence paths} | `{assumed value}` | `{paths}` | {how human/system validates} | pending-human-validation |

## 调整指引
| ID | 如果假设不成立 | 需要修改 |
|---|---|---|
| ASM-001 | {condition} | `{file}` 中 {constant/mapping/method/config} |
```

If there are no assumptions, still create the file and write:

```markdown
## 假设列表
| ID | 类型 | 任务/Trace | 未知项 | 环境依据 | 假设值/格式 | 影响文件 | 验证方式 | 状态 |
|---|---|---|---|---|---|---|---|---|
| none | none | - | - | - | - | - | - | not-needed |
```

## `human-config-checklist.md`

```markdown
# 人类配置清单：{change-name}

## 汇总
| 状态 | 数量 |
|---|---:|
| pending | {N} |
| done | {N} |
| not-needed | {N} |

## 配置与联调动作
| ID | 类型 | 配置项/动作 | 负责人 | 来源任务/Trace | 必填值/操作 | 依赖假设 | 验证方式 | 状态 |
|---|---|---|---|---|---|---|---|---|
| CFG-001 | CSF/serviceCode/ET/MQ/SMS/SQL/open/billing/gateway | {item} | manual | task {N.n} / {D-*} | {value/action} | ASM-001 | {validation} | pending |

## 联调顺序
| 顺序 | 动作 | 前置条件 | 期望结果 |
|---:|---|---|---|
| 1 | {action} | {precondition} | {result} |
```

If there is no human configuration, still create the file and write:

```markdown
## 配置与联调动作
| ID | 类型 | 配置项/动作 | 负责人 | 来源任务/Trace | 必填值/操作 | 依赖假设 | 验证方式 | 状态 |
|---|---|---|---|---|---|---|---|---|
| none | none | none | - | - | - | - | - | not-needed |
```

## Rules

- Every added, modified, deleted, or renamed code/config/test/artifact file must appear in `按层次的代码清单`.
- `changed-files/` must contain only source files under configured code repositories. Do not copy `.ai-sdd/`, `openspec/`, backup zips, reports, runners, SQL artifacts, or historical artifacts into `changed-files/`.
- `changed-files.md`, `apply-report.md`, `coding-assumptions.md`, `human-config-checklist.md`, and `review-notes.md` are mandatory. If no source files changed, still generate `changed-files.md` with an empty source-file list and record `changed-files: no source code changes` in `apply-report.md`.
- Run `<skills-root>/ai-apply-change/scripts/validate_phase6_artifacts.py` before final output. Use `--expect-source-code` when this apply changed source files.
- `apply-report.md` should summarize assumptions and human config; detailed rows live in the two independent files.
- `apply-report.md` must include `Review 与修复门禁结果` and each gate result must be auditable.
- Every unknown fact used in code must have an `ASM-*` row.
- Every manual production/configuration action must have a `CFG-*` row.
- `ASM-*` and `CFG-*` IDs must be stable across subsequent updates.
- `apply-report.md` must record the Step 0 workspace backup decision and the Step 1 artifact backup result.
