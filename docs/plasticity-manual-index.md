# Plasticity manual index (condensed, in our own words)

Source: https://doc.plasticity.xyz as read on 2026-11-16 (manual for 26.2). This is a summary with links, not a copy of the manual. Entries marked (idx) were taken from index descriptions only.


Method and coverage caveat: I read the home, whats-new, all-commands, the four command index pages (solid, sketch, common, tool), essentials, cad-essentials, licence, install, import-export, the Blender pages, preferences, shader mode, constraints, assets, and about 45 individual command pages. The pages were read through a page-question extractor, so "not stated" below means the extractor found nothing, not that the page is silent. The remaining roughly 90 command pages are listed from the section index descriptions only and are marked (idx). Base URL abbreviations: S = https://doc.plasticity.xyz/solid/, K = .../sketch/, C = .../common/, T = .../tool/, E = .../plasticity-essentials/.

## 1. Command index
★ = surface quality or continuity.

**Curves and sketching (K, T)**
| Command | What it does | Options named | URL |
|---|---|---|---|
| Line, Spline Curve, Control Point Curve | Draw polylines, interpolated splines, CV splines | (idx) | T line, spline-curve, control-point-curve |
| Circle (centre, 2-pt, 3-pt, tangent), Ellipse | Circle and ellipse sketching | (idx) | T center-circle … ellipse |
| Arc (centre-point, 3-pt, tangent), Polygon, Spiral, Rectangle (corner, centre, 3-pt) | Arc, polygon, spiral, rectangle sketching | (idx) | T center-point-arc … three-point-rectangle |
| Text | Editable text as curves | (idx) | K text |
| Bridge Curve ★ | Connect two curves with a new curve | Start and end continuity G0–G3 (Tab cycles); tension G1/G2/G3; Trim (Q); Show curvature; Create Constraints; 26.2 gizmo sets endpoints and sense | K bridge-curve |
| Bridge, Bridge Edge ★, Bridge Vertex ★ | Bridge curves, edges or vertices | G0–G3, constraint option (Studio) | K bridge, bridge-edge, bridge-vertex |
| Vertex Align ★ | Align a vertex or curve end to a target | G0–G3; P toggles partial alignment; constraint option | K vertex-align |
| Fillet Curve, Fillet Vertex, Fillet | 2D fillets on curves or vertices | (idx) | K fillet-curve, fillet-vertex |
| Offset Curve, Offset Planar Curve, Offset Region, Offset Vertex, Slot | Offset curves, regions and vertices; slot profile | 26.2: vertex offset can pass adjacent vertices | K offset-* , slot |
| Trim, Cut Curve, Split Segment | Trim or split curves | (idx) | K trim, cut-curve, split-segment |
| Extend, Extend Curve | Extend open curve ends | (idx) | K extend, extend-curve |
| Join, Join Curves, Unjoin, Unjoin Curve | Join or separate curves | (idx) | K join… |
| Project, Project Body Body, Project Curve Body, Project Curve Curve, Project Outline, Duplicate Curve and Project, Create Outline | Project curves, intersections or silhouettes onto surfaces or planes | (idx) | K project* |
| Convert Vertex, Insert Knot, Rebuild (Curve), Raise (Curve) Degree, Reverse (Curve), Delete Redundant Topology | Curve rebuild and refine | Point count, degree (idx) | K convert-vertex … |
| Deform, Deform Curve, Slide, Slide Curve CV | Deform and slide curves | 26.2: Deform accepts curves as reference and target | K deform, slide |
| Toggle Curve Curvature ★, Toggle Points | Curvature combs; show CVs | Comb scale; 26.2 autosize combs button in Curvature panel | K toggle-curve-curvature |

**Solids and primitives (S, T)**
| Command | What it does | Options | URL |
|---|---|---|---|
| Box (corner, centre, 3-pt), Sphere, Cylinder | Primitives | (idx) | T corner-box … cylinder |
| Extrude | Faces, edges or regions give solids; curves give sheets | Boolean keys: Q union, W difference, Shift+E intersect, Shift+Q slice, B new body, T keep tools. Distance, angle, thickness. F freestyle, S lock distances (equal both sides), I individual (each face along its own normal) versus direct (one shared direction) | S extrude |
| Revolve | Regions give solids, curves give solids or sheets | Axis options Normal/Binormal/Tangent; degrees; A angle; same boolean keys | S revolve |
| Sweep | Profile along path | Twist, scale, alignment Parallel/Normal, corner Mitre/Round, guide Point/Chord/Curve; Shift+P; default distance 1.00 | S sweep |
| Pipe | Pipe solid along curve | (idx) | S pipe |
| Hollow | Open void from a face, or closed hollow from a solid | Thickness, Local; inward or outward default not stated | S hollow |
| Create/Realize Instance (plus Solid and Sheet variants) | Reusable instances; convert to real geometry | 26.2: all snaps work on instances | S create-instance, realize-instances |

**Surfacing (S)**
| Command | What it does | Options | URL |
|---|---|---|---|
| Loft ★ | Surface through 2 or more curves or edges, optional guides | Continuity G0/G1/G2 (Tab cycles), Tension (D), Simplify, Trim overlap, Loop (3+ curves), add Limit Point (L); inputs may be curves, edges, regions, faces, vertices; shortcut L | S loft |
| Patch ★ | Fill boundary or hole | Continuity Planar/G0/G1/G2; Tolerance; Faces Single/Minimal/Quality; Method trim to hole or sheet | S patch |
| Bridge Surface ★ | G2-style blend between two sheets or surfaces | Width, Tension, Shape G2/Chamfer, Trim walls Both/Short/Long/None, Sense, A adds wall pair | S bridge-surface |
| xNURBS ★ | High-quality N-sided or quad surface from boundary edges | Quad sided, Flatness, Tension, Boundary Natural/Normal/Next/Adjacent, Quality Auto/High/Max, Satisfy tolerances, continuity G0/G1/G2 | S xnurbs |
| Square ★ | xNURBS-based untrimmed quad surface; loft, sweep, patch and refit via Square | Flatness, tension, degree, spans, boundary, weight, analysis; continuity Free/G0/G1/G2; 26.2 accepts a single-rectangular-face sheet | S square |
| Constrained Surface | Surface through clicked points | Tolerance, angular tolerance, Optimize Performance/Smoothness | S constrained-surface |
| PolySpline ★ | Mesh (OBJ or FBX) to untrimmed G2 spline surface | Rounded Corners, Merge Patches, Interpolate Boundary Exactly; quad-dominant meshes best; no support for creases or bevels from DCC tools; 26.2 adds CV move and duplicate in point mode | S polyspline |
| Alternative Duplicate | Make solid from surface fragments | (idx) | S alternative-duplicate |

**Sheets and surface editing (S)**
| Command | What it does | Options | URL |
|---|---|---|---|
| Extend Sheet | Extend sheet boundary edges | Shape Natural/Linear/Soft/Reflective; Limit Minimal/Outside/Inside; D distance; Tab cycles shape; Modify (26.2) | S extend-sheet |
| Extend | Extend open edge or boundary | (idx) | S extend |
| Thicken, Thicken Face | Sheet to solid | Per-side thickness, S lock distances, D thickness | S thicken |
| Edge Align ★ | Dispatcher: two surface edges run Surface Align; vertices or curves run Vertex Align | 26.2: solvers incl. Collinear (Symmetric or Asymmetric), Skew boundary (needs G1+), B and P keys, continuity G0–G3 | S edge-align |
| Surface Align ★ | Move target edge to reference edge | G0/G1/G2; solver, blending, tension, partial alignment, boundary, rebuild, symmetry, analysis, Create Constraints; select the edge to move first, then the reference | S surface-align |
| Project Align ★ (26.2) | Align CVs on target edge to reference along vector or normal | Solver Constrained or xNURBS; continuity G0/G1/G2; Perpendicular; Blend extra rows; Projection Normal or Vector; S screen space; Tab cycle; order: target edge, reference surface, optional reference curve | S project-align |
| Match Face ★ | Replace selected faces with another face | Grow Moving/Fixed/None, Side; order: faces to match, then replacement surface | S match-face |
| Rebuild Face, Rebuild, Isoparam, Raise (Surface) Degree | Rebuild control structure | Explicit U/V degree, spans, extend, shrink (Explicit control is Studio) | S rebuild-face, isoparam |
| Reverse, Reverse Sheet | Flip normals | (idx) | S reverse |
| Untrim, Unwrap Face, Slide, Slide Surface CV, Deform (+Solid and Sheet) | Untrim; flatten; slide or deform surfaces | 26.2: Slide has proportional falloff | S untrim, slide, deform |
| Delete Face, Delete Redundant Topology, Remove Fillets from Shell, Remove Nominal Surface | Cleanup | Remove Nominal Surface also removes PolySpline CVs (destructive) | S delete-face … |
| Imprint (Curve Body, Body Body) | Imprint curve or intersection onto body | Dispatcher by selection | S imprint |
| Join, Join Sheets, Unjoin, Unjoin Faces, Unjoin Shells | Join or split bodies | 26.2: J key in Outliner | S join … |
| Find Boundary Edges | Highlight open edges | (idx) | S find-boundary-edges |
| Draft Face ★ | Draft angle on faces | Taper Isocline/Curve/Surface/Offset/Normal; Grow; neutral face is the first selection; angle via degrees or A | S draft-face |

**Fillet, chamfer, offset (S)**
| Command | What it does | Options | URL |
|---|---|---|---|
| Fillet | Dispatcher: curves give Fillet Curve, vertices give Fillet Vertex, edges give Fillet Shell | Auto-invoked on edge selection (default on in Preferences) | S fillet |
| Fillet Shell ★ | Fillet or chamfer on edges | Positive distance = fillet, negative = chamfer. Fillet shape Conic/Chordal/G2/Full; chamfer shape Offset/Apex; tension; Y-blend attempt; add tangent edges (T); variable point V; limit point L; chamfer angle A | S fillet-shell |
| Offset Face, Offset Face Loop, Offset Edge | Offset faces or edges | Distance, Angle Adjacent, Grow Moving/Fixed/None; sign not stated | S offset-face |

**Boolean and cut (S)**
| Command | What it does | Options | URL |
|---|---|---|---|
| Boolean | Union, difference, intersect, slice, region over solids and sheets | Keep Tools; advanced target and tool material Default/Empty/Inside/Outside; separate "target" and "tool" selection steps; 26.2 failure area highlighted red | S boolean |
| Cut | Cut solid or sheet with a curve or face | C; S screen-space direction; E extend cutter | S cut |

**Transform, pattern, mirror (C)**
| Command | What it does | Options | URL |
|---|---|---|---|
| Move | Translate | Orientation Normal/Pivot/CPlane/World; pivot Bbox/Median/Active; proportional falloff; mirror None/X/Y/Z; keys G, X/Y/Z, Shift+axis (plane), F, V, W; auto-invoked on selection (26.2, can disable) | C move |
| Rotate | Rotate | Angle, axis, orientation, pivot; R, X/Y/Z, G, F, V, W; angle sign not stated | C rotate |
| Scale | Scale | XYZ values; uniform S; same orientation and pivot options | C scale |
| Mirror | Mirror with optional slice and union | Cut down mirror plane, Union (Q), Make Instances (I), Freestyle (F), X/Y/Z positive, Shift+axis negative; Alt+X | C mirror |
| Duplicate, Curve Array, Radial Array, Rectangular Array, Copy/Paste with Placement, Place | Copies and patterns | Rectangular: mode Extent or Spacing, distance 1 and 2, number, Make instances (I) | C rectangular-array … |
| Set, Fork, Remove Material | Material assignment | (idx) | C set-material … |

**Dimensions and measuring**
| Command | What it does | Options | URL |
|---|---|---|---|
| Dimension | Show and edit dimension values on edge, face or solid | Tab switches between dimensions, Enter confirms; whether it drives geometry is not stated | C dimension |
| Measure Distance, Radius | Measurements | (idx) | T measure, measure-radius |
| Measure Continuity ★ | Continuity comb between two touching surface edges | Verifies G0/G1/G2; results placed under Measurements in Outliner | T measure-continuity |
| Section Analysis | Virtual slice through a model | Plane Selection/Previous/CPlane, distance, flip | C section-analysis |
| Complete Edge, Subdivide | Complete an open edge; subdivide | (idx) | C complete-edge, subdivide |

**Constraints, assets, import/export, analysis**
| Command | What it does | Options | URL |
|---|---|---|---|
| Constraint System ★ | Live links between geometry (Studio, session only) | See section 2 | E constraint-system |
| Toggle Asset, Export Asset Pack, Place | Mark and share reusable parts | Pack file extension .plasticitypack; drag asset into viewport then right-click to confirm | E plasticity-interface/assets |
| Import/Append, Export STEP, Parasolid, OBJ, STL, SVG, 3MF, IGES, SAT, Hidden Line | File I/O via P-menu or drag and drop | Tier table in section 3 | E import-export, export-obj, export-svg, export-hidden-line |
| Toggle Surface Curvature ★ | Combs on surface edges, curves, isoparams | Comb scale | S toggle-surface-curvature |
| Shader Mode ★ | Display analysis modes | Isophote/isoangle stripes, Draft Angle, Horizontal and Vertical Zebra, Topography, Face direction (blue outward, red inward), Curvature (Gaussian/Mean/Max) | E plasticity-interface/shader-mode |
| Selection, visibility, isolate | See section 4 | | E selecting-objects, toggle-object-states, focus-and-isolate-objects |
| Publish to Plasticity Share | Public model sharing | (idx) | C publish-to-plasticity-share |

## 2. 26.2 changes (https://doc.plasticity.xyz/whats-new)
- Assets system: mark an object as asset, export a pack, place from the Assets tab by drag. Tier not stated. Page: E plasticity-interface/assets.
- Constraint System: Studio only; constraints are not saved with the file yet (session only). Commands that can create them: Square, Project Align, Surface Align, Edge Align, Vertex Align, Bridge Curve, Bridge Vertex, Bridge Edge. Page: E constraint-system.
- Project Align: new, Studio only (S project-align).
- Curvature analysis shader (Gaussian, Mean, Max) in Shader Mode. Gaussian catches abrupt changes, Mean checks overall smoothness, Max flags trouble for thicken or offset. Tier not stated.
- Edge Align (formerly Align): Collinear solver, Skew boundary (needs G1+), partial-alignment slider, B and P toggles; Studio per licence page.
- Vertex Align and Bridge Curve: partial-alignment slider and P key; Bridge Curve gizmo redesign. The Sense option is removed from the dialog and now set by the gizmo.
- Move now auto-invokes on selection (experimental, disable in Preferences > Commands). Gizmo drags accumulate; mirror settings persist.
- Boolean, Hollow and Thicken failures now highlight the failing area in red.
- Other: Square accepts a single-face sheet; Slide falloff; Deform on curves; Offset Curve passes neighbours; Extend Sheet modify option; PolySpline CV edit and duplicate; Duplicate keeps raw surface lines; .plasticity import now brings meshes, images and instances; Home View; Toggle Images, Meshes and Constraints; Select All Constraints; new Section and plane snaps; snaps on instances; mesh snap highlight; edge colour and tintable matcap options; Outliner Add to Isolation; File tab context menu (reveal, backups, revert).
- New keys: J = Join (Outliner); B and P in Edge Align; P in Vertex Align.
- 26.1 migration (https://doc.plasticity.xyz/migration-26.1): Tab no longer toggles lock-distances (now S) and no longer enables all selection modes (now 5); SpaceMouse up/down reversed. 26.1 also added PolySplines (Studio), Export OBJ and STL commands, Slot, numerical precision options.

## 3. Licence tiers (https://doc.plasticity.xyz/getting-started/license-types-and-features)
- Studio-only per the licence page: Edge Align, Project Align, PolySplines, xNURBS, Square, Rebuild Face with explicit control, Constraint Modeling System, beta access (12 months). Indie has the "essential toolset". The Blender Bridge is in both. Both tiers: commercial use, 12 months of updates, perpetual licence.
- Price and activation: Indie $175, up to 2 machines; Studio $299, up to 4 machines (node-locked). Source: licence page and https://www.plasticity.xyz.
- Import: IGES, SAT, Rhino 3dm (BREP, NURBS, curves only) and DXF/DWG (2D curves, Windows only) are Studio-only. Export: IGES and SAT are Studio-only. STEP, Parasolid, OBJ, STL, 3MF, SVG, FBX and STL import work in Indie. (https://doc.plasticity.xyz/plasticity-essentials/import-export)
- Conflict to flag: my page-by-page extraction tagged xNURBS, Square and PolySpline pages "Indie, Studio". The licence page lists them as Studio-only, and the 26.1 notes say PolySplines is Studio-only. Trust the licence page, and re-check on a real Indie install.
- Trial and activation (https://doc.plasticity.xyz/getting-started/download-and-install): trial is created from the launch screen with email and password, no token. The site says the trial lasts 30 days, exports are low-resolution OBJ/STL only and STEP is import-only. Paid activation uses a token under P-menu > Manage licenses > Validate token.
- Multiple versions: a Studio licence can install Stable and Beta side by side. The docs say nothing on running several instances of one version.

## 4. Documented behaviours that matter for automation
- Units: the manual has a "Grid and Units" panel but its page gives no default unit or tolerance. Export STL offers mm, cm, m, in, ft; OBJ export has per-software scale and up-axis presets (Blender metre, Unreal and Maya cm, 3ds Max inch). Source: https://doc.plasticity.xyz/release-notes/whats-new-2026.1. I found no tolerance setting for modelling. Tolerance appears only per command (Patch tolerance, Constrained Surface tolerance and angular tolerance, xNURBS "satisfy tolerances", Refacet tolerances in the bridge).
- Direction and sign: not documented for Extrude, Revolve, Offset Face, Hollow, Thicken or Rotate. Documented: Fillet Shell sign (positive distance = fillet, negative = chamfer); Extrude direct versus individual mode; S lock-distances means equal distance both sides; Sweep distance 1.00 default.
- Selection and "depends on what you click": Fillet auto-picks Fillet Curve, Fillet Vertex or Fillet Shell by selected entity type. Edge Align picks Surface Align or Vertex Align by what is selected. Imprint picks Curve Body or Body Body. Extrude gives a solid from faces, regions or surface edges and a sheet from curves. Revolve, Sweep and Cut behave likewise. Order matters in Surface Align (edge to move first), Match Face (faces to match, then replacement), Project Align (target edge, reference surface, optional curve) and Draft Face (neutral reference face first). Boolean needs separate target and tool selections. Fillet auto-adds tangent edges unless T is toggled. Mirror and Move proportional pivot use the last active CV.
- Selection conversion keys: Ctrl+1..5 convert selection to points, edges, faces, solids, groups. Alt+click selects loops, related faces or all curves on the plane; Ctrl+Alt+click selects rings or parallel faces. Drag right-to-left selects touching, left-to-right selects contained. Source: E selecting-objects.
- Keyboard-only and modal modes: many options are key toggles (Tab cycle continuity, S screen space or lock distances, B/P in Edge Align, I instances, T tangent edges, F freestyle, V pivot).
- Auto-invoked commands: Preferences list Extrude, Push-face, Extend Sheet, Fillet and Move as auto-invoke, all on by default. Automated selection changes may therefore start a command on their own.
- Undo, redo and repeat: Ctrl+Z, Ctrl+Shift+Z, Shift+R repeats the last command (E general).
- No history or parametric tree: the site says Plasticity is free of feature-tree history. Constraints exist but are Studio-only and not saved.
- Scripting, plugin or API: nothing found. A search of the manual for scripting returned no pages. The only integration surface documented is the Blender Bridge (and a Cinema 4D page I did not read).
- Blender Bridge (https://doc.plasticity.xyz/blender/introduction-blender-bridge, how-to-use, blender-bridge-faq): Blender 4.1+; Plasticity solids and sheets arrive as meshes in Blender via Refresh or Live Link (auto-push every change). PolySplines go from Blender to Plasticity via Refresh. The FAQ says it is one-way, Plasticity to Blender, and that Plasticity materials do not appear in Blender, which conflicts with the how-to's note that materials survive refresh. Refresh overwrites geometry-linked data (seams, sharpness, UVs, names, collections, visibility, Edit Mode changes) and keeps transforms, modifiers, parenting, materials and Object Mode edits. Refacet settings: tri or ngon, tolerance, angle, plus advanced min and max width and edge or face chord and angle tolerances. Port conflict: FAQ says default 8980 (Preferences > Server and Blender sidebar); Preferences page extraction said 5000. Verify on the running app.
- File size and import limits: SVG with over 700 curves per plane hides the region overlay.

## 5. Strengths and weaknesses (official statements only)
- Fillets: site calls them "unparalleled", curvature-perfect fillets. https://www.plasticity.xyz
- Booleans: watertight results on dense or sculptural geometry, per the site. https://www.plasticity.xyz
- Surfacing continuity: G2-continuous blending through xNURBS, curvature combs and Class-A framing; manual has G0–G3 theory, zebra, isophote and curvature shaders. https://www.plasticity.xyz and E shader-mode
- Mesh to NURBS: PolySplines convert subdivision meshes to G2 splines, but ignore DCC creases and bevels (https://doc.plasticity.xyz/solid/polyspline).
- Fillet order: apply larger fillets before smaller ones (https://doc.plasticity.xyz/cad-essentials/fillet-order-of-operations).
- No history: stated as a feature (no feature tree), positioned as a complement to history-based tools. https://www.plasticity.xyz
- STEP and interchange: STEP and Parasolid in both tiers; IGES, SAT, 3dm Studio-only (E import-export). Free trial exports only low-res OBJ/STL.
- Meshes inside Plasticity: imported STL, FBX and OBJ are "Meshes", selectable in body mode, with snapping (26.2). No mesh editing tools are documented.
- Rendering, rigging, animation: the manual has no pages on them (only Render Mode display panel, matcaps). Not claimed as strengths.
- Direct editing: push, pull and dimension-driven edits are named as strengths on the site.

## 6. Pages not read or only partly read
- https://doc.plasticity.xyz/cad-essentials/continuity-curve-and-surface and .../how-to-use-splines-to-create-class-a-Surfaces: extractor returned no text (probably image-only); contents unknown.
- https://doc.plasticity.xyz/sketch/offset-curve and https://doc.plasticity.xyz/solid/create-instance: extractor found no options or behaviour text.
- Fillet (https://doc.plasticity.xyz/solid/fillet) is only a dispatcher; Edge Align likewise.
- Never opened (index description only): all tool pages (line … cylinder), most sketch pages (trim, join, project*, extend, text, insert-knot, rebuild, reverse), solid pipe, thicken-face, offset-edge, offset-face-loop, imprint-*, join*, unjoin*, untrim, unwrap-face, isoparam, delete-*, remove-*, extend, deform, slide, raise-degree, alternative-duplicate, find-boundary-edges, realize-instances; common duplicate, arrays other than rectangular, place, materials, complete-edge, subdivide, publish.
- Essentials pages not opened: outliner, snap, view cube, operating the 3D viewport, render mode, radial menu, importing reference images, export-obj, export-svg, export-hidden-line, focus-and-isolate, group objects, toggle-object-states; also user-support, Cinema 4D, release notes 25.x and 26.1 in full.
- Search found no manual page on scripting or API, and no units or tolerance page.
