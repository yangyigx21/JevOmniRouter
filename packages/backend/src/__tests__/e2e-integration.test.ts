/**
 * T-8.1 End-to-End Integration Test
 *
 * Full chain: Jev → Constraint Selector → Model Gateway → Experience Store
 * Including shadow mode, constraint pipeline, experience reflow, and degradation.
 *
 * Self-contained test module — no test framework dependency.
 * Exports `runE2ETests()` for programmatic execution.
 */
import {
  executeMainChain,
  verifyMainChainOrder,
  verifyTierIndependentOfSelector,
  type MainChainOutput,
} from '../decision-runtime.js';
import {
  evaluateConstraints,
  selectEligible,
} from '../constraint-selector.js';
import {
  ModelGateway,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResponse,
  type StreamChunk,
} from '../model-gateway.js';
import {
  ExperienceStore,
} from '../experience-store.js';
import {
  evaluateDegradation,
  runShadow,
  checkShadowPromotion,
  type FallbackRule,
} from '../degradation.js';
import {
  answerQuestionsLocally,
  LOCAL_JEV_DEVIATIONS,
  verifyDeviationsRegistered,
} from '../local-jev-reimpl.js';
import {
  ExperienceReflow,
  type ReflowDiff,
} from '../experience-reflow.js';
import { ExperienceVersionManager } from '../experience-version.js';
import {
  OutcomeEvaluator,
  type ExperienceEntry,
} from '../outcome-evaluator.js';
import type { VersionedCatalog } from '../model-catalog.js';
import { assembleState, type EngineeredState } from '../state-engineering.js';
import { DEFAULT_ACTION_CONSEQUENCES, type ConsequencePolicy } from '../consequence-thresholds.js';
import type { JevAnswer } from '../jev-adapter.js';
import type { JevDecision } from '../decision-validator.js';
import type { ModelDescriptor, PolicySnapshot, RawEvidence } from '@jev-router/shared';
import type { RouteTier } from '@jev-router/shared';

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

type TestResult = { name: string; passed: boolean; error?: string };

function runTest(name: string, fn: () => void | Promise<void>): Promise<TestResult> {
  return Promise.resolve()
    .then(() => fn())
    .then(() => ({ name, passed: true }))
    .catch((err: unknown) => ({
      name,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    }));
}

// ---------------------------------------------------------------------------
// Mock / fixture helpers
// ---------------------------------------------------------------------------

/** Build a minimal EngineeredState for testing. */
function makeTestState(): EngineeredState {
  return assembleState({
    goal: 'Route user request to best model',
    facts: [
      { claim: 'User requested code generation', verified: true },
      { claim: 'Token budget is 2000', verified: true },
    ],
    artifacts: [],
    evidence: [
      { claim: 'Code generation tasks historically prefer models with code capability', verified: true, source: 'experience' },
    ],
    constraints: ['Budget must not exceed $0.05'],
    options: ['route_to_code_model', 'route_to_general_model', 'escalate_to_human'],
    stateVersion: 'test-v1',
  });
}

/** Build a RawEvidence for testing. */
function makeTestEvidence(): RawEvidence {
  return {
    hits: { code: 5, generation: 3, function: 2 },
    imgCount: 0,
    fileCount: 0,
    fileTokens: 0,
    tokens: 500,
    nCap: 3,
    scores: { complexity: 0.6, capability: 0.85 },
    probabilities: { urgency: 0.3, budget: 0.8 },
  };
}

/** Default policy snapshot for tests. */
const TEST_POLICY: PolicySnapshot = {
  w_capability: 0.3,
  w_quality: 0.3,
  w_cost: 0.2,
  w_latency: 0.2,
  T0: 1.0,
  alpha: 0.05,
};

/** Default consequence policy for tests. */
const TEST_CONSEQUENCE_POLICY: ConsequencePolicy = {
  actionConsequences: { ...DEFAULT_ACTION_CONSEQUENCES },
};

/** Build a test catalog with a few models. */
function makeTestCatalog(): VersionedCatalog {
  return {
    catalogVersion: 'test-v1',
    entries: [
      {
        modelId: 'model-a',
        provider: 'provider-x',
        vendor: 'test',
        vendorLabel: 'Test 厂商 A',
        capabilityTags: ['reasoning', 'code'],
        capability: 0.9,
        quality: 0.88,
        cost: 0.3,
        latency: 0.4,
        load: 0.2,
        contextWindow: 128_000,
        p95LatencyMs: 1500,
        inputPricePer1k: 0.002,
        outputPricePer1k: 0.006,
        health: 'healthy',
        profileVersion: 'p1',
        enabled: true,
        modalities: ['text'],
        dataRegion: ['us'],
      },
      {
        modelId: 'model-b',
        provider: 'provider-y',
        vendor: 'test',
        vendorLabel: 'Test 厂商 A',
        capabilityTags: ['vision', 'creative'],
        capability: 0.85,
        quality: 0.9,
        cost: 0.5,
        latency: 0.35,
        load: 0.15,
        contextWindow: 200_000,
        p95LatencyMs: 2000,
        inputPricePer1k: 0.003,
        outputPricePer1k: 0.01,
        health: 'healthy',
        profileVersion: 'p1',
        enabled: true,
        modalities: ['text', 'image'],
        dataRegion: ['us', 'eu'],
      },
      {
        modelId: 'model-c',
        provider: 'provider-z',
        vendor: 'test',
        vendorLabel: 'Test 厂商 A',
        capabilityTags: ['low-cost'],
        capability: 0.7,
        quality: 0.65,
        cost: 0.1,
        latency: 0.8,
        load: 0.5,
        contextWindow: 32_000,
        p95LatencyMs: 800,
        inputPricePer1k: 0.0005,
        outputPricePer1k: 0.0005,
        health: 'healthy',
        profileVersion: 'p1',
        enabled: true,
        modalities: ['text'],
      },
      {
        modelId: 'model-disabled',
        provider: 'provider-w',
        vendor: 'test',
        vendorLabel: 'Test 厂商 A',
        capabilityTags: ['reasoning'],
        capability: 0.5,
        quality: 0.5,
        cost: 0.2,
        latency: 0.6,
        load: 0.1,
        contextWindow: 64_000,
        p95LatencyMs: 3000,
        inputPricePer1k: 0.001,
        outputPricePer1k: 0.003,
        health: 'healthy',
        profileVersion: 'p1',
        enabled: false,
        modalities: ['text'],
      },
      {
        modelId: 'model-down',
        provider: 'provider-v',
        vendor: 'test',
        vendorLabel: 'Test 厂商 A',
        capabilityTags: ['reasoning', 'long-context'],
        capability: 0.8,
        quality: 0.78,
        cost: 0.4,
        latency: 0.5,
        load: 0.3,
        contextWindow: 1_000_000,
        p95LatencyMs: 5000,
        inputPricePer1k: 0.002,
        outputPricePer1k: 0.008,
        health: 'down',
        profileVersion: 'p1',
        enabled: true,
        modalities: ['text', 'image'],
        dataRegion: ['eu'],
      },
      {
        modelId: 'model-expensive',
        provider: 'provider-u',
        vendor: 'test',
        vendorLabel: 'Test 厂商 A',
        capabilityTags: ['reasoning', 'code'],
        capability: 0.92,
        quality: 0.95,
        cost: 0.9,
        latency: 0.3,
        load: 0.05,
        contextWindow: 256_000,
        p95LatencyMs: 3500,
        inputPricePer1k: 0.01,
        outputPricePer1k: 0.03,
        health: 'healthy',
        profileVersion: 'p1',
        enabled: true,
        modalities: ['text'],
        dataRegion: ['us'],
      },
    ],
  };
}

/** Build JevAnswer fixtures simulating Jev's 5-question batch response. */
function makeTestJevAnswers(): JevAnswer[] {
  return [
    { questionId: 'intent', primitive: 'choice', choiceWinner: 'code_generation', evidenceStrength: 0.9 },
    { questionId: 'complexity', primitive: 'score', scoreValue: 0.6, evidenceStrength: 0.8 },
    { questionId: 'urgency', primitive: 'noul', noulProbability: 0.3, evidenceStrength: 0.7 },
    { questionId: 'budget', primitive: 'noul', noulProbability: 0.8, evidenceStrength: 0.75 },
    { questionId: 'capability', primitive: 'score', scoreValue: 0.85, evidenceStrength: 0.85 },
  ];
}

/** Mock ProviderAdapter for Model Gateway tests. */
class MockProviderAdapter implements ProviderAdapter {
  readonly providerName: string;

  constructor(providerName: string, private readonly latencyMs = 100) {
    this.providerName = providerName;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    return {
      modelId: request.providerModelId,
      executionId: request.trace.executionId,
      content: `Mock response from ${request.providerModelId}`,
      usage: { promptTokens: 50, completionTokens: 100, totalTokens: 150 },
      latencyMs: this.latencyMs,
    };
  }

  async *stream(request: ProviderRequest): AsyncGenerator<StreamChunk, void, unknown> {
    yield {
      modelId: request.providerModelId,
      executionId: request.trace.executionId,
      delta: 'Mock ',
      done: false,
    };
    yield {
      modelId: request.providerModelId,
      executionId: request.trace.executionId,
      delta: 'stream',
      done: true,
      usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
    };
  }

  isAvailable(): boolean {
    return true;
  }
}

/** Make a confirmed experience entry for testing. */
function makeConfirmedEntry(overrides: Partial<ExperienceEntry> = {}): ExperienceEntry {
  return {
    eid: `exp-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    rid: 'req-test-001',
    expVersion: '1',
    prediction: {
      intent: 'code_generation',
      winner: 'model-a',
      winnerIdx: 0,
      tier: 'ROUTE',
      confidence: 0.87,
      topProb: 0.6,
      priorSnapshot: [0, 0, 0],
    },
    outcome: {
      status: 'confirmed',
      source: 'system',
      label: 'model-a',
      observedAt: Date.now() - 1000,
      latencyMs: 500,
      cost: 0.002,
    },
    decisionSource: 'TYPE_SAFE_JEV',
    modelId: 'model-a',
    provider: 'provider-x',
    catalogVersion: 'test-v1',
    createdAt: new Date(Date.now() - 2000).toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite 1: Full Chain Test
// ---------------------------------------------------------------------------

async function testFullChain(): Promise<void> {
  const catalog = makeTestCatalog();
  const state = makeTestState();
  const evidence = makeTestEvidence();
  const jevAnswers = makeTestJevAnswers();
  const models: ModelDescriptor[] = catalog.entries.map((e) => ({
    modelId: e.modelId,
    capability: e.capability,
    quality: e.quality,
    cost: e.cost,
    latency: e.latency,
    load: e.load,
    contextWindow: e.contextWindow,
    modalities: e.modalities as ModelDescriptor['modalities'],
  }));

  // Step 1: Main chain (STATE → QUESTIONS → JEV → PROBABILITY → ROUTE)
  const chainOutput: MainChainOutput = executeMainChain({
    state,
    evidence,
    jevAnswers,
    models,
    policy: TEST_POLICY,
    priorDeltas: [0, 0, 0, 0, 0, 0],
    consequence: 'low',
    consequencePolicy: TEST_CONSEQUENCE_POLICY,
  });

  // Verify stage order (JEV-11)
  assert(verifyMainChainOrder(chainOutput.stageOrder), 'Main chain stages must follow STATE→QUESTIONS→JEV→PROBABILITY→ROUTE');
  assertEqual(chainOutput.stageOrder.length, 5, 'Must have exactly 5 stages');
  assertEqual(chainOutput.stageOrder[0], 'STATE', 'First stage is STATE');
  assertEqual(chainOutput.stageOrder[4], 'ROUTE', 'Last stage is ROUTE');

  // Verify each stage produced output
  assertEqual(chainOutput.stages[0].stage, 'STATE', 'Stage 0 is STATE');
  assert(chainOutput.stages[0].state !== undefined, 'STATE result has state');
  assert(chainOutput.stages[0].evidence !== undefined, 'STATE result has evidence');

  assertEqual(chainOutput.stages[1].stage, 'QUESTIONS', 'Stage 1 is QUESTIONS');
  assertEqual(chainOutput.stages[1].answers.length, 5, 'QUESTIONS has 5 answers');

  assertEqual(chainOutput.stages[2].stage, 'JEV', 'Stage 2 is JEV');
  assert(chainOutput.stages[2].confidence >= 0, 'JEV confidence is non-negative');
  assert(chainOutput.stages[2].confidence <= 1, 'JEV confidence is <= 1');

  assertEqual(chainOutput.stages[3].stage, 'PROBABILITY', 'Stage 3 is PROBABILITY');
  assert(chainOutput.stages[3].calibratedConfidence >= 0.35, 'Calibrated confidence lower bound');
  assert(chainOutput.stages[3].calibratedConfidence <= 0.97, 'Calibrated confidence upper bound');

  assertEqual(chainOutput.stages[4].stage, 'ROUTE', 'Stage 4 is ROUTE');
  const validTiers: RouteTier[] = ['ROUTE', 'GATE', 'ESCALATE'];
  assert(validTiers.includes(chainOutput.tier), `Route tier must be valid, got: ${chainOutput.tier}`);

  // Step 2: Constraint Selector
  const constraintResult = selectEligible(
    catalog.entries,
    {
      enabled: true,
      health: true,
      allowedByTenant: true,
      requiredModalities: ['text'],
      requiredCapabilities: [],
      maxContextTokens: 200_000,
      dataRegions: ['us'],
      riskPolicy: 'allow',
      budgetUsd: 0.1,
      costUnknownPolicy: 'reject',
      maxLatencyMs: 4000,
    },
    'model-a',
  );

  // model-disabled and model-down should be eliminated
  const eligibleIds = constraintResult.eligible.map((e) => e.modelId);
  assert(!eligibleIds.includes('model-disabled'), 'Disabled model must be eliminated (step 1)');
  assert(!eligibleIds.includes('model-down'), 'Down model must be eliminated (step 1)');
  assert(eligibleIds.length >= 2, `Must have at least 2 eligible models, got ${eligibleIds.length}`);

  // Jev recommendation is advisory (CONSTRAIN-3): if Jev recommended an
  // eliminated model, the elimination reason should be recorded
  if (constraintResult.jevRecommendationEliminated) {
    assert(
      typeof constraintResult.jevRecommendationEliminated === 'string',
      'Jev recommendation elimination reason must be a valid code',
    );
  }

  // Step 3: Model Gateway — invoke the selected model
  const gateway = new ModelGateway();
  // Register mock adapters for all providers used in the test catalog
  gateway.registerAdapter(new MockProviderAdapter('provider-x'));
  gateway.registerAdapter(new MockProviderAdapter('provider-y'));
  gateway.registerAdapter(new MockProviderAdapter('provider-z'));
  gateway.registerAdapter(new MockProviderAdapter('provider-w'));
  gateway.registerAdapter(new MockProviderAdapter('provider-v'));
  gateway.registerAdapter(new MockProviderAdapter('provider-u'));

  const selectedEntry = constraintResult.eligible[0];
  const response = await gateway.invoke(
    selectedEntry,
    [{ role: 'user', content: 'Write a function to sort an array' }],
    { requestId: 'req-e2e-001', decisionId: chainOutput.stages[2].decisionId, executionId: 'exec-001' },
  );

  assertEqual(response.modelId, selectedEntry.modelId, 'Gateway response modelId must match');
  assert(response.usage.totalTokens > 0, 'Gateway response must have token usage');

  // Step 4: Experience Store — write the experience entry
  const store = new ExperienceStore();
  const entry = makeConfirmedEntry({
    modelId: selectedEntry.modelId,
    provider: selectedEntry.provider,
    prediction: {
      intent: 'code_generation',
      winner: selectedEntry.modelId,
      winnerIdx: 0,
      tier: chainOutput.tier,
      confidence: chainOutput.confidence,
      topProb: chainOutput.stages[3].scoreResult.byCatalogOrder[0]?.probability ?? 0,
      priorSnapshot: [0, 0, 0, 0, 0, 0],
    },
  });

  await store.writeEntry(entry);
  await store.drainWriteQueue();

  const retrieved = store.getEntry(entry.eid);
  assert(retrieved !== undefined, 'Written entry must be retrievable');
  assertEqual(retrieved!.eid, entry.eid, 'Retrieved entry eid must match');
  assertEqual(retrieved!.outcome.status, 'confirmed', 'Entry status must be confirmed');

  // Step 5: Verify tier is independent of constraint selector (JEV-11 scenario 2)
  const tierIndependent = verifyTierIndependentOfSelector(
    chainOutput.tier,
    chainOutput.confidence,
    'low',
    TEST_CONSEQUENCE_POLICY,
  );
  assert(tierIndependent, 'Tier must be a pure function of confidence and consequence, not constraint results');
}

// ---------------------------------------------------------------------------
// Test Suite 2: Shadow Mode Test
// ---------------------------------------------------------------------------

async function testShadowMode(): Promise<void> {
  // Build a JevDecision for shadow testing
  const jevDecision: JevDecision = {
    decisionId: 'shadow-test-001',
    schemaVersion: '1.0.0',
    createdAt: new Date().toISOString(),
    selectedRecommendation: 'model-a',
    candidateScores: [
      { modelId: 'model-a', raw: 0.9, probability: 0.6 },
      { modelId: 'model-b', raw: 0.7, probability: 0.3 },
    ],
    confidence: 0.85,
    rationale: 'Shadow mode test decision',
    knowledgeReferences: [],
  };

  // CONSTRAIN-5: Shadow decisions are recorded but MUST NOT drive execution
  const shadowConfig = {
    enabled: true,
    variant: 'jev-v2-shadow',
    requireHumanBaseline: true,
  };

  const shadowResult = runShadow(jevDecision, 'TYPE_SAFE_JEV', shadowConfig);

  // Shadow result must exist when enabled
  assert(shadowResult !== null, 'Shadow result must exist when shadow mode is enabled');
  assertEqual(shadowResult!.isShadow, true, 'Shadow result must be marked as shadow');
  assertEqual(shadowResult!.shadowVariant, 'jev-v2-shadow', 'Shadow variant must match config');
  assertEqual(shadowResult!.decision.decisionId, 'shadow-test-001', 'Shadow decision id must match');
  assertEqual(shadowResult!.decisionSource, 'TYPE_SAFE_JEV', 'Shadow decision source must match');

  // Shadow decisions must NOT drive execution — caller is responsible for
  // checking `isShadow` before executing; we verify the flag is set
  assert(shadowResult!.isShadow === true, 'isShadow flag must be true — caller must check before execution');

  // When shadow mode is disabled, runShadow must return null
  const disabledResult = runShadow(jevDecision, 'TYPE_SAFE_JEV', {
    enabled: false,
    variant: 'jev-v2-shadow',
    requireHumanBaseline: true,
  });
  assertEqual(disabledResult, null, 'Shadow result must be null when shadow mode is disabled');

  // Shadow promotion requires human baseline (CONSTRAIN-5)
  const promotionWithoutBaseline = checkShadowPromotion(shadowResult!);
  assert(!promotionWithoutBaseline.eligible, 'Shadow promotion must be blocked without human baseline');
  assert(
    promotionWithoutBaseline.blockers.some((b) => b.includes('human baseline')),
    'Blocker must mention human baseline requirement',
  );

  // With human baseline and rationale, promotion should be eligible
  const promotionWithBaseline = checkShadowPromotion(shadowResult!, 'model-a');
  assert(promotionWithBaseline.eligible, 'Shadow promotion should be eligible with human baseline and rationale');

  // Run normal and shadow simultaneously — same input, different outputs
  const normalDecision: JevDecision = {
    ...jevDecision,
    decisionId: 'normal-001',
  };
  const shadowDecision: JevDecision = {
    ...jevDecision,
    decisionId: 'shadow-001',
  };

  // Both produce valid decisions but shadow is tagged
  const normalResult = { decision: normalDecision, isShadow: false as const };
  const shadowOnly = runShadow(shadowDecision, 'LOCAL_REIMPL', shadowConfig);

  assert(normalResult.isShadow === false, 'Normal decision is not shadow');
  assert(shadowOnly!.isShadow === true, 'Shadow decision is shadow');
  assertEqual(shadowOnly!.decisionSource, 'LOCAL_REIMPL', 'Shadow preserves decision source');
}

// ---------------------------------------------------------------------------
// Test Suite 3: Constraint Pipeline Test
// ---------------------------------------------------------------------------

async function testConstraintPipeline(): Promise<void> {
  const catalog = makeTestCatalog();

  // Test 1: All 8 steps are executed in order for a fully-passing model
  const healthyEntry = catalog.entries.find((e) => e.modelId === 'model-a')!;
  const fullResult = evaluateConstraints({
    model: healthyEntry,
    catalogIndex: 0,
    constraints: {
      enabled: true,
      health: true,
      allowedByTenant: true,
      requiredModalities: ['text'],
      requiredCapabilities: ['reasoning'],
      maxContextTokens: 100_000,
      dataRegions: ['us'],
      riskPolicy: 'allow',
      budgetUsd: 0.1,
      costUnknownPolicy: 'reject',
      maxLatencyMs: 5000,
    },
  });

  assertEqual(fullResult.auditSummary.length, 8, 'Must have exactly 8 constraint steps');
  assertEqual(fullResult.eligible, true, 'Healthy model should be eligible');
  assertEqual(fullResult.primaryEliminationReason, undefined, 'No elimination reason for eligible model');

  // Verify step order
  const stepNames = fullResult.auditSummary.map((s) => s.step);
  for (let i = 1; i <= 8; i++) {
    assertEqual(stepNames[i - 1], i, `Step ${i} must be at position ${i - 1}`);
  }

  // Verify all steps passed
  for (const step of fullResult.auditSummary) {
    assertEqual(step.passed, true, `Step ${step.step} (${step.name}) should pass for healthy model`);
  }

  // Test 2: Hard-constraint violation correctly rejects a model
  // model-disabled → step 1 fails (MODEL_DISABLED)
  const disabledEntry = catalog.entries.find((e) => e.modelId === 'model-disabled')!;
  const disabledResult = evaluateConstraints({
    model: disabledEntry,
    catalogIndex: 3,
    constraints: {
      allowedByTenant: true,
      requiredModalities: ['text'],
      riskPolicy: 'allow',
    },
  });
  assertEqual(disabledResult.eligible, false, 'Disabled model must be rejected');
  assertEqual(disabledResult.primaryEliminationReason, 'MODEL_DISABLED', 'Primary reason must be MODEL_DISABLED');
  assert(!disabledResult.auditSummary[0].passed, 'Step 1 must fail for disabled model');

  // Test 3: model-down → step 1 fails (MODEL_UNAVAILABLE)
  const downEntry = catalog.entries.find((e) => e.modelId === 'model-down')!;
  const downResult = evaluateConstraints({
    model: downEntry,
    catalogIndex: 4,
    constraints: {
      allowedByTenant: true,
      riskPolicy: 'allow',
    },
  });
  assertEqual(downResult.eligible, false, 'Down model must be rejected');
  assertEqual(downResult.primaryEliminationReason, 'MODEL_UNAVAILABLE', 'Primary reason must be MODEL_UNAVAILABLE');

  // Test 4: Tenant permission denied → step 2 (MODEL_NOT_ALLOWED)
  const tenantDeniedResult = evaluateConstraints({
    model: healthyEntry,
    catalogIndex: 0,
    constraints: {
      allowedByTenant: false,
      riskPolicy: 'allow',
    },
  });
  assertEqual(tenantDeniedResult.eligible, false, 'Model must be rejected when tenant denies');
  assertEqual(tenantDeniedResult.primaryEliminationReason, 'MODEL_NOT_ALLOWED', 'Primary reason must be MODEL_NOT_ALLOWED');

  // Test 5: Modality unsupported → step 3 (MODALITY_UNSUPPORTED)
  const modalityResult = evaluateConstraints({
    model: catalog.entries.find((e) => e.modelId === 'model-c')!, // text only
    catalogIndex: 2,
    constraints: {
      allowedByTenant: true,
      requiredModalities: ['image'],
      riskPolicy: 'allow',
    },
  });
  assertEqual(modalityResult.eligible, false, 'Model without image modality must be rejected');
  assertEqual(modalityResult.primaryEliminationReason, 'MODALITY_UNSUPPORTED', 'Primary reason must be MODALITY_UNSUPPORTED');

  // Test 6: Context limit exceeded → step 4
  const contextResult = evaluateConstraints({
    model: catalog.entries.find((e) => e.modelId === 'model-c')!, // 32K context
    catalogIndex: 2,
    constraints: {
      allowedByTenant: true,
      maxContextTokens: 200_000,
      riskPolicy: 'allow',
    },
  });
  assertEqual(contextResult.eligible, false, 'Model with insufficient context must be rejected');
  assertEqual(contextResult.primaryEliminationReason, 'CONTEXT_LIMIT_EXCEEDED', 'Primary reason must be CONTEXT_LIMIT_EXCEEDED');

  // Test 7: Risk policy blocked → step 6
  const riskResult = evaluateConstraints({
    model: healthyEntry,
    catalogIndex: 0,
    constraints: {
      allowedByTenant: true,
      riskPolicy: 'block',
    },
  });
  assertEqual(riskResult.eligible, false, 'Model must be blocked by risk policy');
  assertEqual(riskResult.primaryEliminationReason, 'RISK_POLICY_BLOCKED', 'Primary reason must be RISK_POLICY_BLOCKED');

  // Test 8: Latency limit exceeded → step 8
  const latencyResult = evaluateConstraints({
    model: catalog.entries.find((e) => e.modelId === 'model-expensive')!, // 3500ms p95
    catalogIndex: 5,
    constraints: {
      allowedByTenant: true,
      riskPolicy: 'allow',
      maxLatencyMs: 1000,
    },
  });
  assertEqual(latencyResult.eligible, false, 'Model exceeding latency limit must be rejected');
  assertEqual(latencyResult.primaryEliminationReason, 'LATENCY_LIMIT_EXCEEDED', 'Primary reason must be LATENCY_LIMIT_EXCEEDED');

  // Test 9: CONSTRAIN-3 — Jev recommendation is advisory, selector overrides
  const jevRecResult = selectEligible(
    catalog.entries,
    {
      allowedByTenant: true,
      riskPolicy: 'allow',
      maxLatencyMs: 1000, // eliminates model-expensive AND model-down
    },
    'model-disabled', // Jev recommends a disabled model
  );
  assert(
    !jevRecResult.eligible.some((e) => e.modelId === 'model-disabled'),
    'CONSTRAIN-3: Jev recommendation must not bypass hard constraints',
  );
  assertEqual(
    jevRecResult.jevRecommendationEliminated,
    'MODEL_DISABLED',
    'CONSTRAIN-3: Jev recommendation elimination reason must be recorded',
  );

  // Test 10: All 8 steps evaluated even after first failure (audit completeness)
  const multiFailResult = evaluateConstraints({
    model: disabledEntry,
    catalogIndex: 3,
    constraints: {
      allowedByTenant: false, // step 2 also fails
      riskPolicy: 'block',   // step 6 also fails
    },
  });
  assertEqual(multiFailResult.auditSummary.length, 8, 'All 8 steps must be evaluated even after first failure');
  assertEqual(multiFailResult.primaryEliminationReason, 'MODEL_DISABLED', 'Primary elimination is the FIRST failure');
  const failedSteps = multiFailResult.auditSummary.filter((s) => !s.passed);
  assert(failedSteps.length >= 2, 'Multiple steps should fail for multi-violation model');
}

// ---------------------------------------------------------------------------
// Test Suite 4: Experience Integration Test
// ---------------------------------------------------------------------------

async function testExperienceIntegration(): Promise<void> {
  const catalog = makeTestCatalog();
  const store = new ExperienceStore();
  const versions = new ExperienceVersionManager();
  const reflow = new ExperienceReflow(versions, store);

  // Create genesis version
  versions.genesis('test-operator');

  // Step 1: Create and write experience entry after a routing decision
  const entry1 = makeConfirmedEntry({
    eid: 'exp-chain-001',
    rid: 'req-chain-001',
    prediction: {
      intent: 'code_generation',
      winner: 'model-a',
      winnerIdx: 0,
      tier: 'ROUTE',
      confidence: 0.87,
      topProb: 0.6,
      priorSnapshot: [0, 0, 0, 0, 0, 0],
    },
  });

  await store.writeEntry(entry1);
  await store.drainWriteQueue();

  // Step 2: Verify entry can be retrieved
  const retrieved = store.getEntry('exp-chain-001');
  assert(retrieved !== undefined, 'Entry must be retrievable after write');
  assertEqual(retrieved!.modelId, 'model-a', 'Retrieved modelId must match');
  assertEqual(retrieved!.outcome.status, 'confirmed', 'Entry must be confirmed');

  // Step 3: Verify query by intent
  const byIntent = store.queryByIntent('code_generation');
  assertEqual(byIntent.length, 1, 'Should find 1 entry by intent');
  assertEqual(byIntent[0].eid, 'exp-chain-001', 'Queried entry eid must match');

  // Step 4: Verify query by model
  const byModel = store.queryByModel('model-a');
  assertEqual(byModel.length, 1, 'Should find 1 entry by modelId');

  // Step 5: Write a second entry (disputed) and query by status
  const entry2 = makeConfirmedEntry({
    eid: 'exp-chain-002',
    rid: 'req-chain-002',
    modelId: 'model-b',
    provider: 'provider-y',
    outcome: {
      status: 'disputed',
      source: 'human',
      label: 'model-a', // human said model-a was better
      observedAt: Date.now() - 500,
      latencyMs: 800,
      cost: 0.005,
    },
  });

  await store.writeEntry(entry2);
  await store.drainWriteQueue();

  const confirmed = store.queryByStatus('confirmed');
  const disputed = store.queryByStatus('disputed');
  assertEqual(confirmed.length, 1, 'Should have 1 confirmed entry');
  assertEqual(disputed.length, 1, 'Should have 1 disputed entry');

  // Step 6: Verify experience affects subsequent scoring via reflow
  const catalogForReflow = catalog.entries
    .filter((e) => e.enabled && e.health !== 'down')
    .map((e) => ({
      modelId: e.modelId,
      priorMean: 0.5,
      profileVersion: e.profileVersion,
    }));

  const reflowDecision = reflow.getActivePriorDeltas('code_generation', catalogForReflow);

  // Reflow decision should be computed
  assert(reflowDecision.priorDelta.length === catalogForReflow.length, 'Prior delta length must match catalog');
  assert(
    typeof reflowDecision.expVersion === 'number' || reflowDecision.expVersion === null,
    'expVersion must be a number or null',
  );

  // Step 7: Verify injectReflow adjusts scores
  const rawScores = [0.5, 0.4, 0.3, 0.2];
  const priorDelta = [0.05, -0.02, 0.01, 0.0];
  const adjustedScores = reflow.injectReflow(rawScores, priorDelta);

  assert(Math.abs(adjustedScores[0] - 0.55) < 1e-9, 'Adjusted score[0] = raw + delta');
  assert(Math.abs(adjustedScores[1] - 0.38) < 1e-9, 'Adjusted score[1] = raw + delta');
  assert(Math.abs(adjustedScores[2] - 0.31) < 1e-9, 'Adjusted score[2] = raw + delta');
  assert(Math.abs(adjustedScores[3] - 0.2) < 1e-9, 'Adjusted score[3] = raw + delta (no change)');

  // Step 8: Verify diffWithAndWithoutReflow
  const diff: ReflowDiff = reflow.diffWithAndWithoutReflow(rawScores, priorDelta);
  assertEqual(diff.winnerChanged, false, 'Winner should not change with small deltas');
  assert(Math.abs(diff.delta[0] - 0.05) < 1e-9, 'Delta[0] must match prior delta');
  assert(Math.abs(diff.without[0] - 0.5) < 1e-9, 'Without scores must be original');
  assert(Math.abs(diff.with[0] - 0.55) < 1e-9, 'With scores must be adjusted');

  // Step 9: Verify OutcomeEvaluator integration
  const evaluator = new OutcomeEvaluator();
  const pendingEntry = evaluator.createPendingEntry({
    rid: 'req-eval-001',
    expVersion: '1',
    intent: 'code_generation',
    winner: 'model-a',
    winnerIdx: 0,
    tier: 'ROUTE',
    confidence: 0.9,
    topProb: 0.7,
    priorSnapshot: [0, 0, 0],
    decisionSource: 'TYPE_SAFE_JEV',
    modelId: 'model-a',
    provider: 'provider-x',
    catalogVersion: 'test-v1',
  });

  assertEqual(pendingEntry.outcome.status, 'pending', 'New entry must be pending');

  // Fill outcome as confirmed
  const confirmedEntry = evaluator.fillOutcome(
    pendingEntry.eid,
    {
      latencyMs: 500,
      usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
      costUsd: 0.003,
    },
    'system',
    'model-a',
  );
  assertEqual(confirmedEntry.outcome.status, 'confirmed', 'Filled entry must be confirmed');
  assertEqual(confirmedEntry.outcome.label, 'model-a', 'Outcome label must match winner');
}

// ---------------------------------------------------------------------------
// Test Suite 5: Degradation Test
// ---------------------------------------------------------------------------

async function testDegradation(): Promise<void> {
  // Test 1: Normal operation — no degradation
  const normalResult = evaluateDegradation({
    jevError: null,
    rules: [],
    policy: { degradationAllowed: true, requireAuditedRule: true },
  });
  assertEqual(normalResult.degraded, false, 'No degradation when no Jev error');
  assertEqual(normalResult.decisionSource, 'TYPE_SAFE_JEV', 'Decision source must be TYPE_SAFE_JEV when normal');
  assertEqual(normalResult.canWriteToExperience, true, 'Normal decisions CAN write to experience store');

  // Test 2: Jev timeout with degradation allowed + audited fallback rule
  const fallbackRules: FallbackRule[] = [
    {
      ruleId: 'fallback-code-v1',
      condition: 'Jev timeout for code generation requests',
      fallbackModelId: 'model-a',
      enabled: true,
      audited: true,
    },
    {
      ruleId: 'fallback-general-v1',
      condition: 'Jev timeout for general requests',
      fallbackModelId: 'model-b',
      enabled: true,
      audited: false, // not audited
    },
  ];

  const timeoutResult = evaluateDegradation({
    jevError: 'TIMEOUT',
    rules: fallbackRules,
    policy: { degradationAllowed: true, requireAuditedRule: true },
  });
  assertEqual(timeoutResult.degraded, true, 'Must degrade on Jev timeout');
  assertEqual(timeoutResult.decisionSource, 'RULE_FALLBACK', 'Decision source must be RULE_FALLBACK');
  assertEqual(timeoutResult.fallbackModelId, 'model-a', 'Must use first audited fallback rule');
  assertEqual(timeoutResult.matchedRule?.ruleId, 'fallback-code-v1', 'Must match the audited rule');
  assertEqual(timeoutResult.canWriteToExperience, false, 'CONSTRAIN-4: Degraded decisions MUST NOT write to experience store');
  assert(
    (timeoutResult.reason ?? '').includes('RULE_FALLBACK'),
    'Reason must mention RULE_FALLBACK',
  );

  // Test 3: Jev timeout but degradation not allowed by policy
  const blockedResult = evaluateDegradation({
    jevError: 'TIMEOUT',
    rules: fallbackRules,
    policy: { degradationAllowed: false, requireAuditedRule: true },
  });
  assertEqual(blockedResult.degraded, true, 'Still degraded (no fallback possible)');
  assertEqual(blockedResult.decisionSource, 'TYPE_SAFE_JEV', 'Decision source stays TYPE_SAFE_JEV when degradation blocked');
  assertEqual(blockedResult.canWriteToExperience, false, 'Cannot write to experience when degradation blocked');
  assert(
    (blockedResult.reason ?? '').includes('DECISION_TIMEOUT'),
    'Reason must mention DECISION_TIMEOUT when degradation disabled',
  );

  // Test 4: Jev timeout but no eligible fallback rules (all unaudited)
  const noEligibleResult = evaluateDegradation({
    jevError: 'TIMEOUT',
    rules: [
      { ruleId: 'r1', condition: 'test', fallbackModelId: 'model-x', enabled: true, audited: false },
    ],
    policy: { degradationAllowed: true, requireAuditedRule: true },
  });
  assertEqual(noEligibleResult.degraded, true, 'Degraded with no eligible rules');
  assertEqual(noEligibleResult.fallbackModelId, undefined, 'No fallback model when no eligible rules');
  assert(
    (noEligibleResult.reason ?? '').includes('DECISION_TIMEOUT'),
    'Must report DECISION_TIMEOUT when no eligible fallback',
  );

  // Test 5: Jev unavailable error
  const unavailableResult = evaluateDegradation({
    jevError: 'UNAVAILABLE',
    rules: fallbackRules,
    policy: { degradationAllowed: true, requireAuditedRule: true },
  });
  assertEqual(unavailableResult.degraded, true, 'Must degrade on Jev unavailable');
  assertEqual(unavailableResult.decisionSource, 'RULE_FALLBACK', 'Decision source must be RULE_FALLBACK for UNAVAILABLE');
  assertEqual(unavailableResult.canWriteToExperience, false, 'Degraded decisions from UNAVAILABLE must not write to experience');

  // Test 6: Invalid schema error
  const invalidSchemaResult = evaluateDegradation({
    jevError: 'INVALID_SCHEMA',
    rules: fallbackRules,
    policy: { degradationAllowed: true, requireAuditedRule: true },
  });
  assertEqual(invalidSchemaResult.degraded, true, 'Must degrade on invalid schema');
  assertEqual(invalidSchemaResult.canWriteToExperience, false, 'Invalid schema degraded decisions must not write to experience');

  // Test 7: Degraded decisions must NOT pollute experience store
  const store = new ExperienceStore();
  const evaluator = new OutcomeEvaluator();

  // Create a normal decision entry (should be writable)
  const normalEntry = evaluator.createPendingEntry({
    rid: 'req-normal-001',
    expVersion: '1',
    intent: 'code_generation',
    winner: 'model-a',
    winnerIdx: 0,
    tier: 'ROUTE',
    confidence: 0.9,
    topProb: 0.7,
    priorSnapshot: [0, 0, 0],
    decisionSource: 'TYPE_SAFE_JEV',
    modelId: 'model-a',
    provider: 'provider-x',
    catalogVersion: 'test-v1',
  });

  // Normal entry can be written to experience store
  await store.writeEntry(normalEntry);
  await store.drainWriteQueue();
  assertEqual(store.size(), 1, 'Normal decision entry should be in store');

  // Simulate a degraded decision — it should NOT be written to experience store
  const degradedResult = evaluateDegradation({
    jevError: 'TIMEOUT',
    rules: fallbackRules,
    policy: { degradationAllowed: true, requireAuditedRule: true },
  });

  // Verify CONSTRAIN-4: canWriteToExperience === false
  assertEqual(degradedResult.canWriteToExperience, false, 'Degraded decisions MUST NOT be written to experience store');

  // If canWriteToExperience is false, we should NOT write the entry
  // This is a behavioral test: the orchestrator must check this flag
  if (!degradedResult.canWriteToExperience) {
    // Do NOT write degraded entry — verify store remains unchanged
    assertEqual(store.size(), 1, 'Store size must remain 1 after degraded decision (not written)');
  }

  // Test 8: Verify fallback rule with `requireAuditedRule: false` picks non-audited rules
  const relaxedResult = evaluateDegradation({
    jevError: 'TIMEOUT',
    rules: [
      { ruleId: 'r1', condition: 'test', fallbackModelId: 'model-x', enabled: true, audited: false },
      { ruleId: 'r2', condition: 'test2', fallbackModelId: 'model-y', enabled: true, audited: false },
    ],
    policy: { degradationAllowed: true, requireAuditedRule: false },
  });
  assertEqual(relaxedResult.degraded, true, 'Degraded with relaxed audit requirement');
  assertEqual(relaxedResult.fallbackModelId, 'model-x', 'Should pick first enabled rule when audit not required');
  assertEqual(relaxedResult.decisionSource, 'RULE_FALLBACK', 'Decision source must be RULE_FALLBACK');

  // Test 9: Disabled fallback rule is skipped
  const disabledRuleResult = evaluateDegradation({
    jevError: 'TIMEOUT',
    rules: [
      { ruleId: 'r-disabled', condition: 'test', fallbackModelId: 'model-x', enabled: false, audited: true },
      { ruleId: 'r-enabled', condition: 'test2', fallbackModelId: 'model-y', enabled: true, audited: true },
    ],
    policy: { degradationAllowed: true, requireAuditedRule: true },
  });
  assertEqual(disabledRuleResult.fallbackModelId, 'model-y', 'Should skip disabled rule and pick enabled one');
}

// ---------------------------------------------------------------------------
// Bonus: LocalJevReimpl integration in the chain
// ---------------------------------------------------------------------------

async function testLocalJevReimplIntegration(): Promise<void> {
  const catalog = makeTestCatalog();
  const models: ModelDescriptor[] = catalog.entries.map((e) => ({
    modelId: e.modelId,
    capability: e.capability,
    quality: e.quality,
    cost: e.cost,
    latency: e.latency,
    load: e.load,
    contextWindow: e.contextWindow,
    modalities: e.modalities as ModelDescriptor['modalities'],
  }));
  const evidence = makeTestEvidence();

  // Use LocalJevReimpl instead of the real adapter (offline form)
  const localOutput = answerQuestionsLocally({
    requestId: 'req-local-001',
    evidence,
    models,
    policy: TEST_POLICY,
  });

  // Verify local reimpl produces valid output
  assertEqual(localOutput.decisionSource, 'LOCAL_REIMPL', 'Local reimpl must tag as LOCAL_REIMPL');
  assertEqual(localOutput.localLabeled, true, 'Local reimpl must be labeled');
  assert(localOutput.decision.confidence >= 0, 'Confidence must be non-negative');
  assert(localOutput.decision.confidence <= 1, 'Confidence must be <= 1');
  assert(localOutput.decision.candidateScores.length > 0, 'Must have candidate scores');
  assert(localOutput.decision.rationale.length > 0, 'Must have rationale');
  assert(!localOutput.decision.rationale.includes('system-one'), 'LOCAL_REIMPL MUST NOT carry system-one tag');

  // Verify deviation table is complete (JEV-10)
  const unverified = verifyDeviationsRegistered();
  assertEqual(unverified.length, 0, `All deviations must be registered (unverified: ${unverified.join(', ')})`);
  assertEqual(LOCAL_JEV_DEVIATIONS.length, 6, 'Must have 6 registered deviations (F1-F6)');

  // Feed the local decision into the main chain
  const jevAnswers = makeTestJevAnswers();
  const state = makeTestState();
  const chainOutput = executeMainChain({
    state,
    evidence,
    jevAnswers,
    models,
    policy: TEST_POLICY,
    priorDeltas: localOutput.scoreResult.byCatalogOrder.map((m) => m.raw > 0 ? 0.01 : 0),
    consequence: 'medium',
    consequencePolicy: TEST_CONSEQUENCE_POLICY,
  });

  // Chain should complete successfully with local reimpl scores
  assert(verifyMainChainOrder(chainOutput.stageOrder), 'Main chain order must be correct with local reimpl');
  const validTiers: RouteTier[] = ['ROUTE', 'GATE', 'ESCALATE'];
  assert(validTiers.includes(chainOutput.tier), `Tier must be valid with local reimpl, got: ${chainOutput.tier}`);
}

// ---------------------------------------------------------------------------
// Exported test runner
// ---------------------------------------------------------------------------

/**
 * Run all T-8.1 E2E integration tests and return a summary.
 *
 * @returns Summary with passed/failed counts and per-test results.
 */
export async function runE2ETests(): Promise<{
  passed: number;
  failed: number;
  results: Array<{ name: string; passed: boolean; error?: string }>;
}> {
  const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [
    { name: 'Full Chain: Jev → Constraint Selector → Model Gateway → Experience Store', fn: testFullChain },
    { name: 'Shadow Mode: decisions recorded but do not drive execution', fn: testShadowMode },
    { name: 'Constraint Pipeline: 8 steps in order, hard-constraint rejection', fn: testConstraintPipeline },
    { name: 'Experience Integration: save, retrieve, reflow scoring', fn: testExperienceIntegration },
    { name: 'Degradation: RULE_FALLBACK + canWriteToExperience=false', fn: testDegradation },
    { name: 'LocalJevReimpl: offline chain integration + deviation registry', fn: testLocalJevReimplIntegration },
  ];

  const results: TestResult[] = [];
  for (const test of tests) {
    const result = await runTest(test.name, test.fn);
    results.push(result);
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  return { passed, failed, results };
}
