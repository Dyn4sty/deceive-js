/**
 * League Deceiver - Electrobun main process
 *
 * A TypeScript port of the original Deceive application.
 * https://github.com/molenzwiebel/Deceive
 */

import { PATHS, Utils } from 'electrobun/main';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { startDeceive, type DeceiveSession } from '../startup.js';
import {
  getProcessExecutable,
  killProcesses,
  waitForClientExit,
} from '../launcher/process-manager.js';
import { config } from '../config/config.js';
import { LaunchGame } from '../types.js';
import { logger } from '../utils/logger.js';
import { DeceiveTray } from '../ui/tray.js';
import { confirm, error, nativeUI, retryOrQuit } from '../ui/dialogs.js';

const lockPath = join(Utils.paths.userData, 'deceive.lock');
// Bundled by scripts/build-worker.ts and copied into the app by electrobun.config.ts
const workerPath = join(PATHS.RESOURCES_FOLDER, 'app', 'worker', 'proxy-worker.js');

function writeLock(): void {
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, exe: process.execPath }), {
    flag: 'wx',
  });
}

/**
 * Allow a single running copy of Deceive, using a lock file holding the owner's PID and executable
 */
function acquireSingleInstanceLock(): boolean {
  try {
    mkdirSync(Utils.paths.userData, { recursive: true });
    writeLock();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      logger.warn(`Unable to create instance lock: ${String(err)}`);
      return true;
    }
  }

  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: number; exe?: string };
    // Only a live process running the same executable counts; PIDs are reused after crashes
    if (lock.pid && lock.pid !== process.pid) {
      const exe = getProcessExecutable(lock.pid);
      const sameApp =
        exe !== null &&
        (exe === lock.exe ||
          exe.toLowerCase() === (lock.exe ?? '').split(/[\\/]/).pop()?.toLowerCase());
      if (sameApp) return false;
    }
  } catch {
    // Unreadable lock file from an older version or a crash; replace it
  }

  try {
    rmSync(lockPath, { force: true });
    writeLock();
  } catch (err) {
    // Another instance won the race to replace the stale lock
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    logger.warn(`Unable to create instance lock: ${String(err)}`);
  }
  return true;
}

function releaseSingleInstanceLock(): void {
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: number };
    if (lock.pid === process.pid) rmSync(lockPath);
  } catch {
    // Ignore
  }
}

let session: DeceiveSession | null = null;
let tray: DeceiveTray | null = null;
let quitting = false;
let restarting = false;
let chatErrorShown = false;

async function quit(reason: string, stopRiot = false): Promise<void> {
  if (quitting) return;
  quitting = true;
  logger.info(`Shutting down (${reason})`);
  const current = session;
  session = null;
  await current?.stop();
  if (stopRiot) killProcesses();
  tray?.remove();
  releaseSingleInstanceLock();
  Utils.quit(0);
}

async function runSession(): Promise<boolean> {
  const started = await startDeceive(nativeUI, {
    workerPath,
    onExit: (reason) => {
      if (!restarting) void quit(reason);
    },
    onChatServerUnreachable: () => {
      if (chatErrorShown) return;
      chatErrorShown = true;
      void retryOrQuit(
        'Unable to connect to the chat server.',
        'Please check your internet connection. If this issue persists and you can connect to chat normally ' +
          'without Deceive, please file a bug report on GitHub.'
      ).then((retry) => {
        chatErrorShown = false;
        if (!retry) void quit('chat server unreachable', true);
      });
    },
  });

  // Quit may have been requested while startup was waiting on a dialog or the picker
  if (quitting) {
    await started?.stop();
    return true;
  }

  session = started;
  if (!session) return false;
  session.proxy.on('state', (state) => tray?.update(state));
  tray?.update(session.proxy.getState());
  return true;
}

async function launchDifferentGame(): Promise<void> {
  if (restarting || quitting) return;
  const ok = await confirm(
    'Restart Deceive to launch a different game?',
    'This will also stop related games if they are running.'
  );
  // The session may have ended (or another restart started) while the dialog was open
  if (!ok || restarting || quitting) return;

  restarting = true;
  try {
    const current = session;
    session = null;
    tray?.update(null);
    await current?.stop();
    killProcesses();
    await waitForClientExit();

    config.set('defaultGame', LaunchGame.Prompt);
    if (!(await runSession())) void quit('no game selected');
  } finally {
    restarting = false;
  }
}

async function main(): Promise<void> {
  // Live in the menu bar only, like the original Deceive lives in the tray
  Utils.setDockIconVisible(false);

  logger.setLogFile(join(Utils.paths.userLogs, 'deceive.log'));

  if (!acquireSingleInstanceLock()) {
    await error('Deceive is already running.', 'Use the Deceive icon in the menu bar or tray.');
    Utils.quit(0);
    return;
  }

  tray = new DeceiveTray({
    onStatusChange: (status) => session?.proxy.setStatus(status),
    onToggleEnabled: () => session?.proxy.toggleEnabled(),
    onToggleMuc: () => session?.proxy.toggleConnectToMuc(),
    onLaunchDifferentGame: () => void launchDifferentGame(),
    onOpenLogs: () => {
      const logFile = logger.getLogFile();
      if (logFile) Utils.showItemInFolder(logFile);
    },
    onQuit: () => {
      void confirm(
        'Are you sure you want to stop Deceive?',
        'This will also stop related games if they are running.'
      ).then((ok) => {
        if (ok) void quit('quit from tray', true);
      });
    },
  });

  process.on('SIGINT', () => void quit('interrupted'));
  process.on('SIGTERM', () => void quit('terminated'));

  if (!(await runSession())) {
    await quit('startup cancelled');
  }
}

process.on('uncaughtException', (err) => logger.error('Uncaught error:', err));
process.on('unhandledRejection', (err) => logger.error('Unhandled rejection:', err));

main().catch(async (err: unknown) => {
  logger.error('Fatal error:', err);
  await error(
    'Deceive ran into an unexpected error.',
    err instanceof Error ? err.message : String(err)
  );
  await quit('fatal error');
});
