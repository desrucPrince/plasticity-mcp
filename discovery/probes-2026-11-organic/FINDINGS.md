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

Not built: splitting a Sheet edge at a point (`SplitSegmentFactory` has only segment/edge; wires already have
`plasticity_split_curve_segment`), a one-body surface bridge (`plasticity_bridge_surface` needs two Sheets; the
seam fix uses isoparam + Indie Patch G1 instead), and a generic command runner. `PLASTICITY_CDP_URL` already
points the server at any isolated port.

## Indie Patch continuity: what makes G1 succeed (tutorial rebuild, 2026-11-23)
- Continuity is applied per neighbouring face: two arcs of one cylinder rim (one wall face) both read back G1
  when only one was asked G1 (`patchmap.ts` shows the factory map itself is per edge and correct).
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
