# Manual commands vs MCP tools (2026-11-16)

A read-only pass comparing `plasticity-manual-index*.md` with the tool registrations in `src/server.ts` at commit 1f4ae9e. Treat rows as leads: they were judged from schemas and descriptions, not from live runs. Supersedes `discovery/COVERAGE.md`.


**1. Coverage table (manual name | tools | status)**

Arc (Center Point) | create_center_arc | F
Arc (Tangent) | create_tangent_arc | F
Arc (Three-Point) | create_three_point_arc | F
Boolean | boolean | P: no per-side material Default/Empty/Inside/Outside
Box (Center) | none | N
Box (Corner) | create_box | F
Box (Three Point) | none | N
Bridge (router) | bridge_curves/bridge_shell_edges/bridge_curve_vertices | P
Bridge Curve | bridge_curves | P: no tension, trim
Bridge Edge | bridge_shell_edges | P: no tension, trim
Bridge Surface | bridge_surface | P: no sense, trim walls, Chamfer shape, add-pair
Bridge Vertex | bridge_curve_vertices | P: no tension, trim
Circle (Center) | create_circle | F
Circle (Tangent) | create_tangent_circle | F
Circle (Three-Point) | create_three_point_circle | F
Circle (Two-Point) | create_two_point_circle | F
Complete Edge | none | N
Constrained Surface | create_constrained_surface | P: Optimize mode not in schema
Control Point Curve | create_control_point_curve | F
Convert Vertex | convert_curve_vertices_to_control_points | F
Copy With Placement | none | N
Create Curve Instance | none | N
Create Instance | create_instance | F
Create Outline | create_body_outlines | F
Create Solid and Sheet Instance | create_instance/create_mirrored_instance | F
Curve Array | curve_pattern | P: count only; no spacing/extent/ratio, no instances
Cut | cut_with_faces/cut_with_curves | F
Cut Curve | split_curve_segment/knife_curve | P: no curve-cut by curve
Cylinder | create_cylinder | F
Deform | deform_bodies_between_faces | P: no UVN scale, flip, reblend
Deform Curve | deform_curves_between_faces | P: same gaps
Deform Solid and Sheet | deform_bodies_between_faces | P: same gaps
Delete Face | delete_faces | F
Delete Redundant Topology | none | N
Dimension | set_driving_distance | P: parallel planar faces only
Draft Face | draft_faces | P: planar neutral only; no taper modes, Grow
Duplicate | duplicate_bodies | F
Duplicate Curve and Project | project_curves_onto_body | F
Edge Align | align_linear_edges | P: Line edges only, no surface solvers
Ellipse | create_ellipse | F
Export Hidden Line | export_hiddenline_svg | P: no dash/gap, hatch, tolerance
Extend (router) | extend_curve_endpoints/extend_sheet_edges | F
Extend Curve | extend_curve_endpoints | F
Extend Sheet | extend_sheet_edges | P: no Limit Minimal/Outside/Inside
Extrude | extrude_faces/extrude_profile/extrude_regions/extrude_curves | P: no boolean keys, Individual/Direct, lock distances, Freestyle
Fillet | fillet | F
Fillet Curve | fillet_curves | F
Fillet Shell | fillet/chamfer | P: no tangent edges, variable/limit points, tension, Apex
Fillet Vertex | fillet_curve_vertices | P: curve vertices only
Find Boundary Edges | none (find_edges has no open-edge filter) | N
Fork Material | none | N
Hollow | hollow_faces/hollow_solids | P: no Local option
Imprint (router) | imprint_bodies/imprint_curves_on_body | F
Imprint Body Body | imprint_bodies | P: no Complete target/tool
Imprint Curve Body | imprint_curves_on_body | P: Completion not seen in schema
Insert Knot | insert_curve_knot | F
Isoparam | insert_isoparam_edges | P: no Subdivide flag
Join | join_curves/join_sheets | F
Join Curves | join_curves | F
Line | create_polyline | F
Loft | loft_curves/loft_faces/loft_regions | P: no limit point; no per-end G0/G1/G2
Match Face | match_faces | P: no Grow, Side
Measure Continuity | analyze_surface_continuity | F
Measure Distance | measure_point_distance/measure_linear_edges | F
Measure Radius | create_radius_measurement | F
Mirror | mirror/create_mirrored_instance | P: no slice, union
Move | move/move_faces/move_edges | P: no proportional falloff, pivot/orientation
Offset Curve | offset_planar_curves | P: planar Wires only
Offset Edge | offset_edges | F
Offset Face | offset_faces | P: no Angle Adjacent, Grow
Offset Face Loop | offset_face_loops | F
Offset Planar Curve | offset_planar_curves | F
Offset Region | offset_regions | F
Offset Vertex | offset_vertices | F
Paste With Placement | none | N
Place | none | N
Polygon | create_regular_polygon | F
PolySpline | convert_reference_mesh_to_polysplines | P: no Rounded Corners
Project (router) | project_curves_onto_body/project_curve_pair/create_body_outlines/create_body_intersection_curves | F
Project Body Body | create_body_intersection_curves | F
Project Curve Body | project_curves_onto_body | F
Project Curve Curve | project_curve_pair | F
Project Outline | create_body_outlines | F
Publish to Plasticity Share | none | N
Radial Array | radial_pattern/radial_face_pattern | P: Total mode only; no Spacing, instances
Raise Curve Degree | raise_curve_degree | F
Raise Degree | raise_curve_degree/raise_surface_degree | F
Realize Curve Instances | none | N
Realize Instances | realize_instances | F
Realize Solid and Sheet Instances | realize_instances | F
Rebuild | rebuild_curves/rebuild_face | P: surfaces tolerance-only
Rebuild Curve | rebuild_curves | F
Rebuild Face | rebuild_face | P: no explicit degree/spans/extend/shrink
Rectangle (Center) | create_rectangle | F
Rectangle (Corner) | none (schema centre mode only, 1692) | N
Rectangle (Three Point) | none | N
Rectangular Array | rectangular_pattern/rectangular_face_pattern | P: no Extent mode, instances
Remove Fillets From Shell | remove_fillets | P: no Max Radius, Convexity
Remove Material | set_appearance_material (materialId 0) | P: appearance only
Remove Nominal Surface | none | N
Reverse | reverse_curves/reverse_sheets | F
Reverse Curve | reverse_curves | F
Reverse Sheet | reverse_sheets | F
Revolve | revolve_profile | P: no Normal/Binormal/Tangent axis modes, boolean keys; Wires only
Rotate | rotate/rotate_faces | F
Scale | scale/scale_faces | F
Section Analysis | create/list/delete_section_analysis | F
Set Material | set_appearance_material | P: appearance only
Slide | slide_curve_control_points | P: curves only
Slide Curve CV | slide_curve_control_points | F
Slide Surface CV | none | N
Slot | create_slot_profiles | F
Sphere | create_sphere | F
Spiral | create_helix | P: 3D helix only
Spline Curve | create_nurbs_curve | F
Split Segment | split_curve_segment | F
Square | none | N
Subdivide | subdivide_curves | P: curves only
Surface Align | align_linear_edges | N: rigid Line placement only
Sweep | sweep_regions/sweep_curves | P: sweep_curves lacks alignment, corner
Text | create_text | F
Thicken | thicken_sheets | F
Thicken Face | thicken_faces | F
Toggle Curvature | none | N
Toggle Curve Curvature | analyze_edge_curvature | P: numeric, no comb
Toggle Points | show_face_control_points | P: faces only
Toggle Surface Curvature | none | N
Trim | trim_curve_fragments | F
Unjoin | unjoin_curves/unjoin_faces/unjoin_shells | F
Unjoin Curve | unjoin_curves | F
Unjoin Faces | unjoin_faces | F
Unjoin Shells | unjoin_shells | F
Untrim | untrim_faces | P: no Keep edges
Unwrap Face | unwrap_face | P: analytic cylinder only
Vertex Align | align_vertices | N: rigid body translate, not G0-G3
xNURBS | xsided_patch | P: no quad, flatness, tension, quality, boundary
Patch (part 1) | patch_regions/patch_closed_wires/patch_sheet_hole/patch_solid_edge_loops/xsided_patch | P: no Faces mode, planar continuity, Method
Pipe | create_pipes | P: circular only; no vertex count, custom profile
Project Align | none | N/A (26.2)
Shader Mode | none | N
Constraint System | none | N
Assets (Toggle Asset, Export Asset Pack) | none | N

**2. Counts (143 rows above)**
- Full: 67
- Partial: 50
- None: 25 (includes Shader Mode, Constraint System, Assets)
- N/A (26.2): 1 (Project Align)
- Caveat: the manual's section D list has 142 names and the part-1 extras are added. The row count is my reconciliation, not a checked diff.

**3. Gaps ranked**
(a) Surfacing
- Surface Align: needs edge-to-edge G0-G2 with solver, blend, tension. Closest: align_linear_edges, which is rigid and Line-only (server.ts:3182).
- Vertex Align: needs curve-end G0-G3. Closest: align_vertices (3180), body translation only.
- Edge Align: dispatcher with 26.2 solvers. Partial via align_linear_edges.
- Square and Project Align: none. Project Align is 26.2-only.
- Shader modes: none. Closest numeric samplers: analyze_surface_continuity (3474), analyze_edge_curvature (3470).
- Find Boundary Edges: none. find_edges (3320) has no open-edge filter.
- Slide Surface CV: none. Slide exists for curves only (4169).
- Subdivide: curves only (4091).
- Rebuild Face: tolerance-only (4393). Manual needs degree, spans, extend, shrink.
- Loft: no limit point, no per-end G0/G1/G2. Schema uses a curvature enum (4318).
(b) Assembly
- Place, Copy/Paste With Placement: none.
- Curve Array: curve_pattern (4593) is count-only.
- Instances: create, realize, move, rotate, scale covered. Arrays cannot make instances.
- Groups, hide, lock: covered (3524-3539). Isolate or focus: none.
- Materials: set_appearance_material only. Fork has no tool.
(c) Drafting
- Export Hidden Line: no dash or hatch options (4692).
- Section Analysis: full.
- Text: full. Manual options are not indexed.
- Dimension: parallel faces only (4149).

**4. Description and schema mismatches (concrete only)**
- create_pipes (4504): no caution that Pipe is approximate. Manual says use Sweep for exact work (A3 Pipe row). Also no vertex-count or custom profile.
- loft_curves (4318): manual continuity is G0/G1/G2. Schema is a natural/unconstrained/clamped curvature enum. Mismatch.
- project_curves_onto_body (4213): no Normal method (imprint_curves_on_body has projectionMethod vector|normal). Completion uses "face-set"; manual says "Boundary".
- unwrap_face (4412): manual says the flattened face lands at world origin. Tool says Plasticity chooses placement. Restricted to cylinders.
- join_sheets (4380): no caution that edges must align exactly. Manual says solid result if closed.
- create_helix (3822): manual Spiral is a 2D sketch command. Tool is 3D helix.
- chamfer (4039) vs fillet (4033): manual uses negative distance for chamfer in Fillet Shell. Tools are split and chamfer rejects non-positive values.
- sweep_curves (4296): no alignment or corner options that sweep_regions (4282) has.
- revolve_profile (4513): Wire profiles only. Manual revolves regions too.
- boolean (4009): no slice or region operation.
- mirror (4577): no union or slice.
- bridge_curves (3882), bridge_surface (4370): no tension or trim options.
- extrude_faces (4049): no boolean keys, no lock-distance option.
- curve_pattern (4593), rectangular_pattern (4579), radial_pattern (4591): no spacing-or-extent modes and no instance option.
- move (3946): no proportional falloff or pivot.
- hollow_faces (4567), hollow_solids (4569): no Local option.
- imprint_bodies (4273): no Complete target or tool option.
- draft_faces (4517): planar neutral only. No taper modes.
- match_faces (4400): no Grow or Side option.
- offset_faces (4519): no Angle Adjacent or Grow.
- set_appearance_material (4027): tool says appearance-only. Manual Set Material is material assignment. This is a semantic difference.
- untrim_faces (4255): no Keep-edges option.
