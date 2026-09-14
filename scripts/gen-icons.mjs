#!/usr/bin/env node
/**
 * Generuje ikonki PWA (PNG bez zewnętrznych zależności) + favicon.svg.
 * Ikony są proste: czarne tło, biały glif „X” w kółku-pigułce, pasek postępu u dołu
 * (sygnatura aplikacji: X + offline).
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'apps/web/public/icons');
mkdirSync(outDir, { recursive: true });

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixelFn) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size);
      const o = row + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const distToSegment = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

function makeIcon(size, { maskable = false } = {}) {
  const pad = maskable ? 0.2 : 0.08; // maskable wymaga bezpiecznego pola
  const box = size * pad;
  const inner = size - box * 2;
  const radius = inner * 0.24;
  const stroke = inner * 0.135;
  const c1 = [box + inner * 0.26, box + inner * 0.26];
  const c2 = [box + inner * 0.74, box + inner * 0.26];
  const c3 = [box + inner * 0.74, box + inner * 0.74];
  const c4 = [box + inner * 0.26, box + inner * 0.74];
  const bar = { y: box + inner * 0.88, h: inner * 0.045, x0: box + inner * 0.26, x1: box + inner * 0.62 };

  return encodePng(size, (x, y) => {
    const inBox = (px, py, rx, ry, rw, rh, rr) => {
      const dx = Math.max(rx - px, 0, px - (rx + rw));
      const dy = Math.max(ry - py, 0, py - (ry + rh));
      if (dx * dx + dy * dy > rr * rr) return false;
      return px >= rx && px <= rx + rw && py >= ry && py <= ry + rh;
    };
    if (!inBox(x, y, box, box, inner, inner, radius)) return [0, 0, 0, 0];
    const inBar = x >= bar.x0 && x <= bar.x1 && Math.abs(y - (bar.y + bar.h / 2)) <= bar.h / 2;
    const thick = distToSegment(x, y, c1[0], c1[1], c3[0], c3[1]) <= stroke / 2;
    const thick2 = distToSegment(x, y, c2[0], c2[1], c4[0], c4[1]) <= stroke / 2;
    if (thick || thick2) return [255, 255, 255, 255];
    if (inBar) return [29, 155, 240, 255]; // niebieski akcent „pobierania”
    return [0, 0, 0, 255];
  });
}

writeFileSync(join(outDir, 'icon-192.png'), makeIcon(192));
writeFileSync(join(outDir, 'icon-512.png'), makeIcon(512));
writeFileSync(join(outDir, 'icon-maskable-512.png'), makeIcon(512, { maskable: true }));
writeFileSync(join(outDir, 'icon-152.png'), makeIcon(152));

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" shape-rendering="geometricPrecision">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f1419"/><stop offset="1" stop-color="#000"/></linearGradient></defs>
<rect width="512" height="512" rx="120" fill="url(#g)"/>
<g stroke="#fff" stroke-width="66" stroke-linecap="round">
<line x1="136" y1="136" x2="376" y2="376"/><line x1="376" y1="136" x2="136" y2="376"/>
</g>
<rect x="136" y="430" width="240" height="22" rx="11" fill="#1d9bf0"/>
</svg>
`;
writeFileSync(join(outDir, 'favicon.svg'), svg);
writeFileSync(join(outDir, 'apple-touch-icon.png'), makeIcon(180));
console.log('✓ ikony PWA wygenerowane w apps/web/public/icons');
