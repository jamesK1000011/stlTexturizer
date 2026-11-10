// SPDX-License-Identifier: AGPL-3.0-only
// The tools bumpmesh-mcp offers an agent, as MCP JSON Schemas.

const point = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }

export const TOOLS = [
  {
    name: 'bumpmesh_open',
    description: 'Open BumpMesh in the browser (served locally by this server) and connect to it. Call first. If the tab does not connect, hand the user the pairing URL.',
    inputSchema: { type: 'object', properties: { launch: { type: 'boolean', description: 'Open the browser (default true).' } } },
  },
  {
    name: 'bumpmesh_status',
    description: 'Whether a BumpMesh tab is connected; the loaded model (name, triangles, bounds in the file\'s own mm), active texture, layers and their masks, preview state, busy flags, and recent warnings the page raised.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bumpmesh_load_model',
    description: 'Load a model from a file path on this computer: STL, OBJ, 3MF or STEP. Replaces the current model; texture and settings carry over. Typical source: a ScanRuler export.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Absolute path or ~/…' },
        stepQuality: { type: 'string', enum: ['coarse', 'standard', 'fine', 'custom'], description: 'STEP only: tessellation preset (default: the dialog\'s choice).' },
      },
    },
  },
  {
    name: 'bumpmesh_list_textures',
    description: 'The built-in texture library: name, category, default tile size as a fraction of the model\'s largest dimension. Categories include natural, patterns, geometric, fabric, grip, mold, organic.',
    inputSchema: { type: 'object', properties: { category: { type: 'string' }, search: { type: 'string', description: 'Substring of the name, e.g. "knurl".' } } },
  },
  {
    name: 'bumpmesh_set_texture',
    description: 'Set the active layer\'s texture: a library texture by name, or a grayscale heightmap image from disk (white = high). Resets tile size to the texture\'s default unless keepScale.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Library texture name (see bumpmesh_list_textures).' },
        imagePath: { type: 'string', description: 'PNG/JPG/WebP heightmap on disk.' },
        keepScale: { type: 'boolean', description: 'Keep the current tile size.' },
      },
    },
  },
  {
    name: 'bumpmesh_get_settings',
    description: 'Current texturing settings for the active layer plus global output settings, with what each one means.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bumpmesh_set_settings',
    description: 'Change settings; only the keys given change. Main ones: textureHeight (depth mm), scaleU/scaleV (tile mm), rotation (deg), mappingMode (5 triplanar, 3 cylindrical, 0–2 planar), bottomAngleLimit/topAngleLimit (deg, leave down/up faces plain), boundaryFalloff (mm), refineLength (mm, output resolution), maxTriangles, noDownwardZ. bumpmesh_get_settings lists all with meanings.',
    inputSchema: { type: 'object', required: ['settings'], properties: { settings: { type: 'object', additionalProperties: true } } },
  },
  {
    name: 'bumpmesh_mask',
    description:
      'Choose which surfaces of the active layer get the texture. mode "exclude" = painted faces stay plain (default); "include" = only painted faces get texture (switching mode clears the paint). ' +
      'Paint by: near (a point in the model file\'s mm; flood-fills the smooth region around the nearest face, stopping at edges sharper than spreadDeg), ' +
      'normal + withinDeg (all faces facing that way, e.g. [0,0,1] for up), and/or box {min,max} (faces whose centre is inside). erase removes paint. action "clear" wipes the layer\'s paint.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['paint', 'clear'], description: 'Default paint.' },
        mode: { type: 'string', enum: ['exclude', 'include'] },
        near: point,
        spreadDeg: { type: 'number', description: 'Fill stops at edges sharper than this (default 20).' },
        normal: point,
        withinDeg: { type: 'number', description: 'With normal: angular tolerance (default 10).' },
        box: { type: 'object', properties: { min: point, max: point }, required: ['min', 'max'] },
        erase: { type: 'boolean' },
      },
    },
  },
  {
    name: 'bumpmesh_layer',
    description: 'Texture layers (up to 4): each has its own texture, settings and mask. list | add | activate {index} | remove {index} | visible {index, visible} | blend {index, blend: cover|add}. Other tools act on the active layer. A new layer starts in include mode with nothing painted, so it covers NOTHING until you paint its surface (bumpmesh_mask { mode: "include", … }) — or give it the whole part with bumpmesh_mask { mode: "exclude", action: "clear" } (a stamp layer, say).',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'activate', 'remove', 'visible', 'blend'] },
        index: { type: 'integer' },
        visible: { type: 'boolean' },
        blend: { type: 'string', enum: ['cover', 'add'] },
      },
    },
  },
  {
    name: 'bumpmesh_preview',
    description: 'Turn the true-geometry 3D displacement preview on or off. Off, the view is a fast shader preview. Waits for the build to finish.',
    inputSchema: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } },
  },
  {
    name: 'bumpmesh_render',
    description: 'Picture of the model as BumpMesh shows it. Moves the camera to the view (the user sees it too).',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom'] },
        direction: { ...point, description: 'Custom: camera direction from the model centre.' },
        maxSize: { type: 'integer', description: 'Longest side in px (default 1024).' },
      },
    },
  },
  {
    name: 'bumpmesh_export',
    description: 'Run the full texturing pipeline and save the printable mesh to a path (.stl or .3mf). Can take minutes on fine settings. Refuses to overwrite unless overwrite: true.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string' }, format: { type: 'string', enum: ['stl', '3mf'] }, overwrite: { type: 'boolean' } },
    },
  },
  {
    name: 'bumpmesh_cancel',
    description: 'Stop an export or a 3D preview build that is running. Answers at once.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bumpmesh_guide',
    description: 'How to texture a part well with these tools — depth and tile size the printer can make, keeping fit surfaces plain, mapping modes, stamps, budgets, checking the result. Read it once before a texturing task; section narrows it to one part (e.g. "depth", "masking", "stamps").',
    inputSchema: { type: 'object', properties: { section: { type: 'string' } } },
  },
  {
    name: 'bumpmesh_texture_file',
    description:
      'Texture an STL file with no browser at all — BumpMesh\'s engine in this process, the same code the page exports with — and write STL or 3MF. For a batch or a quick job; the page (bumpmesh_load_model …) is the way to look at it first. Each layer: { texture: library name | image: PNG path, settings: { textureHeight, scaleU, mappingMode, … as bumpmesh_get_settings lists }, mask: { mode: exclude|include, box: { min, max }, facing: [x,y,z], angleDeg, triangles: [index …] | trianglesFile: a JSON { triangles, stlTriangles } a CAD host wrote with the STL (FreeCAD's texture_prepare) } }. settings: the output\'s own (refineLength — default the part\'s diagonal/250 —, maxTriangles, bottomAngleLimit, topAngleLimit, preserveUntextured …).',
    inputSchema: {
      type: 'object',
      required: ['path', 'output', 'layers'],
      properties: {
        path: { type: 'string', description: 'The STL to texture.' },
        output: { type: 'string', description: 'Where to write it: .stl or .3mf.' },
        layers: { type: 'array', items: { type: 'object', additionalProperties: true }, minItems: 1, maxItems: 4 },
        settings: { type: 'object', additionalProperties: true },
        overwrite: { type: 'boolean' },
      },
    },
  },
  { name: 'bumpmesh_undo', description: 'Undo the last change in BumpMesh.', inputSchema: { type: 'object', properties: {} } },
  { name: 'bumpmesh_redo', description: 'Redo.', inputSchema: { type: 'object', properties: {} } },
]
