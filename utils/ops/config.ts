// Device settings: UDP netcfg, active mode, UART baud, debug console,
// engineering mode and the password (ttool netcfg / actmode / baud /
// debug-console / engmode / set-password).

import { hex4, ModbusException } from '../modbusRtu';
import { asciiBytes, bytesToWords, parsePasswordHex, passwordChange, wordsToString } from '../ntnCodec';
import {
  ACTMODE_BLOCK_ADDR,
  ACTMODE_BLOCK_WORDS,
  ACTMODE_CSQ_IVL_ADDR,
  ACTMODE_IVL_DISABLED,
  ACTMODE_IVL_MAX_S,
  ACTMODE_LORA_IVL_ADDR,
  ACTMODE_REG_ADDR,
  BAUD_MODULE_ADDR,
  BAUD_PORT_ADDR,
  BAUD_RATES,
  BaudPort,
  DBGCON_ADDR,
  DBGCON_DISABLE_CODE,
  ENABLE_CODE,
  NETCFG_FIELDS,
  NetcfgKey,
  NetcfgKind,
} from '../registers';
import { enableEngmode, login, mismatch, OpContext, sleep } from './context';
import { resetMcuNoVerify } from './factory';

// ---- engineering mode / password -------------------------------------------------

export async function engmode(ctx: OpContext): Promise<void> {
  await login(ctx);
  await enableEngmode(ctx);
  ctx.log('[engmode] enabled (valid 5 minutes)');
}

/** Log in with the session password, then change it. The session continues with the new one. */
export async function setPassword(ctx: OpContext, nextHex: string): Promise<void> {
  const next = parsePasswordHex(nextHex);
  await login(ctx);
  await passwordChange(ctx.client, ctx.password, next);
  ctx.session({ passwordHex: nextHex.replace(/\s+/g, '').toLowerCase() });
  ctx.log('[set-password] OK (persisted)');
}

// ---- UDP network config ----------------------------------------------------------

/** Mirror of the firmware-side checks, so a bad value fails before it is sent. Returns an error or null. */
export function validateNetcfgValue(kind: NetcfgKind, value: string, maxBytes: number): string | null {
  if (!value) return 'must not be empty';
  if (value.length > maxBytes) return `exceeds ${maxBytes} bytes`;
  if (!/^[\x20-\x7e]*$/.test(value)) return 'must be printable ASCII';
  if (kind === 'port' && (!/^\d+$/.test(value) || +value < 1 || +value > 65535)) return 'must be a decimal port 1..65535';
  if (kind === 'ip' && !/^[\d.]+$/.test(value)) return 'must be dotted-decimal';
  if (kind === 'pdp' && value !== 'IP' && value !== 'Non-IP') return "must be 'IP' or 'Non-IP'";
  if (kind === 'apn' && /[", ]/.test(value)) return 'must not contain quote/comma/space';
  return null;
}

export type Netcfg = Record<NetcfgKey, string>;

async function readNetcfgField(ctx: OpContext, addr: number, words: number, key: string): Promise<string> {
  return wordsToString(await ctx.client.readHolding(addr, words, `read ${key}`));
}

export async function readNetcfgFields(ctx: OpContext): Promise<Netcfg> {
  const out = {} as Netcfg;
  for (const f of NETCFG_FIELDS) out[f.key] = await readNetcfgField(ctx, f.addr, f.words, f.key);
  return out;
}

export async function readNetcfg(ctx: OpContext): Promise<Netcfg> {
  await login(ctx);
  return readNetcfgFields(ctx);
}

export interface NetcfgWriteResult {
  values: Netcfg;
  mismatches: string[];
  resetDone: boolean;
}

/**
 * Write only the given fields (only the needed bytes, odd length padded 0x00),
 * reading each one back. With resetAfter, reboot the MCU so the NTN link picks
 * them up, then prove they persisted.
 */
export async function writeNetcfg(
  ctx: OpContext,
  values: Partial<Netcfg>,
  resetAfter: boolean,
  waitS = 3,
): Promise<NetcfgWriteResult> {
  const requested = NETCFG_FIELDS.filter((f) => values[f.key] !== undefined);
  for (const f of requested) {
    const err = validateNetcfgValue(f.kind, values[f.key]!, f.words * 2);
    if (err) throw new Error(`${f.key} ${err}: '${values[f.key]}'`);
  }
  const mismatches: string[] = [];
  await login(ctx);
  for (const f of requested) {
    const value = values[f.key]!;
    await ctx.client.writeMultiple(f.addr, bytesToWords(asciiBytes(value)), `netcfg ${f.key} @0x${hex4(f.addr)}`);
    const back = await readNetcfgField(ctx, f.addr, f.words, f.key);
    if (back === value) ctx.log(`[netcfg] ${f.key}: '${value}' written and verified`);
    else mismatch(ctx, mismatches, `[netcfg] ${f.key}: MISMATCH wrote '${value}' read back '${back}'`);
  }

  let resetDone = false;
  if (resetAfter && mismatches.length === 0 && requested.length) {
    await resetMcuNoVerify(ctx);
    ctx.log(`[netcfg] waiting ${waitS}s for the device to reboot`);
    await sleep(ctx, waitS * 1000);
    await login(ctx);
    for (const f of requested) {
      const back = await readNetcfgField(ctx, f.addr, f.words, f.key);
      if (back !== values[f.key]) {
        mismatch(ctx, mismatches, `[netcfg] ${f.key}: NOT PERSISTED -- read back '${back}' after reboot`);
      }
    }
    resetDone = true;
  }
  return { values: await readNetcfgFields(ctx), mismatches, resetDone };
}

// ---- active mode -------------------------------------------------------------------

export interface Actmode {
  workmode: number;
  mode: number;
  csq: number;
  lora: number;
}

/** Seconds, or 'off' (also '-1' / 'disable') for the 0xFFFFFFFF code. Throws on anything else. */
export function parseIntervalArg(text: string): number {
  const t = text.trim().toLowerCase();
  if (['off', 'disable', 'disabled', '-1'].includes(t)) return ACTMODE_IVL_DISABLED;
  if (!/^\d+$/.test(t)) throw new Error(`interval must be 0..${ACTMODE_IVL_MAX_S} seconds or 'off', got '${text}'`);
  const v = Number(t);
  if (v > ACTMODE_IVL_MAX_S) throw new Error(`interval must be 0..${ACTMODE_IVL_MAX_S} seconds or 'off', got '${text}'`);
  return v;
}

async function readActmodeBlock(ctx: OpContext): Promise<Actmode> {
  const w = await ctx.client.readHolding(ACTMODE_BLOCK_ADDR, ACTMODE_BLOCK_WORDS, 'active mode block');
  const u32 = (addr: number) => ((w[addr - ACTMODE_BLOCK_ADDR] << 16) >>> 0) + w[addr - ACTMODE_BLOCK_ADDR + 1];
  return {
    workmode: w[0],
    mode: w[ACTMODE_REG_ADDR - ACTMODE_BLOCK_ADDR],
    csq: u32(ACTMODE_CSQ_IVL_ADDR),
    lora: u32(ACTMODE_LORA_IVL_ADDR),
  };
}

export async function readActmode(ctx: OpContext): Promise<Actmode> {
  await login(ctx);
  return readActmodeBlock(ctx);
}

/** FC 0x10, exactly 2 words big-endian: FC 0x06 is refused by design. */
async function writeInterval(ctx: OpContext, addr: number, value: number, label: string): Promise<void> {
  await ctx.client.writeMultiple(addr, [(value >>> 16) & 0xffff, value & 0xffff], `actmode ${label} @0x${hex4(addr)}`);
}

export async function writeActmode(
  ctx: OpContext,
  want: { mode?: number; csq?: number; lora?: number },
): Promise<{ state: Actmode; mismatches: string[] }> {
  if (want.mode !== undefined && ![0, 1, 2, 3].includes(want.mode)) throw new Error(`mode must be 0..3, got ${want.mode}`);
  await login(ctx);
  if (want.mode !== undefined) await ctx.client.writeSingle(ACTMODE_REG_ADDR, want.mode, 'actmode 0xC358');
  if (want.csq !== undefined) await writeInterval(ctx, ACTMODE_CSQ_IVL_ADDR, want.csq, 'csq');
  if (want.lora !== undefined) await writeInterval(ctx, ACTMODE_LORA_IVL_ADDR, want.lora, 'lora');
  const state = await readActmodeBlock(ctx);
  const mismatches: string[] = [];
  if (want.mode !== undefined && state.mode !== want.mode) {
    mismatch(ctx, mismatches, `[actmode] MISMATCH wrote mode ${want.mode}, read back ${state.mode}`);
  }
  if (want.csq !== undefined && state.csq !== want.csq) {
    mismatch(ctx, mismatches, `[actmode] MISMATCH wrote CSQ interval ${want.csq}, read back ${state.csq}`);
  }
  if (want.lora !== undefined && state.lora !== want.lora) {
    mismatch(ctx, mismatches, `[actmode] MISMATCH wrote LoRa interval ${want.lora}, read back ${state.lora}`);
  }
  return { state, mismatches };
}

export interface RejectCheck {
  label: string;
  want: number;
  got: number | 'accepted';
  ok: boolean;
}

/**
 * The negative half of the actmode contract (ttool --verify-reject): writes
 * the firmware must refuse. Without the refusals they would hit the legacy
 * echo-ACK and report a write that never happened.
 */
export async function verifyActmodeRejects(ctx: OpContext): Promise<RejectCheck[]> {
  await login(ctx);
  const c = ctx.client;
  const checks: Array<[string, () => Promise<void>, number]> = [
    ['FC06 @0xC354 (interval high word)', () => c.writeSingle(ACTMODE_CSQ_IVL_ADDR, 60), 0x02],
    ['FC06 @0xC355 (interval low word)', () => c.writeSingle(ACTMODE_CSQ_IVL_ADDR + 1, 60), 0x02],
    ['FC06 @0xC356 (reserved)', () => c.writeSingle(0xc356, 1), 0x02],
    ['FC06 @0xC359 (interval high word)', () => c.writeSingle(ACTMODE_LORA_IVL_ADDR, 60), 0x02],
    ['FC10 @0xC358 (mode is FC06 only)', () => c.writeMultiple(ACTMODE_REG_ADDR, [3]), 0x02],
    ['FC10 @0xC354 above 86400', () => c.writeMultiple(ACTMODE_CSQ_IVL_ADDR, [0x0001, 0x5181]), 0x03],
    ['FC10 @0xC354 with quantity 1', () => c.writeMultiple(ACTMODE_CSQ_IVL_ADDR, [0]), 0x03],
    ['FC06 @0xC358 value 4', () => c.writeSingle(ACTMODE_REG_ADDR, 4), 0x03],
  ];
  const out: RejectCheck[] = [];
  for (const [label, call, want] of checks) {
    try {
      await call();
      out.push({ label, want, got: 'accepted', ok: false });
      ctx.log(`[actmode] ${label}: ACCEPTED, expected exception 0x${want.toString(16)}`, true);
    } catch (e) {
      if (!(e instanceof ModbusException)) throw e;
      const ok = e.code === want;
      out.push({ label, want, got: e.code, ok });
      ctx.log(`[actmode] ${label}: exception 0x${e.code.toString(16)}${ok ? ' as expected' : `, expected 0x${want.toString(16)}`}`, !ok);
    }
  }
  return out;
}

// ---- UART baud -------------------------------------------------------------------------

export type Bauds = Record<BaudPort, number>;

/** Current rate of all three UARTs. Enables engineering mode (0xFFD1/0xFFD2 refuse reads without it). */
export async function readBauds(ctx: OpContext): Promise<Bauds> {
  await login(ctx);
  return readBaudsLoggedIn(ctx);
}

async function readBaudsLoggedIn(ctx: OpContext): Promise<Bauds> {
  const host = (await ctx.client.readHolding(BAUD_PORT_ADDR.host, 1, 'host baud 0xC357'))[0];
  await enableEngmode(ctx);
  const [ntn, lora] = await ctx.client.readInput(BAUD_MODULE_ADDR, 2, 'NTN/LoRa baud 0xFFD1');
  return { host: host * 100, ntn: ntn * 100, lora: lora * 100 };
}

/**
 * Module ports first: once the host port moves, every later frame has to go
 * out at the new rate. The host echo still comes back at the old rate; the
 * device switches 200 ms later and the local port follows.
 */
export async function setBauds(ctx: OpContext, want: Partial<Bauds>): Promise<{ bauds: Bauds; mismatches: string[] }> {
  const order: BaudPort[] = ['ntn', 'lora', 'host'];
  for (const p of order) {
    const b = want[p];
    if (b !== undefined && !(BAUD_RATES as readonly number[]).includes(b)) throw new Error(`${p} baud ${b} not supported`);
  }
  await login(ctx);
  for (const p of order) {
    const baud = want[p];
    if (baud === undefined) continue;
    const addr = BAUD_PORT_ADDR[p];
    if (p !== 'host') await enableEngmode(ctx);
    ctx.log(`[baud] ${p} -> ${baud}: FC06 0x${hex4(addr)} = ${baud / 100}`);
    await ctx.client.writeSingle(addr, baud / 100, `${p} baud 0x${hex4(addr)}`);
    if (p === 'host') {
      await sleep(ctx, 300);
      await ctx.setLocalBaud(baud);
      ctx.session({ baud });
      ctx.log(`[baud] local port switched to ${baud}`);
    }
  }
  const bauds = await readBaudsLoggedIn(ctx);
  const mismatches: string[] = [];
  for (const p of order) {
    if (want[p] !== undefined && bauds[p] !== want[p]) {
      mismatch(ctx, mismatches, `[baud] ${p}: expected ${want[p]}, read back ${bauds[p]}`);
    }
  }
  if (want.ntn !== undefined || want.lora !== undefined) {
    ctx.log('[baud] only the MCU side changed; the module has to be moved to the same rate separately');
  }
  return { bauds, mismatches };
}

// ---- debug console -----------------------------------------------------------------------

/** Engmode + FC06 0xFD20. Not persisted: a reboot restores the build default. */
export async function setDebugConsole(ctx: OpContext, enable: boolean): Promise<void> {
  await login(ctx);
  await enableEngmode(ctx);
  await ctx.client.writeSingle(DBGCON_ADDR, enable ? ENABLE_CODE : DBGCON_DISABLE_CODE, 'debug console 0xFD20');
  ctx.log(`[debug-console] device ACKed, console is ${enable ? 'on' : 'off'}`);
}
