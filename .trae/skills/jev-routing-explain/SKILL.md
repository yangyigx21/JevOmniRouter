---
name: jev-routing-explain
description: 解释 JevRouter 为什么这样路由——候选得分分布、先验修正归因、硬约束淘汰原因、档位阈值判定。用于"为什么选它"、"评分怎么算的"、"这个模型为什么被淘汰"、"置信度怎么来的"等场景。
version: 1.0.0
updated: 2026-10-10
---

# Jev 路由决策解释

复用之上一步 `jev-route-decide` 的真实结果，按四维度 + Jev 先验 + 8 步硬约束生成可审计的解释。

## 前置检查

同 `jev-route-decide`：后端须在线。若已有上一次决策结果，优先复用，避免重复消耗模型调用。

## 执行流程

1. 调 `jev_score_explain`：
   - 给定 `prompt` → 跑一次真实决策并解释（消耗一次模型调用）
   - 给定 `request_id` → 从决策库解释既有决策（**免费**，但只有概率分布，无 raw/Δprior）
2. 从返回中提取并逐一解释：
   - **类型化答案（Jev 五问）**：`INTENT` / `COMPLEXITY` / `URGENCY` / `BUDGET` / `CAPABILITY`
   - **候选得分分布**：softmax 概率、raw 分、先验 Δ
   - **硬约束淘汰**：被移除的模型 + 失败码
   - **先验归因**：`winnerReason`
3. 如需逐模型 8 步明细，补调 `jev_constraints_audit`（免费）。
4. 如需模型能力对比背景，补调 `jev_model_catalog`。

## 评分链路（解释时按此顺序讲）

```
STATE（证据提取）
  → CHOICE/SCORE/NOUL（Jev 三原语五问）
  → JEV（类型化答案）
  → PROBABILITY（自适应温度 softmax + 经验先验注入 + 同分决胜）
  → ROUTE / GATE / ESCALATE（后果分级阈值）
```

关键点：

- **先验在 softmax 之前注入**（SCORE-3 双序契约）；`先验Δ` 是该模型在 softmax 前获得的分数修正量。
- 先验权重（默认）：`intentMatch 0.60` / `complexityFit 0.40` / `budgetFit 0.30` / `capabilityFit 0.25` / `urgencyFit 0.20`，修正量受 `MAX_PRIOR_DELTA` 夹紧。
- **硬约束优先于 Jev 建议**（CONSTRAIN-3）：Jev 推荐的模型若被淘汰，改选次优，且 `jevRecommendationEliminated` 会标注。

## 8 步硬约束（淘汰原因对照）

| 步 | 约束 | 失败码 |
|---|---|---|
| 1 | 目录启用 & 健康 | `MODEL_DISABLED` / `MODEL_UNAVAILABLE` |
| 2 | 租户/用户权限 | `MODEL_NOT_ALLOWED` |
| 3 | 模态 & 能力 | `MODALITY_UNSUPPORTED` / `CAPABILITY_MISSING` |
| 4 | 上下文 & 输出上限 | `CONTEXT_LIMIT_EXCEEDED` |
| 5 | 数据 & 区域 | `DATA_POLICY_MISMATCH` / `REGION_NOT_ALLOWED` |
| 6 | 风险 & 安全 | `RISK_POLICY_BLOCKED` |
| 7 | 预算 & 配额 | `BUDGET_EXCEEDED` / `COST_UNKNOWN` |
| 8 | 延迟硬上限 | `LATENCY_LIMIT_EXCEEDED` |

## 档位阈值

- `ROUTE`：confidence ≥ `thresholds.high`（运行期动态，常为 0.82）
- `GATE`：`thresholds.mid` ≤ confidence < `thresholds.high`（mid 常为 0.77）
- `ESCALATE`：confidence < `thresholds.mid`

## 红旗

- **不得臆造分数**：所有概率/Δ/置信度必须来自工具返回。
- 淘汰原因必须映射到上表失败码，不得自造原因。
- 阈值是**运行期动态值**，照抄返回的 `thresholds`，不得写死 0.82/0.60。
