import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyInsetFaces, InsetPlanarFaceRecipe, insetLoops, insetPlane, insidePolygon, loopPolygon } from "./inset-planar-face.ts";
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
  const region: Array<[number, number]> = [[-20, -10], [20, -10], [20, 10], [-20, 10]];
  assert.deepEqual(classifyInsetFaces(after, plane, outerPoints, 2, 0, region), { panel: ["panel"], rim: ["rimL"] });
  assert.deepEqual(classifyInsetFaces(after, plane, outerPoints, 2, -1.5, region), { panel: ["deep"], rim: [] });
});

test("C1: a coplanar face elsewhere on the body (a second prong top) is neither panel nor rim", () => {
  const outerPoints: V[] = [[-10, -10, 0], [-20, 0, 0], [-10, 10, 0], [10, -10, 0], [20, 0, 0], [10, 10, 0]];
  const after = body(
    [face("panel", [0, 0, 0], [0, 0, 1], true, ["in2"]), face("otherProngTop", [100, 0, 0], [0, 0, 1], true, ["far"])],
    [edge("in2", ["panel"], [], [0, 8, 0]), edge("far", ["otherProngTop"], [], [100, 8, 0])],
  );
  const plane = { originMm: [0, 0, 0] as V, normal: [0, 0, 1] as V };
  const region = loopPolygon(halves, insetLoops(halves, ["L", "R"]).outer, plane);
  // Before C1 this read panel ["panel", "otherProngTop"].
  assert.deepEqual(classifyInsetFaces(after, plane, outerPoints, 2, 0, region), { panel: ["panel"], rim: [] });
});

test("loopPolygon orders the loop through its vertices; insidePolygon tells inside from outside", () => {
  const withVertices = body(halves.faces, halves.edges, [
    { id: 1, positionMm: [0, -10, 0], edgeIds: [] }, { id: 2, positionMm: [0, 10, 0], edgeIds: [] }, { id: 3, positionMm: [-20, -10, 0], edgeIds: [] },
    { id: 4, positionMm: [-20, 10, 0], edgeIds: [] }, { id: 5, positionMm: [20, -10, 0], edgeIds: [] }, { id: 6, positionMm: [20, 10, 0], edgeIds: [] },
  ] as unknown as Body["vertices"]);
  const plane = { originMm: [0, 0, 0] as V, normal: [0, 0, 1] as V };
  const polygon = loopPolygon(withVertices, insetLoops(withVertices, ["L", "R"]).outer, plane);
  assert.equal(polygon.length, 12);
  // Plane frame for +Z: u = +X, w = +Y.
  assert.equal(insidePolygon([0, 0], polygon), true);
  assert.equal(insidePolygon([19, 9], polygon), true);
  assert.equal(insidePolygon([100, 0], polygon), false);
  assert.equal(insidePolygon([0, 11], polygon), false);
});

test("C2: a failure part-way reports what was committed and the Undo steps measured from the Undo depth", async () => {
  const sheet: Body = { ...halves, id: 10, type: "Sheet" } as Body;
  let undoDepth = 3;
  let revision = 0;
  const wires: Body[] = [];
  const stateNow = (): RuntimeState => ({ targetId: "w", title: "t", documentToken: "doc", revision: `r${revision}`, dbVersion: 1, undoDepth, redoDepth: 0, regions: [], construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" }, bodies: [sheet, ...wires] } as unknown as RuntimeState);
  const commit = (wire?: number) => { undoDepth += 1; revision += 1; if (wire) wires.push({ ...sheet, id: wire, type: "Wire", faces: [], edges: [] } as Body); return stateNow(); };
  const operations = {
    async state() { return stateNow(); },
    async extractEdges() { return commit(20); },
    async listCurveDirections() { return { documentToken: "doc", revision: `r${revision}`, curves: [{ id: 20, closed: true, segments: [{ lengthMm: 120 }] }, { id: 21, closed: true, segments: [{ lengthMm: 108 }] }] }; },
    async offsetPlanarCurves() { return commit(21); },
    async imprintCurvesOnBody() { undoDepth += 1; revision += 1; throw new Error("PK_ERROR_bad_imprint"); },
    async remove(ids: number[]) { for (const id of ids) wires.splice(wires.findIndex((wire) => wire.id === id), 1); return commit(); },
    async extrudeFaces() { throw new Error("not reached"); },
  };
  const recipe = new InsetPlanarFaceRecipe(operations as never);
  await assert.rejects(recipe.inset({ bodyId: 10, faceIds: ["L", "R"], distanceMm: 2, revision: "r0" }),
    /Inset failed: PK_ERROR_bad_imprint\. Before the failure it committed: extracted the outer loop \(Wire 20\); offset it by 2 mm \(Wire 21\); removed the temporary Wires 20, 21; the document is 4 Undo steps past revision r0: undo 4 with plasticity_undo to return to it\./);
});
