<script setup lang="ts">
/**
 * RoutingTab — Jev 智能路由选择逻辑流程图
 *
 * 以 2D 流程图展示 prompt 从输入到输出每个环节的判断逻辑，
 * 参照 jev-routing-hub-and-stores.md §6 三者关系图的风格。
 *
 * 流程包含三列：
 * - 左列：模型能力（候选池 + 画像供给）
 * - 中列：主链路（10 个环节，垂直流转）
 * - 右列：决策经验库（阈值供给 + 经验沉淀）
 */
import { computed, ref, onMounted } from 'vue';
import type { Store } from '../../store/createStore.js';
import type { RouteState, RouteAction } from '../../store/routeEventReducer.js';
import { fetchModelInfo } from '../../api/client.js';

const props = defineProps<{
  store: Store<RouteState, RouteAction>;
}>();

// ── 候选模型池（原 InputTab 移入，与流程图同页签） ──────────────
const poolModels = ref<{ modelId: string; label: string }[]>([]);
const poolSelected = ref<string[]>([]);
const poolError = ref<string | null>(null);

onMounted(async () => {
  try {
    const info = await fetchModelInfo();
    poolModels.value = info.models.map((m) => ({ modelId: m.modelId, label: m.label || m.modelId }));
    poolSelected.value = poolModels.value.map((m) => m.modelId);
  } catch (err) {
    poolError.value = err instanceof Error ? err.message : '模型清单拉取失败';
  }
});

function togglePool(modelId: string) {
  const idx = poolSelected.value.indexOf(modelId);
  if (idx >= 0) {
    if (poolSelected.value.length === 1) return;
    poolSelected.value.splice(idx, 1);
  } else {
    poolSelected.value.push(modelId);
  }
}

/** 当前路由状态摘要，高亮流程图对应环节 */
const currentStage = computed(() => {
  const s = props.store.state;
  const stages = s.stages;
  const activeStage = stages.find((st) => st.active && !st.done);
  return activeStage?.label ?? null;
});

/** 路由结果摘要 */
const routeSummary = computed(() => {
  const s = props.store.state;
  if (!s.confidence) return null;
  return {
    confidence: s.confidence,
    tier: s.routeTier,
    winner: s.winnerModelId,
    decisionSource: s.decisionSource,
  };
});

/** 主链路 10 个环节定义 */
const pipelineSteps = [
  { id: 1, label: 'HTTP 接入', event: 'ROUTE_CREATED', desc: 'POST /v1/routes · prompt ≤ 5000 字符 · 生成 requestId' },
  { id: 2, label: '证据提取', event: '—', desc: 'prompt → RawEvidence · 7 类意图关键词 · complexity/capability/urgency/budget' },
  { id: 3, label: '经验读取 + 候选池过滤', event: 'EXPERIENCE_RETRIEVED', desc: '决策库阈值先读后用 · filterPool(白名单无交集→回落)' },
  { id: 4, label: '6 段状态装配', event: '—', desc: 'GOAL / FACTS / ARTIFACTS / EVIDENCE / CONSTRAINTS / OPTIONS' },
  { id: 5, label: 'Jev 五问决策', event: 'JEV_CALL_STARTED', desc: 'choice×1 + score×2 + noul×2 · 降级链: 失败→本地重实现' },
  { id: 6, label: '硬约束门（8 步）', event: 'CONSTRAINT_GATE_PASSED', desc: 'enabled→health→modality→context→data→risk→budget→latency' },
  { id: 7, label: '先验注入 + 打分 + softmax', event: 'JEV_DECISION_READY', desc: 'jevPriorDeltas ±4.0 · raw = Σw·cap/qual/cost/lat − 26·load²·² + Δ' },
  { id: 8, label: '置信度 → 三档路由', event: '—', desc: 'calibrate [0.35,0.97] · ≥0.82 ROUTE · ≥0.60 GATE · <0.60 ESCALATE' },
  { id: 9, label: 'tool_call 循环执行', event: 'MODEL_CALL_STARTED', desc: '≤3 轮 · round 0 注入 tools · get_weather / web_search' },
  { id: 10, label: '落库闭环', event: 'EXPERIENCE_SAVED', desc: '决策库热写回 + 动态阈值复算 + 模型库重评分 + 历史库' },
];

/** 三档路由颜色映射 */
function tierColor(tier: string | null): string {
  if (tier === 'ROUTE') return 'var(--ok)';
  if (tier === 'GATE') return 'var(--warn)';
  if (tier === 'ESCALATE') return 'var(--bad)';
  return 'var(--tx3)';
}

/** 左列：模型能力 框图（框间自上而下箭头流转） */
const modelColItems = [
  { t: '候选池供给', lines: ['Models API 实时清单', 'enabled && health ≠ down'] },
  { t: '模型画像', lines: ['capability / quality', 'cost / latency / price'] },
  { t: 'OPTIONS 菜单', lines: ['环节 ④ 实时重建', '避免过期菜单决策'] },
];

/** 右列：决策经验库 框图（框间自上而下箭头流转） */
const decisionColItems = [
  { t: '阈值供给（先读后用）', lines: ['static: {0.82, 0.60}', 'dynamic: p80/p50 复算'] },
  { t: '经验沉淀（热写回）', lines: ['per-model 统计', '胜率 / avgConfidence'] },
];
</script>

<template>
  <!-- 路由偏好 + 候选模型池 -->
  <div class="sec sec-select">
    <div class="sec-t">Jev 智能路由选择<span class="tag">类型化问答 · 置信度路由</span></div>
    <div class="selhead" data-pool-head>
      <span class="selstep"><i>1</i>候选模型池</span>
      <span class="dim">已选 {{ poolSelected.length }} / {{ poolModels.length }}</span>
    </div>
    <div v-if="poolError" class="warnbox" role="alert">⚠ {{ poolError }} · 本次按目录全量参与</div>
    <div v-else-if="poolModels.length === 0" class="empty">模型清单加载中…</div>
    <div v-else class="chip-row" data-pool>
      <button
        v-for="m in poolModels"
        :key="m.modelId"
        class="chip"
        :class="{ on: poolSelected.includes(m.modelId) }"
        :aria-pressed="poolSelected.includes(m.modelId)"
        :title="m.modelId"
        @click="togglePool(m.modelId)"
      >{{ m.modelId }}</button>
    </div>
    <div class="note">Jev 中枢先对 prompt 提出 5 个<b>类型化问题</b>（choice / score / noul），
      再按<b>校准置信度</b>分流：≥ 0.82 直接路由、≥ 0.60 标记观察、&lt; 0.60 转兜底模型（免费模型）。</div>
  </div>

  <div class="sec">
    <div class="sec-t">
      Jev 智能路由选择 · 判断逻辑流程
      <span class="tag">10 环节全链路</span>
    </div>

    <div class="note">
      Jev 中枢只判别「请求是什么、多有把握」，不指定最终模型（CONSTRAIN-3）。
      决策经验库供给阈值、模型能力提供候选池与画像，三者汇合于打分+softmax 处产出 winner。
    </div>

    <!-- 路由结果摘要（有结果时显示） -->
    <div v-if="routeSummary" class="route-summary" :style="{ borderColor: tierColor(routeSummary.tier) }">
      <div class="rs-item">
        <span class="rs-k">置信度</span>
        <span class="rs-v">{{ routeSummary.confidence!.toFixed(3) }}</span>
      </div>
      <div class="rs-item">
        <span class="rs-k">档位</span>
        <span class="rs-v" :style="{ color: tierColor(routeSummary.tier) }">{{ routeSummary.tier }}</span>
      </div>
      <div class="rs-item">
        <span class="rs-k">选中模型</span>
        <span class="rs-v">{{ routeSummary.winner ?? '--' }}</span>
      </div>
      <div class="rs-item">
        <span class="rs-k">决策来源</span>
        <span class="rs-v">{{ routeSummary.decisionSource ?? '--' }}</span>
      </div>
    </div>

    <!-- 2D 流程图：三列布局 -->
    <div class="flowchart">
      <!-- 左列：模型能力 -->
      <div class="col col-left">
        <div class="col-header" style="border-color: rgba(78,161,255,.4); color: #9ecbff; background: rgba(78,161,255,.08)">
          模型能力
        </div>
        <template v-for="(item, i) in modelColItems" :key="item.t">
          <div class="col-item">
            <div class="ci-t">{{ item.t }}</div>
            <div class="ci-d">
              <span v-for="(ln, j) in item.lines" :key="j" class="ci-l">{{ ln }}</span>
            </div>
          </div>
          <div v-if="i < modelColItems.length - 1" class="col-arrow-down">▼</div>
        </template>
        <div class="col-arrow">▸▸▸</div>
        <div class="col-note">画像 → 环节 ④⑤⑦<br>重评分 ← 环节 ⑩</div>
      </div>

      <!-- 中列：主链路 -->
      <div class="col col-main">
        <!-- 标题框：Jev 智能路由中枢（位于 HTTP 接入 上方） -->
        <div class="col-hub">
          <span class="hub-title">Jev 智能路由中枢</span>
          <span class="hub-sub">类型化问答 · 置信度路由 · 兜底模型</span>
        </div>
        <template v-for="step in pipelineSteps" :key="step.id">
          <div class="step" :class="{ active: currentStage === step.label }">
            <div class="step-id">{{ step.id }}</div>
            <div class="step-body">
              <div class="step-label">{{ step.label }}</div>
              <div class="step-event" v-if="step.event !== '—'">{{ step.event }}</div>
            </div>
            <div class="step-desc">{{ step.desc }}</div>
          </div>
          <div v-if="step.id < pipelineSteps.length" class="step-arrow">▼</div>
          <!-- 三档分支（环节 8 之后） -->
          <div v-if="step.id === 8" class="tier-branch">
            <div class="tb-item" style="--tc: var(--ok)">
              <span class="tb-tag">ROUTE</span>
              <span class="tb-desc">≥ 0.82 · 自动执行</span>
            </div>
            <div class="tb-item" style="--tc: var(--warn)">
              <span class="tb-tag">GATE</span>
              <span class="tb-desc">≥ 0.60 · 观察标记</span>
            </div>
            <div class="tb-item" style="--tc: var(--bad)">
              <span class="tb-tag">ESCALATE</span>
              <span class="tb-desc">&lt; 0.60 · 转兜底模型 · 免费模型</span>
            </div>
          </div>
        </template>
      </div>

      <!-- 右列：决策经验库 -->
      <div class="col col-right">
        <div class="col-header" style="border-color: rgba(255,181,71,.4); color: #ffd08a; background: rgba(255,181,71,.08)">
          决策经验库
        </div>
        <template v-for="(item, i) in decisionColItems" :key="item.t">
          <div class="col-item">
            <div class="ci-t">{{ item.t }}</div>
            <div class="ci-d">
              <span v-for="(ln, j) in item.lines" :key="j" class="ci-l">{{ ln }}</span>
            </div>
          </div>
          <div v-if="i < decisionColItems.length - 1" class="col-arrow-down">▼</div>
        </template>
        <div class="col-arrow">◂◂◂</div>
        <div class="col-note">阈值 → 环节 ③ 读取<br>结果 ← 环节 ⑩ 写回</div>
      </div>
    </div>

    <!-- 图例 -->
    <div class="legend-bar">
      <div class="lg-item"><span class="lg-dot" style="background: var(--ok)"></span>ROUTE 直接路由</div>
      <div class="lg-item"><span class="lg-dot" style="background: var(--warn)"></span>GATE 标记观察</div>
      <div class="lg-item"><span class="lg-dot" style="background: var(--bad)"></span>ESCALATE 转兜底模型</div>
      <div class="lg-item"><span class="lg-dot" style="background: var(--acc)"></span>当前激活环节</div>
    </div>
  </div>
</template>

<style scoped>
/* 中列顶部标题框：Jev 智能路由中枢（alignitems 与 col-header 一致的 11px 字号体系） */
.col-hub {
  width: 100%;
  box-sizing: border-box;
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 10px;
  padding: 8px 10px;
  margin-bottom: 6px;
  border: 1px solid var(--acc);
  border-radius: var(--r-s);
  background: linear-gradient(135deg, rgba(78,161,255,.12), rgba(16,26,46,.4));
}
.hub-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--tx0);
  letter-spacing: .5px;
  white-space: nowrap;
}
.hub-sub {
  font-size: 9.5px;
  color: var(--tx2);
  letter-spacing: .3px;
  white-space: nowrap;
}

.route-summary {
  display: flex;
  gap: 0;
  margin: 8px 0 12px;
  border: 1px solid var(--line2);
  border-radius: var(--r-m);
  overflow: hidden;
  background: rgba(11, 18, 33, .6);
}
.rs-item {
  flex: 1;
  padding: 6px 10px;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rs-item:last-child { border-right: none; }
.rs-k {
  font-size: 9px;
  color: var(--tx3);
  text-transform: uppercase;
  letter-spacing: .5px;
}
.rs-v {
  font-size: 13px;
  font-weight: 600;
  color: var(--tx0);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

.flowchart {
  display: grid;
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 2.4fr) minmax(0, 0.8fr);
  gap: 10px;
  margin-top: 8px;
}

/* 三列共用 */
.col {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  min-width: 0;
}

.col-header {
  width: 100%;
  text-align: center;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .5px;
  padding: 6px 8px;
  border: 1px solid var(--line2);
  border-radius: var(--r-s);
  margin-bottom: 4px;
}

.col-item {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: var(--r-s);
  background: rgba(16, 26, 46, .4);
  margin-bottom: 4px;
}
.ci-t {
  font-size: 10px;
  font-weight: 600;
  color: var(--tx1);
  margin-bottom: 3px;
}
.ci-d {
  font-size: 9.5px;
  color: var(--tx2);
  line-height: 1.5;
}
.ci-l {
  display: block;
}

/* 列内框图之间的向下箭头（指向下一框） */
.col-arrow-down {
  text-align: center;
  font-size: 9px;
  color: var(--tx3);
  line-height: 1;
  margin: 0 0 5px;
}

.col-arrow {
  font-size: 10px;
  color: var(--tx3);
  letter-spacing: 2px;
  margin: 2px 0;
}

.col-note {
  font-size: 9px;
  color: var(--tx3);
  text-align: center;
  line-height: 1.6;
  margin-top: 4px;
}

/* 中列主链路 */
.col-main {
  gap: 0;
}

.step {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  align-items: start;
  gap: 3px 8px;
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-s);
  background: rgba(16, 26, 46, .35);
  transition: border-color .2s, background .2s;
}
.step.active {
  border-color: var(--acc);
  background: rgba(78, 161, 255, .1);
  box-shadow: 0 0 12px rgba(78, 161, 255, .15);
}

.step-id {
  grid-column: 1;
  grid-row: 1;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--bg2);
  border: 1px solid var(--line2);
  display: grid;
  place-items: center;
  font-size: 10px;
  font-weight: 700;
  color: var(--tx2);
}
.step.active .step-id {
  background: var(--acc);
  border-color: var(--acc);
  color: #06101f;
}

.step-body {
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px 6px;
  flex-wrap: wrap;
}
.step-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--tx0);
  white-space: nowrap;
}
.step-event {
  font-size: 8.5px;
  font-family: var(--mono);
  padding: 1px 5px;
  border-radius: 10px;
  background: rgba(78, 161, 255, .1);
  border: 1px solid var(--line);
  color: var(--tx2);
  white-space: nowrap;
}

.step-desc {
  grid-column: 1 / -1;
  grid-row: 2;
  min-width: 0;
  font-size: 9px;
  color: var(--tx3);
  line-height: 1.5;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.step-arrow {
  text-align: center;
  font-size: 10px;
  color: var(--tx3);
  line-height: 1;
  margin: 2px 0;
}

/* 三档分支 */
.tier-branch {
  display: flex;
  gap: 6px;
  margin: 4px 0 6px;
  padding: 6px 8px;
  border: 1px dashed var(--line2);
  border-radius: var(--r-s);
  background: rgba(16, 26, 46, .25);
}
.tb-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
  border-radius: var(--r-s);
  border: 1px solid var(--tc);
  background: color-mix(in srgb, var(--tc) 8%, transparent);
}
.tb-tag {
  font-size: 10px;
  font-weight: 700;
  color: var(--tc);
  letter-spacing: .5px;
}
.tb-desc {
  font-size: 8.5px;
  color: var(--tx3);
  text-align: center;
  line-height: 1.4;
}

/* 图例 */
.legend-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 12px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-s);
  background: rgba(16, 26, 46, .3);
}
.lg-item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: var(--tx2);
}
.lg-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
}
</style>
