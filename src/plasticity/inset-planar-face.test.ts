import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyInsetFaces, insetLoops, insetPlane } from "./inset-planar-face.ts";
import type { RuntimeState } from "./runtime.ts";

type Body = RuntimeState["bodies"][number];
type V = [number, number, number];
const face = (id: string, centerMm: V, normal: V = [0, 0, 1], planar = true, edgeIds: string[] = []) => ({ id, surfaceType: planar ? "Plane" : "BSurf", planar, centerMm, normal, radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: centerMm, max: centerMm }, edgeIds });
const edge = (id: string, faceIds: string[], vertexIds: number[], centerMm: V, min: V = centerMm, max: V = centerMm) => ({ id, curveType: "Line", line: true, circle: false, lengthMm: 1, centerMm, tangent: [1, 0, 0] as V, boundsMm: { min, max }, faceIds, vertexIds });
const body = (faces: Body["faces"], edges: Body["edges"], vertices?: Body["vertices"]): Body => ({ id: 10, versionId: 1, type: "Solid", name: null, boundsMm: null, faceIds: faces.map((f) => f.id), edgeIds: edges.map((e) => e.id), faces, edges, ...(vertices ? { vertices } : {}) }) as Body;

// Two halves of a 40 x 20 rectangle at z = 0 split by a seam at x = 0 (the attempt-1 tilted face in miniature).
const halves = body(
  [face("L", [-10, 0, 0]), face("R", [10, 0, 0]), face("wall", [0, -10, -5], [0, -1, 0], true)],
  [
    edge("seam", ["L", "R"], [1, 2], [0, 0, 0], [0, -10, 0], [0, 10, 0]),
    edge("Lb", ["L", "wall"], [1, 3], [-10, -10, 0], [-20, -10, 0], [0, -10, 0]), edge("Ll", ["L", "wall"], [3, 4], [-20, 0, 0], [-20, -10, 0], [-20, 10, 0]), edge("Lt", ["L", "wall"], [4, 2], [-10, 10, 0], [-20, 10, 0], [0, 10, 0]),
    edge("Rb", ["R", "wall"], [1, 5], [10, -10, 0], [0, -10, 0], [20, -10, 0]), edge("Rr", ["R", "wall"], [5, 6], [20, 0, 0], [20, -10, 0], [20, 10, 0]), edge("Rt", ["R", "wall"], [6, 2], [10, 10, 0], [0, 10, 0], [20, 10, 0]),
  ],
);

test("insetPlane: coplanar connected faces with one oriented normal; others are refused with the reason", () => {
  assert.deepEqual(insetPlane(halves, ["L", "R"]).normal, [0, 0, 1]);
  assert.throws(() => insetPlane(halves, ["L", "wall"]), /not parallel/);
  const lifted = body([face("L", [-10, 0, 0]), face("R", [10, 0, 0.5])], halves.edges.slice(0, 1));
  assert.throws(() => insetPlane(lifted, ["L", "R"]), /not in its plane/);
  const apart = body([face("L", [-10, 0, 0]), face("R", [10, 0, 0])], []);
  assert.throws(() => insetPlane(apart, ["L", "R"]), /connected through shared edges/);
  const curved = body([face("S", [0, 0, 0], [0, 0, 1], false)], []);
  assert.throws(() => insetPlane(curved, ["S"]), /planar faces; face S is BSurf/);
  assert.throws(() => insetPlane(halves, ["L", "L"]), /unique/);
  assert.throws(() => insetPlane(halves, ["nope"]), /Unknown current face nope/);
});

test("insetLoops: the union's boundary leaves out the seam and the outer loop is the largest", () => {
  const { outer, holes } = insetLoops(halves, ["L", "R"]);
  assert.deepEqual(outer.map((e) => e.id).sort(), ["Lb", "Ll", "Lt", "Rb", "Rr", "Rt"]);
  assert.equal(holes.length, 0);
  const withHole = body(halves.faces, [...halves.edges, edge("h1", ["L", "hole"], [7, 8], [-10, 1, 0], [-11, 0, 0], [-9, 2, 0]), edge("h2", ["L", "hole"], [8, 7], [-10, -1, 0], [-11, -2, 0], [-9, 0, 0])]);
  const split = insetLoops(withHole, ["L", "R"]);
  assert.equal(split.outer.length, 6);
  assert.deepEqual(split.holes.map((loop) => loop.map((e) => e.id).sort()), [["h1", "h2"]]);
});

test("classifyInsetFaces: faces touching the original outer loop are rim, faces at least half the inset away are panel", () => {
  const outerPoints: V[] = [[-10, -10, 0], [-20, 0, 0], [-10, 10, 0], [10, -10, 0], [20, 0, 0], [10, 10, 0]];
  const after = body(
    [face("rimL", [-19, 0, 0], [0, 0, 1], true, ["Ll", "in1"]), face("panel", [0, 0, 0], [0, 0, 1], true, ["in1", "in2"]), face("deep", [0, 0, -1.5], [0, 0, 1], true, ["d1"]), face("wall", [0, -10, -5], [0, -1, 0], true, ["Lb"])],
    [edge("Ll", ["rimL"], [], [-20, 0, 0]), edge("in1", ["rimL", "panel"], [], [-18, 0, 0]), edge("in2", ["panel"], [], [0, 8, 0]), edge("d1", ["deep"], [], [0, 8, -1.5]), edge("Lb", ["wall"], [], [-10, -10, 0])],
  );
  const plane = { originMm: [0, 0, 0] as V, normal: [0, 0, 1] as V };
  assert.deepEqual(classifyInsetFaces(after, plane, outerPoints, 2), { panel: ["panel"], rim: ["rimL"] });
  assert.deepEqual(classifyInsetFaces(after, plane, outerPoints, 2, -1.5), { panel: ["deep"], rim: [] });
});
