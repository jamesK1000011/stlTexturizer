/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// The engine from Node: reading STL / PNG files and the library textures off
// disk, without a browser. Headless hosts (bumpmesh-mcp's export, tests,
// scripts) use this; the page loads images on a canvas instead.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { unzlibSync } from 'fflate';
import { IMAGE_PRESETS } from '../js/presetTextures.js';
import { fitImage, PRESET_SIZE, CUSTOM_SIZE } from './maps.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Decode an 8-bit PNG (grey, grey+alpha, RGB, RGBA; not palette) to RGBA. */
export function decodePNG(buf) {
  const d = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (d.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG file.');
  let p = 8, w, h, ct, bd, interlace;
  const idat = [];
  while (p < d.length) {
    const len = d.readUInt32BE(p), type = d.toString('ascii', p + 4, p + 8), start = p + 8;
    if (type === 'IHDR') { w = d.readUInt32BE(start); h = d.readUInt32BE(start + 4); bd = d[start + 8]; ct = d[start + 9]; interlace = d[start + 12]; }
    else if (type === 'IDAT') idat.push(d.subarray(start, start + len));
    else if (type === 'IEND') break;
    p = start + len + 4;
  }
  if (bd !== 8) throw new Error(`Only 8-bit PNGs are read here (this one is ${bd}-bit) — save it as 8-bit greyscale.`);
  if (interlace) throw new Error('Interlaced PNGs are not read here — save it without interlacing.');
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  if (!ch) throw new Error('Palette PNGs are not read here — save it as greyscale or RGB.');
  const raw = unzlibSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = new Uint8ClampedArray(w * h * 4);
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride);
  const paeth = (a, b, c) => { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const r = raw[rp++], a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      cur[x] = (f === 0 ? r : f === 1 ? r + a : f === 2 ? r + b : f === 3 ? r + ((a + b) >> 1) : r + paeth(a, b, c)) & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const s = x * ch, o = (y * w + x) * 4;
      if (ch === 1) { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = 255; }
      else if (ch === 2) { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = cur[s + 1]; }
      else { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = ch === 4 ? cur[s + 3] : 255; }
    }
    prev.set(cur);
  }
  return { data: out, width: w, height: h };
}

/** A library texture by name, sized as the app sizes presets (fit 512 px). */
export function loadPreset(name) {
  const p = IMAGE_PRESETS.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!p) throw new Error(`No library texture named "${name}".`);
  const base = path.basename(p.url).replace(/\.(jpe?g|webp)$/i, '.png');
  const converted = path.join(ROOT, 'engine', 'presets', base);
  const file = existsSync(converted) ? converted : path.join(ROOT, p.url);
  return { name: p.name, defaultScale: p.defaultScale, category: p.category, image: fitImage(decodePNG(readFileSync(file)), PRESET_SIZE) };
}

/** Your own heightmap (PNG), sized as the app sizes uploads (fit 2048 px). */
export function loadImage(file) {
  if (!/\.png$/i.test(file)) throw new Error('Headless, only PNG heightmaps are read — convert it to an 8-bit greyscale PNG.');
  return fitImage(decodePNG(readFileSync(file)), CUSTOM_SIZE);
}

/** Non-indexed positions from a binary or ASCII STL. */
export function readSTL(buf) {
  const d = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const n = d.length >= 84 ? d.readUInt32LE(80) : 0;
  if (d.length === 84 + 50 * n) {
    const pos = new Float32Array(n * 9);
    for (let i = 0; i < n; i++) for (let v = 0; v < 9; v++) pos[i * 9 + v] = d.readFloatLE(84 + i * 50 + 12 + v * 4);
    return pos;
  }
  const text = d.toString('utf8');
  const nums = [...text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].flatMap((m) => [+m[1], +m[2], +m[3]]);
  if (!nums.length || nums.length % 9) throw new Error('Not an STL file this reads.');
  return Float32Array.from(nums);
}

export { IMAGE_PRESETS };
