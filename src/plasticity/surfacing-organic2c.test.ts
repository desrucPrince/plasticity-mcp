import assert from "node:assert/strict";
import { test } from "node:test";

import { continuitySampleSummary, withContinuitySummary, type ContinuitySamples, type Vector3 } from "./surfacing.ts";

// organic-tools-2 phase C, items 4b/4c and 16: one class rule for both continuity tools, with isolated spikes.

const tolerances = { positionMm: 0.01, normalAngleDeg: 0.1, relativeCurvature: 0.05 };
const series = (g0: (i: number) => number, g1: (i: number) => number, g2: (i: number) => number): ContinuitySamples => ({
  g0Mm: Array.from({ length: 100 }, (_, i) => g0(i)),
  g1Deg: Array.from({ length: 100 }, (_, i) => g1(i)),
  g2Rel: Array.from({ length: 100 }, (_, i) => g2(i)),
  pointsMm: Array.from({ length: 100 }, (_, i) => [i, 0, 0] as Vector3),
});
const maxOf = (samples: ContinuitySamples) => ({ g0Mm: Math.max(...samples.g0Mm), g1Deg: Math.max(...samples.g1Deg), g2Rel: Math.max(...samples.g2Rel) });

test("one 90 degree sample with neighbours under 0.1 degree is an isolated spike; the class ignoring it is G1", () => {
  const samples = series(() => 0, (i) => (i === 40 ? 90 : 0.05), () => 0.3);
  const summary = continuitySampleSummary(samples, maxOf(samples), tolerances);
  assert.equal(summary.class, "G0");
  assert.equal(summary.interiorClass, "G0");
  assert.equal(summary.classIgnoringIsolatedSpikes, "G1");
  assert.deepEqual(summary.spikes.map((spike) => [spike.level, spike.index, spike.value, spike.source]), [["G1", 40, 90, "sample"]]);
  assert.deepEqual(summary.spikes[0]!.positionMm, [40, 0, 0]);
  assert.ok(summary.spikes[0]!.neighbourMax <= 0.1);
});

test("a corner spike (index 0 or 99, neighbours on one side) is a spike; interiorClass already leaves it out", () => {
  for (const at of [0, 99]) {
    const samples = series(() => 0, (i) => (i === at ? 90 : 0.02), () => 0.01);
    const summary = continuitySampleSummary(samples, maxOf(samples), tolerances);
    assert.equal(summary.class, "G0", String(at));
    assert.equal(summary.interiorClass, "G2", String(at));
    assert.equal(summary.classIgnoringIsolatedSpikes, "G2", String(at));
    assert.equal(summary.spikes[0]!.index, at);
  }
});

test("two adjacent failing samples, or a failing neighbour within 2 indices, are not an isolated spike", () => {
  for (const second of [41, 42]) {
    const samples = series(() => 0, (i) => (i === 40 || i === second ? 5 : 0.01), () => 0.01);
    const summary = continuitySampleSummary(samples, maxOf(samples), tolerances);
    assert.equal(summary.spikes.length, 0, String(second));
    assert.equal(summary.classIgnoringIsolatedSpikes, "G0", String(second));
  }
  // Three indices apart they are two separate spikes.
  const apart = series(() => 0, (i) => (i === 40 || i === 43 ? 5 : 0.01), () => 0.01);
  assert.equal(continuitySampleSummary(apart, maxOf(apart), tolerances).spikes.length, 2);
});

test("a failing native maximum off the samples (corner vertex) is a native-maximum spike at the nearest sample", () => {
  // Live band/side: every sample below 0.07 degrees, native maximum 90 degrees at the corner (41.9999, ...).
  const samples = series(() => 0, () => 0.063, () => 0.4);
  const summary = continuitySampleSummary(samples, { g0Mm: 0, g1Deg: 90, g2Rel: 0.4, g1AtMm: [99.4, 0, 0] }, tolerances);
  assert.equal(summary.class, "G0");
  assert.equal(summary.classIgnoringIsolatedSpikes, "G1");
  assert.equal(summary.spikes.length, 1);
  assert.deepEqual([summary.spikes[0]!.level, summary.spikes[0]!.index, summary.spikes[0]!.value, summary.spikes[0]!.source], ["G1", 99, 90, "native-maximum"]);
  assert.deepEqual(summary.spikes[0]!.positionMm, [99.4, 0, 0]);
});

test("a failing native maximum with failing samples is not a spike, and a G2 edge stays G2 in all three classes", () => {
  const failing = series(() => 0, () => 2, () => 0.01);
  const summary = continuitySampleSummary(failing, { g0Mm: 0, g1Deg: 90, g2Rel: 0.01 }, tolerances);
  assert.equal(summary.spikes.length, 0);
  assert.equal(summary.classIgnoringIsolatedSpikes, "G0");
  const smooth = series(() => 1e-6, () => 0.001, () => 0.001);
  const all = continuitySampleSummary(smooth, maxOf(smooth), tolerances);
  assert.deepEqual([all.class, all.interiorClass, all.classIgnoringIsolatedSpikes, all.spikes.length], ["G2", "G2", "G2", 0]);
});

test("4c: interiorClass is never worse than class (interior maxima are clamped), and relative G2 is clamped to 1", () => {
  const samples = series(() => 0, () => 0.01, (i) => (i < 5 ? 0.9 : 0.02));
  // A native maximum a hair under the interior sample maximum (separate reductions) must not make interior worse.
  const summary = continuitySampleSummary(samples, { g0Mm: 0, g1Deg: 0.01, g2Rel: 1.4 }, tolerances);
  assert.equal(summary.class, "G1");
  assert.equal(summary.interiorClass, "G2");
  assert.ok(summary.maximaIgnoringIsolatedSpikes.g2Rel <= 1);
});

test("withContinuitySummary adds interiorContinuity, the class ignoring spikes and spikes, and drops the series", () => {
  const samples = series(() => 0, () => 0.05, () => 0.3);
  const row: Record<string, unknown> = withContinuitySummary<Record<string, unknown>>({
    achievedContinuity: "G0", maximumPositionDeviationMm: 0, maximumNormalAngleDeviationDeg: 90, maximumRelativeCurvatureDeviation: 0.3,
    maximumNormalAngleDeviationAtMm: [0, 0, 0], samples,
  }, tolerances);
  assert.equal("samples" in row, false);
  assert.equal(row.interiorContinuity, "G1");
  assert.equal(row.achievedContinuityIgnoringIsolatedSpikes, "G1");
  assert.equal((row.spikes as unknown[]).length, 1);
  const plain = withContinuitySummary({ achievedContinuity: "G2" }, tolerances);
  assert.deepEqual(plain, { achievedContinuity: "G2" });
  assert.equal("samples" in withContinuitySummary({ maximumPositionDeviationMm: 0, maximumNormalAngleDeviationDeg: 0, maximumRelativeCurvatureDeviation: 0, samples: series(() => 0, () => 0, () => 0) }, tolerances, true), true);
});

// Item 5: end-constrained control-point plane curves.
import { applyCurveEndConstraints, planeTangentWorld, resolveCurvePlane } from "./surfacing.ts";

const collinear = (a: number[], b: number[], c: number[]) => {
  const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
  return Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / (Math.hypot(...u) * Math.hypot(...v));
};

test("startTangent + startCurvatureZero put the first three control points on the tangent line; the rest are untouched", () => {
  const frame = resolveCurvePlane("xz");
  const points: Vector3[] = [[0, 0, 0], [8, 0, 3], [15, 0, -2], [20, 0, -10], [22, 0, -20]];
  const out = applyCurveEndConstraints(frame, points, { startTangent: { direction: [1, 0] }, startCurvatureZero: true });
  assert.ok(collinear(out[0]!, out[1]!, out[2]!) < 1e-12);
  assert.deepEqual(out[1], [8, 0, 0]);
  assert.deepEqual(out[2], [15, 0, 0]);
  assert.deepEqual(out.slice(3), points.slice(3));
  // G1 only moves the second point; lengthMm sets the handle.
  const g1 = applyCurveEndConstraints(frame, points, { startTangent: { direction: [1, 0, 0], lengthMm: 4 } });
  assert.deepEqual(g1[1], [4, 0, 0]);
  assert.deepEqual(g1[2], points[2]);
});

test("endTangent is the arriving direction; a 3D world tangent in the plane works, out of the plane is refused", () => {
  const frame = resolveCurvePlane("yz", 0);
  const band: [number, number, number] = [0, 0.9135, -0.4067];
  const t = planeTangentWorld(frame, band, "startTangent");
  assert.ok(Math.abs(Math.hypot(...t) - 1) < 1e-12 && Math.abs(t[0]) < 1e-12);
  const points: Vector3[] = [[0, 0, 0], [0, 5, 5], [0, 10, 8], [0, 15, 8], [0, 20, 5], [0, 25, 0]];
  const out = applyCurveEndConstraints(frame, points, { endTangent: { direction: [0, 0, -1] }, endCurvatureZero: true });
  assert.ok(collinear(out[5]!, out[4]!, out[3]!) < 1e-12);
  assert.ok(out[4]![2]! > out[5]![2]! && out[3]![2]! > out[4]![2]!, "points before the end lie behind it along the arriving tangent");
  assert.throws(() => planeTangentWorld(frame, [1, 0, 0], "startTangent"), /leaves the curve plane/);
  assert.throws(() => applyCurveEndConstraints(frame, points, { startCurvatureZero: true }), /needs startTangent/);
  assert.throws(() => applyCurveEndConstraints(frame, points.slice(0, 5), { startTangent: { direction: [1, 0] }, startCurvatureZero: true, endTangent: { direction: [1, 0] }, endCurvatureZero: true }), /at least 6/);
  assert.throws(() => applyCurveEndConstraints(frame, points, { startTangent: { direction: [1, 0] } }, true), /open curve/);
  assert.deepEqual(applyCurveEndConstraints(frame, points, {}), points);
});

// Item 14: sampled curvature per Wire segment and its shape.
import { curvatureProfile } from "./surfacing.ts";

test("curvatureProfile: n evenly spaced magnitudes, one broad maximum reads unimodal, wiggles under 0.1 % are ignored", () => {
  const bump = Array.from({ length: 51 }, (_, i) => Math.sin((Math.PI * i) / 50) * 0.05 + (i % 2 ? 1e-6 : 0));
  const one = curvatureProfile(bump, 5);
  assert.equal(one.curvatureSamplesPerMm.length, 5);
  assert.ok(Math.abs(one.curvatureSamplesPerMm[2]! - 0.05) < 1e-5);
  assert.deepEqual(one.curvatureShape, { monotonicRuns: 2, localMaxima: 1, localMinima: 0, unimodal: true });
  const rising = curvatureProfile(Array.from({ length: 20 }, (_, i) => i * 0.001), 3);
  assert.deepEqual(rising.curvatureShape, { monotonicRuns: 1, localMaxima: 0, localMinima: 0, unimodal: true });
  assert.deepEqual(rising.curvatureSamplesPerMm.map((value) => Math.round(value * 1e6) / 1e6), [0, 0.0095, 0.019]);
  const two = curvatureProfile(Array.from({ length: 101 }, (_, i) => Math.abs(Math.sin((2 * Math.PI * i) / 100))), 10);
  assert.equal(two.curvatureShape.localMaxima, 2);
  assert.equal(two.curvatureShape.localMinima, 1);
  assert.equal(two.curvatureShape.unimodal, false);
  assert.throws(() => curvatureProfile([1, 2], 1), /at least 2/);
});

// Item 13: G2 to two neighbours at one corner.
import { checkPatchBoundary, g2CornerCurvatureMismatch, normalCurvatureAlong, type PrincipalCurvature } from "./surfacing.ts";

test("normalCurvatureAlong is Euler's formula in the tangent plane", () => {
  const pc: PrincipalCurvature = { u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1], kuPerMm: 0.1, kvPerMm: -0.02 };
  assert.ok(Math.abs(normalCurvatureAlong(pc, [1, 0, 0])! - 0.1) < 1e-12);
  assert.ok(Math.abs(normalCurvatureAlong(pc, [0, 1, 0.5])! + 0.02) < 1e-12);
  assert.ok(Math.abs(normalCurvatureAlong(pc, [1, 1, 0])! - 0.04) < 1e-12);
  assert.equal(normalCurvatureAlong(pc, [0, 0, 1]), null);
});

test("pre-check: G2 to two faces that curve differently at their shared corner is reported (not blocking); alike, or one G1, is not", () => {
  const band: PrincipalCurvature = { u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0], kuPerMm: 0, kvPerMm: 0 };
  const flank: PrincipalCurvature = { u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0], kuPerMm: -0.00675, kvPerMm: 0.002 };
  const corner = (a: PrincipalCurvature, b: PrincipalCurvature) => ({
    vertexId: 7, positionMm: [42, -17.46, 107.08] as Vector3, items: [0, 1] as [number, number],
    tangents: [[0, 1, 0], [0, 0, -1]] as [Vector3, Vector3], normals: [[1, 0, 0], [1, 0, 0]] as [Vector3, Vector3], inward: [null, null] as [null, null],
    faces: [], closedByPatch: false, curvatures: [a, b] as [PrincipalCurvature, PrincipalCurvature],
  });
  const items = (second: "g1" | "g2") => [
    { kind: "edge" as const, id: "bandEdge", faceId: "band", continuity: "g2" as const },
    { kind: "edge" as const, id: "flankEdge", faceId: "flank", continuity: second },
  ];
  const flagged = checkPatchBoundary({ items: items("g2"), corners: [corner(band, flank)] });
  const problem = flagged.problems.find((entry) => entry.kind === "g2-corner-curvature")!;
  assert.ok(problem);
  assert.equal(problem.blocking, false);
  assert.equal(flagged.ok, true);
  assert.match(problem.message, /G2 to two neighbours at one corner: at vertex 7 .* faces band and flank curve differently along edge bandEdge \(0 against -0\.00675 per mm/);
  assert.match(problem.advice, /ask G1 on edge bandEdge or flankEdge/);
  assert.equal(checkPatchBoundary({ items: items("g1"), corners: [corner(band, flank)] }).problems.some((entry) => entry.kind === "g2-corner-curvature"), false);
  assert.equal(checkPatchBoundary({ items: items("g2"), corners: [corner(flank, flank)] }).problems.some((entry) => entry.kind === "g2-corner-curvature"), false);
  // Normals pointing apart compare curvature with the sign turned: the same surface seen from the other side is alike.
  const flipped: PrincipalCurvature = { ...flank, normal: [-1, 0, 0], kuPerMm: 0.00675, kvPerMm: -0.002 };
  assert.ok(g2CornerCurvatureMismatch(flank, flipped, [[0, 1, 0], [0, 0, -1]])!.differencePerMm < 1e-12);
});

// Item 10: loft guide ends snapped onto profiles.
import { loftSnapPlan } from "./operations.ts";

test("loftSnapPlan: touching ends stay, ends within the tolerance move onto the nearest profile point, far ends are left", () => {
  const plan = loftSnapPlan([
    { guideId: 5, endMm: [42, -32.46, 73.4], nearestMm: [41.99999999, -32.459482, 73.396648], distanceMm: 0.00339 },
    { guideId: 5, endMm: [0, 0, 0], nearestMm: [0, 0, 0], distanceMm: 0 },
    { guideId: 6, endMm: [1, 0, 0], nearestMm: [1, 0.5, 0], distanceMm: 0.5 },
  ], 0.01);
  assert.equal(plan.touching, 1);
  assert.equal(plan.snaps.length, 1);
  assert.equal(plan.snaps[0]!.guideId, 5);
  assert.deepEqual(plan.snaps[0]!.toMm, [41.99999999, -32.459482, 73.396648]);
  assert.ok(Math.abs(plan.snaps[0]!.deltaMm[2] + 0.003352) < 1e-9);
  assert.deepEqual(plan.tooFar.map((end) => end.guideId), [6]);
  assert.equal(loftSnapPlan([{ guideId: 5, endMm: [0, 0, 0], nearestMm: [0, 0.005, 0], distanceMm: 0.005 }], 0).snaps.length, 0);
  assert.throws(() => loftSnapPlan([], -1), /nonnegative/);
  // A profile end vertex within the tolerance wins over the nearest curve point.
  const vertex = loftSnapPlan([{ guideId: 7, endMm: [0, 0.004, 0], nearestMm: [0.0016, 0.0008, 0], distanceMm: 0.0036, nearestVertexMm: [0, 0, 0], vertexDistanceMm: 0.004 }], 0.01);
  assert.deepEqual(vertex.snaps[0]!.toMm, [0, 0, 0]);
  assert.equal(vertex.snaps[0]!.distanceMm, 0.004);
  const onVertex = loftSnapPlan([{ guideId: 7, endMm: [0, 0, 0], nearestMm: [0, 0, 0], distanceMm: 0, nearestVertexMm: [0, 0, 0], vertexDistanceMm: 0 }], 0.01);
  assert.equal(onVertex.touching, 1);
});

// Item 13 wording: a native failure after a clean pre-check is "no known cause; likely ...", not a contradiction.
import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";
import type { NativePatchBoundary } from "./surfacing.ts";

test("a FillHole 22094 after a clean pre-check says the pre-check found no known cause and what is likely", async () => {
  const Z: Vector3 = [0, 0, 1];
  const edges = ["e1", "e2"].map((id) => ({ id, curveType: "Line", line: true, circle: false, lengthMm: 10, centerMm: [0, 0, 0] as Vector3, tangent: [1, 0, 0] as Vector3, boundsMm: { min: [0, 0, 0] as Vector3, max: [10, 0, 0] as Vector3 }, faceIds: ["fA"], vertexIds: [1] }));
  const sheet = { id: 7, versionId: 17, type: "Sheet", name: null, boundsMm: null, faceIds: ["fA"], edgeIds: ["e1", "e2"], faces: [], edges };
  const state = { targetId: "w", title: "t", documentToken: "doc", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" }, bodies: [sheet] } as unknown as RuntimeState;
  const native: NativePatchBoundary = {
    edges: [
      { edgeId: "e1", faceId: "fA", ends: [{ t: 0, pointMm: [0, 0, 0], tangentAway: [1, 0, 0], vertexId: null, inward: null, normal: Z }, { t: 1, pointMm: [5, 5, 0], tangentAway: [-1, 0, 0], vertexId: null, inward: null, normal: Z }] },
      { edgeId: "e2", faceId: "fA", ends: [{ t: 0, pointMm: [0, 0, 0], tangentAway: [0, 1, 0], vertexId: null, inward: null, normal: Z }, { t: 1, pointMm: [5, 5, 0], tangentAway: [0, -1, 0], vertexId: null, inward: null, normal: Z }] },
    ],
    wires: [],
    vertices: [],
  };
  const runtime = {
    async getState() { return state; },
    async readNative() { return native; },
    async mutate() { throw new Error("Plasticity command failed: Error: Operation FillHole failed with error `22094`."); },
  } as unknown as PlasticityRuntime;
  await assert.rejects(new PlasticityOperations(runtime).patchSheetHole(7, ["e1", "e2"], "r1", { continuity: "g2", precheck: "warn" }),
    /FillHole error 22094: .*Boundary analysis: the pre-check found no known cause \(corner normals, angle budget, edge count, G2 corner curvature\); likely a geometric G1\/G2 condition it does not model: try G1 instead of G2 on one edge at a time/);
});
