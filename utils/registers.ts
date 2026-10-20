// Register map pieces the tool reads or writes. Addresses and field sizes are
// from docs/NTN_MODBUS_SPEC.md (authoritative) as summarised in
// docs/USER_MANUAL.md §5 / §8 / Appendix A, and ttool.py's tables.

import { wordsToString } from './ntnCodec';

// ---- control registers (FC 0x06) -------------------------------------------
export const ENGMODE_ADDR = 0xffd0; // engineering mode, valid 5 minutes
export const RESET_CTRL_ADDR = 0xfd00;
export const FACTORY_RESET_ADDR = 0xfd10;
export const DBGCON_ADDR = 0xfd20;
export const ENABLE_CODE = 0xaa55;
export const DBGCON_DISABLE_CODE = 0x55aa;
export const FACTORY_RESET_LV1_CODE = 0x5cc5; // netcfg + modbus id + password (+ actmode, baud, all BLE bonds)
export const FACTORY_RESET_LV2_CODE = 0xc55c; // Lv1 + SN / Model / SKU + BLE passkey
export const ENGMODE_VALID_MS = 5 * 60 * 1000;

// ---- system info block (FC 0x04, 0xEA60..0xEA7D in one read) ------------------
export const SYSINFO_ADDR = 0xea60;
export const SYSINFO_WORDS = 30;
export const FW_VERSION_ADDR = 0xea6b;
export const MODBUS_ID_ADDR = 0xea6f;
export const RESET_CAUSE_ADDR = 0xea70;
export const PCIE_STATUS_ADDR = 0xea72;
export const PCIE_STATUS_LORA_READY = 0x0001;
export const SN_ADDR = 0xea60;
export const IMSI_ADDR = 0xeb00;

// ---- NTN module block (FC 0x04, 0xEB00..0xEB32 in one read) --------------------
export const NTNINFO_ADDR = 0xeb00;
export const NTNINFO_WORDS = 51;

export interface SysInfo {
  sn: string;
  model: string;
  fwVersion: string;
  hwVersion: string;
  modbusId: number;
  resetCause: number;
  linkStatus: number;
  pcieStatus: number;
  sku: string;
  uplinkBusy: boolean;
}

export interface NtnInfo {
  imsi: string;
  swVersion: string;
  sinr: string;
  rsrp: string;
  time: string;
  latitude: string;
  longitude: string;
  grade: string;
  netMode: number;
  ip: string;
  socket: number;
}

function field(words: number[], base: number, addr: number, len: number): number[] {
  return words.slice(addr - base, addr - base + len);
}

export function decodeSysInfo(w: number[]): SysInfo {
  const b = SYSINFO_ADDR;
  return {
    sn: wordsToString(field(w, b, 0xea60, 6)),
    model: wordsToString(field(w, b, 0xea66, 5)),
    fwVersion: wordsToString(field(w, b, 0xea6b, 2)),
    hwVersion: wordsToString(field(w, b, 0xea6d, 2)),
    modbusId: w[0xea6f - b],
    resetCause: w[0xea70 - b],
    linkStatus: w[0xea71 - b],
    pcieStatus: w[0xea72 - b],
    sku: wordsToString(field(w, b, 0xea73, 10)),
    uplinkBusy: w[0xea7d - b] !== 0,
  };
}

export function decodeNtnInfo(w: number[]): NtnInfo {
  const b = NTNINFO_ADDR;
  return {
    imsi: wordsToString(field(w, b, 0xeb00, 8)),
    swVersion: wordsToString(field(w, b, 0xeb08, 11)),
    sinr: wordsToString(field(w, b, 0xeb13, 2)),
    rsrp: wordsToString(field(w, b, 0xeb15, 2)),
    time: wordsToString(field(w, b, 0xeb17, 4)),
    latitude: wordsToString(field(w, b, 0xeb1b, 5)),
    longitude: wordsToString(field(w, b, 0xeb20, 6)),
    grade: wordsToString(field(w, b, 0xeb26, 3)),
    netMode: w[0xeb29 - b],
    ip: wordsToString(field(w, b, 0xeb2a, 8)),
    socket: w[0xeb32 - b],
  };
}

/** 0xEA71 bits, in boot order. i18n key `link.bit<N>`. */
export const LINK_STATUS_BITS = [0, 1, 2, 3, 4] as const;
export const LINK_ONLINE = 0x001f;

/** 0xEA70 reset cause bits (hwinfo RESETREAS low 16 bits). i18n key `reset.<hex>`. */
export const RESET_CAUSE_BITS = [0x0001, 0x0002, 0x0010, 0x0020] as const;

// ---- working mode / active mode block (FC 0x03, 0xC350..0xC35A) ----------------
export const WORKMODE_ADDR = 0xc350;
export const WORKMODE_MODBUS = 1;
export const WORKMODE_PT_NTN = 3;
export const WORKMODE_PT_LORA = 4;
export const ACTMODE_BLOCK_ADDR = 0xc350;
export const ACTMODE_BLOCK_WORDS = 11;
export const ACTMODE_CSQ_IVL_ADDR = 0xc354;
export const ACTMODE_REG_ADDR = 0xc358;
export const ACTMODE_LORA_IVL_ADDR = 0xc359;
export const ACTMODE_IVL_MAX_S = 86400;
export const ACTMODE_IVL_DISABLED = 0xffffffff;
export const ACTMODE_MODES = [0, 1, 2, 3] as const;

// ---- UART baud (value = baud / 100) -------------------------------------------------
export const BAUD_HOST_ADDR = 0xc357;
export const BAUD_MODULE_ADDR = 0xffd1; // NTN; LoRa at 0xFFD2
export const BAUD_PORT_ADDR = { host: 0xc357, ntn: 0xffd1, lora: 0xffd2 } as const;
export type BaudPort = keyof typeof BAUD_PORT_ADDR;
export const BAUD_RATES = [9600, 14400, 19200, 38400, 57600, 115200, 230400, 460800, 921600] as const;
export const BAUD_DEFAULT_HOST = 115200;

// ---- UDP network config (FC 0x03 read / FC 0x10 write at field base) -------------------
export type NetcfgKey = 'remote_port' | 'apn' | 'remote_ip' | 'pdp_type' | 'local_port';
export type NetcfgKind = 'port' | 'apn' | 'ip' | 'pdp';
export const NETCFG_FIELDS: ReadonlyArray<{ key: NetcfgKey; addr: number; words: number; kind: NetcfgKind }> = [
  { key: 'remote_port', addr: 0xc3b8, words: 3, kind: 'port' },
  { key: 'apn', addr: 0xc3bb, words: 15, kind: 'apn' },
  { key: 'remote_ip', addr: 0xc3ca, words: 8, kind: 'ip' },
  { key: 'pdp_type', addr: 0xc3d2, words: 3, kind: 'pdp' },
  { key: 'local_port', addr: 0xc3d5, words: 3, kind: 'port' },
];
export const NETCFG_DEFAULTS: Record<NetcfgKey, string> = {
  remote_port: '7000',
  apn: 'vpnus.mono',
  remote_ip: '172.31.79.129',
  pdp_type: 'IP',
  local_port: '55001',
};

// ---- identity (FC 0x10 full-field writes, login + engineering mode) ---------------------
export type IdentityKey = 'sn' | 'model' | 'sku';
export const IDENTITY_FIELDS: ReadonlyArray<{ key: IdentityKey; addr: number; words: number }> = [
  { key: 'sn', addr: 0xea60, words: 6 },
  { key: 'model', addr: 0xea66, words: 5 },
  { key: 'sku', addr: 0xea73, words: 10 },
];
export const DEFAULT_MODBUS_ID = 1;
export const DEFAULT_SN = 'NTN-ADI01001'; // CONFIG_NTN_FACTORY_DEFAULT_SN
export const MODBUS_ID_MIN = 1;
export const MODBUS_ID_MAX = 247;
export const ASSIGN_ID_ADDR = 0xc830;

// ---- BLE passkey (U32 big-endian across 0xFFD3/0xFFD4, login + engineering mode) ------------
// Read FC 0x04, write FC 0x10 at 0xFFD3 with quantity 2 only; the engmode gate
// covers reads too, like 0xFFD1. Live for the next pairing; bonds are kept.
export const BLE_PASSKEY_ADDR = 0xffd3; // high word; low word at 0xFFD4
export const BLE_PASSKEY_WORDS = 2;
export const BLE_PASSKEY_DIGITS = 6; // as printed on the label, leading zeros included
export const BLE_PASSKEY_MAX = 999999;
export const BLE_PASSKEY_DEFAULT = 123456; // CONFIG_NTN_FACTORY_DEFAULT_BLE_PASSKEY

// ---- BLE advertising switch (0xFFD5, login only, not persisted) ---------------------------
// FC 0x06 write: 0 off now / 1 on with a fresh window / 2 on with no countdown.
// FC 0x04 read: 0 off / 1 on, waiting for a phone / 2 a paired phone connected.
// Every boot advertises for the build's window (600 s) and stops if no phone paired.
export const BLE_SWITCH_ADDR = 0xffd5;
export type BleSwitchAction = 'off' | 'on' | 'always';
export const BLE_SWITCH_VALUES: Record<BleSwitchAction, number> = { off: 0, on: 1, always: 2 };
export const BLE_SWITCH_STATES = [0, 1, 2] as const; // i18n key `bsw.state.<n>`
export const BLE_WINDOW_MIN = 10; // CONFIG_NTN_BLE_ADV_WINDOW_S default, for the UI text

// ---- LoRa ---------------------------------------------------------------------------------
export const LORA_AT_ADDR = 0xc750;
export const LORA_AT_MAX_BYTES = 246; // one FC 0x10 frame of 123 words
