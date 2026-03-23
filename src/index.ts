#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerGameTools } from './tools/games.js';
import { registerLibraryTools } from './tools/library.js';
import { registerStatusTools } from './tools/status.js';
import { registerProtonTools } from './tools/proton.js';
import { registerDiagnosticsTools } from './tools/diagnostics.js';
import { registerGameControlTools } from './tools/game-control.js';
import { registerGameConfigTools } from './tools/game-config.js';
import { registerShortcutTools } from './tools/shortcuts.js';
import { registerStorageTools } from './tools/storage.js';
import { registerPlayerTools } from './tools/player.js';
import { registerWorkshopTools } from './tools/workshop.js';
import { registerDealsTools } from './tools/deals.js';
import { registerInsightsTools } from './tools/insights.js';
import { registerGameInfoTools } from './tools/game-info.js';

const server = new McpServer({
  name: 'steam-mcp',
  version: '1.0.0',
});

// ---------------------------------------------------------------------------
// Category-based tool filtering via STEAM_TOOLS env var.
// Set STEAM_TOOLS=core,compat,api to only register those groups.
// When unset, all categories are registered.
// ---------------------------------------------------------------------------

const TOOL_CATEGORIES: Record<string, Array<(s: McpServer) => void>> = {
  core: [registerGameTools, registerLibraryTools, registerStatusTools],
  compat: [registerProtonTools, registerDiagnosticsTools],
  manage: [registerGameControlTools, registerGameConfigTools, registerShortcutTools],
  storage: [registerStorageTools],
  api: [registerPlayerTools, registerWorkshopTools],
  market: [registerDealsTools],
  insights: [registerInsightsTools],
  content: [registerGameInfoTools],
};

const enabledCategories = process.env.STEAM_TOOLS
  ? process.env.STEAM_TOOLS.split(',').map(s => s.trim().toLowerCase())
  : Object.keys(TOOL_CATEGORIES); // all enabled by default

for (const category of enabledCategories) {
  const registrations = TOOL_CATEGORIES[category];
  if (registrations) {
    for (const register of registrations) {
      register(server);
    }
  }
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Steam MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
