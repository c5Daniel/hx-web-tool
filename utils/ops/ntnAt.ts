// NTN modem AT passthrough over Modbus (ttool ntn-at): write the command at
// 0x9C40, then poll 0x9C41 until the firmware has put the reply (or its own
// status line) there, and read 0x9C42.

import { asciiBytes, bytesToWords, LoraReply, NTN_AT_REPLY_LEN_ADDR, readNtnAtReply } from '../ntnCodec';
import { NTN_AT_ADDR, NTN_AT_MAX_BYTES, NTN_AT_POLL_MS } from '../registers';
import { checkCancelled, login, OpContext, sleep } from './context';

/** The bytes of one 0x9C40 write. Throws on non-ASCII or an over-long command. */
export function ntnAtPayload(command: string, crlf: boolean): Uint8Array {
  if (!/^[\x00-\x7f]*$/.test(command)) throw new Error('AT command must be plain ASCII');
  const payload = asciiBytes(crlf ? `${command}\r\n` : command);
  if (payload.length > NTN_AT_MAX_BYTES) {
    throw new Error(`command is ${payload.length} bytes incl. CRLF, max ${NTN_AT_MAX_BYTES} (single FC 0x10 frame)`);
  }
  return payload;
}

/** True when the reply carries an OK line (ttool ntn-at's exit code 0). */
export function ntnAtReplyOk(reply: LoraReply): boolean {
  return reply.text.split(/\r\n|\r|\n/).some((l) => l.trim() === 'OK');
}

/**
 * Queue one AT command. The ACK means "queued", not "sent": with read, poll
 * 0x9C41 every pollMs for up to waitS, then read the reply. Resolves to null
 * when read is off, or when nothing arrived in time (the command may still be
 * running -- fetch it later with ntnAtPoll).
 */
export async function ntnAtSend(
  ctx: OpContext,
  command: string,
  opts: { read: boolean; waitS: number; crlf: boolean; pollMs?: number },
): Promise<LoraReply | null> {
  const payload = ntnAtPayload(command, opts.crlf);
  await login(ctx);
  await ctx.client.writeMultiple(NTN_AT_ADDR, bytesToWords(payload), 'NTN AT');
  ctx.log(`[ntn-at] queued ${payload.length} bytes @0x9C40`);
  if (!opts.read) return null;

  const deadline = Date.now() + opts.waitS * 1000;
  for (;;) {
    checkCancelled(ctx);
    const n = (await ctx.client.readInput(NTN_AT_REPLY_LEN_ADDR, 1, 'NTN AT reply length'))[0];
    if (n !== 0) break;
    if (Date.now() >= deadline) {
      ctx.log(`[ntn-at] no reply within ${opts.waitS}s; the command may still be running`, true);
      return null;
    }
    await sleep(ctx, opts.pollMs ?? NTN_AT_POLL_MS);
  }
  return readNtnAtReply(ctx.client, ctx.log);
}

/** Read the reply mailbox once without writing anything (ttool ntn-at --poll). */
export async function ntnAtPoll(ctx: OpContext): Promise<LoraReply> {
  await login(ctx);
  return readNtnAtReply(ctx.client, ctx.log);
}
