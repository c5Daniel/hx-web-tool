# HX Web Tool — Agent Guide

Browser port of the firmware repo's `ttool/` (Python Modbus RTU master for the
Hestia NTN Dongle). Same stack and look as `hestia-web-tool`: Vite 7, React 18,
TypeScript strict, Tailwind 3, `@heroicons/react`, `web-serial-polyfill`, flat
layout (no `src/`), dark slate theme, static deploy to GitHub Pages.

## Layering — keep it

1. `utils/serialTransport.ts` is the **only** code that touches a `SerialPort`.
   It implements `ByteLink`; the Modbus client depends on that interface, which
   is how `tests/mockLink.ts` replaces the device.
2. `utils/modbusRtu.ts`, `utils/ntnCodec.ts`, `utils/registers.ts`,
   `utils/ops/*` are plain TypeScript: no React, no DOM. Every ttool `cmd_*`
   flow is one async function in `utils/ops/` taking an `OpContext`.
3. `hooks/useGateway.ts` is the only hook with serial state. `run(label, op)`
   runs one operation at a time (busy lock + per-transaction mutex in
   `ModbusClient`), logs, and maps errors. Panels call `gw.run(...)` and never
   reach the transport, except the passthrough terminal via `sendRaw` /
   `subscribeRx`.
4. Operations change session facts (unit id, host baud, passthrough, password,
   engmode) through `ctx.session(patch)`, never by poking React state.

## Behaviour parity with ttool

Port ttool's behaviour, do not reinvent it: same response-length rule, same
checks, **no automatic retry**, login before every operation, engineering mode
re-enabled before every gated write, the same waits (0.2 s broadcast
turnaround, 0.3 s after a mode/baud switch, 3 s after a reboot), and the same
read-back verification. Deliberate differences, keep them listed here:

- The response function code must echo the request's (ttool does not check).
- Exception `0x06` (Slave Device Busy) is named (missing from ttool's table).
- A probe that gets a CRC error counts as *occupied* (two stations answering),
  where ttool treats any non-exception error as free.
- Host baud changes close and reopen the same `SerialPort` (Web Serial cannot
  re-time an open port).
- The LoRa quick-command list avoids bare `AT+BISDEV=?` (a ~2.6 KB dump against
  a 512-byte mailbox) and `AT+BISGET` (it consumes the module's record).

Register addresses come from the firmware repo's `docs/NTN_MODBUS_SPEC.md`;
when a register changes there, change `utils/registers.ts` and the op that uses
it, and add a test vector if the manual quotes a frame.

## i18n

`i18n/zh-TW.ts` is the key source (default language); `i18n/en.ts` is typed
`Record<keyof typeof zhTW, string>`, so a missing translation fails `tsc`.
UI text goes through `t()`. Log lines and op error messages stay English, like
ttool's output.

## Commands

```bash
npm run dev     # local dev server
npm test        # vitest (codec, CRC frames from USER_MANUAL, mock-device flows)
npm run build   # tsc && vite build
```

Not in v1: OTA / DFU / bus-mute (needs a browser-side mcumgr SMP client).
