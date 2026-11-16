# Changelog

## Unreleased

- Add `plasticity_sweep_curves` (Wire profiles to Sheets), `guideIds`/`guideMethod` rails on `plasticity_sweep_regions`, `shape`/`targetId`/`merge` on `plasticity_extend_sheet_edges`, and `plasticity_move_measurement_label`. Live script: `accept:native-extend-sweep-label`.
- Add `plasticity_xsided_patch` (N-sided Sheet from boundary Wires or edges, optional guides and g0/g1/g2 edge continuity), `plasticity_convert_reference_mesh_to_polysplines` (quad reference mesh to a PolySplines solid; the mesh is consumed) and `plasticity_show_face_control_points` / `plasticity_move_face_control_points` (Sheet and Solid face CVs). Live script: `accept:native-patch-polysplines-facepoints`.
- Polish IGES/SAT export: always stage `geometry.igs`, report a missing file clearly, fix the validator wording. `plasticity_clear_selection` is strict, non-destructive and findable as deselect, unselect or select none.

## 0.2.2 — 2026-10-11

- Cache serialized body topology to avoid repeated native-wrapper allocation when reading an unchanged scene; retain live names, visibility and materials and invalidate on geometry/history changes (#2, #3).
- Return native mass-property centroids for solids and faces instead of bounding-box centers (#1, #4, #5, #6).
- Add native asymmetric-centroid and topology-invalidation regression acceptance, plus a reproducible [486-body state-memory benchmark](docs/state-memory-benchmark.md).

## 0.2.1 — 2026-09-28

- Show a compact core tool catalog by default in `npm start` and the Codex plugin. All operations remain searchable and callable through `plasticity_call`; `npm run start:full` exposes every operation directly.
- First GitHub release of the local preview for Plasticity 26.1.3 on macOS Apple Silicon. See the [acceptance matrix](docs/acceptance-matrix.md) for verified operations and remaining limitations.
