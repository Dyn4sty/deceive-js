/**
 * Proxied Connection - Handles bidirectional TLS proxy between
 * Riot Client and chat server, rewriting presence stanzas.
 *
 * Both directions are split into complete stanzas before they are inspected, so a stanza
 * that arrives across several reads is never forwarded half-rewritten.
 */

import { EventEmitter } from 'events';
import { PresenceStatus } from '../types.js';
import { logger } from '../utils/logger.js';
import { StanzaSplitter, type StanzaUnit } from './stanza-splitter.js';
import { SocketWriter, type WritableSocket } from './socket-writer.js';

// Fake player JID for in-app messaging
export const FAKE_PLAYER_JID = '41c322a1-b328-495b-a004-5ccd3e45eae8@eu1.pvp.net';

// Game presences that are stripped entirely when not appearing online
const STRIPPED_GAMES = ['bacon', 'lion', 'keystone', 'riot_client', 'teamfighttactics'];

const ROSTER_QUERY = "<query xmlns='jabber:iq:riotgames:roster'>";

/**
 * What a connection needs from its owner
 */
export interface PresenceHost {
  isEnabled(): boolean;
  getStatus(): PresenceStatus;
  shouldConnectToMuc(): boolean;
  /** Text of a chat message sent to the fake player */
  handleChatMessage(text: string): void;
}

interface ProxiedConnectionEvents {
  close: () => void;
}

export interface ProxySocket extends WritableSocket {
  end(): void;
}

function elementPattern(name: string): RegExp {
  return new RegExp(`<${name}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${name}>)`, 'g');
}

function removeElement(xml: string, name: string): string {
  return xml.replace(elementPattern(name), '');
}

function setElementText(xml: string, name: string, value: string): string {
  return xml.replace(elementPattern(name), `<${name}>${value}</${name}>`);
}

/**
 * Apply fn to the inner content of the first <name>...</name> element
 */
function mapElementContent(xml: string, name: string, fn: (inner: string) => string): string {
  const pattern = new RegExp(`(<${name}\\b[^>]*>)([\\s\\S]*?)(<\\/${name}>)`);
  return xml.replace(pattern, (_, open: string, inner: string, close: string) => {
    return open + fn(inner) + close;
  });
}

function getElementText(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}\\b[^>]*>([^<]*)<\\/${name}>`).exec(xml);
  return match?.[1] ?? null;
}

function getElementContent(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`).exec(xml);
  return match?.[1] ?? null;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;');
}

/**
 * Whether a presence is directed at a chat room (lobby/champ select), i.e. has a `to` attribute
 */
function isRoomPresence(presence: string): boolean {
  const openingTag = /^<presence\b[^>]*>/.exec(presence)?.[0] ?? '';
  return /\sto=/.test(openingTag);
}

export class ProxiedConnection extends EventEmitter {
  private host: PresenceHost;
  private incoming: ProxySocket;
  private outgoing: ProxySocket;
  private toClient: SocketWriter;
  private toServer: SocketWriter;
  private fromClient = new StanzaSplitter();
  private fromServer = new StanzaSplitter();
  private connected = true;
  /** Most recent presence (not directed at a room) sent by the client, unmodified */
  private lastPresence: string | null = null;
  private insertedFakePlayer = false;
  private sentFakePlayerPresence = false;
  private valorantVersion: string | null = null;

  constructor(host: PresenceHost, incoming: ProxySocket, outgoing: ProxySocket) {
    super();
    this.host = host;
    this.incoming = incoming;
    this.outgoing = outgoing;
    const overflow = (direction: string) => () => {
      logger.warn(`Closing chat connection: ${direction} stopped reading`);
      this.close();
    };
    this.toClient = new SocketWriter(incoming, overflow('Riot Client'));
    this.toServer = new SocketWriter(outgoing, overflow('chat server'));
  }

  /**
   * Handle data from the Riot Client (incoming socket).
   */
  handleIncomingData(data: Buffer | Uint8Array): void {
    if (!this.connected) return;

    let out = '';
    let foundValorantVersion = false;
    for (const unit of this.fromClient.push(data)) {
      try {
        const result = this.processClientUnit(unit);
        out += result.xml;
        if (result.foundValorantVersion) foundValorantVersion = true;
      } catch (err) {
        // Fail closed: never forward a presence we failed to rewrite
        logger.error('Error handling stanza from Riot Client:', err);
        if (unit.name !== 'presence') out += unit.xml;
      }
    }
    if (out) this.toServer.write(out);

    // Send fake player presence after the roster is received, and again once the
    // VALORANT version is known
    if (this.insertedFakePlayer && (!this.sentFakePlayerPresence || foundValorantVersion)) {
      this.sendFakePlayerPresence();
    }
  }

  private processClientUnit(unit: StanzaUnit): { xml: string; foundValorantVersion?: boolean } {
    if (unit.name === 'presence') {
      if (isRoomPresence(unit.xml)) {
        // Lobby chat presence: pass through, or drop if lobby chat is disabled
        const keep = !this.host.isEnabled() || this.host.shouldConnectToMuc();
        return { xml: keep ? unit.xml : '' };
      }

      this.lastPresence = unit.xml;
      if (!this.host.isEnabled()) return { xml: unit.xml };
      logger.debug('Rewriting presence stanza');
      return this.rewritePresence(unit.xml, this.host.getStatus());
    }

    if (unit.name !== null && unit.xml.includes(FAKE_PLAYER_JID)) {
      // Don't send anything involving our fake player to the chat server
      if (unit.name === 'message') {
        const body = getElementContent(unit.xml, 'body');
        if (body !== null) {
          logger.debug('Intercepted message to fake player');
          this.host.handleChatMessage(decodeEntities(body));
        }
      }
      return { xml: '' };
    }

    return { xml: unit.xml };
  }

  /**
   * Handle data from the real chat server (outgoing socket).
   */
  handleOutgoingData(data: Buffer | Uint8Array): void {
    if (!this.connected) return;

    let out = '';
    for (const unit of this.fromServer.push(data)) {
      if (!this.insertedFakePlayer && unit.name === 'iq' && unit.xml.includes(ROSTER_QUERY)) {
        this.insertedFakePlayer = true;
        logger.debug('Injecting fake player into roster');

        const fakePlayer =
          `<item jid='${FAKE_PLAYER_JID}' name='&#9;Deceive Active!' subscription='both' puuid='41c322a1-b328-495b-a004-5ccd3e45eae8'>` +
          "<group priority='9999'>Deceive</group>" +
          '<state>online</state>' +
          "<id name='&#9;Deceive Active!' tagline='...'/>" +
          "<lol name='&#9;Deceive Active!'/>" +
          "<platforms><riot name='&#9;Deceive Active' tagline='...'/></platforms>" +
          '</item>';
        out += unit.xml.replace(ROSTER_QUERY, ROSTER_QUERY + fakePlayer);
      } else {
        out += unit.xml;
      }
    }
    if (out) this.toClient.write(out);
  }

  /** Call when the socket to the Riot Client drains */
  flushToClient(): void {
    this.toClient.flush();
  }

  /** Call when the socket to the chat server drains */
  flushToServer(): void {
    this.toServer.flush();
  }

  /**
   * Handle connection close.
   * Called by the controller when either socket closes.
   */
  handleClose(): void {
    if (!this.connected) return;
    this.close();
  }

  private rewritePresence(
    presence: string,
    targetStatus: PresenceStatus
  ): { xml: string; foundValorantVersion: boolean } {
    let xml = presence;
    let foundValorantVersion = false;

    const leagueContent = getElementContent(xml, 'league_of_legends');
    const leagueState = leagueContent !== null ? getElementText(leagueContent, 'st') : null;

    // When appearing online, keep the in-game (dnd) state as-is
    if (targetStatus !== PresenceStatus.Online || leagueState !== 'dnd') {
      xml = setElementText(xml, 'show', targetStatus);
      xml = mapElementContent(xml, 'league_of_legends', (inner) =>
        setElementText(inner, 'st', targetStatus)
      );
    }

    if (targetStatus === PresenceStatus.Online) {
      return { xml, foundValorantVersion };
    }

    xml = removeElement(xml, 'status');

    if (targetStatus === PresenceStatus.Mobile) {
      xml = mapElementContent(xml, 'league_of_legends', (inner) =>
        removeElement(removeElement(inner, 'p'), 'm')
      );
    } else {
      xml = removeElement(xml, 'league_of_legends');
    }

    for (const game of STRIPPED_GAMES) {
      xml = removeElement(xml, game);
    }

    // Extract the VALORANT version from the user's own presence, so the fake player
    // can use it and avoid a "Version Mismatch" warning.
    if (!this.valorantVersion) {
      const valorantContent = getElementContent(xml, 'valorant');
      const valorantBase64 = valorantContent ? getElementText(valorantContent, 'p') : null;
      if (valorantBase64?.trim()) {
        try {
          const decoded = Buffer.from(valorantBase64, 'base64').toString('utf-8');
          const valorantData = JSON.parse(decoded) as Record<string, unknown>;
          const partyData = valorantData['partyPresenceData'] as
            | Record<string, unknown>
            | undefined;
          const version = partyData?.['partyClientVersion'];
          if (typeof version === 'string' && version) {
            this.valorantVersion = version;
            foundValorantVersion = true;
            logger.debug(`Found VALORANT version: ${version}`);
          }
        } catch {
          // Ignore parsing errors
        }
      }
    }

    xml = removeElement(xml, 'valorant');

    return { xml, foundValorantVersion };
  }

  private sendFakePlayerPresence(): void {
    this.sentFakePlayerPresence = true;

    // VALORANT requires a recent version to not display "Version Mismatch"
    const valorantPresence = Buffer.from(
      JSON.stringify({
        isValid: true,
        isIdle: false,
        queueId: 'competitive',
        provisioningFlow: 'Invalid',
        partyId: '00000000-0000-0000-0000-000000000000',
        partySize: 1,
        maxPartySize: 5,
        partyOwnerMatchScoreAllyTeam: 0,
        partyOwnerMatchScoreEnemyTeam: 0,
        premierPresenceData: {
          rosterId: '',
          rosterName: 'Deceive is active. Ignore any version mismatch warnings.',
          rosterTag: 'Deceive Active!',
          rosterType: 'VCT',
          division: 0,
          score: 0,
          plating: 0,
          showAura: false,
          showTag: true,
          showPlating: false,
        },
        matchPresenceData: {
          sessionLoopState: 'MENUS',
          provisioningFlow: 'Invalid',
          matchMap: '',
          queueId: 'competitive',
        },
        partyPresenceData: {
          partyId: '00000000-0000-0000-0000-000000000000',
          isPartyOwner: true,
          partyState: 'DEFAULT',
          partyAccessibility: 'CLOSED',
          partyLFM: false,
          partyClientVersion: this.valorantVersion ?? 'unknown',
          partyVersion: 1768830115681,
          partySize: 1,
          queueEntryTime: '0001.01.01-00.00.00',
          isPartyCrossPlayEnabled: false,
          isPlayerCrossPlayEnabled: false,
          partyPrecisePlatformTypes: 1,
          customGameName: 'Deceive Active!',
          customGameTeam: '',
          maxPartySize: 5,
          tournamentId: '',
          rosterId: '',
          partyOwnerSessionLoopState: 'MENUS',
          partyOwnerMatchMap: '',
          partyOwnerProvisioningFlow: 'Invalid',
          partyOwnerMatchScoreAllyTeam: 0,
          partyOwnerMatchScoreEnemyTeam: 0,
        },
        playerPresenceData: {
          playerCardId: '893deca1-4123-9c1f-2985-aa9de74cb512',
          playerTitleId: 'e3ca05a4-4e44-9afe-3791-7d96ca8f71fa',
          accountLevel: 999,
          competitiveTier: 0,
          leaderboardPosition: 0,
        },
      })
    ).toString('base64');

    const randomStanzaId = crypto.randomUUID();
    const timestamp = Date.now();

    const presenceMessage =
      `<presence from='${FAKE_PLAYER_JID}/RC-Deceive' id='b-${randomStanzaId}'>` +
      '<games>' +
      `<keystone><st>chat</st><s.t>${timestamp}</s.t><s.p>keystone</s.p><pty/></keystone>` +
      `<league_of_legends><st>chat</st><s.t>${timestamp}</s.t><s.p>league_of_legends</s.p><s.c>live</s.c><p>{"pty":true}</p></league_of_legends>` +
      `<valorant><st>chat</st><s.t>${timestamp}</s.t><s.p>valorant</s.p><s.r>PC</s.r><p>${valorantPresence}</p><pty/></valorant>` +
      `<bacon><st>chat</st><s.t>${timestamp}</s.t><s.l>bacon_availability_online</s.l><s.p>bacon</s.p></bacon>` +
      '</games>' +
      '<show>chat</show>' +
      '<platform>riot</platform>' +
      '<status/>' +
      '</presence>';

    this.toClient.write(presenceMessage);
    logger.debug('Sent fake player presence');
  }

  sendMessageFromFakePlayer(message: string): void {
    if (!this.insertedFakePlayer || !this.connected) {
      return;
    }

    const stamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
    const chatMessage =
      `<message from='${FAKE_PLAYER_JID}/RC-Deceive' stamp='${stamp}' id='fake-${crypto.randomUUID()}' type='chat'>` +
      `<body>${escapeXml(message)}</body>` +
      '</message>';

    this.toClient.write(chatMessage);
    logger.debug(`Sent message from fake player: ${message}`);
  }

  /**
   * Resend the last presence with a new status (or unmodified-but-online when Deceive is disabled)
   */
  updateStatus(newStatus: PresenceStatus): void {
    if (!this.lastPresence || !this.connected) {
      return;
    }
    try {
      this.toServer.write(this.rewritePresence(this.lastPresence, newStatus).xml);
    } catch (err) {
      logger.error('Error resending presence:', err);
    }
  }

  close(): void {
    if (!this.connected) {
      return;
    }

    this.connected = false;
    try {
      this.incoming.end();
    } catch {
      // Ignore errors on close
    }
    try {
      this.outgoing.end();
    } catch {
      // Ignore errors on close
    }
    this.emit('close');
  }

  override on<K extends keyof ProxiedConnectionEvents>(
    event: K,
    listener: ProxiedConnectionEvents[K]
  ): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof ProxiedConnectionEvents>(
    event: K,
    ...args: Parameters<ProxiedConnectionEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}
