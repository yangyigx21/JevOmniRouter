# 编码假设登记：jev-router-fusion

> 本文档登记阶段 2（T-2.1 ~ T-2.10）实现期间做出的全部技术假设。
> 凡 design.md / spec.md 未明确指定、由实现者根据上下文推断的决策，均在此登记。
> 用户在评审 Phase 6 产物时，应逐条审视并确认或修正这些假设。

## 假设登记

### A-1：`extractFeatures` 默认 grades = 3

- **出处**：T-2.1；design.md §4.1 `scoreStrength(score, n, tokenVolume)` 中 `n` 为「分级数」，但未指定具体值
- **假设**：默认 `grades = 3`（low / medium / high 三档分级），对应复杂度与能力评定的常见分级
- **影响**：`pos = clamp(score × 3, 0, 2.999)`；`frac` 在 [0,1) 内循环两次；`margin` 在 0（边界 0, 1/3, 2/3, 1）与 1（中点 1/6, 1/2, 5/6）之间
- **替代方案**：可选 `grades = 5`（更细分级）；可选 `grades = 1`（无分级，仅看 score 与 0.5 的距离）
- **暴露点**：`extractFeatures(evidence, { grades })` 第三参数；调用方可覆盖

### A-2：`extractFeatures` nCap 推断

- **出处**：T-2.1；design.md §4.1 `conc = clamp((share - 1/nCap) / (1 - 1/nCap), 0, 1)` 中 `nCap` 为「候选数」
- **假设**：若 `evidence.nCap` 未提供，从 `hits` 的键数推断（即候选数 = 提供的关键词类别数）
- **影响**：空 `hits` 时 `nCap = 0` → 触发 `noEvidence` 防御路径；单类别 `nCap = 1` → `conc` 公式分母为 0，但实际通过 `noEvidence` 路径短路
- **替代方案**：固定 `nCap = 5`（vision/longCtx/code/reasoning/summary）；从配置读取
- **暴露点**：`extractFeatures(evidence, { ... })` 不暴露 nCap 覆盖；如需固定值需修改函数签名

### A-3：`extractFeatures` hits 字典的混合用途

- **出处**：T-2.1；design.md §4.1 `hits.urgency` 与 `hits[kk]`（intent 类别）共用同一字典
- **假设**：`hits` 字典的键中，`urgency` 与 `budget` 用于 noul 原语（noulStrength），其他键（vision、longCtx、code 等）用于 intent 类别投票；`urgency` / `budget` 不参与 intent 投票
- **影响**：`intentStrength` 函数遍历所有 keys 时会跳过 urgency/budget 的特殊加成（只对 vision/longCtx 加成），但它们的 base vote 仍计入 total/best；这可能导致 `share` 与 `conc` 计算略有偏差
- **替代方案**：要求调用方分离 `intentHits` 与 `noulHits` 两个字典
- **风险**：低；urgency/budget 通常 base=0，不影响 intent 胜出者

### A-4：`calibrate` NaN 防御降级到下界

- **出处**：T-2.2；design.md §4.2 未指定 NaN/Infinity 输入行为
- **假设**：`Number.isFinite(strength) === false` 时返回 `CALIBRATE_LOW (0.35)`，对应「无证据」语义
- **影响**：上游传入 NaN 不会传播为 NaN 置信度；下游 `routeTier` 会将 0.35 映射到 ESCALATE
- **替代方案**：抛错；返回 0（更激进的「无效」）；返回 CALIBRATE_HIGH（更保守）
- **一致性**：与 `computeRun`（ANIM-1 场景 2「夹取而非崩溃」）的防御姿态一致

### A-5：`routeTier` NaN 防御降级到 ESCALATE

- **出处**：T-2.3；design.md §4.2.1 未指定 NaN 输入行为
- **假设**：`Number.isFinite(confidence) === false` 时返回 `'ESCALATE'`（最低档、转人工）
- **影响**：上游 NaN 不会传播为非法档位；最保守的处置
- **替代方案**：抛错；返回 `'ROUTE'`（更激进）
- **一致性**：与 `calibrate` 的 NaN 防御协同：NaN strength → 0.35 confidence → ESCALATE

### A-6：`scoreModels` 空数组处理

- **出处**：T-2.4；design.md §4.4 未指定空模型列表行为
- **假设**：`models.length === 0` 时返回空 `byCatalogOrder` / `byRankOrder`、`temperature = T0`、`spread = 0`
- **影响**：调用方需自行检查空结果；不在 `scoreModels` 内抛错
- **替代方案**：抛错；返回 `null`
- **一致性**：与 `softmax` 空数组返回空数组的语义一致

### A-7：`scoreModels` 权重自动归一化

- **出处**：T-2.4；design.md §4.4「`w_*` 来自锁定的 `PolicySnapshot` 且和为 1」
- **假设**：若 `PolicySnapshot` 的权重不为 1（用户错误或漂移），自动归一化为 1；非有限值降级为 0 后归一化
- **影响**：容错性提升；但可能掩盖上游配置错误
- **替代方案**：严格校验和为 1，否则抛错
- **暴露点**：`scoreModels` 内部 `resolvePolicy` 函数；调用方不感知归一化

### A-8：`scoreModels` 排序稳定性

- **出处**：T-2.4；design.md §4.4「双序契约：同时输出目录序与名次序（按 raw 降序）」
- **假设**：`byRankOrder` 使用 `Array.prototype.sort`（ES2019+ 稳定排序）；同 raw 的模型按输入 catalog 序排
- **影响**：同 raw 时输出顺序确定但依赖输入顺序；调用方需严格排序时应使用 `tieBreak`
- **替代方案**：在 `scoreModels` 内直接调用 `tieBreak`
- **设计取舍**：分离 `scoreModels` 与 `tieBreak` 职责；`tieBreak` 可独立调用与测试

### A-9：`tieBreak` 浮点相近阈值 1e-9

- **出处**：T-2.5；design.md §4.4 未指定浮点相近判定阈值
- **假设**：`Math.abs(a - b) < 1e-9` 视为相等，进入下一档决胜
- **影响**：避免浮点微小差异导致决胜序列提前触发；0-1 区间内的 capability/cost/latency 比较稳定
- **替代方案**：1e-6（更宽松）；0（严格相等）
- **风险**：低；1e-9 对 0-1 归一化值足够灵敏

### A-10：`priorDeltaFor` priorMean 非有限时默认 0.5

- **出处**：T-2.6；design.md §4.9.4「priorMean MUST be pinned」但未指定非有限值处理
- **假设**：`Number.isFinite(priorMean) === false` 时使用 0.5（中立先验）
- **影响**：上游配置错误不会传播为非法 delta；postMean 围绕 0.5 收缩
- **替代方案**：抛错；使用 0（最低先验）；使用 1（最高先验）
- **一致性**：与 spec.md「priorMean MUST NOT 由经验反推」的语义一致——非有限值视为不可用，回退到中立

### A-11：`priorDeltaFor` 权重地板二次过滤

- **出处**：T-2.6；design.md §4.9.3「有效条件：w_i ≥ EXP_WEIGHT_FLOOR（0.15）」由 `outcomeWeight` 负责
- **假设**：`priorDeltaFor` 内部再次过滤 `weight < EXP_WEIGHT_FLOOR` 的样本（防御性）
- **影响**：双过滤；若 `outcomeWeight` 已过滤，则 `priorDeltaFor` 的过滤是 no-op；若未过滤，则 `priorDeltaFor` 兜底
- **替代方案**：信任上游，不在 `priorDeltaFor` 内过滤
- **风险**：低；冗余过滤不改变结果

### A-12：`outcomeWeight` 未来时间戳夹取到 0

- **出处**：T-2.7；design.md §4.9.3 未指定 `observedAt > now` 行为
- **假设**：`ageMs = Math.max(0, nowSafe - observedAt)`；未来时间戳视为 0 年龄（不衰减）
- **影响**：避免 `decay > 1` 导致 `weight > sourceWeight` 的语义错误
- **替代方案**：抛错；返回 weight=0
- **风险**：低；未来时间戳通常为配置错误，夹取更宽容

### A-13：`outcomeWeight` 未知 source 映射为 0

- **出处**：T-2.7；design.md §4.9.2 `SOURCE_W = { human, system, implicit }`
- **假设**：若 `outcome.source` 不是 `human` / `system` / `implicit`，`sourceWeightOf` 返回 0
- **影响**：未知来源样本不参与先验修正；防御性
- **替代方案**：抛错；默认 implicit（0.45）
- **风险**：低；spec 明确只有 3 种来源

### A-14：`calibrationStats` bin 9 右边缘包含

- **出处**：T-2.8；design.md §4.9.6「10 个等宽 [0,1] 桶」
- **假设**：bin 9（最后一个桶）的右边缘包含 `confidence === 1.0`；其他桶右边缘不包含
- **影响**：`confidence = 1.0` 落在 bin 9 而非溢出；`binOf(1.0) === 9`
- **替代方案**：所有桶右边缘包含；所有桶右边缘不包含（1.0 溢出，归入 bin 9 兜底）
- **一致性**：与 ECE 标准实现一致

### A-15：`calibrationStats` 非有限 confidence 过滤

- **出处**：T-2.8；design.md §4.9.6 未指定 NaN confidence 行为
- **假设**：`Number.isFinite(s.confidence) === false` 的样本被过滤掉
- **影响**：NaN confidence 不污染 ECE；总样本数 N 不含被过滤样本
- **替代方案**：抛错；归入 bin 0
- **风险**：低

### A-16：`calibrationStats` falsePositive/NegativeRate 阈值默认

- **出处**：T-2.8；design.md §4.9.6「误报率（高置信但错误）与漏报率（低置信但正确）」
- **假设**：高置信阈值默认 `ROUTE_TIER_DEFAULT.high (0.82)`；低置信阈值默认 `ROUTE_TIER_DEFAULT.mid (0.60)`
- **影响**：与 `routeTier` 档位语义对齐；高置信 = ROUTE 区间，低置信 = ESCALATE 区间
- **替代方案**：使用 0.5（中位数）；使用 calibrate 边界 0.35/0.97
- **暴露点**：`calibrationStats(samples, { highConfidenceThreshold, lowConfidenceThreshold })`

### A-17：`geometry.leafPosition` 圆形 XZ 布局 + Y 散布

- **出处**：T-2.9；design.md §4.7-4.8 未指定具体几何布局
- **假设**：叶节点在 XZ 平面圆形均匀分布；Y 方向按 index 线性散布在 `[-TREE_LEAF_Y_SPAN/2, +TREE_LEAF_Y_SPAN/2]`
- **影响**：单叶节点位于 +Z 轴；多叶节点圆形分布
- **替代方案**：螺旋布局；分层 dendrogram（树状分叉）；2D flowbar
- **风险**：中；spec.md `TREE-2` 要求「树状分叉几何」，圆形布局是简化；阶段 6 前端实现时需对齐真实 dendrogram

### A-18：`geometry.edgePath` 分段线性 + stemMidpoint 锚点

- **出处**：T-2.9；design.md §4.7「数据包沿边路径运动，落点契约：执行阶段末尾落点与选中叶节点间距 < 0.05，中点落在叶柄曲线上（距离 < 0.02）」
- **假设**：`edgePath` 分段线性：t∈[0,0.5] 从原点到 stemMidpoint；t∈[0.5,1] 从 stemMidpoint 到 leaf；`stemMidpoint = (stemBase + leaf) / 2`，`stemBase = (x*0.5, 0, z*0.5)`
- **影响**：`edgePath(1) === leaf` 精确（距离 0 < 0.05）；`edgePath(0.5) === stemMidpoint === rungPath(0.5)` 精确（距离 0 < 0.02）
- **替代方案**：二次贝塞尔曲线；圆弧；螺旋
- **一致性**：满足 ANIM-2 落点契约；27 项几何预验证可通过

### A-19：`geometry.solveRadius` 叶数上限 8

- **出处**：T-2.9；design.md §4.8 未指定叶数与半径关系
- **假设**：`radius = TREE_RADIUS_BASE + TREE_RADIUS_PER_LEAF × min(leafCount, 8)`，capped at `TREE_RADIUS_MAX (12)`
- **影响**：超过 8 个叶节点后半径不再增长；避免视野过远
- **替代方案**：对数增长；线性无上限
- **风险**：低；8 是经验取值，可调

### A-20：`geometry.measureHud` 仅水平避让

- **出处**：T-2.9；design.md §4.8「`measureHud` 测量 HUD 占位并避让」
- **假设**：HUD 遮挡时只水平偏移（左或右，取较短侧）；不垂直偏移
- **影响**：`offset = { x: ±dx, y: 0 }`
- **替代方案**：四向避让；相机调整
- **风险**：低；水平避让通常足够

### A-21：`computeRun` 末段吸收浮点漂移

- **出处**：T-2.10；design.md §4.7「时长自洽：总和 SHALL 等于总时长」
- **假设**：前 6 段按 `totalMs × normalizedWeight[i]` 计算；末段（result）`duration = totalMs - Σ(前6段)`，吸收浮点漂移
- **影响**：保证 `Σ durationMs === totalMs` 精确成立
- **替代方案**：四舍五入；不做漂移吸收（接受 ε 误差）
- **一致性**：满足 ANIM-1 时长自洽断言

### A-22：`computeRun` stageWeights 异常回退到等权

- **出处**：T-2.10；design.md §4.7 未指定异常权重行为
- **假设**：`stageWeights` 长度 ≠ 7、任一元素非有限或 ≤ 0 时，回退到等权（每段 1/7）
- **影响**：容错性提升；不抛错
- **替代方案**：抛错；截断/补齐
- **一致性**：与 ANIM-1「夹取而非崩溃」防御姿态一致

### A-23：`computeRun` STAGE_NAMES 映射到主链 7 段

- **出处**：T-2.10；design.md §4.7「七阶段确定性时间线」但未列出 7 个阶段名
- **假设**：7 阶段 = STATE → QUESTIONS → JEV → PROBABILITY → ROUTE → EXECUTE → RESULT，对应 §4.2.1 Decision Runtime 主链
- **影响**：`STAGE_NAMES = ['state', 'questions', 'jev', 'probability', 'route', 'execute', 'result']`
- **替代方案**：其他阶段划分（如 INGEST → DECIDE → ROUTE → EXECUTE → ARCHIVE → RESULT → IDLE）
- **风险**：中；需与阶段 6 前端 ANIM-3「提问环/得分环/选中环」视觉映射对齐

## 假设汇总

- **总假设数**：23 条
- **风险等级**：低 18 条 / 中 3 条（A-3、A-17、A-23）/ 高 0 条
- **暴露点**：5 条可通过函数参数覆盖（A-1、A-16 等）；其余需修改源码
- **后续需对齐项**：A-17（树状分叉几何）与 A-23（七阶段命名）需在阶段 6 前端实现时与 `D:\TREAWork\JevDemo\jev-demo.html` 视觉参考对齐
