---
name: ai-apply-change
description: "AI 增强的 apply 统一入口：运行时读取 project-profile.yaml 的 sdd.design-mode；direct/default 使用 references/direct-workflow.md 流程，playbook 使用 references/playbook-workflow.md 流程。用于 'apply change'、'开始编码'、'实现任务'、'ai apply'、'基于设计手册编码' 等场景。"
version: 2.0.0
updated: 2026-06-15

---
# AI Apply Change

Apply 阶段统一入口。编码前完成 change 选择、前置校验、规则注入和上下文加载；编码后生成 apply artifacts。

## 运行时模式路由

本技能是 Apply 阶段统一入口。开始执行前必须先读取 `_shared/sdd-profile-runtime.md`，再读取 `project-profile.yaml`，解析 `sdd.design-mode`：

- `direct`（默认）：加载并严格执行 `references/direct-workflow.md`。
- `playbook`：加载并严格执行 `references/playbook-workflow.md`。
- 兼容值：`legacy` 视为 `direct`；`v2` 视为 `playbook`。非法或缺失值降级为 `direct`，并在输出中说明。

无论使用哪个 mode，凡涉及 repo、scope、GitNexus 名称、artifact 路径、后端分层、前端 source root、工具可用性和 context 覆盖路径，必须运行时从 `project-profile.yaml`、`AGENTS.md` 和当前工作区真实目录解析。

按需加载：

- `_shared/sdd-change-gate.md`：change 选择或前置校验。
- `_shared/sdd-context-loading.md`：上下文加载。
- `references/sdd-artifacts.md`：artifact 约束。

阶段结束时必须输出实际使用的 `design-mode`。具体编码检查项以项目 `.ai-sdd/context/sdd/编码实现检查清单（apply-checklist）.md` 为准；本 skill 只定义执行流程和强制加载点。

---

## 触发方式

- "ai apply"
- "开始编码"
- "实现任务"
- `/ai-apply-change [change-name] [补充指令...]`

---

## 输入参数

| 参数        | 必填 | 说明                                                                                          |
| ----------- | ---- | --------------------------------------------------------------------------------------------- |
| change-name | 否   | 目标 change 名称；省略时自动列出让用户选择                                                    |
| 补充指令    | 否   | 追加给编码阶段的额外约束（如"暂不生成集成测试"、"只做后端任务"等），可自由描述               |
