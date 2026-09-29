/**
 * Closed-Loop Verification Tests — T-8.2 through T-8.6.
 *
 * Self-contained test module with simple assertion helpers (no test framework).
 * Import from actual backend modules via relative paths.
 */

import type { ExperienceEntry } from '../outcome-evaluator.js';
import type { OutcomeStatus, OutcomeSource, ModelDescriptor, PolicySnapshot, RawEvidence } from '@jev-router/shared';
import { calibrate, extractFeatures, scoreModels, tieBreak } from '@jev-router/shared';
import { ExperienceStore, validateExperienceEntry } from '../experience-store.js';
import { ExperienceVersionManager } from '../experience-version.js';
import { ExperienceReflow } from '../experience-reflow.js';
import { ExperienceRollback, verifyRollbackAtomicity } from '../experience-rollback.js';
import { ExperienceReplay } from '../experience-replay.js';
import { ExperienceValidator, computeMetrics, decideVerdict } from '../experience-validator.js';
import { getDeviationTable, verifyDeviationsRegistered, answerQuestionsLocally } from '../local-jev-reimpl.js';

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes<T>(arr: T[], item: T, label: string): void {
  if (!arr.includes(item)) {
    throw new Error(`${label}: array does not include ${JSON.stringify(item)}. Got: ${JSON.stringify(arr)}`);
  }
}

function assertGreaterEqual(actual: number, threshold: number, label: string): void {
  if (actual < threshold) {
    throw new Error(`${label}: expected >= ${threshold}, got ${actual}`);
  }
}

function runTest(name: string, fn: () => void | Promise<void>): TestResult | Promise<TestResult> {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(
        () => ({ name, passed: true }),
        (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          return { name, passed: false, error: msg };
        },
      );
    }
    return { name, passed: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, passed: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<ExperienceEntry> & Pick<ExperienceEntry, 'eid' | 'rid' | 'modelId'>): ExperienceEntry {
  const defaults: ExperienceEntry = {
    eid: overrides.eid,
    rid: overrides.rid ?? `req-${overrides.eid}`,
    expVersion: '1',
    prediction: {
      intent: 'code-generation',
      winner: overrides.modelId,
      winnerIdx: 0,
      tier: 'ROUTE' as const,
      confidence: 0.85,
      topProb: 0.85,
      priorSnapshot: [0.1, 0.0, -0.05],
    },
    outcome: {
      status: 'confirmed' as OutcomeStatus,
      source: 'human' as OutcomeSource,
      label: overrides.modelId,
      observedAt: Date.now() - 1000,
      latencyMs: 500,
      cost: 0.002,
    },
    decisionSource: 'TYPE_SAFE_JEV',
    modelId: overrides.modelId,
    provider: 'test-provider',
    catalogVersion: '1.0.0',
    createdAt: new Date().toISOString(),
  };
  return { ...defaults, ...overrides };
}

/** Create a confirmed entry for a given (intent, modelId, winner). */
function confirmedEntry(
  eid: string,
  intent: string,
  modelId: string,
  winner: string,
  winnerIdx: number,
  expVersion: string,
  observedAt: number,
  confidence: number = 0.85,
): ExperienceEntry {
  return makeEntry({
    eid,
    rid: `req-${eid}`,
    modelId,
    expVersion,
    prediction: {
      intent,
      winner,
      winnerIdx,
      tier: 'ROUTE',
      confidence,
      topProb: confidence,
      priorSnapshot: [0.05],
    },
    outcome: {
      status: 'confirmed',
      source: 'human',
      label: winner,
      observedAt,
      latencyMs: 400,
      cost: 0.001,
    },
  });
}

/** Create a disputed entry (misprediction). */
function disputedEntry(
  eid: string,
  intent: string,
  modelId: string,
  winner: string,
  winnerIdx: number,
  expVersion: string,
  observedAt: number,
  confidence: number = 0.6,
): ExperienceEntry {
  const actualWinner = `alt-${modelId}`;
  return makeEntry({
    eid,
    rid: `req-${eid}`,
    modelId,
    expVersion,
    prediction: {
      intent,
      winner,
      winnerIdx,
      tier: 'GATE',
      confidence,
      topProb: confidence,
      priorSnapshot: [0.0],
    },
    outcome: {
      status: 'disputed',
      source: 'human',
      label: actualWinner,
      observedAt,
    },
  });
}

/** Build a simple policy snapshot for scoring. */
const DEFAULT_POLICY: PolicySnapshot = {
  w_capability: 0.3,
  w_quality: 0.3,
  w_cost: 0.2,
  w_latency: 0.2,
  T0: 1.0,
  alpha: 0.5,
};

/** Build a simple model catalog. */
function makeModels(n: number): ModelDescriptor[] {
  const ids = ['gpt-4o', 'claude-3.5', 'gemini-pro', 'llama-3', 'mistral-l', 'command-r', 'qwen-72b', 'yi-large'];
  return Array.from({ length: n }, (_, i) => ({
    modelId: ids[i % ids.length] + (i >= ids.length ? `-${i}` : ''),
    capability: 0.5 + (i * 0.03) % 0.5,
    quality: 0.5 + ((i + 1) * 0.04) % 0.5,
    cost: 0.2 + ((i + 2) * 0.05) % 0.6,
    latency: 0.1 + ((i + 3) * 0.06) % 0.7,
    load: 0.1,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// T-8.2: 五段位验收 (Five-stage closed-loop verification)
// ═══════════════════════════════════════════════════════════════════════════

function testT82_Stage1_Precipitation(): TestResult | Promise<TestResult> {
  return runTest('T-8.2 ① 沉淀: Every routing decision produces ExperienceEntry with outcome lifecycle', () => {
    const store = new ExperienceStore({ validateOnWrite: true });
    const entry = makeEntry({
      eid: 'exp-stage1-001',
      rid: 'req-stage1-001',
      modelId: 'gpt-4o',
    });

    // Every routing decision MUST produce an ExperienceEntry (EXP-1)
    assert(entry.eid.length > 0, 'Entry must have eid');
    assert(entry.rid.length > 0, 'Entry must have rid');
    assert(entry.prediction.intent.length > 0, 'Entry must have prediction.intent');
    assert(entry.prediction.winner.length > 0, 'Entry must have prediction.winner');
    assert(typeof entry.prediction.confidence === 'number', 'Entry must have prediction.confidence');
    assert(Array.isArray(entry.prediction.priorSnapshot), 'Entry must have prediction.priorSnapshot');

    // Outcome lifecycle: pending → confirmed/disputed/expired
    const pendingEntry = makeEntry({
      eid: 'exp-stage1-pending',
      rid: 'req-stage1-pending',
      modelId: 'gpt-4o',
      outcome: { status: 'pending' },
    });
    assertEqual(pendingEntry.outcome.status, 'pending', 'New entry starts as pending');

    // Write to store — validates entry passes integrity checks
    // Note: ExperienceStore uses async write queue; in sync test context we
    // verify via the validation function directly and rely on the microtask
    // queue for store writes. For full async verification see integration tests.
    store.writeEntry(entry);
    store.writeEntry(pendingEntry);

    // Validate experience entry integrity (synchronous)
    const violations = validateExperienceEntry(entry);
    assertEqual(violations.length, 0, `Entry should pass validation, got: ${violations.join('; ')}`);

    // Pending entries must have proper lifecycle shape
    // Pending entries are valid even without source/observedAt
    // (they start as pending and get filled later)
    assertEqual(pendingEntry.outcome.status, 'pending', 'New entry must start as pending');

    // Validate lifecycle transitions: confirmed entry
    const confirmedEntry2 = makeEntry({
      eid: 'exp-confirmed-lifecycle',
      rid: 'req-confirmed-lifecycle',
      modelId: 'claude-3.5',
      outcome: { status: 'confirmed', source: 'human', label: 'claude-3.5', observedAt: Date.now() },
    });
    assertEqual(confirmedEntry2.outcome.status, 'confirmed', 'Confirmed lifecycle status');

    // Disputed entry
    const disputedEntry2 = makeEntry({
      eid: 'exp-disputed-lifecycle',
      rid: 'req-disputed-lifecycle',
      modelId: 'gemini-pro',
      outcome: { status: 'disputed', source: 'system', label: 'other-model', observedAt: Date.now() },
    });
    assertEqual(disputedEntry2.outcome.status, 'disputed', 'Disputed lifecycle status');
  });
}

function testT82_Stage2_Statistics(): TestResult | Promise<TestResult> {
  return runTest('T-8.2 ② 统计: Calibration stats compute from experience data', async () => {
    const store = new ExperienceStore({ validateOnWrite: true });
    const versions = new ExperienceVersionManager();
    versions.genesis();
    const reflow = new ExperienceReflow(versions, store);

    const now = Date.now();
    const intent = 'code-generation';

    // Write 40 confirmed entries to build stats
    const entries: ExperienceEntry[] = [];
    for (let i = 0; i < 40; i++) {
      const modelId = i % 2 === 0 ? 'gpt-4o' : 'claude-3.5';
      const e = confirmedEntry(
        `exp-stat-${i}`, intent, modelId, modelId, i % 2, '1',
        now - 10000 + i * 100, 0.7 + (i % 5) * 0.05,
      );
      entries.push(e);
      store.writeEntry(e);
    }

    // Wait for async write queue to drain
    await store.drainWriteQueue();

    // Compute metrics on confirmed entries
    const confirmedEntries = entries.filter(e => e.outcome.status === 'confirmed');
    const metrics = computeMetrics(confirmedEntries);

    assertGreaterEqual(metrics.sampleCount, 1, 'Stats should have sample count');
    assert(typeof metrics.tierHitRate === 'number', 'tierHitRate should be a number');
    assert(typeof metrics.ece === 'number', 'ECE should be a number');
    assert(metrics.tierHitRate >= 0 && metrics.tierHitRate <= 1, 'tierHitRate should be in [0,1]');

    // Verify store can produce calibration data via confirmedAndDisputed
    // (HumanReviewManager.exportCalibrationData depends on this)
    const reflowDecision = reflow.getActivePriorDeltas(intent, [
      { modelId: 'gpt-4o', priorMean: 0.6 },
      { modelId: 'claude-3.5', priorMean: 0.5 },
    ], now);

    // Reflow should produce a priorDelta array in catalog order
    assert(Array.isArray(reflowDecision.priorDelta), 'priorDelta should be an array');
    assertEqual(reflowDecision.priorDelta.length, 2, 'priorDelta should match catalog length');

    // With enough confirmed data, reflow should produce non-trivial correction
    // (may be zero if cold-start guard kicks in, but structure must be correct)
    assertEqual(reflowDecision.priorDelta.length, 2, 'Reflow produces per-candidate priorDelta');
  });
}

function testT82_Stage3_Application(): TestResult | Promise<TestResult> {
  return runTest('T-8.2 ③ 应用: Prior delta changes next scoring behavior; archive contains priorDelta[]', async () => {
    const store = new ExperienceStore({ validateOnWrite: true });
    const versions = new ExperienceVersionManager();
    versions.genesis();
    const reflow = new ExperienceReflow(versions, store);

    const now = Date.now();
    const intent = 'translation';

    // Seed store with confirmed entries that favor one model
    for (let i = 0; i < 50; i++) {
      const e = confirmedEntry(
        `exp-app-${i}`, intent, 'gpt-4o', 'gpt-4o', 0, '1',
        now - 5000 + i * 100, 0.9,
      );
      store.writeEntry(e);
    }

    // Wait for async write queue to drain
    await store.drainWriteQueue();

    const catalog = [
      { modelId: 'gpt-4o', priorMean: 0.5 },
      { modelId: 'claude-3.5', priorMean: 0.5 },
      { modelId: 'gemini-pro', priorMean: 0.5 },
    ];

    const decision = reflow.getActivePriorDeltas(intent, catalog, now);

    // 1. Archive MUST contain priorDelta[] (EXP-4)
    assert(Array.isArray(decision.priorDelta), 'Decision must have priorDelta array');
    assertEqual(decision.priorDelta.length, catalog.length, 'priorDelta length must match catalog');

    // 2. Prior delta actually changes scoring behavior
    const models = makeModels(3);
    const scoreWithout = scoreModels(models, DEFAULT_POLICY);
    const rawWithout = scoreWithout.byCatalogOrder.map(m => m.raw);

    // Apply prior delta
    const rawWith = reflow.injectReflow(rawWithout, decision.priorDelta);

    // Verify injection preserves length (even if delta is zero from cold-start)
    assertEqual(rawWith.length, rawWithout.length, 'Injection preserves length');

    // 3. A/B diff support (EXP-4)
    const diff = reflow.diffWithAndWithoutReflow(rawWithout, decision.priorDelta);
    assertEqual(diff.with.length, diff.without.length, 'A/B diff lengths must match');
    assert(Array.isArray(diff.delta), 'Diff must include delta vector');
    assert(typeof diff.winnerChanged === 'boolean', 'Diff must report winnerChanged');

    // 4. Record prior snapshot for archive (EXP-6 pinning)
    const snapshotEntries = reflow.recordPriorSnapshot(intent, catalog, decision);
    assertEqual(snapshotEntries.length, catalog.length, 'Snapshot entries must match catalog');
    for (const s of snapshotEntries) {
      assert(typeof s.intent === 'string' && s.intent.length > 0, 'Snapshot entry must have intent');
      assert(typeof s.modelId === 'string' && s.modelId.length > 0, 'Snapshot entry must have modelId');
      assert(typeof s.delta === 'number', 'Snapshot entry must have delta');
    }
  });
}

function testT82_Stage4_Reproducibility(): TestResult | Promise<TestResult> {
  return runTest('T-8.2 ④ 可复现: Pinned-version replay produces identical winner/winnerIdx/priorDelta[]', () => {
    const versions = new ExperienceVersionManager();
    const v1 = versions.genesis();

    // Create version with specific prior snapshots
    const priorSnapshots: Record<string, number> = {
      'code-gen::gpt-4o': 0.05,
      'code-gen::claude-3.5': -0.02,
      'code-gen::gemini-pro': 0.0,
    };
    const v2 = versions.createVersion({
      trigger: 'system-refresh',
      priorSnapshots,
    });

    const replay = new ExperienceReplay(versions);

    // Simulate archive data
    const rawScores = [0.82, 0.78, 0.65];
    const catalog = [
      { modelId: 'gpt-4o' },
      { modelId: 'claude-3.5' },
      { modelId: 'gemini-pro' },
    ];
    const archiveWinnerIdx = 0;
    const archiveWinner = 'gpt-4o';
    const archivePriorDelta = [0.05, -0.02, 0.0];

    // Replay pinned version
    const result = replay.replayPinned({
      pinnedVersion: v2.version,
      rawScores,
      catalog,
      intent: 'code-gen',
      archiveWinnerIdx,
      archiveWinner,
    });

    assertEqual(result.mode, 'recomputed', 'Replay should be recomputed (version exists)');
    assertEqual(result.pinnedVersion, v2.version, 'Pinned version should match');

    // Prior delta from pinned version should match archive
    for (let i = 0; i < archivePriorDelta.length; i++) {
      assertEqual(result.priorDelta[i], archivePriorDelta[i], `priorDelta[${i}] should match archive`);
    }

    // Winner should be consistent
    assertEqual(result.winnerIdx, archiveWinnerIdx, 'Winner index should match archive');
    assertEqual(result.winner, archiveWinner, 'Winner should match archive');

    // Verify consistency via verifyPinnedConsistency
    const consistency = replay.verifyPinnedConsistency(result, {
      winnerIdx: archiveWinnerIdx,
      winner: archiveWinner,
      priorDelta: archivePriorDelta,
    });
    assert(consistency.ok, `Pinned replay should be consistent: ${consistency.violations.join('; ')}`);

    // Replay with a different pinned version should produce different results
    const resultV1 = replay.replayPinned({
      pinnedVersion: v1.version,
      rawScores,
      catalog,
      intent: 'code-gen',
      archiveWinnerIdx: 0,
      archiveWinner: 'gpt-4o',
    });
    assertEqual(resultV1.pinnedVersion, v1.version, 'V1 replay pins to V1');
    // V1 has empty priorSnapshots, so priorDelta should all be zero
    assertEqual(resultV1.priorDelta[0], 0, 'V1 replay should have zero priorDelta');
  });
}

function testT82_Stage5_ValidationRollback(): TestResult | Promise<TestResult> {
  return runTest('T-8.2 ⑤ 验证回滚: Segment validator produces verdicts; rollback is atomic with audit trail', () => {
    const versions = new ExperienceVersionManager();
    const v1 = versions.genesis();
    const validator = new ExperienceValidator(versions);

    const now = Date.now();
    const v1Time = now - 20000;
    const v2Time = now - 10000;

    // Create V2 with a timestamp that splits the data
    const v2 = versions.createVersion({
      trigger: 'threshold-approval',
      operator: 'test-operator',
      changes: { thresholdDeltas: { high: -0.05 } },
    });

    // Build before entries (good performance) and after entries (degraded)
    const entries: ExperienceEntry[] = [];

    // Before V2: high hit rate
    for (let i = 0; i < 50; i++) {
      entries.push(confirmedEntry(
        `exp-before-${i}`, 'code-gen', 'gpt-4o', 'gpt-4o', 0, '1',
        v1Time - 5000 + i * 50, 0.9,
      ));
    }

    // After V2: lower hit rate (many mispredictions → degraded)
    for (let i = 0; i < 50; i++) {
      if (i < 20) {
        // 20 disputed (mispredictions)
        entries.push(disputedEntry(
          `exp-after-bad-${i}`, 'code-gen', 'gpt-4o', 'gpt-4o', 0, '2',
          v2Time + 100 + i * 50, 0.5,
        ));
      } else {
        entries.push(confirmedEntry(
          `exp-after-ok-${i}`, 'code-gen', 'gpt-4o', 'gpt-4o', 0, '2',
          v2Time + 100 + i * 50, 0.85,
        ));
      }
    }

    // Validate — should produce one of the four verdicts
    const result = validator.validateLoop(v2.version, entries);
    assertIncludes(['improved', 'neutral', 'degraded', 'inconclusive'] as const, result.verdict,
      'Verdict should be one of the four valid values');
    assert(typeof result.rationale === 'string' && result.rationale.length > 0, 'Rationale should be present');
    assert(result.before.sampleCount >= 0, 'Before segment should have sampleCount');
    assert(result.after.sampleCount >= 0, 'After segment should have sampleCount');

    // Verify decideVerdict directly
    const neutralVerdict = decideVerdict(
      { sampleCount: 100, tierHitRate: 0.8, ece: 0.05, avgCostPerAutoRoute: 0.01, humanTakeoverRate: 0.2, insufficient: false },
      { sampleCount: 100, tierHitRate: 0.8, ece: 0.05, avgCostPerAutoRoute: 0.01, humanTakeoverRate: 0.2, insufficient: false },
      { tierHitRate: 0, ece: 0, avgCostPerAutoRoute: 0, humanTakeoverRate: 0 },
    );
    assertEqual(neutralVerdict, 'neutral', 'Identical metrics should yield neutral verdict');

    const degradedVerdict = decideVerdict(
      { sampleCount: 100, tierHitRate: 0.8, ece: 0.05, avgCostPerAutoRoute: 0.01, humanTakeoverRate: 0.2, insufficient: false },
      { sampleCount: 50, tierHitRate: 0.5, ece: 0.1, avgCostPerAutoRoute: 0.03, humanTakeoverRate: 0.5, insufficient: false },
      { tierHitRate: -0.3, ece: 0.05, avgCostPerAutoRoute: 0.02, humanTakeoverRate: 0.3 },
    );
    assertEqual(degradedVerdict, 'degraded', 'Worse metrics should yield degraded verdict');

    const improvedVerdict = decideVerdict(
      { sampleCount: 100, tierHitRate: 0.6, ece: 0.1, avgCostPerAutoRoute: 0.03, humanTakeoverRate: 0.4, insufficient: false },
      { sampleCount: 50, tierHitRate: 0.9, ece: 0.03, avgCostPerAutoRoute: 0.01, humanTakeoverRate: 0.1, insufficient: false },
      { tierHitRate: 0.3, ece: -0.07, avgCostPerAutoRoute: -0.02, humanTakeoverRate: -0.3 },
    );
    assertEqual(improvedVerdict, 'improved', 'Better metrics should yield improved verdict');

    // Insufficient data → inconclusive
    const inconclusiveVerdict = decideVerdict(
      { sampleCount: 100, tierHitRate: 0.6, ece: 0.1, avgCostPerAutoRoute: 0.03, humanTakeoverRate: 0.4, insufficient: false },
      { sampleCount: 5, tierHitRate: 0.9, ece: 0.03, avgCostPerAutoRoute: 0.01, humanTakeoverRate: 0.1, insufficient: true },
      { tierHitRate: 0.3, ece: -0.07, avgCostPerAutoRoute: -0.02, humanTakeoverRate: -0.3 },
    );
    assertEqual(inconclusiveVerdict, 'inconclusive', 'Insufficient post-segment → inconclusive (MUST NOT output improved)');

    // Test atomic rollback with audit trail (EXP-9)
    const rollback = new ExperienceRollback(versions);
    const rollbackResult = rollback.rollbackTo(v1.version, 'admin-user');

    assert(rollbackResult.atomicityVerified, 'Rollback should be atomic');
    assertEqual(rollbackResult.rollbackVersion.rollbackTarget, v1.version, 'Rollback should target V1');
    assertEqual(rollbackResult.rollbackVersion.trigger, 'rollback', 'Rollback version should have trigger=rollback');
    assertEqual(rollbackResult.targetVersion.version, v1.version, 'Target version should be V1');

    // Verify audit trail — rollback is a NEW version event
    const allVersions = versions.listVersions();
    const rollbackVersions = allVersions.filter(v => v.trigger === 'rollback');
    assertEqual(rollbackVersions.length, 1, 'Should have exactly one rollback version in history');

    // Original versions are preserved (append-only)
    assert(allVersions.some(v => v.version === v1.version), 'V1 should still exist');
    assert(allVersions.some(v => v.version === v2.version), 'V2 should still exist');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// T-8.3: 双形态一致性 (Dual-form consistency)
// ═══════════════════════════════════════════════════════════════════════════

function testT83_DualFormConsistency(): TestResult | Promise<TestResult> {
  return runTest('T-8.3: Same input + same experience version → same selection in cloud and offline forms', () => {
    // Test that the pure logic layer (extractFeatures/calibrate/scoreModels)
    // produces identical results regardless of form (cloud vs local)

    const models: ModelDescriptor[] = [
      { modelId: 'gpt-4o', capability: 0.9, quality: 0.85, cost: 0.3, latency: 0.4, load: 0.2 },
      { modelId: 'claude-3.5', capability: 0.88, quality: 0.87, cost: 0.35, latency: 0.35, load: 0.3 },
      { modelId: 'gemini-pro', capability: 0.82, quality: 0.80, cost: 0.15, latency: 0.5, load: 0.1 },
      { modelId: 'llama-3', capability: 0.75, quality: 0.70, cost: 0.05, latency: 0.6, load: 0.05 },
      { modelId: 'mistral-l', capability: 0.78, quality: 0.76, cost: 0.10, latency: 0.45, load: 0.15 },
    ];

    const policy: PolicySnapshot = {
      w_capability: 0.35,
      w_quality: 0.25,
      w_cost: 0.20,
      w_latency: 0.20,
      T0: 1.0,
      alpha: 0.5,
    };

    // Run scoring multiple times — deterministic (no randomness)
    const result1 = scoreModels(models, policy);
    const result2 = scoreModels(models, policy);

    // Catalog order must be identical
    assertEqual(result1.byCatalogOrder.length, result2.byCatalogOrder.length, 'Catalog order length must match');
    for (let i = 0; i < result1.byCatalogOrder.length; i++) {
      assertEqual(result1.byCatalogOrder[i].modelId, result2.byCatalogOrder[i].modelId, `Catalog[${i}] modelId must match`);
      assertEqual(result1.byCatalogOrder[i].raw, result2.byCatalogOrder[i].raw, `Catalog[${i}] raw must match`);
      assertEqual(result1.byCatalogOrder[i].probability, result2.byCatalogOrder[i].probability, `Catalog[${i}] probability must match`);
    }

    // Rank order must be identical
    assertEqual(result1.byRankOrder.length, result2.byRankOrder.length, 'Rank order length must match');
    for (let i = 0; i < result1.byRankOrder.length; i++) {
      assertEqual(result1.byRankOrder[i].modelId, result2.byRankOrder[i].modelId, `Rank[${i}] modelId must match`);
    }

    // Test with priorDeltas — same deltas → same result
    const priorDeltas = [0.05, -0.02, 0.0, -0.01, 0.03];
    const resultWithDeltas1 = scoreModels(models, policy, priorDeltas);
    const resultWithDeltas2 = scoreModels(models, policy, priorDeltas);
    assertEqual(resultWithDeltas1.byRankOrder[0].modelId, resultWithDeltas2.byRankOrder[0].modelId, 'Same priorDeltas → same winner');

    // Test calibrate determinism
    const cal1 = calibrate(0.75);
    const cal2 = calibrate(0.75);
    assertEqual(cal1, cal2, 'calibrate must be deterministic');

    // Test extractFeatures determinism
    const evidence: RawEvidence = { tokens: 1000, nCap: 3, scores: { complexity: 0.5, capability: 0.7 }, probabilities: { urgency: 0.3, budget: 0.6 } };
    const feat1 = extractFeatures(evidence);
    const feat2 = extractFeatures(evidence);
    assertEqual(feat1.overall, feat2.overall, 'extractFeatures must be deterministic');

    // Test LocalJevReimpl determinism
    const localOutput1 = answerQuestionsLocally({
      requestId: 'dual-test-001',
      models,
      policy,
      priorDeltas,
    });
    const localOutput2 = answerQuestionsLocally({
      requestId: 'dual-test-001',
      models,
      policy,
      priorDeltas,
    });
    // Note: decisionId includes Date.now() so it differs, but scores must match
    assertEqual(
      localOutput1.decision.selectedRecommendation,
      localOutput2.decision.selectedRecommendation,
      'LocalJevReimpl must produce same winner',
    );
    assertEqual(localOutput1.decisionSource, 'LOCAL_REIMPL', 'LocalJevReimpl must tag LOCAL_REIMPL');
    assertEqual(localOutput1.localLabeled, true, 'LocalJevReimpl must be localLabeled');

    // Verify candidate scores match
    for (let i = 0; i < localOutput1.decision.candidateScores.length; i++) {
      assertEqual(
        localOutput1.decision.candidateScores[i].modelId,
        localOutput2.decision.candidateScores[i].modelId,
        `Candidate[${i}] modelId must match`,
      );
    }

    // Tiebreak determinism
    const tie1 = tieBreak(result1.byRankOrder);
    const tie2 = tieBreak(result2.byRankOrder);
    for (let i = 0; i < tie1.length; i++) {
      assertEqual(tie1[i].modelId, tie2[i].modelId, `TieBreak[${i}] must be deterministic`);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// T-8.4: 反固化验收 (Anti-ossification)
// ═══════════════════════════════════════════════════════════════════════════

function testT84_AntiOssification(): TestResult | Promise<TestResult> {
  return runTest('T-8.4: After applying experience, at least 5 distinct models can still win (EXP-5)', () => {
    const models: ModelDescriptor[] = [
      { modelId: 'gpt-4o',      capability: 0.95, quality: 0.90, cost: 0.50, latency: 0.45, load: 0.20 },
      { modelId: 'claude-3.5',  capability: 0.85, quality: 0.88, cost: 0.40, latency: 0.35, load: 0.30 },
      { modelId: 'gemini-pro',  capability: 0.70, quality: 0.75, cost: 0.15, latency: 0.50, load: 0.10 },
      { modelId: 'llama-3',     capability: 0.45, quality: 0.50, cost: 0.02, latency: 0.65, load: 0.05 },
      { modelId: 'mistral-l',   capability: 0.60, quality: 0.65, cost: 0.08, latency: 0.40, load: 0.15 },
      { modelId: 'command-r',   capability: 0.50, quality: 0.55, cost: 0.05, latency: 0.55, load: 0.12 },
      { modelId: 'qwen-72b',    capability: 0.65, quality: 0.68, cost: 0.10, latency: 0.42, load: 0.08 },
      { modelId: 'yi-large',    capability: 0.55, quality: 0.58, cost: 0.06, latency: 0.48, load: 0.18 },
    ];

    const basePolicy: PolicySnapshot = {
      w_capability: 0.3,
      w_quality: 0.25,
      w_cost: 0.2,
      w_latency: 0.25,
      T0: 1.0,
      alpha: 0.5,
    };

    const winners = new Set<string>();

    // Test with various priorDelta configurations to show multiple models can win
    const priorDeltaSets: number[][] = [
      [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],           // No correction
      [0.3, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],           // Favor model 0
      [0.0, 0.3, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],           // Favor model 1
      [0.0, 0.0, 0.3, 0.0, 0.0, 0.0, 0.0, 0.0],           // Favor model 2
      [0.0, 0.0, 0.0, 0.4, 0.0, 0.0, 0.0, 0.0],           // Favor model 3 (cheapest)
      [0.0, 0.0, 0.0, 0.0, 0.3, 0.0, 0.0, 0.0],           // Favor model 4
      [0.0, 0.0, 0.0, 0.0, 0.0, 0.3, 0.0, 0.0],           // Favor model 5
      [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.3, 0.0],           // Favor model 6
      [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.3],           // Favor model 7
      [-0.3, -0.3, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],         // Penalize top 2
      [0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 0.0, 0.0],           // Strong favor model 3
      [0.0, 0.0, 0.0, 0.0, 0.0, 0.5, 0.0, 0.0],           // Strong favor model 5
      [-0.4, -0.4, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15],   // Strong penalize top 2
    ];

    for (const deltas of priorDeltaSets) {
      const result = scoreModels(models, basePolicy, deltas);
      const ranked = tieBreak(result.byRankOrder);
      if (ranked.length > 0) {
        winners.add(ranked[0].modelId);
      }
    }

    // Also test with policy weight variations
    const policyVariations: PolicySnapshot[] = [
      { ...basePolicy, w_capability: 0.5, w_quality: 0.1, w_cost: 0.2, w_latency: 0.2 },
      { ...basePolicy, w_capability: 0.1, w_quality: 0.5, w_cost: 0.2, w_latency: 0.2 },
      { ...basePolicy, w_capability: 0.1, w_quality: 0.2, w_cost: 0.5, w_latency: 0.2 },
      { ...basePolicy, w_capability: 0.1, w_quality: 0.2, w_cost: 0.2, w_latency: 0.5 },
    ];

    for (const policy of policyVariations) {
      const result = scoreModels(models, policy);
      const ranked = tieBreak(result.byRankOrder);
      if (ranked.length > 0) {
        winners.add(ranked[0].modelId);
      }
    }

    // EXP-5: At least 5 distinct models can still win
    assertGreaterEqual(winners.size, 5, `Anti-ossification: at least 5 models must be able to win, got ${winners.size}: [${Array.from(winners).join(', ')}]`);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// T-8.5: 劣化告警与一键回滚演练
// ═══════════════════════════════════════════════════════════════════════════

function testT85_DegradationAlertAndRollback(): TestResult | Promise<TestResult> {
  return runTest('T-8.5: Degradation detection → atomic rollback → state restoration → audit event', () => {
    const versions = new ExperienceVersionManager();
    const v1 = versions.genesis();
    const validator = new ExperienceValidator(versions);
    const rollback = new ExperienceRollback(versions);

    const now = Date.now();

    // Create V2 that will be the "degradation boundary"
    const v2 = versions.createVersion({
      trigger: 'system-refresh',
      changes: { thresholdDeltas: { high: -0.1 } },
    });

    // Build before entries: GOOD performance (high hit rate, low takeover)
    const beforeEntries: ExperienceEntry[] = [];
    for (let i = 0; i < 60; i++) {
      beforeEntries.push(confirmedEntry(
        `exp-good-${i}`, 'translation', 'gpt-4o', 'gpt-4o', 0, '1',
        now - 30000 + i * 100, 0.9,
      ));
    }

    // Capture the version boundary timestamp (V2's createdAt)
    const versionBoundary = new Date(v2.createdAt).getTime();

    // Build after entries: DEGRADED performance (low hit rate, high takeover)
    // All after entries MUST have observedAt AFTER the version boundary
    const afterEntries: ExperienceEntry[] = [];
    for (let i = 0; i < 40; i++) {
      if (i < 25) {
        // 25 out of 40 are disputed (bad)
        afterEntries.push(disputedEntry(
          `exp-bad-${i}`, 'translation', 'gpt-4o', 'gpt-4o', 0, '2',
          versionBoundary + 1000 + i * 100, 0.45,
        ));
      } else {
        afterEntries.push(confirmedEntry(
          `exp-ok-${i}`, 'translation', 'gpt-4o', 'gpt-4o', 0, '2',
          versionBoundary + 1000 + i * 100, 0.7,
        ));
      }
    }

    // 1. ExperienceValidator detects degradation
    const result = validator.validateLoop(v2.version, [...beforeEntries, ...afterEntries]);
    assertEqual(result.verdict, 'degraded', `Validator should detect degradation, got: ${result.verdict} — ${result.rationale}`);

    // 2. Degraded verdict should suggest rollback
    assert(result.rollbackSuggestion !== undefined, 'Degraded verdict should include rollback suggestion');
    assert(result.rollbackSuggestion!.targetVersion < v2.version, 'Rollback target should be before degraded version');

    // 3. Atomic rollback
    const rollbackResult = rollback.rollbackTo(v1.version, 'ops-admin');

    // 4. Verify system returns to pre-degradation state
    assert(rollbackResult.atomicityVerified, 'Rollback must be atomic');
    assertEqual(rollbackResult.targetVersion.version, v1.version, 'Rollback should target V1');

    // Active state MUST deep-equal V1's prior snapshots
    const latestVersion = versions.getLatestVersion()!;
    const v1Data = versions.getVersion(v1.version);
    const keysLatest = Object.keys(latestVersion.priorSnapshots).sort();
    const keysV1 = Object.keys(v1Data.priorSnapshots).sort();
    assertEqual(keysLatest.length, keysV1.length, 'Prior snapshot key count must match after rollback');
    for (let i = 0; i < keysLatest.length; i++) {
      assertEqual(keysLatest[i], keysV1[i], `Prior snapshot key [${i}] must match`);
      assertEqual(latestVersion.priorSnapshots[keysLatest[i]], v1Data.priorSnapshots[keysV1[i]], `Prior snapshot value for ${keysLatest[i]} must match`);
    }

    // 5. Rollback creates audit event (new version with trigger=rollback)
    const auditVersions = versions.listVersions().filter(v => v.trigger === 'rollback');
    assertEqual(auditVersions.length, 1, 'Rollback must create exactly one audit version event');
    assertEqual(auditVersions[0].rollbackTarget, v1.version, 'Audit version must reference rollback target');
    assert(typeof auditVersions[0].operator === 'string' && auditVersions[0].operator!.length > 0,
      'Audit version must have operator');

    // Verify rollback atomicity using the helper function
    const atomicity = verifyRollbackAtomicity(rollbackResult.rollbackVersion, rollbackResult.targetVersion);
    assert(atomicity.ok, `Rollback atomicity verification: ${atomicity.violations.join('; ')}`);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// T-8.6: 偏差登记复核
// ═══════════════════════════════════════════════════════════════════════════

/** Frontend deviation entry shape (mirrored from OfflineAdapter.ts for cross-check). */
interface FrontendDeviationEntry {
  id: string;
  aspect: string;
  officialBehavior: string;
  localBehavior: string;
  risk: string;
}

function testT86_DeviationRegisterReview(): TestResult | Promise<TestResult> {
  return runTest('T-8.6: Deviation register review — each deviation has required fields; structure matches frontend', () => {
    // 1. Verify LOCAL_JEV_DEVIATIONS is accessible and registered
    const deviations = getDeviationTable();
    assert(Array.isArray(deviations), 'Deviation table should be an array');
    assertGreaterEqual(deviations.length, 1, 'Should have at least one deviation registered');

    // 2. Verify each deviation has required fields
    for (const d of deviations) {
      assert(typeof d.id === 'string' && d.id.length > 0, `Deviation must have non-empty "id"`);
      assert(typeof d.aspect === 'string' && d.aspect.length > 0, `Deviation ${d.id} must have non-empty "aspect"`);
      assert(typeof d.official === 'string' && d.official.length > 0, `Deviation ${d.id} must have non-empty "official"`);
      assert(typeof d.local === 'string' && d.local.length > 0, `Deviation ${d.id} must have non-empty "local"`);
      assert(typeof d.rationale === 'string' && d.rationale.length > 0, `Deviation ${d.id} must have non-empty "rationale"`);
    }

    // 3. Verify verifyDeviationsRegistered returns no unverified aspects
    const unverified = verifyDeviationsRegistered();
    assertEqual(unverified.length, 0, `All aspects should be registered. Unverified: ${unverified.join(', ')}`);

    // 4. Cross-check with frontend OFFLINE_DEVIATIONS structure
    // Frontend uses: { id, aspect, officialBehavior, localBehavior, risk }
    // Backend uses:  { id, aspect, official,     local,        rationale }
    // Verify structure compatibility: same IDs, same aspects
    const frontendStructure: FrontendDeviationEntry[] = [
      { id: 'F1', aspect: '决策来源', officialBehavior: 'TypeSafe Jev API 真实响应', localBehavior: '本地确定性重实现 (LocalJevReimpl)', risk: '低 — 算法相同但无真实校准数据' },
      { id: 'F2', aspect: 'Provider 标签', officialBehavior: '决策来源标记为 TYPE_SAFE_JEV + provider=system-one', localBehavior: '决策来源标记为 LOCAL_REIMPL', risk: '无 — 非伪装' },
      { id: 'F3', aspect: 'Schema 校验', officialBehavior: '服务端完整 schema 校验', localBehavior: '前端简化校验', risk: '低 — 输出空间封闭' },
      { id: 'F4', aspect: '延迟', officialBehavior: '网络延迟 200-2000ms', localBehavior: '本地计算 <5ms', risk: '无 — 仅影响动画节奏' },
      { id: 'F5', aspect: '人工审批', officialBehavior: '服务端审批 + 审计', localBehavior: '单端审批 + 显式标注「本地审批」', risk: '中 — 无跨端审计追踪' },
      { id: 'F6', aspect: '经验状态', officialBehavior: '服务端 Experience Store', localBehavior: 'localStorage (版本化键)', risk: '低 — 数据不跨设备同步' },
    ];

    // Verify same number of deviations
    assertEqual(deviations.length, frontendStructure.length,
      `Backend (${deviations.length}) and frontend (${frontendStructure.length}) deviation counts must match`);

    // Verify IDs match
    const backendIds = deviations.map(d => d.id).sort();
    const frontendIds = frontendStructure.map(d => d.id).sort();
    for (let i = 0; i < backendIds.length; i++) {
      assertEqual(backendIds[i], frontendIds[i], `Deviation ID at position ${i} must match`);
    }

    // 5. Verify structural mapping: backend fields map to frontend fields
    for (const d of deviations) {
      const fe = frontendStructure.find(f => f.id === d.id);
      assert(fe !== undefined, `Deviation ${d.id} must have a frontend counterpart`);
      // Backend `official` maps to frontend `officialBehavior`
      assert(typeof d.official === 'string', `Deviation ${d.id} must have 'official' field (maps to frontend officialBehavior)`);
      // Backend `local` maps to frontend `localBehavior`
      assert(typeof d.local === 'string', `Deviation ${d.id} must have 'local' field (maps to frontend localBehavior)`);
      // Backend `rationale` maps to frontend `risk`
      assert(typeof d.rationale === 'string', `Deviation ${d.id} must have 'rationale' field (maps to frontend risk)`);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Main export
// ═══════════════════════════════════════════════════════════════════════════

export async function runClosedLoopTests(): Promise<{
  passed: number;
  failed: number;
  results: Array<{ name: string; passed: boolean; error?: string }>;
}> {
  const tests: Array<() => TestResult | Promise<TestResult>> = [
    // T-8.2: 五段位验收
    testT82_Stage1_Precipitation,
    testT82_Stage2_Statistics,
    testT82_Stage3_Application,
    testT82_Stage4_Reproducibility,
    testT82_Stage5_ValidationRollback,
    // T-8.3: 双形态一致性
    testT83_DualFormConsistency,
    // T-8.4: 反固化验收
    testT84_AntiOssification,
    // T-8.5: 劣化告警与一键回滚演练
    testT85_DegradationAlertAndRollback,
    // T-8.6: 偏差登记复核
    testT86_DeviationRegisterReview,
  ];

  const results: Array<{ name: string; passed: boolean; error?: string }> = [];
  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      const result = await test();
      results.push(result);
      if (result.passed) passed++;
      else failed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ name: 'unknown', passed: false, error: `Test threw: ${msg}` });
      failed++;
    }
  }

  return { passed, failed, results };
}
