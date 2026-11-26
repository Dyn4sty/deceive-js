/**
 * Startup handler - orchestrates the application startup sequence
 */

import { LaunchGame, PRODUCT_NAMES, statusLabel } from './types.js';
import {
  getRiotClientPath,
  isClientRunning,
  killProcesses,
  waitForClientExit,
  watchRiotClientExit,
} from './launcher/process-manager.js';
import { launchRiotClient } from './launcher/game-launcher.js';
import { config, resolveStartupStatus, saveLastStatus } from './config/config.js';
import { loadCertificate, localhostDomainResolves, LOCALHOST_DOMAIN } from './proxy/certificate.js';
import { ProxyClient } from './proxy/proxy-client.js';
import { logger } from './utils/logger.js';
import packageJson from '../package.json' with { type: 'json' };

export const FAQ_URL = 'https://github.com/molenzwiebel/Deceive#faq';
const ISSUES_URL = 'https://github.com/Dyn4sty/deceive-js/issues';

// After the client received the patched chat config, it should connect to the proxy quickly
const CHAT_CONNECT_TIMEOUT_MS = 45_000;

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
  proxy: ProxyClient;
  /** Stop the proxies and watchers. Does not stop the Riot Client. */
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Path of the bundled proxy worker script */
  workerPath: string;
  /** Called when the session ends on its own (Riot Client exited, idle timeout, crash) */
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

  if (await isClientRunning()) {
    logger.info('Riot Client is already running');
    const stop = await ui.confirm(
      'The Riot Client is currently running.',
      'In order to mask your online status, the Riot Client needs to be started by Deceive. ' +
        'Do you want Deceive to stop the Riot Client and games launched by it, so that it can restart with the proper configuration?'
    );
    if (!stop) return null;
    killProcesses();
    if (!(await waitForClientExit())) {
      logger.warn('Riot processes are still running after being stopped');
    }
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
  saveLastStatus(status);

  const certificate = await loadCertificate();
  if (!certificate.trusted) {
    await ui.error(
      'Deceive was unable to obtain the security certificate needed to intercept the chat connection.',
      'This normally happens when the server providing the certificate has a problem, but it can also be caused by ' +
        'network issues on your end. Deceive will continue with a fallback certificate, but chat may fail to connect.'
    );
  }

  const proxy = await ProxyClient.start(options.workerPath, {
    status,
    connectToMuc: config.get('connectToMuc'),
    introductionShown: config.get('introductionShown'),
    certificate: { certificate: certificate.certificate, privateKey: certificate.privateKey },
    trustedCertificate: certificate.trusted,
    logFile: logger.getLogFile(),
    debug: Boolean(process.env.DEBUG),
  });

  let stopped = false;
  let stopWatching: () => void = () => {};
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let chatConnected = false;
  let warnedNotMasked = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    stopWatching();
    if (connectTimer) clearTimeout(connectTimer);
    await proxy.stop();
  };

  const exit = (reason: string) => {
    if (stopped) return;
    void stop().then(() => options.onExit(reason));
  };

  const warnNotMasked = (detail: string) => {
    if (warnedNotMasked || stopped) return;
    warnedNotMasked = true;
    void ui.warn('Deceive may not be hiding your status.', detail, {
      label: 'Open FAQ',
      url: FAQ_URL,
    });
  };

  // Settings live on the main thread; the worker only reports changes
  proxy.on('state', (state) => {
    saveLastStatus(state.status);
    config.set('connectToMuc', state.connectToMuc);
  });
  proxy.on('introductionShown', () => config.set('introductionShown', true));
  proxy.on('idle', () => exit('no chat connections'));
  proxy.on('chatUnreachable', () => options.onChatServerUnreachable?.());
  proxy.on('crashed', (message) => {
    if (stopped) return;
    logger.error(`Proxy stopped unexpectedly: ${message}`);
    void ui
      .error(
        'Deceive stopped unexpectedly.',
        `${message}\n\nYour status is no longer being hidden.`
      )
      .then(() => exit('proxy crashed'));
  });
  proxy.on('configRewriteFailed', (message) =>
    warnNotMasked(
      'Deceive was unable to rewrite the Riot Client configuration, so chat may connect directly to Riot. ' +
        `This normally happens because Riot changed something on their end. Check for a new version of Deceive.\n\n${message}`
    )
  );
  proxy.on('chatConfigured', () => {
    if (chatConnected || connectTimer) return;
    connectTimer = setTimeout(() => {
      if (!chatConnected) {
        warnNotMasked(
          'The Riot Client received the chat configuration but has not connected to chat through Deceive. ' +
            'Check deceive.log (tray menu > Open Logs Folder) for errors.'
        );
      }
    }, CHAT_CONNECT_TIMEOUT_MS);
  });
  proxy.on('chatConnected', () => {
    if (chatConnected) return;
    chatConnected = true;
    if (connectTimer) clearTimeout(connectTimer);
    ui.notify(
      'Deceive is active',
      `You are appearing ${statusLabel(proxy.getState().status)}. Use the Deceive menu bar/tray icon for more options.`
    );
  });

  const launchError = await launchRiotClient(
    riotClientPath,
    proxy.configPort,
    PRODUCT_NAMES[game],
    options.patchline ?? 'live'
  );
  if (launchError) {
    await stop();
    await ui.error('Deceive was unable to start the Riot Client.', launchError);
    return null;
  }

  stopWatching = watchRiotClientExit({
    onExit: () => exit('Riot Client exited'),
    onNeverStarted: () => {
      if (stopped) return;
      logger.error('Riot Client was not seen running after launch');
      void ui
        .error(
          'The Riot Client did not start.',
          'Deceive launched the Riot Client, but it is not running. Try starting Deceive again.'
        )
        .then(() => exit('Riot Client did not start'));
    },
  });

  logger.info('Deceive is running');

  return { proxy, stop };
}
