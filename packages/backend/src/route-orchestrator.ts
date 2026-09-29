/**
 * @module route-orchestrator
 * @implements LLM-sdd.md 执行流程
 *
 * 路由编排器 —— 串起「Prompt 输入 → Jev 分析 → 决策库算阈值 → 选型 → 执行 →
 * 展示 → 落库」全链路。
 *
 * ```
 *  1. ROUTE_CREATED            Prompt 输入接入
 *  2. EXPERIENCE_RETRIEVED     读取决策信息库（经验/统计回流）
 *  3. JEV_CALL_STARTED         调用 Jev System One（5 个类型化问题，单次批量）
 *     ├─ 成功 → JEV_DECISION_READY
 *     └─ 失败 → JEV_FALLBACK → 本地重实现兜底 → JEV_DECISION_READY
 *  4. CONSTRAINT_GATE_PASSED   硬约束门（8 步）通过 / CONSTRAINT_FILTERED 淘汰
 *  5. MODEL_SELECTED           依据置信度阈值选择最终模型
 *     ├─ ESCALATE → ROUTE_ESCALATED（不执行）
 *     └─ ROUTE/GATE → 继续
 *  6. MODEL_CALL_STARTED       调用 LLM 模型库
 *  7. MODEL_STREAMING…         流式增量
 *  8. MODEL_COMPLETED          执行完成
 *  9. EXPERIENCE_SAVED         热更新决策信息库 + 写入历史库
 * ```
 *
 * 关键不变量：
 * - 决策信息库的置信度阈值**先读后用**：本次路由使用库中当前阈值（动态或静态）。
 * - 硬约束淘汰优先于 Jev 建议（CONSTRAIN-3）：Jev 推荐被淘汰时改选次优。
 * - ESCALATE 档位 MUST NOT 自动执行模型（spec `ROUTE_ESCALATED`）。
 * - 任何失败路径 MUST 落 `ROUTE_FAILED` 并把失败原因写入历史库。
 */
import {
  calibrate,
  extractFeatures,
  routeTier,
  scoreModels,
  SOFTMAX_ALPHA_DEFAULT,
  SOFTMAX_T0_DEFAULT,
  tieBreak,
  type PolicySnapshot,
  type RawEvidence,
  type RouteTier,
  type ScoredModel,
} from '@jev-router/shared';
import type { CatalogEntry } from './model-catalog.js';
import { selectEligible } from './constraint-selector.js';
import type { JevAnswer } from './jev-adapter.js';
import { ModelGateway, GatewayError, type ProviderMessage, type TokenUsage, type ToolCall, type ToolDefinition } from './model-gateway.js';
import {
  buildRoutingQuestions,
  DEFAULT_JEV_MODEL,
  SystemOneJevAdapter,
  JevAdapterError,
} from './jev-http-adapter.js';
import {
  buildJevProfile,
  explainJevPrior,
  jevPriorDeltas,
  type JevRequestProfile,
} from './jev-routing.js';
import { answerQuestionsLocally } from './local-jev-reimpl.js';
import { assembleState, type EngineeredState, type EvidenceEntry } from './state-engineering.js';
import type { EventBus } from './route-event.js';
import type { RouteRegistry } from './route-api.js';
import type { AppConfig } from './app-config.js';
import type { DecisionStore, DecisionRecordEntry } from './decision-store.js';
import type { HistoryStore, HistoryEntry } from './history-store.js';
import type { ModelInfoStore } from './model-info-store.js';
import { BUILTIN_TOOLS, executeTool } from './builtin-tools.js';
import { extractPromptEvidence, estimateTokens } from './prompt-evidence.js';
import { hourBucketOf, summarizePrompt } from './history-store.js';

// ---------------------------------------------------------------------------
// 依赖
// ---------------------------------------------------------------------------

export interface OrchestratorDeps {
  config: AppConfig;
  registry: RouteRegistry;
  eventBus: EventBus;
  decisionStore: DecisionStore;
  modelInfoStore: ModelInfoStore;
  historyStore: HistoryStore;
  gateway: ModelGateway;
  jevAdapter: SystemOneJevAdapter;
}

/** 编排输入（来自 `POST /v1/routes`）。 */
export interface OrchestrateInput {
  requestId: string;
  prompt: string;
  preference?: 'economy' | 'balanced' | 'quality';
  /** 允许的模型 id 白名单（前端候选池）。 */
  allowedModelIds?: string[];
  maxLatencyMs?: number;
  budgetUsd?: number;
}

/** 编排结果摘要（供 HTTP 层立即返回 / 调试）。 */
export interface OrchestrateOutcome {
  requestId: string;
  decisionId: string;
  executionId?: string;
  routeTier: RouteTier;
  confidence: number;
  selectedModelId: string;
  decisionSource: 'TYPE_SAFE_JEV' | 'RULE_FALLBACK' | 'LOCAL_REIMPL' | 'USER_OVERRIDE';
  status: 'COMPLETED' | 'FAILED' | 'ESCALATED';
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------
export class RouteOrchestrator {
  private readonly deps: OrchestratorDeps;
  /** requestId → 取消控制器（支持 `POST /v1/routes/:id/cancel`）。 */
  private readonly inflight = new Map<string, AbortController>();

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  /** 取消一次进行中的路由。 */
  cancel(requestId: string): boolean {
    const ctrl = this.inflight.get(requestId);
    if (!ctrl) return false;
    ctrl.abort();
    return true;
  }

  /**
   * 执行一次完整路由（异步推进，不阻塞 HTTP 响应）。
   *
   * 调用方 SHOULD NOT await 本方法；`POST /v1/routes` 立即返回 requestId，
   * 后续事件经 EventBus → SSE 推送。
   */
  async run(input: OrchestrateInput): Promise<OrchestrateOutcome> {
    const { registry, eventBus, decisionStore, modelInfoStore } = this.deps;
    const { requestId, prompt } = input;
    const abort = new AbortController();
    this.inflight.set(requestId, abort);

    const eventTypes: string[] = [];
    const emit = (type: Parameters<EventBus['emit']>[0]['type'], payload: Record<string, unknown>, extra?: { decisionId?: string; executionId?: string }): void => {
      eventTypes.push(type);
      eventBus.emit({
        requestId,
        type,
        payload,
        ...(extra?.decisionId ? { decisionId: extra.decisionId } : {}),
        ...(extra?.executionId ? { executionId: extra.executionId } : {}),
      });
    };

    // ── 2. 读取决策信息库（经验回流）────────────────────────────────────
    const storeSnapshot = decisionStore.snapshot();
    const thresholds = decisionSnapshotThresholds(storeSnapshot);
    emit('EXPERIENCE_RETRIEVED', {
      expVersion: storeSnapshot.updatedAt,
      priorSnapshot: Object.values(storeSnapshot.models).map((m) => m.avgProbability),
      sampleCount: storeSnapshot.totals.decisions,
      thresholds,
      thresholdSource: storeSnapshot.thresholdSource,
    });

    // ── 3. STATE 段：证据提取 + 6 段状态装配 ────────────────────────────
    const evidence = extractPromptEvidence(prompt);
    const catalog = modelInfoStore.catalogEntries();
    const poolFilter = filterPool(catalog, input.allowedModelIds);
    const pool = poolFilter.pool;

    // ── 4. JEV_CALL_STARTED → 决策 ──────────────────────────────────────
    emit('JEV_CALL_STARTED', {
      contractId: DEFAULT_JEV_MODEL,
      model: this.deps.jevAdapter.modelAlias,
      fiveQuestionsCount: Object.keys(buildRoutingQuestions()).length,
      baseUrl: this.deps.config.jev.baseUrl,
    });
    registry.transition(requestId, 'DECIDING');

    const decisionResult = await this.decide(requestId, prompt, evidence, pool, thresholds, input.preference, input, emit);

    // ── 5. 硬约束门（CONSTRAIN-1/2/3）─────────────────────────────────
    const { eligible, eliminated, jevRecommendationEliminated } = selectEligible(
      pool,
      {
        requiredModalities: [],
        maxLatencyMs: input.maxLatencyMs,
        budgetUsd: input.budgetUsd,
      },
      decisionResult.jevRecommendation,
    );
    for (const e of eliminated) {
      emit('CONSTRAINT_FILTERED', {
        modelId: e.modelId,
        excludedModelIds: [e.modelId],
        reason: { [e.modelId]: e.primaryEliminationReason ?? 'UNKNOWN' },
        remainingCount: eligible.length,
      });
    }
    // JEV-11 正交性：硬约束淘汰全部候选时为保证可用性回落到未过滤池，
    // 该行为 MUST 可审计——`constraintFallback` 随决策落库（见附录 G-2）。
    const hardConstraintFallback = eligible.length === 0 && pool.length > 0;
    const constraintFallback = poolFilter.poolFallback || hardConstraintFallback;

    emit('CONSTRAINT_GATE_PASSED', {
      passedModelIds: eligible.map((m) => m.modelId),
      step: '8-step-hard-constraints',
      jevRecommendationEliminated: jevRecommendationEliminated ?? null,
      constraintFallback,
      ...(hardConstraintFallback
        ? { constraintFallbackReason: 'all_candidates_eliminated' }
        : poolFilter.poolFallback
          ? { constraintFallbackReason: 'allowed_model_ids_not_in_catalog' }
          : {}),
    });

    const usable = eligible.length > 0 ? eligible : pool;
    if (usable.length === 0) {
      const message = '候选池为空：模型清单拉取失败且无回落清单';
      registry.transition(requestId, 'FAILED', { errorMessage: message });
      emit('ROUTE_FAILED', { reason: 'no_candidate', message });
      await this.finishStores(input, evidence, {
        routeTier: 'ESCALATE',
        confidence: decisionResult.confidence,
        thresholds,
        decisionSource: decisionResult.decisionSource,
        decisionId: decisionResult.decisionId,
        distribution: [],
        eliminated: [],
        selectedModelId: '',
        jevRecommendation: undefined,
        eventTypes,
        jevAnswers: decisionResult.answers,
        execution: {
          modelId: '',
          latencyMs: 0,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: 0,
          status: 'error',
          errorMessage: message,
        },
        result: '',
      });
      this.inflight.delete(requestId);
      throw new Error(message);
    }

    // ── 6. Jev 先验注入 + 打分 + 阈值选型 ────────────────────────────
    // SCORE-3：先验 MUST 在 softmax 之前注入，故通过 `priorDeltas` 传入。
    const policy = buildPolicy(this.deps.config.routing.preference, input.preference);
    const priorDeltas = jevPriorDeltas(decisionResult.profile, usable);
    const scores = scoreModels(usable, policy, priorDeltas);
    const ranked = tieBreak(scores.byRankOrder);
    if (ranked.length === 0) {
      throw new Error('打分结果为空：候选池不可用');
    }
    // CONSTRAIN-3：Jev 只判别请求特征，不指定模型；最终选择由打分结果决定。
    const jevRec = decisionResult.jevRecommendation;
    let winner: ScoredModel = ranked[0];
    const distribution = scores.byRankOrder.map((m) => ({
      modelId: m.modelId,
      probability: m.probability,
      rankIndex: m.rankIndex,
    }));
    const winnerProbability = winner.probability;

    // 置信度：真实 Jev 用其自评 confidence；降级时用本地校准曲线（JEV-5）。
    const features = extractFeatures(evidence, { tokens: estimateTokens(prompt) });
    const localConfidence = calibrate(features.overall);
    const confidence =
      decisionResult.decisionSource === 'TYPE_SAFE_JEV' && decisionResult.confidence > 0
        ? decisionResult.confidence
        : localConfidence;
    const tier = routeTier(confidence, thresholds);

    const decisionId = decisionResult.decisionId;
    const winnerEntry = usable.find((m) => m.modelId === winner.modelId);
    emit('JEV_DECISION_READY', {
      decisionId,
      confidence,
      calibratedConfidence: confidence,
      routeTier: tier,
      thresholds,
      answers: decisionResult.answers,
      rationale: decisionResult.rationale,
      decisionSource: decisionResult.decisionSource,
      jevModel: decisionResult.profile.model,
      jevCallLatencyMs: decisionResult.callLatencyMs ?? null,
      jevUsage: decisionResult.jevUsage ?? null,
      jevProfile: decisionResult.profile,
      priorDeltas,
      winnerReason: winnerEntry ? explainJevPrior(decisionResult.profile, winnerEntry) : null,
      // 按排名序输出（高→低），便于前端直接展示得分分布
      candidateScores: scores.byRankOrder.map((m) => ({
        modelId: m.modelId,
        raw: m.raw,
        probability: m.probability,
        rankIndex: m.rankIndex,
        priorDelta: priorDeltas[m.catalogIndex],
      })),
    });
    registry.transition(requestId, 'EXECUTING', {
      decisionId,
      tier,
      confidence,
    });

    // ESCALATE：低置信度转兜底模型（免费模型）继续执行（原「转人工复核」改为自动兜底）
    if (tier === 'ESCALATE') {
      // 兜底规则：低置信度场景优先选择免费模型（inputPricePer1k=0 && outputPricePer1k=0）
      const freeModelIds = new Set(
        usable.filter((m) => m.inputPricePer1k === 0 && m.outputPricePer1k === 0).map((m) => m.modelId),
      );
      if (freeModelIds.size > 0) {
        const freeWinner = ranked.find((r) => freeModelIds.has(r.modelId));
        if (freeWinner) winner = freeWinner;
      }
      const reason = 'low_confidence';
      emit('ROUTE_ESCALATED', { reason, escalateTo: 'fallback_model' });
    }

    emit('MODEL_SELECTED', {
      modelId: winner.modelId,
      catalogIndex: winner.catalogIndex,
      rankIndex: winner.rankIndex,
      probability: winnerProbability,
      selectionMode: decisionResult.decisionSource,
      routeTier: tier,
      confidence,
    });

    // ── 7. 执行（流式）───────────────────────────────────────────────
    const entry = usable.find((m) => m.modelId === winner.modelId);
    if (!entry) {
      throw new Error(`选中模型 ${winner.modelId} 不在候选池中（下标契约违规）`);
    }
    const executionId = `exec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const { messages: initialMessages, tools } = buildMessagesWithTools(prompt);
    const startedAt = Date.now();

    emit('MODEL_CALL_STARTED', {
      modelId: entry.modelId,
      executionId,
      provider: this.deps.config.llmLibrary.id,
      baseUrl: this.deps.config.llmLibrary.baseUrl,
    }, { decisionId, executionId });

    let result = '';
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let status: 'success' | 'error' | 'cancelled' = 'success';
    let errorMessage: string | undefined;
    let toolExecuted = false;

    try {
      // ── 7a. tool_call 循环（最多 3 轮）──────────────────────────────
      // round 0：注入 tools，LLM 决定是否调用工具
      // round 1+：回传工具结果，LLM 基于结果生成最终回答（不再注入 tools）
      const messageHistory = [...initialMessages];
      const MAX_TOOL_ROUNDS = 3;

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const roundTools = round === 0 ? tools : undefined;
        const roundToolChoice = round === 0 ? 'auto' as const : undefined;
        const stream = this.deps.gateway.streamInvoke(
          entry,
          messageHistory,
          { requestId, decisionId, executionId },
          {
            temperature: this.deps.config.routing.temperature,
            maxTokens: this.deps.config.routing.maxTokens,
            signal: abort.signal,
            tools: roundTools,
            toolChoice: roundToolChoice,
          },
        );

        let roundResult = '';
        let roundToolCalls: ToolCall[] | undefined;

        for await (const chunk of stream) {
          if (chunk.done) {
            if (chunk.usage) usage = chunk.usage;
            if (chunk.tool_calls && chunk.tool_calls.length > 0) {
              roundToolCalls = chunk.tool_calls;
            }
            continue;
          }
          roundResult += chunk.delta;
          emit('MODEL_STREAMING', {
            modelId: entry.modelId,
            executionId,
            delta: chunk.delta,
            cumulativeTokens: chunk.usage?.totalTokens ?? usage.totalTokens,
          }, { decisionId, executionId });
        }

        // 无 tool_calls → 最终答案，退出循环
        if (!roundToolCalls || roundToolCalls.length === 0) {
          result = roundResult;
          break;
        }

        // 有 tool_calls → 执行工具并追加消息
        toolExecuted = true;
        messageHistory.push({
          role: 'assistant',
          content: roundResult,
          tool_calls: roundToolCalls,
        });
        for (const tc of roundToolCalls) {
          let toolResult: string;
          try {
            toolResult = await executeTool(tc);
          } catch (err) {
            toolResult = JSON.stringify({
              error: `工具执行失败：${err instanceof Error ? err.message : String(err)}`,
            });
          }
          messageHistory.push({
            role: 'tool',
            content: toolResult,
            tool_call_id: tc.id,
          });
          // 向前端推送工具执行进度
          emit('MODEL_STREAMING', {
            modelId: entry.modelId,
            executionId,
            delta: `\n\n[已调用工具 ${tc.function.name}] 已获取实时数据，正在生成回答…\n\n`,
            cumulativeTokens: usage.totalTokens,
          }, { decisionId, executionId });
        }
        // 继续下一轮：LLM 基于工具结果生成最终回答
      }
    } catch (err) {
      status = err instanceof GatewayError && err.code === 'CANCELLED' ? 'cancelled' : 'error';
      errorMessage = err instanceof Error ? err.message : String(err);
      if (status === 'error') {
        const message = `模型执行失败：${errorMessage}`;
        emit('ROUTE_FAILED', { reason: 'provider_error', message }, { decisionId, executionId });
        registry.transition(requestId, 'FAILED', {
          decisionId,
          executionId,
          errorMessage: message,
        });
        await this.finishStores(input, evidence, {
          decisionId,
          executionId,
          routeTier: tier,
          confidence,
          thresholds,
          decisionSource: decisionResult.decisionSource,
          selectedModelId: entry.modelId,
          jevRecommendation: jevRec,
          distribution,
          eliminated: eliminated.map((e) => ({ modelId: e.modelId, reason: e.primaryEliminationReason ?? 'UNKNOWN' })),
          constraintFallback,
          constraintFallbackReason: hardConstraintFallback
            ? 'all_candidates_eliminated'
            : poolFilter.poolFallback
              ? 'allowed_model_ids_not_in_catalog'
              : undefined,
          eventTypes,
          jevAnswers: decisionResult.answers,
          execution: {
            modelId: entry.modelId,
            latencyMs: Date.now() - startedAt,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            costUsd: this.deps.gateway.computeCost(entry, usage),
            status,
            usageSource: usage.totalTokens > 0 ? 'provider' : 'estimated',
            errorMessage,
          },
          result,
        });
        this.inflight.delete(requestId);
        return {
          requestId,
          decisionId,
          executionId,
          routeTier: tier,
          confidence,
          selectedModelId: entry.modelId,
          decisionSource: decisionResult.decisionSource,
          status: 'FAILED',
        };
      }
    }

    const latencyMs = Date.now() - startedAt;
    // 网关在流被截断（如触及 max_tokens）时不上报 usage；此时按文本长度估算，
    // 并显式标注来源，避免成本统计静默归零。
    const usageSource: 'provider' | 'estimated' =
      usage.totalTokens > 0 ? 'provider' : 'estimated';
    const finalUsage: TokenUsage =
      usageSource === 'provider'
        ? usage
        : {
            promptTokens: estimateTokens(prompt),
            completionTokens: estimateTokens(result),
            totalTokens: estimateTokens(prompt) + estimateTokens(result),
          };
    const costUsd = this.deps.gateway.computeCost(entry, finalUsage);
    emit('MODEL_COMPLETED', {
      modelId: entry.modelId,
      executionId,
      latencyMs,
      promptTokens: finalUsage.promptTokens,
      completionTokens: finalUsage.completionTokens,
      costUsd,
      usageSource,
      toolExecuted,
      // 终态兜底：完整结果文本。SSE 增量丢失（重连/代理缓冲）时，
      // 前端据此回填「结果」区，避免只显示执行成功但正文为空。
      result,
    }, { decisionId, executionId });
    registry.transition(requestId, 'COMPLETED', {
      decisionId,
      executionId,
      selectedModelId: entry.modelId,
    });

    // ── 8. 热更新决策信息库 + 写入历史库 ──────────────────────────────
    await this.finishStores(input, evidence, {
      decisionId,
      executionId,
      routeTier: tier,
      confidence,
      thresholds,
      decisionSource: decisionResult.decisionSource,
      selectedModelId: entry.modelId,
      jevRecommendation: jevRec,
      distribution,
      eliminated: eliminated.map((e) => ({ modelId: e.modelId, reason: e.primaryEliminationReason ?? 'UNKNOWN' })),
      constraintFallback,
      constraintFallbackReason: hardConstraintFallback
        ? 'all_candidates_eliminated'
        : poolFilter.poolFallback
          ? 'allowed_model_ids_not_in_catalog'
          : undefined,
      eventTypes,
      jevAnswers: decisionResult.answers,
      execution: {
        modelId: entry.modelId,
        latencyMs,
        promptTokens: finalUsage.promptTokens,
        completionTokens: finalUsage.completionTokens,
        costUsd,
        status,
        usageSource,
        errorMessage,
      },
      result,
    });
    emit('EXPERIENCE_SAVED', {
      eid: `exp-${requestId}`,
      expVersion: decisionStore.snapshot().totals.decisions,
      outcomeStatus: status === 'success' ? 'pending' : 'disputed',
    }, { decisionId, executionId });

    this.inflight.delete(requestId);
    return {
      requestId,
      decisionId,
      executionId,
      routeTier: tier,
      confidence,
      selectedModelId: entry.modelId,
      decisionSource: decisionResult.decisionSource,
      status: status === 'success' ? 'COMPLETED' : 'FAILED',
    };
  }

  // -------------------------------------------------------------------------
  // 决策
  // -------------------------------------------------------------------------

  /**
   * 调用 Jev 决策；失败时按 CONSTRAIN-4 降级到本地重实现。
   *
   * 降级链：System One 失败 → `JEV_FALLBACK` 事件 → `answerQuestionsLocally`
   * （`decisionSource=RULE_FALLBACK`，明确标注非官方机制，JEV-1/JEV-7）。
   */
  private async decide(
    requestId: string,
    prompt: string,
    evidence: RawEvidence,
    pool: CatalogEntry[],
    thresholds: { high: number; mid: number },
    preference: 'economy' | 'balanced' | 'quality' | undefined,
    input: OrchestrateInput,
    emit: (type: 'JEV_DECISION_READY' | 'JEV_FALLBACK', payload: Record<string, unknown>) => void,
  ): Promise<{
    decisionId: string;
    confidence: number;
    jevRecommendation?: string;
    answers: { tag: string; type: 'choice' | 'score' | 'noul'; value: string }[];
    rationale: string;
    decisionSource: 'TYPE_SAFE_JEV' | 'RULE_FALLBACK' | 'LOCAL_REIMPL';
    profile: JevRequestProfile;
    callLatencyMs?: number;
    jevUsage?: { input_tokens: number; output_tokens: number };
  }> {
    try {
      const res = await this.deps.jevAdapter.decide({
        requestId,
        // JEV-14：STATE 段在主链内组装（事实/证据/约束/选项分离），
        // 使「结论不得冒充证据」与「菜单实时重建」对真实 Jev 调用生效。
        state: this.buildEngineeredState(requestId, prompt, evidence, pool, input),
        evidence,
        candidateModels: pool,
        thresholds,
        preference,
      });
      const profile = buildJevProfile({ answers: res.answers, model: res.model });
      return {
        decisionId: res.decision.decisionId,
        confidence: profile.confidence,
        jevRecommendation: profile.intent,
        answers: normalizeAnswersForDisplay(res.answers),
        rationale: res.decision.rationale,
        decisionSource: 'TYPE_SAFE_JEV',
        profile,
        callLatencyMs: res.callLatencyMs,
        jevUsage: res.usage,
      };
    } catch (err) {
      const reason = err instanceof JevAdapterError ? err.fallbackReason : 'adapter_error';
      const message = err instanceof Error ? err.message : String(err);
      emit('JEV_FALLBACK', { reason, fallbackRuleId: 'local-reimpl-v1', degraded: true, message });

      const local = answerQuestionsLocally({
        requestId,
        evidence,
        models: pool,
        policy: buildPolicy(this.deps.config.routing.preference, preference),
      });
      // 降级时用本地特征构造等价画像，保证下游先验计算逻辑一致。
      const f = extractFeatures(evidence, { tokens: estimateTokens(prompt) });
      const profile: JevRequestProfile = {
        intent: f.intent.noEvidence ? 'other' : f.intent.winner,
        complexity: f.complexity.score,
        capability: f.capability.score,
        urgency: f.urgency.p,
        budget: f.budget.p,
        confidence: local.decision.confidence,
        model: 'local-reimpl',
      };
      return {
        decisionId: local.decision.decisionId,
        confidence: local.decision.confidence,
        jevRecommendation: local.decision.selectedRecommendation,
        answers: normalizeAnswersForDisplay(localJevAnswers(evidence)),
        rationale: `${local.decision.rationale}（Jev 降级原因：${message}）`,
        decisionSource: 'RULE_FALLBACK',
        profile,
      };
    }
  }

  /**
   * 组装送入 Jev 的 6 段状态（`JEV-14`）。
   *
   * 各段职责严格分离，禁止把「结论」写进 FACTS / EVIDENCE：
   * - `GOAL`：用户原始诉求（Jev 直接读用户表达最准）
   * - `FACTS`：系统已核实的客观事实（关键词命中计数、token 估算、附件计数）
   * - `ARTIFACTS`：已存在的产物（当前无附件时为空数组）
   * - `EVIDENCE`：支撑下一步判断的原子证据，逐条带 `verified` 标记
   * - `CONSTRAINTS`：系统不可越过的边界（用户显式给的预算 / 延迟上限、白名单）
   * - `OPTIONS`：当前可执行的选项，由**实时目录**重建（`JEV-14` 菜单实时重建）
   *
   * 结论性短语（如 "probably" / "likely enough"）若出现在 FACTS / EVIDENCE
   * 会被 `assembleState` 拒绝并抛错——这正是 JEV-14 要防的反模式。
   */
  private buildEngineeredState(
    requestId: string,
    prompt: string,
    evidence: RawEvidence,
    pool: CatalogEntry[],
    input: OrchestrateInput,
  ): EngineeredState {
    const hitList = Object.entries(evidence.hits ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([intent, n]) => `${intent} 类关键词命中 ${n} 次`);

    const facts: EvidenceEntry[] = [
      { claim: `输入长度约 ${evidence.tokens ?? 0} tokens`, verified: true, source: 'tokenizer' },
      { claim: `图片 ${evidence.imgCount ?? 0} 张、文档 ${evidence.fileCount ?? 0} 个`, verified: true, source: 'envelope' },
      { claim: `可用能力档位 n_cap=${evidence.nCap ?? 0}`, verified: true, source: 'evidence-extractor' },
    ];

    const evidenceEntries: EvidenceEntry[] = [
      ...hitList.map((claim) => ({ claim, verified: true, source: 'keyword-scan' })),
      { claim: `复杂度评分 ${evidence.scores?.complexity ?? 0}`, verified: true, source: 'evidence-extractor' },
      { claim: `所需能力评分 ${evidence.scores?.capability ?? 0}`, verified: true, source: 'evidence-extractor' },
      { claim: `紧急度先验 ${evidence.probabilities?.urgency ?? 0}`, verified: false, source: 'prior' },
      { claim: `成本敏感先验 ${evidence.probabilities?.budget ?? 0}`, verified: false, source: 'prior' },
    ];

    const constraints: string[] = [];
    if (input.budgetUsd !== undefined) constraints.push(`单次请求预算上限 ${input.budgetUsd} USD`);
    if (input.maxLatencyMs !== undefined) constraints.push(`延迟上限 ${input.maxLatencyMs} ms`);
    if (input.allowedModelIds?.length) {
      constraints.push(`用户已将候选池收窄为 ${input.allowedModelIds.length} 个模型`);
    }

    // OPTIONS 由实时目录重建：Jev 只在**当前真实可选**的模型里判别，
    // 避免在过期菜单上决策（JEV-14 菜单实时重建）。
    const options = pool.map((m) => `${m.modelId}（能力标签：${m.capabilityTags.join('/') || '无'}）`);

    return assembleState({
      goal: prompt,
      facts,
      artifacts: [],
      evidence: evidenceEntries,
      constraints,
      options,
      // 钉住经验版本与请求 id，使同一状态下决策可复现（JEV-16 凭据留痕）。
      stateVersion: `${requestId}:${this.deps.decisionStore.snapshot().updatedAt}`,
    });
  }

  // -------------------------------------------------------------------------
  // 落库
  // -------------------------------------------------------------------------

  /** 热更新决策信息库 + 写入历史库 + 刷新模型信息库评分。 */
  private async finishStores(
    input: OrchestrateInput,
    evidence: RawEvidence,
    payload: {
      decisionId: string;
      executionId?: string;
      routeTier: RouteTier;
      confidence: number;
      thresholds: { high: number; mid: number };
      decisionSource: 'TYPE_SAFE_JEV' | 'RULE_FALLBACK' | 'LOCAL_REIMPL';
      selectedModelId: string;
      jevRecommendation?: string;
      distribution: { modelId: string; probability: number; rankIndex: number }[];
      eliminated: { modelId: string; reason: string }[];
      /** 约束回落登记（JEV-11 附录 G-2）。 */
      constraintFallback?: boolean;
      constraintFallbackReason?: 'allowed_model_ids_not_in_catalog' | 'all_candidates_eliminated';
      eventTypes: string[];
      execution: HistoryEntry['execution'];
      result: string;
      /** Jev 五问（降级时由本地特征派生）。 */
      jevAnswers?: { tag: string; type: 'choice' | 'score' | 'noul'; value: string }[];
    },
  ): Promise<void> {
    const now = new Date();
    const decisionEntry: DecisionRecordEntry = {
      requestId: input.requestId,
      decisionId: payload.decisionId,
      executionId: payload.executionId,
      createdAt: now.toISOString(),
      decisionSource: payload.decisionSource,
      jevAnswers: payload.jevAnswers ?? normalizeAnswersForDisplay(localJevAnswers(evidence)),
      confidence: payload.confidence,
      thresholds: payload.thresholds,
      routeTier: payload.routeTier,
      selectedModelId: payload.selectedModelId,
      jevRecommendation: payload.jevRecommendation,
      distribution: payload.distribution,
      eliminated: payload.eliminated,
      constraintFallback: payload.constraintFallback ?? false,
      constraintFallbackReason: payload.constraintFallbackReason,
      execution: payload.execution,
      resultLength: payload.result.length,
    };
    await this.deps.decisionStore.recordDecision(decisionEntry);
    // 决策信息库更新后立即刷新模型信息库的区分度评分。
    this.deps.modelInfoStore.rescore(this.deps.decisionStore.snapshot());

    const historyEntry: HistoryEntry = {
      requestId: input.requestId,
      decisionId: payload.decisionId,
      executionId: payload.executionId,
      createdAt: now.toISOString(),
      hourBucket: hourBucketOf(now),
      prompt: input.prompt,
      promptSummary: summarizePrompt(input.prompt),
      selectedModelId: payload.selectedModelId,
      jevRecommendation: payload.jevRecommendation,
      routeTier: payload.routeTier,
      confidence: payload.confidence,
      thresholds: payload.thresholds,
      decisionSource: payload.decisionSource,
      execution: payload.execution,
      result: payload.result,
      eventTypes: payload.eventTypes,
    };
    await this.deps.historyStore.append(historyEntry);
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 决策快照里的阈值。 */
function decisionSnapshotThresholds(snapshot: {
  thresholds: { high: number; mid: number };
}): { high: number; mid: number } {
  return { high: snapshot.thresholds.high, mid: snapshot.thresholds.mid };
}

/** 候选池过滤：目录序保持稳定（MODEL-3 下标契约）。
 *
 * 候选池过滤结果。
 *
 * `poolFallback` 记录**用户白名单被忽略**这一事实（JEV-11 正交性登记）：
 * 白名单与目录无交集时，系统为保证可用性回落到全量池——此行为必须可审计，
 * 否则「约束是否真的生效」无从判断。
 */
export interface PoolFilterResult {
  pool: CatalogEntry[];
  /** true = 白名单与目录无交集，已回落到全量可用池。 */
  poolFallback: boolean;
}

/** 导出以便测试断言回落判定（G-2）。 */
export function filterPool(catalog: CatalogEntry[], allowed?: string[]): PoolFilterResult {
  const enabled = catalog.filter((e) => e.enabled && e.health !== 'down');
  if (!allowed || allowed.length === 0) return { pool: enabled, poolFallback: false };
  const allow = new Set(allowed);
  const filtered = enabled.filter((e) => allow.has(e.modelId));
  return filtered.length > 0
    ? { pool: filtered, poolFallback: false }
    : { pool: enabled, poolFallback: true };
}

/** 策略快照：配置偏好 + 本次请求偏好（JEV-9）。 */
function buildPolicy(
  configPreference: 'economy' | 'balanced' | 'quality',
  requestPreference?: 'economy' | 'balanced' | 'quality',
): PolicySnapshot {
  const p = requestPreference ?? configPreference;
  const presets: Record<string, PolicySnapshot> = {
    economy: { w_capability: 0.2, w_quality: 0.2, w_cost: 0.35, w_latency: 0.25, T0: SOFTMAX_T0_DEFAULT, alpha: SOFTMAX_ALPHA_DEFAULT },
    balanced: { w_capability: 0.25, w_quality: 0.25, w_cost: 0.25, w_latency: 0.25, T0: SOFTMAX_T0_DEFAULT, alpha: SOFTMAX_ALPHA_DEFAULT },
    quality: { w_capability: 0.35, w_quality: 0.35, w_cost: 0.15, w_latency: 0.15, T0: SOFTMAX_T0_DEFAULT, alpha: SOFTMAX_ALPHA_DEFAULT },
  };
  return presets[p] ?? presets.balanced;
}

/** 组装发给 LLM 的消息 + 工具定义。 */
function buildMessagesWithTools(prompt: string): {
  messages: ProviderMessage[];
  tools: ToolDefinition[];
} {
  return {
    messages: [
      {
        role: 'system',
        content:
          '你是 Jev 多模型智能路由中枢选中的执行模型。请直接、完整、准确地回答用户请求，' +
          '不要复述问题，不要输出路由元信息。当需要实时信息（天气、新闻、实时数据等）时，' +
          '请主动调用提供的工具获取数据，不要凭训练知识猜测。',
      },
      { role: 'user', content: prompt },
    ],
    tools: BUILTIN_TOOLS,
  };
}

/** Jev 原始答案 → 前端展示形态。 */
function normalizeAnswersForDisplay(
  answers: { questionId: string; primitive: 'choice' | 'score' | 'noul'; choiceWinner?: string; scoreValue?: number; noulProbability?: number }[],
): { tag: string; type: 'choice' | 'score' | 'noul'; value: string }[] {
  return answers.map((a) => {
    let value: string;
    if (a.primitive === 'choice') value = a.choiceWinner ?? '--';
    else if (a.primitive === 'score') value = `${((a.scoreValue ?? 0) * 5).toFixed(1)}/5`;
    else value = `P=${(a.noulProbability ?? 0).toFixed(2)}`;
    return { tag: a.questionId.toUpperCase(), type: a.primitive, value };
  });
}

/** 降级路径：由本地 `extractFeatures` 结果派生等价的 Jev 五问（JevAnswer 形态）。 */
function localJevAnswers(evidence: RawEvidence): JevAnswer[] {
  const f = extractFeatures(evidence, { tokens: evidence.tokens ?? 0 });
  return [
    {
      questionId: 'intent',
      primitive: 'choice',
      choiceWinner: f.intent.noEvidence ? 'other' : f.intent.winner,
      evidenceStrength: f.intent.strength,
    },
    { questionId: 'complexity', primitive: 'score', scoreValue: f.complexity.score, evidenceStrength: f.complexity.strength },
    { questionId: 'urgency', primitive: 'noul', noulProbability: f.urgency.p, evidenceStrength: f.urgency.strength },
    { questionId: 'budget', primitive: 'noul', noulProbability: f.budget.p, evidenceStrength: f.budget.strength },
    { questionId: 'capability', primitive: 'score', scoreValue: f.capability.score, evidenceStrength: f.capability.strength },
  ];
}
