import assert from "node:assert/strict";
import test from "node:test";

import {
  bridgeEdgePair,
  bridgeOutcome,
  checkPatchBoundary,
  checkSplitPieces,
  clampContinuityMaxima,
  nearAngleWrap,
  patchCornerAngleDeg,
  requireSplitEdge,
  splitEdgeOutcome,
  topologyEntity,
  validateEdgeSplitRequest,
  wireJunctions,
  type PatchPrecheckCorner,
} from "./surfacing.ts";
import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

type V = [number, number, number];
type Body = RuntimeState["bodies"][number];
const Z: V = [0, 0, 1];
const tol = { normalAngleDeg: 1, relativeCurvature: 0.1 };

const edge = (id: string, faceIds: string[], vertexIds: number[], centerMm: V = [0, 0, 0], lengthMm = 10) =>
  ({ id, curveType: "Line", line: true, circle: false, lengthMm, centerMm, tangent: [1, 0, 0] as V, boundsMm: { min: [0, 0, 0] as V, max: [0, 0, 0] as V }, faceIds, vertexIds });
const face = (id: string, centerMm: V = [0, 0, 0]) =>
  ({ id, surfaceType: "Plane", planar: true, centerMm, normal: Z, radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 0] as V, max: [0, 0, 0] as V }, edgeIds: [] as string[] });
const body = (id: number, type: string, faces: ReturnType<typeof face>[], edges: ReturnType<typeof edge>[], vertices: Array<{ id: number; positionMm: V }>): Body =>
  ({ id, versionId: 1, type, name: null, boundsMm: null, faceIds: faces.map((f) => f.id), edgeIds: edges.map((e) => e.id), faces, edges, vertices: vertices.map((v) => ({ ...v, edgeIds: [], faceIds: [] })) }) as unknown as Body;

// The rectangle Sheet of the live run: edge 3e262 from (40, 0, 10) to (0, 0, 10); split at t 0.3 puts vertex 307 at (28, 0, 10).
const rectBefore = body(2, "Sheet", [face("3f266")], [edge("3e262", ["3f266"], [231, 243]), edge("3e257", ["3f266"], [243, 239]), edge("3e252", ["3f266"], [239, 235]), edge("3e247", ["3f266"], [235, 231])],
  [{ id: 231, positionMm: [40, 0, 10] }, { id: 235, positionMm: [40, 20, 10] }, { id: 239, positionMm: [0, 20, 10] }, { id: 243, positionMm: [0, 0, 10] }]);
const rectAfter = body(2, "Sheet", [face("4f266")], [edge("4e262", ["4f266"], [231, 307]), edge("4e308", ["4f266"], [307, 243]), edge("4e257", ["4f266"], [243, 239]), edge("4e252", ["4f266"], [239, 235]), edge("4e247", ["4f266"], [235, 231])],
  [{ id: 231, positionMm: [40, 0, 10] }, { id: 235, positionMm: [40, 20, 10] }, { id: 239, positionMm: [0, 20, 10] }, { id: 243, positionMm: [0, 0, 10] }, { id: 307, positionMm: [28, 0, 10] }]);

test("split edge: exactly one of normalizedParameter (0 < t < 1) and a finite pointMm", () => {
  assert.deepEqual(validateEdgeSplitRequest({ normalizedParameter: 0.3 }), { mode: "parameter", fraction: 0.3 });
  assert.deepEqual(validateEdgeSplitRequest({ pointMm: [1, 2, 3] }), { mode: "point", pointMm: [1, 2, 3] });
  assert.throws(() => validateEdgeSplitRequest({}), /exactly one of normalizedParameter and pointMm/);
  assert.throws(() => validateEdgeSplitRequest({ normalizedParameter: 0.5, pointMm: [0, 0, 0] }), /exactly one/);
  for (const t of [0, 1, -0.1, 1.5, Number.NaN]) assert.throws(() => validateEdgeSplitRequest({ normalizedParameter: t }), /greater than 0 and less than 1/);
  assert.throws(() => validateEdgeSplitRequest({ pointMm: [0, Number.POSITIVE_INFINITY, 0] }), /three finite/);
});

test("split edge: both pieces must be at least 0.01 mm; the edge must be on a current Solid or Sheet", () => {
  checkSplitPieces(40, 0.3);
  assert.throws(() => checkSplitPieces(40, 0.0001), /piece of 0\.004 mm \(minimum 0\.01 mm\)/);
  assert.throws(() => checkSplitPieces(40, 1), /at an end of the edge/);
  assert.throws(() => checkSplitPieces(0, 0.5), /positive length/);
  assert.equal(requireSplitEdge(rectBefore, 2, "3e262").id, "3e262");
  assert.throws(() => requireSplitEdge(rectBefore, 2, "9e9"), /Stale or unknown edge on body 2: 9e9/);
  assert.throws(() => requireSplitEdge(body(5, "Wire", [], [], []), 5, "x"), /current Solid or Sheet body: 5/);
  assert.throws(() => requireSplitEdge(undefined, 6, "x"), /current Solid or Sheet body: 6/);
});

test("split edge outcome: the new vertex at the expected point and the two edges that meet there; a ring stays one edge", () => {
  const outcome = splitEdgeOutcome(rectBefore, rectAfter, [28, 0, 10]);
  assert.equal(outcome.vertexId, 307);
  assert.deepEqual(outcome.edgeIds, ["4e262", "4e308"]);
  assert.equal(outcome.closedEdge, false);
  assert.deepEqual([outcome.faceCountBefore, outcome.faceCountAfter, outcome.edgeCountBefore, outcome.edgeCountAfter, outcome.vertexCountBefore, outcome.vertexCountAfter], [1, 1, 4, 5, 4, 5]);
  assert.throws(() => splitEdgeOutcome(rectBefore, rectAfter, [28.01, 0, 10]), /lies 0\.01\d* mm from the requested point/);
  assert.throws(() => splitEdgeOutcome(rectBefore, rectBefore, [28, 0, 10]), /made no new vertex/);
  assert.throws(() => splitEdgeOutcome(rectBefore, undefined, [28, 0, 10]), /gone after the edge split/);
  // A full circle without a vertex: one vertex, still one closed edge.
  const ringBefore = body(41, "Sheet", [face("86f6758")], [edge("86e6767", ["86f6758"], [])], []);
  const ringAfter = body(41, "Sheet", [face("87f6758")], [edge("87e6767", ["87f6758"], [6790])], [{ id: 6790, positionMm: [0, -20, 40] }]);
  const ring = splitEdgeOutcome(ringBefore, ringAfter, [0, -20, 40]);
  assert.equal(ring.closedEdge, true);
  assert.deepEqual(ring.edgeIds, ["87e6767"]);
});

// The trapezoid channel of the live run: floor 4850, walls 5157 / 5464; the bridge made face 5601 and two joins.
const trapBefore = body(29, "Sheet", [face("68f4850"), face("68f5464"), face("68f5157")], [
  edge("68e4837", ["68f4850", "68f5464"], [1, 2]), edge("68e4833", ["68f4850", "68f5157"], [3, 4]), edge("68e5451", ["68f5464"], [5, 6]), edge("68e5148", ["68f5157"], [7, 8]),
], []);
const trapAfter = body(29, "Sheet", [face("69f5601"), face("69f4850"), face("69f5464"), face("69f5157")], [
  edge("69e5587", ["69f5601"], [9, 10]), edge("69e5553", ["69f5464", "69f5601"], [11, 12]), edge("69e5528", ["69f5157", "69f5601"], [13, 14]),
  edge("69e4837", ["69f4850", "69f5464"], [1, 2]), edge("69e4833", ["69f4850", "69f5157"], [3, 4]),
], []);

test("one-body bridge: two boundary edges of one Sheet on two different faces", () => {
  assert.deepEqual(bridgeEdgePair(trapBefore, 29, "68e5148", "68e5451"), { first: { edgeId: "68e5148", faceId: "68f5157" }, second: { edgeId: "68e5451", faceId: "68f5464" } });
  assert.throws(() => bridgeEdgePair(trapBefore, 29, "68e5148", "68e5148"), /two different edges/);
  assert.throws(() => bridgeEdgePair(trapBefore, 29, "68e5148", "68e4837"), /boundary edges \(one face\); 68e4837 has 2/);
  assert.throws(() => bridgeEdgePair(trapBefore, 29, "68e5148", "1e1"), /Stale or unknown edge on Sheet 29: 1e1/);
  assert.throws(() => bridgeEdgePair(body(3, "Solid", [], [], []), 3, "a", "b"), /current Sheet body: 3/);
  const twoOnOne = body(4, "Sheet", [face("1f1")], [edge("1e2", ["1f1"], []), edge("1e3", ["1f1"], [])], []);
  assert.throws(() => bridgeEdgePair(twoOnOne, 4, "1e2", "1e3"), /Both edges border face 1f1; the native bridge blends two different faces/);
});

test("one-body bridge outcome: the new face and its joins with the two source faces, by stable topology entity", () => {
  assert.equal(topologyEntity("69e5553"), "5553");
  assert.equal(topologyEntity("plain"), "plain");
  const outcome = bridgeOutcome(trapBefore, trapAfter, ["68f5157", "68f5464"]);
  assert.deepEqual(outcome.bridgeFaceIds, ["69f5601"]);
  assert.deepEqual(outcome.joins, [
    { edgeId: "69e5553", faceIds: ["69f5464", "69f5601"], sourceFaceId: "69f5464" },
    { edgeId: "69e5528", faceIds: ["69f5157", "69f5601"], sourceFaceId: "69f5157" },
  ]);
  assert.throws(() => bridgeOutcome(trapBefore, undefined, []), /gone after the bridge/);
});

test("R2: a closed single-segment Wire takes the first curvature sample at its start and the last at its end", () => {
  const closed = { entityId: 9, startMm: [0, 0, 0] as V, endMm: [0, 0, 0] as V, startTangent: [1, 0, 0] as V, endTangent: [1, 0, 0] as V, lengthMm: 60 };
  const samples = new Map([[9, [
    { positionMm: [0, 0, 0] as V, vectorPerMm: [0, 0.1, 0] as V },
    { positionMm: [10, 5, 0] as V, vectorPerMm: [0, 0.3, 0] as V },
    { positionMm: [0, 0, 0] as V, vectorPerMm: [0, 0.5, 0] as V },
  ]]]);
  const report = wireJunctions([closed], samples, tol);
  assert.equal(report.junctions.length, 1);
  const junction = report.junctions[0]!;
  assert.notEqual(junction.class, "G2");
  assert.equal(junction.class, "G1");
  assert.deepEqual(junction.curvaturePerMm, [0.1, 0.5]);
  assert.ok(Math.abs(junction.relativeCurvatureMismatch - 0.4 / 0.6) < 1e-12);
  // The segment's own inner points say the list runs backwards: the sides swap, the class stays.
  const reversed = wireJunctions([{ ...closed, startInnerMm: [-0.1, 0.4, 0], endInnerMm: [-0.1, -0.4, 0] }], new Map([[9, [
    { positionMm: [0, 0, 0] as V, vectorPerMm: [0, 0.5, 0] as V }, { positionMm: [-0.1, -0.4, 0] as V, vectorPerMm: [0, 0.5, 0] as V },
    { positionMm: [-0.1, 0.4, 0] as V, vectorPerMm: [0, 0.1, 0] as V }, { positionMm: [0, 0, 0] as V, vectorPerMm: [0, 0.1, 0] as V },
  ]]]), tol);
  assert.deepEqual(reversed.junctions[0]!.curvaturePerMm, [0.1, 0.5]);
});

test("R4: kernel end tangents running against the segment are re-oriented by the segment's own inner points", () => {
  const first = { entityId: 1, startMm: [0, 0, 0] as V, endMm: [10, 0, 0] as V, startTangent: [1, 0, 0] as V, endTangent: [-1, 0, 0] as V, lengthMm: 10, startInnerMm: [0.1, 0, 0] as V, endInnerMm: [9.9, 0, 0] as V };
  const second = { entityId: 2, startMm: [10, 0, 0] as V, endMm: [20, 0, 0] as V, startTangent: [-1, 0, 0] as V, endTangent: [1, 0, 0] as V, lengthMm: 10, startInnerMm: [10.1, 0, 0] as V, endInnerMm: [19.9, 0, 0] as V };
  const straight = wireJunctions([first, second], new Map(), tol);
  assert.equal(straight.junctions[0]!.tangentAngleDeg, 0);
  assert.equal(straight.junctions[0]!.class, "G2");
  // A real 90 degree corner stays 90 degrees whatever way the kernel tangents run.
  const corner = { entityId: 3, startMm: [10, 0, 0] as V, endMm: [10, 10, 0] as V, startTangent: [0, -1, 0] as V, endTangent: [0, -1, 0] as V, lengthMm: 10, startInnerMm: [10, 0.1, 0] as V, endInnerMm: [10, 9.9, 0] as V };
  assert.ok(Math.abs(wireJunctions([first, corner], new Map(), tol).junctions[0]!.tangentAngleDeg - 90) < 1e-9);
});

test("R5: interior maxima are clamped to the overall maxima and relative G2 to 1", () => {
  const { overall, interior } = clampContinuityMaxima({ g0Mm: 1e-6, g1Deg: 0.1, g2Rel: 1.0000000002 }, { g0Mm: 1.0000001e-6, g1Deg: 0.10000000001, g2Rel: 1.3 });
  assert.equal(overall.g2Rel, 1);
  assert.equal(interior!.g0Mm, 1e-6);
  assert.equal(interior!.g1Deg, 0.1);
  assert.equal(interior!.g2Rel, 1);
  assert.deepEqual(clampContinuityMaxima({ g0Mm: 1, g1Deg: 2, g2Rel: 0.5 }, { g0Mm: 0.5, g1Deg: 1, g2Rel: 0.25 }).interior, { g0Mm: 0.5, g1Deg: 1, g2Rel: 0.25 });
  assert.equal(clampContinuityMaxima({ g0Mm: 1, g1Deg: 2, g2Rel: 0.5 }, undefined).interior, undefined);
});

test("R3: an angle near 0 or 360 degrees makes the angle budget indeterminate instead of refusing", () => {
  // Two 180 degree faces at a vertex on a straight boundary; the patch corner should read 0 but wraps to 359.94.
  const tB: V = [Math.cos(-0.001), Math.sin(-0.001), 0];
  const patch = patchCornerAngleDeg([1, 0, 0], tB, [0, -1, 0], Z)!;
  assert.ok(patch > 359.9 && nearAngleWrap(patch));
  const corner: PatchPrecheckCorner = {
    vertexId: 12, positionMm: [0, 0, 0], items: [0, 1], tangents: [[1, 0, 0], tB], normals: [Z, Z], inward: [[0, -1, 0], [0, -1, 0]],
    faces: [{ faceId: "fA", normal: Z, angleDeg: 180 }, { faceId: "fB", normal: Z, angleDeg: 180 }], closedByPatch: true,
  };
  const items = [{ kind: "edge" as const, id: "eA", faceId: "fA", continuity: "g1" as const }, { kind: "edge" as const, id: "eB", faceId: "fB", continuity: "g1" as const }];
  const result = checkPatchBoundary({ items, corners: [corner] });
  assert.equal(result.ok, true);
  assert.equal(result.problems.filter((entry) => entry.kind === "angle-budget").length, 0);
  const indeterminate = result.problems.find((entry) => entry.kind === "angle-indeterminate")!;
  assert.equal(indeterminate.blocking, false);
  assert.equal(indeterminate.cornerVertexId, 12);
  assert.match(indeterminate.message, /angle budget at vertex 12 \(0, 0, 0\) is indeterminate: an angle there is within 2° of 0° or 360°/);
  assert.equal(result.corners[0]!.angleBudget, "indeterminate");
  // A face angle read as 359.95 by the native source (a wrapped 0) fails open the same way.
  const wrappedFace = checkPatchBoundary({ items, corners: [{ ...corner, tangents: [[1, 0, 0], [0, 1, 0]], faces: [{ faceId: "fA", normal: Z, angleDeg: 359.95 }, { faceId: "fB", normal: Z, angleDeg: 90 }] }] });
  assert.equal(wrappedFace.ok, true);
  assert.ok(wrappedFace.problems.some((entry) => entry.kind === "angle-indeterminate"));
  // A clear budget miss away from the wrap still refuses.
  const broken = checkPatchBoundary({ items, corners: [{ ...corner, tangents: [[1, 0, 0], [0, 1, 0]], faces: [{ faceId: "fA", normal: Z, angleDeg: 180 }, { faceId: "fB", normal: Z, angleDeg: 180 }] }] });
  assert.equal(broken.ok, false);
  assert.equal(broken.corners[0]!.angleBudget, undefined);
});

function mockOperations(states: RuntimeState[], mutateResult: unknown, readResult: unknown = {}) {
  let index = 0;
  const calls: Array<{ source: string; bindings: string[]; args: unknown[] }> = [];
  const runtime = {
    async getState() { return states[Math.min(index, states.length - 1)]!; },
    async readNative(_source: unknown, _bindings: string[], _args: unknown[]) { return readResult; },
    async mutate(source: unknown, bindings: string[], args: unknown[]) { calls.push({ source: String((source as { source?: string })?.source ?? source), bindings, args }); index += 1; return mutateResult; },
  } as unknown as PlasticityRuntime;
  return { operations: new PlasticityOperations(runtime), calls };
}
const stateWith = (revision: string, undoDepth: number, bodies: Body[]): RuntimeState =>
  ({ targetId: "w", title: "t", documentToken: "doc", revision, dbVersion: 1, undoDepth, redoDepth: 0, regions: [], construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" }, bodies }) as unknown as RuntimeState;

test("splitSheetEdge drives Split Segment with the shell edge and reports the two edges, the vertex and one Undo step", async () => {
  const native = { t: 0.3, fraction: 0.3, lengthMm: 40, projectionDistanceMm: null, expectedMm: [28, 0, 10], startMm: [40, 0, 10], endMm: [0, 0, 10], periodic: false };
  const { operations, calls } = mockOperations([stateWith("r1", 3, [rectBefore]), stateWith("r2", 4, [rectAfter])], native);
  const result = await operations.splitSheetEdge({ bodyId: 2, edgeId: "3e262", normalizedParameter: 0.3 }, "r1");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.bindings, ["SplitSegmentFactory"]);
  assert.match(calls[0]!.source, /SplitSegmentCommand/);
  assert.match(calls[0]!.source, /factory\.edge = edgeView/);
  assert.match(calls[0]!.source, /object\.SplitAt\(t\)/);
  assert.deepEqual((calls[0]!.args[0] as { fraction: number }).fraction, 0.3);
  assert.deepEqual(result.split.edgeIds, ["4e262", "4e308"]);
  assert.equal(result.split.vertexId, 307);
  assert.equal(result.split.distanceFromStartMm, 12);
  assert.equal(result.split.undoSteps, 1);
  assert.deepEqual(result.split.counts, { faces: [1, 1], edges: [4, 5], vertices: [4, 5] });
  await assert.rejects(operations.splitSheetEdge({ bodyId: 2, edgeId: "3e262" }, "r2"), /exactly one of normalizedParameter and pointMm/);
});

test("bridgeSheetEdges runs the native bridge on two faces of one Sheet and reads the joins back", async () => {
  const rows = ["69e5528", "69e5553"].map((edgeId) => ({ edge: { bodyId: 29, edgeId }, achievedContinuity: "G2", maximumPositionDeviationMm: 3.9e-15, maximumNormalAngleDeviationDeg: 1.2e-6, maximumRelativeCurvatureDeviation: 0.01 }));
  const { operations, calls } = mockOperations([stateWith("r1", 5, [trapBefore]), stateWith("r2", 6, [trapAfter])], [[10, 10, 20], [30, 10, 20]], rows);
  const result = await operations.bridgeSheetEdges({ bodyId: 29, firstEdgeId: "68e5148", secondEdgeId: "68e5451", widthMm: 30 }, "r1");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.bindings, ["BridgeSurfaceWithPreviewFactory", "Vector3", "BlendShape", "BlendTrim"]);
  assert.match(calls[0]!.source, /BridgeSurfaceCommand/);
  assert.deepEqual((calls[0]!.args[0] as { faces: string[] }).faces, ["68f5157", "68f5464"]);
  assert.equal((calls[0]!.args[0] as { width: number }).width, 0.03);
  assert.deepEqual(result.bridge.bridgeFaceIds, ["69f5601"]);
  assert.deepEqual(result.bridge.joins.map((join) => [join.edgeId, join.achievedContinuity]), [["69e5553", "G2"], ["69e5528", "G2"]]);
  assert.equal(result.bridge.singleBody, true);
  assert.equal(result.bridge.undoSteps, 1);
  assert.deepEqual(result.bridge.pickPointsMm, [[10, 10, 20], [30, 10, 20]]);
  await assert.rejects(operations.bridgeSheetEdges({ bodyId: 29, firstEdgeId: "69e5587", secondEdgeId: "69e4837", widthMm: 30 }, "r2"), /boundary edges/);
});

test("bridgeSheetEdges explains a native face-blend failure", async () => {
  const runtime = {
    async getState() { return stateWith("r1", 5, [trapBefore]); },
    async mutate() { throw new Error("Plasticity command failed: Error: Operation FaceBlend failed at PK_FACE_make_blend with error `17453`."); },
  } as unknown as PlasticityRuntime;
  await assert.rejects(new PlasticityOperations(runtime).bridgeSheetEdges({ bodyId: 29, firstEdgeId: "68e5148", secondEdgeId: "68e5451", widthMm: 10 }, "r1"),
    /error `17453`\. The native bridge is a G2 face blend .*Try another widthMm/);
});

test("R6: a closed plane curve needs at least three points, refused before any change", async () => {
  const { operations, calls } = mockOperations([stateWith("r1", 0, [])], {});
  await assert.rejects(operations.createPlaneCurve({ plane: "xy", points2dMm: [[0, 0], [10, 0]], mode: "interpolate", closed: true }, "r1"), /closed plane curve needs at least three points/);
  assert.equal(calls.length, 0);
});

// Phase C addendum B1-B3 (review of phase B).
test("B3: splitSheetEdge pointMm passes maxProjectionMm (default 1 mm) to the native check that refuses before any change", async () => {
  const native = { t: 0.3, fraction: 0.3, lengthMm: 40, projectionDistanceMm: 0.2, expectedMm: [28, 0, 10], startMm: [40, 0, 10], endMm: [0, 0, 10], periodic: false, splitCalled: true };
  const { operations, calls } = mockOperations([stateWith("r1", 3, [rectBefore]), stateWith("r2", 4, [rectAfter])], native);
  await operations.splitSheetEdge({ bodyId: 2, edgeId: "3e262", pointMm: [28, 0.2, 10] }, "r1");
  assert.equal((calls[0]!.args[0] as { maxProjectionMm: number }).maxProjectionMm, 1);
  assert.match(calls[0]!.source, /if \(projectionDistanceMm > args\.maxProjectionMm\) throw new Error\('pointMm lies ' \+ projectionDistanceMm\.toPrecision\(4\) \+ ' mm from edge '/);
  // The check runs before the Split Segment command starts.
  assert.ok(calls[0]!.source.indexOf("args.maxProjectionMm") < calls[0]!.source.indexOf("SplitSegmentCommand"));
  const second = mockOperations([stateWith("r1", 3, [rectBefore]), stateWith("r2", 4, [rectAfter])], native);
  await second.operations.splitSheetEdge({ bodyId: 2, edgeId: "3e262", pointMm: [28, 3, 10], maxProjectionMm: 5 }, "r1");
  assert.equal((second.calls[0]!.args[0] as { maxProjectionMm: number }).maxProjectionMm, 5);
  await assert.rejects(second.operations.splitSheetEdge({ bodyId: 2, edgeId: "3e262", pointMm: [28, 3, 10], maxProjectionMm: 0 }, "r2"), /maxProjectionMm must be a positive distance/);
});

test("B1: a split check that fails after the native commit says the document changed and how to undo it", async () => {
  const native = { t: 0.3, fraction: 0.3, lengthMm: 40, projectionDistanceMm: null, expectedMm: [28, 0, 10], startMm: [40, 0, 10], endMm: [0, 0, 10], periodic: false };
  const notSplit = mockOperations([stateWith("r1", 3, [rectBefore]), stateWith("r2", 4, [rectBefore])], { ...native, splitCalled: false });
  await assert.rejects(notSplit.operations.splitSheetEdge({ bodyId: 2, edgeId: "3e262", normalizedParameter: 0.3 }, "r1"), /committed without splitting the edge; the document was changed \(1 Undo step\): undo with plasticity_undo/);
  const noVertex = mockOperations([stateWith("r1", 3, [rectBefore]), stateWith("r2", 4, [rectBefore])], native);
  await assert.rejects(noVertex.operations.splitSheetEdge({ bodyId: 2, edgeId: "3e262", normalizedParameter: 0.3 }, "r1"), /made no new vertex; the document was changed \(1 Undo step\): undo with plasticity_undo/);
});

test("B1/B2: bridgeSheetEdges matches joins by edge or face ids only, and warns on a failed read-back, a missing join or a new body", async () => {
  // Read-back rows that match no join (wrong edge ids, no faces): no positional fallback, a warning instead.
  const stray = ["1e1", "1e2"].map((edgeId) => ({ edge: { bodyId: 29, edgeId }, achievedContinuity: "G2" }));
  const unmatched = mockOperations([stateWith("r1", 5, [trapBefore]), stateWith("r2", 6, [trapAfter])], [[10, 10, 20], [30, 10, 20]], stray);
  const result = await unmatched.operations.bridgeSheetEdges({ bodyId: 29, firstEdgeId: "68e5148", secondEdgeId: "68e5451", widthMm: 30 }, "r1");
  assert.deepEqual(result.bridge.joins.map((join) => join.achievedContinuity), [null, null]);
  assert.ok(result.bridge.warnings!.some((warning) => /no continuity read-back matched join edge 69e5553/.test(warning)));
  // Matched by the two face ids when the edge id differs.
  const byFaces = [{ edge: { bodyId: 29, edgeId: "x" }, adjacentFaces: [{ faceId: "69f5601" }, { faceId: "69f5464" }], achievedContinuity: "G1" }, { edge: { bodyId: 29, edgeId: "69e5528" }, achievedContinuity: "G2" }];
  const faces = mockOperations([stateWith("r1", 5, [trapBefore]), stateWith("r2", 6, [trapAfter])], [[10, 10, 20], [30, 10, 20]], byFaces);
  const matched = await faces.operations.bridgeSheetEdges({ bodyId: 29, firstEdgeId: "68e5148", secondEdgeId: "68e5451", widthMm: 30 }, "r1");
  assert.deepEqual(matched.bridge.joins.map((join) => [join.edgeId, join.achievedContinuity]), [["69e5553", "G1"], ["69e5528", "G2"]]);
  assert.equal(matched.bridge.warnings, undefined);
  // One join only, plus a separate new Sheet: two warnings, still a result (the bridge is committed).
  const oneJoin = { ...trapAfter, edges: trapAfter.edges.filter((edge) => edge.id !== "69e5528") };
  const extra = { ...trapAfter, id: 30, edges: [], faces: [] };
  const partial = mockOperations([stateWith("r1", 5, [trapBefore]), stateWith("r2", 6, [oneJoin, extra])], [[10, 10, 20], [30, 10, 20]], []);
  const warned = await partial.operations.bridgeSheetEdges({ bodyId: 29, firstEdgeId: "68e5148", secondEdgeId: "68e5451", widthMm: 30 }, "r1");
  assert.equal(warned.bridge.singleBody, false);
  assert.ok(warned.bridge.warnings!.some((warning) => /did not stay one body: new bodies 30/.test(warning)));
  assert.ok(warned.bridge.warnings!.some((warning) => /found 1 join .*expected 2/.test(warning)));
  // The Sheet gone after the commit: an error that says the document changed.
  const gone = mockOperations([stateWith("r1", 5, [trapBefore]), stateWith("r2", 6, [])], [[10, 10, 20], [30, 10, 20]], []);
  await assert.rejects(gone.operations.bridgeSheetEdges({ bodyId: 29, firstEdgeId: "68e5148", secondEdgeId: "68e5451", widthMm: 30 }, "r1"), /gone after the bridge; the document was changed \(1 Undo step\): undo with plasticity_undo/);
});
