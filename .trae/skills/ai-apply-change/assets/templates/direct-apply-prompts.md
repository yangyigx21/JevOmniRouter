# Direct apply 内部提示与 ask-questions 模板

direct 模式下，Phase 0/1.1/2.1/2.2/4.2/5.3/5.4/7 的对外输出 / ask-questions JSON 统一定义在这里，便于按需加载。

## Phase 0：选定 change

```
header: "选择要实现的 change"
question: "请从上方列表中选择要进入编码阶段的 change 名称："
allowFreeformInput: true
```

选定后宣告：`> 使用 change: **<name>**`。

## Phase 1.1：前置校验未通过

```
❌ 无法进入编码阶段

当前 change "<name>" 的以下制品尚未完成：
- [design / tasks]（视具体缺失情况列出）

请先完成设计和任务拆分，再重新执行 ai-apply-change。
推荐命令：openspec-continue-change（或 openspec-ff-change 快速推进至 tasks）
```

## Phase 2.1：apply 规则加载确认

```
✅ 已从 openspec/config.yaml 加载 rules.apply（共 N 条），将在编码全程强制执行。
```

## Phase 2.2：上下文加载完成确认

```
✅ Phase 2.2 完成：
  - Scope：<scope，按 project-profile.yaml 与本次 change 实际涉及范围>
  - 上下文：已加载 N 个文件
  - 代码模式：<已加载 / 不存在>
  - 补充设计约束：<已加载 / 无>
  - 原型：<就绪 / 无>
  - 应用接口契约：<contracts.md / design.md 已确认章节 / 不涉及 / 不足>
  - OUTBOUND 外部协议契约：<不涉及 / 通过 / 阻塞>
  - INBOUND 入站协议契约：<不涉及 / 通过 / 阻塞>
```

## Phase 4.2：apply 约束摘要

```
## Apply 约束摘要 — change: <name>

### Apply 规则（config.rules.apply，共 N 条）
1. ...
2. ...
...

### 本次补充指令
- <用户传入的补充指令，若无则显示"（无）">

### 契约状态
- 应用接口契约: <contracts.md / design.md 已确认章节 / 不涉及 / 不足>
- OUTBOUND 外部协议契约: <不涉及 / 通过 / 阻塞>
- INBOUND 入站协议契约: <不涉及 / 通过 / 阻塞>
```

## Phase 5.4：任务执行终态摘要

```
## 任务执行摘要

| 任务 | 产出 | 状态 |
|------|------|------|
| 1.1 ... | 新增接口 xxx | ✅ |
| 2.3 运行单元测试 | 12 passed | ✅ |
| 3.1 ... | — | ⏸ 用户跳过 |

**统计**：✅ N | ⏸ K（用户跳过）| ⌛ L（未开始）
**未完成任务**：<列出 ⌛ 项及原因；若 ⌛ != 0 必须解释为什么没做>
```

## Phase 5.3：单任务勾选证据注释

```
- [x] N.M 任务标题  <!-- done: <一句话描述产出> -->
```

测试任务额外带上运行结果：`<!-- done: tests, 12 passed, exit=0 -->`。

## Phase 7：refine 同意门

```
header: "执行 refine"
question: "编码已完成并生成 changed-files/apply-report。是否现在调用 ai-refine-change 做一轮评估修复？"
options:
  - label: "执行 refine（推荐）"
    description: "读取本次 changed-files、OpenSpec、上下文和源码，做一轮评估、修复和再验证。"
    recommended: true
  - label: "暂不 refine"
    description: "保留当前实现和报告，不做自动评估修复。"
allowFreeformInput: false
```
