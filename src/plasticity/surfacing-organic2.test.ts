import assert from "node:assert/strict";
import test from "node:test";

import {
  checkPatchBoundary,
  countInflections,
  patchCornerAngleDeg,
  patchHoleErrorCode,
  patchPrecheckInputFromNative,
  planeCurveWorldPoints,
  resolveCurvePlane,
  wireJunctions,
  type NativePatchBoundary,
  type PatchPrecheckCorner,
  type PatchPrecheckInput,
} from "./surfacing.ts";
import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

type V = [number, number, number];
const Z: V = [0, 0, 1];

// A square hole in a flat sheet at its corner (0, 0, 0): edge A runs along +x with its face below (inward -y), edge B
// along +y with its face to the left (inward -x). The patch fills the first quadrant: corner angle 90 degrees.
function squareCorner(overrides: Partial<PatchPrecheckCorner> = {}): PatchPrecheckCorner {
  return {
    vertexId: 7,
    positionMm: [0, 0, 0],
    items: [0, 1],
    tangents: [[1, 0, 0], [0, 1, 0]],
    normals: [Z, Z],
    inward: [[0, -1, 0], [-1, 0, 0]],
    faces: [{ faceId: "fA", normal: Z, angleDeg: 180 }, { faceId: "fB", normal: Z, angleDeg: 90 }],
    closedByPatch: true,
    ...overrides,
  };
}
const twoEdges = (a: "g0" | "g1" | "g2", b: "g0" | "g1" | "g2", faceB = "fB"): PatchPrecheckInput["items"] => [
  { kind: "edge", id: "eA", faceId: "fA", continuity: a },
  { kind: "edge", id: "eB", faceId: faceB, continuity: b },
];

test("pre-check: a fitting corner passes (shared tangent plane, angles add to 360 degrees)", () => {
  const result = checkPatchBoundary({ items: twoEdges("g1", "g1"), corners: [squareCorner()] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
  const corner = result.corners[0]!;
  assert.equal(corner.patchAngleDeg, 90);
  assert.equal(corner.angleSumDeg, 360);
  assert.equal(corner.smooth, true);
  assert.equal(corner.faceCount, 2);
  assert.equal(corner.boundaryTurnDeg, 90);
});

test("pre-check: neighbour normals disagreeing beyond tolerance refuse with the vertex named when the patch cannot crease", () => {
  const tilted: V = [0, Math.sin(7.3 * Math.PI / 180), Math.cos(7.3 * Math.PI / 180)];
  const corner = squareCorner({ normals: [Z, tilted], faces: [{ faceId: "fA", normal: Z, angleDeg: 180 }, { faceId: "fB", normal: tilted, angleDeg: 90 }] });
  for (const options of [{ faces: "single" as const }, { smoothness: "smooth" as const }]) {
    const result = checkPatchBoundary({ items: twoEdges("g1", "g1"), corners: [corner], ...options });
    assert.equal(result.ok, false);
    const problem = result.problems.find((entry) => entry.kind === "normals-disagree")!;
    assert.equal(problem.blocking, true);
    assert.equal(problem.cornerVertexId, 7);
    assert.equal(problem.measured, 7.3);
    assert.match(problem.message, /neighbour normals disagree by 7\.3° at vertex 7 \(0, 0, 0\): faces fA and fB do not share a tangent plane, so G1 to both is impossible/);
    assert.match(problem.advice, /ask G0 on edge eA or eB/);
  }
  // The same corner with the default patch options: native creases the patch there (live), so it is reported, not refused.
  const relaxed = checkPatchBoundary({ items: twoEdges("g1", "g1"), corners: [corner] });
  assert.equal(relaxed.ok, true);
  assert.equal(relaxed.problems.find((entry) => entry.kind === "normals-disagree")?.blocking, false);
  // Within the 2 degree tolerance, or with G0 on one side, nothing is reported.
  const close: V = [0, Math.sin(1.5 * Math.PI / 180), Math.cos(1.5 * Math.PI / 180)];
  assert.equal(checkPatchBoundary({ items: twoEdges("g1", "g1"), corners: [squareCorner({ normals: [Z, close] })], faces: "single" }).problems.length, 0);
  assert.equal(checkPatchBoundary({ items: twoEdges("g1", "g0"), corners: [corner], faces: "single" }).problems.filter((entry) => entry.kind === "normals-disagree").length, 0);
  // The lead's switch makes the default options refuse too.
  assert.equal(checkPatchBoundary({ items: twoEdges("g1", "g1"), corners: [corner] }, { normalsRefuseWithCrease: true }).ok, false);
});

test("pre-check: an angle sum of 540 degrees at a smooth vertex refuses with the vertex named", () => {
  // Faces at the vertex 180 + 180 + 90 plus the patch corner 90: the tutorial rebuild's first rear closure.
  const corner = squareCorner({
    vertexId: 189379,
    positionMm: [35, 8, 70.1],
    faces: [{ faceId: "bowl", normal: Z, angleDeg: 180 }, { faceId: "side", normal: Z, angleDeg: 180 }, { faceId: "head", normal: Z, angleDeg: 90 }],
  });
  const result = checkPatchBoundary({ items: twoEdges("g1", "g0", "side"), corners: [corner] });
  assert.equal(result.ok, false);
  const problem = result.problems.find((entry) => entry.kind === "angle-budget")!;
  assert.equal(problem.blocking, true);
  assert.equal(problem.cornerVertexId, 189379);
  assert.equal(problem.measured, 540);
  assert.match(problem.message, /angles at vertex 189379 \(35, 8, 70\.1\) sum to 540° \(3 faces: bowl 180° \+ side 180° \+ head 90°, plus the patch corner 90°\)/);
  assert.match(problem.message, /a smooth patch needs 360°/);
  assert.match(problem.advice, /ask G0 on edge eA/);
  // The budget is not judged where the patch is G0 on both sides, where the faces do not share a tangent plane, or where
  // another open boundary leaves the vertex (the faces need not surround it).
  assert.equal(checkPatchBoundary({ items: twoEdges("g0", "g0", "side"), corners: [corner] }).ok, true);
  assert.equal(checkPatchBoundary({ items: twoEdges("g1", "g0", "side"), corners: [{ ...corner, closedByPatch: false }] }).ok, true);
  const creased = { ...corner, faces: [...corner.faces.slice(0, 2), { faceId: "head", normal: [1, 0, 0] as V, angleDeg: 90 }] };
  assert.equal(checkPatchBoundary({ items: twoEdges("g1", "g0", "side"), corners: [creased] }).problems.filter((entry) => entry.kind === "angle-budget").length, 0);
});

test("pre-check: mixed continuity is reported (G0 is only a minimum; native may come back tangent there), never refused", () => {
  const result = checkPatchBoundary({
    items: [
      { kind: "edge", id: "arc1", faceId: "wall", continuity: "g1" },
      { kind: "edge", id: "arc2", faceId: "wall", continuity: "g0" },
      { kind: "edge", id: "top", faceId: "lid", continuity: "g1" },
    ],
    corners: [],
  });
  const problem = result.problems.find((entry) => entry.kind === "mixed-continuity")!;
  assert.ok(problem);
  assert.deepEqual(problem.edgeIds, ["arc2"]);
  assert.deepEqual(problem.faceIds, ["wall"]);
  assert.match(problem.message, /edges arc2 \(G0\) ask less than G1; on Plasticity 26\.1\.3 that is only a minimum: Indie Patch keeps the G1 edges and may come back G1 on these too where a smooth fill allows it .*arc2 also shares a neighbour face with a G1 edge, and splitting that face did not change it\); it never makes a crease on request/);
  assert.equal(problem.blocking, false); // native succeeds; G0 edges may come back G1 (FINDINGS, phase B)
  assert.equal(result.ok, true);
  assert.deepEqual(result.edges.find((edge) => edge.edgeId === "arc1")?.sharesFaceWith, ["arc2"]);
  // Different faces too (an open box with one wall G1 came back G1 on all four rim edges).
  const box = checkPatchBoundary({ items: ["x0", "y0", "x40", "y40"].map((id, i) => ({ kind: "edge" as const, id, faceId: `w${i}`, continuity: i === 0 ? "g1" as const : "g0" as const })), corners: [] });
  assert.deepEqual(box.problems.find((entry) => entry.kind === "mixed-continuity")?.edgeIds, ["y0", "x40", "y40"]);
  // Same continuity on both: nothing to report.
  assert.equal(checkPatchBoundary({ items: [{ kind: "edge", id: "a", faceId: "w", continuity: "g1" }, { kind: "edge", id: "b", faceId: "w", continuity: "g1" }], corners: [] }).problems.length, 0);
});

test("pre-check: more than 20 boundary edges with any edge G1 or G2 are reported, never refused (R1)", () => {
  const items = (count: number, faces = count) => Array.from({ length: count }, (_, i) => ({ kind: "edge" as const, id: `e${i}`, faceId: `f${i % faces}`, continuity: "g1" as const }));
  assert.equal(checkPatchBoundary({ items: items(20), corners: [] }).problems.length, 0);
  const many = checkPatchBoundary({ items: items(21), corners: [] });
  assert.equal(many.ok, true);
  assert.equal(many.problems[0]!.kind, "too-many-edges");
  assert.equal(many.problems[0]!.blocking, false);
  assert.match(many.problems[0]!.message, /the boundary has 21 items \(21 edges on 21 faces\); Indie Patch G1\/G2 failed on more than 20 in every live test/);
  const fewFaces = checkPatchBoundary({ items: items(24, 4), corners: [] });
  assert.equal(fewFaces.ok, true);
  assert.equal(fewFaces.problems[0]!.blocking, false);
  // All G0: no count limit.
  assert.equal(checkPatchBoundary({ items: items(30).map((item) => ({ ...item, continuity: "g0" as const })), corners: [] }).problems.length, 0);
});

test("pre-check: the patch corner angle lies on the side away from the neighbour face", () => {
  assert.equal(patchCornerAngleDeg([1, 0, 0], [0, 1, 0], [0, -1, 0], Z), 90);
  // Face above edge A: the patch turns the other way round to +y, through 270 degrees.
  assert.equal(patchCornerAngleDeg([1, 0, 0], [0, 1, 0], [0, 1, 0], Z), 270);
  // A straight continuation is 180 degrees; the sign of the plane normal does not matter.
  assert.ok(Math.abs(patchCornerAngleDeg([1, 0, 0], [-1, 0, 0], [0, -1, 0], [0, 0, -1])! - 180) < 1e-9);
});

test("pre-check input from native boundary geometry pairs item ends into corners and marks closed vertices", () => {
  const native: NativePatchBoundary = {
    edges: [
      { edgeId: "eA", faceId: "fA", ends: [{ t: 0, pointMm: [0, 0, 0], tangentAway: [1, 0, 0], vertexId: 1, inward: [0, -1, 0], normal: Z }, { t: 1, pointMm: [10, 0, 0], tangentAway: [-1, 0, 0], vertexId: 2, inward: [0, -1, 0], normal: Z }] },
      { edgeId: "eB", faceId: "fB", ends: [{ t: 0, pointMm: [0, 0, 0], tangentAway: [0, 1, 0], vertexId: 1, inward: [-1, 0, 0], normal: Z }, { t: 1, pointMm: [0, 10, 0], tangentAway: [0, -1, 0], vertexId: 3, inward: [-1, 0, 0], normal: Z }] },
    ],
    wires: [{ wireId: 9, ends: [{ pointMm: [10, 0, 0.001], tangentAway: [0, 1, 0] }, { pointMm: [0, 10, 0], tangentAway: [1, 0, 0] }] }],
    vertices: [
      { vertexId: 1, positionMm: [0, 0, 0], faces: [{ faceId: "fA", normal: Z, angleDeg: 180 }, { faceId: "fB", normal: Z, angleDeg: 90 }], boundaryEdgeIds: ["eA", "eB"] },
      { vertexId: 2, positionMm: [10, 0, 0], faces: [{ faceId: "fA", normal: Z, angleDeg: 90 }], boundaryEdgeIds: ["eA", "eOther"] },
      { vertexId: 3, positionMm: [0, 10, 0], faces: [{ faceId: "fB", normal: Z, angleDeg: 90 }], boundaryEdgeIds: ["eB", "eMore"] },
    ],
  };
  const input = patchPrecheckInputFromNative(native, (edgeId) => (edgeId === "eA" ? "g1" : "g0"), { faces: "single" });
  assert.equal(input.items.length, 3);
  assert.deepEqual(input.items.map((item) => item.continuity), ["g1", "g0", "g0"]);
  assert.equal(input.corners.length, 3);
  const atOrigin = input.corners.find((corner) => corner.vertexId === 1)!;
  assert.deepEqual(atOrigin.items, [0, 1]);
  assert.equal(atOrigin.closedByPatch, true);
  const atWireEnd = input.corners.find((corner) => corner.vertexId === 2)!;
  assert.deepEqual(atWireEnd.items, [0, 2]);
  assert.equal(atWireEnd.closedByPatch, false);
  assert.equal(input.faces, "single");
  assert.equal(checkPatchBoundary(input).ok, true);
});

test("FillHole error codes are read from the native message", () => {
  assert.equal(patchHoleErrorCode(new Error("Plasticity command failed: Error: Operation FillHole failed with error `22093`.")), 22093);
  assert.equal(patchHoleErrorCode(new Error("XNurbs operation failed with error `30`.")), undefined);
});

test("patchSheetHole refuses before native on a blocking pre-check problem, and attaches the analysis to FillHole errors", async () => {
  const edges = ["e1", "e2"].map((id) => ({ id, curveType: "Line", line: true, circle: false, lengthMm: 10, centerMm: [0, 0, 0] as V, tangent: [1, 0, 0] as V, boundsMm: { min: [0, 0, 0] as V, max: [10, 0, 0] as V }, faceIds: [id === "e1" ? "fA" : "fB"], vertexIds: [1] }));
  const sheet = { id: 7, versionId: 17, type: "Sheet", name: null, boundsMm: null, faceIds: ["fA", "fB"], edgeIds: ["e1", "e2"], faces: [], edges };
  const state = { targetId: "w", title: "t", documentToken: "doc", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" }, bodies: [sheet] } as unknown as RuntimeState;
  const native: NativePatchBoundary = {
    edges: [
      { edgeId: "e1", faceId: "fA", ends: [{ t: 0, pointMm: [0, 0, 0], tangentAway: [1, 0, 0], vertexId: 1, inward: [0, -1, 0], normal: Z }, { t: 1, pointMm: [5, 5, 0], tangentAway: [-1, 0, 0], vertexId: 2, inward: [0, -1, 0], normal: Z }] },
      { edgeId: "e2", faceId: "fB", ends: [{ t: 0, pointMm: [0, 0, 0], tangentAway: [0, 1, 0], vertexId: 1, inward: [-1, 0, 0], normal: Z }, { t: 1, pointMm: [5, 5, 0], tangentAway: [0, -1, 0], vertexId: 2, inward: [-1, 0, 0], normal: Z }] },
    ],
    wires: [],
    vertices: [
      { vertexId: 1, positionMm: [0, 0, 0], faces: [{ faceId: "fA", normal: Z, angleDeg: 180 }, { faceId: "fB", normal: Z, angleDeg: 180 }, { faceId: "fC", normal: Z, angleDeg: 90 }], boundaryEdgeIds: ["e1", "e2"] },
      { vertexId: 2, positionMm: [5, 5, 0], faces: [], boundaryEdgeIds: ["e1", "e2"] },
    ],
  };
  let mutations = 0;
  let mutateError: Error | undefined;
  const runtime = {
    async getState() { return state; },
    async readNative() { return native; },
    async mutate() { mutations += 1; if (mutateError) throw mutateError; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  await assert.rejects(operations.patchSheetHole(7, ["e1", "e2"], "r1", { continuity: "g1" }), /pre-check refused the patch before any change: 1\. angles at vertex 1 \(0, 0, 0\) sum to 540°.*Fix: ask G0 on edges e1 and e2/);
  assert.equal(mutations, 0);
  // G0 everywhere: no check, native runs.
  await operations.patchSheetHole(7, ["e1", "e2"], "r1");
  assert.equal(mutations, 1);
  // warn runs native and hands the analysis over; off skips the check.
  let seen: unknown;
  await operations.patchSheetHole(7, ["e1", "e2"], "r1", { continuity: "g1", precheck: "warn", onPrecheck: (analysis) => { seen = analysis; } });
  assert.equal(mutations, 2);
  assert.equal((seen as { ok: boolean }).ok, false);
  mutateError = new Error("Plasticity command failed: Error: Operation FillHole failed with error `22094`.");
  await assert.rejects(operations.patchSheetHole(7, ["e1", "e2"], "r1", { continuity: "g1", precheck: "off" }), /FillHole failed with error `22094`\. FillHole error 22094: .*Boundary analysis: 1\. angles at vertex 1/);
  assert.equal(mutations, 3);
  // The read-only check returns the same analysis.
  const check = await operations.checkPatchBoundary(7, ["e1", "e2"], "r1", { continuity: "g1" });
  assert.equal(check.ok, false);
  assert.equal(check.revision, "r1");
});

test("plane curve frames: named planes offset along +Z, +Y, +X; custom axes are orthonormalised", () => {
  const xz = resolveCurvePlane("xz", 7.5);
  assert.deepEqual(xz.originMm, [0, 7.5, 0]);
  assert.deepEqual(planeCurveWorldPoints(xz, [[1, 2]]), [[1, 7.5, 2]]);
  assert.deepEqual(planeCurveWorldPoints(resolveCurvePlane("xy", -3), [[1, 2]]), [[1, 2, -3]]);
  assert.deepEqual(planeCurveWorldPoints(resolveCurvePlane("yz", 4), [[1, 2]], 2, [5, -5]), [[4, 7, -1]]);
  const custom = resolveCurvePlane({ originMm: [10, 20, 30], uAxis: [2, 0, 0], vAxis: [1, 3, 0] }, 1);
  assert.deepEqual(custom.uAxis, [1, 0, 0]);
  assert.deepEqual(custom.vAxis, [0, 1, 0]);
  assert.deepEqual(custom.normal, [0, 0, 1]);
  assert.deepEqual(custom.originMm, [10, 20, 31]);
  assert.throws(() => resolveCurvePlane({ originMm: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [1, 0.001, 0] }), /at least 1 degree/);
  assert.throws(() => planeCurveWorldPoints(xz, [[0, 0]], 0), /scale must be a positive/);
});

test("wire junctions: a filleted corner is G1 (0 against 1/r), a sharp one G0, a split curve G2; inflections count sign changes", () => {
  const line1 = { entityId: 1, startMm: [0, 0, 0] as V, endMm: [25, 0, 0] as V, startTangent: [1, 0, 0] as V, endTangent: [1, 0, 0] as V, lengthMm: 25 };
  const arc = { entityId: 2, startMm: [30, 5, 0] as V, endMm: [25, 0, 0] as V, startTangent: [0, -1, 0] as V, endTangent: [-1, 0, 0] as V, lengthMm: 7.85 };
  const line2 = { entityId: 3, startMm: [30, 5, 0] as V, endMm: [30, 30, 0] as V, startTangent: [0, 1, 0] as V, endTangent: [0, 1, 0] as V, lengthMm: 25 };
  const flat = (from: V, to: V) => [{ positionMm: from, vectorPerMm: [0, 0, 0] as V }, { positionMm: to, vectorPerMm: [0, 0, 0] as V }];
  const samples = new Map([
    [1, flat([0, 0, 0], [25, 0, 0])],
    [2, [{ positionMm: [30, 5, 0] as V, vectorPerMm: [-0.2, 0, 0] as V }, { positionMm: [25, 0, 0] as V, vectorPerMm: [0, 0.2, 0] as V }]],
    [3, flat([30, 5, 0], [30, 30, 0])],
  ]);
  const report = wireJunctions([arc, line1, line2], samples, { normalAngleDeg: 1, relativeCurvature: 0.1 });
  assert.equal(report.junctions.length, 2);
  for (const junction of report.junctions) {
    assert.equal(junction.class, "G1");
    assert.ok(junction.tangentAngleDeg < 1e-9);
    assert.deepEqual([...junction.curvaturePerMm].sort(), [0, 0.2]);
    assert.equal(junction.relativeCurvatureMismatch, 1);
  }
  const sharp = wireJunctions([line1, { ...line2, startMm: [25, 0, 0] }], new Map(), { normalAngleDeg: 1, relativeCurvature: 0.1 });
  assert.equal(sharp.junctions[0]!.class, "G0");
  assert.ok(Math.abs(sharp.junctions[0]!.tangentAngleDeg - 90) < 1e-9);
  const k: V = [0, 0.1, 0];
  const split = wireJunctions([
    { entityId: 5, startMm: [0, 0, 0], endMm: [10, 0, 0], startTangent: [1, 0, 0], endTangent: [1, 0, 0], lengthMm: 10 },
    { entityId: 6, startMm: [20, 0, 0], endMm: [10, 0, 0], startTangent: [-1, 0, 0], endTangent: [-1, 0, 0], lengthMm: 10 },
  ], new Map([[5, [{ positionMm: [10, 0, 0] as V, vectorPerMm: k }]], [6, [{ positionMm: [10, 0, 0] as V, vectorPerMm: k }]]]), { normalAngleDeg: 1, relativeCurvature: 0.1 });
  assert.equal(split.junctions[0]!.class, "G2");
  assert.equal(countInflections([[0, 1, 0], [0, 0.5, 0], [0, 0, 0], [0, -0.5, 0], [0, -1, 0], [0, 1, 0]].map((v) => ({ positionMm: [0, 0, 0] as V, vectorPerMm: v as V }))), 2);
});
