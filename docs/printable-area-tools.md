# Printable-area tools: boundary, surface and mesh

Technical reference for the Pen / Bezier boundary, the Brush Mask boundary, the Curved Surface (cylinder)
transformation and the editable mesh. Everything described here is **additive**: no existing configuration,
validator rule, export or D1 table changes, and no migration is needed.

## 1. Three concerns, kept apart

| Concern | Lives in | Space | Changes the production file? |
|---|---|---|---|
| **Printable boundary**: which pixels of the *product photograph* may show artwork | `placement.mask` | fractions of the mockup photo | never |
| **Surface transformation**: how the flat artwork is bent onto the photographed object | `placement.surface` (cylinder), `placement.mesh` | the placement's own frame (`0..1` across its rectangle or perspective quad) | never |
| **Production artwork**: the customer's design | `area.canvas`, `area.shape`, layers | canvas pixels | it *is* the production file |

```
flat artwork (u, v)  --surface-->  frame-local (x, y)  --placement frame-->  photo pixels  --boundary-->  visible pixels
 production canvas     cylinder | mesh | identity      rotated rect | perspective quad      Bezier path | alpha mask
```

* The boundary is applied **after** the warp, in photo space. A boundary drawn on the photograph is never
  interpreted as a flat artwork-space mask (`util/draw.ts`, `drawWarped`; pinned by the browser test
  "clips the WARPED picture").
* `PrintableArea.shape` (rectangle, ellipse, SVG path) is still the *production* mask, in canvas pixels. Combining
  it with a surface works: the shape clips the flat artwork first, then the surface bends the clipped result.
* A curved bottle label therefore stays a flat rectangle in the production PNG. "Use outline as production shape"
  (inspector) is the opt-in for stickers and patches whose printed file should have the outline's shape too.

## 2. Data model

```ts
interface AreaPlacement {            // existing fields unchanged ...
  mask?: PlacementMask;              // printable boundary on the photo
  surface?: CylinderSurface;         // cylindrical wrap, evaluated inside the placement frame
  mesh?: MeshSpec;                   // free mesh, evaluated inside the placement frame; overrides `surface`
}

type PlacementMask =
  | { type: 'path'; path: BezierPath }
  | { type: 'raster'; src: string; width: number; height: number };

interface BezierPath { version: 1; fillRule: 'nonzero' | 'evenodd'; contours: { anchors: BezierAnchor[] }[] }
interface BezierAnchor { x: number; y: number; handleIn?: [x, y]; handleOut?: [x, y]; smooth?: boolean }   // absolute positions, photo fractions

interface CylinderSurface { type: 'cylinder'; curvature: number; centre: number; visibleLeft: number; visibleRight: number; tilt: number }
interface MeshSpec { cols: number; rows: number; points: number[] }   // row-major [x0, y0, x1, y1, ...], placement-frame fractions
```

Types: `src/app/customizer/models/product.models.ts` (also in the shipped `.d.ts`, checked by `tests/types/consumer.ts`).
JSON Schema: `public/schema/product-config.schema.json` (`placementMask`, `bezierPath`, `cylinderSurface`, `meshSpec`).
Runtime validation: `util/product-validator.ts` (`validateMask`, `validateBezierPath`, `validateSurface`, `validateMesh`).

### Limits and validation (rejected, never repaired)

* Path: version `1`; 1..16 contours; 3..256 anchors per contour and at most 1024 in total; every coordinate and handle
  finite and within `-1..2`; a contour must be *non-degenerate* (its anchors may not coincide or lie on one line:
  judged by thickness, not by signed area, because a bow-tie's lobes cancel).
* **Self-intersecting contours are accepted.** The fill rule gives them a well-defined inside (`nonzero`: a hole must be wound
  the opposite way, the centre of a pentagram is filled; `evenodd`: nested parts are holes, the pentagram's centre is
  empty). The editor shows a notice naming the rule in use. Behaviour is pinned in `bezier.spec.ts`.
* Raster mask: `src` goes through the normal asset URL policy; `width` / `height` integers `1..4096`.
* Cylinder: `curvature 0..360`, `centre -180..180`, `visibleLeft/Right 1..90`, `tilt -60..60`, all required.
* Mesh: `cols`, `rows` integers `2..12`; exactly `cols*rows*2` finite numbers in `-1..2`; a mesh that **folds** (any
  tessellated triangle flips orientation or collapses) is invalid. The editor refuses a drag that would fold it, so a saved
  mesh is always valid; an imported one is rejected by the validator.

### Compatibility

* All three fields are optional and omitted when unused, so old configurations validate and serialize exactly as before.
  Rendering of placements without them goes through the original code path untouched: the three shipped sample products
  render **pixel-identically** in a build of the previous commit and in this one (A/B check, section 8).
* A perspective quad may carry a `surface` or `mesh` (the cylinder is then seen in perspective).
* `placement.mesh` is relative to the placement frame, so moving, resizing, rotating or re-cornering the placement carries it along;
  `placement.mask` is in photo space and deliberately does **not** move with the placement (it is a property of the photograph).
  Duplicating an area translates a Bezier boundary with its copy; a raster boundary cannot be translated, so its copy is not nudged.
* Markups (the reusable area / artwork library) have never contained placements ("a markup area is inserted unplaced"), so photo-specific
  geometry (`mask`, `surface`, `mesh`) is intentionally not part of a markup. A Bezier outline *used as production shape* lives in
  `area.shape` and is therefore carried.

## 3. The cylinder mapping (exact definition)

Frame: the placement's rectangle, `(0,0)` top-left to `(1,1)` bottom-right (rotation applied afterwards, about the rectangle centre,
in pixel space). The rectangle **bounds the visible part of the artwork**, so the merchant draws it around what the shopper can see.

For artwork fraction `u` (left to right) the angle on the cylinder, measured from the camera-facing meridian, is

```
phi(u) = centre + (u - 0.5) * curvature            (degrees; curvature = angle the WHOLE artwork spans, 0 = flat)
visible  <=>  -visibleLeft <= phi <= visibleRight
phiStart = max(centre - curvature/2, -visibleLeft),  phiEnd = min(centre + curvature/2, visibleRight)
x(u) = (sin phi(u) - sin phiStart) / (sin phiEnd - sin phiStart)               orthographic projection onto the box
y(u, v) = v + (1/extent) * sin(tilt) * (cos phi(u) - 1) * aspect               extent = sin phiEnd - sin phiStart,
                                                                               aspect = frame width / frame height in pixels
```

* `curvature -> 0` tends to the identity (flat). Compression towards the sides follows `cos(phi)`: at 60 degrees off-axis the artwork
  is drawn at half its centre scale (tested to 3 decimals).
* `tilt` is the camera elevation: horizontal rows bow like the ellipses of a cylinder seen from above (positive looks down: the sides sit
  higher). Vertical scale is the placement height; orientation is the placement rotation plus `tilt` and `centre`.
* Artwork outside the visible range is clipped (occlusion by the object itself); nothing is drawn if none is visible.
* The mapping is deterministic, independent of the artwork's pixels and of the viewport. `util/surface.ts` has the forward map, its inverse
  (`cylinderInverseU`) and the frame transforms (`placementFrame`, rotated rectangle or perspective quad, with inverses).
* It does **not** model lighting, depth, refraction or highlights. Keep glass, shadows and highlights in the existing mockup **overlays**
  (drawn above the artwork) or the photo itself.

## 4. The mesh

A `cols x rows` grid of control points in the placement frame. The surface is a uniform **Catmull-Rom** patch *through* the control points
(linearly extrapolated at the borders): dragging a point moves exactly that point of the artwork, edges can be curved and the deformation is
smooth and non-uniform. With 2 x 2 points it is the identity. "Edit mesh" samples the current surface (flat or cylinder) onto the grid, so a mesh
starts as exactly what the merchant was looking at; changing the density resamples without changing the shape; "Reset points" re-samples from the
base, "Reset mesh" removes it.

**Fold detection** (`meshFolds`): the surface is tessellated (4 x 4 per control cell) and every triangle must keep the orientation of the unfolded
artwork with an area above `1e-7` frame units squared. A drag that would violate this is refused with a visible message; the validator applies the
same rule.

## 5. Rendering

One implementation serves the editor stage, the customer preview and every export: `drawComposite` -> `drawPlaced` (`util/draw.ts`).
Placements with neither boundary nor surface take the original code path. Others go through `drawWarped`:

1. build the warp grid in photo space (`buildWarpGrid`: cylinder strips or a tessellated mesh, mapped through the frame);
2. rasterize the artwork into a transparent layer (`util/warp.ts`);
3. clip the layer: a Bezier boundary is filled with `destination-in` using its fill rule (anti-aliased), a raster boundary is drawn with
   `destination-in` (the **alpha channel multiplies**, so partially transparent pixels stay partially transparent);
4. draw the layer with the placement's opacity and blend mode.

A raster boundary whose image has not loaded hides the area (artwork is never shown unclipped); a boundary that fails to load is an
`asset-error` like any other image.

### Why a software rasterizer instead of extending the existing triangle drawing

Measured in Chrome (headless 157) on a 50 %-transparent source warped by a 10 x 10 triangle grid: the existing perspective approach
(`drawImage` per triangle with an anti-aliased clip) gives alpha 93..130 where triangles meet (seams) without overlap, and with the 1 px
overlap it uses to hide them **alpha up to 252 instead of 128 on about 40 % of the interior** (double blending); `copy` compositing still
dipped to 80. The new rasterizer covers every output sample by exactly one triangle (edge functions are evaluated with bit-identical
coefficients for shared edges, ties follow the top-left rule), so there are no seams, no gaps and no double blending, and 50 % artwork stays
exactly 50 % (`warp.spec.ts`, no browser needed). Sampling is bilinear and alpha-weighted; `final` quality supersamples 2 x 2 (box filter) for
anti-aliased silhouettes. **The existing four-corner perspective drawing was left byte-identical** so old previews cannot change; it still has the
double-blend artefact on semi-transparent artwork. (Finding for the owners; not changed here.)

### Quality, caching and cost

* `draft` (a handle or the brush is being dragged): one sample per pixel and the layer is capped at 300 k pixels. `final`: 2 x 2 supersampling up to 600 k
  layer pixels (above that, 1 sample), layers capped at 4 M pixels and scaled up when drawn.
* `WarpCache` (per preview / stage) keeps each area's warped layer and the source pixels it was read from; it is reused while the placement object,
  the mask image, the artwork canvas version and the target size are unchanged, so panning, zooming steps, and editing another area do not re-warp.
* Measured on the development machine (headless Chrome, no GPU; `scratchpad` benchmark, not part of the suite): the rasterizer does about
  8 M output pixels per second at 1 sample: 400 x 300: 13 ms, 800 x 600: 33 ms, 1200 x 900: 70 ms (210 ms with 2 x 2). In the editor
  (1400 x 900 stage) dragging a mesh point held 16.7 ms frame intervals (p95 16.8 ms, one 33 ms frame in 64) and scrubbing the curvature slider
  (a full re-render per step) dropped none. **A low-end mobile profile was not measured.**
* Exports (`renderPreview`, `customizer-save`): no cache, `final` quality, the same code. `renderAreaArtwork` (the production PNG) never touches any of it.

## 6. Boundaries

### Bezier (Pen)
Editable, versioned cubic Bezier contours; closed; multiple contours (holes) with an explicit fill rule. Immutable edit operations in
`editor/util/bezier-edit.ts` (insert by de Casteljau split, remove, corner <-> smooth, handle moves that keep a smooth anchor collinear,
translate, reverse winding for holes); hit testing converts to pixels first so tolerances are in screen pixels at any zoom.

### Raster (Brush)
**Representation and trade-offs.** The mask is an alpha channel at the photo's resolution (down to 4096 px on the long edge).

| | Lossless raster alpha PNG (chosen) | Stroke history | Vectorized trace |
|---|---|---|---|
| Fidelity | exact, soft edges and partial alpha kept | exact only if the brush engine is replayed identically | loses soft edges and detail |
| Load cost | one image decode (the normal pipeline) | replay every stroke, cost grows with editing | cheap |
| Renderer needs | `destination-in` with the image | the brush engine in the storefront bundle | a path fill |
| Storage | an ordinary asset, a few KB..100 KB for typical masks | JSON that grows; order-dependent with erase | small JSON |
| Edit later | repaint | undo-able in principle | awkward |

A raster alpha mask is the only option that is exact, needs nothing new in the storefront and reuses the asset infrastructure. Vectorization
is not offered (an outline can already be traced with the Pen); a painted *outline* can be loaded into the brush and refined ("Paint mask" on an area with a
Bezier boundary rasterizes it first).

**Storage.** The mask is **never** inline base64 and never in D1: the config holds `mask.src` (an asset reference) like a mockup image. Each finished
stroke encodes a PNG, stores it (IndexedDB `idb:` locally; in cloud mode the existing asset sync uploads it when the draft is saved) and
updates `mask.src` — one undo step per stroke. Because the field is named `src`, the **Worker needs no change**: asset adoption, the
`status`/ownership checks, "cannot delete an asset a configuration references", deletion with the configuration, the storefront URL rewrite and public
serving all work (`worker-api/test/placement-geometry.test.ts`, including another store's asset never being served). Superseded masks of a
local editing session stay in IndexedDB until the template is deleted (bounded by the number of strokes); in cloud mode only the saved reference is uploaded.

**Zoom.** The brush diameter is in *photo pixels*; the on-screen circle is `diameter * zoom`. A stroke is the same size at every zoom (tested).

## 7. Editor

Add area: Rectangle, Circle / ellipse, Custom shape, **Pen / Bezier**, **Brush mask**, **Curved surface** (the last draws a rectangle, then the
curve is tuned in the inspector). Selecting an area with a placement shows *Printable boundary on the photo* and *Surface* in the inspector;
an active Pen / Brush tool shows its panel at the top of the inspector.

| Tool | Pointer | Keyboard |
|---|---|---|
| Pen, creating | click = corner, click-drag = smooth point, click the first point = close | `Enter` close, `Backspace` remove last, `Esc` cancel |
| Pen, editing | drag points / handles, click an edge = insert, double-click = corner/smooth, `Alt`+click = remove, drag inside = move path | `[` `]` pick a point, arrows nudge (`Shift` x10), `Delete` remove, `Esc` done; numeric X/Y + "Smooth point" in the inspector |
| Brush | drag to paint (add or erase), `[` `]` size, `X` add/erase | `Esc` done; size, hardness, clear, fit-placement in the panel |
| Edit mesh | drag points (refused if it would fold) | `[` `]` pick, arrows nudge, `Esc` done; columns, rows, X/Y %, reset in the inspector |

Every pointer drag has a keyboard or numeric alternative; every action is one undo step (drags coalesce); anchors, handles and the brush
outline keep a constant on-screen size; hints are announced as a status and shown at the bottom of the stage. Admin strings exist in
English, French and Arabic. Verified with axe-core (WCAG 2.2 AA + best practice) at 1280 and 360 px with the dialog and every tool active.

Interactive tools live in `editor/tools/` (`pen-tool`, `brush-tool`, `mesh-tool`; the stage forwards pointer events), all in the lazy editor chunk.
The storefront only gets the evaluation and rendering code (`bezier`, `surface`, `warp`, `draw`): its initial download is unchanged at 279 kB
(budget: warn 440, error 700) because the preview code is in the lazy chunk; the admin initial download is 614 kB (budget 1400 / 2000). No library was added.

## 8. Tests and how they were run

* Unit (`npm run test:ci`): `bezier`, `bezier-edit`, `surface`, `warp` (pixel-exact: identity, 50 % alpha uniformity, no gaps, supersampled colour, cylinder closed form),
  `mockup-geometry-validator`, `product-schema` (the JSON schema and the runtime validator reject the same mistakes).
* Browser (`npm run test:browser`, real Chrome): `mockup-geometry.spec.ts` (flat unchanged; cylinder against the closed form; boundary clips the *warped* picture;
  raster alpha; missing mask; mesh; production file flat while the preview is warped; supplement-jar and angled spray-bottle fixtures from
  `scripts/generate-surface-fixtures.mjs`) and `geometry-editor.spec.ts` (every tool through the real admin element, persistence read back from IndexedDB, undo/redo,
  zoom-independent brush size, soft brush alpha, reopen, publish, axe).
* Worker: `placement-geometry.test.ts` (verbatim round trip through save / publish / storefront, raster-mask adoption, delete protection, tenant isolation).
* Compatibility: `dist` of the previous commit and of this one render `heart-clock` (quad + path shape), `tshirt` and `bottle` to identical pixels.

## 9. Known limitations

* Orthographic cylinder only: no perspective foreshortening along the axis except through a quad frame, no cones, no lighting or depth.
* Raster masks are stretched over the whole photo; a mask whose aspect differs from the photo's is stretched, not rejected.
* Editing history of a raster mask keeps intermediate PNGs in the local library (see above).
* The existing perspective renderer's semi-transparent double blend (section 5) is untouched.
* Not verified: Safari / Firefox, touch input on the stage, a low-end mobile profile, a deployed Worker / real R2 or S3 for mask uploads (the Worker path is tested
  with the local Miniflare D1 and in-memory storage only).
