// Writes the PWA icons to public/icons/ using Node built-ins only (no image
// library): a blue rounded square with signal arcs on the slate-900 page
// colour. The artwork stays inside the central 62%, so the same 512 px file
// also serves as the maskable icon (safe zone: the central 80% circle).
//
//   node scripts/gen-icons.mjs
//
// The generated PNGs are committed; re-run only when the artwork changes.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const SIZES = [192, 512];
const SUPERSAMPLE = 4;

const BG = [0x0f, 0x17, 0x2a]; // slate-900, the page background
const TILE = [0x25, 0x63, 0xeb]; // blue-600, the primary button colour
const FG = [0xff, 0xff, 0xff];

/** Which colour covers the point (x, y) in unit coordinates. */
function paint(x, y) {
  // Rounded square 0.19..0.81, corner radius 0.12.
  const lo = 0.19;
  const hi = 0.81;
  const r = 0.12;
  const cx = Math.min(Math.max(x, lo + r), hi - r);
  const cy = Math.min(Math.max(y, lo + r), hi - r);
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return BG;

  // Dot plus two arcs opening upwards, all centred on (0.5, 0.66).
  const dx = x - 0.5;
  const dy = 0.66 - y;
  const d = Math.hypot(dx, dy);
  if (d <= 0.05) return FG;
  const withinWedge = dy > 0 && Math.abs(Math.atan2(dx, dy)) <= Math.PI / 4;
  if (withinWedge && ((d >= 0.12 && d <= 0.17) || (d >= 0.22 && d <= 0.27))) return FG;
  return TILE;
}

function render(size) {
  const row = size * 3 + 1;
  const raw = Buffer.alloc(row * size);
  for (let py = 0; py < size; py++) {
    raw[py * row] = 0; // filter: none
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const c = paint((px + (sx + 0.5) / SUPERSAMPLE) / size, (py + (sy + 0.5) / SUPERSAMPLE) / size);
          acc[0] += c[0];
          acc[1] += c[1];
          acc[2] += c[2];
        }
      }
      const n = SUPERSAMPLE * SUPERSAMPLE;
      const o = py * row + 1 + px * 3;
      raw[o] = Math.round(acc[0] / n);
      raw[o + 1] = Math.round(acc[1] / n);
      raw[o + 2] = Math.round(acc[2] / n);
    }
  }
  return raw;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB, opaque
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(render(size), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT, `icon-${size}.png`);
  writeFileSync(file, png(size));
  console.log(`wrote ${file}`);
}
