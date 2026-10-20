// BLE advertising switch over Modbus (0xFFD5, FC 0x06 write / FC 0x04 read,
// login only), against a scripted device. Frames marked SPEC are quoted in
// the firmware repo's docs/NTN_MODBUS_SPEC.md "BLE Switch".
import { describe, expect, it } from 'vitest';
import { appendCrc, hexDump } from '../utils/modbusRtu';
import { readBleSwitch, setBleSwitch } from '../utils/ops/config';
import { h, MockLink, opContext, Step } from './mockLink';

const SPEC = {
  readReq: '01 04 FF D5 00 01 10 26',
  readResp1: '01 04 02 00 01 78 F0',
  off: '01 06 FF D5 00 00 A8 26',
  on: '01 06 FF D5 00 01 69 E6',
  always: '01 06 FF D5 00 02 29 E7',
  value3: '01 06 FF D5 00 03 E8 27',
  badValue: '01 86 03 02 61',
  noStack: '01 86 04 43 A3',
  fc10: '01 10 FF D5 00 01 02 00 01 7B 5A',
  fc10Resp: '01 90 02 CD C1',
};

const LOGIN: Step = {
  expect: '01 10 00 00 00 04 08 00 00 00 00 00 00 00 00 B6 7A',
  reply: '01 10 00 00 00 04 C1 CA',
};
const state = (v: number): Step => ({ expect: SPEC.readReq, reply: appendCrc(h(`01 04 02 00 0${v}`)) });
const echo = (frame: string): Step => ({ expect: frame, reply: frame });

describe('BLE switch', () => {
  it('reproduces the CRC of every frame the spec quotes', () => {
    for (const frame of Object.values(SPEC)) {
      const bytes = h(frame);
      expect(hexDump(appendCrc(bytes.subarray(0, bytes.length - 2)))).toBe(hexDump(bytes));
    }
  });

  it('reads the state after login only (no engineering mode)', async () => {
    const logs: string[] = [];
    const link = new MockLink([LOGIN, { expect: SPEC.readReq, reply: SPEC.readResp1 }]);
    expect(await readBleSwitch(opContext(link, [], logs))).toBe(1);
    link.done();
    expect(logs[logs.length - 1]).toBe('[ble] 1');
  });

  it('writes each action with the spec frame and reads it back', async () => {
    for (const [action, frame, back] of [
      ['on', SPEC.on, 1],
      ['always', SPEC.always, 1],
      ['off', SPEC.off, 0],
    ] as const) {
      const link = new MockLink([LOGIN, echo(frame), state(back)]);
      expect(await setBleSwitch(opContext(link), action)).toBe(back);
      link.done();
    }
  });

  it('accepts 2 (paired phone connected) as the read-back of on', async () => {
    const link = new MockLink([LOGIN, echo(SPEC.on), state(2)]);
    expect(await setBleSwitch(opContext(link), 'on')).toBe(2);
    link.done();
  });

  it('fails when the read-back contradicts the write', async () => {
    const link = new MockLink([LOGIN, echo(SPEC.off), state(1)]);
    await expect(setBleSwitch(opContext(link), 'off')).rejects.toThrow('[ble] MISMATCH: wrote 0, read back 1');
  });

  it('explains 0x04 (no BLE stack on this unit)', async () => {
    const link = new MockLink([LOGIN, { expect: SPEC.on, reply: SPEC.noStack }]);
    await expect(setBleSwitch(opContext(link), 'on')).rejects.toThrow(/BLE stack is not running/);
  });
});
