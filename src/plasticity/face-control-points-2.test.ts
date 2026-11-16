import assert from "node:assert/strict";
import { test } from "node:test";
import { faceControlPointTolerance, PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

// Re-review of 61b054e, Part 2 (face control points). Same fake model as face-control-points.test.ts (ShellCVs carry
// no face link; view.high.cvs lists the shown faces' points face by face in kernel face order; every show, hide or
// move is an edit that bumps the body version), plus:
// - faces split on one B-Surface (identical grids), shown before the tool ran (preShown, like a Plasticity UI show);
// - edits that add more than one Undo entry (stepsPerEdit), so undoSteps must be measured;
// - grids far from the origin, where float32 positions miss a 1e-3 mm read-back;
// - a move that separates coincident points of a shared edge and makes Plasticity reshape the face
//   (probe-coincident-point.json: the moved face's grid grew from 4 x 2 to 7 x 2).

type Fields = Record<string, any>;
interface KernelFace { entity: number; surfaceType: string; vertices: number[] }

const grid = (x0: number, peak: number): number[] => {
  const points: number[] = [];
  for (const [x, z] of [[x0, 0], [x0 + 0.00667, peak], [x0 + 0.01333, peak], [x0 + 0.02, 0]] as const) {
    points.push(x, 0, z, x, 0.02, z);
  }
  return points;
};

function fixture(options: { kernel?: KernelFace[]; preShown?: number[]; stepsPerEdit?: number; moveIgnored?: boolean; reshapeOnMove?: boolean } = {}) {
  const kernel: KernelFace[] = options.kernel ?? [
    { entity: 3210, surfaceType: "BSurf", vertices: grid(2.9, 0.010667) },
    { entity: 3307, surfaceType: "BSurf", vertices: grid(2.92, 0.010667) },
    { entity: 4000, surfaceType: "Plane", vertices: [] },
  ];
  const viewOrder = [...kernel].reverse().map((face) => face.entity);
  let version = 66;
  const shown = new Set<number>(options.preShown ?? []);
  const faceId = (entity: number) => `${version}f${entity}`;
  const view: Fields = { constructor: { name: "Sheet" }, high: { cvs: [] as Fields[], faces: {} } };
  const rebuild = () => {
    view.high.faces = { versionIds: viewOrder.map(faceId), get: (index: number) => ({ entityId: viewOrder[index] }) };
    const cvs: Fields[] = [];
    for (const face of kernel) {
      if (!shown.has(face.entity) || face.surfaceType !== "BSurf") continue;
      // The shown points stay a 4 x 2 grid even when the kernel surface was reshaped (live 26.1.3 behaviour).
      const count = Math.min(face.vertices.length / 3, 8);
      for (let index = 0; index < count; index += 1) {
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
    targetId: "window", title: "Face control points 2", documentToken: "document", revision: `r${undoStack.length + 1}`, dbVersion: 1, undoDepth: undoStack.length, redoDepth: 0,
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
      for (let step = 0; step < (options.stepsPerEdit ?? 1); step += 1) undoStack.push(name);
      if (name === "ShowFacePointsFactory") {
        for (const face of self.faces as Array<{ entityId: number }>) {
          if (self.show === false) shown.delete(face.entityId);
          else shown.add(face.entityId);
        }
      }
      if (name === "MultiMoveControlPointFactory" && !options.moveIgnored) {
        const [dx, dy, dz] = self.move.value as number[];
        for (const cv of self.cvs as Fields[]) {
          const face = kernel.find((candidate) => candidate.entity === cv.face)!;
          face.vertices[cv.index * 3] = face.vertices[cv.index * 3]! + dx!; face.vertices[cv.index * 3 + 1] = face.vertices[cv.index * 3 + 1]! + dy!; face.vertices[cv.index * 3 + 2] = face.vertices[cv.index * 3 + 2]! + dz!;
          // Plasticity extends the moved face's surface when a point of a shared edge moves alone.
          if (options.reshapeOnMove) face.vertices.push(...face.vertices.slice(-6).map((value, index) => value + (index % 3 === 0 ? 0.001 : 0)));
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
    isUncertain() { return false; },
  } as unknown as PlasticityRuntime;
  return {
    operations: new PlasticityOperations(runtime), created, calls, kernel, view, undoStack, shown,
    faceId, revision: () => state().revision,
    mutations: () => calls.filter((call) => call.kind === "mutate"),
  };
}

const A = 3210, B = 3307, C = 5005;
const twinKernel = (): KernelFace[] => [
  { entity: A, surfaceType: "BSurf", vertices: grid(2.9, 0.01) },
  { entity: B, surfaceType: "BSurf", vertices: grid(2.9, 0.01) },
  { entity: C, surfaceType: "BSurf", vertices: grid(2.95, 0.004) },
];

// ---- item 7: faces split on one B-Surface

test("show refuses a face whose control grid duplicates another face's, before any edit and with no Undo step", async () => {
  for (const request of [[A], [B], [A, B], [A, C]]) {
    const f = fixture({ kernel: twinKernel() });
    await assert.rejects(f.operations.showFaceControlPoints(9, request.map(f.faceId), "r1"), (error: Error) => {
      assert.match(error.message, /^These faces share one control grid \(faces split on one B-Surface\): 9:66f3210 = 9:66f3307\. .*nothing was changed$/);
      return true;
    }, JSON.stringify(request));
    assert.equal(f.undoStack.length, 0);
    assert.equal(f.mutations().length, 0, "no native edit");
  }
  // A face with its own grid on the same body still shows normally.
  const g = fixture({ kernel: twinKernel() });
  const shown = await g.operations.showFaceControlPoints(9, [g.faceId(C)], "r1");
  assert.equal(shown.undoSteps, 1);
  assert.equal(shown.controlPoints.length, 8);
});

test("a body whose shown points cannot be attributed (twin faces shown in Plasticity) can always be hidden", async () => {
  const f = fixture({ kernel: twinKernel(), preShown: [A] });
  // Show and move refuse before any edit and point to hide.
  await assert.rejects(f.operations.showFaceControlPoints(9, [f.faceId(C)], "r1"), /cannot be attributed to faces \(Face control points of body 9 are ambiguous from index 0: faces 66f3210, 66f3307 match\)\. Hide them with plasticity_hide_face_control_points first; nothing was changed/);
  await assert.rejects(f.operations.moveFaceControlPoints(9, ["66c0"], [0, 0, 1], "r1"), /cannot be attributed to faces .*Hide them with plasticity_hide_face_control_points; nothing was changed/);
  assert.equal(f.mutations().length, 0);
  // Hide by face needs no per-point attribution.
  const hidden = await f.operations.hideFaceControlPoints(9, [f.faceId(A)], "r1");
  assert.equal(hidden.undoSteps, 1);
  assert.equal(f.created.at(-1)!.show, false);
  assert.deepEqual(hidden.faces, [{ requestedFaceId: "66f3210", faceId: f.faceId(A), controlPointCount: 0 }]);
  assert.deepEqual(hidden.controlPoints, []);
  assert.equal(f.view.high.cvs.length, 0, "no points left");
  // The body is usable again: C shows.
  const shownC = await f.operations.showFaceControlPoints(9, [f.faceId(C)], f.revision());
  assert.equal(shownC.controlPoints.length, 8);
});

test("hiding one of two shown twin faces works and says the rest still cannot be attributed; hiding the other clears it", async () => {
  const f = fixture({ kernel: twinKernel(), preShown: [A, B] });
  const first = await f.operations.hideFaceControlPoints(9, [f.faceId(A)], "r1");
  assert.equal(first.undoSteps, 1);
  assert.deepEqual(first.controlPoints, []);
  assert.match(first.message ?? "", /^8 shown control points of other faces of body 9 remain but cannot be attributed to faces \(.*ambiguous.*\); hide those faces too$/);
  const second = await f.operations.hideFaceControlPoints(9, [f.faceId(B)], f.revision());
  assert.equal(second.undoSteps, 1);
  assert.equal(second.message, undefined);
  assert.equal(f.view.high.cvs.length, 0);
  const again = await f.operations.hideFaceControlPoints(9, [f.faceId(B)], f.revision());
  assert.equal(again.undoSteps, 0, "nothing shown: no edit");
});

// ---- item 8: undoSteps is measured

test("undoSteps is the measured Undo depth change for show, hide and move", async () => {
  const f = fixture({ stepsPerEdit: 2 });
  const shown = await f.operations.showFaceControlPoints(9, [f.faceId(A)], "r1");
  assert.equal(shown.undoSteps, 2);
  const moved = await f.operations.moveFaceControlPoints(9, [shown.controlPoints[2]!.cvId], [0, 0, 1], f.revision());
  assert.equal(moved.undoSteps, 2);
  const hidden = await f.operations.hideFaceControlPoints(9, [f.faceId(A)], f.revision());
  assert.equal(hidden.undoSteps, 2);
  assert.equal(f.undoStack.length, 6);
  const none = fixture({ stepsPerEdit: 0 });
  const free = await none.operations.showFaceControlPoints(9, [none.faceId(A)], "r1");
  assert.equal(free.undoSteps, 0, "an edit that adds no Undo entry reports 0");
});

test("a failed read-back names the measured number of Undo steps", async () => {
  const f = fixture({ stepsPerEdit: 2, moveIgnored: true });
  const shown = await f.operations.showFaceControlPoints(9, [f.faceId(A)], "r1");
  await assert.rejects(f.operations.moveFaceControlPoints(9, [shown.controlPoints[2]!.cvId], [0, 0, 5], f.revision()), /^Error: Moving face control points took 2 Undo steps, but the read-back does not match/);
});

// ---- item 9: read-back tolerance far from the origin

test("the move tolerance is max(1e-3, |coordinate| x 2e-7 x 4) mm per axis", () => {
  assert.equal(faceControlPointTolerance(0), 1e-3);
  assert.equal(faceControlPointTolerance(-1000), 1e-3);
  assert.ok(Math.abs(faceControlPointTolerance(2900) - 0.00232) < 1e-12);
  assert.ok(Math.abs(faceControlPointTolerance(40_000) - 0.032) < 1e-12);
  assert.ok(Math.abs(faceControlPointTolerance(-120_000) - 0.096) < 1e-12);
});

test("a correct float32 move passes the read-back at 2.9 m, 40 m and 120 m from the origin", async () => {
  for (const x0 of [2.9, 40, 120]) {
    const f = fixture({ kernel: [{ entity: A, surfaceType: "BSurf", vertices: grid(x0, 0.010667) }, { entity: B, surfaceType: "BSurf", vertices: grid(x0 + 0.02, 0.010667) }] });
    const shown = await f.operations.showFaceControlPoints(9, [f.faceId(A)], "r1");
    const ids = shown.controlPoints.map((point) => point.cvId);
    const moved = await f.operations.moveFaceControlPoints(9, ids, [5, 0, 0], f.revision());
    assert.equal(moved.controlPoints.length, 8, `${x0} m`);
    for (const [index, point] of moved.controlPoints.entries()) {
      assert.ok(Math.abs(point.positionMm[0] - (shown.controlPoints[index]!.positionMm[0] + 5)) < 0.01, `${x0} m point ${index}`);
    }
  }
});

test("a real miss far from the origin is still reported, with the tolerance used", async () => {
  const f = fixture({ moveIgnored: true, kernel: [{ entity: A, surfaceType: "BSurf", vertices: grid(120, 0.010667) }, { entity: B, surfaceType: "BSurf", vertices: grid(120.02, 0.010667) }] });
  const shown = await f.operations.showFaceControlPoints(9, [f.faceId(A)], "r1");
  await assert.rejects(f.operations.moveFaceControlPoints(9, [shown.controlPoints[0]!.cvId], [0.5, 0, 0], f.revision()), (error: Error) => {
    assert.match(error.message, /took one Undo step, but the read-back does not match: cv 67c0 is at \[120000, 0, 0\], expected \[120000\.5, 0, 0\]; inspect the body or undo \(read-back tolerance per axis: cv 67c0 \[0\.096, 0\.001, 0\.001\] mm\)$/);
    return true;
  });
});

// ---- item 10: renumbered note and grid shapes

test("show reports the grid shape per requested face and whether other faces' cvIds were renumbered", async () => {
  const f = fixture();
  const first = await f.operations.showFaceControlPoints(9, [f.faceId(B)], "r1");
  assert.deepEqual(first.grids, [{ faceId: f.faceId(B), u: 4, v: 2 }]);
  assert.equal(first.renumbered, false, "no other face had shown points");
  assert.equal(first.message, undefined);
  const second = await f.operations.showFaceControlPoints(9, [f.faceId(A)], f.revision());
  assert.equal(second.renumbered, true, "B's points were renumbered when A was shown");
  assert.match(second.message ?? "", /the cvIds of other faces' shown points of body 9 were renumbered; read them again before moving them/);
  assert.deepEqual(second.grids, [{ faceId: f.faceId(A), u: 4, v: 2 }]);
  const again = await f.operations.showFaceControlPoints(9, [f.faceId(A), f.faceId(B)], f.revision());
  assert.equal(again.undoSteps, 0);
  assert.equal(again.renumbered, false);
  assert.deepEqual(again.grids.map((shape) => [shape.u, shape.v]), [[4, 2], [4, 2]]);
});

// ---- item 11: a move that separates coincident points of a shared edge

test("moving one of two coincident shared-edge points alone: the read-back failure explains the separation", async () => {
  const f = fixture({ reshapeOnMove: true });
  const shown = await f.operations.showFaceControlPoints(9, [f.faceId(A), f.faceId(B)], "r1");
  // A's index 6 (x 2920, y 0) and B's index 0 sit at the same position.
  const a6 = shown.controlPoints.find((point) => point.faceId === f.faceId(A) && point.index === 6)!;
  const b0 = shown.controlPoints.find((point) => point.faceId === f.faceId(B) && point.index === 0)!;
  assert.deepEqual(a6.positionMm, b0.positionMm);
  await assert.rejects(f.operations.moveFaceControlPoints(9, [a6.cvId], [0, 0, 5], f.revision()), (error: Error) => {
    assert.match(error.message, /^Moving face control points took one Undo step, but the points could not be read back \(.*match no face control grid\)\. The move separated coincident points of two faces \(67c6 and 67c8\): .*include both cvIds to move a shared edge point; inspect the body or undo$/);
    return true;
  });
  // Moving both points together keeps the edge closed (live: the grids keep their 4 x 2 shape), so a fixture
  // without the reshape stands in for it.
  const g = fixture();
  const both = await g.operations.showFaceControlPoints(9, [g.faceId(A), g.faceId(B)], "r1");
  const moved = await g.operations.moveFaceControlPoints(9, [both.controlPoints[6]!.cvId, both.controlPoints[8]!.cvId], [0, 0, 5], g.revision());
  assert.equal(moved.controlPoints.length, 2);
});
