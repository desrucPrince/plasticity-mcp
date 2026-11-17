import assert from "node:assert/strict";
import test from "node:test";

import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";
import { PROBE_SURFACE_COLLECT_ABOVE_MB, PROBE_SURFACE_HEAP_CHECK_EVERY_RAYS, PROBE_SURFACE_UNRESOLVED_CODES, probeOddParityReason, probeSurface, projectProbeRay, type NativeProbeRay, type ProbeRayResult } from "./surfacing.ts";

// plasticity_probe_surface, final review (P1-P5): the real native source runs against stub kernels with exact geometry.
// The stubs give the two kernel reads the source uses, as measured live on Plasticity 26.1.3:
//  - the range read (Eval.DistancesToPoints on a face): the global distance to the TRIMMED face; it reads 0 within 1e-8 m.
//  - the nearest-point read (Face.FindPointNear): precise, but it may throw (a stub option).
// Units: kernel metres; rays and assertions in millimetres.

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V) => Math.hypot(...a);
// A zero vector has no direction: +x, so a stub face has a nearest point for its own centre or axis too (the kernel always answers).
const unit = (a: V): V => (len(a) > 0 ? mul(a, 1 / len(a)) : [1, 0, 0]);

class KVector { x: number; y: number; z: number; constructor(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } }
const K = (p: V) => new KVector(...p);

/** One stub face: the exact nearest point on the trimmed face with the face normal there. */
interface StubFace {
  kind: string;
  nearest(p: V): { q: V; n: V };
  /** Analytic surface data (GetInfo, GetPoint, uv box) for the closed-form path; absent for a B-spline face. */
  analytic?: { info: unknown; uv: [number, number, number, number]; point(u: number, v: number): V; curvature?: (u: number, v: number) => { normal: V; curvature1: number; curvature2: number } };
  /** Display-mesh box (metres). */
  box: [V, V];
  /** The nearest-point read throws when this returns true. */
  nearestThrows?: (p: V) => boolean;
  /** The nearest-point read answers with this instead of the true nearest point (a read that is off). */
  nearestWrong?: (p: V) => { q: V; n: V };
  /** The range read throws for this face (the whole kernel call fails when the face is part of it). */
  rangeThrows?: boolean;
}

function runtimeFor(faces: StubFace[], type: "Solid" | "Sheet", boundsMm: { min: V; max: V }) {
  const normals = new Map<number, V>();
  let next = 1;
  const remember = (n: V) => { const key = next++; normals.set(key, n); return key; };
  const stats = { rangeCalls: 0, rangePoints: 0, nearestCalls: 0 };
  const kernelFaces = faces.map((face, index) => ({
    Id: () => 700 + index,
    GetSurface: () => {
      if (!face.analytic) return { surface: { constructor: { name: face.kind } } };
      const a = face.analytic;
      const surface = { constructor: { name: face.kind }, GetInfo: a.info === undefined ? undefined : () => a.info, GetPoint: (u: number, v: number) => K(a.point(u, v)),
        EvalCurvature: (u: number, v: number) => { const k = a.curvature!(u, v); return { normal: K(k.normal), curvature1: k.curvature1, curvature2: k.curvature2 }; } };
      return { surface, orientation: true, uMin: a.uv[0], uMax: a.uv[1], vMin: a.uv[2], vMax: a.uv[3] };
    },
    FindPointNear: (p: KVector) => {
      stats.nearestCalls += 1;
      const at: V = [p.x, p.y, p.z];
      if (face.nearestThrows?.(at)) throw new Error("");
      const { q, n } = (face.nearestWrong ?? face.nearest)(at);
      return { u: remember(n), v: 0, exact: K(q) };
    },
    EvalBasis: (u: number) => ({ normal: K(normals.get(u)!), uCurvature: 0, vCurvature: 0 }),
  }));
  class Eval {
    DistancesToPoints(ids: Int32Array, xyz: Float64Array, offsets: Int32Array) {
      stats.rangeCalls += 1;
      const count = offsets[ids.length]!;
      stats.rangePoints += count;
      const distances = new Float64Array(count), nearests = new Float64Array(3 * count), params = new Float64Array(2 * count), errors = new Int32Array(count);
      ids.forEach((id, i) => {
        const face = faces[id - 700]!;
        if (face.rangeThrows) throw new Error("PK_ERROR_stub");
        for (let k = offsets[i]!; k < offsets[i + 1]!; k += 1) {
          const p: V = [xyz[3 * k]!, xyz[3 * k + 1]!, xyz[3 * k + 2]!], { q, n } = face.nearest(p), d = len(sub(p, q));
          // The kernel reads 0 within its resolution (1e-8 m), with the point itself as the nearest point.
          distances[k] = d <= 1e-8 ? 0 : d; nearests.set(d <= 1e-8 ? p : q, 3 * k); params.set([remember(n), 0], 2 * k);
        }
      });
      return { distances, nearests, params, errors, ok: count };
    }
  }
  const versionIds = faces.map((_, index) => `9f${index}`);
  class Solid {}
  class Sheet {}
  const view = Object.assign(type === "Solid" ? new Solid() : new Sheet(), { high: { faces: {
    versionIds, groups: faces.flatMap(() => [0, 0]), bboxes: Float32Array.from(faces.flatMap((face) => [...face.box[0], ...face.box[1]])),
    get: (index: number) => ({ entityId: 700 + index }),
    mesh: { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, geometry: { attributes: { position: { array: new Float32Array(0) } }, index: null } },
  } } });
  const editor = {
    history: { undoStack: { length: 0 } },
    geo: { geometryModel: new Map([[19, { view, model: {} }]]), automatics: new Set() },
    db: { lookupStableId: (versionId: number) => (versionId === 19 ? 9 : undefined), lookupFaceCollection: (ids: string[]) => ({ Size: () => 1, Get: () => kernelFaces[versionIds.indexOf(ids[0]!)] }), commit() {} },
  };
  const runtime = {
    async readNative(source: string, _bindings: string[], values: unknown[]) {
      const execute = new Function(`return (${source})`)() as (...args: unknown[]) => unknown;
      return execute.apply(editor, [{ a: { Vector: KVector, Eval, Context: { Get: () => ({}) } } }, ...values]);
    },
  } as unknown as PlasticityRuntime;
  const state = { revision: "r1", bodies: [{ id: 9, versionId: 19, type, name: "b", boundsMm, faceIds: versionIds, edgeIds: [], faces: [], edges: [] }] } as unknown as RuntimeState;
  return { runtime, state, stats };
}

const flagged = (ray: ProbeRayResult) => ray.unresolvedCrossings !== undefined || ray.grazing !== undefined;
const distances = (ray: ProbeRayResult) => ray.intersections.map((hit) => hit.distanceMm);

// ---------------------------------------------------------------- the reviewer's sheet ----------------------------------------------------------------
// z = 27 u (1 - u), u = (x - 6000) / 60, x in [6000, 6060], y in [0, 30] (mm): the extruded control-point curve of the review.
const X0 = 6, W = 0.06, H = 0.03, A = 0.027; // metres
const zOf = (x: number) => { const u = (x - X0) / W; return A * u * (1 - u); };
const slopeOf = (x: number) => A * (1 - 2 * (x - X0) / W) / W;
function nearestOnSheet(p: V): { q: V; n: V } {
  // Nearest point of the parabola arc to (px, pz): the roots of g(x) = (x - px) + (z(x) - pz) z'(x), a cubic, plus the ends.
  const g = (x: number) => (x - p[0]) + (zOf(x) - p[2]) * slopeOf(x);
  const dg = (x: number) => 1 + slopeOf(x) ** 2 + (zOf(x) - p[2]) * (-2 * A / (W * W));
  const d2 = (x: number) => (x - p[0]) ** 2 + (zOf(x) - p[2]) ** 2;
  let best = X0;
  for (const x of [X0, X0 + W]) if (d2(x) < d2(best)) best = x;
  for (let i = 0; i <= 12; i += 1) {
    let x = X0 + W * i / 12;
    for (let it = 0; it < 60; it += 1) { const step = g(x) / dg(x); if (!Number.isFinite(step)) break; x -= step; if (Math.abs(step) < 1e-18) break; }
    if (x >= X0 && x <= X0 + W && d2(x) < d2(best)) best = x;
  }
  const s = slopeOf(best);
  return { q: [best, Math.min(H, Math.max(0, p[1])), zOf(best)], n: unit([-s, 0, 1]) };
}
const sheetFace = (extra: Partial<StubFace> = {}): StubFace => ({ kind: "BSurf", nearest: nearestOnSheet, box: [[X0, 0, 0], [X0 + W, H, A / 4]], ...extra });
const sheetBounds = { min: [6000, 0, 0] as V, max: [6060, 30, 9] as V };
/** Closed form: the distances along the ray (mm) where it crosses the trimmed sheet. */
function sheetTruth(o: V, d: V): number[] {
  const u0 = (o[0] - 6000) / 60, du = d[0] / 60;
  // z0 + t dz = 27 (u0 + t du)(1 - u0 - t du)
  const a = 27 * du * du, b = d[2] - 27 * du * (1 - 2 * u0), c = o[2] - 27 * u0 * (1 - u0);
  let roots: number[] = [];
  if (Math.abs(a) < 1e-15) { if (Math.abs(b) > 1e-15) roots = [-c / b]; }
  else { const disc = b * b - 4 * a * c; if (disc > 0) { const q = -0.5 * (b + Math.sign(b || 1) * Math.sqrt(disc)); roots = [q / a, c / q]; } }
  return roots.filter((t) => { const x = o[0] + t * d[0], y = o[1] + t * d[1]; return t > 0 && x >= 6000 && x <= 6060 && y >= 0 && y <= 30; }).sort((p, q) => p - q);
}
const probeSheet = async (rays: Array<{ originMm: V; direction: V }>, extra: Partial<StubFace> = {}) => {
  const { runtime, state, stats } = runtimeFor([sheetFace(extra)], "Sheet", sheetBounds);
  return { rays: (await probeSurface(runtime, state, { id: 9, rays })).rays, stats };
};

test("P1: a close pair of crossings on a B-spline face gives two hits (0.01, 0.1, 0.5, 0.89 mm apart), straight and oblique", async () => {
  for (const separation of [0.01, 0.1, 0.5, 0.89]) {
    const h = 27 * (separation / 120) ** 2; // a chord `separation` long lies h below the crest at z = 6.75
    const straight = { originMm: [5990, 15, 6.75 - h] as V, direction: [1, 0, 0] as V };
    const oblique = { originMm: [5990, 2, 6.75 - h] as V, direction: unit([Math.cos(0.3), Math.sin(0.3), 0]) };
    const { rays } = await probeSheet([straight, oblique]);
    for (const [index, ray] of rays.entries()) {
      const input = index === 0 ? straight : oblique, truth = sheetTruth(input.originMm, input.direction);
      assert.equal(truth.length, 2);
      assert.ok(Math.abs(truth[1]! - truth[0]! - separation / (index === 0 ? 1 : Math.cos(0.3))) < 1e-6, `fixture: ${truth}`);
      // The criterion: two hits or a flag. This search gives both hits every time, at the closed-form places.
      assert.ok(ray.hits === 2 || flagged(ray), `${separation} mm: ${JSON.stringify(ray)}`);
      assert.equal(ray.hits, 2, `${separation} mm: ${JSON.stringify(ray)}`);
      distances(ray).forEach((got, k) => assert.ok(Math.abs(got - truth[k]!) < 1e-6, `${separation} mm: ${got} vs ${truth[k]}`));
      for (const hit of ray.intersections) assert.ok(hit.residualMm <= 1e-6);
      assert.equal(ray.unresolvedCrossings, undefined);
      // A pair less than 0.001 mm deep is a tangent pair: flagged in grazing, with both crossings kept. 0.89 mm apart is 0.0015 mm deep: clean.
      assert.equal(ray.grazing !== undefined, h < 1e-3, `${separation} mm, depth ${h}: ${JSON.stringify(ray.grazing)}`);
    }
  }
});

test("P1: the reviewer's ray (1 hit at d1f9898) returns both crossings, 61.617 and 62.381 mm", async () => {
  const { rays } = await probeSheet([{ originMm: [5970.77, 7.3, 6.749], direction: unit([0.955336, 0.29552, 0]) }]);
  assert.equal(rays[0]!.hits, 2, JSON.stringify(rays[0]));
  assert.ok(Math.abs(distances(rays[0]!)[0]! - 61.617) < 1e-3 && Math.abs(distances(rays[0]!)[1]! - 62.381) < 1e-3, String(distances(rays[0]!)));
});

test("P1: a tangent ray is flagged grazing with no hit; a ray along a ruling of the face is flagged grazing", async () => {
  const { rays } = await probeSheet([
    { originMm: [5990, 15, 6.75], direction: [1, 0, 0] },      // touches the crest
    { originMm: [6030, -20, 6.75], direction: [0, 1, 0] },     // lies in the face along the crest ruling
    { originMm: [5990, 15, 6.7505], direction: [1, 0, 0] },    // 0.0005 mm above the crest
    { originMm: [5990, 15, 6.752], direction: [1, 0, 0] },     // 0.002 mm above: clear
  ]);
  assert.equal(rays[0]!.hits, 0);
  assert.equal(rays[0]!.grazing?.length, 1);
  assert.equal(rays[1]!.hits, 0);
  assert.equal(rays[1]!.grazing?.length, 1, JSON.stringify(rays[1]));
  assert.equal(rays[2]!.hits, 0);
  assert.ok(Math.abs(rays[2]!.grazing![0]!.minDistanceMm - 5e-4) < 1e-6, JSON.stringify(rays[2]));
  assert.equal(flagged(rays[3]!), false);
  assert.equal(rays[3]!.hits, 0);
});

test("P1: 1,024 random and near-tangent rays against the closed form: no unflagged wrong count", async () => {
  let seed = 0x1234567;
  const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rdir = (): V => { for (;;) { const v: V = [2 * rnd() - 1, 2 * rnd() - 1, 2 * rnd() - 1]; const n = len(v); if (n > 0.05 && n <= 1) return mul(v, 1 / n); } };
  const centre: V = [6030, 15, 3.4];
  let compared = 0, wrongFlagged = 0, pairs = 0;
  for (let batch = 0; batch < 16; batch += 1) {
    const inputs = Array.from({ length: 64 }, (_, i) => {
      if (i % 2 === 0) { const o = add(centre, mul(rdir(), 85)); return { originMm: o, direction: unit(sub(add(centre, mul(rdir(), 30 * Math.cbrt(rnd()))), o)) }; }
      // near-tangent: a surface point, a tangent direction, offset along the normal by 1e-7 .. 0.3 mm on either side
      const x = 6000 + 60 * rnd(), y = 30 * rnd(), s = 27 * (1 - 2 * (x - 6000) / 60) / 60, n = unit([-s, 0, 1]), a = rnd() * 2 * Math.PI;
      const tau = unit(add(mul(unit([1, 0, s]), Math.cos(a)), mul([0, 1, 0], Math.sin(a)))), delta = (rnd() < 0.5 ? 1 : -1) * 10 ** (-7 + 6.5 * rnd());
      return { originMm: sub(add([x, y, 27 * ((x - 6000) / 60) * (1 - (x - 6000) / 60)], mul(n, delta)), mul(tau, 85)), direction: tau };
    });
    const { rays } = await probeSheet(inputs);
    rays.forEach((ray, index) => {
      const truth = sheetTruth(inputs[index]!.originMm, inputs[index]!.direction);
      // Not a fair count test: a crossing within 0.0001 mm of the face boundary.
      if (truth.some((t) => { const x = inputs[index]!.originMm[0] + t * inputs[index]!.direction[0], y = inputs[index]!.originMm[1] + t * inputs[index]!.direction[1]; return Math.min(x - 6000, 6060 - x, y, 30 - y) < 1e-4; })) return;
      compared += 1;
      if (truth.length === 2 && truth[1]! - truth[0]! < 1) pairs += 1;
      if (ray.hits !== truth.length) { assert.ok(flagged(ray), `unflagged wrong count: ${JSON.stringify({ input: inputs[index], truth, ray })}`); wrongFlagged += 1; }
      else distances(ray).forEach((got, k) => assert.ok(Math.abs(got - truth[k]!) * Math.abs(dot(ray.intersections[k]!.normal as V, inputs[index]!.direction)) < 1e-6));
    });
  }
  assert.ok(compared > 900 && pairs > 20, `${compared} compared, ${pairs} close pairs`);
  assert.ok(wrongFlagged <= compared * 0.02, `${wrongFlagged} flagged-but-wrong of ${compared}`);
});

test("P3: the nearest-point read throwing off the face does not lose the call; a face it fails on at a crossing is flagged, with a code", async () => {
  // Live, Face.FindPointNear threw for many points beside a blend face. Here it throws for every point more than 0.2 mm from the face.
  const far = (p: V) => len(sub(p, nearestOnSheet(p).q)) > 2e-4;
  const rays = [{ originMm: [6010, 10, 60] as V, direction: [0, 0, -1] as V }, { originMm: [5990, 15, 6.75 - 27 * (0.89 / 120) ** 2] as V, direction: [1, 0, 0] as V }];
  const ok = await probeSheet(rays, { nearestThrows: far });
  assert.deepEqual(ok.rays.map((ray) => ray.hits), [1, 2]);
  assert.equal(ok.rays.some(flagged), false);
  // It throws everywhere: the range read still locates the crossing, which then cannot be confirmed: flagged, never thrown.
  const broken = await probeSheet(rays, { nearestThrows: () => true });
  for (const ray of broken.rays) {
    assert.equal(ray.hits, 0);
    assert.equal(ray.unresolvedCrossings, 1);
    assert.equal(ray.unresolvedCode, "kernel-error");
    assert.deepEqual(ray.unresolvedFaceIds, ["9f0"]);
    assert.match(ray.unresolvedReason ?? "", /^face 9f0 is not settled for this ray: kernel error/);
  }
});

test("P3: a crossing the range read puts on the face while the nearest-point read is off is flagged bracket-unresolved, never returned", async () => {
  // The nearest-point read answers 0.001 mm off the sphere: its residual is too large to accept the closed-form crossing.
  const off = (p: V) => { const n = unit(p); return { q: mul(n, 0.02 + 1e-6), n }; };
  const { runtime, state } = runtimeFor([{ ...sphereFace(0.02), nearestWrong: off }], "Solid", ballBounds);
  const [ray] = (await probeSurface(runtime, state, { id: 9, rays: [{ originMm: [3, 4, 100], direction: [0, 0, -1] }] })).rays;
  assert.equal(ray!.hits, 0);
  assert.equal(ray!.unresolvedCode, "bracket-unresolved");
  assert.deepEqual(ray!.unresolvedCodes, ["bracket-unresolved"]);
  assert.deepEqual(ray!.unresolvedFaceIds, ["9f0"]);
  assert.match(ray!.unresolvedReason ?? "", /^face 9f0 is not settled for this ray: the range read puts a crossing on the face, the nearest-point read does not confirm it$/);
});

// ---------------------------------------------------------------- a closed Solid of two faces ----------------------------------------------------------------
// A sphere of radius 20 mm at the origin, split at z = 0 into an upper and a lower hemisphere face (trimmed analytic faces).
const R = 0.02;
const hemisphere = (upper: boolean, extra: Partial<StubFace> = {}): StubFace => ({
  kind: "Sphere",
  nearest: (p) => {
    const n = unit(p);
    if ((upper ? n[2] : -n[2]) >= 0) return { q: mul(n, R), n };
    const e = unit([p[0], p[1], 0]);
    return { q: mul(e, R), n: e };
  },
  analytic: { info: { radius: R, basis: { Location: K([0, 0, 0]), Axis: K([0, 0, 1]) } }, uv: [0, 2 * Math.PI, upper ? 0.2 : -1.4, upper ? 1.4 : -0.2],
    point: (u, v) => [R * Math.cos(v) * Math.cos(u), R * Math.cos(v) * Math.sin(u), R * Math.sin(v)] },
  box: upper ? [[-R, -R, 0], [R, R, R]] : [[-R, -R, -R], [R, R, 0]],
  ...extra,
});
const ballBounds = { min: [-20, -20, -20] as V, max: [20, 20, 20] as V };
const probeBall = async (rays: Array<{ originMm: V; direction: V }>, upper: Partial<StubFace> = {}, lower: Partial<StubFace> = {}) => {
  const { runtime, state } = runtimeFor([hemisphere(true, upper), hemisphere(false, lower)], "Solid", ballBounds);
  return (await probeSurface(runtime, state, { id: 9, rays })).rays;
};

test("P1 parity: the whole line is checked, so an origin inside the bounds box needs no special case", async () => {
  const rays = await probeBall([
    { originMm: [15, 15, 15], direction: unit([-1, -1, -1]) },   // inside the box, outside the ball: in, out
    { originMm: [0, 0, 5], direction: [0, 0, 1] },               // inside the ball: one exit ahead, one entry behind
    { originMm: [15, 15, 15], direction: unit([1, 1, 1]) },      // inside the box, leaving: nothing ahead, in and out behind
    { originMm: [0, 0, 100], direction: [0, 0, -1] },            // outside the box
  ]);
  assert.deepEqual(rays.map((ray) => ray.hits), [2, 1, 0, 2]);
  for (const ray of rays) assert.equal(flagged(ray), false, JSON.stringify(ray));
});

test("P1 parity + P3: a face whose kernel reads fail is flagged for the rays that reach it; the other face and the other rays still answer", async () => {
  const inputs = [
    { originMm: [15, 15, 15] as V, direction: unit([-1, -1, -1]) },  // enters through the upper face (fails), leaves through the lower
    { originMm: [0, 30, -10] as V, direction: [0, -1, 0] as V },     // passes below z = 0, but through the upper face's padded box? no: only the lower face
    { originMm: [0, 0, -100] as V, direction: [0, 0, 1] as V },      // lower face first, then the upper one
  ];
  for (const failure of [{ rangeThrows: true }, { nearestThrows: () => true }] as Array<Partial<StubFace>>) {
    const rays = await probeBall(inputs, failure);
    // Ray 0: the entry is missing. The lone exit is not accepted as "origin inside": the face is flagged and so is the parity.
    assert.equal(rays[0]!.hits, 1, JSON.stringify(rays[0]));
    assert.equal(rays[0]!.intersections[0]!.faceId, "9f1");
    assert.deepEqual(rays[0]!.unresolvedFaceIds, ["9f0"]);
    assert.deepEqual(rays[0]!.unresolvedCodes, ["parity", "kernel-error"]);
    assert.equal(rays[0]!.unresolvedCode, "kernel-error");
    assert.equal(rays[0]!.unresolvedCrossings, 2);
    assert.match(rays[0]!.unresolvedReason ?? "", /do not alternate entry and exit .*; face 9f0 is not settled for this ray: /);
    // Ray 1 never comes near the failing face: complete.
    assert.equal(rays[1]!.hits, 2);
    assert.equal(flagged(rays[1]!), false, JSON.stringify(rays[1]));
    // Ray 2: one hit on the good face, the failing face flagged.
    assert.equal(rays[2]!.hits, 1);
    assert.deepEqual(rays[2]!.unresolvedFaceIds, ["9f0"]);
  }
});

const hit = (t: number, faceId: string, normal: V) => ({ t, point: [0, 0, t] as V, faceId, normal, uCurvature: null, vCurvature: null, residual: 0 });
const UP: V = [0, 0, 1], DOWN: V = [0, 0, -1];
const lineRay = { originMm: [0, 0, 0] as V, direction: [0, 0, 1] as V };
const closed = { closedSolid: true, originOutside: false };

test("P1 parity rule from the crossings themselves: entry and exit alternate along the whole line, entry first, exit last", () => {
  const project = (native: NativeProbeRay, context = closed) => projectProbeRay(lineRay, native, context);
  // From outside, inside the box: a dropped entry leaves a lone exit: flagged (at d1f9898 it passed as "origin inside").
  const lone = project({ hits: [hit(0.02, "b", UP)], unresolved: 0, behind: [] });
  assert.equal(lone.unresolvedCrossings, 1);
  assert.equal(lone.unresolvedCode, "parity");
  assert.deepEqual(lone.unresolvedCodes, ["parity"]);
  assert.match(lone.unresolvedReason ?? "", /do not alternate entry and exit \(behind the origin \| ahead: none \| out\)/);
  // The same lone exit with its entry behind the origin: the origin is inside, complete.
  assert.equal(project({ hits: [hit(0.02, "b", UP)], unresolved: 0, behind: [{ t: -0.01, faceId: "a", normal: DOWN }] }).unresolvedCrossings, undefined);
  // In, out behind and in, out ahead: complete. Two entries in a row, or an entry last: flagged.
  assert.equal(project({ hits: [hit(0.01, "a", DOWN), hit(0.02, "b", UP)], unresolved: 0, behind: [{ t: -0.03, faceId: "c", normal: DOWN }, { t: -0.02, faceId: "d", normal: UP }] }).unresolvedCrossings, undefined);
  assert.equal(project({ hits: [hit(0.01, "a", DOWN), hit(0.02, "b", DOWN)], unresolved: 0, behind: [] }).unresolvedCode, "parity");
  assert.equal(project({ hits: [hit(0.01, "a", DOWN), hit(0.02, "b", UP), hit(0.03, "c", DOWN)], unresolved: 0, behind: [] }).unresolvedCode, "parity");
  // Two faces at one place that disagree (an edge touched from outside): ambiguous, flagged.
  const touch = project({ hits: [hit(0.01, "a", DOWN), hit(0.0100000001, "b", UP)], unresolved: 0, behind: [] });
  assert.equal(touch.hits, 1);
  assert.equal(touch.unresolvedCode, "parity");
  assert.match(touch.unresolvedReason ?? "", /^parity ambiguous on a closed Solid/);
  // A crossing behind the origin is never reported, and a Sheet has no parity.
  assert.equal(project({ hits: [], unresolved: 0, behind: [{ t: -0.02, faceId: "a", normal: DOWN }, { t: -0.01, faceId: "b", normal: UP }] }).hits, 0);
  assert.equal(project({ hits: [hit(0.02, "b", UP)], unresolved: 0 }, { closedSolid: false, originOutside: false }).unresolvedCrossings, undefined);
});

test("unresolvedCode: the codes are a fixed set, and an odd count from outside the box keeps the d1f9898 reason text byte for byte", () => {
  assert.deepEqual([...PROBE_SURFACE_UNRESOLVED_CODES], ["parity", "kernel-error", "bracket-unresolved", "search-limit", "missed-crossing", "mesh-crossing"]);
  const OLD = "odd number of crossings (3) on a closed Solid from an outside origin: at least one crossing is missing or a tangent touch was counted";
  assert.equal(probeOddParityReason(3), OLD);
  const three = [hit(0.01, "a", DOWN), hit(0.02, "b", UP), hit(0.03, "c", DOWN)];
  // With the crossings behind the origin (the current search) and without them (an older record): the same text and code.
  for (const native of [{ hits: three, unresolved: 0, behind: [] }, { hits: three, unresolved: 0 }] as NativeProbeRay[]) {
    const ray = projectProbeRay(lineRay, native, { closedSolid: true, originOutside: true });
    assert.equal(ray.unresolvedReason, OLD);
    assert.equal(ray.unresolvedCode, "parity");
    assert.deepEqual(ray.unresolvedCodes, ["parity"]);
    assert.equal(ray.unresolvedCrossings, 1);
  }
  // Every code a face problem can carry passes through; "parity" is the code only when nothing else is unsettled.
  for (const code of ["kernel-error", "bracket-unresolved", "search-limit", "missed-crossing"] as const) {
    const ray = projectProbeRay(lineRay, { hits: three, unresolved: 0, behind: [], problems: [{ faceId: "f", reason: "why", code }] }, { closedSolid: true, originOutside: true });
    assert.equal(ray.unresolvedCode, code);
    assert.deepEqual(ray.unresolvedCodes, ["parity", code]);
    assert.equal(ray.unresolvedReason, `${OLD}; face f is not settled for this ray: why`);
    assert.deepEqual(ray.unresolvedFaceIds, ["f"]);
  }
  // A problem without a code (an older native record) reads as a kernel error; a complete ray carries no code.
  assert.equal(projectProbeRay(lineRay, { hits: [], unresolved: 0, problems: [{ faceId: "f", reason: "why" }] }).unresolvedCode, "kernel-error");
  const complete = projectProbeRay(lineRay, { hits: [hit(0.01, "a", DOWN), hit(0.02, "b", UP)], unresolved: 0, behind: [] }, { closedSolid: true, originOutside: true });
  assert.equal("unresolvedCode" in complete || "unresolvedCodes" in complete || "unresolvedReason" in complete, false);
});

// ---------------------------------------------------------------- analytic faces ----------------------------------------------------------------
const Z: V = [0, 0, 1];
const BIG: [V, V] = [[-0.05, -0.05, -0.05], [0.05, 0.05, 0.05]];
const sphereFace = (r: number): StubFace => ({ kind: "Sphere", nearest: (p) => { const n = unit(p); return { q: mul(n, r), n }; }, box: [[-r, -r, -r], [r, r, r]],
  analytic: { info: { radius: r, basis: { Location: K([0, 0, 0]), Axis: K(Z) } }, uv: [0, 2 * Math.PI, -1.4, 1.4], point: (u, v) => [r * Math.cos(v) * Math.cos(u), r * Math.cos(v) * Math.sin(u), r * Math.sin(v)] } });
const cylinderFace = (r: number, h: number): StubFace => ({ kind: "Cylinder", box: [[-r, -r, 0], [r, r, h]],
  nearest: (p) => { const e = unit([p[0], p[1], 0]); return { q: [e[0] * r, e[1] * r, Math.min(h, Math.max(0, p[2]))], n: e }; },
  analytic: { info: { radius: r, basis: { Location: K([0, 0, 0]), Axis: K(Z) } }, uv: [0, 2 * Math.PI, 0, h], point: (u, v) => [r * Math.cos(u), r * Math.sin(u), v] } });
// Radius r0 at z = 0, growing by tan per unit along +z, for z in [0, h].
const coneFace = (r0: number, tan: number, h: number): StubFace => ({ kind: "Cone", box: [[-r0, -r0, 0], [r0, r0, h]],
  nearest: (p) => {
    const rho = Math.hypot(p[0], p[1]), e = unit([p[0], p[1], 0]), angle = Math.atan(tan), c = Math.cos(angle), s = Math.sin(angle);
    const t = Math.min(h / c, Math.max(0, (rho - r0) * s + p[2] * c));
    return { q: [e[0] * (r0 + t * s), e[1] * (r0 + t * s), t * c], n: unit([e[0] * c, e[1] * c, -s]) };
  },
  analytic: { info: { radius: r0, semiAngle: Math.atan(tan), basis: { Location: K([0, 0, 0]), Axis: K(Z) } }, uv: [0, 2 * Math.PI, 0, h], point: (u, v) => [(r0 + v * tan) * Math.cos(u), (r0 + v * tan) * Math.sin(u), v] } });
const torusFace = (major: number, minor: number): StubFace => ({ kind: "Torus", box: [[-major - minor, -major - minor, -minor], [major + minor, major + minor, minor]],
  nearest: (p) => { const e = unit([p[0], p[1], 0]), spine = mul(e, major), n = unit(sub(p, spine)); return { q: add(spine, mul(n, minor)), n }; },
  analytic: { info: undefined, uv: [0, 2 * Math.PI, -Math.PI, Math.PI], point: (u, v) => [(major + minor * Math.cos(v)) * Math.cos(u), (major + minor * Math.cos(v)) * Math.sin(u), minor * Math.sin(v)],
    curvature: (u, v) => ({ normal: [Math.cos(v) * Math.cos(u), Math.cos(v) * Math.sin(u), Math.sin(v)], curvature1: 1 / minor, curvature2: Math.cos(v) / (major + minor * Math.cos(v)) }) } });
// The disc z = 0.04, radius 10 mm (a cylinder's top cap).
const capFace = (): StubFace => ({ kind: "Plane", box: [[-0.01, -0.01, 0.04], [0.01, 0.01, 0.04]],
  nearest: (p) => { const rho = Math.hypot(p[0], p[1]), k = rho > 0.01 ? 0.01 / rho : 1; return { q: [p[0] * k, p[1] * k, 0.04], n: Z }; },
  analytic: { info: { Location: K([0, 0, 0.04]), Axis: K(Z) }, uv: [-0.01, 0.01, -0.01, 0.01], point: (u, v) => [u, v, 0.04] } });
const wide = { min: [-1e7, -1e7, -1e7] as V, max: [1e7, 1e7, 1e7] as V };
const probeFaces = async (faces: StubFace[], rays: Array<{ originMm: V; direction: V }>, type: "Solid" | "Sheet" = "Sheet") => {
  const { runtime, state } = runtimeFor(faces, type, wide);
  return (await probeSurface(runtime, state, { id: 9, rays })).rays;
};

test("P2: the closed-form solve does not depend on how far away the origin is (1 mm to 1 km; sphere, cylinder, cone, torus)", async () => {
  const cases: Array<{ name: string; face: StubFace; target: V; direction: V; truth: number[] }> = [
    // offsets of each crossing from the target point along the ray, in mm
    { name: "sphere", face: sphereFace(0.02), target: [0, 0, 0], direction: unit([-1, 0.3, 0.2]), truth: [-20, 20] },
    { name: "cylinder", face: cylinderFace(0.01, 0.04), target: [0, 0, 20], direction: unit([-1, 0.2, 0]), truth: [-10, 10] },
    // cone radius 15 at z = 0 shrinking to 5 at z = 30: radius 10 at z = 15
    { name: "cone", face: coneFace(0.015, -1 / 3, 0.03), target: [0, 0, 15], direction: unit([-1, 0.2, 0]), truth: [-10, 10] },
    { name: "torus", face: torusFace(0.02, 0.005), target: [0, 0, 0], direction: [-1, 0, 0], truth: [-25, -15, 15, 25] },
  ];
  for (const { name, face, target, direction, truth } of cases) {
    for (const distance of [1, 1e2, 1e3, 3.2e3, 1e4, 1e5, 1e6]) {
      const origin = sub(target, mul(direction, distance));
      const [ray] = await probeFaces([face], [{ originMm: origin, direction }], "Solid");
      const expected = truth.map((offset) => distance + offset).filter((t) => t >= 0);
      assert.equal(ray!.hits, expected.length, `${name} from ${distance} mm: ${JSON.stringify(ray)}`);
      distances(ray!).forEach((got, k) => assert.ok(Math.abs(got - expected[k]!) <= 1e-6 * Math.max(1, distance / 1e3), `${name} from ${distance} mm: ${got} vs ${expected[k]}`));
      assert.equal(flagged(ray!), false, `${name} from ${distance} mm: ${JSON.stringify(ray)}`);
    }
  }
  // The reviewer's ray: torus R20 r5 at x = 5300 probed from x = 8600, 3,300 mm away: 4 hits at 3275, 3285, 3315, 3325.
  const [far] = await probeFaces([torusFace(0.02, 0.005)], [{ originMm: [3300, 0, 0], direction: [-1, 0, 0] }], "Solid");
  assert.deepEqual(distances(far!).map((value) => Math.round(value * 1e6) / 1e6), [3275, 3285, 3315, 3325]);
});

test("P4: a ray lying in a planar face, just above it, or along a cylinder's ruling is flagged grazing", async () => {
  const cap = await probeFaces([capFace()], [
    { originMm: [50, 3, 40], direction: [-1, 0, 0] },        // in the plane, across the disc
    { originMm: [50, 3, 40.0005], direction: [-1, 0, 0] },   // 0.0005 mm above it
    { originMm: [50, 3, 40.002], direction: [-1, 0, 0] },    // 0.002 mm above: clear
    { originMm: [50, 3, 39.9995], direction: [-1, 0, 0] },   // 0.0005 mm below it
  ]);
  assert.deepEqual(cap.map((ray) => ray.hits), [0, 0, 0, 0]);
  assert.equal(cap[0]!.grazing?.length, 1, JSON.stringify(cap[0]));
  assert.equal(cap[0]!.grazing![0]!.minDistanceMm, 0);
  assert.ok(Math.abs(cap[1]!.grazing![0]!.minDistanceMm - 5e-4) < 1e-9, JSON.stringify(cap[1]));
  assert.equal(flagged(cap[2]!), false);
  assert.ok(Math.abs(cap[3]!.grazing![0]!.minDistanceMm - 5e-4) < 1e-9);
  const wall = await probeFaces([cylinderFace(0.01, 0.04)], [
    { originMm: [10, 0, 100], direction: [0, 0, -1] },        // along a ruling
    { originMm: [10.0005, 0, 100], direction: [0, 0, -1] },   // 0.0005 mm outside it
    { originMm: [10.002, 0, 100], direction: [0, 0, -1] },    // clear
  ]);
  assert.deepEqual(wall.map((ray) => ray.hits), [0, 0, 0]);
  assert.equal(wall[0]!.grazing?.length, 1, JSON.stringify(wall[0]));
  assert.ok(Math.abs(wall[1]!.grazing![0]!.minDistanceMm - 5e-4) < 1e-9, JSON.stringify(wall[1]));
  assert.equal(flagged(wall[2]!), false);
  for (const ray of [...cap, ...wall]) assert.equal(ray.unresolvedCrossings, undefined);
});

test("the range read is batched: one kernel call serves every face and ray of a simple probe", async () => {
  const { runtime, state, stats } = runtimeFor([sphereFace(0.02), { ...cylinderFace(0.01, 0.04), box: BIG }], "Sheet", wide);
  const evidence = await probeSurface(runtime, state, { id: 9, rays: Array.from({ length: 32 }, (_, i) => ({ originMm: [i - 16, 0.5, 100] as V, direction: [0, 0, -1] as V })) });
  assert.equal(evidence.rays.length, 32);
  assert.equal(stats.rangeCalls, 1, JSON.stringify(stats));
});

test("P5: the probe wrapper reads the renderer heap every 512 rays and asks for a collection only after 20 MB of growth; a refusal does not fail the probe", async () => {
  assert.equal(PROBE_SURFACE_HEAP_CHECK_EVERY_RAYS, 512);
  assert.equal(PROBE_SURFACE_COLLECT_ABOVE_MB, 20);
  const state = { documentToken: "d", revision: "r1", undoDepth: 0, redoDepth: 0, bodies: [{ id: 9, versionId: 19, type: "Sheet", name: "b", boundsMm: { min: [0, 0, 0], max: [1, 1, 1] }, faceIds: [], edgeIds: [], faces: [], edges: [] }] };
  const fixture = (heap: { used: number; refuse?: boolean }) => {
    const cdp: string[] = [];
    const runtime = {
      async getState() { return structuredClone(state); },
      async readNative(_source: string, _bindings: string[], values: unknown[]) { return { undoBefore: 0, undoAfter: 0, bodyCountBefore: 1, bodyCountAfter: 1, rays: (values[0] as { rays: unknown[] }).rays.map(() => ({ hits: [], unresolved: 0 })) }; },
      async cdp(method: string) {
        cdp.push(method);
        if (heap.refuse) throw new Error("not available");
        if (method === "HeapProfiler.collectGarbage") { heap.used = 80e6; return {}; }
        return { usedSize: heap.used, totalSize: 200e6 };
      },
      isUncertain() { return false; },
    } as unknown as PlasticityRuntime;
    return { operations: new PlasticityOperations(runtime), cdp };
  };
  const rays = Array.from({ length: 64 }, () => ({ originMm: [0, 0, 5] as V, direction: [0, 0, -1] as V }));
  const heap = { used: 80e6 };
  const { operations, cdp } = fixture(heap);
  // Seven calls (448 rays): nothing is asked of the renderer. The eighth (512 rays) reads the heap: the first reading is the baseline.
  for (let call = 0; call < 7; call += 1) await operations.probeSurface({ id: 9, rays }, "r1");
  assert.deepEqual(cdp, []);
  await operations.probeSurface({ id: 9, rays }, "r1");
  assert.deepEqual(cdp, ["Runtime.getHeapUsage"]);
  // 15 MB of garbage later: read, no collection. A lower reading (V8 collected by itself) becomes the baseline.
  heap.used = 95e6;
  for (let call = 0; call < 8; call += 1) await operations.probeSurface({ id: 9, rays }, "r1");
  assert.deepEqual(cdp.slice(1), ["Runtime.getHeapUsage"]);
  heap.used = 70e6;
  for (let call = 0; call < 8; call += 1) await operations.probeSurface({ id: 9, rays }, "r1");
  heap.used = 89e6;
  for (let call = 0; call < 8; call += 1) await operations.probeSurface({ id: 9, rays }, "r1");
  assert.equal(cdp.filter((method) => method === "HeapProfiler.collectGarbage").length, 0, "19 MB above the 70 MB baseline: no collection");
  // 21 MB above the baseline: one collection, then the heap is read again for the new baseline.
  heap.used = 91e6;
  for (let call = 0; call < 8; call += 1) await operations.probeSurface({ id: 9, rays }, "r1");
  assert.deepEqual(cdp.slice(-3), ["Runtime.getHeapUsage", "HeapProfiler.collectGarbage", "Runtime.getHeapUsage"]);
  assert.equal(cdp.filter((method) => method === "HeapProfiler.collectGarbage").length, 1);
  // A renderer that refuses: the probe still answers.
  const refused = fixture({ used: 80e6, refuse: true });
  for (let call = 0; call < 8; call += 1) assert.equal((await refused.operations.probeSurface({ id: 9, rays }, "r1")).rays.length, 64);
  assert.deepEqual(refused.cdp, ["Runtime.getHeapUsage"]);
});
