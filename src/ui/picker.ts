/**
 * Game picker window, like the original Deceive's game prompt
 */

import { BrowserView, BrowserWindow } from 'electrobun/main';
import { LaunchGame } from '../types.js';
import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';
import type { PickerRPC } from '../shared/rpc.js';

/**
 * Show the game picker. Resolves with the chosen game, or null if the window was closed.
 */
export function pickGame(): Promise<LaunchGame | null> {
  return new Promise((resolve) => {
    let settled = false;
    let window: BrowserWindow | null = null;

    const finish = (game: LaunchGame | null) => {
      if (settled) return;
      settled = true;
      resolve(game);
    };

    const rpc = BrowserView.defineRPC<PickerRPC>({
      handlers: {
        requests: {
          chooseGame: ({ game, remember }) => {
            logger.info(`Game selected: ${game}${remember ? ' (remembered)' : ''}`);
            if (remember) {
              config.set('defaultGame', game);
            }
            finish(game);
            setTimeout(() => window?.close(), 0);
          },
        },
        messages: {},
      },
    });

    window = new BrowserWindow({
      title: 'Deceive',
      url: 'views://picker/index.html',
      frame: { width: 480, height: 380 },
      rpc,
    });

    window.on('close', () => finish(null));
  });
}
