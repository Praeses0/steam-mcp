export interface AppManifest {
  appid: number;
  name: string;
  installdir: string;
  sizeOnDisk: number;
  buildid: string;
  lastUpdated: number;
  lastPlayed: number;
  stateFlags: number;
  libraryPath: string;
}

export interface LibraryFolder {
  path: string;
  label: string;
  totalSize: number; // from VDF
  freeSpace: number; // from statfs
  appids: number[];
  mounted: boolean;
}

export interface UserConfig {
  steamId64: string;
  steamId32: number;
  accountName: string;
  personaName: string;
}

export interface ProtonInfo {
  appid: number;
  toolName: string; // e.g. "GE-Proton10-33"
  prefixPath: string; // compatdata path
  prefixSize: number;
}

export interface WorkshopItem {
  publishedFileId: string;
  appid: number;
  size: number;
  timeUpdated: number;
}

export interface ShortcutEntry {
  appid: number;
  appName: string;
  exe: string;
  startDir: string;
  launchOptions: string;
  lastPlayTime: number;
  tags: string[];
}

export interface CloudSave {
  appid: number;
  path: string;
  size: number;
  fileCount: number;
}
