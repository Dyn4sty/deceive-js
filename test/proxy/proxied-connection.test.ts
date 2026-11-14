/**
 * Presence rewriting tests
 */

import { describe, it, expect } from 'bun:test';
import type { Socket } from 'bun';
import { ProxiedConnection } from '../../src/proxy/proxied-connection.js';
import type { MainController } from '../../src/controller.js';
import { PresenceStatus } from '../../src/types.js';

type SocketData = { proxiedConnection?: ProxiedConnection };

function setup(status: PresenceStatus, connectToMuc = true) {
  const written: string[] = [];
  const outgoing = {
    write: (data: Buffer | Uint8Array) => written.push(Buffer.from(data).toString('utf-8')),
    end: () => {},
  } as unknown as Socket<SocketData>;
  const incoming = { write: () => 0, end: () => {} } as unknown as Socket<SocketData>;
  const controller = {
    isEnabled: () => true,
    getStatus: () => status,
    shouldConnectToMuc: () => connectToMuc,
    handleChatMessage: () => {},
  } as unknown as MainController;

  const connection = new ProxiedConnection(controller, incoming, outgoing);
  return {
    send: (xml: string) => {
      connection.handleIncomingData(Buffer.from(xml, 'utf-8'));
      return written.join('');
    },
  };
}

const PRESENCE =
  "<presence id='presence_1'><show>chat</show><status>hello</status><games>" +
  '<keystone><st>chat</st><s.p>keystone</s.p></keystone>' +
  '<league_of_legends><st>dnd</st><s.p>league_of_legends</s.p><p>{"gameStatus":"inGame"}</p><m>Summoner</m></league_of_legends>' +
  '<teamfighttactics><st>chat</st><p>crossPlay</p></teamfighttactics>' +
  '<valorant><st>chat</st><p></p></valorant>' +
  '<riot_client><st>chat</st></riot_client>' +
  '</games></presence>';

describe('ProxiedConnection presence rewriting', () => {
  it('strips all game presences when offline', () => {
    const out = setup(PresenceStatus.Offline).send(PRESENCE);
    expect(out).toContain('<show>offline</show>');
    expect(out).not.toContain('<status>');
    expect(out).not.toContain('league_of_legends');
    expect(out).not.toContain('teamfighttactics');
    expect(out).not.toContain('keystone');
    expect(out).not.toContain('riot_client');
    expect(out).not.toContain('valorant');
  });

  it('keeps League presence without game details when mobile', () => {
    const out = setup(PresenceStatus.Mobile).send(PRESENCE);
    expect(out).toContain('<show>mobile</show>');
    expect(out).toContain('<league_of_legends><st>mobile</st>');
    expect(out).not.toContain('<p>{"gameStatus"');
    expect(out).not.toContain('<m>Summoner</m>');
    expect(out).not.toContain('teamfighttactics');
  });

  it('keeps the in-game dnd state when online', () => {
    const out = setup(PresenceStatus.Online).send(PRESENCE);
    expect(out).toBe(PRESENCE);
  });

  it('sets online state when not in game', () => {
    const out = setup(PresenceStatus.Online).send(
      PRESENCE.replace('<st>dnd</st>', '<st>away</st>')
    );
    expect(out).toContain('<show>chat</show>');
    expect(out).toContain('<league_of_legends><st>chat</st>');
  });

  it('passes lobby presences through or drops them depending on lobby chat', () => {
    const muc = "<presence to='lobby@champ-select.pvp.net/me'><show>chat</show></presence>";
    expect(setup(PresenceStatus.Offline, true).send(muc)).toBe(muc);
    expect(setup(PresenceStatus.Offline, false).send(muc)).toBe('');
  });
});
