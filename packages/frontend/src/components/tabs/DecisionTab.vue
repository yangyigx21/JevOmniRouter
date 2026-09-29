<script setup lang="ts">
/**
 * DecisionTab — 决策经验库（LLM-sdd.md 二）
 *
 * 展示后端决策信息库的实时快照：
 * - 置信度路由阈值（动态/静态来源）
 * - 累计决策数与档位分布
 * - per-model 决策统计（被选次数 / 胜率 / 平均置信度）
 * - 最近决策明细（Jev 五问、候选分布、硬约束淘汰、执行统计）
 */
import { ref, computed, onMounted } from 'vue';
import { fetchDecisionStore, type DecisionStoreSnapshot } from '../../api/client.js';

const snapshot = ref<DecisionStoreSnapshot | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);
/** 最近决策明细中展开的 requestId。 */
const selectedId = ref<string | null>(null);
/** 模型决策统计中展开的 modelId。 */
const expandedModelId = ref<string | null>(null);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    snapshot.value = await fetchDecisionStore();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '决策信息库拉取失败';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const modelStats = computed(() => {
  const models = snapshot.value?.models ?? {};
  return Object.values(models).sort((a, b) => b.selectedCount - a.selectedCount);
});

const selected = computed(
  () => snapshot.value?.recent.find((r) => r.requestId === selectedId.value) ?? null,
);

/**
 * 展开的模型统计详情：聚合该模型近期被选中的决策记录，
 * 与决策信息库中的业界评分来源/时间等补充字段一并呈现。
 */
const expandedModel = computed(() => {
  const mid = expandedModelId.value;
  if (!mid || !snapshot.value) return null;
  const m = snapshot.value.models[mid];
  if (!m) return null;
  const recentPicks = snapshot.value.recent
    .filter((r) => r.selectedModelId === mid)
    .slice(0, 5);
  return { stat: m, recentPicks };
});

function pct(total: number, part: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

function tierColor(tier: string): string {
  if (tier === 'ROUTE') return 'var(--ok)';
  if (tier === 'GATE') return 'var(--warn)';
  return 'var(--bad)';
}

function pick(r: { requestId: string }) {
  selectedId.value = selectedId.value === r.requestId ? null : r.requestId;
}

function toggleModel(modelId: string) {
  expandedModelId.value = expandedModelId.value === modelId ? null : modelId;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}
</script>

<template>
  <div class="sec">
    <div class="sec-t">
      决策经验库
      <span class="tag">{{ snapshot?.thresholdSource === 'dynamic' ? '动态阈值' : '静态阈值' }}</span>
      <button class="linkbtn" style="margin-left:auto" :disabled="loading" @click="load">
        {{ loading ? '刷新中…' : '刷新' }}
      </button>
    </div>

    <div v-if="error" class="warnbox" role="alert">⚠ {{ error }}</div>
    <div v-else-if="!snapshot" class="empty">加载中…</div>

    <template v-else>
      <div class="kpis">
        <div class="kpi">
          <div class="k">决策总数</div>
          <div class="v">{{ snapshot.totals.decisions }}</div>
        </div>
        <div class="kpi">
          <div class="k">直接路由 high</div>
          <div class="v">{{ snapshot.thresholds.high.toFixed(2) }}</div>
        </div>
        <div class="kpi">
          <div class="k">标记观察 mid</div>
          <div class="v">{{ snapshot.thresholds.mid.toFixed(2) }}</div>
        </div>
        <div class="kpi">
          <div class="k">更新于</div>
          <div class="v" style="font-size:11px">{{ fmtTime(snapshot.updatedAt) }}</div>
        </div>
      </div>

      <div class="bars" style="margin-top:10px">
        <div class="brow">
          <span class="nm">ROUTE</span>
          <div class="bar"><i :style="{ width: pct(snapshot.totals.decisions, snapshot.totals.byTier.ROUTE) + '%', background: 'var(--ok)' }"></i></div>
          <span class="v">{{ snapshot.totals.byTier.ROUTE }}</span>
        </div>
        <div class="brow">
          <span class="nm">GATE</span>
          <div class="bar"><i :style="{ width: pct(snapshot.totals.decisions, snapshot.totals.byTier.GATE) + '%', background: 'var(--warn)' }"></i></div>
          <span class="v">{{ snapshot.totals.byTier.GATE }}</span>
        </div>
        <div class="brow">
          <span class="nm">ESCALATE</span>
          <div class="bar"><i :style="{ width: pct(snapshot.totals.decisions, snapshot.totals.byTier.ESCALATE) + '%', background: 'var(--bad)' }"></i></div>
          <span class="v">{{ snapshot.totals.byTier.ESCALATE }}</span>
        </div>
      </div>

      <div v-if="snapshot.industrySync" class="note">
        业界评分同步：{{ snapshot.industrySync.matched }} 条 · 来源 {{ snapshot.industrySync.sourceLabel }}
        · {{ fmtTime(snapshot.industrySync.syncedAt) }}
        <span v-if="snapshot.industrySync.unmatched.length">
          · 未匹配 {{ snapshot.industrySync.unmatched.length }} 个
        </span>
      </div>

      <div class="sub-t" style="margin-top:14px">模型决策统计<span class="tag">{{ modelStats.length }}</span><span class="dim" style="margin-left:auto;font-size:11px">点击展开详情</span></div>
      <div v-if="modelStats.length === 0" class="empty" style="padding:12px">尚无模型被选中</div>
      <div v-else style="display:flex;flex-direction:column;gap:6px">
        <div
          v-for="m in modelStats"
          :key="m.modelId"
          class="hcard"
          :class="{ act: expandedModelId === m.modelId }"
          style="cursor:pointer"
          @click="toggleModel(m.modelId)"
        >
          <div class="ht">
            <span class="caret" :class="{ open: expandedModelId === m.modelId }">▸</span>
            {{ m.modelId }}
          </div>
          <div class="hm">
            <i :style="{ background: 'var(--acc1)' }"></i>
            被选 {{ m.selectedCount }} / 候选 {{ m.candidateCount }} · 胜率 {{ (m.winRate * 100).toFixed(0) }}%
            · 平均置信 {{ m.avgConfidence.toFixed(2) }}
            <span v-if="m.industryScore !== undefined" class="pill w">
              业界 {{ m.industryScore.toFixed(2) }}<template v-if="m.industryRank"> · #{{ m.industryRank }}</template>
            </span>
            <span class="dim" style="margin-left:auto">{{ m.lastSelectedAt ? fmtTime(m.lastSelectedAt) : '--' }}</span>
          </div>
          <div v-if="expandedModelId === m.modelId && expandedModel" class="mexp">
            <div class="drow"><span class="k">平均候选概率</span><span class="v">{{ expandedModel.stat.avgProbability.toFixed(3) }}</span></div>
            <div class="drow"><span class="k">候选/胜出</span><span class="v">{{ expandedModel.stat.candidateCount }} / {{ expandedModel.stat.selectedCount }}</span></div>
            <div class="drow"><span class="k">胜率</span><span class="v">{{ (expandedModel.stat.winRate * 100).toFixed(1) }}%</span></div>
            <div class="drow"><span class="k">平均置信</span><span class="v">{{ expandedModel.stat.avgConfidence.toFixed(3) }}</span></div>
            <div v-if="expandedModel.stat.industryScore !== undefined" class="drow">
              <span class="k">业界评分</span>
              <span class="v">
                {{ expandedModel.stat.industryScore.toFixed(2) }}<template v-if="expandedModel.stat.industryRank"> · 排名 #{{ expandedModel.stat.industryRank }}</template>
                <template v-if="expandedModel.stat.industrySource"> · {{ expandedModel.stat.industrySource }}</template>
                <template v-if="expandedModel.stat.industryRatedAt"> · {{ fmtTime(expandedModel.stat.industryRatedAt) }}</template>
              </span>
            </div>
            <div class="drow"><span class="k">最后选中</span><span class="v">{{ expandedModel.stat.lastSelectedAt ? fmtTime(expandedModel.stat.lastSelectedAt) : '--' }}</span></div>
            <div v-if="expandedModel.recentPicks.length > 0" class="m-sub-t">该模型近期被选中的决策（{{ expandedModel.recentPicks.length }}）</div>
            <div v-else class="m-sub-t dim">该模型暂无近期被选中记录</div>
            <div v-if="expandedModel.recentPicks.length > 0" class="picks">
              <div v-for="rp in expandedModel.recentPicks" :key="rp.requestId" class="pick-row" @click.stop="pick(rp)">
                <i :style="{ background: tierColor(rp.routeTier) }"></i>
                <span class="mono">{{ rp.requestId.slice(0, 12) }}</span>
                <span class="dim">{{ rp.routeTier }} · CONF {{ rp.confidence.toFixed(2) }}</span>
                <span class="dim" style="margin-left:auto">{{ fmtTime(rp.createdAt) }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="sub-t" style="margin-top:14px">最近决策明细<span class="tag">{{ snapshot.recent.length }}</span><span class="dim" style="margin-left:auto;font-size:11px">点击展开详情</span></div>
      <div v-if="snapshot.recent.length === 0" class="empty" style="padding:12px">尚无决策记录</div>
      <div v-else style="display:flex;flex-direction:column;gap:6px">
        <div
          v-for="r in snapshot.recent"
          :key="r.requestId"
          class="hcard"
          :class="{ act: selectedId === r.requestId }"
          style="cursor:pointer"
          @click="pick(r)"
        >
          <div class="ht">
            <span class="caret" :class="{ open: selectedId === r.requestId }">▸</span>
            {{ r.requestId }}
          </div>
          <div class="hm">
            <i :style="{ background: tierColor(r.routeTier) }"></i>
            {{ r.selectedModelId || '--' }} · {{ r.routeTier }} · CONF {{ r.confidence.toFixed(2) }}
            · {{ r.decisionSource }}
            <span class="dim" style="margin-left:auto">{{ fmtTime(r.createdAt) }}</span>
          </div>
        </div>
      </div>

      <div
        v-if="selected"
        class="sec"
        style="margin-top:10px;border:1px solid var(--bd);border-radius:8px;padding:10px"
      >
        <div class="sec-t">决策详情 · {{ selected.decisionId }}</div>
        <div style="font-size:11px;line-height:1.7;color:var(--tx2)">
          <div>选中模型：<b>{{ selected.selectedModelId || '--' }}</b>（Jev 建议：{{ selected.jevRecommendation ?? '--' }}）</div>
          <div>阈值：high {{ selected.thresholds.high }} / mid {{ selected.thresholds.mid }}</div>
          <div v-if="selected.jevAnswers.length">
            Jev 五问：{{ selected.jevAnswers.map((a) => `${a.tag}=${a.value}`).join(' · ') }}
          </div>
          <div v-if="selected.eliminated.length">
            硬约束淘汰：{{ selected.eliminated.map((e) => `${e.modelId}(${e.reason})`).join(' · ') }}
          </div>
          <div v-if="selected.execution">
            执行：{{ selected.execution.modelId }} · {{ selected.execution.latencyMs }}ms ·
            {{ selected.execution.promptTokens }}+{{ selected.execution.completionTokens }} tokens ·
            ${{ selected.execution.costUsd.toFixed(5) }} · {{ selected.execution.status }}
            <span v-if="selected.execution.errorMessage" style="color:var(--bad)"> · {{ selected.execution.errorMessage }}</span>
          </div>
          <div>结果长度：{{ selected.resultLength }} 字符</div>
        </div>
        <div class="bars" style="margin-top:8px">
          <div v-for="d in selected.distribution" :key="d.modelId" class="brow">
            <span class="nm">{{ d.modelId }}</span>
            <div class="bar"><i :style="{ width: (d.probability * 100).toFixed(1) + '%', background: 'var(--acc2)' }"></i></div>
            <span class="v">{{ d.probability.toFixed(2) }}</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 展开箭头：收起时朝右，展开时旋转 90° 朝下 */
.caret {
  display: inline-block;
  width: 10px;
  font-size: 9px;
  color: var(--tx3, #8b949e);
  transition: transform .16s ease;
  transform: rotate(0deg);
  margin-right: 2px;
}
.caret.open { transform: rotate(90deg); }

/* 展开态卡片高亮边框 */
.hcard.act {
  border-color: var(--acc1, #4ea1ff);
  background: rgba(78, 161, 255, 0.06);
}

/* 模型统计展开详情容器 */
.mexp {
  margin-top: 6px;
  padding: 8px 10px;
  border-top: 1px solid var(--line, #21262d);
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 10px;
  color: var(--tx2, #8b949e);
}

/* 详情行：标签 + 值 */
.drow {
  display: flex;
  align-items: baseline;
  gap: 8px;
  line-height: 1.6;
}
.drow .k {
  flex: 0 0 auto;
  width: 72px;
  color: var(--tx3, #6e7681);
}
.drow .v {
  flex: 1;
  color: var(--tx1, #e6edf3);
  font-family: var(--mono, monospace);
  font-variant-numeric: tabular-nums;
  word-break: break-all;
}

/* 展开详情中的子标题 */
.m-sub-t {
  margin-top: 6px;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: .3px;
  color: var(--tx2, #8b949e);
}
.m-sub-t.dim { font-weight: 400; }

/* 近期被选中决策列表 */
.picks {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 4px;
}
.pick-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 9.5px;
  padding: 3px 6px;
  border-radius: 5px;
  background: rgba(6, 11, 21, 0.5);
  cursor: pointer;
  transition: background .15s ease;
}
.pick-row:hover {
  background: rgba(78, 161, 255, 0.08);
}
.pick-row i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex: 0 0 auto;
}
</style>
