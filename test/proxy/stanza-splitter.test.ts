/**
 * XMPP stream splitting tests
 */

import { describe, it, expect } from 'bun:test';
import { StanzaSplitter } from '../../src/proxy/stanza-splitter.js';

const push = (splitter: StanzaSplitter, text: string) =>
  splitter.push(Buffer.from(text, 'utf-8')).map((unit) => [unit.name, unit.xml]);

describe('StanzaSplitter', () => {
  it('emits the stream header and complete stanzas', () => {
    const splitter = new StanzaSplitter();
    const header = "<?xml version='1.0'?><stream:stream to='pvp.net' xmlns='jabber:client'>";
    expect(push(splitter, header + "<iq id='1'><bind/></iq> ")).toEqual([
      [null, "<?xml version='1.0'?>"],
      ['stream:stream', "<stream:stream to='pvp.net' xmlns='jabber:client'>"],
      ['iq', "<iq id='1'><bind/></iq>"],
      [null, ' '],
    ]);
  });

  it('waits for the rest of a split stanza', () => {
    const splitter = new StanzaSplitter();
    expect(push(splitter, '<presence><show>chat</sh')).toEqual([]);
    expect(push(splitter, 'ow></presence><message/>')).toEqual([
      ['presence', '<presence><show>chat</show></presence>'],
      ['message', '<message/>'],
    ]);
    expect(splitter.pendingLength).toBe(0);
  });

  it('handles nested elements with the same name and quoted >', () => {
    const splitter = new StanzaSplitter();
    const iq = "<iq id='a>b'><query><item><group>x</group></item><item/></query></iq>";
    expect(push(splitter, iq)).toEqual([['iq', iq]]);
  });

  it('emits the stream close tag', () => {
    const splitter = new StanzaSplitter();
    expect(push(splitter, '</stream:stream>')).toEqual([['stream:stream', '</stream:stream>']]);
  });
});
