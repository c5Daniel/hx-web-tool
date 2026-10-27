// NTN modem AT passthrough over Modbus (0x9C40 write, reply in 0x9C41/0x9C42),
// against a scripted device. Frames marked SPEC are quoted in the firmware
// repo's docs/NTN_MODBUS_SPEC.md "NTN AT Command Register" (and USER_MANUAL
// §10.11); the reply bytes are what the RMM-T1 sent on the DK.
import { describe, expect, it } from 'vitest';
import { appendCrc, hexDump } from '../utils/modbusRtu';
import { ntnAtPayload, ntnAtPoll, ntnAtReplyOk, ntnAtSend } from '../utils/ops/ntnAt';
import { h, MockLink, opContext, Step } from './mockLink';

const SPEC = {
  write: '01 10 9C 40 00 02 04 41 54 0D 0A DF E2',
  ack: '01 10 9C 40 00 02 6E 4C',
  lenReq: '01 04 9C 41 00 01 4F 8E',
  lenResp3: '01 04 02 00 03 F9 31',
  dataReq3: '01 04 9C 42 00 03 3E 4F',
  dataResp: '01 04 06 4F 4B 0D 0A 0D 0A 6C 9B',
};

const LOGIN: Step = {
  expect: '01 10 00 00 00 04 08 00 00 00 00 00 00 00 00 B6 7A',
  reply: '01 10 00 00 00 04 C1 CA',
};
const len = (n: number): Step => ({ expect: SPEC.lenReq, reply: appendCrc(h(`01 04 02 00 ${n.toString(16).padStart(2, '0')}`)) });

describe('NTN AT (0x9C40)', () => {
  it('reproduces the CRC of every frame the spec quotes', () => {
    for (const frame of Object.values(SPEC)) {
      const bytes = h(frame);
      expect(hexDump(appendCrc(bytes.subarray(0, bytes.length - 2)))).toBe(hexDump(bytes));
    }
  });

  it('builds the payload like ttool (CRLF, ASCII only, 246-byte cap)', () => {
    expect(hexDump(ntnAtPayload('AT', true))).toBe('41 54 0D 0A');
    expect(hexDump(ntnAtPayload('AT', false))).toBe('41 54');
    expect(() => ntnAtPayload('AT+é', true)).toThrow(/plain ASCII/);
    expect(() => ntnAtPayload('A'.repeat(245), true)).toThrow(/max 246/);
  });

  it('queues, polls 0x9C41 until the reply is there, then reads 0x9C42', async () => {
    const link = new MockLink([
      LOGIN,
      { expect: SPEC.write, reply: SPEC.ack },
      len(0),
      len(0),
      { expect: SPEC.lenReq, reply: SPEC.lenResp3 },
      { expect: SPEC.lenReq, reply: SPEC.lenResp3 },
      { expect: SPEC.dataReq3, reply: SPEC.dataResp },
    ]);
    const reply = await ntnAtSend(opContext(link), 'AT', { read: true, waitS: 5, crlf: true, pollMs: 5 });
    link.done();
    expect(reply?.text).toBe('OK\r\n\r\n');
    expect(ntnAtReplyOk(reply!)).toBe(true);
  });

  it('returns null without reading when read is off', async () => {
    const link = new MockLink([LOGIN, { expect: SPEC.write, reply: SPEC.ack }]);
    expect(await ntnAtSend(opContext(link), 'AT', { read: false, waitS: 5, crlf: true })).toBeNull();
    link.done();
  });

  it('gives up with null when nothing arrives in time', async () => {
    const steps: Step[] = [LOGIN, { expect: SPEC.write, reply: SPEC.ack }];
    for (let i = 0; i < 50; i++) steps.push(len(0));
    const link = new MockLink(steps);
    expect(await ntnAtSend(opContext(link), 'AT', { read: true, waitS: 0.05, crlf: true, pollMs: 5 })).toBeNull();
  });

  it('surfaces 0x06 when the previous command still runs', async () => {
    const link = new MockLink([LOGIN, { expect: SPEC.write, reply: appendCrc(h('01 90 06')) }]);
    await expect(ntnAtSend(opContext(link), 'AT', { read: true, waitS: 5, crlf: true })).rejects.toThrow(/0x06|Busy/);
  });

  it('reads an MCU status line as a reply without OK', async () => {
    const msg = 'Module response timeout.\r\n';
    const words = Math.ceil(msg.length / 2);
    const data = new Uint8Array(words * 2);
    data.set(new TextEncoder().encode(msg));
    const link = new MockLink([
      LOGIN,
      len(words),
      { expect: appendCrc(h(`01 04 9C 42 00 ${words.toString(16).padStart(2, '0')}`)), reply: appendCrc(new Uint8Array([1, 4, data.length, ...data])) },
    ]);
    const reply = await ntnAtPoll(opContext(link));
    link.done();
    expect(reply.text).toBe(msg);
    expect(ntnAtReplyOk(reply)).toBe(false);
  });
});
