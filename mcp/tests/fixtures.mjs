// SPDX-License-Identifier: AGPL-3.0-only
// Test parts, written as binary STL.
import { writeFileSync } from 'node:fs'

/** A closed cylinder, radius r, height h, Z 0–h, `seg` facets round. */
export function cylinderSTL(file, { r = 15, h = 40, seg = 96 } = {}) {
  const tris = []
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * 2 * Math.PI, a1 = ((i + 1) / seg) * 2 * Math.PI
    const p0 = [r * Math.cos(a0), r * Math.sin(a0)], p1 = [r * Math.cos(a1), r * Math.sin(a1)]
    tris.push([[p0[0], p0[1], 0], [p1[0], p1[1], 0], [p1[0], p1[1], h]], [[p0[0], p0[1], 0], [p1[0], p1[1], h], [p0[0], p0[1], h]])
    tris.push([[0, 0, h], [p0[0], p0[1], h], [p1[0], p1[1], h]], [[0, 0, 0], [p1[0], p1[1], 0], [p0[0], p0[1], 0]])
  }
  const buf = Buffer.alloc(84 + 50 * tris.length)
  buf.writeUInt32LE(tris.length, 80)
  tris.forEach((t, k) => t.flat().forEach((c, j) => buf.writeFloatLE(c, 84 + 50 * k + 12 + 4 * j)))
  writeFileSync(file, buf)
  return file
}

/** Radius range of an STL's vertices between z0 and z1, and its triangle count. */
export function radialRange(buf, z0, z1) {
  const n = buf.readUInt32LE(80)
  let min = Infinity, max = 0
  for (let t = 0; t < n; t++) for (let v = 0; v < 3; v++) {
    const o = 84 + 50 * t + 12 + 12 * v
    const x = buf.readFloatLE(o), y = buf.readFloatLE(o + 4), z = buf.readFloatLE(o + 8)
    if (z < z0 || z > z1) continue
    const r = Math.hypot(x, y)
    if (r < min) min = r
    if (r > max) max = r
  }
  return { min, max, triangles: n }
}
