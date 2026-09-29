# Direct Apply 产物模板

本模板供 `ai-apply-change` 在 `sdd.design-mode=direct` 时按需读取。路径优先来自 `project-profile.yaml -> paths.*`。

## changed-files.md

```markdown
# 变更文件清单：{change-name}

## 汇总
| 状态 | 数量 |
|---|---:|
| added | {N} |
| modified | {N} |
| deleted | {N} |

## 文件列表
| 状态 | 文件路径 | 归档副本 | 说明 |
|---|---|---|---|
| modified | `{repo/path}` | `changed-files/{repo/path}` | {任务/Trace} |
```

## apply-report.md

```markdown
# 编码执行报告：{change-name}

## 范围
- 变更：{change-name}
- 模式：direct
- artifact root：{artifact-root}

## 任务结果
| 状态 | 数量 | 说明 |
|---|---:|---|
| completed | {N} | {summary} |
| skipped_by_user | {N} | {summary} |
| blocked | {N} | {summary} |

## 按层次的代码清单
| 层次 | 模块/仓库 | 状态 | 文件 | Review 重点 |
|---|---|---|---|---|

## 代码 Review 入口
- 主业务入口
- 接口入口
- 页面入口
- 后台入口

## Review 与修复门禁结果
| 门禁 | 初检 | 修复动作 | 复检 | 证据 |
|---|---|---|---|---|
| serviceCode/API 契约逐字段核实 | pass/fail | `{fix or n/a}` | pass/fail/blocked | `{target CSV/class/method + 入参字段 + 返回结构}` |
| 项目模式业务方接入骨架 | pass/fail/not-applicable | `{fix or n/a}` | pass/fail/blocked | `{code-pattern refs + files}` |
| OUTBOUND 外部协议契约 diff | pass/fail/not-applicable | `{fix or n/a}` | pass/fail/blocked | `{api-catalog/contracts.md §2.1 + 字段 diff 结果}` |
| INBOUND 入站协议契约 diff | pass/fail/not-applicable | `{fix or n/a}` | pass/fail/blocked | `{外部规范来源/contracts.md §2.2 + KEY 一致性确认}` |
| apply-checklist 汇总复检 | pass/fail | `{fix or n/a}` | pass/fail/blocked | `{checklist refs}` |

## 需要人工配置
| 类型 | 动作 | 验证方式 | 状态 |
|---|---|---|---|

## 验证结果
| 命令/检查项 | 结果 | 备注 |
|---|---|---|
```
