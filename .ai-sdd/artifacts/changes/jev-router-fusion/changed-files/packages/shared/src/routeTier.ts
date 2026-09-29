/**
 * `routeTier` — JEV-5 / JEV-11 three-tier routing (§4.2.1).
 *
 * Maps calibrated confidence into one of three disposition tiers:
 *
 * | Tier       | Threshold        | Disposition                     | Human? |
 * |------------|------------------|---------------------------------|--------|
 * | `ROUTE`    | conf ≥ high      | Direct routing                  | no     |
 * | `GATE`     | mid ≤ conf < high| Route with observation flag     | no     |
 * | `ESCALATE` | conf < mid       | Ambiguous → human review        | yes    |
 *
 * Per `JEV-11` scenario 2: the tier mapping MUST be a pure function of
 * confidence; it MUST NOT consult hard-constraint filter results. The
 * Selector (hard-constraint pipeline, §4.5) is orthogonal — `routeTier`
 * is invoked AFTER `calibrate`, BEFORE the Selector decides who CAN run.
 *
 * Thresholds are configurable per-call to support risk-tier sensitivity
 * (§4.2 design trade-off): "同一系统内不同动作可用不同阈值".
 */
import { ROUTE_TIER_DEFAULT } from './constants.js';
import { clamp } from './utils/math.js';
import type { RouteTier, RouteTierThresholds } from './types.js';

/** Normalize user-supplied threshold overrides with defaults. */
function resolveThresholds(
  thresholds?: Partial<RouteTierThresholds>,
): RouteTierThresholds {
  const high = thresholds?.high ?? ROUTE_TIER_DEFAULT.high;
  const mid = thresholds?.mid ?? ROUTE_TIER_DEFAULT.mid;
  // Defensive: ensure high ≥ mid so the three ranges form a valid partition.
  const safeHigh = clamp(high, 0, 1);
  const safeMid = clamp(mid, 0, safeHigh);
  return { high: safeHigh, mid: safeMid };
}

/**
 * Route calibrated confidence to its disposition tier.
 *
 * @param confidence Calibrated confidence (e.g. from `calibrate`)
 * @param thresholds Optional threshold overrides; defaults `{ high: 0.82, mid: 0.60 }`
 */
export function routeTier(
  confidence: number,
  thresholds?: Partial<RouteTierThresholds>,
): RouteTier {
  const t = resolveThresholds(thresholds);
  // Non-finite defense: any NaN/Infinity collapses to the lowest tier.
  if (!Number.isFinite(confidence)) return 'ESCALATE';
  const c = clamp(confidence, 0, 1);
  if (c >= t.high) return 'ROUTE';
  if (c >= t.mid) return 'GATE';
  return 'ESCALATE';
}

export { ROUTE_TIER_DEFAULT } from './constants.js';
