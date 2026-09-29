/**
 * State Engineering — JEV-14 (§4.11).
 *
 * State MUST be separated by function into 6 segments; MUST NOT be one
 * undifferentiated text block:
 *
 * ```
 * GOAL          what success means
 * FACTS         what the system knows
 * ARTIFACTS     what already exists
 * EVIDENCE      what supports the next judgment
 * CONSTRAINTS   what the system may not cross
 * OPTIONS       what can happen now
 * ```
 *
 * Core anti-pattern: state containing **conclusions** rather than **evidence**.
 *
 * ❌ "the research is probably enough"
 * ✅ "7 sources collected · 3 official · pricing verified · security claim unresolved"
 *
 * The model SHALL judge the evidence itself; MUST NOT inherit the prior
 * stage's confidence as fact (links to JEV-4 empty-signal defense).
 *
 * Menu real-time rebuild (OPTIONS segment): available actions change with
 * each action (workers online/offline, sources expired, budget shrunk,
 * files appeared, permissions changed, queues filled). Selecting from a
 * stale menu is "running on an invalid graph", not "bad reasoning".
 */
import type { StateSegment } from './decision-contract.js';

/** A single evidence entry (atomic, checkable). */
export interface EvidenceEntry {
  /** The fact being stated. */
  claim: string;
  /** Whether this claim has been verified. */
  verified: boolean;
  /** Optional source identifier. */
  source?: string;
}

/** The 6-segment state structure (JEV-14). */
export interface EngineeredState {
  /** GOAL: what success means (compact). */
  goal: string;
  /** FACTS: what the system knows (atomic, checkable). */
  facts: EvidenceEntry[];
  /** ARTIFACTS: what already exists (documents, prior outputs). */
  artifacts: string[];
  /** EVIDENCE: what supports the next judgment (atomic, checkable). */
  evidence: EvidenceEntry[];
  /** CONSTRAINTS: what the system may not cross. */
  constraints: string[];
  /** OPTIONS: what can happen now (rebuilt from real-time state). */
  options: string[];
  /** State version (for decision receipt, JEV-16). */
  stateVersion: string;
  /** Content hash (for decision receipt, JEV-16). */
  stateHash: string;
}

/** All 6 segment names in canonical order. */
export const STATE_SEGMENTS: readonly StateSegment[] = [
  'GOAL',
  'FACTS',
  'ARTIFACTS',
  'EVIDENCE',
  'CONSTRAINTS',
  'OPTIONS',
] as const;

/** Conclusion phrases that signal state contamination (JEV-14 anti-pattern). */
const CONCLUSION_PATTERNS = [
  /\bprobably\b/i,
  /\blikely\b/i,
  /\benough\b/i,
  /\bsufficient\b/i,
  /\bseems\s+(?:good|enough|fine|ok|sufficient)\b/i,
  /\blooks\s+(?:good|enough|fine|ok|sufficient)\b/i,
  /\bappears?\s+(?:to\s+be\s+)?(?:good|enough|fine|ok|sufficient|complete)\b/i,
  /\bmaybe\b/i,
  /\bperhaps\b/i,
  /\broughly\b/i,
];

/** Result of conclusion-pattern scan. */
export interface ConclusionScanResult {
  /** `true` iff the segment passed (no conclusion phrases detected). */
  ok: boolean;
  /** Offending entries with the matched phrase. */
  offenders: { segment: StateSegment; index: number; phrase: string; claim: string }[];
}

/**
 * Scan a segment's entries for conclusion phrases (JEV-14 anti-pattern).
 * Returns offenders so the caller can rewrite them as atomic evidence.
 */
function scanEntries(
  segment: StateSegment,
  entries: EvidenceEntry[],
): ConclusionScanResult['offenders'] {
  const offenders: ConclusionScanResult['offenders'] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    for (const pattern of CONCLUSION_PATTERNS) {
      const match = entry.claim.match(pattern);
      if (match) {
        offenders.push({
          segment,
          index: i,
          phrase: match[0],
          claim: entry.claim,
        });
        break;
      }
    }
  }
  return offenders;
}

/**
 * Assemble a 6-segment state, enforcing JEV-14 separation.
 *
 * Rules enforced:
 *  1. All 6 segments MUST be present (empty arrays allowed for segments
 *     with no data, but their presence is required).
 *  2. FACTS / EVIDENCE entries MUST NOT contain conclusion phrases
 *     ("probably", "likely enough", etc.) — the caller is asked to rewrite
 *     them as atomic, checkable evidence.
 *  3. OPTIONS MUST be provided (a stale menu is an invalid graph).
 *
 * @throws StateAssemblyError when conclusion contamination is detected.
 */
export function assembleState(input: {
  goal: string;
  facts: EvidenceEntry[];
  artifacts?: string[];
  evidence: EvidenceEntry[];
  constraints?: string[];
  options: string[];
  stateVersion?: string;
}): EngineeredState {
  const factsOffenders = scanEntries('FACTS', input.facts);
  const evidenceOffenders = scanEntries('EVIDENCE', input.evidence);
  const offenders = [...factsOffenders, ...evidenceOffenders];
  if (offenders.length > 0) {
    const summary = offenders
      .map((o) => `${o.segment}[${o.index}]: "${o.phrase}" in "${o.claim}"`)
      .join('; ');
    throw new StateAssemblyError(
      `Conclusion-as-evidence detected (JEV-14 anti-pattern). Rewrite as atomic, checkable evidence. Offenders: ${summary}`,
    );
  }
  if (input.options.length === 0) {
    throw new StateAssemblyError(
      'OPTIONS segment MUST be non-empty (stale menu = invalid graph, JEV-14).',
    );
  }
  const stateVersion = input.stateVersion ?? `state-${Date.now()}`;
  const stateHash = computeStateHash({
    goal: input.goal,
    facts: input.facts,
    artifacts: input.artifacts ?? [],
    evidence: input.evidence,
    constraints: input.constraints ?? [],
    options: input.options,
    stateVersion,
  });
  return {
    goal: input.goal,
    facts: input.facts,
    artifacts: input.artifacts ?? [],
    evidence: input.evidence,
    constraints: input.constraints ?? [],
    options: input.options,
    stateVersion,
    stateHash,
  };
}

/** Error thrown when state assembly fails JEV-14 checks. */
export class StateAssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateAssemblyError';
  }
}

/**
 * Compute a content hash for the state (for JEV-16 decision receipt).
 * Uses a simple FNV-1a hash since Node 20's `crypto.createHash` is async-ish
 * and we want a pure sync function for the two-form architecture.
 */
export function computeStateHash(state: Omit<EngineeredState, 'stateHash'>): string {
  const parts = [
    state.goal,
    state.facts.map((f) => `${f.claim}:${f.verified}:${f.source ?? ''}`).join('|'),
    state.artifacts.join('|'),
    state.evidence.map((e) => `${e.claim}:${e.verified}:${e.source ?? ''}`).join('|'),
    state.constraints.join('|'),
    state.options.join('|'),
    state.stateVersion,
  ];
  const text = parts.join('\n');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Force positive 32-bit, render as hex.
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Validate that an EngineeredState has all 6 segments and no conclusion
 * contamination. Returns violations (does not throw).
 */
export function validateState(state: Partial<EngineeredState>): ConclusionScanResult & {
  missingSegments: StateSegment[];
} {
  const missingSegments: StateSegment[] = [];
  for (const seg of STATE_SEGMENTS) {
    if (state[seg.toLowerCase() as keyof EngineeredState] === undefined) {
      missingSegments.push(seg);
    }
  }
  const factsOffenders = state.facts ? scanEntries('FACTS', state.facts) : [];
  const evidenceOffenders = state.evidence ? scanEntries('EVIDENCE', state.evidence) : [];
  const offenders = [...factsOffenders, ...evidenceOffenders];
  return {
    ok: missingSegments.length === 0 && offenders.length === 0,
    offenders,
    missingSegments,
  };
}
