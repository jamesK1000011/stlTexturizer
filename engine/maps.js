/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Heightmaps as the engine takes them: RGBA ImageData-like { data, width,
// height }, sized as the app sizes them (presets to fit 512 px, your own
// images to fit 2048 px), with the texture smoothing and invert of main.js
// _effectiveMapFor applied. Pure JS: the page can also do the sizing on a
// canvas (which is what the app does, and then matches it to the pixel);
// Node uses fitImage here.

export const PRESET_SIZE = 512;
export const CUSTOM_SIZE = 2048;
/** textureAnalysis.js REF_TEXTURE_SIZE: the smoothing slider is in pixels of a 512 px map. */
const REF_TEXTURE_SIZE = 512;

/** { w, h } capped at maxSize on the longest side, aspect kept, never enlarged. */
export function fitDimensions(w, h, maxSize) {
  const s = Math.min(maxSize / w, maxSize / h, 1);
  return { w: Math.round(w * s), h: Math.round(h * s) };
}

/** Resize RGBA bilinearly (box-averaged when shrinking a lot) to fit maxSize. */
export function fitImage(img, maxSize) {
  const { w, h } = fitDimensions(img.width, img.height, maxSize);
  if (w === img.width && h === img.height) return img;
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = img.width / w, sy = img.height / h;
  const src = img.data, W = img.width, H = img.height;
  for (let y = 0; y < h; y++) {
    const y0 = y * sy, y1 = Math.min(H, (y + 1) * sy);
    for (let x = 0; x < w; x++) {
      const x0 = x * sx, x1 = Math.min(W, (x + 1) * sx);
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const i = (yy * W + xx) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { data: out, width: w, height: h };
}

function boxBlurH(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 4; c++) {
      let ti = y * w, li = ti, ri = ti + r;
      const fv = src[ti * 4 + c], lv = src[(ti + w - 1) * 4 + c];
      let val = (r + 1) * fv;
      for (let j = 0; j < r; j++) val += src[(ti + Math.min(j, w - 1)) * 4 + c];
      for (let j = 0; j <= r; j++) { val += (ri < y * w + w ? src[ri * 4 + c] : lv) - fv; dst[ti * 4 + c] = Math.round(val * iarr); ri++; ti++; }
      for (let j = r + 1; j < w - r; j++) { val += src[ri * 4 + c] - src[li * 4 + c]; dst[ti * 4 + c] = Math.round(val * iarr); ri++; li++; ti++; }
      for (let j = Math.max(w - r, r + 1); j < w; j++) { val += lv - src[li * 4 + c]; dst[ti * 4 + c] = Math.round(val * iarr); li++; ti++; }
    }
  }
}

function boxBlurV(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 4; c++) {
      let ti = x, li = ti, ri = ti + r * w;
      const fv = src[ti * 4 + c], lv = src[(ti + w * (h - 1)) * 4 + c];
      let val = (r + 1) * fv;
      for (let j = 0; j < r; j++) val += src[(ti + Math.min(j, h - 1) * w) * 4 + c];
      for (let j = 0; j <= r; j++) { val += (ri < w * h ? src[ri * 4 + c] : lv) - fv; dst[ti * 4 + c] = Math.round(val * iarr); ri += w; ti += w; }
      for (let j = r + 1; j < h - r; j++) { val += src[ri * 4 + c] - src[li * 4 + c]; dst[ti * 4 + c] = Math.round(val * iarr); li += w; ri += w; ti += w; }
      for (let j = Math.max(h - r, r + 1); j < h; j++) { val += lv - src[li * 4 + c]; dst[ti * 4 + c] = Math.round(val * iarr); li += w; ti += w; }
    }
  }
}

/** Gaussian-ish blur (3 box passes) of a tile, wrapped so it stays seamless. */
function blurTile(img, sigma) {
  const { width: w, height: h, data } = img;
  const padX = Math.min(w, Math.ceil(4 * sigma) + 2), padY = Math.min(h, Math.ceil(4 * sigma) + 2);
  const W = w + 2 * padX, H = h + 2 * padY;
  const a = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = (((y - padY) % h) + h) % h;
    for (let x = 0; x < W; x++) {
      const sx = (((x - padX) % w) + w) % w;
      const s = (sy * w + sx) * 4, d = (y * W + x) * 4;
      a[d] = data[s]; a[d + 1] = data[s + 1]; a[d + 2] = data[s + 2]; a[d + 3] = data[s + 3];
    }
  }
  const b = new Uint8ClampedArray(a.length);
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  for (let pass = 0; pass < 3; pass++) { boxBlurH(a, b, W, H, r); boxBlurV(b, a, W, H, r); }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(a.subarray(((y + padY) * W + padX) * 4, ((y + padY) * W + padX + w) * 4), y * w * 4);
  return { data: out, width: w, height: h };
}

/** The map a layer samples: its image smoothed and inverted as its settings say. */
export function prepareMap(img, { textureSmoothing = 0, invertTexture = false } = {}) {
  let out = img;
  if (textureSmoothing > 0) {
    const sigma = textureSmoothing * Math.max(1, Math.max(img.width, img.height) / REF_TEXTURE_SIZE);
    out = blurTile(img, sigma);
  }
  if (invertTexture) {
    const d = new Uint8ClampedArray(out.data);
    for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; d[i + 3] = 255; }
    out = { data: d, width: out.width, height: out.height };
  }
  return out;
}

/** RGBA from an 8-bit grey buffer. */
export function greyToRgba(grey, width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < grey.length; i++, j += 4) { data[j] = data[j + 1] = data[j + 2] = grey[i]; data[j + 3] = 255; }
  return { data, width, height };
}
