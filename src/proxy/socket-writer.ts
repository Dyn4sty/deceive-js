/**
 * Write queue for Bun sockets.
 *
 * Bun's TCP sockets do not buffer: `write()` returns how many bytes were accepted and the rest
 * is dropped. This keeps the remainder and flushes it when the socket drains.
 */

export interface WritableSocket {
  write(data: Uint8Array): number;
}

// Close the connection rather than buffer without limit when the peer stops reading
const MAX_QUEUED_BYTES = 32 * 1024 * 1024;

export class SocketWriter {
  private queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private closed = false;

  constructor(
    private socket: WritableSocket,
    private onOverflow: () => void = () => {}
  ) {}

  write(data: Uint8Array | string): void {
    if (this.closed) return;
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    if (bytes.length === 0) return;

    if (this.queue.length > 0) {
      this.enqueue(bytes);
      return;
    }

    const written = this.socket.write(bytes);
    if (written < 0) {
      this.closed = true;
      return;
    }
    if (written < bytes.length) {
      this.enqueue(bytes.subarray(written));
    }
  }

  /**
   * Call from the socket's `drain` handler
   */
  flush(): void {
    while (this.queue.length > 0 && !this.closed) {
      const chunk = this.queue[0];
      const written = this.socket.write(chunk);
      if (written < 0) {
        this.closed = true;
        this.queue = [];
        this.queuedBytes = 0;
        return;
      }
      this.queuedBytes -= written;
      if (written < chunk.length) {
        this.queue[0] = chunk.subarray(written);
        return;
      }
      this.queue.shift();
    }
  }

  get pendingBytes(): number {
    return this.queuedBytes;
  }

  private enqueue(bytes: Uint8Array): void {
    this.queue.push(bytes);
    this.queuedBytes += bytes.length;
    if (this.queuedBytes > MAX_QUEUED_BYTES) {
      this.closed = true;
      this.queue = [];
      this.queuedBytes = 0;
      this.onOverflow();
    }
  }
}
