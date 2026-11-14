/**
 * Proxied Connection - Handles bidirectional TLS proxy between
 * Riot Client and chat server, rewriting presence stanzas.
 *
 * Uses Bun's native socket types for better performance.
 */

import type { Socket } from 'bun';
import { EventEmitter } from 'events';
import { PresenceStatus } from '../types.js';
import { logger } from '../utils/logger.js';
import type { MainController } from '../controller.js';

// Fake player JID for in-app messaging
const FAKE_PLAYER_JID = '41c322a1-b328-495b-a004-5ccd3e45eae8@eu1.pvp.net';

// Game presences that are stripped entirely when not appearing online
const STRIPPED_GAMES = ['bacon', 'lion', 'keystone', 'riot_client', 'teamfighttactics'];

const PRESENCE_STANZA = /<presence\b[^>]*?(?:\/>|>[\s\S]*?<\/presence>)/g;

interface ProxiedConnectionEvents {
  close: () => void;
}

type SocketData = { proxiedConnection?: ProxiedConnection };

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

export class ProxiedConnection extends EventEmitter {
  private controller: MainController;
  private incoming: Socket<SocketData>;
  private outgoing: Socket<SocketData>;
  private connected = true;
  private lastPresence: string | null = null;
  private insertedFakePlayer = false;
  private sentFakePlayerPresence = false;
  private valorantVersion: string | null = null;

  constructor(
    controller: MainController,
    incoming: Socket<SocketData>,
    outgoing: Socket<SocketData>
  ) {
    super();
    this.controller = controller;
    this.incoming = incoming;
    this.outgoing = outgoing;
  }

  /**
   * Handle data from the Riot Client (incoming socket).
   * Called by the controller when data is received.
   */
  handleIncomingData(data: Buffer | Uint8Array): void {
    if (!this.connected) return;

    try {
      const content = Buffer.from(data).toString('utf-8');

      if (content.includes('<presence') && this.controller.isEnabled()) {
        logger.debug('Intercepting presence stanza');
        this.rewriteAndSendPresence(content, this.controller.getStatus());
      } else if (content.includes(FAKE_PLAYER_JID)) {
        // Don't send anything involving our fake player to the chat server
        this.controller.handleChatMessage(content);
        logger.debug('Intercepted message to fake player');
      } else {
        this.outgoing.write(data);
      }

      // Send fake player presence after roster is received
      if (this.insertedFakePlayer && !this.sentFakePlayerPresence) {
        this.sendFakePlayerPresence();
      }
    } catch (err) {
      logger.error('Error handling incoming data:', err);
    }
  }

  /**
   * Handle data from the real chat server (outgoing socket).
   * Called by the controller when data is received.
   */
  handleOutgoingData(data: Buffer | Uint8Array): void {
    if (!this.connected) return;

    try {
      let content = Buffer.from(data).toString('utf-8');

      // Inject fake player into roster
      const roster = "<query xmlns='jabber:iq:riotgames:roster'>";
      if (!this.insertedFakePlayer && content.includes(roster)) {
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

        content = content.replace(roster, roster + fakePlayer);
        this.incoming.write(Buffer.from(content, 'utf-8'));
        return;
      }

      this.incoming.write(data);
    } catch (err) {
      logger.error('Error handling outgoing data:', err);
    }
  }

  /**
   * Handle connection close.
   * Called by the controller when either socket closes.
   */
  handleClose(): void {
    if (!this.connected) return;
    this.close();
  }

  private rewriteAndSendPresence(content: string, targetStatus: PresenceStatus): void {
    this.lastPresence = content;
    let foundValorantVersion = false;

    try {
      const modified = content.replace(PRESENCE_STANZA, (presence) => {
        const openingTag = /^<presence\b[^>]*>/.exec(presence)?.[0] ?? '';

        // Presence with 'to' is for MUC (lobby chat): pass through, or drop if lobby chat is disabled
        if (/\sto=/.test(openingTag)) {
          return this.controller.shouldConnectToMuc() ? presence : '';
        }

        const rewritten = this.rewritePresence(presence, targetStatus);
        if (rewritten.foundValorantVersion) foundValorantVersion = true;
        return rewritten.xml;
      });

      this.outgoing.write(Buffer.from(modified, 'utf-8'));
      logger.debug('Sent modified presence');
    } catch (err) {
      logger.error('Error rewriting presence:', err);
      this.outgoing.write(Buffer.from(content, 'utf-8'));
    }

    // Resend the fake player presence with the detected VALORANT version
    if (foundValorantVersion && this.insertedFakePlayer) {
      this.sendFakePlayerPresence();
    }
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

    this.incoming.write(Buffer.from(presenceMessage, 'utf-8'));
    logger.debug('Sent fake player presence');
  }

  sendMessageFromFakePlayer(message: string): void {
    if (!this.insertedFakePlayer || !this.connected) {
      return;
    }

    const stamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
    const chatMessage =
      `<message from='${FAKE_PLAYER_JID}/RC-Deceive' stamp='${stamp}' id='fake-${stamp}' type='chat'>` +
      `<body>${message}</body>` +
      '</message>';

    this.incoming.write(Buffer.from(chatMessage, 'utf-8'));
    logger.debug(`Sent message from fake player: ${message}`);
  }

  updateStatus(newStatus: PresenceStatus): void {
    if (!this.lastPresence || !this.connected) {
      return;
    }
    this.rewriteAndSendPresence(this.lastPresence, newStatus);
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
