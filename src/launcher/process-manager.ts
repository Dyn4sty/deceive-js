/**
 * Process Manager - Detect and manage game processes
 */

import { execFile, spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { basename, join } from 'path';
import { promisify } from 'util';
import { isWindows, isMacOS } from '../utils/platform.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

const PROCESS_NAMES = ['RiotClientServices', 'LeagueClient', 'LoR', 'VALORANT-Win64-Shipping'];

/**
 * Executable name without directory or .exe, lowercased, for exact comparison
 */
export function processBaseName(processPath: string): string {
  return basename(processPath.trim().replace(/\\/g, '/'))
    .replace(/\.exe$/i, '')
    .toLowerCase();
}

async function isRunning(names: string[]): Promise<boolean> {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return (await getRunningProcesses()).some((p) => wanted.has(processBaseName(p)));
}

/**
 * Check if any Riot client processes are running
 */
export function isClientRunning(): Promise<boolean> {
  return isRunning(PROCESS_NAMES);
}

/**
 * Wait until no Riot client processes are running. Resolves false on timeout.
 */
export async function waitForClientExit(timeoutMs = 10_000, pollMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isClientRunning())) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return !(await isClientRunning());
}

/**
 * Get list of running processes (executable names or paths), without blocking the event loop
 */
async function getRunningProcesses(): Promise<string[]> {
  try {
    if (isWindows()) {
      const { stdout } = await execFileAsync('tasklist', ['/fo', 'csv', '/nh'], {
        encoding: 'utf-8',
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      });
      return stdout
        .split('\n')
        .map((line) => line.split(',')[0]?.replace(/"/g, '') ?? '')
        .filter(Boolean);
    }
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'comm='], {
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Executable of a process by PID, or null if it is not running
 */
export function getProcessExecutable(pid: number): string | null {
  try {
    if (isWindows()) {
      const result = spawnSync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], {
        encoding: 'utf-8',
        windowsHide: true,
      });
      const name = result.stdout.split('\n')[0]?.split(',')[0]?.replace(/"/g, '').trim();
      return name && !name.startsWith('INFO:') ? name : null;
    }
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8' });
    return result.status === 0 ? result.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * Kill all Riot-related processes
 */
export function killProcesses(): void {
  logger.info('Stopping Riot processes...');

  for (const name of PROCESS_NAMES) {
    try {
      if (isWindows()) {
        spawnSync('taskkill', ['/f', '/im', `${name}.exe`], { stdio: 'ignore' });
      } else {
        spawnSync('pkill', ['-9', name], { stdio: 'ignore' });
      }
    } catch {
      // Ignore errors - process may not be running
    }
  }
}

/**
 * Get the path to the Riot Client executable
 */
export function getRiotClientPath(): string | null {
  if (isWindows()) {
    return getWindowsRiotClientPath();
  } else if (isMacOS()) {
    return getMacOSRiotClientPath();
  } else {
    return getLinuxRiotClientPath();
  }
}

function getWindowsRiotClientPath(): string | null {
  // Check RiotClientInstalls.json
  const installPath = join(
    process.env.PROGRAMDATA ?? 'C:\\ProgramData',
    'Riot Games',
    'RiotClientInstalls.json'
  );

  if (!existsSync(installPath)) {
    logger.debug(`RiotClientInstalls.json not found at ${installPath}`);
    return null;
  }

  try {
    const data = JSON.parse(readFileSync(installPath, 'utf-8')) as Record<string, unknown>;
    const candidates = [data['rc_default'], data['rc_live'], data['rc_beta']].filter(
      (p): p is string => typeof p === 'string' && existsSync(p)
    );

    if (candidates.length > 0) {
      return candidates[0];
    }
  } catch (err) {
    logger.error('Failed to parse RiotClientInstalls.json:', err);
  }

  return null;
}

function getMacOSRiotClientPath(): string | null {
  const paths = [
    '/Applications/Riot Client.app/Contents/MacOS/RiotClientServices',
    join(process.env.HOME ?? '', 'Applications/Riot Client.app/Contents/MacOS/RiotClientServices'),
  ];

  for (const path of paths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

function getLinuxRiotClientPath(): string | null {
  // Linux typically uses Wine/Lutris - check common locations
  // const home = process.env.HOME ?? '';
  // const paths = [join(home, '.local/share/lutris/runners/wine'), join(home, 'Games/riot-games')];

  // For Linux, we'd need to find the Wine prefix and executable
  // This is complex and varies by setup - return null for now
  logger.warn('Linux support is limited. Please ensure Riot Client is accessible.');
  return null;
}

/**
 * Whether the Riot Client (RiotClientServices) is running
 */
export async function isRiotClientRunning(): Promise<boolean> {
  return (await getRunningProcesses()).some((p) => processBaseName(p) === 'riotclientservices');
}

export interface WatchOptions {
  /** Called once the Riot Client exited and did not relaunch itself within graceMs */
  onExit: () => void;
  /** Called if the Riot Client is not seen running within startTimeoutMs */
  onNeverStarted?: () => void;
  graceMs?: number;
  pollMs?: number;
  startTimeoutMs?: number;
}

/**
 * Watch the Riot Client process. Returns a function that stops watching.
 */
export function watchRiotClientExit({
  onExit,
  onNeverStarted,
  graceMs = 3000,
  pollMs = 2000,
  startTimeoutMs = 60_000,
}: WatchOptions): () => void {
  const startedAt = Date.now();
  let seenRunning = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (ms: number) => {
    if (!stopped) timer = setTimeout(() => void check(), ms);
  };

  const check = async () => {
    if (stopped) return;
    if (await isRiotClientRunning()) {
      seenRunning = true;
      schedule(pollMs);
      return;
    }
    if (stopped) return;

    if (!seenRunning) {
      if (Date.now() - startedAt > startTimeoutMs) {
        stopped = true;
        onNeverStarted?.();
      } else {
        schedule(pollMs);
      }
      return;
    }

    logger.debug('Detected Riot Client exit, waiting to see if it relaunches');
    await new Promise((resolve) => setTimeout(resolve, graceMs));
    if (stopped) return;
    if (await isRiotClientRunning()) {
      logger.debug('Riot Client relaunched, continuing to monitor');
      schedule(pollMs);
      return;
    }
    if (stopped) return;
    stopped = true;
    onExit();
  };

  schedule(pollMs);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
