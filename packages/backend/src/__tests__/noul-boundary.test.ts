/**
 * Noul boundary tests — JEV-13 (§4.10).
 *
 * Verifies the interpretNoulProbability floating-point boundary fix
 * (NOUL_INDISTINGUISHABLE_EPSILON + 1e-9 tolerance).
 *
 * Audit §4.2: Math.abs(0.55 - 0.5) = 0.050000000000000044 > 0.05
 * caused asymmetric classification. With 1e-9 tolerance, 0.45/0.50/0.55
 * are all correctly indistinguishable.
 */
import { describe, it, expect } from 'vitest';
import {
  interpretNoulProbability,
  NOUL_INDISTINGUISHABLE_EPSILON,
} from '../primitive-guards.js';

describe('interpretNoulProbability', () => {
  it('0.45, 0.50, 0.55 are ALL indistinguishable (boundary fix verification)', () => {
    expect(interpretNoulProbability(0.45).indistinguishable).toBe(true);
    expect(interpretNoulProbability(0.50).indistinguishable).toBe(true);
    expect(interpretNoulProbability(0.55).indistinguishable).toBe(true);
  });

  it('0.3 → leans-no', () => {
    const r = interpretNoulProbability(0.3);
    expect(r.indistinguishable).toBe(false);
    expect(r.label).toBe('leans-no');
  });

  it('0.7 → leans-yes', () => {
    const r = interpretNoulProbability(0.7);
    expect(r.indistinguishable).toBe(false);
    expect(r.label).toBe('leans-yes');
  });

  it('0.0 → leans-no (definitely-no)', () => {
    const r = interpretNoulProbability(0.0);
    expect(r.indistinguishable).toBe(false);
    expect(r.label).toBe('leans-no');
  });

  it('1.0 → leans-yes (definitely-yes)', () => {
    const r = interpretNoulProbability(1.0);
    expect(r.indistinguishable).toBe(false);
    expect(r.label).toBe('leans-yes');
  });

  it('NaN → indistinguishable', () => {
    const r = interpretNoulProbability(NaN);
    expect(r.indistinguishable).toBe(true);
  });

  it('boundary: exactly at epsilon boundary is still indistinguishable', () => {
    const eps = NOUL_INDISTINGUISHABLE_EPSILON;
    expect(interpretNoulProbability(0.5 - eps).indistinguishable).toBe(true);
    expect(interpretNoulProbability(0.5 + eps).indistinguishable).toBe(true);
  });
});
