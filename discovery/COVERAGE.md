# Plasticity MCP coverage report

Question: what can Plasticity do natively that this MCP server cannot drive yet, especially curves?

Inputs: Plasticity 26.1.3 live class lists (236 `*Command`, 182 `*Factory`), `commands.json` (191 `command:*` ids), `live-catalog.json` (370 MCP tools). Source of truth: `src/` non-test `.ts` files. Static analysis only: name grep plus reading `src/plasticity/operations.ts`. Plasticity was not contacted.

## Headline

| | covered-direct | covered-equivalent | partial | gap | n/a (UI-only / base class) | total |
|---|---|---|---|---|---|---|
| Command classes | 104 | 90 | 15 | 19 | 8 | 236 |
| Factory classes | 118 | 24 | 25 | 12 | 3 | 182 |

Reading the numbers:

- Name-grep found 126/236 Commands and 53/182 Factories absent from `src/`. After reading the code: of the 126 Commands, 90 are covered-equivalent, 9 partial, 19 gap, 8 UI-only. Of the 53 Factories: 24 covered-equivalent, 14 partial, 12 gap, 3 base/internal.
- Name-used classes are covered-direct unless the code shows a missing mode: 6 used Commands and 11 used Factories are downgraded to partial (Extrude, Sweep, Spiral, Cut, Curve, ExtendSheet, and five Knife sketch factories that are only used with `isKnife = false`). See Appendix C.
- Several gap rows have an unverified purpose (marked "not verified"). Probe them live before building.
- Biggest real hole for curves: no control-point curve, no knife mode, no curve-to-sheet extrusion, no cut-curve, no curve-to-curve fillet, no PolySplines / XNurbs / X-sided patch.

## Top 15 gaps (most useful for modeling first)

| # | Gap | Closest MCP tool | Effort |
|---|---|---|---|
| 1 | Control-point curve (`ControlPointCurveCommand`) | closest `plasticity_create_nurbs_curve` (interpolating only) | S-M |
| 2 | Knife mode: draw-and-cut on a body (7 unused Knife* factories; 5 more only used with `isKnife=false`) | closest `plasticity_imprint_curves_on_body`, `plasticity_cut_with_faces` | M |
| 3 | Extrude options + curve extrusion (ExtrudeSurface; two-sided, draft angle, shear, thickness) | closest `plasticity_extrude_profile` / `extrude_faces` (one distance only) | S-M |
| 4 | Curve-to-curve fillet (`FilletCurveCommand`) | closest `plasticity_fillet_curve_vertices` (vertices of one Wire) | S-M |
| 5 | Cut curve (`CutCurveCommand`, MultiCurveCut) | closest `plasticity_trim_curve_fragments` + `plasticity_split_curve_segment` | M |
| 6 | Sweep variants (SweepTool; open-profile sweep to sheet; rails) | closest `plasticity_sweep_regions` (closed Regions, one spine) | M-L |
| 7 | X-sided patch (XSided) | closest `plasticity_patch_closed_wires`, `plasticity_create_constrained_surface` | M |
| 8 | Extend edge + extend-sheet options (ExtendEdge; shape, bias) | closest `plasticity_extend_sheet_edges` (linear only), `plasticity_extend_curve_endpoints` | M |
| 9 | XNurbs (`XNurbsCommand`) | none | L |
| 10 | PolySplines (`PolySplinesCommand`, `ImportPolySplinesCommand`, ImportPolySplines, ConvertMeshToPolySplines) | none | L |
| 11 | Surface control points: show / move (ShowFacePoints, `command:toggle-points`) | closest read-only `plasticity_inspect_surface_structure` | M-L |
| 12 | Cut with non-planar cutters / curves (`CutCommand`) | `plasticity_cut_with_faces` is planar-only | M |
| 13 | Clear selection (`DeselectAllCommand`) | none; `select_*` need at least 1 id | S |
| 14 | IGES / SAT / web export (`ExportIgesCommand`, `ExportSatCommand`, ExportWeb) | `export_step`, `export_parasolid` only | S |
| 15 | Distance / polyline dimensions and measurement label move (`DimensionDistanceCommand`, `DimensionPolylineCommand`, `MoveMeasurementCommand`) | closest `create_*_measurement` | M |

Full ranked list with evidence is in section (b). Effort: S = under a day, one operation in `operations.ts` plus tool registration; M = new native factory driven and tested live; L = new workflow (many tools).

## Method and limits

1. Listed every non-test `src/**/*.ts` file and grepped each of the 236 Command and 182 Factory names with word boundaries. Result matches the hint: 126 Commands and 53 Factories never appear.
2. Name-used classes were checked to appear in code positions (`commandStart("X")`, `new this.commands.X`, or a quoted binding list passed to `runtime.mutate`) and not only in prose. All do. They count as covered-direct, except where `operations.ts` shows a missing mode (Appendix C).
3. For each name-unused class I read the closest operation in `src/plasticity/operations.ts` and the tool schema in `discovery/live-catalog.json`, then classified: covered-equivalent (other route, MCP tool named), partial (what is missing named), gap, or n/a (base class or pure UI).
4. Native option ids in `commands.json` (for example `extrude:angle1`, `fillet-shell:angle`, `extend-sheet:bias1`) were used as evidence that an option exists natively. They do not prove how the option is wired.
5. Limits: no live verification. Purpose of some classes is inferred from the name only (marked "not verified"). Whether `ExportCad` accepts `.iges` / `.sat` paths, whether `CurveFactory.type` accepts a control-point value, and whether FilletShell has variable-radius or distance+angle modes are assumptions to test live. A name found in `src/` proves the class is referenced, not that every option of it is reachable. `src/server.ts` was grepped for the class names but not read in full; the 370 tools in `live-catalog.json` were taken as the tool surface.
6. Counts depend on my category rules (regex on class names, reviewed by eye). Treat per-category numbers as +-3.

## (a) Counts by category

Columns: D = covered-direct, E = covered-equivalent, P = partial, G = gap, N = n/a (UI-only or base class).

### Command classes

| Category | D | E | P | G | N | Total |
|---|---|---|---|---|---|---|
| curves/sketch | 35 | 14 | 3 | 2 | 0 | 54 |
| solids/primitives | 12 | 4 | 1 | 0 | 0 | 17 |
| surfaces | 22 | 5 | 2 | 8 | 0 | 37 |
| booleans/cut | 3 | 1 | 1 | 0 | 0 | 5 |
| fillets/chamfers | 3 | 1 | 1 | 0 | 0 | 5 |
| transforms/align | 8 | 21 | 1 | 2 | 0 | 32 |
| patterns/arrays | 5 | 4 | 0 | 0 | 0 | 9 |
| selection | 0 | 1 | 0 | 1 | 5 | 7 |
| view/camera/visibility | 0 | 9 | 1 | 0 | 1 | 11 |
| file/import/export | 2 | 9 | 1 | 3 | 0 | 15 |
| materials/render | 0 | 8 | 3 | 1 | 0 | 12 |
| measurement/dimensions | 6 | 4 | 1 | 2 | 0 | 13 |
| other/UI-only | 8 | 9 | 0 | 0 | 2 | 19 |
| **Total** | 104 | 90 | 15 | 19 | 8 | 236 |

### Factory classes

| Category | D | E | P | G | N | Total |
|---|---|---|---|---|---|---|
| curves/sketch | 36 | 6 | 4 | 0 | 1 | 47 |
| solids/primitives | 12 | 3 | 1 | 0 | 0 | 16 |
| surfaces | 29 | 5 | 5 | 7 | 0 | 46 |
| booleans/cut | 4 | 0 | 13 | 0 | 0 | 17 |
| fillets/chamfers | 4 | 1 | 1 | 0 | 0 | 6 |
| transforms/align | 9 | 8 | 0 | 1 | 0 | 18 |
| patterns/arrays | 7 | 0 | 0 | 0 | 0 | 7 |
| selection | 0 | 0 | 0 | 0 | 0 | 0 |
| view/camera/visibility | 0 | 0 | 0 | 1 | 0 | 1 |
| file/import/export | 10 | 1 | 0 | 1 | 0 | 12 |
| materials/render | 0 | 0 | 0 | 0 | 0 | 0 |
| measurement/dimensions | 7 | 0 | 1 | 2 | 0 | 10 |
| other/UI-only | 0 | 0 | 0 | 0 | 2 | 2 |
| **Total** | 118 | 24 | 25 | 12 | 3 | 182 |

Category notes: knife factories sit under booleans/cut; curve control-point editing under curves/sketch; patch/loft/sweep/bridge/extend-sheet and face editing under surfaces; group and delete wrappers under other/UI-only. Material commands under materials/render (only appearance materials exist in the MCP).

## (b) Ranked gaps and partials

Names without the `Factory` suffix are Factory classes. "Checked" lists the files read.

| # | Gap | Plasticity classes | What it does | Closest MCP tool | Effort | Evidence / checked |
|---|---|---|---|---|---|---|
| 1 | Control-point curve | ControlPointCurveCommand; Curve (partial) | Curve defined by its control polygon and degree, not interpolated through points. | `plasticity_create_nurbs_curve` (interpolating only); `rebuild_curves`, `convert_curve_vertices_to_control_points` only edit existing Wires | S-M | operations.ts:3400-3418 sets only `CurveType.Polyline` / `CurveType.NURBS`. Probe other `CurveType` values live first. |
| 2 | Knife mode | KnifeCenterCircle, KnifeCenterRectangle, KnifeCornerRectangle, KnifeCurve, KnifeCurveWithPreview, KnifeThreePointAr, KnifeThreePointRectangle; plus KnifeTwoPointCircle, KnifeThreePointCircle, KnifeCenterPointArc, KnifeEllipse, KnifePolygon (used, partial) | Sketch a shape on a body and imprint/cut it in one step. | `create_*` curve then `plasticity_imprint_curves_on_body`; `plasticity_cut_with_faces`; `plasticity_boolean` with an extruded profile | M (S for the five already-used shapes: set `isKnife=true`) | operations.ts:3528,3571,3627,3673,4144,4199 set `isKnife = false`; no `isKnife = true` and no other Knife name in src/. |
| 3 | Extrude options and curve extrusion | ExtrudeCommand, ExtrudeFactory (partial); ExtrudeSurface | Two-sided distance, draft angle, shear, thickness; extrude an open curve into a Sheet. | `plasticity_extrude_profile` (closed planar Wire only), `plasticity_extrude_faces`, `plasticity_extrude_regions` | S (options) / M (open curves) | operations.ts:4864-4930 sets only `distance1` and rejects open Wires. commands.json lists `extrude:angle1`, `extrude:shear`, `extrude:thickness`. |
| 4 | Curve fillet beyond one Wire | FilletCurveCommand; FilletCurve | Fillet two separate curves / segments with trim. | `plasticity_fillet_curve_vertices` (vertices inside one Wire) | S-M | operations.ts:5205 uses FilletVertex on Wire vertices only. Native purpose of FilletCurve not verified. |
| 5 | Cut curve | CutCurveCommand; CutCurve; MultiCurveCut | Cut curves with other curves (split at intersections). | `plasticity_list_curve_intersections` + `plasticity_split_curve_segment` + `plasticity_trim_curve_fragments` | M | No CutCurve / MultiCurveCut name in src/. Trim is covered (operations.ts:5049 trimCurveFragments). |
| 6 | Sweep variants | SweepTool (command:sweep-tool); SweepCommand, SweepFactory (partial) | Sweep open profiles to Sheets, rails, tool variant. | `plasticity_sweep_regions` (closed Regions + one Wire spine; alignment, corner, twist, scale), `plasticity_create_pipes`, `plasticity_loft_curves` | M-L | operations.ts:6412-6485 takes `regionIds` + `spineId` only. SweepTool not in src/. |
| 7 | X-sided patch | XSided | N-sided patch from boundary edges with continuity options. | `plasticity_patch_closed_wires`, `plasticity_patch_solid_edge_loops`, `plasticity_patch_sheet_hole`, `plasticity_create_constrained_surface` | M | operations.ts:6715 patchRegions, 6746 patchClosedWires, 7561 patchSheetHole use Patch* factories; XSided not referenced. |
| 8 | Extend edge and extend-sheet options | ExtendEdge; ExtendSheetCommand, ExtendSheetFactory (partial) | Extend edges with continuity/shape, bias, extend to target. | `plasticity_extend_sheet_edges` (linear distance), `plasticity_extend_curve_endpoints` | M | operations.ts:7650-7657 hard-codes Linear / Distance / Minimal. commands.json lists `extend-sheet:bias1`, `extend-sheet:bias2`. |
| 9 | XNurbs | XNurbsCommand | Native freeform NURBS surface tool (`command:xnurbs`). | none | L | No XNurbs in src/. |
| 10 | PolySplines | PolySplinesCommand; ImportPolySplinesCommand; ImportPolySplines; ConvertMeshToPolySplines | Subdivision-style PolySplines modeling and mesh conversion. | none (reference meshes are import-only: `plasticity_import_reference_mesh`) | L | No PolySplines name in src/. |
| 11 | Surface control points | ShowFacePoints (`command:toggle-points`) | Show and move control points of a face. | `plasticity_inspect_surface_structure` (read-only); `plasticity_list_curve_control_points` is Wire-only | M-L | No face control-point listing in src/plasticity/operations.ts; editing path for faces not verified. |
| 12 | Cut with non-planar cutters | CutCommand, MultiCut (partial) | Cut bodies with curved cutter faces or curves. | `plasticity_cut_with_faces` | M | operations.ts:4656 throws "Cut requires current planar cutter faces". |
| 13 | Clear selection | DeselectAllCommand | Deselect everything. | none | S | `plasticity_select_bodies` schema has `minItems: 1`; same for other `select_*`. |
| 14 | IGES / SAT / web export | ExportIgesCommand, ExportSatCommand; ExportWeb | Export other CAD/web formats. | `plasticity_export_step`, `plasticity_export_parasolid` | S | operations.ts:8494-8545 accept only `.step/.stp` and `.x_t/.x_b`. ExportCad is used, so IGES/SAT may be reachable by extension (unverified). |
| 15 | Distance and polyline dimensions, measurement label move | DimensionDistanceCommand (partial), DimensionPolylineCommand; DimensionDistance (partial), DimensionPolyline; MoveMeasurementCommand; MoveMeasurement | Dimension-driven edits and relocating measurement labels. | `plasticity_create_topology_distance_measurement`, `create_vertex_distance_measurement`, `set_block_dimensions`, `set_radius_dimension`, `set_rectangle_dimensions` | M | Only Block/Radius/Rectangle dimension factories are used (operations.ts:4469, 4535, 4601); measurement tools take no offset. |
| 16 | Chamfer and fillet modes | FilletShellCommand, FilletShellFactory (direct; options unverified) | Distance + angle chamfer, variable radius. | `plasticity_chamfer` (equal distance), `plasticity_fillet` (constant radius) | S-M | operations.ts:4754-4790 sets only `factory.distance`. commands.json lists `fillet-shell:angle`, `fillet-shell:chamfer`, `fillet-vertex:chamfer`. Counted direct, not partial, until probed. |
| 17 | Camera and display control | NavigationCommand (partial); commands.json `orbit:*`, `viewport:navigate:selection`, `viewport:toggle-orthographic`, `viewport:toggle-x-ray`, `viewport:toggle-render-mode` | Orbit, pan, zoom, zoom-to-selection, orthographic, x-ray, render mode. | `plasticity_set_view` (7 named views, optional fit), `plasticity_screenshot` | S-M | operations.ts:9660 setView; enum of 7 views. |
| 18 | Variable spiral | SpiralCommand, SpiralFactory (partial) | Spiral with angle / length / radius change. | `plasticity_create_helix` (constant radius) | S | operations.ts:3422-3460; commands.json lists `spiral:angle`, `spiral:length`, `spiral:radius`. |
| 19 | Free-form align | AlignCommand (partial); AlignAndRebuild | Align curved edges or surfaces, then rebuild. | `plasticity_align_planar_faces`, `align_cylindrical_faces`, `align_linear_edges`, `align_vertices` | M | operations.ts:2870-3130: planar/cylinder faces, Line edges, vertices only. |
| 20 | Material edit / fork / rename | EditMaterialCommand, ForkMaterialCommand, SetNameOfMaterialCommand, ContextMenuForkMaterialCommand | Edit properties of an existing material, fork it, rename it. | `plasticity_set_appearance_material` (assign, or create a new bounded one, or clear) | S | operations.ts:4688-4750 setAppearanceMaterial creates/assigns only. |
| 21 | Refit surface and trims | RefitSurface, RefitTrim (partial) | Refit a whole surface or trim curves separately. | `plasticity_rebuild_face`, `plasticity_rebuild_curves` | M | RebuildFace used (operations.ts:6240); Refit* not referenced. |
| 22 | Remove nominal surface | RemoveNominalSurface (`command:remove-nominal-surface`) | Strip the nominal surface of a face. | none | S-M | Not referenced in src/. Purpose not verified. |
| 23 | Unknown-purpose commands | CompleteEdgeCommand, ContinueLoftEdgeCommand, JoinFacesCommand, JoinFaces, JoinVerticesCommand, SquareEdgeCommand, SquareFaceCommand, DissolvePlaneCommand, DeleteRegionCommand, SetNameOfMaterialCommand | Probe live to learn what each does before building. | see Appendix B | ? | Not referenced in src/. |
| 24 | Asset library import | ImportAssetCommand | Import from the Plasticity asset library. | `plasticity_import_step` and friends | S | Low value. |

### Curve checklist (the capabilities you named)

| Capability | Status | MCP route / what is missing |
|---|---|---|
| Spline drawing (interpolated) | covered | `plasticity_create_nurbs_curve`, `create_polyline`, `create_helix` |
| Control-point curve | gap | see #1 |
| Curve fillet | partial | `plasticity_fillet_curve_vertices` for vertices of one Wire; curve-to-curve missing (#4) |
| Curve offset | covered (planar) | `plasticity_offset_planar_curves`; non-planar offset is not driven |
| Trim curve | covered | `plasticity_trim_curve_fragments` (+ `list_curve_fragments`) |
| Cut curve | gap | #5 |
| Project | covered | `project_curves_onto_body`, `project_curve_pair`, `create_body_outlines`, `create_body_intersection_curves` |
| Isoparam | covered | `plasticity_insert_isoparam_edges` |
| Bridge / blend | covered | `bridge_curves`, `bridge_curve_vertices` (G0-G3), `bridge_shell_edges`, `bridge_surface` |
| Loft with guides | covered | `loft_curves`, `loft_faces`, `loft_regions` take `guideIds` |
| Sweep variants | partial | `sweep_regions`, `create_pipes`; open-profile / rail / tool missing (#6) |
| Revolve | covered | `plasticity_revolve_profile` (accepts any Wire; operations.ts:7777) |
| Rebuild / refit | covered / partial | `rebuild_curves` (tolerance, control-points, degree-spans), `rebuild_face`, `raise_curve_degree`, `insert_curve_knot`; Refit surface/trim (#21) |
| Knife tools | gap | #2 |
| XNurbs / PolySplines | gap | #9, #10 |
| X-sided patch | partial | #7 |
| Extend edge | partial | #8 |
| Constrained surface | covered | `plasticity_create_constrained_surface` |

## (c) UI-only or no-factory items

Commands with no factory work (selection, context menus, navigation, toggles, material editor, account). Verdict: MCP equivalent exists (E), partial (P), or pointless (X).

| Item | Examples | Verdict |
|---|---|---|
| Mouse selection wrappers | BoxChangeSelectionCommand, ClickChangeSelectionCommand, ClickChooseSelectionCommand, DblClickChangeSelectionCommand, OutlinerChangeSelectionCommand | E: `select_bodies`, `select_faces`, `select_edges`, `select_curves`, `select_nodes`. Click semantics pointless. Clear-selection is missing (gap #13). |
| Context menu wrappers | ContextMenuDeleteCommand, ContextMenuDissolveCommand, ContextMenuGroupSelectedCommand, ContextMenuSetMaterialCommand, ContextMenuRemoveMaterialCommand, ContextMenuForkMaterialCommand | E for all but Fork (P). The wrapper adds nothing. |
| Navigation and display | NavigationCommand, ToggleCurvatureCommand, PopIsolationCommand; ids `orbit:*` (16), `viewport:*` (21), `snaps:*` (11) | P: `set_view` has 7 named views. Orbit/pan/dolly/snaps are pointless for an agent that gives explicit coordinates. Zoom-to-selection, ortho, x-ray and render mode could be useful for screenshots (#17). |
| Visibility and lock toggles | HideSelectedCommand, HideUnselectedCommand, UnhideAllCommand, InvertHiddenCommand, ToggleHiddenCommand, ToggleVisibilityCommand, ToggleSelectableCommand, LockSelectedCommand | E: `set_visibility`, `set_locked` with explicit ids. |
| Material editor UI | CreateMaterialCommand, EditMaterialCommand, SetMaterialCommand, UseMaterialCommand, SelectAllWithMaterialCommand, assets:* (4) | E for create/assign/clear/select; P for edit, fork, rename (#20). Physical/render materials do not exist in the MCP; only appearance materials. |
| Clipboard and placement | CopyWithPlacementCommand, PasteCommand, PasteWithPlacementCommand, RepeatPasteWithPlacementCommand; `edit:*`, `place:*` | E: `duplicate_bodies` + `move`. Snap placement pointless. |
| Account / sharing | ManageMySharedDocumentsCommand; `command:publish-to-plasticity-share` | Pointless. |
| Modal tool control | `command:abort`, `command:finish`, `command:quasimode:*`, `command:smart-command`, `dialog:*`, `point-picker:*`, `direction:*`, `hover:*`, `tab:*`, `app:*` | Pointless: the MCP calls factories directly and commits. |
| Gizmos and keyboard | `gizmo:*` (128), `keyboard:*` (86) | Pointless (mouse handles and key bindings). Their numeric intent is covered by `move`, `rotate`, `scale`. |
| Selection modes | `selection:*` (28), `outliner:*` (24) | P: mode switching is implicit in the typed `select_*` tools; select-adjacent / invert are missing but `find_faces` with adjacency covers most use. |
| File menu | `file:new`, `file:open`, `file:save`, `file:save-as`, `file:save-version`, `file:import`, `file:export` | P: `open_document`, `save_copy` (never overwrites), imports/exports exist. No new-document and no save-in-place tool. |
| Undo / repeat | `edit:undo`, `edit:redo`, `edit:repeat-last-command` | E for undo/redo; repeat pointless. |
| Tool option fields | ~80 ids such as `extrude:*`, `fillet-shell:*`, `loft:tension`, `sweep:twist`, `box:*`, `move:*` | Not commands. They show native options; see #3, #8, #16, #18 for options the MCP does not set. |

## (d) `command:*` ids mapped to MCP tools

Total ids: 191. Matched by name: 123. Matched through an equivalent or partial route: 40. Unmatched: 28. Matched in total: 163 of 191.

Matching is by name similarity, then by the closest tool when the route differs ("equivalent"). A match does not mean every option is reachable (see (b)).

### Unmatched ids by category

**curves** (2)

- `command:control-point-curve`: no control-point-defined curve
- `command:cut-curve`: no cut-curve (closest trim_curve_fragments + split_curve_segment)

**surfaces** (5)

- `command:sweep-tool`: no sweep-tool op
- `command:complete-edge`: not verified; no tool
- `command:poly-splines`: no PolySplines / XNurbs
- `command:xnurbs`: no PolySplines / XNurbs
- `command:remove-nominal-surface`: no tool

**transforms/align** (2)

- `command:place`: UI snap/placement dialog (no tool needed)
- `command:dialog:place`: UI snap/placement dialog (no tool needed)

**selection** (6)

- `command:deselect-all`: select_* needs >=1 id; no clear-selection
- `command:deselect-all-and-reset-construction-plane`: no clear-selection; set_workplane only activates a plane
- `command:invert-selection`: interactive selection helpers (find_faces adjacency filter covers select-adjacent partially)
- `command:select-adjacent`: interactive selection helpers (find_faces adjacency filter covers select-adjacent partially)
- `command:select-next-entity-collection`: interactive selection helpers (find_faces adjacency filter covers select-adjacent partially)
- `command:select-previous-entity-collection`: interactive selection helpers (find_faces adjacency filter covers select-adjacent partially)

**view/camera/visibility** (2)

- `command:toggle-curvature`: display toggle (data via analyze_edge_curvature)
- `command:toggle-points`: surface/curve control-point display toggle

**file/import/export** (3)

- `command:export-iges`: no IGES / SAT / asset-pack export
- `command:export-sat`: no IGES / SAT / asset-pack export
- `command:export-asset-pack`: no IGES / SAT / asset-pack export

**materials/render** (1)

- `command:fork-material`: no fork/edit of existing material

**other** (7)

- `command:abort`: modal tool control (UI only; not needed)
- `command:finish`: modal tool control (UI only; not needed)
- `command:quasimode:start`: modal tool control (UI only; not needed)
- `command:quasimode:stop`: modal tool control (UI only; not needed)
- `command:smart-command`: modal tool control (UI only; not needed)
- `command:manage-my-shared-documents`: account/sharing (UI only)
- `command:publish-to-plasticity-share`: account/sharing (UI only)

### Matches through equivalent / partial route

| id | MCP route |
|---|---|
| `command:push-face` | plasticity_move_faces / offset_faces |
| `command:copy-with-placement` | plasticity_duplicate_bodies (+ move) |
| `command:paste-with-placement` | plasticity_duplicate_bodies (+ move) |
| `command:alternative-duplicate` | plasticity_duplicate_bodies (+ move) |
| `command:duplicate` | plasticity_duplicate_bodies (+ move) |
| `command:center-rectangle` | plasticity_create_rectangle |
| `command:corner-rectangle` | plasticity_create_rectangle |
| `command:three-point-rectangle` | plasticity_create_rectangle |
| `command:square` | plasticity_create_rectangle |
| `command:line` | plasticity_create_polyline |
| `command:curve` | plasticity_create_polyline / create_nurbs_curve (interpolating only) |
| `command:fillet-curve` | plasticity_fillet_curve_vertices (single Wire only) |
| `command:create-solid-from-faces` | plasticity_create_solid_from_sheet / unjoin_shells |
| `command:project-body-body` | plasticity_create_body_intersection_curves |
| `command:duplicate-curve-and-project` | plasticity_duplicate_curves + project_curves_onto_body |
| `command:duplicate-edge-and-project` | plasticity_extract_edges |
| `command:convert-vertex` | plasticity_convert_curve_vertices_to_control_points |
| `command:delete-redundant-topology` | plasticity_delete_edges |
| `command:ungroup-selected` | plasticity_dissolve_groups |
| `command:hide-selected` | plasticity_set_visibility |
| `command:hide-unselected` | plasticity_set_visibility |
| `command:unhide-all` | plasticity_set_visibility |
| `command:invert-hidden` | plasticity_set_visibility |
| `command:isolate` | plasticity_set_visibility |
| `command:unisolate` | plasticity_set_visibility |
| `command:lock-selected` | plasticity_set_locked |
| `command:unlock-all` | plasticity_set_locked |
| `command:select-all` | plasticity_list_bodies + select_bodies / select_curves |
| `command:select-all-curves` | plasticity_list_bodies + select_bodies / select_curves |
| `command:select-all-measurements` | plasticity_list_bodies + select_bodies / select_curves |
| `command:select-all-sheets` | plasticity_list_bodies + select_bodies / select_curves |
| `command:select-all-solids` | plasticity_list_bodies + select_bodies / select_curves |
| `command:find-boundary-edges` | plasticity_find_edges |
| `command:export-screenshot` | plasticity_screenshot |
| `command:remove-material` | plasticity_set_appearance_material (materialId 0) |
| `command:dimension` | plasticity_set_block_dimensions / set_radius_dimension / set_rectangle_dimensions / create_*_measurement |
| `command:measure-continuity` | plasticity_analyze_surface_continuity |
| `command:check` | plasticity_validate_bodies / diagnose |
| `command:create-viewspace-construction-plane` | plasticity_create_construction_plane (explicit, not camera-relative) |
| `command:create-viewspace-construction-plane-at-origin` | plasticity_create_construction_plane (explicit, not camera-relative) |

### Matched by name (summary)

| id | MCP tool |
|---|---|
| `command:boolean` | plasticity_boolean |
| `command:cut` | plasticity_cut_with_faces (planar cutters only) |
| `command:imprint` | plasticity_imprint_bodies / imprint_curves_on_body |
| `command:imprint-body-body` | plasticity_imprint_bodies / imprint_curves_on_body |
| `command:imprint-curve-body` | plasticity_imprint_bodies / imprint_curves_on_body |
| `command:align` | plasticity_align_* (planar/cylinder faces, line edges, vertices) |
| `command:move` | plasticity_move / move_faces / move_curve_control_points |
| `command:move-item` | plasticity_move / move_faces / move_curve_control_points |
| `command:move-face` | plasticity_move / move_faces / move_curve_control_points |
| `command:move-control-point` | plasticity_move / move_faces / move_curve_control_points |
| `command:freestyle-move` | plasticity_move / move_faces / move_curve_control_points |
| `command:rotate` | plasticity_rotate / rotate_faces / rotate_curve_control_points |
| `command:rotate-item` | plasticity_rotate / rotate_faces / rotate_curve_control_points |
| `command:rotate-face` | plasticity_rotate / rotate_faces / rotate_curve_control_points |
| `command:rotate-control-point` | plasticity_rotate / rotate_faces / rotate_curve_control_points |
| `command:freestyle-rotate` | plasticity_rotate / rotate_faces / rotate_curve_control_points |
| `command:scale` | plasticity_scale / scale_faces / scale_curve_control_points |
| `command:scale-item` | plasticity_scale / scale_faces / scale_curve_control_points |
| `command:scale-face` | plasticity_scale / scale_faces / scale_curve_control_points |
| `command:scale-control-point` | plasticity_scale / scale_faces / scale_curve_control_points |
| `command:freestyle-scale` | plasticity_scale / scale_faces / scale_curve_control_points |
| `command:mirror` | plasticity_mirror |
| `command:freestyle-mirror` | plasticity_mirror |
| `command:slide` | plasticity_slide_curve_control_points |
| `command:bridge` | plasticity_bridge_curves / bridge_curve_vertices |
| `command:bridge-curve` | plasticity_bridge_curves / bridge_curve_vertices |
| `command:bridge-vertex` | plasticity_bridge_curves / bridge_curve_vertices |
| `command:bridge-edge` | plasticity_bridge_shell_edges |
| `command:bridge-surface` | plasticity_bridge_surface |
| `command:constrained-surface` | plasticity_create_constrained_surface |
| `command:center-box` | plasticity_create_box |
| `command:corner-box` | plasticity_create_box |
| `command:three-point-box` | plasticity_create_box |
| `command:cylinder` | plasticity_create_cylinder |
| `command:sphere` | plasticity_create_sphere |
| `command:center-circle` | plasticity_create_circle / three_point_circle / two_point_circle |
| `command:three-point-circle` | plasticity_create_circle / three_point_circle / two_point_circle |
| `command:two-point-circle` | plasticity_create_circle / three_point_circle / two_point_circle |
| `command:tangent-circle` | plasticity_create_tangent_circle |
| `command:center-point-arc` | plasticity_create_center_arc |
| `command:three-point-arc` | plasticity_create_three_point_arc |
| `command:tangent-arc` | plasticity_create_tangent_arc |
| `command:ellipse` | plasticity_create_ellipse |
| `command:polygon` | plasticity_create_regular_polygon |
| `command:spiral` | plasticity_create_helix (constant radius only) |
| `command:slot` | plasticity_create_slot_profiles / create_slotted_hole |
| `command:text` | plasticity_create_text |
| `command:trim` | plasticity_trim_curve_fragments |
| `command:untrim` | plasticity_untrim_faces |
| `command:extend` | plasticity_extend_curve_endpoints |
| `command:extend-curve` | plasticity_extend_curve_endpoints |
| `command:extend-sheet` | plasticity_extend_sheet_edges (linear only) |
| `command:fillet` | plasticity_fillet / chamfer |
| `command:fillet-shell` | plasticity_fillet / chamfer |
| `command:fillet-vertex` | plasticity_fillet_curve_vertices (Wire vertices) |
| `command:refillet-face` | plasticity_refillet_faces |
| `command:remove-fillets-from-shell` | plasticity_remove_fillets |
| `command:extrude` | plasticity_extrude_faces / extrude_profile / extrude_regions |
| `command:revolve` | plasticity_revolve_profile |
| `command:sweep` | plasticity_sweep_regions |
| `command:loft` | plasticity_loft_curves / loft_faces / loft_regions (guideIds) |
| `command:loft-guide` | plasticity_loft_curves / loft_faces / loft_regions (guideIds) |
| `command:pipe` | plasticity_create_pipes |
| `command:hollow` | plasticity_hollow_faces / hollow_solids |
| `command:hollow-faces` | plasticity_hollow_faces / hollow_solids |
| `command:hollow-solids` | plasticity_hollow_faces / hollow_solids |
| `command:thicken` | plasticity_thicken_faces / thicken_sheets |
| `command:thicken-face` | plasticity_thicken_faces / thicken_sheets |
| `command:thicken-sheet` | plasticity_thicken_faces / thicken_sheets |
| `command:draft-face` | plasticity_draft_faces |
| `command:offset-face` | plasticity_offset_faces |
| `command:offset-curve` | plasticity_offset_planar_curves |
| `command:offset-planar-curve` | plasticity_offset_planar_curves |
| `command:freestyle-offset-planar-curve` | plasticity_offset_planar_curves |
| `command:offset-edge` | plasticity_offset_edges |
| `command:offset-face-loop` | plasticity_offset_face_loops |
| `command:offset-region` | plasticity_offset_regions |
| `command:offset-vertex` | plasticity_offset_vertices |
| `command:patch` | plasticity_patch_regions / patch_closed_wires / patch_sheet_hole / patch_solid_edge_loops |
| `command:match-face` | plasticity_match_faces |
| `command:join` | plasticity_join_curves |
| `command:join-curves` | plasticity_join_curves |
| `command:join-sheets` | plasticity_join_sheets |
| `command:unjoin` | plasticity_unjoin_curves |
| `command:unjoin-curves` | plasticity_unjoin_curves |
| `command:unjoin-faces` | plasticity_unjoin_faces / unjoin_shells |
| `command:unjoin-shells` | plasticity_unjoin_faces / unjoin_shells |
| `command:reverse` | plasticity_reverse_curves / reverse_sheets |
| `command:rebuild` | plasticity_rebuild_curves |
| `command:rebuild-curve` | plasticity_rebuild_curves |
| `command:rebuild-face` | plasticity_rebuild_face |
| `command:raise-degree` | plasticity_raise_curve_degree / raise_surface_degree |
| `command:insert-knot` | plasticity_insert_curve_knot |
| `command:subdivide` | plasticity_subdivide_curves |
| `command:split-segment` | plasticity_split_curve_segment |
| `command:isoparam` | plasticity_insert_isoparam_edges |
| `command:unwrap-face` | plasticity_unwrap_face |
| `command:project` | plasticity_project_curves_onto_body |
| `command:project-curve-body` | plasticity_project_curves_onto_body |
| `command:project-curve-curve` | plasticity_project_curve_pair |
| `command:project-outline` | plasticity_create_body_outlines |
| `command:create-outline` | plasticity_create_body_outlines |
| `command:deform` | plasticity_deform_bodies_between_faces / deform_curves_between_faces |
| `command:dissolve` | plasticity_dissolve_faces |
| `command:delete` | plasticity_delete |
| `command:curve-array` | plasticity_curve_pattern |
| `command:radial-array` | plasticity_radial_pattern |
| `command:rectangular-array` | plasticity_rectangular_pattern |
| `command:create-instance` | plasticity_create_instance |
| `command:realize-instances` | plasticity_realize_instances |
| `command:group-selected` | plasticity_create_group |
| `command:export-3-mf` | plasticity_export_3mf |
| `command:export-hidden-line` | plasticity_export_hiddenline_svg |
| `command:export-obj` | plasticity_export_obj |
| `command:export-parasolid` | plasticity_export_parasolid |
| `command:export-step` | plasticity_export_step |
| `command:export-stl` | plasticity_export_stl |
| `command:export-svg` | plasticity_export_svg |
| `command:set-material` | plasticity_set_appearance_material |
| `command:measure-distance` | plasticity_measure_point_distance / create_*_distance_measurement |
| `command:measure-radius` | plasticity_create_radius_measurement / measure_point_to_circular_edge |
| `command:section-analysis` | plasticity_create_section_analysis |
| `command:undo` | plasticity_undo |

## Appendix A: the 53 Factory classes with no name hit in src/

Each class appears once. Class codes: E = covered-equivalent, P = partial, G = gap, N = base/internal. For P and G rows, the grep covered every non-test `src/**/*.ts` file (zero hits for the class name) and the operation file read is named.

| ID | Factory | Category | Class | MCP tool that covers it / closest | Notes (src file checked) |
|---|---|---|---|---|---|
| F1 | AbstractFactory | other/UI-only | n/a (UI-only/internal) | none | base class |
| F2 | AlignAndRebuildFactory | transforms/align | gap | none (closest: plasticity_align_* + plasticity_rebuild_curves) | purpose not verified Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F3 | AlignEdgeFactory | transforms/align | covered-equivalent | plasticity_align_linear_edges | MCP uses MoveItem/RotateItem factories instead |
| F4 | AlignVertexFactory | transforms/align | covered-equivalent | plasticity_align_vertices | same |
| F5 | BridgeSurfaceFactory | surfaces | covered-equivalent | plasticity_bridge_surface | BridgeSurfaceWithPreview used (operations.ts:6847) |
| F6 | CenterRectangleFactory | curves/sketch | covered-equivalent | plasticity_create_rectangle |  |
| F7 | ConstrainedSurfaceWithPreviewFactory | surfaces | covered-equivalent | plasticity_create_constrained_surface | ConstrainedSurface factory used (operations.ts:6915) |
| F8 | ConvertMeshToPolySplinesFactory | surfaces | gap | none |  Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F9 | CornerRectangleFactory | curves/sketch | covered-equivalent | plasticity_create_rectangle |  |
| F10 | CurveWithPreviewFactory | curves/sketch | covered-equivalent | plasticity_create_polyline / plasticity_create_nurbs_curve | Curve factory used; preview variant is UI |
| F11 | CutCurveFactory | curves/sketch | partial | plasticity_trim_curve_fragments / split_curve_segment | see CutCurveCommand Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F12 | DiagonalRectangleFactory | curves/sketch | covered-equivalent | plasticity_create_rectangle |  |
| F13 | DimensionDistanceFactory | measurement/dimensions | partial | plasticity_create_topology_distance_measurement | see DimensionDistanceCommand Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F14 | DimensionPolylineFactory | measurement/dimensions | gap | none |  Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F15 | ExportWebFactory | file/import/export | gap | none | web/glTF-style export (command:export-asset-pack); no tool Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F16 | ExtendEdgeFactory | surfaces | gap | none (closest: plasticity_extend_curve_endpoints, plasticity_extend_sheet_edges) | extend_sheet_edges is linear only (operations.ts:7657: shape=Linear, type=Distance, limit=Minimal hard-coded); native edge extension with continuity not driven; purpose not fully verified Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F17 | ExtrudeSurfaceFactory | surfaces | gap | none (closest: plasticity_extrude_profile closed Wires only) | extrudeProfile rejects open Wires (operations.ts:4882-4890); no curve-to-sheet extrusion Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F18 | FilletCurveFactory | fillets/chamfers | partial | plasticity_fillet_curve_vertices | FilletVertex factory used for vertices of one Wire only Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F19 | FreestyleScaleFaceFactory | transforms/align | covered-equivalent | plasticity_scale_faces | MultiPlanarizingBasicScaleFace used |
| F20 | GeometryFactory | other/UI-only | n/a (UI-only/internal) | none | base class |
| F21 | ImportPolySplinesFactory | surfaces | gap | none |  Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F22 | JoinFacesFactory | surfaces | gap | none (closest: plasticity_join_sheets) | purpose not verified Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F23 | KnifeCenterCircleFactory | booleans/cut | partial | plasticity_imprint_curves_on_body (after create_*), plasticity_cut_with_faces | knife = sketch-and-cut mode; no isKnife=true call anywhere (grep isKnife: only isKnife=false, operations.ts:3528,3571,3627,3673,4144,4199) Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F24 | KnifeCenterRectangleFactory | booleans/cut | partial | plasticity_imprint_curves_on_body (after create_*), plasticity_cut_with_faces | knife = sketch-and-cut mode; no isKnife=true call anywhere (grep isKnife: only isKnife=false, operations.ts:3528,3571,3627,3673,4144,4199) Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F25 | KnifeCornerRectangleFactory | booleans/cut | partial | plasticity_imprint_curves_on_body (after create_*), plasticity_cut_with_faces | knife = sketch-and-cut mode; no isKnife=true call anywhere (grep isKnife: only isKnife=false, operations.ts:3528,3571,3627,3673,4144,4199) Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F26 | KnifeCurveFactory | booleans/cut | partial | plasticity_imprint_curves_on_body (after create_*), plasticity_cut_with_faces | knife = sketch-and-cut mode; no isKnife=true call anywhere (grep isKnife: only isKnife=false, operations.ts:3528,3571,3627,3673,4144,4199) Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F27 | KnifeCurveWithPreviewFactory | booleans/cut | partial | plasticity_imprint_curves_on_body (after create_*), plasticity_cut_with_faces | knife = sketch-and-cut mode; no isKnife=true call anywhere (grep isKnife: only isKnife=false, operations.ts:3528,3571,3627,3673,4144,4199) Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F28 | KnifeThreePointArFactory | booleans/cut | partial | plasticity_imprint_curves_on_body (after create_*), plasticity_cut_with_faces | knife = sketch-and-cut mode; no isKnife=true call anywhere (grep isKnife: only isKnife=false, operations.ts:3528,3571,3627,3673,4144,4199) Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F29 | KnifeThreePointRectangleFactory | booleans/cut | partial | plasticity_imprint_curves_on_body (after create_*), plasticity_cut_with_faces | knife = sketch-and-cut mode; no isKnife=true call anywhere (grep isKnife: only isKnife=false, operations.ts:3528,3571,3627,3673,4144,4199) Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F30 | LineFactory | curves/sketch | covered-equivalent | plasticity_create_polyline |  |
| F31 | LoftFactory | surfaces | covered-equivalent | plasticity_loft_curves / loft_faces / loft_regions | CurveLoft, FaceLoft, RegionLoft used (operations.ts:6535,6605,6702) |
| F32 | LoftGuideFactory | surfaces | covered-equivalent | plasticity_loft_curves (guideIds) | guides supported via guideIds/trimGuides |
| F33 | MoveMeasurementFactory | measurement/dimensions | gap | none |  Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F34 | MultiCurveCutFactory | curves/sketch | partial | plasticity_trim_curve_fragments / split_curve_segment | multi-curve variant of cut curve Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F35 | MultiFilletShellFactory | fillets/chamfers | covered-equivalent | plasticity_fillet | FilletShell used for one body per call |
| F36 | MultiFreestyleScaleControlPointFactory | transforms/align | covered-equivalent | plasticity_scale_curve_control_points | MultiScaleControlPoint used |
| F37 | MultiTransformFactory | transforms/align | covered-equivalent | plasticity_move / rotate / scale |  |
| F38 | OpenBackupFactory | file/import/export | covered-equivalent | plasticity_open_document |  |
| F39 | PhantomCurveFactory | curves/sketch | n/a (UI-only/internal) | none | internal preview/helper curve |
| F40 | PlaceFactory | transforms/align | covered-equivalent | plasticity_duplicate_bodies / plasticity_move | snap placement is UI |
| F41 | PossiblyBooleanCenterBoxFactory | solids/primitives | covered-equivalent | plasticity_create_box (+ plasticity_boolean) | PossiblyBoolean Cylinder/Sphere used; box variants unnecessary |
| F42 | PossiblyBooleanCornerBoxFactory | solids/primitives | covered-equivalent | plasticity_create_box (+ plasticity_boolean) | PossiblyBoolean Cylinder/Sphere used; box variants unnecessary |
| F43 | PossiblyBooleanThreePointBoxFactory | solids/primitives | covered-equivalent | plasticity_create_box (+ plasticity_boolean) | PossiblyBoolean Cylinder/Sphere used; box variants unnecessary |
| F44 | ProjectingFreestyleScaleItemAndEmptyFactory | transforms/align | covered-equivalent | plasticity_scale | ProjectingScaleItemAndEmpty used |
| F45 | RefitFaceFactory | surfaces | covered-equivalent | plasticity_rebuild_face | RebuildFace used; refit probably its internal step (unverified) |
| F46 | RefitSurfaceFactory | surfaces | partial | plasticity_rebuild_face | whole-surface refit without projected trims not exposed Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F47 | RefitTrimFactory | surfaces | partial | plasticity_rebuild_face | trim-curve refit not exposed separately Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F48 | RemoveNominalSurfaceFactory | surfaces | gap | none | no tool Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F49 | ShowFacePointsFactory | view/camera/visibility | gap | none (closest: plasticity_inspect_surface_structure, read-only) | no surface control-point display/edit; list_curve_control_points covers Wires only Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F50 | SquareFactory | curves/sketch | covered-equivalent | plasticity_create_rectangle |  |
| F51 | SweepToolFactory | surfaces | gap | none (closest: plasticity_sweep_regions) | sweep-tool command not driven; purpose not verified Checked: src/plasticity/operations.ts, src/server.ts (no hit). |
| F52 | TransformFactory | transforms/align | covered-equivalent | plasticity_move / rotate / scale |  |
| F53 | XSidedFactory | surfaces | partial | plasticity_patch_closed_wires / patch_solid_edge_loops / patch_sheet_hole | n-sided fills exist; X-sided patch with tangency/continuity options absent Checked: src/plasticity/operations.ts, src/server.ts (no hit). |

## Appendix B: the 126 Command classes with no name hit in src/

| Command | Category | Class | MCP tool that covers it / closest | Notes |
|---|---|---|---|---|
| AlignCommand | transforms/align | partial | plasticity_align_planar_faces / align_cylindrical_faces / align_linear_edges / align_vertices | covers planar+cylinder faces, straight edges, vertices; no curved-edge/free-form align, no AlignAndRebuild Checked: src/plasticity/operations.ts (no hit). |
| AlignEdgeCommand | transforms/align | covered-equivalent | plasticity_align_linear_edges | straight (Line) edges only |
| AlignVertexCommand | transforms/align | covered-equivalent | plasticity_align_vertices |  |
| BoxChangeSelectionCommand | selection | n/a (UI-only/internal) | plasticity_select_bodies / select_faces / select_edges / select_curves / select_nodes | mouse-selection wrapper; programmatic selection exists, click semantics pointless |
| CenterBoxCommand | solids/primitives | covered-equivalent | plasticity_create_box | axis-aligned origin+size |
| CenterRectangleCommand | curves/sketch | covered-equivalent | plasticity_create_rectangle |  |
| ClickChangeSelectionCommand | selection | n/a (UI-only/internal) | plasticity_select_bodies / select_faces / select_edges / select_curves / select_nodes | mouse-selection wrapper; programmatic selection exists, click semantics pointless |
| ClickChooseSelectionCommand | selection | n/a (UI-only/internal) | plasticity_select_bodies / select_faces / select_edges / select_curves / select_nodes | mouse-selection wrapper; programmatic selection exists, click semantics pointless |
| CompleteEdgeCommand | surfaces | gap | none | purpose not verified (probably closes a missing edge of a sheet/wire); probe live before building Checked: src/plasticity/operations.ts (no hit). |
| ContextMenuDeleteCommand | other/UI-only | covered-equivalent | plasticity_delete | context-menu wrapper |
| ContextMenuDissolveCommand | surfaces | covered-equivalent | plasticity_dissolve_faces | context-menu wrapper |
| ContextMenuForkMaterialCommand | materials/render | partial | plasticity_set_appearance_material | no fork/edit of an existing material; can only create a new bounded appearance Checked: src/plasticity/operations.ts (no hit). |
| ContextMenuGroupSelectedCommand | other/UI-only | covered-equivalent | plasticity_create_group |  |
| ContextMenuRemoveMaterialCommand | materials/render | covered-equivalent | plasticity_set_appearance_material | materialId 0 clears the assignment |
| ContextMenuSetMaterialCommand | materials/render | covered-equivalent | plasticity_set_appearance_material |  |
| ContinueLoftEdgeCommand | surfaces | gap | none (closest: plasticity_loft_curves with clamped start/end condition) | purpose not verified; likely continues a loft from an existing sheet edge with tangency Checked: src/plasticity/operations.ts (no hit). |
| ControlPointCurveCommand | curves/sketch | gap | plasticity_create_nurbs_curve (interpolating only) | createNurbsCurve sets only CurveType.NURBS / CurveType.Polyline (operations.ts:3400-3418); no control-point-defined curve Checked: src/plasticity/operations.ts (no hit). |
| ConvertControlPointCommand | curves/sketch | covered-equivalent | plasticity_convert_curve_vertices_to_control_points | ConvertVertex factory used |
| CopyWithPlacementCommand | transforms/align | covered-equivalent | plasticity_duplicate_bodies (+ plasticity_move) | clipboard + snap placement is UI; duplicate with delta exists |
| CornerBoxCommand | solids/primitives | covered-equivalent | plasticity_create_box |  |
| CornerRectangleCommand | curves/sketch | covered-equivalent | plasticity_create_rectangle | center/width/height; corner input is just a different parametrisation |
| CreateInstanceCommand | patterns/arrays | covered-equivalent | plasticity_create_instance | factory used directly |
| CreateMaterialCommand | materials/render | covered-equivalent | plasticity_set_appearance_material | creates a bounded colour/roughness/metalness/opacity material and assigns it |
| CurveArrayCommand | patterns/arrays | covered-equivalent | plasticity_curve_pattern | CurveArray factory used |
| CutCurveCommand | curves/sketch | partial | plasticity_trim_curve_fragments + plasticity_split_curve_segment + plasticity_list_curve_intersections | no single cut-with-curve op; the split can be built from intersections + split + trim. Purpose of native command not verified Checked: src/plasticity/operations.ts (no hit). |
| DblClickChangeSelectionCommand | selection | n/a (UI-only/internal) | plasticity_select_bodies / select_faces / select_edges / select_curves / select_nodes | mouse-selection wrapper; programmatic selection exists, click semantics pointless |
| DeformShellCommand | surfaces | covered-equivalent | plasticity_deform_bodies_between_faces | DeformFace factory used; shell variant not verified separately |
| DeleteEmptyGroupsCommand | other/UI-only | covered-equivalent | plasticity_dissolve_groups | dissolving an empty group removes it |
| DeleteGroupCommand | other/UI-only | covered-equivalent | plasticity_dissolve_groups + plasticity_delete |  |
| DeleteRegionCommand | surfaces | gap | none (closest: plasticity_delete on the boundary Wires) | purpose not verified; Regions are automatic in Plasticity Checked: src/plasticity/operations.ts (no hit). |
| DeselectAllCommand | selection | gap | none | select_* tools require minItems 1 (select_bodies schema ids minItems=1); no way to clear selection Checked: src/plasticity/operations.ts (no hit). |
| DimensionDistanceCommand | measurement/dimensions | partial | plasticity_create_topology_distance_measurement / create_vertex_distance_measurement | measurement creation exists; no dimension-driven distance edit Checked: src/plasticity/operations.ts (no hit). |
| DimensionPolylineCommand | measurement/dimensions | gap | none | no polyline dimension in src (only Distance, Radius, Block, Rectangle) Checked: src/plasticity/operations.ts (no hit). |
| DissolveCommand | surfaces | covered-equivalent | plasticity_dissolve_faces |  |
| DissolvePlaneCommand | surfaces | gap | none (closest: plasticity_dissolve_faces) | purpose not verified; probably dissolves all coplanar faces Checked: src/plasticity/operations.ts (no hit). |
| DuplicateCurveAndProjectCommand | curves/sketch | covered-equivalent | plasticity_duplicate_curves + plasticity_project_curves_onto_body | two steps |
| EditMaterialCommand | materials/render | partial | plasticity_set_appearance_material | cannot edit an existing material, only create a new one Checked: src/plasticity/operations.ts (no hit). |
| Export3mfCommand | file/import/export | covered-equivalent | plasticity_export_3mf |  |
| ExportCadCommand | file/import/export | partial | plasticity_export_step / export_parasolid | only .step/.stp and .x_t/.x_b accepted (operations.ts:8494-8545 exportStep/exportParasolid); IGES and SAT absent Checked: src/plasticity/operations.ts (no hit). |
| ExportIgesCommand | file/import/export | gap | none | exportStep/exportParasolid reject other extensions; ExportCad factory picks format by extension (assumption, unverified) Checked: src/plasticity/operations.ts (no hit). |
| ExportObjCommand | file/import/export | covered-equivalent | plasticity_export_obj |  |
| ExportParasolidCommand | file/import/export | covered-equivalent | plasticity_export_parasolid |  |
| ExportSatCommand | file/import/export | gap | none | same as IGES Checked: src/plasticity/operations.ts (no hit). |
| ExportScreenshotCommand | file/import/export | covered-equivalent | plasticity_screenshot | viewport PNG |
| ExportStepCommand | file/import/export | covered-equivalent | plasticity_export_step |  |
| ExportStlCommand | file/import/export | covered-equivalent | plasticity_export_stl |  |
| ExportSvgCommand | file/import/export | covered-equivalent | plasticity_export_svg |  |
| FilletCommand | fillets/chamfers | covered-equivalent | plasticity_fillet | uses FilletShell factory (constant radius) |
| FilletCurveCommand | fillets/chamfers | partial | plasticity_fillet_curve_vertices | only vertices inside one Wire via FilletVertex factory (operations.ts:5205); curve-to-curve fillet of two separate curves not driven Checked: src/plasticity/operations.ts (no hit). |
| FilterSelectionBySurfaceClassCommand | selection | covered-equivalent | plasticity_find_faces + plasticity_select_faces | find_faces filters by surface type |
| ForkMaterialCommand | materials/render | partial | plasticity_set_appearance_material | cannot fork/edit existing material Checked: src/plasticity/operations.ts (no hit). |
| FreestyleMirrorCommand | transforms/align | covered-equivalent | plasticity_mirror | Freestyle = interactive manipulator; numeric equivalent exists |
| FreestyleMoveControlPointCommand | transforms/align | covered-equivalent | plasticity_move_curve_control_points | Freestyle = interactive manipulator; numeric equivalent exists |
| FreestyleMoveEdgeCommand | transforms/align | covered-equivalent | plasticity_move_edges | Freestyle = interactive manipulator; numeric equivalent exists |
| FreestyleMoveFaceCommand | transforms/align | covered-equivalent | plasticity_move_faces | Freestyle = interactive manipulator; numeric equivalent exists |
| FreestyleMoveItemCommand | transforms/align | covered-equivalent | plasticity_move | Freestyle = interactive manipulator; numeric equivalent exists |
| FreestyleOffsetPlanarCurveCommand | curves/sketch | covered-equivalent | plasticity_offset_planar_curves | Freestyle = interactive manipulator; numeric equivalent exists |
| FreestyleRotateControlPointCommand | transforms/align | covered-equivalent | plasticity_rotate_curve_control_points | Freestyle = interactive manipulator; numeric equivalent exists |
| FreestyleRotateFaceCommand | transforms/align | covered-equivalent | plasticity_rotate_faces | Freestyle = interactive manipulator; numeric equivalent exists |
| FreestyleRotateItemCommand | transforms/align | covered-equivalent | plasticity_rotate | Freestyle = interactive manipulator; numeric equivalent exists |
| FreestyleScaleControlPointCommand | transforms/align | covered-equivalent | plasticity_scale_curve_control_points | Freestyle = interactive manipulator; numeric equivalent exists |
| FreestyleScaleFaceCommand | transforms/align | covered-equivalent | plasticity_scale_faces | Freestyle = interactive manipulator; numeric equivalent exists |
| FreestyleScaleItemCommand | transforms/align | covered-equivalent | plasticity_scale | Freestyle = interactive manipulator; numeric equivalent exists |
| HideSelectedCommand | view/camera/visibility | covered-equivalent | plasticity_set_visibility | explicit ids; "invert/all/isolate" = list_bodies then set |
| HideUnselectedCommand | view/camera/visibility | covered-equivalent | plasticity_set_visibility | explicit ids; "invert/all/isolate" = list_bodies then set |
| HollowCommand | solids/primitives | covered-equivalent | plasticity_hollow_faces / plasticity_hollow_solids |  |
| ImportAssetCommand | file/import/export | gap | none | asset-library import (namespace assets:*); low value Checked: src/plasticity/operations.ts (no hit). |
| ImportPolySplinesCommand | surfaces | gap | none | PolySplines not exposed at all Checked: src/plasticity/operations.ts (no hit). |
| ImportWithPlacementCommand | file/import/export | covered-equivalent | plasticity_import_step (+ plasticity_move) |  |
| ImprintCommand | booleans/cut | covered-equivalent | plasticity_imprint_bodies / plasticity_imprint_curves_on_body |  |
| InvertHiddenCommand | view/camera/visibility | covered-equivalent | plasticity_set_visibility | explicit ids; "invert/all/isolate" = list_bodies then set |
| JoinCommand | curves/sketch | covered-equivalent | plasticity_join_curves / plasticity_join_sheets |  |
| JoinFacesCommand | surfaces | gap | none (closest: plasticity_join_sheets, plasticity_dissolve_faces) | purpose not verified Checked: src/plasticity/operations.ts (no hit). |
| JoinVerticesCommand | curves/sketch | gap | none (closest: plasticity_bridge_curve_vertices, plasticity_join_curves) | purpose not verified Checked: src/plasticity/operations.ts (no hit). |
| LineCommand | curves/sketch | covered-equivalent | plasticity_create_polyline | CurveFactory Polyline |
| LockSelectedCommand | view/camera/visibility | covered-equivalent | plasticity_set_locked |  |
| ManageMySharedDocumentsCommand | other/UI-only | n/a (UI-only/internal) | none | account/sharing UI; pointless |
| MeasureContinuityCommand | measurement/dimensions | covered-equivalent | plasticity_analyze_surface_continuity | MeasureContinuity factory used |
| MeasureMoveFaceCommand | measurement/dimensions | covered-equivalent | plasticity_move_faces | numeric delta |
| MeasureMoveItemCommand | measurement/dimensions | covered-equivalent | plasticity_move |  |
| MoveCommand | transforms/align | covered-equivalent | plasticity_move |  |
| MoveMeasurementCommand | measurement/dimensions | gap | none | create_*_measurement take no offset; label offset of existing measurement cannot be moved Checked: src/plasticity/operations.ts (no hit). |
| MoveToGroupCommand | other/UI-only | covered-equivalent | plasticity_move_to_group |  |
| NavigationCommand | view/camera/visibility | partial | plasticity_set_view | 7 named views + fit only (set_view schema); no orbit/pan/zoom/zoom-to-selection Checked: src/plasticity/operations.ts (no hit). |
| OffsetCurveCommand | curves/sketch | covered-equivalent | plasticity_offset_planar_curves | planar Wires only |
| OpenBackupCommand | file/import/export | covered-equivalent | plasticity_open_document | backups are .plasticity files (assumption) |
| OutlinerChangeSelectionCommand | selection | n/a (UI-only/internal) | plasticity_select_bodies / select_faces / select_edges / select_curves / select_nodes | mouse-selection wrapper; programmatic selection exists, click semantics pointless |
| PasteCommand | transforms/align | covered-equivalent | plasticity_duplicate_bodies |  |
| PasteWithPlacementCommand | transforms/align | covered-equivalent | plasticity_duplicate_bodies (+ plasticity_move) |  |
| PatchHoleInSheetCommand | surfaces | covered-equivalent | plasticity_patch_sheet_hole | PatchHoleInSheet factory used |
| PatchRegionCommand | surfaces | covered-equivalent | plasticity_patch_regions | PatchRegion factory used |
| PolySplinesCommand | surfaces | gap | none | no PolySplines/subdivision workflow in src Checked: src/plasticity/operations.ts (no hit). |
| PopIsolationCommand | view/camera/visibility | covered-equivalent | plasticity_set_visibility | explicit ids; "invert/all/isolate" = list_bodies then set |
| ProjectCommand | curves/sketch | covered-equivalent | plasticity_project_curves_onto_body / plasticity_project_curve_pair |  |
| ProjectOutlineCommand | curves/sketch | covered-equivalent | plasticity_create_body_outlines |  |
| PushFaceCommand | transforms/align | covered-equivalent | plasticity_move_faces / plasticity_offset_faces |  |
| RadialArrayItemsCommand | patterns/arrays | covered-equivalent | plasticity_radial_pattern |  |
| RaiseDegreeCommand | curves/sketch | covered-equivalent | plasticity_raise_curve_degree / plasticity_raise_surface_degree |  |
| RebuildCommand | curves/sketch | covered-equivalent | plasticity_rebuild_curves / plasticity_rebuild_face |  |
| RectangularArrayItemsCommand | patterns/arrays | covered-equivalent | plasticity_rectangular_pattern |  |
| RemoveEmptyCommand | other/UI-only | covered-equivalent | plasticity_dissolve_groups | assumes it removes empty groups; unverified |
| RemoveItemCommand | other/UI-only | covered-equivalent | plasticity_delete |  |
| RemoveMaterialCommand | materials/render | covered-equivalent | plasticity_set_appearance_material | materialId 0 unassigns; deleting the material definition itself is not exposed |
| RepeatPasteWithPlacementCommand | transforms/align | covered-equivalent | plasticity_duplicate_bodies (+ plasticity_move) |  |
| RotateCommand | transforms/align | covered-equivalent | plasticity_rotate |  |
| ScaleCommand | transforms/align | covered-equivalent | plasticity_scale |  |
| SectionAnalysisCommand | measurement/dimensions | covered-equivalent | plasticity_create_section_analysis |  |
| SelectAllWithMaterialCommand | materials/render | covered-equivalent | plasticity_list_appearance_materials + plasticity_select_bodies |  |
| SetMaterialCommand | materials/render | covered-equivalent | plasticity_set_appearance_material |  |
| SetMaterialOfSelectedCommand | materials/render | covered-equivalent | plasticity_set_appearance_material |  |
| SetNameCommand | other/UI-only | covered-equivalent | plasticity_rename |  |
| SetNameOfMaterialCommand | materials/render | gap | none | name only settable when creating a material Checked: src/plasticity/operations.ts (no hit). |
| SquareCommand | curves/sketch | covered-equivalent | plasticity_create_rectangle | equal width/height |
| SquareEdgeCommand | transforms/align | gap | none | purpose not verified Checked: src/plasticity/operations.ts (no hit). |
| SquareFaceCommand | transforms/align | gap | none | purpose not verified Checked: src/plasticity/operations.ts (no hit). |
| ThickenCommand | solids/primitives | covered-equivalent | plasticity_thicken_faces / plasticity_thicken_sheets |  |
| ToggleCurvatureCommand | view/camera/visibility | n/a (UI-only/internal) | plasticity_analyze_edge_curvature (data only) | display toggle; pointless via MCP |
| ToggleHiddenCommand | view/camera/visibility | covered-equivalent | plasticity_set_visibility | explicit ids; "invert/all/isolate" = list_bodies then set |
| ToggleSelectableCommand | view/camera/visibility | covered-equivalent | plasticity_set_locked | approximation |
| ToggleVisibilityCommand | view/camera/visibility | covered-equivalent | plasticity_set_visibility | explicit ids; "invert/all/isolate" = list_bodies then set |
| UngroupSelectedCommand | other/UI-only | covered-equivalent | plasticity_dissolve_groups |  |
| UnhideAllCommand | view/camera/visibility | covered-equivalent | plasticity_set_visibility | explicit ids; "invert/all/isolate" = list_bodies then set |
| UnjoinCommand | curves/sketch | covered-equivalent | plasticity_unjoin_curves / unjoin_faces / unjoin_shells |  |
| UseMaterialCommand | materials/render | covered-equivalent | plasticity_set_appearance_material |  |
| ViewportPointControl_MoveControlPointCommand | other/UI-only | n/a (UI-only/internal) | plasticity_move_curve_control_points | gizmo drag wrapper |
| XNurbsCommand | surfaces | gap | none (closest: plasticity_create_constrained_surface, plasticity_patch_closed_wires) | no XNurbs in src Checked: src/plasticity/operations.ts (no hit). |

## Appendix C: name-used classes downgraded to partial

| Class | Kind | MCP tool | What is missing |
|---|---|---|---|
| CurveCommand | Command | plasticity_create_polyline / create_nurbs_curve | only CurveType.Polyline and CurveType.NURBS (interpolating); control-point curve missing |
| CutCommand | Command | plasticity_cut_with_faces | planar cutter faces only; cutWithFaces throws on non-planar (operations.ts:4656) |
| ExtendSheetCommand | Command | plasticity_extend_sheet_edges | shape fixed to Linear, type Distance, limit Minimal (operations.ts:7650-7657); no bias1/bias2 (commands.json extend-sheet:bias1/bias2), no tangent/natural shape, no extend-to-target |
| ExtrudeCommand | Command | plasticity_extrude_faces / extrude_profile / extrude_regions | only factory.distance1 set (operations.ts:4864-4930; commands.json also lists extrude:angle1, extrude:shear, extrude:thickness); no two-sided distance, draft, direction, open-curve-to-sheet |
| SpiralCommand | Command | plasticity_create_helix | constant radius only (operations.ts:3422-3460; commands.json lists spiral:angle/length/radius) |
| SweepCommand | Command | plasticity_sweep_regions | closed Regions + one Wire spine only (operations.ts:6412-6485); no open-profile sweep to sheet, rails, or sweeping faces |
| CurveFactory | Factory | plasticity_create_polyline / create_nurbs_curve | same |
| ExtendSheetFactory | Factory | plasticity_extend_sheet_edges | shape fixed to Linear, type Distance, limit Minimal (operations.ts:7650-7657); no bias1/bias2 (commands.json extend-sheet:bias1/bias2), no tangent/natural shape, no extend-to-target |
| ExtrudeFactory | Factory | plasticity_extrude_faces / extrude_profile / extrude_regions | only factory.distance1 set (operations.ts:4864-4930; commands.json also lists extrude:angle1, extrude:shear, extrude:thickness); no two-sided distance, draft, direction, open-curve-to-sheet |
| KnifeCenterPointArcFactory | Factory | plasticity_create_two_point_circle / three_point_circle / center_arc / tangent_arc / ellipse / regular_polygon | factory used only as a sketch creator with isKnife=false (operations.ts:3528,3571,3627,3673,4144,4199); knife mode never enabled |
| KnifeEllipseFactory | Factory | plasticity_create_two_point_circle / three_point_circle / center_arc / tangent_arc / ellipse / regular_polygon | factory used only as a sketch creator with isKnife=false (operations.ts:3528,3571,3627,3673,4144,4199); knife mode never enabled |
| KnifePolygonFactory | Factory | plasticity_create_two_point_circle / three_point_circle / center_arc / tangent_arc / ellipse / regular_polygon | factory used only as a sketch creator with isKnife=false (operations.ts:3528,3571,3627,3673,4144,4199); knife mode never enabled |
| KnifeThreePointCircleFactory | Factory | plasticity_create_two_point_circle / three_point_circle / center_arc / tangent_arc / ellipse / regular_polygon | factory used only as a sketch creator with isKnife=false (operations.ts:3528,3571,3627,3673,4144,4199); knife mode never enabled |
| KnifeTwoPointCircleFactory | Factory | plasticity_create_two_point_circle / three_point_circle / center_arc / tangent_arc / ellipse / regular_polygon | factory used only as a sketch creator with isKnife=false (operations.ts:3528,3571,3627,3673,4144,4199); knife mode never enabled |
| MultiCutFactory | Factory | plasticity_cut_with_faces | planar cutter faces only |
| SpiralFactory | Factory | plasticity_create_helix | constant radius only (operations.ts:3422-3460; commands.json lists spiral:angle/length/radius) |
| SweepFactory | Factory | plasticity_sweep_regions | closed Regions + one Wire spine only (operations.ts:6412-6485); no open-profile sweep to sheet, rails, or sweeping faces |
