/**
 * Model Gateway — RESULT-2 (§5.1, §2.2).
 *
 * The Model Gateway is responsible for model invocation, streaming,
 * retry, and cancellation. It belongs to the GENERATE layer (LLM)
 * and MUST NOT alter Jev decisions (Constraint: 改写 Jev 决策 is forbidden).
 *
 * Key guarantees:
 *  - RESULT-2: Streaming incremental delivery; progress MUST be visible.
 *  - Provider adapters are pluggable; each provider implements `ProviderAdapter`.
 *  - Retry: transient errors only; MUST NOT retry on auth/validation errors.
 *  - Cancel: in-flight requests MUST be cancellable via `AbortSignal`.
 *  - Timeout: per-request budget derived from catalog `p95LatencyMs`.
 *  - Trace: every invocation links `requestId`/`decisionId`/`executionId` (EVENT-4).
 *  - Same-evidence discipline: retry MUST provide new evidence, not just more
 *    tokens (EXP-1, EXP-10).
 */
import type { CatalogEntry } from './model-catalog.js';

// ---------------------------------------------------------------------------
// Provider Adapter interface
// ---------------------------------------------------------------------------

/** A single chunk of streaming output. */
export interface StreamChunk {
  /** Model that produced this chunk. */
  modelId: string;
  /** Execution ID for trace correlation (EVENT-4). */
  executionId: string;
  /** Incremental text content. */
  delta: string;
  /** Whether this is the final chunk. */
  done: boolean;
  /** Token usage so far (may be partial until done=true). */
  usage?: TokenUsage;
  /** Provider-specific metadata (e.g. finish_reason). */
  metadata?: Record<string, unknown>;
  /** 工具调用请求（finishReason='tool_calls' 时在 done chunk 上返回）。 */
  tool_calls?: ToolCall[];
}

/** 一次工具调用请求（OpenAI tool_calls 格式）。 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** 工具定义（OpenAI tools 参数格式）。 */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Token usage statistics. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Provider-agnostic request (gateway → adapter). */
export interface ProviderRequest {
  /** The model to call (provider-specific model name). */
  providerModelId: string;
  /** Prompt messages. */
  messages: ProviderMessage[];
  /** Temperature (0..1). */
  temperature?: number;
  /** Maximum tokens to generate. */
  maxTokens?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Request timeout in ms. */
  timeoutMs: number;
  /** Trace IDs (EVENT-4). */
  trace: {
    requestId: string;
    decisionId: string;
    executionId: string;
  };
  /** 工具定义列表（注入到 LLM 请求的 tools 参数）。 */
  tools?: ToolDefinition[];
  /** 工具选择策略：auto=模型自行决定，none=不调用工具。 */
  toolChoice?: 'auto' | 'none';
}

/** A single message in the provider request. */
export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant 消息携带的工具调用（tool_call 循环回传时用）。 */
  tool_calls?: ToolCall[];
  /** tool role 消息对应的 tool_call_id。 */
  tool_call_id?: string;
}

/** Provider-agnostic response (non-streaming fallback). */
export interface ProviderResponse {
  modelId: string;
  executionId: string;
  content: string;
  usage: TokenUsage;
  latencyMs: number;
  providerMetadata?: Record<string, unknown>;
}

/**
 * ProviderAdapter — pluggable adapter for each LLM provider.
 *
 * Each provider (openai, anthropic, google, etc.) implements this interface.
 * The Model Gateway delegates actual HTTP calls to the adapter.
 */
export interface ProviderAdapter {
  /** Provider name (matches `CatalogEntry.provider`). */
  providerName: string;
  /** Send a non-streaming request (fallback). */
  complete(request: ProviderRequest): Promise<ProviderResponse>;
  /** Send a streaming request, yielding chunks. */
  stream(request: ProviderRequest): AsyncIterable<StreamChunk>;
  /** Check if the provider is currently available. */
  isAvailable(): boolean;
}

// ---------------------------------------------------------------------------
// Gateway configuration
// ---------------------------------------------------------------------------

/** Retry policy for the Model Gateway. */
export interface RetryPolicy {
  /** Maximum retry attempts for transient errors. */
  maxRetries: number;
  /** Base delay in ms for exponential backoff. */
  baseDelayMs: number;
  /** Maximum delay cap in ms. */
  maxDelayMs: number;
  /** Whether to retry on timeout. */
  retryOnTimeout: boolean;
}

/** Default retry policy (conservative; respects EXP-1 same-evidence discipline). */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 5000,
  retryOnTimeout: false,
};

/** Model Gateway configuration. */
export interface ModelGatewayConfig {
  /** Retry policy. */
  retry: RetryPolicy;
  /** Default timeout in ms when catalog entry has no p95. */
  defaultTimeoutMs: number;
  /** Timeout multiplier over p95 (e.g. 2.0 = 2 × p95). */
  timeoutMultiplier: number;
}

/** Default gateway configuration. */
export const DEFAULT_GATEWAY_CONFIG: ModelGatewayConfig = {
  retry: DEFAULT_RETRY_POLICY,
  defaultTimeoutMs: 30_000,
  timeoutMultiplier: 2.0,
};

// ---------------------------------------------------------------------------
// Gateway errors
// ---------------------------------------------------------------------------

/** Error codes from the Model Gateway. */
export type GatewayErrorCode =
  | 'PROVIDER_UNAVAILABLE'
  | 'MODEL_NOT_FOUND'
  | 'TIMEOUT'
  | 'AUTH_ERROR'
  | 'VALIDATION_ERROR'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'CANCELLED'
  | 'RETRY_EXHAUSTED';

export class GatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    message: string,
    readonly modelId?: string,
    readonly provider?: string,
    readonly retryable: boolean = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'GatewayError';
  }
}

// ---------------------------------------------------------------------------
// Invocation record (for trace and outcome collection)
// ---------------------------------------------------------------------------

/** Record of a model invocation (for audit / outcome). */
export interface InvocationRecord {
  /** Execution ID (EVENT-4). */
  executionId: string;
  /** Request ID. */
  requestId: string;
  /** Decision ID. */
  decisionId: string;
  /** Model that was called. */
  modelId: string;
  /** Provider name. */
  provider: string;
  /** Whether streaming was used. */
  streamed: boolean;
  /** Token usage. */
  usage: TokenUsage;
  /** Wall-clock latency in ms. */
  latencyMs: number;
  /** Number of retry attempts (0 = first attempt succeeded). */
  retryCount: number;
  /** Final status. */
  status: 'success' | 'error' | 'cancelled';
  /** Error code if failed. */
  errorCode?: GatewayErrorCode;
  /** ISO 8601 timestamp. */
  startedAt: string;
  /** ISO 8601 timestamp. */
  completedAt: string;
}

// ---------------------------------------------------------------------------
// Model Gateway
// ---------------------------------------------------------------------------

/**
 * ModelGateway — RESULT-2.
 *
 * Orchestrates model calls through provider adapters.
 * Belongs to the GENERATE layer; MUST NOT alter Jev decisions.
 */
export class ModelGateway {
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly config: ModelGatewayConfig;
  private readonly invocationLog: InvocationRecord[] = [];

  constructor(config?: Partial<ModelGatewayConfig>) {
    this.config = { ...DEFAULT_GATEWAY_CONFIG, ...config };
  }

  /** Register a provider adapter. */
  registerAdapter(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.providerName, adapter);
  }

  /** Get a registered adapter. */
  getAdapter(provider: string): ProviderAdapter | undefined {
    return this.adapters.get(provider);
  }

  /** List registered provider names. */
  listProviders(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Compute timeout for a model call based on catalog entry p95.
   */
  computeTimeout(entry: CatalogEntry): number {
    return Math.round(entry.p95LatencyMs * this.config.timeoutMultiplier);
  }

  /**
   * Invoke a model (non-streaming) with retry logic.
   *
   * Retry is only attempted for transient errors (rate limit, provider error).
   * Auth errors, validation errors, and cancellations are NOT retried.
   */
  async invoke(
    entry: CatalogEntry,
    messages: ProviderMessage[],
    trace: { requestId: string; decisionId: string; executionId: string },
    options?: {
      temperature?: number;
      maxTokens?: number;
      signal?: AbortSignal;
    },
  ): Promise<ProviderResponse> {
    const adapter = this.adapters.get(entry.provider);
    if (!adapter) {
      throw new GatewayError(
        'PROVIDER_UNAVAILABLE',
        `No adapter registered for provider "${entry.provider}"`,
        entry.modelId,
        entry.provider,
      );
    }
    if (!adapter.isAvailable()) {
      throw new GatewayError(
        'PROVIDER_UNAVAILABLE',
        `Provider "${entry.provider}" reports unavailable`,
        entry.modelId,
        entry.provider,
      );
    }

    const timeoutMs = this.computeTimeout(entry);
    const startedAt = new Date().toISOString();
    let lastError: GatewayError | undefined;
    let retryCount = 0;

    for (let attempt = 0; attempt <= this.config.retry.maxRetries; attempt++) {
      // Check cancellation before each attempt.
      if (options?.signal?.aborted) {
        this.recordInvocation({
          executionId: trace.executionId,
          requestId: trace.requestId,
          decisionId: trace.decisionId,
          modelId: entry.modelId,
          provider: entry.provider,
          streamed: false,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          latencyMs: 0,
          retryCount: attempt,
          status: 'cancelled',
          errorCode: 'CANCELLED',
          startedAt,
          completedAt: new Date().toISOString(),
        });
        throw new GatewayError(
          'CANCELLED',
          'Request was cancelled',
          entry.modelId,
          entry.provider,
        );
      }

      try {
        const response = await adapter.complete({
          providerModelId: entry.modelId,
          messages,
          temperature: options?.temperature,
          maxTokens: options?.maxTokens,
          signal: options?.signal,
          timeoutMs,
          trace,
        });

        this.recordInvocation({
          executionId: trace.executionId,
          requestId: trace.requestId,
          decisionId: trace.decisionId,
          modelId: entry.modelId,
          provider: entry.provider,
          streamed: false,
          usage: response.usage,
          latencyMs: response.latencyMs,
          retryCount: attempt,
          status: 'success',
          startedAt,
          completedAt: new Date().toISOString(),
        });

        return response;
      } catch (err) {
        lastError = this.classifyError(err, entry);

        // Non-retryable errors: fail immediately.
        if (!lastError.retryable) {
          this.recordInvocation({
            executionId: trace.executionId,
            requestId: trace.requestId,
            decisionId: trace.decisionId,
            modelId: entry.modelId,
            provider: entry.provider,
            streamed: false,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            latencyMs: 0,
            retryCount: attempt,
            status: 'error',
            errorCode: lastError.code,
            startedAt,
            completedAt: new Date().toISOString(),
          });
          throw lastError;
        }

        retryCount = attempt;

        // Exponential backoff before retry.
        if (attempt < this.config.retry.maxRetries) {
          const delay = Math.min(
            this.config.retry.baseDelayMs * 2 ** attempt,
            this.config.retry.maxDelayMs,
          );
          await this.sleep(delay, options?.signal);
        }
      }
    }

    // All retries exhausted.
    this.recordInvocation({
      executionId: trace.executionId,
      requestId: trace.requestId,
      decisionId: trace.decisionId,
      modelId: entry.modelId,
      provider: entry.provider,
      streamed: false,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      latencyMs: 0,
      retryCount: retryCount,
      status: 'error',
      errorCode: 'RETRY_EXHAUSTED',
      startedAt,
      completedAt: new Date().toISOString(),
    });

    throw new GatewayError(
      'RETRY_EXHAUSTED',
      `All ${this.config.retry.maxRetries + 1} attempts failed; last: ${lastError?.message}`,
      entry.modelId,
      entry.provider,
      false,
    );
  }

  /**
   * Invoke a model with streaming (RESULT-2: incremental delivery).
   *
   * Yields `StreamChunk`s as they arrive. The caller collects
   * the final result by concatenating `delta` until `done=true`.
   *
   * Streaming calls are NOT retried — the caller must handle
   * reconnection if the stream breaks.
   */
  async *streamInvoke(
    entry: CatalogEntry,
    messages: ProviderMessage[],
    trace: { requestId: string; decisionId: string; executionId: string },
    options?: {
      temperature?: number;
      maxTokens?: number;
      signal?: AbortSignal;
      tools?: ToolDefinition[];
      toolChoice?: 'auto' | 'none';
    },
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const adapter = this.adapters.get(entry.provider);
    if (!adapter) {
      throw new GatewayError(
        'PROVIDER_UNAVAILABLE',
        `No adapter registered for provider "${entry.provider}"`,
        entry.modelId,
        entry.provider,
      );
    }
    if (!adapter.isAvailable()) {
      throw new GatewayError(
        'PROVIDER_UNAVAILABLE',
        `Provider "${entry.provider}" reports unavailable`,
        entry.modelId,
        entry.provider,
      );
    }

    const timeoutMs = this.computeTimeout(entry);
    const startedAt = new Date().toISOString();
    let totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let chunkCount = 0;

    try {
      const iterable = adapter.stream({
        providerModelId: entry.modelId,
        messages,
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
        signal: options?.signal,
        timeoutMs,
        trace,
        tools: options?.tools,
        toolChoice: options?.toolChoice,
      });

      for await (const chunk of iterable) {
        chunkCount++;
        if (chunk.usage) {
          totalUsage = chunk.usage;
        }
        yield chunk;

        if (chunk.done) {
          this.recordInvocation({
            executionId: trace.executionId,
            requestId: trace.requestId,
            decisionId: trace.decisionId,
            modelId: entry.modelId,
            provider: entry.provider,
            streamed: true,
            usage: totalUsage,
            latencyMs: Date.now() - new Date(startedAt).getTime(),
            retryCount: 0,
            status: 'success',
            startedAt,
            completedAt: new Date().toISOString(),
          });
          return;
        }
      }
    } catch (err) {
      const gwError = this.classifyError(err, entry);
      this.recordInvocation({
        executionId: trace.executionId,
        requestId: trace.requestId,
        decisionId: trace.decisionId,
        modelId: entry.modelId,
        provider: entry.provider,
        streamed: true,
        usage: totalUsage,
        latencyMs: Date.now() - new Date(startedAt).getTime(),
        retryCount: 0,
        status: options?.signal?.aborted ? 'cancelled' : 'error',
        errorCode: gwError.code,
        startedAt,
        completedAt: new Date().toISOString(),
      });
      throw gwError;
    }
  }

  /**
   * Compute the cost of a model invocation.
   */
  computeCost(entry: CatalogEntry, usage: TokenUsage): number {
    return (
      (usage.promptTokens / 1000) * entry.inputPricePer1k +
      (usage.completionTokens / 1000) * entry.outputPricePer1k
    );
  }

  /** Get invocation records (for audit / outcome). */
  getInvocations(requestId?: string): InvocationRecord[] {
    if (requestId) {
      return this.invocationLog.filter((r) => r.requestId === requestId);
    }
    return [...this.invocationLog];
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Classify an error into a GatewayError with retryability. */
  private classifyError(err: unknown, entry: CatalogEntry): GatewayError {
    if (err instanceof GatewayError) return err;

    const message = err instanceof Error ? err.message : String(err);

    // Rate limiting: retryable.
    if (message.includes('429') || message.toLowerCase().includes('rate')) {
      return new GatewayError('RATE_LIMITED', message, entry.modelId, entry.provider, true);
    }
    // Timeout: only retryable if configured.
    if (message.includes('timeout') || message.includes('TIMEOUT') || message.includes('ETIMEDOUT')) {
      return new GatewayError(
        'TIMEOUT',
        message,
        entry.modelId,
        entry.provider,
        this.config.retry.retryOnTimeout,
      );
    }
    // Auth errors: never retry.
    if (message.includes('401') || message.includes('403') || message.toLowerCase().includes('auth')) {
      return new GatewayError('AUTH_ERROR', message, entry.modelId, entry.provider, false);
    }
    // Validation errors: never retry.
    if (message.includes('400') || message.toLowerCase().includes('validation')) {
      return new GatewayError('VALIDATION_ERROR', message, entry.modelId, entry.provider, false);
    }
    // Abort/cancel: never retry.
    if (message.includes('abort') || message.includes('cancel')) {
      return new GatewayError('CANCELLED', message, entry.modelId, entry.provider, false);
    }
    // Other provider errors: retryable (transient).
    return new GatewayError('PROVIDER_ERROR', message, entry.modelId, entry.provider, true);
  }

  /** Record an invocation for audit. */
  private recordInvocation(record: InvocationRecord): void {
    this.invocationLog.push(record);
  }

  /** Sleep with abort signal support. */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new GatewayError('CANCELLED', 'Retry cancelled during backoff'));
        },
        { once: true },
      );
    });
  }
}
