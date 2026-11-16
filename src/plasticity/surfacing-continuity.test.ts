import assert from "node:assert/strict";
import { test } from "node:test";

import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

// plasticity_analyze_surface_continuity per-sample read-out (P5): interior maxima over samples 5..94, worstAt and absolute
// curvature across the edge. The native source runs against a stub editor with Float32 spike arrays like 26.1.3's.

type Spikes = { g0: number[]; g1: number[]; g2: number[] };

function spikes(g0: (i: number) => number, g1: (i: number) => number, g2: (i: number) => number): Spikes {
  const point = (i: number) => [5 + i / 1000, 0, 0];
  return {
    g0: Array.from({ length: 100 }, (_, i) => [...point(i), g0(i), 0, 0]).flat(),
    g1: Array.from({ length: 100 }, (_, i) => [...point(i), 0, g1(i), 0]).flat(),
    // (point, spike vector, w): the value is the vector length; the vector need not point along one axis.
    g2: Array.from({ length: 100 }, (_, i) => [...point(i), 0.6 * g2(i), 0, 0.8 * g2(i), 0]).flat(),
  };
}

function fixture(series: Spikes, maxes: { g0: number; g1: number; g2: number }, faceBasis?: { u: number[]; v: number[]; ku: number; kv: number }[]) {
  const edge = { id: "17e1", curveType: "Line", line: true, circle: false, lengthMm: 99, centerMm: [5050, 0, 0], tangent: [1, 0, 0], boundsMm: { min: [5000, 0, 0], max: [5099, 0, 0] }, faceIds: ["17f1", "17f2"], vertexIds: [1, 2] };
  const body = { id: 7, versionId: 17, type: "Sheet", name: null, boundsMm: edge.boundsMm, faceIds: ["17f1", "17f2"], edgeIds: ["17e1"], faces: [], edges: [edge], vertices: [] };
  const state = { targetId: "w", title: "t", documentToken: "doc", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" }, bodies: [body] } as unknown as RuntimeState;
  class KVector { x: number; y: number; z: number; constructor(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } }
  const basis = faceBasis ?? [{ u: [1, 0, 0], v: [0, 1, 0], ku: 0, kv: 0 }, { u: [1, 0, 0], v: [0, 0, 1], ku: 0, kv: 200 }];
  const kernelFace = (id: number, index: number) => ({
    Id: () => id,
    FindPointNear: (p: KVector) => ({ u: 0.5, v: 0.5, exact: p }),
    EvalBasis: () => ({ uDirection: new KVector(...(basis[index]!.u as [number, number, number])), vDirection: new KVector(...(basis[index]!.v as [number, number, number])), uCurvature: basis[index]!.ku, vCurvature: basis[index]!.kv }),
  });
  const kernelEdge = {
    Id: () => 301,
    GetPoint: () => new KVector(5.05, 0, 0),
    FindPointNear: (p: KVector) => ({ t: 0.5, exact: p }),
    GetPointAndTangent: () => ({ position: new KVector(5.05, 0, 0), tangent: new KVector(1, 0, 0) }),
    GetFaces: () => ({ GetFaces: () => [kernelFace(401, 0), kernelFace(402, 1)] }),
  };
  class Sheet {}
  const view = Object.assign(new Sheet(), { high: {
    edges: { versionIds: ["17e1"], get: () => ({ entityId: 301 }) },
    faces: { versionIds: ["17f1", "17f2"], get: (i: number) => ({ entityId: 401 + i }) },
  } });
  const model = { Id: () => 900, GetEdges: () => ({ GetEdges: () => [kernelEdge] }) };
  const editor = {
    analyzer: {},
    geo: { geometryModel: new Map([[17, { view, model }]]), automatics: new Set() },
    db: { lookupStableId: (versionId: number) => (versionId === 17 ? 7 : undefined), commit() {} },
  };
  class Factory { async calculate() { return ["m"]; } }
  const evaluate = async () => ({
    measurements: [{ referenceEdge: { bodyId: 900, topologyId: 301 }, referenceFace: { topologyId: 401 }, targetFace: { topologyId: 402 } }],
    views: [{
      g0max: maxes.g0, g1max: maxes.g1, g2max: maxes.g2,
      g0maxBase: { x: 5, y: 0, z: 0 }, g1maxBase: { x: 5, y: 0, z: 0 }, g2maxBase: { x: 5, y: 0, z: 0 },
      analysis: { g0spikes: Float32Array.from(series.g0), g1spikes: Float32Array.from(series.g1), g2spikes: Float32Array.from(series.g2) },
    }],
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

test("a corner spike in G2 reads worstAt corner, with the run of the edge in interior and the existing fields as before", async () => {
  // Relative G2 0.9 at the first sample (the corner), 0.02 along the run.
  const operations = fixture(spikes(() => 1e-8, () => 1e-6, (i) => (i === 0 ? 0.9 : 0.02)), { g0: 1e-8, g1: 1e-6, g2: 0.9 });
  const analyses = (await operations.analyzeSurfaceContinuity([{ bodyId: 7, edgeId: "17e1" }], "r1")).analyses as unknown[];
  const result = analyses[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(result), [
    "edge", "adjacentFaces", "bodyVersionId", "measurementSource", "sampleCount", "maximumPositionDeviationMm", "maximumPositionDeviationAtMm",
    "maximumNormalAngleDeviationDeg", "maximumNormalAngleDeviationAtMm", "maximumRelativeCurvatureDeviation", "maximumRelativeCurvatureDeviationAtMm",
    "tolerances", "passes", "achievedContinuity", "interior", "worstAt", "absoluteCurvature",
  ]);
  assert.equal(result.achievedContinuity, "G1");
  assert.equal(result.maximumRelativeCurvatureDeviation, 0.9);
  assert.equal(result.worstAt, "corner");
  const interior = result.interior as { g0Mm: number; g1Deg: number; g2Rel: number };
  assert.ok(Math.abs(interior.g2Rel - 0.02) < 1e-7, String(interior.g2Rel));
  assert.ok(Math.abs(interior.g0Mm - 1e-5) < 1e-11, String(interior.g0Mm));
  assert.ok(Math.abs(interior.g1Deg - 1e-6 * 180 / Math.PI) < 1e-10, String(interior.g1Deg));
  // Plane (0) beside a 5 mm radius (200 1/m) across the edge: the curvature that relative G2 hides.
  assert.deepEqual(result.absoluteCurvature, { side1PerMm: 0, side2PerMm: 0.2 });
});

test("worstAt follows the first failing level and says interior when the run of the edge is as bad as its ends", async () => {
  // G1 fails (0.5 degree) everywhere; G2 has a corner spike that must not decide worstAt.
  const angle = 0.5 * Math.PI / 180;
  const operations = fixture(spikes(() => 0, () => angle, (i) => (i === 99 ? 0.9 : 0.1)), { g0: 0, g1: angle, g2: 0.9 });
  const analyses = (await operations.analyzeSurfaceContinuity([{ bodyId: 7, edgeId: "17e1" }], "r1")).analyses as unknown[];
  const result = analyses[0] as Record<string, unknown>;
  assert.equal(result.achievedContinuity, "G0");
  assert.equal(result.worstAt, "interior");
});

test("absoluteCurvature is left out when no face parameter direction runs across the edge; interior and worstAt are left out for odd arrays", async () => {
  const skew = Math.SQRT1_2;
  const operations = fixture(spikes(() => 0, () => 0, () => 0.01), { g0: 0, g1: 0, g2: 0.01 }, [{ u: [skew, skew, 0], v: [-skew, skew, 0], ku: 1, kv: 2 }, { u: [1, 0, 0], v: [0, 0, 1], ku: 0, kv: 200 }]);
  const analyses = (await operations.analyzeSurfaceContinuity([{ bodyId: 7, edgeId: "17e1" }], "r1")).analyses as unknown[];
  const result = analyses[0] as Record<string, unknown>;
  assert.equal(result.worstAt, "interior");
  assert.equal("absoluteCurvature" in result, false);
  const short = spikes(() => 0, () => 0, () => 0);
  short.g2 = short.g2.slice(0, 693);
  const odd = fixture(short, { g0: 0, g1: 0, g2: 0 });
  const oddResult = ((await odd.analyzeSurfaceContinuity([{ bodyId: 7, edgeId: "17e1" }], "r1")).analyses as unknown[])[0] as Record<string, unknown>;
  assert.equal("interior" in oddResult, false);
  assert.equal("worstAt" in oddResult, false);
  assert.equal(oddResult.achievedContinuity, "G2");
});
