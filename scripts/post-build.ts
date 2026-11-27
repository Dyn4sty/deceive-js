/**
 * Electrobun postBuild hook: add app details to the built (not yet wrapped) app.
 *
 * - Windows: version info and icon on bin/launcher.exe, the executable users run
 * - macOS: version string, copyright and menu-bar-only flag in Info.plist
 */

import { appVersion, applyMacAppDetails, findAppBundles, findFiles } from './hook-utils.ts';
import { applyWindowsDetails } from './windows-version-info.ts';

const buildDir = process.env.ELECTROBUN_BUILD_DIR;

if (process.env.ELECTROBUN_OS === 'win') {
  const launchers = findFiles(buildDir, (name) => name.toLowerCase() === 'launcher.exe');
  if (launchers.length === 0) console.warn(`postBuild: no launcher.exe found under ${buildDir}`);
  for (const exe of launchers) {
    applyWindowsDetails(exe, { description: 'Deceive', version: appVersion });
    console.log(`postBuild: added version info to ${exe}`);
  }
}

if (process.env.ELECTROBUN_OS === 'macos') {
  const apps = findAppBundles(buildDir);
  if (apps.length === 0) console.warn(`postBuild: no .app found in ${buildDir}`);
  for (const app of apps) applyMacAppDetails(app);
}
