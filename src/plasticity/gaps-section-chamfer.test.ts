import assert from "node:assert/strict";
import { test } from "node:test";

import { CHAMFER_SOURCE, chamferFaceCheck, PlasticityOperations, type ChamferNativeEvidence } from "./operations.ts";
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

// G5 / C1: the chamfer read-back. Topology below mimics the live R7 box: faces and edges carry ids
// "<bodyVersion>f<entity>" / "<bodyVersion>e<entity>" and the entity survives a trim, as in Plasticity.

type Body = RuntimeState["bodies"][number];
interface FakeEdge { entity: number; faces: number[]; curve?: "Line" | "Circle"; radiusMm?: number }
function fakeBody(id: number, version: number, faces: number[], edges: FakeEdge[]): Body {
  const faceId = (entity: number) => `${version}f${entity}`;
  return {
    id, versionId: version, type: "Solid", name: null, boundsMm: null,
    faceIds: faces.map(faceId), edgeIds: edges.map((edge) => `${version}e${edge.entity}`),
    faces: faces.map((entity) => ({ id: faceId(entity), surfaceType: "Plane", planar: true, centerMm: [0, 0, 0], normal: [0, 0, 1], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 0], max: [0, 0, 0] }, edgeIds: edges.filter((edge) => edge.faces.includes(entity)).map((edge) => `${version}e${edge.entity}`) })),
    edges: edges.map((edge) => ({
      id: `${version}e${edge.entity}`, curveType: edge.curve ?? "Line", line: edge.curve !== "Circle", circle: edge.curve === "Circle", lengthMm: 10, centerMm: [0, 0, 0], tangent: [1, 0, 0],
      boundsMm: { min: [0, 0, 0], max: [0, 0, 0] }, faceIds: edge.faces.map(faceId), vertexIds: [],
      ...(edge.radiusMm === undefined ? {} : { circleGeometry: { centerMm: [0, 0, 0], radiusMm: edge.radiusMm, normal: [0, 0, 1], reference: [1, 0, 0], startMm: [0, 0, 0], midpointMm: [0, 0, 0], endMm: [0, 0, 0] } }),
    })),
  } as unknown as Body;
}
const identities = (body: Body): Array<[string, number]> => body.faceIds.map((id) => [id, Number(id.split("f")[1])]);

// End face E=1, sides T1-T4 = 2-5, fillets Y1-Y4 = 6-9. Loop: lines L_i = 100+i (E, T_i), arcs A_i = 200+i (E, Y_i, R7).
const LOOP_FACES = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const loopEdges: FakeEdge[] = [1, 2, 3, 4].flatMap((i) => [
  { entity: 100 + i, faces: [1, 1 + i], curve: "Line" as const },
  { entity: 200 + i, faces: [1, 5 + i], curve: "Circle" as const, radiusMm: 7 },
  { entity: 300 + i, faces: [1 + i, 5 + i], curve: "Line" as const },
]);
// After: line chamfer planes C_i = 400+i touch E, T_i, Y_i and Y_(i+1); with every arc chamfered, cones K_i = 500+i too.
function loopAfter(version: number, arcsChamfered: boolean): Body {
  const next = (i: number) => (i % 4) + 1;
  const edges: FakeEdge[] = [1, 2, 3, 4].flatMap((i) => [
    { entity: 600 + i, faces: [1, 400 + i] }, { entity: 610 + i, faces: [400 + i, 1 + i] },
    { entity: 620 + i, faces: [400 + i, 5 + i] }, { entity: 630 + i, faces: [400 + i, 5 + next(i)] },
    { entity: 300 + i, faces: [1 + i, 5 + i] },
    ...(arcsChamfered ? [{ entity: 640 + i, faces: [500 + i, 5 + i], curve: "Circle" as const, radiusMm: 7 }, { entity: 650 + i, faces: [500 + i, 400 + i] }, { entity: 660 + i, faces: [500 + i, 1] }] : []),
  ]);
  return fakeBody(9, version, [...LOOP_FACES, 401, 402, 403, 404, ...(arcsChamfered ? [501, 502, 503, 504] : [])], edges);
}
const LOOP_BEFORE = fakeBody(9, 10, LOOP_FACES, loopEdges);
const loopId = (entity: number) => `10e${entity}`;
const LOOP_CHAIN = [101, 201, 102, 202, 103, 203, 104, 204].map(loopId);

function chamferWorld(after: Body, options: { chain?: string[] | null; failUndo?: boolean; noUndoStep?: boolean; evidence?: boolean } = {}) {
  let revision = 1;
  const stack: Body[][] = [[fakeBody(3, 3, [1], [])]];
  const base = stack[0]!;
  let bodies: Body[] = [...base, LOOP_BEFORE];
  let undoDepth = 2;
  const calls: Array<{ bindings: string[]; values: unknown[]; kind: string }> = [];
  const state = (): RuntimeState => ({ targetId: "w", title: "t", documentToken: "d", revision: `r${revision}`, dbVersion: revision, undoDepth, redoDepth: 0, regions: [], construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" }, bodies: structuredClone(bodies) }) as unknown as RuntimeState;
  const beforeBodies = bodies;
  const runtime = {
    async getState() { return state(); },
    isUncertain: () => false,
    async mutate(source: string, bindings: string[], values: unknown[]) {
      const first = values[0] as { direction?: string } | undefined;
      if (first?.direction === "undo") {
        calls.push({ bindings, values, kind: "undo" });
        if (options.failUndo) throw new Error("undo did not complete within 10000 ms");
        bodies = beforeBodies; undoDepth -= 1; revision += 1;
        return "applied";
      }
      calls.push({ bindings, values, kind: "chamfer" });
      assert.equal(source, CHAMFER_SOURCE);
      const beforeBody = bodies.find((body) => body.id === 9)!;
      bodies = [...base, after];
      if (!options.noUndoStep) undoDepth += 1;
      revision += 1;
      if (options.evidence === false) return undefined;
      return { chain: options.chain === undefined ? LOOP_CHAIN : options.chain, chainError: null, facesBefore: identities(beforeBody), facesAfter: identities(after) } satisfies ChamferNativeEvidence;
    },
  } as unknown as PlasticityRuntime;
  return { operations: new PlasticityOperations(runtime), calls, state };
}

test("CHAMFER_SOURCE runs against a fake renderer: it returns the factory's tangent chain and the face identities before and after", async () => {
  let committed = false;
  const view = (version: number, faces: number[], edges: number[]) => ({
    high: {
      faces: { versionIds: faces.map((entity) => `${version}f${entity}`), get: (index: number) => ({ entityId: faces[index] }) },
      edges: { versionIds: edges.map((entity) => `${version}e${entity}`), get: (index: number) => ({ versionId: `${version}e${edges[index]}`, entityId: edges[index] }) },
    },
  });
  const geometryModel = new Map<number, { view: unknown }>([[10, { view: view(10, [1, 2], [101, 201]) }]]);
  class Factory {
    shell: unknown; edges: Array<{ versionId: string }> = []; distance = 0;
    constructor(_editor: unknown) {}
    resource() { return this; }
    // Plasticity adds the tangent chain: here the arc next to the selected line.
    get extendedEdges() { return [...this.edges, { versionId: "10e201" }]; }
    async commit() { committed = true; geometryModel.clear(); geometryModel.set(11, { view: view(11, [1, 2, 401, 501], [601]) }); return {}; }
  }
  const editor = {
    executor: { isBusy: false },
    geo: { geometryModel },
    db: { lookupStableId: (versionId: number) => (versionId === 10 || versionId === 11 ? 9 : null) },
    commands: { FilletShellCommand: class { execute?: () => Promise<unknown>; remember = true; constructor(_editor: unknown) {} } },
    async exec(command: { execute: () => Promise<unknown> }) { await command.execute(); },
  };
  const run = new Function(`return (${CHAMFER_SOURCE})`)() as (this: unknown, ...args: unknown[]) => Promise<ChamferNativeEvidence>;
  const evidence = await run.call(editor, Factory, { id: 9, edgeIds: ["10e101"], distance: -0.00741 });
  assert.equal(committed, true);
  assert.deepEqual(evidence, { chain: ["10e101", "10e201"], chainError: null, facesBefore: [["10f1", 1], ["10f2", 2]], facesAfter: [["11f1", 1], ["11f2", 2], ["11f401", 401], ["11f501", 501]] });
  await assert.rejects(run.call(editor, Factory, { id: 9, edgeIds: ["10e999"], distance: -0.001 }), /Stale or unknown edge: 10e999/);
});

test("a chamfer that leaves chained arcs without a face is rolled back by the tool, which says the document is as before", async () => {
  const world = chamferWorld(loopAfter(11, false));
  await assert.rejects(world.operations.chamfer(9, [loopId(101)], 7.41, "r1"), (error: Error) => {
    assert.match(error.message, /Chamfer 7\.41 mm on body 9 was not made on every edge: Plasticity reported OK, but 4 of the 8 edges it chamfered \(1 selected, 7 more along their tangent chain\) got no chamfer face: /);
    for (const i of [1, 2, 3, 4]) assert.match(error.message, new RegExp(`10e20${i} \\(Circle R7 mm\\)`));
    assert.match(error.message, /A chained arc has radius 7 mm, below the distance/);
    assert.match(error.message, /The tool undid its own step: the document is as it was before this call \(Undo depth 2, every body at its earlier version, body 9 with its 9 faces\); the revision is now r3\. No undo is needed for this call\./);
    assert.doesNotMatch(error.message, /plasticity_undo|uncertain/);
    return true;
  });
  assert.deepEqual(world.calls.map((call) => call.kind), ["chamfer", "undo"]);
  assert.deepEqual(world.calls[0]!.bindings, ["FilletShellFactory"]);
  assert.deepEqual(world.calls[0]!.values, [{ id: 9, edgeIds: [loopId(101)], distance: -0.00741 }]);
  assert.equal(world.state().undoDepth, 2);
  assert.deepEqual(world.state().bodies.find((body) => body.id === 9)!.faceIds, LOOP_BEFORE.faceIds);
});

test("a chamfer with a new face for every chained edge is returned, whatever was selected", async () => {
  for (const selected of [[loopId(101)], [loopId(201)], LOOP_CHAIN]) {
    const world = chamferWorld(loopAfter(11, true));
    const after = await world.operations.chamfer(9, selected, 5, "r1");
    assert.equal(after.revision, "r2");
    assert.equal(after.undoDepth, 3);
    assert.deepEqual(world.calls.map((call) => call.kind), ["chamfer"]);
  }
});

test("a countersink whose cone replaces the whole hole wall passes: an edge with one surviving face needs a new face next to it", async () => {
  // Top T=1, wall W=2, bottom B=3, outside 4. Rim R=100 (T, W). After: W is gone, cone K=50 touches T and B.
  const before = fakeBody(9, 10, [1, 2, 3, 4], [{ entity: 100, faces: [1, 2], curve: "Circle", radiusMm: 3 }, { entity: 101, faces: [3, 2], curve: "Circle", radiusMm: 3 }, { entity: 102, faces: [1, 4] }]);
  const after = fakeBody(9, 11, [1, 3, 4, 50], [{ entity: 110, faces: [1, 50], curve: "Circle" }, { entity: 111, faces: [3, 50], curve: "Circle" }, { entity: 102, faces: [1, 4] }]);
  const check = chamferFaceCheck(before, after, { chain: ["10e100"], facesBefore: identities(before), facesAfter: identities(after) }, ["10e100"]);
  assert.deepEqual(check, { selected: ["10e100"], chained: ["10e100"], chainSource: "factory", newFaces: ["11f50"], matched: [{ edgeId: "10e100", faceId: "11f50" }], missing: [] });
  // The same cone can serve one rim, not two: two rims need two cones.
  const both = chamferFaceCheck(before, after, { chain: ["10e100", "10e101"], facesBefore: identities(before), facesAfter: identities(after) }, ["10e100", "10e101"]);
  assert.deepEqual(both.missing.length, 1);
  // A new face that touches neither original face of the edge does not count for it.
  const far = fakeBody(9, 11, [1, 2, 3, 4, 60], [{ entity: 100, faces: [1, 2], curve: "Circle" }, { entity: 101, faces: [3, 2], curve: "Circle" }, { entity: 120, faces: [4, 60] }]);
  assert.deepEqual(chamferFaceCheck(before, far, { chain: ["10e100"], facesBefore: identities(before), facesAfter: identities(far) }, ["10e100"]).missing, ["10e100"]);
});

test("chamferFaceCheck: without a factory chain it checks the selection; without face identities it claims nothing", () => {
  const after = loopAfter(11, false);
  const selectionOnly = chamferFaceCheck(LOOP_BEFORE, after, { chain: null, facesBefore: identities(LOOP_BEFORE), facesAfter: identities(after) }, [loopId(101), loopId(102)]);
  assert.equal(selectionOnly.chainSource, "selection");
  assert.deepEqual(selectionOnly.missing, []);
  const arc = chamferFaceCheck(LOOP_BEFORE, after, { chain: [], facesBefore: identities(LOOP_BEFORE), facesAfter: identities(after) }, LOOP_CHAIN);
  assert.equal(arc.missing.length, 4);
  // Lines are matched to their own planes first, so the arcs are the edges reported.
  assert.deepEqual([...arc.missing].sort(), [201, 202, 203, 204].map(loopId));
  const partial = chamferFaceCheck(LOOP_BEFORE, after, { chain: LOOP_CHAIN, facesBefore: identities(LOOP_BEFORE).slice(1), facesAfter: identities(after) }, LOOP_CHAIN);
  assert.deepEqual(partial.missing, []);
  assert.match(partial.noClaim!, /do not cover/);
});

test("a second chamfer in line with an earlier one is new although it lies on the earlier chamfer's plane", () => {
  // Live: a notched edge, the first segment chamfered, then the second; both chamfer faces share one plane.
  const before = fakeBody(9, 10, [1, 2, 70], [{ entity: 100, faces: [1, 2] }, { entity: 101, faces: [70, 1] }]);
  const after = fakeBody(9, 11, [1, 2, 70, 71], [{ entity: 110, faces: [1, 71] }, { entity: 111, faces: [2, 71] }, { entity: 101, faces: [70, 1] }]);
  assert.deepEqual(chamferFaceCheck(before, after, { chain: ["10e100"], facesBefore: identities(before), facesAfter: identities(after) }, ["10e100"]).missing, []);
});

test("when the tool's own undo fails, or the call took no Undo step, the message says what remains", async () => {
  const failing = chamferWorld(loopAfter(11, false), { failUndo: true });
  await assert.rejects(failing.operations.chamfer(9, LOOP_CHAIN, 7.41, "r1"), (error: Error) => {
    assert.match(error.message, /The tool's own undo of this step failed \(undo did not complete within 10000 ms\): the chamfer may remain at revision r2; call plasticity_reconcile and read the body before you undo\./);
    return true;
  });
  const noStep = chamferWorld(loopAfter(11, false), { noUndoStep: true });
  await assert.rejects(noStep.operations.chamfer(9, LOOP_CHAIN, 7.41, "r1"), /left the Undo depth at 2 \(was 2\), so the tool did not undo anything: revision r2 holds this result/);
  assert.deepEqual(noStep.calls.map((call) => call.kind), ["chamfer"]);
});

test("a stale revision is refused before any native call, and a renderer that returns no evidence gets no claim", async () => {
  const world = chamferWorld(loopAfter(11, false));
  await assert.rejects(world.operations.chamfer(9, LOOP_CHAIN, 7.41, "old"), /stale reference/i);
  assert.equal(world.calls.length, 0);
  const silent = chamferWorld(loopAfter(11, false), { evidence: false });
  assert.equal((await silent.operations.chamfer(9, LOOP_CHAIN, 7.41, "r1")).revision, "r2");
});
