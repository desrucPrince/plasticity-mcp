import assert from "node:assert/strict";
import { test } from "node:test";

import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

const sectionState = (count: number): RuntimeState => ({
  targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: `r-${count}`, dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], bodies: [],
  construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" },
  sectionAnalyses: Array.from({ length: count }, (_, index) => ({ id: index + 3, name: null, originMm: [0, 0, 5], normal: [0, 0, 1], visible: true, registeredViewportCount: 1 })),
}) as unknown as RuntimeState;

// G3: delete_section_analysis all: true.
test("deleteAllSectionAnalyses clears every listed section analysis in one native call", async () => {
  let state = sectionState(2);
  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { calls.push({ source, bindings, values }); state = sectionState(0); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const after = await operations.deleteAllSectionAnalyses("r-2");
  assert.deepEqual(after.sectionAnalyses, []);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.source, /this\.shading\.section = null/);
  assert.match(calls[0]!.source, /viewport\.setNeedsRender/);
  assert.deepEqual(calls[0]!.bindings, []);
});

test("deleteAllSectionAnalyses with none active runs nothing; a stale revision is refused first", async () => {
  let mutations = 0;
  const state = sectionState(0);
  const runtime = { async getState() { return state; }, async mutate() { mutations += 1; return {}; } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const same = await operations.deleteAllSectionAnalyses(state.revision);
  assert.equal(same.revision, state.revision);
  await assert.rejects(operations.deleteAllSectionAnalyses("old"), /stale reference/i);
  assert.equal(mutations, 0);
});

// G5: a chamfer larger than an arc radius.
const circle = (id: string, radiusMm: number) => ({ id, curveType: "Circle", line: false, circle: true, lengthMm: 11, centerMm: [0, 0, 0], tangent: [1, 0, 0], boundsMm: { min: [0, 0, 0], max: [0, 0, 0] }, faceIds: [], vertexIds: [], circleGeometry: { radiusMm } });
const line = (id: string) => ({ id, curveType: "Line", line: true, circle: false, lengthMm: 20, centerMm: [0, 0, 0], tangent: [0, 1, 0], boundsMm: { min: [0, 0, 0], max: [0, 0, 0] }, faceIds: [], vertexIds: [] });

function chamferFixture(addedFaces: number) {
  const edges = [line("l1"), line("l2"), circle("a1", 7), circle("a2", 7)];
  const body = (faces: number) => ({ id: 9, versionId: 90 + faces, type: "Solid", name: null, boundsMm: null, faceIds: Array.from({ length: faces }, (_, i) => `f${i}`), edgeIds: edges.map((edge) => edge.id), faces: [], edges });
  let state = { targetId: "w", title: "t", documentToken: "d", revision: "r1", dbVersion: 1, undoDepth: 2, redoDepth: 0, regions: [], construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" }, bodies: [body(10)] } as unknown as RuntimeState;
  const runtime = {
    async getState() { return state; },
    async mutate() { state = { ...state, revision: "r2", undoDepth: 3, bodies: [body(10 + addedFaces)] } as unknown as RuntimeState; return {}; },
  } as unknown as PlasticityRuntime;
  return new PlasticityOperations(runtime);
}

test("a chamfer larger than an arc radius that adds fewer faces than edges fails honestly", async () => {
  const operations = chamferFixture(2);
  await assert.rejects(operations.chamfer(9, ["l1", "l2", "a1", "a2"], 7.41, "r1"), (error: Error) => {
    assert.match(error.message, /larger than the radius of arc edge a1 \(R7 mm\), a2 \(R7 mm\)/);
    assert.match(error.message, /made 2 chamfer faces for 4 edges/);
    assert.match(error.message, /revision r2/);
    assert.match(error.message, /plasticity_undo/);
    return true;
  });
});

test("a chamfer larger than an arc radius that adds a face per edge, or any chamfer within the radius, is returned", async () => {
  assert.equal((await chamferFixture(4).chamfer(9, ["l1", "l2", "a1", "a2"], 7.41, "r1")).revision, "r2");
  assert.equal((await chamferFixture(2).chamfer(9, ["l1", "l2", "a1", "a2"], 7, "r1")).revision, "r2", "distance equal to the radius is not checked");
  assert.equal((await chamferFixture(0).chamfer(9, ["l1", "l2"], 30, "r1")).revision, "r2", "line edges are never checked");
});
