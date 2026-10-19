// Byte transport over the Web Serial API (or its WebUSB polyfill).
//
// One instance owns one port. A background pump drains the port's readable
// stream into a buffer, so bytes that arrive while nobody is waiting are not
// lost (the same idea as hestia-web-tool's WebSerialAdapter). The Modbus
// client and the passthrough terminal both sit on top of this; nothing else
// touches the port.

// @ts-ignore - the polyfill's .d.ts references w3c-web-usb types we do not install
import { serial as polyfillSerial } from 'web-serial-polyfill';

export enum DriverMode {
  AUTO = 'AUTO',
  NATIVE = 'NATIVE',
  POLYFILL = 'POLYFILL',
}

/** What the Modbus client needs from a byte link; a mock implements it in tests. */
export interface ByteLink {
  write(data: Uint8Array): Promise<void>;
  /** Drop everything received so far. */
  flushInput(): void;
  /** Take (and remove) everything received so far. */
  takeAvailable(): Uint8Array;
  /** Resolve true as soon as unread bytes exist, false after timeoutMs. */
  waitForData(timeoutMs: number): Promise<boolean>;
}

type ChunkListener = (chunk: Uint8Array) => void;

// Never let an unread buffer grow without bound (e.g. a chatty passthrough
// peer while no transaction is reading). Keep the newest bytes.
const MAX_BUFFER_BYTES = 64 * 1024;

interface SerialApi {
  requestPort(options?: unknown): Promise<SerialPort>;
}

function pickSerialApi(mode: DriverMode): SerialApi | null {
  const native = (navigator as unknown as { serial?: SerialApi }).serial ?? null;
  const poly = (polyfillSerial as unknown as SerialApi | undefined) ?? null;
  if (mode === DriverMode.NATIVE) return native;
  if (mode === DriverMode.POLYFILL) return poly;
  return native ?? poly;
}

export function isSerialSupported(): boolean {
  return pickSerialApi(DriverMode.AUTO) !== null;
}

export class SerialTransport implements ByteLink {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private pumpDone: Promise<void> | null = null;
  private stopping = false;
  private buffer = new Uint8Array(0);
  private waiters: Array<() => void> = [];
  private listeners = new Set<ChunkListener>();
  private _baud = 115200;

  /** Called once when the port goes away without close() (cable pulled). */
  onLost: ((err: unknown) => void) | null = null;

  get isOpen(): boolean {
    return this.port !== null;
  }

  get baud(): number {
    return this._baud;
  }

  /** Ask the user for a port and open it. Throws the browser's DOMException on cancel. */
  async open(mode: DriverMode, baud: number): Promise<void> {
    const api = pickSerialApi(mode);
    if (!api) throw new Error('Web Serial is not available in this browser (use Chrome or Edge)');
    const port = await api.requestPort();
    await port.open({ baudRate: baud, dataBits: 8, parity: 'none', stopBits: 1, bufferSize: 8192 });
    this.port = port;
    this._baud = baud;
    this.startPump();
  }

  async close(): Promise<void> {
    const port = this.port;
    if (!port) return;
    await this.stopPump();
    this.port = null;
    try {
      await port.close();
    } catch (e) {
      console.debug('port.close failed', e);
    }
    this.wakeWaiters();
  }

  /**
   * Re-time the open port. Web Serial cannot change the rate of an open
   * port, so this closes and reopens the same SerialPort object (no picker).
   */
  async setBaud(baud: number): Promise<void> {
    const port = this.port;
    if (!port) throw new Error('Serial port is not open');
    await this.stopPump();
    await port.close();
    await port.open({ baudRate: baud, dataBits: 8, parity: 'none', stopBits: 1, bufferSize: 8192 });
    this._baud = baud;
    this.buffer = new Uint8Array(0);
    this.startPump();
  }

  async write(data: Uint8Array): Promise<void> {
    const port = this.port;
    if (!port || !port.writable) throw new Error('Serial port is not open');
    const writer = port.writable.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  }

  flushInput(): void {
    this.buffer = new Uint8Array(0);
  }

  takeAvailable(): Uint8Array {
    const out = this.buffer;
    this.buffer = new Uint8Array(0);
    return out;
  }

  waitForData(timeoutMs: number): Promise<boolean> {
    if (this.buffer.length > 0) return Promise.resolve(true);
    // A closed port would otherwise answer "no data" instantly and let a
    // caller's deadline loop spin.
    if (!this.port) return Promise.reject(new Error('Serial port is not open'));
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== finish);
        if (this.buffer.length > 0) resolve(true);
        else if (!this.port) reject(new Error('Serial port closed'));
        else resolve(false);
      };
      const timer = setTimeout(finish, Math.max(0, timeoutMs));
      this.waiters.push(finish);
    });
  }

  /** Every received chunk, as it arrives (passthrough terminal). Returns an unsubscribe. */
  subscribe(listener: ChunkListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private startPump(): void {
    const port = this.port;
    if (!port || !port.readable) return;
    this.stopping = false;
    const reader = port.readable.getReader();
    this.reader = reader;
    this.pumpDone = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length) this.push(value);
        }
      } catch (err) {
        if (!this.stopping) {
          // The device vanished (USB unplugged) or the OS reported a line error.
          this.port = null;
          this.wakeWaiters();
          this.onLost?.(err);
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
      }
    })();
  }

  private async stopPump(): Promise<void> {
    this.stopping = true;
    try {
      await this.reader?.cancel();
    } catch (e) {
      console.debug('reader.cancel failed', e);
    }
    await this.pumpDone;
    this.reader = null;
    this.pumpDone = null;
  }

  private push(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged.length > MAX_BUFFER_BYTES ? merged.slice(merged.length - MAX_BUFFER_BYTES) : merged;
    for (const l of this.listeners) l(chunk);
    this.wakeWaiters();
  }

  private wakeWaiters(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }
}
