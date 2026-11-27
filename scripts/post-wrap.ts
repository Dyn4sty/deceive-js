/**
 * Electrobun postWrap hook: finish the release wrapper before it is packaged.
 *
 * - macOS: add app details to Info.plist, then give the wrapper a complete ad-hoc signature.
 *   Without a Developer ID it only carries the linker's partial ad-hoc signature, which macOS
 *   reports as "damaged" for downloaded apps; a complete one turns that into the normal
 *   "Apple could not verify" prompt, which users can allow in Privacy & Security.
 * - Windows: version info and icon on Deceive-Setup.exe
 */

import { spawnSync } from 'child_process';
import { appVersion, applyMacAppDetails, findAppBundles, findFiles } from './hook-utils.ts';
import { applyWindowsDetails } from './windows-version-info.ts';

const wrapper = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH;

if (process.env.ELECTROBUN_OS === 'macos') {
  if (!wrapper) throw new Error('ELECTROBUN_WRAPPER_BUNDLE_PATH is not set');

  for (const app of findAppBundles(wrapper)) applyMacAppDetails(app);

  const codesign = (args: string[]) => {
    const result = spawnSync('codesign', args, { stdio: 'inherit' });
    if (result.status !== 0) {
      throw new Error(`codesign ${args.join(' ')} failed with exit code ${result.status}`);
    }
  };
  codesign(['--force', '--deep', '--sign', '-', wrapper]);
  codesign(['--verify', '--deep', '--strict', '--verbose=2', wrapper]);
  console.log(`Ad-hoc signed ${wrapper}`);
}

if (process.env.ELECTROBUN_OS === 'win') {
  const isSetup = (name: string) => /-setup.*\.exe$/i.test(name);
  let setups = findFiles(wrapper, isSetup);
  if (setups.length === 0) setups = findFiles(process.env.ELECTROBUN_BUILD_DIR, isSetup);
  if (setups.length === 0) console.warn(`postWrap: no *-Setup.exe found under ${wrapper}`);
  for (const exe of setups) {
    applyWindowsDetails(exe, { description: 'Deceive Setup', version: appVersion });
    console.log(`postWrap: added version info to ${exe}`);
  }
}
