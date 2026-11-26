/**
 * Socket write queue tests
 */

import { describe, it, expect } from 'bun:test';
import { SocketWriter } from '../../src/proxy/socket-writer.js';

function socketAccepting(limits: number[]) {
  const written: number[] = [];
  return {
    written,
    write(data: Uint8Array): number {
      const limit = limits.shift() ?? data.length;
      const n = Math.min(limit, data.length);
      written.push(...data.subarray(0, n));
      return n;
    },
  };
}

describe('SocketWriter', () => {
  it('keeps data the socket did not accept and flushes it in order', () => {
    const socket = socketAccepting([3, 0]);
    const writer = new SocketWriter(socket);

    writer.write(new Uint8Array([1, 2, 3, 4, 5]));
    writer.write(new Uint8Array([6, 7]));
    expect(socket.written).toEqual([1, 2, 3]);
    expect(writer.pendingBytes).toBe(4);

    writer.flush(); // socket accepts nothing yet
    expect(writer.pendingBytes).toBe(4);
    writer.flush();
    expect(socket.written).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(writer.pendingBytes).toBe(0);
  });

  it('stops writing once the socket is closed', () => {
    const calls: number[] = [];
    const writer = new SocketWriter({
      write: (data) => {
        calls.push(data.length);
        return -1;
      },
    });
    writer.write('a');
    writer.write('b');
    expect(calls).toEqual([1]);
  });
});
