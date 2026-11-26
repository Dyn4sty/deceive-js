/**
 * Main Controller - Manages chat proxy connections and status
 *
 * Uses Bun's native TLS APIs for better performance.
 * Implements data buffering to handle the race condition where the Riot Client
 * sends data before the outgoing connection to the chat server is established.
 */

import type { Socket, TCPSocketListener } from 'bun';
import { PresenceStatus, statusLabel } from './types.js';
import { ProxiedConnection } from './proxy/proxied-connection.js';
import { getCertificate } from './proxy/certificate.js';
import { logger } from './utils/logger.js';
import { config, saveLastStatus } from './config/config.js';

/**
 * Socket data attached to both incoming and outgoing sockets.
 * pendingData buffers incoming data until the ProxiedConnection is ready.
 */
type SocketData = {
  proxiedConnection?: ProxiedConnection;
  pendingData?: Buffer[];
};

export interface ControllerState {
  status: PresenceStatus;
  enabled: boolean;
  connectToMuc: boolean;
}

export class MainController {
  private status: PresenceStatus;
  private enabled = true;
  private connectToMuc: boolean;
  private connections: ProxiedConnection[] = [];
  private shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  private sentIntroductionText = false;
  private chatServer: TCPSocketListener<SocketData> | null = null;
  private chatHost: string = '';
  private chatPort: number = 0;
  private stopped = false;
  private onQuit: () => void = () => process.exit(0);
  private stateListeners: ((state: ControllerState) => void)[] = [];
  private chatUnreachableHandler: (() => void) | null = null;

  constructor(initialStatus: PresenceStatus) {
    this.status = initialStatus;
    this.connectToMuc = config.get('connectToMuc');
    saveLastStatus(initialStatus);

    logger.info(`Initial status: ${statusLabel(this.status)}`);
  }

  /**
   * Set the handler used to shut down the whole application (tray Quit, idle shutdown)
   */
  setQuitHandler(handler: () => void): void {
    this.onQuit = handler;
  }

  getState(): ControllerState {
    return { status: this.status, enabled: this.enabled, connectToMuc: this.connectToMuc };
  }

  /**
   * Called whenever the status, enabled flag or lobby chat setting changes
   */
  onStateChange(listener: (state: ControllerState) => void): void {
    this.stateListeners.push(listener);
  }

  onChatServerUnreachable(handler: () => void): void {
    this.chatUnreachableHandler = handler;
  }

  private notifyStateChange(): void {
    const state = this.getState();
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }

  /**
   * Start the TLS listener for chat proxy using Bun's native API.
   * Returns the port number.
   */
  startChatListener(): number {
    const cert = getCertificate();

    this.chatServer = Bun.listen<SocketData>({
      hostname: '127.0.0.1',
      port: 0,
      tls: {
        key: cert.privateKey,
        cert: cert.certificate,
      },
      socket: {
        open: (socket) => this.handleNewConnection(socket),
        data: (socket, data) => this.handleIncomingSocketData(socket, data),
        close: (socket) => socket.data?.proxiedConnection?.handleClose(),
        error: (socket, error) => {
          logger.debug(`Incoming socket error: ${error.message}`);
          socket.data?.proxiedConnection?.handleClose();
        },
      },
    });

    return this.chatServer.port;
  }

  /**
   * Handle incoming data from the Riot Client.
   * Buffers data if the ProxiedConnection isn't ready yet.
   */
  private handleIncomingSocketData(socket: Socket<SocketData>, data: Buffer | Uint8Array): void {
    const proxied = socket.data?.proxiedConnection;
    if (proxied) {
      proxied.handleIncomingData(data);
    } else {
      // Buffer data until the outgoing connection is established
      socket.data ??= {};
      socket.data.pendingData ??= [];
      socket.data.pendingData.push(Buffer.from(data));
      logger.debug(`Buffered ${data.length} bytes (waiting for outgoing connection)`);
    }
  }

  /**
   * Set the real chat server configuration.
   * Called when the config proxy patches the client configuration.
   */
  setChatServerConfig(chatHost: string, chatPort: number): void {
    this.chatHost = chatHost;
    this.chatPort = chatPort;
    logger.debug(`Chat server configured: ${chatHost}:${chatPort}`);
  }

  /**
   * Handle a new incoming TLS connection from the Riot Client.
   */
  private handleNewConnection(incomingSocket: Socket<SocketData>): void {
    // Cancel shutdown timer if we get a new connection
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
    }

    logger.debug('New incoming TLS connection');

    // Wait for chat server config before connecting
    if (!this.chatHost || !this.chatPort) {
      logger.debug('Chat server not configured yet, waiting...');
      const checkConfig = setInterval(() => {
        if (this.chatHost && this.chatPort) {
          clearInterval(checkConfig);
          this.connectToRealServer(incomingSocket);
        }
      }, 100);
      return;
    }

    this.connectToRealServer(incomingSocket);
  }

  /**
   * Connect to the real chat server and establish the proxy.
   */
  private connectToRealServer(incomingSocket: Socket<SocketData>): void {
    Bun.connect<SocketData>({
      hostname: this.chatHost,
      port: this.chatPort,
      tls: { serverName: this.chatHost },
      socket: {
        open: (outgoingSocket) => {
          logger.debug('Connected to real chat server');
          this.establishProxiedConnection(incomingSocket, outgoingSocket);
        },
        data: (socket, data) => {
          socket.data?.proxiedConnection?.handleOutgoingData(data);
        },
        close: (socket) => {
          socket.data?.proxiedConnection?.handleClose();
        },
        error: (socket, error) => {
          logger.error(`Outgoing socket error: ${error.message}`);
          socket.data?.proxiedConnection?.handleClose();
        },
      },
    }).catch((err: unknown) => {
      logger.error(
        `Failed to connect to chat server ${this.chatHost}:${this.chatPort}: ${err instanceof Error ? err.message : String(err)}`
      );
      incomingSocket.end();
      this.chatUnreachableHandler?.();
    });
  }

  /**
   * Create the ProxiedConnection and flush any buffered data.
   */
  private establishProxiedConnection(
    incomingSocket: Socket<SocketData>,
    outgoingSocket: Socket<SocketData>
  ): void {
    const proxiedConnection = new ProxiedConnection(this, incomingSocket, outgoingSocket);
    proxiedConnection.on('close', () => this.removeConnection(proxiedConnection));

    // Get buffered data before overwriting socket.data
    const pendingData = incomingSocket.data?.pendingData ?? [];

    // Store reference in both sockets
    incomingSocket.data = { proxiedConnection };
    outgoingSocket.data = { proxiedConnection };

    // Flush any buffered incoming data
    if (pendingData.length > 0) {
      logger.debug(`Flushing ${pendingData.length} buffered chunks`);
      for (const bufferedData of pendingData) {
        proxiedConnection.handleIncomingData(bufferedData);
      }
    }

    this.connections.push(proxiedConnection);
    logger.info('Chat connection established, presence is being masked');

    // Send introduction messages once, on the very first run (10s delay)
    if (!this.sentIntroductionText && !config.get('introductionShown')) {
      this.sentIntroductionText = true;
      setTimeout(() => void this.sendIntroductionMessages(), 10000);
    }
  }

  private removeConnection(proxied: ProxiedConnection): void {
    this.connections = this.connections.filter((c) => c !== proxied);
    logger.debug('Chat connection closed');
    if (this.connections.length === 0 && !this.stopped) {
      this.scheduleShutdown();
    }
  }

  private scheduleShutdown(): void {
    if (this.shutdownTimer) clearTimeout(this.shutdownTimer);
    this.shutdownTimer = setTimeout(() => {
      logger.info('No chat connections for 60s, shutting down');
      this.quit();
    }, 60000);
  }

  getStatus(): PresenceStatus {
    return this.status;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  shouldConnectToMuc(): boolean {
    return this.connectToMuc;
  }

  setStatus(newStatus: PresenceStatus): void {
    this.status = newStatus;
    this.enabled = true;
    saveLastStatus(newStatus);
    logger.info(`Status changed to: ${statusLabel(newStatus)}`);

    this.notifyStateChange();

    for (const connection of this.connections) {
      connection.updateStatus(newStatus);
    }

    this.sendMessageFromFakePlayer(`You are now appearing ${statusLabel(newStatus)}.`);
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      this.sendMessageFromFakePlayer(
        enabled ? 'Deceive is already enabled.' : 'Deceive is already disabled.'
      );
      return;
    }
    this.toggleEnabled();
  }

  toggleEnabled(): void {
    this.enabled = !this.enabled;
    const status = this.enabled ? this.status : PresenceStatus.Online;
    logger.info(this.enabled ? 'Deceive enabled' : 'Deceive disabled');

    for (const connection of this.connections) {
      connection.updateStatus(status);
    }

    this.notifyStateChange();
    this.sendMessageFromFakePlayer(
      this.enabled ? 'Deceive is now enabled.' : 'Deceive is now disabled.'
    );
  }

  toggleConnectToMuc(): void {
    this.connectToMuc = !this.connectToMuc;
    config.set('connectToMuc', this.connectToMuc);
    logger.info(`Lobby chat ${this.connectToMuc ? 'enabled' : 'disabled'}`);
    this.notifyStateChange();
  }

  describeStatus(): string {
    return this.enabled
      ? `Deceive is enabled. You are appearing ${statusLabel(this.status)}.`
      : 'Deceive is disabled. You are appearing with your real status.';
  }

  sendMessageFromFakePlayer(message: string): void {
    for (const connection of this.connections) {
      connection.sendMessageFromFakePlayer(message);
    }
  }

  /**
   * Send introduction messages to the user explaining how Deceive works.
   */
  private async sendIntroductionMessages(): Promise<void> {
    config.set('introductionShown', true);

    this.sendMessageFromFakePlayer(
      `Welcome! Deceive is running and you are currently appearing ${statusLabel(this.status)}. ` +
        'Despite what the game client may indicate, you are appearing offline to your friends unless you manually disable Deceive.'
    );

    await this.delay(200);
    this.sendMessageFromFakePlayer(
      'If you want to invite others while being offline, you may need to disable Deceive for them to accept. ' +
        'You can enable Deceive again as soon as they are in your lobby.'
    );

    await this.delay(200);
    this.sendMessageFromFakePlayer(
      'To enable or disable Deceive, or to configure other settings, find Deceive in your tray (menu bar on macOS), ' +
        'or send me a message: online, offline, mobile, enable, disable, status.'
    );

    await this.delay(200);
    this.sendMessageFromFakePlayer('Have fun!');
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  handleChatMessage(content: string): void {
    const lowerContent = content.toLowerCase();

    if (lowerContent.includes('offline')) {
      this.setStatus(PresenceStatus.Offline);
    } else if (lowerContent.includes('mobile')) {
      this.setStatus(PresenceStatus.Mobile);
    } else if (lowerContent.includes('online')) {
      this.setStatus(PresenceStatus.Online);
    } else if (lowerContent.includes('enable')) {
      this.setEnabled(true);
    } else if (lowerContent.includes('disable')) {
      this.setEnabled(false);
    } else if (lowerContent.includes('status')) {
      this.sendMessageFromFakePlayer(this.describeStatus());
    } else if (lowerContent.includes('help')) {
      this.sendMessageFromFakePlayer(
        'Commands: online, offline, mobile, enable, disable, status, help'
      );
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
    }

    for (const connection of [...this.connections]) {
      connection.close();
    }
    this.connections = [];

    if (this.chatServer) {
      this.chatServer.stop(true);
      this.chatServer = null;
    }
  }

  quit(): void {
    this.onQuit();
  }
}
