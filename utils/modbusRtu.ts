// Minimal Modbus RTU master (FC 0x03 / 0x04 / 0x06 / 0x10), ported from
// ttool/modbus_rtu.py. Behaviour is kept identical to the Python tool --
// same response-length rule, same checks, no automatic retry -- with one
// addition: the response function code must echo the request's.

import type { ByteLink } from './serialTransport';

export const EXC_TOO_LONG = 0x0d;
export const EXC_PWD_AUTH = 0x0e;
export const EXC_PWD_LOCKOUT = 0x0f;
export const EXC_ENGMODE_REQUIRED = 0x10;
export const EXC_BUSY = 0x19;

/** English names, as ttool prints them. The UI adds a localised hint (i18n `exc.*`). */
export const EXCEPTION_NAMES: Record<number, string> = {
  0x01: 'Illegal Function',
  0x02: 'Illegal Data Address',
  0x03: 'Illegal Data Value',
  0x04: 'Slave Device Failure',
  // Not in ttool's table: 0xC750 while the firmware holds the LoRa port (USER_MANUAL §15).
  0x06: 'Slave Device Busy',
  [EXC_TOO_LONG]: 'Uplink Too Long',
  [EXC_PWD_AUTH]: 'Password Auth Required',
  [EXC_PWD_LOCKOUT]: 'Password Lockout',
  [EXC_ENGMODE_REQUIRED]: 'Engineering Mode Required',
  [EXC_BUSY]: 'Uplink Busy',
};

export class ModbusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModbusError';
  }
}

export class ModbusTimeout extends ModbusError {
  constructor(message: string) {
    super(message);
    this.name = 'ModbusTimeout';
  }
}

export class ModbusException extends ModbusError {
  constructor(
    readonly unit: number,
    readonly fn: number,
    readonly code: number,
  ) {
    const name = EXCEPTION_NAMES[code] ?? 'Unknown';
    super(`Modbus exception unit=${unit} fc=0x${hex2(fn)} code=0x${hex2(code)} (${name})`);
    this.name = 'ModbusException';
  }
}

export function hex2(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

export function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, '0');
}

export function hexDump(data: Uint8Array): string {
  return Array.from(data, hex2).join(' ');
}

/** Modbus RTU CRC-16 (poly 0xA001 reflected, init 0xFFFF). */
export function crc16(data: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

/** PDU + CRC, low byte first. */
export function appendCrc(pdu: Uint8Array): Uint8Array {
  const c = crc16(pdu);
  const out = new Uint8Array(pdu.length + 2);
  out.set(pdu, 0);
  out[pdu.length] = c & 0xff;
  out[pdu.length + 1] = (c >> 8) & 0xff;
  return out;
}

export function verifyCrc(frame: Uint8Array): boolean {
  if (frame.length < 4) return false;
  const recv = frame[frame.length - 2] | (frame[frame.length - 1] << 8);
  return recv === crc16(frame.subarray(0, frame.length - 2));
}

/** Full response length from its first bytes, or 0 while still unknown. */
export function expectedResponseLen(first: Uint8Array): number {
  if (first.length < 2) return 0;
  const fn = first[1];
  if (fn & 0x80) return 5; // unit, fn|0x80, code, crc lo, crc hi
  if (fn >= 0x01 && fn <= 0x04) {
    if (first.length < 3) return 0;
    return 3 + first[2] + 2;
  }
  if (fn === 0x05 || fn === 0x06 || fn === 0x0f || fn === 0x10) return 8;
  return 0;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function u16(n: number): [number, number] {
  return [(n >> 8) & 0xff, n & 0xff];
}

export type FrameLog = (dir: 'TX' | 'RX', frame: Uint8Array, note: string) => void;

// pyserial was opened with a 50 ms read timeout; an idle gap that long ends a
// raw (unframed) reply whose length is not known in advance.
const RAW_IDLE_MS = 50;

export class ModbusClient {
  unit = 1;
  timeoutMs = 1000;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly link: ByteLink,
    private readonly logFrame: FrameLog = () => {},
  ) {}

  /** One transaction at a time, whoever calls. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private transact(request: Uint8Array, note: string): Promise<Uint8Array> {
    return this.exclusive(async () => {
      const unit = this.unit;
      this.link.flushInput();
      const frame = appendCrc(request);
      this.logFrame('TX', frame, note);
      await this.link.write(frame);

      const deadline = Date.now() + this.timeoutMs;
      let buf: Uint8Array = new Uint8Array(0);
      let expected = 0;
      while (Date.now() < deadline) {
        if (await this.link.waitForData(deadline - Date.now())) {
          buf = concat(buf, this.link.takeAvailable());
          if (expected === 0) expected = expectedResponseLen(buf);
          if (expected && buf.length >= expected) break;
        }
      }

      if (buf.length === 0) throw new ModbusTimeout(`No response (${note || 'transaction'})`);
      const resp = expected && buf.length > expected ? buf.slice(0, expected) : buf;
      this.logFrame('RX', resp, note);

      if (!verifyCrc(resp)) throw new ModbusError(`CRC mismatch on response: ${hexDump(resp)}`);
      if (resp.length < 3) throw new ModbusError(`Response too short: ${hexDump(resp)}`);
      if (resp[0] !== unit) throw new ModbusError(`Unit id mismatch: got ${resp[0]}, expected ${unit}`);
      if (resp[1] & 0x80) throw new ModbusException(resp[0], resp[1] & 0x7f, resp[2]);
      if (resp[1] !== request[1]) {
        throw new ModbusError(`Function code mismatch: got 0x${hex2(resp[1])}, expected 0x${hex2(request[1])}`);
      }
      return resp;
    });
  }

  private async readRegisters(fn: number, address: number, quantity: number, note: string): Promise<number[]> {
    if (quantity < 1 || quantity > 125) throw new RangeError(`quantity must be 1..125, got ${quantity}`);
    const req = new Uint8Array([this.unit, fn, ...u16(address), ...u16(quantity)]);
    const resp = await this.transact(req, note || `FC${hex2(fn)} addr=0x${hex4(address)} qty=${quantity}`);
    const byteCount = resp[2];
    if (byteCount !== quantity * 2) {
      throw new ModbusError(`Byte count mismatch: got ${byteCount}, expected ${quantity * 2}`);
    }
    if (resp.length < 3 + byteCount + 2) throw new ModbusError(`Truncated FC${hex2(fn)} response`);
    const values: number[] = [];
    for (let i = 0; i < byteCount; i += 2) values.push((resp[3 + i] << 8) | resp[4 + i]);
    return values;
  }

  /** FC 0x03 Read Holding Registers. */
  readHolding(address: number, quantity: number, note = ''): Promise<number[]> {
    return this.readRegisters(0x03, address, quantity, note);
  }

  /** FC 0x04 Read Input Registers. */
  readInput(address: number, quantity: number, note = ''): Promise<number[]> {
    return this.readRegisters(0x04, address, quantity, note);
  }

  /** FC 0x06 Write Single Register; the response is an echo of the request. */
  async writeSingle(address: number, value: number, note = ''): Promise<void> {
    const req = new Uint8Array([this.unit, 0x06, ...u16(address), ...u16(value)]);
    const resp = await this.transact(req, note || `FC06 addr=0x${hex4(address)} val=0x${hex4(value)}`);
    if (resp.length < 8) throw new ModbusError(`Truncated FC06 response: ${hexDump(resp)}`);
    const echoAddr = (resp[2] << 8) | resp[3];
    const echoVal = (resp[4] << 8) | resp[5];
    if (echoAddr !== (address & 0xffff) || echoVal !== (value & 0xffff)) {
      throw new ModbusError(
        `FC06 echo mismatch: addr=0x${hex4(echoAddr)} val=0x${hex4(echoVal)} ` +
          `(expected 0x${hex4(address)}/0x${hex4(value)})`,
      );
    }
  }

  /** FC 0x10 Write Multiple Registers. */
  async writeMultiple(address: number, values: number[], note = ''): Promise<void> {
    const req = this.buildWriteMultiple(this.unit, address, values);
    const resp = await this.transact(req, note || `FC10 addr=0x${hex4(address)} qty=${values.length}`);
    if (resp.length < 8) throw new ModbusError(`Truncated FC10 response: ${hexDump(resp)}`);
    const start = (resp[2] << 8) | resp[3];
    const qty = (resp[4] << 8) | resp[5];
    if (start !== (address & 0xffff) || qty !== values.length) {
      throw new ModbusError(
        `FC10 ACK mismatch: start=0x${hex4(start)} qty=${qty} (expected 0x${hex4(address)}/${values.length})`,
      );
    }
  }

  /** FC 0x06 broadcast (slave id 0): no station answers; sleep the turnaround. */
  broadcastWriteSingle(address: number, value: number, note = '', turnaroundMs = 200): Promise<void> {
    const req = new Uint8Array([0x00, 0x06, ...u16(address), ...u16(value)]);
    return this.fireAndForget(req, note || `FC06 broadcast addr=0x${hex4(address)} val=0x${hex4(value)}`, turnaroundMs);
  }

  /** FC 0x10 broadcast (slave id 0): no station answers; sleep the turnaround. */
  broadcastWriteMultiple(address: number, values: number[], note = '', turnaroundMs = 200): Promise<void> {
    const req = this.buildWriteMultiple(0x00, address, values);
    return this.fireAndForget(req, note || `FC10 broadcast addr=0x${hex4(address)}`, turnaroundMs);
  }

  /**
   * Raw bytes, no Modbus framing (passthrough control frames). Reads until
   * expectLen bytes arrived or -- with expectLen 0 -- the first idle gap after
   * some data. Returns an empty array on a silent timeout.
   */
  rawExchange(data: Uint8Array, expectLen = 0, timeoutMs?: number, note = ''): Promise<Uint8Array> {
    return this.exclusive(async () => {
      this.link.flushInput();
      this.logFrame('TX', data, note);
      await this.link.write(data);
      const deadline = Date.now() + (timeoutMs ?? this.timeoutMs);
      let buf: Uint8Array = new Uint8Array(0);
      while (Date.now() < deadline) {
        const wait = buf.length && expectLen === 0 ? Math.min(RAW_IDLE_MS, deadline - Date.now()) : deadline - Date.now();
        if (await this.link.waitForData(wait)) {
          buf = concat(buf, this.link.takeAvailable());
          if (expectLen && buf.length >= expectLen) break;
        } else if (buf.length && expectLen === 0) {
          break;
        }
      }
      if (buf.length) this.logFrame('RX', buf, note);
      return buf;
    });
  }

  private buildWriteMultiple(unit: number, address: number, values: number[]): Uint8Array {
    const quantity = values.length;
    if (quantity < 1 || quantity > 123) throw new RangeError(`quantity must be 1..123, got ${quantity}`);
    const out = [unit, 0x10, ...u16(address), ...u16(quantity), quantity * 2];
    for (const v of values) out.push(...u16(v));
    return new Uint8Array(out);
  }

  private fireAndForget(req: Uint8Array, note: string, turnaroundMs: number): Promise<void> {
    return this.exclusive(async () => {
      const frame = appendCrc(req);
      this.logFrame('TX', frame, note);
      await this.link.write(frame);
      await new Promise((r) => setTimeout(r, turnaroundMs));
    });
  }
}
