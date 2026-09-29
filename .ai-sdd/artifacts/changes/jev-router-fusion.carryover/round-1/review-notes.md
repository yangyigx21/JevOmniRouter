# JevRouter (jev-router-fusion) — Apply Review Notes

## 已确认用户决策（本次会话）

| # | 决策 | 用户选择 | 备注 |
|---|---|---|---|
| 1 | openspec 结构处理 | 迁到标准 change 目录 | 已完成：4 个文件 + .openspec.yaml + README + review-notes 迁到 `D:\TREAWork\JevOmniRouter\openspec\changes\jev-router-fusion\`（JevOmniRouter 子工作区） |
| 2 | 评审状态与 C7 门禁 | 评审已过，越过 C7 编码 | proposal 状态仍为 Draft；用户明示已过评，越过 spec.md C7 与 tasks.md §0 评审冻结门禁 |
| 3 | 本次交付范围 | 只做阶段 2 纯逻辑层（T-2.1 ~ T-2.10） | 91 任务中只勾选 10 个；其余 81 任务保持 `- [ ]` |
| 4 | 技术形态 | Node.js + TypeScript + Vue 3 | 与 design.md L65 "单个自包含 HTML、无后端" 表述不一致；用户选择以分离工程形态实现，需在 design 偏差登记中记录 |
| 5 | 模式仲裁 | 为 jev-router 单独建 aispec 工作区 | 已新建 `D:\TREAWork\JevOmniRouter\project-profile.yaml` 与 `openspec/config.yaml`；JevOmniRouter 现为独立 openspec 根；不再受父 NCOM 工作区污染 |
| 6 | 依赖安装 | 允许 pnpm install + 类型检查 | 用户授权写入 pnpm-lock.yaml；已安装 typescript@5.9.3、vitest@1.6.1、@types/node@20.19.43、@vitest/coverage-v8@1.6.1；typecheck 0 错误 |
| 7 | 仓库路径调整 | repositories.path 从 "." 改为 "packages" | 为兼容 collect_changed_files.py 与 validate_phase6_artifacts.py 的源码识别；不影响 ai-apply-change scope 检测（基于 type 不基于 path） |

## 模式与设计偏差登记

### D-Apply-1：技术形态偏差

- **spec.md/design.md 原表述**：双形态 = 云原生（前后端分离）+ 离线（单文件自包含 HTML + LocalJevReimpl）
- **用户选定形态**：Node.js + TypeScript + Vue 3（前后端分离 monorepo）
- **影响**：离线单文件形态不在本次交付范围；降级形态后续若需，需另行设计
- **处置**：本次只实现阶段 2 纯逻辑层（不涉及形态差异），不影响验收；后续阶段若涉及 `ARCH-4` 离线单文件验收，需追加设计

### D-Apply-2：C7 评审门禁越过

- **spec.md C7**：本阶段 SHALL NOT 交付前后端代码实现，仅交付规范
- **tasks.md §0**：本阶段不交付前后端代码实现；评审通过后方可启动编码
- **用户决策**：评审已过，越过 C7 编码
- **处置**：阶段 0 评审任务（T-0.1~T-0.7）保持 `- [ ]` 不勾选；阶段 2 任务（T-2.1~T-2.10）按用户授权直接实现并勾选；阶段 1 断言基线任务不在本次范围（按 user override 跳过 TDD-first 的强约束，由阶段 2 自带的单元测试覆盖）

### D-Apply-3：repositories.path 调整

- **原值**：`repositories[0].path: "."`（仓库根 = 工作区根）
- **新值**：`repositories[0].path: "packages"`（仓库根 = packages 子目录）
- **原因**：collect_changed_files.py 的 `path_in_repo` 与 validate_phase6_artifacts.py 的 `is_source_snapshot` 均以 `path.startswith(root + "/")` 判定，`root="."` 对所有相对路径返回 False；改为 `packages` 后，`packages/shared/...` 路径可被识别为源码
- **副作用**：无；ai-apply-change 的 scope 检测基于 `type` 字段（fullstack → backend + frontend-vue3），不依赖 `path`

## 待问询 / 后续范围

### Q-1（已解决）：模式探测受父工作区污染

按用户决策 5 解决：建立独立 JevOmniRouter aispec 工作区。父 `D:\TREAWork\openspec\changes\jev-router-fusion\` 留有原始文件副本（未删，因 shell 无权操作父目录），不影响子工作区工作。

### Q-2：源码遗留副本

- `D:\TREAWork\openspec\changes\jev-router-fusion\` 仍存原始文件副本（7 个文件，含 .openspec.yaml、README.md、proposal.md、spec.md、design.md、tasks.md、review-notes.md）。
- 该副本对当前 SDD 流程无影响（openspec CLI 现以 JevOmniRouter 为根）。
- 建议用户后续手动删除：`Remove-Item D:\TREAWork\openspec\changes\jev-router-fusion -Recurse -Force`。

## 已采取的执行分支

- 模式：aispec-direct（JevOmniRouter 子工作区，project-profile.yaml 的 sdd.design-mode=direct）
- 代码工程根：`D:\TREAWork\JevOmniRouter`
- 工作区布局：monorepo，packages/shared（纯逻辑层）、packages/backend、packages/frontend
- Phase 5 单任务循环：T-2.1 ~ T-2.10 全部完成；TypeScript typecheck 0 错误
- Phase 6 产物：changed-files.md（16 个源文件归档）、apply-report.md、coding-assumptions.md、human-config-checklist.md、review-notes.md（本文件）
