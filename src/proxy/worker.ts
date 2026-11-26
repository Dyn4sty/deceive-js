/**
 * Proxy worker: runs the chat and config proxies off the main thread.
 *
 * Native dialogs block the main thread while they are open; running the sockets here keeps
 * chat flowing in the meantime. This module must not import Electrobun or the settings store.
 */

import { MainController } from '../controller.js';
import { ConfigProxy } from './config-proxy.js';
import { logger } from '../utils/logger.js';
import type { ChatServerConfig } from '../types.js';
import type { MainToWorker, ProxyStartOptions, WorkerToMain } from '../shared/worker-protocol.js';

declare const self: Worker;

let controller: MainController | null = null;
let configProxy: ConfigProxy | null = null;

function send(message: WorkerToMain): void {
  self.postMessage(message);
}

function start(options: ProxyStartOptions): void {
  if (options.logFile) logger.setLogFile(options.logFile, { rotate: false });
  if (options.debug) logger.setLevel('debug');

  controller = new MainController({
    status: options.status,
    connectToMuc: options.connectToMuc,
    introductionShown: options.introductionShown,
    certificate: options.certificate,
    events: {
      onStateChange: (state) => send({ type: 'state', state }),
      onIntroductionShown: () => send({ type: 'introductionShown' }),
      onChatConnected: () => send({ type: 'chatConnected' }),
      onChatServerUnreachable: () => send({ type: 'chatUnreachable' }),
      onIdle: () => send({ type: 'idle' }),
    },
  });
  const chatPort = controller.startChatListener();
  logger.info(`Chat proxy listening on port ${chatPort}`);

  configProxy = new ConfigProxy(chatPort, options.trustedCertificate);
  configProxy.start();
  logger.info(`Config proxy listening on port ${configProxy.port}`);

  let servingClients = false;
  configProxy.on('patchedChatServer', (serverConfig: ChatServerConfig) => {
    logger.debug(`Original chat server: ${serverConfig.chatHost}:${serverConfig.chatPort}`);
    if (servingClients) return;
    servingClients = true;
    logger.info(`Original chat server: ${serverConfig.chatHost}:${serverConfig.chatPort}`);
    controller?.setChatServerConfig(serverConfig.chatHost, serverConfig.chatPort);
    send({ type: 'chatConfigured' });
  });
  configProxy.on('rewriteFailed', (message) => send({ type: 'configRewriteFailed', message }));

  send({ type: 'started', chatPort, configPort: configProxy.port, state: controller.getState() });
}

function stop(): void {
  try {
    controller?.stop();
    configProxy?.stop();
  } catch (err) {
    logger.debug(
      `Error during proxy shutdown: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  controller = null;
  configProxy = null;
  send({ type: 'stopped' });
}

self.onmessage = (event: MessageEvent<MainToWorker>) => {
  const message = event.data;
  try {
    switch (message.type) {
      case 'start':
        start(message.options);
        break;
      case 'setStatus':
        controller?.setStatus(message.status);
        break;
      case 'toggleEnabled':
        controller?.toggleEnabled();
        break;
      case 'toggleMuc':
        controller?.toggleConnectToMuc();
        break;
      case 'stop':
        stop();
        break;
    }
  } catch (err) {
    logger.error(`Proxy worker error handling ${message.type}:`, err);
    if (message.type === 'start') {
      send({ type: 'fatal', message: err instanceof Error ? err.message : String(err) });
    }
  }
};

process.on('uncaughtException', (err) => logger.error('Uncaught error in proxy worker:', err));
process.on('unhandledRejection', (err) =>
  logger.error('Unhandled rejection in proxy worker:', err)
);
