#!/usr/bin/env node
/**
 * League Deceiver - Appear offline in League of Legends, VALORANT, and Legends of Runeterra
 *
 * A TypeScript/Node.js port of the original Deceive application.
 * https://github.com/molenzwiebel/Deceive
 */

import { program } from 'commander';
import { startDeceive } from './startup.js';
import { LaunchGame } from './types.js';
import { logger } from './utils/logger.js';
import packageJson from '../package.json' with { type: 'json' };

const GAME_MAP: Record<string, LaunchGame> = {
  lol: LaunchGame.LoL,
  tft: LaunchGame.TFT,
  valorant: LaunchGame.VALORANT,
  lor: LaunchGame.LoR,
  lion: LaunchGame.Lion,
  'riot-client': LaunchGame.RiotClient,
  prompt: LaunchGame.Prompt,
  auto: LaunchGame.Auto,
};

program
  .name('league-deceiver')
  .description('Appear offline in League of Legends, VALORANT, and Legends of Runeterra')
  .version(packageJson.version);

program
  .command('launch')
  .description('Launch a game with offline status')
  .argument(
    '[game]',
    'Game to launch: lol, tft, valorant, lor, lion, riot-client, prompt, or auto',
    'auto'
  )
  .option(
    '-s, --status <status>',
    'Initial status: offline, online, mobile, or prompt (default: the configured startup status)'
  )
  .option('--no-tray', 'Do not show the system tray icon')
  .option('-p, --patchline <patchline>', 'Patchline to use', 'live')
  .action(async (game: string, options: { status?: string; tray: boolean; patchline: string }) => {
    const launchGame = GAME_MAP[game.toLowerCase()] ?? LaunchGame.Prompt;
    await startDeceive(launchGame, options.status ?? null, options.patchline, options.tray);
  });

// If no arguments provided (double-clicked), use the saved default game and startup status
if (process.argv.length === 2) {
  startDeceive(LaunchGame.Auto, null, 'live', true).catch((err: unknown) => {
    logger.error(`Error starting Deceive: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
} else {
  program.parse();
}
