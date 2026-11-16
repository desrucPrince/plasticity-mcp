import assert from "node:assert/strict";
import { test } from "node:test";
import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

// Executes the source each Upgrades B operation hands to the runtime against a stub editor and records what
// the native factories received. Enum values are the numbers FINDINGS (probes-2026-11) read from Plasticity 26.1.3.
const ENUMS: Record<string, Record<string, number>> = {
  ContinuityType: { C1: 23150, C2: 23151, C3: 23152, G1: 23153, G2: 23154, G3: 23155, G0: 23156, Free: 23157 },
};

type Fields = Record<string, any>;

// Float32 noise like the live values (2900.0000953674316 mm) so the rounding is exercised.
const CV_POSITIONS_M: Array<[number, number, number]> = [
  [2.9000000953674316, 0, 0], [2.9000000953674316, 0.019999999552965164, 0],
  [2.9133334159851074, 0, 0.013333333656191826], [2.9133334159851074, 0.019999999552965164, 0.013333333656191826],
  [2.9266667366027832, 0, 0.013333333656191826], [2.9266667366027832, 0.019999999552965164, 0.013333333656191826],
  [2.940000057220459, 0, 0], [2.940000057220459, 0.019999999552965164, 0],
];

class ObjectEmpty {}

function vectorStub() {
  return {
    value: [] as number[],
    fromArray(value: number[]) { this.value = value; return this; },
  };
}

function fixture() {
  const body = (id: number, type: string, extra: Fields = {}) => ({ id, versionId: 100 + id, type, name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], ...extra });
  const state = {
    targetId: "window", title: "Upgrades B", documentToken: "document", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0,
    construction: { planes: [], activePlaneId: "standard:top", planeStateToken: "planes", viewStateToken: "view" },
    bodies: [
      body(5, "Sheet", { faceIds: ["f1"], edgeIds: ["e1", "e2", "e3", "e4"] }),
      body(7, "Wire"), body(8, "Wire"), body(9, "Wire"), body(11, "Wire"), body(13, "Wire"),
      body(10, "Solid", { faceIds: ["g1"], edgeIds: ["h1"] }),
    ],
    referenceMeshes: [{ id: 3 }],
    measurements: [],
  } as unknown as RuntimeState;

  const edgeIds = ["e1", "e2", "e3", "e4"];
  const faceIds = ["f1"];
  const sheetView: Fields = {
    constructor: { name: "Sheet" },
    high: {
      edges: { versionIds: edgeIds, get: (index: number) => ({ edgeView: edgeIds[index] }) },
      faces: { versionIds: faceIds, get: (index: number) => ({ faceView: faceIds[index] }) },
      cvs: [] as Fields[],
    },
  };
  const geometryModel = new Map<number, { view: Fields }>();
  const views = new Map<number, Fields>();
  for (const entry of state.bodies) {
    const view = entry.id === 5 ? sheetView : { constructor: { name: entry.type }, high: { edges: { versionIds: [] }, faces: { versionIds: [] } } };
    views.set(entry.id, view);
    geometryModel.set(entry.versionId, { view });
  }
  const mesh = new ObjectEmpty();

  const created: Fields[] = [];
  const executed: string[] = [];
  // ShowFacePointsFactory fills view.high.cvs; MultiMoveControlPointFactory moves the given cvs by `move`, as Plasticity does.
  const stub = (name: string) => class {
    resource() { return this; }
    move = vectorStub();
    async commit() {
      created.push({ factory: name, ...(this as unknown as Fields) });
      if (name === "ShowFacePointsFactory") {
        sheetView.high.cvs = CV_POSITIONS_M.map(([x, y, z], id) => ({ id, versionId: `235c${id}`, position: { x, y, z } }));
      }
      if (name === "MultiMoveControlPointFactory") {
        const [dx, dy, dz] = (this as unknown as Fields).move.value as number[];
        for (const cv of (this as unknown as Fields).cvs as Fields[]) cv.position = { x: cv.position.x + dx, y: cv.position.y + dy, z: cv.position.z + dz };
      }
      return [];
    }
  };
  const editor = {
    geo: { read: { geometryModel, automatics: new Set<number>() }, lookupStableId(version: number) { return version - 100; } },
    db: { version: 1, commit() { return undefined; } },
    empties: { lookupById(id: number) { return id === 3 ? mesh : undefined; } },
    executor: { isBusy: false },
    selection: { selected: { add() {}, removeAll() {} } },
    commands: new Proxy({}, {
      get: (_target, name: string) => class { remember = true; execute: () => Promise<unknown> = async () => undefined; constructor() { executed.push(name); } },
    }),
    async exec(command: { execute(): Promise<unknown> }) { await command.execute(); },
  };

  const calls: Array<{ kind: "mutate" | "read"; source: string; bindings: string[]; values: unknown[] }> = [];
  const run = async (kind: "mutate" | "read", source: string, bindings: string[], values: unknown[]) => {
    calls.push({ kind, source, bindings, values });
    const native = Function(`return (${source})`)();
    const bound = bindings.map((binding) => ENUMS[binding] ?? stub(binding));
    return await native.call(editor, ...bound, ...values);
  };
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { return await run("mutate", source, bindings, values); },
    async read(source: string, values: unknown[]) { return await run("read", source, [], values ?? []); },
    isUncertain() { return false; },
  } as unknown as PlasticityRuntime;
  return { operations: new PlasticityOperations(runtime), state, created, executed, calls, views, sheetView, mesh };
}

const mutations = (f: ReturnType<typeof fixture>) => f.calls.filter((call) => call.kind === "mutate");

// ---- plasticity_xsided_patch (FINDINGS gaps 2 and 6)

test("xsidedPatch with boundary curves runs PatchCommand and XSidedFactory with the Wires only", async () => {
  const f = fixture();
  await f.operations.xsidedPatch({ curveIds: [7, 8, 9, 11] }, "r1");
  assert.deepEqual(f.executed, ["PatchCommand"]);
  assert.deepEqual(mutations(f)[0]!.bindings, ["XSidedFactory"]);
  assert.deepEqual(mutations(f)[0]!.values, [{ curveIds: [7, 8, 9, 11] }]);
  const factory = f.created[0]!;
  assert.equal(factory.factory, "XSidedFactory");
  assert.deepEqual(factory.curves, [f.views.get(7), f.views.get(8), f.views.get(9), f.views.get(11)]);
  assert.equal(factory.edges, undefined);
  assert.equal(factory.guides, undefined);
  assert.equal(factory.continuity, undefined);
});

test("xsidedPatch accepts the three-curve minimum and five curves", async () => {
  for (const curveIds of [[7, 8, 9], [7, 8, 9, 11, 13]]) {
    const f = fixture();
    await f.operations.xsidedPatch({ curveIds }, "r1");
    assert.equal(f.created[0]!.curves.length, curveIds.length);
  }
});

test("xsidedPatch with guide curves switches to XNurbsCommand on the same XSidedFactory", async () => {
  const f = fixture();
  await f.operations.xsidedPatch({ curveIds: [7, 8, 9, 11], guideIds: [13] }, "r1");
  assert.deepEqual(f.executed, ["XNurbsCommand"]);
  assert.deepEqual(mutations(f)[0]!.bindings, ["XSidedFactory"]);
  const factory = f.created[0]!;
  assert.equal(factory.factory, "XSidedFactory");
  assert.deepEqual(factory.curves, [f.views.get(7), f.views.get(8), f.views.get(9), f.views.get(11)]);
  assert.deepEqual(factory.guides, [f.views.get(13)]);
});

test("xsidedPatch with edges looks up the edge views on the body and sets no continuity by default", async () => {
  const f = fixture();
  await f.operations.xsidedPatch({ edges: { bodyId: 5, edgeIds: ["e3", "e1"] } }, "r1");
  assert.deepEqual(f.executed, ["PatchCommand"]);
  assert.deepEqual(mutations(f)[0]!.bindings, ["XSidedFactory"]);
  const factory = f.created[0]!;
  assert.deepEqual(factory.edges, [{ edgeView: "e3" }, { edgeView: "e1" }]);
  assert.equal(factory.curves, undefined);
  assert.equal(factory.continuity, undefined);
});

test("xsidedPatch maps g0, g1 and g2 to the native ContinuityType values for all edges", async () => {
  for (const [name, native] of [["g0", 23156], ["g1", 23153], ["g2", 23154]] as const) {
    const f = fixture();
    await f.operations.xsidedPatch({ edges: { bodyId: 5, edgeIds: ["e1"] }, continuity: name }, "r1");
    assert.deepEqual(mutations(f)[0]!.bindings, ["XSidedFactory", "ContinuityType"], name);
    assert.equal(f.created[0]!.continuity, native, name);
  }
});

test("xsidedPatch combines edges, a guide and continuity in one XNurbsCommand", async () => {
  const f = fixture();
  await f.operations.xsidedPatch({ edges: { bodyId: 5, edgeIds: ["e1", "e2"] }, guideIds: [7], continuity: "g1" }, "r1");
  assert.deepEqual(f.executed, ["XNurbsCommand"]);
  const factory = f.created[0]!;
  assert.deepEqual(factory.edges, [{ edgeView: "e1" }, { edgeView: "e2" }]);
  assert.deepEqual(factory.guides, [f.views.get(7)]);
  assert.equal(factory.continuity, 23153);
});

test("xsidedPatch rejects both or neither of curveIds and edges before any native call", async () => {
  const f = fixture();
  await assert.rejects(f.operations.xsidedPatch({}, "r1"), /exactly one of curveIds and edges/);
  await assert.rejects(f.operations.xsidedPatch({ curveIds: [7, 8, 9], edges: { bodyId: 5, edgeIds: ["e1"] } }, "r1"), /exactly one of curveIds and edges, not both/);
  assert.equal(f.calls.length, 0);
});

test("xsidedPatch rejects guides without a boundary", async () => {
  const f = fixture();
  await assert.rejects(f.operations.xsidedPatch({ guideIds: [13] }, "r1"), /guides need a boundary/);
  assert.equal(f.calls.length, 0);
});

test("xsidedPatch rejects bad boundary curves, guides, edges and continuity", async () => {
  const f = fixture();
  const reject = async (input: Parameters<PlasticityOperations["xsidedPatch"]>[0], pattern: RegExp) => {
    await assert.rejects(f.operations.xsidedPatch(input, "r1"), pattern, JSON.stringify(input));
  };
  await reject({ curveIds: [7, 8] }, /at least 3/);
  await reject({ curveIds: [7, 7, 8] }, /unique/);
  await reject({ curveIds: [7, 8, 10] }, /current Wire IDs: 10/);
  await reject({ curveIds: [7, 8, 99] }, /current Wire IDs: 99/);
  await reject({ curveIds: [7, 8, 9], guideIds: [10] }, /guides must be current Wire IDs: 10/);
  await reject({ curveIds: [7, 8, 9], guideIds: [9] }, /guide must not be one of the boundary curves/);
  await reject({ curveIds: [7, 8, 9], guideIds: [] }, /guide IDs/);
  await reject({ curveIds: [7, 8, 9], guideIds: [13, 13] }, /guide IDs/);
  await reject({ curveIds: [7, 8, 9], continuity: "g1" }, /edges only/);
  await reject({ edges: { bodyId: 7, edgeIds: ["e1"] } }, /Sheet or Solid/);
  await reject({ edges: { bodyId: 99, edgeIds: ["e1"] } }, /Sheet or Solid/);
  await reject({ edges: { bodyId: 5, edgeIds: ["nope"] } }, /unknown X-sided patch edges: nope/);
  await reject({ edges: { bodyId: 5, edgeIds: [] } }, /edge IDs/);
  await reject({ edges: { bodyId: 5, edgeIds: ["e1", "e1"] } }, /edge IDs/);
  await reject({ edges: { bodyId: 5, edgeIds: ["e1"] }, continuity: "g3" as never }, /continuity must be one of/);
  assert.equal(f.calls.length, 0, "no rejected call may reach the native side");
});

test("xsidedPatch rejects a stale revision", async () => {
  const f = fixture();
  await assert.rejects(f.operations.xsidedPatch({ curveIds: [7, 8, 9] }, "old"), /Stale reference/);
  assert.equal(f.calls.length, 0);
});

test("xsidedPatch source is generated with the Wire check and no unexposed options", async () => {
  const f = fixture();
  await f.operations.xsidedPatch({ curveIds: [7, 8, 9] }, "r1");
  const source = mutations(f)[0]!.source;
  assert.match(source, /constructor\.name !== 'Wire'/);
  for (const hidden of ["uDegree", "vDegree", "uSpans", "vSpans", "controlType", "bending", "stretch", "setContinuityForEdge", "boundaryCondition"]) {
    assert.ok(!source.includes(hidden), `${hidden} must stay unexposed`);
  }
});

// ---- plasticity_convert_reference_mesh_to_polysplines (FINDINGS gap 7)

test("convertReferenceMeshToPolySplines runs PolySplinesCommand and ConvertMeshToPolySplinesFactory on the mesh", async () => {
  const f = fixture();
  await f.operations.convertReferenceMeshToPolySplines(3, {}, "r1");
  assert.deepEqual(f.executed, ["PolySplinesCommand"]);
  assert.deepEqual(mutations(f)[0]!.bindings, ["ConvertMeshToPolySplinesFactory"]);
  assert.deepEqual(mutations(f)[0]!.values, [{ referenceMeshId: 3 }]);
  const factory = f.created[0]!;
  assert.equal(factory.factory, "ConvertMeshToPolySplinesFactory");
  assert.deepEqual(factory.empties, [f.mesh]);
  assert.equal(factory.mergePatches, undefined, "an unset option keeps the native default");
  assert.equal(factory.interpolateBoundary, undefined);
  assert.equal(factory.roundedCorners, undefined, "roundedCorners has no effect and stays unexposed");
});

test("convertReferenceMeshToPolySplines forwards mergePatches and interpolateBoundary as native flags", async () => {
  const merged = fixture();
  await merged.operations.convertReferenceMeshToPolySplines(3, { mergePatches: true }, "r1");
  assert.equal(merged.created[0]!.mergePatches, true);
  const separate = fixture();
  await separate.operations.convertReferenceMeshToPolySplines(3, { mergePatches: false, interpolateBoundary: true }, "r1");
  assert.equal(separate.created[0]!.mergePatches, false);
  assert.equal(separate.created[0]!.interpolateBoundary, true);
  const open = fixture();
  await open.operations.convertReferenceMeshToPolySplines(3, { interpolateBoundary: false }, "r1");
  assert.equal(open.created[0]!.interpolateBoundary, false);
});

test("convertReferenceMeshToPolySplines rejects an unknown reference mesh, a non-boolean flag and a stale revision", async () => {
  const f = fixture();
  await assert.rejects(f.operations.convertReferenceMeshToPolySplines(99, {}, "r1"), /Unknown current reference mesh IDs: 99/);
  await assert.rejects(f.operations.convertReferenceMeshToPolySplines(7, {}, "r1"), /Unknown current reference mesh IDs: 7/);
  await assert.rejects(f.operations.convertReferenceMeshToPolySplines(3, { mergePatches: "yes" as never }, "r1"), /mergePatches must be a boolean/);
  await assert.rejects(f.operations.convertReferenceMeshToPolySplines(3, {}, "old"), /Stale reference/);
  assert.equal(f.calls.length, 0);
});

test("convertReferenceMeshToPolySplines fails inside the native source when the id is not a reference mesh", async () => {
  const f = fixture();
  f.state.referenceMeshes = [{ id: 4 }] as never;
  await assert.rejects(f.operations.convertReferenceMeshToPolySplines(4, {}, "r1"), /Unknown native reference mesh ID: 4/);
  assert.equal(f.created.length, 0, "the factory must not commit");
});

// ---- plasticity_show_face_control_points and plasticity_move_face_control_points (FINDINGS gap 5)

test("showFaceControlPoints runs TogglePointsCommand and ShowFacePointsFactory on the face views", async () => {
  const f = fixture();
  await f.operations.showFaceControlPoints(5, ["f1"], "r1");
  assert.deepEqual(f.executed, ["TogglePointsCommand"]);
  assert.deepEqual(mutations(f)[0]!.bindings, ["ShowFacePointsFactory"]);
  assert.deepEqual(mutations(f)[0]!.values, [{ bodyId: 5, faceIds: ["f1"] }]);
  const factory = f.created[0]!;
  assert.equal(factory.factory, "ShowFacePointsFactory");
  assert.deepEqual(factory.faces, [{ faceView: "f1" }]);
  assert.equal(factory.show, undefined, "show keeps its native default of true");
});

test("showFaceControlPoints returns the eight CVs as rounded millimeter positions", async () => {
  const f = fixture();
  const { controlPoints, state } = await f.operations.showFaceControlPoints(5, ["f1"], "r1");
  assert.equal(state.revision, "r1");
  assert.equal(controlPoints.length, 8);
  assert.deepEqual(controlPoints.map((point) => point.cvId), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(controlPoints[0]!.positionMm, [2900, 0, 0]);
  assert.deepEqual(controlPoints[1]!.positionMm, [2900, 20, 0]);
  assert.deepEqual(controlPoints[3]!.positionMm, [2913.333, 20, 13.333]);
  assert.deepEqual(controlPoints[7]!.positionMm, [2940, 20, 0]);
});

test("showFaceControlPoints rejects bad bodies, faces and a stale revision before any native call", async () => {
  const f = fixture();
  await assert.rejects(f.operations.showFaceControlPoints(7, ["f1"], "r1"), /Sheet or Solid body: 7/);
  await assert.rejects(f.operations.showFaceControlPoints(99, ["f1"], "r1"), /Sheet or Solid body: 99/);
  await assert.rejects(f.operations.showFaceControlPoints(5, ["nope"], "r1"), /Stale or unknown faces: 5:nope/);
  await assert.rejects(f.operations.showFaceControlPoints(5, ["g1"], "r1"), /Stale or unknown faces: 5:g1/);
  await assert.rejects(f.operations.showFaceControlPoints(5, [], "r1"), /nonempty unique/);
  await assert.rejects(f.operations.showFaceControlPoints(5, ["f1", "f1"], "r1"), /nonempty unique/);
  await assert.rejects(f.operations.showFaceControlPoints(5, ["f1"], "old"), /Stale reference/);
  assert.equal(f.calls.length, 0);
});

test("moveFaceControlPoints runs MoveControlPointCommand and MultiMoveControlPointFactory with the shown CVs and a delta in meters", async () => {
  const f = fixture();
  await f.operations.showFaceControlPoints(5, ["f1"], "r1");
  const shown = f.sheetView.high.cvs as Fields[];
  f.executed.length = 0;
  await f.operations.moveFaceControlPoints(5, [2, 3, 4, 5], [0, 0, 10], "r1");
  assert.deepEqual(f.executed, ["MoveControlPointCommand"]);
  const call = mutations(f)[1]!;
  assert.deepEqual(call.bindings, ["MultiMoveControlPointFactory"]);
  assert.deepEqual(call.values, [{ bodyId: 5, cvIds: [2, 3, 4, 5], delta: [0, 0, 0.01] }]);
  const factory = f.created[1]!;
  assert.equal(factory.factory, "MultiMoveControlPointFactory");
  assert.deepEqual(factory.cvs.map((cv: Fields) => cv.id), [2, 3, 4, 5]);
  assert.ok(factory.cvs.every((cv: Fields) => shown.includes(cv)), "the factory receives the shown ShellCV objects");
  assert.deepEqual(factory.move.value, [0, 0, 0.01]);
  assert.equal(factory.controlPoints, undefined, "controlPoints has no effect; cvs is the field");
});

test("moveFaceControlPoints returns the moved points 10 mm higher and leaves the others", async () => {
  const f = fixture();
  const shown = (await f.operations.showFaceControlPoints(5, ["f1"], "r1")).controlPoints;
  const moved = (await f.operations.moveFaceControlPoints(5, [2, 3, 4, 5], [0, 0, 10], "r1")).controlPoints;
  assert.deepEqual(moved.map((point) => point.cvId), [2, 3, 4, 5]);
  for (const point of moved) {
    const before = shown.find((candidate) => candidate.cvId === point.cvId)!;
    assert.ok(Math.abs(point.positionMm[2] - before.positionMm[2] - 10) < 0.01, `cv ${point.cvId}`);
    assert.equal(point.positionMm[0], before.positionMm[0]);
    assert.equal(point.positionMm[1], before.positionMm[1]);
  }
  const all = await (f.operations as unknown as { readFaceControlPoints(id: number): Promise<Array<{ cvId: number; positionMm: number[] }>> }).readFaceControlPoints(5);
  assert.deepEqual(all.find((point) => point.cvId === 0)!.positionMm, [2900, 0, 0], "an unmoved point stays");
});

test("moveFaceControlPoints rejects an unknown cvId and points to the show tool, without a native edit", async () => {
  const f = fixture();
  await assert.rejects(f.operations.moveFaceControlPoints(5, [0, 1], [0, 0, 10], "r1"), /Unknown face control point IDs on body 5: 0, 1\. Call plasticity_show_face_control_points first/);
  assert.equal(f.created.length, 0);
  assert.deepEqual(f.executed, [], "no command is created when the validation fails");
  await f.operations.showFaceControlPoints(5, ["f1"], "r1");
  await assert.rejects(f.operations.moveFaceControlPoints(5, [1, 42], [0, 0, 10], "r1"), /Unknown face control point IDs on body 5: 42\. Call plasticity_show_face_control_points first/);
  assert.equal(f.created.filter((entry) => entry.factory === "MultiMoveControlPointFactory").length, 0);
});

test("moveFaceControlPoints rejects bad input and a stale revision before any native call", async () => {
  const f = fixture();
  await assert.rejects(f.operations.moveFaceControlPoints(7, [0], [0, 0, 1], "r1"), /Sheet or Solid body: 7/);
  await assert.rejects(f.operations.moveFaceControlPoints(5, [], [0, 0, 1], "r1"), /nonempty unique/);
  await assert.rejects(f.operations.moveFaceControlPoints(5, [0, 0], [0, 0, 1], "r1"), /nonempty unique/);
  await assert.rejects(f.operations.moveFaceControlPoints(5, [0], [0, 0, 0], "r1"), /nonzero vector/);
  await assert.rejects(f.operations.moveFaceControlPoints(5, [0], [0, Number.NaN, 1], "r1"), /nonzero vector/);
  await assert.rejects(f.operations.moveFaceControlPoints(5, [0], [0, 0, 1], "old"), /Stale reference/);
  assert.equal(f.calls.length, 0);
});
