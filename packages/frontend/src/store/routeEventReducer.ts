/**
 * routeEventReducer — ANIM-6 (T-6.3).
 *
 * Event-driven state: all node/edge states SHALL be driven by RouteEvent,
 * SHALL NOT self-infer.
 *
 * The reducer processes RouteEvent actions and updates the visualization state.
 * The 3D renderer reads from this state; it SHALL NOT directly modify it.
 */
import type { RouteEventType, RouteEvent } from './types.js';

/**
 * Map shared/backend stage names to frontend animation stage names (C7).
 *
 * shared:  state → questions → jev → probability → route → execute → result
 * frontend: ingest → analyze → score → select → execute → return → done
 */
export function sharedStageToFrontend(sharedStage: string): string {
  const mapping: Record<string, string> = {
    state: 'ingest',
    questions: 'analyze',
    jev: 'analyze',
    probability: 'score',
    route: 'select',
    execute: 'execute',
    result: 'return',
    // Additional reducer-internal stages
    constraint: 'select',
    experience: 'return',
  };
  return mapping[sharedStage] ?? sharedStage;
}

/** Frontend animation stage order (C7 aligned with computeRunFrontend.ts) */
const FRONTEND_STAGE_ORDER = ['ingest', 'analyze', 'score', 'select', 'execute', 'return', 'done'] as const;

export interface NodeVisualState {
  id: string;
  label: string;
  type: NodeType;
  x: number;
  y: number;
  z: number;
  active: boolean;
  highlighted: boolean;
  greyedOut: boolean;
  loadPercent: number;
  score?: number;
  isWinner: boolean;
  /** 星球节点（厂商）所辖的 modelId 列表；用于把模型级事件映射到厂商节点。 */
  modelIds?: readonly string[];
}

export type NodeType = 'prompt' | 'jev-hub' | 'candidate' | 'knowledge';

export interface StageState {
  id: string;
  label: string;
  active: boolean;
  done: boolean;
  progress: number;
}

export interface ModelScoreEntry {
  name: string;
  score: number;
  color?: string;
  isWinner?: boolean;
  /** Jev 先验修正量（softmax 前注入）。 */
  priorDelta?: number;
  rankIndex?: number;
}

/** Jev 五问展示条目 —— 字段与后端 `normalizeAnswersForDisplay` 输出一致。 */
export interface JevAnswerEntry {
  tag: string;
  type: 'choice' | 'score' | 'noul';
  value: string;
}

/** 星球（厂商）调色板 —— 3D 星球节点按厂商稳定取色。 */
export const VENDOR_PALETTE: readonly number[] = [
  0x4ea1ff, 0x22d39a, 0xffb547, 0x8b5cff, 0x31d0d8, 0xff5f6d, 0x7cc45a, 0xff9f43,
];

/** 星球（厂商）分组 —— 3D 候选节点的数据源。 */
export interface VendorGroup {
  vendor: string;
  vendorLabel: string;
  modelCount: number;
  modelIds: readonly string[];
  topDiscrimination: number;
  /** 星球颜色（十六进制）。 */
  color: number;
}

/**
 * 离线兜底星球分组（后端不可达时保证 3D 场景仍有候选节点）。
 * 顺序即节点顺序，勿随意调整。
 */
const FALLBACK_VENDOR_GROUPS: readonly Omit<VendorGroup, 'color'>[] = [
  { vendor: 'openai', vendorLabel: 'OpenAI', modelCount: 1, modelIds: ['gpt-4o'], topDiscrimination: 0.6 },
  { vendor: 'anthropic', vendorLabel: 'Anthropic', modelCount: 1, modelIds: ['claude-3.5-sonnet'], topDiscrimination: 0.6 },
  { vendor: 'google', vendorLabel: 'Google', modelCount: 1, modelIds: ['gemini-1.5-pro'], topDiscrimination: 0.6 },
  { vendor: 'meta', vendorLabel: 'Meta', modelCount: 1, modelIds: ['llama-3.1-70b'], topDiscrimination: 0.6 },
  { vendor: 'mistral', vendorLabel: 'Mistral', modelCount: 1, modelIds: ['mistral-large'], topDiscrimination: 0.6 },
  { vendor: 'alibaba', vendorLabel: '阿里通义', modelCount: 1, modelIds: ['qwen-2.5-coder'], topDiscrimination: 0.6 },
];

/** 给厂商分组补上颜色。 */
export function withVendorColors(groups: readonly Omit<VendorGroup, 'color'>[]): VendorGroup[] {
  return groups.map((g, i) => ({ ...g, color: VENDOR_PALETTE[i % VENDOR_PALETTE.length] }));
}

/** 离线兜底星球分组（已着色）。 */
export function fallbackVendorGroups(): VendorGroup[] {
  return withVendorColors(FALLBACK_VENDOR_GROUPS);
}

export interface RouteState {
  requestId: string | null;
  decisionId: string | null;
  executionId: string | null;
  stage: string;
  nodes: NodeVisualState[];
  stages: StageState[];
  routeTier: 'ROUTE' | 'GATE' | 'ESCALATE' | null;
  confidence: number | null;
  winnerModelId: string | null;
  decisionSource: 'TYPE_SAFE_JEV' | 'LOCAL_REIMPL' | null;
  /** 真实 Jev 返回的模型版本，如 jev-1.13.0。 */
  jevModel: string | null;
  /** Jev 调用耗时（ms）。 */
  jevCallLatencyMs: number | null;
  /** Jev token 用量。 */
  jevUsage: { inputTokens: number; outputTokens: number } | null;
  /** 胜出模型的 Jev 先验理由。 */
  winnerReason: string | null;
  /** 当前星球（厂商）节点列表 —— 由 LLM 模型服务动态下发。 */
  vendorGroups: VendorGroup[];
  resultText: string;
  streaming: boolean;
  animProgress: number;
  animPlaying: boolean;
  animSpeed: number;
  events: RouteEvent[];
  errorMessage: string | null;
  isConnected: boolean;
  modelScores: ModelScoreEntry[];
  jevAnswers: JevAnswerEntry[];
}

export type RouteAction =
  | { type: 'ROUTE_EVENT'; event: RouteEvent }
  | { type: 'SET_STAGE'; stage: string }
  | { type: 'SET_ANIM_PROGRESS'; progress: number }
  | { type: 'SET_ANIM_PLAYING'; playing: boolean }
  | { type: 'SET_ANIM_SPEED'; speed: number }
  | { type: 'RESET_ROUTE' }
  | { type: 'SET_RESULT_TEXT'; text: string }
  | { type: 'APPEND_RESULT_CHUNK'; chunk: string }
  | { type: 'SET_DECISION_SOURCE'; source: 'TYPE_SAFE_JEV' | 'LOCAL_REIMPL' }
  | { type: 'SET_ERROR'; message: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'SET_CONNECTED'; connected: boolean }
  | { type: 'SET_MODEL_SCORES'; scores: ModelScoreEntry[] }
  | { type: 'SET_JEV_ANSWERS'; answers: JevAnswerEntry[] }
  | { type: 'SET_VENDOR_GROUPS'; groups: VendorGroup[] };

// Event type → node activation mapping (ANIM-6, design.md §6.1)
// Keyed by NodeType. Model nodes are activated by id (payload.modelId) below.
const EVENT_NODE_MAP: Record<RouteEventType, Partial<Record<NodeType, boolean>>> = {
  ROUTE_CREATED: { prompt: true },
  EXPERIENCE_RETRIEVED: { knowledge: true },
  JEV_CALL_STARTED: { 'jev-hub': true },
  JEV_DECISION_READY: { 'jev-hub': true },
  JEV_FALLBACK: { 'jev-hub': true },
  CONSTRAINT_FILTERED: {},
  MODEL_CALL_STARTED: {},
  MODEL_SELECTED: {},
  MODEL_STREAMING: {},
  MODEL_COMPLETED: { knowledge: true },
  EXPERIENCE_SAVED: { knowledge: true },
  CONSTRAINT_GATE_PASSED: { 'jev-hub': true },
  ROUTE_ESCALATED: { 'jev-hub': true },
  ROUTE_FAILED: { 'jev-hub': true },
};

/** Events that activate a specific candidate node by payload.modelId */
const MODEL_NODE_EVENTS: ReadonlySet<RouteEventType> = new Set([
  'MODEL_CALL_STARTED',
  'MODEL_SELECTED',
  'MODEL_STREAMING',
]);

// 7-stage timeline (ANIM-1) — C7 aligned with computeRunFrontend.ts
const STAGE_DEFS: { id: string; label: string }[] = [
  { id: 'ingest', label: 'Prompt 接入' },
  { id: 'analyze', label: 'JEV 类型化提问' },
  { id: 'score', label: '候选模型评估' },
  { id: 'select', label: '置信度路由决策' },
  { id: 'execute', label: '模型推理执行' },
  { id: 'return', label: '结果回传汇聚' },
  { id: 'done', label: '路由完成' },
];

/** 离线兜底的候选 modelId 顺序（仅在无星球分组时使用）。 */
export const CANDIDATE_MODEL_IDS = [
  'gpt-4o',
  'claude-3.5-sonnet',
  'gemini-1.5-pro',
  'llama-3.1-70b',
  'mistral-large',
  'qwen-2.5-coder',
] as const;

/**
 * 构建节点图：Prompt输入 → Jev智能路由中枢 → 厂商星球 → 决策库。
 *
 * 星球节点数量与顺序完全由 LLM 模型服务下发的 `vendorGroups` 决定
 * （一个厂商一颗星球），离线时回落 `fallbackVendorGroups()`。
 *
 * 节点 id 用 `vendor:<vendor>`，避免与 modelId 混淆；
 * `modelIds` 保留所辖模型，供模型级事件（MODEL_SELECTED 等）映射。
 */
export function buildInitialNodes(groups?: readonly VendorGroup[]): NodeVisualState[] {
  const mk = (
    id: string,
    label: string,
    type: NodeType,
    x: number,
    y: number,
    modelIds?: string[],
  ): NodeVisualState => ({
    id,
    label,
    type,
    x,
    y,
    z: 0,
    active: false,
    highlighted: false,
    greyedOut: false,
    loadPercent: 0,
    isWinner: false,
    modelIds,
  });

  const planets = groups && groups.length > 0 ? groups : fallbackVendorGroups();

  // Layout constants matching TreeScene.ts sphere layout
  const ROW_DY = 2.10;
  const LEAF_X = 5.85;
  const n = planets.length;

  return [
    mk('prompt', 'Prompt输入', 'prompt', -7.4, 0),
    mk('jev-hub', 'Jev智能路由中枢', 'jev-hub', 0, 0),
    ...planets.map((g, i) => {
      const y = ((n - 1) * 0.5 - i) * ROW_DY;
      return mk(`vendor:${g.vendor}`, g.vendorLabel, 'candidate', LEAF_X, y, [...g.modelIds]);
    }),
    mk('knowledge', '决策库', 'knowledge', 9.0, 0),
  ];
}

export function createInitialRouteState(): RouteState {
  const vendorGroups = fallbackVendorGroups();
  return {
    requestId: null,
    decisionId: null,
    executionId: null,
    stage: 'idle',
    nodes: buildInitialNodes(vendorGroups),
    stages: STAGE_DEFS.map((s) => ({
      ...s,
      active: false,
      done: false,
      progress: 0,
    })),
    routeTier: null,
    confidence: null,
    winnerModelId: null,
    decisionSource: null,
    jevModel: null,
    jevCallLatencyMs: null,
    jevUsage: null,
    winnerReason: null,
    vendorGroups,
    resultText: '',
    streaming: false,
    animProgress: 0,
    animPlaying: false,
    animSpeed: 1,
    events: [],
    errorMessage: null,
    isConnected: false,
    modelScores: [],
    jevAnswers: [],
  };
}

export function routeEventReducer(state: RouteState, action: RouteAction): RouteState {
  switch (action.type) {
    case 'ROUTE_EVENT': {
      const event = action.event;
      // 星球节点以厂商聚合，事件仍带 modelId —— 先解析出事件指向的 modelId。
      const eventModelId = typeof event.payload.modelId === 'string' ? event.payload.modelId : null;
      const nodes = state.nodes.map((n) => {
        const activation = EVENT_NODE_MAP[event.type];
        if (activation && activation[n.type]) {
          return { ...n, active: true, highlighted: true };
        }
        // Model events activate the vendor planet that owns the referenced model
        const ownsModel = eventModelId !== null && (n.modelIds?.includes(eventModelId) ?? false);
        if (MODEL_NODE_EVENTS.has(event.type) && ownsModel) {
          // MODEL_SELECTED 同时标记胜出星球（它也在 MODEL_NODE_EVENTS 内，
          // 若不在此合并处理，后面的 isWinner 分支永远不会执行）。
          return event.type === 'MODEL_SELECTED'
            ? { ...n, active: true, highlighted: true, isWinner: true }
            : { ...n, active: true, highlighted: true };
        }
        // CONSTRAINT_FILTERED: grey out the vendor planet owning the filtered model
        if (event.type === 'CONSTRAINT_FILTERED' && ownsModel) {
          return { ...n, greyedOut: true, highlighted: false };
        }
        // ROUTE_FAILED: mark constraint-gate node with error visual
        if (event.type === 'ROUTE_FAILED' && n.type === 'jev-hub') {
          return { ...n, active: true, highlighted: true };
        }
        return n;
      });

      // Update stage based on event type
      let stage = state.stage;
      let routeTier = state.routeTier;
      let confidence = state.confidence;
      let winnerModelId = state.winnerModelId;
      let modelScores = state.modelScores;
      let jevAnswers = state.jevAnswers;
      let resultText = state.resultText;
      let streaming = state.streaming;
      let jevModel = state.jevModel;
      let jevCallLatencyMs = state.jevCallLatencyMs;
      let jevUsage = state.jevUsage;
      let winnerReason = state.winnerReason;

      if (event.type === 'ROUTE_CREATED') stage = 'ingest';
      else if (event.type === 'EXPERIENCE_RETRIEVED') stage = sharedStageToFrontend('state');
      else if (event.type === 'JEV_CALL_STARTED') stage = sharedStageToFrontend('jev');
      else if (event.type === 'JEV_DECISION_READY') {
        stage = sharedStageToFrontend('probability');
        confidence = (event.payload.confidence as number) ?? null;
        routeTier = (event.payload.routeTier as 'ROUTE' | 'GATE' | 'ESCALATE') ?? null;
        jevModel = (event.payload.jevModel as string) ?? state.jevModel;
        jevCallLatencyMs =
          typeof event.payload.jevCallLatencyMs === 'number'
            ? event.payload.jevCallLatencyMs
            : state.jevCallLatencyMs;
        const usage = event.payload.jevUsage as
          | { input_tokens?: number; output_tokens?: number }
          | undefined;
        if (usage) {
          jevUsage = {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
          };
        }
        winnerReason = (event.payload.winnerReason as string) ?? state.winnerReason;
        // 候选得分由后端按排名序下发（含 Jev 先验修正量）
        const candidateScores = event.payload.candidateScores as
          | { modelId: string; raw: number; probability?: number; rankIndex?: number; priorDelta?: number }[]
          | undefined;
        if (candidateScores && candidateScores.length > 0) {
          modelScores = candidateScores.map((cs) => ({
            name: cs.modelId,
            score: cs.probability ?? cs.raw,
            rankIndex: cs.rankIndex,
            priorDelta: cs.priorDelta,
          }));
        }
        // Jev 五问（后端已转为展示形态 { tag, type, value }）
        const answers = event.payload.answers as JevAnswerEntry[] | undefined;
        if (answers && answers.length > 0) {
          jevAnswers = answers;
        }
      } else if (event.type === 'CONSTRAINT_FILTERED' || event.type === 'CONSTRAINT_GATE_PASSED') {
        stage = sharedStageToFrontend('constraint');
      } else if (event.type === 'MODEL_CALL_STARTED') {
        stage = sharedStageToFrontend('route');
      } else if (event.type === 'MODEL_SELECTED') {
        stage = sharedStageToFrontend('route');
        winnerModelId = (event.payload.modelId as string) ?? null;
      } else if (event.type === 'MODEL_STREAMING') {
        // streaming in progress — append delta text
        const delta = event.payload.delta as string | undefined;
        if (delta) {
          resultText = state.resultText + delta;
          streaming = true;
        }
      } else if (event.type === 'MODEL_COMPLETED') {
        stage = sharedStageToFrontend('experience');
        streaming = false;
        // 终态兜底：SSE 增量丢失时用后端回传的完整结果回填。
        const finalText = event.payload.result;
        if (typeof finalText === 'string' && finalText.length > 0 && finalText !== state.resultText) {
          resultText = finalText;
        }
      } else if (event.type === 'EXPERIENCE_SAVED') {
        // experience saved
      } else if (event.type === 'ROUTE_FAILED') {
        // route failed — set error message from payload
        const msg = (event.payload.message as string) ?? '路由失败';
        const failedStage = sharedStageToFrontend('constraint');
        return {
          ...state,
          events: [...state.events, event],
          nodes: nodes.map((n) =>
            n.type === 'jev-hub' ? { ...n, active: true, highlighted: true } : n,
          ),
          stage: failedStage,
          stages: state.stages.map((s) =>
            s.id === failedStage ? { ...s, active: true, progress: 1 } : s,
          ),
          routeTier,
          confidence,
          winnerModelId,
          requestId: event.requestId ?? state.requestId,
          decisionId: event.decisionId ?? state.decisionId,
          executionId: event.executionId ?? state.executionId,
          errorMessage: msg,
        };
      }

      // Update stages progress (C7: uses frontend stage names)
      const stageIdx = (FRONTEND_STAGE_ORDER as readonly string[]).indexOf(stage);
      const stages = state.stages.map((s, i) => {
        if (stageIdx < 0) return s;
        if (i < stageIdx) return { ...s, active: false, done: true, progress: 1 };
        if (i === stageIdx) return { ...s, active: true, progress: 1 };
        return s;
      });

      return {
        ...state,
        events: [...state.events, event],
        nodes,
        stage,
        stages,
        routeTier,
        confidence,
        winnerModelId,
        jevModel,
        jevCallLatencyMs,
        jevUsage,
        winnerReason,
        modelScores,
        jevAnswers,
        resultText,
        streaming,
        requestId: event.requestId ?? state.requestId,
        decisionId: event.decisionId ?? state.decisionId,
        executionId: event.executionId ?? state.executionId,
      };
    }

    case 'SET_STAGE':
      return { ...state, stage: sharedStageToFrontend(action.stage) };

    case 'SET_ANIM_PROGRESS':
      // Animation progress does NOT modify decision state (ARCH-3)
      return { ...state, animProgress: action.progress };

    case 'SET_ANIM_PLAYING':
      return { ...state, animPlaying: action.playing };

    case 'SET_ANIM_SPEED':
      return { ...state, animSpeed: action.speed };

    case 'RESET_ROUTE': {
      // 保留已从 LLM 模型服务拉取的星球分组，仅重置本轮路由状态。
      const next = createInitialRouteState();
      return { ...next, vendorGroups: state.vendorGroups, nodes: buildInitialNodes(state.vendorGroups) };
    }

    case 'SET_RESULT_TEXT':
      return { ...state, resultText: action.text, streaming: false };

    case 'APPEND_RESULT_CHUNK':
      return { ...state, resultText: state.resultText + action.chunk, streaming: true };

    case 'SET_DECISION_SOURCE':
      return { ...state, decisionSource: action.source };

    case 'SET_ERROR':
      return { ...state, errorMessage: action.message, streaming: false };

    case 'CLEAR_ERROR':
      return { ...state, errorMessage: null };

    case 'SET_CONNECTED':
      return { ...state, isConnected: action.connected };

    case 'SET_MODEL_SCORES':
      return { ...state, modelScores: action.scores };

    case 'SET_JEV_ANSWERS':
      return { ...state, jevAnswers: action.answers };

    case 'SET_VENDOR_GROUPS': {
      // 星球分组来自 LLM 模型服务，随时可能变化 → 重建候选节点，
      // 但保留本轮已产生的激活/胜出状态（按 modelId 归属迁移）。
      const groups = action.groups.length > 0 ? action.groups : fallbackVendorGroups();
      const carried = new Map(
        state.nodes.filter((n) => n.type === 'candidate').map((n) => [n.id, n]),
      );
      const nodes = buildInitialNodes(groups).map((n) => {
        const prev = carried.get(n.id);
        if (!prev) return n;
        return {
          ...n,
          active: prev.active,
          highlighted: prev.highlighted,
          greyedOut: prev.greyedOut,
          isWinner: prev.isWinner,
        };
      });
      return { ...state, vendorGroups: groups, nodes };
    }

    default:
      return state;
  }
}
