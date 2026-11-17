import assert from "node:assert/strict";
import test from "node:test";

import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";
import { probeSurface, projectProbeRay } from "./surfacing.ts";

// plasticity_probe_surface completeness (round 3, D1): the real native source runs against a stub kernel of exact analytic
// surfaces with NO display-mesh triangles, so every crossing must come from the closed-form roots. Units: kernel metres.

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addv = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V) => Math.hypot(...a);
const unit = (a: V): V => mul(a, 1 / len(a));

class KVector { x: number; y: number; z: number; constructor(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } }
const K = (p: V) => new KVector(...p);
const arr = (v: { x: number; y: number; z: number }): V => [v.x, v.y, v.z];

// An analytic surface (z axis through L) with the kernel methods the probe uses. closest(p) is the exact nearest point on
// the untrimmed surface and its outward normal; point(u, v) the parametric point.
interface Shape { kind: string; info: unknown; uv: [number, number, number, number]; point(u: number, v: number): V; closest(p: V): { q: V; n: V }; curvature?: (u: number, v: number) => { normal: V; curvature1: number; curvature2: number } }
const Z: V = [0, 0, 1];
const sphere = (L: V, r: number): Shape => ({
  kind: "Sphere", info: { radius: r, basis: { Location: K(L), Axis: K(Z) } }, uv: [0, 2 * Math.PI, -Math.PI / 2, Math.PI / 2],
  point: (u, v) => addv(L, [r * Math.cos(v) * Math.cos(u), r * Math.cos(v) * Math.sin(u), r * Math.sin(v)]),
  closest: (p) => { const n = unit(sub(p, L)); return { q: addv(L, mul(n, r)), n }; },
});
const cylinder = (L: V, r: number, h: number): Shape => ({
  kind: "Cylinder", info: { radius: r, basis: { Location: K(L), Axis: K(Z) } }, uv: [0, 2 * Math.PI, 0, h],
  point: (u, v) => addv(L, [r * Math.cos(u), r * Math.sin(u), v]),
  closest: (p) => { const w = sub(p, L); const n = unit([w[0], w[1], 0]); return { q: addv(L, [n[0] * r, n[1] * r, w[2]]), n }; },
});
// Radius r0 at L, growing by tan per unit along +z.
const cone = (L: V, r0: number, tan: number, v0: number, v1: number): Shape => ({
  kind: "Cone", info: { radius: r0, semiAngle: Math.atan(tan), basis: { Location: K(L), Axis: K(Z) } }, uv: [0, 2 * Math.PI, v0, v1],
  point: (u, v) => addv(L, [(r0 + v * tan) * Math.cos(u), (r0 + v * tan) * Math.sin(u), v]),
  closest: (p) => {
    const w = sub(p, L), rho = Math.hypot(w[0], w[1]), e = unit([w[0], w[1], 0]);
    const c = Math.cos(Math.atan(tan)), s = Math.sin(Math.atan(tan));
    // Generator line (rho, h) = (r0, 0) + t (s, c); project (rho, h) onto it.
    const t = (rho - r0) * s + w[2] * c, rq = r0 + t * s, hq = t * c;
    return { q: addv(L, [e[0] * rq, e[1] * rq, hq]), n: unit([e[0] * c, e[1] * c, -s]) };
  },
});
const torus = (L: V, R: number, r: number): Shape => ({
  kind: "Torus", info: undefined, uv: [0, 2 * Math.PI, -Math.PI, Math.PI],
  point: (u, v) => addv(L, [(R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v)]),
  closest: (p) => { const w = sub(p, L), e = unit([w[0], w[1], 0]), s = addv(L, mul(e, R)), n = unit(sub(p, s)); return { q: addv(s, mul(n, r)), n }; },
  curvature: (u, v) => ({ normal: [Math.cos(v) * Math.cos(u), Math.cos(v) * Math.sin(u), Math.sin(v)], curvature1: 1 / r, curvature2: Math.cos(v) / (R + r * Math.cos(v)) }),
});

function runtimeFor(shapes: Shape[], type = "Solid") {
  const cache = new Map<number, V>();
  let next = 1;
  const faces = shapes.map((shape, index) => {
    const surface = {
      constructor: { name: shape.kind },
      GetInfo: shape.info === undefined ? undefined : () => shape.info,
      GetPoint: (u: number, v: number) => K(shape.point(u, v)),
      EvalCurvature: (u: number, v: number) => { const k = shape.curvature!(u, v); return { normal: K(k.normal), curvature1: k.curvature1, curvature2: k.curvature2 }; },
      Raycast() { throw new Error("not used"); },
    };
    return {
      Id: () => 700 + index,
      GetSurface: () => ({ surface, orientation: true, uMin: shape.uv[0], uMax: shape.uv[1], vMin: shape.uv[2], vMax: shape.uv[3] }),
      FindPointNear: (p: KVector) => { const { q, n } = shape.closest(arr(p)); const key = next++; cache.set(key, n); return { u: key, v: 0, exact: K(q) }; },
      EvalBasis: (u: number) => ({ normal: K(cache.get(u)!), uCurvature: 0, vCurvature: 0 }),
    };
  });
  const big = 10;
  const versionIds = faces.map((_, index) => `9f${index}`);
  class Solid {}
  class Sheet {}
  const view = Object.assign(type === "Solid" ? new Solid() : new Sheet(), { high: { faces: {
    versionIds, groups: faces.flatMap(() => [0, 0]), bboxes: Float32Array.from(faces.flatMap(() => [-big, -big, -big, big, big, big])),
    get: (index: number) => ({ entityId: 700 + index }),
    mesh: { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, geometry: { attributes: { position: { array: new Float32Array(0) } }, index: null } },
  } } });
  const editor = {
    history: { undoStack: { length: 0 } },
    geo: { geometryModel: new Map([[19, { view, model: {} }]]), automatics: new Set() },
    db: { lookupStableId: (versionId: number) => (versionId === 19 ? 9 : undefined), lookupFaceCollection: (ids: string[]) => ({ Size: () => 1, Get: () => faces[versionIds.indexOf(ids[0]!)] }), commit() {} },
  };
  const runtime = {
    async readNative(source: string, _bindings: string[], values: unknown[]) {
      const execute = new Function(`return (${source})`)() as (...args: unknown[]) => unknown;
      return execute.apply(editor, [{ a: { Vector: KVector } }, ...values]);
    },
  } as unknown as PlasticityRuntime;
  const state = { revision: "r1", bodies: [{ id: 9, versionId: 19, type, name: "b", boundsMm: { min: [-1000, -1000, -1000], max: [1000, 1000, 1000] }, faceIds: versionIds, edgeIds: [], faces: [], edges: [] }] } as unknown as RuntimeState;
  return { runtime, state };
}

// Rays in millimetres; shapes in metres.
const probe = async (shapes: Shape[], rays: Array<{ originMm: V; direction: V }>, type = "Solid") => {
  const { runtime, state } = runtimeFor(shapes, type);
  return (await probeSurface(runtime, state, { id: 9, rays })).rays;
};
const close = (got: number[], want: number[], tol = 1e-9) => got.length === want.length && want.every((value, index) => Math.abs(value - got[index]!) <= tol);

test("sphere: every crossing in closed form, also 0.001, 0.01 and 0.04 mm inside the silhouette, with no mesh seeds", async () => {
  const r = 20;
  for (const inside of [20, 4e-2, 1e-2, 1e-3]) {
    const offset = r - inside;
    const [ray] = await probe([sphere([0, 0, 0], r / 1000)], [{ originMm: [offset, 0, 100], direction: [0, 0, -1] }]);
    const h = Math.sqrt(r * r - offset * offset);
    assert.ok(close(ray!.intersections.map((hit) => hit.pointMm[2]), [h, -h]), `${inside}: ${JSON.stringify(ray)}`);
    assert.equal(ray!.unresolvedCrossings, undefined);
    assert.equal(ray!.grazing, undefined);
  }
});

test("cylinder and cone: both crossings near the silhouette; torus: four crossings near the top and the inner equator", async () => {
  for (const inside of [4e-2, 1e-2, 1e-3]) {
    const y = 10 - inside, h = Math.sqrt(100 - y * y);
    const [cyl] = await probe([cylinder([0, 0, 0], 0.01, 0.04)], [{ originMm: [50, y, 20], direction: [-1, 0, 0] }]);
    assert.ok(close(cyl!.intersections.map((hit) => hit.pointMm[0]), [h, -h]), `cylinder ${inside}: ${JSON.stringify(cyl)}`);
    // Cone radius 15 at z=0 shrinking to 5 at z=30 (tan -1/3): radius 10 at z=15.
    const [con] = await probe([cone([0, 0, 0], 0.015, -1 / 3, 0, 0.03)], [{ originMm: [50, y, 15], direction: [-1, 0, 0] }]);
    assert.ok(close(con!.intersections.map((hit) => hit.pointMm[0]), [h, -h]), `cone ${inside}: ${JSON.stringify(con)}`);
    const tor = await probe([torus([0, 0, 0], 0.02, 0.005)], [{ originMm: [50, 0, 5 - inside], direction: [-1, 0, 0] }, { originMm: [50, 15 - inside, 0], direction: [-1, 0, 0] }]);
    const z = 5 - inside, a = Math.sqrt(25 - z * z);
    assert.ok(close(tor[0]!.intersections.map((hit) => hit.pointMm[0]), [20 + a, 20 - a, -(20 - a), -(20 + a)], 1e-8), `torus top ${inside}: ${JSON.stringify(tor[0])}`);
    const yy = 15 - inside, outer = Math.sqrt(625 - yy * yy), inner = Math.sqrt(225 - yy * yy);
    assert.ok(close(tor[1]!.intersections.map((hit) => hit.pointMm[0]), [outer, inner, -inner, -outer], 1e-8), `torus inner ${inside}: ${JSON.stringify(tor[1])}`);
    for (const ray of [cyl, con, ...tor]) assert.equal(ray!.unresolvedCrossings, undefined);
  }
});

test("a tangent ray is a grazing entry, not a crossing; a ray 0.0005 mm outside grazes; 0.01 mm outside is clean", async () => {
  const rays = await probe([sphere([0, 0, 0], 0.02)], [
    { originMm: [20, 0, 100], direction: [0, 0, -1] },
    { originMm: [20.0005, 0, 100], direction: [0, 0, -1] },
    { originMm: [20.01, 0, 100], direction: [0, 0, -1] },
  ]);
  assert.equal(rays[0]!.hits, 0);
  assert.equal(rays[0]!.grazing?.length, 1);
  assert.ok(rays[0]!.grazing![0]!.minDistanceMm < 1e-9);
  assert.equal(rays[1]!.hits, 0);
  assert.ok(Math.abs(rays[1]!.grazing![0]!.minDistanceMm - 5e-4) < 1e-9, JSON.stringify(rays[1]));
  assert.equal(rays[2]!.grazing, undefined);
  assert.equal(rays[2]!.hits, 0);
  // Torus top tangent: two tangent points, no crossings.
  const [top] = await probe([torus([0, 0, 0], 0.02, 0.005)], [{ originMm: [50, 0, 5], direction: [-1, 0, 0] }]);
  assert.equal(top!.hits, 0);
  assert.equal(top!.grazing?.length, 2);
});

test("a hit at the ray origin is clamped to t = 0 and reports the residual of the reported point", async () => {
  const [ray] = await probe([sphere([0, 0, 0], 0.02)], [{ originMm: [0, 0, 20], direction: [0, 0, -1] }]);
  assert.equal(ray!.intersections[0]!.distanceMm, 0);
  assert.ok(ray!.intersections[0]!.residualMm <= 1e-9);
  assert.equal(ray!.hits, 2);
});

test("parity guard: an odd count on a closed Solid from an outside origin is flagged with the reason; never on a Sheet or from inside", () => {
  const hit = (t: number, faceId: string) => ({ t, point: [0, 0, 0] as V, faceId, normal: [0, 0, 1] as V, uCurvature: null, vCurvature: null, residual: 0 });
  const native = { hits: [hit(0.01, "a"), hit(0.02, "b"), hit(0.03, "c")], unresolved: 0 };
  const ray = { originMm: [0, 0, 0] as V, direction: [0, 0, 1] as V };
  const flagged = projectProbeRay(ray, native, { closedSolid: true, originOutside: true });
  assert.equal(flagged.unresolvedCrossings, 1);
  assert.match(flagged.unresolvedReason ?? "", /odd number of crossings \(3\) on a closed Solid from an outside origin/);
  assert.equal(projectProbeRay(ray, native, { closedSolid: false, originOutside: true }).unresolvedCrossings, undefined);
  assert.equal(projectProbeRay(ray, native, { closedSolid: true, originOutside: false }).unresolvedCrossings, undefined);
  // Hits on two faces 0.0001 mm apart along the ray are one crossing (an edge): even, not flagged.
  const edge = projectProbeRay(ray, { hits: [hit(0.01, "a"), hit(0.0300000001, "b"), hit(0.0300000002, "c")], unresolved: 0 }, { closedSolid: true, originOutside: true });
  assert.equal(edge.hits, 2);
  assert.deepEqual(edge.intersections[1]!.otherFaceIds, ["c"]);
  assert.equal(edge.unresolvedCrossings, undefined);
  const grazing = projectProbeRay(ray, { hits: [], unresolved: 0, grazing: [{ faceId: "a", t: 0.02, minDistance: 5e-7, point: [0.001, 0, 0.02] }] });
  assert.deepEqual(grazing.grazing, [{ faceId: "a", minDistanceMm: 0.0005, atMm: [1, 0, 20] }]);
});

test("a closed sphere probed from outside never returns an odd count without a flag (512 random rays)", async () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let batch = 0; batch < 8; batch += 1) {
    const rays = Array.from({ length: 64 }, () => {
      const target: V = [rnd() * 44 - 22, rnd() * 44 - 22, rnd() * 44 - 22];
      const d = unit([rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]);
      return { originMm: sub(target, mul(d, 100)), direction: d };
    });
    const results = await probe([sphere([0, 0, 0], 0.02)], rays);
    results.forEach((ray, index) => {
      const o = rays[index]!.originMm, d = rays[index]!.direction, b = dot(o, d), disc = b * b - (dot(o, o) - 400);
      if (!ray.grazing) assert.equal(ray.hits, disc > 0 ? 2 : 0, JSON.stringify({ ray: rays[index], got: ray }));
      assert.ok(ray.hits % 2 === 0 || ray.unresolvedCrossings);
    });
  }
});
