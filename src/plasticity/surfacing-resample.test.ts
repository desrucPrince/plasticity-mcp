import assert from "node:assert/strict";
import { test } from "node:test";

import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

// Phase C review C4: the edge resample replaces native continuity values only when every resampled edge point lies on
// both faces within the position tolerance and the resampled G0 passes; the native values stay in nativeMaxima.
// The native source runs against a stub editor (as in surfacing-continuity.test.ts).

class KVector { x: number; y: number; z: number; constructor(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } }

function fixture(options: { offsetB: (t: number) => number; nativeG0Mm: number }) {
  const edge = { id: "17e1", curveType: "Circle", line: false, circle: true, lengthMm: 100, centerMm: [50, 0, 0], tangent: [1, 0, 0], boundsMm: { min: [0, 0, 0], max: [100, 0, 0] }, faceIds: ["17f1", "17f2"], vertexIds: [1, 1] };
  const body = { id: 7, versionId: 17, type: "Solid", name: null, boundsMm: edge.boundsMm, faceIds: ["17f1", "17f2"], edgeIds: ["17e1"], faces: [], edges: [edge], vertices: [] };
  const state = { targetId: "w", title: "t", documentToken: "doc", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" }, bodies: [body] } as unknown as RuntimeState;
  // The edge runs along x from 0 to 0.1 m; face A holds every point exactly, face B holds it shifted by offsetB(x) in z.
  const kernelFace = (id: number, shift: (x: number) => number) => ({
    Id: () => id,
    GetSurface: () => ({ orientation: true }),
    FindPointNear: (p: KVector) => ({ u: p.x, v: 0, exact: new KVector(p.x, p.y, p.z + shift(p.x)) }),
    EvalBasis: () => ({ normal: new KVector(0, 0, 1), uDirection: new KVector(1, 0, 0), vDirection: new KVector(0, 1, 0), uCurvature: 0, vCurvature: 0 }),
  });
  const kernelEdge = {
    Id: () => 301,
    GetPoint: () => new KVector(0.05, 0, 0),
    FindPointNear: (p: KVector) => ({ t: p.x / 0.1, exact: p }),
    GetPointAndTangent: (t: number) => ({ position: new KVector(0.1 * t, 0, 0), tangent: new KVector(1, 0, 0) }),
    GetFaces: () => ({ GetFaces: () => [kernelFace(401, () => 0), kernelFace(402, (x) => options.offsetB(x / 0.1) / 1000)] }),
  };
  class Solid {}
  const view = Object.assign(new Solid(), { high: { edges: { versionIds: ["17e1"], get: () => ({ entityId: 301 }) }, faces: { versionIds: ["17f1", "17f2"], get: (i: number) => ({ entityId: 401 + i }) } } });
  const model = { Id: () => 900, GetEdges: () => ({ GetEdges: () => [kernelEdge] }) };
  const editor = { analyzer: {}, geo: { geometryModel: new Map([[17, { view, model }]]), automatics: new Set() }, db: { lookupStableId: (versionId: number) => (versionId === 17 ? 7 : undefined), commit() {} } };
  // Native spike arrays: G0 fails near the vertex (the misread), G1 and G2 pass.
  const point = (i: number) => [i / 1000, 0, 0];
  const g0 = Array.from({ length: 100 }, (_, i) => [...point(i), i >= 70 && i <= 72 ? options.nativeG0Mm / 1000 : 0, 0, 0]).flat();
  const g1 = Array.from({ length: 100 }, (_, i) => [...point(i), 0, 0, 0]).flat();
  const g2 = Array.from({ length: 100 }, (_, i) => [...point(i), 0, 0, 0, 0]).flat();
  class Factory { async calculate() { return ["m"]; } }
  const evaluate = async () => ({
    measurements: [{ referenceEdge: { bodyId: 900, topologyId: 301 }, referenceFace: { topologyId: 401 }, targetFace: { topologyId: 402 } }],
    views: [{ g0max: options.nativeG0Mm / 1000, g1max: 0, g2max: 0, g0maxBase: { x: 0.07, y: 0, z: 0 }, g1maxBase: { x: 0, y: 0, z: 0 }, g2maxBase: { x: 0, y: 0, z: 0 }, analysis: { g0spikes: Float32Array.from(g0), g1spikes: Float32Array.from(g1), g2spikes: Float32Array.from(g2) } }],
  });
  const natives: Record<string, unknown> = { MeasureContinuityFactory: Factory, ContinuityType: { G2: 23154 }, evalSurfaceContinuityMeasurements: evaluate, EvalSurfaceContinuityMeasurements_refresh: { Samples: 100 } };
  const runtime = {
    async getState() { return state; },
    async readNative(source: string, bindings: string[], values: unknown[]) {
      const execute = new Function(`return (${source})`)() as (...args: unknown[]) => Promise<unknown>;
      return await execute.apply(editor, [...bindings.map((name) => natives[name]), ...values]);
    },
  } as unknown as PlasticityRuntime;
  return new PlasticityOperations(runtime);
}

const run = async (options: { offsetB: (t: number) => number; nativeG0Mm: number }, extended = true) =>
  ((await fixture(options).analyzeSurfaceContinuity([{ bodyId: 7, edgeId: "17e1" }], "r1", 0.01, 0.1, 0.05, { extended })).analyses as Array<Record<string, any>>)[0]!;

test("C4: a native G0 misread (every edge point on both faces) is replaced, never silently", async () => {
  const row = await run({ offsetB: () => 0, nativeG0Mm: 31.8 });
  assert.equal(row.measurementSource, "resampled");
  assert.equal(row.achievedContinuity, "G2");
  assert.equal(row.maximumPositionDeviationMm, 0);
  assert.equal(row.nativeMaxima.g0Mm, 31.8);
  assert.equal(row.nativeMaxima.achievedContinuity, "discontinuous");
  assert.match(row.resample.note, /native values are in nativeMaxima/);
});

test("C4: a real gap on part of the edge, or one only next to a vertex, is not replaced", async () => {
  // 0.5 mm along the middle third.
  const gap = await run({ offsetB: (t) => (t > 0.33 && t < 0.66 ? 0.5 : 0), nativeG0Mm: 0.5 });
  assert.equal(gap.measurementSource, "native-brep-100-samples");
  assert.equal(gap.achievedContinuity, "discontinuous");
  assert.equal("nativeMaxima" in gap, false);
  // A gap only within 0.002 of the end is caught by the samples at t = 0.001 and 0.999.
  const atVertex = await run({ offsetB: (t) => (t > 0.998 ? 0.3 : 0), nativeG0Mm: 0.3 });
  assert.equal(atVertex.measurementSource, "native-brep-100-samples");
});

test("C4: legacy (non-extended) calls never resample", async () => {
  const row = await run({ offsetB: () => 0, nativeG0Mm: 31.8 }, false);
  assert.equal(row.measurementSource, "native-brep-100-samples");
  assert.equal(row.achievedContinuity, "discontinuous");
});
