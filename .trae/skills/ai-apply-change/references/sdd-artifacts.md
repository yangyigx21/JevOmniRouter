# SDD 产物

当 AI SDD 技能创建或汇总实现产物时，使用本共享说明。

## 路径规则

产物位置优先使用 `project-profile.yaml -> paths.*`。仅当 profile 未配置路径时，才使用以下默认值：

```text
.ai-sdd/artifacts/changes/{change-name}/
.ai-sdd/artifacts/changes/{change-name}/sql/
.ai-sdd/artifacts/changes/{change-name}/test-sources/{repo}/
.ai-sdd/artifacts/changes/{change-name}/test-cases/{repo}/
.ai-sdd/artifacts/changes/{change-name}/test-data/{repo}/
.ai-sdd/artifacts/changes/{change-name}/runners/{repo}/
.ai-sdd/artifacts/changes/{change-name}/reports/{repo}/
.ai-sdd/artifacts/changes/{change-name}/e2e/
```

## Apply 产物

playbook 模式使用 v2 产物布局：

- `changed-files/`
- `changed-files.md`
- `apply-report.md`
- `coding-assumptions.md`
- `human-config-checklist.md`
- `review-notes.md`
- 源码发生变更时使用 `written-files.txt`

只有配置的代码仓库下的源码文件可以复制进 `changed-files/`。报告、备份、SQL、runner、OpenSpec 文件和 `.ai-sdd/` 产物不得进入 `changed-files/`。
