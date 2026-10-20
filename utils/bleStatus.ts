// Decoder for the firmware's read-only BLE status service, GATT protocol v1
// (firmware repo docs/BLE_STATUS_SERVICE.md, authoritative). Plain
// TypeScript: no DOM, no React, no navigator.bluetooth -- the transport hands
// over the characteristic values and this turns them into typed records.
//
// All integers are little-endian (unlike the Modbus registers). Strings are
// ASCII padded with 0x00 and NOT NUL-terminated when they fill the field.
// Bytes past the known length are ignored (minor additions append); an
// unknown format version is refused.

import { decodeAscii } from './ntnCodec';

export const BLE_SERVICE_UUID = 'e8560001-df66-42ac-aca6-cc9af539c4f1';
export const BLE_STATUS_UUID = 'e8560002-df66-42ac-aca6-cc9af539c4f1';
export const BLE_IDENTITY_UUID = 'e8560003-df66-42ac-aca6-cc9af539c4f1';
/** CONFIG_NTN_BLE_NAME_PREFIX default; the advertised name is this + the SN. */
export const BLE_NAME_PREFIX = 'HX-';

export const BLE_FORMAT_VERSION = 1;
export const BLE_STATUS_LEN = 34;
export const BLE_IDENTITY_LEN = 124;
export const BLE_COUNTER_LEN = 2;

export const BLE_FLAG_CSQ_VALID = 0x01;
export const BLE_FLAG_TIME_VALID = 0x02;
export const BLE_CSQ_AGE_NEVER = 0xffffffff;

/** 0xEB26 grade as the status byte carries it. i18n key `ble.grade.<n>`. */
export const BLE_CSQ_GRADES = [0, 1, 2, 3] as const;

export class BleFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BleFormatError';
  }
}

export interface BleStatus {
  version: number;
  flags: number;
  /** flags bit0: rsrp / sinr / grade hold a real reading. */
  csqValid: boolean;
  /** Bumps whenever a status field at offsets 4..21 or any identity byte changes; restarts at 0 on every boot. */
  counter: number;
  /** 0xEA71 bits, LINK_STATUS_BITS / LINK_ONLINE. */
  linkStatus: number;
  /** 0xEA72, bit0 LoRa ready. */
  pcieStatus: number;
  /** 0xEA70, RESET_CAUSE_BITS. */
  resetCause: number;
  /** 0xEA7D: 0 Free, 1 Busy. */
  uplinkStatus: number;
  /** 0xC350: 1 Modbus, 3 NTN passthrough, 4 LoRa passthrough. */
  workmode: number;
  /** 0xC358. */
  actmode: number;
  rsrp: number;
  sinr: number;
  /** 0 none, 1 Poor, 2 Medium, 3 Good. */
  grade: number;
  /** Seconds since the last CSQ reading, or null when there never was one. */
  csqAgeS: number | null;
  uptimeS: number;
  /** Unix seconds (UTC), or null until the module clock was synced (flags bit1 clear or value 0). */
  moduleTimeS: number | null;
}

export interface BleIdentity {
  version: number;
  modbusId: number;
  sn: string;
  model: string;
  sku: string;
  /** Full APP_VERSION_STRING, e.g. "1.21.0" (0xEA6B holds only "M.mm"). */
  fwVersion: string;
  hwVersion: string;
  moduleSwVersion: string;
  /** Empty until the NTN module reported it. */
  imsi: string;
  latitude: string;
  longitude: string;
}

export type BleBytes = DataView | Uint8Array;

function asView(data: BleBytes): DataView {
  return data instanceof DataView ? data : new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function checkHeader(v: DataView, minLen: number, what: string): void {
  if (v.byteLength < 1) throw new BleFormatError(`${what}: empty value`);
  const version = v.getUint8(0);
  if (version !== BLE_FORMAT_VERSION) {
    throw new BleFormatError(`${what}: unknown format version ${version} (this page knows ${BLE_FORMAT_VERSION})`);
  }
  if (v.byteLength < minLen) throw new BleFormatError(`${what}: ${v.byteLength} bytes, expected at least ${minLen}`);
}

/** Field text up to the first NUL, or the whole field when it is full. */
function asciiField(v: DataView, offset: number, size: number): string {
  const bytes = new Uint8Array(v.buffer, v.byteOffset + offset, size);
  const nul = bytes.indexOf(0);
  return decodeAscii(nul < 0 ? bytes : bytes.subarray(0, nul));
}

/** Status characteristic, 34 bytes (BLE_STATUS_SERVICE.md §4.1). */
export function decodeBleStatus(data: BleBytes): BleStatus {
  const v = asView(data);
  checkHeader(v, BLE_STATUS_LEN, 'status');
  const flags = v.getUint8(1);
  const csqAge = v.getUint32(22, true);
  const moduleTime = v.getUint32(30, true);
  return {
    version: v.getUint8(0),
    flags,
    csqValid: (flags & BLE_FLAG_CSQ_VALID) !== 0,
    counter: v.getUint16(2, true),
    linkStatus: v.getUint16(4, true),
    pcieStatus: v.getUint16(6, true),
    resetCause: v.getUint16(8, true),
    uplinkStatus: v.getUint16(10, true),
    workmode: v.getUint16(12, true),
    actmode: v.getUint16(14, true),
    rsrp: v.getInt16(16, true),
    sinr: v.getInt16(18, true),
    grade: v.getUint8(20),
    csqAgeS: csqAge === BLE_CSQ_AGE_NEVER ? null : csqAge,
    uptimeS: v.getUint32(26, true),
    moduleTimeS: (flags & BLE_FLAG_TIME_VALID) !== 0 && moduleTime !== 0 ? moduleTime : null,
  };
}

/** Identity characteristic, 124 bytes (BLE_STATUS_SERVICE.md §4.3). */
export function decodeBleIdentity(data: BleBytes): BleIdentity {
  const v = asView(data);
  checkHeader(v, BLE_IDENTITY_LEN, 'identity');
  return {
    version: v.getUint8(0),
    modbusId: v.getUint8(1),
    sn: asciiField(v, 2, 12),
    model: asciiField(v, 14, 10),
    sku: asciiField(v, 24, 20),
    fwVersion: asciiField(v, 44, 16),
    hwVersion: asciiField(v, 60, 4),
    moduleSwVersion: asciiField(v, 64, 22),
    imsi: asciiField(v, 86, 16),
    latitude: asciiField(v, 102, 10),
    longitude: asciiField(v, 112, 12),
  };
}

/** Notification payload: only the new change counter, u16 LE (§4.2). */
export function decodeBleCounter(data: BleBytes): number {
  const v = asView(data);
  if (v.byteLength < BLE_COUNTER_LEN) throw new BleFormatError(`notification: ${v.byteLength} bytes, expected ${BLE_COUNTER_LEN}`);
  return v.getUint16(0, true);
}
