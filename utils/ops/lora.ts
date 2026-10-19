// LoRa co-module: AT passthrough at 0xC750 + reply mailboxes, the boot-ready
// flag, and a node's TX interval (ttool lora / lora --status / lora-interval).

import {
  asciiBytes,
  bytesToWords,
  LoraReply,
  loraCmdIsBisget,
  loraNodeIntervalCmd,
  parseNodeIntervalRecord,
  readLoraReply,
} from '../ntnCodec';
import { LORA_AT_ADDR, LORA_AT_MAX_BYTES, PCIE_STATUS_ADDR, PCIE_STATUS_LORA_READY } from '../registers';
import { login, OpContext, sleep } from './context';

export async function loraStatus(ctx: OpContext): Promise<{ value: number; ready: boolean }> {
  await login(ctx);
  const value = (await ctx.client.readInput(PCIE_STATUS_ADDR, 1, 'PCIe 2 status'))[0];
  return { value, ready: (value & PCIE_STATUS_LORA_READY) !== 0 };
}

/** The bytes of one 0xC750 write. Throws on non-ASCII or an over-long command. */
export function loraPayload(command: string, crlf: boolean): Uint8Array {
  if (!/^[\x00-\x7f]*$/.test(command)) throw new Error('AT command must be plain ASCII');
  const payload = asciiBytes(crlf ? `${command}\r\n` : command);
  if (payload.length > LORA_AT_MAX_BYTES) {
    throw new Error(`command is ${payload.length} bytes incl. CRLF, max ${LORA_AT_MAX_BYTES} (single FC 0x10 frame)`);
  }
  return payload;
}

async function writeAt(ctx: OpContext, payload: Uint8Array): Promise<void> {
  await ctx.client.writeMultiple(LORA_AT_ADDR, bytesToWords(payload), 'LoRa AT');
}

export interface LoraSendResult {
  /** null when the reply was not requested. */
  reply: LoraReply | null;
  mailbox: 0xf460 | 0xf860 | null;
}

/**
 * Write one AT command. With read, wait and fetch its mailbox: AT+BISGET*
 * answers in 0xF460, everything else in 0xF860 -- and a reply later than the
 * MCU's 5 s window counts as unsolicited and lands in 0xF460, so look there too.
 */
export async function loraSend(
  ctx: OpContext,
  command: string,
  opts: { read: boolean; waitS: number; crlf: boolean },
): Promise<LoraSendResult> {
  const payload = loraPayload(command, opts.crlf);
  await login(ctx);
  await writeAt(ctx, payload);
  ctx.log(`[lora] sent ${payload.length} bytes @0xC750`);
  if (!opts.read) return { reply: null, mailbox: null };

  const bisget = loraCmdIsBisget(command);
  await sleep(ctx, opts.waitS * 1000);
  let reply = await readLoraReply(ctx.client, bisget, ctx.log);
  let mailbox: 0xf460 | 0xf860 = bisget ? 0xf460 : 0xf860;
  if (!reply.lengthWords && !bisget) {
    ctx.log('[lora] 0xF860 empty; checking 0xF460 (late reply / push)');
    reply = await readLoraReply(ctx.client, true, ctx.log);
    mailbox = 0xf460;
  }
  return { reply, mailbox };
}

/** Read one mailbox without writing anything (ttool lora --poll / --poll-reply). */
export async function loraPoll(ctx: OpContext, bisget: boolean): Promise<LoraReply> {
  await login(ctx);
  return readLoraReply(ctx.client, bisget, ctx.log);
}

// Time for the module's bare OK to land in its mailbox (measured 67-208 ms).
const REPLY_WAIT_MS = 1000;
// The AT+BISGET has to follow the get request within this: the module keeps
// one record per slot and the node's own next report overwrites the reply.
export const LORA_INTERVAL_BISGET_MAX_S = 5;

export type LoraIntervalResult =
  | { kind: 'seconds'; seconds: number; reply: string }
  | { kind: 'overwritten'; reply: string }
  | { kind: 'none'; reply: string };

/** AT+BISCSEND <i>:016B41CF, check OK, wait, AT+BISGET=<i>?, decode the 016B record. */
export async function loraInterval(ctx: OpContext, index: number, waitS = 2): Promise<LoraIntervalResult> {
  const getCmd = loraNodeIntervalCmd(index);
  if (REPLY_WAIT_MS / 1000 + waitS > LORA_INTERVAL_BISGET_MAX_S) {
    ctx.log(
      `[lora-interval] WARNING: AT+BISGET goes out ~${REPLY_WAIT_MS / 1000 + waitS}s after the request, over the ` +
        `recommended ${LORA_INTERVAL_BISGET_MAX_S}s -- the node's next report may overwrite the reply`,
      true,
    );
  }
  await login(ctx);
  await writeAt(ctx, loraPayload(getCmd, true));
  ctx.log(`[lora-interval] sent ${getCmd}`);
  await sleep(ctx, REPLY_WAIT_MS);
  const ack = await readLoraReply(ctx.client, false, ctx.log);
  if (!ack.text.split(/\r\n|\r|\n/).some((l) => l.trim() === 'OK')) {
    throw new Error(`[lora-interval] module did not accept the request (reply: '${ack.text.trim()}')`);
  }

  ctx.log(`[lora-interval] waiting ${waitS}s for node ${index} to answer...`);
  await sleep(ctx, waitS * 1000);
  await writeAt(ctx, loraPayload(`AT+BISGET=${index}?`, true));
  await sleep(ctx, REPLY_WAIT_MS);
  const reply = await readLoraReply(ctx.client, true, ctx.log);
  if (!reply.lengthWords) throw new Error('[lora-interval] 0xF460 empty -- the module did not answer AT+BISGET');

  const seconds = parseNodeIntervalRecord(reply.text);
  if (seconds !== null) return { kind: 'seconds', seconds, reply: reply.text };
  if (reply.text.split(/\r\n|\r|\n/).some((l) => l.includes(','))) return { kind: 'overwritten', reply: reply.text };
  return { kind: 'none', reply: reply.text };
}
