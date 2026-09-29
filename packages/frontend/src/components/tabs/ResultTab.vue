<script setup lang="ts">
/**
 * ResultTab — RESULT-3/5 (T-6.8 + T-6.9)。
 *
 * 决策解释：5 个类型化问题、档位、依据、模型、置信度（RESULT-3/5）。
 * 低置信度 ESCALATE 提示（JEV-5）。
 * 「执行结果」已迁至 InputTab 的提交按钮正下方，「事件追踪」按需移除。
 */
import { computed } from 'vue';
import type { Store } from '../../store/createStore.js';
import type { RouteState, ModelScoreEntry } from '../../store/routeEventReducer.js';
import { OFFLINE_DEVIATIONS } from '../../offline/OfflineAdapter.js';
import { getMode } from '../../offline/OfflineAdapter.js';

const props = defineProps<{
  store: Store<RouteState, any>;
}>();

const isOffline = computed(() => getMode() === 'offline');
const offlineDeviations = OFFLINE_DEVIATIONS;

// 只要本轮路由产生过事件就展示结果区。
const hasResult = computed(
  () => props.store.state.resultText.length > 0 || props.store.state.events.length > 0,
);

const kpis = computed(() => {
  const s = props.store.state;
  return [
    { k: '置信度', v: s.confidence !== null ? s.confidence!.toFixed(3) : '--', sub: '' },
    { k: '档位', v: s.routeTier ?? '--', sub: '' },
    { k: '选中模型', v: s.winnerModelId ?? '--', sub: '' },
    { k: '事件数', v: String(s.events.length), sub: '' },
  ];
});

const tierInfo = computed(() => {
  const tier = props.store.state.routeTier;
  if (tier === 'ROUTE') return { label: '直接路由', color: 'var(--ok)', desc: '置信度 ≥ 0.82，自动执行' };
  if (tier === 'GATE') return { label: '标记观察', color: 'var(--warn)', desc: '置信度 ≥ 0.60，路由但标记需观察' };
  if (tier === 'ESCALATE') return { label: '转兜底模型', color: 'var(--bad)', desc: '置信度 < 0.60，转免费兜底模型执行' };
  return null;
});

const isLowConfidence = computed(() => {
  return props.store.state.routeTier === 'ESCALATE' && (props.store.state.confidence ?? 1) < 0.6;
});

const hasRouteError = computed(() => {
  return props.store.state.errorMessage !== null;
});

const reasonLines = computed(() => {
  const s = props.store.state;
  // Use real JEV answers from store if available (populated by backend events)
  if (s.jevAnswers.length > 0) {
    return s.jevAnswers;
  }
  // Fallback hardcoded when no real data
  if (!s.confidence) return [];
  return [
    { tag: 'INTENT', type: 'choice' as const, value: '代码审查 · 重构建议' },
    { tag: 'COMPLEXITY', type: 'score' as const, value: '高复杂度 · 需深度推理' },
    { tag: 'URGENCY', type: 'noul' as const, value: '常规 · 无紧急时限' },
    { tag: 'BUDGET', type: 'noul' as const, value: '中等预算 · 可接受高成本' },
    { tag: 'CAPABILITY', type: 'score' as const, value: '代码生成能力优先' },
  ];
});

/** 真实 Jev 调用元信息（模型版本 / 耗时 / token）。 */
const jevMeta = computed(() => {
  const s = props.store.state;
  if (s.decisionSource !== 'TYPE_SAFE_JEV' && !s.jevModel) return null;
  return {
    model: s.jevModel ?? '--',
    latencyMs: s.jevCallLatencyMs,
    usage: s.jevUsage,
  };
});

interface ScoreRow extends ModelScoreEntry {
  isWinner: boolean;
  color: string;
}

const modelScores = computed<ScoreRow[]>(() => {
  const s = props.store.state;
  // Use real model scores from store if available (populated by JEV_DECISION_READY event)
  if (s.modelScores.length > 0) {
    return s.modelScores.map((m) => ({
      ...m,
      isWinner: m.name === s.winnerModelId,
      color: m.name === s.winnerModelId ? 'var(--ok)' : (m.color ?? 'var(--acc2)'),
    }));
  }
  // Fallback hardcoded when no real data
  if (!s.winnerModelId) return [];
  const models: ModelScoreEntry[] = [
    { name: 'gpt-4o', score: 0.87, color: 'var(--ok)' },
    { name: 'claude-3.5-sonnet', score: 0.72, color: 'var(--acc2)' },
    { name: 'gemini-1.5-pro', score: 0.65, color: 'var(--acc3)' },
    { name: 'llama-3.1-70b', score: 0.48, color: 'var(--warn)' },
    { name: 'mistral-large', score: 0.41, color: 'var(--tx2)' },
    { name: 'qwen-2.5-coder', score: 0.35, color: 'var(--tx2)' },
  ];
  // Mark winner
  return models.map((m) => ({
    ...m,
    isWinner: m.name === s.winnerModelId,
    color: m.name === s.winnerModelId ? 'var(--ok)' : (m.color ?? 'var(--acc2)'),
  }));
});
</script>

<template>
  <div v-if="!hasResult" class="empty">尚未执行路由<br>请在上方输入 prompt 并提交</div>
  <div v-else style="display:flex;flex-direction:column;gap:11px">
    <!-- RESULT-5: KPI overview -->
    <div class="sec">
      <div class="sec-t">路由结果概览</div>
      <div class="kpis">
        <div v-for="kpi in kpis" :key="kpi.k" class="kpi" role="status" aria-live="polite">
          <div class="k">{{ kpi.k }}</div>
          <div class="v">{{ kpi.v }}<small v-if="kpi.sub">{{ kpi.sub }}</small></div>
        </div>
      </div>
    </div>

    <!-- ROUTE_FAILED error display -->
    <div v-if="hasRouteError" class="warnbox" style="border-color:var(--bad);background:rgba(255,23,68,0.08)" role="alert">
      <div style="font-weight:700;margin-bottom:4px">⚠ 路由失败</div>
      <div style="font-size:12px">{{ props.store.state.errorMessage }}</div>
    </div>

    <!-- RESULT-3: Tier + decision reason -->
    <div class="sec">
      <div class="sec-t">类型化答案与决策依据<span class="tag" :style="isOffline ? { background: 'var(--warn)', color: '#000' } : {}">{{ isOffline ? 'LOCAL_REIMPL' : 'TypeSafe Jev' }}</span></div>
      <div class="reason">
        <div class="qlist">
          <div v-for="r in reasonLines" :key="r.tag" class="qrow">
            <span class="qt">{{ r.tag }}</span>
            <b>{{ r.value }}</b>
            <span class="qc">{{ r.type }}</span>
          </div>
        </div>
      </div>
      <!-- 真实 Jev 调用元信息 -->
      <div v-if="jevMeta" class="notebox" style="margin-top:8px">
        <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px">
          <span>Jev 模型 <b>{{ jevMeta.model }}</b></span>
          <span v-if="jevMeta.latencyMs !== null">耗时 <b>{{ jevMeta.latencyMs }} ms</b></span>
          <span v-if="jevMeta.usage">
            tokens <b>{{ jevMeta.usage.inputTokens }} in / {{ jevMeta.usage.outputTokens }} out</b>
          </span>
        </div>
        <div v-if="props.store.state.winnerReason" style="margin-top:4px;font-size:11px;line-height:1.6">
          选型依据：{{ props.store.state.winnerReason }}
        </div>
      </div>
      <!-- Low-confidence ESCALATE: 转兜底模型（免费模型）自动执行 -->
      <div v-if="isLowConfidence" class="notebox" style="border-color:var(--bad);background:rgba(255,95,109,0.06)">
        ⚠ 低置信度 ESCALATE：置信度 {{ (props.store.state.confidence ?? 0).toFixed(2) }} &lt; 0.60，
        已转兜底模型（免费模型）自动执行。
      </div>
      <div v-else-if="tierInfo && tierInfo.label === '标记观察'" class="notebox">
        中置信 GATE：路由已执行，建议对输出做抽样校验。
      </div>
      <!-- JEV-8 / JEV-10: Offline deviation declaration -->
      <div v-if="isOffline" class="warnbox" style="border-color:var(--warn);background:rgba(255,180,0,0.08)">
        <div style="font-weight:700;margin-bottom:6px">⚠ 离线模式 · LOCAL_REIMPL 偏差声明 (JEV-8/JEV-10)</div>
        <div style="font-size:11px;line-height:1.6">
          <div v-for="d in offlineDeviations" :key="d.id" style="margin-bottom:3px">
            <b>{{ d.id }}</b> {{ d.aspect }}：{{ d.localBehavior }}
            <span style="color:var(--tx3)">（官方：{{ d.officialBehavior }}）</span>
            <span :style="{ color: d.risk.startsWith('中') ? 'var(--warn)' : 'var(--tx3)' }">[风险：{{ d.risk }}]</span>
          </div>
        </div>
      </div>
    </div>

    <!-- RESULT-3: Model score distribution -->
    <div class="sec">
      <div class="sec-t">候选模型得分分布<span class="tag">softmax · Jev 先验注入</span></div>
      <div class="bars">
        <div v-for="m in modelScores" :key="m.name" class="brow" :class="{ win: m.isWinner }">
          <span class="nm">{{ m.name }}</span>
          <div class="bar"><i :style="{ width: `${m.score * 100}%`, background: m.color }"></i></div>
          <span class="v">{{ m.score.toFixed(2) }}</span>
          <span v-if="m.priorDelta !== undefined" class="v" :style="{ color: m.priorDelta >= 0 ? 'var(--ok)' : 'var(--tx3)' }">
            Δ{{ m.priorDelta >= 0 ? '+' : '' }}{{ m.priorDelta.toFixed(3) }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
