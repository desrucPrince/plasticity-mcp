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

const ENDS: Vector3[] = [[0, 0, 0], [99, 0, 0]];

test("C3: a 90 degree sample next to an edge end, neighbours under 0.1 degree, is a spike; the class ignoring it is G1", () => {
  const samples = series(() => 0, (i) => (i === 2 ? 90 : 0.05), () => 0.3);
  const summary = continuitySampleSummary(samples, maxOf(samples), tolerances, ENDS);
  assert.equal(summary.class, "G0");
  assert.equal(summary.interiorClass, "G1");
  assert.equal(summary.classIgnoringIsolatedSpikes, "G1");
  assert.deepEqual(summary.spikes.map((spike) => [spike.level, spike.index, spike.value, spike.source]), [["G1", 2, 90, "sample"]]);
  assert.ok(summary.spikes[0]!.neighbourMax <= 0.1);
});

test("C3: the same single 90 degree sample in the run of the edge is not a spike; the class stands", () => {
  const samples = series(() => 0, (i) => (i === 40 ? 90 : 0.05), () => 0.3);
  const summary = continuitySampleSummary(samples, maxOf(samples), tolerances, ENDS);
  assert.equal(summary.spikes.length, 0);
  assert.equal(summary.classIgnoringIsolatedSpikes, "G0");
});

test("C3: 90 degrees at every third sample gives G0 (no spikes at all)", () => {
  const samples = series(() => 0, (i) => (i % 3 === 0 ? 90 : 0.01), () => 0.01);
  const summary = continuitySampleSummary(samples, maxOf(samples), tolerances, ENDS);
  assert.equal(summary.spikes.length, 0);
  assert.equal(summary.classIgnoringIsolatedSpikes, "G0");
});

test("C3: a single-sample position gap is never a spike, at the end or mid-edge: the class is none", () => {
  for (const at of [1, 50]) {
    const samples = series((i) => (i === at ? 0.5 : 0), () => 0.01, () => 0.01);
    const summary = continuitySampleSummary(samples, maxOf(samples), tolerances, ENDS);
    assert.equal(summary.class, "none", String(at));
    assert.equal(summary.classIgnoringIsolatedSpikes, "none", String(at));
    assert.equal(summary.spikes.length, 0, String(at));
  }
});

test("C3: a corner run of at most 2 samples is a spike, 3 is not, and more than 2 spikes cancel all of them", () => {
  for (const at of [0, 99]) {
    const samples = series(() => 0, (i) => (i === at ? 90 : 0.02), () => 0.01);
    const summary = continuitySampleSummary(samples, maxOf(samples), tolerances, ENDS);
    assert.equal(summary.interiorClass, "G2", String(at));
    assert.equal(summary.classIgnoringIsolatedSpikes, "G2", String(at));
    assert.equal(summary.spikes[0]!.index, at);
  }
  const two = series(() => 0, (i) => (i === 0 || i === 1 ? 90 : 0.02), () => 0.01);
  assert.equal(continuitySampleSummary(two, maxOf(two), tolerances, ENDS).classIgnoringIsolatedSpikes, "G2");
  const three = series(() => 0, (i) => (i <= 2 ? 90 : 0.02), () => 0.01);
  assert.equal(continuitySampleSummary(three, maxOf(three), tolerances, ENDS).classIgnoringIsolatedSpikes, "G0");
  // A failing neighbour within 2 indices outside the run disqualifies it.
  const near = series(() => 0, (i) => (i === 0 || i === 2 ? 90 : 0.02), () => 0.01);
  assert.equal(continuitySampleSummary(near, maxOf(near), tolerances, ENDS).spikes.length, 0);
  // Three separate spikes (start of G1, end of G1, start of G2 at another sample): none count.
  const many = series(() => 0, (i) => (i === 0 || i === 99 ? 90 : 0.02), (i) => (i === 4 ? 0.9 : 0.01));
  const manySummary = continuitySampleSummary(many, maxOf(many), tolerances, ENDS);
  assert.equal(manySummary.spikes.length, 0);
  assert.equal(manySummary.classIgnoringIsolatedSpikes, "G0");
});

test("C3: a failing native maximum off the samples counts within 1 mm of an end vertex (the real corner case), not mid-edge", () => {
  // Live band/side: every sample below 0.07 degrees, native maximum 90 degrees at the corner vertex.
  const samples = series(() => 0, () => 0.063, () => 0.4);
  const corner = continuitySampleSummary(samples, { g0Mm: 0, g1Deg: 90, g2Rel: 0.4, g1AtMm: [99.4, 0, 0] }, tolerances, ENDS);
  assert.equal(corner.class, "G0");
  assert.equal(corner.classIgnoringIsolatedSpikes, "G1");
  assert.deepEqual([corner.spikes[0]!.level, corner.spikes[0]!.index, corner.spikes[0]!.value, corner.spikes[0]!.source], ["G1", 99, 90, "native-maximum"]);
  const mid = continuitySampleSummary(samples, { g0Mm: 0, g1Deg: 30, g2Rel: 0.4, g1AtMm: [50.5, 0, 0] }, tolerances, ENDS);
  assert.equal(mid.spikes.length, 0);
  assert.equal(mid.classIgnoringIsolatedSpikes, "G0");
  // Without known end vertices a native maximum is never a spike.
  assert.equal(continuitySampleSummary(samples, { g0Mm: 0, g1Deg: 90, g2Rel: 0.4, g1AtMm: [99.4, 0, 0] }, tolerances).spikes.length, 0);
});

test("a failing native maximum with failing samples is not a spike, and a G2 edge stays G2 in all three classes", () => {
  const failing = series(() => 0, () => 2, () => 0.01);
  const summary = continuitySampleSummary(failing, { g0Mm: 0, g1Deg: 90, g2Rel: 0.01 }, tolerances, ENDS);
  assert.equal(summary.spikes.length, 0);
  assert.equal(summary.classIgnoringIsolatedSpikes, "G0");
  const smooth = series(() => 1e-6, () => 0.001, () => 0.001);
  const all = continuitySampleSummary(smooth, maxOf(smooth), tolerances, ENDS);
  assert.deepEqual([all.class, all.interiorClass, all.classIgnoringIsolatedSpikes, all.spikes.length], ["G2", "G2", "G2", 0]);
});

test("4c: interiorClass is never worse than class (interior maxima are clamped), and relative G2 is clamped to 1", () => {
  const samples = series(() => 0, () => 0.01, (i) => (i < 5 ? 0.9 : 0.02));
  const summary = continuitySampleSummary(samples, { g0Mm: 0, g1Deg: 0.01, g2Rel: 1.4 }, tolerances, ENDS);
  assert.equal(summary.class, "G1");
  assert.equal(summary.interiorClass, "G2");
  assert.ok(summary.maximaIgnoringIsolatedSpikes.g2Rel <= 1);
});

test("withContinuitySummary adds interiorContinuity, the class ignoring spikes and spikes, and drops the series and ends", () => {
  const samples = series(() => 0, () => 0.05, () => 0.3);
  const row: Record<string, unknown> = withContinuitySummary<Record<string, unknown>>({
    achievedContinuity: "G0", maximumPositionDeviationMm: 0, maximumNormalAngleDeviationDeg: 90, maximumRelativeCurvatureDeviation: 0.3,
    maximumNormalAngleDeviationAtMm: [0, 0, 0], samples, edgeEndsMm: ENDS,
  }, tolerances);
  assert.equal("samples" in row, false);
  assert.equal("edgeEndsMm" in row, false);
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
    /FillHole error 22094: .*Boundary analysis: the pre-check found no known blocking cause \(corner normals, angle budget\); likely a geometric G1\/G2 condition it does not refuse on: try G1 instead of G2 on one edge at a time/);
  // C5: with only report-only notes (here mixed continuity) the wording is the same, and the notes are listed.
  await assert.rejects(new PlasticityOperations(runtime).patchSheetHole(7, ["e1", "e2"], "r1", { edgeContinuity: [{ edgeId: "e1", continuity: "g2" }, { edgeId: "e2", continuity: "g0" }], precheck: "warn" }),
    /no known blocking cause \(corner normals, angle budget\); its notes, which may explain it: 1\. edges e2 \(G0\) ask less than G2.*; likely a geometric G1\/G2 condition/);
});

test("C7: when a snapped loft fails, the error says which guide end moved and how many Undo steps restore it", async () => {
  let undoDepth = 2;
  const wire = (id: number) => ({ id, versionId: id, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] });
  const stateNow = () => ({ targetId: "w", title: "t", documentToken: "doc", revision: `r${undoDepth}`, dbVersion: 1, undoDepth, redoDepth: 0, regions: [], construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" }, bodies: [wire(1), wire(2), wire(3)] }) as unknown as RuntimeState;
  const runtime = {
    async getState() { return stateNow(); },
    async readNative() { return [{ guideId: 3, endMm: [0, 0.004, 0], nearestMm: [0.0016, 0.0008, 0], distanceMm: 0.0036, nearestVertexMm: [0, 0, 0], vertexDistanceMm: 0.004 }]; },
    async mutate() { throw new Error("Plasticity command failed: Error: Loft failed\n    at stack"); },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const moved: unknown[] = [];
  Object.assign(operations, {
    async listCurveControlPoints() { return { documentToken: "doc", revision: `r${undoDepth}`, curves: [{ id: 3, boundaryVertices: [{ reference: { bodyId: 3, kind: "vertex", pointId: 0 }, positionMm: [0, 0.004, 0] }], interiorControlPoints: [] }] }; },
    async moveCurveControlPoints(points: unknown[], delta: unknown) { moved.push([points, delta]); undoDepth += 1; return stateNow(); },
  });
  const error = await operations.loftCurves([1, 2], { guideIds: [3], snapToleranceMm: 0.01 }, "r2").then(() => undefined, (failure: Error) => failure);
  assert.ok(error);
  assert.equal(moved.length, 1);
  assert.match(error!.message, /^Plasticity command failed: Error: Loft failed\. Before the loft, snapToleranceMm moved a guide end onto the profiles \(guide 3 end 0\.0000, 0\.0040, 0\.0000 -> 0\.0000, 0\.0000, 0\.0000 \(0\.00400 mm\)\); the document is 1 Undo step past the call: undo 1 with plasticity_undo to restore the guides\. guideSnaps: /);
  assert.equal((error as Error & { guideSnaps: unknown[] }).guideSnaps.length, 1);
});

test("C9: offset_planar_curves with plane refuses a Wire more than 0.01 mm from that plane before any change", async () => {
  class KV { x: number; y: number; z: number; constructor(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } }
  const make = (zMm: number) => {
    const edge = { GetPointAndTangent: (t: number) => ({ position: new KV(0.02 * t, 0, (zMm * t) / 1000), tangent: new KV(1, 0, 0) }) };
    class Wire {}
    const editor = {
      geo: { geometryModel: new Map([[5, { view: new Wire(), model: { GetEdges: () => ({ Size: () => 1, Get: () => edge }) } }]]), automatics: new Set() },
      db: { lookupStableId: (versionId: number) => (versionId === 5 ? 9 : undefined) },
      executor: { isBusy: false },
      commands: { OffsetPlanarCurveCommand: class { remember = true; execute: () => Promise<unknown> = async () => undefined; constructor(_editor: unknown) {} } },
      committed: 0,
      async exec(command: { execute: () => Promise<unknown> }) { await command.execute(); },
    };
    class Factory { curves: unknown; constructionPlane: unknown; distance1 = 0; constructor(_editor: unknown) {} resource() { return this; } async commit() { editor.committed += 1; return []; } }
    class Snap { constructor(..._args: unknown[]) {} }
    class Vector { constructor(..._args: unknown[]) {} }
    const natives: Record<string, unknown> = { OffsetPlanarCurvesFactory: Factory, ConstructionPlaneSnap: Snap, Vector3: Vector };
    const state = { targetId: "w", title: "t", documentToken: "doc", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" }, bodies: [{ id: 9, versionId: 5, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] }] } as unknown as RuntimeState;
    const runtime = {
      async getState() { return state; },
      async mutate(source: string, bindings: string[], values: unknown[]) {
        const execute = new Function(`return (${source})`)() as (...args: unknown[]) => Promise<unknown>;
        return await execute.apply(editor, [...bindings.map((name) => natives[name]), ...values]);
      },
    } as unknown as PlasticityRuntime;
    return { operations: new PlasticityOperations(runtime), editor };
  };
  const off = make(0.5);
  await assert.rejects(off.operations.offsetPlanarCurves([9], 2, "r1", { originMm: [0, 0, 0], normal: [0, 0, 1] }), /Wire 9 lies up to 0\.5000 mm from the given offset plane \(tolerance 0\.01 mm\); nothing was changed/);
  assert.equal(off.editor.committed, 0);
  const on = make(0.005);
  await on.operations.offsetPlanarCurves([9], 2, "r1", { originMm: [0, 0, 0], normal: [0, 0, 1] });
  assert.equal(on.editor.committed, 1);
});
