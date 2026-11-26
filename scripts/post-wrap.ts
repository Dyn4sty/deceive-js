/**
 * Electrobun postWrap hook: give the macOS release wrapper a valid ad-hoc signature.
 *
 * Without a Developer ID, the wrapper only carries the linker's partial ad-hoc signature, which
 * macOS reports as "damaged" for downloaded apps. A complete ad-hoc signature turns that into
 * the normal "Apple could not verify" prompt, which users can allow in Privacy & Security.
 */

import { spawnSync } from 'child_process';

if (process.env.ELECTROBUN_OS !== 'macos') process.exit(0);

const app = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH;
if (!app) throw new Error('ELECTROBUN_WRAPPER_BUNDLE_PATH is not set');

function run(args: string[]): void {
  const result = spawnSync('codesign', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`codesign ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

run(['--force', '--deep', '--sign', '-', app]);
run(['--verify', '--deep', '--strict', '--verbose=2', app]);
console.log(`Ad-hoc signed ${app}`);
