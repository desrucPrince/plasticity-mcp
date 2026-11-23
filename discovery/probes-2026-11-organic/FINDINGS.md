# FINDINGS: organic-surfacing tool gaps (2026-11-23, Plasticity 26.1.3, isolated instance)

Driven by the LearnPlasticity "Organic Shapes (Indie)" tutorial rebuild. Scripts here; class sources are obfuscated
(`String(class)` returns zero-width filler), so every finding is from fields, enums and live commits.

| Gap | Native entry point | Result | Tool change |
|---|---|---|---|
| Indie Patch continuity | `PatchHoleInSheetFactory`: `sheet`, `edges`, `curves`, `guides`, `continuity`, `setContinuityForEdge`, `topology` (pk `FillHoleTopologyType` Multiple/Minimal/Single), `internalSmoothness` (pk `FillHoleInternalSmoothnessType` Sharp/Smooth), `tolerance` | open cylinder top: G0 90 deg, G1 0 deg (dome to z 50), G2 0.04 deg (z 64.5); sheet edge + bridge curve patch lands as a face of the same Sheet | `plasticity_patch_sheet_hole` continuity, edgeContinuity, curveIds, guideIds, faces, smoothness |
| Bridge tension / flip / parameter | `BridgeCurveFactory`: `tensions1`/`tensions2` = [G1, G2] metres (empty = 0), `sense1`/`sense2`, `t1`/`t2` normalized | tension +10 mm: 67.6 → 80.3 mm; flip reversed; t 0.5 started mid-line | `plasticity_bridge_curves` per-end parameter, flip, tensionG1Mm, tensionG2Mm |
| Edge bridge tension | `BridgeEdgeFactory`: same tensions; `side1`/`side2` pick the other vertex (not direction) | tension +15 / −10 mm changed bulge 43.75 → 67.2 / 28.1 mm | `plasticity_bridge_shell_edges` tensionG1Mm, tensionG2Mm |
| Isoparam position | `IsoparamFactory.paramPoint` (default 0.5) | 0.2 split a 40 mm face at 8 mm in u and v | `plasticity_insert_isoparam_edges` parameter (count 1) |
| Loft end continuity | `CurveLoftFactory.profiles` accepts boundary edges; `LoftCurvatureType` Natural/Unconstrained/Clamped | joined read-back G0 26.6 deg / G1 / G2 | `plasticity_loft_curves` profiles mixing `{wireId}` and `{bodyId, edgeId}` |

Not built in phase A: splitting a Sheet edge at a point, a one-body surface bridge, and a generic command runner
(`PLASTICITY_CDP_URL` already points the server at any isolated port). Phase B (below) built the first two.

- Continuity is applied per neighbouring face (phase A note): wrong, see phase B. G0 is only a minimum: native may
  come back tangent on a G0 edge where a smooth fill allows it, whatever the neighbour faces.

## Indie Patch continuity: what makes G1 succeed (tutorial rebuild, 2026-11-23)
- (Corrected in phase B.) Two arcs of one cylinder rim (one wall face) both read back G1 when only one was asked
  G1 (`patchmap.ts` shows the factory map itself is per edge and correct). The cause is not the shared face: see
  phase B.
- G1/G2 fails (FillHole errors 22092/22093/22094) when the corner geometry cannot be satisfied. The corner
  tangent-plane part of this was refined by the pre-check runs below: only the angle budget and the edge count
  hold for the default options. Original note: at each corner the faces asked G1 must share one tangent plane
  that contains both boundary edges, and the face angles meeting at a vertex of a smooth region must add up to
  360 deg. Example: four faces tangent to x = 35 at one vertex with
  angles 90 + 180 + 180 + 90 = 540 deg made every G1 rear patch fail; swapping which curve continues which edge
  fixed the budget. A flank guide 7 deg out of the head's tangent plane likewise failed until it was re-lofted.
- Looser `toleranceMm` did not rescue any of these failures; it is exposed for the dialog's Tolerance field.
- A G2 patch can come out with a degenerate parameterisation (degree 5, one span in v); `plasticity_rebuild_face`
  turns it into a regular B-Surface before it is used as a G1 neighbour or loft profile face.

## Indie Patch pre-check: what decides 22092 / 22093 / 22094 (organic-tools-2, 2026-11-23, 26.1.3, isolated)
Scripts: `evalfile.ts` runs a read-only JS file from `js/` (`js/boundary.js` is the probe version of
`PATCH_BOUNDARY_SOURCE` in src/plasticity/surfacing.ts; `js/defaults.js` reads the factory defaults). Scenes were
built with the MCP tools (extruded polygons and polylines, an open box, a wall plus a curve) and the tutorial
checkpoints `attempt1-E` / `attempt2-E` (copies; the rear hole is the 7- or 8-edge loop at y 60).

| Case (G1 unless noted, default options: faces multiple, smoothness sharp) | Native |
|---|---|
| open cylinder top (one closed edge) | OK |
| open box, 4 walls (corner normals 90 deg apart) | OK: a dome, rim edges G1, 4 creases run from the corners (about 89 deg) |
| regular n-gon prism top: n = 6, 12, 14, 16, 18, 20 | OK |
| n = 21, 22, 24, 50; n = 24 also at R 100 mm and with faces single or minimal or smoothness smooth | 22093 |
| n = 90, 180, 256 (corner kinks 4, 2, 1.4 deg) | 22094 |
| n = 24 with only 1, 4, 20 or 21 edges G1, rest G0 | 22093 |
| n = 180 at G0 | OK |
| star 10 (20 edges) / star 11 (22 edges) | OK / 22093 |
| lens 10 / lens 11 segments per side (20 / 22 edges) | OK / 22093 |
| filleted 8- and 10-gon (16 / 20 edges, tangent joins) / filleted 11-gon (22 edges) | OK / 22094 |
| n = 12 and n = 20 at G2 / n = 21 and 24 at G2 | OK / 22094 |
| rectangle with one or four kinks (0.02 to 25 deg) | OK |
| open box or kink box with faces: single, or smoothness: smooth | 22093 (kinks of 0.02 deg too, beside the box corners) |
| kink box with faces: minimal | OK |
| rectangle with its four corners filleted (R 4) and one kink of 3 or 10 deg, default options | OK (pre-check: 360 deg at all eight fillet joints, kink reported) |
| the same with faces: single (the kink is the only crease) | 22094 at 3 deg, 22093 at 10 deg (pre-check refuses both) |
| filleted 8-gon (corner normals agree) with faces single / smoothness smooth | OK |
| one wall edge plus a control-point curve leaving the corner 0, 2, 7, 30 or 90 deg out of the wall's tangent plane | OK |
| attempt1-E rear: G1 on bowl rim and both necks, or on any one of them, G0 base | 22094 |
| attempt1-E rear after `plasticity_rebuild_face` on the bowl and both side faces | 22092 |
| attempt2-E rear (curves swapped): G1 bowl and necks / G2 | OK / 22094 |
| factory defaults (read, no commit) | continuity G0 (23156), tolerance 1e-5 m |

What this means (the rules in `checkPatchBoundary`):
- **Edge count.** More than 20 boundary edges fail as soon as any edge asks G1 or G2, whatever the corner angles
  (stars and lenses have sharp corners; filleted loops have none). Every tested loop had one neighbour face per
  edge and no curve items, so the pre-check blocks only when there are more than 20 edges on more than 20 faces
  and reports otherwise.
- **Corner normals.** A corner whose two neighbour faces do not share a tangent plane does not fail with the default
  options: native creases the patch from that corner. It fails (22093) only when `faces: "single"` or
  `smoothness: "smooth"` forbids the crease. The earlier note that the G1 faces must share a tangent plane at
  every corner holds only for those options. A curve leaving a G1 edge out of its face's tangent plane also passed
  (0 to 90 deg), so that is not checked.
- **Angle budget.** At the attempt1-E head-back corner (35, 8, 70.1) the bowl, side and head faces all have normal
  +x (within 0.1 deg) and interior angles 180 + 180.2 + 90 = 450.2 deg before the patch; the patch corner measured
  on the side away from the bowl is 269.8 deg, so the sum is 720 deg (the build report counted the patch corner as
  90 deg and wrote 540; both are not 360). At the same corner of attempt2-E the faces read 90 + 90 + 90 and the
  patch 90: 360 deg, and the same G1 request passed. Rebuilding the neighbour faces did not rescue attempt1-E,
  so the budget, not a degenerate neighbour parameterisation, is the cause there.
- **Codes.** None is decoded. 22093 went with the edge count at G1 on kinked loops and with forbidden creases (22094 for a lone 3 deg crease);
  22094 with the edge count at G2 or on nearly smooth loops, with the broken angle budget, and with G2 on the
  attempt2-E rear whose G1 passed (no pre-check rule explains that one); 22092 appeared once, on attempt1-E after
  its neighbour faces were rebuilt.
- **Interior angle at a vertex.** Measured in the face: step 0.5 mm (at most 5 %) along one of its edges, then
  0.01 mm either way across the edge; the step that lands on the trimmed face (`Eval.DistancesToPoints` about 0)
  is inside. `Face.FindPointNear` clamps to the trimmed face, so projecting first cannot tell inside from outside.
  The kernel's edge tangent follows the curve, which can run against the edge (mirrored edges), so each end's
  tangent is oriented by a step inside the edge.

## Phase B: split sheet edge, one-body bridge, per-edge continuity (organic-tools-2, 2026-11-23, 26.1.3, isolated)
Scripts: `mutfile.ts` runs a mutating JS file (`js/split-edge-seg.js`, `js/bridge-same.js`, `js/patch-intercept.js`);
`evalfile.ts` runs read-only ones (`js/kernel-split.js`, `js/bridge-names.js`, `js/fill-names.js`, `js/fho.js`,
`js/face-methods.js`, `js/vertex-uv.js`, `js/edge-near.js`). Scenes were built with the MCP tools.

| Gap | Native entry point | Result | Tool change |
|---|---|---|---|
| Split a Sheet/Solid edge | `SplitSegmentFactory.edge` takes a `ShellEdge`; `_edge.model` is the kernel `Edge`, whose `SplitAt(t)` the factory calls (proxied, as for Wire segments) | rectangle Sheet edge 40 mm at t 0.3: vertex at 12 mm from the edge start (`GetPointAndTangent(0)`), 1e-12 mm off, one Undo step, 1 face, 4 to 5 edges; box Solid edge: valid Solid, 13 edges; a vertex-less cylinder rim (ring) gets one vertex and stays one closed edge, a second split makes two arcs | `plasticity_split_sheet_edge` |
| One-body surface bridge | `BridgeSurfaceWithPreviewFactory` with two faces of one Sheet (`originalItems` = that Sheet) | trapezoid channel, wall tops, width 30: one 4-face Sheet, both joins G2 (1.2e-6 deg). The two-Sheet limit was only in the tool | `plasticity_bridge_sheet_edges` |
| Per-edge continuity | `PatchHoleInSheetFactory` calls kernel `SheetBody.FillHole_async(edges, FillHoleOptions)` | G0 is a minimum; no crease on request: see below | pre-check `mixed-continuity` (report only) |

Also found: kernel `Operation.SplitEdges(_async)` (edge ids + normalized parameters; the 26.2 vertex offset uses it),
`Edge.FindPointNear(p)` returns `{ t, exact }` with t normalized from `GetPointAndTangent(0)`, `Face.FindPointNear`
returns normalized face `u, v`, and `IsoparamFactory.paramPoint` with `uOrV` true cuts at that normalized u (on the
cylinder wall u is the angle: 0.75 put the seam through the vertex at (0, -20, 40)).

**Edge split.** The normalized edge parameter is not an arc-length fraction in general, so the tool bisects the
carrier length (`curve.GetLength` between `Denormalize(0)` and `Denormalize(t)`) for `normalizedParameter`, and
projects `pointMm` with `Edge.FindPointNear`. Kernel length reads of a near-zero interval throw
(`PK_ERROR_curve_too_short` 1057, `PK_ERROR_zero_interval` 5028); they are read as 0 and the 0.01 mm minimum piece
refuses the split.

**Surface bridge.** It is a G2 face blend (`PK_FACE_make_blend`), like a fillet between the two faces' surfaces:
`width` is the distance between its two contact lines (reference case: a floor and a wall at 90 deg, width 20, contact
lines 14.14 mm from the corner on each face), it lies on the side both normals point to, and `trimWalls` trims both
faces back. Failures, all the same with two separate Sheets:
- 17453: trapezoid walls at width 10 or 20 (contact lines above the wall tops); U channel with parallel walls.
- 1080 `PK_ERROR_fxf_blend_failed`: floor + back wall + side wall in one Sheet (the blend runs into the back wall);
  17452 for the same with the side wall unjoined into its own Sheet, so unjoin, bridge, re-join is no composite.
- `trimWalls: false` commits the blend as a separate Sheet (1 face) with the faces untrimmed: not a join.

**Per-edge continuity (native cannot force a G0 crease).** Intercepting the factory's kernel call (a Proxy on `factory._sheet.model`;
the embind prototypes are not configurable) shows what it sends: `Smoothness` is always G2 (23154), edges asked G0
go in `EdgesG0`, G1 in `EdgesG1`, G2 in neither (continuity unset: all in `EdgesG0`). So the per-edge request
reaches the kernel. Results (cylinder R 20 rim split into two arcs A, B on the one wall face; open box 40 x 40 x 20):

| Case | A / B (box: x0 / others) |
|---|---|
| factory, A G1, B G0 | G1 0.028 deg / G1 0.028 deg |
| same, wall split into two faces by isoparams through both arc vertices (each arc its own neighbour) | G1 / G1 |
| factory, A G2, B G0 | G2 / G2 |
| kernel `Smoothness` forced G1, lists kept | G1 / G1 |
| kernel `Smoothness` forced G0, lists kept | the patch is the tangent hemisphere (Sphere R 20 about (0, 0, 40); probe rays hit z 46.245 at x 19 and z 60 on the axis), so G1 on the whole rim. The continuity sampler reads edge B on that Sphere face as class none with a 40 mm position deviation (the sphere's diameter) on a native-valid Solid: a sampler misread, phase A follow-up |
| open box, x0 G1, others G0 (factory; also with Smoothness forced G0 or G1) | G1 on all four rim edges, 0 deg |
| attempt2-E rear closure (copy), G1 bowl and necks, G0 base | G1 edges G1 (one reads G0 only at a corner sample, interior G1); the four G0 base edges G0, interior 57 to 70 deg |

So G0 is a minimum, not a crease request: the kernel keeps every G1/G2 request and comes back tangent on a G0 edge
where a smooth fill allows it (box, cylinder), and G0 where it does not (rear closure). Splitting the neighbour faces
changes nothing (the spec's `splitSharedNeighbours` composite would not help, so it was not built), and no factory or
kernel option tried forces a crease. The pre-check reports `mixed-continuity` (not blocking) with this;
`plasticity_patch_sheet_hole` defaults are unchanged.

## Phase A review fixes (organic-tools-2 phase B addendum)
- R1: the more-than-20-edges rule reports, never refuses (evidence: prisms, stars and lenses only).
- R2/R4: Wire junctions take the curvature sample by end (first at the start, last at the end; the list is read
  as reversed only when the segment's own t 0.01 point says so) and orient the kernel end tangents by the
  segment's points at t 0.01 and 0.99. Live after the fix (`work-p2b/wires-final.txt`): polyline corner G0 90 deg,
  filleted corner two G1 (0 / 0.2 per mm), S curve split at 0.4 one G2 junction and 1 inflection, closed periodic
  plane curve G2. Plasticity stores a control-point curve that starts and ends at one point as two segments, so a
  kinked closed single segment could not be made live; the unit test covers it.
- R3: an angle within 2 deg of 0 or 360 at a vertex makes the angle budget indeterminate (reported), not a refusal.
- R5: interior maxima are clamped to the overall maxima, relative curvature to 1.
- R6: a closed plane curve needs three points.

## Phase C: friction fixes from the product build (organic-tools-2, 2026-11-23, 26.1.3, isolated)
Scripts and outputs: `~/Desktop/organic-tutorial/work-p2c/` (`verify1.py` ... `verify17.py`, `verify-item*.txt`;
probe JS in `work-p2c/js/`, run with `mutfile.ts` / `evalfile.ts`).

| Question | Native finding | Tool change |
|---|---|---|
| Why does offset_planar_curves refuse a planar face loop? | `OffsetPlanarCurvesFactory.getBasis` finds no plane for SPCurve segments; setting `constructionPlane = new ConstructionPlaneSnap(normal, point, x)` offsets the same Wire (+2 mm went outward on the attempt-1 tilted face: 348.8 to 361.4 mm, i.e. L + 2 pi d) | `plane` option; `plasticity_inset_planar_face` |
| Imprint of an in-plane loop | a vector imprint along -n from a loop built on a plane point 5e-5 mm off the face missed the face (no split); bidirectional imprint from the face midpoint splits it | the inset uses the face midpoint and a bidirectional imprint |
| extrude_faces into the Solid | `ExtrudeFactory` (AbstractSweepFactory) has `targets`, `operationType`, `keepTools`; faces + `targets = [solid]` + 15902 at -1.5 mm recessed the face (15 to 16 faces, -7658 mm³, no new body) | `boolean` option |
| Spike at the stadium corner | the native g1 maximum (90 deg) is not among the 100 samples (every sample below 0.07 deg) on band/side (`organic-product`) and bowl/rear (`attempt1-v2-final`); on bowl/rear it sits between samples 11 and 12 | `source: native-maximum` spikes |
| EvalBasis directions | `uDirection`/`vDirection` are orthogonal principal directions with `uCurvature`/`vCurvature` the principal curvatures: Euler's formula matched a finite-difference normal derivative at 0, 30, 60, 90 deg to 1e-4 on four B-surface faces; the curvature sign follows the surface (mirrored halves with `orientation` false read opposite signs) | absolute curvature on every edge, signed against the face normal |
| Sphere edge read as a 40 mm gap (phase B) | reproduced as a closed Sphere/Cylinder rim after `split_sheet_edge` added a vertex: native g0 31.8 mm, its sample points pile up at the vertex; a resample by edge parameter projected on both faces reads 0 mm / 1.7e-6 deg | resample when native G0 fails; `nativeMisread` |
| G2/G2 side patch 22094 | at (42, -17.46, 107.08) band and flank (both asked G2) curve differently: -0.00675 against 0 per mm along the band edge; band G2 + flank G1 passed. Rear corner where band and side (G2 to each other) meet: no flag | `g2-corner-curvature` (report only) |
| Loft guide 0.004 mm off | refused ("A guide curve is not touching a profile"); after moving the guide end onto the curve 8e-5 along it (2e-19 m off) still refused; onto the profile end vertex: lofted | snap prefers the end vertex |
| Split volume drift | 136 mm³ on 777 007 mm³ (1.75e-4) at z = 10 on `organic-product`, two valid Solids | relative tolerance, warning up to 1 % |

### Phase C review (C1-C9), live on 26.1.3
- Face.EvalBasis is unchanged; regions: `nativeApi.db.lookupTopologyItem(region)` is a planar kernel Face whose
  `GetInnerLoops()` length is the region's hole count (a 40 x 20 rectangle around a 10 x 5 one: 1).
- Joining two sheets whose shared edge is 0 to 0.5 mm apart fails (`PK_BODY_sew_bodies` 1041), so a body edge with a
  real G0 gap was not built live; the resample's no-replace path is unit-tested (gap along a third of the edge, and
  only next to a vertex).
- The attempt-2 rear closure: in the saved half the hole after deleting the rear face is open from (0, 23.37,
  134.88) to (0, 56, 4) (no support face), which is the 22085; closed with the rebuilt profile Wire, band G2 + side G2
  passes natively with no g2-corner-curvature note (the side was patched G2 to the band, so they curve alike).

