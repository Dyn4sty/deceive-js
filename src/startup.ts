/**
 * Startup handler - orchestrates the application startup sequence
 */

import {
  LaunchGame,
  PresenceStatus,
  PRODUCT_NAMES,
  ChatServerConfig,
  statusLabel,
} from './types.js';
import { ConfigProxy } from './proxy/config-proxy.js';
import { MainController } from './controller.js';
import {
  getRiotClientPath,
  isClientRunning,
  killProcesses,
  watchRiotClientExit,
} from './launcher/process-manager.js';
import { launchRiotClient } from './launcher/game-launcher.js';
import { config, resolveStartupStatus } from './config/config.js';
import { loadCertificate, localhostDomainResolves, LOCALHOST_DOMAIN } from './proxy/certificate.js';
import { logger } from './utils/logger.js';
import { promptForGame, promptForStatus, confirm, startCommandLoop } from './ui/cli.js';
import packageJson from '../package.json' with { type: 'json' };

const STATUS_MAP: Record<string, PresenceStatus> = {
  offline: PresenceStatus.Offline,
  online: PresenceStatus.Online,
  mobile: PresenceStatus.Mobile,
  chat: PresenceStatus.Online,
};

/**
 * Main entry point for starting Deceive
 *
 * @param statusStr Initial status (offline/online/mobile), 'prompt' to ask interactively,
 *   or null to use the configured startup status
 */
export async function startDeceive(
  game: LaunchGame,
  statusStr: string | null,
  patchline: string,
  showTray: boolean
): Promise<void> {
  logger.info(`League Deceiver v${packageJson.version}`);

  if (!(await localhostDomainResolves())) {
    logger.warn(
      `Your machine is failing to resolve ${LOCALHOST_DOMAIN} to 127.0.0.1. ` +
        'Deceive will not work until this is resolved. Switch to a different DNS server (like 1.1.1.1 or 8.8.8.8), ' +
        `or add "127.0.0.1 ${LOCALHOST_DOMAIN}" to your hosts file (/etc/hosts on macOS/Linux). ` +
        'See https://github.com/molenzwiebel/Deceive#faq for details.'
    );
  }

  // Check if Riot Client is already running
  if (isClientRunning()) {
    logger.warn('The Riot Client is currently running.');
    const stop = await confirm(
      'To mask your status, the Riot Client needs to be started by Deceive. Stop the Riot Client and its games now?'
    );
    if (!stop) {
      logger.info('Riot Client left running, exiting.');
      process.exit(0);
    }
    killProcesses();
    // Riot Client takes a while to die
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  // Find Riot Client path
  const riotClientPath = getRiotClientPath();
  if (!riotClientPath) {
    logger.error(
      'Unable to find Riot Client installation. Please launch any Riot game once, then try again.'
    );
    process.exit(1);
  }

  logger.info(`Found Riot Client at: ${riotClientPath}`);

  // Handle game selection
  if (game === LaunchGame.Auto) {
    game = config.get('defaultGame') ?? LaunchGame.Prompt;
  }

  if (game === LaunchGame.Prompt) {
    game = await promptForGame();
    if (game === LaunchGame.Prompt) {
      logger.info('No game selected, exiting.');
      process.exit(0);
    }
  }

  let status: PresenceStatus;
  if (statusStr === null) {
    status = resolveStartupStatus();
  } else if (statusStr.toLowerCase() === 'prompt') {
    status = await promptForStatus();
  } else {
    status = STATUS_MAP[statusStr.toLowerCase()] ?? PresenceStatus.Offline;
  }

  logger.info(`Status: ${statusLabel(status)}`);

  // Step 1: Get the certificate used to intercept the chat connection
  const certificate = await loadCertificate();

  // Step 2: Create main controller and start the chat TLS listener
  const mainController = new MainController(status, showTray);
  const chatPort = mainController.startChatListener();
  logger.info(`Chat proxy listening on port ${chatPort}`);

  // Step 3: Start config proxy
  const configProxy = new ConfigProxy(chatPort, certificate.trusted);
  configProxy.start();
  logger.info(`Config proxy listening on port ${configProxy.port}`);

  // Step 4: Listen for chat server configuration
  let servingClients = false;
  configProxy.on('patchedChatServer', (serverConfig: ChatServerConfig) => {
    logger.debug(`Original chat server: ${serverConfig.chatHost}:${serverConfig.chatPort}`);

    if (!servingClients) {
      servingClients = true;
      logger.info(`Original chat server: ${serverConfig.chatHost}:${serverConfig.chatPort}`);
      mainController.setChatServerConfig(serverConfig.chatHost, serverConfig.chatPort);
    }
  });

  let shuttingDown = false;
  let stopWatchingClient: () => void = () => {};
  let stopCommandLoop: () => void = () => {};

  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Shutting down (${reason})...`);
    stopWatchingClient();
    stopCommandLoop();
    try {
      mainController.stop();
      configProxy.stop();
    } catch (err) {
      logger.debug(`Error during shutdown: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(0);
  };

  mainController.setQuitHandler(() => shutdown('quit'));
  process.on('SIGINT', () => shutdown('interrupted'));
  process.on('SIGTERM', () => shutdown('terminated'));

  // Step 5: Launch Riot Client with our config proxy
  const product = PRODUCT_NAMES[game];
  launchRiotClient(riotClientPath, configProxy.port, product, patchline);

  // Step 6: Exit when the Riot Client exits
  stopWatchingClient = watchRiotClientExit(() => shutdown('Riot Client exited'));

  logger.info('Deceive is running. Press Ctrl+C to exit.');
  stopCommandLoop = startCommandLoop({
    setStatus: (newStatus) => mainController.setStatus(newStatus),
    setEnabled: (enabled) => mainController.setEnabled(enabled),
    describeStatus: () => mainController.describeStatus(),
    quit: () => shutdown('quit'),
  });
}
