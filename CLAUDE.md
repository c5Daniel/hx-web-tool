# HX Web Tool — Agent Guide

Browser port of the firmware repo's `ttool/` (Python Modbus RTU master for the
Hestia NTN Dongle), plus a read-only Bluetooth LE status page for phones in the
field. Same stack and look as `hestia-web-tool`: Vite 7, React 18, TypeScript
strict, Tailwind 3, `@heroicons/react`, `web-serial-polyfill`, flat layout (no
`src/`), dark slate theme, static deploy to GitHub Pages, installable PWA.

Two **separate pages** (Vite multi-page build, `vite.config.ts`), neither
showing the other:

- `./` — `index.html` → `index.tsx` → `App.tsx`: the Modbus tool (the ttool port).
- `./ble/` — `ble/index.html` → `ble.tsx` → `BleApp.tsx`: the Bluetooth status
  page for phones; the device label's QR code points here.

Shared code lands in a common chunk, but the BLE page never imports the
serial transport or the panels, and the tool never imports `bleTransport`.
The old `./#ble` link is redirected to `./ble/` by an inline script in
`index.html` (on load and on `hashchange`). Keep that redirect: printed QR
codes may still carry it.

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
5. `utils/bleTransport.ts` is the **second transport** and the only code that
   touches `navigator.bluetooth`. It hands raw characteristic values over;
   `utils/bleStatus.ts` (plain TypeScript, no DOM) decodes them.
   `hooks/useBleStatus.ts` holds the BLE state and is independent of
   `useGateway`: BLE and serial are separate links, and the BLE page must work
   on a phone with no serial port at all. `useBleStatus` lives in `BleApp`,
   `useGateway` in `App`; no page uses both.
6. Nothing read over a link outlives it. `useGateway` bumps `epoch` when the
   port closes (disconnect or lost) and `App` keys `<main>` on it, so every
   panel remounts with fresh state: panels never clear themselves, so keep
   results in panel-local state. Anything lifted above the panels must be
   tagged with the epoch it was read in, like the dashboard. Settings, the
   password and the log survive. `useBleStatus` clears its snapshot on every
   disconnect and drops reads that finish after one; a user disconnect also
   forgets the device (no Reconnect), a lost link keeps it with the error.

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

The BLE passkey (`0xFFD3`–`0xFFD4`, factory panel) is ttool's `ble-passkey`
(show / set) and `provision --ble-passkey` (written after the identity fields,
recorded as `ble_passkey=NNNNNN`): exactly 6 digits, login + engmode for the
read too, read-back verified. The spec's quoted frames are test vectors.

## Bluetooth status page — not part of ttool parity

ttool has no BLE; nothing on this page mirrors a ttool command. The wire format
is the firmware repo's `docs/BLE_STATUS_SERVICE.md` (authoritative): change
`utils/bleStatus.ts` together with it, keep the spec's §5 example as a test
vector, refuse unknown format versions, ignore trailing bytes.

- Every notification (2-byte change counter) re-reads status and identity; a
  5 s timer re-reads status (uptime / module time / CSQ age do not bump the
  counter). Refreshes coalesce.
- `readValue()` also fires `characteristicvaluechanged` (Web Bluetooth spec),
  so the transport treats only values shorter than the 34-byte status as
  notifications — otherwise every read would trigger another read.
- GATT operations are serialised in the transport (Android refuses a second
  operation in flight).
- The first status read is where pairing happens (the OS passkey dialog); a
  failure there is reported as a pairing problem, with the advice to forget
  the device in Android's Bluetooth settings after a factory reset.
- Feature detection: no `navigator.bluetooth` → iOS needs the Bluefy browser,
  elsewhere Chrome/Edge over https or localhost.

## PWA / offline

The field has no network, so the built site is installable and works offline
after one online visit. No plugin: `public/sw.js` is hand-written and copied
verbatim by Vite. Each page has its own manifest with relative `id` /
`start_url` / `scope` (`./`): `public/manifest.webmanifest` (the tool) and
`public/ble/manifest.webmanifest` ("HX 藍牙狀態"), so they install as two
apps. One worker at the site root serves both: `index.tsx` registers `./sw.js`,
`ble.tsx` registers `../sw.js` (same script, same default scope), both only
when `import.meta.env.PROD`, so the dev server never answers from a cache.

- Two shells, `./` and `ble/` (`SHELLS` in `sw.js`). Install precaches each
  by reading its HTML for the hashed `assets/` files (the first visit loads
  them before the worker controls the page). Navigations are network-first
  with a 4 s fallback to the cached shell of that page (anything under `ble`
  gets the BLE shell); `assets/` is cache-first; other same-origin GETs are
  stale-while-revalidate. A fresh shell prunes only assets that no cached
  shell references: the two pages share chunks.
- Bump `VERSION` in `sw.js` when its caching logic changes; activate deletes
  every other `hx-web-tool-*` cache. A new deploy alone needs no bump.
- Icons (`public/icons/icon-192.png`, `icon-512.png`, the 512 also maskable)
  come from `node scripts/gen-icons.mjs` (Node built-ins only); the PNGs are
  committed.
- Keep every asset path relative (`base: './'`): the site must work under any
  GitHub Pages repo path, and so must the worker (it resolves everything
  against its registration scope).

## i18n

`i18n/zh-TW.ts` is the key source (default language); `i18n/en.ts` is typed
`Record<keyof typeof zhTW, string>`, so a missing translation fails `tsc`.
UI text goes through `t()`. Log lines and op error messages stay English, like
ttool's output.

## Commands

```bash
npm run dev     # local dev server
npm test        # vitest (codec, CRC frames from USER_MANUAL, mock-device flows, BLE decoder)
npm run build   # tsc && vite build
```

Not in v1: OTA / DFU / bus-mute (needs a browser-side mcumgr SMP client).
