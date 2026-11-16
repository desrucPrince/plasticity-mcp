# Gap probes 2026-11 (live, isolated instance 127.0.0.1:56453)

Plasticity 26.1.3. Native units are meters, the MCP uses mm. Probe geometry sits at x = 2000–3300 mm, and every probe undoes back to its start.
Helper `harness.ts`: `drive()` runs `new Factory(editor).resource(command)` inside a Command whose `execute` is overridden, then `exec()`s it. `TRACE` logs reads on the prototype chain.

## Summary

| # | Gap | Verdict | Native entry point | Proposed tool | Effort |
|---|---|---|---|---|---|
| 1 | Sweep: open profile, Wire profile, guide rails | DRIVABLE (SweepTool PARTIAL) | `SweepCommand` + `SweepFactory` (`curves`, `guides`) | `plasticity_sweep_curves` + `guideIds` on `sweep_regions` | S |
| 2 | X-sided patch | DRIVABLE | `PatchCommand` or `XNurbsCommand` + `XSidedFactory` | `plasticity_xsided_patch` | S-M |
| 3 | Extend sheet options / ExtendEdge | DRIVABLE (shape, target, modify) / PARTIAL (ExtendEdge, no measurable effect) | `ExtendSheetCommand` + `ExtendSheetFactory` | options on `plasticity_extend_sheet_edges` | S |
| 4 | Dimensions | MoveMeasurement DRIVABLE; DimensionDistance BLOCKED; DimensionPolyline BLOCKED | `MoveMeasurementCommand` + `MoveMeasurementFactory` | `plasticity_move_measurement_label` | S |
| 5 | Surface control points | DRIVABLE | `TogglePointsCommand` + `ShowFacePointsFactory`, then `MoveControlPointCommand` + `MultiMoveControlPointFactory` | `plasticity_list_face_control_points`, `plasticity_move_face_control_points` | M |
| 6 | XNurbs | DRIVABLE (same as gap 2) | `XNurbsCommand` constructs `XSidedFactory`; `guides` adds interior curves | merge into `plasticity_xsided_patch` (`guideIds`) | S |
| 7 | PolySplines | PARTIAL: mesh to PolySplines DRIVABLE; Import not driven | `PolySplinesCommand` + `ConvertMeshToPolySplinesFactory` | `plasticity_convert_reference_mesh_to_polysplines` | S |
| 8 | ExportWeb | BLOCKED (network publish, not a file export) | `ExportWebFactory` | none | – |
| 9 | Ranked gaps beyond #15 | list only | see below | – | – |

## Gap 1. Sweep variants: DRIVABLE (SweepTool PARTIAL)
Script `probe-sweep.ts`, raw `probe-sweep.json`.

Recipe. Command `SweepCommand` (`editor.commands`), factory binding `SweepFactory`. Set `factory.spine = <Wire view>`, then one profile kind:
- `factory.curves = [<Wire view>]`: an open or closed Wire profile. The result is a Sheet.
- `factory.regions = [<Region>]`: the existing route. The result is a Solid.
- Guides: `factory.guides = [<Wire view>]` and `factory.guideMethod = SweepGuideMethod.{Point 23250 | Chord 23251 | Curve 23252}`.
- Other fields: `alignment` (`SweepAlignmentType`), `cornerType`, `twistDegrees`, `scale`, `simplify`, `thickness` (m).

Read-back (spine 2000,0,0 → 2000,0,60 mm):
- A. Open arc Wire (1990..2010 x 0..10, z 0) gives a Sheet: bounds [1990,0,0]–[2010,10,60], 1F/4E/4V.
- A2. The same arc on a curved NURBS spine gives a Sheet, 1F/4E/4V.
- B. A closed circle Wire (r 5) through `curves` gives a Sheet: [1995,-5,0]–[2005,5,60], 1F/2E/0V.
- C0. The circle Region gives a Solid: [1995,-5,0]–[2005,5,60], 3F.
- C. The Region with a rail guide (2005,0,0 → 2015,0,60) gives a Solid with max x 2015 (C0 has 2005). Point, Chord and Curve give identical results on this straight rail.
- C4. The open arc with a rail (`guideMethod` Curve) gives a Sheet with max x 2020 (A has 2010).
- D. `thickness = 0.001` on an open-Wire sweep fails: "Operation failed at PK_BODY_hollow_2 with error `PK_ERROR_unsuitable_entity` (914)".
- E. SweepTool needs `SweepToolCommand` + `SweepToolFactory` with `solid`, `spine`, `origin` (Vector3, m) and `originOrientation` (Quaternion). Without the last two it fails in `Vector3.applyQuaternion` (trace read `origin`, `originOrientation`).
  - With them, a 10 mm box on a 40 mm y spine gives a Solid: [2192.93,-7.07,-5]–[2207.07,47.07,5], 6F/12E/8V. The result looks rotated 45°.
  - `degrees = 90` gives an identical result, so the orientation semantics are unclear.

Tool sketch. `plasticity_sweep_curves`:
`{ profileIds: int[] (Wire), spineId: int (Wire), guideIds?: int[] (Wire), guideMethod?: "point"|"chord"|"curve", alignment?, corner?, twistDegrees?, scale?, revision }`.
Also add `guideIds` and `guideMethod` to `plasticity_sweep_regions`.
Effort: S.
Risks:
- `thickness` fails on open Wires.
- I tested guideMethod only on a straight rail.
- SweepTool orientation is unclear, so leave it out for now.

## Gap 2. X-sided patch: DRIVABLE
Script `probe-xsided.ts`, raw `probe-xsided.json`.

Recipe. Command `PatchCommand` from `editor.commands`. `XNurbsCommand` also works and constructs the same factory, see gap 6.
Factory binding `XSidedFactory`, a subclass of the unbound `XNurbsFactory`. Set one boundary input:
- `factory.curves = [<Wire views>]` for N boundary Wires. The Wires need not be one closed Wire.
- `factory.edges = [<edge views>]` for sheet boundary edges.

Options:
- `factory.setContinuityForEdge(edgeView, ContinuityType.G1)`, or `factory.continuity = ContinuityType.X` for all edges.
  - `ContinuityType`: C1 23150, C2 23151, C3 23152, G1 23153, G2 23154, G3 23155, G0 23156 (default), Free 23157.
- `factory.guides = [<Wire views>]` for interior curves, see gap 6.
- Others: `uDegree`, `vDegree`, `uSpans`, `vSpans`, `quadSided`, `controlType` (None 0 / Explicit 1 / Aligned 2), `boundaryCondition`, `parameterization`, `tolerance`, `bending`, `stretch`.

Read-back. The result is a new Sheet named "XNurbs.001". The source sheet stays.
- Skew quad, 4 polylines: 1F/4E/4V.
- Curved triangle, 3 NURBS: 1F/3E/3V.
- Pentagon, 5 polylines: 1F/5E/5V.
- Open cylinder top edge (r 10, z 20):

| continuity | z range of the patch |
|---|---|
| G0 | 19.99..20.01 (flat cap) |
| G1 | 16.23..24.15 |
| G2 | 17.11..24.50 |

  `continuity = G1` for all edges equals the per-edge G1 result.
- Spans 4 and degree 5 on the quad: bounds identical to the default.

Tool sketch. `plasticity_xsided_patch`:
`{ curveIds?: int[] (Wire), edges?: {bodyId, edgeId}[], guideIds?: int[], continuity?: "g0"|"g1"|"g2"|..., edgeContinuity?: {edgeId, continuity}[], uDegree?, vDegree?, uSpans?, vSpans?, revision }`.
Effort: S-M.
Risks:
- The status `boundsMm` overshoots the boundary. Triangle corners span x 2300..2340 and y 100..135, but the bounds read x 2280..2340 and y 74..135. Verify results by type and edge count, not by bounds.
- The G1 and G2 z ranges reach below the rim, which needs a visual check.

## Gap 3. Extend sheet options: DRIVABLE; ExtendEdge: PARTIAL
Script `probe-extend.ts`, raw `probe-extend.json`.

Recipe. Command `ExtendSheetCommand`, factory `ExtendSheetFactory`, plus the existing fields: `edges`, `distance` (m), `type`, `limit`, `modify`. New options:
- `shape = ExtensionShape.{Linear 22750 | Soft 22751 | Reflective 22752 | Natural 22753 | Arc 22754}`.
- `type = BodyExtensionType.{Distance 22760 | Target 22761 | Bbox 22762}`, with `factory.target = <body view>` for Target.
- `modify` (bool).
- `bias` (number, default 0.5). Note: commands.json lists `bias1` and `bias2`, but the factory has one `bias`.
- `ExtensionLimit`: Minimal 23800 / Outside 23801 / Inside 23802.

Read-back. The test sheet is an extruded arch: [2500,0,0]–[2540,20,13.33]. The test extends the straight end edge at x 2540 by 10 mm.

| variant | max x | min z | other |
|---|---|---|---|
| Linear | 2547.07 | -7.07 | |
| Soft | 2546.77 | -7.36 | |
| Reflective | 2546.26 | -7.77 | |
| Natural | 2546.51 | -7.58 | max z 14.24 |
| Arc | – | – | fails: "PK_BODY_extend with error `PK_ERROR_field_of_wrong_type` (5014)" |
| `bias` 0.1 or 0.9 (Soft, Natural) | no change | no change | |
| `modify = false` | | | 2F/7E: the extension is a separate face |
| `type = Target` (box face at x 2555) | 2555 | -15 | |
| `type = Bbox` | = Linear | = Linear | no effect seen |

ExtendEdge: `ExtendCommand` + `ExtendEdgeFactory` (`shell`, `edges`). It commits a Sheet or Solid, but the only change is a uniform ±0.005 mm in bounds, probably box padding. I claim no measurable effect.
- `calculate` reads only `shell` and `edges`.
- `distance = 0.01` changes nothing.

Tool sketch. Extend `plasticity_extend_sheet_edges` with:
`shape?: "linear"|"soft"|"reflective"|"natural"`, `targetId?: int` (sets type Target, makes distanceMm optional), `merge?: boolean` (maps to `modify`).
Leave out bias, bbox and arc.
Effort: S.
Risks:
- Arc fails on this NURBS sheet.
- I did not find a use for bias.

## Gap 4. Dimensions: MoveMeasurement DRIVABLE; DimensionDistance BLOCKED; DimensionPolyline BLOCKED
Scripts `probe-dimension-command.ts`, `probe-dimensions.ts`, `probe-move-measurement.ts`, with JSON next to them.

Routing (`probe-dimension-command.json`). The test traps `DimensionFactory.collection` during `editor.commands.DimensionCommand.execute()`. The generic DimensionCommand picks the factory from the selection:

| selection | result |
|---|---|
| box body | DimensionBlockFactory |
| one or two box faces | DimensionDistanceFactory |
| rectangle Wire | DimensionRectangleFactory |
| cylinder | DimensionRadiusFactory |
| edge, open polyline | "Operation has no effect" |

The binding commands report "Operation has no effect" here:
- `DimensionPolylineCommand` with a polyline.
- `DimensionDistanceCommand` with box + cylinder.

Vertex selections: not tested. My selection helper had a bug.

DimensionDistance commit (`probe-dimensions.json`). Set `factory.collection = captured` and `factory.distance = 0.03` (or `0.012` for the top face):
- The commit returns `["Solid"]` and adds an undo step.
- The box stays [2700,0,0]–[2720,10,5]. This is a silent no-op.
- `to`, `direction` and `refDistance` stay 0 after the collection is set.
- If I set `to`, `direction` and `refDistance` (and `clickPoint`) by hand, the commit fails: "Operation LocalOutcome failed with error `21460`."

DimensionPolyline on a closed triangle: "Operation has no effect".

MoveMeasurement recipe. Binding command `MoveMeasurementCommand`, factory `MoveMeasurementFactory`.
- Set `factory.measurement = editor.measurements.lookupByStableId(id)`.
- Set `start` and `end` to the measured points (world, m), `direction` to the unit vector, and `offset` to the label point (world, m).
- `offsetLocal2d` = (offset − start) in the measurement frame.
- Without `measurement`, it fails: "Cannot read properties of undefined (reading 'clone')".

Read-back: offsetMm [-2800,0] → [10,-10] (offset at 2.81,-0.01,0), and → [0,5] (offset at 2.8,0.005,0). The measurement versionId changes 1 → 2.

Tool sketch. `plasticity_move_measurement_label`: `{ id: int, offsetMm: [x,y] (local along/perpendicular) | labelPointMm: Vector3, revision }`.
Effort: S.
Risks:
- The commit drops `userData.name` (name → null). Reuse `commandEndPreservingMeasurementNames`.
- DimensionDistance needs the UI's reference pick. It is not reachable from fields alone.

## Gap 5. Surface control points: DRIVABLE
Script `probe-face-points.ts`, raw `probe-face-points.json`.

Recipe.
1. Show the points. Command `TogglePointsCommand`, factory `ShowFacePointsFactory`, `factory.faces = [<face view>]` (`show` defaults to true). This adds one undo step (2 → 3).
2. Read the points. They are in `item.view.high.cvs` (`ShellCVGroup`, 0 before, 8 after). Each `ShellCV` has `{ id, versionId, position (Vector3, m, float32), parentItem }`.
   - This matches `inspect_surface_structure`: BSurf, uDegree 3, vDegree 1, 4×2 control points.
3. Move the points. Binding command `MoveControlPointCommand`, factory `MultiMoveControlPointFactory`. Set `factory.cvs = [ShellCV...]` and `factory.move.set(dx,dy,dz)` (m). This is the 26.1 path, like the Wire CVs.

Read-back: the top CV moved +10 mm in z, and the sheet max z went 13.33 → 15.00. Setting `controlPoints` instead had no effect.

Tool sketch:
- `plasticity_list_face_control_points { bodyId, faceId, revision }`. It shows the points and returns `{cvId, positionMm}`.
- `plasticity_move_face_control_points { bodyId, faceId, cvIds: int[], deltaMm, revision }`.

Effort: M.
Risks:
- "Show" is a history step.
- I did not test hide (`show = false`).
- Positions are float32, about 1e-4 mm.
- CV ids are valid only after the show step.

## Gap 6. XNurbs: DRIVABLE (same mechanism as gap 2)
Scripts `probe-xnurbs.ts`, `probe-command-factories.ts`, `probe-licence-enums.ts`.

Evidence:
- `XNurbsCommand.execute()` constructs `XSidedFactory` (chain XSidedFactory → XNurbsFactory → GeometryFactory).
- There is no `XNurbsFactory` binding. It is `Object.getPrototypeOf(XSidedFactory)`.
- Licence: `hasXNurbs()` = true, `isStudioLicense()` = true, `isIndieLicense()` = false.

Recipe. `XNurbsCommand` + `XSidedFactory`, with `curves = [4 quad Wires]` and `guides = [<interior NURBS Wire>]`. The result is a Sheet "XNurbs.001", 1F/4E/4V, with max z 22.47. The quad without a guide (gap 2) has max z 10.03.

The bare base class is not an entry point:
- An empty `XNurbsFactory` fails: "XNurbs operation failed with error `3`".
- Guides only, or borrowed constraints + guide, fail with error `29`.
- `addSegmentConstraint(CurveSegment)` fails: "Cannot read properties of undefined (reading 'Id')". It expects an `XNurbsEdgeConstraint`.

Tool: fold into `plasticity_xsided_patch` with `guideIds`. Effort: S.
Risk: I tested only on a Studio licence.

## Gap 7. PolySplines: PARTIAL
Scripts `probe-polysplines.ts`, `probe-command-factories.ts`.

Evidence:
- `PolySplinesCommand` with no selection, or with a Solid selected: "Operation has no effect".
- With a reference mesh selected, it constructs `ConvertMeshToPolySplinesFactory`.
- There is no `PolySplinesFactory` binding (only `PolySplinesFactory_tmp` and `_tmpMatrix`).

Recipe. `PolySplinesCommand` + `ConvertMeshToPolySplinesFactory`, `factory.empties = [nativeApi.db.lookupEmptyById(meshId)]`. Options: `roundedCorners`, `mergePatches` (default true), `interpolateBoundary`.

Read-back. The source is an imported 10 mm quad OBJ cube (3100..3110). The result is a Solid with bounds 3100.80..3109.20 on each axis, 6F/12E/8V, which is a subdivision limit surface. The reference mesh is consumed: the list is empty after the commit. `roundedCorners = true` gives an identical result on this cube.

Import: `ImportPolySplinesCommand.execute()` with no arguments fails: "Cannot read properties of undefined (reading 'map')". I did not drive it further.

Tool sketch. `plasticity_convert_reference_mesh_to_polysplines { referenceMeshId, roundedCorners?, mergePatches?, interpolateBoundary?, revision }`.
Effort: S.
Risks:
- The source mesh is consumed.
- I tested only a quad cube.
- Triangle meshes are untested.

## Gap 8. ExportWeb: BLOCKED
Script `probe-export-web.ts`, raw `probe-export-web.json`.

Evidence. During the test, fetch, XHR, WebSocket.send, sendBeacon and window.open were stubbed, then restored.
- A bare commit reads `thumbnail`, `host` and `serialized`, then fails: "Cannot read properties of undefined (reading 'json')".
- With `items` + `filePath` set, the commit gives the same result.
- I saw zero network exits.
- No file appeared in the output dir.
- The bindings `WebPublishContent` and the id `command:publish-to-plasticity-share` exist.

Conclusion: this is the Plasticity Share publisher. It uploads a serialized document and a thumbnail to a host. It is not a local file export. `serialized.json` is an inference from the error. Do not build a tool.

## Gap 9. Beyond #15 (list only, `probe-gap9.json`)
- #16 Fillet/chamfer modes: `FilletShellFactory` setters `filletMode` (default "constant"), `chamferMode` (`ChamferMode` Offset 0 / Apex 1), `distance1`/`distance2`, `lockDistances`, `prolong`; fields `rho`, `yBlend`. These look trivially drivable as options (S).
- #18 Variable spiral: `SpiralFactory` setters `angle`, `length`, `degrees`, `p2`; fields `turns`, `spiralPitch`, `handedness` (S, not committed).
- #22 RemoveNominalSurface: `RemoveNominalSurfaceCommand` + factory (`shell`, `faces`) commits on a plain box face with no geometry change. It is drivable, but its value shows only on fillet faces (S).
- #21 RefitFace / RefitTrim, #19 AlignAndRebuild: these are XNurbs-family factories (`faces`/`sheet`, `reference` setters). Medium effort, not committed.
- #23 JoinFaces: `JoinFacesFactory` with `faces` only fails: "Cannot read properties of undefined (reading 'CoverFaces_async')". It also needs `shell`.
- COVERAGE.md is stale: #1–#4, #13 and #14 already ship as tools.

## Follow-ups not tested
- Hide face points.
- The Dimension reference pick (`containsRefEntity`, ref entity).
- Vertex selections for dimensions.
- ImportPolySplines inputs.
- SweepTool orientation.
- XNurbs on non-Studio tiers.
