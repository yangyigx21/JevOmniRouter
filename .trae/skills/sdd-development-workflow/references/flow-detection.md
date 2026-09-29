# 流程探测（flow-detection）

> 本文件是 `sdd-development-workflow` SKILL.md Step 0.3 的执行细则。原则：**只认文件证据，不臆测；结论必须显式声明**。

## 1. 探测信号与权重

| 权重 | 信号 | 判定证据 | 指向 |
|---|---|---|---|
| **重** | `project-profile.yaml`（工作区根） | 文件存在即 aispec 工作区；再读 `sdd.design-mode` 定子模式 | aispec |
| **重** | `.ai-sdd/context/context-index.yaml` | 文件存在 = 上下文生产线已初始化 | aispec（legacy，按 direct） |
| **重** | `openspec/config.yaml` → `rules` 含 `apply` 键 | `rules` 按 **artifact id** 键入；`apply` 在内置 spec-driven schema 中不是 artifact，因此该键只会触发 openspec 的 unknown-artifact **警告**（config 照常加载、validate 仍 valid）。这是 aispec 侧的**强佐证**，但不排除两种反例：①纯官方用户误配（官方模板里 `rules:` 与 `operations.apply.guidance:` 相邻，易写混）；②工程使用 project-local schema 且其中确有 id 为 `apply` 的 artifact——此时 `rules.apply` 是完全合法的官方用法 | aispec 佐证（**不单独定模式**，见 §3 规则 4） |
| 中 | `openspec/changes/<id>/contracts.md` | aispec 独有产物（playbook+并行场景必有；direct v2.0.0 也要求写） | aispec 佐证 |
| 中 | tasks.md 形态 | 多行任务体（`Trace: D-*` / `Design 来源` / `操作` / `文件` / `编排` / `验收` 子字段）或 `### Phase N：层名` 分组 → aispec；`## N.` + `- [ ] N.M` 单行 → 官方 | 交叉验证 |
| 弱 | design.md 章节特征 | 含"后端中心归属决策 / OUTBOUND 字段映射 / §18 Implementation Trace Matrix"等 → aispec；官方四段（Context / Goals-Non-Goals / Decisions / Risks）→ 官方 | 交叉验证 |
| 弱 | proposal.md 章节特征 | AS-IS/TO-BE、待确认项/已确认项表、验收标准段 → aispec | 交叉验证 |

## 2. 子模式解析（仅 aispec 模式需要）

读 `project-profile.yaml` 的 `sdd.design-mode`，按 `_shared/sdd-profile-runtime.md` 模式表：

| design-mode 取值 | 子模式 |
|---|---|
| 缺失 / 非法值 | direct（并在输出中声明降级理由） |
| `legacy` | direct |
| `direct` | direct |
| `v2` / `playbook` | playbook |

`_shared/sdd-profile-runtime.md` 不存在（源态工作区未分发）时：直接按上表判定，声明"_shared 未分发，按内置模式表解析"。子模式只影响 aispec 链内部路由（由 `ai-apply-change` 自行处理），**不影响本分身的探测结论**。

## 3. 仲裁规则

1. 重信号之间冲突（有 profile 但 `.ai-sdd/` 缺失）：仍判 **aispec 模式**，进入 Step 1 后由 ai-apply-change 的前置校验决定继续或阻塞；本分身在终态汇报中列出缺口。
2. 重信号与中/弱信号冲突（profile 说 aispec 但 tasks 是官方薄格式）：以重信号为准。注意**不要用"解析器对两种形态一致"来安抚**——复选框解析器确实一致，但真正会卡住的是**门禁**：aispec 链的 ai-apply Phase 1.1 要求 design 为 done，而一个官方薄 change 可能根本没有 design.md（合法：`apply.requires=[tasks]`，design 是条件性 artifact）。此时按 `gate.py` 的**按 change 判定**结论走：design 缺失不阻塞，只降级相关检查（跳过 design 一致性核对与 D-* Trace 锚定），并在汇报中声明。
3. 全部信号缺失：**官方轻量模式**。不得因为本仓库装了 ai-* 技能就擅自启用增强（轻量流程保持轻量）。
4. **仅命中探测点 c（rules.apply）而 a、b 皆缺席**：不足以单独判定 aispec。先 ask-questions 与用户确认；确认前**禁止任何写入**——特别要点名 ai-apply direct Phase 1.2 会生成工作区 `backup-*.zip` 并 `mkdir -p .ai-sdd/artifacts/...`，一旦误判就会在纯官方工程里造出 aispec 目录，直接违反"轻量零增强"。无人值守时按保守分支取**官方轻量模式**（少做优于误做）。
5. artifact 状态 `skipped` **等价于** `done`（由 change 的 `.openspec.yaml` 声明 `skip_specs: true` 产生，是官方正道），不得当作未完成而退回上游。

## 4. 探测输出格式

```
【流程探测结论】
- 模式：aispec-direct | aispec-playbook | 官方轻量
- 证据：project-profile.yaml(sdd.design-mode=direct) ✓ / .ai-sdd/context/context-index.yaml ✗ / rules.apply ✓
- 交叉验证：tasks 形态=多行任务体(Trace: D-*)，与主证据一致
- 声明：<降级/冲突/缺口说明，无则省略>
```

## 5. 工作区根与 change 定位注意

- 工作区根 = 含 `project-profile.yaml` 或 `openspec/config.yaml` 的目录；两者都在时以 `project-profile.yaml` 所在层为准。
- `openspec list --json` 返回各 change 的 status（no-tasks / in-progress / complete）与任务数，按 lastModified 降序——推荐"最近修改 (Recommended)"即官方续作模式。
- store / 多仓库场景：`status --json` 的 `planningHome.root` 与 `changeRoot` 才是 change 真实位置，**不要**按本仓库相对路径拼接。
