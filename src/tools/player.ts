import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { hasApiKey, steamApiRequest } from '../steam/api.js';
import { getUserConfig, getUserDataDir } from '../steam/paths.js';
import { getLocalConfig } from '../steam/userdata.js';
import { formatTimestamp, formatPlaytime } from '../util/format.js';
import { parseVdf } from '../vdf/parser.js';
import { PERSONA_STATES } from '../steam/api-types.js';
import type { PlayerSummary, PlayerSummariesResponse, OwnedGamesResponse } from '../steam/api-types.js';
import type { VdfObject } from '../vdf/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BadgeInfo {
  badgeid: number;
  level: number;
  completion_time: number;
  xp: number;
  scarcity: number;
}

interface BadgesResponse {
  response: {
    badges: BadgeInfo[];
    player_xp: number;
    player_level: number;
    player_xp_needed_current_level: number;
    player_xp_needed_next_level: number;
  };
}

interface LevelResponse {
  response: {
    player_level: number;
  };
}

interface PlayerBan {
  SteamId: string;
  CommunityBanned: boolean;
  VACBanned: boolean;
  NumberOfVACBans: number;
  DaysSinceLastBan: number;
  NumberOfGameBans: number;
  EconomyBan: string;
}

interface PlayerBansResponse {
  players: PlayerBan[];
}

interface Friend {
  steamid: string;
  relationship: string;
  friend_since: number;
}

interface FriendListResponse {
  friendslist: {
    friends: Friend[];
  };
}

interface RecentGame {
  appid: number;
  name: string;
  playtime_2weeks: number;
  playtime_forever: number;
  img_icon_url: string;
}

interface RecentlyPlayedResponse {
  response: {
    total_count: number;
    games: RecentGame[];
  };
}

interface PlayerAchievement {
  apiname: string;
  achieved: number;
  unlocktime: number;
  name?: string;
  description?: string;
}

interface PlayerAchievementsResponse {
  playerstats: {
    steamID: string;
    gameName: string;
    achievements: PlayerAchievement[];
    success: boolean;
  };
}

interface GlobalAchievementEntry {
  name: string;
  percent: number;
}

interface GlobalAchievementResponse {
  achievementpercentages: {
    achievements: GlobalAchievementEntry[];
  };
}

interface SchemaAchievement {
  name: string;
  defaultvalue: number;
  displayName: string;
  hidden: number;
  description: string;
  icon: string;
  icongray: string;
}

interface SchemaStat {
  name: string;
  defaultvalue: number;
  displayName: string;
}

interface SchemaResponse {
  game: {
    gameName: string;
    availableGameStats?: {
      achievements?: SchemaAchievement[];
      stats?: SchemaStat[];
    };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveDefaultSteamId(steamid?: string): string {
  if (steamid) return steamid;
  return getUserConfig().steamId64;
}

/**
 * Fetch player summaries in batches of up to 100 (Steam API limit).
 */
async function batchFetchSummaries(steamids: string[]): Promise<Map<string, PlayerSummary>> {
  const map = new Map<string, PlayerSummary>();
  const batchSize = 100;

  const batches: Promise<PlayerSummariesResponse>[] = [];
  for (let i = 0; i < steamids.length; i += batchSize) {
    const batch = steamids.slice(i, i + batchSize);
    batches.push(
      steamApiRequest<PlayerSummariesResponse>(
        'ISteamUser',
        'GetPlayerSummaries',
        'v2',
        { steamids: batch.join(',') },
      ),
    );
  }

  const results = await Promise.all(batches);
  for (const result of results) {
    const players = result.response?.players ?? [];
    for (const player of players) {
      map.set(player.steamid, player);
    }
  }

  return map;
}

// Sort priority: playing > online > offline
function sortPriority(summary: PlayerSummary | undefined): number {
  if (!summary) return 3;
  if (summary.gameextrainfo) return 0; // Currently playing
  if (summary.personastate >= 1) return 1; // Online (any non-offline state)
  return 2; // Offline
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function handleSummary(params: { steamid?: string }) {
  try {
    const steamid = resolveDefaultSteamId(params.steamid);

    const data = await steamApiRequest<PlayerSummariesResponse>(
      'ISteamUser',
      'GetPlayerSummaries',
      'v2',
      { steamids: steamid },
    );

    const players = data.response?.players;
    if (!players || players.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No player found for Steam ID ${steamid}`,
          },
        ],
        isError: true,
      };
    }

    const player = players[0];

    const accountCreated = player.timecreated
      ? formatTimestamp(player.timecreated)
      : 'Unknown';

    const now = Date.now() / 1000;
    const accountAgeDays = player.timecreated
      ? Math.floor((now - player.timecreated) / 86400)
      : null;
    const accountAgeYears = accountAgeDays !== null
      ? (accountAgeDays / 365.25).toFixed(1)
      : null;

    const output: Record<string, unknown> = {
      steamid: player.steamid,
      personaName: player.personaname,
      profileUrl: player.profileurl,
      avatar: player.avatar,
      avatarFull: player.avatarfull,
      onlineStatus: PERSONA_STATES[player.personastate] ?? `Unknown (${player.personastate})`,
      lastLogoff: player.lastlogoff ? formatTimestamp(player.lastlogoff) : 'Unknown',
      accountCreated,
      accountAge: accountAgeYears !== null ? `${accountAgeYears} years (${accountAgeDays} days)` : 'Unknown',
    };

    if (player.gameextrainfo) {
      output.currentlyPlaying = player.gameextrainfo;
      output.currentGameId = player.gameid ?? null;
    }

    if (player.loccountrycode) {
      output.country = player.loccountrycode;
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: `Error fetching player summary: ${msg}` }],
      isError: true,
    };
  }
}

async function handleLevel(params: { steamid?: string }) {
  try {
    const steamid = resolveDefaultSteamId(params.steamid);

    // Fetch level and badges in parallel
    const [levelData, badgesData] = await Promise.all([
      steamApiRequest<LevelResponse>(
        'IPlayerService',
        'GetSteamLevel',
        'v1',
        { steamid },
      ),
      steamApiRequest<BadgesResponse>(
        'IPlayerService',
        'GetBadges',
        'v1',
        { steamid },
      ),
    ]);

    const level = levelData.response?.player_level ?? 0;
    const badges = badgesData.response?.badges ?? [];
    const playerXp = badgesData.response?.player_xp ?? 0;
    const xpNeededCurrent = badgesData.response?.player_xp_needed_current_level ?? 0;
    const xpNeededNext = badgesData.response?.player_xp_needed_next_level ?? 0;

    const totalBadgeXp = badges.reduce((sum, b) => sum + (b.xp || 0), 0);
    const xpToNextLevel = xpNeededNext - playerXp;

    const output = {
      steamid,
      level,
      currentXp: playerXp,
      xpNeededForCurrentLevel: xpNeededCurrent,
      xpNeededForNextLevel: xpNeededNext,
      xpToNextLevel: xpToNextLevel > 0 ? xpToNextLevel : 0,
      xpProgress: xpNeededNext > xpNeededCurrent
        ? `${(((playerXp - xpNeededCurrent) / (xpNeededNext - xpNeededCurrent)) * 100).toFixed(1)}%`
        : '100%',
      badgeCount: badges.length,
      totalBadgeXp,
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: `Error fetching player level: ${msg}` }],
      isError: true,
    };
  }
}

async function handleBans(params: { steamid?: string }) {
  try {
    const steamid = resolveDefaultSteamId(params.steamid);

    const data = await steamApiRequest<PlayerBansResponse>(
      'ISteamUser',
      'GetPlayerBans',
      'v1',
      { steamids: steamid },
    );

    const players = data.players;
    if (!players || players.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No ban data found for Steam ID ${steamid}`,
          },
        ],
        isError: true,
      };
    }

    const ban = players[0];

    const output = {
      steamid: ban.SteamId,
      communityBanned: ban.CommunityBanned,
      vacBanned: ban.VACBanned,
      numberOfVacBans: ban.NumberOfVACBans,
      daysSinceLastBan: ban.DaysSinceLastBan,
      numberOfGameBans: ban.NumberOfGameBans,
      economyBan: ban.EconomyBan,
      summary: ban.VACBanned || ban.CommunityBanned || ban.NumberOfGameBans > 0
        ? 'This account has bans on record.'
        : 'This account is in good standing.',
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: `Error fetching player bans: ${msg}` }],
      isError: true,
    };
  }
}

async function handleFriends(params: { steamid?: string }) {
  try {
    // ---- API path (when key is available) ----
    if (hasApiKey()) {
      const steamid = resolveDefaultSteamId(params.steamid);

      const friendData = await steamApiRequest<FriendListResponse>(
        'ISteamUser',
        'GetFriendList',
        'v1',
        { steamid, relationship: 'friend' },
      );

      const friends = friendData.friendslist?.friends;
      if (!friends || friends.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No friends found for Steam ID ${steamid} (the profile may be private).`,
            },
          ],
        };
      }

      // Batch-fetch summaries for all friends
      const friendIds = friends.map((f) => f.steamid);
      const summaries = await batchFetchSummaries(friendIds);

      // Build enriched friend list
      const enriched = friends.map((f) => {
        const summary = summaries.get(f.steamid);

        const entry: Record<string, unknown> = {
          steamid: f.steamid,
          name: summary?.personaname ?? `Unknown (${f.steamid})`,
          onlineStatus: summary
            ? (PERSONA_STATES[summary.personastate] ?? `Unknown (${summary.personastate})`)
            : 'Unknown',
          friendSince: formatTimestamp(f.friend_since),
        };

        if (summary?.gameextrainfo) {
          entry.currentlyPlaying = summary.gameextrainfo;
          entry.currentGameId = summary.gameid ?? null;
        }

        if (summary?.profileurl) {
          entry.profileUrl = summary.profileurl;
        }

        return { entry, summary };
      });

      // Sort: currently playing first, then online, then offline
      enriched.sort((a, b) => {
        const pa = sortPriority(a.summary);
        const pb = sortPriority(b.summary);
        if (pa !== pb) return pa - pb;
        const nameA = (a.entry.name as string).toLowerCase();
        const nameB = (b.entry.name as string).toLowerCase();
        return nameA.localeCompare(nameB);
      });

      const sortedEntries = enriched.map((e) => e.entry);

      const playingCount = enriched.filter((e) => sortPriority(e.summary) === 0).length;
      const onlineCount = enriched.filter((e) => sortPriority(e.summary) === 1).length;
      const offlineCount = enriched.filter((e) => sortPriority(e.summary) >= 2).length;

      const output = {
        source: 'api' as const,
        steamid,
        totalFriends: friends.length,
        currentlyPlaying: playingCount,
        online: onlineCount,
        offline: offlineCount,
        friends: sortedEntries,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
      };
    }

    // ---- Local fallback (no API key) ----
    const config = getLocalConfig();

    const root = config['UserLocalConfigStore'] ?? config['userlocalconfigstore'];
    if (!root || typeof root === 'string') {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Could not find UserLocalConfigStore in localconfig.vdf',
          },
        ],
        isError: true,
      };
    }

    const rootObj = root as VdfObject;
    const friends = rootObj['friends'] ?? rootObj['Friends'];

    if (!friends || typeof friends === 'string') {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No friends section found in localconfig.vdf. Friends data may not be cached locally.',
          },
        ],
      };
    }

    const friendsObj = friends as VdfObject;
    const friendList: Array<{ steamId: string; name: string }> = [];

    for (const [key, value] of Object.entries(friendsObj)) {
      if (!/^\d+$/.test(key)) continue;

      if (typeof value === 'object') {
        const friendObj = value as VdfObject;
        const name = (friendObj['name'] ?? friendObj['Name'] ?? '') as string;
        friendList.push({
          steamId: key,
          name: name || `Unknown (${key})`,
        });
      }
    }

    const output = {
      source: 'local' as const,
      count: friendList.length,
      note: 'This is locally cached data only — online/offline status is not available without a Steam API key. Set the STEAM_API_KEY environment variable for live status.',
      friends: friendList,
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: `Error fetching friend list: ${msg}` }],
      isError: true,
    };
  }
}

async function handleAchievements(params: { steamid?: string; appid?: number }) {
  const appid = params.appid;
  if (!appid) {
    return {
      content: [{ type: 'text' as const, text: 'appid is required for the achievements action' }],
      isError: true,
    };
  }

  // ---- Try API path first (if key is available) ----
  if (hasApiKey()) {
    try {
      const steamid = params.steamid ?? getUserConfig().steamId64;

      const data = await steamApiRequest<PlayerAchievementsResponse>(
        'ISteamUserStats',
        'GetPlayerAchievements',
        'v1',
        { steamid, appid },
      );

      const { playerstats } = data;

      if (!playerstats.success || !playerstats.achievements) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Game "${playerstats.gameName || appid}" has no achievements or the API returned success=false.`,
            },
          ],
        };
      }

      const achievements = playerstats.achievements;
      const total = achievements.length;
      const unlocked = achievements.filter((a) => a.achieved === 1);
      const locked = achievements.filter((a) => a.achieved === 0);
      const pct = total > 0 ? ((unlocked.length / total) * 100).toFixed(1) : '0.0';

      unlocked.sort((a, b) => b.unlocktime - a.unlocktime);

      locked.sort((a, b) => {
        const nameA = a.name ?? a.apiname;
        const nameB = b.name ?? b.apiname;
        return nameA.localeCompare(nameB);
      });

      const unlockedList = unlocked.map((a) => ({
        name: a.name ?? a.apiname,
        apiname: a.apiname,
        unlockedAt: formatTimestamp(a.unlocktime),
      }));

      const lockedList = locked.map((a) => ({
        name: a.name ?? a.apiname,
        apiname: a.apiname,
        description: a.description ?? null,
      }));

      const output = {
        source: 'api' as const,
        gameName: playerstats.gameName,
        steamID: playerstats.steamID,
        completion: `${unlocked.length}/${total} (${pct}%)`,
        totalAchievements: total,
        unlockedCount: unlocked.length,
        lockedCount: locked.length,
        unlocked: unlockedList,
        locked: lockedList,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
      };
    } catch {
      // API failed — fall through to local fallback
    }
  }

  // ---- Local fallback ----
  try {
    const userDataDir = getUserDataDir();
    const appDir = path.join(userDataDir, String(appid));

    if (!fs.existsSync(appDir)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No userdata directory found for appid ${appid}. The game may not have been played or may not store local data.`,
          },
        ],
      };
    }

    // Check for stats directory
    const statsDir = path.join(appDir, 'stats');
    let statsFiles: string[] = [];
    if (fs.existsSync(statsDir)) {
      try {
        statsFiles = fs.readdirSync(statsDir);
      } catch {
        // unreadable
      }
    }

    // Check for remotecache.vdf
    let remoteCacheData: Record<string, unknown> | null = null;
    const remoteCachePath = path.join(appDir, 'remotecache.vdf');
    if (fs.existsSync(remoteCachePath)) {
      try {
        const content = fs.readFileSync(remoteCachePath, 'utf-8');
        remoteCacheData = parseVdf(content) as Record<string, unknown>;
      } catch {
        // parse error — skip
      }
    }

    // List other files in the app userdata directory
    let appDirFiles: string[] = [];
    try {
      appDirFiles = fs.readdirSync(appDir);
    } catch {
      // unreadable
    }

    const output: Record<string, unknown> = {
      source: 'local',
      appid,
      userdataPath: appDir,
      filesInAppDir: appDirFiles,
    };

    if (statsFiles.length > 0) {
      output.statsDir = statsDir;
      output.statsFiles = statsFiles;
    } else {
      output.statsDir = null;
      output.statsNote = 'No stats directory found for this game.';
    }

    if (remoteCacheData) {
      output.remotecache = remoteCacheData;
    } else {
      output.remotecache = null;
      output.remotecacheNote = 'No remotecache.vdf found for this game.';
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: `Error fetching player achievements: ${msg}` }],
      isError: true,
    };
  }
}

async function handleGlobalAchievements(params: { appid?: number }) {
  const appid = params.appid;
  if (!appid) {
    return {
      content: [{ type: 'text' as const, text: 'appid is required for the global_achievements action' }],
      isError: true,
    };
  }

  try {
    // Fetch global percentages and schema in parallel
    const [globalData, schemaData] = await Promise.all([
      steamApiRequest<GlobalAchievementResponse>(
        'ISteamUserStats',
        'GetGlobalAchievementPercentagesForApp',
        'v2',
        { gameid: appid },
      ),
      steamApiRequest<SchemaResponse>(
        'ISteamUserStats',
        'GetSchemaForGame',
        'v2',
        { appid },
      ),
    ]);

    const percentages = globalData.achievementpercentages?.achievements ?? [];
    const schemaAchievements = schemaData.game?.availableGameStats?.achievements ?? [];
    const gameName = schemaData.game?.gameName ?? `App ${appid}`;

    // Build a lookup map from schema
    const schemaMap = new Map<string, SchemaAchievement>();
    for (const sa of schemaAchievements) {
      schemaMap.set(sa.name, sa);
    }

    // Merge and sort by percent descending
    const merged = percentages
      .map((entry) => {
        const schema = schemaMap.get(entry.name);
        return {
          name: entry.name,
          displayName: schema?.displayName ?? entry.name,
          percent: Math.round(entry.percent * 100) / 100,
          description: schema?.description ?? null,
        };
      })
      .sort((a, b) => b.percent - a.percent);

    const output = {
      gameName,
      appid,
      totalAchievements: merged.length,
      achievements: merged,
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [
        { type: 'text' as const, text: `Error fetching global achievement stats: ${msg}` },
      ],
      isError: true,
    };
  }
}

async function handleSchema(params: { appid?: number }) {
  const appid = params.appid;
  if (!appid) {
    return {
      content: [{ type: 'text' as const, text: 'appid is required for the schema action' }],
      isError: true,
    };
  }

  try {
    const data = await steamApiRequest<SchemaResponse>(
      'ISteamUserStats',
      'GetSchemaForGame',
      'v2',
      { appid },
    );

    const game = data.game;
    const gameName = game?.gameName ?? `App ${appid}`;
    const gameStats = game?.availableGameStats;
    const achievements = gameStats?.achievements ?? [];
    const stats = gameStats?.stats ?? [];

    const achievementList = achievements.map((a) => ({
      name: a.name,
      displayName: a.displayName,
      description: a.description || null,
      hidden: a.hidden === 1,
    }));

    const statList = stats.map((s) => ({
      name: s.name,
      displayName: s.displayName,
    }));

    const output = {
      gameName,
      appid,
      achievementCount: achievementList.length,
      statCount: statList.length,
      achievements: achievementList,
      stats: statList,
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: `Error fetching game schema: ${msg}` }],
      isError: true,
    };
  }
}

async function handleOwned(params: { steamid?: string }) {
  try {
    const steamid = params.steamid ?? getUserConfig().steamId64;

    const data = await steamApiRequest<OwnedGamesResponse>(
      'IPlayerService',
      'GetOwnedGames',
      'v1',
      {
        steamid,
        include_appinfo: 1,
        include_played_free_games: 1,
      },
    );

    let games = data.response.games ?? [];
    const totalOwned = data.response.game_count;

    // Sort by playtime descending by default
    games.sort((a, b) => b.playtime_forever - a.playtime_forever);

    const output = {
      game_count: totalOwned,
      showing: games.length,
      games: games.map((g) => ({
        appid: g.appid,
        name: g.name,
        playtime: formatPlaytime(g.playtime_forever),
        ...(g.playtime_2weeks && g.playtime_2weeks > 0
          ? { playtime_2weeks: formatPlaytime(g.playtime_2weeks) }
          : {}),
        icon_url: `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.img_icon_url}.jpg`,
      })),
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: `Error fetching owned games: ${msg}` }],
      isError: true,
    };
  }
}

async function handleRecent(params: { steamid?: string }) {
  try {
    const steamid = params.steamid ?? getUserConfig().steamId64;

    const data = await steamApiRequest<RecentlyPlayedResponse>(
      'IPlayerService',
      'GetRecentlyPlayedGames',
      'v1',
      {
        steamid,
        count: 10,
      },
    );

    const output = {
      total_count: data.response.total_count,
      games: (data.response.games ?? []).map((g) => ({
        appid: g.appid,
        name: g.name,
        playtime_2weeks: formatPlaytime(g.playtime_2weeks),
        playtime_forever: formatPlaytime(g.playtime_forever),
      })),
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [
        { type: 'text' as const, text: `Error fetching recently played games: ${msg}` },
      ],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPlayerTools(server: McpServer): void {
  server.tool(
    'player',
    'Profile, level, bans, friends, achievements, owned/recent games',
    {
      action: z.enum(['summary', 'level', 'bans', 'friends', 'achievements', 'global_achievements', 'schema', 'owned', 'recent']),
      steamid: z.string().optional(),
      appid: z.number().optional(),
    },
    async (params) => {
      switch (params.action) {
        case 'summary':
          return handleSummary(params);
        case 'level':
          return handleLevel(params);
        case 'bans':
          return handleBans(params);
        case 'friends':
          return handleFriends(params);
        case 'achievements':
          return handleAchievements(params);
        case 'global_achievements':
          return handleGlobalAchievements(params);
        case 'schema':
          return handleSchema(params);
        case 'owned':
          return handleOwned(params);
        case 'recent':
          return handleRecent(params);
      }
    },
  );
}
