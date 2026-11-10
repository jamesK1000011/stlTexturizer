// SPDX-License-Identifier: AGPL-3.0-only
// Where a headless texture layer goes, as the engine's per-corner paint: a
// box, a facing direction, and/or triangles by index into the STL as read —
// the last what a CAD host that knows its faces writes beside the STL
// (FreeCAD's texture_prepare), so a texture keeps exactly to the faces asked.
import { readFile } from 'node:fs/promises'

/** Float32Array(triangles * 3), 1 where the mask paints. readMaskFile(path)
 *  resolves a trianglesFile path (or throws). */
export async function maskPaint(positions, mask, resolveFile = async (f) => f) {
  const tri = positions.length / 9
  const { box, facing, angleDeg = 30, triangles, trianglesFile } = mask
  let picked = triangles
  if (trianglesFile) {
    const t = JSON.parse(await readFile(await resolveFile(trianglesFile), 'utf8'))
    picked = Array.isArray(t) ? t : t.triangles
    if (t && !Array.isArray(t) && t.stlTriangles != null && t.stlTriangles !== tri) {
      throw new Error(`The mask was made for ${t.stlTriangles} triangles; the STL has ${tri}: make them together.`)
    }
  }
  if (!box && !facing && !picked) throw new Error('Headless masks are a box and/or a facing direction, or triangles: { mode, box: { min, max }, facing, angleDeg } or { mode, triangles | trianglesFile }.')
  const paint = new Float32Array(tri * 3)
  if (picked) {
    for (const t of picked) {
      if (!Number.isInteger(t) || t < 0 || t >= tri) throw new Error(`Mask triangle ${t} is not in the STL (0 to ${tri - 1}).`)
      paint.fill(1, t * 3, t * 3 + 3)
    }
  }
  if (box || facing) {
    const f = facing ? (() => { const l = Math.hypot(...facing); return facing.map((x) => x / l) })() : null
    const cos = Math.cos((angleDeg * Math.PI) / 180)
    for (let t = 0; t < tri; t++) {
      const p = positions.subarray(t * 9, t * 9 + 9)
      let ok = true
      if (f) {
        const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2]
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
        const l = Math.hypot(nx, ny, nz) || 1
        ok = (nx * f[0] + ny * f[1] + nz * f[2]) / l >= cos
      }
      if (ok && box) for (let c = 0; c < 3 && ok; c++) for (let k = 0; k < 3; k++) if (p[c * 3 + k] < box.min[k] || p[c * 3 + k] > box.max[k]) ok = false
      if (ok) paint.fill(1, t * 3, t * 3 + 3)
    }
  }
  return paint
}
