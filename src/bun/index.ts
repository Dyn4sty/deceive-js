/**
 * League Deceiver - Electrobun main process
 *
 * A TypeScript port of the original Deceive application.
 * https://github.com/molenzwiebel/Deceive
 */

import { Utils } from 'electrobun/main';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { startDeceive, type DeceiveSession } from '../startup.js';
import { killProcesses } from '../launcher/process-manager.js';
import { config } from '../config/config.js';
import { LaunchGame } from '../types.js';
import { logger } from '../utils/logger.js';
import { DeceiveTray } from '../ui/tray.js';
import { confirm, error, nativeUI, retryOrQuit } from '../ui/dialogs.js';

const lockPath = join(Utils.paths.userData, 'deceive.lock');

/**
 * Allow a single running copy of Deceive, using a lock file holding the owner's PID
 */
function acquireSingleInstanceLock(): boolean {
  try {
    if (existsSync(lockPath)) {
      const pid = Number(readFileSync(lockPath, 'utf-8'));
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          // Stale lock from a process that no longer exists
        }
      }
    }
    mkdirSync(Utils.paths.userData, { recursive: true });
    writeFileSync(lockPath, String(process.pid));
  } catch (err) {
    logger.warn(`Unable to create instance lock: ${String(err)}`);
  }
  return true;
}

function releaseSingleInstanceLock(): void {
  try {
    if (existsSync(lockPath) && Number(readFileSync(lockPath, 'utf-8')) === process.pid) {
      rmSync(lockPath);
    }
  } catch {
    // Ignore
  }
}

let session: DeceiveSession | null = null;
let tray: DeceiveTray | null = null;
let quitting = false;
let restarting = false;
let chatErrorShown = false;

function quit(reason: string, stopRiot = false): void {
  if (quitting) return;
  quitting = true;
  logger.info(`Shutting down (${reason})`);
  session?.stop();
  session = null;
  if (stopRiot) killProcesses();
  tray?.remove();
  releaseSingleInstanceLock();
  Utils.quit(0);
}

async function runSession(): Promise<boolean> {
  session = await startDeceive(nativeUI, {
    onExit: (reason) => {
      if (!restarting) quit(reason);
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
        if (!retry) quit('chat server unreachable', true);
      });
    },
  });

  if (!session) return false;
  session.controller.onStateChange((state) => tray?.update(state));
  tray?.update(session.controller.getState());
  return true;
}

async function launchDifferentGame(): Promise<void> {
  const ok = await confirm(
    'Restart Deceive to launch a different game?',
    'This will also stop related games if they are running.'
  );
  if (!ok || restarting) return;

  restarting = true;
  try {
    session?.stop();
    session = null;
    tray?.update(null);
    killProcesses();
    await new Promise((resolve) => setTimeout(resolve, 2000));

    config.set('defaultGame', LaunchGame.Prompt);
    if (!(await runSession())) quit('no game selected');
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
    onStatusChange: (status) => session?.controller.setStatus(status),
    onToggleEnabled: () => session?.controller.toggleEnabled(),
    onToggleMuc: () => session?.controller.toggleConnectToMuc(),
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
        if (ok) quit('quit from tray', true);
      });
    },
  });

  process.on('SIGINT', () => quit('interrupted'));
  process.on('SIGTERM', () => quit('terminated'));

  if (!(await runSession())) {
    quit('startup cancelled');
  }
}

main().catch(async (err: unknown) => {
  logger.error('Fatal error:', err);
  await error(
    'Deceive ran into an unexpected error.',
    err instanceof Error ? err.message : String(err)
  );
  quit('fatal error');
});
