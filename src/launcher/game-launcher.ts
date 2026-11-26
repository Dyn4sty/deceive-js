/**
 * Game Launcher - Launch Riot games with proxy configuration
 */

import { spawn } from 'child_process';
import { logger } from '../utils/logger.js';

/**
 * Launch Riot Client with our config proxy. Resolves with an error message if it failed to start.
 */
export function launchRiotClient(
  riotClientPath: string,
  configProxyPort: number,
  product: string | null,
  patchline: string
): Promise<string | null> {
  const args: string[] = [`--client-config-url=http://127.0.0.1:${configProxyPort}`];

  if (product) {
    args.push(`--launch-product=${product}`);
    args.push(`--launch-patchline=${patchline}`);
    // Skip the Riot Client UI and launch the game directly
    args.push('--allow-direct-launch');
  }

  logger.info(`Launching Riot Client with args: ${args.join(' ')}`);

  return new Promise((resolve) => {
    const child = spawn(riotClientPath, args, {
      detached: true,
      stdio: 'ignore',
    });

    child.once('spawn', () => {
      logger.info('Riot Client launched successfully');
      child.unref();
      resolve(null);
    });

    child.once('error', (err) => {
      logger.error('Failed to launch Riot Client:', err);
      resolve(err.message);
    });

    child.on('exit', (code) => {
      if (code !== null && code !== 0) {
        logger.warn(`Riot Client exited with code ${code}`);
      }
    });
  });
}
