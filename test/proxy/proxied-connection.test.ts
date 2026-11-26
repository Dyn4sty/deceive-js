/**
 * Presence rewriting tests
 */

import { describe, it, expect } from 'bun:test';
import {
  FAKE_PLAYER_JID,
  ProxiedConnection,
  type PresenceHost,
  type ProxySocket,
} from '../../src/proxy/proxied-connection.js';
import { PresenceStatus } from '../../src/types.js';

function setup(status: PresenceStatus, connectToMuc = true) {
  const toServer: string[] = [];
  const toClient: string[] = [];
  const messages: string[] = [];
  const socket = (sink: string[]): ProxySocket => ({
    write: (data: Uint8Array) => {
      sink.push(Buffer.from(data).toString('utf-8'));
      return data.length;
    },
    end: () => {},
  });
  const host = {
    enabled: true,
    status,
    isEnabled() {
      return this.enabled;
    },
    getStatus() {
      return this.status;
    },
    shouldConnectToMuc: () => connectToMuc,
    handleChatMessage: (text: string) => messages.push(text),
  } satisfies PresenceHost & { enabled: boolean; status: PresenceStatus };

  const connection = new ProxiedConnection(host, socket(toClient), socket(toServer));
  return {
    host,
    connection,
    messages,
    toServer: () => toServer.join(''),
    toClient: () => toClient.join(''),
    send: (xml: string) => {
      connection.handleIncomingData(Buffer.from(xml, 'utf-8'));
      return toServer.join('');
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

describe('ProxiedConnection stream handling', () => {
  it('never forwards a presence split across reads before rewriting it', () => {
    const conn = setup(PresenceStatus.Offline);
    const cut = PRESENCE.indexOf('<league_of_legends>') + 10;

    expect(conn.send(PRESENCE.slice(0, cut))).toBe('');
    const out = conn.send(PRESENCE.slice(cut));
    expect(out).toContain('<show>offline</show>');
    expect(out).not.toContain('inGame');
    expect(out).not.toContain('hello');
  });

  it('handles several stanzas and multi-byte characters split across reads', () => {
    const conn = setup(PresenceStatus.Offline);
    const message = "<message to='friend@pvp.net' type='chat'><body>héllo 👋</body></message>";
    const bytes = Buffer.from(message + PRESENCE, 'utf-8');
    const emoji = bytes.indexOf(Buffer.from('👋')) + 2;

    conn.connection.handleIncomingData(bytes.subarray(0, emoji));
    conn.connection.handleIncomingData(bytes.subarray(emoji));
    expect(conn.toServer()).toStartWith(message);
    expect(conn.toServer()).toContain('<show>offline</show>');
  });

  it('only resends the presence itself on status change', () => {
    const conn = setup(PresenceStatus.Offline);
    const message = "<message to='friend@pvp.net' type='chat'><body>hi</body></message>";
    conn.send(message + PRESENCE);
    const before = conn.toServer().length;

    conn.host.status = PresenceStatus.Mobile;
    conn.connection.updateStatus(PresenceStatus.Mobile);
    const resent = conn.toServer().slice(before);
    expect(resent).toContain('<show>mobile</show>');
    expect(resent).not.toContain('<message');
  });

  it('remembers presences sent while disabled', () => {
    const conn = setup(PresenceStatus.Offline);
    conn.send(PRESENCE);
    conn.host.enabled = false;
    conn.send(PRESENCE.replace('inGame', 'championSelect'));
    const before = conn.toServer().length;

    conn.host.enabled = true;
    conn.connection.updateStatus(PresenceStatus.Mobile);
    conn.host.status = PresenceStatus.Mobile;
    const resent = conn.toServer().slice(before);
    expect(resent).toContain('<show>mobile</show>');
    expect(resent).not.toContain('inGame');
  });

  it('handles chat commands sent to the fake player without forwarding them', () => {
    const conn = setup(PresenceStatus.Offline);
    const command = `<message to='${FAKE_PLAYER_JID}' type='chat'><body>Mobile</body></message>`;
    const other = "<iq type='get' id='1'/>";
    expect(conn.send(command + other)).toBe(other);
    expect(conn.messages).toEqual(['Mobile']);
  });
});
