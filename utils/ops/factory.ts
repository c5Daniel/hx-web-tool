// Production line and recovery: provision, ble-passkey, set-id, assign-id,
// reset, factory-reset (ttool cmd_provision / cmd_ble_passkey / cmd_set_id /
// cmd_assign_id / cmd_reset / cmd_factory_reset).

import { EXC_PWD_AUTH, hex4, ModbusException, ModbusError, ModbusTimeout } from '../modbusRtu';
import { asciiBytes, parsePasswordHex, DEFAULT_PASSWORD_HEX, wordsToString } from '../ntnCodec';
import {
  ASSIGN_ID_ADDR,
  BAUD_DEFAULT_HOST,
  BLE_PASSKEY_ADDR,
  BLE_PASSKEY_DIGITS,
  BLE_PASSKEY_MAX,
  BLE_PASSKEY_WORDS,
  DEFAULT_MODBUS_ID,
  DEFAULT_SN,
  ENABLE_CODE,
  FACTORY_RESET_ADDR,
  FACTORY_RESET_LV1_CODE,
  FACTORY_RESET_LV2_CODE,
  FW_VERSION_ADDR,
  IDENTITY_FIELDS,
  IdentityKey,
  IMSI_ADDR,
  MODBUS_ID_ADDR,
  MODBUS_ID_MAX,
  MODBUS_ID_MIN,
  NETCFG_DEFAULTS,
  RESET_CTRL_ADDR,
  SN_ADDR,
} from '../registers';
import { enableEngmode, login, mismatch, OpContext, sleep } from './context';
import { readNetcfgFields } from './config';

async function readVersion(ctx: OpContext): Promise<string> {
  return wordsToString(await ctx.client.readInput(FW_VERSION_ADDR, 2, 'read 0xEA6B fw version'));
}

async function readIdentity(ctx: OpContext, mode: 'sn' | 'imsi'): Promise<string> {
  const words =
    mode === 'sn'
      ? await ctx.client.readInput(SN_ADDR, 6, 'verify SN')
      : await ctx.client.readInput(IMSI_ADDR, 8, 'verify IMSI');
  return wordsToString(words);
}

/** A rebooting device forgets the unlock and engineering mode. */
function markRebooted(ctx: OpContext): void {
  ctx.session({ unlocked: false, engmodeAt: null, passthrough: null });
}

// ---- provision ------------------------------------------------------------------------

/** An identity string as a full field, zero-padded. */
export function asciiFieldWords(text: string, regWords: number): number[] {
  if (!text) throw new Error('must not be empty');
  if (!/^[\x20-\x7e]*$/.test(text)) throw new Error('must be printable ASCII');
  const data = asciiBytes(text);
  if (data.length > regWords * 2) throw new Error(`exceeds ${regWords * 2} bytes`);
  const padded = new Uint8Array(regWords * 2);
  padded.set(data, 0);
  const words: number[] = [];
  for (let i = 0; i < padded.length; i += 2) words.push((padded[i] << 8) | padded[i + 1]);
  return words;
}

export interface ProvisionResult {
  ok: boolean;
  mismatches: string[];
  fwVersion: string;
  /** The CSV line ttool prints for the production record. */
  record: string;
}

/** Identity fields and/or the BLE passkey (ttool `provision --ble-passkey`), written after the identity. */
export async function provision(
  ctx: OpContext,
  values: Partial<Record<IdentityKey, string>>,
  blePasskey?: number,
): Promise<ProvisionResult> {
  const writes = IDENTITY_FIELDS.filter((f) => values[f.key] !== undefined).map((f) => {
    try {
      return { ...f, value: values[f.key]!, regs: asciiFieldWords(values[f.key]!, f.words) };
    } catch (e) {
      throw new Error(`${f.key} ${(e as Error).message}`);
    }
  });
  if (blePasskey !== undefined) checkPasskey(blePasskey);
  if (!writes.length && blePasskey === undefined) throw new Error('provide at least one of SN / Model / SKU / BLE passkey');
  const mismatches: string[] = [];
  await login(ctx);
  await enableEngmode(ctx);
  for (const w of writes) {
    await ctx.client.writeMultiple(w.addr, w.regs, `provision ${w.key} @0x${hex4(w.addr)}`);
    const back = wordsToString(await ctx.client.readInput(w.addr, w.words, `verify ${w.key}`));
    if (back === w.value) ctx.log(`[provision] ${w.key}: '${w.value}' written and verified`);
    else mismatch(ctx, mismatches, `[provision] ${w.key}: MISMATCH wrote '${w.value}' read back '${back}'`);
  }
  if (blePasskey !== undefined) {
    const back = await writePasskey(ctx, blePasskey);
    const want = formatPasskey(blePasskey);
    if (back === blePasskey) ctx.log(`[provision] BLE passkey: ${want} written and verified`);
    else mismatch(ctx, mismatches, `[provision] BLE passkey: MISMATCH wrote ${want} read back ${formatPasskey(back)}`);
  }
  const fwVersion = await readVersion(ctx);
  const ok = mismatches.length === 0;
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const fields = [
    ...writes.map((w) => `${w.key}=${w.value}`),
    ...(blePasskey !== undefined ? [`ble_passkey=${formatPasskey(blePasskey)}`] : []),
  ].join(',');
  const record = `${stamp},${fields},fw=${fwVersion},${ok ? 'PASS' : 'FAIL'}`;
  ctx.log(`[provision] record: ${record}`);
  return { ok, mismatches, fwVersion, record };
}

// ---- BLE passkey (ttool ble-passkey) ----------------------------------------------------------

/** The passkey as printed on the label: always 6 digits. */
export function formatPasskey(passkey: number): string {
  return String(passkey).padStart(BLE_PASSKEY_DIGITS, '0');
}

/** Exactly six digits, leading zeros allowed (it is printed that way), like ttool. */
export function parseBlePasskey(text: string): number {
  if (text.length !== BLE_PASSKEY_DIGITS || !/^\d+$/.test(text)) {
    throw new Error(`BLE passkey must be exactly ${BLE_PASSKEY_DIGITS} digits, got '${text}'`);
  }
  return Number(text);
}

function checkPasskey(passkey: number): void {
  if (!Number.isInteger(passkey) || passkey < 0 || passkey > BLE_PASSKEY_MAX) {
    throw new RangeError(`passkey must be 0..${BLE_PASSKEY_MAX}, got ${passkey}`);
  }
}

async function readPasskeyWords(ctx: OpContext): Promise<number> {
  const [hi, lo] = await ctx.client.readInput(BLE_PASSKEY_ADDR, BLE_PASSKEY_WORDS, 'BLE passkey 0xFFD3');
  return ((hi << 16) >>> 0) + lo;
}

/** FC 0x10 @0xFFD3, quantity 2, high word first (like the 0xC354 interval); returns the read-back. Caller holds engmode. */
async function writePasskey(ctx: OpContext, passkey: number): Promise<number> {
  await ctx.client.writeMultiple(
    BLE_PASSKEY_ADDR,
    [(passkey >>> 16) & 0xffff, passkey & 0xffff],
    `provision ble_passkey @0x${hex4(BLE_PASSKEY_ADDR)}`,
  );
  return readPasskeyWords(ctx);
}

/** The passkey in effect (stored, or the build default on an unprovisioned unit). Reads need engmode too. */
export async function readBlePasskey(ctx: OpContext): Promise<number> {
  await login(ctx);
  await enableEngmode(ctx);
  const passkey = await readPasskeyWords(ctx);
  ctx.log(`[ble-passkey] ${formatPasskey(passkey)}`);
  return passkey;
}

/** Live for the next pairing; phones already bonded keep their bond. */
export async function setBlePasskey(ctx: OpContext, passkey: number): Promise<void> {
  checkPasskey(passkey);
  await login(ctx);
  await enableEngmode(ctx);
  const back = await writePasskey(ctx, passkey);
  if (back !== passkey) {
    throw new Error(`[ble-passkey] MISMATCH wrote ${formatPasskey(passkey)} read back ${formatPasskey(back)}`);
  }
  ctx.log(`[ble-passkey] ${formatPasskey(passkey)} written and verified; live for the next pairing`);
}

// ---- Modbus id ----------------------------------------------------------------------------

function checkId(id: number): void {
  if (!Number.isInteger(id) || id < MODBUS_ID_MIN || id > MODBUS_ID_MAX) {
    throw new RangeError(`id must be ${MODBUS_ID_MIN}..${MODBUS_ID_MAX}, got ${id}`);
  }
}

/** FC 0x10 @0xEA6F. The ACK comes from the old id; the new id is live right after it. */
export async function setId(ctx: OpContext, newId: number): Promise<void> {
  checkId(newId);
  const oldId = ctx.client.unit;
  await login(ctx);
  await enableEngmode(ctx);
  await ctx.client.writeMultiple(MODBUS_ID_ADDR, [newId], `set modbus id ${oldId} -> ${newId}`);
  ctx.client.unit = newId;
  ctx.session({ unit: newId });
  const back = (await ctx.client.readInput(MODBUS_ID_ADDR, 1, 'verify modbus id'))[0];
  if (back !== newId) throw new Error(`[set-id] MISMATCH: wrote ${newId}, read back ${back}`);
  ctx.log(`[set-id] Modbus ID ${oldId} -> ${newId} written, persisted and verified`);
}

/** Is anything answering at `unit`? Any reply, even an exception, means yes; a timeout means no. */
async function probeUnit(ctx: OpContext, unit: number, note: string): Promise<boolean> {
  const own = ctx.client.unit;
  ctx.client.unit = unit;
  try {
    await ctx.client.readInput(MODBUS_ID_ADDR, 1, note);
    return true;
  } catch (e) {
    if (e instanceof ModbusException) return true;
    if (e instanceof ModbusTimeout) return false;
    // A CRC error here usually means two stations answered at once.
    if (e instanceof ModbusError) return true;
    throw e;
  } finally {
    ctx.client.unit = own;
  }
}

/** [selector][new id][length][value...][pad to a word boundary] */
export function assignPayloadWords(mode: 'sn' | 'imsi', value: string, newId: number): number[] {
  const bytes =
    mode === 'sn'
      ? [0x01, newId, 12, ...Array.from(asciiBytes(value.padEnd(12, '\0'))), 0x00]
      : [0x02, newId, 15, ...Array.from(asciiBytes(value))];
  const words: number[] = [];
  for (let i = 0; i < bytes.length; i += 2) words.push((bytes[i] << 8) | (bytes[i + 1] ?? 0));
  return words;
}

export type AssignResult = 'assigned' | 'already';

/**
 * Broadcast FC 0x10 @0xC830 that selects one device by SN or IMSI and gives
 * it `newId`; never answered, so it is verified by a unicast read at the new id.
 */
export async function assignId(
  ctx: OpContext,
  mode: 'sn' | 'imsi',
  value: string,
  newId: number,
  repeat = 2,
  turnaroundMs = 200,
): Promise<AssignResult> {
  checkId(newId);
  if (mode === 'sn' && !/^[\x20-\x7e]{1,12}$/.test(value)) throw new Error('SN must be 1..12 ASCII chars');
  if (mode === 'imsi' && !/^\d{15}$/.test(value)) throw new Error('IMSI must be exactly 15 digits');

  const own = ctx.client.unit;
  if (await probeUnit(ctx, newId, 'probe target id')) {
    ctx.log(`[assign-id] id ${newId} already answers -- checking identity`);
    ctx.client.unit = newId;
    try {
      await login(ctx);
      const current = await readIdentity(ctx, mode);
      if (current !== value) {
        throw new Error(`[assign-id] id ${newId} is held by another device (${mode.toUpperCase()} '${current}'); pick a free id`);
      }
    } catch (e) {
      ctx.client.unit = own;
      throw e;
    }
    ctx.session({ unit: newId });
    ctx.log(`[assign-id] ${mode.toUpperCase()} '${value}' already has id ${newId} -- nothing to do`);
    return 'already';
  }

  const words = assignPayloadWords(mode, value, newId);
  for (let i = 0; i < repeat; i++) {
    await ctx.client.broadcastWriteMultiple(
      ASSIGN_ID_ADDR,
      words,
      `assign ${mode}=${value} -> id ${newId} (${i + 1}/${repeat})`,
      turnaroundMs,
    );
  }

  ctx.client.unit = newId;
  try {
    await login(ctx);
    const gotId = (await ctx.client.readInput(MODBUS_ID_ADDR, 1, 'verify modbus id'))[0];
    const gotValue = await readIdentity(ctx, mode);
    if (gotId !== newId || gotValue !== value) {
      throw new Error(`[assign-id] MISMATCH: id=${gotId} ${mode}='${gotValue}' (expected id=${newId} ${mode}='${value}')`);
    }
  } catch (e) {
    ctx.client.unit = own;
    if (e instanceof ModbusError) {
      const hint =
        mode === 'imsi'
          ? 'the NTN module may not have reported its IMSI yet (wait for boot/attach and retry)'
          : 'SN mode needs a provisioned (non-default) SN matching exactly; unprovisioned units only accept IMSI';
      throw new Error(`[assign-id] no device on id ${newId} after broadcast: ${e.message} -- hint: ${hint}`);
    }
    throw e;
  }
  ctx.session({ unit: newId });
  ctx.log(`[assign-id] ${mode.toUpperCase()} '${value}' -> Modbus ID ${newId} assigned, persisted and verified`);
  return 'assigned';
}

// ---- reset ------------------------------------------------------------------------------------

/** Engmode + FC06 0xFD00 = 0xAA55; the device reboots 200 ms after the ACK. Caller is logged in. */
export async function resetMcuNoVerify(ctx: OpContext): Promise<void> {
  await enableEngmode(ctx);
  await ctx.client.writeSingle(RESET_CTRL_ADDR, ENABLE_CODE, 'reset MCU 0xFD00');
  markRebooted(ctx);
  ctx.log('[reset] device ACKed, rebooting in 200 ms');
}

/**
 * Reset, then prove it rebooted: the unlock is RAM-only, so an
 * unauthenticated read must come back 0x0E. Returns the version after.
 */
export async function resetMcu(ctx: OpContext, waitS = 3, verify = true): Promise<string | null> {
  await login(ctx);
  await resetMcuNoVerify(ctx);
  if (!verify) return null;
  ctx.log(`[reset] waiting ${waitS}s for the device to reboot`);
  await sleep(ctx, waitS * 1000);
  try {
    await readVersion(ctx);
    throw new Error('[reset] device still unlocked -- it did not reboot');
  } catch (e) {
    if (!(e instanceof ModbusException)) {
      if (e instanceof ModbusError) throw new Error(`[reset] no response after reboot: ${e.message}`);
      throw e;
    }
    if (e.code !== EXC_PWD_AUTH) throw new Error(`[reset] unexpected exception: ${e.message}`);
  }
  await login(ctx);
  const version = await readVersion(ctx);
  ctx.log(`[reset] device is back, fw version '${version}'`);
  return version;
}

// ---- factory reset ------------------------------------------------------------------------------

export interface FactoryResetResult {
  verified: boolean;
  mismatches: string[];
}

/**
 * Engmode + FC06 0xFD10. Lv1 reverts netcfg, active mode, UART baud, station
 * id and password and deletes every BLE bond; Lv2 also wipes SN/Model/SKU and
 * the BLE passkey (needs the SN typed back).
 * Afterwards the session follows the device to id 1, 115200 and the default
 * password, and checks the defaults are what it reads.
 */
export async function factoryReset(
  ctx: OpContext,
  wipeIdentity: boolean,
  opts: { waitS?: number; verify?: boolean; force?: boolean } = {},
): Promise<FactoryResetResult> {
  const { waitS = 3, verify = true, force = false } = opts;

  if (ctx.client.unit !== DEFAULT_MODBUS_ID && !force) {
    if (await probeUnit(ctx, DEFAULT_MODBUS_ID, 'probe default id 1')) {
      throw new Error(
        `[factory-reset] station id ${DEFAULT_MODBUS_ID} already answers on this bus; after the reset ` +
          'this unit would collide with it. Detach the other device or force it.',
      );
    }
  }

  await login(ctx);
  const snBefore = await readIdentity(ctx, 'sn');
  const confirmed = await ctx.confirm(
    wipeIdentity
      ? {
          key: 'fr.lv2',
          vars: { sn: snBefore },
          title: 'Factory reset Lv2',
          message: `Level 2 wipes the identity of SN '${snBefore}' and resets the BLE passkey -- the unit returns to the unprovisioned state and needs re-provisioning. Type the SN to confirm.`,
          expectText: snBefore,
        }
      : {
          key: 'fr.lv1',
          vars: { sn: snBefore },
          title: 'Factory reset Lv1',
          message: `Level 1: netcfg, active mode, UART baud, station id and password revert to defaults and all BLE bonds are deleted; SN '${snBefore}' and the BLE passkey are kept.`,
        },
  );
  if (!confirmed) throw new Error('[factory-reset] aborted by the user');

  await enableEngmode(ctx);
  const code = wipeIdentity ? FACTORY_RESET_LV2_CODE : FACTORY_RESET_LV1_CODE;
  await ctx.client.writeSingle(FACTORY_RESET_ADDR, code, 'factory reset 0xFD10');
  markRebooted(ctx);
  ctx.log('[factory-reset] device ACKed (records deleted), rebooting in 200 ms');

  // The device comes back at the defaults whether or not we verify.
  ctx.client.unit = DEFAULT_MODBUS_ID;
  ctx.session({ unit: DEFAULT_MODBUS_ID, passwordHex: DEFAULT_PASSWORD_HEX });
  if (!verify) {
    if (ctx.localBaud() !== BAUD_DEFAULT_HOST) {
      await sleep(ctx, waitS * 1000);
      await ctx.setLocalBaud(BAUD_DEFAULT_HOST);
      ctx.session({ baud: BAUD_DEFAULT_HOST });
    }
    return { verified: false, mismatches: [] };
  }

  ctx.log(`[factory-reset] waiting ${waitS}s for the device to reboot`);
  await sleep(ctx, waitS * 1000);
  if (ctx.localBaud() !== BAUD_DEFAULT_HOST) {
    ctx.log(`[factory-reset] host baud reverts too: switching local port ${ctx.localBaud()} -> ${BAUD_DEFAULT_HOST}`);
    await ctx.setLocalBaud(BAUD_DEFAULT_HOST);
    ctx.session({ baud: BAUD_DEFAULT_HOST });
  }

  const mismatches: string[] = [];
  await login(ctx, parsePasswordHex(DEFAULT_PASSWORD_HEX));
  const gotId = (await ctx.client.readInput(MODBUS_ID_ADDR, 1, 'verify modbus id'))[0];
  if (gotId !== DEFAULT_MODBUS_ID) mismatch(ctx, mismatches, `[factory-reset] modbus id: expected ${DEFAULT_MODBUS_ID}, got ${gotId}`);
  const net = await readNetcfgFields(ctx);
  for (const [key, want] of Object.entries(NETCFG_DEFAULTS)) {
    const got = net[key as keyof typeof net];
    if (got !== want) mismatch(ctx, mismatches, `[factory-reset] ${key}: expected '${want}', got '${got}'`);
  }
  const snAfter = await readIdentity(ctx, 'sn');
  const snWant = wipeIdentity ? DEFAULT_SN : snBefore;
  if (snAfter !== snWant) mismatch(ctx, mismatches, `[factory-reset] SN: expected '${snWant}', got '${snAfter}'`);
  if (!mismatches.length) {
    ctx.log(`[factory-reset] ${wipeIdentity ? 'Level 2 (full)' : 'Level 1 (config)'} verified: defaults active (id 1, default password)`);
  }
  return { verified: mismatches.length === 0, mismatches };
}
