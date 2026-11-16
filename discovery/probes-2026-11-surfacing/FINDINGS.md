# FINDINGS: surfacing verify-and-refine probes (2026-11-16, Plasticity 26.1.3)

Scripts and raw JSON: `discovery/probes-2026-11-surfacing/`. Isolated instance only; endpoint and target come from the
env vars `PLASTICITY_CDP_URL` and `PLASTICITY_TARGET_ID`. Native units are metres; the MCP uses mm.
The starting document was NOT empty: 4 bodies at x 0..80 mm, undo 0. Fixtures sit at x >= 5000 mm. Each run undoes to its start.

## Summary
| # | Capability | Verdict | Native entry point | Proposed tool | Effort |
|---|---|---|---|---|---|
| 1 | Measure Continuity | DRIVABLE (shipped tool validated) | `plasticity_analyze_surface_continuity` (`MeasureContinuityFactory.calculate` + `evalSurfaceContinuityMeasurements`) | keep; fix wording; optional absolute curvature | S |
| 2 | Find Boundary Edges / closure | DRIVABLE | kernel `model.GetEdges().Laminar()`; command `editor.commands.FindBoundaryEdgesCommand` | already covered by `plasticity_validate_bodies`; add native laminar source | S |
| 3 | Analysis shader modes | DRIVABLE | `editor.shading.setShader(name2shader[k])`, `restoreFromMemento` | `plasticity_set_analysis_shader` or a `shader` option on `plasticity_screenshot` | S |
| 4 | Surface Align (Edge Align, 2 surface edges) | DRIVABLE via the command; factory-direct BLOCKED | `AlignEdgeCommand` (binding) + `AlignAndRebuildFactory` + `AlignEdgeDialog.finish()` | `plasticity_surface_align` | M |
| 5 | Square | DRIVABLE factory-direct | `SquareEdgeCommand` (binding) + `SquareFactory.boundaries` | `plasticity_square_surface` | S |
| 6a | Curve Array | DRIVABLE, already shipped | `plasticity_curve_pattern` (`CurveArrayFactory`) | none | - |
| 6b | Vertex Align (curves) | PARTIAL | `AlignVertexCommand` + `AlignVertexFactory` + dialog finish | `plasticity_align_curve_vertex` | M |
| 7 | Other starred rows | list only | see section 7 | - | - |

## 1. Measure Continuity: DRIVABLE (shipped tool validated)
Script `probe-continuity-1.ts`, raw `probe-continuity-1.json`. Kernel API probe: `kernel-tries2-round.json`.

| case | expected | measured gap mm | measured angle deg | relG2 | verdict |
|---|---|---|---|---|---|
| (a) 30 deg prism crease, edge 18e2163 | G0, angle 30 | 0 | 29.999999999999876 | 0 | G0 |
| (b) round fillet r5: plane to cylinder (2 edges) | G1, angle 0, k 0 vs 0.2/mm | 2.2e-15 and 0 | 0 | 1 | G1 |
| (c) G2 fillet r5: plane to BSurf (2 edges) | G2, k mismatch ~0 | 3.5e-15 | 8.54e-7 | 0 | G2 |

Absolute curvature for (b), from the kernel: `Face.EvalBasis(0.5,0.5)` gives `vCurvature 200` (1/m) = 0.2/mm on the cylinder and 0 on the plane. This equals 1/r for r = 5 mm.

How to read the output:
- relG2 is |k1 − k2| / max(|k1|, |k2|). It saturates at 1 whenever one side is flat. So (b) reads 1, not 0.2/mm.
- The tool reports the maximum only. A corner spike hides an interior that is G2. Example: in the Square case, relG2 is 1 at the corner (6200, 0, 0).
- The `…AtMm` locations come from Float32 spikes, so they jitter by about 0.02 mm at x = 5 m.
- Default tolerances are 0.01 mm, 0.1 deg and relG2 0.05. They match the native factory defaults: `g0Tolerance 1e-5` m, `g1Tolerance 0.0017453` rad, `g2Tolerance 0.05`.
- The tool needs an edge shared by two faces. Two separate sheets need `plasticity_join_sheets` first, and the join fails while a gap exists: "Operation failed at PK_BODY_sew_bodies with error `PK_ERROR_bodies_dont_knit` (1041)" (`probe-align-2.json` joinBefore).

Extra data in the native view (`probe-continuity-2.json`):
- `view.analysis.g0spikes` and `g1spikes` are Float32Array[600]: 100 samples × (point, vector).
- `g2spikes` is Float32Array[700]: 100 samples × 7.
- `maxes` is [g0, g1, g2, ?].
- Per-sample curves could come from these arrays.

Kernel recipe for absolute values (not built, per the re-scope). All of these ran:
- `Edge.GetPointAndTangent(t ∈ [0,1])`.
- `Edge.EvalFaceNormal(t)` returns `{normal, faceNormal1, faceNormal2}`.
- `Face.FindPointNear(<kernel Vector returned by GetPoint>)` returns `{u, v, exact}` (normalised). A three.js Vector3, an array or a plain object all fail: "Invalid argument 'position'".
- `Face.EvalBasis(u,v)` returns `{normal, uDirection, vDirection, uCurvature, vCurvature}` in 1/m.
- Kernel vectors serialise as `{}`; read `.x`, `.y`, `.z` directly.

Not tested:
- The real `MeasureContinuityCommand`: its Measurements entry and its undo count.
- G3.

## 2. Find Boundary Edges and closure: DRIVABLE
Scripts `probe-boundary.ts` and `probe-boundary-cmd.ts`; raw JSON beside them. `probe-boundary-cmd.json` supersedes the command part of `probe-boundary.json`: the first run awaited `exec()` and timed out, and the first run's cylinder fixture picked a cap, not the wall.

Kernel recipe (read-only, no undo step), with `item` = `geometryModel` entry:
- `const c = item.model.GetEdges();`
- `const lam = c.Laminar();` then `lam.Size()` and `lam.GetEdges()`.
- Map each to its view versionId: the edge whose `view.high.edges.get(k).entityId == e.Id()`.
- `Edge.IsLaminar()` agrees.
- Warning: `EdgeCollection.IsClosed()` was true for every body, including open sheets. Do not use it for watertightness.

| body | expected free edges | kernel laminar | `plasticity_validate_bodies` boundaryEdgeIds / closed |
|---|---|---|---|
| open L-sheet (2 faces) | 6 | 6 (same ids) | 6 / false |
| closed box | 0 | 0 | [] / true, printableSolid true |
| sheet with hole (top face of holed box) | 5 (4 + circle) | 5 | 5 / false |
| cylinder wall sheet | 2 circles, no seam | 2 | ['51e4710','51e4707'] / false |

Native command, `new editor.commands.FindBoundaryEdgesCommand(editor)` with the sheet selected:
- It selects the same 6 edges.
- Undo depth goes 2 → 3 (one selection step).
- The executor then auto-chains `ExtendSheetCommand`, which waits for input. It must be cancelled with `executor.cancelActiveCommand()`.
- With no selection it does nothing visible, but undo still goes +1.
- Not run on a Solid.

Proposal: no new tool is needed. Optionally add `source: "native-laminar"` (`Laminar()`) to `plasticity_validate_bodies` in place of the `faceIds.length === 1` heuristic. They agree in all 4 cases. Effort S.

## 3. Analysis shader modes: DRIVABLE
Script `probe-shader.ts`, raw `probe-shader.json`, PNGs `shot-shader-*.png` (quarter scale).

Modes on 26.1.3, from `name2shader` keys: isophotes, draft, faceDirection, zebraVertical, zebraHorizontal, topo. There is no curvature shader; that is a 26.2 feature.

Recipe (`runtime.readNative`, binding `name2shader`; `this` = editor):
1. `const m = this.shading.saveToMemento();`
2. `this.shading.setShader(name2shader[key]);`
3. `Array.from(this.viewports)[0].setNeedsRender();`
4. Screenshot.
5. Restore: `this.shading.restoreFromMemento(m)`.

Notes:
- `setShader('zebraHorizontal')` (a string) fails: "undefined is not a function". It needs the material object.
- `mode.tag` stays "uniform". The memento `shader` field shows the mode name.
- The UI shader panel highlights the active mode (see the zebra PNG).
- Undo depth stayed 3 throughout all 7 captures: no history step.

Pixel check (window mode, 2800×2048; default mean luminance 45.52):

| mode | mean abs diff vs default | fraction changed |
|---|---|---|
| isophotes | 13.21 | 20.2 % |
| draft | 18.45 | 20.2 % |
| faceDirection | 14.12 | 20.1 % |
| zebraVertical | 25.23 | 20.2 % |
| zebraHorizontal | 23.86 | 20.2 % |
| topo | 17.47 | 17.2 % |
| default again (after restore) | 8.7e-6 | 0 % |

Camera:
- Restoring through `orbitControls.setQuaternion` did not reproduce the old pose.
- `plasticity_set_camera(eye, target)` followed by setting `zoom` natively restored it exactly (`restore-camera.json`).

Proposed tool `plasticity_set_analysis_shader { mode: "default"|"isophotes"|"draft"|"faceDirection"|"zebraVertical"|"zebraHorizontal"|"topo" }` → `{previous, current}`.
Alternatively, `plasticity_screenshot { shader? }` could set the mode, capture and restore in one call.
Effort S.

Not tested:
- The second `setShader` argument (shader uniforms such as `bands`, `rotation`, `contrast`).
- The draft pull direction.
- `captureMode: "viewport"` with a shader.
- A hidden window.

## 4. Surface Align: DRIVABLE via the command; factory-direct BLOCKED
Scripts `probe-align-1.ts`, `probe-align-2.ts`, `probe-align-3.ts`.
Fixture: two extruded control-point-curve BSurf sheets. B's start edge is 0.5 mm from A's end edge and leaves at 24.5 deg.

Factory-direct is BLOCKED (`probe-align-2*.json`, 6 trials, with and without the TRACE proxy, with raw and selection-sourced edges): "TypeError: Cannot read properties of undefined (reading 'model') at set pairs".
- Inferred cause, not proven: before it sets `pairs`, the command sets `_face` (an Object) and `_vDegree: 1` on the factory (`probe-align-1c.json`).

Command recipe (`probe-align-3.ts`, bindings `AlignEdgeCommand`, `AlignEdgeDialog`, `AlignEdgeFactory`, `ContinuityType`):
1. Guard: `executor.active == null`.
2. `selection.selected.removeAll(); selection.hits.clear();`
3. `sel.add(edgeToMove); sel.add(referenceEdge);`
 - **The first-selected edge moves.** Verified both ways: B moved in `probe-align-3.json`; A moved in `probe-align-3-swapped.json`.
 - No selection hit is needed.
4. Create `new AlignEdgeCommand(editor)` (the binding). The router `editor.commands.AlignCommand` is a silent no-op: it settles with no error and no factory.
 - Set `remember = false`.
 - Wrap `execute` to catch errors and run `removeAll()` in `finally`.
5. Start `editor.exec(cmd)` without awaiting it.
6. Capture the dialog: an `AlignEdgeDialog` instance whose constructor name reads "Constructor". `dialog.params === factory`, an `AlignAndRebuildFactory`.
 - I captured both with prototype wraps of `update` and `execute`, restored in `finally`.
7. **Wait about 500 ms.**
 - `finish()` before setup completes throws `AlreadyFinishedError` from `startQuasimode`.
 - Nothing commits, and nothing reports the failure (`probe-align-3-dbg.json`).
8. Set continuity: `factory.setContinuityForEdge(ref, ContinuityType.G0|G1|G2)`.
 - Take `ref` from `factory.pairs`, matching by `versionId`, for the reference edge.
 - The continuity map is keyed by the reference edge.
 - `factory.targets` also returns the reference edge, so the naming is inverted.
 - Passing a numeric key fails: "reading 'match'" (`probe-align-3-G1.json`).
9. `await factory.update(); dialog.finish();` then wait for the run to settle. `factory.commit` resolves "Sheet".
10. Result: one undo step (4 → 5). The moving sheet keeps its id; the reference sheet is unchanged.

Read-back (join A+B, then `plasticity_analyze_surface_continuity`):

| requested | gap mm | angle deg | relG2 | analyzer verdict |
|---|---|---|---|---|
| G0 | 0 | 24.4867 | 0.1377 | G0 |
| G1 | 0 | 8.54e-7 | 0.7846 | G1 |
| G2 | 0 | 1.21e-6 | 7.5e-8 | G2 |
| G1, swapped order (A moves) | 8.9e-13 | 8.54e-7 | 0.8694 | G1 |

After the align, B's edge centre is (5030, 5, 10), which is A's edge. Before, it was (5030.5, 5.3, 10).

Proposed tool `plasticity_surface_align`:
- Input: `{ moving: {bodyId, edgeId}, reference: {bodyId, edgeId}, continuity: "g0"|"g1"|"g2", revision, intent }`.
- Output: mutation result, plus optional continuity read-back after a trial join.
- Build it on `runPickCommand`-style lifecycle code. It differs in three ways: the dialog is a DOM element, not in `helpers.scene`; it needs a settle wait before `finish`; it needs no selection hit.
- Effort M.

Risks:
- The fixed 500 ms wait.
- The prototype-wrap capture. Capturing through `executor.active` was not tried.
- A crashed run can leave the command active. Always cancel in `finally`.

Not tested:
- G3; global `factory.continuity`; plain `AlignEdgeFactory`.
- The tension, blending, solver, partial-alignment and boundary options.
- Solid edges, unequal edge lengths, and two edges on one body.

## 5. Square: DRIVABLE factory-direct
Scripts `probe-square.ts`, `probe-square-2.ts`, `probe-square-3.ts`.

The command route is not usable (`probe-square-router.json`):
- `SquareCommand` routes to `SquareEdgeCommand`.
- That command opens `SquareDialog` with an empty `SquareFactory`; it does not read the selection.
- `finish` then fails: "XNurbs operation failed with error `3`". Inferred meaning: empty input.

Recipe (harness `drive()`, command binding `SquareEdgeCommand`, factory binding `SquareFactory`):
1. `factory.boundaries = [4 items, flat]`. Items may be ShellEdge views (taken from the selection) and/or Wire views (`item.view`), mixed.
 - Nested arrays fail: "reading 'match'" in `TopologyItem.decompose`.
2. Per-edge continuity: `factory.setContinuityForEdge(shellEdge, ContinuityType.X)`.
3. `await factory.commit()` returns "Sheet". The result is named "XNurbs.001": BSurf, 1F/4E. One undo step.

| case | read-back |
|---|---|
| 4 control-point curves | Sheet, z −4..6.33 (`probe-square-2.json` wiresFlat) |
| open box (top deleted), 4 edges, default or G0 | joins to a Solid; all 4 edges at 90 deg, G0 (expected) |
| open box, G1/G2 per edge or global | "XNurbs operation failed with error `30`" |
| flat neighbour + 3 curves leaving it horizontally: G0 / G1 / G2 | angle 4.0e-4 / 8.54e-7 / 1.39e-4 deg; relG2 1 at corner (6200,0,0) each time → analyzer: G1 / G1 / G1 |
| same, sides leaving at 24.8 deg: G0 | angle 24.775 deg, G0 |
| same, sloped: G1 / G2 | error `30` |

Reading:
- The G1 setting has a measurable effect: 4e-4 → 8.5e-7 deg. The verdict alone does not separate it from G0 on the horizontal fixture.
- Inferred meaning of error `30`: continuity that is incompatible at a corner (perpendicular walls, or a sloped side curve against G1).
- G2 never measured G2. Its max relG2 sits at a corner.

The result overlaps the shipped `plasticity_xsided_patch` (same XNurbs family, `XSidedFactory`).

Proposed tool `plasticity_square_surface`:
- Input: `{ boundary: ({bodyId, edgeId} | {wireId})[4], edgeContinuity?: {edgeId, continuity}[], revision, intent }`.
- Effort S.

Not tested:
- `Free` continuity; continuity on wire sides (`setContinuityForSegment`).
- Degrees and spans; the untrimmed property; single-face sheet input.

## 6. Curve Array and Vertex Align (`probe-item6.json`)
Curve Array is already shipped as `plasticity_curve_pattern`.
- A 4 mm cube with count 5 along a curved spine gave 4 new Solids. The last one is centred at the spine end (6360, 20, 0). One undo step.

Vertex Align is PARTIAL.
- Selection: [moving `CurveVertex` (curve B start), reference `CurveVertex` (curve A end)]. Wire views hold `_vertices`.
- `new AlignVertexCommand(editor)`; capture `AlignVertexDialog` with `params` = `AlignVertexFactory`.
- Wait 600 ms, set `factory.continuity = ContinuityType.G1`, call `update()`, then `finish()`.
- Result: one undo step (2 → 3). Curve B's min x moved 6441 → 6440, so its start reached A's end (G0 position).
- Not verified: G1 tangency.
- `AlignVertexFactory_continuities` = [G0 23156, G1 23153, G2 23154, G3 23155].

## 7. Other starred rows (list only, not run)
- `ToggleCurvatureCommand`: curvature combs for screenshots.
- `MeasureContinuityCommand`: a persistent Measurement.
- `BridgeVertexCommand` / `BridgeVertexFactory`: may be covered by `plasticity_bridge_curve_vertices`.
- `viewport:toggle-continuity-labels`.
- Not found in 26.1.3 bindings: Project Align and the curvature shader. Both are 26.2 features.

## Enums
- `ContinuityType`: C1 23150, C2 23151, C3 23152, G1 23153, G2 23154, G3 23155, G0 23156, Free 23157.
- `BoundaryCondition`: Natural 0, Normal 1, AlignWithAdjacent 2, AlignToNext 3.

## Risks and not tested (all items)
- Everything relies on internal, obfuscated API and was verified on 26.1.3 only, with a Studio licence.
- Items 4 and 6b depend on prototype wraps and timing. A tool should cancel the command in `finally` and verify the undo delta.
- Item 2: the native command was not run on a Solid.
- Item 3: viewport capture mode with shaders, and shader uniforms, are untested.
- Selection steps from `FindBoundaryEdgesCommand` add undo entries.
