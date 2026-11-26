/**
 * Main-thread handle for the proxy worker
 */

import { EventEmitter } from 'events';
import type { ControllerState } from '../controller.js';
import type { PresenceStatus } from '../types.js';
import { logger } from '../utils/logger.js';
import type { MainToWorker, ProxyStartOptions, WorkerToMain } from '../shared/worker-protocol.js';

const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 2_000;

interface ProxyClientEvents {
  state: (state: ControllerState) => void;
  chatConfigured: () => void;
  chatConnected: () => void;
  chatUnreachable: () => void;
  idle: () => void;
  introductionShown: () => void;
  configRewriteFailed: (message: string) => void;
  /** The worker crashed or exited unexpectedly */
  crashed: (message: string) => void;
}

export class ProxyClient extends EventEmitter {
  readonly chatPort: number;
  readonly configPort: number;
  private state: ControllerState;
  private stopping = false;

  private constructor(
    private worker: Worker,
    started: Extract<WorkerToMain, { type: 'started' }>
  ) {
    super();
    this.chatPort = started.chatPort;
    this.configPort = started.configPort;
    this.state = started.state;

    worker.onmessage = (event: MessageEvent<WorkerToMain>) => this.handleMessage(event.data);
    worker.onerror = (event) => {
      logger.error(`Proxy worker error: ${event.message}`);
      if (!this.stopping) this.emit('crashed', event.message);
    };
    worker.addEventListener('close', () => {
      if (!this.stopping) this.emit('crashed', 'The proxy worker exited unexpectedly');
    });
  }

  /**
   * Start the worker and the proxies inside it
   */
  static start(workerPath: string, options: ProxyStartOptions): Promise<ProxyClient> {
    const worker = new Worker(workerPath);

    return new Promise((resolve, reject) => {
      const fail = (message: string) => {
        clearTimeout(timeout);
        worker.terminate();
        reject(new Error(message));
      };
      const timeout = setTimeout(
        () => fail('The proxy worker did not start in time'),
        START_TIMEOUT_MS
      );

      worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
        const message = event.data;
        if (message.type === 'started') {
          clearTimeout(timeout);
          resolve(new ProxyClient(worker, message));
        } else if (message.type === 'fatal') {
          fail(message.message);
        }
      };
      worker.onerror = (event) => fail(event.message || 'The proxy worker failed to load');

      worker.postMessage({ type: 'start', options } satisfies MainToWorker);
    });
  }

  private handleMessage(message: WorkerToMain): void {
    switch (message.type) {
      case 'state':
        this.state = message.state;
        this.emit('state', message.state);
        break;
      case 'configRewriteFailed':
        this.emit('configRewriteFailed', message.message);
        break;
      case 'fatal':
        this.emit('crashed', message.message);
        break;
      case 'chatConfigured':
      case 'chatConnected':
      case 'chatUnreachable':
      case 'idle':
      case 'introductionShown':
        this.emit(message.type);
        break;
      case 'started':
      case 'stopped':
        break;
    }
  }

  private post(message: MainToWorker): void {
    if (!this.stopping) this.worker.postMessage(message);
  }

  getState(): ControllerState {
    return this.state;
  }

  setStatus(status: PresenceStatus): void {
    this.post({ type: 'setStatus', status });
  }

  toggleEnabled(): void {
    this.post({ type: 'toggleEnabled' });
  }

  toggleConnectToMuc(): void {
    this.post({ type: 'toggleMuc' });
  }

  /**
   * Stop the proxies and the worker. Resolves once the worker has shut down (or timed out).
   */
  stop(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.post({ type: 'stop' });
    this.stopping = true;

    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timeout);
        this.worker.terminate();
        resolve();
      };
      const timeout = setTimeout(finish, STOP_TIMEOUT_MS);
      this.worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
        if (event.data.type === 'stopped') finish();
      };
    });
  }

  override on<K extends keyof ProxyClientEvents>(event: K, listener: ProxyClientEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof ProxyClientEvents>(
    event: K,
    ...args: Parameters<ProxyClientEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}
