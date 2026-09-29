/**
 * @jev-router/backend — Server-side core module barrel export.
 *
 * Phase 3 (T-3.1 ~ T-3.10): Decision runtime, constraint pipeline,
 * model gateway, and outcome evaluation.
 */

// JEV-12: Decision contract registration & validation
export {
  type DecisionContract,
  type ConsequenceThresholds,
  type ConsequenceLevel,
  type ContractOption,
  type RubricBand,
  type StateSegment,
  type PrimitiveType,
  type ContractErrorCode,
  type ContractValidationError as ContractValidationErrorInfo,
  CHOICE_ESCAPE_HATCHES,
  validateContract,
  registerContract,
  thresholdsFor,
  isIrreversible,
  inferPrimitive,
  ContractValidationError_,
} from './decision-contract.js';

// JEV-13: Three primitive semantic guards
export {
  NOUL_INDISTINGUISHABLE_EPSILON,
  MIN_RUBRIC_BANDS,
  type GuardResult,
  type PrimitiveViolationKind,
  type PrimitiveViolation,
  guardChoiceEscapeHatch,
  guardScoreNotMeasurement,
  interpretScoreBand,
  interpretNoulProbability,
  guardNoulIndistinguishable,
  ScoreInterpretationError,
} from './primitive-guards.js';

// JEV-14: State engineering (6-segment separation)
export {
  type EvidenceEntry,
  type EngineeredState,
  STATE_SEGMENTS,
  type ConclusionScanResult,
  assembleState,
  computeStateHash,
  validateState,
  StateAssemblyError,
} from './state-engineering.js';

// JEV-15: Consequence-graded thresholds
export {
  CONSEQUENCE_THRESHOLDS_DEFAULT,
  type ConsequencePolicy,
  DEFAULT_ACTION_CONSEQUENCES,
  resolveThresholds,
  resolveConsequence,
  consequenceRouteTier,
  validateConsequencePolicy,
  retryPermitted,
} from './consequence-thresholds.js';

// JEV-16: Decision receipt generation & verification
export {
  type ProbabilityEntry,
  type DecisionReceipt,
  type GenerateReceiptInput,
  generateReceipt,
  verifyReproducible,
  summarizeReceipt,
  ReceiptIncompleteError,
} from './decision-receipt.js';

// JEV-7: Decision source marking & audit
export {
  type DecisionSource,
  type JevProvider,
  type DecisionAuditEntry,
  type AuditLogSink,
  InMemoryAuditLog,
  buildAuditEntry,
  assertValidDecisionSource,
  isAuditEntryConsistent,
  InvalidDecisionSourceError,
} from './decision-source.js';

// JEV-12/CONSTRAIN-1/3: Responsibility boundary guards
export {
  type ResponsibilityLayer,
  type BoundaryGuardResult,
  type BoundaryViolationKind,
  type BoundaryViolation,
  guardDecideNotEnforce,
  guardEnforceNotOverrideJev,
  guardHighConfidenceNeedsPolicy,
  enforceSafeOrdering,
  safeOrderingStages,
} from './responsibility-boundary.js';

// MODEL-1/2/3/4: Versioned model catalog
export {
  type CatalogEntry,
  type HealthStatus,
  type VersionedCatalog,
  type CatalogErrorCode,
  CatalogError,
  MVP_SEED_CATALOG,
  validateEntry,
  validateCatalog,
  buildCandidatePool,
  lookupByCatalogIndex,
  lookupByModelId,
  assertSameCatalogVersion,
  detectProfileChanges,
} from './model-catalog.js';

// JEV-6: Decision validator
export {
  type JevDecision,
  validateDecision,
  assertValidDecision,
  InvalidDecisionError,
} from './decision-validator.js';

// JEV-8/10: Local Jev reimplementation
export {
  LOCAL_JEV_DEVIATIONS,
  answerQuestionsLocally,
  getDeviationTable,
  verifyDeviationsRegistered,
} from './local-jev-reimpl.js';

// JEV-1/2/3/9: TypeSafeJevAdapter interface & five questions
export {
  type TypeSafeJevAdapter,
  type JevAdapterConfig,
  type JevQuestion,
  type JevAnswer,
  type JevBatchRequest,
  type JevBatchResponse,
  type PrimitiveKind,
  FIVE_QUESTIONS,
  PREFERENCE_PRIOR_WEIGHTS,
  applyPreferencePrior,
  validateBatchRequest,
  buildFiveQuestionBatch,
} from './jev-adapter.js';

// JEV-11: Decision Runtime main chain
export {
  type MainChainStage,
  type MainChainOutput,
  type StateResult,
  type QuestionsResult,
  type JevResult,
  type ProbabilityResult,
  type RouteResult,
  executeMainChain,
  verifyMainChainOrder,
  verifyTierIndependentOfSelector,
} from './decision-runtime.js';

// CONSTRAIN-1/2/3: Constraint selector (8-step pipeline)
export {
  type ConstraintErrorCode,
  type ConstraintStepResult,
  type ModelConstraintResult,
  type ConstraintInput,
  evaluateConstraints,
  selectEligible,
} from './constraint-selector.js';

// CONSTRAIN-4/5: Degradation & shadow mode
export {
  type FallbackRule,
  type DegradationResult,
  type ShadowDecision,
  type ShadowModeConfig,
  evaluateDegradation,
  runShadow,
  checkShadowPromotion,
} from './degradation.js';

// RESULT-2: Model Gateway (provider adapters, stream, retry, cancel)
export {
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderMessage,
  type StreamChunk,
  type TokenUsage,
  type RetryPolicy,
  type ModelGatewayConfig,
  type InvocationRecord,
  type GatewayErrorCode,
  DEFAULT_RETRY_POLICY,
  DEFAULT_GATEWAY_CONFIG,
  GatewayError,
  ModelGateway,
} from './model-gateway.js';

// EXP-1: Outcome Evaluator (quality / cost / latency / feedback)
export {
  type ExperienceEntry,
  type QualityMetrics,
  type OutcomeData,
  type OutcomeEvaluatorConfig,
  type OutcomeErrorCode,
  SOURCE_WEIGHTS,
  QUALITY_WEIGHTS,
  DEFAULT_OUTCOME_CONFIG,
  OutcomeEvaluator,
  OutcomeError,
  inferOutcomeSource,
  inferOutcomeLabel,
  inferOutcomeStatus,
} from './outcome-evaluator.js';

// ───────────────────────────────────────────────────────────────────────────
// Phase 4 — Experience Loop (T-4.1 ~ T-4.11)
// ───────────────────────────────────────────────────────────────────────────

// EXP-1 / ARCHIVE-1: Experience Store (async write, retrieval)
export {
  type IntentModelKey,
  type ExperienceStoreErrorCode,
  ExperienceStoreError,
  type ExperienceStoreConfig,
  DEFAULT_EXPERIENCE_STORE_CONFIG,
  ExperienceStore,
  validateExperienceEntry,
} from './experience-store.js';

// EXP-9: Experience version management (append-only, monotonic)
export {
  type ExperienceVersionTrigger,
  type VersionChangeSummary,
  type PriorSnapshotMap,
  type ExperienceVersion,
  type CreateVersionInput,
  type ExperienceVersionErrorCode,
  ExperienceVersionError,
  ExperienceVersionManager,
  samplesToSnapshotInput,
} from './experience-version.js';

// EXP-4: Experience reflow channel (read active version, inject Δraw)
export {
  type ReflowDecision,
  type ReflowDiff,
  ExperienceReflow,
  pinVersion,
} from './experience-reflow.js';

// EXP-9: Atomic rollback (state exactly equals target version)
export {
  type RollbackResult,
  type ExperienceRollbackErrorCode,
  ExperienceRollbackError,
  ExperienceRollback,
  verifyRollbackAtomicity,
  getEffectiveVersion,
} from './experience-rollback.js';

// EXP-6 / ARCHIVE-3: Pinned-version replay
export {
  type ReplayMode,
  type PinnedReplayResult,
  type PinnedReplayInput,
  type ExperienceReplayErrorCode,
  ExperienceReplayError,
  ExperienceReplay,
  pinArchive,
} from './experience-replay.js';

// EXP-8: Cold-start guard & shadow protection
export {
  type ColdStartResult,
  checkColdStart,
  getPairSampleCount,
  type ShadowGuardConfig,
  DEFAULT_SHADOW_GUARD_CONFIG,
  type ShadowGuardResult,
  shouldShadow,
  getSampleCount,
} from './cold-start-guard.js';

// EXP-3: Threshold recalibration suggestions (NOT auto-apply)
export {
  type ThresholdOptimizationTarget,
  type ThresholdSample,
  type ThresholdKind,
  type CounterfactualExplanation,
  type ThresholdSuggestion,
  type ThresholdSuggestionConfig,
  DEFAULT_THRESHOLD_SUGGESTION_CONFIG,
  type ThresholdSuggestionErrorCode,
  ThresholdSuggestionError,
  ThresholdSuggestionGenerator,
  computeCoverage,
  computeLowConfidencePrecision,
  computeTakeover,
  computeCounterfactual,
  validateConfig as validateSuggestionConfig,
} from './threshold-suggestion.js';

// EXP-10: Closed-loop auto-validator (before/after segment comparison)
export {
  type ValidationVerdict,
  type SegmentMetrics,
  type ValidationResult,
  type SegmentSplit,
  type ExperienceValidatorErrorCode,
  ExperienceValidatorError,
  EXP10_MIN_POST_SEGMENT,
  EXP10_NEUTRAL_DELTA,
  ExperienceValidator,
  computeMetrics,
  decideVerdict,
  explainVerdict,
  pickRollbackTarget,
} from './experience-validator.js';

// ARCHIVE-5 / API-4: Human review writeback & calibration export
export {
  type ReviewSubmission,
  type ReviewWritebackResult,
  type ReviewRecord,
  type ThresholdApprovalSubmission,
  type ThresholdApprovalResult,
  type CalibrationExportRow,
  type CalibrationExport,
  type HumanReviewErrorCode,
  HumanReviewError,
  HumanReviewManager,
  idempotencyKey,
  thresholdApprovalKey,
  redactComment,
} from './human-review.js';

// ARCHIVE-2 / ARCHIVE-4: Archive persistence (versioned keys, dirty data defense)
export {
  type PersistenceMode,
  type ArchiveRecord,
  type ArchivePersistenceConfig,
  DEFAULT_ARCHIVE_PERSISTENCE_CONFIG,
  type ArchivePersistenceErrorCode,
  ArchivePersistenceError,
  ArchivePersistence,
  archiveKey,
  buildArchiveKey,
  validateEntry as validateArchiveEntry,
  redactPiiInEntry,
  parseArchiveKey,
} from './archive-persistence.js';

// ───────────────────────────────────────────────────────────────────────────
// Phase 5 — Event Stream & Observability (T-5.1 ~ T-5.6)
// Another agent may be working on Phase 4 in parallel; these exports are
// kept in a separate section so merge conflicts are minimal.
// ───────────────────────────────────────────────────────────────────────────

// EVENT-1: RouteEvent contract & EventBus
export {
  type RouteEvent,
  type RouteEventType,
  type RouteEventPayloads,
  type RouteEventErrorCode,
  type EventSubscriber,
  type Subscription,
  ROUTE_EVENT_TYPES,
  RouteEventError,
  validateEvent,
  isValidEvent,
  createEvent,
  contentAddressedEventId,
  serializeEvent,
  EventBus,
} from './route-event.js';

// EVENT-2: Event idempotency & dedup
export {
  type EventDedupErrorCode,
  DEFAULT_DEDUP_BUFFER_SIZE,
  EventDedupError,
  EventDeduplicator,
  deduplicateEvents,
} from './event-dedup.js';

// EVENT-3 / API-2: SSE event stream & reconnection compensation
export {
  type SSESink,
  type SSEStreamOptions,
  type SSEStream,
  type SSEStreamErrorCode,
  DEFAULT_SSE_HEARTBEAT_MS,
  DEFAULT_SSE_REPLAY_BUFFER,
  SSEStreamError,
  SSEReplayBuffer,
  parseLastEventId,
  formatSSEData,
  formatHeartbeat,
  formatSSError,
  createSSEStream,
} from './sse-stream.js';

// EVENT-4: Full-chain trace & metrics aggregation
export {
  type TraceDimensions,
  type ExecutionSegment,
  type DecisionSegment,
  type RequestTrace,
  type AggregatedMetrics,
  type TraceErrorCode,
  TraceError,
  TraceAggregator,
} from './trace-aggregator.js';

// EVENT-4 (selectionMode): TYPE_SAFE_JEV / RULE_FALLBACK / USER_OVERRIDE distinction
export {
  type SelectionMode,
  type SelectionTaggedRecord,
  type SelectionModeErrorCode,
  SELECTION_MODES,
  SelectionModeError,
  toSelectionMode,
  tagSelectionMode,
  getSelectionMode,
  validateSelectionMode,
  groupBySelectionMode,
  filterBySelectionMode,
} from './selection-mode.js';

// API-1 ~ API-3 + B4/EXP-2: Route creation, catalog, health, and experience handlers
export {
  type RouteStatus,
  type CreateRouteRequest,
  type CreateRouteResponse,
  type RouteRecord,
  type RouteEventsResponse,
  type CatalogResponse,
  type RouteApiErrorCode,
  RouteApiError,
  RouteRegistry,
  // B4/EXP-2 types
  type HealthCheckResponse,
  type ExperienceStatsResponse,
  type DecisionRecord,
  // API-1 ~ API-3 handlers
  createRoute,
  getRouteStatus,
  getRouteEvents,
  getCatalog,
  // B4/EXP-2 handlers
  healthCheck,
  getExperienceStats,
  // Registration helpers
  registerReceipt,
  storeContract,
  registerDecision,
  // State machine helpers
  beginDeciding,
  beginExecuting,
  completeRoute,
  failRoute,
  emitRouteEscalated,
  emitModelCompleted,
  emitModelStreaming,
} from './route-api.js';

// ───────────────────────────────────────────────────────────────────────────
// Phase 7 — Tenant Governance (T-7.1)
// ───────────────────────────────────────────────────────────────────────────

// T-7.1 / A11Y-3: Privacy, data-minimization, tenant isolation, audit trail
export {
  type AuditAction,
  type TenantContext,
  type AuditEntry,
  type AuditQueryFilters,
  type TenantGovernanceErrorCode,
  type ProviderValidationResult,
  TenantGovernanceError,
  sanitizePrompt,
  sanitizeModelOutput,
  validateProviderResponse,
  AuditLog,
  TenantIsolationGuard,
} from './tenant-governance.js';

// T-7.2 / C3: Key security — server-side only, frontend zero-key
export {
  type ProviderKey,
  type KeyLeakReport,
  KeyVault,
  scrubResponse,
  KeyLeakDetector,
  assertNoKeyInFrontendPayload,
} from './key-security.js';

// ───────────────────────────────────────────────────────────────────────────
// LLM-sdd.md — 四大模块 + 真实执行链路
// ───────────────────────────────────────────────────────────────────────────

// 一、模型配置文件
export {
  type AppConfig,
  type PublicAppConfig,
  type JevEndpointConfig,
  type LlmLibraryConfig,
  type StorageConfig,
  type RoutingConfig,
  type ConfigErrorCode,
  ConfigError,
  loadConfig,
  buildConfig,
  defaultConfigPath,
  resolveDataDir,
  resolveEndpoint,
  toPublicConfig,
  inferModelProfile,
  inferVendor,
  ensureVendorFields,
} from './app-config.js';

// 二、决策信息库
export {
  type DecisionStoreFile,
  type DecisionRecordEntry,
  type ModelDecisionStat,
  type DecisionStoreOptions,
  DecisionStore,
  DECISION_RECENT_LIMIT,
  THRESHOLD_DYNAMIC_MIN_SAMPLES,
} from './decision-store.js';

// 三、模型信息库
export {
  type ModelInfoFile,
  type ModelInfoEntry,
  type ModelInfoStoreOptions,
  type VendorGroup,
  ModelInfoStore,
  scoreDiscrimination,
  buildAuthHeaders,
  groupByVendor,
} from './model-info-store.js';

// 四、历史库
export {
  type HistoryEntry,
  type HistoryHourFile,
  type HistoryQueryResult,
  type HistoryStoreOptions,
  HistoryStore,
  hourBucketOf,
  summarizePrompt,
  HISTORY_HOUR_LIMIT,
} from './history-store.js';

// Prompt 证据提取（STATE 段）
export { extractPromptEvidence, estimateTokens } from './prompt-evidence.js';

// 真实 Jev System One HTTP 适配器
export {
  type JevAdapterErrorCode,
  type NoulCriteria,
  type SystemOneQuestion,
  type SystemOneRequest,
  type SystemOneResponse,
  type SystemOneNoulAnswer,
  type SystemOneScoreAnswer,
  type SystemOneChoiceAnswer,
  type JevDecisionResult,
  type JevHttpAdapterOptions,
  JevAdapterError,
  SystemOneJevAdapter,
  buildRoutingQuestions,
  INTENT_CHOICES,
  COMPLEXITY_LEVELS,
  CAPABILITY_LEVELS,
  DEFAULT_JEV_MODEL,
} from './jev-http-adapter.js';

// Jev 类型化答案 → 候选模型先验
export {
  type JevRequestProfile,
  type JevPriorWeights,
  DEFAULT_JEV_PRIOR_WEIGHTS,
  MAX_PRIOR_DELTA,
  buildJevProfile,
  jevPriorDeltas,
  explainJevPrior,
} from './jev-routing.js';

// LLM 模型库 Provider 适配器
export {
  type LlmProviderAdapterOptions,
  LlmLibraryProviderAdapter,
  iterateSse,
} from './llm-provider-adapter.js';

// 路由编排器
export {
  type OrchestratorDeps,
  type OrchestrateInput,
  type OrchestrateOutcome,
  RouteOrchestrator,
} from './route-orchestrator.js';

// HTTP server layer
export { createServer, createAppServices, type AppServices } from './server.js';
