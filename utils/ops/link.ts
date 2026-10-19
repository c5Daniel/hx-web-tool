// Satellite data path: uplink (0xC550), uplink result (0xF060), downlink (0xEC60).

import { DownlinkResult, readDownlink, readUplinkResult, UplinkFragment, writeUplink } from '../ntnCodec';
import { checkCancelled, login, OpContext, sleep } from './context';

export async function sendUplink(ctx: OpContext, payload: Uint8Array, raw: boolean): Promise<UplinkFragment[]> {
  await login(ctx);
  return writeUplink(ctx.client, payload, ctx.log, raw);
}

/**
 * Poll 0xF060 until a result appears. waitS 0 = one read. Returns the
 * message, or null when nothing arrived in time. The worst case of a mode A
 * uplink is about 10.5 minutes, hence ttool's `--wait 660`.
 */
export async function waitUplinkResult(ctx: OpContext, waitS: number, intervalS = 1): Promise<string | null> {
  await login(ctx);
  const deadline = Date.now() + waitS * 1000;
  for (;;) {
    checkCancelled(ctx);
    const msg = await readUplinkResult(ctx.client, ctx.log);
    if (msg) return msg;
    if (Date.now() >= deadline) return null;
    await sleep(ctx, intervalS * 1000);
  }
}

export async function fetchDownlink(ctx: OpContext): Promise<DownlinkResult> {
  await login(ctx);
  return readDownlink(ctx.client, ctx.log);
}

/** ttool `watch`: poll 0xEC60 until cancelled, handing every downlink to onDownlink. */
export async function watchDownlink(
  ctx: OpContext,
  intervalS: number,
  onDownlink: (d: DownlinkResult) => void,
): Promise<void> {
  await login(ctx);
  for (;;) {
    checkCancelled(ctx);
    const d = await readDownlink(ctx.client, ctx.log);
    if (d.lengthWords) onDownlink(d);
    await sleep(ctx, intervalS * 1000);
  }
}
