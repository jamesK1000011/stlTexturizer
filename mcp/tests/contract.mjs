// SPDX-License-Identifier: AGPL-3.0-only
// The agent's contract with the BumpMesh page, end to end, through a real MCP
// client: the server started as Claude Desktop starts it, the page paired,
// a cylinder knurled with its top kept plain, rendered, exported and checked;
// an export cancelled; a stamp; the headless tool. Run it after pulling
// BumpMesh — a refactor of main.js that breaks a hook fails here, not in a
// chat.
//
//   node mcp/tests/contract.mjs                 (opens the pairing link in your browser)
//   CHROME=/path/to/chrome node mcp/tests/contract.mjs   (a headless Chrome instead)
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cylinderSTL, radialRange } from './fixtures.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'bumpmesh-contract-'))
const part = cylinderSTL(join(dir, 'cyl.stl'))
const port = String(47400 + Math.floor(Math.random() * 500))
let failed = 0
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}`); if (!ok) failed++ }

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(here, '..', 'bin', 'bumpmesh-mcp.js')],
  env: { ...process.env, BUMPMESH_PORT: port, HOME: mkdtempSync(join(tmpdir(), 'bumpmesh-home-')) },
  stderr: 'ignore',
})
const client = new Client({ name: 'bumpmesh-contract', version: '1' })
await client.connect(transport)
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { error: !!r.isError, text, json, images: r.content.filter((c) => c.type === 'image') }
}
let chrome = null
try {
  const tools = (await client.listTools()).tools.map((t) => t.name)
  check(['bumpmesh_open', 'bumpmesh_export', 'bumpmesh_cancel', 'bumpmesh_guide', 'bumpmesh_texture_file'].every((n) => tools.includes(n)), `${tools.length} tools listed`)

  const opened = await call('bumpmesh_open', { launch: !process.env.CHROME })
  if (process.env.CHROME && !opened.json.connected) {
    chrome = spawn(process.env.CHROME, ['--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'bm-chrome-'))}`, opened.json.pairingUrl], { stdio: 'ignore' })
  }
  let st
  for (let i = 0; i < 120; i++) { st = await call('bumpmesh_status'); if (st.json?.connected) break; await new Promise((r) => setTimeout(r, 500)) }
  check(st.json?.connected === true, 'the page paired and connected')
  check(st.json?.page?.protocol === st.json?.server?.protocol && !st.json?.warning, `page ${st.json?.page?.version} and server ${st.json?.server?.version} speak the same protocol`)

  const loaded = await call('bumpmesh_load_model', { path: part })
  check(loaded.json?.model?.triangles === 384 && loaded.json.model.bounds.size[2] === 40, `load_model: ${loaded.json?.model?.triangles} triangles`)
  const tex = await call('bumpmesh_set_texture', { name: 'Knurling' })
  check(tex.json?.texture === 'Knurling', 'set_texture Knurling')
  const set = await call('bumpmesh_set_settings', { settings: { textureHeight: 0.6, mappingMode: 3, topAngleLimit: 0 } })
  check(set.json?.settings?.mappingMode === 3 && set.json.settings.textureHeight === 0.6, 'set_settings cylindrical 0.6 mm')
  const bad = await call('bumpmesh_set_settings', { settings: { nope: 1 } })
  check(bad.error && /nope/.test(bad.text), 'an unknown setting is refused by name')
  const mask = await call('bumpmesh_mask', { mode: 'exclude', normal: [0, 0, 1], withinDeg: 5 })
  check(mask.json?.painted === 96, `mask the top: ${mask.json?.painted} faces`)
  const pic = await call('bumpmesh_render', { view: 'iso' })
  check(pic.images.length === 1 && pic.images[0].data.length > 1000, 'render returns a picture')

  // cancel: start an export, stop it
  const slow = call('bumpmesh_export', { path: join(dir, 'cancelled.stl') })
  await new Promise((r) => setTimeout(r, 400))
  const mid = await call('bumpmesh_status')
  check(mid.json?.busy?.exporting === true, `status answers during an export (${mid.json?.exportProgress})`)
  const cancel = await call('bumpmesh_cancel')
  const slowR = await slow
  check(cancel.json?.cancelled === true && slowR.error && !existsSync(join(dir, 'cancelled.stl')), 'cancel stops an export and nothing is written')

  const out = join(dir, 'knurled.stl')
  const exp = await call('bumpmesh_export', { path: out })
  check(!exp.error && existsSync(out), `export: ${exp.json?.triangles} triangles in ${exp.json?.seconds} s`)
  const buf = readFileSync(out)
  const wall = radialRange(buf, 3, 37)
  check(wall.max > 15.5 && wall.max < 15.61 && wall.min > 14.95, `the wall stands proud 0.6 mm (r ${wall.min.toFixed(3)}–${wall.max.toFixed(3)})`)
  let topZ = 0, topPts = 0
  for (let t = 0; t < wall.triangles; t++) for (let v = 0; v < 3; v++) { const o = 84 + 50 * t + 12 + 12 * v; const z = buf.readFloatLE(o + 8); const r = Math.hypot(buf.readFloatLE(o), buf.readFloatLE(o + 4)); if (r < 13) { topPts += z > 39 ? 1 : 0; if (z > 39) topZ = Math.max(topZ, z) } }
  check(topPts > 0 && Math.abs(topZ - 40) < 1e-4, `the masked top stays flat at Z 40 (${topZ})`)
  const again = await call('bumpmesh_export', { path: out })
  check(again.error && /exists/.test(again.text), 'export refuses to overwrite')

  await call('bumpmesh_layer', { action: 'add' })
  await call('bumpmesh_mask', { mode: 'exclude', action: 'clear' })
  await call('bumpmesh_set_texture', { name: 'Hexagon' })
  await call('bumpmesh_set_settings', { settings: { stampOnce: true, stampCenterX: 15, stampCenterY: 0, stampCenterZ: 20, stampSide: 1, mappingMode: 2, scaleU: 12, scaleV: 12, textureHeight: 0.8 } })
  const got = (await call('bumpmesh_get_settings')).json?.settings
  check(got?.stampCenterZ === 20, `stamp centre reads back in the file's frame (Z ${got?.stampCenterZ})`)
  const stampOut = join(dir, 'stamp.stl')
  await call('bumpmesh_export', { path: stampOut })
  const sb = readFileSync(stampOut)
  let at = 0
  for (let t = 0; t < sb.readUInt32LE(80); t++) for (let v = 0; v < 3; v++) { const o = 84 + 50 * t + 12 + 12 * v; const x = sb.readFloatLE(o), y = sb.readFloatLE(o + 4), z = sb.readFloatLE(o + 8); if (x > 10 && Math.abs(y) < 4 && Math.abs(z - 20) < 4) at = Math.max(at, Math.hypot(x, y)) }
  check(at > 15.65 && at < 15.81, `the stamp stands 0.8 mm proud at its centre (r ${at.toFixed(3)})`)

  const guide = await call('bumpmesh_guide', { section: 'depth' })
  check(/textureHeight/.test(guide.text), 'the guide serves a section')
  const headless = await call('bumpmesh_texture_file', { path: part, output: join(dir, 'headless.stl'), layers: [{ texture: 'Knurling', settings: { mappingMode: 3, textureHeight: 0.6 } }] })
  const hw = headless.error ? null : radialRange(readFileSync(join(dir, 'headless.stl')), 3, 37)
  check(hw && hw.max > 15.5 && hw.max < 15.61, `texture_file headless: ${headless.json?.triangles ?? headless.text} triangles`)
} finally {
  chrome?.kill()
  await client.close()
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS')
process.exit(failed ? 1 : 0)
