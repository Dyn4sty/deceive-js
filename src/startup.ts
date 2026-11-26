/**
 * Startup handler - orchestrates the application startup sequence
 */

import { LaunchGame, PRODUCT_NAMES, ChatServerConfig, statusLabel } from './types.js';
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
import packageJson from '../package.json' with { type: 'json' };

export const FAQ_URL = 'https://github.com/molenzwiebel/Deceive#faq';
const ISSUES_URL = 'https://github.com/Dyn4sty/deceive-node/issues';

/**
 * User interface used during startup, implemented with native dialogs by the app
 */
export interface StartupUI {
  /** OK/Cancel question. Resolves true for OK. */
  confirm(message: string, detail?: string): Promise<boolean>;
  /** Warning with an optional link button. */
  warn(message: string, detail?: string, link?: { label: string; url: string }): Promise<void>;
  error(message: string, detail?: string): Promise<void>;
  notify(title: string, body: string): void;
  /** Ask which game to launch. Resolves null if cancelled. */
  pickGame(): Promise<LaunchGame | null>;
}

export interface DeceiveSession {
  controller: MainController;
  /** Stop the proxies and watchers. Does not stop the Riot Client. */
  stop(): void;
}

export interface StartOptions {
  /** Called when the session ends on its own (Riot Client exited, idle timeout) */
  onExit: (reason: string) => void;
  /** Called when the real chat server cannot be reached */
  onChatServerUnreachable?: () => void;
  patchline?: string;
}

/**
 * Start Deceive: launch the Riot Client through the proxies.
 * Resolves null if the user cancelled or Deceive cannot start.
 */
export async function startDeceive(
  ui: StartupUI,
  options: StartOptions
): Promise<DeceiveSession | null> {
  logger.info(`League Deceiver v${packageJson.version}`);

  if (!(await localhostDomainResolves())) {
    logger.warn(`${LOCALHOST_DOMAIN} does not resolve to 127.0.0.1`);
    await ui.warn(
      'Your machine is failing to resolve some required domains.',
      'You will need to switch DNS servers (for example to 1.1.1.1 or 8.8.8.8) or add ' +
        `"127.0.0.1 ${LOCALHOST_DOMAIN}" to your hosts file. Deceive will not work until this is resolved.`,
      { label: 'Open FAQ', url: FAQ_URL }
    );
  }

  if (isClientRunning()) {
    logger.info('Riot Client is already running');
    const stop = await ui.confirm(
      'The Riot Client is currently running.',
      'In order to mask your online status, the Riot Client needs to be started by Deceive. ' +
        'Do you want Deceive to stop the Riot Client and games launched by it, so that it can restart with the proper configuration?'
    );
    if (!stop) return null;
    killProcesses();
    // Riot Client takes a while to die
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  const riotClientPath = getRiotClientPath();
  if (!riotClientPath) {
    logger.error('Unable to find the Riot Client installation');
    await ui.error(
      'Deceive was unable to find the path to the Riot Client.',
      'Usually this can be resolved by launching any Riot Games game once, then launching Deceive again. ' +
        `If this does not resolve the issue, please file a bug report at ${ISSUES_URL}.`
    );
    return null;
  }
  logger.info(`Found Riot Client at: ${riotClientPath}`);

  let game = config.get('defaultGame') ?? LaunchGame.Prompt;
  if (game === LaunchGame.Auto || game === LaunchGame.Prompt) {
    const picked = await ui.pickGame();
    if (!picked) {
      logger.info('No game selected');
      return null;
    }
    game = picked;
  }

  const status = resolveStartupStatus();
  logger.info(`Status: ${statusLabel(status)}`);

  const certificate = await loadCertificate();
  if (!certificate.trusted) {
    await ui.error(
      'Deceive was unable to obtain the security certificate needed to intercept the chat connection.',
      'This normally happens when the server providing the certificate has a problem, but it can also be caused by ' +
        'network issues on your end. Deceive will continue with a fallback certificate, but chat may fail to connect.'
    );
  }

  const controller = new MainController(status);
  controller.setQuitHandler(() => options.onExit('quit'));
  if (options.onChatServerUnreachable) {
    controller.onChatServerUnreachable(options.onChatServerUnreachable);
  }
  const chatPort = controller.startChatListener();
  logger.info(`Chat proxy listening on port ${chatPort}`);

  const configProxy = new ConfigProxy(chatPort, certificate.trusted);
  configProxy.start();
  logger.info(`Config proxy listening on port ${configProxy.port}`);

  let servingClients = false;
  configProxy.on('patchedChatServer', (serverConfig: ChatServerConfig) => {
    logger.debug(`Original chat server: ${serverConfig.chatHost}:${serverConfig.chatPort}`);
    if (!servingClients) {
      servingClients = true;
      logger.info(`Original chat server: ${serverConfig.chatHost}:${serverConfig.chatPort}`);
      controller.setChatServerConfig(serverConfig.chatHost, serverConfig.chatPort);
    }
  });

  launchRiotClient(
    riotClientPath,
    configProxy.port,
    PRODUCT_NAMES[game],
    options.patchline ?? 'live'
  );

  let stopped = false;
  const stopWatching = watchRiotClientExit(() => options.onExit('Riot Client exited'));

  ui.notify(
    'Deceive is running',
    'Deceive is currently masking your status. Use the Deceive menu bar/tray icon for more options.'
  );
  logger.info('Deceive is running');

  return {
    controller,
    stop: () => {
      if (stopped) return;
      stopped = true;
      stopWatching();
      try {
        controller.stop();
        configProxy.stop();
      } catch (err) {
        logger.debug(`Error during shutdown: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
