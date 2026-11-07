/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// The engine's output as file bytes — the same binary STL and 3MF that
// js/exporter.js writes, returned instead of downloaded.

import { strToU8 } from 'fflate';
import { QuantizedPointMap } from '../js/meshIndex.js';
import { zipChunks } from '../js/zipStream.js';

/** Binary STL; normals from `normals` (first corner of each face) or the cross product. */
export function stlBytes(positions, normals = null) {
  const triCount = (positions.length / 9) | 0;
  const buffer = new ArrayBuffer(84 + 50 * triCount);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  view.setUint32(80, triCount, true);
  const posSrc = new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength);
  const norSrc = normals ? new Uint8Array(normals.buffer, normals.byteOffset, normals.byteLength) : null;
  for (let i = 0; i < triCount; i++) {
    const dst = 84 + i * 50, src = i * 36;
    if (norSrc) bytes.set(norSrc.subarray(src, src + 12), dst);
    else {
      const b = i * 9, p = positions;
      const ux = p[b + 3] - p[b], uy = p[b + 4] - p[b + 1], uz = p[b + 5] - p[b + 2];
      const vx = p[b + 6] - p[b], vy = p[b + 7] - p[b + 1], vz = p[b + 8] - p[b + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      view.setFloat32(dst, nx / len, true); view.setFloat32(dst + 4, ny / len, true); view.setFloat32(dst + 8, nz / len, true);
    }
    bytes.set(posSrc.subarray(src, src + 36), dst + 12);
  }
  return bytes;
}

/** 3MF (core 2015/02, millimetres), vertices welded on the 0.1 µm grid. */
export async function threeMfBytes(positions, shouldAbort = () => false) {
  const triCount = (positions.length / 9) | 0;
  const indexMap = new QuantizedPointMap(1e4, Math.min(triCount * 3, 1 << 22));
  const xyz = [];
  const tri = new Uint32Array(triCount * 3);
  for (let i = 0; i < triCount * 3; i++) {
    const b = i * 3;
    const idx = indexMap.getOrSet(positions[b], positions[b + 1], positions[b + 2], xyz.length / 3);
    if (indexMap.inserted) xyz.push(positions[b], positions[b + 1], positions[b + 2]);
    tri[i] = idx;
  }
  const types = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n</Types>\n';
  const rels = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    '<Relationship Id="rel-1" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n';
  const blob = await zipChunks([
    ['[Content_Types].xml', [strToU8(types)]],
    ['_rels/.rels', [strToU8(rels)]],
    ['3D/3dmodel.model', modelChunks(xyz, tri)],
  ], shouldAbort);
  return new Uint8Array(await blob.arrayBuffer());
}

function* modelChunks(vertices, indices) {
  const enc = new TextEncoder();
  const fmt = (n) => { let s = n.toFixed(4); if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, ''); return s; };
  let pending = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n<resources>\n<object id="1" type="model">\n<mesh>\n<vertices>\n';
  for (let i = 0; i < vertices.length; i += 3) {
    pending += `<vertex x="${fmt(vertices[i])}" y="${fmt(vertices[i + 1])}" z="${fmt(vertices[i + 2])}"/>\n`;
    if (pending.length >= 1 << 20) { yield enc.encode(pending); pending = ''; }
  }
  pending += '</vertices>\n<triangles>\n';
  for (let i = 0; i < indices.length; i += 3) {
    pending += `<triangle v1="${indices[i]}" v2="${indices[i + 1]}" v3="${indices[i + 2]}"/>\n`;
    if (pending.length >= 1 << 20) { yield enc.encode(pending); pending = ''; }
  }
  pending += '</triangles>\n</mesh>\n</object>\n</resources>\n<build>\n<item objectid="1"/>\n</build>\n</model>\n';
  yield enc.encode(pending);
}
