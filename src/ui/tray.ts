/**
 * System Tray Interface
 *
 * Implements system tray using systray2 library.
 */

import { PresenceStatus, StartupStatus } from '../types.js';
import { logger } from '../utils/logger.js';
import { getStartupStatusOption, setStartupStatusOption } from '../config/config.js';
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import SysTrayModule from 'systray2';
import systrayPkg from 'systray2/package.json' with { type: 'json' };
import packageJson from '../../package.json' with { type: 'json' };

// Import icon files for embedding in compiled executables
// @ts-expect-error - Icon files are embedded in the compiled executable
import offlineIcoPath from '../../assets/icons/offline.ico' with { type: 'file' };
// @ts-expect-error - Icon files are embedded in the compiled executable
import mobileIcoPath from '../../assets/icons/mobile.ico' with { type: 'file' };
// @ts-expect-error - Icon files are embedded in the compiled executable
import onlineIcoPath from '../../assets/icons/online.ico' with { type: 'file' };
// @ts-expect-error - Icon files are embedded in the compiled executable
import offlinePngPath from '../../assets/icons/offline.png' with { type: 'file' };
// @ts-expect-error - Icon files are embedded in the compiled executable
import mobilePngPath from '../../assets/icons/mobile.png' with { type: 'file' };
// @ts-expect-error - Icon files are embedded in the compiled executable
import onlinePngPath from '../../assets/icons/online.png' with { type: 'file' };

// systray2 spawns a native helper from its traybin folder, which does not exist inside a
// compiled executable, so the helpers are embedded and extracted to systray2's copyDir cache.
// The macOS helper is a universal build from scripts/build-tray-darwin.sh, since systray2's is x86_64-only.
// @ts-expect-error - Tray helper binaries are embedded in the compiled executable
import trayBinDarwin from '../../assets/traybin/tray_darwin_release' with { type: 'file' };
// @ts-expect-error - Tray helper binaries are embedded in the compiled executable
import trayBinLinux from 'systray2/traybin/tray_linux_release' with { type: 'file' };
// @ts-expect-error - Tray helper binaries are embedded in the compiled executable
import trayBinWindows from 'systray2/traybin/tray_windows_release.exe' with { type: 'file' };

// systray2 is CommonJS with `exports.default`; depending on the bundler's interop the default
// import is either the class itself or the whole exports object.
type SysTrayClass = typeof SysTrayModule.default;
type SysTrayInstance = InstanceType<SysTrayClass>;
const SysTray: SysTrayClass =
  (SysTrayModule as { default?: SysTrayClass }).default ??
  (SysTrayModule as unknown as SysTrayClass);

interface MenuItem {
  title: string;
  tooltip: string;
  checked?: boolean;
  enabled?: boolean;
  hidden?: boolean;
  items?: MenuItem[];
  click?: () => void;
}

export interface TrayState {
  status: PresenceStatus;
  enabled: boolean;
  connectToMuc: boolean;
}

export interface TrayCallbacks {
  onStatusChange: (status: PresenceStatus) => void;
  onToggleEnabled: () => void;
  onToggleMuc: () => void;
  onQuit: () => void;
}

const isWindows = process.platform === 'win32';

let systray: SysTrayInstance | null = null;
let state: TrayState = {
  status: PresenceStatus.Offline,
  enabled: true,
  connectToMuc: true,
};
let currentIconStatus: PresenceStatus | null = null;

let enabledItem: MenuItem;
let statusItems: Record<PresenceStatus, MenuItem>;
let startupItems: Record<StartupStatus, MenuItem>;
let mucItem: MenuItem;

/**
 * Get icon path for a given status
 * Windows needs .ico, macOS and Linux need .png
 */
export function getIconPath(status: PresenceStatus): string {
  const icons: Record<PresenceStatus, string> = isWindows
    ? {
        [PresenceStatus.Offline]: offlineIcoPath as string,
        [PresenceStatus.Mobile]: mobileIcoPath as string,
        [PresenceStatus.Online]: onlineIcoPath as string,
      }
    : {
        [PresenceStatus.Offline]: offlinePngPath as string,
        [PresenceStatus.Mobile]: mobilePngPath as string,
        [PresenceStatus.Online]: onlinePngPath as string,
      };
  return icons[status] ?? icons[PresenceStatus.Offline];
}

/**
 * Get icon as base64 string for systray
 * Works with both embedded files (compiled) and filesystem paths (development)
 */
async function getIconBase64(status: PresenceStatus): Promise<string> {
  try {
    const iconPath = getIconPath(status);
    if (typeof Bun !== 'undefined') {
      return Buffer.from(await Bun.file(iconPath).arrayBuffer()).toString('base64');
    }
    if (existsSync(iconPath)) {
      return readFileSync(iconPath).toString('base64');
    }
  } catch (err: unknown) {
    logger.debug(`Failed to load icon: ${err instanceof Error ? err.message : String(err)}`);
  }
  return '';
}

/**
 * Extract the embedded tray helper to the path systray2 checks before copying from traybin
 */
async function extractTrayBinary(): Promise<void> {
  const helpers: Partial<Record<NodeJS.Platform, [string, string]>> = {
    darwin: ['tray_darwin_release', trayBinDarwin as string],
    linux: ['tray_linux_release', trayBinLinux as string],
    win32: ['tray_windows_release.exe', trayBinWindows as string],
  };
  const helper = helpers[process.platform];
  if (!helper) return;

  const [binName, embeddedPath] = helper;
  const cacheDir = join(homedir(), '.cache', 'node-systray', systrayPkg.version);
  const target = join(cacheDir, binName);
  const data = Buffer.from(await Bun.file(embeddedPath).arrayBuffer());

  if (existsSync(target) && readFileSync(target).equals(data)) return;

  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(target, data);
  chmodSync(target, 0o755);
}

const separator = (): MenuItem => ({ title: '<SEPARATOR>', tooltip: '', enabled: true });

function buildMenu(callbacks: TrayCallbacks): MenuItem[] {
  const titleItem: MenuItem = {
    title: `Deceive v${packageJson.version}`,
    tooltip: '',
    enabled: false,
  };

  enabledItem = {
    title: 'Enabled',
    tooltip: 'Mask your status. Disable to appear with your real status.',
    checked: state.enabled,
    enabled: true,
    click: () => callbacks.onToggleEnabled(),
  };

  const statusItem = (status: PresenceStatus, title: string, tooltip: string): MenuItem => ({
    title,
    tooltip,
    checked: state.status === status,
    enabled: true,
    click: () => callbacks.onStatusChange(status),
  });

  statusItems = {
    [PresenceStatus.Online]: statusItem(PresenceStatus.Online, 'Online', 'Appear online'),
    [PresenceStatus.Offline]: statusItem(
      PresenceStatus.Offline,
      'Offline',
      'Appear offline to friends'
    ),
    [PresenceStatus.Mobile]: statusItem(PresenceStatus.Mobile, 'Mobile', 'Appear on mobile app'),
  };

  const startupItem = (value: StartupStatus, title: string): MenuItem => ({
    title,
    tooltip: '',
    checked: getStartupStatusOption() === value,
    enabled: true,
    click: () => {
      setStartupStatusOption(value);
      updateStartupItems();
    },
  });

  startupItems = {
    [PresenceStatus.Online]: startupItem(PresenceStatus.Online, 'Online'),
    [PresenceStatus.Offline]: startupItem(PresenceStatus.Offline, 'Offline'),
    [PresenceStatus.Mobile]: startupItem(PresenceStatus.Mobile, 'Mobile'),
    last: startupItem('last', 'Remember Last'),
  };

  const startupMenu: MenuItem = {
    title: 'Default Status on Startup',
    tooltip: '',
    enabled: true,
    items: [
      startupItems[PresenceStatus.Online],
      startupItems[PresenceStatus.Offline],
      startupItems[PresenceStatus.Mobile],
      startupItems.last,
    ],
  };

  mucItem = {
    title: 'Enable Lobby Chat',
    tooltip: 'Keep your presence in lobby/champion select chat rooms',
    checked: state.connectToMuc,
    enabled: true,
    click: () => callbacks.onToggleMuc(),
  };

  const quitItem: MenuItem = {
    title: 'Quit',
    tooltip: 'Exit Deceive',
    enabled: true,
    click: () => callbacks.onQuit(),
  };

  return [
    titleItem,
    separator(),
    enabledItem,
    separator(),
    statusItems[PresenceStatus.Online],
    statusItems[PresenceStatus.Offline],
    statusItems[PresenceStatus.Mobile],
    separator(),
    startupMenu,
    mucItem,
    separator(),
    quitItem,
  ];
}

function sendItem(item: MenuItem): void {
  if (!systray) return;
  systray.sendAction({ type: 'update-item', item }).catch((err: Error) => {
    logger.debug(`Failed to update tray item "${item.title}": ${err.message}`);
  });
}

const STATUSES = [PresenceStatus.Online, PresenceStatus.Offline, PresenceStatus.Mobile];
const STARTUP_OPTIONS: StartupStatus[] = [...STATUSES, 'last'];

function updateStartupItems(): void {
  const option = getStartupStatusOption();
  for (const value of STARTUP_OPTIONS) {
    startupItems[value].checked = value === option;
    sendItem(startupItems[value]);
  }
}

/**
 * Create system tray icon
 */
export async function createTray(initialState: TrayState, callbacks: TrayCallbacks): Promise<void> {
  state = { ...initialState };

  try {
    await extractTrayBinary();
    const icon = await getIconBase64(state.status);
    currentIconStatus = state.status;

    const instance = new SysTray({
      menu: {
        icon,
        isTemplateIcon: false,
        // macOS shows the title next to the menu bar icon
        title: process.platform === 'darwin' ? '' : 'Deceive',
        tooltip: 'Deceive - Appear Offline',
        items: buildMenu(callbacks),
      },
      debug: false,
      copyDir: true,
    });
    systray = instance;

    void instance.onClick((action) => {
      (action.item as MenuItem).click?.();
    });

    await instance.ready();
    // The helper process only exists once ready() resolves
    instance.onError((err) => {
      logger.warn(`System tray error: ${err.message}`);
    });
    logger.info('System tray initialized');
  } catch (err) {
    systray = null;
    logger.warn(
      `System tray initialization failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Sync tray menu and icon with the controller state
 */
export function updateTray(newState: TrayState): void {
  state = { ...newState };
  if (!systray) return;

  enabledItem.checked = state.enabled;
  sendItem(enabledItem);

  for (const status of STATUSES) {
    statusItems[status].checked = status === state.status;
    sendItem(statusItems[status]);
  }

  mucItem.checked = state.connectToMuc;
  sendItem(mucItem);

  const iconStatus = state.enabled ? state.status : PresenceStatus.Online;
  if (iconStatus !== currentIconStatus) {
    currentIconStatus = iconStatus;
    void getIconBase64(iconStatus).then((icon) => {
      systray
        ?.sendAction({
          type: 'update-menu',
          menu: {
            icon,
            isTemplateIcon: false,
            title: process.platform === 'darwin' ? '' : 'Deceive',
            tooltip: 'Deceive - Appear Offline',
            items: [],
          },
        })
        .catch((err: Error) => logger.debug(`Failed to update tray icon: ${err.message}`));
    });
  }
}

/**
 * Destroy tray icon
 */
export function destroyTray(): void {
  if (!systray) return;
  try {
    void systray.kill(false);
  } catch (err) {
    logger.debug(`Error destroying tray: ${err instanceof Error ? err.message : String(err)}`);
  }
  systray = null;
  logger.debug('Tray destroyed');
}
