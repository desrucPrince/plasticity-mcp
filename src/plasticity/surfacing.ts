// Surfacing verify-and-refine helpers: exact point reads on curved bodies (plasticity_probe_surface),
// exact-bounds reasoning for NURBS bodies, and small pure helpers shared by the surfacing tools.
// Probe evidence: discovery/probes-2026-11-surfacing/FINDINGS.md (Plasticity 26.1.3).
import { nativeFunction } from "./native-function.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

export type Vector3 = [number, number, number];

export const PROBE_SURFACE_MAX_RAYS = 64;
/** A Newton hit is accepted when the kernel's closest face point lies within this distance of the ray point. */
export const PROBE_SURFACE_ACCEPT_RESIDUAL_MM = 1e-6;
/** Two hits closer than this along the ray, on any faces, are one crossing (a ray through an edge or vertex). */
export const PROBE_SURFACE_MERGE_MM = 1e-6;
/** Rays from gridMm start this far outside the body's conservative bounds. */
export const PROBE_SURFACE_GRID_CLEARANCE_MM = 1;

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
export interface NativeProbeRay { hits: NativeProbeHit[]; unresolved: number }
export interface NativeProbeResult { undoBefore: number; undoAfter: number; bodyCountBefore: number; bodyCountAfter: number; rays: NativeProbeRay[] }

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

/** Native metres to the reply's millimetres; merge crossings that coincide on several faces. */
export function projectProbeRay(ray: ProbeRay & { atMm?: [number, number] }, native: NativeProbeRay): ProbeRayResult {
  const sorted = [...native.hits].sort((a, b) => a.t - b.t);
  const intersections: ProbeIntersection[] = [];
  for (const hit of sorted) {
    const distanceMm = hit.t * 1000;
    const previous = intersections.at(-1);
    if (previous && Math.abs(previous.distanceMm - distanceMm) <= PROBE_SURFACE_MERGE_MM) {
      if (previous.faceId !== hit.faceId && !(previous.otherFaceIds ?? []).includes(hit.faceId)) previous.otherFaceIds = [...(previous.otherFaceIds ?? []), hit.faceId];
      continue;
    }
    intersections.push({
      pointMm: roundVector(hit.point.map((value) => value * 1000), 9),
      faceId: hit.faceId,
      normal: roundVector(hit.normal, 12),
      distanceMm: roundTo(distanceMm, 9),
      ...(hit.uCurvature !== null && Number.isFinite(hit.uCurvature) ? { uCurvaturePerMm: roundTo(hit.uCurvature / 1000, 12) } : {}),
      ...(hit.vCurvature !== null && Number.isFinite(hit.vCurvature) ? { vCurvaturePerMm: roundTo(hit.vCurvature / 1000, 12) } : {}),
      residualMm: roundTo(hit.residual * 1000, 12),
    });
  }
  return {
    originMm: ray.originMm,
    direction: roundVector(ray.direction, 12),
    ...(ray.atMm ? { atMm: ray.atMm } : {}),
    hits: intersections.length,
    intersections,
    ...(native.unresolved > 0 ? { unresolvedCrossings: native.unresolved } : {}),
  };
}

// Renderer source. Rays in metres with unit directions. Per face: seeds from the display mesh (Moller-Trumbore, a
// slightly widened triangle) and from the kernel surface's own Raycast; every seed is then solved on the exact kernel
// face by Newton steps along the ray (Face.FindPointNear gives the closest trimmed-face point, Face.EvalBasis its
// normal). Only a point whose kernel residual is within acceptResidualM is returned. The mesh never supplies a value.
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
  // Kernel face wrappers are never freed by Plasticity's binding, so a face is wrapped only when a ray can reach it:
  // its display-mesh box (fg.bboxes, 6 floats per face), widened by the mesh's chord error, must meet the ray.
  const boxes = group.bboxes;
  const faces = [];
  for (let index = 0; index < group.versionIds.length; index += 1) {
    const min = [boxes[6 * index], boxes[6 * index + 1], boxes[6 * index + 2]], max = [boxes[6 * index + 3], boxes[6 * index + 4], boxes[6 * index + 5]];
    const pad = args.boxMarginM + 0.02 * Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    faces.push({ id: String(group.versionIds[index]), entityId: Number(group.get(index).entityId), start: group.groups[2 * index], count: group.groups[2 * index + 1],
      min: min.map(v => v - pad), max: max.map(v => v + pad), kernel: null });
  }
  const kernelFace = entry => {
    if (entry.kernel) return entry.kernel;
    const collection = nativeApi.db.lookupFaceCollection([entry.id]);
    const face = collection?.Size?.() === 1 ? collection.Get(0) : null;
    if (!face || Number(face.Id()) !== entry.entityId) throw new Error('Display face ' + entry.id + ' has no kernel face');
    entry.kernel = face;
    return face;
  };
  const reaches = (entry, o, d) => {
    let low = -args.seedBehindM, high = Infinity;
    for (let axis = 0; axis < 3; axis += 1) {
      if (Math.abs(d[axis]) < 1e-15) { if (o[axis] < entry.min[axis] || o[axis] > entry.max[axis]) return false; continue; }
      let t1 = (entry.min[axis] - o[axis]) / d[axis], t2 = (entry.max[axis] - o[axis]) / d[axis];
      if (t1 > t2) [t1, t2] = [t2, t1];
      low = Math.max(low, t1); high = Math.min(high, t2);
      if (low > high) return false;
    }
    return true;
  };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const K = p => new kernel.Vector(p[0], p[1], p[2]);
  const read = v => [Number(v.x), Number(v.y), Number(v.z)];
  const rays = args.rays.map(ray => {
    const o = ray.origin, d = ray.direction;
    const at = t => [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]];
    const seeds = [];
    faces.forEach((entry, faceIndex) => {
      if (!reaches(entry, o, d)) return;
      for (let j = entry.start; j < entry.start + entry.count; j += 3) {
        const a = vertex(indices ? indices[j] : j), b = vertex(indices ? indices[j + 1] : j + 1), c = vertex(indices ? indices[j + 2] : j + 2);
        const e1 = sub(b, a), e2 = sub(c, a), p = cross(d, e2), det = dot(e1, p);
        if (Math.abs(det) < 1e-20) continue;
        const s = sub(o, a), u = dot(s, p) / det;
        if (u < -args.margin || u > 1 + args.margin) continue;
        const q = cross(s, e1), v = dot(d, q) / det;
        if (v < -args.margin || u + v > 1 + args.margin) continue;
        const t = dot(e2, q) / det;
        if (t < -args.seedBehindM) continue;
        seeds.push({ faceIndex, t, strict: u >= 0 && v >= 0 && u + v <= 1 && t >= 0 });
      }
      try {
        const hit = kernelFace(entry).GetSurface().surface.Raycast(K(o), K(d));
        if (hit?.exact) {
          const point = read(hit.exact), t = dot(sub(point, o), d);
          if (Math.hypot(...sub(point, at(t))) <= args.acceptResidualM && t >= -args.seedBehindM) seeds.push({ faceIndex, t, strict: false });
        }
      } catch (error) { /* the surface raycast is only a seed; the mesh seeds stand alone */ }
    });
    const hits = [], failed = [];
    for (const seed of seeds) {
      const entry = faces[seed.faceIndex];
      let t = seed.t, residual = Infinity, basis = null, settled = false;
      try {
        entry.face = kernelFace(entry);
        for (let step = 0; step < args.maxSteps; step += 1) {
          const p = at(t);
          const near = entry.face.FindPointNear(K(p));
          const r = sub(read(near.exact), p);
          residual = Math.hypot(...r);
          basis = entry.face.EvalBasis(near.u, near.v);
          if (residual <= args.convergedM) { settled = true; break; }
          const n = read(basis.normal), den = dot(n, d);
          if (Math.abs(den) < 1e-9) break;
          const dt = dot(n, r) / den;
          t += dt;
          if (Math.abs(dt) < 1e-15) {
            const near2 = entry.face.FindPointNear(K(at(t)));
            residual = Math.hypot(...sub(read(near2.exact), at(t)));
            basis = entry.face.EvalBasis(near2.u, near2.v);
            settled = true; break;
          }
        }
      } catch (error) { settled = false; }
      if (!settled || !(residual <= args.acceptResidualM) || t < -args.acceptResidualM) { if (seed.strict) failed.push(seed.t); continue; }
      if (hits.some(hit => hit.faceId === entry.id && Math.abs(hit.t - t) <= args.mergeM)) continue;
      hits.push({ t: Math.max(t, 0), point: at(Math.max(t, 0)), faceId: entry.id, normal: read(basis.normal),
        uCurvature: Number.isFinite(Number(basis.uCurvature)) ? Number(basis.uCurvature) : null,
        vCurvature: Number.isFinite(Number(basis.vCurvature)) ? Number(basis.vCurvature) : null, residual });
    }
    // A strict mesh crossing that no exact hit explains (within the mesh's own chord tolerance) is reported, not hidden.
    const unresolved = failed.filter(t => !hits.some(hit => Math.abs(hit.t - t) <= args.coverM)).length;
    return { hits, unresolved };
  });
  const undoAfter = this.history.undoStack.length, bodyCountAfter = countBodies();
  if (undoAfter !== undoBefore || bodyCountAfter !== bodyCountBefore) throw new Error('The surface probe changed the document; reconcile before continuing');
  return { undoBefore, undoAfter, bodyCountBefore, bodyCountAfter, rays };
}`;

export async function probeSurface(runtime: PlasticityRuntime, state: RuntimeState, request: ProbeSurfaceRequest): Promise<ProbeSurfaceEvidence> {
  const body = state.bodies.find((candidate) => candidate.id === request.id);
  if (!body || (body.type !== "Solid" && body.type !== "Sheet")) throw new Error(`Unknown current Solid or Sheet body ID: ${request.id}`);
  const rays = resolveProbeRays(request, body);
  const native = await runtime.readNative<NativeProbeResult>(PROBE_SURFACE_SOURCE, ["pk_default"], [{
    bodyId: body.id,
    rays: rays.map((ray) => ({ origin: ray.originMm.map((value) => value / 1000), direction: ray.direction })),
    margin: 0.05,
    boxMarginM: 5e-4,
    seedBehindM: 1e-4,
    maxSteps: 60,
    convergedM: 1e-13,
    acceptResidualM: PROBE_SURFACE_ACCEPT_RESIDUAL_MM / 1000,
    mergeM: 1e-7,
    coverM: 5e-4,
  }]);
  if (!Array.isArray(native?.rays) || native.rays.length !== rays.length) throw new Error("Native surface probe returned an unexpected result shape");
  if (native.undoAfter !== native.undoBefore || native.bodyCountAfter !== native.bodyCountBefore) throw new Error("The surface probe changed the document; reconcile before continuing");
  return {
    id: body.id,
    bodyType: body.type,
    revision: state.revision,
    source: "native-brep-ray-newton",
    acceptResidualMm: PROBE_SURFACE_ACCEPT_RESIDUAL_MM,
    rays: rays.map((ray, index) => projectProbeRay(ray, native.rays[index]!)),
    note: "Each point is solved on the exact kernel face (closest-point Newton steps along the ray); residualMm is the kernel distance from the point to that face. normal is the face normal (outward on a Solid). Curvatures are the kernel's normal curvatures along the face's u and v directions, signed by the surface parametrisation; compare magnitudes. Hits are seeded from the display mesh and the kernel surface raycast, so a ray that only grazes a face tangentially can be missed; unresolvedCrossings counts mesh crossings no exact hit explains.",
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
  const advice = XNURBS_ERROR_ADVICE[code] ?? "this code is undecoded on Plasticity 26.1.3. Check the boundary edges form one loop and try a lower continuity.";
  const explained = new Error(`${error.message.replace(/\.?\s*$/, "")}. XNurbs error ${code}: ${advice}`);
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

export interface ScreenshotViewApplied { undoDepth: number; previousShader: string | null; shader: string | null; framed: boolean; cameraBefore: CameraPose | null }
export interface ScreenshotViewRestored { restored: boolean; undoDepth: number; shader: string | null; cameraAfter: CameraPose | null; cameraDeviation: number | null }
export interface CameraPose { position: Vector3; target: Vector3; quaternion: [number, number, number, number]; zoom: number }

// The pending view change lives on the renderer's global object under one symbol, so a crashed call is undone by the next.
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
  const settle = async () => {
    viewport.setNeedsRender();
    const frame = () => new Promise(resolve => { let done = false; const finish = () => { if (!done) { done = true; resolve(); } };
      try { requestAnimationFrame(finish); } catch { finish(); } setTimeout(finish, 250); });
    // Six frames: a framed capture after three frames differed from a later one in about 3,000 scattered model pixels
    // (mean abs diff 0.07) in one live run; the extra frames are cheap (about 100 ms).
    for (let index = 0; index < (args.settleFrames ?? 6); index += 1) await frame();
  };
  const restore = async () => {
    const saved = globalThis[key];
    if (!saved) return { restored: false, undoDepth: this.history.undoStack.length, shader: shaderName(shading.saveToMemento()), cameraAfter: pose(), cameraDeviation: null };
    try {
      if (saved.shading) shading.restoreFromMemento(saved.shading);
      if (saved.camera) {
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
    let deviation = null;
    if (saved.camera) {
      const before = saved.camera.pose;
      deviation = Math.max(...before.position.map((v, i) => Math.abs(v - after.position[i])), ...before.target.map((v, i) => Math.abs(v - after.target[i])),
        ...before.quaternion.map((v, i) => Math.min(Math.abs(v - after.quaternion[i]), Math.abs(v + after.quaternion[i]))), Math.abs(after.zoom / before.zoom - 1));
    }
    return { restored: true, undoDepth: this.history.undoStack.length, shader: shaderName(shading.saveToMemento()), cameraAfter: after, cameraDeviation: deviation };
  };
  if (args.op === 'restore') return await restore();
  if (globalThis[key]) await restore(); // a crashed call left its change: undo it before anything else
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
    }
    await settle();
  } catch (error) {
    await restore();
    throw error;
  }
  return { undoDepth, previousShader: shaderName(memento), shader: material ? shaderName(shading.saveToMemento()) : null, framed: Boolean(box), cameraBefore };
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
 * Undo depth must not change, and the camera must come back within CAMERA_RESTORE_TOLERANCE, or the call fails.
 */
export async function withScreenshotView<T extends object>(runtime: PlasticityRuntime, options: ScreenshotViewOptions, capture: () => Promise<T>): Promise<T & { view: { shader?: { mode: string; previous: string | null; restored: string | null }; frame?: { bodyIds: number[]; cameraRestored: true; cameraDeviation: number } } }> {
  const args = { op: "apply", ...(options.shader ? { shader: options.shader } : {}), ...(options.frame ? { frame: { bodyIds: options.frame.bodyIds } } : {}) };
  const applied = await runtime.readNative<ScreenshotViewApplied>(SCREENSHOT_VIEW_SOURCE, ["name2shader"], [{ ...args, tolerance: CAMERA_RESTORE_TOLERANCE }], 15_000);
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
    restored = await runtime.readNative<ScreenshotViewRestored>(SCREENSHOT_VIEW_SOURCE, ["name2shader"], [{ op: "restore", tolerance: CAMERA_RESTORE_TOLERANCE }], 15_000);
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
  if (options.frame && !(restored.cameraDeviation !== null && restored.cameraDeviation <= CAMERA_RESTORE_TOLERANCE)) {
    throw new Error(`The camera did not come back exactly after framing (deviation ${String(restored.cameraDeviation)})`);
  }
  return {
    ...captured!,
    view: {
      ...(options.shader ? { shader: { mode: options.shader, previous: applied.previousShader, restored: restored.shader } } : {}),
      ...(options.frame ? { frame: { bodyIds: options.frame.bodyIds, cameraRestored: true as const, cameraDeviation: restored.cameraDeviation! } } : {}),
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
