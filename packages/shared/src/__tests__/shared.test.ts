import { describe, it, expect } from 'vitest';

// ── shared layer imports ──
import {
  calibrate,
  CALIBRATE_LOW,
  CALIBRATE_HIGH,
} from '../calibrate.js';
import { tieBreak } from '../tieBreak.js';
import {
  priorDeltaFor,
  EXP_CORR_MAX,
} from '../priorDeltaFor.js';
import {
  calibrationStats,
  ECE_BINS,
} from '../calibrationStats.js';
import {
  computeRun,
  RUN_DEFAULT_TOTAL_MS,
  STAGE_COUNT,
  STAGE_NAMES,
} from '../computeRun.js';
import { routeTier } from '../routeTier.js';

// interpretNoulProbability tests are in packages/backend/src/__tests__/noul-boundary.test.ts
// (cross-package imports not allowed under shared rootDir)

import type { ScoredModel, ExperienceSample } from '../types.js';

// ---------------------------------------------------------------------------
// calibrate (§4.2)
// ---------------------------------------------------------------------------
describe('calibrate', () => {
  it('calibrate(0.5) returns value in [0.35, 0.97]', () => {
    const v = calibrate(0.5);
    expect(v).toBeGreaterThanOrEqual(CALIBRATE_LOW);
    expect(v).toBeLessThanOrEqual(CALIBRATE_HIGH);
  });

  it('calibrate(0) returns CALIBRATE_LOW (0.35)', () => {
    expect(calibrate(0)).toBe(CALIBRATE_LOW);
  });

  it('calibrate(1) returns CALIBRATE_HIGH (0.97)', () => {
    expect(calibrate(1)).toBe(CALIBRATE_HIGH);
  });

  it('calibrate(NaN) returns CALIBRATE_LOW', () => {
    expect(calibrate(NaN)).toBe(CALIBRATE_LOW);
  });

  it('calibrate(Infinity) returns CALIBRATE_LOW', () => {
    expect(calibrate(Infinity)).toBe(CALIBRATE_LOW);
  });

  it('monotonic: calibrate(0.3) < calibrate(0.5) < calibrate(0.8)', () => {
    expect(calibrate(0.3)).toBeLessThan(calibrate(0.5));
    expect(calibrate(0.5)).toBeLessThan(calibrate(0.8));
  });
});

// ---------------------------------------------------------------------------
// tieBreak (§4.4 / SCORE-4)
// ---------------------------------------------------------------------------
describe('tieBreak', () => {
  /** Helper: build a ScoredModel. */
  function mkModel(overrides: Partial<ScoredModel> & Pick<ScoredModel, 'modelId'>): ScoredModel {
    return {
      catalogIndex: 0,
      rankIndex: 0,
      raw: 0.5,
      probability: 0.25,
      capability: 0.5,
      cost: 0.5,
      latency: 0.5,
      ...overrides,
    };
  }

  it('CRITICAL (SCORE-4): when raw scores differ significantly, winner = byRankOrder[0] (raw decides)', () => {
    // Model A: high raw, low capability
    // Model B: low raw, high capability
    // Raw is the definitive ranking → A must win regardless of capability.
    const a = mkModel({ modelId: 'model-a', raw: 0.9, capability: 0.1 });
    const b = mkModel({ modelId: 'model-b', raw: 0.3, capability: 0.95 });
    const result = tieBreak([a, b]);
    expect(result[0].modelId).toBe('model-a');
    expect(result[0].raw).toBe(0.9);
  });

  it('when raw scores are near-equal (|Δraw| < ε), capability is the tiebreaker', () => {
    // Both models have essentially the same raw score (difference < 1e-9).
    // The one with higher capability should rank first.
    const a = mkModel({ modelId: 'model-a', raw: 0.5, capability: 0.3 });
    const b = mkModel({ modelId: 'model-b', raw: 0.5, capability: 0.9 });
    const result = tieBreak([a, b]);
    expect(result[0].modelId).toBe('model-b');
  });

  it('deterministic: same input → same output', () => {
    const a = mkModel({ modelId: 'm1', raw: 0.7, capability: 0.6, cost: 0.3, latency: 0.2 });
    const b = mkModel({ modelId: 'm2', raw: 0.4, capability: 0.8, cost: 0.1, latency: 0.5 });
    const c = mkModel({ modelId: 'm3', raw: 0.55, capability: 0.4, cost: 0.5, latency: 0.1 });
    const input = [a, b, c];
    const r1 = tieBreak(input);
    const r2 = tieBreak(input);
    expect(r1.map((m) => m.modelId)).toEqual(r2.map((m) => m.modelId));
  });

  it('reassigns rankIndex to reflect strict order', () => {
    const a = mkModel({ modelId: 'a', raw: 0.8 });
    const b = mkModel({ modelId: 'b', raw: 0.3 });
    const result = tieBreak([a, b]);
    expect(result[0].rankIndex).toBe(0);
    expect(result[1].rankIndex).toBe(1);
  });

  it('does not mutate the original input array', () => {
    const a = mkModel({ modelId: 'a', raw: 0.8, rankIndex: 5 });
    const b = mkModel({ modelId: 'b', raw: 0.3, rankIndex: 3 });
    const input = [a, b];
    tieBreak(input);
    // Original rankIndex values should be preserved
    expect(input[0].rankIndex).toBe(5);
    expect(input[1].rankIndex).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// priorDeltaFor (§4.9.4 / EXP-5)
// ---------------------------------------------------------------------------
describe('priorDeltaFor', () => {
  it('cold start (n_eff = 0): returns Δraw = 0', () => {
    const result = priorDeltaFor({
      priorMean: 0.5,
      samples: [],
      globalConfirmedCount: 100,
    });
    expect(result.delta).toBe(0);
    expect(result.nEff).toBe(0);
  });

  it('cold start: shadow mode also returns delta = 0', () => {
    const result = priorDeltaFor({
      priorMean: 0.5,
      samples: [],
      globalConfirmedCount: 5, // < EXP_MIN_SAMPLE_GLOBAL
    });
    expect(result.delta).toBe(0);
  });

  it('with data: returns bounded correction (|Δraw| ≤ EXP_CORR_MAX)', () => {
    const priorMean = 0.5;
    // Generate enough samples to pass both per-pair and global guards.
    const samples: ExperienceSample[] = [];
    for (let i = 0; i < 20; i++) {
      samples.push({
        intent: 'test',
        modelId: 'm1',
        y: 1,
        source: 'human',
        observedAt: Date.now(),
        weight: 1,
      });
    }
    const result = priorDeltaFor({
      priorMean,
      samples,
      globalConfirmedCount: 50,
    });
    expect(Math.abs(result.delta)).toBeLessThanOrEqual(EXP_CORR_MAX);
  });

  it('beta posterior mean is between prior and data mean', () => {
    const priorMean = 0.5;
    // Data mean = 0.8 (all y=1 with weight=1).
    // postMean should be between 0.5 and 0.8.
    const samples: ExperienceSample[] = [];
    for (let i = 0; i < 20; i++) {
      samples.push({
        intent: 'test',
        modelId: 'm1',
        y: 1,
        source: 'human',
        observedAt: Date.now(),
        weight: 1,
      });
    }
    const result = priorDeltaFor({
      priorMean,
      samples,
      globalConfirmedCount: 50,
    });
    const dataMean = 1; // all y=1
    // postMean is between priorMean and dataMean (shrunk toward prior).
    expect(result.postMean).toBeGreaterThanOrEqual(priorMean);
    expect(result.postMean).toBeLessThanOrEqual(dataMean);
  });

  it('per-pair cold start guard: n_eff < MIN_SAMPLE_PER_PAIR → delta = 0', () => {
    // Only 5 samples, below EXP_MIN_SAMPLE_PER_PAIR (8).
    const samples: ExperienceSample[] = [];
    for (let i = 0; i < 5; i++) {
      samples.push({
        intent: 'test',
        modelId: 'm1',
        y: 1,
        source: 'human',
        observedAt: Date.now(),
        weight: 1,
      });
    }
    const result = priorDeltaFor({
      priorMean: 0.5,
      samples,
      globalConfirmedCount: 50,
    });
    expect(result.delta).toBe(0);
  });

  it('global shadow: globalConfirmedCount < MIN_SAMPLE_GLOBAL → delta = 0, shadowed = true', () => {
    const samples: ExperienceSample[] = [];
    for (let i = 0; i < 20; i++) {
      samples.push({
        intent: 'test',
        modelId: 'm1',
        y: 1,
        source: 'human',
        observedAt: Date.now(),
        weight: 1,
      });
    }
    const result = priorDeltaFor({
      priorMean: 0.5,
      samples,
      globalConfirmedCount: 10, // < EXP_MIN_SAMPLE_GLOBAL (30)
    });
    expect(result.delta).toBe(0);
    expect(result.shadowed).toBe(true);
    // shadowDelta should reflect what the correction would have been.
    expect(result.shadowDelta).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// calibrationStats (§4.9.6 / EXP-2)
// ---------------------------------------------------------------------------
describe('calibrationStats', () => {
  it('empty input: returns insufficient=true', () => {
    const result = calibrationStats([]);
    expect(result.insufficient).toBe(true);
    expect(result.totalSamples).toBe(0);
  });

  it('with 30+ samples: returns ECE and bins', () => {
    const samples = Array.from({ length: 35 }, (_, i) => ({
      confidence: 0.5 + (i % 10) * 0.05,
      hit: i % 2 === 0,
    }));
    const result = calibrationStats(samples);
    expect(result.insufficient).toBe(false);
    expect(result.bins).toHaveLength(ECE_BINS);
    expect(result.totalSamples).toBe(35);
  });

  it('ECE is between 0 and 1', () => {
    const samples = Array.from({ length: 50 }, () => ({
      confidence: Math.random(),
      hit: Math.random() > 0.5,
    }));
    const result = calibrationStats(samples);
    expect(result.ece).toBeGreaterThanOrEqual(0);
    expect(result.ece).toBeLessThanOrEqual(1);
  });

  it('perfectly calibrated: ECE = 0', () => {
    // When confidence = hit rate for every sample, ECE should be 0.
    const samples = Array.from({ length: 50 }, (_, i) => ({
      confidence: i % 2 === 0 ? 1 : 0,
      hit: i % 2 === 0,
    }));
    const result = calibrationStats(samples);
    expect(result.ece).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeRun (§4.7 / ANIM-1)
// ---------------------------------------------------------------------------
describe('computeRun', () => {
  it('stage names match expected 7 stages', () => {
    const timeline = computeRun();
    const names = timeline.stages.map((s) => s.name);
    expect(names).toEqual([...STAGE_NAMES]);
  });

  it('same input → same output (deterministic)', () => {
    const a = computeRun();
    const b = computeRun();
    expect(a).toEqual(b);
  });

  it('total duration matches RUN_DEFAULT_TOTAL_MS with defaults', () => {
    const timeline = computeRun();
    expect(timeline.totalMs).toBe(RUN_DEFAULT_TOTAL_MS);
  });

  it('sum of stage durations equals totalMs', () => {
    const timeline = computeRun();
    const sum = timeline.stages.reduce((acc, s) => acc + s.durationMs, 0);
    expect(sum).toBeCloseTo(timeline.totalMs, 10);
  });

  it('stage count is STAGE_COUNT (7)', () => {
    const timeline = computeRun();
    expect(timeline.stages).toHaveLength(STAGE_COUNT);
  });

  it('non-finite totalDurationMs falls back to RUN_DEFAULT_TOTAL_MS', () => {
    const t = computeRun({ totalDurationMs: NaN });
    expect(t.totalMs).toBe(RUN_DEFAULT_TOTAL_MS);
  });
});

// ---------------------------------------------------------------------------
// routeTier (§4.2.1 / JEV-5 / JEV-11)
// ---------------------------------------------------------------------------
describe('routeTier', () => {
  it('confidence >= high threshold → ROUTE', () => {
    expect(routeTier(0.82)).toBe('ROUTE');
    expect(routeTier(0.95)).toBe('ROUTE');
    expect(routeTier(1.0)).toBe('ROUTE');
  });

  it('medium range → GATE', () => {
    expect(routeTier(0.6)).toBe('GATE');
    expect(routeTier(0.7)).toBe('GATE');
    expect(routeTier(0.81)).toBe('GATE');
  });

  it('low → ESCALATE', () => {
    expect(routeTier(0.0)).toBe('ESCALATE');
    expect(routeTier(0.1)).toBe('ESCALATE');
    expect(routeTier(0.59)).toBe('ESCALATE');
  });

  it('NaN → ESCALATE (non-finite defense)', () => {
    expect(routeTier(NaN)).toBe('ESCALATE');
  });

  it('custom thresholds are respected', () => {
    expect(routeTier(0.7, { high: 0.7, mid: 0.4 })).toBe('ROUTE');
    expect(routeTier(0.5, { high: 0.7, mid: 0.4 })).toBe('GATE');
    expect(routeTier(0.3, { high: 0.7, mid: 0.4 })).toBe('ESCALATE');
  });
});

// interpretNoulProbability tests moved to packages/backend/src/__tests__/noul-boundary.test.ts
// (cannot import from backend within shared package due to rootDir constraint)
