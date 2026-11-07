/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// BumpMesh's texturing engine as one call: a triangle mesh, the texture
// layers with their masks, and the output settings in; the printable mesh
// out. It is the same pipeline the app's Export button runs
// (js/exportPipeline.js), fed the way main.js's _pipelineInputs feeds it, so
// a host — the BumpMesh page, ScanRuler's Texture workspace, a Node script —
// gets the app's result without the app around it. Nothing here touches the
// DOM: images come in as ImageData-like { data, width, height } (RGBA), already
// sized; maps.js prepares them (smoothing, invert) the way the app does.

import { THREE } from '../js/threeCompat.js';
import { runExportPipeline } from '../js/exportPipeline.js';
import { buildFaceWeights } from '../js/exclusion.js';
import { isStampActive, stampFrame, stampUntouchedFaces, buildStampDepth } from '../js/mapping.js';
import { buildOutlineWrap } from '../js/outlineWrap.js';

export const ENGINE_VERSION = '1.0.0';

/** The settings a layer carries for itself (main.js LAYER_KEYS). */
export const LAYER_KEYS = [
  'mappingMode', 'scaleU', 'scaleV', 'lockScale',
  'offsetU', 'offsetV', 'rotation', 'rotateAroundZ',
  'amplitude', 'textureHeight', 'invertDisplacement', 'invertTexture', 'textureSmoothing',
  'symmetricDisplacement', 'mappingBlend', 'seamBandWidth', 'capAngle',
  'boundaryFalloff', 'boundaryFalloffCurve',
  'snapSeamlessWrap', 'cylinderCenterX', 'cylinderCenterY', 'cylinderRadius',
  'stampOnce', 'stampCenterX', 'stampCenterY', 'stampCenterZ', 'stampSide',
  'stampNormalX', 'stampNormalY', 'stampNormalZ',
];

/** The app's defaults (main.js `settings`), less the UI-only keys. */
export const DEFAULTS = Object.freeze({
  mappingMode: 5, scaleU: 25, scaleV: 25, amplitude: 0.5, textureHeight: 0.5,
  invertDisplacement: false, offsetU: 0, offsetV: 0, rotation: 0, rotateAroundZ: false,
  refineLength: 1.0, maxTriangles: 750_000, lockScale: true,
  bottomAngleLimit: 5, topAngleLimit: 0, mappingBlend: 1, seamBandWidth: 0.5,
  textureSmoothing: 0, invertTexture: false, blendNormalSmoothing: 32, capAngle: 20,
  boundaryFalloff: 0, boundaryFalloffCurve: 'ease', symmetricDisplacement: false,
  noDownwardZ: false, smoothBottom: true, harvestFlatFaces: true, harvestTol: 0.005,
  preserveUntextured: true, snapSeamlessWrap: true,
  cylinderCenterX: null, cylinderCenterY: null, cylinderRadius: null,
  stampOnce: false, stampCenterX: null, stampCenterY: null, stampCenterZ: null, stampSide: null,
  stampNormalX: null, stampNormalY: null, stampNormalZ: null,
  regularizeEnabled: true, regularizeAspectThreshold: 5, regularizeSlack: 3.0,
  regularizeAggressiveSlack: 8.0, regularizeExtremeAspect: 8, regularizeNormalDeg: 15,
  regularizeAggressiveNormalDeg: 25, regularizeSecondPassMul: 1.1,
});

/** The settings that are the whole export's, not a layer's. */
export const GLOBAL_KEYS = Object.keys(DEFAULTS).filter((k) => !LAYER_KEYS.includes(k));

export const MAPPING_MODES = Object.freeze({
  planarXY: 0, planarXZ: 1, planarYZ: 2, cylindrical: 3, spherical: 4,
  triplanar: 5, cubic: 6, surfaceNormal: 7, outlineWrap: 8,
});
const MODE_OUTLINE_WRAP = 8;

/** A layer's settings over the defaults, with amplitude kept signed from
 *  textureHeight and invertDisplacement the way the app's field sets it. */
export function layerSettings(s = {}) {
  const out = { ...pick(DEFAULTS, LAYER_KEYS), ...pick(s, LAYER_KEYS) };
  if (s.textureHeight != null || s.invertDisplacement != null || s.amplitude == null) {
    out.amplitude = (out.invertDisplacement ? -1 : 1) * Math.abs(out.textureHeight);
  }
  if (out.lockScale && s.scaleV == null && s.scaleU != null) out.scaleV = out.scaleU;
  return out;
}

export function boundsOf(positions) {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < min.x) min.x = x; if (y < min.y) min.y = y; if (z < min.z) min.z = z;
    if (x > max.x) max.x = x; if (y > max.y) max.y = y; if (z > max.z) max.z = z;
  }
  const size = new THREE.Vector3().subVectors(max, min);
  const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
  return { min, max, size, center };
}

/** Non-indexed positions from an indexed mesh. */
export function unindex(positions, indices) {
  const out = new Float32Array(indices.length * 3);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] * 3;
    out[i * 3] = positions[v]; out[i * 3 + 1] = positions[v + 1]; out[i * 3 + 2] = positions[v + 2];
  }
  return out;
}

/** Per-corner paint (1 = painted) from a set of painted vertices of an indexed mesh. */
export function cornerPaintFromVertices(indices, vertexCount, vertices) {
  const on = new Uint8Array(vertexCount);
  for (const v of vertices) if (v < vertexCount) on[v] = 1;
  const paint = new Float32Array(indices.length);
  for (let i = 0; i < indices.length; i++) paint[i] = on[indices[i]];
  return paint;
}

/** A layer's cover (textured share per corner) and fully-masked faces, as
 *  main.js _layerCoverOn reads them off a layer's paint. A face whose three
 *  corners are painted is hard-painted. */
function coverOf(mask, triCount) {
  const include = mask?.mode === 'include';
  const paint = mask?.paint ?? null;
  if (!paint) {
    return include
      ? { cover: new Float32Array(triCount * 3), hardMasked: new Uint8Array(triCount).fill(1) }
      : { cover: null, hardMasked: null };
  }
  if (paint.length !== triCount * 3) throw new Error(`A mask's paint has ${paint.length} values; the mesh has ${triCount * 3} corners.`);
  const cover = new Float32Array(paint.length);
  const hardMasked = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const a = paint[t * 3], b = paint[t * 3 + 1], c = paint[t * 3 + 2];
    const hard = a >= 1 && b >= 1 && c >= 1;
    if (include) {
      cover[t * 3] = a; cover[t * 3 + 1] = b; cover[t * 3 + 2] = c;
      hardMasked[t] = !hard && a === 0 && b === 0 && c === 0 ? 1 : 0;
    } else {
      cover[t * 3] = 1 - a; cover[t * 3 + 1] = 1 - b; cover[t * 3 + 2] = 1 - c;
      hardMasked[t] = hard ? 1 : 0;
    }
  }
  return { cover, hardMasked };
}

/** Per-corner exclusion weights (1 = left plain) for faces excluded outright
 *  and those the angle limits leave plain — main.js buildCombinedFaceWeights. */
function combinedFaceWeights(geometry, excludedFaces, g) {
  const weights = buildFaceWeights(geometry, excludedFaces, false, null);
  if (!(g.bottomAngleLimit > 0 || g.topAngleLimit > 0)) return weights;
  const p = geometry.attributes.position.array;
  for (let t = 0; t < p.length / 9; t++) {
    if (weights[t * 3] > 0.99) continue;
    const i = t * 9;
    const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
    const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const nzn = area > 1e-12 ? nz / area : 0;
    const ang = Math.acos(Math.abs(nzn)) * (180 / Math.PI);
    const masked = nzn < 0 ? (g.bottomAngleLimit > 0 && ang <= g.bottomAngleLimit) : (g.topAngleLimit > 0 && ang <= g.topAngleLimit);
    if (masked) weights[t * 3] = weights[t * 3 + 1] = weights[t * 3 + 2] = 1;
  }
  return weights;
}

/** Every face painted on all three corners or none. */
function isWholeFaces(paint) {
  for (let t = 0; t < paint.length; t += 3) {
    const a = paint[t] >= 1, b = paint[t + 1] >= 1, c = paint[t + 2] >= 1;
    if (a !== b || b !== c) return false;
    if (!a && (paint[t] > 0 || paint[t + 1] > 0 || paint[t + 2] > 0)) return false;
  }
  return true;
}

/** main.js buildCombinedFaceWeights, include-only mode included. */
function combinedWeightsInvertible(geometry, faces, include, s) {
  if (!include) return combinedFaceWeights(geometry, faces, s);
  const weights = buildFaceWeights(geometry, faces, true, null);
  if (!(s.bottomAngleLimit > 0 || s.topAngleLimit > 0)) return weights;
  const masked = combinedFaceWeights(geometry, new Set(), s);
  for (let k = 0; k < weights.length; k++) if (masked[k] > 0.99) weights[k] = 1;
  return weights;
}

function regularizeOpts(g) {
  return {
    aspectThreshold: g.regularizeAspectThreshold,
    slack: g.regularizeSlack,
    aggressiveSlack: g.regularizeAggressiveSlack,
    extremeSliverAspect: g.regularizeExtremeAspect,
    maxNormalDeltaCos: Math.cos(g.regularizeNormalDeg * Math.PI / 180),
    aggressiveNormalDeltaCos: Math.cos(g.regularizeAggressiveNormalDeg * Math.PI / 180),
    preserveExcluded: g.preserveUntextured,
  };
}

const STAGE_SHARE = { subdivide1: [0, 0.3], regularize: [0.3, 0.35], subdivide2: [0.35, 0.45], displace: [0.45, 0.65], decimate: [0.65, 0.92], repair: [0.92, 1] };

/**
 * Texture a mesh.
 *
 * @param {object} input
 * @param {Float32Array} input.positions   non-indexed triangles, mm
 * @param {Array<object>} input.layers     bottom first, each:
 *    image     { data: Uint8ClampedArray RGBA, width, height } — prepared (maps.prepareMap)
 *    settings  the layer's settings (LAYER_KEYS; defaults fill the rest)
 *    mask      { mode: 'exclude'|'include', paint: Float32Array per corner, 1 = painted } | null
 *    blendAdd  add onto the layers below instead of covering them (not for the first)
 *    visible   false leaves the layer out
 * @param {object} [input.settings]        the export's own settings (GLOBAL_KEYS)
 * @param {(stage:string, fraction:number, info?:object) => void} [input.onProgress]
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{positions: Float32Array, normals: Float32Array|null, triangles: number,
 *   warnings: string[], repair: object|null, inputTriangles: number} | null>} null when aborted
 */
export async function textureMesh(input) {
  if (!(input.positions instanceof Float32Array) || input.positions.length % 9 !== 0) throw new Error('positions must be a Float32Array of whole triangles (9 floats each).');
  // The app works on a model centred on its bounding box (stlLoader), and
  // where a tile starts depends on it: centre here too, and put the result
  // back where the input was. Stamp and cylinder positions given in the
  // input's own frame move with it.
  const origin = input.centered === false ? null : boundsOf(input.positions).center;
  const positions = origin ? shifted(input.positions, -origin.x, -origin.y, -origin.z) : input.positions;
  const triCount = positions.length / 9;
  const g = { ...DEFAULTS, ...pick(input.settings || {}, GLOBAL_KEYS) };
  const bounds = boundsOf(positions);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const layers = (input.layers || []).filter((L) => L && L.visible !== false && L.image);
  if (!layers.length) throw new Error('No layer with a texture to apply.');
  if (layers.length > 4) throw new Error('At most 4 layers.');

  let wrap = null;
  const hardFlags = [];
  const out = [];
  for (let i = 0; i < layers.length; i++) {
    const L = layers[i];
    // A layer carries its own settings only: the export's (resolution, budget,
    // angle limits) are the whole run's, from input.settings.
    const s = toWorking(layerSettings({ ...pick(input.settings || {}, LAYER_KEYS), ...pick(L.settings || {}, LAYER_KEYS) }), origin);
    const { data, width, height } = L.image;
    if (!data || !width || !height) throw new Error(`Layer ${i + 1}'s image is empty.`);
    const { cover, hardMasked: hm } = coverOf(L.mask, triCount);
    let hardMasked = hm;
    let stampDepth = null;
    if (isStampActive(s)) {
      const tmax = Math.max(width, height, 1);
      const frame = stampFrame({ ...s, textureAspectU: tmax / width, textureAspectV: tmax / height }, bounds);
      if (frame) {
        frame.depth = buildStampDepth(positions, frame);
        stampDepth = frame.depth;
        const untouched = stampUntouchedFaces(positions, frame);
        if (hardMasked) for (let t = 0; t < untouched.length; t++) untouched[t] |= hardMasked[t];
        hardMasked = untouched;
      }
    }
    if (s.mappingMode === MODE_OUTLINE_WRAP && !wrap) {
      try { wrap = buildOutlineWrap(positions); } catch { wrap = null; }   // falls back to cylindrical, as the app does
    }
    hardFlags.push(hardMasked);
    let exclude = null;
    if (cover) {
      exclude = new Float32Array(cover.length);
      for (let k = 0; k < cover.length; k++) exclude[k] = 1 - cover[k];
    }
    out.push({
      imageData: { data, width, height }, imgWidth: width, imgHeight: height,
      settings: { ...g, ...s, ...(wrap && s.mappingMode === MODE_OUTLINE_WRAP ? { outlineWrap: wrap } : {}) },
      exclude, hardFaces: hardMasked,
      blendAdd: i > 0 && !!L.blendAdd,
      stampDepth,
    });
  }

  // Faces no layer textures: neither refined nor (with preserveUntextured) touched.
  const excluded = new Set();
  if (hardFlags.length && hardFlags.every((h) => h)) {
    for (let t = 0; t < triCount; t++) if (hardFlags.every((h) => h[t])) excluded.add(t);
  }
  const faceWeights = excluded.size || g.bottomAngleLimit > 0 || g.topAngleLimit > 0 ? combinedFaceWeights(geometry, excluded, g) : null;

  // One plain layer — no stamp, a mask of whole faces — goes the app's
  // original single-texture path (main.js _pipelineInputs), which its
  // export takes in that case too, so the result is the app's to the bit.
  const L0 = layers[0];
  const paint0 = L0.mask?.paint ?? null;
  const wholeFaces = !paint0 || isWholeFaces(paint0);
  const single = out.length === 1 && !out[0].stampDepth && wholeFaces;
  let pipelineIn;
  if (single) {
    const include = L0.mask?.mode === 'include';
    const painted = new Set();
    if (paint0) for (let t = 0; t < triCount; t++) if (paint0[t * 3] >= 1) painted.add(t);
    const s0 = out[0].settings;
    const weights = painted.size > 0 || include || s0.bottomAngleLimit > 0 || s0.topAngleLimit > 0
      ? combinedWeightsInvertible(geometry, painted, include, s0) : null;
    pipelineIn = {
      positions, faceWeights: weights, softExclude: null,
      imageData: out[0].imageData, imgWidth: out[0].imgWidth, imgHeight: out[0].imgHeight,
      layers: null, settings: s0,
    };
  } else {
    pipelineIn = {
      positions, faceWeights, softExclude: null,
      imageData: null, imgWidth: 0, imgHeight: 0,
      layers: out, settings: { ...g, ...out[0].settings },
    };
  }

  const signal = input.signal;
  const onProgress = input.onProgress || (() => {});
  const result = await runExportPipeline({
    ...pipelineIn,
    bounds: { min: bounds.min, max: bounds.max, size: bounds.size, center: bounds.center },
    regularizeOpts: regularizeOpts(g),
    mode: 'export',
  }, (stage, p, info) => {
    const [a, b] = STAGE_SHARE[stage] || [0, 1];
    onProgress(stage, a + (b - a) * (p ?? 0), info);
  }, () => !!signal?.aborted);
  geometry.dispose();
  if (!result) return null;
  if (origin) shiftInPlace(result.positions, origin.x, origin.y, origin.z);
  const warnings = [];
  if (result.safetyCapHit) warnings.push('The subdivision hit its safety cap (10 M triangles): the texture is coarser than refineLength asks. Raise refineLength or texture less of the part.');
  if (result.lockedOverBudget) warnings.push('The untextured faces alone exceed maxTriangles, so the budget could not be met with preserveUntextured on.');
  if (result.repairStats && (result.repairStats.open || result.repairStats.nonManifold)) {
    warnings.push(`The output has ${result.repairStats.open} open and ${result.repairStats.nonManifold} non-manifold edges — check it in the slicer.`);
  }
  return {
    positions: result.positions,
    normals: result.normals || null,
    triangles: result.positions.length / 9,
    inputTriangles: triCount,
    warnings,
    repair: result.repairStats || null,
  };
}

function shifted(p, dx, dy, dz) {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) { out[i] = p[i] + dx; out[i + 1] = p[i + 1] + dy; out[i + 2] = p[i + 2] + dz; }
  return out;
}
function shiftInPlace(p, dx, dy, dz) {
  for (let i = 0; i < p.length; i += 3) { p[i] += dx; p[i + 1] += dy; p[i + 2] += dz; }
}
/** A layer's points given in the input's frame (stamp centre, cylinder axis) in the centred one. */
function toWorking(s, o) {
  if (!o) return s;
  const out = { ...s };
  if (out.stampCenterX != null) out.stampCenterX -= o.x;
  if (out.stampCenterY != null) out.stampCenterY -= o.y;
  if (out.stampCenterZ != null) out.stampCenterZ -= o.z;
  if (out.cylinderCenterX != null) out.cylinderCenterX -= o.x;
  if (out.cylinderCenterY != null) out.cylinderCenterY -= o.y;
  return out;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
