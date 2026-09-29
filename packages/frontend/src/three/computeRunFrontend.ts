/**
 * computeRunFrontend — ANIM-1 / ANIM-3 (T-6.6).
 *
 * Deterministic timeline: same input → same output (ARCH-3).
 * Pure function: 3D layer reads and maps, never infers.
 *
 * Seven stages matching jev-demo.html:
 *   ingest → analyze → score → select → execute → return → done
 *
 * ANIM-3: Each stage has a visual type mapping (question ring / score ring /
 * selection ring), and tier (ROUTE / GATE / ESCALATE) has distinct color coding.
 *
 * Ported from jev-demo.html computeRun() for Vue 3 frontend.
 */

import { STAGE_COUNT as SHARED_STAGE_COUNT } from '@jev-router/shared';

// Stage name mapping (C7 alignment):
// shared:  state → questions → jev → probability → route → execute → result
// frontend: ingest → analyze → score → select → execute → return → done

/** Mapping from shared/backend stage names to frontend animation stage names (C7) */
export const SHARED_TO_FRONTEND_STAGE: Record<string, string> = {
  state: 'ingest',
  questions: 'analyze',
  jev: 'analyze',
  probability: 'score',
  route: 'select',
  execute: 'execute',
  result: 'return',
};

/** Tier color palette (ANIM-3 — 档位配色区分) */
export const TIER_COLORS: Record<string, { primary: string; glow: string; ring: string }> = {
  ROUTE:    { primary: '#00e676', glow: '#00e676', ring: '#00c853' },  // green — high confidence
  GATE:     { primary: '#ffc107', glow: '#ffc107', ring: '#ff9800' },  // amber — medium confidence
  ESCALATE: { primary: '#ff1744', glow: '#ff1744', ring: '#d50000' },  // red — low confidence
  IDLE:     { primary: '#90a4ae', glow: '#607d8b', ring: '#546e7a' },  // grey — no tier yet
};

/**
 * Stage visual mapping (ANIM-3 — 阶段视觉映射).
 * Each stage maps to a visual element type:
 *   - 'question-ring': JEV question orbit (analyze stage)
 *   - 'score-ring': model scoring glow (score stage)
 *   - 'selection-ring': winner selection pulse (select stage)
 *   - 'execution': model execution activity (execute stage)
 *   - 'passive': no active visual element
 */
export const STAGE_VISUAL_TYPE: Record<string, 'question-ring' | 'score-ring' | 'selection-ring' | 'execution' | 'passive'> = {
  ingest:  'passive',
  analyze: 'question-ring',
  score:   'score-ring',
  select:  'selection-ring',
  execute: 'execution',
  return:  'passive',
  done:    'passive',
};
function clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; }

/** Seven animation stages */
export const STAGES = [
  { id: 'ingest', name: 'Prompt 接入', short: '接入', dur: 900 },
  { id: 'analyze', name: 'JEV 类型化提问', short: '提问', dur: 1900 },
  { id: 'score', name: '候选模型评估', short: '评估', dur: 1400 },
  { id: 'select', name: '置信度路由决策', short: '决策', dur: 900 },
  { id: 'execute', name: '模型推理执行', short: '执行', dur: 2200 },
  { id: 'return', name: '结果回传汇聚', short: '回传', dur: 1000 },
  { id: 'done', name: '路由完成', short: '完成', dur: 0 },
] as const;

export type StageId = typeof STAGES[number]['id'];

export const TOTAL_DUR = STAGES.reduce((s, st) => s + st.dur, 0);

// ARCH-2 validation: ensure frontend stage count matches shared layer
if (STAGES.length !== SHARED_STAGE_COUNT) {
  console.warn(`[computeRunFrontend] Stage count mismatch: frontend=${STAGES.length}, shared=${SHARED_STAGE_COUNT}`);
}

/** Pre-computed stage start times */
export const STAGE_START: number[] = (() => {
  let acc = 0;
  const out: number[] = [];
  for (const st of STAGES) { out.push(acc); acc += st.dur; }
  return out;
})();

/** Easing functions (deterministic) */
function easeInOut(t: number): number {
  t = clamp(t, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeOut(t: number): number {
  t = clamp(t, 0, 1);
  return 1 - (1 - t) * (1 - t);
}

/** Get stage index and stage progress at time t */
export function stageAt(t: number): { idx: number; sp: number } {
  t = (typeof t === 'number' && isFinite(t)) ? clamp(t, 0, TOTAL_DUR) : 0;
  if (t >= TOTAL_DUR) return { idx: STAGES.length - 1, sp: 1 };
  let i = 0;
  while (i < STAGES.length - 1 && t >= STAGE_START[i] + STAGES[i].dur) i++;
  const dur = STAGES[i].dur || 1;
  return { idx: i, sp: clamp((t - STAGE_START[i]) / dur, 0, 1) };
}

/** Context for computeRun */
export interface ComputeRunContext {
  winnerIdx: number;
  nodeCount: number;
  probs: number[];
  confidence: number;
  tier: string;
}

/** Data packet state */
export interface PacketState {
  path: 'idle' | 'in' | 'orbit' | 'hub' | 'toNode' | 'back' | 'out';
  s: number;
  visible: boolean;
  winner: number;
}

/** ComputeRun result */
export interface ComputeRunResult {
  t: number;
  g: number;
  stageIdx: number;
  stageId: string;
  sp: number;
  stageName: string;
  stageDesc: string;
  /** ANIM-3: visual element type for this stage */
  visualType: 'question-ring' | 'score-ring' | 'selection-ring' | 'execution' | 'passive';
  /** ANIM-3: tier color palette based on route tier */
  tierColor: { primary: string; glow: string; ring: string };
  pIngest: number;
  pAnalyze: number;
  pScore: number;
  pSelect: number;
  pExec: number;
  pReturn: number;
  pDone: number;
  packet: PacketState;
  nodeGlow: number[];
  edgeFlow: number[];
  qAct: number[];
  selectRing: number;
  /** Score wave: expanding ring from hub during score stage (0→1 easeOut) */
  scoreWave: number;
  /** Select wave: convergence ring toward winner during select stage (0→1 easeOut) */
  selectWave: number;
  /** Execution intensity: sin pulse during execute stage (0→1→0) */
  execIntensity: number;
  /** Return intensity: flow intensity during return stage */
  returnIntensity: number;
}

/**
 * Compute animation parameters at time t.
 * Pure function — deterministic, no side effects (ARCH-3).
 */
export function computeRun(t: number, ctx: ComputeRunContext): ComputeRunResult {
  ctx = ctx || {} as ComputeRunContext;
  t = (typeof t === 'number' && isFinite(t)) ? clamp(t, 0, TOTAL_DUR) : 0;
  const winnerIdx = typeof ctx.winnerIdx === 'number' ? ctx.winnerIdx : 0;
  const n = ctx.nodeCount || 6;

  const st = stageAt(t);
  const idx = st.idx;
  const sp = st.sp;

  const byId: Record<string, number> = {};
  for (let i = 0; i < STAGES.length; i++) byId[STAGES[i].id] = i;

  const g = TOTAL_DUR > 0 ? clamp(t / TOTAL_DUR, 0, 1) : 1;

  // Per-stage progress
  function prog(id: string): number {
    const i = byId[id];
    if (idx > i) return 1;
    if (idx < i) return 0;
    return sp;
  }

  const pIngest = prog('ingest');
  const pAnalyze = prog('analyze');
  const pScore = prog('score');
  const pSelect = prog('select');
  const pExec = prog('execute');
  const pReturn = prog('return');
  const pDone = idx >= byId['done'] ? 1 : 0;

  // Data packet path & progress
  const packet: PacketState = { path: 'idle', s: 0, visible: false, winner: winnerIdx };
  if (idx === byId['ingest']) {
    packet.path = 'in'; packet.s = easeInOut(sp); packet.visible = true;
  } else if (idx === byId['analyze']) {
    packet.path = 'orbit'; packet.s = sp; packet.visible = true;
  } else if (idx === byId['score']) {
    packet.path = 'hub'; packet.s = sp; packet.visible = true;
  } else if (idx === byId['select']) {
    packet.path = 'hub'; packet.s = sp; packet.visible = true;
  } else if (idx === byId['execute']) {
    packet.path = 'toNode'; packet.s = easeInOut(sp); packet.visible = true;
  } else if (idx === byId['return']) {
    packet.visible = true;
    if (sp < 0.55) { packet.path = 'back'; packet.s = easeInOut(sp / 0.55); }
    else { packet.path = 'out'; packet.s = easeInOut((sp - 0.55) / 0.45); }
  } else if (idx >= byId['done']) {
    packet.path = 'out'; packet.s = 1; packet.visible = false;
  }

  // Question activation (5 questions in analyze stage)
  const qAct: number[] = [];
  const questionCount = 5;
  for (let d = 0; d < questionCount; d++) {
    qAct.push(clamp(pAnalyze * questionCount - d, 0, 1));
  }

  // Node glow (candidate nodes get glow proportional to their probability)
  const candidateCount = n - 3; // exclude prompt, jev-hub, knowledge
  const probs = ctx.probs && ctx.probs.length > 0
    ? ctx.probs
    : Array(Math.max(1, candidateCount)).fill(1 / Math.max(1, candidateCount));

  const nodeGlow: number[] = [];
  for (let k = 0; k < candidateCount; k++) {
    let glow = 0;
    if (idx >= byId['score'] && idx < byId['done']) {
      const prob = probs[k] ?? 0;
      glow = prob * 2;
      // select 阶段起，非 winner 按进度衰减到 0（pSelect∈[0,1]），
      // 使 winner（glow=2.5+）与非 winner 视觉对比鲜明。
      if (idx >= byId['select'] && k !== winnerIdx) {
        glow *= (1 - pSelect);
      }
    }
    // winner 从 score 阶段起就获得额外高亮（高于普通候选最高 prob*2=2.0），
    // 确保评分阶段 winner 已比非 winner 更亮，与实际路由选择一致。
    if (k === winnerIdx && idx >= byId['score'] && idx < byId['select']) {
      glow = Math.max(glow, 2.2);
    }
    if (k === winnerIdx && idx >= byId['select']) {
      glow = 2.5 + (idx >= byId['execute'] ? 0.5 : 0);
    }
    nodeGlow.push(glow);
  }

  // Edge flow
  const edgeFlow: number[] = [];
  // New edge index order (matches buildEdgeDefs):
  //   e0: prompt→hub (ingest)
  //   e1..e6: hub→candidate (analyze)
  //   e7..e12: candidate→knowledge (execute/return)
  const edgeCount = 1 + candidateCount * 2;
  for (let e = 0; e < edgeCount; e++) {
    let flow = 0;
    if (e === 0 && pIngest > 0) flow = pIngest; // prompt→hub
    else if (e >= 1 && e < 1 + candidateCount) {
      // hub→candidate edges
      const ci = e - 1;
      flow = (nodeGlow[ci] ?? 0) * 0.5;
    } else if (e >= 1 + candidateCount && e < 1 + candidateCount * 2) {
      // candidate→knowledge edges
      const ci = e - 1 - candidateCount;
      flow = (nodeGlow[ci] ?? 0) * 0.4;
      if (pReturn > 0) flow = Math.max(flow, pReturn);
    }
    edgeFlow.push(clamp(flow, 0, 1));
  }

  // Select ring pulse
  const selectRing = idx >= byId['select'] ? 0.5 + Math.sin(sp * Math.PI) * 0.5 : 0;

  // Score wave: expanding ring from hub during score stage
  const scoreWave = (idx === byId['score']) ? easeOut(sp) : (idx > byId['score'] ? 1 : 0);

  // Select wave: convergence ring toward winner during select stage
  const selectWave = (idx === byId['select']) ? easeOut(sp) : 0;

  // Execution intensity: sin pulse during execute stage
  const execIntensity = (idx === byId['execute']) ? Math.sin(sp * Math.PI) : 0;

  // Return intensity
  const returnIntensity = (idx === byId['return']) ? easeInOut(sp) : 0;

  return {
    t, g, stageIdx: idx, stageId: STAGES[idx].id, sp,
    stageName: STAGES[idx].name,
    stageDesc: (STAGES[idx] as any).desc ?? STAGES[idx].name,
    visualType: STAGE_VISUAL_TYPE[STAGES[idx].id] ?? 'passive',
    tierColor: TIER_COLORS[ctx.tier] ?? TIER_COLORS.IDLE,
    pIngest, pAnalyze, pScore, pSelect, pExec, pReturn, pDone,
    packet, nodeGlow, edgeFlow, qAct, selectRing,
    scoreWave, selectWave, execIntensity, returnIntensity,
  };
}
