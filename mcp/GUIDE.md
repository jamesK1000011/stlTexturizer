<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Texturing a part with BumpMesh

These tools drive BumpMesh — CNC Kitchen's tool that gives a 3D-print mesh a
real surface texture (the mesh is displaced, not painted). The page is served
by this server and shows every step to the person at the screen.
`bumpmesh_texture_file` runs the same engine with no page at all.

If the part comes out of ScanRuler (a scan or a rebuilt model), its Texture
workspace does the same with ScanRuler's regions for where the texture goes —
prefer it when the surfaces to keep are easier to find there.

Workflow:

1. `bumpmesh_open`, `bumpmesh_load_model { path }`, `bumpmesh_status` — the part's bounds.
2. Name the surfaces that must not change; say them back to the person.
3. Pick a texture, depth and tile size the printer can make.
4. `bumpmesh_mask` where it goes; `bumpmesh_render` to look.
5. `bumpmesh_preview { enabled: true }` and render it; adjust.
6. `bumpmesh_export { path }`; report what was textured, with what, and the file.

## Coordinates

Every coordinate the tools take or give is mm in the model file's own frame
— what `bumpmesh_status` reports as the bounds. Z is up for the cylindrical
and planar mappings, the angle limits and facing directions: if the part lies
on its side in the file, say so and texture it as it lies, or rotate it in
the page first.

## Surfaces that must not change

Before texturing, name the surfaces that must stay as they are — mating
faces, press-fits, a cutout another part slides into, a button, threads, a
datum face — and say them back. A texture on any of them changes the fit.
When the person has called one the master fit, it is never textured.

- `bumpmesh_mask { mode: "include", … }` paints only the panels to texture;
  the rest stays plain. Safest when the textured area is small (a grip).
- `bumpmesh_mask { mode: "exclude", … }` paints the surfaces to keep plain;
  the rest is textured. Switching mode clears the paint.
- Paint by `near` (a point: flood-fills the smooth surface round it, stopping
  at edges sharper than spreadDeg), `normal` + `withinDeg` (every face facing
  that way), and/or `box`. `erase: true` takes paint off.
- Keep `preserveUntextured: true` (the default): plain faces then come out
  exactly as they went in.
- `boundaryFalloff` (0.5–1 mm) ramps the texture in at a painted edge instead
  of starting at full depth against it.
- Look before exporting: `bumpmesh_render` shows the paint in orange.

## Depth and tile size

Starting points for FDM with a 0.4 mm nozzle (ask what they print with):

- **textureHeight** 0.3–0.6 mm for a stipple or fine finish, 0.5–1.0 for a
  grip or knurl. Under ~0.2 mm it is lost in the layer lines.
- **scaleU** (tile, mm): the smallest feature in a tile at least ~0.8 mm
  across. Diamond knurl pitch 1.5–3 mm; stipple tile 5–15 mm.
- **Which way**: outward (default) adds material — the part grows by the
  depth. `invertDisplacement` pushes it in, keeping the outside size (a part
  that must fit a holster or case) but thinning the wall by the depth: keep
  1.2 mm or more under it. `symmetricDisplacement` keeps the mean size.
- Keep `bottomAngleLimit` (5°) so the bed face stays flat; deep texture on
  downward faces prints poorly.

## Textures

`bumpmesh_list_textures`: grip (Knurling, Grip Surface, Isogrid), mold
(Fine Stipple, Haircell, Hammered, Fine Leather — moulded-part finishes),
geometric, patterns, organic, fabric, natural. Your own: `bumpmesh_set_texture
{ imagePath }` — white high, black low.

## Mapping

- 5 triplanar (default): from the three axes, blended — most parts.
- 3 cylindrical: wrapped round Z — handles, grips, knobs; the tile is rounded
  to wrap seamlessly. 8 outline wrap: follows a non-round outline round Z.
- 6 cubic: boxy parts. 0/1/2 planar XY/XZ/YZ: one face.

## Stamps

A logo or label once: `stampOnce: true`, `stampCenterX/Y/Z` (model mm),
`scaleU`/`scaleV` its size, a planar mode along the axis it faces (YZ along
X, XZ along Y, XY along Z) and `stampSide` 1 or -1 for which side — or
mapping 7 (surface normal) with `stampNormalX/Y/Z` for a curved face. Use a
second layer (`bumpmesh_layer { action: "add" }`) to stamp over a texture —
and give that layer the whole part with `bumpmesh_mask { mode: "exclude",
action: "clear" }`: a new layer covers nothing until it is painted. Render
from that side to see it (`bumpmesh_render { view: "right" }` for +X).

## Budget and export

- `refineLength` is the resolution (the part's diagonal / 250 by default);
  at most a quarter of the tile's smallest feature. `maxTriangles` is the
  budget: past it the mesh is decimated coarser. 1–3 M is fine for slicers.
- `bumpmesh_export` takes seconds to minutes; `bumpmesh_status` reports its
  progress, `bumpmesh_cancel` stops it.
- Report: the texture, depth, tile, which surfaces were kept plain, the file
  and its triangle count, and any warning the export gave.

## Traps

- Outward texture makes the part bigger by its depth where it is.
- A raw scan's noise is textured too — smooth it first.
- Mask paint is per model: loading another model clears it.
