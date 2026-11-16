# Plasticity MCP

Local stdio MCP server for native CAD modeling in Plasticity 26.1.3 on Apple
Silicon Macs. It drives Plasticity's own command factories and history through
an Electron CDP endpoint bound to loopback. It does not modify the application
bundle, its bytecode, or its signature.

The public MCP interface uses millimeters and degrees. Geometry edits run
through native Plasticity commands, so Undo and Redo remain available. Body,
face, and edge references carry a document revision; mutation tools reject a
stale revision.

Both the Plasticity and optional Workbench MCP servers include concise agent
guidance in the MCP initialize response. Detailed workflows remain available
as named prompts and resources, while the initialize guidance covers safe
revision-bound CAD edits, practical strength checks, optional Workbench use,
and the explicit confirmation required before sending a print job.

## Install

Requirements:

- macOS on Apple Silicon
- Plasticity 26.1.3 in `/Applications/Plasticity.app`
- Node.js 24

```sh
cd .
npm install
npm run start:plasticity
```

`start:plasticity` returns an already enabled window when one exists. If
Plasticity is running without MCP access, it refuses to terminate or restart
it. Save all open work, quit the application, and run the command again. On a
clean start the launcher pauses the Electron main process, preserves the
loopback renderer debugger flags, then resumes startup. No listener is exposed
outside `127.0.0.1`.

For isolated live acceptance, `npm run start:plasticity-isolated` starts a
separate Plasticity process with a new temporary user-data profile and distinct
ephemeral loopback CDP ports. It does not attach to an existing document. Keep
the printed profile directory until the isolated Plasticity process has been
closed; it can then be removed.

Register the stdio server in Codex:

```sh
codex mcp add plasticity -- npm --prefix . start
```

The agent should call `plasticity_list_windows`, then
`plasticity_connect` with an explicit `targetId`. One MCP process owns a window
at a time. Lock files live under `~/.plasticity-mcp/ownership/` by default, shared across checkouts, and stale process locks are
recovered automatically. Reconnecting to the same window reuses its current
session. Switching windows first acquires and validates the new connection, so
a busy target or failed initial read leaves the existing connection intact.

The default `npm start` and Codex plugin expose 10 core named tools plus
`plasticity_call`. Use `plasticity_call` with `toolName: "catalog"` and a name
or description query to get a bounded page of all operations and their JSON
input schemas. Pass a returned operation name and its `arguments` object back
to `plasticity_call` to invoke it. The dispatcher only calls tools registered
by this server and applies each operation's original schema and handler; it
does not accept JavaScript or arbitrary method names. To expose every operation
directly, run `npm run start:full` and register that command with the MCP client.

Call `plasticity_status` before editing and pass its `revision` to mutation
tools. It returns compact, paginated body bounds and topology counts (50 bodies
per page by default, at most 200); follow `bodyPagination.nextOffset` to read
the next page and pass the prior page's `revision` as `expectedRevision` so a
manual edit cannot mix pages from different scene states. Use
`plasticity_body_info` for exact face, edge, or vertex IDs and geometry of one
body, or `plasticity_list_bodies` for paginated exact topology details. That
tool returns 10 bodies per page by default (at most 100) and uses the same
revision check when following `bodyPagination.nextOffset`. A document
switch or manual edit changes the revision, so a queued command with an older
revision is rejected before it reaches Plasticity.

Native mutation tools that return a scene state use the same compact body
summary shape, limited to the first 20 bodies, plus a `change` object listing
added, removed, and modified bodies with exact native bounds and topology
counts. Follow `bodyPagination.nextOffset` for more summaries; use
`plasticity_body_info` or `plasticity_list_bodies` when exact face, edge, or
vertex geometry is needed. Non-state operation results keep their own schema.

### Batch reply shaping and selection (speed tier 1)

`plasticity_batch` runs many steps under one lock. Three inputs control what
comes back; none of them changes what later steps can read, because every
step's full result stays stored for `$<step>.result...`, `$<step>.added[...]`
and `$<step>.removed` references.

- Step `return: string[]`: result paths in the `$n.result` syntax (`.key`,
  `[i]`, `[*]`; the leading dot is optional), for example
  `["matches[*].id", "matches[*].axisOriginMm", "count"]`. The step's reply
  `result` is an object with exactly those paths as keys. A key must be an own
  property of the result: `__proto__`, `constructor`, `prototype` and other
  inherited keys (such as an array's `length`) never resolve. On a read step a
  path that does not resolve fails the batch; the error names the step, the
  path and the result's top-level keys. On a step that changed the document the
  edit is already applied and journaled, so the step stays completed: it keeps
  its normal reply and adds `returnError: "<the same message>"`, and the batch
  goes on. Do not retry such a step; that would duplicate the geometry. The
  batch reply also carries a top-level `returnErrors: <n>`, the number of steps
  that carry `returnError`, so it cannot be missed (absent when none does).
- Without `return`, a read step's reply is its full result when it is 1,500
  bytes or less. A larger result comes back as `{ truncated: true, bytes,
  count, ids, hint: "add return: [...] to this step" }`. Nothing is cut
  silently. Mutating steps also report the tool's own result fields (an export's
  `path` and `bytes`, `controlPoints`, `previousDistanceMm`, recipe journals)
  under `result`, with the same 1,500-byte rule; `createdEdges` keeps its own
  key. `plasticity_describe_body` is the one exception: it has its own 4 KB
  hard cap, so a describe step without `return` comes back whole in both
  detail modes (an enclosure description is 1.5-1.6 KB).
- `detail: "standard" | "lean"` (default `standard`). `standard` is the reply
  this server sent before tier 1 plus two additive fields: `hint` on a read
  result cut to ids (`truncated: true`), and `result` on a mutating step whose
  tool returns its own data (see above). `returnError` appears only where a bad
  `return` path used to fail an applied step. `lean` leaves out the `createdEdges` echo (`createdEdgeCount`
  stays), `addedBodies` entries for bodies a later step consumed, and every
  empty list. Its reply is `{ steps, summary }`. `summary` holds `revision`,
  `undoSteps`, `bodyCount` and the bodies that survive (`added`, `modified`:
  id, type, name, `boundsMm`, face and edge counts), plus `removed` ids.
  In `lean`, a recipe step (create_rib, screw_boss_pattern, connector_opening
  and the other recipes) replies `result: { status }` without its step journal;
  the bodies it created stay in `added`/`addedBodies`. A read step without
  `return` whose result a later step references (`$n.result...`) replies
  `{ count }`, plus `ids` when it returned 8 matches or fewer. A read no later
  step references keeps the 1,500-byte rule. `return` still projects from the
  full stored result in both cases. Both lean shapes add `omitted: [keys]`, the
  top-level result keys they left out (for example `["documentToken",
  "revision", "measurementSource", "matches"]`), so a `return` list can fetch
  any of them. `standard` drops nothing and has no `omitted`.
- `roundMm: 0-6`: rounds length values in the reply to that many decimals: the
  numbers under a key that ends in `Mm` or `Mm2` (`lengthMm`, `radiusMm`,
  `areaMm2`, `positionMm`, `boundsMm.min`), including everything nested under
  that key. A return key is a path, and the nearest segment that ends in `Mm`
  or `Mm2` decides: `"matches[*].lengthMm"`, `"matches[*].boundsMm.min"` and
  `"matches[*].centerMm[0]"` are rounded. A bare `mm` key is a length too (the
  plane offsets of `plasticity_describe_body`: `"planes.zPos[0].mm"`). Keys that
  end in `Mm` or `Mm2` but are rates keep full precision: a rate is a name
  ending in `PerMm` or `PerMm2` (`curvaturePerMm`, `fractureEnergyNPerMm`,
  `stiffnessMPaPerMm`, `tractionNPerMm2`). An area such as
  `shearAreaPerPlaneMm2` is rounded. `matrixWorldMm` keeps full precision
  except its translation (elements 12-14 of the column-major 4x4). Normals, tangents, axes, angles, quaternions,
  counts and ids keep full precision. The rule applies to the whole reply, including the `verbose` top
  level. Stored results are not rounded. Off by default.

`plasticity_find_faces` and `plasticity_find_edges` take optional `sortBy`
(faces: `x`, `y`, `z` of the centre, or `area`; edges: `x`, `y`, `z` or `length`), `order` (`asc` or `desc`;
`length` defaults to `desc`, the rest to `asc`) and `limit` (1-1000). `count`
is the number of matches before `limit`. Ties keep the engine's order. With
none of these inputs the result is unchanged. `boundsMm` in a query matches by
overlap, not containment. `plasticity_find_faces` also takes `sortBy: "area"`
(default order `desc`): the read model has no face area, so the tool measures
the exact trimmed area of the matched faces in one native read (the one behind
`plasticity_measure_face_properties`), adds `areaMm2` to each match, then sorts
and limits. At most 256 faces can be measured; a query that matches more fails
and asks for a narrower one. `sortBy: "area", limit: 1` picks the main face
over small fragments (for example an enclosure floor split by bosses). No
other query makes that extra read.

A direct `plasticity_find_faces` or `plasticity_find_edges` call without
`limit` never returns more than 8,000 bytes. When the full reply would be
larger, it carries the matches that fit (in the usual order), `count` (the
total), `truncated: true` and `hint: "add limit (sortBy picks which matches) or narrow the query"`. Only `limit` lifts the cut;
`sortBy` without `limit` is still cut (it chooses which matches stay). The
`next` text says "add limit (e.g. 20) with sortBy".
A reply of 8,000 bytes or less is unchanged, an explicit `limit` is always
honoured, and the steps of a `plasticity_batch` are never cut (a later step can
reference every match).

### Edge and face queries on edit tools (speed tier 1d)

`plasticity_fillet` and `plasticity_chamfer` take `edgeQuery` instead of
`edgeIds` (exactly one of the two; anything else is a validation error), so a
fillet or chamfer needs no separate `plasticity_find_edges` step. `edgeQuery`
is the `plasticity_find_edges` query without `bodyIds` (the tool's `id` is the
body), with optional top-level `sortBy` (`length`, `x`, `y`, `z`), `order` and
`limit` that pick among the matches exactly as in `plasticity_find_edges`
(they are an error with `edgeIds`). The query is resolved against the current
state first; it must match the revision (`Stale reference` otherwise). If it
matches nothing the call fails with `edgeQuery matched no edges on body <id>:
<the query as sent>`. The reply is the usual edit reply plus `edgeCount`
(`edgeIds` calls reply as before). In a batch the revision auto-fills as for
every other step.

`edgeQuery.adjacentFace` names one face of the body by a query instead of by
id: `{ planar, normal, ..., sortBy: "x"|"y"|"z", order, limit }` takes the
`plasticity_find_faces` fields (without `bodyIds` and `adjacentEdgeIds`), and
the edges of that face match. It must resolve to exactly one face (use `sortBy`
with `limit: 1`). The top rim of a shell is one step:
`{"toolName":"plasticity_chamfer","arguments":{"id":"$0.added[0]","edgeQuery":{"adjacentFace":{"planar":true,"normal":{"vector":[0,0,1]},"sortBy":"z","order":"desc","limit":1}},"distanceMm":1}}`
instead of `find_faces` (top), `find_edges` (`adjacentFaceIds`), `chamfer`. It
selects every edge of that face, inner loops included: the rim of each hole or
pocket on the face as well as its outer edge. The read model does not say which
loop of a face is the outer one, so there is no `outerLoopOnly` option; pick the
outer edges with a second criterion (`lengthMm`, `boundsMm`) when needed.
`plasticity_extrude_faces` takes `faceQuery` (a `plasticity_find_faces` query
without `bodyIds`, `sortBy` `x`/`y`/`z`, `order`, `limit`) instead of
`faceIds` the same way and adds `faceCount`. In the tool list `edgeQuery` and
`faceQuery` are plain objects; the full schema is checked when the call runs.

Guards: an empty query (`{}`, or an `adjacentFace` with no criterion besides
`sortBy`, `order` and `limit`) is an error (`edgeQuery needs at least one
criterion`), never "every edge" or "every face". So is a query with an empty
list criterion (`adjacentFaceIds: []`, `adjacentEdgeIds: []`, `edgeIds: []`,
`curveTypes: []`, `surfaceTypes: []`, also inside `adjacentFace`): the error
names the key (`edgeQuery: adjacentFaceIds is an empty list ...`) and nothing
runs. In a batch, when the empty list came from a `$n` reference, the error
names the reference and says it matched nothing (`edgeQuery: adjacentFaceIds is
empty because $0.result.matches[*].id matched nothing in step 0 ...`), before
the step is called. An empty list names nothing, so it also matches nothing in
the matchers behind `plasticity_find_edges` and `plasticity_find_faces`
(`adjacentFaceIds: []` returns zero matches; it used to return every edge,
because `[].every(...)` is true). The same holds for the other list criteria:
`edgeIds`, `bodyIds`, `curveTypes` and `surfaceTypes` with `[]` match nothing. The keys `__proto__`,
`constructor` and `prototype` are refused by name, at any depth (a raw
`__proto__` key would otherwise be dropped and leave `{}`). `limit` needs
`sortBy` (`limit needs sortBy`). Ties are deterministic: after `sortBy`, equal
values (rounded to 1e-6 mm) are ordered by id, and when `limit` cuts through a
group of equal values the reply carries `tie: true`. The reply lists `edgeIds`
(or `faceIds`) when there are 16 or fewer, and `edgeCount` (`faceCount`) always.
If the native fillet, chamfer or extrusion fails after a query pick, the error
adds `(edgeQuery picked N edges; first 8: ...)`.

A cut find reply now starts with `next`, a concrete move: a direct find reply
over 8,000 bytes begins `{"next":"<count> matches; add limit (e.g. 20) with
sortBy, or use plasticity_describe_body for hole, boss and plane positions", ...}`
(for edges: `..., or narrow the query`), and a batch read cut at 1,500 bytes
begins with `next: "<count> matches; add return: [\"matches[*].id\"] ..."`.
`truncated` and the older `hint` stay. In a `detail: "lean"` batch,
`plasticity_status` without `return` whose reply would be cut answers
`{ revision, undoDepth, bodyCount, bodies: [{ id, type, name, boundsMm }, ...
up to 20], moreBodies?, hint?, omitted: [keys] }` instead. `omitted` names the
keys the step left out (`documentToken`, `regions`, `selection`,
`construction`, ...); a `return` list fetches them.

### Describe a body (speed tier 1c)

`plasticity_describe_body` (`{ id }`, strict, read-only, in the compact list)
returns one body in 1-2 KB instead of the 17-110 KB of
`plasticity_body_info`. It is built from the read model with no extra native
call, in millimetres, rounded to 4 decimals. Three byte limits hold: one body
(`{ id }`) is never longer than 4,096 bytes; `ids` and `{}` (up to 8 bodies) are
never longer than 12,000 bytes in all (each body gets an equal share of it, at
most 4,096 bytes, and is trimmed to that share with the same `more` counts: no
body is dropped); the list of more than 8 bodies is never longer than 6,000
bytes. The limits also hold for a describe step inside a batch (the batch's
1,500-byte read cut does not apply to it). `name` is cut to 120 characters; every list is capped
(12 plane positions per group, 16 axis points per cylinder group, 12 blend
radii, 8 cone half-angles, 50 cylinder groups) with a `more` count; beyond that
the longest list is shortened first (the cylinder groups with the fewest faces
go last of all, and the groups with the most faces stay). As a last resort
whole sections are left out in this order: `otherSurfaces`, `blendRadii`,
`cylinders`, `planes`, each leaving `otherSurfacesMore`, `blendRadiiMore`,
`cylindersMore` or `planesMore: <n>`. `truncated: true` is set whenever one of
those top-level counts is present. The result is built in one pass: 3,000
cylinder groups take a few milliseconds. `revision` is always in the reply
(the status reply's `documentToken` is not repeated here).

- `id, type, name, revision, boundsMm, sizeMm, faceCount, edgeCount, vertexCount`.
- `planes`: planar faces grouped by outward normal: `xPos`, `xNeg`, `yPos`,
  `yNeg`, `zPos`, `zNeg`, and `slanted` (each entry carries its `normal`). Each
  group lists distinct plane positions in ascending order as
  `{ mm, count?, face }`: `mm` is the plane's coordinate on that axis for an
  axis-aligned group, and the signed offset along the normal for `slanted`;
  `count` is the number of faces on it (left out when 1) and `face` the id of
  the face with the largest bounding box at that offset (not the exact area). A
  cavity floor reads as a `zPos` entry below the top, and the inner walls as
  `xPos`/`xNeg`/`yPos`/`yNeg` entries inside the bounds: read inner walls and
  floors from `planes`. There is no `cavity` field: a derived pocket was wrong
  for a lid seat, a boss taller than the rim, two pockets, a plate with posts
  and a bracket with a window, so it was removed. At most 12 positions per
  group; `planes.more` maps a group to the number left out.
- `cylinders`: groups by radius, axis direction and kind:
  `{ radiusMm, axis, kind, sweepDeg?, count, faces?, axisPointsMm, more? }`.
  `axis` is `"x"`, `"y"` or `"z"`, else a unit vector. `kind` is `"hole"` or
  `"boss"` from the face normal (toward or away from the axis) for a full-turn
  face, and is left out when the normal does not say. A face is a full turn
  when the circle edges at one end of it sweep 360 degrees (one closed circle,
  or seam-split circles of that end adding up to 360; a sweep of 359.9 or more
  counts). Any other face with circle edges is a part turn: its `kind` is
  `"arc"`, with `sweepDeg` (the largest sum over its ends, from each edge's
  start, midpoint and end). A slot end reads as an arc of 180 and the corner of
  an imported rounded rectangle as an arc of 90, never as a hole or boss; an
  arc stays in its own group (by sweep, to the degree) and has `axisPointsMm`
  like any group. Where a circle edge carries no geometry its sweep is unknown
  and two circle edges count as a full turn. A cylinder face with no circle edge at all cannot
  say, so its normal decides as before. `count` is the number of distinct axes
  (features), not faces; `faces` is the number of faces and appears only when
  it differs from `count` (one boss clipped by walls can be two faces).
  `axisPointsMm` lists one point on each distinct axis (at the middle of the
  faces' extent along an axis-aligned axis), at most 16, with a `more` count;
  coaxial holes through opposite walls merge into one axis point. Grouping
  treats direction components below 1e-6 as 0 before it picks the sign, merges
  axis points within 0.001 mm, and merges radii within 0.0001 mm of a group's
  first radius. Cylindrical blend faces are not listed here (see `blendRadii`).
- `otherSurfaces`: face counts by surface type (`Cone` also has `halfAngleDeg`).
- `blendRadii`: `{ "<radius mm>": faceCount }` for fillet and blend faces.
- In each `cylinders` group, only when every face of the group is a full turn
  and they agree: `extentMm: [from, to]`, the group's length along its axis
  (axis-aligned axes). For holes, `through` appears only under a proof from the
  read model, and is otherwise left out: `through: true` when the hole's own
  extent reaches the body's bounding extent along the axis at both ends (within
  0.001 mm), i.e. it leaves the body's outer bounds on both sides;
  `through: false` when a flat face closes the bore at one end (a plane normal
  to the axis, at that end, whose only edges are the bore's own circle edges
  and whose bounds hold the axis point and stay within the bore radius). A
  filleted, chamfered or stepped floor, a vented floor, a bore that opens into
  an internal cavity, and a hole in a leg or boss that does not reach the
  body's overall bounds (the hole of an L-bracket's leg) therefore carry no
  `through` field, though they may be through holes. Mixed faces in a group
  leave it out too. `through` is a claim about Solids only: a Sheet (a cup made
  of a cylinder wall and a bottom disc) never carries it, whatever its bounds
  say.

Forms: `{ id }` replies with the description as above (unchanged shape).
`{ ids: [1-8 ids] }` replies `{ revision, bodies: [description without its own
revision, ...] }` in the order asked. `{}` describes every body the same way
when the document has 8 or fewer, else replies `{ revision, bodyCount, bodies:
[{ id, type, name, boundsMm }, ...up to 40], more?, hint }`: `name` is cut to 40
characters, `boundsMm` is rounded to 3 decimals, and `more` counts the bodies
left out (entries are also dropped from the end until the list fits 6,000
bytes). End a build batch with a describe step to verify; call `{}` first only
to fit existing bodies or find free space. An enclosure base reads in about
1.6 KB, and its hole and axis positions need no face search (its screw bosses,
clipped by the walls, read as arcs, with their axis points).

All of these are plain keys, so `return` in a batch step can name them:
`return: ["cylinders", "planes.zNeg", "blendRadii", "sizeMm"]`. A face id from
`planes` goes straight into `find_faces`/`fillet`/`extrude_faces`.

`plasticity_body_info` takes optional `faces`, `edges` and `vertices` booleans
(default true: the reply is unchanged). `false` leaves that list out of
`body`; the id lists stay. When the reply is over 20,000 bytes and none of the
three flags was passed, it still carries everything and adds a top-level
`hint: "large reply; use plasticity_describe_body, or pass edges:false/vertices:false"`.

Inside a batch the server reads the document once per edit step instead of
5-7 times. The state read after step k stands in for step k+1's
journal-before, revision check and before-state. Every state read that would
be answered from that cache first runs one small native probe (the exact
revision plus the active workplane, body names and regions, with no topology),
also the second and later reads inside one step. So a tool that waits for
something slow (a download, a native read, a solver run) and then checks the
document again sees an edit made in the Plasticity UI meanwhile, and its
"document changed while ..." guard fails the step as before. If the probe
differs, the server reads the document again; a stale step fails as a stale
revision. A read is cached only when no mutation started while it was pending.
A mutation, an uncertain outcome or a failed step ends the reuse. Inside a
batch, `sortBy: "area"` measures against the same probed state instead of two
extra full reads. Direct tool calls read as before. Journal entries and replies
are the same as without reuse. Each journal entry is still written and
flushed when its step completes.

The compact tool list also names `plasticity_create_rib`,
`plasticity_create_screw_boss_pattern`, `plasticity_create_connector_opening`,
`plasticity_create_through_hole_pattern`, `plasticity_create_countersink_pattern`,
`plasticity_check_interference`,
`plasticity_measure_parallel_planar_face_clearance` and
`plasticity_set_driving_distance`, so a typical part needs no catalog lookup.
`plasticity_create_cylinder` takes `centerMm` as the centre of the BASE face;
the cylinder extends `heightMm` along `axis`.

Benchmark: `node discovery/speed-2026-11/parts.ts --tier1 a1 a2 b c d e`
(writes `part-<name>-tier1.json`).

### Brackets and mating parts

Three tools for custom brackets and multi-part assemblies, all in the compact
list, all strict, all in millimetres. Nothing is recognised by heuristics:
`plasticity_place_body` uses only bounds points or face ids you name, and
`plasticity_transfer_holes` uses only full-turn cylinder faces picked by
radius (within `toleranceMm`, default 0.01) and axis, or axes you give. The
rule is "provable or refused". What the inputs (and, for a transfer, exact
ray probes of the target) can predict is refused before the first native call,
with the document unchanged. Some outcomes are only caught by the read-back
after the native steps: a native step that fails; an edge shorter than 0.05 mm
or an invalid body that the planning rules below did not predict; a bracket
hole cut that changes another leg's faces; a transfer cut that is not whole
(a breakout between the probe rays, a countersink cone or counterbore that
leaves its wall). Each tool reads its result back from a fresh state read;
when the read-back does not prove the request, the tool undoes its own steps
(counted from the Undo depth) and the error says the document is unchanged.
The undone steps then sit on Plasticity's redo stack until the next edit
clears it (no operation clears it sooner): do not call `plasticity_redo` after
such an error, since it would replay the first rejected step (for example a
stray cutter body); the error says so. Only when the undo itself is uncertain
(a CDP timeout, an Undo that does not lower the Undo depth) does the error say
how many of its steps may remain and to call `plasticity_reconcile`.
`undoSteps` is always the measured Undo depth change.

**`plasticity_create_bracket`** builds an L, U, Z or flat sheet-style bracket
as one Solid in one call. `originMm` is the minimum corner of the bracket's
bounds. The width (`widthMm`) runs along +Y; the profile lies in the XZ plane.
`legs` are outer sizes: L `{ baseMm, uprightMm }`, U `{ baseMm, leftMm,
rightMm }`, Z `{ lowerMm, webMm, upperMm }`, flat `{ lengthMm }`. 40 x 40 x 30
wide, 4 thick is the audit L-bracket. Native steps: one box per leg and one
union; one fillet of the inner bends (`innerBendRadiusMm`; the outer corner of
a bend stays sharp, as in the audit bracket); one fillet of the free outer
corners (`cornerRadiusMm`, rounded in the leg's plane); one
`plasticity_create_rib` per gusset with `side: "centered"`, so its place does
not depend on point order; one hole recipe per hole item; one delete of the
construction Wires the rib, slot and countersink recipes leave. The reply
holds `bodyId`, `derived` (computed from the inputs before any native call and
checked against the built body) and `faceIds` (read back: each leg's
`outerFaceId` and `innerFaceId`, given only when exactly one planar face
matches; a gusset splits the inner face, so it is left out then).

Leg frames. "Outer face" is the face on the convex side of the bend;
`planeNormal` points out of it and `outerFaceOffsetMm` is its coordinate on
that axis. `frameOriginMm` is the outer face's corner at the bend end, at the
minimum-width side. `alongAxis` points from the bend toward the free end;
`acrossAxis` is +Y for every leg. A hole position is `[along, across]` from the
frame origin. `flatSpanMm` is the along range clear of bends: the hole region.
o is `originMm`, t the thickness, r the inner bend radius.

| Profile | Leg | planeNormal | frameOriginMm | alongAxis | flatSpanMm |
| --- | --- | --- | --- | --- | --- |
| L | base | -Z | o | +X | [t+r, base] |
| L | upright | -X | o | +Z | [t+r, upright] |
| U | base | -Z | o | +X | [t+r, base-t-r] |
| U | left | -X | o | +Z | [t+r, left] |
| U | right | +X | o + (base, 0, 0) | +Z | [t+r, right] |
| Z | lower | -Z | o + (lower, 0, 0) | -X | [t+r, lower] |
| Z | web | +X | o + (lower, 0, 0) | +Z | [t+r, web-t-r] |
| Z | upper | +Z | o + (lower-t, 0, web) | +X | [t+r, upper] |
| flat | flat | -Z | o | +X | [0, length] |

`derived` also gives `boundsMm`, `holeAxesMm` (`{ leg, pointMm, axis,
diameterMm, slot?, countersunk? }`: `pointMm` lies on the outer face and
`axis` points into the leg), `bendAxesMm`, `cornerAxesMm` and
`gussetBoundsMm` (one entry per gusset, the visible gusset from the inner
faces). Every `derived` value is in the bracket's build position, from
`originMm`: after `plasticity_place_body` moves or turns the bracket they are
stale, so read the axes again from the body (or select them with
`plasticity_transfer_holes`) instead of passing old `holeAxesMm`. Hole layouts:
`explicit` takes `positionsMm`; `line-across` puts the
holes at the middle of the flat span, across the width, spaced by `pitchMm`
(centred) or spread from `marginMm` to `marginMm` from the side edges;
`line-along` puts them on the width centre line, spaced by `pitchMm` (centred
in the flat span) or spread from `marginMm` past each end of the flat span;
`grid` (even count) makes two rows `marginMm` from the side edges, with
`count/2` columns placed like `line-along`. `slot: { lengthMm, direction }` is
an overall slot length with its long axis `along` or `across` the leg (its
world direction is in `holeAxesMm[*].slot.directionAxis`).
`countersunk: { headDiameterMm }` is a 90 degree countersink that opens on the
inner face (the screw head sits inside the bend); a slot cannot be countersunk.
A gusset (L only) is a triangle whose sides meet the inner faces `sizeMm` from
the inner corner: one gusset is centred on the width; two sit flush with the
side faces (`positions: "edges"`, the default) or centred in each half
(`"centered"`).

Gusset limit. The rib profile runs e = min(0.5, t/4) mm further into each leg
than the visible gusset, so its buried tip lies t + `sizeMm` + e from the outer
corner. The tip must end at least 0.05 mm inside the leg at every across
position of the gusset: before the leg end, and, with `cornerRadiusMm`, inside
the rounded corner where an edge gusset sits in it (the clip at the rounded
corner). `sizeMm` must also be at most the shorter leg minus t and the corner
radius. A larger `sizeMm` is refused before any native call and the message
gives the largest allowed value (for 40 x 40, t 4: 35.45 mm; with a 3 mm corner
radius and two edge gussets 4 thick: 32.45 mm).

Holes in a narrow U. Each cutter runs 0.5 mm past both faces of its leg,
except where another leg stands behind the inner face (a U side leg, below the
other side leg's top): there it runs the smaller of 0.5 mm and half the free
gap between the side legs, so the cut never reaches the other leg. After each hole item the read-back
checks that the outer and inner faces of every other leg have the same face
and edge counts as before it.

Validation before any native call, naming the offending item: positive sizes;
every dimension (and the overall bounds extent) at most 10,000 mm and every
positive feature size at least 0.05 mm; legs longer than t (U base and Z web
longer than 2t); a bend radius less than the shorter adjacent leg minus t, and
less than half the inner base or web when two bends share it; every flat span
at least 0.05 mm; a corner radius less than half the width and than the flat
span, leaving straight sides of at least 0.05 mm; every hole footprint (the
head for a countersink, the full slot) at least one diameter from the flat
region's edges, the bends and the rounded corners (`allowEdgeHoles: true` only
asks it to stay inside), clear of the gusset footprints and of other holes; a
countersink less deep than t; gussets larger than the bend radius by at least
0.05 mm and within the gusset limit above; a gusset thickness that leaves at
least 0.05 mm of inner face beside each gusset (to a side face, or between two
gussets). The read-back after the build checks the bounds, the
bend, corner and hole cylinders, the countersink cones, the gusset faces, that
no edge is shorter than 0.05 mm (a sliver), and that the body is a closed,
natively valid Solid (the check `plasticity_validate_bodies` runs); a failure
undoes the build.

**`plasticity_place_body`** moves one body (or, with `copy: true`, a copy) so
that `anchor` on it lands on `to` on another body. An anchor is exactly one of
`point` (a bounds point: `min`, `max`, `center`, `bottom-center`,
`top-center`, `x--center`, `x+-center`, `y--center`, `y+-center`, `z--center`,
`z+-center`) or `faceId` (an explicit planar face; its point is the kernel's
own face midpoint, the `centerMm` that `plasticity_find_faces` reports, which
is not the area centroid on a face with rounded corners). `rotate: { axis,
quarterTurns }` first turns the body in 90 degree steps about its bounds centre
(right-hand rule); quarter turns about x, y or z are the only rotation, so the
tool does not remove a twist about the mate normal (a body turned 30 degrees
about z stays turned) and does not turn faces to mate. With two faces, the
faces after the rotation must mate: opposed normals (`relation: "mating"`, the
default), within a sine of 1e-6. Same-facing faces would put one body inside
the other; they are refused with a message that says to flip the body (a
half turn) or to pass `relation: "aligned"` to place same-facing faces flush
(the reply then says `relation: "parallel"`). Faces that are neither are
refused with both normals and the angle (printed so that a small angle is not
shown as zero). `gapMm` (two faces only) runs along the fixed face's outward
normal: positive moves the faces apart; a negative `gapMm` pushes the bodies
into each other and is refused unless `allowOverlap: true`. `offsetMm` is
added last. The whole transform is computed first, then applied with the
existing duplicate, rotate and move operations (one, two or three Undo
steps). The read-back requires the new bounds to equal the rotated and moved
bounds within 1e-6 mm, the anchor (a bounds point from the fresh bounds, or
exactly one planar face with the expected normal at the expected centre) to
land within 1e-6 mm, and the fixed body (and a copied original) to be
unchanged; a failure undoes the steps. The reply gives `deltaMm`, `anchorMm`,
`boundsMm`, `relation`, `rotation`, `movedFaceId` and `undoSteps`. Limits:
with bounds anchors only, a quarter turn and its opposite give the same
bounds, so the read-back cannot see the turn direction; a face anchor can (the
live script checks +90 degrees about z this way). The tool does not check
interference beyond the face relation: a non-convex body (an L bracket's other
leg) can still reach into the fixed body; use `plasticity_check_interference`.

**`plasticity_transfer_holes`** cuts holes in `targetId` that line up with
axes of `sourceId`. `select: { radiusMm, toleranceMm? (0.01), axis? ("x", "y",
"z" or a vector, either sign), kind? ("hole" by default, "boss" or "any"),
withinMm? }` picks the source's full-turn cylinder faces whose radius is
within `toleranceMm` (default 0.01) of `radiusMm`: a Cylinder face that is not
a blend and whose circle edges at one end sweep 360 degrees, every circle edge
measured (an arc, a blend, or a face whose circle edges carry no geometry is
never used). The kind is the same provable rule `plasticity_describe_body`
uses: a face whose normal points to its axis is a hole, away from it a boss;
a cylinder whose kind cannot be proven is never taken, even with `"any"`.
`withinMm` filters by the face centre projected onto its axis; coaxial faces
are one axis. Or `axesMm: [{ pointMm, axis }]` gives the axes
(`derived.holeAxesMm` items pass as they are, but only in the bracket's build
position). Each transferred axis reports `kind` (`"hole"`, `"boss"`, or
`"explicit"` for a given axis). When `select` matches nothing the call is
refused with the selection and every full-turn radius on the source
(`[{ radiusMm, kind, axes }]`). Two parallel axes closer than the hole
diameter (the counterbore or countersink head diameter when there is one) are
refused: the holes would overlap.

Entry side, from exact rays. Each axis is judged by exact ray hits on the
target from the kernel (the operation behind `plasticity_probe_surface`), not
by face bounds. The rays run parallel to the axis: the axis ray and 8 rays on
the bore radius, plus 8 on the head radius with a countersink or counterbore,
cast both ways. For `select` they start at the two ends of the source hole
(along +axis from its upper end, along -axis from its lower end); for `axesMm`
they start at `pointMm`. A face a ray starts on and leaves is ignored, so a
part touching the source face works. With `axesMm`, rays that hit the target
on both sides mean the point lies between target faces (refused); with
`select`, the drill runs toward the side where the target is nearer to the
hole's end (a bracket against one wall of an enclosure drills that wall, not
the far one) and only a tie is refused. No hit at all is a miss. The drill
runs toward the side with hits. The entry is the axis ray's
first hit: it must be a planar face normal to the axis that faces the source,
and every rim ray must meet that face's plane first, at the same distance. So
a recessed entry face works: the floor of a pocket, a tray or an enclosure, a
round recess or a cup, a face beside a rib, at any rotation about the axis,
as long as nothing else lies over the bore. It is refused when material comes
first (a rim ray meets another face before the entry plane, for example a
pocket wall within the rim: "material precedes the first planar face"), when
the rim runs over an edge (a rim ray finds no material or meets the material
deeper), and when the first hit is curved or oblique (a non-planar or oblique
entry is not supported). The rim must also lie inside the entry face by its
own line and circle edges, inner loops included. An existing hole is refused
with its own message: the axis finds no material where the rim rays meet the
entry plane, or an inward-facing coaxial cylinder or cone (a bore, a
countersink) lies on the part of the axis the cut reaches; a coaxial recess or
cup wall that ends at the entry plane is not a hole, nor is an outward face
such as a rod or boss drilled down its middle, and a coaxial face whose facing
cannot be proven is refused. `onMiss: "skip"` passes over axes that miss the
target and lists them in `skipped: [{ axisIndex, pointMm, axis, reason }]`;
the rest are cut. Other refusals still refuse the call, and so does a call in
which every axis misses. The default is `onMiss: "error"`.

`hole: { diameterMm, through: true | depthMm, countersunk?: { headDiameterMm },
counterbore?: { diameterMm, depthMm } }`: `through` cuts from the entry to the
far side of the target's bounds, so every wall after the entry on the line is
drilled. Before the edit all bore rays must meet the same crossings after the
entry (the same count at the same distances); otherwise the cut is refused and
the message says what the bore runs into: a side wall or step, an oblique face
(a chamfer or slope), or a curved face (a cross hole or a fillet). `depthMm` is
a blind hole and is checked against the local wall: the least distance, over
the bore rays, from the entry to the next crossing must leave at least 0.05 mm
under the floor. A countersink's depth must stay in the bore rays' wall and a
counterbore's depth in the bore and head rays' wall. Countersunk (90 degrees)
and counterbore holes are through holes; a countersink opens on the entry face
(the face toward the source). The existing through, blind, countersink and
counterbore recipes (single or pattern, one call per drill direction) do the
cut; a transfer adds `ceil(rays / 64)` probe calls (18 rays per axis, 34 with
a head), a few milliseconds each. The read-back requires, for every axis, a
full-turn hole face of the diameter coaxial with the source axis within
1e-6 mm, an entry circle centred on the entry point bordering a planar face in
the entry plane, every face the cut made whole (each bore cylinder, the
countersink cone, the counterbore wall and floor: every circle edge a full
turn and no other edge shared with another face; the error names the axis and
what the cut ran into), for a blind hole a flat floor at the depth, and a
closed, natively valid target; a failure undoes the cut. The reply gives
`axesMm` (with `entryPointMm`, `entryFaceId` and `kind`), `axisCount` (axes
cut), `holeCount` (separate bores proven by read-back: one axis through both
walls of a U is 2), `targetHoleCount` (equal to `holeCount`), `holes` with
their read-back axes and `bores`, `skipped` (with `onMiss: "skip"`),
`maxCoaxialOffsetMm` and `probe` (`{ rays, calls, ms }`).

Live acceptance: `PLASTICITY_CDP_URL=http://127.0.0.1:PORT npm run
accept:native-bracket-mate -- --target ID --allow-disposable-mutations
--output NEW_DIR` (the audit L-bracket in one call, a U bracket with a slotted
pair, a Z bracket with a 2 x 2 grid, a block + bracket mate chain as direct
calls and as one lean batch, live rejections, cases `d1`-`d11` with the
review's failing inputs, one per defect, and cases `r2b1` (recessed entries),
`r2b2` (countersink and counterbore breakout) and `r2t` (ray time); every check reads the geometry with
`plasticity_find_faces`/`plasticity_find_edges` (limit 1000),
`plasticity_validate_bodies`, `plasticity_check_interference` and
`plasticity_measure_parallel_planar_face_clearance`; every refusal checks
that the Undo depth and the body list are unchanged, and the last line gives
the restored baseline).

## Tools

- Connection: diagnose, list windows, connect, status, capabilities, reconcile
- Analysis: list bodies, revision-bound planar regions, exact native curve
  fragments and open-Wire endpoints, editable Wire boundary/control handles, native B-Rep vertices, face normals/surface types/radii, edge
  directions/lengths/adjacency, exact point distance, planar-face separation and angle,
  linear-edge angle and supporting-line clearance, sampled native face-draft classification,
  persistent topology distance and radius annotations, semantic face and edge search, revision-bound
  named selections, exact temporary B-Rep volumetric interference checks,
  exact Solid volume, surface area, and volume centroid, exact selected-face
  area, trimmed boundary length, loop count, and area centroid,
  native body validity, shell closure, printability, and removable viewport section analyses
- Strength: isolated Codex fact extraction, versioned axial, cantilever and
  rectangular-plate methods, deterministic scenario and candidate calculations,
  exact native rectangular-member/plate verification, exact line/circle planar-section properties,
  exact arbitrary-plane sections through native temporary cuts,
  nominal axial/biaxial-bending checks, maximum direct shear for proven solid
  rectangles, solid circles and concentric circular annuli, elastic torsional
  shear for the two circular families, exact single-through-fastener plate
  geometry with bearing/shear-out/net-section checks, one-fastener tension/shear
  and combined-load screening from traceable fastener data, configuration-bound
  heat-set-insert pullout/torque checks, elastic in-plane load distribution over
  a rigid equal-stiffness fastener group, exact rectangular-face group layout
  checks for edge distance, pitch, ligament, and supplied hardware/tool envelopes,
  plus an exact-geometry per-hole local bearing screen for groups (overall plate strength remains conditional),
  immutable reports, and stale detection
  for CAD faces/topology, material, printer profile, and orientation changes
- Collaboration: scene snapshots, change diff, wait for edits, read user-selected
  bodies, linked instances, groups, faces, and edges, and highlight the same
  revision-bound nodes or exact topology in Plasticity
- Measurement: exact revision-bound point, planar-face, and linear-edge queries;
  persistent native vertex distances and circular-edge radius annotations with list and delete
  operations tracked through Plasticity Undo/Redo
- Instances: create and list native linked copies, transform them independently,
  realize selected copies as ordinary B-Rep bodies, and delete them without
  deleting their source geometry
- Creation: box, cylinder, sphere, exact cone or conical frustum and exact ring torus with editable profiles,
  polyline, center-radius, diameter-defined, and three-point circles,
  interpolating NURBS curve, constant-radius helix, exact constant-width slot
  profiles around planar Wire spines,
  constrained B-Surface, planar Region patch, sweep, loft, and solid or hollow pipe
- Recipes: exact round through-holes, explicit multi-center through-hole,
  counterbore, countersink, and flat-bottom blind-hole patterns; through holes with either a flat-bottom counterbore or a
  conical countersink, single or multi-center straight through-slots with semicircular ends, oriented
  single or multi-center hex nut pockets, and single or multi-center
  three-stage heat-set insert pockets, plus single or multi-center attached
  screw bosses with blind pilot holes, matched rounded-print external and
  internal threads, printable hex screws and printable hex nuts,
  profile-driven support ribs, and rectangular arrays of round
  vents, plus cantilever snap-fits with integral hooks; recipes record all
  inputs and return every confirmed native history step; hollow hinge barrels
  can be joined along any world-space axis, circular cable channels can be cut
  along editable Wire paths, rectangular connector openings support exact
  corner radii, two enclosure halves can receive a clearance-matched lip and
  groove joint, paired locating pins expose radial and axial fit clearances,
  oriented tongue-and-groove and dovetail joints keep both construction profiles,
  and split screw/heat-set-insert joints bind the exact insert part number,
  source, thread diameter and pitch to explicit three-stage pocket dimensions
- Construction geometry: coordinate, face-center, and edge-midpoint datum
  points; coordinate, two-point, linear-edge, and cylindrical-face axes;
  explicit, three-point, planar-face, offset, and rotated saved planes;
  list, activate, remove, and refresh tools
- Editing: move, rotate, scale, exact planar face-to-face and cylindrical-axis
  placement of rigid body sets,
  exact native face move, arbitrary-axis rotation, and world-XYZ surface scale with adjacent-face retrimming,
  tolerance-controlled native face refit into a B-Surface,
  independent thickening of selected faces, signed face-loop insertion, and independent Sheet patches from Solid edge loops,
  exact native edge move, signed adjacent-surface edge offset, and compatible split-edge deletion with topology read-back,
  exact native block dimensioning, Boolean, native face-surface cutting, fillet,
  equal-distance chamfer, recognized-fillet removal, closed-profile/explicit-region Solid extrusion,
  signed planar Wire offset, curve-fragment trim, endpoint extension, local Wire control-point transforms and deletion, independent Wire and Region-boundary copies, Wire unjoin, curve imprint, face extrusion, profile revolve, signed
  face offset, Sheet thickening, face draft from a neutral face,
  inward/outward open-face shelling and closed-solid hollowing, exact face deletion/extraction/dissolve, Sheet-edge extension, closed-Sheet solidification,
  Sheet sewing, native G2 Surface Bridge, exact face unjoining, mirror, rectangular, radial, and curve body patterns,
  rename, delete, Undo, Redo
- Intent: a private local construction history records every journaled native
  CAD mutation, exact inputs, before/after revisions, compact geometry diffs
  and uncertain outcomes across MCP restarts; manual edits are reported as a
  divergence
- View: named camera orientations, fit, and a PNG screenshot captured from the
  visible Plasticity renderer through CDP screencast. Hidden windows are
  rejected to avoid stale frames; screenshots support visual review, while exact
  dimensions and geometry validity come from native B-Rep reads. `shader`
  (`isophotes`, `draft`, `faceDirection`, `zebraVertical`, `zebraHorizontal`,
  `topo`) sets Plasticity's analysis shader for one capture and restores the
  previous one in the same call, also when the capture fails; `frame: { bodyIds }`
  aims the camera at those bodies (same view direction) and puts the camera back
  exactly (the orbit controls, including their snap state, are restored and then
  the saved camera pose is written back, because the controls' own recompute
  differed in the last bits, 3e-16 m per capture). Both work with `path` (window
  or viewport mode) and with the inline JPEG, add no Undo step (checked) and
  report `view`. Live on 26.1.3: all six
  shaders change the window and viewport captures (mean absolute pixel
  difference 1.8-4.7), the default capture afterwards differs by 1.2e-5, and the
  camera comes back with deviation 0 (`accept:native-surfacing`)
- Documents: save a copy, open with mandatory backup, exact STEP and Parasolid
  (`.x_t`/`.x_b`) import/export, IGES (`.igs`/`.iges`) and ACIS SAT (`.sat`) export,
  native editable SVG Wire/Region import,
  orthographic hidden-line SVG drawings of Solid B-rep geometry, and
  approximate STL/OBJ reference-mesh import with explicit source units,
  millimeter-scaled binary STL export, validated OBJ export, and validated 3MF
  export with explicit tessellation tolerance and mesh-bound read-back

`plasticity_import_svg` maps SVG coordinate values through an explicit source
unit and creates ordinary editable native Wires. Closed valid contours also
appear as revision-bound Regions, so the agent can inspect their exact B-Rep
segments and use them directly for extrusion or other profile operations. SVG
transforms and path topology still affect placement and region formation, so
the agent must verify the imported geometry rather than trusting file metadata.

`plasticity_export_svg` preserves native Lines, full circles, trimmed circular
arcs, and one closed Ellipse Wire as exact SVG primitives. It approximates
other planar native B-Rep curves with adaptive polylines. The request sets
chord and tangent-angle tolerances; the SVG marks approximated paths, and the
MCP report states the maximum quarter-sample chord deviation observed. This is
an approximation check, not a global mathematical error bound. Noncoplanar
Wires are rejected.

Rational BCurves that fit a stable conic are exported as SVG ellipses or arcs
only after 65 further exact native B-Rep samples agree with the fit. The SVG
labels this finite-sample validation; it is not a proof of global equality.
Repeat the live gate on a separate disposable empty Plasticity document:

```sh
npm run accept:native-svg-rational -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-live \
  --output NEW_EMPTY_DIRECTORY
```

The verifier imports an authored rational STEP fixture, checks the native
degree-2 rational BCurve and generated SVG arc, then undoes the import. The
fixture remains in Redo history, so close the disposable test document after
the acceptance run.
The live NURBS acceptance can be repeated on an empty test window:

```sh
npm run accept:native-svg-approximation -- \
  --target TARGET_ID \
  --allow-live \
  --output /tmp/plasticity-mcp-output
```

`plasticity_export_hiddenline_svg` uses Plasticity's native hidden-line
projector for selected Solid bodies in the current orthographic camera. It
emits vector paths in projected model millimeters, including dashed hidden
edges, without embedding the viewport background. Set the intended front, top,
side, or isometric camera with `plasticity_set_view` first. Perspective views,
Sheets, instances, and non-Solid inputs are not supported by this export path;
the SVG is a derived drawing, while `.plasticity` and STEP remain editable CAD.

The guarded live acceptance can be repeated with:

```sh
npm run accept:native-hiddenline-svg -- \
  --target TARGET_ID \
  --solid-id SOLID_ID \
  --allow-live \
  --output /tmp/plasticity-mcp-output
```

`plasticity_create_slot_profiles` preserves one or more current planar Wire
spines and creates separate closed constant-width Wires around them. The width
is the full finished profile width. The resulting Region can be extruded or
used as a cutter, so this operation is useful for routed cable channels,
gaskets, and curved slots. Plasticity needs the spine itself to determine a
plane; a lone straight segment is ambiguous and should instead use the
dedicated straight slotted-hole recipe or a spine with additional planar
geometry.

The guarded live acceptance can be repeated with:

```sh
npm run accept:native-slot-profiles -- \
  --target TARGET_ID \
  --allow-disposable-mutations \
  --output /tmp/plasticity-mcp-output
```

`plasticity_import_reference_mesh` keeps downloaded or scanned STL/OBJ data in
a separate approximate reference-mesh collection rather than presenting it as
editable B-Rep. `plasticity_list_reference_meshes` reports its source,
world-space mesh bounds, triangle counts, and transform with
`measurementSource: "reference-mesh"`. Dedicated select, rename, move, rotate,
scale, and delete tools let the agent register a reference against qualified
dimensions inside Plasticity. Reference meshes can also be placed in native
groups and controlled through the mixed-node visibility and lock tools. These
bounds can guide placement and visual comparison, but they cannot prove a
manufacturing dimension or replace manufacturer CAD, drawings, or
user-confirmed measurements.
`plasticity_convert_reference_mesh_to_polysplines` turns one reference mesh into
a native PolySplines Solid (closed mesh) or Sheet (open mesh). The reference mesh
is consumed: it disappears from `plasticity_list_reference_meshes`. The result is
the smooth subdivision-limit surface, so a 10 mm quad cube becomes a rounded
cube about 8.4 mm across (6 faces, 12 edges, 8 vertices). Verified live on
Plasticity 26.1.3 only:
- A triangle-only mesh also converts: a 12-triangle 10 mm cube gave a 36-face
  Solid (72 edges, 38 vertices), shrunk like the quad cube.
- On an open 3 x 3 quad grid, the default gives a 9-face Sheet.
  `interpolateBoundary: true` gives 21 faces with the same bounds; its effect on
  the boundary shape is not verified.
- `mergePatches` defaults to true; `false` showed no effect on that grid.
- `roundedCorners` showed no effect and is not exposed, and PolySplines import
  is not driven.

When a product search yields a directly downloadable public STL or OBJ,
`plasticity_download_and_import_reference_mesh` can fetch and import only the
explicitly selected HTTPS asset. The call must name its format and source unit
(STL itself carries no unit metadata); source URL, optional source page, license,
confidence, SHA-256, and observed mesh bounds are recorded separately from exact
CAD imports. Downloads are limited to public IPv4 destinations, bounded to 64
MiB, reject archives, and validate the mesh and finite coordinates before the
native import. Search results are never downloaded automatically, and an
approximate mesh does not become a fit-critical datum without confirmed
measurements.

Plasticity's native 3MF importer is also exposed for reference acquisition.
`plasticity_import_reference_3mf` uses the unit embedded in the 3MF model (the
3MF default is millimetres) and imports tessellated reference geometry, not an
editable B-Rep. A selected direct HTTPS 3MF asset can be downloaded and
imported with `plasticity_download_and_import_reference_3mf`; the bounded ZIP
reader validates package paths, limits expansion, checks CRCs, and records the
artifact hash and redacted source provenance. Its bounds remain approximate
reference-mesh evidence and must not replace fit-critical drawings or
confirmed dimensions.

The live remote-download acceptance can be repeated with a selected direct
asset URL. It temporarily imports the mesh into the explicit Plasticity window
with an explicit empty disposable scene and isolated stores. It checks source
geometry, artifact hash, Undo/Redo and durable history after MCP restart, then
restores the initial scene. Timeout/uncertain outcomes stop recovery mutations.

```sh
npm run accept:reference-mesh-download -- \
  --target TARGET_ID \
  --allow-disposable-mutations \
  --source-url https://raw.githubusercontent.com/Buildbee/example-stl/main/ascii-cube.stl \
  --source-page-url https://github.com/Buildbee/example-stl \
  --format stl \
  --source-unit millimeter \
  --output /tmp/plasticity-mcp-output
```

The guarded live acceptance can be repeated with:

```sh
npm run accept:native-reference-mesh -- \
  --target TARGET_ID \
  --allow-disposable-mutations \
  --output /tmp/plasticity-mcp-output
```

Files are never overwritten. After a command timeout or lost connection, the
server marks the mutation outcome uncertain and blocks further edits until
`plasticity_reconcile` reads the document. It never retries the command or
automatically undoes it.

The strength workflow is documented in
[`docs/strength-operations.md`](./strength-operations.md). It is available
through the `plasticity_strength_first` prompt and the
`plasticity://strength/workflow`, `plasticity://strength/methods`, and
`plasticity://strength/recovery` resources. Codex uses this deeper workflow when
the load, consequences, or a design decision warrant it; ordinary enclosure
and bracket modeling can start with a practical provisional design and basic
functional checks without a coupon campaign or detailed FEA. Numerical
calculations remain available when isolated Codex analysis is unavailable. Native verification
requires an explicit connected Plasticity window. `plasticity_inspect_planar_section`
reads one selected native Solid face. `plasticity_inspect_arbitrary_section`
measures an internal critical plane by cutting a native clone in a temporary
geometry database; the persistent Solid, revision and Undo/Redo history are
checked before the result is accepted. Both tools reject unsupported curves and
never use a render mesh as measurement evidence. Stored strength verification
is still face-bound; arbitrary-plane properties can be used in an unbound
scenario. They do not validate the whole part or approve a print. Workbench is
optional.

When exact-process physical material evidence is missing, the read-only
`plasticity_plan_single_material_strength_tests` MCP tool creates a measurement
matrix for the selected solver scope. It distinguishes road, in-plane
transverse and layer-normal properties, and can plan same-material layer
interface tests. It requires the exact printer/material/profile/orientation,
infill percentage and pattern, wall loops, top/bottom shell layers, nozzle
temperature and measured layer height; it does not invent
material values, design allowables, test standards, specimen dimensions or
sample counts. The active mechanical model remains one material per print
process. Complementary physical coupon records for that same exact process can be consolidated with `plasticity_combine_material_coupon_data` after the unique specimen count is confirmed; values are never averaged.

The static FEA supports the homogeneous-material CalculiX route and an
experimental layerwise orthotropic route. The latter uses one measured tensor
for the selected single material, mapped to each layer only after complete
G-code road-direction evidence and explicit user confirmation of slicer-to-CAD
and coupon-axis mapping. It creates a conformal mesh with shared nodes between
layers and labels solver stresses in each layer's local material frame. The
interfaces are assumed perfectly bonded: this mode does not model delamination,
different materials, or layer-varying properties, and it does not issue a
strength verdict. An
experimental `plasticity_analyze_cohesive_interface` tool can also export one
current Solid to STEP, split it at one or more explicitly supplied parallel
planes, mesh the regions in Gmsh, add PENTA6 cohesive elements, and run pinned
Code_Aster from exact-process interface-test curves and coupon records. The
legacy route uses DCB mode-I data; an experimental mixed-mode route uses matched
DCB/ENF/MMB evidence to fit a Turon cohesive law. The Turon route can use
homogeneous orthotropic bulk tensors and print frames from each immutable
exact-process coupon record. Cohesive analyses require one material process;
multi-plane analyses repeat the same measured interface law at every plane.
Mode-I accepts an explicit `modeILaw` choice of `CZM_EXP_REG` (the compatibility
default) or `CZM_LIN_REG`. Both use measured peak traction and integrated
fracture energy; neither fits arbitrary curve shape, so justify the selected
softening law against the measured curve.
Every new cohesive analysis requires `plasticity_plan_cohesive_layer_planes` to
derive profile-bound split planes; arbitrary unbound planes are rejected. The
planner derives copy-ready split planes from the
selected slicer profile hash, its layer height, a caller-supplied first-interface
anchor (validated against the Solid only when meshing succeeds), a confirmed
global build direction and explicit layer indices. Pass its plan and planes to
the cohesive analysis; the analysis checks the profile hash
against the physical test and, for orthotropic bulk, checks the build axis
against the exact coupon frame. It analyzes the full stack only when all layer
interfaces fit within the 32-plane solver limit. Larger stacks are marked as
selected-interface-only, and omitted layers remain unanalyzed.
New physical coupon records and same-material interface tests require the
measured slicer layer height in their immutable process identity; analysis
rejects legacy evidence without it and any mismatch even when the profile hash
matches.
Interface tests can additionally preserve actual specimen G-code provenance:
profile, model/G-code hashes, sampled per-layer road directions and a
user-confirmed slicer-to-global frame. This helps interpret the tested raster
orientation; it does not supply adhesion strength, qualify a cohesive law, or
feed road-direction data into the current cohesive solver.
When Workbench has a complete deposition-height schedule from the actual G-code,
`workbench_slicer_interface_heights` returns only selected interface heights
and the first-layer reference height. The planner accepts their relative values
as `interfaceOffsetsMm`, so a taller first layer or adaptive layer heights do
not get approximated by the nominal profile height. G-code Z values are in the
slicer's build frame; map only their relative offsets onto a separately
confirmed CAD build axis and anchor.
The same MCP response also reports selected layers' XY deposition-road
direction summaries from extruding linear G-code moves. It reports a dominant
road axis modulo 180 degrees and a directional-concentration value; arc and
spline extrusion moves make that layer's coverage explicitly partial. These
summaries describe the toolpath only and are not material properties or a
validated road-level strength model. The read-only
`workbench_slicer_layer_path_orientations` tool returns selected actual layers,
including the final layer, in bounded batches of 32 with their deposition Z and
the same job/profile/G-code hashes. The cohesive plane planner can preserve the
selected summaries with the exact job, profile, source-artifact, G-code, layer
count and relative-offset identities in an immutable analysis report. To send
layer directions into the solver, the user must additionally confirm that the
exact-process coupon's material axis 1 represents the dominant deposited-road
direction with `roadAxisMapping`, provide complete linear direction evidence
for every layer (up to 256), and explicitly enable the measured orthotropic bulk
tensor. The Mode-I and mixed-mode Turon routes then assign that one shared
measured tensor to each layer's own local frame. This represents orientation
changes only: it does not create different materials or layer properties.
Cohesive analysis still represents specified same-material layer interfaces,
not individual extrusion roads or within-layer raster mixtures. The same
measured, direction-independent cohesive law is repeated at every interface.
ENF and MMB calibration records must use the
same in-plane shear axis. A mixed-mode solver displacement must contain both
opening and shear and use that measured shear axis; other directions are
rejected before meshing because the law has one tangential response. This does
not prove the actual bond is isotropic or identify separate Mode-II/Mode-III
properties. Neither route qualifies part strength. It checks the CAD revision
and reports the raw solver response.
The public path has passed synthetic solver and MCP acceptance, including live
Code_Aster 17.4 runs with three distinct layer frames for both Mode-I and Turon,
but has not yet been run against registered physical coupon and interface-test data. Results are saved
as immutable cohesive reports and can be reread with
`plasticity_cohesive_fem_report`, which rechecks the CAD binding and exact
interface-test/coupon evidence. The Turon route additionally requires traceable
initial stiffness `K`, which is not inferred from a curve. Neither response is
a qualified material law or part-strength result. See
[`docs/cohesive-solver-spike.md`](./cohesive-solver-spike.md) and run
`npm run accept:code-aster-czm` to repeat the solver-only check.

The launcher uses the installed `codex` executable by default. Set
`PLASTICITY_CODEX_EXECUTABLE` to another trusted executable, and
`PLASTICITY_STRENGTH_ASSET_ROOT` to the directory containing explicitly
supplied analysis images. Images in the signed-in Codex user's
`~/.codex/attachments` folder are also accepted directly. Add other trusted
image folders with `PLASTICITY_STRENGTH_IMAGE_ROOTS`, separated by the
platform path separator. Each requested path must resolve inside one of those
roots; symlink targets outside them are rejected. Inputs remain bounded to
four PNG/JPEG/HEIC/HEIF images of at most 20 MiB each. On macOS, HEIC/HEIF
attachments are converted locally to JPEG in a private temporary directory for
Codex analysis; request fingerprints still bind to the original attachment.
Strength records default to
`.plasticity-mcp/strength`; a trusted process may override this with
`PLASTICITY_STRENGTH_ROOT`.

The guarded real-environment acceptance procedure and its measured results are
recorded in [`docs/strength-acceptance.md`](./strength-acceptance.md). It
uses a real stdio client, isolated Codex analysis and a disposable empty
Plasticity document; running the acceptance command without explicit mutation,
live-Codex, target and new-output flags performs no live work.

The exact face-bound section and direct-shear acceptance can be repeated with:

```sh
npm run accept:section-strength -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It creates and removes disposable native rectangle, circle, annulus and
perforated-rectangle bodies. The annulus is recognized from its two exact
concentric circular boundaries; unsupported section families remain explicit.

The exact single-fastener plate acceptance can be repeated with:

```sh
npm run accept:fastener-strength -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It creates a disposable 40 × 20 × 2 mm plate with one Ø6 mm through-hole,
reads thickness and every edge distance from opposed native faces, verifies
bearing, two-plane edge shear-out and net-section tension, checks stale-report
behavior, resolves an M5 tapped-metal request to the threaded-receiver method,
checks a clearly labelled synthetic three-mode capacity scenario and its stale
engagement behavior, then restores the empty document.

The fastener itself is a separate evidence-bound scenario. Call
`plasticity_calculate_fastener_member_strength` with the sourced tensile stress
area, effective shear area at the actual plane, one or two shear planes, axial
tension including applicable preload, transverse shear, and grade-specific
tensile/shear limits. It reports the two stresses, factored load ratios, and the
NASA screening interaction `R_t² + R_s³`. It does not infer a standard fastener
table from nominal diameter alone.

The receiving thread is checked separately with
`plasticity_calculate_threaded_receiver_strength`. For a tapped hole, nut, or
threaded insert it requires actual pitch and engagement, the number of fully
formed engaged threads, the worst-case axial demand, and explicit compatible
allowable loads for internal-thread stripping, external-thread stripping, and
fastener tension. It reports all three utilizations and can require the fastener
to fail in tension before either thread strips. A nominal designation such as
`M5×10` supplies thread metadata only. Procured nuts and inserts require a
specified assembly allowable or matched dedicated test rather than an
unqualified nominal shear-area estimate.

Before creating fastening geometry, call
`plasticity_resolve_fastener_designation` with the user's wording, for example
`винт M5x10`, `крепится на 4 болта M5x10 с гайками` or
`болт ISO 4017 M5×0,8×10 класс 8.8`. The resolver separates nominal thread
diameter, pitch, length, quantity, head/standard, property class, receiving
feature and fixed/adjustable/pivot intent, then lists the compatible CAD and
strength tools. Its default is `analysisIntent=both`; `nextQuestionPackage`
contains only the current logical package, with load path, joined materials and
process, and failure consequence first. Later packages cover joint purpose,
hardware selection, and qualified feature geometry without presenting every
future question at once. Natural phrases can resolve a nut, heat-set insert,
tapped metal, printed plastic, or a fully printed screw with a mating nut or a
generically named mating part without a redundant question. Russian forms such
as `печать винта M6x20 и ответной части` route to the matched custom-thread
tools. The printed-pair route does not import ISO coarse pitch from an M-like
crest diameter. An adjustment slot is routed only when adjustment is explicit.
Repeated fixed fasteners into printed plastic route to one grouped boss recipe;
the agent still must resolve the exact screw family and qualified pilot/boss
dimensions for the selected material, printer, profile, orientation, and reuse.
`decisionMode=agent-may-select-qualified` lets the agent source ordinary
catalog/standard dimensions, while unresolved functional or strength choices
remain with the user. A plain `M5×10`
does not define a clearance hole, tap drill, heat-set-insert pocket, head recess,
nut/washer envelope or allowable load. Those values remain required inputs from
the chosen fit, current standard or exact manufacturer part and qualified
printer/material/profile process. Ambiguous short forms such as `M10×1` are
returned as questions instead of being guessed as pitch or length.

### Matched printable threads

The server can build a complete custom printed pair or add either side to an
existing design:

- `plasticity_create_printed_hex_pair` accepts an M-like diameter-and-length
  shorthand such as `M5x10`, then creates both a hex screw and matching nut
  from one shared custom thread definition. It records the printer, material,
  slicing profile, orientation, clearance basis, and sizing basis with the
  result. An explicit pitch in a three-number designation must match the
  supplied custom profile pitch.
- `plasticity_create_printed_external_thread` creates a standalone threaded
  Solid from an exact cylindrical core, native Helix, swept circular ridge,
  Boolean union, and crest-envelope intersection.
- `plasticity_cut_printed_internal_thread` cuts the matching enlarged bore and
  helical groove into one existing Solid.
- `plasticity_create_printed_hex_screw` adds an overlapping wrenchable hex
  head to the external thread.
- `plasticity_create_printed_hex_nut` extrudes a regular hex blank and cuts the
  matching internal thread while enforcing an explicit minimum wall.
- `plasticity_create_printed_thread_calibration_set` creates one reference
  screw and 2-8 separate nuts with unique candidate clearances. Each sample has
  an explicit ID and position; the result records the exact printer, material,
  slicing profile, orientation, and sizing basis, and remains marked
  `requires-physical-fit-test` until the user prints and tests it.
- `plasticity_record_printed_thread_qualification` stores a user-confirmed
  physical fit result in the core MCP's immutable local registry;
  `plasticity_match_printed_thread_qualification` reuses it only for the exact
  printer, material, slicer profile, nozzle diameter, layer height, orientation,
  rounded thread definition, fit class, and a tested engagement at least as
  long as the requested engagement. Conflicting clearances return `ambiguous`.

The six geometry tools use the one-start `rounded-print-v1` profile. Diameter,
pitch, thread depth, handedness, length, and radial direction are explicit. The
internal side also requires a normal profile clearance; this enlarges both its base bore
and swept groove relative to the male profile. The source Helix and hex profile
Wire remain editable in Plasticity. Every native step is journaled, and a
failed recipe reports its last confirmed revision without retrying.

The process identity also includes `nozzleDiameterMm` and `layerHeightMm`.
Optional `processFingerprintSha256` can bind it to an exact immutable slicer
configuration. A saved qualification is content-addressed, append-only, and
idempotent. It requires `confirmedPhysicalTest=true`, a specimen sample ID,
fit class, tested engagement, completed cycle count, and test time. A viewport
or B-Rep interference result cannot be recorded as a physical qualification.
The default registry is `.plasticity-mcp/thread-qualifications`; set
`PLASTICITY_THREAD_QUALIFICATION_ROOT` to use another local directory.
When Workbench is available, its immutable manufacturing profile remains the
source of printer/material/slicer configuration and hashes; the core registry
stores only the physical thread-fit result keyed to that identity. It therefore
does not make Workbench mandatory or create a second slicer preset format.

This is a custom matched printing profile. It is not an ISO metric thread, and
a 5 mm crest diameter does not make it an M5 fastener. The agent resolves load,
engagement, failure consequence, printer, material, slicing profile,
orientation, pitch, depth, clearance, head envelope, nut dimensions, and
wrench access. If the user delegates ordinary process choices, the agent
proposes them with their basis. Strength still requires configuration-matched
internal-stripping, external-stripping, and screw-tension allowables through
`plasticity_calculate_threaded_receiver_strength`.

An exact no-interference result at one aligned phase proves only that indexed
pose. It does not prove continuous helical travel or the fit of real printed
parts. When that process has no qualified thread clearance, create the ladder,
print every sample with the recorded settings and orientation, test full travel
and the intended reuse/load behavior, then store the selected sample ID and
clearance with `plasticity_record_printed_thread_qualification`. Before later
production geometry, query it with
`plasticity_match_printed_thread_qualification`. Passing its immutable ID to
`plasticity_create_printed_hex_pair` binds the generated pair to the exact
physical result; omitting the ID leaves the pair marked
`requires-physical-fit-test`.

The guarded live acceptance is:

```sh
npm run accept:printed-threads -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It refuses a nonempty document, creates a custom 5 mm screw and matching nut
through one `plasticity_create_printed_hex_pair` call, confirms that `M5x8`
supplied only the 5 mm crest diameter and 8 mm length, records the synthetic
K1C/PLA/process qualification context, returns all 15 native Undo steps,
checks exact cylindrical B-Rep radii and native body validity, verifies no
volumetric intersection in one aligned phase, deliberately rotates the nut to
prove that a phase error intersects, restores alignment with Undo, and finally
restores the initial empty scene.

The calibration-set acceptance is separate because it validates a process
qualification artifact rather than one selected fit:

```sh
npm run accept:printed-thread-calibration -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It creates one 5 mm reference screw and two nuts with 0.10 mm and 0.20 mm
normal profile clearances, checks the three exact native Solids and their
distinct bore radii, confirms the result still requires a physical fit test,
and restores the initial empty scene.

The bounded standard catalog classifies ISO 4014/4017 hex fasteners, ISO 4762
and DIN 912 socket-head cap screws, ISO 7380-1/-2 button heads, ISO 7045 and
14583 pan heads, ISO 7046-1, 10642 and 14581 countersunk heads, and ISO
4026/4027/4028/4029 headless set screws. Each current ISO entry returns its
official source URL and selects only the compatible modeling route. The
resolver does not copy a standard's dimensional table into CAD: actual head,
driver, hole, recess, washer, nut, fit, and process dimensions still come from
the exact current product or qualified standard data. The result distinguishes
external hex, hexagon socket, hexalobular socket, and cross-recessed drives.
For ISO 4026–4029 it also returns the flat, truncated-cone, dog, or cup point,
requires the mating contact and driver-access envelope, and reports
`SET_SCREW_TENSION_LIMITATION`, because those families are not intended to
carry tensile load. The agent must resolve the real load path before a strength
decision.

After the designation and joint type are resolved,
`plasticity_check_fastener_stack` checks the stated nominal length against an
explicit list of clamped layers and either a nut envelope or a threaded
receiver. For a nut it checks minimum and optional maximum protrusion. For an
insert, tapped hole, or qualified plastic thread it checks engagement,
available thread length, optional blind depth and tip clearance. Countersunk or
other overall-length products require an explicit head axial length. A passing
result proves only axial stack compatibility; strength, preload, fit, tool
access, thread stripping, and printed-part behavior remain separate checks.
When those layers already exist in Plasticity,
`plasticity_measure_fastener_grip_stack` reads each thickness from an explicit
pair of opposite planar B-Rep faces aligned with the fastener axis. Its
revision-bound `gripItems` feed the length check directly. Duplicate face pairs,
cross-body pairs, nonparallel faces, Sheets, stale revisions, and faces not
normal to the fastener axis are rejected; an unmodeled washer remains an
explicit sourced layer rather than an inferred dimension.

The guarded real-application acceptance for the countersink, trapped-nut
pocket, round through-hole, blind-hole, and adjustment-slot recipes is:

```sh
npm run accept:fastener-pockets -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It resolves fixed, adjustable, and tapped-metal M5 fastening requests, builds a
disposable exact plate, checks a dedicated Ø5.5 through-hole and a flat-bottom
Ø4.2 × 5 mm blind hole, the conical and cylindrical faces of an ISO 10642
countersink, the six hex-pocket planes, and the exact R3 ends and 14 mm straight
sections of a 20 × 6 mm slot from native B-Rep. It runs native body validation,
verifies Undo/Redo, and restores the empty document. No live work occurs unless
the explicit target, mutation flag, and a new output directory are supplied.

`plasticity_calculate_heat_set_insert_retention` checks the installed insert as
a separate qualified component. It needs the worst-case axial and torque demand
on one insert plus measured or sourced pullout and torque-out capacity for the
same insert, host material, K1C/profile, print orientation, pocket dimensions
and installation process. Data for moulded ABS or polycarbonate remains
unconfirmed for printed PLA unless a matching qualification proves otherwise.

`plasticity_distribute_fastener_group_load` resolves a complete in-plane force,
its point of application and any free moment over two or more distinct fastener
points. It returns the direct share, elastic moment share, resultant vector and
magnitude for every fastener plus the governing shear demand. A `calculated`
result proves only equilibrium under the rigid, identical-stiffness model; pass
the governing demand to the separate fastener, plate and insert checks.

Use `plasticity_inspect_fastener_group` before that calculation when the hole
pattern already exists in Plasticity. Supply one Solid, two or more explicit
cylindrical face IDs, the current document revision, and a plane frame. The MCP
intersects each exact cylinder axis with the frame, returns local X/Y centers
and native diameters, and emits measured evidence plus assignment paths for the
load-distribution input. The binding records the session, document, revision,
body, selected faces, frame and a topology signature. Stale revisions, skew
axes and coaxial duplicate faces are rejected rather than silently remapped.
Pass that binding and input fragment to
`plasticity_verify_fastener_group_load` to re-read the faces, replace all
fastener coordinates with current native measurements and save a CAD-bound
distribution report. `plasticity_strength_report` then rechecks the face set,
frame and topology signature and marks the report stale after a manual edit.

Use `plasticity_check_fastener_group_layout` on the same cylindrical faces and
one exact rectangular planar boundary face to measure every center-to-edge and
hole-edge distance, every pair's center spacing and remaining ligament, and
circular mounting envelopes for heads, washers, nuts or driver access. Envelope
diameters and required clearances must come from a named standard, manufacturer
data, a qualified process rule or an explicit user decision recorded in
`requirements.basis`. Without requirements the result is `measured`; only an
explicit comparison can return `pass` or `fail`. That status covers layout
geometry only and does not replace fastener, insert, boss or plate strength.

The guarded real-application acceptance for designation parsing, a native
four-hole plate, exact B-Rep group inspection, load distribution, stale
reference rejection and Undo cleanup is:

```sh
npm run accept:fastener-group -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

Exact arbitrary-plane inspection has its own guarded acceptance command:

```sh
npm run accept:arbitrary-section -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It refuses a nonempty document, checks horizontal and 45-degree sections of a
disposable 20 × 10 × 5 mm Solid through the real stdio MCP, verifies that body
geometry and history remain unchanged, then restores the empty document.

`boundsMm` comes from the native B-Rep model's `FindBox()` result. Semantic
metadata is read from native faces and edges; each body also publishes exact
vertex entity IDs and `Vertex.GetPoint()` coordinates. Vertex, face and edge
references are valid only at the returned revision. `plasticity_measure_point_distance`
resolves exact vertices, edge parameter midpoints, face evaluation points or
explicit millimeter coordinates and reports both XYZ delta and Euclidean distance.
`plasticity_measure_planar_faces` reports the angle between exact face planes and
parallel supporting-plane separation (`separationKind: "supporting-planes"`). It
does not check whether the trimmed faces overlap or measure the actual gap between
their boundaries. `plasticity_measure_parallel_planar_face_clearance` computes
exact minimum clearance between parallel planar faces (within 1e-7 degrees)
with closed polygonal trims, complete circles, and exact trimmed circular
arcs, including nested loops and holes, up to 512 edges per face. It rejects
other curved boundaries, nonparallel faces and incomplete topology.
For nonparallel faces, `plasticity_measure_nonparallel_planar_polygon_clearance`
computes exact distance between simple straight-edged polygonal regions on
each face, including zero distance when the finite regions intersect. Concave
outlines, holes, and multiple nested or disjoint loops are supported. It
limits each face to 512 boundary vertices and 4,096 exact decomposition
triangles, and rejects parallel faces, arcs, and self-intersecting or touching
contours.
Neither face tool checks whole-body clearance or collision.
`plasticity_measure_linear_edges` reports the angle
and shortest distance between the infinite supporting lines; returned edge
lengths still describe the bounded edges. Topology bounds remain viewport
geometry bounds and are mainly for locating entities. Face and edge IDs are
version specific. Named selections store their geometric query, re-evaluate
after a topology change and report `unresolved` or `ambiguous` instead of
guessing.

`plasticity_list_regions` exposes the automatic planar regions generated by
Plasticity for closed coplanar curves. Region IDs are valid only for the
returned document revision. `displayBoundsMm` is explicitly tagged
`measurementSource: "render-mesh"` and is only for choosing a region; dimensions
of the resulting Solid are verified from native B-Rep `boundsMm`.
`plasticity_extrude_profile` creates a Solid only when a Wire resolves to one
unambiguous region. For nested loops or several regions, list them and call
`plasticity_extrude_regions` with the chosen revision-bound IDs.
`plasticity_offset_planar_curves` preserves the source Wires and creates native
offset Wires. Its signed millimeter distance follows each Wire orientation.
`plasticity_offset_regions` accepts explicit current Region IDs from one sketch
and creates one or two signed offsets in one native history step. This is the
preferred path for wall contours, nested loops and clearance boundaries.
For Trim, `plasticity_list_curve_fragments` returns exact native start, midpoint,
end and length data tied to the current revision. Pass chosen IDs to
`plasticity_trim_curve_fragments`; stale fragment IDs are rejected.
`plasticity_list_curve_intersections` filters Plasticity's native cross-point
database to intersections between user Wire bodies and reports their exact
coordinates and participating body versions for the current revision.
`plasticity_list_curve_endpoints` reports exact native endpoint coordinates for
open Wires. `plasticity_extend_curve_endpoints` extends one or several selected
ends by a positive millimeter distance in one history step.
`plasticity_list_curve_vertices` reports every exact native Wire vertex, its
endpoint status, position, and adjacent segment entity IDs.
`plasticity_convert_curve_vertices_to_control_points` converts selected current
interior or closed Wire vertices into editable cubic B-Spline control vertices
in one native history step. Open endpoints are rejected. Conversion replaces
the contributing segments and changes the path, so discard every old vertex and
segment reference, then inspect the returned curve structure and control points.
The guarded live check can be repeated with:

```sh
npm run accept:native-curve-vertex-conversion -- \\
  --target PLASTICITY_WINDOW_ID \\
  --allow-disposable-mutations \\
  --output NEW_EMPTY_DIRECTORY
```

It converts two corners in a disposable polyline, checks exact B-Spline degree,
control-point count, endpoints, length, endpoint rejection and Undo/Redo, then
restores the empty document.
Pass current `bodyId`/`vertexId` pairs to
`plasticity_fillet_curve_vertices` to round one or
several interior or closed profile corners with one positive millimeter radius
in one native history step. Re-read the returned state because Plasticity may
replace a Wire's stable body ID when its topology changes.
`plasticity_list_curve_directions` reports exact native start/end points and
tangents for every Wire segment. `plasticity_reverse_curves` reverses that
orientation explicitly, so signed offsets and path operations do not depend on
guessing. `plasticity_reverse_sheets` likewise reverses Sheet face normals.
`plasticity_create_body_outlines` creates exact native silhouette Wires from
current Solid or Sheet bodies while preserving the source geometry. The caller
must supply a current construction-plane identity and choose whether the
silhouette remains at the source geometry or is projected onto that workplane.
The resulting closed Wires expose Regions for gasket, lid, clearance, and
mating-profile workflows; dimensions are read back from native curve segments.
`plasticity_unjoin_curves` splits compound Wire bodies such as polylines into
separate editable native curve bodies. `plasticity_join_curves` combines two or
more Wire bodies again; connected closed segments produce a selectable Region.
Each operation is one reversible history step.
`plasticity_duplicate_curves` creates independent exact native copies of
current Wire bodies in place. The source and copies keep separate stable body
IDs, so the copies can be moved or edited without changing the originals.
`plasticity_create_curves_from_regions` copies the exact boundaries of current
planar Regions into independent Wire bodies. Because the coincident boundary
changes Plasticity's automatic sketch topology, every earlier Region reference
becomes stale even though the source Wire geometry remains; read the returned
state or call `plasticity_list_regions` before using a Region downstream.
`plasticity_project_curves_onto_body` preserves the source Wires and creates
native projected Wires on a Solid or Sheet. The caller supplies a nonzero
world-space direction and can choose bidirectional projection, visible-surface
occlusion, and Plasticity's none/edge/face-set completion modes.
`plasticity_create_body_intersection_curves` preserves one target and one or
more Solid or Sheet tools, then creates independent native Wires at every exact
body intersection in one history step. Use it when the intersection curve is
needed for construction without splitting either source body.
`plasticity_project_curve_pair` constructs one independent spatial Wire from
two distinct source Wires by intersecting their bidirectional extrusion
surfaces. Each source has an explicit world-space projection direction, and the
caller supplies a millimeter depth large enough for the temporary surfaces to
overlap. This supports a 3D guide defined by two orthogonal sketches while
keeping both sketches editable.
`plasticity_insert_isoparam_edges` inserts native U- or V-isoparametric edges
into one current Solid or Sheet face and splits that face in place. U/V follow
the face's parameterization rather than world axes. Re-read analytic surface
types, radii, topology, dimensions, validation, and mass properties afterward.
On the accepted 26.1.3 cylinder case, all four result faces remained analytical
R5 Cylinders and bounds stayed Ø10 × 20 mm, while the native mass-properties
integrator changed its volume estimate by about 0.422 mm³ after the periodic
surface was split; the MCP reports this result and does not claim numerical
mass-property invariance.
`plasticity_inspect_surface_structure` reads the exact carrier type, trim state,
face and natural UV parameter ranges, and compact B-Surface degree, span,
control-point, and rationality data for current Solid or Sheet faces. UV values
are native parameters rather than millimeter dimensions.
`plasticity_analyze_surface_continuity` runs Plasticity's native continuity
evaluator across current shell edges shared by exactly two faces. For each edge
it reports the maximum sampled G0 position deviation in millimeters, G1
normal-angle deviation in degrees, Plasticity's dimensionless relative G2
curvature deviation, the location of each maximum, and a hierarchical
G0/G1/G2 result against explicit tolerances. Plasticity samples 100 positions;
the result comes from native B-Rep surfaces rather than the display mesh, but it
is not an exact continuous maximum and does not change the document.
Relative G2 is |k1 - k2| / max(|k1|, |k2|) of the curvatures across the edge,
so it reads 1.0 whenever one side is flat (a plane meeting a fillet), however
small the other curvature. Each edge result now also carries `interior`
(`g0Mm`, `g1Deg`, `g2Rel`: the maxima over samples 5..94, leaving out the five
samples at each end, which are the corners), `worstAt` (`corner` when the first
level that fails its tolerance, or G2 when all pass, has its maximum in those
end samples, else `interior`), and `absoluteCurvature` (`side1PerMm`,
`side2PerMm`: the kernel's normal curvature across the edge on each adjacent
face at the worst G2 sample, from `Face.EvalBasis`, given only when one face
parameter direction runs along the edge and the other across it within one
degree). The per-sample values come from the native view's spike arrays
(100 samples; each value is its spike vector's length, Float32, and their
maxima equal the reported maxima). Every earlier field is unchanged: live on
26.1.3 the old and new code returned byte-identical existing fields on 48
edges of four bodies. On the benchmark's crowned pad and a filleted box, edges
that read `discontinuous` because of a 1.4-17 mm G0 spike at one end read
`worstAt: "corner"` with `interior.g0Mm` below 1e-12, and the plane-to-fillet
edges show `absoluteCurvature` 0 and 0.3333/mm (R3) where relative G2 says 1.
`plasticity_probe_surface` reads exact points on a curved Solid or Sheet. Give
`rays` (1-64 `{ originMm, direction }`) or `gridMm: { axis, at }`: grid rays
travel along -axis (default `z`) from 1 mm outside the body's bounds, and each
`at` entry gives the other two coordinates in x, y, z order, so "surface height
at (x, y)" is one call. Every crossing with the body's faces comes back in order
along the ray: `pointMm`, `faceId` (`otherFaceIds` when the ray crosses an edge
shared by several faces), `normal` (outward on a Solid), `distanceMm`, the
kernel's `uCurvaturePerMm`/`vCurvaturePerMm` (signed by the surface
parametrisation; compare magnitudes) and `residualMm`. `hits: 0` is a miss.
Each point is solved on the exact kernel face: closest-point Newton steps along
the ray (`Face.FindPointNear` for the trimmed face, `Face.EvalBasis` for its
normal) until the kernel residual is at most 0.000001 mm. The display mesh and
the kernel surface's own raycast only seed the search, so a ray that grazes a
face tangentially can be missed; `unresolvedCrossings` counts mesh crossings no
exact hit explains. Points are rounded to 1e-9 mm. Live on 26.1.3
(`accept:native-surfacing`): a sphere, a cylinder and a 30 degree plane agree
with analytic heights within 5e-10 mm; a cubic Bezier extruded sheet agrees
with its control-polygon formula (z = 3a s(1-s)) within 1e-15 mm; a ray through
a holed block returns four hits. The read changes nothing: the native call checks the undo depth and body
count before and after.

`plasticity_exact_bounds` gives the exact axis-aligned extent of 1-32 Solid or
Sheet bodies. Plasticity 26.1.3 has no kernel extrema call, so every Solid and
Sheet `boundsMm` is `boundsMethod: "native-box"`: the kernel's box, which for a
B-spline face is its control-point hull. Live: a lofted Bezier sheet whose top
is 6.75 mm reads 9 mm, and the benchmark's crowned grip pad (true top
13.99072 mm) reads 14.499 mm, with y overstated by 1.28 mm. Each side here is
the coordinate of a real body point found by the kernel's global body range
(`Eval.DistancesToPoints`) from a point 100 km out along that axis. The true
extent lies at most `maxErrorMm` beyond it: `L^2 / (2 (R - h))` from the far
distance R and the conservative box, plus 1e-5 mm kernel resolution. `exact`
is true when that bound is within 0.001 mm (any body up to about 0.4 m across)
and a second query from 10 km gives the same coordinates within that radius's
own bound (`radiiDisagreementMm`); the premise is that the kernel range is a
global minimum. Live, the pad's support top agreed with an exact
`plasticity_probe_surface` ray at the same x, y within 1e-6 mm.
`overshootMm` says how far the conservative box overstates the body.
`plasticity_describe_body` now adds `boundsExact` per body (true when the
kernel box equals the exact extent within 0.001 mm, or when `boundsMethod` is
`native-extrema`), and `boundsNote` with the reason when it is false; it leaves
both out when the support read fails.

`plasticity_surface_align` moves the boundary edge of one Sheet (`moving`) onto
the boundary edge of another Sheet (`reference`) with `g0`, `g1` or `g2`
continuity, as Plasticity's Align (Edge Align) does: the moving Sheet is
rebuilt, the reference stays, one Undo step. It runs the real
`AlignEdgeCommand` with the two edges selected (the first one moves), finds
its dialog in the document (no prototype patch), waits until the command is
`Awaiting` and its factory has updated (about 25 ms; a fixed 500 ms on a build
without those states), keys the continuity by the reference edge, updates and
finishes, all inside the pick-command lifecycle (one call, our command only,
cancel in the same call, the shared outcome classifier). The read-back samples
both edges in the kernel: `coincidence.maxGapMm` must be within 0.001 mm, and
`maxTangentPlaneAngleDeg` is the largest angle between the two faces' tangent
planes. The sheets stay separate, so `achieved` is `"not measured"`: join them
and call `plasticity_analyze_surface_continuity`. Live on 26.1.3 (the probe's
two-sheet fixture, joined): g0 gives gap 8.9e-13 mm and 24.49 degrees (G0), g1
1.2e-6 degrees (G1, relative G2 0.78), g2 relative G2 7.5e-8 (G2); swapped
order moves the other sheet. A 20 mm edge aligned to a 30 mm curve commits but
misses by 1.11 mm: a certain error with one Undo step that `plasticity_undo`
restores. Two edges of one Sheet and Solid edges are refused before the
command starts (never verified). Stalls injected at the operations layer end
as a certain "cancelled, unchanged" before `finish()` (or, when the drive step
outlives its budget, a refused late `finish()` that stays undetermined) and as
undetermined (reconcile) after it. A drive step that outlives its budget stops
before it touches the factory. Caution: such injected stalls (budgets of
1-120 ms; the real one is 15 s) killed the isolated renderer once in about 150
trials, when the cancel landed while Plasticity was still computing.

`plasticity_square_surface` makes one four-sided Sheet (XNurbs, one B-surface
face, four edges) from exactly four boundary items, in order around the patch:
`{ bodyId, edgeId }` (a Sheet or Solid edge) or `{ wireId }`, mixed freely.
`edgeContinuity` (`g0` or `g1` per boundary edge) matches the neighbouring
face; `g2` is not offered because it never measured as G2. It sets
`SquareFactory.boundaries` directly inside `SquareEdgeCommand` (the command's
own dialog route starts with an empty factory). Failures keep the raw XNurbs
code with its meaning (30 when g1 meets perpendicular walls, as on an open
box). Live on 26.1.3: four Bezier curves give a Sheet whose edges read back
at the curves' own heights by probe rays (3.75, -3, 4.5, 2.25 mm within
6e-5 mm); a flat neighbour Sheet plus three curves joins at g0 with 4.0e-4
degrees and at g1 with 8.5e-7 degrees along the shared edge; one
`plasticity_undo` removes the patch.
`plasticity_analyze_edge_curvature` runs Plasticity's native curvature
evaluator at 100 positions on each selected B-Rep edge. Wire segments use the
numeric `segmentEntityId` returned by `plasticity_list_curve_directions`;
Solid and Sheet edges use the revision-bound string `edgeId` from document
state. The compact result reports minimum, maximum, and mean curvature in
1/mm, locations of both extrema, the maximum curvature vector, finite radii of
curvature in millimeters, and whether any sampled point is straight. A straight
edge returns `null` for both finite-radius fields. This is native sampled
analysis rather than an exact continuous extremum, and it does not change the
document or Undo/Redo history.
`plasticity_raise_surface_degree` raises both native B-Surface directions by one
Plasticity step in one history entry. On the accepted 26.1.3 surface it changed
degree 3/3 to 4/4, spans 3/2 to 5/3, control points 6×5 to 9×7, and altered an
exact bound by 1.685846 mm. Treat it as a shape-changing rebuild and verify all
functional geometry afterward.
`plasticity_rebuild_face` refits one exact current Solid or Sheet face into a
native B-Surface using projected boundary edges and an explicit positive
millimeter tolerance. It preserves the owning body's stable ID and uses one
history step, but invalidates all topology references. The tolerance is a
Plasticity approximation input, so re-read functional dimensions, surface
structure, continuity, mass properties, and native validity afterward.
`plasticity_match_faces` replaces one or more exact current Solid or Sheet face
surfaces with the carrier surface of a separate replacement face. Plasticity
extends or trims the adjacent faces, preserves both edited body IDs and an
external replacement body, and uses one history step. The operation invalidates prior
topology references; re-read bounds, analytic surface types, mass properties,
interference, and native validity before continuing.
`plasticity_untrim_faces` discards the selected trim boundary and restores each
face to the natural UV bounds of its carrier surface. It preserves the body ID,
but changes exact bounds, can overlap adjacent geometry, and invalidates all old
topology references. Read surface structure and validate intersections after
every use.

The guarded surface-refinement acceptance, including face matching and face
refit, can be repeated with:

```sh
npm run accept:native-surface-refinement -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

`plasticity_imprint_curves_on_body` uses the same projection controls but splits
the target's exact faces along the projected Wires. The source Wires remain in
the document; the new face and edge IDs can be selected for deletion,
extraction, offset, or other surface work.
`plasticity_imprint_bodies` splits a Solid or Sheet target along its exact
intersections with one or more Solid or Sheet tools. Tool bodies are preserved,
which supports reusable mating envelopes and selective downstream face edits.
`plasticity_create_through_hole` cuts one exact round hole from an explicit
finished diameter and material depth. `entryCenterMm` lies on the entry surface,
`axis` points into the material, and `overshootMm` extends the temporary cutter
past both tangent boundaries. The recipe creates one native cylinder, consumes
it in one Boolean difference, and returns both confirmed revisions. A thread
designation such as M5×10 is resolved first, but its nominal 5 mm diameter is
never substituted for the selected clearance, pilot, or insert-hole diameter.
`plasticity_create_through_hole_pattern` cuts 2–256 equal round holes at
explicit entry centers in one Solid. It creates one native cylinder for each
center and consumes every cutter in one final Boolean difference, so a pattern
of N holes has N+1 confirmed Undo steps. Use it after a phrase such as
`крепится на 4 болта M5×10` has been resolved and the selected fit has supplied
the finished hole diameter, material depth, and every center. The tool does not
invent spacing, edge distances, fit, or load capacity from the designation.
`plasticity_create_blind_hole` cuts a flat-bottom round hole from an explicit
finished diameter and depth. It also requires the available local material
depth and rejects `holeDepthMm >= materialDepthMm` before mutation. Use it for a
qualified blind tap drill, self-tapping pilot, or a pilot in an existing boss.
The recipe does not infer hole depth from fastener length and does not model or
claim a physical thread.
`plasticity_create_blind_hole_pattern` applies one qualified finished diameter
and depth at 2–256 explicit entry centers. It creates one native cylinder per
center and consumes every cutter in one final Boolean, so N holes have N+1
confirmed Undo steps. Fixed requests for several tapped-metal fasteners route
to this grouped recipe; the agent must still resolve the actual tap-drill or
modeled minor diameter, engagement, local material depth, tip clearance, and
every center.
`plasticity_create_countersink` cuts a finished through hole and concentric
conical head recess from explicit dimensions. `entryCenterMm` lies on the entry
surface, `axis` points into the material, and `radialDirection` fixes the
editable meridional profile plane. The countersink depth is derived from the
finished through diameter, major diameter, and included angle; the recipe
rejects a recess that reaches through the target. It creates a through-cylinder
cutter, preserves an annular Wire profile, revolves the conical cutter, and
consumes both cutters in one Boolean, returning four native Undo steps.
`plasticity_create_countersink_pattern` applies the same finished bore, major
diameter, and included angle at 2–64 explicit entry centers. Each center creates
one through cutter, one preserved editable meridional Wire, and one revolved
conical cutter; a final Boolean consumes all solid cutters. A pattern of N
countersinks therefore has 3N+1 confirmed Undo steps. A fixed request such as
`4 винта ISO 10642 M5×10` routes here, but the agent must still resolve the
selected standard, fit, manufacturing allowance, material depth, and every
center rather than deriving geometry from the nominal thread designation.
`plasticity_create_hex_nut_pocket` cuts a blind regular hexagon from an explicit
across-flats size, pocket depth, and material depth; the pocket depth must stay
below the material depth. `flatNormalDirection` controls the orientation of
one pair of opposite flats. The source Wire remains editable, while its native
Region is extruded and consumed by the Boolean in three Undo steps. None of
these recipes derives head, hole, washer, or nut dimensions from an `M` designation;
the agent must use the selected standard or manufacturer part plus fit and
process clearance.
`plasticity_create_hex_nut_pocket_pattern` applies one qualified across-flats
size, depth, and orientation at 2–128 explicit entry centers. It preserves one
editable Wire per center, extrudes one cutter per pocket, and consumes every
cutter in one final Boolean, for 2N+1 confirmed Undo steps. Region selection is
based on newly created native Region IDs because Plasticity associates every
coplanar closed profile in the shared sketch with each Region. This also keeps
the single-pocket recipe reliable when other coplanar profiles already exist.
`plasticity_create_slotted_hole` cuts a straight through-slot with exact
semicircular ends. `overallLengthMm` includes both round ends, `widthMm` is the
finished slot width, and `slotDirection` sets the adjustment direction in the
entry plane. The recipe preserves its rectangular center Wire, extrudes it,
adds two exact cylindrical end cutters, and consumes all three cutters in one
Boolean, for five native Undo steps. Use a slot only after the required travel,
edge distances, and the washer or fastener-head bearing envelope are known.
`plasticity_create_slotted_hole_pattern` applies the same qualified slot at
2–64 explicit entry centers. It preserves one center Wire and creates three
cutters per slot, then consumes every cutter in one final Boolean, for 4N+1
confirmed Undo steps. A fixed-width multi-bolt adjustment request routes to
this grouped recipe. The caller must prove positive edge distance for every
semicircular end; exact tangency to an exterior boundary is a degenerate
Plasticity Boolean configuration and is rejected before it can be accepted as
a finished design.
`plasticity_create_counterbore` cuts a through hole and a wider flat-bottom
recess into one Solid. `entryCenterMm` lies on the entry surface and `axis`
points into the material. `throughDepthMm` is the material depth along that
axis; `overshootMm` extends temporary cutters beyond tangent boundaries. The
counterbore diameter must exceed the through diameter, and its depth must be
less than the through depth. The recipe uses two native cylinder commands and
one native Boolean command, consumes both temporary cutters, and returns the
three revisions and `undoSteps: 3`. If any step fails or becomes uncertain it
stops immediately, leaves confirmed partial geometry visible, and never retries
or rolls back automatically.
`plasticity_create_counterbore_pattern` applies the same finished through-hole
and head-recess dimensions at 2–128 explicit entry centers. It creates two
native cylinders per center and consumes every cutter in one final Boolean, so
a pattern of N counterbores has 2N+1 confirmed Undo steps. A resolved request
such as `4 винта DIN 912 M5×10` routes here when the mounting is fixed; the
agent must still obtain the selected standard's head envelope, fit, process
clearance, local material depth, and every center before calling the tool. The
nominal thread diameter or screw length is never treated as a finished pocket
dimension.
`plasticity_create_heat_set_insert_pocket` creates a nested pilot, insert bore,
and shallow lead-in from dimensions supplied for the chosen insert, material,
and print profile. The axis points from the entry surface into the target. Its
diameters must increase from pilot to insert to lead-in while depths decrease
in that order. The explicit local material depth must also exceed pilot depth.
Three temporary native cylinders are consumed by one Boolean, so the result is
ordinary editable Plasticity geometry with four explicit Undo steps. Failure
and uncertainty use the same stop-without-retry behavior as the counterbore
recipe.
`plasticity_create_heat_set_insert_pocket_pattern` applies one qualified
pilot/insert/lead-in stack at 2–64 explicit entry centers. It creates three
native cylinders per center and consumes all cutters in one final Boolean, for
3N+1 confirmed Undo steps. A fixed request for several equal heat-set inserts
routes to this tool and routes the mating side to
`plasticity_create_through_hole_pattern`; insert identity, installation process,
print profile, retention evidence, local thickness, and every center remain
explicit.
`plasticity_create_screw_boss` grows a cylindrical boss outward from a point on
an existing Solid. A required base overlap gives the native union real volume;
the recipe then cuts a blind pilot from the boss top without entering the
support body. The hole diameter must be smaller than the boss and its depth
cannot exceed the boss height. The two temporary cylinders are consumed in
four native history steps: create, union, create cutter, difference.
`plasticity_create_screw_boss_pattern` applies the same qualified geometry at
2–64 explicit base centers. It creates all boss cylinders, joins them to the
support in one Boolean, creates all blind-pilot cutters, and consumes those in
one final Boolean, for 2N+2 confirmed Undo steps. A fixed phrase naming several
self-tapping or printed-plastic fasteners routes to this grouped recipe; screw
family, printer/material/profile, orientation, reuse, outer diameter, pilot
diameter, engagement depth, edge distance, and every center remain explicit.
`plasticity_create_rib` accepts three or more coplanar world-space points and a
signed extrusion thickness. It creates a closed profile, resolves its single
native Region, extrudes a Solid, and joins that Solid to the selected target.
Non-coplanar and degenerate profiles are rejected before the first mutation;
the three successful mutations are returned as separate Undo steps.
Direction (verified live): a positive `thicknessMm` extrudes along the
profile's right-hand normal, the one for which the points run counter-clockwise
(for points A, B, C it is (B-A) x (C-A)); the rib fills `[plane, plane +
thickness]` on that side, a negative thickness the other way. So points in the
x-z plane at y = 13 that run x then z, with thickness +4, fill y 9..13. Optional
`side` makes the intent explicit and ignores the sign of `thicknessMm`:
`"centered"` splits `|thicknessMm|` evenly about the profile plane (a gusset at
y = 15 with thickness 4 fills y 13..17, whatever the point order), `"positive"`
runs along the normal, `"negative"` against it. Without `side` the call is as
before. The reply adds `ribBoundsMm` (`{ min, max }` in mm, 4 decimals): the
extruded solid's bounds before it is joined, i.e. where the rib landed. A lean
batch leaves it out of the step reply and names it in `omitted` (ask with
`return: ["ribBoundsMm"]`). Direction and `side` were checked live on three
profiles (the triangle, the same triangle with reversed point order, and one
tilted 30 degrees), for `side` positive, negative and centered: every
`ribBoundsMm` matched the right-hand-normal prediction
(`discovery/speed-2026-11/rib-direction-check.json`).
`keepProfile` (default true) keeps the editable profile Wire in the document,
as before; `false` deletes it in a fourth Undo step (`steps` then ends with
`delete-construction-profile`, the reply adds `profileDeleted: true`, and the
batch `added` list no longer names the Wire). The delete clears the current
selection. If it fails after the geometry is complete, the reply is still
`completed` with `warning: "construction wire not removed: <reason>"`, and
`undoSteps` counts only the steps that happened. `plasticity_create_countersink`
and `plasticity_create_countersink_pattern` take the same `keepProfile` (one
extra delete step for all of their Wires; `profileDeleted` / `profilesDeleted`).
`plasticity_create_through_hole_pattern` leaves no construction Wire.
`plasticity_create_round_vent_array` cuts a one- or two-dimensional grid of
round through-holes. The first center lies on the entry surface, the hole axis
points into the target, and both grid directions must lie in that surface
plane. Pitch must exceed hole diameter. The recipe creates one cutter, uses
Plasticity's native rectangular pattern for up to 20 × 20 instances, and
consumes all cutters in one Boolean. Thus a multi-hole array needs only three
Undo steps; a single hole needs two.
`plasticity_create_cantilever_snap_fit` builds a beam and integral end hook
from a point on the support. Perpendicular beam and thickness directions define
the profile plane; width is centered across its normal. Length, width,
thickness, hook length, hook height, and support overlap are explicit
millimeter inputs. The profile Wire remains editable, while the extruded body
is joined to the target in three native history steps. Material-specific strain
and clearance remain design inputs for the agent to validate against the active
manufacturing profile.
`plasticity_create_hinge_barrel` creates a cylindrical knuckle, cuts its exact
finished pin-clearance bore, and joins the hollow barrel to an existing Solid.
The caller supplies the barrel axis start and direction, length, outer
diameter, and finished bore diameter. The support must intersect the barrel;
four native steps create the outer cylinder, create the overshooting bore
cutter, subtract it, and unite the barrel with the target.
`plasticity_cut_cable_channel` uses one or more current editable Wire bodies as
centerlines for solid native Pipe cutters, then subtracts those cutters from a
selected Solid. `channelDiameterMm` is the finished cable-clearance diameter.
The source Wires stay in the document for inspection or later adjustment; the
Pipe creation and Boolean difference are returned as two explicit Undo steps.
Each Wire must be current in the supplied document revision and distinct from
the target body.
`plasticity_create_connector_opening` cuts an oriented rectangular or
rounded-rectangular through-opening into a Solid. The entry center lies on the
target surface, `axis` points through the material, and `widthDirection` lies
in the surface plane; height direction is derived as a perpendicular axis.
The exact width, height, through depth, overshoot, and optional corner radius
are journaled. A closed rectangular Wire stays editable outside the target,
while its native extruded cutter is optionally filleted on four longitudinal
edges and consumed by the Boolean difference. Rounded openings use four Undo
steps and sharp openings use three.
`plasticity_create_mating_enclosure_joint` adds a rectangular male lip and its
clearance-matched female rabbet to two existing axis-aligned enclosure halves.
`seamOriginMm` is the lower-left outer corner of the XY mating plane. Outer
width/depth, wall thickness, lip thickness/height, radial fit clearance,
attachment overlap, and cutter overshoot are explicit millimeter inputs. Four
temporary boxes form two exact rings: the male ring overlaps and unites with
one half, while the wider female ring removes material from the other. All
temporary solids are consumed, both stable target IDs remain, and the eight
native history steps are returned. This lets the agent create or modify the
shells independently before applying the joint required by the active printer
and material profile.
`plasticity_create_locating_pin_pair` adds one cylindrical locating pin to a
male Solid and cuts its matching blind socket into a different female Solid.
The base center lies on the mating plane and the axis points from pin to
socket. Pin diameter/height, radial clearance, axial clearance, attachment
overlap, and cutter overshoot are explicit. The socket radius is the pin radius
plus radial clearance; its depth is pin height plus axial clearance. Both
stable target IDs remain and the four native history steps are returned.
`plasticity_create_locating_pin_pair_pattern` performs the same operation for
2–64 explicit locations: it unions all pins in one native operation and cuts
all sockets in one operation. Duplicate centers are rejected before mutation.
Both tools create exact geometric clearances from caller-supplied values; those
values still require a matching printer/material/profile fit test before they
can be treated as production recommendations.
`plasticity_create_tongue_groove_joint` joins an oriented rectangular tongue
to one Solid and cuts its clearance-matched blind groove into another. The
base center lies on the mating plane, `axis` points from tongue to groove, and
`widthDirection` lies in that plane. Tongue width, thickness, height, radial
clearance, axial clearance, attachment overlap, and cutter overshoot are
explicit millimeter inputs. Both profile Wires remain editable; the two
temporary extrusions are consumed. When Plasticity divides nested coplanar
profiles into multiple adjacent Regions, the recipe extrudes all Regions tied
to the groove profile so the cutter stays a single full rectangular Solid.
Six native history steps are returned.
`plasticity_sweep_regions` creates exact capped solids from explicit closed
Regions and a Wire spine. It exposes Plasticity's normal, parallel and transport
alignment, miter/round corners, twist, terminal scale and simplification.
Optional `guideIds` (current Wire rails) and `guideMethod` (`point`, `chord`,
`curve`) steer the profile along rails; a rail moves the result bounds.
`plasticity_sweep_curves` sweeps one or more current Wire profiles, open or
closed, along a Wire spine and returns one independent Sheet per profile (two
profiles on one spine give two Sheets in one Undo step). It takes the same
optional `guideIds` and `guideMethod`, plus `twistDegrees` and a positive
`scale`. It has no thickness, alignment or corner option.
`plasticity_loft_regions` consumes an ordered list of Regions from separate
sketch planes and creates capped loft geometry; open and closed profile chains
and native simplification are supported. Optional `guideIds` reference current
Wire bodies that intersect every profile and shape the loft between them;
`trimGuides` forwards Plasticity's native guide-trimming behavior. Profile
Wires cannot also be used as guides, and the resulting exact B-Rep bounds must
be inspected because a curved guide can extend beyond every profile.
`plasticity_loft_curves` creates an independent native Sheet through ordered
Wire profiles while preserving every profile and guide. Optional Wire guides
must intersect every profile. Open mode builds a transition surface; closed
mode needs at least three profiles and closes the loft sequence. Native
`natural`, `unconstrained`, and `clamped` curvature, profile/guide trimming,
simplification, and positive dimensionless end magnitudes are explicit. The
result never joins source bodies automatically, so inspect its exact B-Rep
topology, direction, bounds, and continuity before sewing or thickening it.
`plasticity_loft_faces` creates an independent capped Solid directly from an
ordered list of exact planar faces on different current Solid or Sheet bodies.
Every source body is preserved. Optional Wire guides must intersect all
profiles. Native `natural`, `unconstrained`, and `clamped` end conditions are
available independently; their positive magnitudes are dimensionless shape
controls, so verify the returned topology, bounds, volume, and end behavior.

The guarded native Wire-loft acceptance can be repeated with:

```sh
npm run accept:native-curve-loft -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It creates one guide-shaped open B-Surface and one closed-sequence B-Surface,
verifies exact native topology and bounds, exercises Undo/Redo, and restores
the initial empty document.
`plasticity_patch_regions` fills explicit current Regions with native Sheet
bodies while preserving the source profile curves. The resulting faces and
bounds are read back from the exact B-Rep model.
`plasticity_patch_closed_wires` fills current closed Wire bodies with
independent native Sheets while preserving every source Wire. It accepts
spatial boundaries that cannot form planar Regions and can therefore produce a
nonplanar B-Surface. The native fill defaults do not establish a requested
continuity or engineering surface: inspect the exact boundary, surface
structure, face properties, and validity before joining or thickening it.
`plasticity_xsided_patch` fills an N-sided boundary with one new native Sheet.
Give exactly one of `curveIds` (three or more current boundary Wires, which need
not form one closed Wire) or `edges` (`{ bodyId, edgeIds }`, edges of one Sheet or
Solid). Verified live on Plasticity 26.1.3: the open rim of a Sheet, the rim of a
through hole in a Solid (default flat, `g1` bulges) and the four-edge loop of a
Solid's face. Optional `guideIds` are interior Wire curves that pull the surface
toward them; they work with `curveIds` and with `edges` (verified on an open
cylinder rim and on a Solid face loop). Guides run Plasticity's XNurbs command,
which was tested only with a Studio licence (`hasXNurbs()` true); another
licence may refuse it. Optional `continuity` (`g0` default, `g1`, `g2`) applies to
all `edges` and is rejected with `curveIds`: g0 stays flat at the rim, g1 and g2
bulge off it. Use it instead of `plasticity_patch_closed_wires` when several
open Wires or Sheet edges bound the patch or the patch must match the
neighbouring surface, and instead of `plasticity_create_constrained_surface`
when the boundary is exact geometry rather than points and normals. Source Wires
and Sheet or Solid stay. Without guides it runs `PatchCommand`; with guides it runs
`XNurbsCommand`, both on `XSidedFactory`. Three more inputs are built and
measured at the operations layer (`PlasticityOperations.xsidedPatch`) but not
yet in the tool schema, because an existing test pins the schema's property
list: `edgeContinuity` (`[{ edgeId, continuity }]`, g0/g1/g2 per boundary edge
over the global `continuity`, `setContinuityForEdge`), `tension` (0.1-1.0,
default 0.5, the factory's `blending`) and `quality` (`auto`, `high`, `max`:
`enforceTolerance` = `EnforceToleranceType` Automatic, High, Max). Typing in
the live dialog's Tension input changed only `blending`, and its Quality buttons
only `enforceTolerance` (values 5, 1, 2). All three changed the patch
measurably on 26.1.3 (the benchmark's three-sheet hole, centre height: g0
28.000, g1 30.166, g1 on one of three edges 29.951, g1 with tension 0.1 29.901
and 1.0 31.010, g2 auto 30.639, high 30.678, max 30.668 mm). `weight`, the
other 0.5 default, changed nothing (1e-9 mm). Degree, spans, control type, stretch and the C1-C3, G3 and Free types are not
exposed. A failure keeps the raw XNurbs code and adds its meaning: `3` no
usable boundary input; `30` the continuity is incompatible at a corner or with
the neighbouring faces (reproduced: g1/g2 on a Solid face's edge loop with
perpendicular walls, and on a rectangular hole) - lower it, set it per edge, or
blend the rim first; `29` inconsistent constraints (guides without a boundary;
one edge that branches off the loop); `27` not fully decoded, reproduced with
g1/g2 on an open Sheet rim whose walls are perpendicular to the patch (g0
works); `25` not fully decoded, reproduced with extra edges that branch off the
loop (a bounds query that also caught the vertical wall edges). Any other code
is reported as undecoded.
Verify the result by type and face and edge counts: reported bounds can
overshoot the boundary.

The guarded nonplanar-Wire acceptance patches two independent spatial Wires in
one native history step, verifies both resulting Sheets through exact B-Rep
read-back and native validation, exercises Undo/Redo, and restores the empty
document. Repeat it with:

```sh
npm run accept:native-closed-wire-patch -- \
  --target TARGET_ID \
  --allow-disposable-mutations \
  --output /tmp/plasticity-mcp-output
```

`plasticity_join_sheets` sews two or more current Sheet bodies along coincident
edges in one native history step. Inputs must all be revision-current Sheets.
`plasticity_bridge_surface` creates a native G2 transition between two current
Sheet faces. Each face carries a world-space millimeter pick point on the
intended boundary edge; `widthMm` controls the native transition extent and
`softness` defaults to 1. Plasticity trims both source faces and replaces the
two Sheets with one editable Sheet containing a `BSurf` face. Inspect the
returned B-Rep because infeasible widths are rejected by the native kernel and
the transition width is not a promise of one final linear dimension.
`plasticity_cut_with_faces` splits current Solid or Sheet bodies with current
planar cutter faces and preserves the cutter bodies. For an open-Sheet trim,
inspect the exact parts returned after Cut and call `plasticity_delete` only on
the unwanted part using that new revision. Cut and Delete are two explicit
Undo steps. `plasticity_trim_curve_fragments` applies only to Wire fragments
and must not be used as a Sheet-trimming substitute.
`plasticity_list_appearance_materials` reads the document's native Plasticity
appearance catalog and the material ID assigned to each body.
`plasticity_set_appearance_material` can assign an existing ID, create a named
`#RRGGBB` appearance with bounded roughness, metalness and opacity, or clear an
assignment with ID 0. Creation plus assignment is one native Undo step and is
tracked by scene snapshots. These values control Plasticity display only; they
are never accepted as evidence for filament, density, strength or print
process.
`plasticity_set_block_dimensions` applies Plasticity's native direct-dimension
command to one Solid that the application still recognizes as a block. Width,
length, and height use the block's local primitive axes; the edit keeps the
existing center and occupies one Undo step. It is not a persistent constraint
or feature-history parameter. Modified or booleaned solids that no longer pass
Plasticity's native `HasBlock` check are rejected, and callers must read the
resulting B-Rep dimensions back instead of assuming the requested values were
applied.
`plasticity_set_radius_dimension` applies the corresponding native direct edit
to one current cylindrical B-Rep face. It changes the recognized cylinder or
hole radius in one Undo step and rejects noncylindrical or stale face IDs. It
does not edit fillets; use `plasticity_refillet_faces` for recognized blend
faces. Read the new cylindrical radius from the returned B-Rep state.
`plasticity_set_driving_distance` sets the distance between two parallel planar
faces of one Solid or Sheet, as Plasticity's Dimension tool does:
`{ bodyId, movingFaceId, referenceFaceId?, distanceMm, revision }`.
`movingFaceId` moves with the geometry attached to it; `referenceFaceId` stays
fixed. The faces may face opposite ways (a box's two ends), face each other
(the two walls of a slot: the slot width), or face the same way (the two top
faces of a stepped block, with either face as the reference; all verified live).
Without `referenceFaceId`,
Plasticity finds the opposite face itself. Use it to resize a part to an exact
overall dimension (a 20 mm box to 30 mm, a cylinder to 16 mm tall) without
computing an offset; `plasticity_extrude_faces` and `plasticity_move` take a
delta instead. Verified on Plasticity 26.1.3 only.

- One Undo step. The result adds `changed`, `previousDistanceMm` (what
  Plasticity measured before), `distanceMm`, `undoSteps`, `movedFaceId` (the
  moved face's new ID; face IDs change with the edit) and `planeOffsetMm` (the
  moved plane's offset along its outward normal) to the usual compact change.
- Outcomes (one classifier, `src/plasticity/pick-command-outcome.ts`):
  - committed, read back: success. Committed but the read-back does not match: a
    certain error that says what changed, names the new revision and the one
    Undo step, and `plasticity_undo` restores it (no reconcile needed).
  - Rejected, unchanged: a certain error (or the equal-distance no-op), only when
    `finish()` never ran, or when Plasticity answered "Operation has no effect"
    and nothing landed or stayed active during the settle window.
  - Anything else after `finish()`: undetermined; the session is uncertain, call
    `plasticity_reconcile`.
- After a commit the tool reads the body back, anchored on where the faces were
  before the edit (face IDs change, so faces are found by plane and by
  footprint: the face's bounds and the click point). It requires: (1) no face
  with the moving normal remains at the old offset over the click point; (2) a
  face with the moving normal at the target offset covers the click point
  carried to the target (a merge into a larger coplanar face, "make flush", or a
  split is fine; either side of the reference is accepted, the same side first);
  (3) a face with the reference's normal still lies at the reference offset over
  the reference's old centre (single-face mode: over Plasticity's reference
  point, when a face lay there before); (4) the measured distance equals
  `distanceMm` within 1e-6 mm; (5) along the normal no other plane appeared or
  disappeared, except the old and the target offsets and offsets strictly
  between them (a small step the move swallowed). The body version is not
  checked: the planes and footprints prove the edit. A bounds box cannot prove
  "still at" or "reached" when a coplanar sibling's box covers the click point
  (an island pad inside a ring-shaped face, a pad beside an L-shaped face) or
  when the moved face shifts sideways (a slanted adjacent wall). The tool counts
  the faces that cover the click point at the old offset before and after: if
  the count fell, the moving face left and the rest are siblings. When a face
  reached the target (over the click point, or adjoining the old footprint
  swept to the target), the reference is intact and the measured distance is
  right, but a sibling's box makes condition 1 or 2 unprovable, the call
  succeeds with `verification: "ambiguous"` and a `note` naming the sibling
  faces ("another coplanar face overlaps the footprint (5:ring); could not
  prove which face moved"). A plain verified edit has no `verification` field.
  The certain mismatch stays for: the moving face still there (the covering
  count did not fall), no face at either target, a moved reference, a wrong
  measured distance, or other planes changing. One case a bounds box cannot
  tell from a correct edit: a different face that covers the click point (the
  ring instead of the island) moving to the target. It is reported as ambiguous,
  because a wrong "undo this" would make `undoOnError` undo a correct build. A
  failed check after a clean
  commit is the certain "committed but does not match" error. A stepped face
  moved past the bottom of its block (5 mm below the upper face set to 12 mm) is
  removed by Plasticity; the error names the removed face and the Undo step, and
  one `plasticity_undo` restores the body (verified live).
- If Plasticity ends after `finish()` without an Undo step and without its
  no-effect rejection, the call fails with "Plasticity made no change: distance
  is still X mm, requested Y mm" and the session is uncertain (round 4: only the
  no-effect rejection proves that nothing will land).
- If the distance already equals `distanceMm` within 1e-6 mm, nothing changes:
  `changed: false`, `undoSteps: 0` and a "distance already X mm" message. With a
  reference face the tool checks this before running anything, because
  Plasticity would still record an Undo step. In single-face mode Plasticity
  refuses the equal edit ("Operation has no effect"), and the tool reports the
  same no-op.
- The tool checks the revision, that both faces belong to the body and are
  planar, and that a given reference is a different, parallel, non-coplanar
  face. It does not reject hidden or locked bodies; no sibling edit tool does.
- It seeds the click point itself: the kernel's own point on the moving face
  (`Face.GetAnyPointOn`) with the face's outward normal. A face midpoint can lie
  off the face: the midpoint of a washer face sits in its hole, and single-face
  mode then fails.
- Plasticity's last selected face moves; the click point does not decide it
  (verified live both ways). So the tool selects `[reference, moving]`.
- A pair Plasticity cannot dimension, such as a chamfer face with no parallel
  opposite, fails with "Plasticity could not dimension these faces (no effect)"
  plus Plasticity's reason, and changes nothing. So does single-face mode on a
  face whose opposite surface is not a parallel plane (the flat face of a half
  cylinder; verified live). A command that another (user) command interrupts
  before its dialog opens reads as "interrupted", naming that command. A build
  without `Face.GetAnyPointOn` fails before anything starts with "not supported
  on this Plasticity build".
- Assumption (P3, not proven): after our own `execute()` rejected with
  Plasticity's no-effect answer, only a detached promise could still commit;
  Plasticity 26.1.3 has not been observed to do this. The "no effect, the
  document is unchanged" claim after `finish()` rests on it, and so does the
  classification table (`src/plasticity/driving-distance-outcomes.test.ts`
  prunes those rows and the simulation runs them as assumption-dependent cases:
  a no-effect rejection followed by a detached commit at 400 ms and 1,500 ms,
  and a mismatch followed by a second change at 500 ms; it reports how many it
  ran and how many the late change contradicts). The no-effect text must be the
  exact phrase "Operation has no effect" or an executor-prefixed form seen live
  (`Exec.execute:rejected CommandExecutor  Operation has no effect`); cancel and
  abort (by error class and by text) are tested first, so "Command cancelled:
  Operation has no effect" and an `AbortError` with that message are cancels. A
  rejection of `exec()` after our own `execute()` resolved is a chained
  command's, not ours: undetermined after `finish()`. A native record that lacks
  `foreignActive` or `cleanupError`, or types them wrongly, is undetermined.
  While a user's command is active, an early interruption says "nothing of ours
  changed; the user's command <name> is still active" instead of "the document is
  unchanged".
- Lifecycle: everything runs in one native call. Plasticity's executor swallows
  command errors, so the tool reads the error inside the command. The native
  source reports facts only (whether the drive step called `finish()`, how the
  command settled and with which error, the Undo depth before and after a settle
  window, what is active, how the cancel and the cleanup went); Node classifies
  them. The drive step must call `finish()` before it returns: a later call is
  refused and makes the outcome undetermined. After `finish()`, while no Undo
  step has landed, the tool watches the Undo stack for 250 ms (never past the
  cancel budget) before it decides. A commit seen to land is read back like any
  other. A cancel of any kind after `finish()` (the tool's own after a timeout,
  the user's Esc, a user command that pre-empts it: "invalid state: cancelled",
  "Invalid state transition", `PK_ERROR_aborted`) never proves that nothing will
  land, so it is undetermined: live on 26.1.3 a cancel 0-10 ms after `finish()`
  discarded the commit in every trial
  (`discovery/probes-2026-11-followups/probe-late-commit.json`), but that is one
  build. A cancel that fails or throws, a command that never settles, a cleanup
  that fails, or a commit of more than one Undo step also marks the session
  uncertain. A different command that is active at the end is left alone: it is
  named in `warning` after a verified commit, and after `finish()` it makes any
  other outcome undetermined. A plain "no effect" rejection is never reported as
  "interrupted", even when a user command starts afterwards.
- The tool clears the current Plasticity selection. Works as a
  `plasticity_batch` step (for example after `plasticity_create_box` and
  `plasticity_find_faces`). Live check: `npm run accept:native-driving-distance`.
- Plasticity 26.2.x: the store binding route now binds
  `DimensionDistanceSpaceDialog`. The tool is not verified there; a missing
  binding fails with "Plasticity native binding is unavailable" before any
  change.
`plasticity_set_rectangle_dimensions` changes the native local width and
length of one closed planar Wire that Plasticity recognizes as a rectangle.
The profile stays centered, remains an editable Wire, and its Region is updated
in the same Undo step. Native width/length follow Plasticity's rectangle axes;
inspect the returned exact Wire bounds before using the Region downstream.
`plasticity_create_vertex_distance_measurement` adds a persistent native
Plasticity distance-measurement object between two current exact B-Rep
vertices. The measurement and its optional name are stored in the document,
occupy one Undo step, and are returned by `plasticity_list_measurements` with
their stable ID, topology targets, exact read-back positions, and distance in
millimetres.
`plasticity_create_topology_distance_measurement` extends the same native
measurement object to any pair of current Solid or Sheet vertices, edge
midpoints, and face centers. The list result resolves Plasticity's native
target back to the current public `vertexId`, `edgeId`, or `faceId`, identifies
each topology type, and recomputes the exact distance from the attached B-Rep
points. This is useful for persistent thickness, gap, diagonal, and inspection
dimensions; it measures the selected topology points and does not claim a
minimum distance between surfaces.
The saved measurement remains the native Plasticity document object. The MCP
rebuilds a viewport-only annotation from its exact endpoints: an offset
dimension line, extension lines, and a millimetre label. Zero-offset vertex
dimensions are placed outside the referenced body's B-Rep bounds where the
native axis-aligned path allows it. These helpers do not add model geometry or
change the exact stored measurement. Live Plasticity 26.1.3 acceptance verified
visible labels and nonzero line segments, pixel changes in the viewport,
Undo/Redo, and cleanup back to an empty test document; see the evidence path in
the [acceptance matrix](./acceptance-matrix.md).
`plasticity_create_radius_measurement` adds the corresponding persistent native
radius-measurement object to one exact circular edge. Wire segments use the
numeric `segmentEntityId` from `plasticity_list_curve_directions`; Solid and
Sheet edges use the current string `edgeId`. List results include the native
topology target, exact radius, and derived diameter in millimeters. It is a
radius measurement even when a downstream table presents its derived diameter.
`plasticity_move_measurement_label` moves the dimension line and label of one
distance measurement. `offsetMm` is `[along, perpendicular]` in the same frame
that `plasticity_list_measurements` reports. The measurement keeps its name.
The move clears the current selection; select again afterwards if you need it.
`plasticity_delete_measurement` selects that native measurement and delegates
removal to Plasticity's own removal command, also as one Undo step. Body topology
and measurement IDs are valid only for the current document revision; use the
read-only topology measurement tools when an annotation does not need to stay
in the document. These annotations are dimensions for inspection, not
parametric constraints that drive model geometry.
`plasticity_create_section_analysis` adds a native viewport section through an
explicit world-space origin and normal. The normal points toward the clipped
half-space; the optional `xDirection` fixes the in-plane frame, while omission
uses a deterministic perpendicular axis. `plasticity_list_section_analyses`
returns session-stable analysis IDs and exact plane read-back, and
`plasticity_delete_section_analysis` clears the active section. Plasticity
supports one active viewport section plane at a time. These operations use
Plasticity's native shading state, change the MCP revision and scene snapshots,
and leave B-Rep geometry and Undo history unchanged. They are for
inspection and demonstration, not for creating section geometry; use the exact
section-strength tools when area properties or load checks are required.
`plasticity_analyze_face_draft` evaluates oriented native B-Rep normals on a
finite interior grid of each selected Solid or Sheet face. Relative to the
normalized pull direction, signed draft is `asin(normal · pull)`: a wall
parallel to pull is 0°, a normal toward pull is positive, and a normal away
from pull is negative. The explicit minimum angle groups samples into positive,
negative, and neutral bands; a face spanning more than one band is `mixed`.
The result returns compact signed extrema, their exact evaluated positions and
normals, counts, surface type, and body version without changing document
history. It is a sampled check: it does not prove extrema between grid points,
a workable parting line, mold release, or FDM support requirements.
`plasticity_duplicate_bodies` creates independent exact B-Rep copies of one or
more current Solid or Sheet bodies, preserves the sources, and translates the
whole copied set by an explicit world-space millimetre delta. The grouped native
CreateInstance/Move/Realize transaction occupies one Undo step and leaves no
linked instance behind. Returned copy IDs are revision-bound; read their exact
bounds before editing them. A zero delta is allowed only when coincident geometry
is intentional.
`plasticity_create_instance` creates one native Plasticity linked instance of
a current body and can place it with an initial millimetre translation.
`plasticity_list_instances` returns its revision-bound ID, source-body IDs,
world matrix with millimetre translation components, rotation quaternion, and
decomposed local scale. Move, rotate, and scale inputs use world-space axes and
each occupy one Undo step. Because Plasticity stores instance transforms in mutable display
objects, the adapter first enters the native empty database's copy-on-write
state; this is required for Undo/Redo to restore the matrix rather than only
move the history cursor. `plasticity_realize_instances` converts selected
copies into independent exact B-Rep bodies before Boolean or per-copy geometry
editing. `plasticity_delete_instances` removes only the selected copies. Source
edits continue to propagate until realization, and every instance ID is valid
only at the returned document revision.
`plasticity_create_group` organizes current bodies, linked instances, and
existing child groups in Plasticity's native scene hierarchy. The returned
group descriptors include parent and child group IDs, direct body and instance
members, visibility, lock state, and unclassified native node keys.
`plasticity_move_to_group` reparents mixed selections while rejecting hierarchy
cycles. `plasticity_rename_group` and `plasticity_dissolve_groups` preserve
Plasticity Undo/Redo; dissolving promotes contents into the parent instead of
deleting geometry. `plasticity_activate_group` selects where Plasticity places
new objects; group ID 0 restores the root `Scene` destination.
`plasticity_set_visibility` and `plasticity_set_locked` apply exact native node
state to bodies, instances, or groups. All IDs are
revision-bound, the root `Scene` group is protected from rename, nesting, and
dissolve, and each write occupies one native history step.
`plasticity_current_selection` also returns selected instance and group IDs and
revision-bound Wire boundary/control handles, so a user's manual assembly or
curve-editing selection can be read without guessing from geometry.
`plasticity_select_nodes` performs the reverse operation for a mixed
set of bodies, instances, and groups without adding a document history entry.
`plasticity_select_faces` and `plasticity_select_edges` likewise highlight
exact revision-bound B-Rep surfaces and boundaries in Plasticity. This lets the
agent point at the topology it is discussing while the user stays in the CAD
window. `plasticity_select_curve_control_points` highlights an exact mix of
current boundary vertices and interior B-Spline handles without adding an Undo
entry.
`plasticity_align_planar_faces` rotates and translates one or more bodies as a
rigid set so an exact source-face center and normal meet a fixed target face.
The `opposed` relation seats outward normals against each other; `same` keeps
them parallel. A positive gap follows the target's outward normal. The shortest
normal-to-normal rotation does not independently align in-plane edges. Plasticity
records the combined rotation and translation as one Undo step. This is a
direct placement operation rather than a persistent assembly constraint, and
the agent must read the resulting face positions back from B-Rep.
`plasticity_align_vertices` translates a rigid set of bodies so one exact
source vertex reaches a fixed target vertex plus an explicit world-space
offset. `plasticity_align_linear_edges` rotates and translates a rigid set so
the midpoint and tangent of one exact native Line meet a fixed Line, with an
optional signed offset along the target tangent and an explicit roll around
the target line. Each logical placement occupies one native Undo step. Both
are direct placements rather than persistent assembly constraints. Re-read
the returned topology before the next operation: Plasticity can assign a new
edge ID after a rigid rotation even when the body ID is unchanged.
`plasticity_align_cylindrical_faces` performs the corresponding placement for
exact native Cylinder faces. `preserve` removes the transverse offset between
the axes while retaining the moving cluster's axial position, which supports a
planar-seat followed by hole alignment. `anchor` places the source native axis
origin at the target origin plus a signed target-axis offset. Axis direction
can be `same` or `opposed`, and `rotationAroundAxisDeg` fixes the remaining
roll. Rotation, translation, and roll share one native Undo step and preserve
the relative placement of every supplied moving body. This is also a direct
placement rather than a persistent concentric constraint.
`plasticity_check_interference` then checks explicit Solid pairs by intersecting
native clones in a temporary geometry database. An `interfere` result includes
the exact B-Rep bounds, face count, and kernel validation codes for every
intersection Solid. `no-volumetric-interference` proves only that the
intersection has no volume: touching and separated bodies deliberately share
that result, and the tool does not report minimum clearance. Use exact
face/edge measurements when a known mating gap must be verified. The check is
revision-bound and rejects its evidence if the persistent document, history,
or body descriptors change while it runs.
`plasticity_curve_pattern` distributes one or more current Solid or Sheet
bodies over the full length of an explicit native Wire. Its count includes the
source position; the spine remains editable, and the result consists of
independent native bodies rather than linked instances. Plasticity's verified
26.1.3 default rotates copies along the path. Use linked instances instead when
later source edits must propagate to every copy.
`plasticity_measure_solid_properties` reads each requested current Solid through
Plasticity's native `BodyCollection.EvaluateMassProperties()` and returns exact
B-Rep volume in mm³, surface area in mm², and volume centroid in millimetres.
For multiple bodies it also returns total volume, total area, and the
volume-weighted centroid. The tool does not infer physical mass: callers must
provide a qualified density for the selected material and print profile. The
volume centroid is a center of mass only for uniform density.
`plasticity_measure_face_properties` applies the corresponding native
`FaceCollection.EvaluateMassProperties()` to exact revision-bound Solid or
Sheet faces. Each result includes trimmed area, the full outer-plus-inner
boundary length, area centroid, surface type, planarity, outer/inner loop
counts, body version, and native face validation. Totals contain selected area,
area-weighted centroid, and the sum of each selected face's boundary. That last
sum is deliberately not unique model-edge length: an edge shared by two
selected faces is counted once for each face. Use these values for contact,
gasket, bearing, coating, and selected-surface evidence without using the
display mesh.
`plasticity_create_constrained_surface` fits a native B-Surface through paired
3D points and normal constraints. It exposes native linear/angular tolerances
and performance/smoothness optimization; the fitted surface may extend beyond
the control points, so inspect its returned exact B-Rep bounds.
`plasticity_extract_faces` copies selected current B-Rep faces into independent
native Sheet bodies and preserves the source body. This provides editable
surface references for repair, thickening, sewing, and downstream construction.
`plasticity_unwrap_face` develops one current analytic Cylinder face into an
independent planar native Sheet while preserving the source body. For a full
cylinder the exact rectangle is the axial length by `2πR`; Plasticity chooses
the seam and planar placement. The tool is intentionally limited to Cylinder
faces and does not calculate thickness, bend allowance, neutral axis,
springback, kerf, or any other manufacturing compensation. A live Cone probe
in Plasticity 26.1.3 did not produce an area-preserving frustum development, so
Cone faces are rejected rather than presented as exact flat patterns.
`plasticity_deform_bodies_between_faces` maps all faces of selected Solid or
Sheet bodies from one exact source face onto a different exact target face. It
preserves the selected bodies and both reference-face bodies, then creates
independent native copies. This supports details such as raised marks, ribs, or
surface features designed against an unwrapped Cylinder and mapped back onto
the curved face. The public contract exposes the verified dimensionless U, V,
and normal scales plus UV swap, normal flip, and mirror controls. Native U/V
offsets remain internal until their physical unit semantics are independently
verified. Deformation changes shape and can change volume, so inspect the
result's exact bounds, topology, mass properties, and native validity.

The guarded live acceptance can be repeated with:

```sh
npm run accept:native-face-deformation -- \
  --target TARGET_ID \
  --allow-disposable-mutations \
  --output /tmp/plasticity-mcp-output
```

`plasticity_deform_curves_between_faces` applies the same verified native
surface mapping to one or more Wire bodies. It preserves the input Wires and
both reference-face bodies, creates independent mapped Wires, and supports open
and closed curves in one history step. Use it for surface markings, trim
guides, projected construction paths, and later imprint workflows. Re-read
exact segment points, tangents, lengths, bounds, open/closed state, and
planarity; a closed planar source mapped to a curved face does not retain its
planar Region.

The guarded curve-deformation acceptance can be repeated with:

```sh
npm run accept:native-curve-deformation -- \
  --target TARGET_ID \
  --allow-disposable-mutations \
  --output /tmp/plasticity-mcp-output
```

`plasticity_unjoin_faces` detaches selected exact faces from their current
shells. Plasticity creates separate editable Sheet bodies and keeps the action
as one Undo/Redo history entry, which makes joined surface repairs reversible.
`plasticity_insert_sheet` performs the complementary reconstruction when an
explicit separate Sheet must be inserted into selected boundary edges of an
open target Sheet. Plasticity consumes both inputs and returns one rebuilt
Sheet or Solid; in the verified closed-box case the fill Sheet stable ID became
the result ID. All earlier body, face, and edge references must be discarded.
The agent must inspect the returned topology and run native validation instead
of assuming that matching-looking boundaries produced a closed body.

The guarded live acceptance can be repeated with:

```sh
npm run accept:native-sheet-insertion -- \
  --target TARGET_ID \
  --allow-disposable-mutations \
  --output /tmp/plasticity-mcp-output
```

`plasticity_unjoin_shells` completely disassembles each selected multi-face
Solid or Sheet into independent one-face Sheets in one native history step. The
source bodies are replaced, Plasticity may reuse a source stable ID for one
result, and every prior body and topology reference becomes stale. Use this for
full surface-level reconstruction; use `plasticity_unjoin_faces` for selective
detachment.
`plasticity_extract_edges` copies selected exact B-Rep edges into native Wire
curves while preserving the source body. Connected planar edges can form a
closed Wire and Region for downstream extrusion, sweep, or offset operations.
`plasticity_create_solid_from_sheet` converts a closed Sheet shell into a new
native Solid while preserving the source Sheet for inspection and recovery.
`plasticity_hollow_solids` offsets every face of one or more current Solids to
create a fully enclosed cavity in one native history step. Inward mode preserves
the exact outside envelope; outward mode preserves the original interior
envelope. Use `plasticity_hollow_faces` when the result needs explicit opening
faces instead of a sealed cavity. Both tools require an explicit positive wall
thickness in millimeters.
`plasticity_delete_faces` removes explicit revision-current B-Rep faces. For a
Solid this can create an open Sheet shell that can then be patched, joined,
thickened, or solidified again.
`plasticity_dissolve_faces` removes compatible internal face boundaries and
merges the selected faces into adjacent native surfaces. This reverses
temporary imprint splits without opening the body.
`plasticity_patch_sheet_hole` fills a closed boundary loop selected by current
Sheet edge IDs. If the patch closes the shell, Plasticity promotes it back to a
Solid in the same native history step.
`plasticity_cap_sheet_holes` fills every planar open boundary on one or more
current Sheet bodies in one native history step. Use it when all compatible
openings should be closed; Plasticity promotes a fully closed shell to a Solid.
`plasticity_extend_sheet_edges` extends selected boundary edges on one
current Sheet by an exact positive millimeter distance. It modifies the Sheet
in one native history step for later trimming, joining, or solidification.
Optional `shape` is `linear` (default), `soft`, `reflective` or `natural`.
Optional `targetId` extends up to another Solid or Sheet instead of a distance;
give exactly one of `distanceMm` and `targetId`. `merge: false` keeps the
extension as a separate face.
`plasticity_validate_bodies` runs the native C3D `Check()` method and reports
its diagnostic codes together with exact topology-derived Sheet boundary
edges. A native Solid is marked `printableSolid` when `Check()` reports no
errors. Solid periodic faces can expose a single seam adjacency even though the
kernel body is closed, so Solid closure follows native type plus `Check()`;
open Sheets still use their exact boundary edges and remain non-printable.
`plasticity_remove_fillets` detects and removes native blend faces from current
Solid or Sheet bodies in one history step. It is useful for restoring sharp
editable geometry in imported STEP models before applying a different radius.
`plasticity_refillet_faces` changes selected recognized blend faces by a signed
millimeter radius delta. Current exact face IDs and the resulting positive
radius are required, so imported blends can be enlarged or reduced safely.
`plasticity_create_pipes` creates solid circular pipes from Wire spines or
hollow pipes when wall thickness is nonzero. For hollow pipes, use the exact
end-edge diameters when the offset surface produces a conservative body box.
`plasticity_create_helix` creates a constant-radius native Wire around any
world-space axis. It accepts a radius, turn count, radial reference direction,
and right- or left-hand winding for spring, thread, and cable-path construction.
`plasticity_create_cone` creates either a pointed cone (`topRadiusMm=0`) or an
unequal-radius conical frustum around any world-space axis. It preserves the
closed meridional Wire and revolves its automatic native Region into an exact
Solid in the same Plasticity history step. Equal radii are rejected and should
use `plasticity_create_cylinder`.

The guarded cone and frustum acceptance can be repeated with:

```sh
npm run accept:native-cone -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It refuses a nonempty document, verifies analytic Cone and Plane faces, native
validity, exact bounds and volumes for both forms, exercises one-step Undo/Redo,
and restores the initial empty scene.
`plasticity_create_nurbs_curve` creates a native interpolating NURBS Wire
through three or more 3D millimeter points for smooth outlines and sweep paths.
`plasticity_inspect_curve_structure` reads a compact exact B-Rep description of
selected Wires, including segment type and length and, for native B-Splines,
degree, control-point count, spans, normalized knot parameters with
multiplicities, rationality, and periodicity. Knot parameters are carrier-curve
parameters mapped into the selected segment's normalized coordinates;
`withinSegment` distinguishes active knots from carrier knots outside a trimmed
segment.
`plasticity_rebuild_curves` exposes Plasticity's three verified rebuild modes:
fit to a millimeter tolerance, set the control-point count, or set NURBS degree
and span count. It preserves the requested chain/corner behavior in one native
history step. The requested fit setting remains an input; compare exact curve
evidence and functional clearances after rebuilding rather than treating that
setting as an independently measured maximum deviation.

`plasticity_raise_curve_degree` elevates every native B-Spline segment in the
selected Wires by one degree without intentionally changing its path.
`plasticity_subdivide_curves` inserts native knots while preserving the current
degree and path, adding local edit points. Each call is one history step. Read
the exact curve structure before and after because both operations increase
representation complexity and are useful for different editing goals.

`plasticity_insert_curve_knot` refines one exact B-Spline segment at one
dimensionless parameter strictly between 0 and 1. Obtain the current segment ID
and its start-to-end direction from `plasticity_list_curve_directions`; the
parameter is measured in that direction. The adapter converts it to the native
curve interval and keeps Plasticity's native transaction and history behavior.
Read back the knot list to verify the requested parameter and multiplicity.

`plasticity_evaluate_curve_segments` reads an exact B-Rep position and unit
tangent at any normalized parameter from 0 to 1 on a current Wire segment.
`plasticity_split_curve_segment` uses the same start-to-end parameter convention
to turn one nonperiodic segment into two consecutive selectable segments without
changing the Wire path. It preserves the Wire body but invalidates every old
segment reference. A full periodic circle is rejected because one split point
would only relocate its seam.

The guarded native curve-refinement acceptance can be repeated with:

```sh
npm run accept:native-curve-refinement -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It elevates one seven-control-point cubic B-Spline, subdivides an identical one,
and inserts one knot at normalized parameter 0.5 in a third. Exact native
read-back checks the resulting degree, control points, spans, knot parameters
and multiplicities, endpoints, tangents, and length, then exercises Undo, Redo,
and cleanup.

The guarded native curve-segment split acceptance can be repeated with:

```sh
npm run accept:native-curve-segment-split -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It evaluates and splits a B-Spline and a Line at normalized parameter 0.5,
checks exact split positions, tangents, and preserved total lengths, verifies a
periodic Circle rejection, then exercises Undo, Redo, and cleanup.

The guarded native surface-continuity acceptance can be repeated with:

```sh
npm run accept:native-surface-continuity -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It checks a sharp box edge as G0 with a 90° normal-angle deviation and a
plane-to-fillet boundary as G1 with relative curvature deviation 1. Both
analyses preserve revision and Undo/Redo history; the script then verifies the
fillet's Undo/Redo and restores the empty document.

`plasticity_list_curve_control_points` returns every editable native handle for
selected Wires: boundary vertices separately from interior B-Spline control
points. Each handle includes Plasticity's local positive-U and negative-U unit
directions. Each reference is tied to the current body and document revision.
`plasticity_select_curve_control_points` replaces Plasticity's current selection
with those exact handles, while `plasticity_current_selection` reads a manual or
agent-made handle selection back. Selection does not change the document or its
Undo history. `plasticity_clear_selection` (deselect, unselect, select none)
empties the current selection and adds no Undo entry.
`plasticity_move_curve_control_points` moves any selected mix by one shared
world-space millimeter delta. `plasticity_slide_curve_control_points` moves the
selected handles by one positive distance along each handle's chosen local U
direction, which lets the agent edit along the control polygon without deriving
that direction from display geometry.
`plasticity_show_face_control_points` shows the control points (B-Surface CVs) of
B-Surface faces of a Sheet or Solid. It returns the requested faces' points as
`controlPoints: [{ cvId, faceId, index, positionMm }]` (millimeters, rounded to a
micrometer because Plasticity stores float32) and
`faces: [{ requestedFaceId, faceId, controlPointCount }]`, plus
`grids: [{ faceId, u, v }]` (the shape of each requested face's control grid; a
point's `index` is `uIndex * v + vIndex`) and `renumbered`. Verified on
Plasticity 26.1.3 only:
- Showing is a history step (`undoSteps` is the measured Undo depth change,
  normally 1) and an edit of the body: face IDs change, so use the returned
  `faceId`.
- `renumbered: true` (with a message) says the shown points of other faces of
  the body got new `cvId`s with this show; read them again before moving them.
- `cvId` is a string: Plasticity's control point `versionId` (for example
  `54c10`, body version plus point index). Plasticity numbers the shown points
  of all faces together, face by face, so showing or hiding another face
  renumbers the rest: a face shown alone has indexes 0..7, and after an earlier
  face is shown it has 8..15. A bare index could therefore name a different
  point later. The `versionId` changes with every edit of the body (show, hide,
  move; verified live), so a `cvId` is valid only at the revision the call
  returns, and a stale `cvId` is rejected as unknown, never applied to another
  point.
- The tool attributes each point to its face by matching it against the face's
  kernel control grid. Points that match no grid, or two grids, are an error.
- Faces split on one B-Surface (for example by a knife cut) carry identical
  control grids, so their shown points could never be attributed. The show
  refuses such faces before any edit (no Undo step; verified live).
- A face whose points are already shown costs no step (`undoSteps: 0`).
- The tool supports BSurf faces only. Plane and Cylinder faces show no points
  but would still cost a step (other surface types are untested), so the tool
  rejects non-BSurf faces before any edit.
- The point count matches `plasticity_inspect_surface_structure` (a 4 x 2 Sheet
  shows 8).

`plasticity_hide_face_control_points` `{ bodyId, faceIds, revision }` hides shown
points (Plasticity's Toggle Points with `show` off). It is one history step that
edits the body; the `cvId`s of the body's remaining shown points change, so the
result returns those points as `controlPoints`. `undoSteps` is the measured Undo
depth change. Faces with no shown points cost no step. Hiding works by face and
needs no per-point attribution, so it also works when the shown points cannot be
attributed (twin faces shown in the Plasticity UI; verified live); remaining
points that still cannot be attributed are named in `message`, and show and move
ask for a hide first. Undo also removes a show step.

`plasticity_move_face_control_points` moves shown points by one shared
world-space millimeter `deltaMm` in one history step and returns the moved points
with their new `cvId`, `faceId` and grid `index` (the move is an edit, so both IDs
change). Points of several faces of
one body can move together. It rejects any `cvId` that is not currently shown and
asks for `plasticity_show_face_control_points` first. It reads the points back:
on each axis each point must have moved by `deltaMm` within
max(1e-3 mm, |coordinate| x 2e-7 x 4) (compared unrounded; positions are float32,
so the tolerance is 0.032 mm at 40 m and 0.096 mm at 120 m), else the call
reports what happened and the tolerance it used (the step stays in the Undo
history). A delta the read-back could not tell from no move (inside the
tolerance on every axis at that point) is refused before the edit: "below the
verifiable resolution X mm at this distance from the origin". `undoSteps` is
the measured Undo depth change; a verified move whose depth did not change
reports `undoSteps: null` with a note. A show or hide whose read-back fails says
so too and names the Undo steps it took. Moving one of two coincident points on
the edge two faces share leaves the other in place; Plasticity then reshapes the
moved face's surface (its grid grew from 4 x 2 to 7 x 2), the kernel still
reports the body valid, and the read-back fails and names the separation
(verified live, `probe-coincident-point.json`). That error names the new
revision and says: undo with `plasticity_undo`, re-read the `cvId`s with
`plasticity_show_face_control_points`, and move both points together. When the
twin point's face is not shown, the hint names that face and says to show it
first. Move both `cvId`s together to move a shared edge point. On 26.1.3 the move writes
`factory.cvs`; the 26.2 control-point adapter (which writes `controlPoints` for
Wire handles) is not used for face points because it is not verified there.
Re-read exact B-Rep geometry afterward.
`plasticity_rotate_curve_control_points` rotates handles around an explicit
world pivot and axis, while
`plasticity_scale_curve_control_points` applies positive XYZ factors around an
explicit pivot. Each transform occupies one Plasticity history step. Handle
positions are edit coordinates from Plasticity's native editor representation;
validate the resulting endpoints, tangents, lengths, and dimensions from exact
B-Rep evidence.
`plasticity_delete_curve_control_points` removes one or more selected interior
B-Spline points from one Wire. Deletion changes the path and reindexes the
remaining control-point IDs, so every old handle reference must be discarded
and the curve must be listed again.

The guarded native control-point acceptance can be repeated with:

```sh
npm run accept:native-curve-control-points -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It first selects one boundary vertex and one interior control point of a cubic
B-Spline and reads the same selection back without changing history. It slides
another point 5 mm along its returned positive-U direction, moves two handles
together, rotates another control point 90°, and scales a fourth about the world
origin. It then deletes one interior point and verifies the reduction
from seven to six B-Spline control points, every native handle position, and the
exact B-Rep endpoints and structure, then exercises Undo, Redo, and full cleanup.

`plasticity_move_faces`, `plasticity_rotate_faces`, and
`plasticity_scale_faces` directly transform current revision-bound B-Rep faces.
Plasticity extends and retrims their adjacent surfaces, so every prior face and
edge reference must be discarded after each edit. Move deltas and pivots are in
millimeters, rotations use a world-space axis and degrees, and scale uses
positive world-XYZ factors. Scaling changes the underlying surface: a Cylinder
scaled equally across its radial world axes changes exact radius, while scaling
a Plane only inside the same infinite plane can correctly be a no-op. Always
re-read exact normals, radii, edges, dimensions, and native body validity.

The guarded face-transform acceptance can be repeated with:

```sh
npm run accept:native-face-transforms -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It moves a box face by 5 mm and measures an exact 15 mm height, rotates another
box face by 10° and reads the exact plane normal and angle, then scales a
cylindrical face from R5 to R10. Each transform occupies one native history
step; all three Solids pass native `Check()`, Undo/Redo restores both source and
result geometry, and cleanup returns the document to its initial empty state.

`plasticity_thicken_faces` copies a current face set into a new independent
native body using explicit nonnegative front and back thicknesses. The source
Solid or Sheet remains unchanged; front follows the selected face normals and
back goes against them. `plasticity_offset_face_loops` inserts signed native
loops without intentionally changing volume. Its sign follows Plasticity's
oriented face adjacency, so the new loop may lie on the selected face or
propagate over neighboring faces. `plasticity_patch_solid_edge_loops` creates
independent Sheet patches from edge loops on a Solid. It preserves the source
and does not by itself fill a hole or heal the Solid.

The guarded native face-construction acceptance can be repeated with:

```sh
npm run accept:native-face-construction -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It thickens a 20 × 10 mm face by 2 mm front and 1 mm back into an exact
600 mm³ Solid, inserts a 2 mm rectangular loop with exact 16/6/16/6 mm edges
while preserving 1000 mm³ source volume, and constructs an independent planar
R3 Sheet patch over one rim of a through-hole without changing the holed Solid.
It also completely separates a twelve-face hollow Solid and unwraps an R10 ×
30 mm Cylinder face into a planar 30 × 62.831853 mm Sheet. Each operation uses
one history step, passes native validation, exercises Undo/Redo, and cleans back
to the initial empty document.

`plasticity_rectangular_face_pattern` and
`plasticity_radial_face_pattern` repeat a complete current feature-face set on
one Solid or Sheet. This is the preferred route for an existing boss, pocket,
hole, rib, or other feature recognized by Plasticity: select every connected
face that belongs to the feature, then supply linear counts and center spacing
or a world-space radial center, axis, count, and total sweep. Counts include the
source feature. Both operations replace topology in one native history step,
so discard every old face, edge, and vertex reference and verify all resulting
feature centers, dimensions, add/cut direction, and body validity.

The guarded native face-pattern acceptance can be repeated with:

```sh
npm run accept:native-face-patterns -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It repeats an R3 × 5 mm boss three times at 15 mm linear spacing and four times
around a 360° radial array. Exact B-Rep read-back checks every cylinder axis,
topology, volume, stable body ID and name. Both Solids pass native `Check()`,
Undo/Redo restores source and patterned geometry, and cleanup returns the
document to its initial empty state.

`plasticity_move_edges` moves one or more current B-Rep edges from the same
Solid or Sheet by a world-space millimeter vector. `plasticity_offset_edges`
adds native parallel edges on one adjacent surface at a signed millimeter
distance. `plasticity_delete_edges` removes selected split or seam edges and
asks Plasticity to heal compatible adjacent surfaces; the native kernel can
reject structural edges that cannot be removed. Plasticity interprets the
offset sign using the edge orientation, so the agent must inspect the resulting
strip instead of mapping the sign to a fixed world direction. All three
operations rebuild the body and invalidate every prior face and edge reference.

The guarded native edge-edit acceptance can be repeated with:

```sh
npm run accept:native-edge-edits -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It moves the top-front edge of a 20 × 10 × 10 mm box upward by 5 mm and reads
the exact moved edge, tilted face normal, and two √125 mm connecting edges.
It then offsets the equivalent edge on two more boxes by +2 mm and −2 mm,
proving that the native signs select different adjacent surfaces and create
exact 2 mm strips. A fourth box receives the same +2 mm split, then
`plasticity_delete_edges` heals it back from 7 faces/15 edges to the exact
6-face/12-edge box topology. Each edit occupies one native history step; all
four Solids pass native `Check()`, Undo/Redo restores both source and result
geometry, and cleanup returns the document to its initial empty state.

`plasticity_offset_vertices` inserts exact native split vertices at one positive
millimeter distance along every edge incident to selected current Solid or Sheet
vertices. All selected vertices must belong to one body. Plasticity preserves
the original corners, outer shape, volume, stable body ID, and name while
rebuilding the body's topology. This operation does not move a corner and is
not a chamfer or fillet; discard every prior face, edge, and vertex reference
after it succeeds.

The guarded native vertex-offset acceptance can be repeated with:

```sh
npm run accept:native-vertex-offset -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It offsets two opposite vertices of a 20 × 10 × 10 mm box by 2 mm in one
history step. Exact B-Rep read-back finds six new vertices at the expected
positions and a topology change from 6 faces/12 edges/8 vertices to
6 faces/18 edges/14 vertices. Native mass properties remain 2000 mm³ with
centroid [10,5,5] mm, the Solid passes native `Check()`, Undo/Redo restores both
topologies, and cleanup returns the document to its initial empty state.

`plasticity_inspect_curve_planarity` asks the native kernel whether selected
Wires are exactly planar and returns the detected plane. When a spatial path
must lie on a known plane, `plasticity_planarize_curves` orthogonally projects
it onto an explicit world-space origin and normal. Projection changes the path
and Plasticity may reverse its parameter direction, so always re-read
planarity, endpoints, direction, and functional dimensions afterward.

The guarded native planarization acceptance can be repeated with:

```sh
npm run accept:native-curve-planarize -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It projects a non-planar cubic B-Spline onto Z=5 mm, checks the native plane,
curve structure, projected endpoint pair and direction, then exercises Undo,
Redo, and full cleanup.

`plasticity_bridge_curves` creates an independent native B-Spline between two
exact endpoints selected from current Wire segments. Obtain `bodyId`,
`segmentEntityId`, endpoint positions, and directions from
`plasticity_list_curve_directions` immediately before the mutation. Each end
accepts G0 positional, G1 tangent, G2 curvature, or G3 third-order geometric
continuity. The source Wires are preserved, so inspect the returned bridge and
use `plasticity_join_curves` separately only when one combined Wire is needed.

`plasticity_bridge_curve_vertices` provides the same independent transition
from two exact open Wire vertices. Read the current numeric `vertexId` values
with `plasticity_list_curve_vertices`; internal, stale, coincident, or non-Wire
references are rejected before mutation. This is the preferred form when the
agent already selected explicit sketch endpoints rather than segment senses.

`plasticity_bridge_shell_edges` starts the same native transition from exact
Solid or Sheet topology. Each endpoint reference combines a current `bodyId`,
`edgeId`, and one `vertexId` listed for that edge. G0 through G3 are selected
independently at both ends. The operation creates an independent Wire and
preserves both source bodies; read the returned Wire's exact endpoints and
tangents before using it as a downstream Sweep or surface guide.

The guarded native Curve Bridge acceptance can be repeated with:

```sh
npm run accept:native-curve-bridge -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It creates G0 through G3 transitions between four pairs of straight source
Wires, one G2 transition selected by exact open Wire vertices, and one G2
transition between explicitly selected vertical edges of two Solids. Exact
native read-back checks endpoints, tangent directions, lengths, B-Spline degree
and control-point count, then verifies source preservation, Undo, Redo, and full
cleanup.

The guarded native curve-rebuild acceptance can be repeated with:

```sh
npm run accept:native-curve-rebuild -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It rebuilds three identical seven-control-point cubic curves by a 0.1 mm fit
tolerance, nine control points, and degree 5 with three spans. Native read-back
checks the resulting B-Spline structure and endpoints, then exercises Undo,
Redo, and full cleanup.

`plasticity_capabilities` pages through native renderer bindings (100 by
default, up to 250 per call); use case-insensitive `query`, `offset`, and
`limit` to inspect a focused slice without flooding MCP context. Its response
includes total/matching counts, `nextOffset`, and structured availability for
saved construction planes and active workplane control. Construction
references always contain `id`, `sessionId`,
`documentToken`, and `revision`. Pass the whole identity object back to plane
activation/removal and plane-local curve tools. References from another MCP
connection, document, or revision are rejected rather than rebound silently.

`plasticity_create_polyline`, `plasticity_create_circle`,
`plasticity_create_two_point_circle`, `plasticity_create_three_point_circle`,
`plasticity_create_tangent_circle`,
`plasticity_create_center_arc`, `plasticity_create_three_point_arc`,
`plasticity_create_tangent_arc`, `plasticity_create_ellipse`,
`plasticity_create_regular_polygon`, and `plasticity_create_rectangle` accept
world-space 3D inputs or 2D millimeter coordinates plus a current plane
identity. Center arcs take a start angle and a signed sweep below 360 degrees;
positive sweep is counterclockwise around the selected plane normal and the
native curve direction is preserved from the requested start to end.
Three-point arcs instead take exact start, through, and end points; their order
selects the minor or major arc and preserves the requested start-to-end
direction. Tangent arcs continue an exact current Wire segment at its selected
start or end; the opposite tangent sense can select the major arc. Obtain the
revision-bound segment entity and endpoint geometry from
`plasticity_list_curve_directions` immediately before creating the arc or a
tangent circle. A tangent circle takes two distinct current Wire segment
references, one positive radius, and a solution point that chooses the intended
center neighborhood when several geometric solutions exist. The point is not a
third tangency constraint. Both source Wires remain unchanged, and the caller
must re-read the returned state because the new circle can change automatic
Region subdivision. Ellipses take explicit major/minor radii and an in-plane
major-axis angle. Regular polygons take 3–256 vertices and distinguish a center-to-vertex
circumradius from a center-to-edge inradius. Closed ellipses and polygons
create associated Regions for later extrusion or cutting. A rectangle is
created through Plasticity's native three-point rectangle command, takes exact
width and height, and can rotate its width axis by a signed angle around the
plane normal. In world space its normal and in-plane X direction are explicit;
parallel axes are rejected before CDP mutation. The server transforms local
X/Y through the saved orthonormal frame before the single millimeter-to-metre
conversion. Mixed 2D, 3D, orientation, and plane forms are rejected by strict
schemas.

The guarded native sketch-primitives acceptance can be repeated with:

```sh
npm run accept:native-sketch-primitives -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It creates positive and negative center-defined circular arcs, a three-point
major arc, minor and major tangent arcs from a preserved source line, a
fixed-radius circle tangent to two preserved exact line segments, a
20 × 10 mm-radius ellipse, and a regular hexagon from a 10 mm inradius. It reads
endpoints, tangents, arc lengths and major-arc bounds, tangent-circle bounds,
circumference and both exact tangency intersections, ellipse bounds and
perimeter, polygon side lengths, and Region associations from native B-Rep
evidence. Thirteen Undo/Redo operations restore all Wires and seven Regions;
final cleanup restores the empty document.

The guarded native-rectangle acceptance can be repeated with:

```sh
npm run accept:native-rectangle -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It creates a 40 × 20 mm rectangle on an inclined plane, reads all four segment
lengths from exact native B-Rep, verifies its associated Region and one-step
history behavior, exercises Undo/Redo, and restores the empty document.

The guarded native curve-fillet acceptance can be repeated with:

```sh
npm run accept:native-curve-fillet -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It selects all four exact vertices of a 40 × 20 mm rectangle, applies R3 in one
native command, verifies eight B-Rep segments and the retained Region, checks
the four trimmed lines at 34/34/14/14 mm and four quarter arcs at
4.71238898 mm, exercises Undo/Redo, and restores the empty document.

The guarded closed-solid hollowing acceptance can be repeated with:

```sh
npm run accept:native-hollow-solids -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It hollows a 100 × 80 × 40 mm Solid inward by 2 mm in one native command,
measures the sealed cavity as 96 × 76 × 36 mm from exact opposing B-Rep faces,
checks the exact 57,344 mm³ material volume, validates the closed Solid, exercises
Undo/Redo, and restores the empty document.

The guarded native body-outline acceptance can be repeated with:

```sh
npm run accept:native-body-outlines -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It preserves a 20 × 10 × 5 mm Solid, creates one exact 20 × 10 mm silhouette
at the source Z=10 mm plane and another on the explicit Top workplane at Z=0,
verifies all eight native line lengths and both Regions, exercises Undo/Redo
for each operation, restores the initial workplane, and returns the document to
its empty state.

The guarded native curve-pattern acceptance can be repeated with:

```sh
npm run accept:native-curve-pattern -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It distributes one 10 × 4 × 2 mm Solid into five independent native Solids
over a three-point NURBS path, verifies exact 80 mm³ volume for every copy and
400 mm³ total volume, checks the endpoint and midpoint centroids, tangent-following
orientation, one-step history, Undo/Redo, spine preservation, and full cleanup.

`plasticity_create_text` creates closed native Wire outlines using Plasticity's
verified `inter` font. It accepts a nominal font size, baseline origin, and the
same world or construction-plane placement model. A string can produce several
Wires and Regions, and its actual glyph envelope is deliberately read back from
the native curves rather than inferred from the nominal font size. The outlines
can then be extruded or used as cutters for embossed and engraved labels.

The guarded native-text acceptance can be repeated with:

```sh
npm run accept:native-text -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It creates and places the `M5` outlines on a vertical plane in one history
step, checks two closed Wires, two Regions, 45 exact native curve segments and
their measured envelope, exercises Undo/Redo, and restores the empty document.

`plasticity_list_construction_geometry` returns the active plane ID and full
current plane reference alongside all points, axes, and planes. Snapshots also
capture current datum identities; `plasticity_changes_since` reports them in
`diff.staleDatums` when a revision or document change invalidates them.

The construction tools are:

- `plasticity_define_datum_point`
- `plasticity_define_datum_axis`
- `plasticity_create_construction_plane`
- `plasticity_list_construction_geometry`
- `plasticity_set_workplane`
- `plasticity_remove_construction_plane`
- `plasticity_refresh_datum`

Saved plane creation/removal uses one native Plasticity history entry. Datum
definitions live only for the current MCP session. A body edit or manual saved
plane edit makes geometry-backed datum identities stale; call
`plasticity_refresh_datum` for a resolvable topology-backed datum or define a
new immutable coordinate datum at the new revision.

### Board case: base and lid in one call

`plasticity_create_board_case` builds a two-part enclosure around a
rectangular board in one call: the base shell, one standoff under each board
hole, four corner bosses for the lid screws, the lid plate with a locating lip,
countersunk or plain lid screw holes, wall/lid/floor openings, one slot vent and
an optional board stand-in. It is in the compact tool list. Bodies are named
`<name>-base`, `<name>-lid` and `<name>-board` (default name `case`). The
derived dimensions come back in `derived`, computed from the parameters (never
read back), so a later step uses them instead of searching faces. The result is
then read back natively (see "When the rules run").

All lengths are millimetres. Inputs and defaults: `originMm` (outer bottom
corner of the base); `board` `{ lengthMm (x), widthMm (y), thicknessMm 1.6,
holes [{ xMm, yMm, diameterMm }] from the board's min corner, componentHeightMm,
undersideClearanceMm 2 }`; `fit` `{ boardClearanceMm 0.5, lidClearanceMm 0.2 }`
(per side); `walls` `{ wallMm 2 (at least 0.8), floorMm 2 (at least 0.8), lidMm 2,
outerCornerRadiusMm 3 }`; `standoffs` `{ heightMm = undersideClearanceMm,
outerDiameterMm = hole + 3, fastener: { screw M2|M2.5|M3, mode
pilot|heat-set-insert|through, pilotDiameterMm, pilotDepthMm (default the
standoff height), insertLengthMm, clearanceFit close|medium|free (default
medium) } }`; `lid` `{ lipDepthMm 1.5, lipWallMm 1.2, fasteners: { screw,
count 4, bossDiameterMm 6, bossStyle floor|tapered|hanging (default floor),
allowBlockedBoard false, growAxis x|y (floor only), countersunk true,
headDiameterMm, base pilot|heat-set-insert, pilotDiameterMm, pilotDepthMm,
insertLengthMm, clearanceFit } }`; `openings` `[{ wall x-|x+|y-|y+|lid|floor,
shape rect|rounded-rect|circle, widthMm, heightMm, cornerRadiusMm
(rounded-rect), alongMm, aboveBoardMm (walls) or acrossMm (lid, floor), label
}]`; `vents` `{ on lid|x-|x+|y-|y+, slots, slotWidthMm, slotLengthMm, pitchMm,
centerAlongMm, centerAcrossMm }`; `boardStandIn` false; `exploded` 0.

Openings: on a wall, `widthMm` runs along the wall and `heightMm` is vertical;
`alongMm` is the centre along the wall from the board's min corner on that axis
(y for x walls, x for y walls) and `aboveBoardMm` is the opening bottom above the
board top surface. On the lid and the floor, `widthMm` is along x, `heightMm`
along y, `alongMm` is the x centre and `acrossMm` the y centre from the board's
min corner. A circle takes `widthMm` as its diameter. Vents: on the lid the
slots are spaced along x by `pitchMm` and run along y; on a wall they are spaced
along the wall and run vertically. `centerAlongMm` defaults to the board centre;
`centerAcrossMm` is the y centre on the lid (default board centre) and the
height of the vent centre above the board top on a wall (default: the middle of
the open wall band).

Derived geometry (O = `originMm`, bc/lc = board/lid clearance, w = wall,
f = floor, t = lid, d = lip depth, Ro = outer corner radius):

- cavity = board + 2 x bc in x and y (plus the `floor` growth below); outer =
  cavity + 2 x w; the cavity starts at O + (w, w, f). `floorTopZMm` = O.z + f.
- support = standoff height (or `undersideClearanceMm` without standoffs; a
  standoff below the underside clearance is refused). Board bottom =
  floor top + support; `boardTopZMm` = board bottom + thickness;
  `componentTopZMm` = board top + componentHeight.
- boss length = base hole depth + 1 mm (only with lid screws; 0 otherwise).
  `wallTopZMm` (styles `hanging` and `floor`) = componentTop + 1 mm headroom +
  max(d, boss length) (`floor`: or the boss hole depth + 1 above the floor
  top, if that is higher). So the base inner height (floor top to wall top) is
  support + board thickness + componentHeight + 1 + max(d, boss length): the
  lip (and the bosses) occupy space above the component envelope plus
  headroom, never inside it. The lip bottom is at wallTop - d. Style
  `tapered` raises the wall top further, see below.
- `lidTopZMm` = wallTop + t + exploded. The lid plate (outer size, outer corner
  radius) sits on the wall top. `lidMm` is the lid's planned bounds: the outer
  x/y, from the lip bottom (+ exploded) to the lid top.
- Inner corner radius (`innerCornerRadiusMm`, Ri) = min(Ro - w, the largest the
  board's square corner allows). The board corner sits bc from both walls; a
  rounded cavity corner clears it when Ri <= bc x (2 + sqrt 2). The plan keeps
  0.05 mm between the board corner and the arc: Ri <= (bc x sqrt 2 - 0.05) /
  (sqrt 2 - 1) (1.586 for bc 0.5; the defaults give Ri = 1).
- `cornerWallMm` = w x sqrt 2 - (Ro - Ri) x (sqrt 2 - 1), the wall along the
  corner diagonal (= w for a uniform wall, Ri = Ro - w). It must be at least
  max(0.8, 0.75 x w); the refusal names the largest `outerCornerRadiusMm` that
  passes.
- Lip ring: outer = cavity - 2 x lc per axis (`lipOuterMm`, corner radius
  Ri - lc), wall `lipWallMm` (`lipInnerMm`), depth d below the plate.
- Standoffs: `standoffAxesMm` = board min corner + hole position;
  `standoffTopZMm` = board bottom, so a board stand-in sits on them.
  `fasteners.standoffs.outerDiametersMm` has one entry per standoff, in the
  order of `standoffAxesMm`.
- Lid screw bosses (`lidBossAxesMm`): one per cavity corner, centred
  bossDiameter/2 - 0.5 mm from both adjoining inner walls (each boss overlaps
  its walls by 0.5 mm), flush with the wall top so the lid plate clamps on
  them. The lid lip is notched around each boss with radius bossDiameter/2 +
  lc; when that round notch would leave a lip piece shorter than 1 mm between
  itself and the corner, the notch is a box from 0.5 mm outside the cavity
  corner past the whole boss circle instead, so no sliver remains. The lid
  holes are coaxial. `lid.fasteners.bossStyle` (default `floor`) chooses how
  the boss is carried; `derived.bossStyle` echoes it:
  - `floor` (default): the bosses stand on the floor and rise to the wall top
    (`lidBossBottomZMm` = floor top; `fasteners.lid.bossLengthMm` is the real
    floor-to-wall-top length), and the cavity grows so every boss lies outside
    the board keep-out (board outline + boardClearance). The keep-out edge
    must be one boss radius from the boss axis, so the cavity grows by 2 x
    (bossDiameter/2 - 0.5 + bossDiameter/2) in ONE axis (11 mm for a 6 mm
    boss). Growing an axis moves its two end walls away from the board, so an
    opening on them would no longer reach the board edge. Rule: grow the axis
    whose two end walls carry no opening (wall openings and wall vents count;
    lid and floor openings do not); when no wall carries one, the axis whose
    growth adds less floor area (x unless the cavity is shorter in x than in
    y); when both axes carry one, the call is refused unless
    `lid.fasteners.growAxis` names the axis (an explicit `growAxis` always
    wins). `derived.cavityGrowthMm` is `[x, y]`, `derived.growAxis` the axis and
    `derived.growAxisReason` why. The other axis keeps boardClearance exactly
    and the board is centred. Standoffs stay under the board holes, and
    openings stay referenced to the board.
  - `tapered`: the boss hangs from the walls on a 45 degree gusset. The
    gusset is a cone with its apex on each cavity corner and its axis on the
    corner line, rising at 45 degrees from vertical to the boss bottom (and
    0.5 mm past it into the boss), cut off 0.5 mm inside the two walls. Its
    height at the boss bottom is reach = (bossDiameter/2 - 0.5) x sqrt 2 +
    bossDiameter/2, the farthest boss point from the corner. The lowest point
    of the gusset inside the cavity is `bossTaper.bottomZMm` = apex + Ri x
    (sqrt 2 - 1); it must stay at least componentTop + 1 mm, so `wallTopZMm`
    rises to componentTop + 1 + boss length + reach - Ri x (sqrt 2 - 1);
    `bossTaper.addedHeightMm` is that rise over the `hanging` wall top.
    `derived.bossTaper` is `{ angleDeg 45, bottomZMm, addedHeightMm }`. The lip
    depth must not exceed the boss length minus 0.5 mm.
  - `hanging`: from `lidBossBottomZMm` (= wallTop - boss length, at least
    componentTop + 1 mm) up to the wall top, with a flat underside.
  - `derived.assembly` `{ boardDropIn, note }` (always present) is computed in
    plan view: `boardDropIn` is true only when no boss and no gusset overlaps
    the board outline grown by 0.2 mm. The hung styles overhang the board
    corners, so for any practical clearance they are refused unless
    `lid.fasteners.allowBlockedBoard: true` (then `boardDropIn` is false: the
    board cannot be lowered into the finished base). A `floor` case with
    boardClearance below 0.2 mm is refused the same way.
  - `derived.boardWallClearanceMm` `{ xNeg, xPos, yNeg, yPos }` (all styles) is
    the free space between each board edge and the cavity wall: boardClearance
    on every side, plus half the growth on both sides of the grown axis.
  - `derived.printability` (always present) is computed from the derived
    geometry, never assumed: `{ baseOrientation: "floor-down",
    maxBossOverhangDeg (with lid screws only), scope, lidPrintOrientation:
    "top face down", lidMaxOverhangDeg, openingCeilings }`.
    `maxBossOverhangDeg` is the boss underside only (90 `hanging`, 45
    `tapered`, 0 `floor`; the plan refuses a `tapered` or `floor` case above
    45 degrees + 1e-6). `lidMaxOverhangDeg`
    covers every lid face printed top face down: half the countersink included
    angle (45), or 0 without countersinks. `openingCeilings` lists every flat
    ceiling of a rect or rounded-rect wall opening wider than 6 mm
    (`{ label, wall, widthMm, zMm }`, the flat width is width - 2 x corner
    radius): a bridge when the base prints floor-down. `scope` states what is
    not covered (circle crowns, rounded corners and wall vent slot ends,
    strength).
- `openings[*].centerMm` is the centre of the opening on the outer face it is
  cut from (outer wall face, lid top, floor bottom); `sizeMm` is
  [width, height].
- `plannedUndoSteps` is the number of Undo steps the composition takes, step
  for step; the build's measured `undoSteps` equals it.

Fixed construction constants (returned as `constants`, not engineering values):
1 mm headroom, 0.5 mm boss-to-wall overlap, 1 mm closed floor under a boss hole,
0.5 mm cutter overshoot and lip-to-plate joint. The limits below are returned as
`limits`.

Fasteners use `plasticity_fastener_presets` (read-only, also callable directly):
ISO 273 clearance holes close/medium/free (M2 2.2/2.4/2.6, M2.5 2.7/2.9/3.1,
M3 3.2/3.4/3.6), following the ISO 273 pattern as cited by two chart pages
(amesweb.info and fmcarbide.com), not read from the standard; confidence medium.
CNC Kitchen heat-set insert pockets (M2x3 Ø3.2 wall 1.3; M2.5x4 Ø4.0 wall 1.6;
M3x5.7 and M3x3 Ø4.0 wall 1.6; blind hole = insert length + 1 mm; CNC Kitchen
design-guidelines PDF; medium): the sheet lists three M3 inserts and the table
holds two of them (M3 x 5 x 4 VORON, hole 4.4, is not in it). The ISO 10642 M3
countersunk head (Ø6.72, 90°; engineersedge.com; medium): 6.72 is the
theoretical sharp-corner head diameter (dk theoretical max.), noted in the
table. Not sourced and therefore never defaulted: self-tapping pilot diameters
(`pilotDiameterMm` is required for `pilot`, and `pilotDepthMm` for lid bosses,
since it sets the boss length) and the M2/M2.5 countersunk head (`countersunk:
true` with M2/M2.5 is refused unless `headDiameterMm` is given). M3 has two
sourced inserts, so `insertLengthMm` (5.7 or 3) is required for M3. Every value
a build uses is echoed in `derived.fasteners` with its source
(`caller-supplied` for caller values).

When the rules run. The plan (a pure function) checks every rule below before
the first native call, and the call is refused with a message that states the
limit; nothing is edited. The sub-recipes repeat their own input checks when
they run; no input is known that passes the plan and fails one of them, but that
is not proven. Then the build runs, and after it a
native read-back must prove the result: the base's native bounds equal
`derived.outerMm`, the lid's `derived.lidMm` and the stand-in's
`derived.boardMm` (within 0.001 mm), every body is closed and natively valid
(Plasticity's B-Rep Check), and no edge is shorter than 0.05 mm. The result
carries it as `readBack`. A native failure part-way or a failed read-back undoes
the recipe's own steps (counted by the Undo depth) and the error names the
failed stage (`read-back` for the read-back), the confirmed step count, the
undone count (they agree; a sub-recipe step that landed but failed its own check
is listed, with the profile Wire it left) and whether the document matches the
start; after an uncertain native result it undoes nothing and says to
reconcile. The plan sets no lower limit on `board.thicknessMm`: a 1e-6 mm
board stand-in passes it, Plasticity's box command refuses it, and the recipe
undoes itself.

The plan's rules: every dimension positive (corner radius and `exploded` may be
0); `originMm` within 100,000 mm of the document origin; board length and width
at most 500 mm; board thickness, componentHeight, undersideClearance, standoff
height, lip depth and `exploded` at most 200 mm; board holes, pilot holes and
circle openings at least 0.5 mm across, pilot holes at least 0.5 mm deep, and at
least 0.4 mm of wall around a pilot or clearance hole in a boss or standoff; wall
and floor at least 0.8 mm; `lipWallMm` at least 0.4 mm; lid thicker than the
0.5 mm lip joint;
board holes inside the board and not overlapping; standoffs at least the
underside clearance, deep enough for an insert, at least the sourced insert
wall, at least 1 mm wider than their board hole, and inside the cavity grown
by w - 0.4 mm with at least 0.4 mm of wall left to the outer profile, rounded
corners included (a standoff may merge into the wall, but 0.4 mm of wall stays
outside it); the corner wall rule above; every boss and gusset at least
0.8 mm inside the outer profile, rounded corners included (with the 0.5 mm
boss overlap this needs walls of at least 1.3 mm with lid screws); the
countersink (or, with `countersunk: false`, the `headDiameterMm` or clearance
hole) circle at least 0.5 mm inside the lid outline, rounded corners included;
the countersink shallower than the lid; openings and vent slots inside their
face (a wall's flat span and the band from the floor top to the lip bottom; the
lid area inside the lip; the flat floor), clear of the standoffs, the lid
bosses and (style `tapered`) the gussets, tested against their real footprints
(a standoff or boss that merges into a wall occupies its whole diameter along
that wall over its height; a gusset its cone radius at the opening's height),
with the pair named; openings and slots on one face separated by a web of at
least 0.4 mm (touching or overlapping is refused); vent pitch at least slot
width + 0.4 mm; four bosses that fit the cavity; a `floor` boss not standing on
a standoff; the board drop-in and `floor` growth-axis rules above; a lip depth
below the base inner height; and at most 400 planned Undo steps (the refusal
states the count).

The build composes the existing recipes (screw boss pattern for standoffs and
bosses, through-hole, countersink pattern, connector opening, slotted hole
pattern) with direct boxes, fillets, revolves and Booleans for the shells, the
lip and the gussets, then deletes the construction Wires the sub-recipes keep
in one step, so only the two (or three) Solids are added. It runs in one
exclusive section. `undoSteps` is the measured Undo depth change. In a lean
batch the step replies `{ status }`; `return: ["bodies",
"derived.lidBossAxesMm"]` fetches exactly those fields.

Live acceptance: `PLASTICITY_CDP_URL=http://127.0.0.1:<port> npm run
accept:native-board-case -- --target ID --allow-disposable-mutations --output
NEW_DIRECTORY` builds the multi-part benchmark board in all three styles
(`floor` by default; `tapered` and `hanging` with `allowBlockedBoard`), the
audit enclosure equivalent with heat-set inserts and a small sensor pod; checks
every `derived` field and the read-back with independent face, edge, validity,
interference and clearance reads; lifts each board stand-in straight up in
3 mm steps until it clears the wall top, checking base-board interference at
every step (`boardDropIn` must equal "no interference at every step"); undoes
each case with one batched undo; sends the reviewer's bad inputs (each must be
refused with the Undo depth, the body count and the revision unchanged); and
forces one native failure (the 1e-6 mm board stand-in) to prove the rollback.

## Development and verification

```sh
npm test
npm run typecheck
npm run probe:targets
npm run probe:regions
# destructive proof, only in an explicitly chosen empty test window:
npm run probe:regions -- --mutate --target <target-id>
npm run accept:instances -- --target <target-id> --allow-disposable-mutations --output <new-directory>
npm run accept:groups -- --target <target-id> --allow-disposable-mutations --output <new-directory>
npm run accept:interference -- --target <target-id> --allow-disposable-mutations --output <new-directory>
npm run accept:solid-properties -- --target <target-id> --allow-disposable-mutations --output <new-directory>
npm run accept:native-parasolid -- --target <target-id> --allow-disposable-mutations --output <new-directory>
npm run accept:native-iges-sat-clear-selection -- --target <target-id> --allow-disposable-mutations --output <new-directory>
npm run accept:native-extend-sweep-label -- --target <target-id> --allow-disposable-mutations --output <new-directory>
npm run accept:native-patch-polysplines-facepoints -- --target <target-id> --allow-disposable-mutations --output <new-directory>
```

The last three accept commands (`accept:native-iges-sat-clear-selection`,
`accept:native-extend-sweep-label`, `accept:native-patch-polysplines-facepoints`)
require `PLASTICITY_CDP_URL` to name the isolated test instance. They refuse to
start without it, never launch Plasticity (they force `PLASTICITY_AUTO_LAUNCH=0`
and `PLASTICITY_HUD=0`), and recover the baseline on every exit path.

The live acceptance run created an 80 × 40 × 8 mm plate with two Ø6 mm
through-holes and four R2 outer vertical fillets. It verified Undo/Redo,
saved `.plasticity` and STEP files, reopened the native document, imported the
STEP, and captured a screenshot. Evidence and exact artifact paths are in
[the native-access report](./native-access-report.md). Текущее состояние
каждого требования и проверки, которым ещё нужно внешнее устройство, сведены
в [матрицу готовности](./acceptance-matrix.md).

This adapter is pinned to Plasticity 26.1.3. Plasticity's internal interfaces
are undocumented and may change in another release.

## Photo or sketch workflow

The MCP exposes the `plasticity_model_from_reference` prompt for agents that
support MCP prompts, plus `plasticity_analyze_design_reference` for bounded,
structured photo/sketch interpretation through the isolated Codex API. Codex
remains the conversation partner; Workbench is optional. The intended workflow
is:

1. Attach up to four PNG/JPEG/HEIC/HEIF views of the part, a hand sketch, or a
   dimensioned drawing to the agent (20 MiB per image).
2. The agent passes all supplied views and the task to the design-reference tool
   in one Codex request. It records
   visible facts separately from inference, binds claims to evidence IDs, and
   reports whether scale is dimensioned, calibrated, unscaled, or unknown.
   An unscaled image never yields millimeter measurements.
3. The agent asks only the next decision-relevant question package. For a
   bracket, this starts with what it supports and how it is mounted; strength
   and load path come before wall thickness. It explains why the missing fact
   matters. If the user does not know, it asks for one useful contextual clue
   such as the supported object or a product photo, rather than repeating the
   same unknowns. The user may delegate the assigned choice while the agent
   keeps its assumptions visible.
   Optional refinements do not delay a sufficiently specified task. Before
   changing the model based on a consequential choice that was not delegated,
   the agent gives its recommendation and trade-offs and asks the user to
   accept, reject, or delegate.
4. For a named product, call `plasticity_search_product_references` to use an
   isolated Codex live-web profile to search manufacturer CAD and drawings
   first. It returns candidate source links and cited dimension evidence; the
   agent reviews source, license, file format, and fit-critical dimensions.
   Search never downloads or imports a model. Select a candidate explicitly
   before passing its public STEP URL to the guarded importer.
5. Once the question is resolved and the modeling action is authorized, the
   agent connects to an explicit Plasticity window, reads status, and captures
   a scene snapshot. For one chosen public STEP URL, it supplies the HTTPS
   source, source category, known license, and confidence to
   `plasticity_download_and_import_step`; the MCP pins public DNS results,
   bounds redirects and file size, validates the STEP envelope, and imports a
   private hash-addressed copy. For a STEP already downloaded locally, it can
   use `plasticity_import_step`. The import response stays compact: it returns
   document identity/revision, changed body IDs/count, artifact SHA-256, and a
   durable local CAD-reference provenance ID. Read exact geometry only for
   selected IDs with `plasticity_body_info`; the historical import record can
   be recovered through `plasticity_list_cad_reference_imports` and
   `plasticity_get_cad_reference_import` after restart.
6. The agent compares before/after scene snapshots, checks exact B-Rep bounds,
   groups and locks reference bodies, then builds native functional geometry
   separately. It reads dimensions back from Plasticity and presents an
   isometric screenshot for review.
7. Before manual work, it captures another compact snapshot (ID, revision and
   object counts; the B-Rep baseline remains private to the MCP process). After
   the user edits or selects geometry in Plasticity, `plasticity_changes_since` and
   `plasticity_current_selection` return a compact, revision-bound, paginated
   summary of changed bodies plus the selected face/edge IDs. Follow
   `bodyPagination.nextOffset` with `expectedRevision=current.revision`; use
   `plasticity_body_info` to read exact topology for a selected body. The agent
   continues from the new revision.

To verify the read-only scene-observation path against a live window, run
`npm run accept:compact-observation -- --target PLASTICITY_WINDOW_ID --output NEW_DIRECTORY`.
It uses the production stdio MCP server, checks connect/status and body-list
pagination, captures an in-memory snapshot, reads the unchanged diff and
journal, and refuses to overwrite evidence. It performs no CAD mutation.

To validate a paginated scene diff against live Plasticity, use a separate
disposable test document and explicitly opt into disposable mutations:

```sh
npm run accept:compact-diff-live -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EVIDENCE_DIRECTORY
```

This verifier creates 201 temporary boxes through the production stdio MCP
server, checks that `plasticity_changes_since` and the construction journal
paginate as 100, 100, and 1 without duplicates or detailed B-Rep topology. It
also checks every mutation response for its total body count, a compact page
of at most 20 summaries, and exactly one compact added-body summary. It records
the maximum and mean serialized mutation-response sizes in `evidence.json`. It
captures the initial scene and refuses documents with redo history,
non-root groups, regions, or instances. It uses native Undo only while the
selected document and revision still match the verifier's last confirmed state;
an uncertain command outcome stops automatic cleanup. Undo restores the
initial scene but leaves the temporary operations in the document's redo
history, so use a disposable document and discard it after the run. Keep other
editors and agents out of the document during the acceptance. Help/no-argument
mode is inert and evidence directories are never overwritten.

The direct-UI geometry-change acceptance is available for an explicit empty
test document:

```sh
npm run accept:native-ui-edits -- \
  --target PLASTICITY_WINDOW_ID \
  --allow-disposable-mutations \
  --output NEW_EMPTY_DIRECTORY
```

It creates one temporary Solid, waits for a visible mouse move in Plasticity,
then checks the reported scene diff, exact native bounds, Undo/Redo and cleanup
to the original empty document. Live UI gesture verification still needs to be
completed on this host.

Workbench can persist the original artifact and reference record when it is
enabled. Without Workbench, the MCP reference store keeps the STEP hash, source
metadata and import-time B-Rep snapshot locally; current-process journal
entries remain session-only, while compact mutation history survives MCP
restarts. The original STEP remains at its source path. The agent should
include source and measurement details in the Codex conversation for project
portability.

The image-backed tool path passed a real Codex API call through stdio MCP on
2026-09-24. Its synthetic bracket sketch stayed unscaled, returned nine
observations and one question package, contained no millimeter measurements,
and every interface/feature claim resolved to an observation ID. A separate
live acceptance carried that sketch through one clarification, explicit
dimensions and native CAD creation, then verified exact B-Rep bounds and Undo.
These synthetic checks do not establish arbitrary-photo reconstruction or
general design inference; see [design-reference acceptance](./design-reference-acceptance.md).
To verify several supplied images in one live Codex turn without touching CAD,
repeat `--image` two to four times with `npm run accept:design-reference-multiview`.
Image-derived observations include one-based `sourceImageIndices` into that
request's image list; invalid or out-of-range indexes are rejected. Live
acceptance verifies attribution across four distinct synthetic bracket views.
Regenerate those fixtures with `swift
scripts/fixtures/generate-design-reference-views.swift`; see
[design-reference acceptance](./design-reference-acceptance.md) for evidence
and the remaining limits of synthetic inputs.

Cylinders accept an arbitrary world-space axis and circles accept an arbitrary
plane normal. Circles and polylines can instead use a current construction-plane
identity and 2D coordinates. Closed curves generate revision-bound regions;
extruding an unambiguous profile or an explicit region creates a capped Solid.

## Workbench: модель, таблицы и планшет

Workbench объединяет проекты, интерактивный STEP-просмотрщик, валидируемые
таблицы размеров, аннотации стилусом и проверку подготовки к печати. Общение с
агентом остаётся в Codex; веб-интерфейс не содержит отдельного чата. Запуск в
локальной сети:

```sh
npm run start:workbench -- --lan
```

На Mac выполните `npm --workspace workbench run open:owner -- --lan`, чтобы открыть
владельческую сессию; напечатанный адрес сам по себе прав владельца не даёт.
В проекте нажмите **Поделиться**, перенесите
одноразовую ссылку на планшет и рисуйте поверх зафиксированной версии модели.
Аннотации отправляются агенту одним пакетом только после явной кнопки. Поля
размеров проверяют числовой тип, диапазон, шаг и целочисленные значения до
записи и повторно на сервере. Просмотрщик предоставляет изометрический,
фронтальный и верхний ракурсы, ортографические виды, Z-сечение, вписывание,
выбор, скрытие, изоляцию и прозрачность тел. Попавшая в модель стилусная
отметка сохраняет 3D-точку и, при наличии сопоставления, ID тела и грани.
Точный порядок запуска, MCP-регистрация и восстановление
описаны в [руководстве Workbench](./workbench-operations.md).

Workbench MCP публикует версии модели, точные B-Rep измерения, таблицы и статусы:

```sh
codex mcp add plasticity-workbench -- npm --prefix ./workbench run mcp
```

MCP сначала ищет уже работающий Workbench на loopback и локальных приватных
IPv4. Если сервис не найден, он запускает его сам с `--lan`. Через
`workbench_list_projects` и `workbench_create_project` агент подготавливает
проект и получает его отдельный `workspacePath` без текстового чата в браузере.

Для публикации файла агент сохраняет его внутри `workspacePath` проекта и
вызывает `workbench_upload_project_artifact` с относительным путём. Реальный
путь повторно проверяется после разрешения симлинков; выход за каталог проекта,
неподдерживаемое расширение, каталог вместо файла и размер свыше 250 MiB
отклоняются.

`workbench_register_reference` сохраняет источник, URL, SHA-256 загруженного
файла, лицензию, тип источника, роль в сцене и уверенность каждого размера.
Критичные неизвестные размеры выводятся отдельной таблицей. Сам Workbench не
скачивает произвольные URL: агент сначала проверяет источник, загружает файл как
артефакт и затем регистрирует его происхождение.

`plasticity_construction_history` читает локальную историю команд, а
`plasticity_construction_journal` дополнительно сравнивает живую сцену с
последним записанным событием и сообщает о неизвестном исходе или ручной
правке. История хранится в `.plasticity-mcp/construction-history`; для другого
пути задайте `PLASTICITY_CONSTRUCTION_HISTORY_ROOT`. Агент публикует контрольные
снимки через
`workbench_publish_construction_journal`; Workbench сохраняет их в SQLite с
ревизией проекта. Таким образом MCP сохраняет историю без Workbench; Workbench
привязывает опубликованные снимки к проектной ревизии. Снимки журнала содержат
компактные B-Rep bounds и топологические количества, а не полные face/edge
данные. Текущий журнал также отдаёт записи страницами (`offset`/`limit`) и
хранит только компактные изменения тел в памяти процесса. После перезапуска вызовите `plasticity_construction_history`, затем
подключитесь к явному окну и вызовите `plasticity_construction_journal`, чтобы
проверить `durableSyncStatus`. История — диагностическая, старые операции не
переигрываются и не отменяются автоматически. См. [construction history](./construction-history.md)
для статусов и восстановления. STEP-происхождение хранится отдельно в
`.plasticity-mcp/references`; его записи также являются историческими и не
служат текущими ссылками на тела после правок. Полученные STEP-файлы по умолчанию
остаются в `.plasticity-mcp/reference-artifacts`; путь настраивается через
`PLASTICITY_REFERENCE_ARTIFACT_ROOT`. См. [reference acquisition](./reference-acquisition.md)
для сетевых ограничений и происхождения загрузок.

При установленном Creality Print Workbench находит штатные профили K1C,
проверяет габариты детали, запускает CLI-нарезку в отдельном неизменяемом
каталоге и показывает G-code по слоям. Отправка на принтер возможна только после
подтверждения в браузере, привязанного к SHA-256 G-code, профилю, принтеру и
ревизии проекта, а также точному набору DFM-предупреждений и оценок. Любая
последующая правка аннулирует возможность отправки.
Для K1C 0.4 мм каталог Workbench публикует все найденные filament-профили,
совместимые с этой машиной, для штатного процесса 0.20 mm Standard, а не только
Generic PLA. На этом Mac живое чтение Creality Print обнаружило отдельные
профили Creality CR-PLA и Hyper PLA; это профили слайсера, а не подтверждение
свойств конкретной катушки или испытаний прочности.
Для штатного K1/K1C Workbench загружает один бинарный файл через тот же
`/upload/<filename>` endpoint, который использует установленный Creality Print,
а затем запускает точное ASCII-имя через Moonraker. На текущем K1C этот путь
проверен живой отправкой и состоянием `print_stats=printing`.
Если ответ принтера потерян, `workbench_reconcile_print_submission` сверяет
текущий `print_stats` и хранилище G-code. Он не загружает и не запускает файл:
точно отсутствующий файл можно отправить отдельной командой, а найденный без
подтверждённого запуска остаётся в состоянии `unknown`.
Найденный установленный профиль можно зарегистрировать через
`workbench_register_manufacturing_profile`, передав его `printer.id`,
`material.id` и `slicer.id` из каталога. Workbench разрешает профиль локально и
копирует три JSON-конфигурации в неизменяемый реестр с отдельными SHA-256; агенту
не нужно видеть локальные пути. Пользовательский или импортированный профиль
можно передать полным объектом через локальный MCP. Статусы `draft`, `imported`,
`official` и `user-verified` остаются различимы. Для DFM и нарезки используется
возвращённый `profileHash`.

Creality Print 7.2 CLI принимает STL, OBJ и AMF, но отклоняет STEP. На
Plasticity 26.1.3 + Creality Print 7.2.2.5483 для контрольного Solid 20 × 10 ×
5 мм живой маршрут `plasticity_export_stl` → Workbench slicing вернул 25 слоёв
и реальные границы траекторий 20 × 10 × 5 мм. Слайсерский `--datadir` и
профили изолированы внутри задания. Экспортированный Plasticity 3MF импортируется
для просмотра размеров, но в этой версии не даёт пригодного результата
`--slice`; поэтому для Creality Print выбирается STL. Редактируемым источником
остаётся `.plasticity` или STEP, а Workbench привязывает нарезку к SHA-256
производного STL. Допуск хорды и угловой допуск записываются в результат экспорта.

OrcaSlicer 2.4.2 также прошёл живой Workbench MCP acceptance на K1C: из
установленных machine/process/filament пресетов получен профиль Generic PLA,
20 × 10 × 5 мм STL дал 25 слоёв и job остался `ready`; принтер не подключался.
Для Orca Workbench читает модельный габарит из `EXCLUDE_OBJECT_DEFINE` metadata
в G-code и отдельно сохраняет меньший bbox траектории экструдера. Если G-code
даёт только приблизительные границы траектории, они не считаются доказательством,
что сама модель помещается на столе.

На Apple Silicon Workbench предпочитает
`/Applications/Creality Print (Apple Silicon).app`, если в нём найдены CLI и
штатные профили K1C; исходное `/Applications/Creality Print.app` не заменяется.
Для нестандартного расположения задайте `CREALITY_PRINT_EXECUTABLE` и
`CREALITY_PRINT_RESOURCES_ROOT` (путь к `Contents/Resources`) процессу
Workbench. Живой slicer acceptance запускается командой
`npm run accept:creality-print -- --input /path/to/model.stl --output /new/evidence --executable /path/to/CrealityPrint --resources-root /path/to/Contents/Resources`;
он не связывается с принтером и не начинает печать.
Полный stdio MCP-конвейер — создание проекта, загрузка STL, выбор профиля,
`workbench_slice_model`, чтение preview asset и отказ отправки до подтверждения —
проверяется командой `npm run accept:workbench-creality-mcp` с теми же аргументами.
Для комплектов из нескольких частей предусмотрен `workbench_slice_parts`: он
проверяет весь пакет STL до нарезки, создаёт отдельный G-code job на каждую
часть и сохраняет отдельное подтверждение перед отправкой каждого задания.
Живая batch-проверка на K1C запускается тем же acceptance с `--batch-parts 2`.
MCP также предоставляет `plasticity_export_3mf` для слайсеров, которые
принимают 3MF. Plasticity 26.1.3 всегда объявляет координаты такого файла в
метрах, поэтому адаптер задаёт проверенный масштаб `0.001` для исходной
миллиметровой модели, проверяет обязательные OPC-части архива и читает реальные
границы сетки обратно из `3D/3dmodel.model`. `.plasticity` или STEP остаётся
редактируемым источником; 3MF, как и STL, является производной сеткой.
Creality Print/K1C по-прежнему использует STL, поскольку его CLI не выдаёт
пригодный G-code из Plasticity 3MF.

`plasticity_export_obj` создаёт производную Wavefront-сетку выбранных Solid и
Sheet через нативный `OBJExportFactory`. Координаты записываются в миллиметрах
с осью Z вверх. Адаптер перечитывает сохранённый файл, проверяет индексы граней,
конечность координат и возвращает число объектов, вершин, нормалей, UV, граней,
треугольников и фактические bounds. Файл не перезаписывается, а экспорт не
меняет документ или историю Plasticity. Повторяемая живая проверка:

```sh
npm run accept:native-obj-export -- \
  --target TARGET_ID \
  --allow-disposable-mutations \
  --output /tmp/plasticity-mcp-output
```

Если габарит не помещается на стол, `workbench_assess_printability` сначала
проверяет шесть осевых ориентаций и диагональную раскладку с шагом 0,1°.
Для большой детали он возвращает расчётную сетку частей, смещения разрезов и
варианты соединений. Сам расчётный план CAD не изменяет. После выбора
ориентации и выравнивания детали вдоль мировых осей принтера агент передаёт
полезный объём профиля в `plasticity_split_solid_to_build_volume`: MCP читает
точные B-Rep bounds, вычисляет число равных сегментов и координаты плоскостей,
затем проверяет фактические bounds каждого результата. Для одного выбранного
плоского разреза MCP предоставляет
`plasticity_split_solid_by_plane`, а `plasticity_split_solid_by_planes` принимает
упорядоченный список плоскостей и последовательно режет только пересекаемые
ими текущие части. Оба инструмента строят временные поверхности по точным
B-Rep границам, требуют ровно два Solid на каждый нативный разрез, проверяют
сохранение точного общего объёма и удаляют временные резаки. Агент пока сам
выбирает и применяет ориентацию детали по DFM `splitPlan`; MCP пока не
оптимизирует швы под прочность, поддержки или сборку.
Соединение создаётся отдельной операцией и требует согласованного типа и
проверенного зазора. Получившиеся части нужно повторно проверить относительно
стола. Перед созданием задания Workbench независимо проверяет реальные границы
траекторий из G-code относительно объёма выбранного принтера.
После ориентации агент может повторно вызвать `workbench_assess_printability`
с `split.protectedZones`, указав источник, ось и точный интервал зоны в
ориентированных координатах. DFM помечает пересечение предложенных швов с
этими областями и проверяет полный явный набор альтернативных
`split.cutOffsetsMm` на размер каждого сегмента. Ссылки на расчёт и сами зоны
передаёт вызывающий агент; Workbench не проверяет актуальность расчёта и не
выводит структурную безопасность. Для применения смещённых плоскостей агент
передаёт их из ответа в `plasticity_split_solid_by_planes`; автоматическая
оптимизация расположения швов по прочности или поддержкам пока не выполняется.

Нативный сценарий можно повторить на явно выбранном пустом окне Plasticity:

```sh
npm run accept:native-solid-split -- --target TARGET_ID --allow-disposable-mutations --output /tmp/plasticity-mcp-output
```

Проверка создаёт временный куб 20 × 20 × 20 мм, делит его пополам и строит
шип-паз с тестовым зазором 0,25 мм. Затем она делит куб 40 × 20 × 20 мм двумя
плоскостями на четыре части. Оба сценария сверяют точные B-Rep bounds и объём,
проверяют нативную валидность частей, для шип-паза также проверяют отсутствие
объёмной коллизии, выполняют Undo/Redo и возвращают документ к исходному
пустому состоянию. Тестовый зазор подтверждает CAD-геометрию, но не заменяет
калибровку печати. Та же проверка отдельно моделирует пару «винт + термовставка»
по публичному MCP-рецепту и проверяет резьбу M5×0,8, измеренное зацепление,
валидность Solid, отсутствие пересечения и Undo/Redo. Размеры термовставки в
этом fixture синтетические и не подтверждают установку конкретного изделия.
Проверка откажется работать с непустым документом или уже существующим
каталогом evidence.

Сквозной маршрут двух частей с этим соединением и Creality Print/K1C проверяется
командой `npm run accept:workbench-creality-mcp -- --plasticity-target TARGET_ID
--split-native --split-joint screws-and-inserts --output NEW_DIRECTORY --executable
"/Applications/Creality Print (Apple Silicon).app/Contents/MacOS/CrealityPrint"
--resources-root "/Applications/Creality Print (Apple Silicon).app/Contents/Resources"`.
Это малый синтетический шовный fixture, не рекомендация для реального изделия;
оба задания остаются `ready`, а отправка без подтверждения блокируется.
