// SPDX-License-Identifier: AGPL-3.0-only
// bumpmesh-mcp: drive BumpMesh (CNC Kitchen's texturing tool) from an AI agent.
//
// One process does three things on 127.0.0.1:<port>:
//   • serves this BumpMesh fork (the folder above mcp/) as a static site,
//   • accepts the page's WebSocket at /agent (pairing token required) and
//     sends it commands — see js/agentBridge.js and the end of js/main.js,
//   • lets the page read model/image files and write exports through /fs.
// MCP itself speaks stdio. Claude Desktop may start more than one copy; only
// the first can hold the port, so later copies relay their calls through it
// over /peer, the way scanruler-mcp does.

import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { TOOLS } from './tools.js'
import { maskPaint } from './masks.js'

export const VERSION = '0.2.0'
/** The page's link protocol this server speaks (js/agentBridge.js PROTOCOL). */
const PROTOCOL = 1
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const log = (...a) => process.stderr.write(`[bumpmesh-mcp] ${a.join(' ')}\n`)

// ── Config: port and pairing token, kept so a paired tab keeps working ──────
function loadConfig() {
  const dir = path.join(os.homedir(), '.config', 'bumpmesh-mcp')
  const file = path.join(dir, 'config.json')
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  if (!cfg.token) cfg.token = crypto.randomBytes(18).toString('base64url')
  cfg.port = Number(process.env.BUMPMESH_PORT || cfg.port || 47318)
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 }) } catch {}
  return cfg
}
const CFG = loadConfig()
const BASE = `http://127.0.0.1:${CFG.port}`
const VENDOR = process.env.BUMPMESH_VENDOR ? path.resolve(process.env.BUMPMESH_VENDOR) : null
const pairingUrl = () => `${BASE}/#agent=${CFG.port}:${CFG.token}`

// ── File access for the page (/fs) ──────────────────────────────────────────
const READ_EXT = /\.(stl|obj|3mf|step|stp|png|jpe?g|webp|gif|bmp)$/i
const WRITE_EXT = /\.(stl|3mf)$/i
const expand = (p) => path.resolve(String(p).replace(/^~(?=$|\/)/, os.homedir()))

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ico': 'image/x-icon',
}

async function handleHttp(req, res) {
  const url = new URL(req.url, BASE)
  const authed = url.searchParams.get('token') === CFG.token
  try {
    if (url.pathname === '/fs') {
      if (!authed) return send(res, 403, 'bad token')
      const file = expand(url.searchParams.get('path') || '')
      if (req.method === 'GET') {
        if (!READ_EXT.test(file)) return send(res, 400, 'not a model or image file')
        const st = await fsp.stat(file)
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store' })
        return fs.createReadStream(file).pipe(res)
      }
      if (req.method === 'PUT') {
        if (!WRITE_EXT.test(file)) return send(res, 400, 'exports go to .stl or .3mf')
        await fsp.mkdir(path.dirname(file), { recursive: true })
        const tmp = `${file}.part`
        await new Promise((ok, fail) => {
          const out = fs.createWriteStream(tmp)
          req.pipe(out); out.on('finish', ok); out.on('error', fail); req.on('error', fail)
        })
        await fsp.rename(tmp, file)
        return send(res, 200, 'ok')
      }
      return send(res, 405, 'method')
    }
    // Offline / tests: BUMPMESH_VENDOR names a folder holding three/ (its
    // build/ and examples/jsm/) and fflate/index.js; the page's CDN imports
    // are pointed there. Unset, the page loads them from the CDN as bumpmesh.com does.
    if (VENDOR && url.pathname.startsWith('/_vendor/')) {
      const file = path.resolve(VENDOR, '.' + decodeURIComponent(url.pathname.slice('/_vendor'.length)))
      if (!file.startsWith(VENDOR + path.sep)) return send(res, 404, 'not found')
      const st = await fsp.stat(file).catch(() => null)
      if (!st || !st.isFile()) return send(res, 404, 'not found')
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' })
      return fs.createReadStream(file).pipe(res)
    }
    // Static app. Never serve the server's own folder, git data or dotfiles.
    let rel = decodeURIComponent(url.pathname)
    if (rel.endsWith('/')) rel += 'index.html'
    const file = path.resolve(APP_ROOT, '.' + rel)
    const inside = file.startsWith(APP_ROOT + path.sep)
    const relParts = path.relative(APP_ROOT, file).split(path.sep)
    if (!inside || relParts[0] === 'mcp' || relParts.some((p) => p.startsWith('.'))) return send(res, 404, 'not found')
    const st = await fsp.stat(file).catch(() => null)
    if (!st || !st.isFile()) return send(res, 404, 'not found')
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' })
    if (VENDOR && /\.(html|js)$/i.test(file)) {
      const text = (await fsp.readFile(file, 'utf8'))
        .replaceAll('https://cdn.jsdelivr.net/npm/three@0.170.0/', '/_vendor/three/')
        .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/fflate@[^"']+/g, '/_vendor/fflate/index.js')
      return res.end(text)
    }
    fs.createReadStream(file).pipe(res)
  } catch (e) {
    send(res, e.code === 'ENOENT' ? 404 : 500, e.message)
  }
}
function send(res, code, text) {
  if (res.headersSent) return res.end()
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }); res.end(text)
}

// ── The link: page socket, peer relays, and calls by id ─────────────────────
class Link {
  constructor() {
    this.page = null       // WebSocket of the connected page
    this.upstream = null   // WebSocket to the primary, when this copy is a relay
    this.pending = new Map()
    this.nextId = 1
    this.peers = new Set()
  }
  get mode() { return this.upstream ? 'relay' : 'primary' }
  /** A page counts as connected once it said hello: what it is comes with it. */
  get connected() { return this.upstream ? this.upstreamPage : !!this.page && !!this.pageInfo }

  call(cmd, args, timeoutMs = 600_000) {
    const ws = this.upstream || this.page
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.connected) {
      return Promise.reject(new Error(`No BumpMesh tab is connected. Run bumpmesh_open (or open ${BASE}/ in the browser it was paired in).`))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${cmd} timed out after ${timeoutMs / 1000}s`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, cmd, args }))
    })
  }
  answer(msg) {
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id); clearTimeout(p.timer)
    msg.error ? p.reject(new Error(msg.error.message || 'failed')) : p.resolve(msg.result)
  }
  dropAll(why) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)) }
    this.pending.clear()
  }
}
const link = new Link()

function startPrimary(httpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 ** 2 })
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, BASE)
    const origin = req.headers.origin
    const okOrigin = !origin || /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(origin)
    if (!okOrigin || url.searchParams.get('token') !== CFG.token || !['/agent', '/peer'].includes(url.pathname)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy()
    }
    wss.handleUpgrade(req, socket, head, (ws) => (url.pathname === '/agent' ? onPage(ws) : onPeer(ws)))
  })

  function onPage(ws) {
    if (link.page && link.page.readyState === WebSocket.OPEN) {
      // A newer tab replaces the old one: the person most likely reloaded or reopened.
      try { link.page.close(4009, 'replaced') } catch {}
    }
    link.page = ws
    link.pageInfo = null
    log('page connected')
    ws.send(JSON.stringify({ welcome: { version: VERSION } }))
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data.toString('utf8')) } catch { return }
      if (msg.hello) {
        link.pageInfo = { version: msg.hello.version ?? null, protocol: msg.hello.protocol ?? null, commands: msg.hello.commands ?? [] }
        if (msg.hello.protocol !== PROTOCOL) log(`the page speaks link protocol ${msg.hello.protocol}, this server ${PROTOCOL} — update the one that is older`)
        for (const p of link.peers) p.send(JSON.stringify({ pageState: true }))
        return
      }
      if (typeof msg.id === 'string' && msg.id.startsWith('p')) return routeToPeer(msg)
      link.answer(msg)
    })
    ws.on('close', () => {
      if (link.page !== ws) return
      link.page = null
      link.pageInfo = null
      log('page gone')
      link.dropAll('The BumpMesh tab disconnected before answering. If it was a change, check bumpmesh_status before repeating it.')
      for (const p of link.peers) p.send(JSON.stringify({ pageState: false }))
    })
  }

  // Peers: other copies of this server. Their ids are rewritten so answers can find their way back.
  const peerRoutes = new Map()
  let peerSeq = 0
  function onPeer(ws) {
    link.peers.add(ws)
    ws.send(JSON.stringify({ pageState: link.connected }))
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data.toString('utf8')) } catch { return }
      if (!link.page) return ws.send(JSON.stringify({ id: msg.id, error: { message: 'No BumpMesh tab is connected.' } }))
      const rid = `p${++peerSeq}`
      peerRoutes.set(rid, { ws, id: msg.id })
      link.page.send(JSON.stringify({ ...msg, id: rid }))
    })
    ws.on('close', () => link.peers.delete(ws))
  }
  function routeToPeer(msg) {
    const r = peerRoutes.get(msg.id)
    if (!r) return
    peerRoutes.delete(msg.id)
    if (r.ws.readyState === WebSocket.OPEN) r.ws.send(JSON.stringify({ ...msg, id: r.id }))
  }
}

function startRelay() {
  const connect = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${CFG.port}/peer?token=${CFG.token}`)
    ws.on('open', () => { link.upstream = ws; log('relaying through the copy that holds the port') })
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data.toString('utf8')) } catch { return }
      if ('pageState' in msg) { link.upstreamPage = msg.pageState; return }
      link.answer(msg)
    })
    ws.on('close', () => {
      if (link.upstream === ws) { link.upstream = null; link.upstreamPage = false }
      link.dropAll('Lost the connection to the BumpMesh server.')
      setTimeout(boot, 1000)   // the primary went away: try to become it
    })
    ws.on('error', () => {})
  }
  connect()
}

function boot() {
  const httpServer = http.createServer(handleHttp)
  httpServer.once('error', (e) => {
    if (e.code === 'EADDRINUSE') startRelay()
    else log('server error', e.message)
  })
  httpServer.listen(CFG.port, '127.0.0.1', () => {
    log(`serving BumpMesh at ${BASE}/`)
    startPrimary(httpServer)
  })
}

// ── Opening the page ────────────────────────────────────────────────────────
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); return true } catch { return false }
}

async function waitForPage(ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (link.connected) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

// ── Tool handlers ───────────────────────────────────────────────────────────
const fsUrl = (p) => `/fs?token=${encodeURIComponent(CFG.token)}&path=${encodeURIComponent(p)}`
const json = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] })

async function requireFile(p, kind, ext = READ_EXT) {
  const file = expand(p)
  const st = await fsp.stat(file).catch(() => null)
  if (!st || !st.isFile()) throw new Error(`${kind} not found: ${file}`)
  if (!ext.test(file)) throw new Error(`${file} is not a ${kind === 'Mask' ? 'mask (.json)' : 'model or image'} this tool reads.`)
  return file
}

const HANDLERS = {
  async bumpmesh_open({ launch = true } = {}) {
    if (link.connected) return json({ connected: true, url: `${BASE}/`, note: 'A BumpMesh tab is already connected.' })
    const url = pairingUrl()
    const launched = launch && openBrowser(url)
    const ok = await waitForPage(launched ? 20_000 : 1000)
    return json({
      connected: ok,
      pairingUrl: url,
      note: ok ? 'BumpMesh is open and connected.'
        : launched ? 'Opened the browser but the tab has not connected yet. If nothing opened, give the user the pairing URL to open.'
          : 'Give the user the pairing URL to open in their browser.',
    })
  },
  async bumpmesh_status() {
    if (!link.connected) return json({ connected: false, server: { version: VERSION, mode: link.mode, url: `${BASE}/` } })
    const page = link.pageInfo
    const mismatch = page && page.protocol !== PROTOCOL
      ? `The BumpMesh page speaks link protocol ${page.protocol} and this server ${PROTOCOL}: reload the page (it is served by this server, so a reload brings the matching one).`
      : null
    return json({ connected: true, server: { version: VERSION, mode: link.mode, protocol: PROTOCOL }, page: page ? { version: page.version, protocol: page.protocol } : null, ...(mismatch ? { warning: mismatch } : {}), ...(await link.call('status')) })
  },
  async bumpmesh_load_model({ path: p, stepQuality }) {
    const file = await requireFile(p, 'Model')
    return json(await link.call('load_model', { url: fsUrl(file), fileName: path.basename(file), stepPreset: stepQuality }))
  },
  async bumpmesh_list_textures(args) {
    const list = await link.call('list_textures', args)
    return json({ count: list.length, textures: list })
  },
  async bumpmesh_set_texture({ name, imagePath, keepScale }) {
    if (imagePath) {
      const file = await requireFile(imagePath, 'Image')
      return json(await link.call('set_texture', { imageUrl: fsUrl(file), imageName: path.basename(file), keepScale }))
    }
    return json(await link.call('set_texture', { name, keepScale }))
  },
  async bumpmesh_get_settings() { return json(await link.call('get_settings')) },
  async bumpmesh_set_settings({ settings }) { return json(await link.call('set_settings', { settings })) },
  async bumpmesh_mask(args) { return json(await link.call('mask', args)) },
  async bumpmesh_layer(args) { return json(await link.call('layer', args)) },
  async bumpmesh_preview({ enabled }) { return json(await link.call('preview', { enabled })) },
  async bumpmesh_render(args) {
    const r = await link.call('render', args)
    return {
      content: [
        { type: 'image', data: r.base64, mimeType: r.mimeType },
        { type: 'text', text: `view: ${r.view}; ${r.preview3d ? '3D displacement preview on' : 'shader preview (turn on bumpmesh_preview for true geometry)'}` },
      ],
    }
  },
  async bumpmesh_export({ path: p, format, overwrite = false }) {
    const fmt = format || (/\.3mf$/i.test(p) ? '3mf' : 'stl')
    let out = expand(p)
    if (!new RegExp(`\\.${fmt}$`, 'i').test(out)) out += `.${fmt}`
    if (!overwrite && fs.existsSync(out)) throw new Error(`${out} exists. Pass overwrite: true or pick another path.`)
    const r = await link.call('export', { format: fmt, uploadUrl: fsUrl(out) }, 1_800_000)
    return json({ savedTo: out, ...r })
  },
  // Not listed: for contract tests — what the app would feed its pipeline.
  async bumpmesh_debug_pipeline_inputs() { return json(await link.call('pipeline_inputs')) },
  async bumpmesh_cancel() { return json(await link.call('cancel')) },
  async bumpmesh_guide({ section } = {}) {
    const text = await fsp.readFile(path.join(APP_ROOT, 'mcp', 'GUIDE.md'), 'utf8')
    if (!section) return { content: [{ type: 'text', text }] }
    const parts = text.split(/^## /m).slice(1)
    const want = String(section).toLowerCase()
    const heading = (p) => p.split('\n')[0].toLowerCase()
    const hit = parts.find((p) => heading(p).includes(want)) ?? parts.find((p) => p.toLowerCase().includes(want))
    return { content: [{ type: 'text', text: hit ? `## ${hit}` : `No section like "${section}". Sections: ${parts.map((p) => p.split('\n')[0]).join(' | ')}` }] }
  },
  async bumpmesh_texture_file(args) { return json(await textureFileHeadless(args)) },
  async bumpmesh_undo() { return json(await link.call('undo')) },
  async bumpmesh_redo() { return json(await link.call('redo')) },
}

// ── Headless: the engine in this process, no browser ───────────────────────
async function textureFileHeadless({ path: input, output, layers, settings = {}, overwrite = false }) {
  const engine = await import('../../engine/index.js').catch((e) => {
    throw new Error(`The engine needs three and fflate beside it (bumpmesh/node_modules): ${e.message}`)
  })
  const node = await import('../../engine/node.js')
  const { prepareMap } = await import('../../engine/maps.js')
  const { stlBytes, threeMfBytes } = await import('../../engine/writers.js')
  const file = await requireFile(input, 'Model')
  if (!/\.stl$/i.test(file)) throw new Error('Headless, only STL models are read — open others in the page (bumpmesh_load_model).')
  const positions = node.readSTL(await fsp.readFile(file))
  if (!Array.isArray(layers) || !layers.length) throw new Error('Give at least one layer: { texture: "Knurling" } or { image: "/path/map.png" }, with its settings.')
  const tri = positions.length / 9
  const built = []
  for (const L of layers) {
    let image, defaultScale = null
    if (L.texture) { const p = node.loadPreset(L.texture); image = p.image; defaultScale = p.defaultScale }
    else if (L.image) image = node.loadImage(expand(L.image))
    else throw new Error('Each layer needs a texture (library name) or an image (PNG path).')
    const s = { ...(L.settings || {}) }
    if (s.scaleU == null && defaultScale != null) {
      const mins = [Infinity, Infinity, Infinity], maxs = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { mins[k] = Math.min(mins[k], positions[i + k]); maxs[k] = Math.max(maxs[k], positions[i + k]) }
      s.scaleU = s.scaleV = parseFloat((defaultScale * Math.max(...maxs.map((m, k) => m - mins[k]))).toPrecision(3))
    }
    const mask = L.mask ? { mode: L.mask.mode || 'exclude', paint: await maskPaint(positions, L.mask, (f) => requireFile(f, 'Mask', /\.json$/i)) } : null
    built.push({ image: prepareMap(image, s), settings: s, mask, blendAdd: L.blend === 'add' })
  }
  if (settings.refineLength == null) {
    const mins = [Infinity, Infinity, Infinity], maxs = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { mins[k] = Math.min(mins[k], positions[i + k]); maxs[k] = Math.max(maxs[k], positions[i + k]) }
    const diag = Math.hypot(...maxs.map((m, k) => m - mins[k]))
    settings.refineLength = Math.max(0.05, Math.min(5, +(diag / 250).toFixed(2)))
  }
  const t0 = Date.now()
  const r = await engine.textureMesh({ positions, layers: built, settings })
  const fmt = /\.3mf$/i.test(output) ? '3mf' : 'stl'
  let out = expand(output)
  if (!/\.(stl|3mf)$/i.test(out)) out += '.stl'
  if (!overwrite && fs.existsSync(out)) throw new Error(`${out} exists. Pass overwrite: true or pick another path.`)
  await fsp.writeFile(out, fmt === '3mf' ? await threeMfBytes(r.positions) : stlBytes(r.positions, r.normals))
  return { savedTo: out, triangles: r.triangles, inputTriangles: r.inputTriangles, refineLength: settings.refineLength, seconds: (Date.now() - t0) / 1000, warnings: r.warnings, engine: engine.ENGINE_VERSION }
}

// ── App mode: BumpMesh by hand, no agent needed ────────────────────────────
// What the BumpMesh.app launcher runs: serve the app and open it, paired, in
// the browser. If a copy already holds the port (Claude Desktop's, or an
// earlier launch), just open the page — it is the same app on the same port.
async function appMode() {
  const url = pairingUrl()
  const httpServer = http.createServer(handleHttp)
  httpServer.once('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log(`already running on ${BASE}/ — opening it`)
      openBrowser(url)
      setTimeout(() => process.exit(0), 500)
    } else {
      log('server error', e.message)
      process.exit(1)
    }
  })
  httpServer.listen(CFG.port, '127.0.0.1', () => {
    log(`serving BumpMesh at ${BASE}/ (app mode; Ctrl+C or quit the launcher's process to stop)`)
    startPrimary(httpServer)
    openBrowser(url)
  })
}

// ── MCP ─────────────────────────────────────────────────────────────────────
export async function main() {
  if (process.argv.includes('--version')) { console.log(VERSION); return }
  if (process.argv.includes('--url')) { console.log(pairingUrl()); return }
  if (process.argv.includes('--app')) return appMode()
  boot()
  const server = new Server(
    { name: 'bumpmesh', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'Drives BumpMesh, CNC Kitchen\'s tool that adds physical surface textures (displacement) to 3D-print meshes. ' +
        'Start with bumpmesh_open, then bumpmesh_load_model with a file path. Pick a texture (bumpmesh_list_textures / bumpmesh_set_texture), ' +
        'tune it with bumpmesh_set_settings (textureHeight = depth in mm, scaleU/scaleV = tile size in mm), limit where it goes with bumpmesh_mask, ' +
        'check it with bumpmesh_render, and write the result with bumpmesh_export. Coordinates are the model file\'s own, in mm. ' +
        'Pairs with ScanRuler: export STL/STEP from ScanRuler, load it here.',
    },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const h = HANDLERS[req.params.name]
    if (!h) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${req.params.name}` }] }
    try {
      return await h(req.params.arguments || {})
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message || String(e) }] }
    }
  })
  await server.connect(new StdioServerTransport())
}
