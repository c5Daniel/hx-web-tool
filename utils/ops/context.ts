// What every operation gets from the hook that runs it. Operations are the
// ttool.py cmd_* flows as plain async functions: no React, no DOM, so the
// same code can run against a mock link in tests.

import { ModbusClient } from '../modbusRtu';
import { Log, passwordLogin } from '../ntnCodec';
import { ENABLE_CODE, ENGMODE_ADDR } from '../registers';

export type PassthroughTarget = 'ntn' | 'lora';

export interface SessionPatch {
  unit?: number;
  baud?: number;
  unlocked?: boolean;
  /** Date.now() of the last engineering-mode enable, or null after a reboot. */
  engmodeAt?: number | null;
  passthrough?: PassthroughTarget | null;
  passwordHex?: string;
}

export interface ConfirmRequest {
  /** UI message id (i18n `confirm.<key>.title` / `.body`); title/message are the English fallback. */
  key?: 'fr.lv1' | 'fr.lv2';
  vars?: Record<string, string>;
  title: string;
  message: string;
  /** When set, the user must type exactly this text to confirm. */
  expectText?: string;
}

export interface OpContext {
  client: ModbusClient;
  /** The local serial port's rate, re-timed when the device's host rate changes. */
  setLocalBaud(baud: number): Promise<void>;
  localBaud(): number;
  password: Uint8Array;
  log: Log;
  signal: AbortSignal;
  confirm(req: ConfirmRequest): Promise<boolean>;
  session(patch: SessionPatch): void;
}

export class OpCancelled extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'OpCancelled';
  }
}

/** Sleep that ends early (throwing OpCancelled) when the operation is cancelled. */
export function sleep(ctx: OpContext, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ctx.signal.aborted) return reject(new OpCancelled());
    const timer = setTimeout(() => {
      ctx.signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new OpCancelled());
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function checkCancelled(ctx: OpContext): void {
  if (ctx.signal.aborted) throw new OpCancelled();
}

/** Like ttool, every operation logs in first: the unlock is RAM-only and a reboot drops it. */
export async function login(ctx: OpContext, password: Uint8Array = ctx.password): Promise<void> {
  await passwordLogin(ctx.client, password);
  ctx.session({ unlocked: true });
}

/** FC 0x06 0xFFD0 = 0xAA55, valid 5 minutes. ttool re-enables it before every gated write. */
export async function enableEngmode(ctx: OpContext): Promise<void> {
  await ctx.client.writeSingle(ENGMODE_ADDR, ENABLE_CODE, 'engineering mode 0xFFD0');
  ctx.session({ engmodeAt: Date.now() });
}

/** A verify step that did not match: logged as an error, collected into the result. */
export function mismatch(ctx: OpContext, list: string[], msg: string): void {
  list.push(msg);
  ctx.log(msg, true);
}
