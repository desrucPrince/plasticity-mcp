# Plasticity manual index, part 2: per-command detail and concepts

Source: https://doc.plasticity.xyz as read on 2026-11-16 (manual for 26.2). Our own summary with links, not a copy of the manual. Part 1 is `plasticity-manual-index.md`. "Output" is inferred unless marked stated. Note: this fork drives Plasticity 26.1.3; 26.2-only items are marked in part 1.


General facts for every page below:
- Every page with an "Available in" badge shows both "Indie" and "Studio". Dispatcher pages (router pages) have no badge.
- No page documents default values, units or sign conventions, unless the row says so.
- "Output" is inferred from the wording unless marked "stated".
- All commands confirm with OK or right-click.
- Tab opens numeric entry in sketch tools. K starts knife mode.

## A. PER-COMMAND TABLE

### A1. Tool pages (T). Every page was read. All are Indie+Studio.
| Command | Key | Does | Click order | Options and keys | Defaults and notes | Output |
|---|---|---|---|---|---|---|
| Line | Shift+A | Chained straight segments | Click each point, right-click to end | Tab, K, X/Y/Z, Ctrl+Z (undo last click) | none | curve, new |
| Spline Curve | toolbar | Curve through the clicked points | Click points, right-click to end | Tab toggles to Control Point Curve; K; X/Y/Z; Ctrl+Z | none | curve |
| Control Point Curve | toolbar | Curve shaped by control points off the curve | Same as Spline Curve | Tab toggles to Spline Curve | none | curve |
| Center Circle | toolbar | Circle from centre and size | Centre, then size | V tilts vs the construction plane; X/Y only; K | The dialog field is Radius, though the text says diameter | curve |
| Two-Point Circle | toolbar | Circle from two diameter ends | Point 1, point 2 | V, K, X/Y/Z | none | curve |
| Three-Point Circle | toolbar | Circle through three points | Three clicks | K, X/Y/Z | none | curve |
| Tangent Circle | toolbar | Circle tangent to up to three curves | Curve 1, curve 2, optional third; move for size | Radius field; F freezes the circle; Tab jumps to Radius | none | curve |
| Ellipse | toolbar | Ellipse from centre plus axis radius | Centre, then size | K, X/Y | none | curve |
| Center Point Arc | toolbar | Arc from centre and two circumference points | Centre, start, end | Tab, K, X/Y/Z | none | curve |
| Three-Point Arc | toolbar | Arc through three points | Three clicks | X/Y/Z at point 2; Tab at point 3 | none | curve |
| Tangent Arc | toolbar | Arc tangent to a curve | Base curve (optionally a second curve), then size | D flips direction; X/Y/Z; N moves along the normal; B along the binormal | Tangent detection is touchy | curve |
| Polygon | toolbar | Regular n-gon | Centre, then size | Shift+wheel or Up/Down arrows change the vertex count; C toggles inscribed or circumscribed; V; K; X/Y | Remembers the last vertex count | curve |
| Spiral | toolbar | Spiral from an axis | Axis start, axis end, diameter, then dialog | Turns; Radius; Angle or Pitch (linked); Handedness. Keys: A, D, R | none | curve |
| Corner Rectangle | toolbar | Rectangle from a diagonal | Corner, opposite corner | C switches to Center; S makes a square; K | none | curve |
| Center Rectangle | toolbar | Rectangle from the centre | Centre, then size | C switches to Corner; S makes a square | none | curve |
| Three Point Rectangle | toolbar | Rotated rectangle | Corner, second point, width | K, X/Y/Z | none | curve |
| Sphere | toolbar | Ball | Centre, then size | Radius; target bodies (boolean keys Shift+Q, Q, W, Shift+E, B, T); D | none | solid, new unless boolean targets are set |
| Corner Box | toolbar | Box | Base corner, base size, height | Width, Length, Height; target bodies; C switches to Center; S square base; H height | none | solid |
| Center Box | toolbar | Box from the centre | Base centre, base size, height | Same as Corner Box | none | solid |
| Three Point Box | toolbar | Box from three base points | Corner, second point, base size, height | Width, Length, Height; target bodies; X/Y/Z | none | solid |
| Cylinder | toolbar | Cylinder | Base centre, radius, height | Radius; Height; target bodies; V; F radius; D height; X/Y/Z | none | solid |
| Measure (Distance) | Ctrl+= | Live dimension | Pick a curve, edge or point, then place it | Right-click at placement gives a straight-line distance; G slides it in the Outliner | Follows the construction plane axes | annotation only |
| Measure Radius | palette | Radius annotation | Choose Solid (edge) or Curve; set the line length | none | none | annotation |
| Toggle Curvature | router | Surface edges go to the S version, curves to the K version | n/a | n/a | n/a | display only |

Sketching essentials (T /tool/sketching-essentials):
- Snapped vertices change colour.
- Ctrl forces snapping.
- Shift-tap creates temporary snap reference lines.
- K cuts faces while drawing, but only at snapped points on those faces.

### A2. Sketch pages (K). Every page was read. All are Indie+Studio.
| Command | Key | Does | Selection and order | Options and keys | Defaults and notes | Output |
|---|---|---|---|---|---|---|
| Fillet (K) | B | Router: curves go to Fillet Curve, vertices to Fillet Vertex, edges to Fillet Shell | by type | none | none | none |
| Fillet Curve and Fillet Vertex | B | Round or bevel a corner | Select curves or vertices, press B, drag the yellow dot | Radius; D and C set fillet or chamfer by cursor | Drag direction picks fillet vs chamfer | curve, modified |
| Offset Curve (router) | O | Vertices, curves, regions, faces and edges each go to their own variant | by type | none | none | none |
| Offset Planar Curve | O | Offset curves on both sides if wanted | Select curves, press O, drag the arrow | Distance; Gap fill Round, Linear or Natural (V); S locks both sides; F freestyle; D; pressing O again runs Slot | none | new curves |
| Offset Region | O | Offset region outlines | Select regions, press O | Distance; Gap fill (V); S; I individual (the wording is ambiguous, so test it); D | none | new region |
| Offset Vertex | O | Add vertices along a curve on both sides of one vertex | One vertex, then place | Distance; D | none | curve modified |
| Slot | palette | Slot profile with arc caps | One open, non-self-intersecting curve | Width (D) | none | closed curve |
| Text | palette | Text as curves | No selection; dialog | Text; Font (built-in only); Size | Default height 1 cm; placed at the XY origin | curves, new |
| Trim | T | Delete a segment | Press T, click the segment | none | Segments are split at intersections, ends and CVs | curve modified |
| Cut Curve | C twice | Cut a curve with a cutter curve or face | Target, then cutter | Extend; S screen space; Tab | none | curve split |
| Split Segment | toolbar | Insert a split point | Click the point | none | none | curve |
| Extend (router) | none | Curves go to Extend Curve; outer sheet edges go to Extend Sheet | by type | none | none | none |
| Extend Curve | palette | Extend by a distance or to a target | Select the END point, run Extend, press D or pick a target | Shape Natural, Linear, Soft, Reflective, Arc; Distance (D) | The target sets the distance | curve modified |
| Join Curves | J | Join at matching endpoints | Select curves, press J | none | Ends must match exactly | one curve |
| Unjoin Curve | Alt+J | Split joined curves | Select curves | none | none | separate curves |
| Insert Knot | toolbar | Add a CV to a spline | Click on the curve | none | Splines only | modified |
| Convert Vertex | palette | Vertex to control vertex | Select vertices | none | Double-click also converts | modified |
| Delete Redundant Topology (K) | palette | Remove extra vertices, shape kept | Select curves | none | none | modified |
| Bridge (router) | none | Two curves go to Bridge Curve, two vertices to Bridge Vertex, two edges to Bridge Edge | by type | none | none | none |
| Bridge Edge | toolbar | G0 to G3 curve between two surface edges | Two edges | Parameter 1 and 2; Tension 1/2/3 (value 1 and 2 each); Start and End curvature G0 to G3; Show curvature; Create Constraints. Keys: X/Y/Z, Tab (continuity), D (G1 tension), Q (trim) | none | new curve; sources trimmed if Q |
| Bridge Vertex | L | Same, between two vertices | Two vertices, press L | Same as Bridge Edge, plus a Trim checkbox and "Tension G1/G2/G3" labels | none | new curve |
| Bridge Curve | toolbar | Same, between two points | Click start, click end (object snaps on) | Same as Bridge Vertex | G1 tension acts on CV1 to CV3, G2 on CV2 and CV3, G3 on CV3 | new curve |
| Vertex Align | palette (the page header says "Edge Align") | Align a vertex or curve to a target | Target first, then reference; in edge selection mode the nearest end is picked | Continuity G0/G1/G2; Tension G1/G2/G3; Partial alignment (P); Show curvature; Create Constraints (C); D; Tab | Only the target moves | target modified |
| Edge Align (K) | none | Router: vertices or curves go to Vertex Align, two edges go to Surface Align | by type | none | none | none |
| Project (router) | I | Two curves go to Curve Curve, two bodies to Body Body, anything else to Curve Body | by type | none | none | none |
| Project Body Body | I | Intersection curve of two bodies | Two bodies | none | none | new curve |
| Project Curve Body | I | Project a curve onto a body | Body first, then the curve | Method Normal or Vector (Vector adds Bidirectional and Hide occluded); S screen space | Normal means the construction plane +Z | new curve |
| Project Curve Curve | I | Curve from two swept curves | Two curves | none | Wrong normals cause errors; the workaround is to extrude and use Imprint Body Body | new curve |
| Project Outline | Alt+D (the page header says Alternative Duplicate) | Outline of a body onto the plane | Set the plane, select the bodies | none | Gives a 2D projected result | new curves |
| Create Outline | palette | 3D outline at the true boundary | Same as Project Outline | none | none | new curves |
| Duplicate Curve and Project | Alt+D (the page header says "Cut Curve", an error) | Flatten curves onto the plane | Select curves or edges, set the plane | none | none | new curve |
| Alternative Duplicate (K) | Alt+D | Flatten curves along the plane normal | Set the plane, select curves | none | Move gizmo follows | new curve |
| Rebuild (router) | none | Curves go to Rebuild Curve, faces go to Rebuild Face | by type | none | none | none |
| Rebuild Curve | palette | Clean up the CV layout | Select curves | Method Refit (Tolerance, Keep corners), Points (CV count), Explicit (Degree and Spans, Weight) | Weight default 0.5 | rebuilt curve |
| Raise Curve Degree | Shift+S | Raise the degree by one per press | Select curves | none | New CVs end up selected | modified |
| Reverse Curve | palette | Flip the direction | Select the curve | none | none | same curve |
| Deform Curve | palette | Wrap curves from a reference to a target | Curves, then reference (face or curve), then target | Scale (U,V,N); Offset (U,V,N); Flip Mirror/UV/Normal; Keep Tools | UVN, not XYZ; a straight reference curve is advised; Unwrap Face gives a better reference | new curves |
| Slide Curve CV | Shift+G | Slide CVs along the cage tangent | Select CVs | Distance; Proportional None/All/Selected; Falloff U and V; Mirror None/X/Y/Z. Keys: U, Shift+U, N, Ctrl toggles preview | Splines only | modified |
| Toggle Points | palette | Show or hide CVs | Select an object | none | none | view only |
| Toggle Curve Curvature | palette or toolbar | Curvature comb | Select a curve | Comb Scale | Comb length is 1/radius; a Measurements entry is created | measurement |
| Create Curve Instance and Realize Curve Instances | palette | Linked read-only copies, and the reverse | Select the curve or group | none | Works with arrays, Mirror and Place; Copy with Placement does not work on instances | instance, or real curves |
| Project Align | S /solid/project-align (the K URL gives 404) | Align CVs on a target edge to a reference | Target edge, reference surface, optional reference curve | Solver Constrained or XNurbs; continuity G0/G1/G2 plus Perpendicular; Blend extra rows; Projection Normal or Vector; S; Ctrl; Tab | Constrained is the default; XNurbs needs a reference curve; the target must be an untrimmed single-patch B-spline | target modified |

### A3. Solid pages (S)
Every page shows both tiers. The one tier exception is the Explicit control method in Rebuild Face.

| Command | Key | Does | Selection and order | Options and keys | Defaults and notes | Output |
|---|---|---|---|---|---|---|
| Alternative Duplicate (S) | Alt+D | Solid from chosen faces, then move it | Select faces, press Alt+D | X/Y/Z, Shift+axis, G, F, V, W | Works best on simple faces | new solid |
| Pipe | P | Tube from a curve or edge | Select curves or edges, press P | Target bodies (boolean keys); custom profile (C); Vertex count (0 = circular); Diameter (D); Thickness (Shift+T); Angle (A); Scale; Distance with Distance 1 and 2 | Distance default 1.00. The manual says Pipe is not dimensionally accurate; use Sweep for exact work | solid; booleans decide new vs modify |
| Thicken Face | palette | Thicken faces per side | Select faces | Thickness; S equal both sides; D | none | thickened solid |
| Offset Edge and Offset Face Loop | O | New edges offset from edges or face outlines | Select edges or faces | Distance; Gap fill Round/Linear/Natural (V); S; D; I on Face Loop | The mouse side picks the direction | edges |
| Offset Curve (S) | none | Router | by type | none | none | none |
| Imprint (router) | none | A curve and a body go to Curve Body, two bodies go to Body Body | by type | none | none | none |
| Imprint Body Body | Shift+I | Edges where a tool body meets the target | Target first, then tool | Imprint tool; Complete target None/Edge; Complete tool None/Edge | none | edges on existing bodies |
| Imprint Curve Body | Shift+I | Project curves onto a body as edges | Curves then body, body then curves, or nothing selected then body then curves | Method Normal/Vector (Bidirectional, Hide occlusion); Completion None/Edge/Boundary | none | edges |
| Join (router) and Join Sheets | J | Join sheets with matching edges | Select sheets | none | The edges must align exactly | joined sheet, or a solid if closed |
| Unjoin (router) | none | Faces go to Unjoin Faces; solids and sheets go to Unjoin Shells | by type | none | none | none |
| Unjoin Faces and Unjoin Shells | Alt+J | Detach faces; split a body into one sheet per face | Select faces or bodies | none | none | separate sheets |
| Untrim | Alt+T | Sheet from the original untrimmed surface | Select a face | Keep edges (Tab) | none | new sheet |
| Unwrap Face | palette | Flatten a face | One face | none | Lands at the world origin | new sheet |
| Isoparam | Ctrl+R | Edges along U or V | Press the key, hover the face, right-click | Direction U/V (Tab); Count (Shift+wheel); Param; Subdivide (S) | Subdivide cannot be reverted by dissolving the face | edges on the body |
| Delete Face | Shift+X, Delete or Backspace | Remove faces | Select faces | none | none | body modified |
| Delete Redundant Topology (S) | palette | Clean solids and sheets | Select bodies | none | none | modified |
| Remove Fillets From Shell | palette | Strip fillets | Select the body | Max Radius; Convexity Any/Convex/Concave | none | modified |
| Remove Nominal Surface | palette | Reveal the hidden extra spans behind visible CVs | Select a face | none | The page suggests Rebuild afterwards. The first pass noted that it also removes PolySpline CVs | modified |
| Extend (S, router) | none | Outer sheet edges go to Extend Sheet | by type | none | none | none |
| Extend Sheet | auto-runs on an outer sheet edge | Extend sheet edges | Select outer edges | Shape Natural/Linear/Soft/Reflective (Tab); Limit Minimal/Outside/Inside; Distance (D); Modify | The intro text omits Natural. Modify gives one single sheet | sheet |
| Find Boundary Edges | palette | Select a sheet's open edges | Select a sheet | none | none | selection only |
| Deform Solid and Sheet | palette | Wrap bodies from a reference onto a target | Objects, reference, target | Scale and Offset in UVN; Flip Mirror/UV/Normal; Reblend; Keep Tools | Split closed surfaces first; use Unwrap Face for open targets | deformed copy |
| Slide Surface CV | Shift+G | Slide CVs | Select CVs | Distance; Proportional; Falloff U and V; Mirror X/Y/Z; U, Shift+U, V, Shift+V, N | The page lists no shortcut, but its steps use Shift+G | modified |
| Raise Surface Degree | Shift+S | Raise the degree | Select a face or solid | none | Use Rebuild if the CV count gets high | modified |
| Reverse Sheet | palette | Flip the normal | Select the sheet | none | none | modified |
| Create Solid and Sheet Instance and Realize Solid and Sheet Instances | palette | Linked read-only copy, and the reverse | Select the body or group | none | Works with arrays, Mirror and Place; all snaps work (26.2); Copy with Placement does not | instance, or real body |
| Rebuild Face | palette | Rebuild the surface structure | Select faces | Explicit control (Studio only): Degree U/V, Spans U/V, Extend, Shrink. Tolerance method: Tolerance, Extend, Shrink | none | modified |
| XNurbs | palette | N-sided or quad surface from boundary edges | Select edges, or run first then pick | Continuity G0/G1/G2; Quad sided; Flatness (0.95 to 1.00 for a 4-sided boundary); Tension (0.1 to 1.0); Boundary Natural/Normal/Next/Adjacent; Quality Auto/High/Max; Satisfy tolerances | Tension 0.5, Quality Auto, Satisfy tolerances on | new sheet |
| Square | palette | Quad surface with control of degree and spans | Edges; 2 apart is like Loft; 2 or 3 touching is like Sweep; a quad boundary is like Patch | Continuity Free/G0/G1/G2; Flatness; Tension; Degree U/V; Spans U/V; Boundary; Weight; Analysis | Free is for rough surfaces | new sheet; refit modifies faces |
| PolySplines | palette | Mesh (OBJ or FBX) to a G2 untrimmed spline surface | Select or import a mesh | Rounded Corners; Merge Patches; Interpolate Boundary Exactly | No creases or bevels; quad-dominant meshes work best | new body |
| Constrained Surface | palette | Surface through clicked points | Click points in order | Tolerance; Angular tolerance; Optimize Performance/Smoothness; Ctrl+Z removes the last point | none | new sheet |
| Toggle Surface Curvature | palette | Comb on surface edges | Select an edge | Comb Scale | Creates a Measurements entry | no change |
| Complete Edge (C) | palette | Extend an edge until it meets another edge | Select edges | none | none | edge extended |
| Subdivide (C) | palette | Double the CVs on curves; raise degree and spans on surfaces | Select the object | none | none | modified |

### A4. Common pages (C). All are Indie+Studio.
| Command | Key | Does | Order | Options and keys | Defaults and notes | Output |
|---|---|---|---|---|---|---|
| Copy With Placement | Ctrl+Shift+C | Copy with an anchor | Select, press the key, click the anchor | none | Does not work on meshes or instances | clipboard |
| Paste With Placement | Ctrl+Shift+V | Paste with anchor to anchor | Press the key, click the destination, right-click | F flip; X/Y/Z; S scale; A angle; D offset; boolean keys Shift+Q, Q, W, Shift+E, B | none | copies or a boolean result |
| Place | Ctrl+D (no badge on the page) | Copy and place by reference points | Select, press the key, click source, click destination | S, A, D, F, I, X/Y/Z, boolean keys | Meshes snap to vertices and faces only; instances snap to faces and edges only | copies |
| Duplicate | Shift+D | Copy with the move gizmo | Select, press the key | XYZ amounts; G, X/Y/Z, F, V, Alt+V, W | none | copies |
| Curve Array | palette | Repeat along a path | Object, then path curve | Number; Twist (degrees); Scale; Alignment Normal/Parallel/Transport; Extent; Method Distance/Ratio; Make instances (I); Shift+wheel | Ratio runs 0 to 1, default 1.00 | copies or instances |
| Radial Array | button | Circular pattern | Object, then centre | Mode Total/Spacing; Degrees; Number 1 and 2; Step 1; Make instances (I) | none | copies |
| Rectangular Array | button | Grid pattern | Object, X/Y/Z, then direction; second direction via "Select endpoint 2" | Mode Extent/Spacing; Distance 1 and 2; Number; Repeat; Make instances (I) | none | copies |
| Set Material | M | Assign a material | Select, press M | Color; Roughness 0 to 1; Metalness 0 to 1; IOR; Opacity; Reflection, Transmission and Advanced menus (Density) | Curves use only colour and opacity | material modified |
| Remove Material | Alt+M | Back to the default material | Select | none | none | modified |
| Fork Material | Shift+M | Own editable copy of the material | Select | none | none | modified |
| Publish To Plasticity Share | palette | Upload a mesh copy and get a link | Select, run, confirm | none | Off by default (Preferences > Web Publishing); 5 GB storage; once shared the link is effectively public | cloud upload only |

### A5. Export and interface commands
- **Export Hidden Line** (E /export-hidden-line, palette): writes an SVG drawing.
- Standard views: Top, Front, Right, Bottom, Left and the four corners.
- Stroke thicknesses run 0 to 10 for Visible, Silhouette and Smooth. 0 hides that line type.
- Also offers Hidden Lines (dash length and gap), Planar, Section, Radial and Parametric hatching, and Tolerance.
- S captures the screen.
- **Export OBJ** (E /export-obj):
- It exports the selected bodies, or all displayed solids and sheets if nothing is selected.
- Topology is Tris, Quads or Ngons. Density sets the others automatically.
- Plane tolerances are in cm (0.01 low poly, 0.0001 high poly). Angle tolerances are in radians (0.35 low poly, 0.15 high poly).
- Advanced options: Scale, Up Axis, and others.
- **Export SVG** (E /export-svg): exports 2D sketches only. Flat sketches on different planes become separate files.
- **P-menu keys** (E /plasticity-interface/file-menu):
- Ctrl+N new, Ctrl+O open, Ctrl+Shift+O import or append.
- Ctrl+S save, Ctrl+Shift+S save as, Ctrl+Shift+E export.
- Ctrl+, preferences, Ctrl+Q quit.

## B. CONCEPT SUMMARIES

**CAD essentials**
- **NURBS overview** (/cad-essentials/nurbs-overview).
- A curve is defined by CVs, a degree, knots and weights. A span needs degree+1 CVs.
- The page names cubic (degree 3) as the CAD standard. Use as few CVs as the shape needs.
- Weights below 1 flatten the curve. A solid must be watertight, because an unclosed one causes errors downstream.
- It gives no span-count rules.
- **UVN** (/cad-essentials/uvn-coordinate-system).
- U and V are tangents on the surface. N is the outward normal. This is a local frame, not XYZ.
- The page gives no sign convention. Do not assume U or V map to X or Y. Read the orientation back from the model.
- **Continuity** (/cad-essentials/continuity-curve-and-surface).
- Curves have G0 to G3. Surfaces have G0 to G2.
- Class A visible surfaces need G2 or better. Hidden surfaces can be G0.
- Check with zebra and curvature combs.
- Rule of thumb: G0 for hidden or structural joins, G1 for tangent blends, G2 for visible blends.
- **Splines for Class-A** (/cad-essentials/how-to-use-splines-to-create-class-a-Surfaces; the capital S in the slug is required).
- The page has no text. It holds only a heading and two embedded YouTube videos (Siemens NX Freeform tutorials, Part 1/2 and 2/2).
- Nothing else can be said about it.
- **Fillet order** (/cad-essentials/fillet-order-of-operations). This is a summary of a video.
- Apply fillets from the largest radius to the smallest.
- For equal radii, fillet the more open (larger-angle) edges first.
- Re-find edge IDs after each fillet, because the topology changes (my inference).

**Essentials**
- **Object types** (E /object-types).
- Curve, Vertex, Control Vertex, Region, Solid, Sheet, Face, Edge, Image and Mesh.
- A solid is closed. A sheet is open.
- Selecting a region starts Extrude. Selecting a face starts Offset Face. An edge between two faces starts Fillet. An open sheet edge starts Extend Sheet.
- Regions stop displaying after about 700 curves per plane.
- Meshes are imported STL or FBX and are not NURBS.
- **Viewport** (E /operating-the-3d-viewport).
- Num1 is Front, Num3 Right, Num7 Top. Ctrl plus the same key gives the opposite view. Num5 toggles orthographic.
- The page does not state the up axis or handedness. Verify them by reading the bounds of a box.
- **Snapping** (E /plasticity-interface/snap).
- Ctrl enables snapping temporarily. Shift+X disables it, and pressing it again cycles types.
- Curve targets: Beginning, End, Middle, Closest, Intersection, Center, 1/4, 3/4, Perpendicular, Tangent, Tan/Tan, Section.
- Meshes snap to vertex and face only. Images snap to corner only.
- **Construction planes** (E /plasticity-interface/construction-plane).
- The defaults are XY (Num7), YZ (Num3) and XZ (Num1).
- Space creates a plane from the selection:
  - A face or region gives an aligned plane.
  - A face plus an edge gives a plane perpendicular to the face.
  - Two parallel faces give a mid-plane.
  - Three points give a plane through them; with four or more points it sits at their average position.
- Shift+Space does the same without changing the view.
- Ctrl+Space makes a plane from the view through the origin.
- Planes can be saved and renamed in the Outliner. The "2D Snapping" option projects picked points onto the active plane.
- Curves are drawn on the active plane.
- **Selection modes** (E /plasticity-interface/selection-mode).
- 1 is control point, 2 edge or curve, 3 face or region, 4 solid or sheet, Tab all.
- Shift+1 to Shift+4 combine modes.
- **Selecting** (E /selecting-objects).
- Dragging right to left selects what the box touches. Dragging left to right selects only what it fully contains.
- Alt+click selects loops, related faces or all curves on a plane. Ctrl+Alt+click selects rings or parallel faces.
- A is select all, Esc deselects, Alt+A inverts.
- Ctrl+1 to Ctrl+5 convert the selection to points, edges, faces, solids or groups.
- Ctrl+T selects the source objects of the last operation.
- **Groups and the Outliner** (E /group-objects points to the Outliner page).
- Ctrl+G groups, Alt+G ungroups, Shift+D duplicates a group.
- Double-clicking a group makes it the active collection, and new objects go there.
- Dissolve (Backspace or X) keeps the contents. Delete removes them.
- The Outliner has sections for Solids, Sheets, Curves, Meshes, Images, Measurements, Instances and Planes. F2 renames, Ctrl+F searches.
- **Object states** (E /toggle-object-states).
- H hides, Shift+H hides unselected, Alt+H unhides all, Ctrl+H inverts.
- Outliner icons: Hide (still processed), Disable (removed from processing), Lock (cannot be selected or changed).
- Lock Selected and Unlock All have no default keys.
- **Isolate** (E /focus-and-isolate-objects).
- "." isolates the selection and nests layers. Alt+. unisolates everything.
- "/" focuses the view, and Space centres the selection.
- **Radial menu.**
- Two default menus exist (Selection mode and Viewport settings), and they need setup. No default key is bound.
- Menus are JSON files in ~/.plasticity/radials.
- Each item names an internal command ID, for example command:extrude or selection:mode:set:face.
- **Render and shader modes.**
- Render mode is toggled by the command "Viewport: toggle render mode". It has 8 HDRIs. Rotation default is 0, Intensity 1.0, AO Radius 15, AO Falloff 0.5.
- Shader mode has 15 matcaps, including Isophote, Draft Angle, Zebra, Topography, Face direction and Curvature.
- AO is off by default.
- **Grid and units.**
- Length units are mm, cm, m, inch and foot. Mass units are g, kg, oz and lb.
- The grid sits on the active plane. Ctrl suspends grid snapping.
- No default unit or grid size is documented.
- **General keys.**
- Ctrl+Z undo, Ctrl+Shift+Z redo, Shift+R repeats the last command.
- Delete is Shift+X, Shift+Delete or Shift+Backspace.
- Alt+Z is X-ray. Alt+Shift+Z toggles overlays.

## C. CORRECTIONS TO THE FIRST INDEX

1. **Licence tier of xNURBS, Square and PolySplines.** Each page badge reads "Available in IndieStudio" (both tiers). The licence page lists them as Studio only, and the what's-new, Blender and how-to pages repeat the Studio restriction for PolySplines. Page badges and the licence page disagree. Treat Studio as the safe assumption.
2. **Edge Align and Project Align.** The licence page says Studio only. The Edge Align and Project Align command pages carry the both-tier badge (the shard reports for Project Align and Vertex Align show Indie and Studio).
3. **Extend Sheet.** The licence page does not list it. The badge shows both tiers. The shape has four values: Natural, Linear, Soft and Reflective. The page also has Limit, Distance, Modify, and the keys D and Tab. The intro text omits Natural.
4. **Rebuild Face.** The page badge shows both tiers. Only the Explicit control method is marked Studio only.
5. **Blender Bridge port.** The conflict is confirmed and both numbers are on real pages.
 - The FAQ gives 8980, set in Preferences > Server and in the Blender sidebar.
 - The Preferences page (at /plasticity-essentials/preferences, Network > Blender Bridge) gives 5000, host "localhost", enabled by default.
 - The setup and intro pages say to tick Enabled, which suggests it is off by default.
 - Verify on the running app.
6. **Preferences page URL.** It is /plasticity-essentials/preferences. The plasticity-interface/preferences URL returns 404.
7. **Blender materials.** Plasticity materials do not carry to Blender (FAQ). Blender-side materials survive a refresh (how-to). There is no real conflict.
8. **Project Align.** The page is at /solid/project-align. /sketch/project-align returns 404.
9. **Vertex Align.** The page header says "Edge Align", and the page has an anchor to a different slug.
10. **Slide Surface CV.** The page lists no shortcut, but its steps use Shift+G. Slide Curve CV also uses Shift+G.
11. **Class-A splines page.** It is video-only, not an extractor miss (see B).
12. **Remove Nominal Surface.** It is a documented command at /solid/remove-nominal-surface.
13. **Pipe.** The manual says it approximates and is not dimensionally accurate. Use Sweep for exact pipes.
14. **Units.** The Grid and Units page lists the available units but no default.
15. **Scripting and API.** The shards found no documented scripting interface in Plasticity itself.
16. **Wording errors in the manual.**
  - The I key is described as toggling the "mirrored half" on the three array pages.
  - Corner Box says C switches to Corner Box.
  - Several pages say "diameter" for a field labelled Radius.
17. **Offset Face Loop and Offset Region.** The "Individual" (I) option is worded ambiguously.

## D. ALL COMMAND NAMES FOUND (alphabetical)
Alternative Duplicate, Arc (Center Point), Arc (Tangent), Arc (Three-Point), Boolean, Box (Center), Box (Corner), Box (Three Point), Bridge, Bridge Curve, Bridge Edge, Bridge Surface, Bridge Vertex, Circle (Center), Circle (Tangent), Circle (Three-Point), Circle (Two-Point), Complete Edge, Constrained Surface, Control Point Curve, Convert Vertex, Copy With Placement, Create Curve Instance, Create Instance, Create Outline, Create Solid and Sheet Instance, Curve Array, Cut, Cut Curve, Cylinder, Deform, Deform Curve, Deform Solid and Sheet, Delete Face, Delete Redundant Topology, Dimension, Draft Face, Duplicate, Duplicate Curve and Project, Edge Align, Ellipse, Export Hidden Line, Extend, Extend Curve, Extend Sheet, Extrude, Fillet, Fillet Curve, Fillet Shell, Fillet Vertex, Find Boundary Edges, Fork Material, Hollow, Imprint, Imprint Body Body, Imprint Curve Body, Insert Knot, Isoparam, Join, Join Curves, Join Sheets, Line, Loft, Match Face, Measure Continuity, Measure Distance, Measure Radius, Mirror, Move, Offset Curve, Offset Edge, Offset Face, Offset Face Loop, Offset Planar Curve, Offset Region, Offset Vertex, Paste With Placement, Patch, Pipe, Place, Polygon, PolySpline, Project, Project Align, Project Body Body, Project Curve Body, Project Curve Curve, Project Outline, Publish to Plasticity Share, Radial Array, Raise Curve Degree, Raise Degree, Raise Surface Degree, Realize Curve Instances, Realize Instances, Realize Solid and Sheet Instances, Rebuild, Rebuild Curve, Rebuild Face, Rectangle (Center), Rectangle (Corner), Rectangle (Three Point), Rectangular Array, Remove Fillets From Shell, Remove Material, Remove Nominal Surface, Reverse, Reverse Curve, Reverse Sheet, Revolve, Rotate, Scale, Section Analysis, Set Material, Slide, Slide Curve CV, Slide Surface CV, Slot, Sphere, Spiral, Spline Curve, Split Segment, Square, Subdivide, Surface Align, Sweep, Text, Thicken, Thicken Face, Toggle Curvature, Toggle Curve Curvature, Toggle Points, Toggle Surface Curvature, Trim, Unjoin, Unjoin Curve, Unjoin Faces, Unjoin Shells, Untrim, Unwrap Face, Vertex Align, xNURBS.

Sources for this list: the five section index pages (/all-commands/solid-commands, sketch-commands, common-commands, tool-commands, plasticity-essentials) plus the shard reports.

Command names that appear in the first-pass index but are not in these section indexes: Extrude, Revolve, Sweep, Hollow, Loft, Patch, Dimension, Draft Face, Match Face, Move, Rotate, Scale and similar. They are in the first pass from pages already read.

## E. PAGES NOT READ OR PARTLY READ
- The roughly 45 pages read in detail in the first pass were not re-scraped this time. They include Extrude, Revolve, Sweep, Hollow, Loft, Patch, Bridge Surface, Boolean, Cut, Fillet Shell, Offset Face, Thicken, Surface Align, Match Face, Draft Face, Move, Rotate, Scale, Mirror, Dimension, Section Analysis and Measure Continuity.
- /tool/measure-continuity: not scraped by any shard.
- Essentials pages not read:
- Command Palette and View Cube pages: not read.
- Import/Export page: not read this pass.
- Release notes 25.x: not read.
- Cinema 4D page: not read.
- The Render Mode, Radial Menu and Outliner details come from a shard that read their pages. I have not re-checked them.
- /cad-essentials/how-to-use-splines-to-create-class-a-Surfaces: video-only, with no readable rules.
- Output type (new body or modifies) is stated on almost no page. The Output column is inferred.
- Image and video content on the pages was not read or described.
