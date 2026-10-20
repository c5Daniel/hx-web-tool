// BLE passkey over Modbus (0xFFD3-0xFFD4, U32 big-endian, login + engineering
// mode for read and write), against a scripted device. Frames marked SPEC are
// quoted in the firmware repo's docs/NTN_MODBUS_SPEC.md "BLE Passkey".
import { describe, expect, it } from 'vitest';
import { appendCrc, hexDump, ModbusException } from '../utils/modbusRtu';
import { formatPasskey, parseBlePasskey, provision, readBlePasskey, setBlePasskey } from '../utils/ops/factory';
import { SessionPatch } from '../utils/ops/context';
import { BLE_PASSKEY_DEFAULT } from '../utils/registers';
import { h, MockLink, opContext, Step } from './mockLink';

const SPEC = {
  readReq: '01 04 FF D3 00 02 B0 26',
  readResp123456: '01 04 04 00 01 E2 40 E3 14',
  write654321: '01 10 FF D3 00 02 04 00 09 FB F1 A9 A4',
  writeAck: '01 10 FF D3 00 02 80 25',
  noEngmode: '01 84 10 42 CC',
  fc06Req: '01 06 FF D3 00 01 89 E7',
  fc06Resp: '01 86 02 C3 A1',
};

const LOGIN: Step = {
  expect: '01 10 00 00 00 04 08 00 00 00 00 00 00 00 00 B6 7A',
  reply: '01 10 00 00 00 04 C1 CA',
};
const ENGMODE: Step = { expect: '01 06 FF D0 AA 55 06 B8', reply: '01 06 FF D0 AA 55 06 B8' };
const VERSION: Step = { expect: '01 04 EA 6B 00 02 34 0F', reply: '01 04 04 31 2E 32 30 80 05' }; // "1.20"

const write = (words: string): Step => ({
  expect: appendCrc(h(`01 10 FF D3 00 02 04 ${words}`)),
  reply: SPEC.writeAck,
});
const readBack = (words: string): Step => ({ expect: SPEC.readReq, reply: appendCrc(h(`01 04 04 ${words}`)) });

describe('BLE passkey', () => {
  it('reproduces the CRC of every frame the spec quotes', () => {
    for (const frame of Object.values(SPEC)) {
      const bytes = h(frame);
      expect(hexDump(appendCrc(bytes.subarray(0, bytes.length - 2)))).toBe(hexDump(bytes));
    }
  });

  it('formats and parses like the label (and ttool)', () => {
    expect(formatPasskey(123456)).toBe('123456');
    expect(formatPasskey(42)).toBe('000042');
    expect(parseBlePasskey('012345')).toBe(12345);
    expect(parseBlePasskey('000000')).toBe(0);
    for (const bad of ['12345', '1234567', '12a456', ' 12345', '']) expect(() => parseBlePasskey(bad)).toThrow(/6 digits/);
  });

  it('writes the spec frame for 654321 after login and engmode, then verifies', async () => {
    const link = new MockLink([
      LOGIN,
      ENGMODE,
      { expect: SPEC.write654321, reply: SPEC.writeAck },
      readBack('00 09 FB F1'),
    ]);
    const sessions: SessionPatch[] = [];
    const logs: string[] = [];
    await setBlePasskey(opContext(link, sessions, logs), 654321);
    link.done();
    expect(sessions[0]).toEqual({ unlocked: true });
    expect(sessions[1].engmodeAt).toEqual(expect.any(Number));
    expect(logs[logs.length - 1]).toBe('[ble-passkey] 654321 written and verified; live for the next pairing');
  });

  it('puts the high word first', async () => {
    const link = new MockLink([LOGIN, ENGMODE, write('00 00 30 39'), readBack('00 00 30 39')]); // 12345
    await setBlePasskey(opContext(link), 12345);
    link.done();
  });

  it('reads the passkey in effect with the spec frame (the default on an unprovisioned unit)', async () => {
    const logs: string[] = [];
    const link = new MockLink([LOGIN, ENGMODE, { expect: SPEC.readReq, reply: SPEC.readResp123456 }]);
    expect(await readBlePasskey(opContext(link, [], logs))).toBe(BLE_PASSKEY_DEFAULT);
    expect(logs[logs.length - 1]).toBe('[ble-passkey] 123456');
    link.done();
  });

  it('refuses out-of-range values before sending anything', async () => {
    for (const bad of [1000000, -1, 1.5, NaN]) {
      const link = new MockLink([]);
      await expect(setBlePasskey(opContext(link), bad)).rejects.toThrow(RangeError);
      expect(link.written).toEqual([]);
    }
  });

  it('fails on a read-back mismatch', async () => {
    const link = new MockLink([LOGIN, ENGMODE, { expect: SPEC.write654321, reply: SPEC.writeAck }, readBack('00 01 E2 40')]);
    await expect(setBlePasskey(opContext(link), 654321)).rejects.toThrow('[ble-passkey] MISMATCH wrote 654321 read back 123456');
  });

  it('surfaces the engineering-mode exception', async () => {
    const link = new MockLink([LOGIN, ENGMODE, { expect: SPEC.readReq, reply: SPEC.noEngmode }]);
    const err = await readBlePasskey(opContext(link)).catch((e) => e);
    expect(err).toBeInstanceOf(ModbusException);
    expect((err as ModbusException).code).toBe(0x10);
  });
});

describe('provision with a BLE passkey (ttool provision --ble-passkey)', () => {
  const SN_WRITE: Step = {
    expect: appendCrc(h('01 10 EA 60 00 06 0C 41 42 00 00 00 00 00 00 00 00 00 00')),
    reply: appendCrc(h('01 10 EA 60 00 06')),
  };
  const SN_VERIFY: Step = {
    expect: appendCrc(h('01 04 EA 60 00 06')),
    reply: appendCrc(h('01 04 0C 41 42 00 00 00 00 00 00 00 00 00 00')),
  };

  it('writes the passkey after the identity and records it', async () => {
    const logs: string[] = [];
    const link = new MockLink([
      LOGIN,
      ENGMODE,
      SN_WRITE,
      SN_VERIFY,
      { expect: SPEC.write654321, reply: SPEC.writeAck },
      readBack('00 09 FB F1'),
      VERSION,
    ]);
    const r = await provision(opContext(link, [], logs), { sn: 'AB' }, 654321);
    link.done();
    expect(r.ok).toBe(true);
    expect(r.record).toMatch(/,sn=AB,ble_passkey=654321,fw=1\.20,PASS$/);
    expect(logs).toContain('[provision] BLE passkey: 654321 written and verified');
  });

  it('takes the passkey alone, and reports a mismatch as FAIL', async () => {
    const link = new MockLink([LOGIN, ENGMODE, write('00 00 00 2A'), readBack('00 01 E2 40'), VERSION]);
    const r = await provision(opContext(link), {}, 42);
    link.done();
    expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual(['[provision] BLE passkey: MISMATCH wrote 000042 read back 123456']);
    expect(r.record).toMatch(/,ble_passkey=000042,fw=1\.20,FAIL$/);
  });

  it('needs at least one field', async () => {
    await expect(provision(opContext(new MockLink([])), {})).rejects.toThrow(/at least one/);
  });
});
