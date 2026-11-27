/**
 * Build the single-file Windows installer from Electrobun's setup zip, then check that all
 * Windows executables carry version info.
 *
 * Run on Windows after `hutch electrobun build`:  bun scripts/package-windows.ts
 * Produces artifacts/<zip name>.exe next to artifacts/<...>-Setup<...>.zip.
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import packageJson from '../package.json' with { type: 'json' };
import { applyWindowsDetails, COPYRIGHT, readWindowsDetails } from './windows-version-info.ts';

const root = join(import.meta.dir, '..');
const artifacts = join(root, 'artifacts');
const staging = join(root, 'build-generated', 'windows-setup');
const checkDir = join(root, 'build-generated', 'windows-check');
const version = packageJson.version;

function fail(message: string): never {
  console.error(`package-windows: ${message}`);
  process.exit(1);
}

function run(command: string, args: string[]): void {
  console.log(`> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) fail(`${basename(command)} failed with exit code ${result.status}`);
}

// Windows' own bsdtar reads zip files; another tar earlier on PATH (Git's GNU tar) may not
const tar =
  process.platform === 'win32' && existsSync('C:\\Windows\\System32\\tar.exe')
    ? 'C:\\Windows\\System32\\tar.exe'
    : 'tar';

function findMakensis(): string {
  if (spawnSync('makensis', ['/VERSION']).status === 0) return 'makensis';
  for (const candidate of [
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
    'C:\\Program Files\\NSIS\\makensis.exe',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  fail('makensis not found; install NSIS (choco install nsis)');
}

const zipName = existsSync(artifacts)
  ? readdirSync(artifacts).find((name) => /Deceive-Setup.*\.zip$/i.test(name))
  : undefined;
if (!zipName) fail(`no Deceive-Setup zip in ${artifacts}`);
const zipPath = join(artifacts, zipName);
const exePath = join(artifacts, zipName.replace(/\.zip$/i, '.exe'));

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
run(tar, ['-xf', zipPath, '-C', staging]);

// Deceive-Setup.exe (stable) or Deceive-Setup-canary.exe (canary)
const setupName = readdirSync(staging).find((name) => /setup.*\.exe$/i.test(name));
if (!setupName) fail('no setup executable in the zip');
const setupPath = join(staging, setupName);

// Electrobun creates the setup executable after the postWrap hook, so its details are added here
applyWindowsDetails(setupPath, { description: 'Deceive Setup', version });
rmSync(zipPath);
run(tar, ['-a', '-c', '-f', zipPath, '-C', staging, setupName, '.installer']);
console.log(`Added version info to ${setupName} and rebuilt ${zipName}`);

const [major = 0, minor = 0, patch = 0] = version
  .split(/[.+-]/)
  .map((n) => Number.parseInt(n, 10) || 0);
run(findMakensis(), [
  `/DSOURCE=${staging}`,
  `/DSETUPEXE=${setupName}`,
  `/DOUTFILE=${exePath}`,
  `/DICON=${join(root, 'assets', 'icons', 'app.ico')}`,
  `/DVERSION=${version}`,
  `/DVIVERSION=${major}.${minor}.${patch}.0`,
  `/DCOPYRIGHT=${COPYRIGHT}`,
  join(root, 'installer', 'windows', 'deceive.nsi'),
]);
if (!existsSync(exePath)) fail(`makensis did not produce ${exePath}`);
console.log(`Built ${exePath}`);

// The installed app's launcher is inside the setup payload (.installer/*.tar.zst)
const payloadDir = join(staging, '.installer');
const payload = existsSync(payloadDir)
  ? readdirSync(payloadDir).find((name) => name.endsWith('.tar.zst'))
  : undefined;
const exes: [string, string][] = [
  ['installer', exePath],
  ['Electrobun setup', setupPath],
];
if (payload) {
  rmSync(checkDir, { recursive: true, force: true });
  const extracted = join(checkDir, 'payload');
  const tarPath = join(checkDir, 'payload.tar');
  mkdirSync(extracted, { recursive: true });
  writeFileSync(tarPath, Bun.zstdDecompressSync(await Bun.file(join(payloadDir, payload)).bytes()));
  run(tar, ['-xf', tarPath, '-C', extracted]);
  const launcher = readdirSync(extracted, { recursive: true }).find((entry) =>
    String(entry).toLowerCase().endsWith('launcher.exe')
  );
  if (launcher) exes.push(['app launcher', join(extracted, String(launcher))]);
}

let missing = false;
for (const [label, path] of exes) {
  const details = readWindowsDetails(path);
  console.log(`${label} (${basename(path)}):`, details);
  if (details['CompanyName'] !== 'League Deceiver') missing = true;
}
if (exes.length < 3) fail('could not find the app launcher in the setup payload');
if (missing) fail('version info is missing on at least one executable');
