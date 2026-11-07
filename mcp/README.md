<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# bumpmesh-mcp (local fork)

Lets an AI agent (Claude Desktop, Claude Code, …) drive **BumpMesh**, CNC Kitchen's
surface-texturing tool, the way `scanruler-mcp` drives ScanRuler.

```
Claude ──stdio/MCP──> bumpmesh-mcp ──WebSocket──> BumpMesh tab (served by bumpmesh-mcp)
                          │  http://127.0.0.1:47318/       │
                          └──── /fs: reads models, writes exports on this Mac
```

* The server **serves this fork itself** on `127.0.0.1:47318`, so nothing depends on bumpmesh.com.
* The first tool call `bumpmesh_open` opens the page with a pairing link
  (`#agent=<port>:<token>`); the tab remembers it. Token + port: `~/.config/bumpmesh-mcp/config.json`.
* A chip at the bottom right of the page shows the link; click it to unpair.
* Alerts are logged (see `bumpmesh_status.notices`) instead of blocking the page.
* If a second copy starts (Claude Desktop runs two), it relays through the first.

## Tools (v0.2)
`bumpmesh_open`, `bumpmesh_status` (answers even mid-export, with its progress),
`bumpmesh_load_model` (STL/OBJ/3MF/STEP path), `bumpmesh_list_textures`,
`bumpmesh_set_texture` (library name or heightmap image path), `bumpmesh_get_settings` /
`bumpmesh_set_settings` (stamp and cylinder points in the model file's frame), `bumpmesh_mask`
(by point, facing direction, or box — exclude or include), `bumpmesh_layer` (up to 4 layers),
`bumpmesh_preview` (true 3D), `bumpmesh_render` (returns a picture), `bumpmesh_export`
(.stl / .3mf to a path), `bumpmesh_cancel`, `bumpmesh_undo` / `bumpmesh_redo`,
`bumpmesh_guide` (how to texture well — GUIDE.md), and `bumpmesh_texture_file` — the engine
with no browser at all, STL in, STL/3MF out.

The page and the server check each other's link protocol on connect; `bumpmesh_status`
warns on a mismatch.

## The engine
`../engine/` is BumpMesh's export pipeline as one call (`textureMesh`), run by
`bumpmesh_texture_file` here and vendored into ScanRuler's Texture workspace
(`scanruler/plugins/texture/scripts/sync-engine.mjs`). Run in the page on the same
inputs it gives BumpMesh's own Export to the bit. Headless it needs `three` and `fflate`
in `bumpmesh/node_modules`.

## Tests — run after pulling BumpMesh
* `node --test mcp/tests/*.test.mjs` — the engine, no browser.
* `node mcp/tests/contract.mjs` — the whole agent contract through a real MCP client;
  opens the pairing link in your browser (or `CHROME=/path/to/chrome` for a headless one).
  `BUMPMESH_VENDOR=<dir>` serves three/fflate from a folder instead of the CDN, offline.

## Claude Desktop
Settings → Developer → Edit Config, add beside `scanruler`:

```json
"bumpmesh": {
  "command": "/ABSOLUTE/PATH/TO/node",
  "args": ["/Users/jamesk/src/bumpmesh/mcp/bin/bumpmesh-mcp.js"]
}
```
(`which node` in Terminal gives the path; Node 20+.) Quit and reopen Claude Desktop.

## Claude Code
`claude mcp add --scope user bumpmesh -- node ~/src/bumpmesh/mcp/bin/bumpmesh-mcp.js`

## What changed in the app
* `js/main.js` — an `AGENT_COMMANDS` block appended at the end (needs the module's private state),
  plus two imports (`getRenderer, getScene`, `distSqPointToTri`).
* `js/agentBridge.js` — new: the socket, loaded only on a paired page.

Updating from upstream: `git stash; git pull; git stash pop` — the main.js change is an append, so it
rarely conflicts.
