# 人工配置清单：jev-router-fusion

> 阶段 2（T-2.1 ~ T-2.10）实现中产生的全部需人工确认 / 配置 / 标定的项。
> 每项标注：当前值（占位/演示）→ 期望值（真实配置）→ 验证方式 → 责任阶段。

## 1. 路由档位阈值（routeTier）

| 参数 | 当前值 | 期望值 | 验证方式 | 责任阶段 |
|---|---|---|---|---|
| `ROUTE_TIER_DEFAULT.high` | 0.82 | 按动作风险分级标定（低风险动作可降低阈值，高风险动作应提高） | 三档边界断言 + 档位语义断言 | 阶段 7 治理 |
| `ROUTE_TIER_DEFAULT.mid` | 0.60 | 同上 | 同上 | 阶段 7 治理 |

**理由**：design.md §4.2 明示「阈值统一取 0.82 / 0.60 是演示取值（官方不给固定阈值，要求按动作风险分级）」。

**动作**：用户需在阶段 7 前根据真实动作风险分级（low/medium/high）确定阈值矩阵，或确认当前演示值可用于生产。

## 2. 软评分策略快照（scoreModels）

| 参数 | 当前值 | 期望值 | 验证方式 | 责任阶段 |
|---|---|---|---|---|
| `SOFTMAX_T0_DEFAULT` | 1.0 | 根据真实模型分布标定 | softmax 输出分布断言 | 阶段 3 服务端 |
| `SOFTMAX_ALPHA_DEFAULT` | 0.5 | 同上 | 同上 | 阶段 3 服务端 |
| PolicySnapshot 的 `w_capability` / `w_quality` / `w_cost` / `w_latency` | 无默认（调用方提供） | 锁定的真实策略快照，权重和为 1 | 打分构成断言 + 双序断言 | 阶段 3 服务端 |
| `LOAD_PENALTY_COEFF` | 26 | 根据真实拥塞数据标定 | 惩罚单调性断言 | 阶段 3 服务端 |
| `LOAD_PENALTY_EXP` | 2.2 | 同上 | 同上 | 阶段 3 服务端 |

**理由**：design.md §4.4 未给出真实权重值，仅给出公式；阶段 3 实现时需由策略服务锁定 PolicySnapshot。

**动作**：用户需在阶段 3 前确定真实的策略权重与 softmax 参数，或确认当前演示值可用于生产。

## 3. 经验闭环常量（priorDeltaFor / outcomeWeight / calibrationStats）

| 参数 | 当前值 | 期望值 | 验证方式 | 责任阶段 |
|---|---|---|---|---|
| `EXP_CORR_MAX` | 4.0 | 根据真实经验数据分布标定 | 上界 + 冷启动 + 反固化断言 | 阶段 4 经验闭环 |
| `EXP_PRIOR_STRENGTH` | 20 | 同上 | 同上 | 阶段 4 经验闭环 |
| `EXP_HALF_LIFE_DAYS` | 30 | 根据真实经验时效性标定 | 半衰期与地板值断言 | 阶段 4 经验闭环 |
| `EXP_WEIGHT_FLOOR` | 0.15 | 同上 | 同上 | 阶段 4 经验闭环 |
| `EXP_MIN_SAMPLE_PER_PAIR` | 8 | 根据真实样本规模标定 | shadow 模式断言 | 阶段 4 经验闭环 |
| `EXP_MIN_SAMPLE_GLOBAL` | 30 | 同上 | 同上 | 阶段 4 经验闭环 |
| `SOURCE_W.human` | 1.0 | 根据真实来源可信度标定 | 来源权重断言 | 阶段 4 经验闭环 |
| `SOURCE_W.system` | 1.0 | 同上 | 同上 | 阶段 4 经验闭环 |
| `SOURCE_W.implicit` | 0.45 | 同上 | 同上 | 阶段 4 经验闭环 |

**理由**：design.md §4.9.4 明示这些是设计取值，需根据真实经验数据校准。

**动作**：用户需在阶段 4 前根据真实经验数据校准这些常量，或确认当前设计值可用于生产。

## 4. 几何与取景参数（geometry）

| 参数 | 当前值 | 期望值 | 验证方式 | 责任阶段 |
|---|---|---|---|---|
| `TREE_RADIUS_BASE` | 2 | 根据真实 3D 视觉调优 | 几何预验证（27 项）+ 视觉回归 | 阶段 6 前端 |
| `TREE_RADIUS_PER_LEAF` | 0.5 | 同上 | 同上 | 阶段 6 前端 |
| `TREE_RADIUS_MAX` | 12 | 同上 | 同上 | 阶段 6 前端 |
| `TREE_LEAF_Y_SPAN` | 1.2 | 同上 | 同上 | 阶段 6 前端 |
| `TREE_LEAF_Z_OFFSET` | 0.3 | 同上 | 同上 | 阶段 6 前端 |
| `TREE_HUD_MARGIN` | 0.4 | 根据 HUD 实际占位调优 | HUD 遮挡检查 | 阶段 6 前端 |
| `LANDING_DISTANCE_MAX` | 0.05 | spec.md ANIM-2 给定，无需调优 | 落点实测 | 阶段 6 前端 |
| `LANDING_MIDPOINT_MAX` | 0.02 | 同上 | 同上 | 阶段 6 前端 |

**理由**：design.md §4.7-4.8 未给出具体几何参数；当前值为占位，需在阶段 6 前端实现时与 `D:\TREAWork\JevDemo\jev-demo.html` 视觉参考对齐。

**动作**：用户需在阶段 6 前根据真实 3D 视觉效果调优这些参数。

## 5. 时间线参数（computeRun）

| 参数 | 当前值 | 期望值 | 验证方式 | 责任阶段 |
|---|---|---|---|---|
| `RUN_DEFAULT_TOTAL_MS` | 4200 | 根据 UX 调优 | 时长自洽断言 + 用户测试 | 阶段 6 前端 |
| `RUN_MIN_TOTAL_MS` | 1 | 同上 | 同上 | 阶段 6 前端 |
| `STAGE_NAMES` | ['state','questions','jev','probability','route','execute','result'] | 与 ANIM-3 视觉映射对齐 | 视觉回归 | 阶段 6 前端 |

**理由**：design.md §4.7 未给出总时长；当前 4200ms 为占位。STAGE_NAMES 假设对应主链 7 段（A-23），需与 ANIM-3「提问环/得分环/选中环」视觉映射对齐。

**动作**：用户需在阶段 6 前根据 UX 测试调优总时长；需确认 STAGE_NAMES 与前端视觉阶段映射一致。

## 6. extractFeatures 参数

| 参数 | 当前值 | 期望值 | 验证方式 | 责任阶段 |
|---|---|---|---|---|
| `DEFAULT_GRADE_COUNT` | 3 | 根据真实分级需求标定 | 确定性断言 + 空输入断言 | 阶段 3 服务端 |
| `EVIDENCE_W` | {intent:0.34, complexity:0.16, urgency:0.14, budget:0.14, capability:0.22} | design.md §4.1 给定，无需调优 | 证据强度断言 | 已确认 |
| `NOUL_PRIOR` | 0.30 | design.md §4.1 给定，无需调优 | noul 先验污染断言 | 已确认 |
| `SCORE_TOKEN_SATURATION` | 450 | design.md §4.1 给定，无需调优 | 规模证据断言 | 已确认 |
| `LONG_CTX_SATURATION` | 4000 | design.md §4.1 给定，无需调优 | 同上 | 已确认 |

**动作**：用户需确认 `DEFAULT_GRADE_COUNT = 3` 是否符合真实分级需求；若需更细分级（如 5 档），需修改 `extractFeatures.ts`。

## 7. 校准曲线参数（calibrate）

| 参数 | 当前值 | 期望值 | 验证方式 | 责任阶段 |
|---|---|---|---|---|
| `CALIBRATE_LOW` | 0.35 | design.md §4.2 给定，无需调优 | 边界断言 | 已确认 |
| `CALIBRATE_HIGH` | 0.97 | design.md §4.2 给定，无需调优 | 同上 | 已确认 |
| `CALIBRATE_K` | 2.6 | design.md §4.2 给定，无需调优 | 单调性断言 | 已确认 |
| `CALIBRATE_DECIMALS` | 2 | design.md §4.2 给定（`round(x, 2)`），无需调优 | 同上 | 已确认 |

**动作**：无需用户配置；design.md 已给定。

## 8. 校准统计参数（calibrationStats）

| 参数 | 当前值 | 期望值 | 验证方式 | 责任阶段 |
|---|---|---|---|---|
| `ECE_BINS` | 10 | design.md §4.9.6 给定，无需调优 | ECE 对拍手算 | 已确认 |
| `ECE_MIN_SAMPLE` | 30 | design.md §4.9.6 给定，无需调优 | 样本量守卫断言 | 已确认 |
| 默认高置信阈值（falsePositiveRate） | 0.82 | 与 ROUTE_TIER_DEFAULT.high 对齐 | 误报率断言 | 阶段 7 治理 |
| 默认低置信阈值（falseNegativeRate） | 0.60 | 与 ROUTE_TIER_DEFAULT.mid 对齐 | 漏报率断言 | 阶段 7 治理 |

**动作**：高/低置信阈值随 ROUTE_TIER_DEFAULT 联动；用户在阶段 7 调整路由阈值时，校准统计阈值同步调整。

## 9. 工程配置

| 项 | 当前值 | 期望值 | 验证方式 | 责任阶段 |
|---|---|---|---|---|
| `project-profile.yaml` repositories.path | "packages" | 真实仓库根（若 monorepo 根 = 工作区根，需调整 collect/validate 脚本或保持 "packages"） | validate_phase6_artifacts.py exit 0 | 已确认（D-Apply-3） |
| `tsconfig.base.json` strict mode | true | 保持 | typecheck 0 错误 | 已确认 |
| `package.json` engines.node | >=20.0.0 | 根据生产环境调整 | n/a | 阶段 8 集成 |
| `package.json` packageManager | pnpm@9.0.0 | 根据生产环境调整 | n/a | 阶段 8 集成 |

## 待用户确认项汇总

1. **routeTier 阈值**：0.82/0.60 是否可用于生产，还是需按动作风险分级标定？
2. **scoreModels 策略权重**：是否有真实的 PolicySnapshot，还是使用演示值推进？
3. **经验闭环常量**：EXP_CORR_MAX=4.0 等设计值是否可用于生产？
4. **几何参数**：TREE_RADIUS_* 等占位值是否可在阶段 6 调优？
5. **时间线时长**：RUN_DEFAULT_TOTAL_MS=4200 是否符合 UX 预期？
6. **STAGE_NAMES**：7 阶段命名是否与 ANIM-3 视觉映射一致？
7. **DEFAULT_GRADE_COUNT**：3 档分级是否符合复杂度/能力评定需求？
8. **repositories.path**："packages" 工作区配置是否可保持？

**用户评审通过后**：勾选本清单各项 → 进入阶段 3 服务端核心实现。
