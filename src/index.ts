import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerGameTools } from './tools/games.js';
import { registerLibraryTools } from './tools/library.js';
import { registerStorageTools } from './tools/storage.js';
import { registerCompatTools } from './tools/compat.js';
import { registerConfigTools } from './tools/config.js';
import { registerWorkshopTools } from './tools/workshop.js';
import { registerCacheTools } from './tools/cache.js';
import { registerShortcutTools } from './tools/shortcuts.js';
import { registerSaveTools } from './tools/saves.js';
import { registerLaunchTools } from './tools/launch.js';
import { registerDiagnosticsTools } from './tools/diagnostics.js';
import { registerMediaTools } from './tools/media.js';
import { registerNewsTools } from './tools/news.js';
import { registerSocialTools } from './tools/social.js';
import { registerStatusTools } from './tools/status.js';
import { registerAchievementTools } from './tools/achievements.js';
import { registerHistoryTools } from './tools/history.js';
import { registerProfileTools } from './tools/profile.js';
import { registerFriendsApiTools } from './tools/friends-api.js';
import { registerOwnedTools } from './tools/owned.js';
import { registerAchievementsApiTools } from './tools/achievements-api.js';
import { registerStoreApiTools } from './tools/store-api.js';
import { registerWishlistTools } from './tools/wishlist.js';
import { registerDealsTools } from './tools/deals.js';
import { registerValuationTools } from './tools/valuation.js';
import { registerInsightsTools } from './tools/insights.js';
import { registerWorkshopSearchTools } from './tools/workshop-search.js';
import { registerExportTools } from './tools/export.js';
import { registerHowLongToBeatTools } from './tools/howlongtobeat.js';
import { registerTweaksTools } from './tools/tweaks.js';

const server = new McpServer({
  name: 'steam-mcp',
  version: '1.0.0',
});

registerGameTools(server);
registerLibraryTools(server);
registerStorageTools(server);
registerCompatTools(server);
registerConfigTools(server);
registerWorkshopTools(server);
registerCacheTools(server);
registerShortcutTools(server);
registerSaveTools(server);
registerLaunchTools(server);
registerDiagnosticsTools(server);
registerMediaTools(server);
registerNewsTools(server);
registerSocialTools(server);
registerStatusTools(server);
registerAchievementTools(server);
registerHistoryTools(server);
registerProfileTools(server);
registerFriendsApiTools(server);
registerOwnedTools(server);
registerAchievementsApiTools(server);
registerStoreApiTools(server);
registerWishlistTools(server);
registerDealsTools(server);
registerValuationTools(server);
registerInsightsTools(server);
registerWorkshopSearchTools(server);
registerExportTools(server);
registerHowLongToBeatTools(server);
registerTweaksTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Steam MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
