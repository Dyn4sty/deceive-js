/**
 * Helpers shared by the Electrobun build hooks
 */

import { spawnSync } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import packageJson from '../package.json' with { type: 'json' };
import { COPYRIGHT, PRODUCT } from './windows-version-info.ts';

export const appVersion = process.env.ELECTROBUN_APP_VERSION || packageJson.version;

/**
 * Files below `dir` (recursively) whose name matches, skipping macOS bundle internals of other apps
 */
export function findFiles(dir: string | undefined, matches: (name: string) => boolean): string[] {
  if (!dir || !existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
    const name = entry.split(/[\\/]/).pop() ?? '';
    if (matches(name)) found.push(join(dir, entry));
  }
  return found;
}

/**
 * App bundles directly inside `dir`
 */
export function findAppBundles(dir: string | undefined): string[] {
  if (!dir || !existsSync(dir)) return [];
  if (dir.endsWith('.app')) return [dir];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.app') && statSync(join(dir, name)).isDirectory())
    .map((name) => join(dir, name));
}

function plutil(args: string[]): void {
  const result = spawnSync('plutil', args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`plutil ${args.join(' ')} failed`);
}

/**
 * Add the version string, display name, copyright, minimum macOS and menu-bar-only flag to Info.plist
 */
export function applyMacAppDetails(appPath: string): void {
  const plist = join(appPath, 'Contents', 'Info.plist');
  if (!existsSync(plist)) {
    console.warn(`No Info.plist in ${appPath}`);
    return;
  }
  plutil(['-replace', 'CFBundleShortVersionString', '-string', appVersion, plist]);
  plutil(['-replace', 'CFBundleDisplayName', '-string', PRODUCT, plist]);
  plutil(['-replace', 'NSHumanReadableCopyright', '-string', COPYRIGHT, plist]);
  plutil(['-replace', 'LSMinimumSystemVersion', '-string', '14.0', plist]);
  // Menu bar app: no Dock icon, not even briefly before the app hides it
  plutil(['-replace', 'LSUIElement', '-bool', 'YES', plist]);
  console.log(`Added app details to ${plist}`);
}
