// Surfacing verify-and-refine helpers: exact point reads on curved bodies (plasticity_probe_surface),
// exact-bounds reasoning for NURBS bodies, and small pure helpers shared by the surfacing tools.
// Probe evidence: discovery/probes-2026-11-surfacing/FINDINGS.md (Plasticity 26.1.3).
import { nativeFunction } from "./native-function.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

export type Vector3 = [number, number, number];

export const PROBE_SURFACE_MAX_RAYS = 64;
/** The renderer's used heap is read after this many probed rays (the probe itself keeps nothing there)... */
export const PROBE_SURFACE_HEAP_CHECK_EVERY_RAYS = 512;
/** ...and the renderer is asked to collect its garbage when the heap has grown this much (MB) since the last collection. */
export const PROBE_SURFACE_COLLECT_ABOVE_MB = 20;
/** A Newton hit is accepted when the kernel's closest face point lies within this distance of the ray point. */
export const PROBE_SURFACE_ACCEPT_RESIDUAL_MM = 1e-6;
/** Two hits on one face closer than this along the ray are one hit. */
export const PROBE_SURFACE_MERGE_MM = 1e-6;
/** Hits on different faces closer than this along the ray are one crossing (a ray through an edge or vertex, where the two
 * faces' own intersection points can differ by the kernel's edge tolerance: 1e-4 mm seen live on a filleted B-spline seam). */
export const PROBE_SURFACE_EDGE_MERGE_MM = 1e-3;
/** A face that the ray passes closer than this without an accepted hit is reported in grazing. */
export const PROBE_SURFACE_GRAZE_MM = 1e-3;
/** Rays from gridMm start this far outside the body's conservative bounds. */
export const PROBE_SURFACE_GRID_CLEARANCE_MM = 1;

/**
 * Why a ray carries unresolvedCrossings (unresolvedCode, unresolvedCodes). Stable: other tools match on these, not on the text.
 * - parity: the crossings of the line with a closed Solid do not alternate entry and exit (or one cannot say which it is).
 * - kernel-error: a kernel read failed on a face for this ray.
 * - bracket-unresolved: the range read located a crossing that the nearest-point read did not confirm.
 * - search-limit: the search of a face did not settle within its budget.
 * - missed-crossing: a display-mesh seed found a crossing the distance search had missed.
 * - mesh-crossing: a display-mesh crossing that no exact hit explains (records of the older search).
 */
export const PROBE_SURFACE_UNRESOLVED_CODES = ["parity", "kernel-error", "bracket-unresolved", "search-limit", "missed-crossing", "mesh-crossing"] as const;
export type ProbeUnresolvedCode = (typeof PROBE_SURFACE_UNRESOLVED_CODES)[number];
/** The parity reason for an odd count from an origin outside the bounds box. Other tools matched this exact text before unresolvedCode existed: do not reword it. */
export const probeOddParityReason = (crossings: number) => `odd number of crossings (${crossings}) on a closed Solid from an outside origin: at least one crossing is missing or a tangent touch was counted`;

export interface ProbeRay { originMm: Vector3; direction: Vector3 }
export interface ProbeGrid { axis: "x" | "y" | "z"; at: Array<[number, number]> }
export interface ProbeSurfaceRequest { id: number; rays?: ProbeRay[]; gridMm?: ProbeGrid }

export interface ProbeIntersection {
  pointMm: Vector3;
  faceId: string;
  otherFaceIds?: string[];
  normal: Vector3;
  distanceMm: number;
  uCurvaturePerMm?: number;
  vCurvaturePerMm?: number;
  residualMm: number;
}

export interface ProbeRayResult {
  originMm: Vector3;
  direction: Vector3;
  atMm?: [number, number];
  hits: number;
  intersections: ProbeIntersection[];
  unresolvedCrossings?: number;
  unresolvedReason?: string;
  /** Machine-readable reason, present with unresolvedCrossings: "parity" only when the parity rule is the sole reason, else the first other code. */
  unresolvedCode?: ProbeUnresolvedCode;
  /** Every reason code of this ray, in the order of PROBE_SURFACE_UNRESOLVED_CODES. */
  unresolvedCodes?: ProbeUnresolvedCode[];
  /** Faces whose crossings for this ray are not settled (a kernel error, or a search that did not finish). */
  unresolvedFaceIds?: string[];
  grazing?: Array<{ faceId: string; minDistanceMm: number; atMm: Vector3 }>;
}

export interface ProbeSurfaceEvidence {
  id: number;
  bodyType: string;
  revision: string;
  source: "native-brep-ray-newton";
  acceptResidualMm: number;
  rays: ProbeRayResult[];
  note: string;
}

// Raw native output for one ray (metres, unit direction).
export interface NativeProbeHit {
  t: number;
  point: Vector3;
  faceId: string;
  normal: Vector3;
  uCurvature: number | null;
  vCurvature: number | null;
  residual: number;
}
export interface NativeProbeGraze { faceId: string; t: number; minDistance: number; point: Vector3 }
/** A crossing behind the ray origin (t < 0) on a closed Solid: used for the parity check only, never reported. */
export interface NativeProbeBehind { t: number; faceId: string; normal: Vector3 }
export interface NativeProbeRay {
  hits: NativeProbeHit[];
  unresolved: number;
  unresolvedFaces?: string[];
  grazing?: NativeProbeGraze[];
  /** Faces the search could not settle for this ray (a kernel error, or a search that did not finish). */
  problems?: Array<{ faceId: string; reason: string; code?: ProbeUnresolvedCode }>;
  /** Closed Solid only: every crossing of the same line behind the origin. Present (also when empty) when the whole line was searched. */
  behind?: NativeProbeBehind[];
}
/**
 * closedSolid: the body is a closed Solid, so the crossings along the whole line must alternate entry and exit, start
 * with an entry and end with an exit (checked from the crossings' own normals when the native record carries the
 * crossings behind the origin). originOutside: the origin is outside the conservative box; used only for a record
 * without `behind` (an odd count from outside is flagged).
 */
export interface ProbeRayContext { closedSolid: boolean; originOutside: boolean }
/** A crossing whose normal is this close to perpendicular to the ray cannot say entry or exit. */
export const PROBE_SURFACE_SENSE_COS = 1e-9;
/** The kernel's range read reports 0 for a point within its own resolution (1e-8 m, measured live) of a face; 1 % head room. */
export const PROBE_SURFACE_KERNEL_RESOLUTION_MM = 1.01e-5;
export interface NativeProbeResult { undoBefore: number; undoAfter: number; bodyCountBefore: number; bodyCountAfter: number; rays: NativeProbeRay[]; rangeReads?: number; rangePoints?: number }

const AXES = { x: 0, y: 1, z: 2 } as const;

function finiteVector(value: readonly number[], label: string): Vector3 {
  if (value.length !== 3 || !value.every(Number.isFinite)) throw new Error(`${label} must be three finite numbers`);
  return [value[0]!, value[1]!, value[2]!];
}

function unit(value: readonly number[], label: string): Vector3 {
  const v = finiteVector(value, label);
  const length = Math.hypot(...v);
  if (!(length > 1e-12)) throw new Error(`${label} must be a non-zero vector`);
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** Turn the request into explicit rays (mm, unit directions). Throws before any native call. */
export function resolveProbeRays(request: ProbeSurfaceRequest, body: RuntimeState["bodies"][number]): Array<ProbeRay & { atMm?: [number, number] }> {
  const hasRays = request.rays !== undefined, hasGrid = request.gridMm !== undefined;
  if (hasRays === hasGrid) throw new Error("Give exactly one of rays or gridMm");
  if (hasRays) {
    const rays = request.rays!;
    if (rays.length < 1 || rays.length > PROBE_SURFACE_MAX_RAYS) throw new Error(`rays must hold 1-${PROBE_SURFACE_MAX_RAYS} rays`);
    return rays.map((ray, index) => ({ originMm: finiteVector(ray.originMm, `rays[${index}].originMm`), direction: unit(ray.direction, `rays[${index}].direction`) }));
  }
  const grid = request.gridMm!;
  if (grid.at.length < 1 || grid.at.length > PROBE_SURFACE_MAX_RAYS) throw new Error(`gridMm.at must hold 1-${PROBE_SURFACE_MAX_RAYS} points`);
  if (!body.boundsMm) throw new Error(`Body ${body.id} has no bounds to place grid rays outside`);
  const axis = AXES[grid.axis];
  const [first, second] = [0, 1, 2].filter((index) => index !== axis) as [number, number];
  const start = body.boundsMm.max[axis]! + PROBE_SURFACE_GRID_CLEARANCE_MM;
  return grid.at.map((pair, index) => {
    if (pair.length !== 2 || !pair.every(Number.isFinite)) throw new Error(`gridMm.at[${index}] must be two finite numbers`);
    const origin: Vector3 = [0, 0, 0];
    origin[axis] = start; origin[first] = pair[0]!; origin[second] = pair[1]!;
    const direction: Vector3 = [0, 0, 0];
    direction[axis] = -1;
    return { originMm: origin, direction, atMm: [pair[0]!, pair[1]!] };
  });
}

const roundTo = (value: number, digits: number) => {
  const scale = 10 ** digits;
  const rounded = Math.round(value * scale) / scale;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const roundVector = (value: readonly number[], digits: number) => value.map((entry) => roundTo(entry, digits)) as Vector3;

/** Native metres to the reply's millimetres; merge crossings that coincide on several faces; check the parity of a closed Solid. */
export function projectProbeRay(ray: ProbeRay & { atMm?: [number, number] }, native: NativeProbeRay, context: ProbeRayContext = { closedSolid: false, originOutside: false }): ProbeRayResult {
  // Every crossing of the line, behind the origin too (distance < 0), in order. A crossing is one hit, or the hits of
  // several faces at one place (an edge or a vertex).
  type Member = { distanceMm: number; faceId: string; normal: Vector3; hit: NativeProbeHit | null };
  const members: Member[] = [
    ...(native.behind ?? []).map((entry) => ({ distanceMm: entry.t * 1000, faceId: entry.faceId, normal: entry.normal, hit: null })),
    ...native.hits.map((hit) => ({ distanceMm: hit.t * 1000, faceId: hit.faceId, normal: hit.normal, hit })),
  ].sort((a, b) => a.distanceMm - b.distanceMm);
  const senseOf = (member: Member) => { const c = member.normal[0] * ray.direction[0] + member.normal[1] * ray.direction[1] + member.normal[2] * ray.direction[2]; return Math.abs(c) < PROBE_SURFACE_SENSE_COS ? 0 : Math.sign(c); };
  // sense: -1 entry (normal against the ray), +1 exit, 0 ambiguous (tangent, or merged faces that disagree: an edge touch).
  const crossings: Array<{ members: Member[]; sense: number; first: number }> = [];
  for (const member of members) {
    const previous = crossings.at(-1);
    const gap = previous ? Math.abs(previous.first - member.distanceMm) : Infinity;
    const known = previous?.members.some((entry) => entry.faceId === member.faceId) ?? false;
    if (previous && (gap <= PROBE_SURFACE_MERGE_MM || (gap <= PROBE_SURFACE_EDGE_MERGE_MM && !known))) {
      if (previous.sense !== senseOf(member)) previous.sense = 0;
      previous.members.push(member);
      continue;
    }
    crossings.push({ members: [member], sense: senseOf(member), first: member.distanceMm });
  }
  const intersections: ProbeIntersection[] = [];
  for (const crossing of crossings) {
    const forward = crossing.members.filter((member) => member.hit !== null);
    if (forward.length === 0) continue;
    const hit = forward[0]!.hit!;
    const others = [...new Set(crossing.members.map((member) => member.faceId).filter((faceId) => faceId !== hit.faceId))];
    intersections.push({
      pointMm: roundVector(hit.point.map((value) => value * 1000), 9),
      faceId: hit.faceId,
      ...(others.length > 0 ? { otherFaceIds: others } : {}),
      normal: roundVector(hit.normal, 12),
      distanceMm: roundTo(hit.t * 1000, 9),
      ...(hit.uCurvature !== null && Number.isFinite(hit.uCurvature) ? { uCurvaturePerMm: roundTo(hit.uCurvature / 1000, 12) } : {}),
      ...(hit.vCurvature !== null && Number.isFinite(hit.vCurvature) ? { vCurvaturePerMm: roundTo(hit.vCurvature / 1000, 12) } : {}),
      residualMm: roundTo(hit.residual * 1000, 12),
    });
  }
  const grazing = (native.grazing ?? []).map((entry) => ({ faceId: entry.faceId, minDistanceMm: roundTo(entry.minDistance * 1000, 9), atMm: roundVector(entry.point.map((value) => value * 1000), 6) }));
  const reasons: string[] = [];
  const codes = new Set<ProbeUnresolvedCode>();
  let unresolved = native.unresolved;
  const faceIds = new Set<string>(native.unresolvedFaces ?? []);
  if (native.unresolved > 0) codes.add("mesh-crossing");
  // Parity first, so its text leads unresolvedReason.
  const oddFromOutside = context.closedSolid && context.originOutside && intersections.length % 2 === 1;
  if (context.closedSolid && native.behind !== undefined) {
    // The whole line through a closed Solid enters and leaves in turn, entry first and exit last, wherever the origin is.
    const word = (sense: number) => (sense < 0 ? "in" : sense > 0 ? "out" : "?");
    const pattern = `${crossings.filter((crossing) => crossing.members.every((member) => member.hit === null)).map((crossing) => word(crossing.sense)).join(" ") || "none"} | ${crossings.filter((crossing) => crossing.members.some((member) => member.hit !== null)).map((crossing) => word(crossing.sense)).join(" ") || "none"}`;
    const senses = crossings.map((crossing) => crossing.sense);
    const ambiguous = senses.some((value) => value === 0);
    if (ambiguous || senses.some((value, index) => value !== (index % 2 === 0 ? -1 : 1)) || senses.length % 2 === 1 || oddFromOutside) {
      unresolved += 1;
      codes.add("parity");
      // An odd count from outside the bounds box keeps the wording other tools matched before unresolvedCode existed.
      reasons.push(oddFromOutside ? probeOddParityReason(intersections.length)
        : ambiguous ? `parity ambiguous on a closed Solid: a crossing is tangent or an edge touch (behind the origin | ahead: ${pattern})`
          : `the crossings of this line with a closed Solid do not alternate entry and exit (behind the origin | ahead: ${pattern}): at least one crossing is missing, or a tangent touch was counted`);
    }
  } else if (oddFromOutside) {
    unresolved += 1;
    codes.add("parity");
    reasons.push(probeOddParityReason(intersections.length));
  }
  for (const problem of native.problems ?? []) {
    unresolved += 1;
    faceIds.add(problem.faceId);
    codes.add(problem.code !== undefined && (PROBE_SURFACE_UNRESOLVED_CODES as readonly string[]).includes(problem.code) ? problem.code : "kernel-error");
    reasons.push(`face ${problem.faceId} is not settled for this ray: ${problem.reason}`);
  }
  const ordered = PROBE_SURFACE_UNRESOLVED_CODES.filter((code) => codes.has(code));
  return {
    originMm: ray.originMm,
    direction: roundVector(ray.direction, 12),
    ...(ray.atMm ? { atMm: ray.atMm } : {}),
    hits: intersections.length,
    intersections,
    ...(unresolved > 0 ? { unresolvedCrossings: unresolved } : {}),
    ...(unresolved > 0 && reasons.length > 0 ? { unresolvedReason: reasons.join("; ") } : {}),
    // "parity" only when nothing else is unsettled; otherwise the first other code. A record of the older search
    // (display-mesh misses only, no reason text) keeps its shape.
    ...(unresolved > 0 && reasons.length > 0 ? { unresolvedCode: ordered.find((code) => code !== "parity" && code !== "mesh-crossing") ?? ordered[0]!, unresolvedCodes: ordered } : {}),
    ...(faceIds.size > 0 ? { unresolvedFaceIds: [...faceIds].sort() } : {}),
    ...(grazing.length > 0 ? { grazing } : {}),
  };
}

/** What the reply's rays mean; the tool description says the same in short. */
export const PROBE_SURFACE_NOTE = "Each point is a crossing of the ray with a face of the body. residualMm is the kernel's nearest-point distance from the reported point to that face (at most 0.000001 mm); the kernel's range read also puts the point on the trimmed face within its own resolution (0.00001 mm), so at a face edge a point can lie that far outside the body. Plane, cylinder, cone, sphere and torus faces get every crossing in closed form from the kernel's surface data (each surface model is checked on kernel surface points first; the solve does not depend on how far away the origin is). B-spline faces are searched with the kernel's distance from the ray to the trimmed face: two reads farther from the face than they are apart prove the ray stays clear between them, every other stretch is read at 1 mm or finer, a change of side is solved as its own crossing, and a closest approach between two reads is narrowed until it is clear, crosses, or grazes. The search assumes one closest approach between two reads 1 mm apart. Hits on two faces within 0.001 mm along the ray are one crossing (an edge; otherFaceIds). A ray is complete when it carries neither unresolvedCrossings nor grazing. grazing lists faces the ray passes within 0.001 mm of without a clean crossing: a tangent touch (never counted as a crossing), a ray that runs in a face or along a ruling, a pass within 0.001 mm of a face edge, and, on a B-spline face, a pair of crossings less than 0.001 mm deep (the two crossings are still returned). unresolvedCrossings counts what could not be settled, unresolvedReason says why and unresolvedFaceIds names the faces: a face the kernel could not evaluate for this ray (the other faces and rays are still answered), or a parity failure. Parity rule, closed Solid only: the crossings of the whole line (behind the origin too) must alternate entry and exit by their normals, starting with an entry and ending with an exit; otherwise at least one crossing is missing. normal is the face normal (outward on a Solid). Curvatures are the kernel's normal curvatures along the face's u and v directions, signed by the surface parametrisation; compare magnitudes.";

// Renderer source. Rays in metres with unit directions. Two kernel reads work together:
//  - the range read (Eval.DistancesToPoints on a face): the global distance from a point to the TRIMMED face, with the
//    nearest point and its face parameters. It never failed live, and it reads 0 within the kernel's resolution (1e-8 m).
//    All points of one round go to the kernel in one call.
//  - the nearest-point read (Face.FindPointNear): precise to 1e-15 m next to the face interior, but near a face boundary
//    it can throw or return a point millimetres from the nearest one (measured live on trimmed blend faces).
// So the range read decides WHERE the ray can meet a face, and the nearest-point read only polishes a crossing that the
// range read has bracketed; every reported point is then confirmed by the range read (it lies on the trimmed face within
// the kernel's resolution) and carries the nearest-point residual. The search per face:
//  - plane, cylinder, cone, sphere, torus: every root of the ray against the untrimmed surface in closed form (the ray
//    parameter is measured from the ray point nearest the face and scaled by the surface size, so the origin's distance
//    does not matter); a ray that runs in the surface is searched like a B-spline face.
//  - other faces: the distance is sampled along the ray inside the face's box. The distance changes by at most the step
//    along a unit ray, so two samples farther from the face than they are apart (plus the graze distance) prove that the
//    ray stays clear between them. The other intervals are refined to 1 mm; a change of side is a crossing (or a jump
//    past the face boundary), and a closest approach between two samples is narrowed until it is clear, crosses, or
//    comes within the kernel's resolution.
// The display mesh never supplies a value: its crossings are seeds, and a crossing only a seed finds is flagged.
export const PROBE_SURFACE_SOURCE = nativeFunction`function (pk_default, args) {
  const kernel = pk_default.a;
  const countBodies = () => { let count = 0; for (const [versionId] of nativeApi.geo.geometryModel) if (!nativeApi.geo.automatics?.has?.(versionId)) count += 1; return count; };
  const undoBefore = this.history.undoStack.length, bodyCountBefore = countBodies();
  const matches = [];
  for (const [versionId, candidate] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(versionId) === args.bodyId) matches.push(candidate);
  if (matches.length !== 1 || !['Solid', 'Sheet'].includes(matches[0]?.view?.constructor?.name)) throw new Error('Unknown current Solid or Sheet body ID: ' + args.bodyId);
  const item = matches[0];
  const group = item.view.high.faces;
  const geometry = group.mesh?.geometry;
  const positions = geometry?.attributes?.position?.array;
  if (!positions) throw new Error('The body has no display mesh to seed the probe');
  const indices = geometry.index ? geometry.index.array : null;
  const m = group.mesh.matrixWorld.elements;
  const vertex = i => { const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]; };
  const evaluator = kernel.Eval && kernel.Context?.Get ? new kernel.Eval(kernel.Context.Get()) : null;
  if (typeof evaluator?.DistancesToPoints !== 'function') throw new Error('This Plasticity build has no kernel range read (Eval.DistancesToPoints); the surface probe needs it');
  // A face is searched only when a ray can reach it: its display-mesh box (fg.bboxes, 6 floats per face), widened by the
  // mesh's chord error, must meet the ray. Every kernel object made here is local to this call.
  const boxes = group.bboxes;
  const faces = [];
  for (let index = 0; index < group.versionIds.length; index += 1) {
    const min = [boxes[6 * index], boxes[6 * index + 1], boxes[6 * index + 2]], max = [boxes[6 * index + 3], boxes[6 * index + 4], boxes[6 * index + 5]];
    const pad = args.boxMarginM + 0.02 * Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    faces.push({ id: String(group.versionIds[index]), entityId: Number(group.get(index).entityId), start: group.groups[2 * index], count: group.groups[2 * index + 1],
      min: min.map(v => v - pad), max: max.map(v => v + pad), kernel: null,
      centreMm: [0, 1, 2].map(i => (min[i] + max[i]) * 500), halfDiagMm: 500 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) });
  }
  const kernelFace = entry => {
    if (entry.kernel) return entry.kernel;
    const collection = nativeApi.db.lookupFaceCollection([entry.id]);
    const face = collection?.Size?.() === 1 ? collection.Get(0) : null;
    if (!face || Number(face.Id()) !== entry.entityId) throw new Error('Display face ' + entry.id + ' has no kernel face');
    entry.kernel = face;
    return face;
  };
  // The part of the line inside the face's padded box, as [tEnter, tExit] in metres from tLow on, or null.
  const segment = (entry, o, d, tLow) => {
    let low = tLow, high = args.farM;
    for (let axis = 0; axis < 3; axis += 1) {
      if (Math.abs(d[axis]) < 1e-15) { if (o[axis] < entry.min[axis] || o[axis] > entry.max[axis]) return null; continue; }
      let t1 = (entry.min[axis] - o[axis]) / d[axis], t2 = (entry.max[axis] - o[axis]) / d[axis];
      if (t1 > t2) [t1, t2] = [t2, t1];
      low = Math.max(low, t1); high = Math.min(high, t2);
      if (low > high) return null;
    }
    return [low, high];
  };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => Math.hypot(a[0], a[1], a[2]);
  const K = p => new kernel.Vector(p[0], p[1], p[2]);
  const read = v => [Number(v.x), Number(v.y), Number(v.z)];
  const mm = p => [p[0] * 1000, p[1] * 1000, p[2] * 1000];
  const at = (o, d, t) => [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]];
  const text = error => String(error?.message || error?.constructor?.name || error).slice(0, 160);
  // ---- polynomials, coefficients in ascending order ----
  const padd = (a, b) => Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] ?? 0) + (b[i] ?? 0));
  const pmul = (a, b) => { const r = new Array(a.length + b.length - 1).fill(0); a.forEach((x, i) => b.forEach((y, j) => { r[i + j] += x * y; })); return r; };
  const pscale = (a, s) => a.map(x => x * s);
  const pval = (c, t) => { let v = 0; for (let i = c.length - 1; i >= 0; i -= 1) v = v * t + c[i]; return v; };
  const pder = c => c.slice(1).map((x, i) => x * (i + 1));
  // The solve is conditioned (see scaledPoly: every coefficient of a real crossing is of order one), so a leading
  // coefficient below 1e-13, or below 1e-14 of the largest, is round-off.
  const ptrim = c => { const big = Math.max(...c.map(Math.abs)); const r = [...c]; while (r.length > 1 && (Math.abs(r[r.length - 1]) <= 1e-14 * big || Math.abs(r[r.length - 1]) <= 1e-13)) r.pop(); return r; };
  // Every real root in [lo, hi]: the derivative's roots split the interval into monotone pieces, each bisected to the last
  // bit. Interior critical points are closest approaches for the grazing test. A polynomial that reduces to a constant
  // (the ray parallel to a plane, or along a ruling) returns that constant.
  const solve = (coefficients, lo, hi) => {
    const c = ptrim(coefficients), n = c.length - 1;
    if (n <= 0) return { roots: [], critical: [], touches: [], constant: c[0] ?? 0 };
    if (n === 1) { const t = -c[0] / c[1]; return { roots: t >= lo && t <= hi ? [t] : [], critical: [], touches: [], constant: null }; }
    const critical = solve(pder(c), lo, hi).roots.sort((a, b) => a - b);
    const knots = [lo, ...critical, hi], roots = [];
    for (let k = 0; k + 1 < knots.length; k += 1) {
      let a = knots[k], b = knots[k + 1], fa = pval(c, a), fb = pval(c, b);
      if (fa === 0) { if (!roots.length || Math.abs(roots[roots.length - 1] - a) > 1e-12) roots.push(a); continue; }
      if (fa * fb > 0) continue;
      for (let it = 0; it < 200 && b - a > 1e-13 * Math.max(1, Math.abs(a)); it += 1) { const mid = (a + b) / 2, fm = pval(c, mid); if (fa * fm <= 0) { b = mid; } else { a = mid; fa = fm; } }
      roots.push((a + b) / 2);
    }
    // A root on a critical point where the sign does not change is a double root: a tangent touch, not a crossing.
    const touches = [], simple = [];
    for (const r of roots) {
      const onCritical = critical.some(x => Math.abs(x - r) <= 1e-9 * Math.max(1, Math.abs(r)));
      const delta = 1e-7 * Math.max(1, Math.abs(r));
      if (onCritical && pval(c, r - delta) * pval(c, r + delta) > 0) touches.push(r); else simple.push(r);
    }
    return { roots: simple, critical, touches, constant: null };
  };
  // ---- analytic surface models from the kernel's own surface data, verified on kernel surface points ----
  // The distance (mm) from points to the untrimmed analytic surface.
  const residualOf = (model, pts) => Math.max(...pts.map(p => {
    const w = sub(p, model.L);
    if (model.kind === 'Plane') return Math.abs(dot(w, model.A));
    if (model.kind === 'Sphere') return Math.abs(norm(w) - model.r);
    const h = dot(w, model.A), rho = Math.sqrt(Math.max(0, dot(w, w) - h * h));
    if (model.kind === 'Cylinder') return Math.abs(rho - model.r);
    if (model.kind === 'Cone') return Math.abs(rho - Math.abs(model.r + h * model.tan)) / Math.sqrt(1 + model.tan * model.tan);
    return Math.abs(Math.hypot(rho - model.R, h) - model.r);
  }));
  const modelOf = entry => {
    if (entry.model !== undefined) return entry.model;
    entry.model = null;
    try {
      const fs = kernelFace(entry).GetSurface(), S = fs.surface, kind = S.constructor.name;
      const grid = [];
      for (const fu of [0.17, 0.5, 0.83]) for (const fv of [0.17, 0.5, 0.83]) grid.push([fs.uMin + fu * (fs.uMax - fs.uMin), fs.vMin + fv * (fs.vMax - fs.vMin)]);
      const pts = grid.map(([u, v]) => mm(read(S.GetPoint(u, v))));
      let model = null;
      if (kind === 'Plane') { const b = S.GetInfo(); model = { kind, L: mm(read(b.Location)), A: read(b.Axis) }; }
      else if (kind === 'Sphere') { const i = S.GetInfo(); model = { kind, L: mm(read(i.basis.Location)), r: i.radius * 1000 }; }
      else if (kind === 'Cylinder') { const i = S.GetInfo(); model = { kind, L: mm(read(i.basis.Location)), A: read(i.basis.Axis), r: i.radius * 1000 }; }
      else if (kind === 'Cone') { const i = S.GetInfo(); model = { kind, L: mm(read(i.basis.Location)), A: read(i.basis.Axis), r: i.radius * 1000, tan: Math.tan(i.semiAngle) }; }
      else if (kind === 'Torus') {
        // No GetInfo on 26.1.3: the minor radius is the principal curvature that is the same everywhere, the spine circle
        // runs through p - r n, and three spine points give its centre, axis and the major radius.
        const curv = grid.map(([u, v]) => S.EvalCurvature(u, v));
        const minorOf = key => { const ks = curv.map(k => Math.abs(Number(k[key]))); return ks.every(k => k > 0 && Math.abs(k - ks[0]) <= 1e-9 * ks[0]) ? 1000 / ks[0] : null; };
        const r = minorOf('curvature1') ?? minorOf('curvature2');
        if (r !== null) for (const sign of [1, -1]) for (const pick of [[1, 4, 7], [3, 4, 5]]) {
          const spine = pick.map(i => sub(pts[i], mul(read(curv[i].normal), sign * r)));
          const ab = sub(spine[1], spine[0]), ac = sub(spine[2], spine[0]), n = cross(ab, ac), nn = dot(n, n);
          if (!(nn > 1e-12)) continue;
          const C = add(spine[0], mul(add(mul(cross(n, ab), dot(ac, ac)), mul(cross(ac, n), dot(ab, ab))), 1 / (2 * nn)));
          const candidate = { kind, L: C, A: mul(n, 1 / Math.sqrt(nn)), R: norm(sub(spine[0], C)), r };
          if (residualOf(candidate, pts) <= args.modelToleranceMm) { model = candidate; break; }
        }
        if (model) { entry.model = model; return model; }
      }
      if (model && residualOf(model, pts) <= args.modelToleranceMm) entry.model = model;
    } catch (error) { entry.model = null; }
    return entry.model;
  };
  // The surface equation along base + s d (unit d), in units of the surface's size, with the model's reference point moved
  // next to base: every coefficient is of order one, whatever the distance from the caller's origin to the face.
  const polyOf = (model, w, d) => {
    const q = [dot(w, w), 2 * dot(w, d), 1];
    if (model.kind === 'Plane') return [dot(w, model.A), dot(d, model.A)];
    if (model.kind === 'Sphere') return padd(q, [-model.r * model.r]);
    const H = [dot(w, model.A), dot(d, model.A)];
    if (model.kind === 'Cylinder') return padd(padd(q, pscale(pmul(H, H), -1)), [-model.r * model.r]);
    if (model.kind === 'Cone') { const g = [model.r + model.tan * H[0], model.tan * H[1]]; return padd(padd(q, pscale(pmul(H, H), -1)), pscale(pmul(g, g), -1)); }
    const G = padd(q, [model.R * model.R - model.r * model.r]);
    return padd(pmul(G, G), pscale(padd(q, pscale(pmul(H, H), -1)), -4 * model.R * model.R));
  };
  const scaleOf = (entry, model) => Math.max(1e-3, entry.halfDiagMm, model.kind === 'Torus' ? model.R + model.r : model.kind === 'Plane' ? 0 : Math.abs(model.r));
  const scaledPoly = (model, base, d, scale) => {
    let L = model.L, r = model.r;
    if (model.kind === 'Cylinder' || model.kind === 'Cone') { const h = dot(sub(base, model.L), model.A); L = add(model.L, mul(model.A, h)); if (model.kind === 'Cone') r = model.r + model.tan * h; }
    else if (model.kind === 'Plane') L = sub(base, mul(model.A, dot(sub(base, model.L), model.A)));
    return polyOf({ ...model, r: (r ?? 0) / scale, R: (model.R ?? 0) / scale }, mul(sub(base, L), 1 / scale), d);
  };
  // ---- the nearest-point read: precise beside the face interior; it can throw, or be far off, near a face boundary ----
  const fpn = (entry, o, d, t) => {
    const face = kernelFace(entry), p = at(o, d, t), near = face.FindPointNear(K(p)), r = sub(p, read(near.exact)), basis = face.EvalBasis(near.u, near.v), n = read(basis.normal);
    const D = norm(r), rn = dot(r, n);
    return { t, p, D, rn, nd: dot(n, d), f: (rn < 0 ? -1 : 1) * D, n, basis };
  };
  const hitOf = (entry, e) => ({ t: e.t, point: e.p, faceId: entry.id, normal: e.n,
    uCurvature: Number.isFinite(Number(e.basis.uCurvature)) ? Number(e.basis.uCurvature) : null,
    vCurvature: Number.isFinite(Number(e.basis.vCurvature)) ? Number(e.basis.vCurvature) : null, residual: e.D });
  // A nearest-point read as a hit, when its residual is within acceptResidualM. A point just behind the origin is
  // reported at t = 0, with the residual of that reported point.
  const hitFrom = (entry, o, d, e) => {
    if (e.t < 0 && e.t >= -args.acceptResidualM) e = fpn(entry, o, d, 0);
    return e.D <= args.acceptResidualM ? hitOf(entry, e) : null;
  };
  // Newton steps along the ray onto the face, kept inside [tMin, tMax]. The result is the read with the smallest
  // residual, when that residual is at the round-off floor (convergedM, or a few bits of the coordinates far from the
  // world origin). A closed-form start (exactStart) that does not settle is tried as it is.
  const polishAt = (entry, o, d, t0, tMin, tMax, exactStart) => {
    const start = fpn(entry, o, d, t0);
    let e = start, best = start;
    for (let step = 0; step < args.maxSteps && e.D > args.convergedM && Math.abs(e.nd) >= 1e-9; step += 1) {
      const t = e.t - e.rn / e.nd;
      if (!(t >= tMin && t <= tMax) || t === e.t) break;
      e = fpn(entry, o, d, t);
      if (e.D < best.D) best = e; else if (step >= 3) break;
    }
    if (best.D <= Math.max(args.convergedM, 3e-14 * Math.max(Math.abs(best.p[0]), Math.abs(best.p[1]), Math.abs(best.p[2])))) return hitFrom(entry, o, d, best);
    return exactStart ? hitFrom(entry, o, d, start) : null;
  };
  // The root of the nearest-point signed distance between two reads of opposite sign (Illinois regula falsi, every third
  // step a bisection): it never leaves the bracket, so two roots never collapse into one.
  const bracketFpn = (entry, o, d, a, b) => {
    let A = a, B = b, wA = a.f, wB = b.f, last = 0;
    for (let it = 0; it < 100; it += 1) {
      if (B.t - A.t <= Math.max(args.bracketM, 4e-16 * Math.abs(B.t))) break;
      let t = it % 3 === 2 ? (A.t + B.t) / 2 : (A.t * wB - B.t * wA) / (wB - wA);
      if (!(t > A.t && t < B.t)) t = (A.t + B.t) / 2;
      const e = fpn(entry, o, d, t);
      if (e.D <= args.convergedM) return e;
      if (e.f * A.f > 0) { A = e; wA = e.f; if (last === -1) wB /= 2; last = -1; } else { B = e; wB = e.f; if (last === 1) wA /= 2; last = 1; }
    }
    return A.D <= B.D ? A : B;
  };
  // ---- the work list: range reads are asked for, read in one kernel call per round, then the waiting steps run ----
  let pending = [], wave = [], rounds = 0, rangeReads = 0, rangePoints = 0;
  const fail = (job, reason, code) => { if (job.failed) return; job.failed = true; job.R.problems.push({ faceId: job.entry.id, reason, code }); };
  const guard = (job, fn) => () => { if (job.failed) return; try { fn(); } catch (error) { if (error?.probe) fail(job, error.message, error.probe); else fail(job, 'kernel error (' + text(error) + ')', 'kernel-error'); } };
  const later = (job, fn) => { wave.push({ job, fn: guard(job, fn) }); };
  const stop = (message, code) => { const error = new Error(message); error.probe = code; return error; };
  const ask = (job, t) => {
    if ((job.asked += 1) > args.maxReads) throw stop('the search did not settle in ' + args.maxReads + ' range reads', 'search-limit');
    const s = { job, t, p: at(job.R.o, job.R.d, t), D: NaN, q: null, u: 0, v: 0, failed: null, side: undefined };
    pending.push(s);
    return s;
  };
  const flush = () => {
    if (!pending.length) return;
    const byFace = new Map();
    for (const s of pending) { const list = byFace.get(s.job.entry); if (list) list.push(s); else byFace.set(s.job.entry, [s]); }
    pending = [];
    const run = groups => {
      const total = groups.reduce((n, g) => n + g[1].length, 0);
      const ids = new Int32Array(groups.length), offsets = new Int32Array(groups.length + 1), xyz = new Float64Array(3 * total);
      let k = 0;
      groups.forEach(([entry, list], i) => { ids[i] = entry.entityId; offsets[i] = k; for (const s of list) { xyz[3 * k] = s.p[0]; xyz[3 * k + 1] = s.p[1]; xyz[3 * k + 2] = s.p[2]; k += 1; } });
      offsets[groups.length] = k;
      rangeReads += 1; rangePoints += total;
      const result = evaluator.DistancesToPoints(ids, xyz, offsets);
      k = 0;
      for (const [, list] of groups) for (const s of list) {
        const code = Number(result.errors?.[k] ?? 0), D = Number(result.distances?.[k]);
        s.q = [Number(result.nearests?.[3 * k]), Number(result.nearests?.[3 * k + 1]), Number(result.nearests?.[3 * k + 2])];
        s.u = Number(result.params?.[2 * k]); s.v = Number(result.params?.[2 * k + 1]);
        if (code !== 0) s.failed = 'the kernel range read failed (code ' + code + ')';
        else if (!(D >= 0) || !s.q.every(Number.isFinite)) s.failed = 'the kernel range read returned no distance';
        else s.D = D;
        k += 1;
      }
    };
    const groups = [...byFace];
    // One face can fail a whole read: read face by face then, and only the faces that still fail are marked (review P3).
    try { run(groups); } catch (error) { for (const g of groups) { try { run([g]); } catch (inner) { for (const s of g[1]) s.failed = 'the kernel range read failed (' + text(inner) + ')'; } } }
  };
  // Each pass (the search, the display-mesh seeds, the pair check) has its own budget of rounds.
  const drain = () => {
    rounds = 0;
    while (pending.length || wave.length) {
      if ((rounds += 1) > args.maxRounds) { for (const task of wave) fail(task.job, 'the search did not settle in ' + args.maxRounds + ' rounds', 'search-limit'); wave = []; pending = []; return; }
      flush();
      const run = wave; wave = [];
      for (const task of run) task.fn();
    }
  };
  const usable = s => { if (s.failed) throw stop(s.failed, 'kernel-error'); return s; };
  // Which side of the face the ray point is on: +1 on the normal's side, -1 behind it, 0 on the face (within the
  // kernel's resolution) or exactly in its tangent plane.
  const sideOf = s => {
    if (s.side !== undefined) return s.side;
    if (s.D <= args.contactM) return (s.side = 0);
    return (s.side = Math.sign(dot(sub(s.p, s.q), read(kernelFace(s.job.entry).EvalBasis(s.u, s.v).normal))));
  };
  // d(distance)/dt along the ray, for a point off the face.
  const slopeOf = s => dot(sub(s.p, s.q), s.job.R.d) / s.D;
  const inner = (a, b, parts) => Array.from({ length: parts - 1 }, (_, i) => a + (b - a) * (i + 1) / parts);
  const graze = (job, t, distance, keep) => { job.R.grazing.push({ faceId: job.entry.id, t, minDistance: distance, point: at(job.R.o, job.R.d, t), keep: Boolean(keep) }); };
  // A point where the ray runs along the surface (|n.d| below touchCos) is a tangent touch: reported in grazing, never
  // as a crossing. Returns 'new', 'merged' (a hit on this face within mergeM) or 'touch'.
  const accept = (job, hit) => {
    if (Math.abs(dot(hit.normal, job.R.d)) < args.touchCos) { graze(job, hit.t, hit.residual, true); return 'touch'; }
    if (job.R.hits.some(h => h.faceId === hit.faceId && Math.abs(h.t - hit.t) <= args.mergeM)) return 'merged';
    job.R.hits.push(hit);
    return 'new';
  };
  // A polished point is a crossing only when the range read puts it on the trimmed face. done(result) gets 'new', 'merged',
  // 'touch' or 'off'.
  const candidate = (job, hit, done) => {
    const v = ask(job, hit.t);
    later(job, () => { const result = usable(v).D <= args.contactM ? accept(job, hit) : 'off'; if (done) done(result, v); });
  };
  // ---- faces without a closed form (and rays that run in an analytic surface): the sampled search ----
  // A stretch of range reads at 0 (the ray on the face within the kernel's resolution): a crossing a sample fell on, a
  // tangent touch, a close pair less than the resolution deep, or a ray that runs in the face. left and right are the
  // nearest reads off the face (null at the ends of the span).
  const zone = (job, left, right, contacts, depth) => {
    const first = contacts[0], last = contacts[contacts.length - 1], run = last.t - first.t > args.zoneM;
    const w0 = left ? left.t : first.t, w1 = right ? right.t : last.t;
    if (!run && w1 - w0 > args.zoneM && depth < args.maxDepth) {
      const before = left ? inner(left.t, first.t, args.fan).map(t => ask(job, t)) : [], after = right ? inner(last.t, right.t, args.fan).map(t => ask(job, t)) : [];
      later(job, () => scan(job, [...(left ? [left] : []), ...before, ...contacts, ...after, ...(right ? [right] : [])], depth + 1));
      return;
    }
    // The nearest-point read is precise here: its signed distance gives the crossings. A short stretch is read at nine
    // points; a long one (the ray runs in the face) at the range reads themselves.
    const { entry, R } = job, o = R.o, d = R.d;
    const ts = run ? [...(left ? [left.t] : []), ...contacts.map(s => s.t), ...(right ? [right.t] : [])] : w1 > w0 ? Array.from({ length: 9 }, (_, i) => w0 + (w1 - w0) * i / 8) : [w0];
    const F = ts.map(t => fpn(entry, o, d, t)), n = F.length - 1;
    const found = [];
    const root = (a, b) => { const e = bracketFpn(entry, o, d, a, b); if (e.D <= args.acceptResidualM) found.push(e); };
    let low = F[0];
    for (let i = 0; i <= n; i += 1) {
      if (F[i].D < low.D) low = F[i];
      if (F[i].D <= args.convergedM) { found.push(F[i]); continue; }
      if (i < n && F[i + 1].D > args.convergedM && F[i].f * F[i + 1].f < 0) root(F[i], F[i + 1]);
    }
    for (let i = 0; i <= n; i += 1) {
      // A closest approach between reads on one side: narrow it; where it dips through the face there are two crossings.
      if (F[i].D <= args.convergedM) continue;
      const s = Math.sign(F[i].f), a = i > 0 ? F[i - 1] : null, b = i < n ? F[i + 1] : null;
      if ((!a && !b) || (a && !(a.f * s > 0 && a.D >= F[i].D)) || (b && !(b.f * s > 0 && b.D >= F[i].D))) continue;
      let x0 = (a ?? F[i]).t, x3 = (b ?? F[i]).t, x1 = x0 + (x3 - x0) * 0.381966, x2 = x0 + (x3 - x0) * 0.618034, e1 = fpn(entry, o, d, x1), e2 = fpn(entry, o, d, x2);
      for (let it = 0; it < 36 && e1.f * s > 0 && e2.f * s > 0; it += 1) {
        if (e1.f * s < e2.f * s) { x3 = x2; x2 = x1; e2 = e1; x1 = x0 + (x3 - x0) * 0.381966; e1 = fpn(entry, o, d, x1); }
        else { x0 = x1; x1 = x2; e1 = e2; x2 = x0 + (x3 - x0) * 0.618034; e2 = fpn(entry, o, d, x2); }
      }
      const dip = e1.f * s <= e2.f * s ? e1 : e2;
      if (dip.D < low.D && dip.f * s > 0) low = dip;
      if (dip.f * s < 0) { root(a ?? F[i], dip); root(dip, b ?? F[i]); }
    }
    // One crossing where the read changes side once across a short window, away from tangency, is clean; anything else grazes.
    const clean = !run && n > 0 && found.length === 1 && F[0].f * F[n].f < 0 && F[0].D > args.convergedM && F[n].D > args.convergedM && Math.abs(found[0].nd) >= args.cleanCos;
    if (!clean) graze(job, run ? first.t : found.length ? found[0].t : low.t, run ? 0 : found.length ? found[0].D : low.D, true);
    for (const e of found) { const hit = Math.abs(e.nd) >= args.touchCos ? hitFrom(entry, o, d, e) : null; if (hit) candidate(job, hit); }
  };
  const nearEnd = (job, a, b) => { const s = a.D <= b.D ? a : b; if (s.D < args.grazeM) graze(job, s.t, s.D, false); };
  const split = (job, a, b, parts, depth, parentSide) => {
    const mids = inner(a.t, b.t, parts).map(t => ask(job, t));
    later(job, () => {
      if (parentSide !== undefined) {
        // A closest approach that dips through the face: a pair of crossings. Less than grazeM deep it is a tangent pair.
        let deep = null;
        for (const s of mids) if (!s.failed && s.D > args.contactM && sideOf(s) !== parentSide && (!deep || s.D > deep.D)) deep = s;
        if (deep && deep.D < args.grazeM) graze(job, deep.t, deep.D, true);
      }
      scan(job, [a, ...mids, b], depth + 1);
    });
  };
  // A change of side between two reads off the face: a crossing, or a jump past the face boundary.
  const bracket = (job, a, b, depth) => {
    const h = b.t - a.t, { entry, R } = job;
    const narrow = extra => {
      if (h <= args.minM || depth >= args.maxDepth) {
        if (a.D + b.D > h + args.contactM) { nearEnd(job, a, b); return; }
        throw stop('a crossing near ' + (a.t * 1000).toFixed(6) + ' mm along the ray was located by the range read, but the nearest-point read did not confirm it', 'bracket-unresolved');
      }
      if (extra && !extra.failed && extra.t > a.t && extra.t < b.t) { later(job, () => scan(job, [a, extra, b], depth + 1)); return; }
      split(job, a, b, args.fan, depth);
    };
    // The distance cannot reach zero between them: a jump. It is narrowed only to see whether the ray grazes the boundary.
    if (a.D + b.D > h + args.contactM) { narrow(null); return; }
    let hit = null;
    try {
      const fa = sideOf(a) * a.D, fb = sideOf(b) * b.D, t0 = fa !== fb ? (a.t * fb - b.t * fa) / (fb - fa) : (a.t + b.t) / 2;
      hit = polishAt(entry, R.o, R.d, t0 > a.t && t0 < b.t ? t0 : (a.t + b.t) / 2, a.t, b.t);
      if (!hit) { const ea = fpn(entry, R.o, R.d, a.t), eb = fpn(entry, R.o, R.d, b.t); if (ea.f * eb.f < 0) hit = hitFrom(entry, R.o, R.d, bracketFpn(entry, R.o, R.d, ea, eb)); }
    } catch (error) { hit = null; }
    if (!hit || !(hit.t >= a.t && hit.t <= b.t)) { narrow(null); return; }
    candidate(job, hit, (result, v) => { if (result === 'off') narrow(v); });
  };
  const interval = (job, a, b, depth) => {
    const h = b.t - a.t;
    // The distance changes by at most the step along a unit ray: these two reads prove the ray stays more than grazeM away.
    if (a.D + b.D - h > 2 * args.grazeM) return;
    if (h > args.stepM * 1.0001) { split(job, a, b, Math.min(args.fan, Math.ceil(h / args.stepM)), depth); return; }
    const side = sideOf(a);
    if (side !== sideOf(b)) { bracket(job, a, b, depth); return; }
    if (slopeOf(a) < -args.slopeEps && slopeOf(b) > args.slopeEps && h > args.minM && depth < args.maxDepth) { split(job, a, b, args.fan, depth, side); return; }
    nearEnd(job, a, b);
  };
  const scan = (job, list, depth) => {
    for (const s of list) usable(s);
    const on = s => s.D <= args.contactM;
    for (let i = 0; i < list.length; ) {
      if (on(list[i])) {
        let j = i;
        while (j + 1 < list.length && on(list[j + 1])) j += 1;
        zone(job, i > 0 ? list[i - 1] : null, j + 1 < list.length ? list[j + 1] : null, list.slice(i, j + 1), depth);
        i = j + 1;
      } else {
        if (i + 1 < list.length && !on(list[i + 1])) interval(job, list[i], list[i + 1], depth);
        i += 1;
      }
    }
  };
  const sampled = (job, lo, hi) => {
    job.sampled = true;
    if (!(hi > lo)) return;
    const parts = Math.max(1, Math.min(args.maxInitial, Math.ceil((hi - lo) / args.coarseM)));
    const list = Array.from({ length: parts + 1 }, (_, i) => ask(job, lo + (hi - lo) * i / parts));
    later(job, () => scan(job, list, 0));
  };
  // Closed form: every root of the ray against the untrimmed analytic surface, then the trimmed-face test. The ray
  // parameter is s = (t - t0) / scale, t0 the ray point nearest the face's box centre (review P2).
  const analytic = (job, model, lo, hi) => {
    const { entry, R } = job, o = R.o, d = R.d;
    const om = mm(o), scale = scaleOf(entry, model), t0 = dot(sub(entry.centreMm, om), d), base = add(om, mul(d, t0));
    const T = s => (t0 + s * scale) / 1000;
    const near = t => residualOf(model, [mm(at(o, d, t))]) < args.grazeM * 1000;
    const { roots, critical, touches, constant } = solve(scaledPoly(model, base, d, scale), (lo * 1000 - t0) / scale, (hi * 1000 - t0) / scale);
    // The ray runs in the surface (in a plane, along a ruling), or parallel to it within grazeM: no usable equation, so
    // the face is searched by distance (review P4).
    if (constant !== null || (near(lo) && near((lo + hi) / 2) && near(hi))) { if (near(lo) || near((lo + hi) / 2) || near(hi)) sampled(job, lo, hi); return; }
    const state = roots.map(() => 'off');
    roots.forEach((s, i) => {
      const tMin = i > 0 ? T((roots[i - 1] + s) / 2) : -Infinity, tMax = i + 1 < roots.length ? T((s + roots[i + 1]) / 2) : Infinity;
      let hit = null, error = null;
      try { hit = polishAt(entry, o, d, T(s), tMin, tMax, true); } catch (thrown) { error = thrown; }
      // The range read at the closed-form crossing says whether the trimmed face is crossed there; the polished point is
      // confirmed on its own when the polish moved it.
      const v = ask(job, T(s)), confirm = hit && Math.abs(hit.t - T(s)) > 1e-12 ? ask(job, hit.t) : v;
      later(job, () => {
        usable(v);
        if (hit && usable(confirm).D <= args.contactM) { state[i] = accept(job, hit); return; }
        // The untrimmed surface is crossed here. Off the trimmed face it is no crossing; within grazeM of the face it grazes
        // it. On the face (by the range read) without a nearest-point confirmation it cannot be settled.
        if (v.D <= args.contactM) throw error ? stop('the nearest-point read failed at a crossing (' + text(error) + ')', 'kernel-error') : stop('the range read puts a crossing on the face, the nearest-point read does not confirm it', 'bracket-unresolved');
        if (v.D < args.grazeM) graze(job, v.t, v.D, false);
      });
    });
    for (const s of touches) { const v = ask(job, T(s)); later(job, () => { if (usable(v).D < args.grazeM) graze(job, v.t, v.D, true); }); }
    for (const c of critical) {
      const v = ask(job, T(c));
      later(job, () => {
        const left = roots.findLastIndex(s => s < c), right = roots.findIndex(s => s > c);
        if (left >= 0 && right >= 0 && state[left] === 'new' && state[right] === 'new') return; // a crossing pair around the closest approach: both crossings are exact
        if (usable(v).D < args.grazeM) graze(job, v.t, v.D, false);
      });
    }
    // The ends of the span within grazeM of the surface: a plane met only beyond the span.
    for (const t of [lo, hi]) if (near(t)) { const v = ask(job, t); later(job, () => { if (usable(v).D < args.grazeM) graze(job, v.t, v.D, false); }); }
  };
  // Display-mesh seeds: a crossing only a seed finds means the search above missed it; it is added and the face flagged.
  const seeds = job => {
    const { entry, R } = job, o = R.o, d = R.d;
    for (let j = entry.start; j < entry.start + entry.count; j += 3) {
      const a = vertex(indices ? indices[j] : j), b = vertex(indices ? indices[j + 1] : j + 1), c = vertex(indices ? indices[j + 2] : j + 2);
      const e1 = sub(b, a), e2 = sub(c, a), p = cross(d, e2), det = dot(e1, p);
      if (Math.abs(det) < 1e-20) continue;
      const sv = sub(o, a), u = dot(sv, p) / det;
      if (u < -args.margin || u > 1 + args.margin) continue;
      const q = cross(sv, e1), v = dot(d, q) / det;
      if (v < -args.margin || u + v > 1 + args.margin) continue;
      const t = dot(e2, q) / det;
      if (t < job.lo || t > job.hi) continue;
      if (R.hits.some(h => h.faceId === entry.id && Math.abs(h.t - t) <= args.seedSkipM)) continue;
      let hit = null;
      try { hit = polishAt(entry, o, d, t, -Infinity, Infinity); } catch (error) { hit = null; }
      if (!hit || !(hit.t >= job.lo && hit.t <= job.hi) || R.hits.some(h => h.faceId === entry.id && Math.abs(h.t - hit.t) <= args.seedSkipM)) continue;
      candidate(job, hit, result => { if (result === 'new') fail(job, 'a display-mesh seed found a crossing the distance search had missed', 'missed-crossing'); });
    }
  };
  const rays = args.rays.map(ray => ({ o: ray.origin, d: ray.direction, hits: [], grazing: [], problems: [] }));
  const jobs = [];
  // A closed Solid is searched along the whole line, so the crossings behind the origin can check the parity.
  for (const R of rays) for (const entry of faces) {
    const span = segment(entry, R.o, R.d, args.closed ? -args.farM : -args.seedBehindM);
    if (!span) continue;
    const job = { R, entry, lo: span[0], hi: span[1], asked: 0, failed: false, sampled: false };
    jobs.push(job);
    guard(job, () => { const model = modelOf(entry); if (model) analytic(job, model, span[0], span[1]); else sampled(job, span[0], span[1]); })();
  }
  drain();
  for (const job of jobs) if (job.sampled && !job.failed) guard(job, () => seeds(job))();
  drain();
  // Sampled faces: two crossings of one face, in then out (or out then in), with the ray less than grazeM from the face
  // half-way between them, are a tangent pair. Both crossings stay, and the face is listed in grazing. (Closed-form
  // crossings are exact, so a close pair on an analytic face is not flagged.)
  for (const job of jobs) {
    if (!job.sampled) continue;
    const own = job.R.hits.filter(h => h.faceId === job.entry.id).sort((a, b) => a.t - b.t);
    for (let i = 0; i + 1 < own.length; i += 1) {
      if (dot(own[i].normal, job.R.d) * dot(own[i + 1].normal, job.R.d) >= 0) continue;
      guard(job, () => { const v = ask(job, (own[i].t + own[i + 1].t) / 2); later(job, () => { if (!v.failed && v.D < args.grazeM * (1 - 1e-6)) graze(job, v.t, v.D, true); }); })();
    }
  }
  drain();
  const out = rays.map(R => {
    const hits = R.hits.filter(h => h.t >= 0), behind = R.hits.filter(h => h.t < 0).map(h => ({ t: h.t, faceId: h.faceId, normal: h.normal }));
    // A closest approach right next to a crossing of the same face is that crossing; a run of grazes on one face is one graze.
    const kept = R.grazing.filter(g => g.t >= -args.grazeSpanM && (g.keep || !R.hits.some(h => h.faceId === g.faceId && Math.abs(h.t - g.t) <= args.grazeSpanM))).sort((a, b) => a.t - b.t);
    const grazing = [];
    for (const g of kept) {
      const same = grazing.findLast(x => x.faceId === g.faceId);
      if (same && g.t - same.last <= args.runGapM) { same.last = g.t; if (g.minDistance < same.minDistance) { same.minDistance = g.minDistance; same.t = g.t; same.point = g.point; } continue; }
      grazing.push({ faceId: g.faceId, t: g.t, minDistance: g.minDistance, point: g.point, last: g.t });
    }
    return { hits, unresolved: 0, unresolvedFaces: [], grazing: grazing.map(g => ({ faceId: g.faceId, t: g.t, minDistance: g.minDistance, point: g.point })), problems: R.problems, ...(args.closed ? { behind } : {}) };
  });
  const undoAfter = this.history.undoStack.length, bodyCountAfter = countBodies();
  if (undoAfter !== undoBefore || bodyCountAfter !== bodyCountBefore) throw new Error('The surface probe changed the document; reconcile before continuing');
  return { undoBefore, undoAfter, bodyCountBefore, bodyCountAfter, rays: out, rangeReads, rangePoints };
}`;

export async function probeSurface(runtime: PlasticityRuntime, state: RuntimeState, request: ProbeSurfaceRequest): Promise<ProbeSurfaceEvidence> {
  const body = state.bodies.find((candidate) => candidate.id === request.id);
  if (!body || (body.type !== "Solid" && body.type !== "Sheet")) throw new Error(`Unknown current Solid or Sheet body ID: ${request.id}`);
  const rays = resolveProbeRays(request, body);
  const box = body.boundsMm;
  // The conservative box contains the body, so an origin outside it is outside the body.
  const outside = (origin: Vector3) => box !== null && [0, 1, 2].some((i) => origin[i]! < box.min[i]! - 1e-6 || origin[i]! > box.max[i]! + 1e-6);
  const native = await runtime.readNative<NativeProbeResult>(PROBE_SURFACE_SOURCE, ["pk_default"], [{
    bodyId: body.id,
    closed: body.type === "Solid",
    rays: rays.map((ray) => ({ origin: ray.originMm.map((value) => value / 1000), direction: ray.direction })),
    margin: 0.05,
    boxMarginM: 5e-4,
    farM: 1e6,
    modelToleranceMm: 1e-5,
    grazeM: PROBE_SURFACE_GRAZE_MM / 1000,
    grazeSpanM: 1e-4,
    runGapM: 2.5e-3,
    touchCos: 1e-6,
    cleanCos: 1e-3,
    contactM: PROBE_SURFACE_KERNEL_RESOLUTION_MM / 1000,
    coarseM: 4e-3,
    maxInitial: 24,
    stepM: 1e-3,
    fan: 8,
    zoneM: 1.5e-4,
    minM: 1e-7,
    slopeEps: 1e-7,
    maxDepth: 12,
    maxReads: 1500,
    maxRounds: 60,
    seedBehindM: 1e-4,
    maxSteps: 60,
    convergedM: 1e-13,
    acceptResidualM: PROBE_SURFACE_ACCEPT_RESIDUAL_MM / 1000,
    mergeM: 1e-7,
    seedSkipM: 1e-4,
    bracketM: 1e-13,
  }]);
  if (!Array.isArray(native?.rays) || native.rays.length !== rays.length) throw new Error("Native surface probe returned an unexpected result shape");
  if (native.undoAfter !== native.undoBefore || native.bodyCountAfter !== native.bodyCountBefore) throw new Error("The surface probe changed the document; reconcile before continuing");
  return {
    id: body.id,
    bodyType: body.type,
    revision: state.revision,
    source: "native-brep-ray-newton",
    acceptResidualMm: PROBE_SURFACE_ACCEPT_RESIDUAL_MM,
    rays: rays.map((ray, index) => projectProbeRay(ray, native.rays[index]!, { closedSolid: body.type === "Solid", originOutside: outside(ray.originMm) })),
    note: PROBE_SURFACE_NOTE,
  };
}

// ---------------------------------------------------------------- P2: exact bounds ----------------------------------------------------------------
// Plasticity 26.1.3 has no kernel Eval.Extremes, so every Solid/Sheet bounds read is native-box (Parasolid's box, which for a
// B-spline face is its control-point hull). The exact extent along a world axis e is the support value max(x.e) over the body.
// The kernel's body range (Eval.DistancesToPoints, a global minimum distance) from a far point P = c + R e gives a body point y
// with  h* - h(y) <= Lmax^2 / (2 (R - hMax)) + kernel resolution,  where Lmax bounds the lateral distance from c to any body
// point (the conservative box corners) and hMax bounds h (the box). y is a real body point, so h(y) <= h*.
export const EXACT_BOUNDS_FAR_M = 1e5;
/** A second query radius: both radii must give the same support coordinate (within the geometric bound), or exact is false. */
export const EXACT_BOUNDS_CHECK_M = 1e4;
export const EXACT_BOUNDS_KERNEL_RESOLUTION_MM = 1e-5;
export const EXACT_BOUNDS_TOLERANCE_MM = 1e-3;
export const EXACT_BOUNDS_MAX_IDS = 32;

export interface NativeSupport { bodyId: number; type: string; ok: number; errors: number[]; nearests: number[]; box: { min: Vector3; max: Vector3 } }

export interface ExactBoundsBody {
  id: number;
  type: string;
  boundsMm: { min: Vector3; max: Vector3 };
  exact: boolean;
  maxErrorMm: number;
  radiiDisagreementMm: number;
  conservativeBoundsMm: { min: Vector3; max: Vector3 } | null;
  conservativeBoundsMethod?: string;
  overshootMm: number;
}

export interface ExactBoundsEvidence {
  revision: string;
  method: "native-support-points";
  toleranceMm: number;
  bodies: ExactBoundsBody[];
  note: string;
}

const DIRECTIONS: Vector3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export const EXACT_BOUNDS_SOURCE = nativeFunction`function (pk_default, args) {
  const kernel = pk_default.a;
  const evaluator = new kernel.Eval(kernel.Context.Get());
  return args.bodies.map(request => {
    const matches = [];
    for (const [versionId, candidate] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(versionId) === request.bodyId) matches.push(candidate);
    if (matches.length !== 1 || !['Solid', 'Sheet'].includes(matches[0]?.view?.constructor?.name)) throw new Error('Unknown current Solid or Sheet body ID: ' + request.bodyId);
    const model = matches[0].model;
    const box = model.FindBox();
    const min = [Number(box.min.x), Number(box.min.y), Number(box.min.z)], max = [Number(box.max.x), Number(box.max.y), Number(box.max.z)];
    const c = [0, 1, 2].map(i => (min[i] + max[i]) / 2);
    const positions = Float64Array.from(args.radii.flatMap(radius => args.directions.flatMap(e => [c[0] + radius * e[0], c[1] + radius * e[1], c[2] + radius * e[2]])));
    const result = evaluator.DistancesToPoints(Int32Array.of(Number(model.Id())), positions, Int32Array.of(0, args.radii.length * args.directions.length));
    return { bodyId: request.bodyId, type: matches[0].view.constructor.name, ok: Number(result?.ok), errors: Array.from(result?.errors ?? [], Number),
      nearests: Array.from(result?.nearests ?? [], Number), box: { min, max } };
  });
}`;

/**
 * Exact extent (mm) per side from the native support points, with the proven error bound. Pure. The first six points
 * come from EXACT_BOUNDS_FAR_M, the next six from EXACT_BOUNDS_CHECK_M. A true global minimum at both radii can differ
 * by at most the larger (check-radius) bound; a bigger disagreement means a premise failed, so consistent is false.
 */
export function supportBounds(native: NativeSupport, farM = EXACT_BOUNDS_FAR_M, checkM = EXACT_BOUNDS_CHECK_M): { boundsMm: { min: Vector3; max: Vector3 }; maxErrorMm: number; radiiDisagreementMm: number; consistent: boolean } {
  const count = DIRECTIONS.length * 2;
  if (native.ok !== count || native.errors.length !== count || native.errors.some((code) => code !== 0)
    || native.nearests.length !== count * 3 || !native.nearests.every(Number.isFinite)) {
    throw new Error(`Native support evaluation failed for body ${native.bodyId} (kernel codes ${native.errors.join(",") || "none"})`);
  }
  const { min, max } = native.box;
  const half = [0, 1, 2].map((i) => (max[i]! - min[i]!) / 2);
  const boundAt = (radius: number) => Math.max(...DIRECTIONS.map((e) => {
    const axis = e.findIndex((entry) => entry !== 0);
    const lateral = [0, 1, 2].filter((i) => i !== axis).reduce((sum, i) => sum + half[i]! ** 2, 0); // Lmax^2 from the box corners
    return lateral / (2 * (radius - half[axis]!)); // h is measured from the box centre along e, so hMax = half[axis]
  }));
  const coordinate = (block: number, index: number) => native.nearests[3 * (block * DIRECTIONS.length + index) + DIRECTIONS[index]!.findIndex((entry) => entry !== 0)]! * 1000;
  const ext = DIRECTIONS.map((_, index) => coordinate(0, index));
  const check = DIRECTIONS.map((_, index) => coordinate(1, index));
  const radiiDisagreementMm = Math.max(...ext.map((value, index) => Math.abs(value - check[index]!)));
  const maxErrorMm = boundAt(farM) * 1000 + EXACT_BOUNDS_KERNEL_RESOLUTION_MM;
  return {
    boundsMm: { min: [ext[1]!, ext[3]!, ext[5]!], max: [ext[0]!, ext[2]!, ext[4]!] },
    maxErrorMm,
    radiiDisagreementMm,
    consistent: radiiDisagreementMm <= boundAt(checkM) * 1000 + 2 * EXACT_BOUNDS_KERNEL_RESOLUTION_MM,
  };
}

export async function readSupportBounds(runtime: PlasticityRuntime, bodyIds: number[]): Promise<NativeSupport[]> {
  const native = await runtime.readNative<NativeSupport[]>(EXACT_BOUNDS_SOURCE, ["pk_default"], [{ bodies: bodyIds.map((bodyId) => ({ bodyId })), directions: DIRECTIONS, radii: [EXACT_BOUNDS_FAR_M, EXACT_BOUNDS_CHECK_M] }]);
  if (!Array.isArray(native) || native.length !== bodyIds.length) throw new Error("Native support evaluation returned an unexpected result shape");
  return native;
}

const round6 = (value: number) => roundTo(value, 6);

export async function exactBounds(runtime: PlasticityRuntime, state: RuntimeState, ids: number[]): Promise<ExactBoundsEvidence> {
  if (ids.length < 1 || ids.length > EXACT_BOUNDS_MAX_IDS) throw new Error(`ids must hold 1-${EXACT_BOUNDS_MAX_IDS} body IDs`);
  if (new Set(ids).size !== ids.length) throw new Error("Body IDs must be unique");
  const bodies = ids.map((id) => {
    const body = state.bodies.find((candidate) => candidate.id === id);
    if (!body || (body.type !== "Solid" && body.type !== "Sheet")) throw new Error(`Unknown current Solid or Sheet body ID: ${id}`);
    return body;
  });
  const native = await readSupportBounds(runtime, ids);
  return {
    revision: state.revision,
    method: "native-support-points",
    toleranceMm: EXACT_BOUNDS_TOLERANCE_MM,
    bodies: bodies.map((body, index) => {
      const { boundsMm, maxErrorMm, radiiDisagreementMm, consistent } = supportBounds(native[index]!);
      const conservative = body.boundsMm;
      const overshoot = conservative ? Math.max(0, ...[0, 1, 2].flatMap((i) => [boundsMm.min[i]! - conservative.min[i]!, conservative.max[i]! - boundsMm.max[i]!])) : 0;
      return {
        id: body.id,
        type: body.type,
        boundsMm: { min: boundsMm.min.map(round6) as Vector3, max: boundsMm.max.map(round6) as Vector3 },
        exact: consistent && maxErrorMm <= EXACT_BOUNDS_TOLERANCE_MM,
        maxErrorMm: roundTo(maxErrorMm, 9),
        radiiDisagreementMm: roundTo(radiiDisagreementMm, 12),
        conservativeBoundsMm: conservative ? { min: [...conservative.min] as Vector3, max: [...conservative.max] as Vector3 } : null,
        ...(body.boundsMethod ? { conservativeBoundsMethod: body.boundsMethod } : {}),
        overshootMm: round6(overshoot),
      };
    }),
    note: "Each side is the coordinate of a real body point that the kernel's global body range finds from a point 100 km out along that axis. The true extent lies at most maxErrorMm beyond it (a geometric bound from the far distance and the conservative box, plus an assumed 1e-5 mm kernel resolution); exact is true when that bound is within 0.001 mm and a second query from 10 km gives the same coordinates within their own bound (radiiDisagreementMm). The premise is that the kernel range is a global minimum. overshootMm is how far the conservative box overstates the body.",
  };
}

/** describe_body's boundsExact: true for native-extrema; otherwise from the support evidence when it is available. */
export function boundsExactness(body: { boundsMethod?: string; boundsMm: { min: number[]; max: number[] } | null }, support?: { boundsMm: { min: Vector3; max: Vector3 }; maxErrorMm: number; consistent?: boolean }): { boundsExact: boolean; boundsNote?: string } | undefined {
  if (body.boundsMethod === "native-extrema") return { boundsExact: true };
  if (!support || !body.boundsMm || support.consistent === false) return undefined;
  const overshoot = Math.max(0, ...[0, 1, 2].flatMap((i) => [support.boundsMm.min[i]! - body.boundsMm!.min[i]!, body.boundsMm!.max[i]! - support.boundsMm.max[i]!]));
  if (overshoot <= EXACT_BOUNDS_TOLERANCE_MM && support.maxErrorMm <= EXACT_BOUNDS_TOLERANCE_MM) return { boundsExact: true };
  if (overshoot <= EXACT_BOUNDS_TOLERANCE_MM) return { boundsExact: false, boundsNote: `kernel box not proven exact: the support bound is ${roundTo(support.maxErrorMm, 6)} mm for a body this large` };
  return { boundsExact: false, boundsNote: `conservative kernel box (B-spline control hull), up to ${round6(overshoot)} mm too large; plasticity_exact_bounds gives the exact extent` };
}

// ---------------------------------------------------------------- P3: XNurbs errors that say what to do ----------------------------------------------------------------
// Codes decoded or reproduced live on Plasticity 26.1.3 (discovery/probes-2026-11/FINDINGS.md gap 6,
// discovery/probes-2026-11-surfacing/FINDINGS.md section 5 and the 2026-11-16 surfacing tool runs). The raw text stays in front.
export const XNURBS_ERROR_ADVICE: Readonly<Record<number, string>> = {
  3: "no usable boundary input reached the patch. Give three or more boundary Wires, or the edges of one boundary loop.",
  25: "not fully decoded. Reproduced when the edge list held edges that branch off the boundary loop (vertical wall edges that a bounds query also caught). Pass only the edges of one boundary loop.",
  27: "not fully decoded. Reproduced when g1 or g2 was asked on the open rim of a Sheet whose neighbouring walls stand perpendicular to the patch (g0 worked on the same rim). Lower the continuity, or blend or tilt the rim first.",
  29: "the boundary constraints are inconsistent. Reproduced with interior guides but no usable boundary, and with one edge that branches off the boundary loop. Pass only the edges of one loop and keep guides inside it.",
  30: "the requested continuity is incompatible at a corner or with the neighbouring faces (for example g1 or g2 against walls perpendicular to the patch). Lower the continuity (or set it per edge), or blend the rim first.",
};

// Codes decoded later, from the independent review's reproductions (round 3), kept apart from the first table.
export const XNURBS_LATER_ERROR_ADVICE: Readonly<Record<number, string>> = {
  31: "the boundary does not close: its items do not meet end to end. Reproduced with a 1 mm corner gap, a curve far from the others and edges that do not form one loop. Pass items that meet end to end, in order around the patch.",
};

/** The XNurbs error code in a native failure message, or undefined. */
export function xnurbsErrorCode(error: unknown): number | undefined {
  const text = error instanceof Error ? error.message : String(error);
  const match = /XNurbs operation failed with error `?(\d+)`?/.exec(text);
  return match ? Number(match[1]) : undefined;
}

/** The same error with what the code means and what to do appended; other errors are returned unchanged. */
export function explainXNurbsError(error: unknown): unknown {
  const code = xnurbsErrorCode(error);
  if (code === undefined || !(error instanceof Error)) return error;
  const advice = XNURBS_ERROR_ADVICE[code] ?? XNURBS_LATER_ERROR_ADVICE[code] ?? "this code is undecoded on Plasticity 26.1.3. Check the boundary edges form one loop and try a lower continuity.";
  // The advice goes right after the line that carries the raw code, before any stack text that follows it.
  const lines = error.message.split("\n");
  const at = Math.max(0, lines.findIndex((line) => /XNurbs operation failed with error/.test(line)));
  lines[at] = `${lines[at]!.replace(/\.?\s*$/, "")}. XNurbs error ${code}: ${advice}`;
  const explained = new Error(lines.join("\n").replace(/\s+$/, ""));
  (explained as Error & { xnurbsCode?: number }).xnurbsCode = code;
  return explained;
}

// ---------------------------------------------------------------- P4: analysis shader and framing on screenshots ----------------------------------------------------------------
// FINDINGS section 3: editor.shading.saveToMemento / setShader(name2shader[key]) / restoreFromMemento; no history step.
// Camera: the pose is restored through the plasticity_set_camera recipe (eye, target, z up) plus zoom, radius and focal
// offset, which put the camera back exactly in restore-camera.json; orbitControls.setQuaternion alone did not.
export const SCREENSHOT_SHADERS = ["isophotes", "draft", "faceDirection", "zebraVertical", "zebraHorizontal", "topo"] as const;
export type ScreenshotShader = (typeof SCREENSHOT_SHADERS)[number];
export const SCREENSHOT_FRAME_MAX_BODIES = 64;
/** Largest camera deviation (metres, radians-ish quaternion components, zoom ratio) that still counts as an exact restore. */
export const CAMERA_RESTORE_TOLERANCE = 1e-9;

export interface ScreenshotViewApplied { undoDepth: number; previousShader: string | null; shader: string | null; framed: boolean; cameraBefore: CameraPose | null; cameraSettle?: { settled: boolean; waitedMs: number } | null; pendingViewDiscarded?: boolean }
export interface ScreenshotViewRestored { restored: boolean; undoDepth: number; shader: string | null; cameraAfter: CameraPose | null; cameraDeviation: number | null; pendingViewDiscarded?: boolean }
/** A pending camera record is put back only while the camera still is where the interrupted call left it (metres, quaternion components, zoom ratio). */
export const PENDING_VIEW_SAME_POSE = 1e-6;
export interface CameraPose { position: Vector3; target: Vector3; quaternion: [number, number, number, number]; zoom: number }

// The pending view change lives on the renderer's global object under one symbol, so a crashed call is undone by the next.
// A record left by an earlier call (args.stale, and the record found at the start of a new apply) puts the camera back
// only when the camera still is where that call left it: a camera the user moved since is theirs, so the record is
// dropped and pendingViewDiscarded is reported. The shader is restored either way.
export const SCREENSHOT_VIEW_SOURCE = nativeFunction`async function (name2shader, args) {
  const key = Symbol.for('plasticity-mcp.screenshot-view');
  const viewport = Array.from(this.viewports ?? [])[0];
  if (!viewport || !this.shading) throw new Error('Plasticity viewport shading is unavailable');
  const shading = this.shading, camera = viewport.camera, controls = viewport.orbitControls;
  const shaderName = memento => { const shader = memento?.shader; return shader ? String(shader.name || shader.constructor?.name || 'custom') : null; };
  const pose = () => ({ position: camera.position.toArray(), target: camera.target.toArray(), quaternion: camera.quaternion.toArray(), zoom: Number(camera.zoom) });
  const stopMotion = () => {
    for (const name of ['targetVelocity', 'focalOffsetVelocity']) controls[name]?.set?.(0, 0, 0);
    for (const name of ['radiusVelocity', 'zoomVelocity']) if (controls[name] && typeof controls[name].value === 'number') controls[name].value = 0;
  };
  const controlsSnapshot = () => {
    const out = {};
    for (const name of ['target', 'targetEnd', 'focalOffset', 'focalOffsetEnd', 'pivot', 'quaternion', 'quaternionEnd', 'snaplessQuaternion', 'snappedQuaternion']) if (controls[name]?.toArray) out[name] = controls[name].toArray();
    for (const name of ['radius', 'radiusEnd', 'zoom', 'zoomEnd']) if (typeof controls[name] === 'number') out[name] = controls[name];
    if (typeof controls.wantsSnap === 'boolean') out.wantsSnap = controls.wantsSnap;
    return out;
  };
  const frame = () => new Promise(resolve => { let done = false; const finish = () => { if (!done) { done = true; resolve(); } };
    try { requestAnimationFrame(finish); } catch { finish(); } setTimeout(finish, 250); });
  // A camera set a moment ago (plasticity_set_view, an orbit with inertia) is still easing toward its end pose. A pose
  // saved mid-motion cannot be restored: the controls keep moving afterwards. Wait until the pose holds still for two
  // frames (or the budget runs out) and save that one.
  const settleCamera = async () => {
    const limit = args.cameraSettleMs ?? 2000, started = Date.now();
    const moved = (a, b) => Math.max(...a.position.map((v, i) => Math.abs(v - b.position[i])), ...a.target.map((v, i) => Math.abs(v - b.target[i])),
      ...a.quaternion.map((v, i) => Math.abs(v - b.quaternion[i])), Math.abs(a.zoom / b.zoom - 1));
    let previous = pose(), still = 0;
    while (Date.now() - started < limit) {
      viewport.setNeedsRender();
      await frame();
      const now = pose();
      still = moved(now, previous) <= 1e-11 ? still + 1 : 0;
      previous = now;
      if (still >= 2) return { settled: true, waitedMs: Date.now() - started };
    }
    return { settled: false, waitedMs: Date.now() - started };
  };
  const settle = async () => {
    viewport.setNeedsRender();
    // Six frames: a framed capture after three frames differed from a later one in about 3,000 scattered model pixels
    // (mean abs diff 0.07) in one live run; the extra frames are cheap (about 100 ms).
    for (let index = 0; index < (args.settleFrames ?? 6); index += 1) await frame();
  };
  const differs = (a, b) => Math.max(...a.position.map((v, i) => Math.abs(v - b.position[i])), ...a.target.map((v, i) => Math.abs(v - b.target[i])),
    ...a.quaternion.map((v, i) => Math.min(Math.abs(v - b.quaternion[i]), Math.abs(v + b.quaternion[i]))), Math.abs(a.zoom / b.zoom - 1));
  const restore = async stale => {
    const saved = globalThis[key];
    if (!saved) return { restored: false, undoDepth: this.history.undoStack.length, shader: shaderName(shading.saveToMemento()), cameraAfter: pose(), cameraDeviation: null };
    // A record of an earlier call: the camera is put back only if it still is where that call left it.
    const discarded = Boolean(stale && saved.camera && !(saved.camera.applied && differs(pose(), saved.camera.applied) <= args.samePose));
    try {
      if (saved.shading) shading.restoreFromMemento(saved.shading);
      if (saved.camera && !discarded) {
        // Put every orbit-control field back as it was (raw copy), with no velocity left to move it afterwards.
        const c = saved.camera.controls;
        for (const name of ['target', 'targetEnd', 'focalOffset', 'focalOffsetEnd', 'pivot']) if (c[name] && controls[name]?.fromArray) controls[name].fromArray(c[name]);
        for (const name of ['quaternion', 'quaternionEnd', 'snaplessQuaternion', 'snappedQuaternion']) if (c[name] && controls[name]?.fromArray) controls[name].fromArray(c[name]);
        if (typeof c.wantsSnap === 'boolean') controls.wantsSnap = c.wantsSnap;
        for (const name of ['radius', 'radiusEnd', 'zoom', 'zoomEnd']) if (typeof c[name] === 'number') controls[name] = c[name];
        stopMotion();
        camera.zoom = saved.camera.zoom;
        controls.setNeedsUpdate(); controls.update(1 / 60); camera.updateProjectionMatrix();
        // Fallback: the plasticity_set_camera recipe (eye, look target, z up), which restored exactly in restore-camera.json.
        const now = pose(), was = saved.camera.pose;
        if (Math.max(...was.position.map((v, i) => Math.abs(v - now.position[i])), ...was.target.map((v, i) => Math.abs(v - now.target[i]))) > args.tolerance) {
          const aim = camera.clone();
          aim.position.fromArray(saved.camera.position);
          aim.up.set(0, 0, 1);
          aim.lookAt(camera.target.clone().fromArray(saved.camera.target));
          controls.setQuaternion(aim.quaternion);
          for (const name of ['target', 'targetEnd', 'focalOffset', 'focalOffsetEnd', 'pivot']) if (c[name] && controls[name]?.fromArray) controls[name].fromArray(c[name]);
          for (const name of ['radius', 'radiusEnd', 'zoom', 'zoomEnd']) if (typeof c[name] === 'number') controls[name] = c[name];
          stopMotion();
          camera.zoom = saved.camera.zoom;
          controls.setNeedsUpdate(); controls.update(1 / 60); camera.updateProjectionMatrix();
        }
        // The controls recompute the camera from the orbit state; the result can differ from the saved pose in the last
        // bits (seen live: 3e-16 m per capture). Write the saved pose back so the camera is the one the caller had.
        camera.position.fromArray(was.position); camera.quaternion.fromArray(was.quaternion); camera.target.fromArray(was.target);
        camera.zoom = was.zoom;
        camera.updateMatrixWorld?.(true); camera.updateProjectionMatrix();
      }
    } finally {
      delete globalThis[key];
    }
    await settle();
    const after = pose();
    const deviation = saved.camera && !discarded ? differs(saved.camera.pose, after) : null;
    return { restored: Boolean(saved.shading) || Boolean(saved.camera && !discarded), undoDepth: this.history.undoStack.length, shader: shaderName(shading.saveToMemento()), cameraAfter: after, cameraDeviation: deviation, ...(discarded ? { pendingViewDiscarded: true } : {}) };
  };
  if (args.op === 'restore') return await restore(Boolean(args.stale));
  // A crashed call left its change: undo it before anything else (its camera only if the camera has not moved since).
  const leftover = globalThis[key] ? await restore(true) : null;
  const undoDepth = this.history.undoStack.length;
  const memento = shading.saveToMemento();
  let material = null;
  if (args.shader) {
    material = name2shader?.[args.shader];
    if (!material) throw new Error('This Plasticity build has no ' + args.shader + ' shader (available: ' + Object.keys(name2shader ?? {}).join(', ') + ')');
  }
  let box = null;
  if (args.frame) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const bodyId of args.frame.bodyIds) {
      let found = null;
      for (const [versionId, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(versionId) === bodyId) found = item;
      if (!found?.model?.FindBox) throw new Error('Unknown current body ID: ' + bodyId);
      const b = found.model.FindBox();
      [b.min.x, b.min.y, b.min.z].forEach((v, i) => { min[i] = Math.min(min[i], v); });
      [b.max.x, b.max.y, b.max.z].forEach((v, i) => { max[i] = Math.max(max[i], v); });
    }
    box = { min, max };
  }
  const cameraSettle = box ? await settleCamera() : null;
  globalThis[key] = {
    shading: args.shader ? memento : null,
    camera: box ? { pose: pose(), position: camera.position.toArray(), target: camera.target.toArray(), zoom: Number(camera.zoom), controls: controlsSnapshot() } : null,
  };
  const cameraBefore = box ? pose() : null;
  try {
    if (material) shading.setShader(material);
    if (box) {
      const center = camera.target.clone().fromArray(box.min.map((v, i) => (v + box.max[i]) / 2));
      const radius = Math.max(1e-6, Math.hypot(...box.max.map((v, i) => v - box.min[i])) / 2);
      const direction = camera.position.clone().sub(camera.target);
      if (direction.length() < 1e-12) direction.set(1, -1, 1);
      direction.normalize();
      const distance = Math.max(controls.radius, radius * 4);
      const aim = camera.clone();
      aim.position.copy(center).addScaledVector(direction, distance);
      aim.up.set(0, 0, 1);
      aim.lookAt(center);
      stopMotion();
      controls.setQuaternion(aim.quaternion);
      controls.target.copy(center); controls.targetEnd.copy(center);
      controls.pivot?.copy?.(center);
      controls.focalOffset.set(0, 0, 0); controls.focalOffsetEnd.set(0, 0, 0);
      controls.radius = controls.radiusEnd = distance;
      const width = camera.orthographic.right - camera.orthographic.left, height = camera.orthographic.top - camera.orthographic.bottom;
      const zoom = Math.min(width, height) / (radius * 2 * 1.2);
      controls.zoom = controls.zoomEnd = zoom; camera.zoom = zoom;
      controls.setNeedsUpdate(); controls.update(1 / 60); camera.updateProjectionMatrix();
      globalThis[key].camera.applied = pose();
    }
    await settle();
    if (box && globalThis[key]?.camera) globalThis[key].camera.applied = pose();
  } catch (error) {
    await restore(false);
    throw error;
  }
  return { undoDepth, previousShader: shaderName(memento), shader: material ? shaderName(shading.saveToMemento()) : null, framed: Boolean(box), cameraBefore, cameraSettle, ...(leftover?.pendingViewDiscarded ? { pendingViewDiscarded: true } : {}) };
}`;

export interface ScreenshotViewOptions { shader?: ScreenshotShader | undefined; frame?: { bodyIds: number[] } | undefined }

/** Validate the view options before anything changes in the renderer. */
export function validateScreenshotView(options: ScreenshotViewOptions, state: RuntimeState | undefined): void {
  if (options.shader !== undefined && !(SCREENSHOT_SHADERS as readonly string[]).includes(options.shader)) {
    throw new Error(`shader must be one of: ${SCREENSHOT_SHADERS.join(", ")}`);
  }
  if (options.frame !== undefined) {
    const ids = options.frame.bodyIds;
    if (ids.length < 1 || ids.length > SCREENSHOT_FRAME_MAX_BODIES) throw new Error(`frame.bodyIds must hold 1-${SCREENSHOT_FRAME_MAX_BODIES} body IDs`);
    if (new Set(ids).size !== ids.length) throw new Error("frame.bodyIds must be unique");
    const known = new Set((state?.bodies ?? []).map((body) => body.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`frame.bodyIds must be current body IDs: ${unknown.join(", ")}`);
  }
}

/**
 * Apply the shader and/or framing, run the capture, and always restore (also when the capture fails). View only: the
 * Undo depth must not change, or the call fails. The camera is saved once it holds still and must come back within
 * CAMERA_RESTORE_TOLERANCE; when it does not, the written image is kept and the reply says cameraRestored false with the deviation.
 */
export async function withScreenshotView<T extends object>(runtime: PlasticityRuntime, options: ScreenshotViewOptions, capture: () => Promise<T>): Promise<T & { pendingViewDiscarded?: true; view: { shader?: { mode: string; previous: string | null; restored: string | null }; frame?: { bodyIds: number[]; cameraRestored: boolean; cameraDeviation: number; cameraSettled?: boolean; cameraSettleWaitMs?: number } } }> {
  const args = { op: "apply", ...(options.shader ? { shader: options.shader } : {}), ...(options.frame ? { frame: { bodyIds: options.frame.bodyIds } } : {}) };
  let applied: ScreenshotViewApplied;
  try {
    applied = await runtime.readNative<ScreenshotViewApplied>(SCREENSHOT_VIEW_SOURCE, ["name2shader"], [{ ...args, tolerance: CAMERA_RESTORE_TOLERANCE, samePose: PENDING_VIEW_SAME_POSE }], 15_000);
  } catch (error) {
    // The apply may have changed the view before it failed or timed out: undo whatever is pending, then report the failure.
    await runtime.readNative(SCREENSHOT_VIEW_SOURCE, ["name2shader"], [{ op: "restore", tolerance: CAMERA_RESTORE_TOLERANCE, samePose: PENDING_VIEW_SAME_POSE }], 15_000).catch(() => undefined);
    throw error;
  }
  let captured: T | undefined;
  let failure: unknown;
  try {
    captured = await capture();
  } catch (error) {
    failure = error;
  }
  let restored: ScreenshotViewRestored | undefined;
  let restoreError: unknown;
  try {
    restored = await runtime.readNative<ScreenshotViewRestored>(SCREENSHOT_VIEW_SOURCE, ["name2shader"], [{ op: "restore", tolerance: CAMERA_RESTORE_TOLERANCE, samePose: PENDING_VIEW_SAME_POSE }], 15_000);
  } catch (error) {
    restoreError = error;
  }
  if (restoreError !== undefined) {
    const reason = restoreError instanceof Error ? restoreError.message : String(restoreError);
    throw new Error(`The screenshot view (shader/camera) could not be restored: ${reason}. The next screenshot call restores it first.${failure !== undefined ? ` The capture also failed: ${failure instanceof Error ? failure.message : String(failure)}` : ""}`);
  }
  if (failure !== undefined) throw failure;
  if (!restored?.restored) throw new Error("The screenshot view change was not found to restore; another call may have restored it");
  if (restored.undoDepth !== applied.undoDepth) throw new Error(`The screenshot view changed the Undo depth (${applied.undoDepth} -> ${restored.undoDepth}); reconcile before continuing`);
  if (options.shader && restored.shader !== applied.previousShader) throw new Error(`The previous shader did not come back (${String(applied.previousShader)} -> ${String(restored.shader)})`);
  // The image is already written: a camera that did not come back exactly is reported, never turned into an error.
  if (options.frame && restored.cameraDeviation === null) throw new Error("The camera read after framing is missing; the screenshot view could not be verified");
  return {
    ...captured!,
    ...(applied.pendingViewDiscarded ? { pendingViewDiscarded: true as const } : {}),
    view: {
      ...(options.shader ? { shader: { mode: options.shader, previous: applied.previousShader, restored: restored.shader } } : {}),
      ...(options.frame ? { frame: {
        bodyIds: options.frame.bodyIds,
        cameraRestored: restored.cameraDeviation! <= CAMERA_RESTORE_TOLERANCE,
        cameraDeviation: restored.cameraDeviation!,
        ...(applied.cameraSettle ? { cameraSettled: applied.cameraSettle.settled, cameraSettleWaitMs: applied.cameraSettle.waitedMs } : {}),
      } } : {}),
    },
  };
}

// ---------------------------------------------------------------- P6: Surface Align ----------------------------------------------------------------
// FINDINGS section 4: the real AlignEdgeCommand with [moving edge, reference edge] selected (the first selected edge
// moves; no selection hit); its AlignEdgeDialog is a DOM element whose params is the AlignAndRebuildFactory. The
// continuity is keyed by the reference edge from factory.pairs. finish() before the command's setup has settled ends
// in AlreadyFinishedError and no commit (probe-align-3-dbg.json), so the drive step waits until the command is
// Awaiting and the factory has updated (both seen at about 25 ms on 26.1.3), or for a fixed 500 ms when this build
// does not expose those states. Any failure before finish() throws without calling it: a clean, certain rejection.
export const SURFACE_ALIGN_CONTINUITY = { g0: "G0", g1: "G1", g2: "G2" } as const;
export type SurfaceAlignContinuity = keyof typeof SURFACE_ALIGN_CONTINUITY;
export const SURFACE_ALIGN_FALLBACK_WAIT_MS = 500;
export const SURFACE_ALIGN_READY_MS = 3_000;
export const SURFACE_ALIGN_COINCIDENCE_MM = 1e-3;
export const SURFACE_ALIGN_TIMEOUTS = Object.freeze({ dialogMs: 3_000, finishMs: 15_000, cancelMs: 3_000 });

export const SURFACE_ALIGN_DRIVE = `
  const factory = dialog.params;
  if (!factory || !Array.isArray(factory.pairs)) throw new Error('Plasticity opened the Align dialog without its factory');
  const pairOf = id => factory.pairs.find(edge => edge?.versionId === id);
  if (!pairOf(driveArgs.movingEdgeId) || !pairOf(driveArgs.referenceEdgeId)) throw new Error('The Align dialog does not hold both edges');
  const tagOf = value => value === null || value === undefined ? null : typeof value === 'string' ? value : (value.tag ?? value.constructor?.name ?? null);
  const observable = command && '_state' in command && factory._state && typeof factory._state === 'object' && 'value' in factory._state;
  const ready = () => tagOf(command._state) === 'Awaiting' && tagOf(factory._state.value) === 'updated';
  const started = Date.now();
  let readiness;
  if (observable) {
    while (!ready() && open() && Date.now() - started < driveArgs.readyMs) await sleep(5);
    if (!open()) throw new Error('The helper stopped waiting before the Align command was ready');
    if (!ready()) throw new Error('The Align command did not become ready (' + tagOf(command._state) + ', ' + tagOf(factory._state.value) + ') within ' + driveArgs.readyMs + ' ms');
    readiness = 'awaiting';
  } else {
    await sleep(driveArgs.fallbackWaitMs);
    readiness = 'fixed-wait';
    if (!open()) throw new Error('The helper stopped waiting during the fixed settle wait');
  }
  const continuity = ContinuityType?.[driveArgs.continuityName];
  if (continuity === undefined) throw new Error('Plasticity build has no ContinuityType.' + driveArgs.continuityName);
  // Once the helper has stopped waiting (its budget ran out, it is cancelling), the factory may be disposed: touch nothing.
  // A finish() after an update() that outlived the budget is refused by the helper (late finish, undetermined).
  if (!open()) throw new Error('The helper stopped waiting before the Align update');
  factory.setContinuityForEdge(pairOf(driveArgs.referenceEdgeId), continuity);
  await factory.update();
  dialog.finish();
  return { readiness, readyAfterMs: Date.now() - started };
`;

export interface AlignReadBackNative { referenceFound: boolean; movingEdgeId: string | null; maxGapM: number | null; maxNormalAngleDeg: number | null; samples: number }

// Read-only: sample the reference edge (kernel points, t in [0, 1]) and find the moving body's edge that runs along it;
// the gap is the larger of the two one-way maxima (reference to moving edge, moving edge to reference). The tangent-plane
// angle compares the two faces' normals at each reference sample (acute angle, |n1.n2|, so sheet orientation does not matter).
export const SURFACE_ALIGN_READBACK_SOURCE = nativeFunction`function (args) {
  const itemOf = id => { for (const [versionId, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(versionId) === id) return item; return null; };
  const reference = itemOf(args.reference.bodyId), moving = itemOf(args.movingBodyId);
  if (!reference || !moving) return { referenceFound: false, movingEdgeId: null, maxGapM: null, maxNormalAngleDeg: null, samples: 0 };
  const refIndex = reference.view.high.edges.versionIds.indexOf(args.reference.edgeId);
  if (refIndex < 0) return { referenceFound: false, movingEdgeId: null, maxGapM: null, maxNormalAngleDeg: null, samples: 0 };
  const refEntity = Number(reference.view.high.edges.get(refIndex).entityId);
  const refEdge = reference.model.GetEdges().GetEdges().find(edge => Number(edge.Id()) === refEntity);
  const read = v => [Number(v.x), Number(v.y), Number(v.z)];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const ts = Array.from({ length: args.samples }, (_, i) => i / (args.samples - 1));
  const refPoints = ts.map(t => refEdge.GetPoint(t));
  let best = null;
  const movingEdges = moving.model.GetEdges().GetEdges();
  for (const edge of movingEdges) {
    let gap = 0;
    for (const point of refPoints) { gap = Math.max(gap, dist(read(edge.FindPointNear(point).exact), read(point))); if (best && gap > best.gap) break; }
    if (!best || gap < best.gap) best = { edge, gap };
  }
  if (!best) return { referenceFound: true, movingEdgeId: null, maxGapM: null, maxNormalAngleDeg: null, samples: args.samples };
  let back = 0;
  for (const t of ts) { const point = best.edge.GetPoint(t); back = Math.max(back, dist(read(refEdge.FindPointNear(point).exact), read(point))); }
  const movingEntity = Number(best.edge.Id());
  let movingEdgeId = null;
  for (let index = 0; index < moving.view.high.edges.versionIds.length; index += 1) if (Number(moving.view.high.edges.get(index).entityId) === movingEntity) movingEdgeId = String(moving.view.high.edges.versionIds[index]);
  let angle = null;
  try {
    const refFace = refEdge.GetFaces().GetFaces()[0], movingFace = best.edge.GetFaces().GetFaces()[0];
    angle = 0;
    for (const point of refPoints) {
      const a = refFace.FindPointNear(point), b = movingFace.FindPointNear(point);
      const n1 = read(refFace.EvalBasis(a.u, a.v).normal), n2 = read(movingFace.EvalBasis(b.u, b.v).normal);
      const cos = Math.min(1, Math.abs(n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]) / (Math.hypot(...n1) * Math.hypot(...n2)));
      angle = Math.max(angle, Math.acos(cos) * 180 / Math.PI);
    }
  } catch (error) { angle = null; }
  return { referenceFound: true, movingEdgeId, maxGapM: Math.max(best.gap, back), maxNormalAngleDeg: angle, samples: args.samples };
}`;

// ---------------------------------------------------------------- P7: Square boundary closure ----------------------------------------------------------------
// The four boundary items must meet end to end around the patch. XNurbs refuses a 1 mm corner gap with error 31 but builds a
// patch over a 0.005 mm gap (independent review), so the ends are checked in the kernel before anything changes.
export const SQUARE_CLOSURE_MM = 1e-3;

/** Each boundary item's two free ends (metres): an edge's ends, or a Wire's unmatched segment ends. Read-only. */
export const SQUARE_ENDS_SOURCE = nativeFunction`function (args) {
  const itemOf = id => { for (const [versionId, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(versionId) === id) return item; throw new Error('Unknown body ID: ' + id); };
  const read = v => [Number(v.x), Number(v.y), Number(v.z)];
  const ends = edges => {
    const points = [];
    for (const edge of edges) points.push(read(edge.GetPoint(0)), read(edge.GetPoint(1)));
    const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= 1e-9;
    return points.filter(p => points.filter(q => same(p, q)).length % 2 === 1);
  };
  return args.boundary.map(entry => {
    const item = itemOf(entry.wireId ?? entry.bodyId);
    if (entry.wireId !== undefined) return ends(item.model.GetEdges().GetEdges());
    const index = item.view.high.edges.versionIds.indexOf(entry.edgeId);
    if (index < 0) throw new Error('Stale or unknown edge: ' + entry.bodyId + ':' + entry.edgeId);
    const entity = Number(item.view.high.edges.get(index).entityId);
    const edge = item.model.GetEdges().GetEdges().find(candidate => Number(candidate.Id()) === entity);
    if (!edge) throw new Error('Kernel edge not found: ' + entry.bodyId + ':' + entry.edgeId);
    return ends([edge]);
  });
}`;

/**
 * Whether four boundary items close: every item has exactly two free ends, and each item's two ends meet the previous and
 * the next item (in order, around the loop) within SQUARE_CLOSURE_MM. Returns the problem in words, or null. Pure; mm in.
 */
export function squareClosureProblem(endsMm: Vector3[][]): string | null {
  const dist = (a: Vector3, b: Vector3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  for (const [index, ends] of endsMm.entries()) {
    if (ends.length !== 2) return `boundary item ${index + 1} has ${ends.length} free ends (a closed or branching curve); each side needs two`;
  }
  const count = endsMm.length;
  // Orient each item: its end that is nearest the next item's ends is its "to" end; its other end must meet the previous one.
  for (let index = 0; index < count; index += 1) {
    const current = endsMm[index]!, next = endsMm[(index + 1) % count]!;
    const pairs = current.flatMap((a, i) => next.map((b, j) => ({ i, j, gap: dist(a, b) })));
    const best = pairs.reduce((x, y) => (y.gap < x.gap ? y : x));
    if (best.gap > SQUARE_CLOSURE_MM) return `boundary items ${index + 1} and ${(index + 1) % count + 1} are ${Number(best.gap.toPrecision(3))} mm apart at their nearest ends (needs <= ${SQUARE_CLOSURE_MM} mm)`;
    const previous = endsMm[(index + count - 1) % count]!;
    const other = current[1 - best.i]!;
    const back = Math.min(...previous.map((p) => dist(other, p)));
    if (back > SQUARE_CLOSURE_MM) return `boundary item ${index + 1} does not run from item ${(index + count - 1) % count + 1} to item ${(index + 1) % count + 1}: its other end is ${Number(back.toPrecision(3))} mm from item ${(index + count - 1) % count + 1} (give the items in order around the patch)`;
  }
  return null;
}

/** Plasticity's relative G2 deviation for two curvatures across an edge: |k1 - k2| / (|k1| + |k2|) (0 when both are 0). */
export function relativeCurvatureDeviation(k1: number, k2: number): number {
  const sum = Math.abs(k1) + Math.abs(k2);
  return sum === 0 ? 0 : Math.abs(k1 - k2) / sum;
}

// ---------------------------------------------------------------- Organic tools 2: Indie Patch boundary pre-check ----------------------------------------------------------------
// What decides whether Plasticity's Indie Patch (PatchHoleInSheetFactory) can meet G1/G2 on a boundary, measured live on 26.1.3
// (discovery/probes-2026-11-organic/FINDINGS.md, "Indie Patch pre-check"):
// - More than 20 boundary edges fail as soon as any edge asks G1 or G2 (regular polygons, stars, lenses and filleted loops:
//   20 edges pass, 21 and 22 fail with 22093 or 22094), even with only one edge asked G1. G0 on 180 edges works.
// - Corners whose neighbour faces do not share a tangent plane: the default patch (faces multiple or minimal, smoothness sharp)
//   creases from such a corner and succeeds (an open box at G1 on all four walls, kinks of 0.02 to 25 degrees); faces: single
//   or smoothness: smooth forbid the crease and fail with 22093.
// - The angle budget: where every face at a corner vertex shares one tangent plane and the patch is asked G1/G2 there, the
//   faces' angles at the vertex plus the patch's own corner angle must add up to 360 degrees. The tutorial rebuild's first rear
//   closure met 180 + 180 + 90 + 90 = 540 degrees and failed at every G1 choice (22094, and 22092 after rebuilding the faces);
//   the second build had 90 + 90 + 90 + 90 = 360 degrees and passed.
// - Mixed continuity: G0 is only a minimum; native may come back tangent on G0 edges where a smooth fill allows it (phase B,
//   open box and split cylinder rim, with or without a shared neighbour face): reported, not refused.
// - The count rule (more than 20 edges at G1/G2) is reported, not refused: its evidence is only planar prisms, stars and lenses.
// - An angle within PATCH_PRECHECK_ANGLE_WRAP_TOLERANCE_DEG of 0 or 360 degrees can wrap to the other end and flip the angle
//   sum, so the budget rule is skipped at that vertex (reported as indeterminate).
export const PATCH_PRECHECK_MAX_CONSTRAINED_EDGES = 20;
/** Neighbour normals closer than this (degrees, unsigned) share a tangent plane. */
export const PATCH_PRECHECK_NORMAL_TOLERANCE_DEG = 2;
/** Allowed miss of the 360 degree angle budget at a smooth vertex. */
export const PATCH_PRECHECK_BUDGET_TOLERANCE_DEG = 10;
/** An angle at a vertex this close to 0 or 360 degrees is ambiguous (it can wrap), so the budget is not judged there. */
export const PATCH_PRECHECK_ANGLE_WRAP_TOLERANCE_DEG = 2;
/** True when an angle (degrees) lies within tolerance of 0 or 360, where atan2 can wrap it to the other end. */
export const nearAngleWrap = (angleDeg: number, toleranceDeg = PATCH_PRECHECK_ANGLE_WRAP_TOLERANCE_DEG) => angleDeg <= toleranceDeg || angleDeg >= 360 - toleranceDeg;
/**
 * Whether disagreeing neighbour normals at a corner with G1/G2 on both sides refuse with the default patch options. Live, the
 * default options crease the patch from that corner and succeed, so the default is false: only faces: single or
 * smoothness: smooth (no crease allowed, native fails 22093) refuse; otherwise the corner is reported.
 */
export const PATCH_PRECHECK_NORMALS_REFUSE_WITH_CREASE = false;

export type PatchPrecheckContinuity = "g0" | "g1" | "g2";
export interface PatchPrecheckItem { kind: "edge" | "curve"; id: string; faceId?: string | null; continuity: PatchPrecheckContinuity }
export interface PatchPrecheckFaceAtVertex { faceId: string; normal: Vector3 | null; angleDeg: number | null }
export interface PatchPrecheckCorner {
  vertexId: number | null;
  positionMm: Vector3;
  /** Indices into items of the two boundary items that meet here. */
  items: [number, number];
  /** Unit tangents leaving the corner along each item. */
  tangents: [Vector3 | null, Vector3 | null];
  /** For an edge item: its neighbour face's normal at the corner; null for a curve. */
  normals: [Vector3 | null, Vector3 | null];
  /** For an edge item: unit direction in its neighbour face, across the edge near the corner, pointing into that face. */
  inward: [Vector3 | null, Vector3 | null];
  /** Every face of the sheet at the vertex, with its interior angle there. Empty for a curve-to-curve corner. */
  faces: PatchPrecheckFaceAtVertex[];
  /** True when the patch closes the vertex: its only open boundary edges are the two hole edges that meet here. */
  closedByPatch: boolean;
}
export interface PatchPrecheckInput {
  items: PatchPrecheckItem[];
  corners: PatchPrecheckCorner[];
  faces?: "single" | "minimal" | "multiple" | undefined;
  smoothness?: "sharp" | "smooth" | undefined;
}
export type PatchPrecheckProblemKind = "too-many-edges" | "angle-budget" | "angle-indeterminate" | "normals-disagree" | "mixed-continuity";
export interface PatchPrecheckProblem {
  kind: PatchPrecheckProblemKind;
  cornerVertexId?: number | null;
  positionMm?: Vector3;
  edgeId?: string;
  edgeIds?: string[];
  faceIds?: string[];
  measured: number;
  needed: string;
  /** True when it refuses the patch before native; false when it is only reported. */
  blocking: boolean;
  message: string;
  advice: string;
}
export interface PatchPrecheckCornerReport {
  vertexId: number | null;
  positionMm: Vector3;
  itemIds: [string, string];
  continuity: [PatchPrecheckContinuity, PatchPrecheckContinuity];
  boundaryTurnDeg: number | null;
  patchAngleDeg: number | null;
  neighbourNormalAngleDeg: number | null;
  smooth: boolean | null;
  faceCount: number;
  faceAngles: Array<{ faceId: string; angleDeg: number | null }>;
  angleSumDeg: number | null;
  /** Present when an angle at the vertex is within the wrap tolerance of 0 or 360 degrees: the budget rule was skipped. */
  angleBudget?: "indeterminate";
}
export interface PatchPrecheckResult {
  ok: boolean;
  problems: PatchPrecheckProblem[];
  corners: PatchPrecheckCornerReport[];
  edges: Array<{ edgeId: string; faceId: string | null; continuity: PatchPrecheckContinuity; sharesFaceWith: string[] }>;
}

const v3dot = (a: Vector3, b: Vector3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const v3cross = (a: Vector3, b: Vector3): Vector3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const v3len = (a: Vector3) => Math.hypot(a[0], a[1], a[2]);
const degreesBetween = (a: Vector3, b: Vector3) => Math.acos(Math.max(-1, Math.min(1, v3dot(a, b) / (v3len(a) * v3len(b))))) * 180 / Math.PI;
/** Angle between two tangent planes given their normals (unsigned: 0 to 90 degrees). */
export const tangentPlaneAngleDeg = (a: Vector3, b: Vector3) => { const d = degreesBetween(a, b); return Math.min(d, 180 - d); };
const fmt = (value: number, digits = 1) => Number(value.toFixed(digits));
const fmtPoint = (p: Vector3) => `(${p.map((x) => fmt(x, 2)).join(", ")})`;
const constrained = (c: PatchPrecheckContinuity) => c === "g1" || c === "g2";

/**
 * The patch's own corner angle (degrees, 0..360) in the plane with normal n: the patch lies across edge A from A's neighbour
 * face, so it turns from tA toward the side opposite A's inward direction until it reaches tB. Null without the vectors.
 */
export function patchCornerAngleDeg(tA: Vector3, tB: Vector3, inwardA: Vector3, n: Vector3): number | null {
  if (![tA, tB, inwardA, n].every((v) => v3len(v) > 1e-12)) return null;
  const patchSide: Vector3 = [-inwardA[0], -inwardA[1], -inwardA[2]];
  const sigma = Math.sign(v3dot(v3cross(tA, patchSide), n)) || 1;
  let phi = Math.atan2(v3dot(v3cross(tA, tB), n) / v3len(n), v3dot(tA, tB)) * 180 / Math.PI * sigma;
  if (phi < 0) phi += 360;
  return phi;
}

/**
 * Pure Indie Patch boundary check from plain numbers (no Plasticity). Blocking problems refuse the patch before native; the
 * rest are reported. See the rules at the top of this section.
 */
export function checkPatchBoundary(input: PatchPrecheckInput, options: { normalToleranceDeg?: number; budgetToleranceDeg?: number; wrapToleranceDeg?: number; maxConstrainedEdges?: number; normalsRefuseWithCrease?: boolean } = {}): PatchPrecheckResult {
  const normalTol = options.normalToleranceDeg ?? PATCH_PRECHECK_NORMAL_TOLERANCE_DEG;
  const budgetTol = options.budgetToleranceDeg ?? PATCH_PRECHECK_BUDGET_TOLERANCE_DEG;
  const wrapTol = options.wrapToleranceDeg ?? PATCH_PRECHECK_ANGLE_WRAP_TOLERANCE_DEG;
  const maxEdges = options.maxConstrainedEdges ?? PATCH_PRECHECK_MAX_CONSTRAINED_EDGES;
  const normalsRefuseWithCrease = options.normalsRefuseWithCrease ?? PATCH_PRECHECK_NORMALS_REFUSE_WITH_CREASE;
  const noCrease = input.faces === "single" || input.smoothness === "smooth";
  const problems: PatchPrecheckProblem[] = [];
  const items = input.items;
  const anyConstrained = items.some((item) => constrained(item.continuity));
  const edgeItems = items.filter((item) => item.kind === "edge");

  // Count rule.
  if (anyConstrained && items.length > maxEdges) {
    const faceCount = new Set(edgeItems.map((item) => item.faceId ?? item.id)).size;
    // Report-only: the live evidence is planar prisms, stars and lenses only, so the rule is advice (FillHole errors still
    // attach it), never a refusal.
    const blocking = false;
    problems.push({
      kind: "too-many-edges", edgeIds: edgeItems.map((item) => item.id), measured: items.length, needed: `at most ${maxEdges} boundary items when any edge is G1 or G2`, blocking,
      message: `the boundary has ${items.length} items (${edgeItems.length} edges on ${faceCount} faces); Indie Patch G1/G2 failed on more than ${maxEdges} in every live test (prisms, stars, lenses: 20 pass, 21 fail with 22093/22094, even with one edge G1)`,
      advice: `merge boundary edges first (plasticity_dissolve_faces or plasticity_delete_edges on the neighbour faces), patch the hole in parts of at most ${maxEdges} edges, or ask G0 on every edge`,
    });
  }

  // Edges sharing one neighbour face (reported in edges[].sharesFaceWith).
  const edges = edgeItems.map((item) => ({
    edgeId: item.id, faceId: item.faceId ?? null, continuity: item.continuity,
    sharesFaceWith: edgeItems.filter((other) => other !== item && other.faceId !== undefined && other.faceId !== null && other.faceId === item.faceId).map((other) => other.id),
  }));
  // Mixed continuity (organic-tools-2 phase B, 26.1.3): G0 is only a minimum. The factory sends per-edge lists and native
  // keeps every G1/G2 request, but it may come back tangent on a G0 edge where a smooth fill allows it: an open box with one
  // wall asked G1 and a cylinder rim split into two arcs (one G1, one G0) came back G1 on every edge, also with the wall face
  // split so each arc had its own neighbour; on the tutorial rear closure the G0 base edges came back G0 (57 to 70 deg).
  const levels = [...new Set(edgeItems.map((item) => item.continuity))];
  if (anyConstrained && levels.length > 1) {
    const top = (["g2", "g1", "g0"] as const).find((level) => levels.includes(level))!;
    const lower = edgeItems.filter((item) => item.continuity !== top);
    const shared = lower.filter((item) => edgeItems.some((other) => other !== item && other.continuity === top && item.faceId && other.faceId === item.faceId));
    problems.push({
      kind: "mixed-continuity", edgeIds: lower.map((item) => item.id), faceIds: [...new Set(lower.map((item) => item.faceId).filter((faceId): faceId is string => Boolean(faceId)))],
      measured: levels.length, needed: "G0 edges may come back tangent; no crease on request", blocking: false,
      message: `edges ${lower.map((item) => `${item.id} (${item.continuity.toUpperCase()})`).join(", ")} ask less than ${top.toUpperCase()}; on Plasticity 26.1.3 that is only a minimum: Indie Patch keeps the ${top.toUpperCase()} edges and may come back ${top.toUpperCase()} on these too where a smooth fill allows it (live: an open box and a cylinder rim split into two arcs came back G1 on every edge${shared.length > 0 ? `; ${shared.map((item) => item.id).join(", ")} also ${shared.length === 1 ? "shares" : "share"} a neighbour face with a ${top.toUpperCase()} edge, and splitting that face did not change it` : ""}); it never makes a crease on request`,
      advice: `read the edges back with plasticity_analyze_surface_continuity; to force a crease along some edges, fill that part separately (a smaller patch loop, plasticity_loft_curves or plasticity_bridge_sheet_edges from the tangent edges) and patch the rest`,
    });
  }

  const corners: PatchPrecheckCornerReport[] = [];
  for (const corner of input.corners) {
    const [ia, ib] = corner.items;
    const a = items[ia]!, b = items[ib]!;
    const [tA, tB] = corner.tangents;
    const [nA, nB] = corner.normals;
    const [wA, wB] = corner.inward;
    const turn = tA && tB ? 180 - degreesBetween(tA, tB) : null;
    // Patch corner angle, from whichever item is an edge with an inward direction.
    let patchAngle: number | null = null;
    if (tA && tB && wA && nA) patchAngle = patchCornerAngleDeg(tA, tB, wA, nA);
    else if (tA && tB && wB && nB) patchAngle = patchCornerAngleDeg(tB, tA, wB, nB);
    const faceNormals = corner.faces.map((face) => face.normal).filter((n): n is Vector3 => n !== null);
    let maxFaceAngle = 0;
    for (let i = 0; i < faceNormals.length; i += 1) for (let j = i + 1; j < faceNormals.length; j += 1) maxFaceAngle = Math.max(maxFaceAngle, tangentPlaneAngleDeg(faceNormals[i]!, faceNormals[j]!));
    const smooth = corner.faces.length === 0 || faceNormals.length !== corner.faces.length ? null : maxFaceAngle <= normalTol;
    const neighbourAngle = nA && nB ? tangentPlaneAngleDeg(nA, nB) : null;
    const anglesKnown = corner.faces.every((face) => face.angleDeg !== null);
    const angleSum = anglesKnown && patchAngle !== null && corner.faces.length > 0 ? corner.faces.reduce((sum, face) => sum + face.angleDeg!, 0) + patchAngle : null;
    const wrapped = angleSum !== null && [patchAngle!, ...corner.faces.map((face) => face.angleDeg!)].some((angle) => nearAngleWrap(angle, wrapTol));
    corners.push({
      vertexId: corner.vertexId, positionMm: corner.positionMm, itemIds: [a.id, b.id], continuity: [a.continuity, b.continuity],
      boundaryTurnDeg: turn === null ? null : fmt(turn, 3), patchAngleDeg: patchAngle === null ? null : fmt(patchAngle, 3),
      neighbourNormalAngleDeg: neighbourAngle === null ? null : fmt(neighbourAngle, 3), smooth, faceCount: corner.faces.length,
      faceAngles: corner.faces.map((face) => ({ faceId: face.faceId, angleDeg: face.angleDeg === null ? null : fmt(face.angleDeg, 3) })),
      angleSumDeg: angleSum === null ? null : fmt(angleSum, 3),
      ...(wrapped ? { angleBudget: "indeterminate" as const } : {}),
    });
    const where = `vertex ${corner.vertexId ?? "(curve end)"} ${fmtPoint(corner.positionMm)}`;
    // Normals rule: both sides edges asked G1/G2 on different faces.
    if (a.kind === "edge" && b.kind === "edge" && constrained(a.continuity) && constrained(b.continuity) && a.faceId !== b.faceId && neighbourAngle !== null && neighbourAngle > normalTol) {
      const blocking = noCrease || normalsRefuseWithCrease;
      problems.push({
        kind: "normals-disagree", cornerVertexId: corner.vertexId, positionMm: corner.positionMm, edgeIds: [a.id, b.id], faceIds: [a.faceId ?? "?", b.faceId ?? "?"],
        measured: fmt(neighbourAngle, 2), needed: `at most ${normalTol} degrees between the neighbour normals for G1/G2 to both`, blocking,
        message: blocking
          ? `neighbour normals disagree by ${fmt(neighbourAngle, 2)}° at ${where}: faces ${a.faceId} and ${b.faceId} do not share a tangent plane, so G1 to both is impossible without a crease, and ${noCrease ? (input.faces === "single" ? "faces: single" : "smoothness: smooth") : "this check"} forbids the crease`
          : `neighbour normals disagree by ${fmt(neighbourAngle, 2)}° at ${where}: faces ${a.faceId} and ${b.faceId} do not share a tangent plane, so the patch cannot be G1 to both at that point; with these options native creases the patch from this corner`,
        advice: blocking
          ? `ask G0 on edge ${a.id} or ${b.id}, use faces: multiple or minimal with smoothness: sharp (the patch then creases from this corner), or make the faces meet tangentially at this vertex`
          : `accept the crease, or ask G0 on edge ${a.id} or ${b.id}, or make faces ${a.faceId} and ${b.faceId} meet tangentially at this vertex`,
      });
    }
    // Angle budget: a smooth vertex the patch closes, with G1/G2 on either side. Fails open where an angle can wrap.
    const budgetApplies = corner.closedByPatch && smooth === true && (constrained(a.continuity) || constrained(b.continuity)) && angleSum !== null;
    if (budgetApplies && wrapped) {
      problems.push({
        kind: "angle-indeterminate", cornerVertexId: corner.vertexId, positionMm: corner.positionMm, edgeIds: [a.id, b.id], faceIds: corner.faces.map((face) => face.faceId),
        measured: fmt(angleSum!), needed: `every angle at the vertex more than ${wrapTol} degrees from 0 and 360`, blocking: false,
        message: `the angle budget at ${where} is indeterminate: an angle there is within ${wrapTol}° of 0° or 360° (patch corner ${fmt(patchAngle!)}°, faces ${corner.faces.map((face) => `${face.faceId} ${fmt(face.angleDeg!)}°`).join(", ")}), where it can wrap to the other end, so the 360° rule is not applied`,
        advice: "read the corner in the viewport; if the patch fails there, check the angles by hand",
      });
    }
    if (budgetApplies && !wrapped && Math.abs(angleSum! - 360) > budgetTol) {
      const parts = corner.faces.map((face) => `${face.faceId} ${fmt(face.angleDeg!)}°`).join(" + ");
      const g1Ids = [a, b].filter((item) => constrained(item.continuity)).map((item) => item.id);
      problems.push({
        kind: "angle-budget", cornerVertexId: corner.vertexId, positionMm: corner.positionMm, edgeIds: [a.id, b.id], faceIds: corner.faces.map((face) => face.faceId),
        measured: fmt(angleSum!), needed: "360 degrees", blocking: true,
        message: `angles at ${where} sum to ${fmt(angleSum!)}° (${corner.faces.length} faces: ${parts}, plus the patch corner ${fmt(patchAngle!)}°); every face there shares one tangent plane, so a smooth patch needs 360°`,
        advice: `ask G0 on ${g1Ids.length > 1 ? `edges ${g1Ids.join(" and ")}` : `edge ${g1Ids[0]}`}, or rebuild the boundary so the faces meeting at this vertex leave a corner that closes to 360° (swap which curve continues which edge, or re-loft so a face leaves the vertex at a different angle)`,
      });
    }
  }
  return { ok: problems.every((problem) => !problem.blocking), problems, corners, edges };
}

/** Indie Patch (FillHole) native error code in a failure message, or undefined. */
export function patchHoleErrorCode(error: unknown): number | undefined {
  const text = error instanceof Error ? error.message : String(error);
  const match = /FillHole failed with error `?(\d+)`?/.exec(text);
  return match ? Number(match[1]) : undefined;
}

// What each FillHole code went with in the live runs (FINDINGS "Indie Patch pre-check"); none is officially decoded.
export const PATCH_HOLE_ERROR_ADVICE: Readonly<Record<number, string>> = {
  22092: "the G1/G2 conditions at the boundary could not be met. Seen at a smooth vertex whose face angles do not add to 360°, after its neighbour faces had been rebuilt.",
  22093: "the G1/G2 conditions at the boundary could not be met. Seen with more than 20 boundary edges and G1, and at corners whose neighbour faces do not share a tangent plane when faces: single or smoothness: smooth forbid a crease.",
  22094: "the G1/G2 conditions at the boundary could not be met. Seen with more than 20 boundary edges and G2 (or nearly smooth loops), at a smooth vertex whose face angles do not add to 360°, at a small corner crease that faces: single forbade, and for G2 on a rear closure whose G1 worked.",
};

/** One line per problem, for an error message. */
export function describePatchPrecheck(result: PatchPrecheckResult, which: "blocking" | "all" = "all"): string {
  const listed = result.problems.filter((problem) => which === "all" || problem.blocking);
  if (listed.length === 0) return "pre-check found no corner, edge-count or face problem";
  // Blocking problems first; at most six in the text (the full list is in the analysis).
  const ordered = [...listed.filter((problem) => problem.blocking), ...listed.filter((problem) => !problem.blocking)];
  const shown = ordered.slice(0, 6).map((problem, index) => `${index + 1}. ${problem.message}. Fix: ${problem.advice}.`).join(" ");
  return ordered.length > 6 ? `${shown} (${ordered.length - 6} more in the analysis.)` : shown;
}

/** Indie Patch boundary geometry for the pre-check (read-only). Every vector in millimetres or unit length. */
export const PATCH_BOUNDARY_SOURCE = nativeFunction`function (pk_default, args) {
  const kernel = pk_default.a;
  let item;
  for (const [versionId, candidate] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(versionId) === args.id) { item = candidate; break; }
  if (!item || item.view?.constructor?.name !== 'Sheet') throw new Error('Unknown current Sheet body ID: ' + args.id);
  const view = item.view;
  const read = v => [Number(v.x), Number(v.y), Number(v.z)];
  const mm = v => read(v).map(x => x * 1000);
  const unit = a => { const l = Math.hypot(a[0], a[1], a[2]); return l > 0 && Number.isFinite(l) ? a.map(x => x / l) : null; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dotp = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const list = c => { if (!c) return []; if (typeof c.Size === 'function') { const out = []; for (let i = 0; i < c.Size(); i += 1) out.push(c.Get(i)); return out; } return Array.from(c); };
  const faceIdByEntity = new Map(), edgeIdByEntity = new Map();
  for (let i = 0; i < view.high.faces.versionIds.length; i += 1) faceIdByEntity.set(Number(view.high.faces.get(i).entityId), String(view.high.faces.versionIds[i]));
  for (let i = 0; i < view.high.edges.versionIds.length; i += 1) edgeIdByEntity.set(Number(view.high.edges.get(i).entityId), String(view.high.edges.versionIds[i]));
  const kernelEdges = item.model.GetEdges().GetEdges();
  const facesOf = edge => { const fs = edge.GetFaces(); return typeof fs.GetFaces === 'function' ? fs.GetFaces() : list(fs); };
  const edgeByEntity = new Map(kernelEdges.map(e => [Number(e.Id()), e]));
  const edgeById = id => { const i = view.high.edges.versionIds.indexOf(id); if (i < 0) throw new Error('Stale or unknown Sheet edge: ' + id); const e = edgeByEntity.get(Number(view.high.edges.get(i).entityId)); if (!e) throw new Error('Kernel edge not found: ' + id); return e; };
  const KernelVector = kernelEdges[0].GetPointAndTangent(0.5).position.constructor;
  const evaluator = kernel.Eval && kernel.Context?.Get ? new kernel.Eval(kernel.Context.Get()) : null;
  // End points of an edge with the tangent leaving the end along the edge (the kernel tangent follows the curve, which can run
  // against the edge, so it is oriented by a step inside the edge) and the vertex at that end.
  const edgeEnds = edge => {
    const verts = edge.GetVertices();
    const vs = [verts.left, verts.right].filter(Boolean).map(v => ({ id: Number(v.Id()), p: mm(v.GetPoint()) }));
    return [[0, 1e-3], [1, 1 - 1e-3]].map(([t, inner]) => {
      const end = edge.GetPointAndTangent(t);
      const pointMm = mm(end.position);
      let tangent = unit(read(end.tangent));
      const step = read(edge.GetPointAndTangent(inner).position).map((x, i) => x - read(end.position)[i]);
      if (tangent && dotp(tangent, step) < 0) tangent = tangent.map(x => -x);
      const v = vs.find(c => dist3(c.p, pointMm) < 1e-3);
      return { t, pointMm, tangentAway: tangent, vertexId: v ? v.id : null };
    });
  };
  const normalAt = (face, pMm) => {
    const near = face.FindPointNear(new KernelVector(pMm[0] / 1000, pMm[1] / 1000, pMm[2] / 1000));
    return unit(read(face.EvalNormal(near.u, near.v).normal));
  };
  const distanceToFace = (face, pMm) => {
    const r = evaluator.DistancesToPoints(Int32Array.from([Number(face.Id())]), Float64Array.from(pMm.map(x => x / 1000)), Int32Array.from([0, 1]));
    const d = Number(r.distances?.[0]);
    return Number(r.errors?.[0] ?? 0) === 0 && Number.isFinite(d) ? d * 1000 : null;
  };
  // Unit direction in the face, across the edge a little away from the vertex, pointing into the face: of two tiny steps
  // either way across the edge, the one that lands on the trimmed face is inside. Null when the two cannot be told apart.
  const inwardAcross = (face, edge, vMm) => {
    if (!evaluator) return null;
    const len = Number(edge.FindLength().length) * 1000;
    const atStart = dist3(mm(edge.GetPointAndTangent(0).position), vMm) <= dist3(mm(edge.GetPointAndTangent(1).position), vMm);
    const f = Math.min(0.05, 0.5 / len);
    const q = edge.GetPointAndTangent(atStart ? f : 1 - f);
    const qMm = mm(q.position);
    const n = normalAt(face, qMm), t = unit(read(q.tangent));
    const w = n && t ? unit(cross(n, t)) : null;
    if (!w) return null;
    const eps = Math.min(0.01, 0.02 * len);
    const plus = distanceToFace(face, qMm.map((x, i) => x + eps * w[i]));
    const minus = distanceToFace(face, qMm.map((x, i) => x - eps * w[i]));
    if (plus === null || minus === null || Math.abs(plus - minus) <= 0.2 * eps) return null;
    return plus < minus ? w : w.map(x => -x);
  };
  const vertexById = new Map();
  for (const e of kernelEdges) { const vv = e.GetVertices(); for (const v of [vv.left, vv.right]) if (v) vertexById.set(Number(v.Id()), v); }
  const edges = args.edgeIds.map(edgeId => {
    const edge = edgeById(edgeId);
    const faces = facesOf(edge);
    if (faces.length !== 1) throw new Error('Hole patch requires boundary edges: ' + edgeId);
    return { edgeId, faceId: faceIdByEntity.get(Number(faces[0].Id())) ?? null, ends: edgeEnds(edge).map(end => ({ ...end, inward: end.vertexId === null ? null : inwardAcross(faces[0], edge, end.pointMm), normal: normalAt(faces[0], end.pointMm) })) };
  });
  const wires = (args.curveIds ?? []).map(wireId => {
    let wire; for (const [versionId, candidate] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(versionId) === wireId) { wire = candidate; break; }
    if (!wire) throw new Error('Unknown Wire: ' + wireId);
    const all = wire.model.GetEdges().GetEdges().flatMap(edgeEnds);
    return { wireId, ends: all.filter(p => all.filter(q => dist3(p.pointMm, q.pointMm) <= 1e-6).length % 2 === 1).map(p => ({ pointMm: p.pointMm, tangentAway: p.tangentAway })) };
  });
  const vertexIds = [...new Set(edges.flatMap(e => e.ends.map(end => end.vertexId)).filter(v => v !== null))];
  const vertices = vertexIds.map(vertexId => {
    const vertex = vertexById.get(vertexId);
    const pMm = mm(vertex.GetPoint());
    const atV = [];
    for (const e of kernelEdges) {
      const ends = edgeEnds(e).filter(end => end.vertexId === vertexId);
      if (ends.length === 0) continue;
      const fs = facesOf(e);
      for (const end of ends) atV.push({ edge: e, edgeId: edgeIdByEntity.get(Number(e.Id())), faces: fs, faceEntities: fs.map(f => Number(f.Id())), tangentAway: end.tangentAway });
    }
    const faceEntities = [...new Set(atV.flatMap(a => a.faceEntities))];
    const faces = faceEntities.map(entity => {
      const ends = atV.filter(a => a.faceEntities.includes(entity));
      const face = ends[0].faces.find(f => Number(f.Id()) === entity);
      const normal = normalAt(face, pMm);
      let angleDeg = null;
      if (ends.length === 2 && ends[0].tangentAway && ends[1].tangentAway && normal) {
        for (const k of [0, 1]) {
          const inward = inwardAcross(face, ends[k].edge, pMm);
          if (!inward) continue;
          const tk = ends[k].tangentAway, tOther = ends[1 - k].tangentAway;
          const sigma = Math.sign(dotp(cross(tk, inward), normal)) || 1;
          let phi = Math.atan2(dotp(cross(tk, tOther), normal), dotp(tk, tOther)) * 180 / Math.PI * sigma;
          if (phi < 0) phi += 360;
          angleDeg = phi;
          break;
        }
      }
      return { faceId: faceIdByEntity.get(entity) ?? String(entity), normal, angleDeg };
    });
    return { vertexId, positionMm: pMm, faces, boundaryEdgeIds: atV.filter(a => a.faceEntities.length === 1).map(a => a.edgeId) };
  });
  return { edges, wires, vertices };
}`;

export interface NativePatchBoundary {
  edges: Array<{ edgeId: string; faceId: string | null; ends: Array<{ t: number; pointMm: Vector3; tangentAway: Vector3 | null; vertexId: number | null; inward: Vector3 | null; normal: Vector3 | null }> }>;
  wires: Array<{ wireId: number; ends: Array<{ pointMm: Vector3; tangentAway: Vector3 | null }> }>;
  vertices: Array<{ vertexId: number; positionMm: Vector3; faces: PatchPrecheckFaceAtVertex[]; boundaryEdgeIds: string[] }>;
}

/** Corner list for checkPatchBoundary from the native boundary read: every pair of item ends that meet. */
export function patchPrecheckInputFromNative(
  native: NativePatchBoundary,
  continuityOf: (edgeId: string) => PatchPrecheckContinuity,
  options: { faces?: "single" | "minimal" | "multiple" | undefined; smoothness?: "sharp" | "smooth" | undefined } = {},
  meetMm = 1e-2,
): PatchPrecheckInput {
  const items: PatchPrecheckItem[] = [
    ...native.edges.map((edge) => ({ kind: "edge" as const, id: edge.edgeId, faceId: edge.faceId, continuity: continuityOf(edge.edgeId) })),
    ...native.wires.map((wire) => ({ kind: "curve" as const, id: `wire:${wire.wireId}`, continuity: "g0" as const })),
  ];
  type End = { item: number; pointMm: Vector3; tangent: Vector3 | null; vertexId: number | null; normal: Vector3 | null; inward: Vector3 | null; used: boolean };
  const ends: End[] = [
    ...native.edges.flatMap((edge, index) => edge.ends.map((end) => ({ item: index, pointMm: end.pointMm, tangent: end.tangentAway, vertexId: end.vertexId, normal: end.normal, inward: end.inward, used: false }))),
    ...native.wires.flatMap((wire, index) => wire.ends.map((end) => ({ item: native.edges.length + index, pointMm: end.pointMm, tangent: end.tangentAway, vertexId: null, normal: null, inward: null, used: false }))),
  ];
  const dist = (a: Vector3, b: Vector3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const holeEdgeIds = new Set(native.edges.map((edge) => edge.edgeId));
  const corners: PatchPrecheckCorner[] = [];
  for (const first of ends) {
    if (first.used) continue;
    const partner = ends.find((other) => other !== first && !other.used && (first.vertexId !== null && other.vertexId !== null ? other.vertexId === first.vertexId : dist(other.pointMm, first.pointMm) <= meetMm));
    if (!partner) continue;
    first.used = true; partner.used = true;
    const vertexId = first.vertexId ?? partner.vertexId;
    const vertex = vertexId === null ? undefined : native.vertices.find((candidate) => candidate.vertexId === vertexId);
    const bothEdges = first.item < native.edges.length && partner.item < native.edges.length;
    corners.push({
      vertexId,
      positionMm: vertex?.positionMm ?? first.pointMm,
      items: [first.item, partner.item],
      tangents: [first.tangent, partner.tangent],
      normals: [first.normal, partner.normal],
      inward: [first.inward, partner.inward],
      faces: vertex?.faces ?? [],
      closedByPatch: Boolean(vertex) && bothEdges && vertex!.boundaryEdgeIds.every((edgeId) => holeEdgeIds.has(edgeId)),
    });
  }
  return { items, corners, faces: options.faces, smoothness: options.smoothness };
}

// ---------------------------------------------------------------- Organic tools 2: plane curve ----------------------------------------------------------------
export type CurvePlaneName = "xy" | "xz" | "yz";
export interface CurvePlaneFrame { originMm: Vector3; uAxis: Vector3; vAxis: Vector3; normal: Vector3 }
const PLANE_FRAMES: Record<CurvePlaneName, { u: Vector3; v: Vector3; normal: Vector3 }> = {
  // The normal is the offset direction: +Z, +Y and +X (for xz, u x v is -Y, but y = offsetMm is what reads back).
  xy: { u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] },
  xz: { u: [1, 0, 0], v: [0, 0, 1], normal: [0, 1, 0] },
  yz: { u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0] },
};

/**
 * The frame of a curve plane: a named world plane offset along its normal (+Z, +Y, +X), or a custom origin with u and v axes.
 * The custom u is normalised and v is made perpendicular to u in their plane (Gram-Schmidt); u and v must be at least 1 degree
 * from parallel. The custom normal is u x v, and offsetMm moves the origin along it.
 */
export function resolveCurvePlane(plane: CurvePlaneName | { originMm: Vector3; uAxis: Vector3; vAxis: Vector3 }, offsetMm = 0): CurvePlaneFrame {
  if (!Number.isFinite(offsetMm)) throw new Error("Plane curve offsetMm must be finite");
  if (typeof plane === "string") {
    const frame = PLANE_FRAMES[plane];
    if (!frame) throw new Error("Plane curve plane must be xy, xz, yz or { originMm, uAxis, vAxis }");
    return { originMm: frame.normal.map((x) => x * offsetMm) as Vector3, uAxis: frame.u, vAxis: frame.v, normal: frame.normal };
  }
  const { originMm, uAxis, vAxis } = plane;
  if (![...originMm, ...uAxis, ...vAxis].every(Number.isFinite)) throw new Error("Plane curve origin and axes must be finite");
  const ul = v3len(uAxis);
  if (!(ul > 1e-12)) throw new Error("Plane curve uAxis must be a non-zero vector");
  const u = uAxis.map((x) => x / ul) as Vector3;
  const along = v3dot(vAxis, u);
  const vPerp: Vector3 = [vAxis[0] - along * u[0], vAxis[1] - along * u[1], vAxis[2] - along * u[2]];
  const vl = v3len(vPerp);
  if (!(v3len(vAxis) > 1e-12) || vl < Math.sin(Math.PI / 180) * v3len(vAxis)) throw new Error("Plane curve vAxis must be non-zero and at least 1 degree from uAxis");
  const v = vPerp.map((x) => x / vl) as Vector3;
  const normal = v3cross(u, v);
  return { originMm: [originMm[0] + normal[0] * offsetMm, originMm[1] + normal[1] * offsetMm, originMm[2] + normal[2] * offsetMm], uAxis: u, vAxis: v, normal };
}

/** World points (mm) for 2D plane points: each point is scaled about the plane origin, then translated in the plane. */
export function planeCurveWorldPoints(frame: CurvePlaneFrame, points2dMm: Array<[number, number]>, scaleFactor = 1, translate2dMm: [number, number] = [0, 0]): Vector3[] {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) throw new Error("Plane curve scale must be a positive finite number");
  if (!translate2dMm.every(Number.isFinite)) throw new Error("Plane curve translate2dMm must be finite");
  return points2dMm.map(([x, y]) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Plane curve points must be finite");
    const a = x * scaleFactor + translate2dMm[0], b = y * scaleFactor + translate2dMm[1];
    return [0, 1, 2].map((i) => frame.originMm[i]! + a * frame.uAxis[i]! + b * frame.vAxis[i]!) as Vector3;
  });
}

// ---------------------------------------------------------------- Organic tools 2: continuity report ----------------------------------------------------------------
export type ContinuityReportClass = "G2" | "G1" | "G0" | "none";
const CLASS_RANK: Record<ContinuityReportClass, number> = { none: 0, G0: 1, G1: 2, G2: 3 };
/** Hierarchical class from deviations and tolerances (G0 position, G1 normal angle, G2 relative curvature); none is a gap. */
export function continuityClass(g0Mm: number, g1Deg: number, g2Rel: number, tolerances: { positionMm: number; normalAngleDeg: number; relativeCurvature: number }): ContinuityReportClass {
  if (!(g0Mm <= tolerances.positionMm)) return "none";
  if (!(g1Deg <= tolerances.normalAngleDeg)) return "G0";
  if (!(g2Rel <= tolerances.relativeCurvature)) return "G1";
  return "G2";
}
/** Order edges worst first: lowest class, then largest normal deviation, then largest curvature mismatch. */
export function worstFirst<T extends { class: ContinuityReportClass; normalAngleDeg: { max: number }; relativeCurvature: { interiorMax: number | null } }>(edges: T[]): T[] {
  return [...edges].sort((a, b) => CLASS_RANK[a.class] - CLASS_RANK[b.class] || b.normalAngleDeg.max - a.normalAngleDeg.max || (b.relativeCurvature.interiorMax ?? 0) - (a.relativeCurvature.interiorMax ?? 0));
}

/**
 * Interior maxima (samples 5..94) can only be at most the overall maxima; float noise in separate reductions must not make
 * interiorClass worse than class. Relative G2 mismatch is at most 1 by definition. Returns clamped copies.
 */
export function clampContinuityMaxima<T extends { g0Mm: number; g1Deg: number; g2Rel: number }>(overall: T, interior: T | undefined): { overall: T; interior: T | undefined } {
  const all = { ...overall, g2Rel: Math.min(overall.g2Rel, 1) };
  if (!interior) return { overall: all, interior };
  return { overall: all, interior: { ...interior, g0Mm: Math.min(interior.g0Mm, all.g0Mm), g1Deg: Math.min(interior.g1Deg, all.g1Deg), g2Rel: Math.min(interior.g2Rel, all.g2Rel) } };
}

/**
 * One Wire segment. startInnerMm / endInnerMm are the segment's points at t = 0.01 and t = 0.99 (its own direction): they
 * orient the kernel end tangents (which follow the curve and can run against the segment) and the curvature sample list.
 */
export interface WireSegmentInput { entityId: number; startMm: Vector3; endMm: Vector3; startTangent: Vector3; endTangent: Vector3; lengthMm: number; startInnerMm?: Vector3; endInnerMm?: Vector3 }
export interface CurvatureSampleInput { positionMm: Vector3; vectorPerMm: Vector3 }
export interface WireJunctionReport {
  atMm: Vector3;
  segmentEntityIds: [number, number];
  curvaturePerMm: [number, number];
  tangentAngleDeg: number;
  relativeCurvatureMismatch: number;
  class: "G0" | "G1" | "G2";
}
export interface WireSegmentReport { entityId: number; lengthMm: number; minCurvaturePerMm: number; maxCurvaturePerMm: number; inflections: number }

/** Sign changes of the curvature along a segment: consecutive non-zero curvature vectors pointing opposite ways. */
export function countInflections(samples: CurvatureSampleInput[], zeroPerMm = 1e-9): number {
  let count = 0;
  let last: Vector3 | null = null;
  for (const sample of samples) {
    if (v3len(sample.vectorPerMm) <= zeroPerMm) continue;
    if (last && v3dot(last, sample.vectorPerMm) < 0) count += 1;
    last = sample.vectorPerMm;
  }
  return count;
}

/**
 * Junctions between consecutive segments of one Wire (segments meeting end to end within 0.001 mm, in any order or direction)
 * with the curvature on each side, the tangent angle (0 when smooth) and a G0/G1/G2 class, plus per-segment curvature extremes
 * and inflection counts. The curvature vector does not depend on the segment direction, so the mismatch is
 * |k1 - k2| / (|k1| + |k2|) of the vectors: 1 at an S-shaped junction even when the magnitudes agree.
 */
export function wireJunctions(segments: WireSegmentInput[], samples: Map<number, CurvatureSampleInput[]>, tolerances: { normalAngleDeg: number; relativeCurvature: number }, meetMm = 1e-3): { junctions: WireJunctionReport[]; segments: WireSegmentReport[] } {
  const dist = (a: Vector3, b: Vector3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  type End = { seg: WireSegmentInput; at: Vector3; away: Vector3; atStart: boolean; used: boolean };
  const sub = (a: Vector3, b: Vector3): Vector3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const neg = (a: Vector3): Vector3 => [-a[0], -a[1], -a[2]];
  // Tangents along the segment's own direction: start tangent toward the t = 0.01 point, end tangent from the t = 0.99 point.
  const along = (tangent: Vector3, step: Vector3 | null): Vector3 => (step && v3len(step) > 0 && v3dot(tangent, step) < 0 ? neg(tangent) : tangent);
  const ends: End[] = segments.flatMap((seg) => {
    const startTangent = along(seg.startTangent, seg.startInnerMm ? sub(seg.startInnerMm, seg.startMm) : null);
    const endTangent = along(seg.endTangent, seg.endInnerMm ? sub(seg.endMm, seg.endInnerMm) : null);
    return [
      { seg, at: seg.startMm, away: startTangent, atStart: true, used: false },
      { seg, at: seg.endMm, away: neg(endTangent), atStart: false, used: false },
    ];
  });
  // The curvature sample at an end is chosen by which end it is (first sample at the start, last at the end), never by
  // distance: on a closed single segment both ends are the same point. The list is taken as reversed only when the segment's
  // own inner points (or, for an open segment, its end points) say so.
  const samplesReversed = (seg: WireSegmentInput, list: CurvatureSampleInput[]): boolean => {
    if (list.length < 2) return false;
    const first = list[0]!.positionMm, last = list[list.length - 1]!.positionMm;
    if (seg.startInnerMm && list.length >= 3) {
      const second = list[1]!.positionMm, penultimate = list[list.length - 2]!.positionMm;
      return dist(penultimate, seg.startInnerMm) < dist(second, seg.startInnerMm);
    }
    if (dist(seg.startMm, seg.endMm) <= meetMm) return false;
    return dist(first, seg.endMm) + dist(last, seg.startMm) < dist(first, seg.startMm) + dist(last, seg.endMm);
  };
  const curvatureAt = (seg: WireSegmentInput, atStart: boolean): Vector3 => {
    const list = samples.get(seg.entityId) ?? [];
    if (list.length === 0) return [0, 0, 0];
    const fromFirst = atStart !== samplesReversed(seg, list);
    return (fromFirst ? list[0]! : list[list.length - 1]!).vectorPerMm;
  };
  const junctions: WireJunctionReport[] = [];
  for (const end of ends) {
    if (end.used) continue;
    const other = ends.find((candidate) => candidate !== end && !candidate.used && candidate.seg !== end.seg && dist(candidate.at, end.at) <= meetMm)
      ?? ends.find((candidate) => candidate !== end && !candidate.used && candidate.seg === end.seg && segments.length === 1 && dist(candidate.at, end.at) <= meetMm);
    if (!other) continue;
    end.used = true; other.used = true;
    const k1 = curvatureAt(end.seg, end.atStart), k2 = curvatureAt(other.seg, other.atStart);
    const diff: Vector3 = [k1[0] - k2[0], k1[1] - k2[1], k1[2] - k2[2]];
    const sum = v3len(k1) + v3len(k2);
    const mismatch = sum === 0 ? 0 : v3len(diff) / sum;
    const tangentAngle = 180 - degreesBetween(end.away, other.away);
    const cls = tangentAngle > tolerances.normalAngleDeg ? "G0" : mismatch > tolerances.relativeCurvature ? "G1" : "G2";
    junctions.push({ atMm: end.at, segmentEntityIds: [end.seg.entityId, other.seg.entityId], curvaturePerMm: [v3len(k1), v3len(k2)], tangentAngleDeg: tangentAngle, relativeCurvatureMismatch: mismatch, class: cls });
  }
  const segmentReports = segments.map((seg) => {
    const list = samples.get(seg.entityId) ?? [];
    const magnitudes = list.map((sample) => v3len(sample.vectorPerMm));
    return { entityId: seg.entityId, lengthMm: seg.lengthMm, minCurvaturePerMm: magnitudes.length ? Math.min(...magnitudes) : 0, maxCurvaturePerMm: magnitudes.length ? Math.max(...magnitudes) : 0, inflections: countInflections(list) };
  });
  return { junctions, segments: segmentReports };
}

// ---------------------------------------------------------------- Organic tools 2 phase B: split edge, one-body bridge ----------------------------------------------------------------
type BodyTopology = Pick<RuntimeState["bodies"][number], "id" | "type" | "faces" | "edges" | "vertices">;
/** Topology entity number of a face or edge ID such as 110e10060 (version 110, entity 10060); stable across edits. */
export const topologyEntity = (id: string): string => { const match = /^\d+[a-z](\d+)$/.exec(id); return match ? match[1]! : id; };

/** Shortest edge piece a split may leave (mm), so no near-zero edge (and no sliver) is made. */
export const SPLIT_EDGE_MIN_PIECE_MM = 0.01;
/** A split vertex must lie this close (mm) to the point evaluated on the edge before the split. */
export const SPLIT_EDGE_POSITION_TOLERANCE_MM = 1e-3;

export interface EdgeSplitRequest { normalizedParameter?: number | undefined; pointMm?: Vector3 | undefined }
/** Exactly one of normalizedParameter (0 < t < 1, fraction of the edge length from its start) and pointMm (finite). */
export function validateEdgeSplitRequest(request: EdgeSplitRequest): { mode: "parameter"; fraction: number } | { mode: "point"; pointMm: Vector3 } {
  const hasT = request.normalizedParameter !== undefined, hasP = request.pointMm !== undefined;
  if (hasT === hasP) throw new Error("Edge split needs exactly one of normalizedParameter and pointMm");
  if (hasT) {
    const t = request.normalizedParameter!;
    if (!(Number.isFinite(t) && t > 0 && t < 1)) throw new Error("Edge split normalizedParameter must be greater than 0 and less than 1");
    return { mode: "parameter", fraction: t };
  }
  const p = request.pointMm!;
  if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) throw new Error("Edge split pointMm must be three finite millimetre coordinates");
  return { mode: "point", pointMm: p };
}

/** Both pieces of an edge split at a length fraction must be at least minPieceMm long. */
export function checkSplitPieces(lengthMm: number, fraction: number, minPieceMm = SPLIT_EDGE_MIN_PIECE_MM): void {
  if (!(Number.isFinite(lengthMm) && lengthMm > 0)) throw new Error("Edge split needs an edge of positive length");
  if (!(fraction > 0 && fraction < 1)) throw new Error(`Edge split point is at an end of the edge (fraction ${fraction}); pick a point inside it`);
  const first = fraction * lengthMm, second = lengthMm - first;
  if (Math.min(first, second) < minPieceMm) {
    throw new Error(`Edge split would leave a piece of ${Number(Math.min(first, second).toPrecision(3))} mm (minimum ${minPieceMm} mm); pick a point farther from the edge ends`);
  }
}

/** Plain-number edge check: one edge of a current Solid or Sheet body. */
export function requireSplitEdge(body: BodyTopology | undefined, bodyId: number, edgeId: string): BodyTopology["edges"][number] {
  if (!body || (body.type !== "Solid" && body.type !== "Sheet")) throw new Error(`Edge split requires a current Solid or Sheet body: ${bodyId}`);
  const edge = body.edges.find((candidate) => candidate.id === edgeId);
  if (!edge) throw new Error(`Stale or unknown edge on body ${bodyId}: ${edgeId}`);
  return edge;
}

/**
 * What a split did, from the body before and after: the new vertex (an ID not in the body before, nearest the expected point)
 * and the edges that meet there. A closed edge without a vertex (a full circle) gets one vertex and stays one edge.
 */
export function splitEdgeOutcome(before: BodyTopology, after: BodyTopology | undefined, expectedMm: Vector3, toleranceMm = SPLIT_EDGE_POSITION_TOLERANCE_MM): { vertexId: number; positionMm: Vector3; deviationMm: number; edgeIds: string[]; closedEdge: boolean; faceCountBefore: number; faceCountAfter: number; edgeCountBefore: number; edgeCountAfter: number; vertexCountBefore: number; vertexCountAfter: number } {
  if (!after) throw new Error(`Body ${before.id} is gone after the edge split`);
  const old = new Set((before.vertices ?? []).map((vertex) => vertex.id));
  const fresh = (after.vertices ?? []).filter((vertex) => !old.has(vertex.id));
  if (fresh.length === 0) throw new Error("The edge split made no new vertex");
  const dist = (a: Vector3, b: Vector3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const vertex = fresh.reduce((best, candidate) => (dist(candidate.positionMm, expectedMm) < dist(best.positionMm, expectedMm) ? candidate : best));
  const deviationMm = dist(vertex.positionMm, expectedMm);
  if (deviationMm > toleranceMm) throw new Error(`The new vertex lies ${deviationMm} mm from the requested point (tolerance ${toleranceMm} mm)`);
  const edgeIds = after.edges.filter((edge) => edge.vertexIds.includes(vertex.id)).map((edge) => edge.id);
  return {
    vertexId: vertex.id, positionMm: vertex.positionMm, deviationMm, edgeIds, closedEdge: edgeIds.length === 1,
    faceCountBefore: before.faces.length, faceCountAfter: after.faces.length, edgeCountBefore: before.edges.length, edgeCountAfter: after.edges.length,
    vertexCountBefore: (before.vertices ?? []).length, vertexCountAfter: (after.vertices ?? []).length,
  };
}

/** Two boundary edges of one Sheet on two different faces (the native bridge blends two faces). */
export function bridgeEdgePair(body: BodyTopology | undefined, bodyId: number, firstEdgeId: string, secondEdgeId: string): { first: { edgeId: string; faceId: string }; second: { edgeId: string; faceId: string } } {
  if (!body || body.type !== "Sheet") throw new Error(`Sheet edge bridge requires a current Sheet body: ${bodyId}`);
  if (firstEdgeId === secondEdgeId) throw new Error("Sheet edge bridge needs two different edges");
  const side = (edgeId: string) => {
    const edge = body.edges.find((candidate) => candidate.id === edgeId);
    if (!edge) throw new Error(`Stale or unknown edge on Sheet ${bodyId}: ${edgeId}`);
    if (edge.faceIds.length !== 1) throw new Error(`Sheet edge bridge needs boundary edges (one face); ${edgeId} has ${edge.faceIds.length}`);
    return { edgeId, faceId: edge.faceIds[0]! };
  };
  const first = side(firstEdgeId), second = side(secondEdgeId);
  if (first.faceId === second.faceId) throw new Error(`Both edges border face ${first.faceId}; the native bridge blends two different faces`);
  return { first, second };
}

/** Faces the bridge made (entities new to the body) and the join edges between a new face and one of the two source faces. */
export function bridgeOutcome(before: BodyTopology, after: BodyTopology | undefined, sourceFaceIds: string[]): { bridgeFaceIds: string[]; joins: Array<{ edgeId: string; faceIds: string[]; sourceFaceId: string }> } {
  if (!after) throw new Error(`Sheet ${before.id} is gone after the bridge`);
  const oldFaces = new Set(before.faces.map((face) => topologyEntity(face.id)));
  const sources = new Set(sourceFaceIds.map(topologyEntity));
  const bridgeFaceIds = after.faces.filter((face) => !oldFaces.has(topologyEntity(face.id))).map((face) => face.id);
  const fresh = new Set(bridgeFaceIds);
  const joins = after.edges
    .filter((edge) => edge.faceIds.length === 2 && edge.faceIds.some((faceId) => fresh.has(faceId)) && edge.faceIds.some((faceId) => sources.has(topologyEntity(faceId))))
    .map((edge) => ({ edgeId: edge.id, faceIds: edge.faceIds, sourceFaceId: edge.faceIds.find((faceId) => sources.has(topologyEntity(faceId)))! }));
  return { bridgeFaceIds, joins };
}

/** Advice for a native Surface Bridge (FaceBlend) failure, from the live probes on 26.1.3. */
export const BRIDGE_FAILURE_ADVICE = "The native bridge is a G2 face blend between the two faces' surfaces: widthMm is the distance between its two contact lines, it lies on the side the face normals point to, and it trims both faces back. It fails (PK_FACE_make_blend 17452/17453, PK_ERROR_fxf_blend_failed 1080) when a contact line falls outside its face (width too small or too large for the angle between the faces), when the faces point away from each other, or when the blend runs into another face of the Sheet; two separate Sheets fail the same way. Try another widthMm, or plasticity_reverse_sheets on a face, or bridge curves and patch instead.";
