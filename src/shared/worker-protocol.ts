/**
 * Messages between the main thread and the proxy worker
 */

import type { ControllerState } from '../controller.js';
import type { PresenceStatus } from '../types.js';

export interface ProxyStartOptions {
  status: PresenceStatus;
  connectToMuc: boolean;
  introductionShown: boolean;
  certificate: { certificate: string; privateKey: string };
  /** Whether `certificate` is the trusted certificate for the localhost domain */
  trustedCertificate: boolean;
  logFile: string | null;
  debug: boolean;
}

export type MainToWorker =
  | { type: 'start'; options: ProxyStartOptions }
  | { type: 'setStatus'; status: PresenceStatus }
  | { type: 'toggleEnabled' }
  | { type: 'toggleMuc' }
  | { type: 'stop' };

export type WorkerToMain =
  | { type: 'started'; chatPort: number; configPort: number; state: ControllerState }
  | { type: 'state'; state: ControllerState }
  | { type: 'chatConfigured' }
  | { type: 'chatConnected' }
  | { type: 'chatUnreachable' }
  | { type: 'idle' }
  | { type: 'introductionShown' }
  | { type: 'configRewriteFailed'; message: string }
  | { type: 'fatal'; message: string }
  | { type: 'stopped' };
