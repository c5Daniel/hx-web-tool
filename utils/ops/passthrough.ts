// Working mode 0xC350 and the raw passthrough bridges (ttool workmode.py).
//
// Modbus -> passthrough: FC 0x06 0xC350 = 3 (NTN) or 4 (LoRa); echo first,
// flip 200 ms later. Back: raw 01 02 05 01 01 (no CRC), echoed. The control
// frames are only recognised as one idle-delimited burst, which a single
// write() is. There is no direct 3 <-> 4 switch.

import { hexDump } from '../modbusRtu';
import { decodeAscii } from '../ntnCodec';
import { WORKMODE_ADDR, WORKMODE_MODBUS, WORKMODE_PT_LORA, WORKMODE_PT_NTN } from '../registers';
import { login, OpContext, PassthroughTarget, sleep } from './context';

export const PT_EXIT_CMD = new Uint8Array([0x01, 0x02, 0x05, 0x01, 0x01]);
export const PT_FWVER_CMD = new Uint8Array([0x01, 0x01, 0x03, 0x01, 0x00]);
// The firmware flips 200 ms after the ACK.
const SWITCH_DELAY_MS = 300;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export async function enterPassthrough(ctx: OpContext, target: PassthroughTarget): Promise<void> {
  const mode = target === 'lora' ? WORKMODE_PT_LORA : WORKMODE_PT_NTN;
  await login(ctx);
  try {
    await ctx.client.writeSingle(WORKMODE_ADDR, mode, 'working mode 0xC350');
  } catch (e) {
    if (target === 'lora') ctx.log('[passthrough] hint: exception 0x04 means the LoRa UART is unavailable on the device', true);
    throw e;
  }
  await sleep(ctx, SWITCH_DELAY_MS);
  ctx.session({ passthrough: target });
  ctx.log(`[passthrough] Host<->${target === 'lora' ? 'LoRa' : 'NTN'} bridge active (Modbus is silent now)`);
}

/** Raw exit frame, check the echo, then confirm 0xC350 reads 1. The unlock survives the round trip. */
export async function exitPassthrough(ctx: OpContext): Promise<void> {
  const echo = await ctx.client.rawExchange(PT_EXIT_CMD, PT_EXIT_CMD.length, undefined, 'passthrough exit');
  if (!sameBytes(echo.subarray(0, PT_EXIT_CMD.length), PT_EXIT_CMD)) {
    throw new Error(
      `exit echo mismatch: got '${hexDump(echo)}', expected '${hexDump(PT_EXIT_CMD)}' -- is the device in passthrough mode?`,
    );
  }
  await sleep(ctx, SWITCH_DELAY_MS);
  const mode = (await ctx.client.readHolding(WORKMODE_ADDR, 1, 'read 0xC350 working mode'))[0];
  ctx.session({ passthrough: null });
  if (mode !== WORKMODE_MODBUS) throw new Error(`[passthrough] 0xC350 reads ${mode}, expected ${WORKMODE_MODBUS}`);
  ctx.log('[passthrough] back in Modbus slave mode (0xC350 = 1)');
}

/** Raw 01 01 03 01 00 -> 01 01 03 <len> <ASCII "M.mm">, the same value as 0xEA6B. */
export async function passthroughFwver(ctx: OpContext): Promise<string> {
  const resp = await ctx.client.rawExchange(PT_FWVER_CMD, 0, undefined, 'passthrough fwver');
  if (resp.length < 4 || resp[0] !== 0x01 || resp[1] !== 0x01 || resp[2] !== 0x03) {
    throw new Error(`bad fw-version reply: '${hexDump(resp)}' -- is the device in passthrough mode?`);
  }
  const len = resp[3];
  if (resp.length < 4 + len) throw new Error(`truncated fw-version reply (${resp.length} bytes, len field ${len})`);
  return decodeAscii(resp.subarray(4, 4 + len));
}
