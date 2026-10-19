import { describe, expect, it } from 'vitest';
import { appendCrc, ModbusClient } from '../utils/modbusRtu';
import {
  bytesToWords,
  decodeAscii,
  dlcmdEncode,
  dlcmdSelfTest,
  DLCMD_REFERENCE_IMSI,
  loraCmdIsBisget,
  loraNodeIntervalCmd,
  parseNodeIntervalRecord,
  parsePasswordHex,
  readDownlink,
  readUplinkResult,
  uplinkWireBytes,
  validateXmr,
  wordsToBytes,
  wordsToString,
  writeUplink,
} from '../utils/ntnCodec';
import { assignPayloadWords, asciiFieldWords } from '../utils/ops/factory';
import { validateNetcfgValue, parseIntervalArg } from '../utils/ops/config';
import { h, MockLink } from './mockLink';

const noLog = () => {};

describe('word packing', () => {
  it('is high byte first and pads odd lengths', () => {
    expect(bytesToWords(new Uint8Array([0x41, 0x42, 0x43]))).toEqual([0x4142, 0x4300]);
    expect(Array.from(wordsToBytes([0x312e, 0x3230]))).toEqual([0x31, 0x2e, 0x32, 0x30]);
    expect(wordsToString([0x3730, 0x3030, 0x0000])).toBe('7000');
  });

  it('parses the password', () => {
    expect(Array.from(parsePasswordHex('11 22 33 44 55 66 77 88'))).toEqual([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
    expect(() => parsePasswordHex('1122')).toThrow();
  });
});

describe('dlcmd encoder', () => {
  it('reproduces all reference frames', () => {
    for (const r of dlcmdSelfTest()) expect(r.got).toBe(r.expected);
  });

  it('refuses quotes in strings and oversize bodies', () => {
    expect(() => dlcmdEncode(DLCMD_REFERENCE_IMSI, { xmr: 'AT+BISCSENDWR="x"' })).toThrow();
    expect(() => dlcmdEncode(DLCMD_REFERENCE_IMSI, { xmr: 'A'.repeat(300) })).toThrow(/limit/);
    expect(() => dlcmdEncode('', { active: 2 })).toThrow(/IMSI/);
  });

  it('validates xmr like ttool', () => {
    expect(validateXmr('AT+BISCSENDWR=3:01')).toBeNull();
    expect(validateXmr('ATZ')).toMatch(/start/);
    expect(validateXmr('AT+BISCSENDWR=3:01\r\n')).toMatch(/CR/);
  });
});

describe('LoRa node interval', () => {
  it('builds the get and set frames', () => {
    expect(loraNodeIntervalCmd(3)).toBe('AT+BISCSEND=3:016B41CF');
    expect(loraNodeIntervalCmd(0, 30)).toBe('AT+BISCSEND=0:016A0000001E99CB');
    expect(() => loraNodeIntervalCmd(31)).toThrow();
    expect(() => loraNodeIntervalCmd(0, 5)).toThrow();
  });

  it('parses a get-interval record', () => {
    expect(parseNodeIntervalRecord('00303cdf, 016b0000000aa404,-112,3\r\n\r\nOK\r\n')).toBe(10);
    expect(parseNodeIntervalRecord('00303cdf, 0103020001,-112,3')).toBeNull();
    expect(() => parseNodeIntervalRecord('00303cdf, 016b0000000aa405,-112,3')).toThrow(/malformed/);
  });

  it('routes BISGET to its own mailbox', () => {
    expect(loraCmdIsBisget(' at+bisget=3?')).toBe(true);
    expect(loraCmdIsBisget('AT+BISDEV=?')).toBe(false);
  });
});

describe('uplink / downlink flows', () => {
  it('writes the manual uplink frame for "AB"', async () => {
    const link = new MockLink([
      { expect: '01 04 EA 71 00 01 55 C9', reply: '01 04 02 00 1F F8 F8' },
      { expect: '01 04 EA 7D 00 01 95 CA', reply: '01 04 02 00 00 B9 30' },
      { expect: '01 10 C5 50 00 03 06 34 31 34 32 0D 0A 5A D6', reply: '01 10 C5 50 00 03 BC D5' },
    ]);
    const frags = await writeUplink(new ModbusClient(link), new TextEncoder().encode('AB'), noLog);
    expect(frags).toHaveLength(1);
    link.done();
  });

  it('refuses an uplink while offline', async () => {
    const link = new MockLink([{ expect: '01 04 EA 71 00 01 55 C9', reply: appendCrc(h('01 04 02 00 03')) }]);
    await expect(writeUplink(new ModbusClient(link), new Uint8Array([1]), noLog)).rejects.toThrow(/not online/);
  });

  it('fragments long uplinks at 0xC550 + words sent', () => {
    const wire = uplinkWireBytes(new Uint8Array(200), false); // 400 hex + CRLF = 201 words
    expect(bytesToWords(wire)).toHaveLength(201);
  });

  it('pads a raw odd body before the CRLF', () => {
    expect(decodeAscii(uplinkWireBytes(new TextEncoder().encode('xyz'), true))).toBe('xyz \r\n');
  });

  it('reads the manual uplink result', async () => {
    const link = new MockLink([
      { expect: '01 04 F0 60 00 01 02 D4', reply: '01 04 02 00 09 79 36' },
      {
        expect: '01 04 F0 61 00 09 52 D2',
        reply: '01 04 12 55 70 6C 69 6E 6B 20 43 6F 6D 70 6C 65 74 65 64 2E 00 5B FD',
      },
    ]);
    expect(await readUplinkResult(new ModbusClient(link), noLog)).toBe('Uplink Completed.');
  });

  it('reads and decodes the manual downlink', async () => {
    const link = new MockLink([
      { expect: '01 04 EC 60 00 01 05 44', reply: '01 04 02 00 02 38 F1' },
      { expect: '01 04 EC 61 00 02 14 85', reply: '01 04 04 34 31 34 32 33 6E' },
    ]);
    const d = await readDownlink(new ModbusClient(link), noLog);
    expect(d.lengthWords).toBe(2);
    expect(decodeAscii(d.payload!)).toBe('AB');
  });
});

describe('field encoders', () => {
  it('zero-pads identity fields', () => {
    expect(asciiFieldWords('AB', 3)).toEqual([0x4142, 0, 0]);
    expect(() => asciiFieldWords('ABCDEFG', 3)).toThrow();
  });

  it('builds the assign-id payloads', () => {
    expect(assignPayloadWords('sn', 'NTN-001', 5)).toHaveLength(8);
    const imsi = assignPayloadWords('imsi', '240075909399344', 7);
    expect(imsi).toHaveLength(9);
    expect(imsi[0]).toBe(0x0207);
  });

  it('validates netcfg values like the firmware', () => {
    expect(validateNetcfgValue('port', '7000', 6)).toBeNull();
    expect(validateNetcfgValue('port', '70000', 6)).not.toBeNull();
    expect(validateNetcfgValue('apn', 'a b', 30)).not.toBeNull();
    expect(validateNetcfgValue('pdp', 'Non-IP', 6)).toBeNull();
    expect(validateNetcfgValue('ip', '1.2.3.x', 16)).not.toBeNull();
  });

  it('parses intervals', () => {
    expect(parseIntervalArg('off')).toBe(0xffffffff);
    expect(parseIntervalArg('120')).toBe(120);
    expect(() => parseIntervalArg('86401')).toThrow();
  });
});
