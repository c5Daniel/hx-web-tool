// NTN register packing and the multi-register flows, ported from
// ttool/ntn_codec.py: uplink, uplink result, downlink, LoRa mailboxes,
// password, LoRa node interval frames and the +ESONMI remote-config encoder.

import { appendCrc, hex4, ModbusClient, verifyCrc } from './modbusRtu';

export const DOWNLINK_LEN_ADDR = 0xec60;
export const DOWNLINK_DATA_ADDR = 0xec61;
export const UPLINK_RESULT_LEN_ADDR = 0xf060;
export const UPLINK_RESULT_DATA_ADDR = 0xf061;
export const UPLINK_RESULT_MAX_WORDS = 16;
// LoRa reply mailboxes: AT+BISGET* answers land in 0xF460, every other reply in 0xF860.
export const LORA_BISGET_LEN_ADDR = 0xf460;
export const LORA_BISGET_DATA_ADDR = 0xf461;
export const LORA_REPLY_LEN_ADDR = 0xf860;
export const LORA_REPLY_DATA_ADDR = 0xf861;
export const LORA_REPLY_MAX_WORDS = 256;
// NTN modem AT passthrough: the reply to a 0x9C40 command (or an MCU status line).
export const NTN_AT_REPLY_LEN_ADDR = 0x9c41;
export const NTN_AT_REPLY_DATA_ADDR = 0x9c42;
export const NTN_AT_REPLY_MAX_WORDS = 256;
export const UPLINK_HOLDING_ADDR = 0xc550;
export const MODULE_STATUS_ADDR = 0xea71;
export const MODULE_STATUS_ONLINE = 0x001f;
export const UPLINK_STATUS_ADDR = 0xea7d;
export const PASSWORD_LOGIN_ADDR = 0x0000;
export const PASSWORD_CHANGE_ADDR = 0x0004;
export const PASSWORD_LEN = 8;
export const DEFAULT_PASSWORD_HEX = '0000000000000000';

export const MAX_READ_WORDS = 125;
export const UPLINK_MAX_WORDS_PER_FRAG = 120;
export const UPLINK_MAX_PAYLOAD_BYTES = 497;
export const DOWNLINK_MAX_WORDS = 494;

export type Log = (msg: string, isError?: boolean) => void;

export class UplinkNotReady extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UplinkNotReady';
  }
}

// ---- byte / word helpers ---------------------------------------------------

const enc = new TextEncoder();

export function asciiBytes(text: string): Uint8Array {
  return enc.encode(text);
}

/** Register words -> bytes, high byte first. */
export function wordsToBytes(words: number[]): Uint8Array {
  const out = new Uint8Array(words.length * 2);
  words.forEach((w, i) => {
    out[2 * i] = (w >> 8) & 0xff;
    out[2 * i + 1] = w & 0xff;
  });
  return out;
}

/** Bytes -> register words, high byte first; an odd length pads 0x00. */
export function bytesToWords(data: Uint8Array): number[] {
  const words: number[] = [];
  for (let i = 0; i < data.length; i += 2) words.push((data[i] << 8) | (i + 1 < data.length ? data[i + 1] : 0));
  return words;
}

export function asciiPreview(data: Uint8Array): string {
  return Array.from(data, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
}

export function wordsHex(words: number[]): string {
  return words.map(hex4).join(' ');
}

export function stripTrailingNul(data: Uint8Array): Uint8Array {
  let end = data.length;
  while (end > 0 && data[end - 1] === 0) end--;
  return data.subarray(0, end);
}

/** ASCII decode with U+FFFD for non-ASCII, like Python's decode('ascii', 'replace'). */
export function decodeAscii(data: Uint8Array): string {
  return Array.from(data, (b) => (b < 128 ? String.fromCharCode(b) : '�')).join('');
}

/** A string register as text: trailing NULs stripped. */
export function wordsToString(words: number[]): string {
  return decodeAscii(stripTrailingNul(wordsToBytes(words)));
}

export function bytesToHex(data: Uint8Array): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Lower-case or upper-case hex, optional whitespace -> bytes. Throws on bad input. */
export function hexToBytes(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '');
  if (clean.length % 2 || /[^0-9a-fA-F]/.test(clean)) throw new Error(`invalid hex: ${text}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(2 * i, 2), 16);
  return out;
}

// ---- segmented reads ---------------------------------------------------------

async function readSegmented(client: ModbusClient, base: number, n: number, tag: string): Promise<number[]> {
  const words: number[] = [];
  for (let offset = 0, seg = 0; offset < n; seg++) {
    const qty = Math.min(n - offset, MAX_READ_WORDS);
    const addr = base + offset;
    words.push(...(await client.readInput(addr, qty, `${tag} seg${seg} 0x${hex4(addr)}x${qty}`)));
    offset += qty;
  }
  return words;
}

// ---- password ------------------------------------------------------------------

export function parsePasswordHex(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '');
  if (clean.length !== PASSWORD_LEN * 2) {
    throw new Error(`password must be ${PASSWORD_LEN} bytes (${PASSWORD_LEN * 2} hex chars), got ${clean.length} chars`);
  }
  return hexToBytes(clean);
}

/** FC 0x10 login at 0x0000 (4 registers / 8 bytes). */
export async function passwordLogin(client: ModbusClient, password: Uint8Array): Promise<void> {
  if (password.length !== PASSWORD_LEN) throw new Error(`password must be ${PASSWORD_LEN} bytes`);
  await client.writeMultiple(PASSWORD_LOGIN_ADDR, bytesToWords(password), 'password login 0x0000');
}

/** FC 0x10 change at 0x0004: current(8) + new(8). Requires an unlocked session. */
export async function passwordChange(client: ModbusClient, current: Uint8Array, next: Uint8Array): Promise<void> {
  if (current.length !== PASSWORD_LEN || next.length !== PASSWORD_LEN) {
    throw new Error(`passwords must be ${PASSWORD_LEN} bytes each`);
  }
  const payload = new Uint8Array(16);
  payload.set(current, 0);
  payload.set(next, 8);
  await client.writeMultiple(PASSWORD_CHANGE_ADDR, bytesToWords(payload), 'password change 0x0004');
}

// ---- uplink ------------------------------------------------------------------------

/** Host gate: 0xEA71 must be 0x001F, then 0xEA7D must be Free (0). */
export async function ensureUplinkReady(client: ModbusClient, log: Log): Promise<void> {
  const ea71 = (await client.readInput(MODULE_STATUS_ADDR, 1, 'read 0xEA71 module status'))[0];
  log(`[ul] EA71=0x${hex4(ea71)} (need 0x${hex4(MODULE_STATUS_ONLINE)})`);
  if (ea71 !== MODULE_STATUS_ONLINE) {
    throw new UplinkNotReady(`0xEA71=0x${hex4(ea71)} not online (need 0x${hex4(MODULE_STATUS_ONLINE)})`);
  }
  const ea7d = (await client.readInput(UPLINK_STATUS_ADDR, 1, 'read 0xEA7D uplink status'))[0];
  log(`[ul] EA7D=${ea7d} (need 0=Free)`);
  if (ea7d !== 0) throw new UplinkNotReady(`0xEA7D=${ea7d} busy (need 0=Free)`);
}

/** The bytes written to 0xC550: lowercase hex of the payload + CRLF, or the raw body (negative test). */
export function uplinkWireBytes(payload: Uint8Array, raw: boolean): Uint8Array {
  if (!raw) return asciiBytes(bytesToHex(payload) + '\r\n');
  let body = payload;
  if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
    body = body.subarray(0, body.length - 2);
  }
  // Modbus needs an even byte count; pad the body (not after CRLF) so the
  // MCU still sees the trailing CRLF. Deliberate garbage for the 0x03 test.
  const pad = body.length % 2 ? 1 : 0;
  const wire = new Uint8Array(body.length + pad + 2);
  wire.set(body, 0);
  if (pad) wire[body.length] = 0x20;
  wire[wire.length - 2] = 0x0d;
  wire[wire.length - 1] = 0x0a;
  return wire;
}

export interface UplinkFragment {
  index: number;
  address: number;
  words: number[];
}

/** Gate check, then FC 0x10 fragments: first at 0xC550, each next at 0xC550 + words already sent. */
export async function writeUplink(
  client: ModbusClient,
  payload: Uint8Array,
  log: Log,
  raw = false,
): Promise<UplinkFragment[]> {
  await ensureUplinkReady(client, log);
  const wire = uplinkWireBytes(payload, raw);
  const words = bytesToWords(wire);
  log(`[ul] payload ${payload.length} bytes -> wire ${wire.length} bytes = ${words.length} words${raw ? ' (RAW, no hexlify)' : ''}`);
  const frags: UplinkFragment[] = [];
  for (let offset = 0; offset < words.length; offset += UPLINK_MAX_WORDS_PER_FRAG) {
    const chunk = words.slice(offset, offset + UPLINK_MAX_WORDS_PER_FRAG);
    const addr = UPLINK_HOLDING_ADDR + offset;
    await client.writeMultiple(addr, chunk, `uplink frag${frags.length} 0x${hex4(addr)}x${chunk.length}`);
    frags.push({ index: frags.length, address: addr, words: chunk });
  }
  log(`[ul] sent ${frags.length} fragment(s)`);
  return frags;
}

/** 0xF060 length, then the plain-ASCII result message at 0xF061. Empty string = no result yet. */
export async function readUplinkResult(client: ModbusClient, log: Log): Promise<string> {
  let n = (await client.readInput(UPLINK_RESULT_LEN_ADDR, 1, 'uplink result length 0xF060'))[0];
  if (n === 0) return '';
  if (n > UPLINK_RESULT_MAX_WORDS) {
    log(`[ulres] length ${n} exceeds max ${UPLINK_RESULT_MAX_WORDS}; clamping`, true);
    n = UPLINK_RESULT_MAX_WORDS;
  }
  const words = await client.readInput(UPLINK_RESULT_DATA_ADDR, n, `uplink result data 0xF061x${n}`);
  return wordsToString(words);
}

// ---- downlink ----------------------------------------------------------------------

export interface DownlinkResult {
  lengthWords: number;
  /** Hex-ASCII as stored in 0xEC61 (CRC already stripped by the MCU). */
  storedHex: Uint8Array;
  /** Decoded payload; null when the stored text is not valid hex. */
  payload: Uint8Array | null;
}

/** 0xEC60 length, then segment-read 0xEC61+. Reading every word clears it MCU-side. */
export async function readDownlink(client: ModbusClient, log: Log): Promise<DownlinkResult> {
  const n = (await client.readInput(DOWNLINK_LEN_ADDR, 1, 'downlink length 0xEC60'))[0];
  if (n === 0) return { lengthWords: 0, storedHex: new Uint8Array(0), payload: null };
  if (n > DOWNLINK_MAX_WORDS) log(`[dl] length ${n} exceeds max ${DOWNLINK_MAX_WORDS}; reading anyway`, true);
  const words = await readSegmented(client, DOWNLINK_DATA_ADDR, n, 'downlink data');
  const storedHex = wordsToBytes(words);
  let hexText = stripTrailingNul(storedHex);
  if (hexText.length % 2) hexText = storedHex; // keep raw if the strip made it odd
  let payload: Uint8Array | null = null;
  try {
    payload = hexToBytes(decodeAscii(hexText));
  } catch {
    log('[dl] stored data is not valid hex; showing it undecoded', true);
  }
  return { lengthWords: n, storedHex, payload };
}

// ---- LoRa mailboxes ------------------------------------------------------------------

export interface LoraReply {
  lengthWords: number;
  raw: Uint8Array;
  text: string;
}

/** Which mailbox the MCU routes this command's reply into. */
export function loraCmdIsBisget(command: string): boolean {
  return command.trim().toUpperCase().startsWith('AT+BISGET');
}

/** Length register, then the data segmented. Reading every word clears the mailbox MCU-side. */
async function readByteMailbox(
  client: ModbusClient,
  lenAddr: number,
  dataAddr: number,
  maxWords: number,
  tag: string,
  log: Log,
): Promise<LoraReply> {
  let n = (await client.readInput(lenAddr, 1, `${tag} length 0x${hex4(lenAddr)}`))[0];
  if (n === 0) return { lengthWords: 0, raw: new Uint8Array(0), text: '' };
  if (n > maxWords) {
    log(`[${tag}] length ${n} exceeds max ${maxWords}; clamping`, true);
    n = maxWords;
  }
  const words = await readSegmented(client, dataAddr, n, tag);
  const raw = stripTrailingNul(wordsToBytes(words));
  return { lengthWords: n, raw, text: decodeAscii(raw) };
}

/** Read one LoRa reply mailbox. Reading every word clears it, so read each reply once. */
export async function readLoraReply(client: ModbusClient, bisget: boolean, log: Log): Promise<LoraReply> {
  return bisget
    ? readByteMailbox(client, LORA_BISGET_LEN_ADDR, LORA_BISGET_DATA_ADDR, LORA_REPLY_MAX_WORDS, 'lora bisget', log)
    : readByteMailbox(client, LORA_REPLY_LEN_ADDR, LORA_REPLY_DATA_ADDR, LORA_REPLY_MAX_WORDS, 'lora reply', log);
}

// ---- NTN AT mailbox --------------------------------------------------------------------

/** Read the NTN AT reply (0x9C41 length / 0x9C42 data). Same read-once rule as the LoRa mailboxes. */
export async function readNtnAtReply(client: ModbusClient, log: Log): Promise<LoraReply> {
  return readByteMailbox(client, NTN_AT_REPLY_LEN_ADDR, NTN_AT_REPLY_DATA_ADDR, NTN_AT_REPLY_MAX_WORDS, 'ntn-at', log);
}

// ---- LoRa node TX interval (vendor node frame over AT+BISCSEND) ---------------------
// <dev id 01><FC><payload><CRC16 lo hi>; FC 0x6A set (u32 BE seconds), FC 0x6B get.

export const LORA_NODE_INDEX_MAX = 30;
export const LORA_NODE_INTERVAL_MIN_S = 10;
export const LORA_NODE_INTERVAL_MAX_S = 86400;

export function loraNodeIntervalCmd(index: number, secs?: number): string {
  if (!Number.isInteger(index) || index < 0 || index > LORA_NODE_INDEX_MAX) {
    throw new RangeError(`node index ${index} outside 0..${LORA_NODE_INDEX_MAX}`);
  }
  let pdu: number[];
  if (secs === undefined) {
    pdu = [0x01, 0x6b];
  } else {
    if (!Number.isInteger(secs) || secs < LORA_NODE_INTERVAL_MIN_S || secs > LORA_NODE_INTERVAL_MAX_S) {
      throw new RangeError(`interval ${secs} s outside ${LORA_NODE_INTERVAL_MIN_S}..${LORA_NODE_INTERVAL_MAX_S}`);
    }
    pdu = [0x01, 0x6a, (secs >>> 24) & 0xff, (secs >>> 16) & 0xff, (secs >>> 8) & 0xff, secs & 0xff];
  }
  return `AT+BISCSEND=${index}:${bytesToHex(appendCrc(new Uint8Array(pdu))).toUpperCase()}`;
}

/**
 * Seconds from a get-interval record in an AT+BISGET reply, else null.
 * Throws when a record carries an FC 0x6B frame of the wrong length or CRC.
 */
export function parseNodeIntervalRecord(text: string): number | null {
  for (const line of text.split(/\r\n|\r|\n/)) {
    const fields = line.split(',').map((f) => f.trim());
    if (fields.length < 2) continue;
    let frame: Uint8Array;
    try {
      frame = hexToBytes(fields[1]);
    } catch {
      continue;
    }
    if (frame.length < 2 || frame[0] !== 0x01 || frame[1] !== 0x6b) continue;
    if (frame.length !== 8 || !verifyCrc(frame)) throw new Error(`malformed get-interval reply: '${line.trim()}'`);
    return ((frame[2] << 24) >>> 0) + (frame[3] << 16) + (frame[4] << 8) + frame[5];
  }
  return null;
}

// ---- remote configuration downlink (+ESONMI) encoder -----------------------------
// CRC32/IEEE over the lower-case hex *string* of the body (the AT+ESOSEND convention).

export const DLCMD_XMR_PREFIX = 'AT+BISCSENDWR=';
export const DLCMD_XMR_TEXT_MAX = 252;
export const DLCMD_MAX_TEXT = 288;
export const DLCMD_REFERENCE_IMSI = '240075909399344';

export type DlcmdValue = number | string;

export const DLCMD_REFERENCE: Array<{ fields: Record<string, DlcmdValue>; socket: number; urc: string }> = [
  {
    fields: { active: 2 },
    socket: 1,
    urc:
      '+ESONMI=1,42,3234303037353930393339393334347b2264617461223a207' +
      'b22616374697665223a20327d7d90da5b89',
  },
  {
    fields: { timeperiods: 120 },
    socket: 1,
    urc:
      '+ESONMI=1,49,3234303037353930393339393334347b2264617461223a207' +
      'b2274696d65706572696f6473223a203132307d7dde5013a3',
  },
  {
    fields: { lrtimeperiods: 120 },
    socket: 1,
    urc:
      '+ESONMI=1,51,3234303037353930393339393334347b2264617461223a207' +
      'b226c7274696d65706572696f6473223a203132307d7d14751043',
  },
  // Measured off a real satellite downlink, socket 0 (2026-09-20).
  {
    fields: { xmr: 'AT+BISCSENDWR=3:01060001000119ca010400040001700b' },
    socket: 0,
    urc:
      '+ESONMI=0,88,3234303037353930393339393334347b2264617461223a207' +
      'b22786d72223a202241542b4249534353454e4457523d333a3031303630303' +
      '031303030313139636130313034303030343030303137303062227d7dfacdbb84',
  },
];

let crcTable: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of data) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dlcmdValue(value: DlcmdValue): string {
  if (typeof value !== 'string') return String(value);
  for (const ch of value) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c > 0x7e || ch === '"' || ch === '\\') {
      throw new Error(`string values must be printable ASCII without quotes or backslashes; found ${JSON.stringify(ch)}`);
    }
  }
  return `"${value}"`;
}

export interface DlcmdFrame {
  text: string;
  bodyHex: string;
  crcHex: string;
  dataLen: number;
  urc: string;
}

/** Build one remote-configuration downlink. Field order is preserved. */
export function dlcmdEncode(imsi: string, fields: Record<string, DlcmdValue>, socketId = 1): DlcmdFrame {
  if (!imsi) throw new Error('IMSI is required: it is how the MCU addresses the command');
  const inner = Object.entries(fields)
    .map(([k, v]) => `"${k}": ${dlcmdValue(v)}`)
    .join(', ');
  const text = `${imsi}{"data": {${inner}}}`;
  if (text.length > DLCMD_MAX_TEXT) {
    throw new Error(
      `body is ${text.length} B, over the firmware's ${DLCMD_MAX_TEXT} B limit -- the MCU drops it before decoding and logs nothing`,
    );
  }
  const bodyHex = bytesToHex(asciiBytes(text));
  const crcHex = crc32(asciiBytes(bodyHex)).toString(16).padStart(8, '0');
  const dataLen = bodyHex.length / 2 + 4;
  return { text, bodyHex, crcHex, dataLen, urc: `+ESONMI=${socketId},${dataLen},${bodyHex}${crcHex}` };
}

/** Reproduce the reference frames. Returns one result per frame. */
export function dlcmdSelfTest(): Array<{ fields: Record<string, DlcmdValue>; ok: boolean; expected: string; got: string }> {
  return DLCMD_REFERENCE.map(({ fields, socket, urc }) => {
    const got = dlcmdEncode(DLCMD_REFERENCE_IMSI, fields, socket).urc;
    return { fields, ok: got === urc, expected: urc, got };
  });
}

/** The xmr value rules ttool enforces before encoding. Returns an error message or null. */
export function validateXmr(value: string): string | null {
  if (!value.startsWith(DLCMD_XMR_PREFIX)) return `must start with ${DLCMD_XMR_PREFIX}`;
  if (/[\r\n]$/.test(value)) return 'must not end in CR/LF (the firmware appends them)';
  if (value.length > DLCMD_XMR_TEXT_MAX) return `is ${value.length} characters, over the firmware's ${DLCMD_XMR_TEXT_MAX}`;
  return null;
}
