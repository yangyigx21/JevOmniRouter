# Plan: 星图高亮逻辑修复 + Function Calling 全链路实现

## Context

用户核查发现两个问题：

1. **前端高亮**：路由选中 deepseek 但 score 阶段 gemini 得分最高最亮，select 阶段后非 winner 星球仍持有 `prob*2` 的 glow，与 winner（glow=2.5）视觉差距不明显。根因在 `computeRunFrontend.ts` L233 条件 `idx >= score && idx < done` 一刀切，未在 select 后把非 winner 压低。

2. **LLM 无法返回实时数据**：LLM 网关 20 个模型元数据全部声明 `supports_tool_calls: true`（反推自 `capabilityTags` 含 `'tool-call'`），但整条链路未落地：`ProviderMessage.role` 仅 `system|user|assistant`（无 `tool` role），`StreamChunk` 无 `tool_calls` 字段，`buildChatPayload` 不传 `tools`，`extractDelta` 丢弃 `delta.tool_calls`，`streamInvoke` 无工具调用循环。LLM 只能凭训练知识回答，无法获取实时天气。

---

## 第 1 项：前端高亮逻辑修复

### 修改文件

`packages/frontend/src/three/computeRunFrontend.ts`（L224-L241 nodeGlow 计算）

### 修改方案

在 nodeGlow 计算中，select 阶段起对非 winner 星球按 `pSelect` 渐进衰减到 0：

```ts
for (let k = 0; k < candidateCount; k++) {
  let glow = 0;
  if (idx >= byId['score'] && idx < byId['done']) {
    const prob = probs[k] ?? 0;
    glow = prob * 2;
    // select 阶段起，非 winner 按进度衰减到 0
    if (idx >= byId['select'] && k !== winnerIdx) {
      glow *= (1 - pSelect);
    }
  }
  if (k === winnerIdx && idx >= byId['select']) {
    glow = 2.5 + (idx >= byId['execute'] ? 0.5 : 0);
  }
  nodeGlow.push(glow);
}
```

**效果**：select 阶段起非 winner 的 glow 由 `prob*2` 渐进降至 0（execute 阶段 `pSelect=1` → glow=0），core/shell/sring/glow sprite 全部回落到基础亮度，winner 维持 2.5+ 高亮，对比鲜明。edgeFlow 同步衰减（因为它依赖 nodeGlow）。

---

## 第 2 项：Function Calling 全链路实现

### 架构

```
route-orchestrator
  ├── buildMessagesWithTools(prompt) → { messages, tools }
  ├── tool_call 循环（最多 3 轮）：
  │     1. gateway.streamInvoke(entry, messages, trace, { ...opts, tools })
  │     2. 流式聚合：result += chunk.delta，tool_calls += chunk.tool_calls
  │     3. 若有 tool_calls → 执行工具 → 追加 assistant+tool 消息 → 继续循环
  │     4. 若无 tool_calls → break（最终答案）
  └── emit MODEL_COMPLETED(result)
```

### 2.1 类型扩展 — `packages/backend/src/model-gateway.ts`

新增类型：

```ts
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}
```

扩展 `ProviderMessage`（L70-L73）：

```ts
export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
```

扩展 `StreamChunk`（L25-L38）：新增 `tool_calls?: ToolCall[]` 字段。

扩展 `ProviderRequest`（L48-L67）：新增 `tools?: ToolDefinition[]` 和 `toolChoice?: 'auto' | 'none'`。

扩展 `streamInvoke` 的 options（L414-L418）：新增 `tools?` 和 `toolChoice?`，透传到 `ProviderRequest`。

### 2.2 LLM 适配器 — `packages/backend/src/llm-provider-adapter.ts`

- `buildChatPayload`（L260-L270）：若 `request.tools` 非空，添加 `payload.tools` 和 `payload.tool_choice`。
- `extractDelta`（L336-L350）：新增 `extractToolCallsDelta(json)` 函数，按 OpenAI 流式格式（`choices[0].delta.tool_calls[].{index,id,function.{name,arguments}}`）解析增量。
- `stream` 方法（L177-L252）：
  - 新增 `toolCallAccumulator: Map<number, ToolCall>` 按 index 聚合 tool_calls 增量
  - 每个 SSE chunk：先聚合 tool_calls 增量，再提取 text delta
  - 流结束时：若 `finishReason === 'tool_calls'`，在 `done=true` 的 chunk 上返回聚合后的 `tool_calls`

### 2.3 工具实现 — 新文件 `packages/backend/src/builtin-tools.ts`

```ts
export const BUILTIN_TOOLS: ToolDefinition[] = [
  // get_weather: 调用 wttr.in/{city}?format=j1&lang=zh
  // web_search: 调用 DuckDuckGo Instant Answer API
];

export async function executeTool(call: ToolCall): Promise<string> {
  const args = JSON.parse(call.function.arguments);
  switch (call.function.name) {
    case 'get_weather': return await getWeather(args.city);
    case 'web_search':  return await webSearch(args.query);
    default: throw new Error(`未知工具: ${call.function.name}`);
  }
}
```

- `getWeather(city)`：`GET https://wttr.in/{encodeURIComponent(city)}?format=j1&lang=zh`，提取当前温度/天气描述/湿度/风速，返回精简 JSON 字符串。wttr.in 免费无需 key，支持中文城市名。
- `webSearch(query)`：`GET https://api.duckduckgo.com/?q={encodeURIComponent(query)}&format=json&no_html=1`，提取 AbstractText/RelatedTopics，返回精简 JSON 字符串。

### 2.4 路由编排器 — `packages/backend/src/route-orchestrator.ts`

**修改 `buildMessages`（L822-L831）**：改为 `buildMessagesWithTools`，返回 `{ messages, tools }`：

```ts
function buildMessagesWithTools(prompt: string): {
  messages: ProviderMessage[];
  tools: ToolDefinition[];
} {
  return {
    messages: [
      { role: 'system', content: '你是 Jev 多模型智能路由中枢选中的执行模型。...' },
      { role: 'user', content: prompt },
    ],
    tools: BUILTIN_TOOLS,
  };
}
```

**修改执行块（L384-L407）**：实现 tool_call 循环：

```ts
const { messages, tools } = buildMessagesWithTools(prompt);
let messageHistory = [...messages];
const MAX_TOOL_ROUNDS = 3;

for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
  const roundTools = round === 0 ? tools : undefined; // 后续轮次不再注入 tools（避免无限循环）
  const stream = this.deps.gateway.streamInvoke(
    entry, messageHistory, { requestId, decisionId, executionId },
    { temperature, maxTokens, signal: abort.signal, tools: roundTools, toolChoice: round === 0 ? 'auto' : undefined },
  );

  let roundResult = '';
  let roundToolCalls: ToolCall[] | undefined;

  for await (const chunk of stream) {
    if (chunk.done) {
      if (chunk.usage) usage = chunk.usage;
      if (chunk.tool_calls && chunk.tool_calls.length > 0) roundToolCalls = chunk.tool_calls;
      continue;
    }
    roundResult += chunk.delta;
    emit('MODEL_STREAMING', { modelId, executionId, delta: chunk.delta, ... }, trace);
  }

  if (!roundToolCalls || roundToolCalls.length === 0) {
    result = roundResult;
    break;
  }

  // 有 tool_calls：执行工具并追加消息
  messageHistory.push({ role: 'assistant', content: roundResult, tool_calls: roundToolCalls });
  for (const tc of roundToolCalls) {
    const toolResult = await executeTool(tc);
    messageHistory.push({ role: 'tool', content: toolResult, tool_call_id: tc.id });
    // 向前端流式推送工具执行进度（可选）
    emit('MODEL_STREAMING', { modelId, executionId, delta: `\n[工具 ${tc.function.name} 已执行]\n`, ... }, trace);
  }
  // 继续下一轮：LLM 基于工具结果生成最终回答
}
```

### 2.5 不改动的部分

- `model-catalog.ts` / `shared/types.ts`：不改 `CatalogEntry` 类型。`capabilityTags` 已含 `'tool-call'`，足够用于决策时的能力筛选。工具调用是后端执行层能力，不需要 catalog 额外字段。
- 前端：不需要改动。tool_call 循环在后端完成，前端通过 SSE `MODEL_STREAMING` 看到的是最终文本流（含可选的工具执行进度提示）。

---

## 验证方案

1. **前端高亮**：浏览器提交 prompt，观察 select 阶段后只有 winner 星球高亮，其他星球暗淡
2. **Function calling**：提交"查询南宁天气"，验证：
   - 后端日志显示 tool_call 循环（round 0 → get_weather → round 1 → 最终文本）
   - 前端结果面板显示实时天气数据（温度、天气描述），而非"我无法获取实时天气"
   - 历史记录 `result` 字段包含实时天气信息
3. **回归**：提交普通 prompt（如"解释闭包"），验证无 tool_call，直接返回文本
