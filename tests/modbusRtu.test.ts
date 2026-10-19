import { describe, expect, it } from 'vitest';
import {
  appendCrc,
  crc16,
  expectedResponseLen,
  hexDump,
  ModbusClient,
  ModbusError,
  ModbusException,
  ModbusTimeout,
} from '../utils/modbusRtu';
import { MockLink, h } from './mockLink';

// Request/response pairs quoted in docs/USER_MANUAL.md, CRC included.
const MANUAL_FRAMES = [
  '01 10 00 00 00 04 08 00 00 00 00 00 00 00 00 B6 7A', // login
  '01 10 00 00 00 04 C1 CA',
  '01 04 EA 71 00 01 55 C9', // read 0xEA71
  '01 04 02 00 1F F8 F8',
  '01 04 EA 7D 00 01 95 CA',
  '01 04 02 00 00 B9 30',
  '01 10 C5 50 00 03 06 34 31 34 32 0D 0A 5A D6', // uplink "AB"
  '01 10 C5 50 00 03 BC D5',
  '01 04 F0 60 00 01 02 D4',
  '01 04 F0 61 00 09 52 D2',
  '01 04 EC 60 00 01 05 44',
  '01 04 EC 61 00 02 14 85',
  '01 04 04 34 31 34 32 33 6E',
  '01 04 EA 6B 00 02 34 0F',
  '01 04 04 31 2E 32 30 80 05',
  '01 10 C3 B8 00 02 04 37 30 30 30 A7 E7',
  '01 03 C3 B8 00 03 B9 AA',
  '01 06 FF D0 AA 55 06 B8', // engmode
  '01 06 FD 00 AA 55 06 F9', // reset
  '01 06 FD 20 55 AA 06 83', // console off
  '01 06 C3 50 00 03 F5 9E', // passthrough NTN
  '01 06 C3 50 00 04 B4 5C', // passthrough LoRa
  '01 10 C7 50 00 05 0A 41 54 2B 56 45 52 3D 3F 0D 0A 30 E8', // LoRa AT+VER=?
];

describe('crc16', () => {
  it.each(MANUAL_FRAMES)('reproduces the manual frame %s', (frame) => {
    const bytes = h(frame);
    expect(hexDump(appendCrc(bytes.subarray(0, bytes.length - 2)))).toBe(hexDump(bytes));
  });

  it('matches the standard check value', () => {
    expect(crc16(new TextEncoder().encode('123456789'))).toBe(0x4b37);
  });
});

describe('expectedResponseLen', () => {
  it('handles exceptions, reads and writes', () => {
    expect(expectedResponseLen(h('01 84'))).toBe(5);
    expect(expectedResponseLen(h('01 04'))).toBe(0);
    expect(expectedResponseLen(h('01 04 04'))).toBe(9);
    expect(expectedResponseLen(h('01 10'))).toBe(8);
    expect(expectedResponseLen(h('01 06'))).toBe(8);
  });
});

describe('ModbusClient', () => {
  it('sends the manual read frame and decodes the words', async () => {
    const link = new MockLink([{ expect: '01 04 EA 6B 00 02 34 0F', reply: '01 04 04 31 2E 32 30 80 05' }]);
    const c = new ModbusClient(link);
    expect(await c.readInput(0xea6b, 2)).toEqual([0x312e, 0x3230]);
    link.done();
  });

  it('accepts a reply split across chunks', async () => {
    const link = new MockLink([{ expect: '01 04 EA 71 00 01 55 C9', reply: ['01 04', '02 00 1F F8 F8'] }]);
    const c = new ModbusClient(link);
    expect(await c.readInput(0xea71, 1)).toEqual([0x001f]);
  });

  it('builds the manual login frame', async () => {
    const link = new MockLink([
      { expect: '01 10 00 00 00 04 08 00 00 00 00 00 00 00 00 B6 7A', reply: '01 10 00 00 00 04 C1 CA' },
    ]);
    await new ModbusClient(link).writeMultiple(0x0000, [0, 0, 0, 0]);
    link.done();
  });

  it('raises the exception code', async () => {
    const link = new MockLink([{ expect: '01 04 EA 6B 00 02 34 0F', reply: appendCrc(h('01 84 0E')) }]);
    const err = await new ModbusClient(link).readInput(0xea6b, 2).catch((e) => e);
    expect(err).toBeInstanceOf(ModbusException);
    expect((err as ModbusException).code).toBe(0x0e);
  });

  it('times out on silence', async () => {
    const link = new MockLink([{ expect: '01 04 EA 6B 00 02 34 0F', reply: null }]);
    const c = new ModbusClient(link);
    c.timeoutMs = 50;
    await expect(c.readInput(0xea6b, 2)).rejects.toBeInstanceOf(ModbusTimeout);
  });

  it('rejects a bad CRC and a foreign unit id', async () => {
    const bad = new MockLink([{ expect: '01 04 EA 6B 00 02 34 0F', reply: '01 04 04 31 2E 32 30 80 06' }]);
    await expect(new ModbusClient(bad).readInput(0xea6b, 2)).rejects.toThrow(/CRC mismatch/);

    const other = new MockLink([{ expect: '01 04 EA 6B 00 02 34 0F', reply: appendCrc(h('02 04 04 31 2E 32 30')) }]);
    await expect(new ModbusClient(other).readInput(0xea6b, 2)).rejects.toThrow(/Unit id mismatch/);
  });

  it('rejects an FC06 echo that differs', async () => {
    const link = new MockLink([{ expect: '01 06 FF D0 AA 55 06 B8', reply: appendCrc(h('01 06 FF D0 00 00')) }]);
    const err = await new ModbusClient(link).writeSingle(0xffd0, 0xaa55).catch((e) => e);
    expect(err).toBeInstanceOf(ModbusError);
    expect(String(err)).toMatch(/echo mismatch/);
  });

  it('serialises concurrent transactions', async () => {
    const link = new MockLink([
      { expect: '01 04 EA 71 00 01 55 C9', reply: '01 04 02 00 1F F8 F8' },
      { expect: '01 04 EA 7D 00 01 95 CA', reply: '01 04 02 00 00 B9 30' },
    ]);
    const c = new ModbusClient(link);
    const [a, b] = await Promise.all([c.readInput(0xea71, 1), c.readInput(0xea7d, 1)]);
    expect(a).toEqual([0x1f]);
    expect(b).toEqual([0]);
  });

  it('sends a broadcast without waiting for a reply', async () => {
    const link = new MockLink([{ expect: appendCrc(h('00 06 D0 00 00 00')), reply: null }]);
    await new ModbusClient(link).broadcastWriteSingle(0xd000, 0, '', 1);
    link.done();
  });

  it('collects a raw reply up to the first idle gap', async () => {
    const link = new MockLink([{ expect: '01 01 03 01 00', reply: '01 01 03 04 31 2E 32 30' }]);
    const resp = await new ModbusClient(link).rawExchange(h('01 01 03 01 00'));
    expect(hexDump(resp)).toBe('01 01 03 04 31 2E 32 30');
  });
});
