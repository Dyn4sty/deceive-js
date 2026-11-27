/**
 * Windows executable details (version info resource and icon), editable from any OS.
 *
 * Electrobun does not set version info on its Windows executables, so Explorer shows no
 * company, description or version for them.
 */

import * as ResEdit from 'resedit';
import { readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

export const COMPANY = 'League Deceiver';
export const PRODUCT = 'Deceive';
export const COPYRIGHT = `(c) ${new Date().getFullYear()} League Deceiver contributors`;

const LANG = 1033; // en-US
const CODEPAGE = 1200; // Unicode

const root = join(import.meta.dir, '..');

/**
 * "2.1.1" or "2.1.1-beta.1" -> [2, 1, 1, 0]
 */
function versionParts(version: string): [number, number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
  return [major, minor, patch, 0];
}

export interface ExeDetails {
  description: string;
  version: string;
}

/**
 * Set CompanyName, ProductName, FileDescription, versions and copyright on an executable,
 * and add the app icon if the executable has none.
 */
export function applyWindowsDetails(exePath: string, { description, version }: ExeDetails): void {
  const exe = ResEdit.NtExecutable.from(readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  const info =
    ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] ??
    ResEdit.Resource.VersionInfo.createEmpty();
  const [major, minor, patch, build] = versionParts(version);
  info.setFileVersion(major, minor, patch, build, LANG);
  info.setProductVersion(major, minor, patch, build, LANG);
  info.setStringValues(
    { lang: LANG, codepage: CODEPAGE },
    {
      CompanyName: COMPANY,
      ProductName: PRODUCT,
      FileDescription: description,
      FileVersion: `${major}.${minor}.${patch}.${build}`,
      ProductVersion: version,
      LegalCopyright: COPYRIGHT,
      OriginalFilename: basename(exePath),
      InternalName: basename(exePath).replace(/\.exe$/i, ''),
    }
  );
  info.outputToResourceEntries(res.entries);

  if (ResEdit.Resource.IconGroupEntry.fromEntries(res.entries).length === 0) {
    const icon = ResEdit.Data.IconFile.from(readFileSync(join(root, 'assets/icons/app.ico')));
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      1,
      LANG,
      icon.icons.map((item) => item.data)
    );
  }

  res.outputResource(exe);
  writeFileSync(exePath, Buffer.from(exe.generate()));
}

/**
 * Read the string version info of an executable (empty object if it has none)
 */
export function readWindowsDetails(exePath: string): Record<string, string> {
  const exe = ResEdit.NtExecutable.from(readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const info = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  if (!info) return {};
  const [language] = info.getAllLanguagesForStringValues();
  const values: Record<string, string> = language ? { ...info.getStringValues(language) } : {};
  values['(icon groups)'] = String(ResEdit.Resource.IconGroupEntry.fromEntries(res.entries).length);
  return values;
}
