/**
 * System tray / menu bar icon using Electrobun's native Tray
 */

import { Tray } from 'electrobun/main';
import type { MenuItemConfig } from 'electrobun/main';
import { PresenceStatus, StartupStatus } from '../types.js';
import { getStartupStatusOption, setStartupStatusOption } from '../config/config.js';
import type { ControllerState } from '../controller.js';
import { logger } from '../utils/logger.js';
import packageJson from '../../package.json' with { type: 'json' };

export interface TrayCallbacks {
  onStatusChange: (status: PresenceStatus) => void;
  onToggleEnabled: () => void;
  onToggleMuc: () => void;
  onLaunchDifferentGame: () => void;
  onOpenLogs: () => void;
  onQuit: () => void;
}

// macOS uses one monochrome template image (36px at 144 DPI = 18pt) that the system tints for the
// menu bar. It is never swapped: Electrobun's setTrayImage drops the template flag, which would turn
// the icon black. Windows and Linux show the status with a colored badge instead.
const isMac = process.platform === 'darwin';
const MAC_ICON = 'views://icons/tray-template.png';
const ICONS: Record<PresenceStatus, string> = {
  [PresenceStatus.Offline]: 'views://icons/tray-offline.png',
  [PresenceStatus.Online]: 'views://icons/tray-online.png',
  [PresenceStatus.Mobile]: 'views://icons/tray-mobile.png',
};

const STATUS_ITEMS: [PresenceStatus, string][] = [
  [PresenceStatus.Online, 'Online'],
  [PresenceStatus.Offline, 'Offline'],
  [PresenceStatus.Mobile, 'Mobile'],
];

const STARTUP_ITEMS: [StartupStatus, string][] = [...STATUS_ITEMS, ['last', 'Remember Last']];

export class DeceiveTray {
  private tray: Tray;
  private state: ControllerState | null = null;
  private iconStatus: PresenceStatus = PresenceStatus.Offline;

  constructor(private callbacks: TrayCallbacks) {
    this.tray = new Tray({
      image: isMac ? MAC_ICON : ICONS[PresenceStatus.Offline],
      template: isMac,
      width: 18,
      height: 18,
    });
    this.tray.on('tray-clicked', (event) => this.handleClick(event));
    this.render();
  }

  /**
   * Show the state of the running session, or null while no game is running
   */
  update(state: ControllerState | null): void {
    this.state = state;
    this.render();
  }

  remove(): void {
    this.tray.remove();
  }

  private handleClick(event: unknown): void {
    const action = (event as { data?: { action?: string } }).data?.action ?? '';
    const [kind, value] = action.split(':');

    switch (kind) {
      case 'status':
        this.callbacks.onStatusChange(value as PresenceStatus);
        break;
      case 'startup':
        setStartupStatusOption(value as StartupStatus);
        this.render();
        break;
      case 'toggle-enabled':
        this.callbacks.onToggleEnabled();
        break;
      case 'toggle-muc':
        this.callbacks.onToggleMuc();
        break;
      case 'launch-different-game':
        this.callbacks.onLaunchDifferentGame();
        break;
      case 'open-logs':
        this.callbacks.onOpenLogs();
        break;
      case 'quit':
        this.callbacks.onQuit();
        break;
      default:
        logger.debug(`Unhandled tray action: ${action}`);
    }
  }

  private render(): void {
    const state = this.state;
    const running = state !== null;
    const startupOption = getStartupStatusOption();

    const menu: MenuItemConfig[] = [
      { type: 'normal', label: `Deceive v${packageJson.version}`, enabled: false },
      { type: 'separator' },
      {
        type: 'normal',
        label: 'Enabled',
        action: 'toggle-enabled',
        checked: state?.enabled ?? false,
        enabled: running,
      },
      { type: 'separator' },
      ...STATUS_ITEMS.map(
        ([status, label]): MenuItemConfig => ({
          type: 'normal',
          label,
          action: `status:${status}`,
          checked: state?.status === status,
          enabled: running,
        })
      ),
      { type: 'separator' },
      {
        type: 'normal',
        label: 'Default Status on Startup',
        submenu: STARTUP_ITEMS.map(
          ([value, label]): MenuItemConfig => ({
            type: 'normal',
            label,
            action: `startup:${value}`,
            checked: startupOption === value,
          })
        ),
      },
      {
        type: 'normal',
        label: 'Enable Lobby Chat',
        action: 'toggle-muc',
        checked: state?.connectToMuc ?? false,
        enabled: running,
      },
      { type: 'separator' },
      {
        type: 'normal',
        label: 'Restart and Launch a Different Game',
        action: 'launch-different-game',
      },
      { type: 'normal', label: 'Open Logs Folder', action: 'open-logs' },
      { type: 'separator' },
      { type: 'normal', label: 'Quit', action: 'quit' },
    ];
    this.tray.setMenu(menu);
    if (isMac) return;

    const iconStatus = state
      ? state.enabled
        ? state.status
        : PresenceStatus.Online
      : PresenceStatus.Offline;
    if (iconStatus !== this.iconStatus) {
      this.iconStatus = iconStatus;
      this.tray.setImage(ICONS[iconStatus]);
    }
  }
}
