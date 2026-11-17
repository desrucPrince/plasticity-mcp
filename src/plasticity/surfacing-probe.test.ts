import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { untaggedNativeApiSites } from "./native-function-tagging.test.ts";
import {
  boundsExactness,
  exactBounds,
  PROBE_SURFACE_SOURCE,
  probeSurface,
  projectProbeRay,
  resolveProbeRays,
  supportBounds,
  type NativeSupport,
} from "./surfacing.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

type Body = RuntimeState["bodies"][number];

function body(id: number, type = "Solid", boundsMm: Body["boundsMm"] = { min: [0, 0, 0], max: [10, 20, 30] }, boundsMethod: Body["boundsMethod"] = "native-box"): Body {
  return { id, versionId: id * 10, type, name: `b${id}`, boundsMm, boundsMethod, faceIds: [], edgeIds: [], faces: [], edges: [] };
}

function state(bodies: Body[]): RuntimeState {
  return {
    targetId: "w", title: "t", documentToken: "doc", revision: "r1", dbVersion: 1, undoDepth: 3, redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" }, bodies,
  } as RuntimeState;
}

test("surfacing.ts: untagged native function sources never need nativeApi", () => {
  const source = readFileSync(new URL("./surfacing.ts", import.meta.url), "utf8");
  assert.deepEqual(untaggedNativeApiSites(source), []);
});

test("resolveProbeRays: exactly one of rays or gridMm, 1-64 rays, non-zero direction, unit output", () => {
  const b = body(7);
  assert.throws(() => resolveProbeRays({ id: 7 }, b), /exactly one of rays or gridMm/);
  assert.throws(() => resolveProbeRays({ id: 7, rays: [{ originMm: [0, 0, 0], direction: [0, 0, 1] }], gridMm: { axis: "z", at: [[0, 0]] } }, b), /exactly one/);
  assert.throws(() => resolveProbeRays({ id: 7, rays: [] }, b), /1-64 rays/);
  assert.throws(() => resolveProbeRays({ id: 7, rays: Array.from({ length: 65 }, () => ({ originMm: [0, 0, 0] as [number, number, number], direction: [0, 0, 1] as [number, number, number] })) }, b), /1-64 rays/);
  assert.throws(() => resolveProbeRays({ id: 7, rays: [{ originMm: [0, 0, 0], direction: [0, 0, 0] }] }, b), /non-zero/);
  assert.throws(() => resolveProbeRays({ id: 7, rays: [{ originMm: [0, Number.NaN, 0], direction: [0, 0, 1] }] }, b), /finite/);
  const [ray] = resolveProbeRays({ id: 7, rays: [{ originMm: [1, 2, 3], direction: [0, 0, -2] }] }, b);
  assert.deepEqual(ray, { originMm: [1, 2, 3], direction: [0, 0, -1] });
});

test("resolveProbeRays: grid rays travel along -axis from 1 mm outside the conservative bounds", () => {
  const b = body(7, "Sheet", { min: [0, 0, 0], max: [10, 20, 30] });
  assert.deepEqual(resolveProbeRays({ id: 7, gridMm: { axis: "z", at: [[4, 5]] } }, b), [{ originMm: [4, 5, 31], direction: [0, 0, -1], atMm: [4, 5] }]);
  assert.deepEqual(resolveProbeRays({ id: 7, gridMm: { axis: "x", at: [[4, 5]] } }, b), [{ originMm: [11, 4, 5], direction: [-1, 0, 0], atMm: [4, 5] }]);
  assert.deepEqual(resolveProbeRays({ id: 7, gridMm: { axis: "y", at: [[4, 5]] } }, b), [{ originMm: [4, 21, 5], direction: [0, -1, 0], atMm: [4, 5] }]);
  assert.throws(() => resolveProbeRays({ id: 7, gridMm: { axis: "z", at: [] } }, b), /1-64 points/);
  assert.throws(() => resolveProbeRays({ id: 7, gridMm: { axis: "z", at: [[0, 0]] } }, body(7, "Solid", null)), /no bounds/);
});

test("projectProbeRay sorts, converts to mm, rounds, merges a crossing shared by two faces and omits unknown curvature", () => {
  const projected = projectProbeRay({ originMm: [0, 0, 100], direction: [0, 0, -1] }, {
    unresolved: 0,
    hits: [
      { t: 0.1, point: [0, 0, 0], faceId: "f2", normal: [0, 0, -1], uCurvature: null, vCurvature: null, residual: 0 },
      { t: 0.08, point: [0, 0, 0.02], faceId: "f1", normal: [-0.0000000000001, 0, 1], uCurvature: 50, vCurvature: -50, residual: 2e-15 },
      { t: 0.1 + 5e-10, point: [0, 0, 0], faceId: "f3", normal: [1, 0, 0], uCurvature: 0, vCurvature: 0, residual: 0 },
    ],
  });
  assert.equal(projected.hits, 2);
  assert.deepEqual(projected.intersections, [
    { pointMm: [0, 0, 20], faceId: "f1", normal: [0, 0, 1], distanceMm: 80, uCurvaturePerMm: 0.05, vCurvaturePerMm: -0.05, residualMm: 2e-12 },
    { pointMm: [0, 0, 0], faceId: "f2", otherFaceIds: ["f3"], normal: [0, 0, -1], distanceMm: 100, residualMm: 0 },
  ]);
  assert.equal("unresolvedCrossings" in projected, false);
  const missed = projectProbeRay({ originMm: [0, 0, 0], direction: [1, 0, 0], atMm: [0, 0] }, { hits: [], unresolved: 2 });
  assert.deepEqual(missed, { originMm: [0, 0, 0], direction: [1, 0, 0], atMm: [0, 0], hits: 0, intersections: [], unresolvedCrossings: 2 });
});

// A stub renderer: one Solid whose only face is the square [0,0.01]^2 at z = 0.01 m, with a two-triangle display mesh.
function stubEditor(options: { undoGrows?: boolean } = {}) {
  class Solid {}
  let undo = 4;
  const kernelFace = {
    Id: () => 501,
    GetSurface: () => ({ surface: { Raycast() { throw new Error("no raycast in the stub"); } } }),
    FindPointNear: (p: { x: number; y: number; z: number }) => {
      const clamp = (value: number) => Math.min(0.01, Math.max(0, value));
      const exact = { x: clamp(p.x), y: clamp(p.y), z: 0.01 };
      return { u: exact.x / 0.01, v: exact.y / 0.01, exact };
    },
    EvalBasis: () => ({ normal: { x: 0, y: 0, z: 1 }, uCurvature: 0, vCurvature: 0 }),
  };
  const view = Object.assign(new Solid(), { high: { faces: {
    versionIds: ["17f501"], groups: [0, 6], bboxes: Float32Array.of(0, 0, 0.01, 0.01, 0.01, 0.01), get: () => ({ entityId: 501 }),
    mesh: { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, geometry: {
      attributes: { position: { array: Float32Array.of(0, 0, 0.01, 0.01, 0, 0.01, 0.01, 0.01, 0.01, 0, 0.01, 0.01) } },
      index: { array: Uint16Array.of(0, 1, 2, 0, 2, 3) },
    } },
  } } });
  const model = {};
  const lookups: string[][] = [];
  const editor = {
    history: { get undoStack() { return { length: options.undoGrows ? undo++ : undo }; } },
    geo: { geometryModel: new Map([[17, { view, model }]]), automatics: new Set() },
    db: { lookupStableId: (versionId: number) => (versionId === 17 ? 7 : undefined), lookupFaceCollection: (ids: string[]) => { lookups.push(ids); return { Size: () => 1, Get: () => kernelFace }; }, commit() {} },
  };
  class Vector { x: number; y: number; z: number; constructor(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } }
  // The kernel range read (Eval.DistancesToPoints on face 501): the distance to the trimmed square, in one call for all points.
  const rangeCalls: number[] = [];
  class Eval {
    DistancesToPoints(ids: Int32Array, xyz: Float64Array, offsets: Int32Array) {
      assert.deepEqual(Array.from(ids), [501]);
      const count = offsets[1]! - offsets[0]!;
      rangeCalls.push(count);
      const distances = new Float64Array(count), nearests = new Float64Array(3 * count), params = new Float64Array(2 * count), errors = new Int32Array(count);
      for (let k = 0; k < count; k += 1) {
        const p = { x: xyz[3 * k]!, y: xyz[3 * k + 1]!, z: xyz[3 * k + 2]! }, near = kernelFace.FindPointNear(p);
        distances[k] = Math.hypot(p.x - near.exact.x, p.y - near.exact.y, p.z - near.exact.z);
        nearests.set([near.exact.x, near.exact.y, near.exact.z], 3 * k); params.set([near.u, near.v], 2 * k);
      }
      return { distances, nearests, params, errors, ok: count };
    }
  }
  const pk_default = { a: { Vector, Eval, Context: { Get: () => ({}) } } };
  return { editor, pk_default, lookups, rangeCalls };
}

function executingRuntime(stub: ReturnType<typeof stubEditor>, calls: Array<{ bindings: string[]; values: unknown[] }> = []) {
  return {
    async readNative(source: string, bindings: string[], values: unknown[]) {
      calls.push({ bindings, values });
      const execute = new Function(`return (${source})`)() as (...args: unknown[]) => unknown;
      return execute.apply(stub.editor, [stub.pk_default, ...values]);
    },
    async mutate() { throw new Error("the probe must not mutate"); },
  } as unknown as PlasticityRuntime;
}

test("the probe source solves a hit on the kernel face, reports a miss as hits 0, and asks only for pk_default", async () => {
  const stub = stubEditor();
  const calls: Array<{ bindings: string[]; values: unknown[] }> = [];
  const evidence = await probeSurface(executingRuntime(stub, calls), state([body(7)]), { id: 7, rays: [
    { originMm: [3, 4, 50], direction: [0, 0, -1] },
    { originMm: [30, 4, 50], direction: [0, 0, -1] },
  ] });
  assert.deepEqual(calls.map((call) => call.bindings), [["pk_default"]]);
  const sent = calls[0]!.values[0] as { bodyId: number; rays: Array<{ origin: number[]; direction: number[] }> };
  assert.equal(sent.bodyId, 7);
  assert.deepEqual(sent.rays[0], { origin: [0.003, 0.004, 0.05], direction: [0, 0, -1] });
  assert.equal(evidence.source, "native-brep-ray-newton");
  assert.equal(evidence.revision, "r1");
  assert.deepEqual(evidence.rays[0]!.intersections, [{ pointMm: [3, 4, 10], faceId: "17f501", normal: [0, 0, 1], distanceMm: 40, uCurvaturePerMm: 0, vCurvaturePerMm: 0, residualMm: 0 }]);
  assert.equal(evidence.rays[1]!.hits, 0);
  assert.deepEqual(evidence.rays[1]!.intersections, []);
  // Only the face the first ray can reach was wrapped (once); the second ray misses its box and wraps nothing.
  assert.deepEqual(stub.lookups, [["17f501"]]);
  assert.match(PROBE_SURFACE_SOURCE, /FindPointNear/);
  assert.match(PROBE_SURFACE_SOURCE, /EvalBasis/);
  assert.doesNotMatch(PROBE_SURFACE_SOURCE, /this\.exec|commit\(|selection\./);
});

test("the probe refuses a result when the document changed underneath it", async () => {
  const stub = stubEditor({ undoGrows: true });
  await assert.rejects(probeSurface(executingRuntime(stub), state([body(7)]), { id: 7, rays: [{ originMm: [3, 4, 50], direction: [0, 0, -1] }] }), /changed the document/);
});

test("probeSurface rejects a Wire or unknown body before any native call", async () => {
  let calls = 0;
  const runtime = { async readNative() { calls += 1; return {}; } } as unknown as PlasticityRuntime;
  await assert.rejects(probeSurface(runtime, state([body(7, "Wire")]), { id: 7, rays: [{ originMm: [0, 0, 0], direction: [0, 0, 1] }] }), /Solid or Sheet/);
  await assert.rejects(probeSurface(runtime, state([]), { id: 9, rays: [{ originMm: [0, 0, 0], direction: [0, 0, 1] }] }), /Solid or Sheet/);
  await assert.rejects(probeSurface(runtime, state([body(7)]), { id: 7 }), /exactly one/);
  assert.equal(calls, 0);
});

function support(nearestsMm: number[], box = { min: [0, 0, 0], max: [10, 20, 30] }, errors = Array(12).fill(0), checkMm = nearestsMm): NativeSupport {
  const all = [...nearestsMm, ...checkMm];
  return { bodyId: 7, type: "Solid", ok: errors.filter((code) => code === 0).length, errors, nearests: all.map((value) => value / 1000), box: { min: box.min.map((v) => v / 1000), max: box.max.map((v) => v / 1000) } as NativeSupport["box"] };
}
// +x, -x, +y, -y, +z, -z support points (mm): a body whose top is 6.75 while its box says 9.
const PAD = [10, 1, 2, 0, 1, 2, 5, 20, 2, 5, 0, 2, 5, 10, 6.75, 5, 10, 0];

test("supportBounds reads one support coordinate per side and bounds the error from the far distance and the box", () => {
  const { boundsMm, maxErrorMm, consistent, radiiDisagreementMm } = supportBounds(support(PAD, { min: [0, 0, 0], max: [10, 20, 9] }));
  assert.deepEqual(boundsMm, { min: [0, 0, 0], max: [10, 20, 6.75] });
  assert.equal(consistent, true);
  assert.equal(radiiDisagreementMm, 0);
  // The 10 km query disagrees by far more than its own bound: a premise failed, so the result is not consistent.
  const off = [...PAD]; off[14] = 6.7;
  assert.equal(supportBounds(support(PAD, { min: [0, 0, 0], max: [10, 20, 9] }, undefined, off)).consistent, false);
  // Worst side: lateral half-diagonal^2 of 0.01^2 + 0.0045^2 m^2 (x or y faces) over 2 * 1e5 m, plus 1e-5 mm resolution.
  const expected = Math.max(0.01 ** 2 + 0.0045 ** 2, 0.005 ** 2 + 0.0045 ** 2, 0.005 ** 2 + 0.01 ** 2) / (2 * (1e5 - 0.01)) * 1000 + 1e-5;
  assert.ok(Math.abs(maxErrorMm - expected) < 1e-12, `${maxErrorMm} vs ${expected}`);
  assert.throws(() => supportBounds(support(PAD, undefined, [0, 0, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0])), /support evaluation failed/);
  assert.throws(() => supportBounds({ ...support(PAD), nearests: [1, 2] }), /support evaluation failed/);
});

test("boundsExactness: native-extrema is exact; a control hull is not, with a short reason; unknown is omitted", () => {
  assert.deepEqual(boundsExactness({ boundsMethod: "native-extrema", boundsMm: { min: [0, 0, 0], max: [1, 1, 1] } }), { boundsExact: true });
  assert.equal(boundsExactness({ boundsMethod: "native-box", boundsMm: { min: [0, 0, 0], max: [1, 1, 1] } }), undefined);
  const exact = boundsExactness({ boundsMethod: "native-box", boundsMm: { min: [0, 0, 0], max: [10, 20, 6.75] } }, { boundsMm: { min: [0, 0, 0], max: [10, 20, 6.75] }, maxErrorMm: 1e-5 });
  assert.deepEqual(exact, { boundsExact: true });
  const hull = boundsExactness({ boundsMethod: "native-box", boundsMm: { min: [0, 0, 0], max: [10, 20, 9] } }, { boundsMm: { min: [0, 0, 0], max: [10, 20, 6.75] }, maxErrorMm: 1e-5 });
  assert.equal(hull?.boundsExact, false);
  assert.match(hull?.boundsNote ?? "", /control hull\), up to 2\.25 mm too large; plasticity_exact_bounds/);
  const large = boundsExactness({ boundsMethod: "native-box", boundsMm: { min: [0, 0, 0], max: [10, 20, 9] } }, { boundsMm: { min: [0, 0, 0], max: [10, 20, 9] }, maxErrorMm: 0.01 });
  assert.equal(large?.boundsExact, false);
  assert.match(large?.boundsNote ?? "", /not proven exact/);
});

test("exactBounds validates ids before the native read and reports exact sides, error bound and overshoot", async () => {
  const calls: unknown[] = [];
  const runtime = { async readNative(_source: string, bindings: string[], values: unknown[]) { calls.push({ bindings, values }); return [support(PAD, { min: [0, 0, 0], max: [10, 20, 9] })]; } } as unknown as PlasticityRuntime;
  const s = state([body(7, "Sheet", { min: [0, 0, 0], max: [10, 20, 9] }), body(8, "Wire")]);
  await assert.rejects(exactBounds(runtime, s, [7, 7]), /unique/);
  await assert.rejects(exactBounds(runtime, s, [8]), /Solid or Sheet/);
  await assert.rejects(exactBounds(runtime, s, []), /1-32/);
  assert.equal(calls.length, 0);
  const evidence = await exactBounds(runtime, s, [7]);
  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0] as { bindings: string[] }).bindings, ["pk_default"]);
  assert.equal(evidence.method, "native-support-points");
  assert.deepEqual(evidence.bodies[0]!.boundsMm, { min: [0, 0, 0], max: [10, 20, 6.75] });
  assert.equal(evidence.bodies[0]!.exact, true);
  assert.equal(evidence.bodies[0]!.overshootMm, 2.25);
  assert.equal(evidence.bodies[0]!.conservativeBoundsMethod, "native-box");
  assert.deepEqual((calls[0] as { values: Array<{ radii: number[] }> }).values[0]!.radii, [1e5, 1e4]);
});
