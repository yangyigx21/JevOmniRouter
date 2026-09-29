---
name: jev-catalog-report
description: 读取 JevRouter 实时模型清单并生成分组报告——模型画像、厂商分布、免费兜底池、决策区分度。用于"当前模型状态"、"有哪些模型"、"列一下模型"、"哪个模型最划算"等场景。
version: 1.0.0
updated: 2026-10-10
---

# Jev 模型清单报告

只读操作，不产生路由决策，不消耗模型调用。

## 前置检查

后端须在线。若 `jev_model_catalog` 返回"后端未就绪"，提示：
```bash
cd packages/backend && pnpm dev
```

## 执行流程

1. 调 `jev_model_catalog`（无参 = 全量）。
2. 按需加过滤/排序：
   - `free_only: true` → 免费兜底模型（ESCALATE 用）
   - `vendor: "openai"` → 按厂商
   - `capability_tag: "code"` → 按能力标签
   - `sort_by`：`discrimination`（默认）/ `capability` / `quality` / `cost` / `latency` / `industry`
3. 输出时保留厂商分组与免费池区块。

## 字段口径（解释时勿混淆）

| 字段 | 含义 |
|---|---|
| `discrimination.score` | 本系统自身的**决策区分度**（0..1），非业界排名 |
| `industry.score` | **业界评分**（如 LMArena 总榜），与区分度正交 |
| `stats.selectedCount` | 该模型被实际选中的累计次数 |
| `profile.cost` | 成本维度分（**越高越便宜**） |
| `inputPricePer1k` / `outputPricePer1k` | 每 1K token 美元价；**两者为 0 即"免费模型"** |
| `coldStart` | 决策样本不足，评分仅供参考 |

## 三条实用视角

1. **免费兜底池**：`free_only: true`——ESCALATE 档位的兜底候选。
2. **最划算**：先按 `sort_by: "cost"` 再叠加 `capability` 参考，避免只看价格选到弱模型。
3. **长上下文**：从返回表里按上下文窗口列筛选（1M 级别的模型）。

## 红旗

- **不得超过清单编造模型**：所有模型必须以工具返回为准。
- `coldStart: true` 时须标注"样本不足，评分仅供参考"。
- `source` 为 `config-fallback` / `seed-fallback` 时须提示"清单来自回落，非实时"。
