<script setup lang="ts">
/**
 * HistoryTab — 历史库（LLM-sdd.md 四）
 *
 * 后端按小时拆分 JSON 存储每次 Prompt 执行记录；本组件跨小时合并展示，
 * 支持搜索、查看详情。
 */
import { ref, computed, onMounted, watch } from 'vue';
import { fetchHistory, fetchHistoryStats, type HistoryEntryDto, type HistoryStatsResponse } from '../../api/client.js';

const props = defineProps<{
  /** 该页签是否处于激活态 —— 激活时重新拉取，保证新提交的 prompt 立即可见。 */
  active: boolean;
}>();

const emit = defineEmits<{
  'update:count': [count: number];
}>();

const entries = ref<HistoryEntryDto[]>([]);
const hours = ref<{ hourBucket: string; count: number }[]>([]);
const stats = ref<HistoryStatsResponse | null>(null);
const search = ref('');
const error = ref<string | null>(null);
const loading = ref(false);
const selectedId = ref<string | null>(null);
let searchTimer: ReturnType<typeof setTimeout> | null = null;

/** 对话框打开时按 Esc 关闭。 */
function onModalKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') selectedId.value = null;
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const [history, s] = await Promise.all([
      fetchHistory({ limit: 100, search: search.value || undefined }),
      fetchHistoryStats(),
    ]);
    entries.value = history.entries;
    hours.value = history.hours;
    stats.value = s;
    emit('update:count', history.total);
  } catch (err) {
    error.value = err instanceof Error ? err.message : '历史库拉取失败';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

// 所有页签都是常驻挂载的（靠 CSS 切换显示），组件不会重新 mount，
// 因此每次切到「历史」都必须主动重拉，否则新提交的 prompt 不会出现在列表里。
watch(() => props.active, (v) => { if (v) void load(); });

// 搜索防抖
watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void load(), 300);
});

const selected = computed(
  () => entries.value.find((e) => e.requestId === selectedId.value) ?? null,
);

function tierColor(tier: string): string {
  if (tier === 'ROUTE') return '#22d39a';
  if (tier === 'GATE') return '#ffb547';
  return '#ff5f6d';
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

function pick(e: HistoryEntryDto) {
  selectedId.value = selectedId.value === e.requestId ? null : e.requestId;
}

// ── 事件序列可读化（UI-1）────────────────────────────────────────────
// 后端事件类型是英文常量，直接展示对阅读者无意义；且 MODEL_STREAMING
// 每个增量记一次，会把序列刷成几十行重复文本，故按类型折叠计数。
const EVENT_LABELS: Record<string, string> = {
  ROUTE_CREATED: '创建路由请求',
  EXPERIENCE_RETRIEVED: '读取历史决策经验',
  JEV_CALL_STARTED: '调用 Jev 决策中枢',
  JEV_DECISION_READY: 'Jev 决策就绪',
  JEV_FALLBACK: 'Jev 降级为本地兜底',
  CONSTRAINT_FILTERED: '按硬约束淘汰候选模型',
  CONSTRAINT_GATE_PASSED: '通过硬约束校验',
  MODEL_SELECTED: '选定执行模型',
  MODEL_CALL_STARTED: '开始调用模型',
  MODEL_STREAMING: '模型流式输出',
  MODEL_COMPLETED: '模型调用完成',
  EXPERIENCE_SAVED: '回写决策经验',
  ROUTE_ESCALATED: '转兜底模型',
  ROUTE_FAILED: '路由失败',
};

interface EventStep {
  key: string;
  label: string;
  count: number;
}

/** 保留原始顺序，合并同类连续事件并计数。 */
function eventSteps(types: string[]): EventStep[] {
  const steps: EventStep[] = [];
  for (const t of types) {
    const last = steps[steps.length - 1];
    if (last && last.key === t) last.count++;
    else steps.push({ key: t, label: EVENT_LABELS[t] ?? t, count: 1 });
  }
  return steps;
}
</script>

<template>
  <div class="search">
    <input v-model="search" type="text" placeholder="搜索历史路由记录…" aria-label="搜索历史" />
  </div>

  <div v-if="stats" class="note">
    共 {{ stats.total }} 条执行记录，分布在 {{ stats.hours }} 个小时桶（当前 {{ stats.currentHour }}）·
    ROUTE {{ stats.byTier.ROUTE }} / GATE {{ stats.byTier.GATE }} / ESCALATE {{ stats.byTier.ESCALATE }}
  </div>

  <div v-if="error" class="warnbox" role="alert">⚠ {{ error }}</div>
  <div v-else-if="loading && entries.length === 0" class="empty">加载中…</div>
  <div v-else-if="entries.length === 0" class="empty">暂无历史记录</div>

  <div v-else style="display:flex;flex-direction:column;gap:6px" role="list" aria-label="历史路由记录">
    <button v-for="h in entries" :key="h.requestId" class="hcard" type="button" role="listitem" @click="pick(h)">
      <span class="ht">{{ h.promptSummary }}</span>
      <span class="hm">
        <i :style="{ background: tierColor(h.routeTier) }"></i>
        {{ h.selectedModelId || '--' }} · {{ h.routeTier }} · CONF {{ h.confidence.toFixed(2) }}
        · {{ h.execution.latencyMs }}ms
        <span class="dim" style="margin-left:auto">{{ fmtTime(h.createdAt) }}</span>
      </span>
    </button>
  </div>

  <!-- 点击记录后弹出的详情对话框。
       必须 Teleport 到 body：本页签处于 display:none 的 .tabview 内，
       不脱离该祖先则 fixed 定位元素也不会布局。 -->
  <Teleport to="body">
  <div v-if="selected" class="hdetail-modal" data-hdetail @keydown.esc="onModalKeydown" @click.self="selectedId = null">
    <div class="box" role="dialog" aria-modal="true" aria-labelledby="hd-title">
      <div id="hd-title" style="display:flex;align-items:flex-start;gap:8px">
        <div style="flex:1;min-width:0">
          <h2 style="margin:0;font-size:13px;line-height:1.4">{{ selected.promptSummary }}</h2>
          <div class="dim" style="font-size:10px;margin-top:3px;font-family:var(--mono)">
            {{ selected.requestId }}
          </div>
        </div>
        <button class="mini" type="button" data-hd-close aria-label="关闭详情" @click="selectedId = null">✕</button>
      </div>

      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:10px">
        <span class="chip"><i :style="{ background: tierColor(selected.routeTier) }"></i>{{ selected.routeTier }}</span>
        <span class="chip">CONF {{ selected.confidence.toFixed(2) }}</span>
        <span class="chip">{{ selected.selectedModelId }}</span>
        <span class="chip">{{ selected.hourBucket }}</span>
      </div>

      <div class="sub-t" style="margin-top:12px">路由元信息</div>
      <div class="kgrid" style="grid-template-columns:86px 1fr">
        <span class="dim">选型模型</span><b>{{ selected.selectedModelId }}</b>
        <span class="dim">JEV 建议</span><b>{{ selected.jevRecommendation || '—' }}</b>
        <span class="dim">决策来源</span><b>{{ selected.decisionSource }}</b>
        <span class="dim">时间桶</span><b>{{ selected.hourBucket }}</b>
        <span class="dim">记录时间</span><b>{{ fmtTime(selected.createdAt) }}</b>
        <span class="dim">决策 ID</span><b style="font-size:10.5px">{{ selected.decisionId }}</b>
        <span class="dim">阈值</span><b>high {{ selected.thresholds.high }} / mid {{ selected.thresholds.mid }}</b>
      </div>

      <div class="sub-t" style="margin-top:12px">Prompt 原文</div>
      <div class="resultbox" style="max-height:150px;overflow:auto">{{ selected.prompt || '（无）' }}</div>

      <div class="sub-t" style="margin-top:12px">模型输出</div>
      <div class="resultbox" style="max-height:200px;overflow:auto">{{ selected.result || '（无输出）' }}</div>

      <div class="sub-t" style="margin-top:12px">执行回执</div>
      <div class="kgrid" style="grid-template-columns:86px 1fr">
        <span class="dim">执行模型</span><b>{{ selected.execution.modelId }}</b>
        <span class="dim">状态</span><b :style="{ color: selected.execution.status === 'ok' ? 'var(--ok)' : 'var(--bad)' }">{{ selected.execution.status }}</b>
        <span class="dim">耗时</span><b>{{ selected.execution.latencyMs }} ms</b>
        <span class="dim">Token</span>
        <b>{{ selected.execution.promptTokens }} prompt + {{ selected.execution.completionTokens }} completion</b>
        <span class="dim">成本</span>
        <b>${{ selected.execution.costUsd.toFixed(5) }}<span v-if="selected.execution.usageSource === 'estimated'" style="color:var(--warn);margin-left:5px">（估算）</span></b>
      </div>
      <div v-if="selected.execution.errorMessage" class="warnbox">⚠ {{ selected.execution.errorMessage }}</div>

      <div class="sub-t" style="margin-top:12px">事件序列（共 {{ selected.eventTypes.length }} 条）</div>
      <ol v-if="eventSteps(selected.eventTypes).length" class="evlist">
        <li v-for="(s, i) in eventSteps(selected.eventTypes)" :key="`${s.key}-${i}`" class="evitem">
          <span class="evdot" :class="s.key.toLowerCase()"></span>
          <span class="evname">{{ s.label }}</span>
          <span v-if="s.count > 1" class="evcount">×{{ s.count }}</span>
          <code v-if="!EVENT_LABELS[s.key]" class="evraw">{{ s.key }}</code>
        </li>
      </ol>
      <div v-else class="dim" style="font-size:10.5px">—</div>
    </div>
  </div>
  </Teleport>

  <div v-if="hours.length > 0" class="sub-t" style="margin-top:14px">小时桶</div>
  <div v-if="hours.length > 0" style="display:flex;flex-wrap:wrap;gap:6px">
    <span v-for="h in hours" :key="h.hourBucket" class="chip" style="cursor:default">
      {{ h.hourBucket }} · {{ h.count }}
    </span>
  </div>
</template>
