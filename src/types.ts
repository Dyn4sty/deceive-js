/**
 * Which game to automatically launch when Deceive is started.
 */
export enum LaunchGame {
  /** Attempt to start League of Legends */
  LoL = 'lol',
  /** Attempt to start Teamfight Tactics */
  TFT = 'tft',
  /** Attempt to start Legends of Runeterra */
  LoR = 'lor',
  /** Attempt to start VALORANT */
  VALORANT = 'valorant',
  /** Attempt to launch Lion (2XKO) */
  Lion = 'lion',
  /** Attempt to launch the Riot Client */
  RiotClient = 'riot-client',
  /** Display a dialog asking which game to launch */
  Prompt = 'prompt',
  /** Automatically pick which game to launch */
  Auto = 'auto',
}

/**
 * Presence status options
 */
export enum PresenceStatus {
  Online = 'chat',
  Offline = 'offline',
  Mobile = 'mobile',
}

/**
 * Status to use on startup: a fixed status, or 'last' to remember the previous session
 */
export type StartupStatus = PresenceStatus | 'last';

/**
 * Chat server configuration from Riot
 */
export interface ChatServerConfig {
  chatHost: string;
  chatPort: number;
}

/**
 * Application configuration stored on disk
 */
export interface AppConfig {
  defaultGame: LaunchGame;
  /** Status of the last session, used when startupStatus is 'last' */
  defaultStatus: PresenceStatus;
  startupStatus: StartupStatus;
  lastPromptedVersion: string;
  connectToMuc: boolean;
  introductionShown: boolean;
}

/**
 * Product names used by Riot Client
 */
export const PRODUCT_NAMES: Record<LaunchGame, string | null> = {
  [LaunchGame.LoL]: 'league_of_legends',
  [LaunchGame.TFT]: 'teamfighttactics',
  [LaunchGame.LoR]: 'bacon',
  [LaunchGame.VALORANT]: 'valorant',
  [LaunchGame.Lion]: 'lion',
  [LaunchGame.RiotClient]: null,
  [LaunchGame.Prompt]: null,
  [LaunchGame.Auto]: null,
};

/**
 * Human-readable status name
 */
export function statusLabel(status: PresenceStatus): string {
  switch (status) {
    case PresenceStatus.Online:
      return 'online';
    case PresenceStatus.Mobile:
      return 'mobile';
    case PresenceStatus.Offline:
      return 'offline';
  }
}
