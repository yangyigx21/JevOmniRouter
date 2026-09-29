---
name: jev-history-inspect
description: 查询与解读 JevRouter 历史执行记录——按关键词/小时桶检索、查看单次执行的完整明细（prompt、模型、耗时、token、成本、事件序列、模型回答全文）。用于"上次那个请求结果"、"查一下历史"、"最近跑了什么"、"这次花了多少钱"等场景。
version: 1.0.0
updated: 2026-10-10
---

# Jev 历史执行查询

只读，不消耗模型调用。

## 前置检查

后端须在线。若 `jev_history_query` 返回"后端未就绪"，提示：
```bash
cd packages/backend && pnpm dev
```

## 执行流程

1. **列表视图**：调 `jev_history_query({ limit, hour?, search? })`
   - `limit` 默认 20，最大 200
   - `hour` 格式 `YYYY-MM-DD-HH`（本地时区）
   - `search` 对 prompt / 模型 / 档位 / 决策来源做包含匹配
2. **明细视图**：已知 `request_id` 时传 `request_id`，返回单条完整记录（含模型回答全文与事件序列）。

## 输出要点

列表视图保留：时间、档位、置信度、选中模型、延迟、成本、状态、prompt 摘要，以及本页汇总（总成本 / tokens / 平均延迟）。

明细视图保留：完整 prompt、执行统计（含 `usageSource`）、事件序列、模型回答全文。

## 字段口径

| 字段 | 含义 |
|---|---|
| `routeTier` | 该次决策档位 ROUTE/GATE/ESCALATE |
| `execution.status` | `success` / `error` / `cancelled` |
| `execution.costUsd` | 该次执行成本；免费兜底模型为 0 |
| `execution.usageSource` | `provider` = 网关上报；`estimated` = 网关未上报时按文本长度估算 |
| `hourBucket` | 记录归属的小时桶（本地时区） |
| `eventTypes` | 该次路由的事件类型序列，可用于审计回放 |

## 红旗

- **不得编造成本/延迟**：一律取工具返回值。
- `usageSource === 'estimated'` 时须提示"token 为估算值，非网关上报"。
- 按 `request_id` 未命中时工具**不会全库扫描**（历史库按小时分桶），须如实告知"未找到"并建议改用 `search` 缩小范围或放宽关键词。
- 硬约束、档位解释等应引导用户使用 `jev-routing-explain`，本 skill 只负责历史检索。
