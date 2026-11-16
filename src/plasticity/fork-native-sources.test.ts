import assert from "node:assert/strict";
import { test } from "node:test";
import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

// Executes the source each operation hands to runtime.mutate against a stub editor.
// The source is only valid when built with nativeFunction: findView reads nativeApi.geo / nativeApi.db.
function fixture(bodies: Array<{ id: number; type: string }>) {
  const state = {
    targetId: "window", title: "Fork fixture", documentToken: "document", revision: "r1", dbVersion: 1,
    undoDepth: 0, redoDepth: 0, regions: [], bodies,
    construction: { planes: [], activePlaneId: "standard:top", planeStateToken: "planes", viewStateToken: "view" },
  } as unknown as RuntimeState;
  // Body ID n lives at version ID 100 + n, so a wrong lookup cannot pass by accident.
  const views = new Map<number, { constructor: { name: string } }>();
  const geometryModel = new Map<number, { view: unknown }>();
  for (const body of bodies) {
    const view = { kind: body.type, constructor: { name: body.type } };
    views.set(body.id, view);
    geometryModel.set(100 + body.id, { view });
  }
  const created: Array<Record<string, unknown>> = [];
  const executed: string[] = [];
  const stub = (name: string) => {
    class Factory {
      resource() { return this; }
      pivot = { fromArray(value: number[]) { this.value = value; }, value: [] as number[] };
      scale = { fromArray(value: number[]) { this.value = value; }, value: [] as number[] };
      async commit() { created.push({ factory: name, ...(this as unknown as Record<string, unknown>) }); return name === "CreateInstanceFactory" ? [{ constructor: { name: "InstanceEmpty" } }] : []; }
    }
    return Factory;
  };
  class Vector {
    constructor(...components: number[]) { Object.assign(this, { components }); }
    normalize() { return this; }
  }
  const editor = {
    geo: { geometryModel },
    db: { lookupStableId(version: number) { return version - 100; } },
    executor: { isBusy: false },
    commands: new Proxy({}, {
      get: (_target, name: string) => class { remember = true; execute: () => Promise<unknown> = async () => undefined; constructor() { executed.push(name); } },
    }),
    async exec(command: { execute(): Promise<unknown> }) { await command.execute(); },
  };
  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) {
      calls.push({ source, bindings, values });
      const native = Function(`return (${source})`)();
      const classes = bindings.map((binding) => binding === "Vector3" ? Vector : binding === "CurveType" ? { Polyline: "polyline", NURBS: "nurbs" } : stub(binding));
      await native.call(editor, ...classes, ...values);
    },
  } as unknown as PlasticityRuntime;
  return { operations: new PlasticityOperations(runtime), created, executed, calls, views };
}

test("createMirroredInstance native source executes and resolves the body through findView", async () => {
  const f = fixture([{ id: 7, type: "Solid" }]);
  await f.operations.createMirroredInstance(7, "x", 12, "r1");
  assert.deepEqual(f.calls[0]!.bindings, ["CreateInstanceFactory", "ProjectingScaleItemAndEmptyFactory"]);
  assert.deepEqual(f.executed, ["GroupSelectedCommand"]);
  assert.equal(f.created[0]!.factory, "CreateInstanceFactory");
  assert.deepEqual(f.created[0]!.items, [f.views.get(7)]);
});

test("cutWithCurves native source executes and resolves targets and cutters through findView", async () => {
  const f = fixture([{ id: 7, type: "Solid" }, { id: 9, type: "Wire" }]);
  await f.operations.cutWithCurves([7], [9], undefined, true, "r1");
  assert.deepEqual(f.calls[0]!.bindings, ["MultiCutFactory", "Vector3"]);
  assert.deepEqual(f.executed, ["CutCommand"]);
  assert.equal(f.created[0]!.factory, "MultiCutFactory");
  assert.deepEqual(f.created[0]!.shells, [f.views.get(7)]);
  assert.deepEqual(f.created[0]!.curves, [f.views.get(9)]);
  assert.equal(f.created[0]!.shouldExtend, true);
});

test("knifeCurve native source executes and resolves the target through findView", async () => {
  const f = fixture([{ id: 7, type: "Solid" }]);
  await f.operations.knifeCurve(7, [[0, 0, 0], [10, 0, 0]], false, false, "r1");
  assert.deepEqual(f.calls[0]!.bindings, ["KnifeCurveFactory", "Vector3", "CurveType"]);
  assert.deepEqual(f.executed, ["CurveCommand"]);
  assert.equal(f.created[0]!.factory, "KnifeCurveFactory");
  assert.equal(f.created[0]!.target, f.views.get(7));
  assert.equal(f.created[0]!.isKnife, true);
  assert.equal(f.created[0]!.type, "polyline");
  assert.equal((f.created[0]!.points as unknown[]).length, 2);
});

test("extrudeCurves native source executes and resolves the Wire through findView", async () => {
  const f = fixture([{ id: 9, type: "Wire" }]);
  await f.operations.extrudeCurves([9], 5, undefined, "r1");
  assert.deepEqual(f.calls[0]!.bindings, ["ExtrudeFactory", "Vector3"]);
  assert.deepEqual(f.executed, ["ExtrudeCommand"]);
  assert.equal(f.created[0]!.factory, "ExtrudeFactory");
  assert.deepEqual(f.created[0]!.curves, [f.views.get(9)]);
  assert.equal(f.created[0]!.distance1, 0.005);
});

test("filletCurves native source executes and resolves both Wires through findView", async () => {
  const f = fixture([{ id: 9, type: "Wire" }, { id: 10, type: "Wire" }]);
  await f.operations.filletCurves(9, 10, 2, "r1");
  assert.deepEqual(f.calls[0]!.bindings, ["FilletCurveFactory"]);
  assert.deepEqual(f.executed, ["FilletCurveCommand"]);
  assert.equal(f.created[0]!.factory, "FilletCurveFactory");
  assert.deepEqual(f.created[0]!.curves, [f.views.get(9), f.views.get(10)]);
  assert.equal(f.created[0]!.radius, 0.002);
});
