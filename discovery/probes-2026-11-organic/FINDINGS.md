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
- G1/G2 fails (FillHole errors 22092/22093/22094) when the corner geometry cannot be satisfied: at each corner
  the faces asked G1 must share one tangent plane that contains both boundary edges, and the face angles meeting
  at a vertex of a smooth region must add up to 360 deg. Example: four faces tangent to x = 35 at one vertex with
  angles 90 + 180 + 180 + 90 = 540 deg made every G1 rear patch fail; swapping which curve continues which edge
  fixed the budget. A flank guide 7 deg out of the head's tangent plane likewise failed until it was re-lofted.
- Looser `toleranceMm` did not rescue any of these failures; it is exposed for the dialog's Tolerance field.
- A G2 patch can come out with a degenerate parameterisation (degree 5, one span in v); `plasticity_rebuild_face`
  turns it into a regular B-Surface before it is used as a G1 neighbour or loft profile face.
