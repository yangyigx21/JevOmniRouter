/**
 * @module llm-provider-adapter
 * @implements RESULT-2, LLM-sdd.md 一、模型配置文件（实际执行调用）
 *
 * LLM 模型库 Provider 适配器 —— 调用 `config/models.json` 中配置的 OpenAI 兼容
 * 网关（`http://127.0.0.1:8788/v1`）：
 *
 * - `GET  {baseUrl}/models`               → 模型清单（由 model-info-store 复用）
 * - `POST {baseUrl}/chat/completions`     → Chat Completions（默认，支持 SSE 流式）
 * - `POST {baseUrl}/responses`            → Responses API（`useResponsesApi=true` 时）
 *
 * 契约要点：
 * - **RESULT-2**：流式增量交付，`stream()` 逐块 yield `StreamChunk`，`done=true` 收尾。
 * - **C3**：密钥仅在服务端使用；本模块对外只暴露 `providerName` 等元数据。
 * - **取消**：透传 `AbortSignal`（`providerRequest.signal`）。
 * - **错误分类**：429/5xx → 可重试；401/403/400 → 不可重试。
 * - **不干预决策**：本模块属 GENERATE 层，MUST NOT 改写 Jev 决策。
 */
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  StreamChunk,
  TokenUsage,
  ToolCall,
} from './model-gateway.js';
import { GatewayError } from './model-gateway.js';
import type { LlmLibraryConfig } from './app-config.js';
import { LLM_PROVIDER_NAME } from './model-info-store.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

function classifyHttp(status: number, modelId: string, body: string): GatewayError {
  const snippet = body.slice(0, 300);
  if (status === 401 || status === 403) {
    return new GatewayError('AUTH_ERROR', `provider auth failed (${status}): ${snippet}`, modelId, LLM_PROVIDER_NAME, false);
  }
  if (status === 400 || status === 422) {
    return new GatewayError('VALIDATION_ERROR', `provider rejected request (${status}): ${snippet}`, modelId, LLM_PROVIDER_NAME, false);
  }
  if (status === 404) {
    return new GatewayError('MODEL_NOT_FOUND', `model not found (${status}): ${snippet}`, modelId, LLM_PROVIDER_NAME, false);
  }
  if (status === 429) {
    return new GatewayError('RATE_LIMITED', `provider rate limited (${status}): ${snippet}`, modelId, LLM_PROVIDER_NAME, true);
  }
  if (status >= 500) {
    return new GatewayError('PROVIDER_ERROR', `provider error (${status}): ${snippet}`, modelId, LLM_PROVIDER_NAME, true);
  }
  return new GatewayError('PROVIDER_ERROR', `unexpected provider status ${status}: ${snippet}`, modelId, LLM_PROVIDER_NAME, false);
}

function classifyNetwork(err: unknown, modelId: string): GatewayError {
  if (err instanceof GatewayError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') {
    return new GatewayError('CANCELLED', 'request aborted', modelId, LLM_PROVIDER_NAME, false);
  }
  if (/abort/i.test(msg)) {
    return new GatewayError('CANCELLED', msg, modelId, LLM_PROVIDER_NAME, false);
  }
  if (/timeout|timedout|etimedout/i.test(msg)) {
    return new GatewayError('TIMEOUT', msg, modelId, LLM_PROVIDER_NAME, false);
  }
  return new GatewayError('PROVIDER_ERROR', msg, modelId, LLM_PROVIDER_NAME, true);
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

export interface LlmProviderAdapterOptions {
  config: LlmLibraryConfig;
  /** 注入 fetch（测试用）。 */
  fetchImpl?: typeof fetch;
}

/**
 * `LlmLibraryProviderAdapter` —— OpenAI 兼容网关适配器。
 *
 * 单一 provider 名为 `llm-library`；网关背后的真实模型由
 * `providerRequest.providerModelId` 区分。
 */
export class LlmLibraryProviderAdapter implements ProviderAdapter {
  readonly providerName = LLM_PROVIDER_NAME;
  private readonly config: LlmLibraryConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LlmProviderAdapterOptions) {
    this.config = opts.config;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** 配置了 baseUrl + apiKey 即视为可用。 */
  isAvailable(): boolean {
    return this.config.baseUrl !== '' && this.config.apiKey !== '';
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      const scheme = this.config.authScheme ? `${this.config.authScheme} ` : '';
      headers[this.config.authHeader || 'Authorization'] = `${scheme}${this.config.apiKey}`;
    }
    return headers;
  }

  /** 组合单次请求的超时与外部取消信号。 */
  private makeSignal(external: AbortSignal | undefined, timeoutMs: number): {
    signal: AbortSignal;
    cleanup: () => void;
    onAbort: () => void;
  } {
    const ctrl = new AbortController();
    const onAbort = (): void => ctrl.abort();
    if (external) {
      if (external.aborted) ctrl.abort();
      else external.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    return {
      signal: ctrl.signal,
      onAbort,
      cleanup: () => {
        clearTimeout(timer);
        external?.removeEventListener('abort', onAbort);
      },
    };
  }

  // -------------------------------------------------------------------------
  // 非流式
  // -------------------------------------------------------------------------

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const startedAt = Date.now();
    const url = this.config.useResponsesApi
      ? this.config.responsesApi
      : this.config.chatCompletionsApi;
    const payload = this.config.useResponsesApi
      ? buildResponsesPayload(request, false)
      : buildChatPayload(request, false);

    const { signal, cleanup } = this.makeSignal(request.signal, request.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(payload),
        signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw classifyHttp(res.status, request.providerModelId, text);
      }
      const json = JSON.parse(text) as Record<string, unknown>;
      return {
        modelId: request.providerModelId,
        executionId: request.trace.executionId,
        content: extractContent(json, this.config.useResponsesApi),
        usage: extractUsage(json),
        latencyMs: Date.now() - startedAt,
        providerMetadata: { finishReason: extractFinishReason(json) },
      };
    } catch (err) {
      throw classifyNetwork(err, request.providerModelId);
    } finally {
      cleanup();
    }
  }

  // -------------------------------------------------------------------------
  // 流式（SSE）
  // -------------------------------------------------------------------------

  async *stream(request: ProviderRequest): AsyncGenerator<StreamChunk, void, unknown> {
    const url = this.config.useResponsesApi
      ? this.config.responsesApi
      : this.config.chatCompletionsApi;
    const payload = this.config.useResponsesApi
      ? buildResponsesPayload(request, true)
      : buildChatPayload(request, true);

    const { signal, cleanup } = this.makeSignal(request.signal, request.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { ...this.authHeaders(), Accept: 'text/event-stream' },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (err) {
      cleanup();
      throw classifyNetwork(err, request.providerModelId);
    }

    if (!res.ok) {
      const text = await safeText(res);
      cleanup();
      throw classifyHttp(res.status, request.providerModelId, text);
    }
    if (!res.body) {
      cleanup();
      throw new GatewayError(
        'PROVIDER_ERROR',
        'provider returned no readable body for streaming request',
        request.providerModelId,
        this.providerName,
        false,
      );
    }

    const modelId = request.providerModelId;
    const executionId = request.trace.executionId;
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let produced = false;
    let finishReason = 'stop';
    // tool_calls 增量按 index 聚合
    const toolCallAcc = new Map<number, ToolCall>();

    try {
      for await (const event of iterateSse(res.body, signal)) {
        if (event === '[DONE]') break;
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(event) as Record<string, unknown>;
        } catch {
          continue; // 忽略非 JSON 心跳/注释行
        }

        // 聚合 tool_calls 增量
        const tcDelta = extractToolCallsDelta(json);
        if (tcDelta) {
          for (const t of tcDelta) {
            const existing = toolCallAcc.get(t.index);
            if (existing) {
              if (t.id) existing.id = t.id;
              if (t.name) existing.function.name = t.name;
              if (t.arguments) existing.function.arguments += t.arguments;
            } else {
              toolCallAcc.set(t.index, {
                id: t.id ?? '',
                type: 'function',
                function: { name: t.name ?? '', arguments: t.arguments ?? '' },
              });
            }
          }
        }

        const delta = extractDelta(json, this.config.useResponsesApi);
        const u = extractUsage(json);
        if (u.totalTokens > 0) usage = u;

        // 更新 finish_reason（可能为 'tool_calls'）
        const fr = extractFinishReason(json);
        if (fr && fr !== 'stop') finishReason = fr;

        if (delta) {
          produced = true;
          yield { modelId, executionId, delta, done: false, usage };
        }
      }

      // 流结束：若 finishReason='tool_calls' 且有聚合结果，在 done chunk 上返回
      const toolCalls = finishReason === 'tool_calls' && toolCallAcc.size > 0
        ? [...toolCallAcc.values()].map((tc) => ({
            ...tc,
            function: { ...tc.function },
          }))
        : undefined;

      yield {
        modelId,
        executionId,
        delta: '',
        done: true,
        usage,
        metadata: { finishReason },
        tool_calls: toolCalls,
      };
    } catch (err) {
      if (!produced) throw classifyNetwork(err, modelId);
      // 已经产出了内容：中途断流按「完成」处理，缺失部分由上层标注。
      yield { modelId, executionId, delta: '', done: true, usage, metadata: { finishReason: 'length' } };
    } finally {
      cleanup();
    }
  }
}

// ---------------------------------------------------------------------------
// 载荷构造
// ---------------------------------------------------------------------------

/** Chat Completions 请求体。 */
function buildChatPayload(request: ProviderRequest, stream: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: request.providerModelId,
    // 保留 tool_calls / tool_call_id 字段（function calling 循环回传时需要）
    messages: request.messages.map((m) => {
      const msg: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      return msg;
    }),
    stream,
  };
  if (request.temperature !== undefined) payload.temperature = request.temperature;
  if (request.maxTokens !== undefined) payload.max_tokens = request.maxTokens;
  // 注入工具定义与选择策略
  if (request.tools && request.tools.length > 0) {
    payload.tools = request.tools;
    if (request.toolChoice) payload.tool_choice = request.toolChoice;
  }
  if (stream) payload.stream_options = { include_usage: true };
  return payload;
}

/** Responses API 请求体。 */
function buildResponsesPayload(request: ProviderRequest, stream: boolean): Record<string, unknown> {
  const system = request.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const user = request.messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n\n');
  const payload: Record<string, unknown> = {
    model: request.providerModelId,
    input: user,
    stream,
  };
  if (system) payload.instructions = system;
  if (request.temperature !== undefined) payload.temperature = request.temperature;
  if (request.maxTokens !== undefined) payload.max_output_tokens = request.maxTokens;
  return payload;
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

/** Chat Completions: `choices[0].message.content`。 */
function extractContent(json: Record<string, unknown>, isResponses: boolean): string {
  if (isResponses) {
    if (typeof json.output_text === 'string') return json.output_text;
    return extractResponsesOutputText(json);
  }
  const choices = json.choices as { message?: { content?: unknown }; text?: unknown }[] | undefined;
  const content = choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  // 部分网关返回纯文本补全形状
  if (typeof choices?.[0]?.text === 'string') return choices[0].text as string;
  return '';
}

/** Responses API: `output[].content[].text`。 */
function extractResponsesOutputText(json: Record<string, unknown>): string {
  const output = json.output as { content?: { text?: unknown }[] }[] | undefined;
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const item of output) {
    for (const c of item.content ?? []) {
      if (typeof c.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('');
}

/**
 * 从 SSE 增量块提取文本 delta。
 *
 * 兼容两类 OpenAI 兼容网关：
 * - 直接续写 `delta.content`
 * - 先输出 `delta.reasoning_content`（推理/思考），再输出 `delta.content`
 *
 * 后一类（reasoning 模型）在 `content` 之前只推 `reasoning_content`；若严格
 * 只取 `content`，整个流会读不到任何正文（表现为「执行成功但结果为空」）。
 * 因此在 `content` 为空时回落 `reasoning_content`，保证流式过程与最终结果
 * 都可见。
 */
function extractDelta(json: Record<string, unknown>, isResponses: boolean): string {
  if (isResponses) {
    return typeof json.delta === 'string' ? json.delta : '';
  }
  const choices = json.choices as
    | { delta?: { content?: unknown; reasoning_content?: unknown }; text?: unknown }[]
    | undefined;
  const delta = choices?.[0]?.delta;
  if (typeof delta?.content === 'string' && delta.content !== '') return delta.content;
  if (typeof choices?.[0]?.text === 'string' && choices[0].text !== '') {
    return choices[0].text as string;
  }
  if (typeof delta?.reasoning_content === 'string') return delta.reasoning_content;
  return '';
}

/**
 * 从 SSE 增量块提取 tool_calls 增量。
 *
 * OpenAI 流式格式：
 * ```json
 * {"choices":[{"delta":{"tool_calls":[
 *   {"index":0,"id":"call_abc","function":{"name":"get_weather","arguments":""}},
 *   {"index":0,"function":{"arguments":"{\"ci"}}
 * ]}}]}
 * ```
 *
 * 首个增量带 id 和 name，后续只带 arguments 片段。按 index 聚合。
 *
 * @returns 增量数组（每个元素是部分 ToolCall + index），或 null
 */
function extractToolCallsDelta(
  json: Record<string, unknown>,
): Array<{ index: number; id?: string; name?: string; arguments?: string }> | null {
  const choices = json.choices as
    | {
        delta?: {
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }[]
    | undefined;
  const tc = choices?.[0]?.delta?.tool_calls;
  if (!Array.isArray(tc) || tc.length === 0) return null;
  return tc.map((t) => ({
    index: typeof t.index === 'number' ? t.index : 0,
    id: t.id,
    name: t.function?.name,
    arguments: t.function?.arguments,
  }));
}

/** 提取 token 用量（两种 API 形状都覆盖）。 */
function extractUsage(json: Record<string, unknown>): TokenUsage {
  const u = (json.usage ?? {}) as Record<string, unknown>;
  const prompt = pickNum(u.prompt_tokens, u.input_tokens);
  const completion = pickNum(u.completion_tokens, u.output_tokens);
  const total = pickNum(u.total_tokens, prompt + completion);
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

function extractFinishReason(json: Record<string, unknown>): string {
  const choices = json.choices as { finish_reason?: unknown }[] | undefined;
  if (typeof choices?.[0]?.finish_reason === 'string') return choices[0].finish_reason as string;
  if (typeof json.status === 'string') return json.status;
  return 'stop';
}

function pickNum(...vals: unknown[]): number {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// SSE 解析
// ---------------------------------------------------------------------------

/**
 * 逐条产出 SSE `data:` 字段内容。
 *
 * 兼容三种帧格式：
 * - `data: {...}\n\n`（OpenAI 风格）
 * - `data: {...}\n` 后紧跟 `event: ...`（部分网关）
 * - 裸 JSON 行（部分代理会剥掉 `data:` 前缀）
 */
export async function* iterateSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 帧分隔：\n\n
      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = extractFrameData(frame);
        if (data !== null) yield data;
        sep = buffer.indexOf('\n\n');
      }
    }
    const tail = extractFrameData(buffer);
    if (tail !== null) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/** 从一帧 SSE 文本中取出 data 内容。 */
function extractFrameData(frame: string): string | null {
  const lines = frame.split(/\r?\n/);
  const dataLines: string[] = [];
  let sawDataField = false;
  for (const line of lines) {
    if (line.startsWith(':')) continue; // 注释/心跳
    if (line.startsWith('data:')) {
      sawDataField = true;
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length > 0) {
    return dataLines.join('\n');
  }
  // 裸 JSON 帧
  const joined = lines.join('').trim();
  if (!sawDataField && (joined.startsWith('{') || joined.startsWith('['))) {
    return joined;
  }
  return null;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
