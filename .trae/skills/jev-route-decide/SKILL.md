---
name: jev-route-decide
description: 给定 prompt，调用 JevRouter MCP 工具执行真实路由决策并解释选型依据（无前端）。用于"这段 prompt 该用哪个模型"、"帮我选型"、"路由到哪个档位"、"为什么选这个模型"等场景。
version: 1.0.0
updated: 2026-10-10
---

# Jev 路由决策

把用户 prompt 交给 JevRouter 后端做真实决策，返回档位、置信度、选中模型与完整依据链。

## 前置检查

1. 后端必须在线。若 `jev_route_decide` 返回"后端未就绪"，提示用户启动：
   ```bash
   cd packages/backend && pnpm dev
   ```
2. 若 MCP 工具不可用，回退直连：
   ```bash
   curl -s -X POST http://127.0.0.1:3000/v1/routes \
     -H 'Content-Type: application/json' \
     -d '{"prompt":"<prompt>","modalities":["text"]}'
   ```

## 执行流程

1. 调 `jev_route_decide({ prompt, ... })`，按需透传可选参数：
   - `consequence_class`：后果等级（`low`/`medium`/`high`/`irreversible`）→ 影响路由偏好
   - `allowed_model_ids`：限定候选池
   - `max_latency_ms` / `budget_usd`：硬约束
2. 读取返回的 Markdown，**原样转发**关键结论，不要改写数字。

## 输出规范

必须完整保留以下事实，不得编造：

| 字段 | 来源 | 规则 |
|---|---|---|
| 档位 | `tier` | ROUTE ≥ high 阈值 / GATE ≥ mid 阈值 / ESCALATE < mid 阈值 |
| 置信度 | `confidence` | 用返回的原始数值（如 0.670），不得四舍五入成"约 0.67"以外的表述 |
| 阈值 | `thresholds` | high/mid 为运行期动态值，照抄 |
| 选中模型 | `selectedModelId` | ESCALATE 时为空，改报"建议兜底模型" |
| 选型依据 | `rationale` + `winnerReason` | 逐条列出 |

## 档位语义（务必向用户解释清楚）

- **ROUTE**：高置信，直接路由到选中模型并已执行完毕。
- **GATE**：中置信，标记观察后执行。
- **ESCALATE**：低置信，**不自动执行模型**（spec `ROUTE_ESCALATED`）。此时后端仅给出候选分布；`jev_route_decide` 会用分布首位作为"建议兜底模型"，但**尚未执行**。需向用户说明这一点，不可宣称已执行。

## 红旗

- **不得编造 `confidence`**：一律以工具返回为准。
- **ESCALATE 不得声称已执行模型**。
- 工具报 `ROUTE_TIMEOUT` 时，如实告知超时，不要臆测结果。
- 若返回 `constraintFallback: true`，必须提示用户"硬约束回落，约束严格性已放宽"。
