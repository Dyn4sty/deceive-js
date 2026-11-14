/**
 * Configuration management using conf
 */

import Conf from 'conf';
import { LaunchGame, PresenceStatus, AppConfig, StartupStatus } from '../types.js';

const schema = {
  defaultGame: {
    type: 'string' as const,
    default: LaunchGame.Prompt,
  },
  defaultStatus: {
    type: 'string' as const,
    default: PresenceStatus.Offline,
  },
  startupStatus: {
    type: 'string' as const,
    default: 'last',
  },
  lastPromptedVersion: {
    type: 'string' as const,
    default: '',
  },
  connectToMuc: {
    type: 'boolean' as const,
    default: true,
  },
  introductionShown: {
    type: 'boolean' as const,
    default: false,
  },
};

export const config = new Conf<AppConfig>({
  projectName: 'league-deceiver',
  schema,
});

/**
 * Get the data directory path
 */
export function getDataDir(): string {
  return config.path.replace(/config\.json$/, '');
}

function isPresenceStatus(value: unknown): value is PresenceStatus {
  return Object.values(PresenceStatus).includes(value as PresenceStatus);
}

/**
 * Get the configured startup status option ('last' remembers the previous session)
 */
export function getStartupStatusOption(): StartupStatus {
  const value = config.get('startupStatus');
  return value === 'last' || isPresenceStatus(value) ? value : 'last';
}

export function setStartupStatusOption(value: StartupStatus): void {
  config.set('startupStatus', value);
}

/**
 * Resolve the status to start with, based on the startup status option
 */
export function resolveStartupStatus(): PresenceStatus {
  const option = getStartupStatusOption();
  if (option !== 'last') return option;

  // defaultStatus holds the status of the last session
  const last = config.get('defaultStatus');
  return isPresenceStatus(last) ? last : PresenceStatus.Offline;
}

export function saveLastStatus(status: PresenceStatus): void {
  config.set('defaultStatus', status);
}
