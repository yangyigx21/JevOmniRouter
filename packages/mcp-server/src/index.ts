#!/usr/bin/env node
/**
 * JevRouter MCP server (stdio transport).
 *
 * Exposes the JevRouter routing engine to MCP clients as tools — no frontend
 * required. This is a thin protocol adapter: all decision logic, catalog
 * management and model execution stay in the backend process.
 *
 * Tools:
 *   - `jev_route_decide`        run a real route decision, wait for terminal event
 *   - `jev_model_catalog`       read the live model catalog
 *   - `jev_constraints_audit`   run the 8-step hard-constraint pipeline (local, free)
 *   - `jev_score_explain`       explain the scoring chain of a decision
 *   - `jev_experience_stats`    read the experience closed-loop stats
 *   - `jev_history_query`       query execution history
 *
 * Usage:
 *   node dist/index.js           (after `pnpm build`)
 *   pnpm --filter @jev-router/mcp-server dev
 *
 * The backend must be running (default http://127.0.0.1:3000). Override with
 * `JEV_BACKEND_URL`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadMcpConfig } from './config.js';
import { JevBackendClient } from './backend-client.js';
import { registerRouteDecideTool } from './tools/route-decide.js';
import { registerModelCatalogTool } from './tools/model-catalog.js';
import { registerConstraintsAuditTool } from './tools/constraints-audit.js';
import { registerScoreExplainTool } from './tools/score-explain.js';
import { registerExperienceStatsTool } from './tools/experience-stats.js';
import { registerHistoryQueryTool } from './tools/history-query.js';

async function main(): Promise<void> {
  const config = loadMcpConfig();
  const client = new JevBackendClient(config);

  const server = new McpServer({
    name: 'jev-router',
    version: '0.1.0',
  });

  registerRouteDecideTool(server, client);
  registerModelCatalogTool(server, client);
  registerConstraintsAuditTool(server, client);
  registerScoreExplainTool(server, client);
  registerExperienceStatsTool(server, client);
  registerHistoryQueryTool(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is reserved for the JSON-RPC channel; log only to stderr.
  console.error(
    `[jev-mcp] ready · backend=${config.backendUrl} · tools=jev_route_decide,jev_model_catalog,jev_constraints_audit,jev_score_explain,jev_experience_stats,jev_history_query`,
  );
}

main().catch((err: unknown) => {
  console.error(`[jev-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
