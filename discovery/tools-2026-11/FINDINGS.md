# Findings: overwrite, long undo, overlap volume, body clearance (2026-11-18)

Plasticity 26.1.3 (Electron 26.6.9, Chrome 116), isolated instance on loopback port 52679, empty disposable document.
Three probe runs through this worktree's server and runtime; each restored the document to 0 bodies and its Undo depth.
The probe scripts and their raw output are not in the repository (session scratch). The numbers below are the measured ones.

## 1. Minimum distance between two solids: not exposed (item 4, no tool)

Question: does the kernel bridge give an exact minimum distance between two bodies, or between their faces and edges,
without changing the document?

Answer: not between two solids. One exact range read is reachable from the script side, and it measures a body
against a wire body only (`ProfileCollection.DiagnoseIntersections`, below). `plasticity_measure_body_clearance` was
not built.

### What was read

- The kernel addon of the application (`pk.node`, the Parasolid bridge), read only: its imported symbols and, per
  imported range function, the bridge functions that call it. Nothing in the application was changed.
- The live script side: the keys of the kernel namespace (`pk_default.a`, 246 keys), the methods of `Eval`,
  `BodyCollection`, `Measurer`, `MeasureOptions`, `ClashOptions`, and the editor's command list.

### Parasolid range functions and who calls them

| Parasolid function | what it measures | called by (bridge) | reachable from script as a read |
|---|---|---|---|
| `PK_TOPOL_range` | minimum distance between two topological entities (bodies, faces, edges) | `ProfileCollection::DiagnoseIntersections` | yes, but a body against a wire body only (see below) |
| `PK_TOPOL_range` | the same | `BodyCollection::SplitAtIntersections` (it also calls `PK_EDGE_split_at_param`: it splits edges), `Path::Create`, `Body::Sweep` (they build a path and a swept body; what else they call was not read) | no |
| `PK_TOPOL_range_array` | the same for arrays | `ShellBody::TransformEdges`, `SweepOptions::PK` | no |
| `PK_TOPOL_range_geom` | entity to geometry | `Edge::Raycast`, `BCurve::SolveDeltaForTarget` | no distance between entities |
| `PK_TOPOL_range_vector`, `PK_ENTITY_range_vector`, `PK_GEOM_range_vector` | entity or geometry to a point | `Eval::DistancesToPoints`, `Face/Edge/Curve/Surface::FindPointNear`, others | yes, point to entity only |
| `PK_GEOM_range` | geometry to geometry | `Curve::Raycast`, `Surface::Raycast` | no distance between entities |
| `PK_TOPOL_clash` | clash type of two entities, no distance | `Eval::Collisions`, `BodyCollection::Clash`, `ClashWithSelf` | yes (used for item 3) |

### What the script side has

- Kernel keys that match distance, range, clash, mass, measure, near, gap, clear, box: `Box`, `ClashOptions`,
  `ClashType`, `MeasureOptions`, `MeasurementType`, `Measurer`, `VertexGapFillType`. No range or distance class.
- `ProfileCollection.DiagnoseIntersections(profiles, guides)` (a static function of the Loft profile collection; its
  bridge function calls `PK_TOPOL_range` and nothing else of the kernel). `profiles` are bodies of any kind, `guides`
  must be wire bodies. It returns `{ profilePoints, guidePoints }`: for every profile and guide, the closest point on
  each, in metres. Measured: the 20 mm box against the line (23, 0, 0)-(23, 10, 0) gives (20, 5, 0) and (23, 5, 0),
  3 mm; a sphere r 3 at (-3, 10, 10) against that line gives 24.857 mm (analytic: sqrt(26^2 + 10^2) - 3 = 24.857).
  A Solid as a guide is refused ("Invalid argument 'guides' for ProfileCollection::DiagnoseIntersections"); a wire
  as the profile returns empty lists. The read did not change the document.
- `Eval` methods: `Axes`, `Boxes`, `BoxesCollisions`, `Circles`, `Classes`, `Collisions`, `ControlVertices`,
  `DistancesToPoints`, `EdgesCenters`, `EdgesConvexities`, `EdgesCurvaturesAtParameters`, `EdgesIntersections`,
  `EdgesTangentsAtParameters`, `Exists`, `FacesCentroids`, `FacesCurvatures`, `HalfEdgesTangentsAtParameters`,
  `MassProperties`, `Pivots`, `Planes`, `Radii`, `VerticesPositions`, `WireBodiesCentroids` (each also `_async`).
- `Eval.DistancesToPoints(ids, xyz, offsets)` takes a body id too. For the box 0..10 mm it reads 3 mm for the point
  (13, 5, 5) and 17.320508075688773 mm for (20, 20, 20), with the nearest point. It is a point-to-entity distance.
- `Measurer` is a namespace object with `Measure(vertices, edges, faces, solids, sheets, wires, options)` and
  `GetGeometryStats`. Its bridge function returns eight numbers, a vector and a count for a selection and calls no
  range function: it is the selection's length, area and volume, not a distance. `MeasureOptions` has `MaxItems` only.
  `MeasurementType` (`Distance`, `DistanceRatio`, `Chord`, `ChordRatio`) is Parasolid's measure type for trimming a path.
- Editor commands: `MeasureDistanceCommand` (a point-to-point measurement between two snap points,
  `PointToPointMeasurementFactory`), `MeasureRadiusCommand`, `MeasureContinuityCommand`, `DimensionCommand`. None
  measures a minimum distance between bodies.

### Why no exact tool can be composed

- There is no exposed distance between two solids, two faces, or a face and an edge. The one entity-to-entity read
  (`DiagnoseIntersections`) needs a wire body on one side.
- The distance from a solid to wire bodies made of the other solid's edges, taken both ways, is the body distance
  only when the closest points lie on an edge or a vertex of one body. That holds for bodies with planar faces only. It
  fails for curved faces: a sphere and a box are closest at interior points of two faces. So it is not an exact tool
  for whole bodies in general, and it needs kernel wire bodies built from edges (not probed: how to make them without
  touching the document). A tool limited to planar-faced bodies is possible in principle; it was not built or probed.
- From `DistancesToPoints` a body distance is a search over points of one body: a sampled estimate, not an exact value.
- `BodyCollection.SplitAtIntersections` reaches `PK_TOPOL_range`, but it splits edges of its bodies. It is not a read.
- The existing exact tools stay the answer for face pairs: `plasticity_measure_parallel_planar_face_clearance` and
  `plasticity_measure_nonparallel_planar_polygon_clearance` (analytic, on the trimmed faces).

## 2. Volume of the intersection (item 3)

`new kernel.Eval(kernel.Context.Get()).MassProperties(Int32Array.of(bodyId), Float64Array.of(1))` works on a kernel
body that is not in the document (the intersection body in the temporary database). The second argument is a density.
Result: `{ amountSum, massSum, peripherySum, centroids, centroidAvg, errors, ok }`; `amountSum` is the volume in m3,
`ok` the count of bodies evaluated, `errors` one code per body. A body has no mass method of its own.

| pair (10 mm box A at the origin) | analytic mm3 | kernel mm3 |
|---|---|---|
| box moved 6 mm in x | 400 | 400.0000000000001 |
| cylinder r 3, h 10, axis on the box face x = 10 | pi x 9 x 10 / 2 = 141.3716694115407 | 141.37166941154072 |
| cylinder r 3 through the box along z | pi x 9 x 10 = 282.7433388230814 | 282.7433388230814 |
| 5 mm box inside, on three faces of A | 125 | 125.00000000000001 |
| equal box at the same place | 1000 | 1000.0000000000001 |
| 3 mm box strictly inside A | 27 | 27 |
| sphere r 3 inside a 20 mm box, tangent to one wall | 4/3 x pi x 27 = 113.09733552923254 | 113.09733552923255 |
| cylinder r 2, h 10 inside that box, lying on its floor | pi x 4 x 10 = 125.66370614359172 | 125.66370614359172 |
| cylinder r 2, h 5 inside that box, standing on its floor | pi x 4 x 5 = 62.83185307179586 | 62.83185307179588 |
| sphere r 2 inside a cylinder r 10, tangent to its curved wall | 4/3 x pi x 8 = 33.510321638291124 | 33.510321638291124 |

Every read left the revision token, the Undo depth, the Redo depth and the body count unchanged.

## 3. Contact and containment (item 3)

The intersection (`BooleanFactory`, operation 15901, on two clones in a temporary geometry database) and the clash test
(`Eval.Collisions`; `BodyCollection.Clash(other, new ClashOptions(true, true))` gives the same list) for each pair, in
both body orders:

| pair | intersection, given order | reversed order | clash types |
|---|---|---|---|
| apart by 3 mm | no effect | no effect | none |
| one whole face shared | no effect | no effect | AbutNoClass x 21 |
| part of a face shared | no effect | no effect | AbutNoClass x 13 |
| one edge shared | no effect | no effect | AbutNoClass x 14 |
| one vertex shared | no effect | no effect | AbutNoClass x 9 |
| sphere tangent to a box face | no effect | no effect | AbutNoClass x 1 |
| board in a pocket of its base (5 faces) | no effect | no effect | AbutNoClass x 30 |
| board with a hole on a base with a pin of the same radius | no effect | no effect | AbutNoClass x 9 |
| overlap | body | body | Interfere |
| inside, touching three faces | body | body | Interfere x 15 |
| box inside, on one face of the larger box | body | body | Interfere x 5 |
| sphere inside a box, tangent to one wall | body | body | Interfere x 1 |
| sphere inside a box corner, tangent to three walls | body | body | Interfere x 3 |
| cylinder inside a box, lying on the floor (line contact) | body | body | Interfere x 3 |
| cylinder inside a box, standing on the floor | body | body | Interfere x 2 |
| sphere inside a cylinder, tangent to its curved wall | body | body | Interfere x 1 |
| sphere outside a box, tangent to a wall | no effect | no effect | AbutNoClass x 1 |
| cylinder outside a box, lying on its top face | no effect | no effect | AbutNoClass x 3 |
| equal bodies | body | body | Interfere x 30 |
| strictly inside (small body first) | no effect | body | AinB |
| strictly inside (large body first) | body | no effect | BinA |

- "Operation has no effect" has two meanings: no shared volume, or the target strictly inside the tool. The tool read
  both as `no-volumetric-interference` before, so the small body first gave a wrong result.
- `ClashOptions(findAll, classify)`: `(true, true)` lists every clashing face pair with its type; `(true, false)`
  gives `Exists` for each; `(false, ...)` stops at the first. A constructor call without arguments fails.
  `BodyCollection.Clash` returns `{ types, targets, tools }`; `Eval.Collisions` returns `{ clashTypes, targetIndices,
  toolIndices, targetTopols, toolTopols }`.
- `AbutBInA` and `AbutBOutA` were never returned for these bodies. So the clash test does not classify an abutment as
  inside or outside. The rule "abutments only means no shared volume" rests on what was measured: every body that
  lies inside another and touches it (on a plane, along a line, at a point, on a curved wall) reads `Interfere`, and
  only bodies that touch from outside read `AbutNoClass` alone. A case outside this list is not covered.
- The failure from the field (`PK_BODY_boolean_2` error `21653` with the base as target) did not occur on any of
  these bodies, in either order. The rule for it is built from the two answers above and is covered by unit tests only.

## 4. Undo and redo (item 2)

Document: 16 small bodies, then 300 moves of one box (probe 1) and 600 moves (probe 2). Window visible, load average 4.

| what | measured |
|---|---|
| `setTimeout(25)` in the page | 26 to 28 ms |
| one Undo of a move, until Plasticity's promise settles | 0.6 ms median, 1.5 ms at the 90th percentile, 2.5 ms maximum (300 steps) |
| the step as the server sent it before (looks at the promise when a 25 ms timer fires), one request | 29.1 ms median |
| `plasticity_undo { steps: 100 }` before | 4.1 s: 41 ms a step, of which about 9 ms is the full document read after each step |
| `plasticity_undo { steps: 622 }` now (one call, to the empty document) | 3.9 s: 6.3 ms a step |
| `plasticity_redo { steps: 622 }` now | 3.8 s |
| full document read / revision probe / a read of the depths | 8 to 9 ms / 1.6 ms / 0.4 ms |

- Before, a step's page-side deadline (10,000 ms) was equal to the CDP request limit (10,000 ms, the client default),
  so a step that needed its deadline could only end as "CDP request timed out: Runtime.callFunctionOn", which marks the
  session uncertain. Each step also waited for a timer although the promise had settled long before.
- The time-out itself did not occur in these runs (visible window, load average 4): 100 steps took 4.1 s. A window
  that is hidden or covered was not measured; Chromium slows timers there.

## 5. Export refusal (item 1)

The refusal is the server's own: `assertAbsent()` (a `stat` of the output path before the export, "Refusing to
overwrite existing file") and an exclusive copy (`COPYFILE_EXCL`, `flag: "wx"` for a screenshot) after it, in
`src/plasticity/operations.ts`. Plasticity never sees the output path: it writes into a staging folder.
