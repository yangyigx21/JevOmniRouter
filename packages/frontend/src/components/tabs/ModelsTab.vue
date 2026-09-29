<script setup lang="ts">
/**
 * ModelsTab — 模型能力（LLM-sdd.md 三）
 *
 * 重新定义为四维度评估，为最终智能路由选择提供信息：
 * - 总体评价：决策区分度评分 + 业界评分 + 冷启动标记
 * - 能力：capability / quality / capabilityTags / contextWindow / modalities
 * - 价格：inputPricePer1k / outputPricePer1k / 免费模型标记
 * - 胜出记录：被选次数 / 候选次数 / 胜率 / 平均置信度 / 平均延迟
 */
import { ref, computed, onMounted } from 'vue';
import type { Store } from '../../store/createStore.js';
import type { RouteState, RouteAction } from '../../store/routeEventReducer.js';
import { withVendorColors } from '../../store/routeEventReducer.js';
import {
  fetchModelInfo,
  fetchConfig,
  refreshModelInfo,
  type ModelInfoSnapshot,
  type PublicConfig,
} from '../../api/client.js';

const props = defineProps<{
  store: Store<RouteState, RouteAction>;
}>();

const info = ref<ModelInfoSnapshot | null>(null);
const config = ref<PublicConfig | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);

const COLORS = ['#4ea1ff', '#8b5cff', '#31d0d8', '#22d39a', '#ffb547', '#ff5f6d', '#f78fb3', '#9ccc65'];

async function load(refresh = false) {
  loading.value = true;
  error.value = null;
  try {
    info.value = refresh ? await refreshModelInfo() : await fetchModelInfo();
    const vendors = info.value?.vendors;
    if (vendors && vendors.length > 0) {
      props.store.dispatch({ type: 'SET_VENDOR_GROUPS', groups: withVendorColors(vendors) });
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : '模型信息库拉取失败';
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await load();
  try {
    config.value = await fetchConfig();
  } catch {
    /* 配置拉取失败不阻塞模型清单展示 */
  }
});

const models = computed(() =>
  // 按综合评级（极高 > 高 > 中 > 低）降序，同等级内按综合分降序
  [...(info.value?.models ?? [])]
    .map((m, i) => ({ ...m, color: COLORS[i % COLORS.length] }))
    .sort(
      (a, b) =>
        (RATING_RANK[overallRating(b)] ?? -1) - (RATING_RANK[overallRating(a)] ?? -1) ||
        overallScore(b) - overallScore(a),
    ),
);

const vendors = computed(() => info.value?.vendors ?? []);

const sourceLabel = computed(() => {
  switch (info.value?.source) {
    case 'models-api':
      return 'Models API 实时清单';
    case 'config-fallback':
      return '配置回落清单';
    default:
      return '内置种子清单';
  }
});

/** 判断是否为免费模型 */
function isFreeModel(m: { profile: { inputPricePer1k: number; outputPricePer1k: number } }): boolean {
  return m.profile.inputPricePer1k === 0 && m.profile.outputPricePer1k === 0;
}

/** 综合评级排序权重（极高 > 高 > 中 > 低）。 */
const RATING_RANK: Record<string, number> = { 极高: 3, 高: 2, 中: 1, 低: 0 };

/** 综合评价数值（0..1）：区分度 × 0.6 + 业界评分 × 0.4，无业界评分时退化为区分度。 */
function overallScore(m: {
  discrimination: { score: number; rating: string; coldStart: boolean };
  industry: { score: number; rank?: number } | null;
}): number {
  const discScore = m.discrimination.score;
  const indScore = m.industry?.score;
  if (indScore !== null && indScore !== undefined) {
    return discScore * 0.6 + indScore * 0.4;
  }
  return discScore;
}

/** 综合评价等级：结合区分度与业界评分 */
function overallRating(m: Parameters<typeof overallScore>[0]): string {
  if (m.industry?.score !== null && m.industry?.score !== undefined) {
    const combined = overallScore(m);
    if (combined >= 0.75) return '极高';
    if (combined >= 0.55) return '高';
    if (combined >= 0.3) return '中';
    return '低';
  }
  return m.discrimination.rating;
}

function ratingColor(rating: string): string {
  if (rating === '极高') return 'var(--ok)';
  if (rating === '高') return 'var(--acc)';
  if (rating === '中') return 'var(--warn)';
  return 'var(--tx3)';
}
</script>

<template>
  <div class="sec">
    <div class="sec-t">
      模型能力
      <span class="tag">{{ sourceLabel }} · {{ models.length }} 个</span>
      <button class="linkbtn" style="margin-left:auto" :disabled="loading" @click="load(true)">
        {{ loading ? '刷新中…' : '重新拉取' }}
      </button>
    </div>

    <div v-if="info?.sourceError" class="warnbox" role="alert">⚠ {{ info.sourceError }}</div>
    <div v-else-if="error" class="warnbox" role="alert">⚠ {{ error }}</div>

    <div v-if="config" class="note">
      Jev 端点 <b>{{ config.jev.baseUrl }}</b>（{{ config.jev.hasApiKey ? '密钥已配置' : '未配置密钥' }}）·
      LLM 模型库 <b>{{ config.llmLibrary.baseUrl }}</b>
      （Chat {{ config.llmLibrary.useResponsesApi ? '未启用' : '启用' }} / Responses {{ config.llmLibrary.useResponsesApi ? '启用' : '未启用' }}）·
      路由阈值 high {{ config.routing.thresholds.high }} / mid {{ config.routing.thresholds.mid }}
    </div>

    <div class="note">
      四维度评估：总体评价（区分度×0.6 + 业界评分×0.4）· 能力（capability/quality/tags）· 价格（输入/输出单价）· 胜出记录（被选/候选/胜率/置信度）。
      为最终智能路由选择提供模型画像信息。
    </div>

    <div v-if="vendors.length > 0" class="note">
      左侧看板按厂商生成星球节点，共 <b>{{ vendors.length }}</b> 颗：
      <b v-for="v in vendors" :key="v.vendor">{{ v.vendorLabel }}({{ v.modelCount }})</b>
    </div>

    <div v-if="models.length === 0" class="empty">暂无模型</div>
    <div v-else style="display:flex;flex-direction:column;gap:8px">
      <div v-for="m in models" :key="m.modelId" class="mcard on" :style="{ '--mc': m.color }">
        <div class="mc-h">
          <span class="dot" :style="{ background: m.color }"></span>
          <span class="nm">{{ m.modelId }}</span>
          <span class="vd">{{ m.profile.vendorLabel }}</span>
          <span class="vd">{{ m.fromLiveCatalog ? 'LIVE' : 'FALLBACK' }}</span>
          <span v-if="isFreeModel(m)" class="pill ok">免费</span>
        </div>
        <div class="mc-d">{{ (m.profile.capabilityTags || []).join(' · ') || '模型' }}</div>

        <!-- 四维度评估 -->
        <div class="mc-m">
          <!-- 维度一：总体评价 -->
          <div class="dim-section">
            <div class="dim-t">总体评价</div>
            <div class="dim-body">
              <div class="mrow">
                <span class="k">综合评级</span>
                <span class="pill" :style="{ borderColor: ratingColor(overallRating(m)), color: ratingColor(overallRating(m)), background: 'transparent' }">{{ overallRating(m) }}</span>
                <span v-if="m.discrimination.coldStart" class="pill w">冷启动</span>
              </div>
              <div class="mrow">
                <span class="k">区分度</span>
                <div class="bar"><i :style="{ width: m.discrimination.score * 100 + '%', background: m.color }"></i></div>
                <span class="v">{{ m.discrimination.score.toFixed(2) }}</span>
              </div>
              <div v-if="m.industry" class="mrow">
                <span class="k">业界评分</span>
                <div class="bar"><i :style="{ width: m.industry.score * 100 + '%', background: 'var(--warn)' }"></i></div>
                <span class="v">
                  {{ m.industry.score.toFixed(2) }}<template v-if="m.industry.rank"> · #{{ m.industry.rank }}</template>
                </span>
              </div>
            </div>
          </div>

          <!-- 维度二：能力 -->
          <div class="dim-section">
            <div class="dim-t">能力</div>
            <div class="dim-body">
              <div class="mrow">
                <span class="k">能力</span>
                <div class="bar"><i :style="{ width: m.profile.capability * 100 + '%', background: m.color }"></i></div>
                <span class="v">{{ m.profile.capability.toFixed(2) }}</span>
              </div>
              <div class="mrow">
                <span class="k">质量</span>
                <div class="bar"><i :style="{ width: m.profile.quality * 100 + '%', background: m.color }"></i></div>
                <span class="v">{{ m.profile.quality.toFixed(2) }}</span>
              </div>
              <div class="mrow">
                <span class="k">延迟</span>
                <div class="bar"><i :style="{ width: m.profile.latency * 100 + '%', background: m.color }"></i></div>
                <span class="v">{{ m.profile.p95LatencyMs }}ms</span>
              </div>
              <div class="mrow">
                <span class="k">上下文</span>
                <span class="pill a">{{ Math.round((m.profile.contextWindow ?? 0) / 1000) }}K ctx</span>
                <span v-if="m.profile.modalities && m.profile.modalities.length" class="pill a">{{ m.profile.modalities.join(' · ') }}</span>
              </div>
            </div>
          </div>

          <!-- 维度三：价格 -->
          <div class="dim-section">
            <div class="dim-t">价格</div>
            <div class="dim-body">
              <div class="mrow">
                <span class="k">输入单价</span>
                <span class="v">${{ m.profile.inputPricePer1k }}/1K</span>
                <span v-if="isFreeModel(m)" class="pill ok">免费</span>
              </div>
              <div class="mrow">
                <span class="k">输出单价</span>
                <span class="v">${{ m.profile.outputPricePer1k }}/1K</span>
              </div>
              <div class="mrow">
                <span class="k">成本分</span>
                <div class="bar"><i :style="{ width: m.profile.cost * 100 + '%', background: m.color }"></i></div>
                <span class="v">{{ m.profile.cost.toFixed(2) }}</span>
              </div>
            </div>
          </div>

          <!-- 维度四：胜出记录 -->
          <div class="dim-section">
            <div class="dim-t">胜出记录</div>
            <div class="dim-body">
              <template v-if="m.stats">
                <div class="mrow">
                  <span class="k">被选/候选</span>
                  <span class="v">{{ m.stats.selectedCount }} / {{ m.stats.candidateCount }}</span>
                  <span class="pill a">胜率 {{ (m.stats.winRate * 100).toFixed(0) }}%</span>
                </div>
                <div class="mrow">
                  <span class="k">平均置信</span>
                  <div class="bar"><i :style="{ width: m.stats.avgConfidence * 100 + '%', background: m.color }"></i></div>
                  <span class="v">{{ m.stats.avgConfidence.toFixed(2) }}</span>
                </div>
                <div class="mrow">
                  <span class="k">平均概率</span>
                  <div class="bar"><i :style="{ width: m.stats.avgProbability * 100 + '%', background: m.color }"></i></div>
                  <span class="v">{{ m.stats.avgProbability.toFixed(3) }}</span>
                </div>
                <div class="mrow" v-if="m.stats.avgLatencyMs > 0">
                  <span class="k">平均延迟</span>
                  <span class="pill w">{{ m.stats.avgLatencyMs }}ms</span>
                </div>
              </template>
              <div v-else class="dim-empty">尚无决策记录</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 四维度分区 */
.dim-section {
  border-top: 1px solid var(--line);
  padding-top: 6px;
  margin-top: 6px;
}
.dim-section:first-child {
  border-top: none;
  padding-top: 0;
  margin-top: 0;
}
.dim-t {
  font-size: 9.5px;
  font-weight: 700;
  color: var(--acc);
  letter-spacing: .5px;
  text-transform: uppercase;
  margin-bottom: 5px;
}
.dim-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dim-empty {
  font-size: 10px;
  color: var(--tx3);
  padding: 4px 0;
}
</style>
