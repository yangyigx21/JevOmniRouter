/**
 * `extractFeatures` — JEV-4 deterministic feature extraction (§4.1).
 *
 * Pure function: no I/O, no side effects, deterministic across runs.
 *
 * Two "must-pinning" traps from §4.1 are explicitly enforced here:
 *
 * 1. **空信号防御**: when `total <= 0` (no keyword hits at all), the
 *    `intent` branch MUST emit `noEvidence = true` and `strength = 0`.
 *    Without this, an empty input would otherwise resolve to a default
 *    intent at >0.8 confidence (the trap explicitly called out in §4.1).
 *
 * 2. **noul 先验防污染**: the noul primitives (urgency / budget) are
 *    P(yes) outputs whose prior at "no signal" is `NOUL_PRIOR = 0.30`.
 *    Therefore `|p − 0.5|` alone is weak evidence (max 0.20 pseudo-signal);
 *    only keyword hits can lift `uStrength` past that floor.
 */
import {
  EVIDENCE_W,
  INTENT_CONC_WEIGHT,
  INTENT_VOL_SATURATION,
  INTENT_VOL_WEIGHT,
  LONG_CTX_BASE_BOOST,
  LONG_CTX_SATURATION,
  NOUL_HIT_WEIGHT,
  NOUL_P_SIGNAL_WEIGHT,
  NOUL_PRIOR,
  SCORE_MARGIN_WEIGHT,
  SCORE_TOKEN_SATURATION,
  SCORE_VOLUME_WEIGHT,
  VISION_BASE_BOOST,
  VISION_PER_IMG_BOOST,
} from './constants.js';
import { clamp } from './utils/math.js';
import type { RawEvidence } from './types.js';

/** Default number of complexity/capability grades for `scoreStrength` (§4.1). */
const DEFAULT_GRADE_COUNT = 3;

/**
 * Result of `extractFeatures` — strengths for each of the five primitive
 * questions plus the combined overall evidence strength.
 */
export interface ExtractedFeatures {
  intent: {
    winner: string;
    strength: number;
    noEvidence: boolean;
  };
  complexity: {
    score: number;
    strength: number;
  };
  urgency: {
    p: number;
    strength: number;
    hits: number;
  };
  budget: {
    p: number;
    strength: number;
    hits: number;
  };
  capability: {
    score: number;
    strength: number;
  };
  /** Weighted average across all five strengths (§4.1). */
  overall: number;
}

/**
 * Compute the strength of a `score`-type primitive (Q2 complexity / Q5
 * capability) per §4.1.
 *
 * @param score     Input score in [0,1]
 * @param grades    Number of grade boundaries (default 3 — low/med/high)
 * @param tokens    Token volume of the prompt; saturation at
 *                  `SCORE_TOKEN_SATURATION` (450 tokens)
 */
function scoreStrength(score: number, grades: number, tokens: number): number {
  const s = clamp(score, 0, 1);
  const n = grades > 1 ? grades : 1;
  // Position along the [0, n) line, clamped just below n to keep `frac` in [0,1).
  const pos = clamp(s * n, 0, n - 0.001);
  const frac = pos - Math.floor(pos);
  // `margin` is 0 at any grade boundary, 1 at the midpoint of a grade.
  const margin = Math.min(frac, 1 - frac) / 0.5;
  const tokenVolume = clamp(tokens / SCORE_TOKEN_SATURATION, 0, 1);
  return clamp(
    SCORE_MARGIN_WEIGHT * margin + SCORE_VOLUME_WEIGHT * tokenVolume,
    0,
    1,
  );
}

/**
 * Compute the strength of a `noul`-type primitive (Q3 urgency / Q4 budget)
 * per §4.1.
 *
 * @param hits   Keyword hit count for this primitive (≥ 0)
 * @param p      Reported P(yes) for this primitive (clamped to [0,1])
 */
function noulStrength(hits: number, p: number): number {
  const safeHits = hits > 0 ? hits : 0;
  const safeP = clamp(p, 0, 1);
  return clamp(
    safeHits * NOUL_HIT_WEIGHT + Math.abs(safeP - 0.5) * NOUL_P_SIGNAL_WEIGHT,
    0,
    1,
  );
}

/**
 * Compute the strength of the `choice` primitive (Q1 intent) per §4.1.
 *
 * @param hits       Per-intent keyword hit map
 * @param nCap       Number of intent candidates (for share/concentration)
 * @param imgCount   Image attachment count
 * @param fileCount  Document attachment count
 * @param fileTokens Token volume of attached documents
 */
function intentStrength(
  hits: Record<string, number>,
  nCap: number,
  imgCount: number,
  fileCount: number,
  fileTokens: number,
): { winner: string; strength: number; noEvidence: boolean } {
  // Per-category vote values (§4.1: `v = hits[kk] * 1.0 + boosts`).
  const categories = Object.keys(hits);
  const votes: Record<string, number> = {};
  let total = 0;
  let best = 0;
  let winner = '';
  for (const kk of categories) {
    const base = (hits[kk] || 0) * 1.0;
    let v = base;
    if (kk === 'vision' && imgCount > 0) {
      v += VISION_BASE_BOOST + VISION_PER_IMG_BOOST * imgCount;
    }
    if (kk === 'longCtx' && fileCount > 0) {
      v += LONG_CTX_BASE_BOOST + clamp(fileTokens / LONG_CTX_SATURATION, 0, 1);
    }
    votes[kk] = v;
    total += v;
    if (v > best) {
      best = v;
      winner = kk;
    }
  }

  // Empty-signal defense (§4.1 trap #1): explicit zero strength.
  if (total <= 0) {
    return { winner: '', strength: 0, noEvidence: true };
  }
  // Pick a stable winner if votes tied (lexicographic order).
  if (winner === '') {
    winner = categories.sort()[0] ?? '';
  }

  const cap = nCap > 1 ? nCap : categories.length || 1;
  const share = best / total;
  const uniformShare = 1 / cap;
  // Concentration: 0 when uniform across candidates, 1 when fully concentrated.
  const conc = clamp(
    (share - uniformShare) / (1 - uniformShare),
    0,
    1,
  );
  // Volume: 0 at best=0, saturates at INTENT_VOL_SATURATION hits.
  const vol = clamp(best / INTENT_VOL_SATURATION, 0, 1);
  const strength = clamp(
    INTENT_CONC_WEIGHT * conc + INTENT_VOL_WEIGHT * vol,
    0,
    1,
  );
  return { winner, strength, noEvidence: false };
}

/**
 * Extract deterministic features from raw evidence per §4.1.
 *
 * @param evidence         Raw signal evidence (`TaskEnvelope.evidence`)
 * @param opts.imgCount    Override image count (defaults from evidence)
 * @param opts.fileCount   Override document count
 * @param opts.tokens      Override token volume for `scoreStrength`
 * @param opts.grades      Number of grade boundaries for score primitives
 */
export function extractFeatures(
  evidence: RawEvidence | undefined,
  opts: {
    imgCount?: number;
    fileCount?: number;
    tokens?: number;
    grades?: number;
  } = {},
): ExtractedFeatures {
  const hits = evidence?.hits ?? {};
  const imgCount = opts.imgCount ?? evidence?.imgCount ?? 0;
  const fileCount = opts.fileCount ?? evidence?.fileCount ?? 0;
  const fileTokens = evidence?.fileTokens ?? 0;
  const tokens = opts.tokens ?? evidence?.tokens ?? 0;
  const grades = opts.grades ?? DEFAULT_GRADE_COUNT;
  const nCap = evidence?.nCap ?? Object.keys(hits).length;

  const intent = intentStrength(hits, nCap, imgCount, fileCount, fileTokens);

  const complexityScore = evidence?.scores?.complexity ?? 0;
  const complexity = {
    score: complexityScore,
    strength: scoreStrength(complexityScore, grades, tokens),
  };

  const urgencyP = evidence?.probabilities?.urgency ?? NOUL_PRIOR;
  const urgencyHits = hits.urgency ?? 0;
  const urgency = {
    p: urgencyP,
    hits: urgencyHits,
    strength: noulStrength(urgencyHits, urgencyP),
  };

  const budgetP = evidence?.probabilities?.budget ?? NOUL_PRIOR;
  const budgetHits = hits.budget ?? 0;
  const budget = {
    p: budgetP,
    hits: budgetHits,
    strength: noulStrength(budgetHits, budgetP),
  };

  const capabilityScore = evidence?.scores?.capability ?? 0;
  const capability = {
    score: capabilityScore,
    strength: scoreStrength(capabilityScore, grades, tokens),
  };

  const overall = clamp(
    EVIDENCE_W.intent * intent.strength +
      EVIDENCE_W.complexity * complexity.strength +
      EVIDENCE_W.urgency * urgency.strength +
      EVIDENCE_W.budget * budget.strength +
      EVIDENCE_W.capability * capability.strength,
    0,
    1,
  );

  return {
    intent,
    complexity,
    urgency,
    budget,
    capability,
    overall,
  };
}
