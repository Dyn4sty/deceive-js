/**
 * Main Controller - Manages chat proxy connections and status
 *
 * Runs inside the proxy worker. It owns no persistent settings: the initial values come from
 * the main thread and changes are reported back through ControllerEvents.
 *
 * Incoming data is buffered until the outgoing connection to the chat server is established.
 */

import type { Socket, TCPSocketListener } from 'bun';
import { PresenceStatus, statusLabel } from './types.js';
import { ProxiedConnection, type PresenceHost } from './proxy/proxied-connection.js';
import { logger } from './utils/logger.js';

/**
 * Socket data attached to both incoming and outgoing sockets.
 * pendingData buffers incoming data until the ProxiedConnection is ready.
 */
type SocketData = {
  proxiedConnection?: ProxiedConnection;
  pendingData?: Buffer[];
  /** Set when the incoming socket closes before its proxied connection exists */
  closed?: boolean;
};

export interface ControllerState {
  status: PresenceStatus;
  enabled: boolean;
  connectToMuc: boolean;
}

export interface ControllerEvents {
  onStateChange(state: ControllerState): void;
  onIntroductionShown(): void;
  onChatConnected(): void;
  onChatServerUnreachable(): void;
  /** No chat connections for IDLE_SHUTDOWN_MS */
  onIdle(): void;
}

export interface ControllerOptions {
  status: PresenceStatus;
  connectToMuc: boolean;
  introductionShown: boolean;
  certificate: { certificate: string; privateKey: string };
  events: ControllerEvents;
}

const IDLE_SHUTDOWN_MS = 60_000;

export class MainController implements PresenceHost {
  private status: PresenceStatus;
  private enabled = true;
  private connectToMuc: boolean;
  private introductionShown: boolean;
  private certificate: ControllerOptions['certificate'];
  private events: ControllerEvents;
  private connections: ProxiedConnection[] = [];
  private shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  private introductionTimer: ReturnType<typeof setTimeout> | null = null;
  private configWaiters = new Set<ReturnType<typeof setInterval>>();
  private pendingOutgoing = new Set<Socket<SocketData>>();
  private chatServer: TCPSocketListener<SocketData> | null = null;
  private chatHost: string = '';
  private chatPort: number = 0;
  private stopped = false;

  constructor(options: ControllerOptions) {
    this.status = options.status;
    this.connectToMuc = options.connectToMuc;
    this.introductionShown = options.introductionShown;
    this.certificate = options.certificate;
    this.events = options.events;

    logger.info(`Initial status: ${statusLabel(this.status)}`);
  }

  getState(): ControllerState {
    return { status: this.status, enabled: this.enabled, connectToMuc: this.connectToMuc };
  }

  private notifyStateChange(): void {
    this.events.onStateChange(this.getState());
  }

  /**
   * Start the TLS listener for chat proxy using Bun's native API.
   * Returns the port number.
   */
  startChatListener(): number {
    this.chatServer = Bun.listen<SocketData>({
      hostname: '127.0.0.1',
      port: 0,
      tls: {
        key: this.certificate.privateKey,
        cert: this.certificate.certificate,
      },
      socket: {
        open: (socket) => this.handleNewConnection(socket),
        data: (socket, data) => this.handleIncomingSocketData(socket, data),
        drain: (socket) => socket.data?.proxiedConnection?.flushToClient(),
        close: (socket) => this.handleIncomingClosed(socket),
        error: (socket, error) => {
          logger.debug(`Incoming socket error: ${error.message}`);
          this.handleIncomingClosed(socket);
        },
      },
    });

    return this.chatServer.port;
  }

  private handleIncomingClosed(socket: Socket<SocketData>): void {
    socket.data ??= {};
    socket.data.closed = true;
    socket.data.pendingData = undefined;
    socket.data.proxiedConnection?.handleClose();
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
    if (this.stopped) {
      incomingSocket.end();
      return;
    }

    // Cancel shutdown timer if we get a new connection
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
    }

    logger.debug('New incoming TLS connection');

    // Wait for chat server config before connecting
    if (!this.chatHost || !this.chatPort) {
      logger.debug('Chat server not configured yet, waiting...');
      const waiter = setInterval(() => {
        if (incomingSocket.data?.closed) {
          clearInterval(waiter);
          this.configWaiters.delete(waiter);
        } else if (this.chatHost && this.chatPort) {
          clearInterval(waiter);
          this.configWaiters.delete(waiter);
          this.connectToRealServer(incomingSocket);
        }
      }, 100);
      this.configWaiters.add(waiter);
      return;
    }

    this.connectToRealServer(incomingSocket);
  }

  /**
   * Connect to the real chat server and establish the proxy.
   */
  private connectToRealServer(incomingSocket: Socket<SocketData>): void {
    const host = this.chatHost;
    const port = this.chatPort;

    Bun.connect<SocketData>({
      hostname: host,
      port,
      tls: { serverName: host },
      socket: {
        open: (outgoingSocket) => {
          this.pendingOutgoing.delete(outgoingSocket);
          if (this.stopped || incomingSocket.data?.closed) {
            logger.debug('Riot Client disconnected before the chat server connection was ready');
            outgoingSocket.end();
            return;
          }
          logger.debug('Connected to real chat server');
          this.establishProxiedConnection(incomingSocket, outgoingSocket);
        },
        data: (socket, data) => {
          socket.data?.proxiedConnection?.handleOutgoingData(data);
        },
        drain: (socket) => socket.data?.proxiedConnection?.flushToServer(),
        close: (socket) => {
          this.pendingOutgoing.delete(socket);
          socket.data?.proxiedConnection?.handleClose();
        },
        error: (socket, error) => {
          logger.error(`Outgoing socket error: ${error.message}`);
          this.pendingOutgoing.delete(socket);
          socket.data?.proxiedConnection?.handleClose();
        },
      },
    })
      .then((socket) => {
        // open() may already have run; only track sockets that are still being set up
        if (!socket.data?.proxiedConnection && !this.stopped && !incomingSocket.data?.closed) {
          this.pendingOutgoing.add(socket);
        }
      })
      .catch((err: unknown) => {
        logger.error(
          `Failed to connect to chat server ${host}:${port}: ${err instanceof Error ? err.message : String(err)}`
        );
        incomingSocket.end();
        if (!this.stopped) this.events.onChatServerUnreachable();
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
    this.events.onChatConnected();

    // Send introduction messages once, on the very first run (10s delay)
    if (!this.introductionShown && !this.introductionTimer) {
      this.introductionTimer = setTimeout(() => void this.sendIntroductionMessages(), 10000);
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
      this.shutdownTimer = null;
      if (this.connections.length > 0 || this.stopped) return;
      logger.info('No chat connections for 60s, shutting down');
      this.events.onIdle();
    }, IDLE_SHUTDOWN_MS);
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
    if (this.stopped) return;
    this.introductionShown = true;
    this.events.onIntroductionShown();

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

  handleChatMessage(text: string): void {
    const command = text.trim().toLowerCase();

    if (command.includes('offline')) {
      this.setStatus(PresenceStatus.Offline);
    } else if (command.includes('mobile')) {
      this.setStatus(PresenceStatus.Mobile);
    } else if (command.includes('online')) {
      this.setStatus(PresenceStatus.Online);
    } else if (command.includes('disable')) {
      this.setEnabled(false);
    } else if (command.includes('enable')) {
      this.setEnabled(true);
    } else if (command.includes('status')) {
      this.sendMessageFromFakePlayer(this.describeStatus());
    } else if (command.includes('help')) {
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
    if (this.introductionTimer) {
      clearTimeout(this.introductionTimer);
      this.introductionTimer = null;
    }
    for (const waiter of this.configWaiters) {
      clearInterval(waiter);
    }
    this.configWaiters.clear();
    for (const socket of this.pendingOutgoing) {
      socket.end();
    }
    this.pendingOutgoing.clear();

    for (const connection of [...this.connections]) {
      connection.close();
    }
    this.connections = [];

    if (this.chatServer) {
      this.chatServer.stop(true);
      this.chatServer = null;
    }
  }
}
