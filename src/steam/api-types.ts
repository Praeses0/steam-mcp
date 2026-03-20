// ---------------------------------------------------------------------------
// Shared Steam Web API response types used across multiple tool files
// ---------------------------------------------------------------------------

export interface OwnedGame {
  appid: number;
  name: string;
  playtime_forever: number;
  playtime_2weeks?: number;
  img_icon_url: string;
  has_community_visible_stats?: boolean;
}

export interface OwnedGamesResponse {
  response: {
    game_count: number;
    games: OwnedGame[];
  };
}

export interface PlayerSummary {
  steamid: string;
  personaname: string;
  profileurl: string;
  avatar: string;
  avatarfull: string;
  personastate: number;
  gameextrainfo?: string;
  gameid?: string;
  loccountrycode?: string;
  timecreated: number;
  lastlogoff: number;
}

export interface PlayerSummariesResponse {
  response: { players: PlayerSummary[] };
}

export const PERSONA_STATES: Record<number, string> = {
  0: 'Offline',
  1: 'Online',
  2: 'Busy',
  3: 'Away',
  4: 'Snooze',
  5: 'Looking to trade',
  6: 'Looking to play',
};
