// Dashboard reads and the generic register read (ttool `read`).

import { hex4 } from '../modbusRtu';
import { MAX_READ_WORDS, wordsToBytes } from '../ntnCodec';
import {
  decodeNtnInfo,
  decodeSysInfo,
  NtnInfo,
  NTNINFO_ADDR,
  NTNINFO_WORDS,
  SysInfo,
  SYSINFO_ADDR,
  SYSINFO_WORDS,
  WORKMODE_ADDR,
} from '../registers';
import { login, OpContext } from './context';

export interface Dashboard {
  sys: SysInfo;
  ntn: NtnInfo;
  readAt: number;
}

export async function readDashboard(ctx: OpContext): Promise<Dashboard> {
  await login(ctx);
  const sysWords = await ctx.client.readInput(SYSINFO_ADDR, SYSINFO_WORDS, 'system info 0xEA60x30');
  const ntnWords = await ctx.client.readInput(NTNINFO_ADDR, NTNINFO_WORDS, 'NTN module info 0xEB00x51');
  return { sys: decodeSysInfo(sysWords), ntn: decodeNtnInfo(ntnWords), readAt: Date.now() };
}

export async function readWorkmode(ctx: OpContext): Promise<number> {
  await login(ctx);
  return (await ctx.client.readHolding(WORKMODE_ADDR, 1, 'read 0xC350 working mode'))[0];
}

export interface RawRead {
  address: number;
  fc: 3 | 4;
  words: number[];
  bytes: Uint8Array;
}

/** FC 0x03 / 0x04 read of any length, in 125-word segments. */
export async function rawRead(ctx: OpContext, address: number, count: number, fc: 3 | 4, doLogin: boolean): Promise<RawRead> {
  if (!Number.isInteger(count) || count < 1) throw new RangeError('count must be >= 1');
  if (doLogin) await login(ctx);
  const words: number[] = [];
  for (let offset = 0; offset < count; ) {
    const qty = Math.min(count - offset, MAX_READ_WORDS);
    const a = (address + offset) & 0xffff;
    const note = `read 0x${hex4(a)}x${qty}`;
    words.push(...(fc === 3 ? await ctx.client.readHolding(a, qty, note) : await ctx.client.readInput(a, qty, note)));
    offset += qty;
  }
  return { address, fc, words, bytes: wordsToBytes(words) };
}
