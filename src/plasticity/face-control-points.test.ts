import assert from "node:assert/strict";
import { test } from "node:test";
import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

// Face control points on multi-face bodies (review of faaa37a, Part 2). The fake models what the 26.1.3 probes
// showed (discovery/probes-2026-11-followups/probe-facepoints-*.json):
// - ShellCVs carry no face link; view.high.cvs lists the shown faces' points face by face in KERNEL face order,
//   each block in the order of the face's BSurf GetInfo().vertices, with ids 0..N-1 across the whole body;
// - every show, hide or move is an edit: face version IDs change ("<version>f<entity>"), entity ids stay;
// - showing or hiding another face renumbers the ids; a second show or a hide of an unshown face is a no-op step;
// - Plane and Cylinder faces show no points.

type Fields = Record<string, any>;
interface KernelFace { entity: number; surfaceType: string; vertices: number[] }

const grid = (x0: number, peak: number): number[] => {
  const points: number[] = [];
  for (const [x, z] of [[x0, 0], [x0 + 0.00667, peak], [x0 + 0.01333, peak], [x0 + 0.02, 0]] as const) {
    points.push(x, 0, z, x, 0.02, z);
  }
  return points;
};

function fixture(options: { kernel?: KernelFace[]; moveIgnored?: boolean; showDropsFace?: boolean } = {}) {
  const kernel: KernelFace[] = options.kernel ?? [
    { entity: 3210, surfaceType: "BSurf", vertices: grid(2.9, 0.010667) },
    { entity: 3307, surfaceType: "BSurf", vertices: grid(2.92, 0.010667) },
    { entity: 4000, surfaceType: "Plane", vertices: [] },
  ];
  const viewOrder = [...kernel].reverse().map((face) => face.entity); // the view lists faces in another order
  let version = 66;
  const shown = new Set<number>();
  const faceId = (entity: number) => `${version}f${entity}`;
  const view: Fields = { constructor: { name: "Sheet" }, high: { cvs: [] as Fields[], faces: {} } };
  const rebuild = () => {
    view.high.faces = {
      versionIds: viewOrder.map(faceId),
      get: (index: number) => ({ entityId: viewOrder[index] }),
    };
    const cvs: Fields[] = [];
    for (const face of kernel) {
      if (!shown.has(face.entity) || face.surfaceType !== "BSurf") continue;
      for (let index = 0; index < face.vertices.length / 3; index += 1) {
        const [x, y, z] = face.vertices.slice(index * 3, index * 3 + 3).map((value) => Math.fround(value));
        cvs.push({ id: cvs.length, versionId: `${version}c${cvs.length}`, position: { x, y, z }, face: face.entity, index });
      }
    }
    view.high.cvs = cvs;
  };
  rebuild();
  const model = {
    GetFaces: () => ({
      Size: () => kernel.length,
      Get: (index: number) => ({
        Id: () => kernel[index]!.entity,
        GetSurface: () => ({ surface: kernel[index]!.surfaceType === "BSurf"
          ? Object.assign(Object.create({ constructor: { name: "BSurf" } }), { GetInfo: () => ({ uVertices: kernel[index]!.vertices.length / 6, vVertices: 2, vertices: Float64Array.from(kernel[index]!.vertices) }) })
          : { constructor: { name: kernel[index]!.surfaceType } } }),
      }),
    }),
  };
  const geometryModel = new Map<number, Fields>([[109, { view, model }]]);
  const undoStack: unknown[] = [];
  const state = () => ({
    targetId: "window", title: "Face control points", documentToken: "document", revision: `r${undoStack.length + 1}`, dbVersion: 1, undoDepth: undoStack.length, redoDepth: 0,
    construction: { planes: [], activePlaneId: "standard:top", planeStateToken: "planes", viewStateToken: "view" },
    bodies: [{
      id: 9, versionId: version, type: "Sheet", name: null, boundsMm: null,
      faceIds: viewOrder.map(faceId), edgeIds: [],
      faces: viewOrder.map((entity) => ({ id: faceId(entity), surfaceType: kernel.find((face) => face.entity === entity)!.surfaceType, planar: false, centerMm: [0, 0, 0], normal: [0, 0, 1], edgeIds: [] })),
      edges: [],
    }],
    measurements: [],
  }) as unknown as RuntimeState;

  const created: Fields[] = [];
  const stub = (name: string) => class {
    resource() { return this; }
    move = { value: [] as number[], fromArray(value: number[]) { this.value = value; return this; } };
    async commit() {
      const self = this as unknown as Fields;
      created.push({ factory: name, show: self.show, faces: self.faces, cvs: self.cvs, move: self.move.value });
      undoStack.push(name);
      if (name === "ShowFacePointsFactory") {
        for (const face of self.faces as Array<{ entityId: number }>) {
          if (self.show === false) shown.delete(face.entityId);
          else if (!options.showDropsFace) shown.add(face.entityId);
        }
      }
      if (name === "MultiMoveControlPointFactory" && !options.moveIgnored) {
        const [dx, dy, dz] = self.move.value as number[];
        for (const cv of self.cvs as Fields[]) {
          const face = kernel.find((candidate) => candidate.entity === cv.face)!;
          face.vertices[cv.index * 3] = face.vertices[cv.index * 3]! + dx!; face.vertices[cv.index * 3 + 1] = face.vertices[cv.index * 3 + 1]! + dy!; face.vertices[cv.index * 3 + 2] = face.vertices[cv.index * 3 + 2]! + dz!;
        }
      }
      version += 1;
      rebuild();
      return [];
    }
  };
  const editor = {
    geo: { read: { geometryModel, automatics: new Set<number>() }, lookupStableId(versionId: number) { return versionId - 100; } },
    db: { version: 1, commit() { return undefined; } },
    executor: { isBusy: false },
    selection: { selected: { add() {}, removeAll() {} } },
    commands: new Proxy({}, { get: () => class { remember = true; execute: () => Promise<unknown> = async () => undefined; } }),
    async exec(command: { execute(): Promise<unknown> }) { await command.execute(); },
  };
  const calls: Array<{ kind: "mutate" | "read"; bindings: string[]; values: unknown[] }> = [];
  const run = async (kind: "mutate" | "read", source: string, bindings: string[], values: unknown[]) => {
    calls.push({ kind, bindings, values });
    const native = Function(`return (${source})`)();
    return await native.call(editor, ...bindings.map(stub), ...values);
  };
  const runtime = {
    async getState() { return state(); },
    async mutate(source: string, bindings: string[], values: unknown[]) { return await run("mutate", source, bindings, values); },
    async read(source: string, values: unknown[]) { return await run("read", source, [], values ?? []); },
    isUncertain() { return false },
  } as unknown as PlasticityRuntime;
  return {
    operations: new PlasticityOperations(runtime), created, calls, kernel, view, undoStack,
    faceId, revision: () => state().revision,
    mutations: () => calls.filter((call) => call.kind === "mutate"),
  };
}

const A = 3210, B = 3307, PLANE = 4000;

test("show on face A of a two-face Sheet returns A's eight points with faceId, index and the new face ID", async () => {
  const f = fixture();
  const requested = f.faceId(A);
  const result = await f.operations.showFaceControlPoints(9, [requested], "r1");
  assert.equal(result.undoSteps, 1);
  assert.equal(f.created[0]!.show, true, "show is set explicitly");
  assert.deepEqual(result.faces, [{ requestedFaceId: requested, faceId: f.faceId(A), controlPointCount: 8 }]);
  assert.notEqual(result.faces[0]!.faceId, requested, "the show is an edit: the face ID changed");
  assert.deepEqual(result.controlPoints.map((point) => point.cvId), ["67c0", "67c1", "67c2", "67c3", "67c4", "67c5", "67c6", "67c7"], "cvId is the ShellCV versionId");
  assert.ok(result.controlPoints.every((point) => point.faceId === f.faceId(A)));
  assert.deepEqual(result.controlPoints.map((point) => point.index), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(result.controlPoints[2]!.positionMm, [2906.67, 0, 10.667]);
  assert.equal(result.message, undefined);
});

test("show returns only the requested face's points; a stale cvId of another face is rejected, never re-targeted", async () => {
  const f = fixture();
  const first = await f.operations.showFaceControlPoints(9, [f.faceId(B)], "r1");
  assert.deepEqual(first.controlPoints.map((point) => point.cvId), ["67c0", "67c1", "67c2", "67c3", "67c4", "67c5", "67c6", "67c7"], "B alone takes Plasticity indexes 0..7");
  const staleB = first.controlPoints[2]!.cvId;
  const second = await f.operations.showFaceControlPoints(9, [f.faceId(A)], f.revision());
  assert.equal(second.controlPoints.length, 8, "only A's points are returned");
  assert.ok(second.controlPoints.every((point) => point.faceId === f.faceId(A)));
  assert.deepEqual(second.controlPoints.map((point) => point.cvId), ["68c0", "68c1", "68c2", "68c3", "68c4", "68c5", "68c6", "68c7"], "A comes first in kernel order");
  const all = await (f.operations as unknown as { readFaceControlPoints(id: number): Promise<Array<{ cvId: string; faceId: string; index: number }>> }).readFaceControlPoints(9);
  const bIds = all.filter((point) => point.faceId === f.faceId(B)).map((point) => point.cvId);
  assert.deepEqual(bIds, ["68c8", "68c9", "68c10", "68c11", "68c12", "68c13", "68c14", "68c15"], "B's points were renumbered by Plasticity after A was shown");
  assert.equal(new Set(all.map((point) => point.cvId)).size, 16, "ids are unique across the body at one revision");
  // B's old cvId "67c2" named Plasticity index 2, which is now A's point 2. It must not move A's point.
  const mutations = f.mutations().length;
  await assert.rejects(f.operations.moveFaceControlPoints(9, [staleB], [0, 0, 1], f.revision()), /Unknown face control point IDs on body 9: 67c2\. Call plasticity_show_face_control_points first/);
  assert.equal(f.mutations().length, mutations, "no native edit for a stale id even at the current revision");
});

test("a second show of a shown face costs no Undo step and makes no native edit", async () => {
  const f = fixture();
  await f.operations.showFaceControlPoints(9, [f.faceId(A)], "r1");
  const mutations = f.mutations().length;
  const again = await f.operations.showFaceControlPoints(9, [f.faceId(A)], f.revision());
  assert.equal(again.undoSteps, 0);
  assert.equal(f.mutations().length, mutations, "no native edit");
  assert.equal(again.controlPoints.length, 8);
  assert.match(again.message ?? "", /already shown; nothing changed/);
  const both = await f.operations.showFaceControlPoints(9, [f.faceId(A), f.faceId(B)], f.revision());
  assert.equal(both.undoSteps, 1, "a partly shown request still shows the rest");
  assert.deepEqual(both.faces.map((face) => face.controlPointCount), [8, 8]);
  assert.equal(both.controlPoints.length, 16);
});

test("hide removes a face's points in one step, returns the renumbered rest, and a hide of an unshown face is free", async () => {
  const f = fixture();
  await f.operations.showFaceControlPoints(9, [f.faceId(A), f.faceId(B)], "r1");
  const requested = f.faceId(A);
  const hidden = await f.operations.hideFaceControlPoints(9, [requested], f.revision());
  assert.equal(hidden.undoSteps, 1);
  assert.equal(f.created.at(-1)!.show, false);
  assert.deepEqual(hidden.faces, [{ requestedFaceId: requested, faceId: f.faceId(A), controlPointCount: 0 }]);
  assert.notEqual(requested, f.faceId(A), "the hide is an edit: the face ID changed");
  assert.deepEqual(hidden.controlPoints.map((point) => point.cvId), ["68c0", "68c1", "68c2", "68c3", "68c4", "68c5", "68c6", "68c7"], "B's points renumbered to 0..7 with new versionIds");
  assert.ok(hidden.controlPoints.every((point) => point.faceId === f.faceId(B)));
  const mutations = f.mutations().length;
  const again = await f.operations.hideFaceControlPoints(9, [f.faceId(A)], f.revision());
  assert.equal(again.undoSteps, 0);
  assert.equal(f.mutations().length, mutations, "no native edit for a face with no shown points");
  assert.match(again.message ?? "", /no control points of these faces are shown/);
});

test("Plane and other non-BSurf faces are rejected before any native call: they have no editable control points", async () => {
  const f = fixture();
  await assert.rejects(f.operations.showFaceControlPoints(9, [f.faceId(PLANE)], "r1"), /These faces have no editable control points: 9:66f4000 \(Plane\)\. The tool supports B-Surface \(BSurf\) faces only \(Plane and Cylinder faces show none\); nothing was changed/);
  await assert.rejects(f.operations.showFaceControlPoints(9, [f.faceId(A), f.faceId(PLANE)], "r1"), /no editable control points: 9:66f4000/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.undoStack.length, 0);
});

test("a BSurf show that yields no points says so and reports the Undo step it cost", async () => {
  const f = fixture({ showDropsFace: true });
  const result = await f.operations.showFaceControlPoints(9, [f.faceId(A)], "r1");
  assert.equal(result.undoSteps, 1);
  assert.deepEqual(result.controlPoints, []);
  assert.match(result.message ?? "", /9:66f3210 showed no editable control points; the show still took one Undo step/);
});

test("move points of two faces in one step: read back by delta, returned with their current face IDs", async () => {
  const f = fixture();
  await f.operations.showFaceControlPoints(9, [f.faceId(A), f.faceId(B)], "r1");
  const moved = await f.operations.moveFaceControlPoints(9, ["67c2", "67c12"], [0, 0, 5], f.revision());
  assert.equal(moved.undoSteps, 1);
  assert.deepEqual(f.created.at(-1)!.cvs.map((cv: Fields) => cv.id), [2, 12]);
  assert.deepEqual(f.created.at(-1)!.move, [0, 0, 0.005]);
  assert.deepEqual(moved.controlPoints.map((point) => [point.cvId, point.faceId, point.index]), [["68c2", f.faceId(A), 2], ["68c12", f.faceId(B), 4]], "new cvIds after the move");
  assert.ok(moved.controlPoints.every((point) => !("rawMm" in point)), "internal raw positions are not returned");
  await assert.rejects(f.operations.moveFaceControlPoints(9, ["67c2"], [0, 0, 5], f.revision()), /Unknown face control point IDs on body 9: 67c2/, "the pre-move id is stale after the move");
  assert.deepEqual(moved.controlPoints.map((point) => point.positionMm[2]), [15.667, 15.667]);
});

test("move rejects unknown ids before any native edit and points to the show tool", async () => {
  const f = fixture();
  await f.operations.showFaceControlPoints(9, [f.faceId(A)], "r1");
  const before = f.mutations().length;
  await assert.rejects(f.operations.moveFaceControlPoints(9, ["67c3", "67c8"], [0, 0, 1], f.revision()), /Unknown face control point IDs on body 9: 67c8\. Call plasticity_show_face_control_points first/);
  await assert.rejects(f.operations.moveFaceControlPoints(9, ["3"], [0, 0, 1], f.revision()), /Unknown face control point IDs on body 9: 3\./, "a bare Plasticity index is not a cvId");
  assert.equal(f.mutations().length, before);
  await assert.rejects(f.operations.moveFaceControlPoints(9, ["67c3"], [0, 0, 1], "r1"), /Stale reference/, "an older revision is refused too");
});

test("a move that Plasticity ignores is reported, not returned as success", async () => {
  const f = fixture({ moveIgnored: true });
  await f.operations.showFaceControlPoints(9, [f.faceId(A)], "r1");
  await assert.rejects(f.operations.moveFaceControlPoints(9, ["67c2"], [0, 0, 5], f.revision()), /took one Undo step, but the read-back does not match: cv 67c2 is at \[2906\.67, 0, 10\.667\], expected \[2906\.67, 0, 15\.667\]; inspect the body or undo/);
});

test("points that match no face grid, or two grids at once, are an error rather than a guess", async () => {
  const twins = fixture({ kernel: [
    { entity: A, surfaceType: "BSurf", vertices: grid(2.9, 0.01) },
    { entity: B, surfaceType: "BSurf", vertices: grid(2.9, 0.01) },
  ] });
  await assert.rejects(twins.operations.showFaceControlPoints(9, [twins.faceId(A)], "r1"), /^Error: These faces share one control grid \(faces split on one B-Surface\): 9:66f3210 = 9:66f3307\. Plasticity's shown points could not be told apart, so the show is refused; nothing was changed$/);
  assert.equal(twins.undoStack.length, 0, "refused before the edit: no Undo step");
  const drifting = fixture();
  await drifting.operations.showFaceControlPoints(9, [drifting.faceId(A)], "r1");
  drifting.kernel[0]!.vertices[2] = 0.5; // the kernel grid no longer matches the shown points
  await assert.rejects(drifting.operations.moveFaceControlPoints(9, ["67c0"], [0, 0, 1], drifting.revision()), /from index 0 match no face control grid/);
});

test("show and hide validate the body, the faces and the revision before any native call", async () => {
  const f = fixture();
  for (const call of [
    () => f.operations.showFaceControlPoints(99, [f.faceId(A)], "r1"),
    () => f.operations.showFaceControlPoints(9, ["nope"], "r1"),
    () => f.operations.showFaceControlPoints(9, [], "r1"),
    () => f.operations.hideFaceControlPoints(9, [f.faceId(A), f.faceId(A)], "r1"),
    () => f.operations.hideFaceControlPoints(9, ["nope"], "r1"),
    () => f.operations.hideFaceControlPoints(9, [f.faceId(A)], "old"),
  ]) await assert.rejects(call());
  assert.equal(f.calls.length, 0);
});
