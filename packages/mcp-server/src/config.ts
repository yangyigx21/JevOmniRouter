/**
 * MCP server runtime configuration.
 *
 * The MCP server is a thin protocol adapter over the JevRouter HTTP API — it
 * intentionally holds no business logic and no secrets. All state lives in the
 * backend process, which reads its own `config/models.json`.
 *
 * Environment:
 *  - `JEV_BACKEND_URL`   backend origin (default `http://127.0.0.1:3000`)
 *  - `JEV_MCP_TIMEOUT_MS` per-route terminal wait budget (default 120000)
 */
export interface McpConfig {
  /** Backend origin, no trailing slash. */
  backendUrl: string;
  /** How long to wait for a route to reach a terminal event. */
  routeTimeoutMs: number;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function loadMcpConfig(): McpConfig {
  return {
    backendUrl: stripTrailingSlash(process.env.JEV_BACKEND_URL ?? 'http://127.0.0.1:3000'),
    routeTimeoutMs: readInt('JEV_MCP_TIMEOUT_MS', 120_000),
  };
}
