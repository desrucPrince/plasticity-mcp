import assert from "node:assert/strict";
import { test } from "node:test";

import { CommittedChangeError, PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

// plasticity_square_surface (P7): SquareFactory driven directly inside SquareEdgeCommand, against a stub editor.
const CONTINUITY = { G0: 23156, G1: 23153, G2: 23154 };

function fixture(options: { commitError?: string; addBodies?: number; addSteps?: number; ends?: number[][][] } = {}) {
  const body = (id: number, type: string, edgeIds: string[] = []) => ({ id, versionId: 100 + id, type, name: null, boundsMm: null, faceIds: [], edgeIds, faces: [], edges: edgeIds.map((edgeId) => ({ id: edgeId, faceIds: ["f"] })) });
  let state = {
    targetId: "w", title: "t", documentToken: "doc", revision: "r1", dbVersion: 1, undoDepth: 2, redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" },
    bodies: [body(5, "Sheet", ["5e1", "5e2"]), body(7, "Wire"), body(8, "Wire"), body(9, "Wire"), body(10, "Wire"), body(11, "Mesh")],
  } as unknown as RuntimeState;
  const created: Array<Record<string, any>> = [];
  const views = new Map<number, unknown>(state.bodies.map((entry): [number, unknown] => [entry.versionId, { view: entry.type === "Sheet"
    ? { constructor: { name: "Sheet" }, high: { edges: { versionIds: entry.edgeIds, get: (index: number) => ({ edge: entry.edgeIds[index] }) } } }
    : { constructor: { name: entry.type }, wire: entry.id } }]));
  class SquareFactory {
    boundaries: unknown[] = [];
    perEdge: Array<[unknown, number]> = [];
    resource() { return this; }
    setContinuityForEdge(edge: unknown, value: number) { this.perEdge.push([edge, value]); }
    async commit() {
      if (options.commitError) throw new Error(options.commitError);
      created.push({ boundaries: this.boundaries, perEdge: this.perEdge });
      const extra = Array.from({ length: options.addBodies ?? 1 }, (_, i) => body(50 + i, "Sheet"));
      state = { ...state, revision: "r2", undoDepth: state.undoDepth + (options.addSteps ?? 1), bodies: [...state.bodies, ...extra] } as RuntimeState;
      return [];
    }
  }
  class SquareEdgeCommand { remember = true; execute: () => Promise<unknown> = async () => undefined; }
  const editor = {
    geo: { read: { geometryModel: views, automatics: new Set<number>() }, lookupStableId(version: number) { return version - 100; } },
    db: { version: 1, commit() { return undefined; } },
    executor: { isBusy: false, active: null },
    async exec(command: { execute(): Promise<unknown> }) { await command.execute(); },
  };
  const calls: Array<{ bindings: string[]; values: unknown[] }> = [];
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) {
      calls.push({ bindings, values });
      const native = Function(`return (${source})`)();
      return await native.call(editor, ...bindings.map((name) => ({ SquareFactory, SquareEdgeCommand, ContinuityType: CONTINUITY } as Record<string, unknown>)[name]), ...values);
    },
    isUncertain() { return false; },
    // The kernel ends of the four boundary items (metres): a closed 40 x 40 loop unless the test opens it.
    async read() { return options.ends ?? [[[0, 0, 0], [0.04, 0, 0]], [[0.04, 0, 0], [0.04, 0.04, 0]], [[0.04, 0.04, 0], [0, 0.04, 0]], [[0, 0.04, 0], [0, 0, 0]]]; },
  } as unknown as PlasticityRuntime;
  return { operations: new PlasticityOperations(runtime), created, calls };
}

test("squareSurface sets one flat boundaries list of edge and Wire views and per-edge g0/g1 by the edge views", async () => {
  const f = fixture();
  const result = await f.operations.squareSurface({ boundary: [{ bodyId: 5, edgeId: "5e2" }, { wireId: 7 }, { wireId: 8 }, { wireId: 9 }], edgeContinuity: [{ edgeId: "5e2", continuity: "g1" }] }, "r1");
  assert.deepEqual(f.calls[0]!.bindings, ["SquareFactory", "SquareEdgeCommand", "ContinuityType"]);
  const expected: unknown[] = [{ edge: "5e2" }, { constructor: { name: "Wire" }, wire: 7 }, { constructor: { name: "Wire" }, wire: 8 }, { constructor: { name: "Wire" }, wire: 9 }];
  assert.deepEqual(f.created[0]!.boundaries, expected);
  assert.deepEqual(f.created[0]!.perEdge, [[{ edge: "5e2" }, 23153]]);
  assert.equal(result.sheetId, 50);
  assert.equal(result.undoSteps, 1);
});

test("squareSurface explains XNurbs error 30 and keeps the raw code", async () => {
  const f = fixture({ commitError: "XNurbs operation failed with error `30`." });
  await assert.rejects(f.operations.squareSurface({ boundary: [{ wireId: 7 }, { wireId: 8 }, { wireId: 9 }, { wireId: 10 }] }, "r1"), /error `30`\. XNurbs error 30: the requested continuity is incompatible/);
});

test("a commit that adds more than one body or Undo step is a certain error with undo advice", async () => {
  const f = fixture({ addSteps: 2 });
  await assert.rejects(f.operations.squareSurface({ boundary: [{ wireId: 7 }, { wireId: 8 }, { wireId: 9 }, { wireId: 10 }] }, "r1"), (error: Error) => error instanceof CommittedChangeError && /plasticity_undo restores/.test(error.message));
});

test("squareSurface refuses bad input before any native call", async () => {
  const f = fixture();
  const reject = (input: Parameters<PlasticityOperations["squareSurface"]>[0], pattern: RegExp) => assert.rejects(f.operations.squareSurface(input, "r1"), pattern);
  await reject({ boundary: [{ wireId: 7 }, { wireId: 8 }, { wireId: 9 }] }, /exactly four/);
  await reject({ boundary: [{ wireId: 7 }, { wireId: 7 }, { wireId: 9 }, { wireId: 10 }] }, /unique/);
  await reject({ boundary: [{ wireId: 5 }, { wireId: 8 }, { wireId: 9 }, { wireId: 10 }] }, /current Wire: 5/);
  await reject({ boundary: [{ bodyId: 11, edgeId: "x" }, { wireId: 8 }, { wireId: 9 }, { wireId: 10 }] }, /Sheet or Solid body: 11/);
  await reject({ boundary: [{ bodyId: 5, edgeId: "nope" }, { wireId: 8 }, { wireId: 9 }, { wireId: 10 }] }, /Stale or unknown Square boundary edge/);
  await reject({ boundary: [{ bodyId: 5, edgeId: "5e1" }, { wireId: 8 }, { wireId: 9 }, { wireId: 10 }], edgeContinuity: [{ edgeId: "5e2", continuity: "g1" }] }, /boundary edges given in boundary: 5e2/);
  await reject({ boundary: [{ bodyId: 5, edgeId: "5e1" }, { wireId: 8 }, { wireId: 9 }, { wireId: 10 }], edgeContinuity: [{ edgeId: "5e1", continuity: "g2" as never }] }, /g0 or g1/);
  await assert.rejects(f.operations.squareSurface({ boundary: [{ wireId: 7 }, { wireId: 8 }, { wireId: 9 }, { wireId: 10 }] }, "old"), /Stale reference/);
  assert.equal(f.calls.length, 0);
});
