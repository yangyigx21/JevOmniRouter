/**
 * Versioned Model Catalog — MODEL-1 / MODEL-2 / MODEL-3 / MODEL-4 (§4.6).
 *
 * MODEL-1: Each model MUST have complete profile fields (modelId, provider,
 *          capability tags, modalities, context window, input/output price,
 *          P95 latency, health status). MVP catalog MUST include ≥ 6 verified
 *          industry-common models covering reasoning, vision/multimodal,
 *          code, creative generation, long-context, low-cost tiers.
 * MODEL-2: Candidate pool SHALL be a catalog subset with ≥ 2 candidates;
 *          empty pool → error (no silent).
 * MODEL-3: Catalog order (MODEL_INDEX) ≠ rank order. Identity lookups MUST
 *          go through catalog order; `priorDelta[]` is stored in catalog
 *          order. This is the project's "most expensive defect" guard.
 * MODEL-4: Catalog is versioned (`catalogVersion`); each model carries
 *          `profileVersion`. When a model's `profileVersion` changes, its
 *          accumulated experience MUST be reset or decayed (links to
 *          EXP-7). Frontend and backend MUST share the same `catalogVersion`.
 */
import type { ModelDescriptor } from '@jev-router/shared';

/** Health status (MODEL-1). */
export type HealthStatus = 'healthy' | 'degraded' | 'down';

/** Extended model descriptor with catalog-side metadata (MODEL-1 / MODEL-4). */
export interface CatalogEntry extends ModelDescriptor {
  /** Provider name (e.g. `openai`, `anthropic`). */
  provider: string;
  /**
   * 模型厂商标识（`deepseek` / `zhipu` / `moonshot` …），由模型名推断。
   * 前端据此把同厂模型聚成一个星球节点。
   */
  vendor: string;
  /** 模型厂商展示名（如 `DeepSeek`、`智谱 GLM`）。 */
  vendorLabel: string;
  /** Capability tags (e.g. `reasoning`, `vision`, `code`, `creative`, `long-context`, `low-cost`). */
  capabilityTags: string[];
  /** P95 latency in ms. */
  p95LatencyMs: number;
  /** Input price per 1K tokens (USD). */
  inputPricePer1k: number;
  /** Output price per 1K tokens (USD). */
  outputPricePer1k: number;
  /** Health status (MODEL-1). */
  health: HealthStatus;
  /** Profile version (MODEL-4). */
  profileVersion: string;
  /** Whether the model is enabled in the catalog (CONSTRAIN-1 step 1). */
  enabled: boolean;
  /** Data region restriction (e.g. `eu`, `us`). */
  dataRegion?: string[];
}

/** Versioned catalog (MODEL-4). */
export interface VersionedCatalog {
  /** Catalog version (MUST be shared between frontend & backend, MODEL-4 scenario "目录同源"). */
  catalogVersion: string;
  /** Entries in stable catalog order (MODEL_INDEX). */
  entries: CatalogEntry[];
}

/** Error codes (MODEL-2, MODEL-3). */
export type CatalogErrorCode =
  | 'EMPTY_POOL'
  | 'MODEL_NOT_FOUND'
  | 'INDEX_MISMATCH'
  | 'CATALOG_VERSION_MISMATCH';

export class CatalogError extends Error {
  constructor(
    readonly code: CatalogErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'CatalogError';
  }
}

/**
 * MVP seed catalog (MODEL-1: ≥ 6 verified industry-common models covering
 * reasoning / vision / code / creative / long-context / low-cost).
 *
 * These are placeholder entries with realistic shape; actual provider
 * wiring (Model Gateway, T-3.9) replaces `provider` field with real adapters.
 */
export const MVP_SEED_CATALOG: VersionedCatalog = {
  catalogVersion: 'mvp-1.0',
  entries: [
    {
      modelId: 'gpt-4o',
      provider: 'openai',
      vendor: 'openai',
      vendorLabel: 'OpenAI',
      capabilityTags: ['reasoning', 'vision', 'creative'],
      capability: 0.92,
      quality: 0.9,
      cost: 0.65,
      latency: 0.55,
      load: 0.3,
      contextWindow: 128_000,
      p95LatencyMs: 2500,
      inputPricePer1k: 0.005,
      outputPricePer1k: 0.015,
      health: 'healthy',
      profileVersion: 'p1',
      enabled: true,
      modalities: ['text', 'image'],
      dataRegion: ['us'],
    },
    {
      modelId: 'claude-3-5-sonnet',
      provider: 'anthropic',
      vendor: 'anthropic',
      vendorLabel: 'Anthropic',
      capabilityTags: ['reasoning', 'code', 'long-context'],
      capability: 0.9,
      quality: 0.88,
      cost: 0.6,
      latency: 0.5,
      load: 0.25,
      contextWindow: 200_000,
      p95LatencyMs: 2200,
      inputPricePer1k: 0.003,
      outputPricePer1k: 0.015,
      health: 'healthy',
      profileVersion: 'p1',
      enabled: true,
      modalities: ['text'],
      dataRegion: ['us'],
    },
    {
      modelId: 'gemini-1-5-pro',
      provider: 'google',
      vendor: 'google',
      vendorLabel: 'Google',
      capabilityTags: ['reasoning', 'vision', 'long-context'],
      capability: 0.88,
      quality: 0.85,
      cost: 0.55,
      latency: 0.6,
      load: 0.35,
      contextWindow: 1_000_000,
      p95LatencyMs: 3000,
      inputPricePer1k: 0.00125,
      outputPricePer1k: 0.005,
      health: 'healthy',
      profileVersion: 'p1',
      enabled: true,
      modalities: ['text', 'image'],
      dataRegion: ['us', 'eu'],
    },
    {
      modelId: 'llama-3-1-70b',
      provider: 'meta',
      vendor: 'meta',
      vendorLabel: 'Meta',
      capabilityTags: ['reasoning', 'low-cost'],
      capability: 0.78,
      quality: 0.75,
      cost: 0.15,
      latency: 0.7,
      load: 0.4,
      contextWindow: 128_000,
      p95LatencyMs: 1500,
      inputPricePer1k: 0.0009,
      outputPricePer1k: 0.0009,
      health: 'healthy',
      profileVersion: 'p1',
      enabled: true,
      modalities: ['text'],
    },
    {
      modelId: 'mistral-large',
      provider: 'mistral',
      vendor: 'mistral',
      vendorLabel: 'Mistral',
      capabilityTags: ['reasoning', 'code'],
      capability: 0.82,
      quality: 0.8,
      cost: 0.4,
      latency: 0.45,
      load: 0.2,
      contextWindow: 32_000,
      p95LatencyMs: 1800,
      inputPricePer1k: 0.002,
      outputPricePer1k: 0.006,
      health: 'healthy',
      profileVersion: 'p1',
      enabled: true,
      modalities: ['text'],
      dataRegion: ['eu'],
    },
    {
      modelId: 'qwen-2-5-coder',
      provider: 'alibaba',
      vendor: 'alibaba',
      vendorLabel: '阿里通义',
      capabilityTags: ['code', 'low-cost'],
      capability: 0.85,
      quality: 0.82,
      cost: 0.1,
      latency: 0.5,
      load: 0.3,
      contextWindow: 128_000,
      p95LatencyMs: 1600,
      inputPricePer1k: 0.0005,
      outputPricePer1k: 0.0015,
      health: 'healthy',
      profileVersion: 'p1',
      enabled: true,
      modalities: ['text'],
      dataRegion: ['us', 'eu'],
    },
  ],
};

/**
 * Validate a catalog entry (MODEL-1 field completeness).
 * @returns violations; empty when valid.
 */
export function validateEntry(entry: Partial<CatalogEntry>): string[] {
  const violations: string[] = [];
  const required: (keyof CatalogEntry)[] = [
    'modelId',
    'provider',
    'vendor',
    'vendorLabel',
    'capabilityTags',
    'capability',
    'quality',
    'cost',
    'latency',
    'load',
    'contextWindow',
    'p95LatencyMs',
    'inputPricePer1k',
    'outputPricePer1k',
    'health',
    'profileVersion',
    'enabled',
  ];
  for (const field of required) {
    if (entry[field] === undefined || entry[field] === null) {
      violations.push(`Missing required field: ${field}`);
    }
  }
  if (Array.isArray(entry.capabilityTags) && entry.capabilityTags.length === 0) {
    violations.push('capabilityTags MUST be non-empty');
  }
  if (typeof entry.modelId === 'string' && entry.modelId.trim() === '') {
    violations.push('modelId MUST be non-empty');
  }
  return violations;
}

/**
 * Validate a versioned catalog (MODEL-1 / MODEL-2 / MODEL-4).
 *  - Every entry MUST pass `validateEntry`.
 *  - Catalog MUST have ≥ 2 enabled entries (MODEL-2 minimum pool).
 *  - `catalogVersion` MUST be non-empty.
 */
export function validateCatalog(catalog: VersionedCatalog): string[] {
  const violations: string[] = [];
  if (!catalog.catalogVersion) {
    violations.push('catalogVersion MUST be non-empty (MODEL-4)');
  }
  for (const entry of catalog.entries) {
    const entryViolations = validateEntry(entry);
    for (const v of entryViolations) {
      violations.push(`Entry ${entry.modelId ?? '<unknown>'}: ${v}`);
    }
  }
  const enabled = catalog.entries.filter((e) => e.enabled);
  if (enabled.length < 2) {
    violations.push(`Catalog MUST have ≥ 2 enabled entries (MODEL-2); got ${enabled.length}`);
  }
  // MVP-1 requirement: ≥ 6 verified entries covering all 6 capability roles.
  if (catalog.entries.length < 6) {
    violations.push(`MVP catalog MUST have ≥ 6 entries (MODEL-1); got ${catalog.entries.length}`);
  }
  const tags = new Set<string>();
  for (const e of catalog.entries) for (const t of e.capabilityTags ?? []) tags.add(t);
  const requiredTags = ['reasoning', 'vision', 'code', 'creative', 'long-context', 'low-cost'];
  for (const t of requiredTags) {
    if (!tags.has(t)) {
      violations.push(`MVP catalog MUST cover capability tag "${t}" (MODEL-1)`);
    }
  }
  return violations;
}

/**
 * Build a candidate pool from the catalog (MODEL-2).
 * @throws CatalogError('EMPTY_POOL') if pool has < 2 candidates.
 */
export function buildCandidatePool(
  catalog: VersionedCatalog,
  filter?: (entry: CatalogEntry) => boolean,
): CatalogEntry[] {
  const pool = catalog.entries.filter((e) => {
    if (!e.enabled) return false;
    if (e.health === 'down') return false;
    if (filter && !filter(e)) return false;
    return true;
  });
  if (pool.length < 2) {
    throw new CatalogError(
      'EMPTY_POOL',
      `Candidate pool MUST have ≥ 2 entries (MODEL-2); got ${pool.length}`,
    );
  }
  return pool;
}

/**
 * Identity lookup via catalog order (MODEL-3).
 * MUST be used everywhere a modelId is derived from a score rank —
 * `rankIndex` MUST NOT be used as identity.
 *
 * @throws CatalogError('INDEX_MISMATCH') if rankIndex is out of bounds.
 */
export function lookupByCatalogIndex(
  catalog: VersionedCatalog,
  catalogIndex: number,
): CatalogEntry {
  if (catalogIndex < 0 || catalogIndex >= catalog.entries.length) {
    throw new CatalogError(
      'INDEX_MISMATCH',
      `catalogIndex ${catalogIndex} out of bounds [0, ${catalog.entries.length}) (MODEL-3)`,
    );
  }
  return catalog.entries[catalogIndex];
}

/**
 * Find a model by modelId (linear scan; identity-stable).
 * @throws CatalogError('MODEL_NOT_FOUND') if absent.
 */
export function lookupByModelId(
  catalog: VersionedCatalog,
  modelId: string,
): { entry: CatalogEntry; catalogIndex: number } {
  for (let i = 0; i < catalog.entries.length; i += 1) {
    if (catalog.entries[i].modelId === modelId) {
      return { entry: catalog.entries[i], catalogIndex: i };
    }
  }
  throw new CatalogError('MODEL_NOT_FOUND', `modelId "${modelId}" not in catalog`);
}

/**
 * Verify catalog version consistency (MODEL-4 scenario "目录同源").
 * @throws CatalogError('CATALOG_VERSION_MISMATCH') if versions differ.
 */
export function assertSameCatalogVersion(
  backend: VersionedCatalog,
  frontend: { catalogVersion: string },
): void {
  if (backend.catalogVersion !== frontend.catalogVersion) {
    throw new CatalogError(
      'CATALOG_VERSION_MISMATCH',
      `Backend catalog version "${backend.catalogVersion}" ≠ frontend "${frontend.catalogVersion}" (MODEL-4)`,
    );
  }
}

/**
 * Record a profile-version change (MODEL-4 scenario "画像变更触发经验失效").
 * Returns the list of modelIds whose experience MUST be reset/decayed.
 */
export function detectProfileChanges(
  prior: VersionedCatalog,
  current: VersionedCatalog,
): { modelId: string; fromVersion: string; toVersion: string }[] {
  const changes: { modelId: string; fromVersion: string; toVersion: string }[] = [];
  const priorMap = new Map(prior.entries.map((e) => [e.modelId, e]));
  for (const curr of current.entries) {
    const prev = priorMap.get(curr.modelId);
    if (prev && prev.profileVersion !== curr.profileVersion) {
      changes.push({
        modelId: curr.modelId,
        fromVersion: prev.profileVersion,
        toVersion: curr.profileVersion,
      });
    }
  }
  return changes;
}
