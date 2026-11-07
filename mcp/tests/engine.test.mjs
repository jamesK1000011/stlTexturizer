// SPDX-License-Identifier: AGPL-3.0-only
// The engine with no browser: the contract the page, ScanRuler's Texture
// workspace and bumpmesh_texture_file rely on. Run after pulling BumpMesh:
//   node --test mcp/tests/*.test.mjs   (from the bumpmesh folder; needs three and fflate in node_modules)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { textureMesh, LAYER_KEYS, GLOBAL_KEYS, cornerPaintFromVertices, unindex } from '../../engine/index.js'
import { prepareMap } from '../../engine/maps.js'
import { readSTL, loadPreset, IMAGE_PRESETS } from '../../engine/node.js'
import { stlBytes, threeMfBytes } from '../../engine/writers.js'
import { cylinderSTL, radialRange } from './fixtures.mjs'

const dir = mkdtempSync(join(tmpdir(), 'bumpmesh-engine-'))
const positions = readSTL(readFileSync(cylinderSTL(join(dir, 'cyl.stl'))))
const knurl = loadPreset('Knurling')
const base = { mappingMode: 3, textureHeight: 0.6, scaleU: 6, scaleV: 6 }
const out = { refineLength: 0.5, maxTriangles: 400_000, bottomAngleLimit: 5, topAngleLimit: 5 }

test('every library texture loads', () => {
  for (const p of IMAGE_PRESETS) {
    const t = loadPreset(p.name)
    assert.ok(t.image.width > 0 && t.image.width <= 512 && t.image.height <= 512, p.name)
  }
})

test('settings keys split cleanly between layer and output', () => {
  assert.ok(LAYER_KEYS.includes('textureHeight') && GLOBAL_KEYS.includes('refineLength'))
  assert.equal(LAYER_KEYS.filter((k) => GLOBAL_KEYS.includes(k)).length, 0)
})

test('the wall stands proud by the depth, the caps stay plain', async () => {
  const r = await textureMesh({ positions, layers: [{ image: prepareMap(knurl.image, base), settings: base }], settings: out })
  const wall = radialRange(Buffer.from(stlBytes(r.positions, r.normals)), 3, 37)
  assert.ok(wall.min > 14.95 && wall.max > 15.5 && wall.max < 15.61, `wall r ${wall.min}–${wall.max}`)
  let top = 0
  for (let i = 2; i < r.positions.length; i += 3) if (r.positions[i] > 40.001 || r.positions[i] < -0.001) top++
  assert.equal(top, 0, 'nothing pushed past the caps')
  assert.deepEqual(r.warnings, [])
})

test('the resolution asked for is the one built', async () => {
  const coarse = await textureMesh({ positions, layers: [{ image: knurl.image, settings: base }], settings: { ...out, refineLength: 1 } })
  const fine = await textureMesh({ positions, layers: [{ image: knurl.image, settings: base }], settings: { ...out, refineLength: 0.5 } })
  assert.ok(fine.triangles > 2.5 * coarse.triangles, `${fine.triangles} vs ${coarse.triangles}`)
})

test('a painted face stays exactly where it was (exclude), and only it is textured (include)', async () => {
  const tri = positions.length / 9
  const paint = new Float32Array(tri * 3)
  // the side faces with x > 10: a strip of the wall
  for (let t = 0; t < tri; t++) {
    const p = positions.subarray(t * 9, t * 9 + 9)
    if (p[0] > 10 && p[3] > 10 && p[6] > 10 && Math.abs(p[2] - p[5]) + Math.abs(p[5] - p[8]) > 1) paint.fill(1, t * 3, t * 3 + 3)
  }
  const ex = await textureMesh({ positions, layers: [{ image: knurl.image, settings: base, mask: { mode: 'exclude', paint } }], settings: out })
  const inc = await textureMesh({ positions, layers: [{ image: knurl.image, settings: base, mask: { mode: 'include', paint } }], settings: out })
  const maxR = (r, pred) => { let m = 0; for (let i = 0; i < r.positions.length; i += 3) { const x = r.positions[i], y = r.positions[i + 1], z = r.positions[i + 2]; if (z > 3 && z < 37 && pred(x, y)) m = Math.max(m, Math.hypot(x, y)) } return m }
  const inStrip = (x, y) => x > 12 && Math.abs(y) < 5
  const outStrip = (x) => x < 5
  assert.ok(maxR(ex, inStrip) < 15.0001, `excluded strip untouched: ${maxR(ex, inStrip)}`)
  assert.ok(maxR(ex, outStrip) > 15.4, 'the rest textured')
  assert.ok(maxR(inc, inStrip) > 15.4, 'included strip textured')
  assert.ok(maxR(inc, outStrip) < 15.0001, `the rest plain: ${maxR(inc, outStrip)}`)
})

test('a stamp lands once, where asked, at its depth', async () => {
  const hex = loadPreset('Hexagon')
  const s = { mappingMode: 2, stampOnce: true, stampCenterX: 15, stampCenterY: 0, stampCenterZ: 20, stampSide: 1, scaleU: 12, scaleV: 12, textureHeight: 0.8 }
  const r = await textureMesh({ positions, layers: [{ image: hex.image, settings: s }], settings: out })
  let at = 0, away = 0
  for (let i = 0; i < r.positions.length; i += 3) {
    const x = r.positions[i], y = r.positions[i + 1], z = r.positions[i + 2], rr = Math.hypot(x, y)
    if (x > 10 && Math.abs(y) < 4 && Math.abs(z - 20) < 4) at = Math.max(at, rr)
    if (x < -10) away = Math.max(away, rr)
  }
  assert.ok(at > 15.6 && at < 15.81, `stamp ${at}`)
  assert.ok(away < 15.0001, `far side plain ${away}`)
})

test('cornerPaintFromVertices and unindex agree with the faces', () => {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0])
  const ix = new Uint32Array([0, 1, 2, 1, 3, 2])
  assert.equal(unindex(pos, ix).length, 18)
  assert.deepEqual([...cornerPaintFromVertices(ix, 4, [1, 2])], [0, 1, 1, 1, 0, 1])
})

test('3MF is a zip with the model', async () => {
  const r = await textureMesh({ positions, layers: [{ image: knurl.image, settings: base }], settings: { ...out, refineLength: 1 } })
  const bytes = await threeMfBytes(r.positions)
  assert.equal(bytes[0], 0x50)
  assert.equal(bytes[1], 0x4b)
  assert.ok(bytes.length > 1000)
})
