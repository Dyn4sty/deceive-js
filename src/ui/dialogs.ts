/**
 * Native dialogs and notifications
 */

import { Utils } from 'electrobun/main';
import type { StartupUI } from '../startup.js';
import { pickGame } from './picker.js';

const TITLE = 'Deceive';

export async function confirm(message: string, detail?: string): Promise<boolean> {
  const { response } = await Utils.showMessageBox({
    type: 'question',
    title: TITLE,
    message,
    detail,
    buttons: ['OK', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0;
}

export async function warn(
  message: string,
  detail?: string,
  link?: { label: string; url: string }
): Promise<void> {
  const buttons = link ? [link.label, 'OK'] : ['OK'];
  const { response } = await Utils.showMessageBox({
    type: 'warning',
    title: TITLE,
    message,
    detail,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  });
  if (link && response === 0) {
    Utils.openExternal(link.url);
  }
}

export async function error(message: string, detail?: string): Promise<void> {
  await Utils.showMessageBox({
    type: 'error',
    title: TITLE,
    message,
    detail,
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0,
  });
}

/**
 * Error with Retry/Quit buttons. Resolves true for Retry.
 */
export async function retryOrQuit(message: string, detail?: string): Promise<boolean> {
  const { response } = await Utils.showMessageBox({
    type: 'error',
    title: TITLE,
    message,
    detail,
    buttons: ['Retry', 'Quit'],
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0;
}

export function notify(title: string, body: string): void {
  Utils.showNotification({ title, body, silent: true });
}

export const nativeUI: StartupUI = {
  confirm,
  warn,
  error,
  notify,
  pickGame,
};
