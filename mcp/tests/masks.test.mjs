// SPDX-License-Identifier: AGPL-3.0-only
// Headless masks: box, facing, and triangles by index (a CAD host's faces).
// Plain Node: node --test mcp/tests/masks.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { maskPaint } from '../src/masks.js'

// Two triangles: one facing +z at z 0, one facing +x at x 5.
const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 0, 0, 5, 1, 0, 5, 0, 1])

test('triangles by index paint just those', async () => {
  const p = await maskPaint(positions, { triangles: [1] })
  assert.deepEqual([...p], [0, 0, 0, 1, 1, 1])
})

test('a triangles file written with the STL, and checked against it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-mask-'))
  const f = join(dir, 'mask.json')
  writeFileSync(f, JSON.stringify({ triangles: [0], stlTriangles: 2 }))
  assert.deepEqual([...(await maskPaint(positions, { trianglesFile: f }))], [1, 1, 1, 0, 0, 0])
  writeFileSync(f, JSON.stringify({ triangles: [0], stlTriangles: 3 }))
  await assert.rejects(maskPaint(positions, { trianglesFile: f }), /made for 3 triangles/)
})

test('facing and box still paint, together with triangles', async () => {
  assert.deepEqual([...(await maskPaint(positions, { facing: [0, 0, 1] }))], [1, 1, 1, 0, 0, 0])
  assert.deepEqual([...(await maskPaint(positions, { box: { min: [4, -1, -1], max: [6, 2, 2] }, triangles: [0] }))], [1, 1, 1, 1, 1, 1])
})

test('an index not in the STL is refused', async () => {
  await assert.rejects(maskPaint(positions, { triangles: [2] }), /not in the STL/)
  await assert.rejects(maskPaint(positions, {}), /Headless masks/)
})
