# Steam MCP Server

[![npm version](https://img.shields.io/npm/v/@praeses/steam-mcp)](https://www.npmjs.com/package/@praeses/steam-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A feature-rich [Model Context Protocol](https://modelcontextprotocol.io/) server that gives AI assistants full access to your Steam game library. Works on **Linux, macOS, and Windows**. 50+ local tools work from local files with **no API key needed**. 12 additional tools use the Steam Web API for online data like achievements, friends, and full library access.

Works with Claude Desktop, Claude Code, or any MCP-compatible client.

## What can it do?

**Ask your AI assistant things like:**

- "What games do I have installed?"
- "Search for ck3" → finds Crusader Kings III via abbreviation matching
- "How much disk space is Steam using?" → full breakdown by game
- "Find orphaned data I can clean up" → identifies leftover compatdata/shadercache
- "What Proton version should I use for this game?"
- "Install Hollow Knight" → looks up the appid and tells Steam to install it
- "Pick a random game for me to play"
- "Show my full play history" → all-time playtime across your entire library
- "Import my Lutris games as Steam shortcuts"
- "Show my achievements for Hades" → unlock status, completion %, global stats
- "Who's online right now?" → friends list with online status and current games
- "What's on my wishlist?"
- "Show me reviews for Elden Ring"
- "How long to beat Hollow Knight?"

## Installation

### npm (recommended)

```bash
npx @praeses/steam-mcp
```

No install needed — just add it to your MCP client config (see below).

### Global install

```bash
npm install -g @praeses/steam-mcp
```

Then use `steam-mcp` as the command instead of `npx @praeses/steam-mcp`.

### Configure with Claude Desktop

Add to your Claude Desktop config:
- **Linux**: `~/.config/Claude/claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "steam": {
      "command": "npx",
      "args": ["@praeses/steam-mcp"],
      "env": {
        "STEAM_API_KEY": "your-key-here"
      }
    }
  }
}
```

### Configure with Claude Code

Add a `.mcp.json` in your project root, or add to `~/.claude.json` for system-wide access:

```json
{
  "mcpServers": {
    "steam": {
      "command": "npx",
      "args": ["@praeses/steam-mcp"],
      "env": {
        "STEAM_API_KEY": "your-key-here"
      }
    }
  }
}
```

> **Note:** The `STEAM_API_KEY` is optional. All local tools work without it. Only the API-powered tools (achievements, friends, owned games, wishlist, profile) require it. Get your key at [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey).

### Category filtering

To reduce context window usage, you can enable only specific tool categories via the `STEAM_TOOLS` env var:

```json
{
  "env": {
    "STEAM_TOOLS": "core,launch,compat,api"
  }
}
```

Available categories: `core`, `storage`, `compat`, `config`, `workshop`, `shortcuts`, `saves`, `launch`, `diagnostics`, `media`, `history`, `api`, `deals`, `insights`, `search`, `export`, `hltb`, `tweaks`

When unset, all categories are enabled (69 tools).

### Prerequisites

- Node.js 18+
- Steam installed in the default location:
  - **Linux**: `~/.local/share/Steam/`
  - **macOS**: `~/Library/Application Support/Steam/`
  - **Windows**: `C:\Program Files (x86)\Steam\`

> Proton/Wine tools (compatibility tracking, prefix inspection, crash logs) are Linux-only. All other tools work cross-platform.

## Features

### 69 Tools

#### Local Tools (no API key needed)

| Category | Tools | Description |
|----------|-------|-------------|
| **Games** | `list_games` `get_game` `search_games` `compare_games` `random_game` `pile_of_shame` | Browse, search (smart abbreviation matching), compare, and discover games |
| **Library** | `list_libraries` `get_library_stats` | Multi-library support with free space, game counts, aggregate stats |
| **Storage** | `disk_usage_report` `find_orphaned_data` `cleanup_recommendations` `move_game` `backup_saves` | Full disk breakdown, orphan detection, cleanup suggestions, save backups |
| **Compatibility** | `list_proton_games` `get_proton_info` `list_proton_versions` `get_proton_db_rating` `recommend_proton_version` `wine_prefix_info` `get_crash_logs` | Proton/Wine tracking, ProtonDB ratings, prefix inspection, crash logs |
| **Config** | `get_launch_options` `set_launch_options` `get_steam_settings` | Read/write launch options, view Steam client settings |
| **Workshop** | `list_workshop_items` `get_workshop_stats` | Workshop content per game and aggregate stats |
| **Shader Cache** | `get_shader_cache` `shader_cache_stats` | Per-game and total shader cache analysis with GPU info |
| **Shortcuts** | `list_shortcuts` `add_shortcut` `remove_shortcut` `import_lutris_games` | Full non-Steam shortcut management + Lutris import |
| **Saves** | `list_cloud_saves` `cloud_save_stats` | Cloud save inspection and stats |
| **Actions** | `install_game` `uninstall_game` `launch_game` `verify_game` `open_store_page` | Control Steam via `steam://` protocol |
| **Status** | `steam_status` `get_download_queue` `download_progress` | Steam running status, download monitoring |
| **Media & News** | `get_game_media` `get_news` | Game artwork URLs, latest news |
| **History** | `get_play_history` | Full playtime history (installed + uninstalled) |
| **Diagnostics** | `parse_compat_log` `parse_shader_log` | Proton and shader log parsing |
| **Store** | `get_game_reviews` | User reviews with scores (no key needed) |
| **Deals** | `check_sale` `wishlist_deals` `library_value` | Sale tracking, wishlist deals, library valuation |
| **Insights** | `completion_stats` `gaming_timeline` `year_in_review` | Achievement rates, monthly timeline, annual recap |
| **Tweaks** | `pcgamingwiki_fixes` `launch_option_presets` `mangohud_config` | PCGamingWiki fixes, launch presets, MangoHud config |
| **Other** | `workshop_search` `export_library` `howlongtobeat` | Workshop search, library export, HLTB estimates |

#### API Tools (requires `STEAM_API_KEY`)

| Category | Tools | Description |
|----------|-------|-------------|
| **Profile** | `get_player_summary` `get_player_level` `get_player_bans` | Online status, level, XP, badges, ban status |
| **Friends** | `get_friend_list` | Full friends list with online status, currently playing |
| **Library** | `get_owned_games` `get_recently_played` | Complete owned games list with playtime, recent activity |
| **Achievements** | `get_player_achievements` `get_global_achievement_stats` `get_game_schema` | Per-game unlock status, global percentages, achievement metadata |
| **Wishlist** | `get_wishlist` | Full wishlist with priority, prices, reviews |

### Key Highlights

- **Cross-platform** — Linux, macOS, and Windows (Proton tools are Linux-only)
- **No API key needed** for 50+ tools — reads directly from Steam's local files
- **Optional API key** unlocks 12 more tools for online data
- **Smart search** — "ck3" finds "Crusader Kings III", "ror2" finds "Risk of Rain 2"
- **Full play history** — playtime for every game you've ever played, not just installed ones
- **Storage analysis** — shows exactly where disk space goes (installs + compatdata + shadercache + workshop)
- **Orphan detection** — finds GBs of leftover data from uninstalled games
- **Multi-library** — supports multiple Steam library folders including external drives
- **Category filtering** — enable only the tool groups you need via `STEAM_TOOLS` env var
- **Custom VDF parsers** — both text and binary formats, no external dependencies

## Development

### Install from source

```bash
git clone https://github.com/Praeses0/steam-mcp.git
cd steam-mcp
npm install
npm run build
```

### Commands

```bash
npm run dev      # Run with tsx (auto-reload)
npm run build    # Compile TypeScript
npm test         # Run tests
```

## Architecture

```
src/
├── index.ts                 # Server entry, category-based tool registration
├── vdf/
│   ├── parser.ts            # Text VDF recursive descent parser + serializer
│   ├── binary-parser.ts     # Binary VDF parser (shortcuts.vdf)
│   ├── binary-writer.ts     # Binary VDF writer (shortcut management)
│   └── types.ts             # VdfValue, VdfObject types
├── steam/
│   ├── paths.ts             # Cross-platform Steam dir resolution, user detection
│   ├── manifests.ts         # App manifest reading with mtime caching
│   ├── library.ts           # Library folder operations + disk info
│   ├── userdata.ts          # localconfig.vdf read/write
│   ├── compat.ts            # Proton/Wine compatibility tracking
│   ├── workshop.ts          # Workshop manifest reading
│   ├── shortcuts.ts         # Binary shortcuts.vdf read/write
│   ├── api.ts               # Steam Web API client
│   ├── api-types.ts         # Shared API response types
│   ├── wishlist.ts          # Wishlist data fetching
│   ├── logs.ts              # Steam log parsing
│   └── types.ts             # Domain types
├── tools/                   # 69 MCP tool handlers (one file per category)
└── util/
    ├── format.ts            # formatBytes, formatPlaytime, formatTimestamp
    ├── cache.ts             # FileCache<T> with mtime invalidation
    └── fs.ts                # Shared filesystem utilities
```

## License

[MIT](LICENSE)
