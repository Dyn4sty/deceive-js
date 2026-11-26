/**
 * Process name matching tests
 */

import { describe, it, expect } from 'bun:test';
import { processBaseName } from '../../src/launcher/process-manager.js';

describe('processBaseName', () => {
  it('extracts the executable name from macOS paths', () => {
    expect(processBaseName('/Applications/Riot Client.app/Contents/MacOS/RiotClientServices')).toBe(
      'riotclientservices'
    );
  });

  it('strips .exe from Windows names', () => {
    expect(processBaseName('LeagueClient.exe')).toBe('leagueclient');
    expect(processBaseName('C:\\Riot Games\\LoR\\LoR.exe')).toBe('lor');
  });

  it('does not match processes that only contain a Riot name', () => {
    expect(processBaseName('/System/Library/CoreServices/ColorSync')).not.toBe('lor');
  });
});
