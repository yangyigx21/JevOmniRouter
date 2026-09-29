/**
 * OfflineAdapter — ARCHIVE-4 / JEV-8 (T-6.11).
 *
 * Detects offline mode and provides browser-side replacements for server features:
 *  - LocalJevReimpl (deterministic Jev answers, same logic as backend)
 *  - localStorage-based experience store (versioned keys)
 *  - In-process event bus (no SSE)
 *  - Single-endpoint human review with explicit "本地审批" label
 *
 * ARCH-2: Offline adapter SHALL use the same pure-logic layer as the cloud form.
 * JEV-8: All deviations from official TypeSafe Jev SHALL be explicitly declared.
 */

import { calibrate } from '@jev-router/shared';

// ── Mode detection ──

export type OperationMode = 'cloud' | 'offline';

let currentMode: OperationMode = typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'cloud';

export function getMode(): OperationMode {
  return currentMode;
}

export function setMode(mode: OperationMode): void {
  currentMode = mode;
}

/** Auto-detect: if backend is unreachable, fall back to offline. */
export async function detectMode(healthUrl = '/v1/health'): Promise<OperationMode> {
  try {
    const resp = await fetch(healthUrl, { method: 'GET', signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      currentMode = 'cloud';
    } else {
      currentMode = 'offline';
    }
  } catch {
    currentMode = 'offline';
  }
  return currentMode;
}

// ── JEV-10: Deviation table (matches backend LOCAL_JEV_DEVIATIONS) ──

export interface DeviationEntry {
  id: string;
  aspect: string;
  officialBehavior: string;
  localBehavior: string;
  risk: string;
}

export const OFFLINE_DEVIATIONS: DeviationEntry[] = [
  { id: 'F1', aspect: '决策来源', officialBehavior: 'TypeSafe Jev API 真实响应', localBehavior: '本地确定性重实现 (LocalJevReimpl)', risk: '低 — 算法相同但无真实校准数据' },
  { id: 'F2', aspect: 'Provider 标签', officialBehavior: '决策来源标记为 TYPE_SAFE_JEV + provider=system-one', localBehavior: '决策来源标记为 LOCAL_REIMPL', risk: '无 — 非伪装' },
  { id: 'F3', aspect: 'Schema 校验', officialBehavior: '服务端完整 schema 校验', localBehavior: '前端简化校验', risk: '低 — 输出空间封闭' },
  { id: 'F4', aspect: '延迟', officialBehavior: '网络延迟 200-2000ms', localBehavior: '本地计算 <5ms', risk: '无 — 仅影响动画节奏' },
  { id: 'F5', aspect: '人工审批', officialBehavior: '服务端审批 + 审计', localBehavior: '单端审批 + 显式标注「本地审批」', risk: '中 — 无跨端审计追踪' },
  { id: 'F6', aspect: '经验状态', officialBehavior: '服务端 Experience Store', localBehavior: 'localStorage (版本化键)', risk: '低 — 数据不跨设备同步' },
];

// ── Local experience store (ARCHIVE-4: versioned keys) ──

const STORAGE_PREFIX = 'jev-router:exp:';
const VERSION_PREFIX = 'jev-router:expv:';

export interface LocalExperienceEntry {
  intent: string;
  modelId: string;
  confidence: number;
  outcome: 'success' | 'partial' | 'failure';
  expVersion: number;
  timestamp: string;
}

function storageKey(intent: string, modelId: string, expVersion: number): string {
  return `${STORAGE_PREFIX}${intent}::${modelId}::${expVersion}`;
}

export function writeLocalExperience(entry: LocalExperienceEntry): void {
  const key = storageKey(entry.intent, entry.modelId, entry.expVersion);
  try {
    localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // localStorage full — clear oldest entries
    evictOldestEntries(10);
    try { localStorage.setItem(key, JSON.stringify(entry)); } catch { /* give up */ }
  }
}

export function readLocalExperiences(intent: string, modelId: string, expVersion: number): LocalExperienceEntry[] {
  const results: LocalExperienceEntry[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(STORAGE_PREFIX)) {
      try {
        const entry: LocalExperienceEntry = JSON.parse(localStorage.getItem(key) || '');
        if (entry.intent === intent && entry.modelId === modelId && entry.expVersion <= expVersion) {
          results.push(entry);
        }
      } catch { /* skip corrupt */ }
    }
  }
  return results.sort((a, b) => a.expVersion - b.expVersion);
}

export function getLocalExpVersion(): number {
  let max = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(VERSION_PREFIX)) {
      const v = parseInt(key.slice(VERSION_PREFIX.length), 10);
      if (!isNaN(v) && v > max) max = v;
    }
  }
  return max;
}

export function incrementLocalExpVersion(): number {
  const current = getLocalExpVersion();
  const next = current + 1;
  localStorage.setItem(`${VERSION_PREFIX}${next}`, JSON.stringify({ createdAt: new Date().toISOString() }));
  return next;
}

function evictOldestEntries(count: number): void {
  const entries: Array<{ key: string; ts: string }> = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(STORAGE_PREFIX)) {
      try {
        const entry = JSON.parse(localStorage.getItem(key) || '');
        entries.push({ key, ts: entry.timestamp || '' });
      } catch { /* skip */ }
    }
  }
  entries.sort((a, b) => a.ts.localeCompare(b.ts));
  for (let i = 0; i < Math.min(count, entries.length); i++) {
    localStorage.removeItem(entries[i].key);
  }
}

// ── Single-endpoint human review (ARCHIVE-4) ──

export interface LocalReview {
  requestId: string;
  approved: boolean;
  comment: string;
  reviewedAt: string;
  source: '本地审批'; // Always explicitly labeled
}

const REVIEW_PREFIX = 'jev-router:review:';

export function submitLocalReview(requestId: string, approved: boolean, comment: string): LocalReview {
  const review: LocalReview = {
    requestId,
    approved,
    comment,
    reviewedAt: new Date().toISOString(),
    source: '本地审批',
  };
  localStorage.setItem(`${REVIEW_PREFIX}${requestId}`, JSON.stringify(review));
  return review;
}

export function getLocalReview(requestId: string): LocalReview | null {
  const raw = localStorage.getItem(`${REVIEW_PREFIX}${requestId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ── Offline Jev answer generation (mirrors backend LocalJevReimpl) ──

export interface OfflineJevAnswer {
  questionId: string;
  type: 'choice' | 'score' | 'noul';
  answer: string | number;
  confidence: number;
  decisionSource: 'LOCAL_REIMPL';
}

/**
 * Generate offline Jev answers deterministically.
 * Uses the same pure-logic functions from @jev-router/shared as the backend.
 * JEV-8: Results are marked LOCAL_REIMPL, never TYPE_SAFE_JEV.
 */
export async function answerQuestionsOffline(
  features: { primary: string; complexity: number; speedNeed: number; costSens: number; weights: Record<string, number> },
): Promise<OfflineJevAnswer[]> {
  // These mirror the 5 canonical questions from jev-adapter.ts FIVE_QUESTIONS
  const { primary, complexity, speedNeed, costSens } = features;

  // Use shared calibrate() for evidence-strength → confidence mapping (ARCH-2)
  const intentConf = calibrate(0.85);
  const complexityConf = calibrate(complexity / 100);
  const urgencyConf = calibrate(0.72);
  const budgetConf = calibrate(0.70);
  const capabilityConf = calibrate(Math.min(1, complexity / 80));

  return [
    {
      questionId: 'intent',
      type: 'choice',
      answer: primary,
      confidence: intentConf,
      decisionSource: 'LOCAL_REIMPL',
    },
    {
      questionId: 'complexity',
      type: 'score',
      answer: complexity / 100,
      confidence: complexityConf,
      decisionSource: 'LOCAL_REIMPL',
    },
    {
      questionId: 'urgency',
      type: 'noul',
      answer: speedNeed,
      confidence: urgencyConf,
      decisionSource: 'LOCAL_REIMPL',
    },
    {
      questionId: 'budget',
      type: 'noul',
      answer: costSens,
      confidence: budgetConf,
      decisionSource: 'LOCAL_REIMPL',
    },
    {
      questionId: 'capability',
      type: 'score',
      answer: Math.min(1, complexity / 80),
      confidence: capabilityConf,
      decisionSource: 'LOCAL_REIMPL',
    },
  ];
}
