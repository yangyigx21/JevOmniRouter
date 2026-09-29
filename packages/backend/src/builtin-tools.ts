/**
 * @module builtin-tools
 *
 * 内置工具定义与执行器 —— 为 LLM 提供 function calling 能力。
 *
 * 当前内置两个工具：
 * - `get_weather`：调用 wttr.in（免费、无需 key，支持中文城市名）获取实时天气
 * - `web_search`：调用 DuckDuckGo Instant Answer API 获取摘要式搜索结果
 *
 * 工具定义遵循 OpenAI tools 参数格式，由 `buildChatPayload` 注入到 LLM 请求；
 * 工具执行结果以 `role: 'tool'` 消息回传给 LLM，形成 tool_call 循环。
 */
import type { ToolCall, ToolDefinition } from './model-gateway.js';

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

export const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '获取指定城市的实时天气信息（温度、天气描述、湿度、风速）。适用于查询天气类问题。',
      parameters: {
        type: 'object',
        properties: {
          city: {
            type: 'string',
            description: '城市名称（支持中文或英文，如：南宁、Beijing）',
          },
        },
        required: ['city'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '通用网络搜索，返回摘要式结果。适用于需要实时信息但非天气类的问题。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索关键词',
          },
        },
        required: ['query'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// 工具执行器
// ---------------------------------------------------------------------------

/**
 * 执行工具调用。
 *
 * @param call LLM 返回的 tool_call
 * @returns 工具执行结果的文本（作为 tool role 消息的 content）
 */
export async function executeTool(call: ToolCall): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    return JSON.stringify({ error: '参数解析失败', raw: call.function.arguments });
  }

  switch (call.function.name) {
    case 'get_weather':
      return await getWeather(typeof args.city === 'string' ? args.city : '');
    case 'web_search':
      return await webSearch(typeof args.query === 'string' ? args.query : '');
    default:
      throw new Error(`未知工具: ${call.function.name}`);
  }
}

// ---------------------------------------------------------------------------
// get_weather —— wttr.in
// ---------------------------------------------------------------------------

async function getWeather(city: string): Promise<string> {
  if (!city) return JSON.stringify({ error: '缺少 city 参数' });
  const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`;
  const res = await fetchWithTimeout(url, 15000);
  if (!res.ok) {
    return JSON.stringify({ error: `wttr.in 返回 HTTP ${res.status}`, city });
  }
  const json = (await res.json()) as {
    current_condition?: Array<{
      temp_C?: string;
      lang_zh?: Array<{ value?: string }> | undefined;
      weatherDesc?: Array<{ value?: string }>;
      humidity?: string;
      windspeedKmph?: string;
      winddir16Point?: string;
    }> | undefined;
    nearest_area?: Array<{ areaName?: { value?: string }; region?: { value?: string } }> | undefined;
  };

  const cur = json.current_condition?.[0];
  if (!cur) return JSON.stringify({ error: 'wttr.in 未返回当前天气数据', city });

  const desc = cur.lang_zh?.[0]?.value ?? cur.weatherDesc?.[0]?.value ?? '';
  const area = json.nearest_area?.[0]?.areaName?.value ?? city;

  return JSON.stringify({
    city: area,
    temperature: cur.temp_C ? `${cur.temp_C}°C` : undefined,
    description: desc,
    humidity: cur.humidity ? `${cur.humidity}%` : undefined,
    windSpeed: cur.windspeedKmph ? `${cur.windspeedKmph} km/h` : undefined,
    windDirection: cur.winddir16Point,
  });
}

// ---------------------------------------------------------------------------
// web_search —— DuckDuckGo Instant Answer API
// ---------------------------------------------------------------------------

async function webSearch(query: string): Promise<string> {
  if (!query) return JSON.stringify({ error: '缺少 query 参数' });
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`;
  const res = await fetchWithTimeout(url, 15000);
  if (!res.ok) {
    return JSON.stringify({ error: `DuckDuckGo 返回 HTTP ${res.status}`, query });
  }
  const json = (await res.json()) as {
    AbstractText?: string;
    Abstract?: string;
    Heading?: string;
    Answer?: string;
    AnswerType?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string } | { Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
  };

  // 优先用 Answer/AbstractText，其次收集 RelatedTopics 文本
  const abstract = json.AbstractText || json.Abstract || '';
  const answer = json.Answer || '';
  const heading = json.Heading || query;

  const topics: string[] = [];
  for (const rt of json.RelatedTopics ?? []) {
    if ('Text' in rt && rt.Text) {
      topics.push(rt.Text);
    } else if ('Topics' in rt && Array.isArray(rt.Topics)) {
      for (const t of rt.Topics) {
        if (t.Text) topics.push(t.Text);
      }
    }
    if (topics.length >= 5) break;
  }

  return JSON.stringify({
    query: heading,
    answer: answer || undefined,
    abstract: abstract || undefined,
    relatedTopics: topics.length > 0 ? topics : undefined,
  });
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'JevOmniRouter/1.0 (function-calling)' },
    });
  } finally {
    clearTimeout(timer);
  }
}
