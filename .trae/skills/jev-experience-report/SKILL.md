---
name: jev-experience-report
description: 汇报 JevRouter 决策经验闭环状态——动态置信度阈值、per-model 胜出统计与胜率、档位分布、业界评分同步。用于"阈值现在是多少"、"哪些模型被选中最多"、"经验库状态"、"学习进展"等场景。
version: 1.0.0
updated: 2026-10-10
---

# Jev 决策经验报告

只读，不消耗模型调用。

## 前置检查

后端须在线。若 `jev_experience_stats` 返回"后端未就绪"，提示：
```bash
cd packages/backend && pnpm dev
```

## 执行流程

1. 调 `jev_experience_stats`，按需传 `top_n`（默认 10）与 `sort_by`：
   - `selected`（默认）：被选次数
   - `winRate`：胜率
   - `avgConfidence`：被选时的平均置信度
   - `avgProbability`：平均胜出概率
   - `industry`：业界评分
2. 输出动态阈值 → 决策/执行分布 → 业界评分同步 → 模型排行榜。

## 字段口径

| 字段 | 含义 |
|---|---|
| `thresholds` | **运行期动态**置信度阈值（high/mid），随样本变化，禁止写死 |
| `thresholdSource` | `dynamic` = 由历史置信度分布计算；`static` = 样本不足用基线 |
| `winRate` | 被选次数 / 进入候选池次数 |
| `avgConfidence` | 仅统计**被选时刻**的校准置信度 |
| `totals.byTier` | 决策库按档位累计（决策视角） |
| `historyStats.byTier` | 历史库按档位累计（执行视角）；二者可能因 ESCALATE 不执行而不同 |
| `industrySync` | 业界评分（如 LMArena）同步摘要，与内部置信度统计**正交** |

## 两种档位分布的差异（务必区分）

- **决策库**记录每一次决策，含 ESCALATE。
- **历史库**只记录真正**执行过模型**的那些（ESCALATE 若未自动执行则不产生执行记录；本项目 ESCALATE 会转兜底模型继续执行，故通常两侧相近，但仍以工具返回为准，不得假设相等）。

## 红旗

- **阈值必须照抄工具返回值**，不得套用文档中的历史值。
- `thresholdSource === 'static'` 时须提示"样本不足，阈值为静态基线"。
- 不得把 `industry`（业界口碑）与 `avgConfidence`（本系统经验）混为一谈。
