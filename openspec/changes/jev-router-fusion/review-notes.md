# JevRouter (jev-router-fusion) — Apply Review Notes

## 已确认用户决策（本次会话）

| # | 决策 | 用户选择 | 备注 |
|---|---|---|---|
| 1 | openspec 结构处理 | 迁到标准 change 目录 | 已完成：4 个文件 + .openspec.yaml + README + review-notes 迁到 `D:\TREAWork\JevOmniRouter\openspec\changes\jev-router-fusion\`（JevOmniRouter 子工作区） |
| 2 | 评审状态与 C7 门禁 | 评审已过，越过 C7 编码 | proposal 状态仍为 Draft；用户明示已过评，越过 spec.md C7 与 tasks.md §0 评审冻结门禁 |
| 3 | 本次交付范围 | 只做阶段 2 纯逻辑层（T-2.1 ~ T-2.10） | 91 任务中只勾选 10 个；其余 81 任务保持 `- [ ]` |
| 4 | 技术形态 | Node.js + TypeScript + Vue 3 | 与 design.md L65 "单个自包含 HTML、无后端" 表述不一致；用户选择以分离工程形态实现，需在 design 偏差登记中记录 |
| 5 | 模式仲裁 | 为 jev-router 单独建 aispec 工作区 | 已新建 `D:\TREAWork\JevOmniRouter\project-profile.yaml` 与 `openspec/config.yaml`；JevOmniRouter 现为独立 openspec 根；不再受父 NCOM 工作区污染 |
| 6 | 阶段标签中文化 | 从英文改为"提交/评分/执行/回流" | 原英文标签与阶段映射本身不一致，中文更贴近 `JEV-11` 展示契约 |
| 7 | 3D 主链节点命名 | "Prompt输入 → Jev智能路由中枢 → 候选模型分支 → 决策库" | 与决策契约、`JEV-11` 展示契约语义对齐；同步更新 `spec.md` [TREE-1]/[TREE-2] 与 `design.md` §7.1/§7.2/§7.4 |
| 8 | 双路径视觉系统 | 实线管路（数据流）+ 虚线逻辑路径（Prompt→中枢、候选模型→决策库） | 使用 `LineDashedMaterial` 视觉区分；虚线数量随 `candidateCount` 联动（1+N 条），满足 [TREE-2] 场景 3「动态数量」 |

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

### D-Apply-3：3D 主链节点命名语义化

- **原表述**：Prompt → Jev 中枢 → 模型分支 → 知识库（`spec.md` [TREE-1]、`design.md` §7.1 / §7.2）
- **用户决策**：中心节点命名为"Jev智能路由中枢"；末端命名为"决策库"；上游命名为"Prompt输入"；中间层为"候选模型分支"
- **理由**：与决策契约 §5 术语、`JEV-11` 展示契约语义对齐；避免"知识库"与"决策库"混淆（决策库是路由结果聚合与经验闭环入口，知识库是外部召回服务）
- **处置**：同步更新 `spec.md` [TREE-1]、[TREE-2]；`design.md` §7.1 / §7.2 / §7.4；不改代码逻辑，仅改视觉与文档表述

### D-Apply-4：3D 双路径视觉系统（实线管路 + 虚线逻辑路径）

- **背景**：原 `TreeScene.ts` 只有实线管路（`TubeGeometry` 数据流），6 个候选模型到决策库没有直接连接，语义上"每个模型向决策库回流经验"这一关系在视觉中不可见
- **用户决策**：Prompt输入→中枢、候选模型→决策库 之间增加虚线连接，与实线管路视觉区分
- **实现**：使用 `THREE.LineDashedMaterial` + `THREE.Line` + `BufferGeometry.setFromPoints()` + `computeLineDistances()`
  - **1 条 Prompt输入→中枢** 直线虚线（蓝色 `#4ea1ff`，dashSize=0.24 / gapSize=0.16 / opacity 动态）
  - **6 条 候选模型→决策库** 贝塞尔弧虚线（按模型颜色，dashSize=0.28 / gapSize=0.20 / opacity 动态；Z 轴 +0.7 前移避开实线管路）
  - `AdditiveBlending` + `depthWrite: false` 与实线管路视觉可区分
- **动画联动**：Prompt→中枢 虚线由 `run.edgeFlow[0]`（ingest 阶段）驱动；候选模型→决策库 虚线由 `run.edgeFlow[candIdx+1+candidateCount]`（execute/return 阶段）驱动；胜出边在 select+return 阶段额外增强
- **动态数量契约**：虚线数量 = 1 + candidateCount，与 [TREE-2] 场景 3「动态数量」保持一致
- **契约同步**：`spec.md` [TREE-2] 新增"虚线逻辑路径"段落与 Scenario；`design.md` §7.1 增加"双路径系统"表格；§7.2 增加节点命名表

### D-Apply-5：3D 树节点视觉升级（球体 + 线框壳 + 状态环）

- **原形态**：圆角矩形面板节点（`RoundedBoxGeometry`）+ 平面文字
- **升级形态**：`SphereGeometry` 球体节点 + 半透明线框壳 + 3 条状态发光环 + 发光 Sprite
  - 中枢新增 JEV CORE 球体 + 12 条问题轨道环（Q1–Q12）+ 呼吸内核 + 线框壳
  - 数据包由小球 + 发光 Sprite + 拖尾 `InstancedMesh`（16 段）承载
  - 6 段粒子流动沿边曲线推进
  - 输入门 / 输出门各设一道圆环标识
- **场景氛围**：星尘背景（3000 颗）+ 网格地面 + 雾效 + Ambient + Directional 光照
- **理由**：与"3D 主链可视化"的立体感、空间感更契合；球体节点在旋转视角下无平面文字裁切问题；线框壳 + 发光环承载状态信息（score/selected/active）
- **未变更契约**：本次仅视觉升级，不改需求号、不改阶段映射、不改数据包路径；契约仍归 `spec.md` [TREE-1] [TREE-2] [TREE-3] [TREE-4]

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
- 后续动作：跑 gate.py（workspace=JevOmniRouter） → openspec instructions apply → 委托 ai-apply-change direct workflow → 实现阶段 2 任务
