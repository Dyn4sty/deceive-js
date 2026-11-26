/**
 * Splits an XMPP byte stream into complete top-level units.
 *
 * TCP/TLS reads can end in the middle of a stanza (or a multi-byte character), so stanzas
 * are only handed out once they are complete. The stream header (`<stream:stream ...>`) and
 * its closing tag are emitted as their own units, as is whitespace between stanzas.
 */

import { StringDecoder } from 'string_decoder';

export interface StanzaUnit {
  /** Root element name (`presence`, `message`, `iq`, `stream:stream`, ...), or null for text/declarations */
  name: string | null;
  xml: string;
}

// A single unit larger than this is not valid Riot chat traffic; pass it through rather than buffer forever
const MAX_PENDING = 4 * 1024 * 1024;

const LT = 0x3c; // <
const GT = 0x3e; // >
const SLASH = 0x2f; // /
const QUOTE = 0x22; // "
const APOS = 0x27; // '

function isNameEnd(code: number): boolean {
  return code === GT || code === SLASH || code <= 0x20;
}

export class StanzaSplitter {
  private decoder = new StringDecoder('utf8');
  private pending = '';

  /**
   * Add received bytes and return all units that are now complete
   */
  push(data: Buffer | Uint8Array): StanzaUnit[] {
    this.pending += this.decoder.write(Buffer.from(data));
    const { units, consumed } = split(this.pending);
    this.pending = this.pending.slice(consumed);

    if (this.pending.length > MAX_PENDING) {
      units.push({ name: null, xml: this.pending });
      this.pending = '';
    }
    return units;
  }

  /** Number of buffered characters that do not form a complete unit yet */
  get pendingLength(): number {
    return this.pending.length;
  }
}

function split(s: string): { units: StanzaUnit[]; consumed: number } {
  const units: StanzaUnit[] = [];
  let pos = 0;

  while (pos < s.length) {
    if (s.charCodeAt(pos) !== LT) {
      // Text between top-level elements (whitespace keepalives)
      const next = s.indexOf('<', pos);
      if (next === -1) {
        units.push({ name: null, xml: s.slice(pos) });
        return { units, consumed: s.length };
      }
      units.push({ name: null, xml: s.slice(pos, next) });
      pos = next;
      continue;
    }

    const end = scanElement(s, pos);
    if (end === -1) break; // incomplete, wait for more data

    units.push({ name: rootName(s, pos), xml: s.slice(pos, end) });
    pos = end;
  }

  return { units, consumed: pos };
}

function rootName(s: string, start: number): string | null {
  const first = s.charCodeAt(start + 1);
  if (first === 0x3f /* ? */ || first === 0x21 /* ! */) return null;
  let i = start + 1;
  if (first === SLASH) i++;
  const nameStart = i;
  while (i < s.length && !isNameEnd(s.charCodeAt(i))) i++;
  return s.slice(nameStart, i);
}

/**
 * Find the end (exclusive) of the top-level construct starting at `start`, or -1 if incomplete
 */
function scanElement(s: string, start: number): number {
  let depth = 0;
  let i = start;

  while (i < s.length) {
    if (s.charCodeAt(i) !== LT) {
      const next = s.indexOf('<', i);
      if (next === -1) return -1;
      i = next;
    }

    // Declarations, comments and CDATA
    if (s.startsWith('<?', i)) {
      const close = s.indexOf('?>', i + 2);
      if (close === -1) return -1;
      i = close + 2;
      if (depth === 0) return i;
      continue;
    }
    if (s.startsWith('<!--', i)) {
      const close = s.indexOf('-->', i + 4);
      if (close === -1) return -1;
      i = close + 3;
      if (depth === 0) return i;
      continue;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const close = s.indexOf(']]>', i + 9);
      if (close === -1) return -1;
      i = close + 3;
      continue;
    }

    const tagEnd = findTagEnd(s, i);
    if (tagEnd === -1) return -1;

    const closing = s.charCodeAt(i + 1) === SLASH;
    const selfClosing = s.charCodeAt(tagEnd - 1) === SLASH;
    const name = rootName(s, i);

    if (closing) {
      depth--;
    } else if (!selfClosing) {
      // The stream header is never closed while the stream is open; treat it as a unit of its own
      if (name === 'stream:stream' && depth === 0) return tagEnd + 1;
      depth++;
    }

    i = tagEnd + 1;
    if (depth <= 0) return i;
  }

  return -1;
}

/**
 * Index of the `>` that ends the tag starting at `start`, skipping quoted attribute values
 */
function findTagEnd(s: string, start: number): number {
  let quote = 0;
  for (let i = start + 1; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === QUOTE || c === APOS) {
      quote = c;
    } else if (c === GT) {
      return i;
    }
  }
  return -1;
}
