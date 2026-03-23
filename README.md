# Steam MCP Server

[![npm version](https://img.shields.io/npm/v/@praeses/steam-mcp)](https://www.npmjs.com/package/@praeses/steam-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A feature-rich [Model Context Protocol](https://modelcontextprotocol.io/) server that gives AI assistants full access to your Steam game library. Works on **Linux, macOS, and Windows**. 14 consolidated tools covering 66 actions — most work from local files with **no API key needed**. Optional Steam Web API key unlocks online data like achievements, friends, and full library access.

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

> **Note:** The `STEAM_API_KEY` is optional. Most tools work without it. Only a few actions (achievements, friends, owned games, wishlist, profile) require it. Get your key at [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey).

### Category filtering

To reduce context window usage further, enable only specific tool categories via the `STEAM_TOOLS` env var:

```json
{
  "env": {
    "STEAM_TOOLS": "core,manage,compat"
  }
}
```

Available categories and their tools:

| Category | Tools | Description |
|----------|-------|-------------|
| `core` | `games`, `library`, `steam_status` | Game browsing, library stats, Steam status |
| `compat` | `proton`, `diagnostics` | Proton/Wine compatibility, log parsing |
| `manage` | `game_control`, `game_config`, `shortcuts` | Install/launch/verify, launch options, non-Steam shortcuts |
| `storage` | `storage` | Disk usage, cleanup, shader cache, cloud saves, backups |
| `api` | `player`, `workshop` | Player profile/achievements/friends, workshop items |
| `market` | `deals` | Sale checks, wishlist, library valuation |
| `insights` | `insights` | Completion stats, timeline, year review, play history, export |
| `content` | `game_info` | Reviews, news, media, HLTB, PCGamingWiki fixes |

When unset, all categories are enabled (14 tools, ~3,200 tokens of context).

### Prerequisites

- Node.js 18+
- Steam installed in the default location:
  - **Linux**: `~/.local/share/Steam/`
  - **macOS**: `~/Library/Application Support/Steam/`
  - **Windows**: `C:\Program Files (x86)\Steam\`

> Proton/Wine tools (compatibility tracking, prefix inspection, crash logs) are Linux-only. All other tools work cross-platform.

## Tools

Each tool uses an `action` parameter to select the operation. 14 tools cover 66 actions total.

### `games` — Game discovery and browsing
| Action | Description |
|--------|-------------|
| `list` | List installed games with filtering, sorting, pagination |
| `get` | Get full details for a game by appid |
| `search` | Smart search with abbreviation matching (e.g. "ck3" → Crusader Kings III) |
| `compare` | Compare two games side-by-side |
| `random` | Pick a random installed game |
| `unplayed` | Find games you own but haven't played |

### `library` — Library folders and stats
| Action | Description |
|--------|-------------|
| `list` | List all Steam library folders with sizes and free space |
| `stats` | Aggregate stats: total games, playtime, disk usage |

### `steam_status` — Steam client status
| Action | Description |
|--------|-------------|
| `status` | Check if Steam is running |
| `queue` | View current download queue |
| `progress` | Check download progress for a game |

### `proton` — Proton/Wine compatibility (Linux)
| Action | Description |
|--------|-------------|
| `list_games` | List all games using Proton/Wine with versions and prefix sizes |
| `info` | Get compatibility details for a specific game |
| `versions` | List installed Proton versions and which games use them |
| `db_rating` | Fetch ProtonDB community rating |
| `recommend` | Get a Proton version recommendation for a game |
| `prefix` | Inspect Wine/Proton prefix (Windows version, file count, size) |
| `crash_logs` | Find and read crash dumps and logs |

### `storage` — Disk management
| Action | Description |
|--------|-------------|
| `disk_report` | Per-game disk usage breakdown (install + compat + shader + workshop) |
| `orphaned` | Find leftover data from uninstalled games |
| `cleanup` | Get cleanup recommendations with space savings |
| `shader_cache` | Shader cache size for a specific game |
| `shader_stats` | Shader cache overview across all games |
| `saves_list` | List local cloud save data per game |
| `saves_stats` | Cloud save aggregate stats |
| `backup` | Back up cloud saves to a directory |

### `game_control` — Game actions
| Action | Description |
|--------|-------------|
| `install` | Install a game via Steam |
| `uninstall` | Uninstall a game |
| `launch` | Launch a game |
| `verify` | Verify game file integrity |
| `move` | Move a game to another library folder |
| `store_page` | Open the Steam store page |

### `game_config` — Configuration and tweaks
| Action | Description |
|--------|-------------|
| `get_launch_opts` | Read current launch options |
| `set_launch_opts` | Set launch options |
| `presets` | List/apply launch option presets (MangoHud, GameMode, Vulkan, etc.) |
| `mangohud` | Show, set, or reset MangoHud configuration |
| `steam_settings` | View Steam client settings |

### `player` — Player data (most actions require API key)
| Action | Description |
|--------|-------------|
| `summary` | Player profile with online status and account info |
| `level` | Steam level, XP, and badges |
| `bans` | VAC and game ban status |
| `friends` | Friends list with online status and current games |
| `achievements` | Per-game achievement unlock status |
| `global_achievements` | Global achievement unlock percentages |
| `schema` | Achievement and stat definitions for a game |
| `owned` | Complete owned games list with playtime |
| `recent` | Recently played games |

### `workshop` — Steam Workshop
| Action | Description |
|--------|-------------|
| `list` | List installed workshop items for a game |
| `stats` | Workshop stats across all games |
| `search` | Search the Steam Workshop |

### `shortcuts` — Non-Steam game shortcuts
| Action | Description |
|--------|-------------|
| `list` | List all non-Steam shortcuts |
| `add` | Add a new shortcut |
| `remove` | Remove a shortcut |
| `import_lutris` | Import games from Lutris |

### `deals` — Pricing and wishlist
| Action | Description |
|--------|-------------|
| `check_sale` | Check if a game is on sale |
| `wishlist_deals` | Find discounted games on your wishlist |
| `wishlist` | View full wishlist with prices and reviews |
| `library_value` | Estimate total library value |

### `insights` — Analytics and history
| Action | Description |
|--------|-------------|
| `completion` | Achievement completion rates across top games |
| `timeline` | Month-by-month gaming activity |
| `year_review` | Annual gaming recap |
| `play_history` | Full playtime history (installed + uninstalled games) |
| `export` | Export library data as JSON or CSV |

### `game_info` — Game content and metadata
| Action | Description |
|--------|-------------|
| `reviews` | User reviews with scores |
| `news` | Latest news articles |
| `media` | Game artwork URLs and local overrides |
| `hltb` | HowLongToBeat completion time estimates |
| `pcgamingwiki` | PCGamingWiki fixes and tweaks |

### `diagnostics` — Log parsing
| Action | Description |
|--------|-------------|
| `compat_log` | Parse Proton/Wine compatibility logs |
| `shader_log` | Parse shader compilation logs |

## Key Highlights

- **Minimal context footprint** — 14 tools, ~3,200 tokens (down from 66 tools / ~8,000 tokens in v1)
- **Cross-platform** — Linux, macOS, and Windows (Proton tools are Linux-only)
- **No API key needed** for most actions — reads directly from Steam's local files
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
├── tools/                   # 14 consolidated MCP tools (one file per tool)
└── util/
    ├── format.ts            # formatBytes, formatPlaytime, formatTimestamp
    ├── cache.ts             # FileCache<T> with mtime invalidation
    └── fs.ts                # Shared filesystem utilities
```

## License

[MIT](LICENSE)
