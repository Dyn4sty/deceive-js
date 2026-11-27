/**
 * Electrobun postWrap hook (macOS): add app details to the release wrapper's Info.plist, then give
 * it a complete ad-hoc signature.
 *
 * Without a Developer ID the wrapper only carries the linker's partial ad-hoc signature, which
 * macOS reports as "damaged" for downloaded apps; a complete one turns that into the normal
 * "Apple could not verify" prompt, which users can allow in Privacy & Security.
 *
 * On Windows, Electrobun creates the setup executable after this hook runs, so its details are
 * added by scripts/package-windows.ts instead.
 */

import { spawnSync } from 'child_process';
import { applyMacAppDetails, findAppBundles } from './hook-utils.ts';

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
