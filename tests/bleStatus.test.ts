import { describe, expect, it } from 'vitest';
import {
  BLE_IDENTITY_LEN,
  BLE_IDENTITY_UUID,
  BLE_SERVICE_UUID,
  BLE_STATUS_UUID,
  BleFormatError,
  decodeBleCounter,
  decodeBleIdentity,
  decodeBleStatus,
} from '../utils/bleStatus';
import { h } from './mockLink';

// docs/BLE_STATUS_SERVICE.md §5, byte for byte.
const STATUS_EXAMPLE = h(`
  01 03 07 00 1F 00 01 00 02 00 00 00 01 00 03 00
  92 FF 03 00 03 00 2A 00 00 00 10 0E 00 00 80 1F D7 6A`);

/** An identity value built from the §4.3 layout: [offset, size, text]. */
function identityBytes(fields: Array<[number, number, string]>, modbusId = 1, version = 1): Uint8Array {
  const out = new Uint8Array(BLE_IDENTITY_LEN);
  out[0] = version;
  out[1] = modbusId;
  for (const [offset, size, text] of fields) {
    if (text.length > size) throw new Error(`test vector: '${text}' does not fit ${size}`);
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  }
  return out;
}

const IDENTITY_FIELDS: Array<[number, number, string]> = [
  [2, 12, 'NTN-ADI01001'], // full width: no NUL
  [14, 10, 'HX-NTN'],
  [24, 20, 'SKU-0123456789ABCDEF'], // full width
  [44, 16, '1.21.0'],
  [60, 4, 'V001'], // full width
  [64, 22, 'RMM-T1_1.2.3'],
  [86, 16, '240075909399344'],
  [102, 10, '25.033964'],
  [112, 12, '121.564468'],
];

describe('BLE UUIDs', () => {
  it('are lower-case canonical strings (Web Bluetooth rejects anything else)', () => {
    for (const u of [BLE_SERVICE_UUID, BLE_STATUS_UUID, BLE_IDENTITY_UUID]) {
      expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });
});

describe('decodeBleStatus', () => {
  it('decodes the spec example', () => {
    expect(decodeBleStatus(STATUS_EXAMPLE)).toEqual({
      version: 1,
      flags: 3,
      csqValid: true,
      counter: 7,
      linkStatus: 0x001f,
      pcieStatus: 1,
      resetCause: 2,
      uplinkStatus: 0,
      workmode: 1,
      actmode: 3,
      rsrp: -110,
      sinr: 3,
      grade: 3,
      csqAgeS: 42,
      uptimeS: 3600,
      moduleTimeS: 1792483200,
    });
    expect(new Date(1792483200 * 1000).toISOString()).toBe('2026-10-20T08:00:00.000Z');
  });

  it('takes a DataView, and a Uint8Array that is a window into a bigger buffer', () => {
    const big = new Uint8Array(40);
    big.set(STATUS_EXAMPLE, 3);
    const view = new DataView(big.buffer, 3, STATUS_EXAMPLE.length);
    const want = decodeBleStatus(STATUS_EXAMPLE);
    expect(decodeBleStatus(view)).toEqual(want);
    expect(decodeBleStatus(big.subarray(3))).toEqual(want);
  });

  it('ignores trailing bytes from a later minor version', () => {
    const longer = new Uint8Array([...STATUS_EXAMPLE, 0xaa, 0xbb, 0xcc, 0xdd]);
    expect(decodeBleStatus(longer)).toEqual(decodeBleStatus(STATUS_EXAMPLE));
  });

  it('refuses an unknown format version and a short value', () => {
    const v2 = STATUS_EXAMPLE.slice();
    v2[0] = 2;
    expect(() => decodeBleStatus(v2)).toThrow(BleFormatError);
    expect(() => decodeBleStatus(v2)).toThrow(/version 2/);
    expect(() => decodeBleStatus(STATUS_EXAMPLE.subarray(0, 33))).toThrow(/33 bytes/);
    expect(() => decodeBleStatus(new Uint8Array(0))).toThrow(BleFormatError);
  });

  it('reports no CSQ reading and an unsynced clock', () => {
    const v = STATUS_EXAMPLE.slice();
    v[1] = 0; // flags: neither CSQ nor time valid
    v.set([0xff, 0xff, 0xff, 0xff], 22); // CSQ age: never
    const s = decodeBleStatus(v);
    expect(s.csqValid).toBe(false);
    expect(s.csqAgeS).toBeNull();
    expect(s.moduleTimeS).toBeNull(); // flag clear wins over a non-zero value

    v[1] = 0x02;
    v.set([0, 0, 0, 0], 30);
    expect(decodeBleStatus(v).moduleTimeS).toBeNull(); // 0 = not synced, whatever the flag says
  });
});

describe('decodeBleIdentity', () => {
  it('cuts NUL padding and keeps full-width fields whole', () => {
    expect(decodeBleIdentity(identityBytes(IDENTITY_FIELDS, 17))).toEqual({
      version: 1,
      modbusId: 17,
      sn: 'NTN-ADI01001',
      model: 'HX-NTN',
      sku: 'SKU-0123456789ABCDEF',
      fwVersion: '1.21.0',
      hwVersion: 'V001',
      moduleSwVersion: 'RMM-T1_1.2.3',
      imsi: '240075909399344',
      latitude: '25.033964',
      longitude: '121.564468',
    });
  });

  it('does not run a full-width field into its neighbour', () => {
    const id = decodeBleIdentity(identityBytes([[2, 12, 'ABCDEFGHIJKL'], [14, 10, 'MODEL']]));
    expect(id.sn).toBe('ABCDEFGHIJKL');
    expect(id.model).toBe('MODEL');
  });

  it('gives empty strings before the module reported IMSI and GPS', () => {
    const id = decodeBleIdentity(identityBytes(IDENTITY_FIELDS.slice(0, 6)));
    expect(id.imsi).toBe('');
    expect(id.latitude).toBe('');
    expect(id.longitude).toBe('');
  });

  it('ignores trailing bytes and refuses an unknown version or a short value', () => {
    const base = identityBytes(IDENTITY_FIELDS);
    expect(decodeBleIdentity(new Uint8Array([...base, 1, 2, 3]))).toEqual(decodeBleIdentity(base));
    expect(() => decodeBleIdentity(identityBytes(IDENTITY_FIELDS, 1, 9))).toThrow(/version 9/);
    expect(() => decodeBleIdentity(base.subarray(0, 123))).toThrow(BleFormatError);
  });
});

describe('decodeBleCounter', () => {
  it('reads the u16 LE counter of a notification', () => {
    expect(decodeBleCounter(h('07 00'))).toBe(7);
    expect(decodeBleCounter(h('34 12'))).toBe(0x1234);
    expect(decodeBleCounter(h('FF FF'))).toBe(65535);
    expect(() => decodeBleCounter(h('07'))).toThrow(BleFormatError);
  });
});
