import assert from "node:assert/strict";
import { test } from "node:test";

import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";
import { explainXNurbsError, XNURBS_ERROR_ADVICE, xnurbsErrorCode } from "./surfacing.ts";

// plasticity_xsided_patch error codes and the per-edge continuity / tension options (P3), against a stub editor.
const CONTINUITY = { C1: 23150, C2: 23151, C3: 23152, G1: 23153, G2: 23154, G3: 23155, G0: 23156, Free: 23157 };

function fixture(commitError?: string) {
  const state = {
    targetId: "w", title: "t", documentToken: "doc", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0,
    construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" }, regions: [],
    bodies: [
      { id: 5, versionId: 105, type: "Sheet", name: null, boundsMm: null, faceIds: ["f1"], edgeIds: ["e1", "e2", "e3"], faces: [], edges: [] },
      { id: 7, versionId: 107, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
      { id: 8, versionId: 108, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
      { id: 9, versionId: 109, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
    ],
  } as unknown as RuntimeState;
  const edgeIds = ["e1", "e2", "e3"];
  const sheet = { constructor: { name: "Sheet" }, high: { edges: { versionIds: edgeIds, get: (index: number) => ({ edge: edgeIds[index] }) } } };
  const geometryModel = new Map<number, { view: unknown }>([[105, { view: sheet }], [107, { view: { constructor: { name: "Wire" } } }], [108, { view: { constructor: { name: "Wire" } } }], [109, { view: { constructor: { name: "Wire" } } }]]);
  const created: Array<Record<string, unknown>> = [];
  class XSidedFactory {
    edges: unknown[] = [];
    perEdge: Array<[unknown, number]> = [];
    blending?: number;
    enforceTolerance?: number;
    continuity?: number;
    resource() { return this; }
    setContinuityForEdge(edge: unknown, value: number) { this.perEdge.push([edge, value]); }
    async commit() {
      if (commitError) throw new Error(commitError);
      created.push({ ...(this as unknown as Record<string, unknown>) });
      return [];
    }
  }
  const editor = {
    geo: { read: { geometryModel, automatics: new Set<number>() }, lookupStableId(version: number) { return version - 100; } },
    db: { version: 1, commit() { return undefined; } },
    executor: { isBusy: false },
    commands: new Proxy({}, { get: () => class { remember = true; execute: () => Promise<unknown> = async () => undefined; } }),
    async exec(command: { execute(): Promise<unknown> }) { await command.execute(); },
  };
  const calls: Array<{ bindings: string[]; values: unknown[] }> = [];
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) {
      calls.push({ bindings, values });
      const native = Function(`return (${source})`)();
      return await native.call(editor, ...bindings.map((name) => (name === "ContinuityType" ? CONTINUITY : name === "pk_default" ? { a: { EnforceToleranceType: { OnlyParameterization: 0, High: 1, Max: 2, Automatic: 5 } } } : XSidedFactory)), ...values);
    },
    isUncertain() { return false; },
  } as unknown as PlasticityRuntime;
  return { operations: new PlasticityOperations(runtime), created, calls };
}

test("xnurbsErrorCode reads the code from the native text", () => {
  assert.equal(xnurbsErrorCode(new Error("Plasticity command failed: Error: XNurbs operation failed with error `30`.")), 30);
  assert.equal(xnurbsErrorCode("XNurbs operation failed with error 27"), 27);
  assert.equal(xnurbsErrorCode(new Error("Kernel failed")), undefined);
});

test("explainXNurbsError keeps the raw code and appends what the decoded and reproduced codes mean", () => {
  const raw = (code: number) => new Error(`Plasticity command failed: Error: XNurbs operation failed with error \`${code}\`.`);
  const text = (code: number) => (explainXNurbsError(raw(code)) as Error).message;
  assert.match(text(30), /^Plasticity command failed: Error: XNurbs operation failed with error `30`\. XNurbs error 30: the requested continuity is incompatible at a corner or with the neighbouring faces/);
  assert.match(text(30), /perpendicular to the patch\)\. Lower the continuity \(or set it per edge\), or blend the rim first\./);
  assert.match(text(3), /no usable boundary input/);
  assert.match(text(29), /boundary constraints are inconsistent/);
  assert.match(text(25), /not fully decoded\. Reproduced when the edge list held edges that branch off the boundary loop/);
  assert.match(text(27), /not fully decoded\. Reproduced when g1 or g2 was asked on the open rim of a Sheet/);
  assert.match(text(41), /error `41`\. XNurbs error 41: this code is undecoded on Plasticity 26\.1\.3/);
  assert.equal((explainXNurbsError(raw(30)) as Error & { xnurbsCode?: number }).xnurbsCode, 30);
  const other = new Error("Kernel failed");
  assert.equal(explainXNurbsError(other), other);
  assert.deepEqual(Object.keys(XNURBS_ERROR_ADVICE).map(Number).sort((a, b) => a - b), [3, 25, 27, 29, 30]);
});

test("xsidedPatch rethrows a native XNurbs failure with its meaning", async () => {
  const f = fixture("XNurbs operation failed with error `30`.");
  await assert.rejects(f.operations.xsidedPatch({ edges: { bodyId: 5, edgeIds: ["e1", "e2", "e3"] }, continuity: "g1" }, "r1"), (error: Error) => {
    assert.match(error.message, /error `30`/);
    assert.match(error.message, /incompatible at a corner or with the neighbouring faces/);
    return true;
  });
  const g = fixture("Something else broke");
  await assert.rejects(g.operations.xsidedPatch({ edges: { bodyId: 5, edgeIds: ["e1"] } }, "r1"), /^Error: Something else broke$|Something else broke/);
});

test("xsidedPatch sets per-edge continuity on the matching edge views and tension as the factory's blending", async () => {
  const f = fixture();
  await f.operations.xsidedPatch({ edges: { bodyId: 5, edgeIds: ["e1", "e2", "e3"] }, continuity: "g0", edgeContinuity: [{ edgeId: "e2", continuity: "g1" }, { edgeId: "e3", continuity: "g2" }], tension: 0.25 }, "r1");
  assert.deepEqual(f.calls[0]!.bindings, ["XSidedFactory", "ContinuityType"]);
  const factory = f.created[0]!;
  assert.equal(factory.continuity, 23156);
  assert.deepEqual(factory.perEdge, [[{ edge: "e2" }, 23153], [{ edge: "e3" }, 23154]]);
  assert.equal(factory.blending, 0.25);
  // edgeContinuity alone still binds ContinuityType; no options leave the factory untouched.
  const g = fixture();
  await g.operations.xsidedPatch({ edges: { bodyId: 5, edgeIds: ["e1", "e2"] }, edgeContinuity: [{ edgeId: "e1", continuity: "g1" }] }, "r1");
  assert.deepEqual(g.calls[0]!.bindings, ["XSidedFactory", "ContinuityType"]);
  assert.equal(g.created[0]!.continuity, undefined);
  const h = fixture();
  await h.operations.xsidedPatch({ edges: { bodyId: 5, edgeIds: ["e1"] } }, "r1");
  assert.deepEqual(h.calls[0]!.bindings, ["XSidedFactory"]);
  assert.equal(h.created[0]!.blending, undefined);
  assert.deepEqual(h.created[0]!.perEdge, []);
  assert.equal(h.created[0]!.enforceTolerance, undefined);
});

test("xsidedPatch quality sets enforceTolerance from EnforceToleranceType by name and binds pk_default only then", async () => {
  for (const [quality, value] of [["auto", 5], ["high", 1], ["max", 2]] as const) {
    const f = fixture();
    await f.operations.xsidedPatch({ curveIds: [7, 8, 9], quality }, "r1");
    assert.deepEqual(f.calls[0]!.bindings, ["XSidedFactory", "pk_default"]);
    assert.equal(f.created[0]!.enforceTolerance, value, quality);
  }
});

test("xsidedPatch rejects bad edgeContinuity and tension before any native call", async () => {
  const f = fixture();
  const reject = async (input: Parameters<PlasticityOperations["xsidedPatch"]>[0], pattern: RegExp) => assert.rejects(f.operations.xsidedPatch(input, "r1"), pattern);
  await reject({ curveIds: [7, 8, 9], edgeContinuity: [{ edgeId: "e1", continuity: "g1" }] }, /edges only/);
  await reject({ edges: { bodyId: 5, edgeIds: ["e1"] }, edgeContinuity: [] }, /must not be empty/);
  await reject({ edges: { bodyId: 5, edgeIds: ["e1", "e2"] }, edgeContinuity: [{ edgeId: "e1", continuity: "g1" }, { edgeId: "e1", continuity: "g0" }] }, /unique/);
  await reject({ edges: { bodyId: 5, edgeIds: ["e1"] }, edgeContinuity: [{ edgeId: "e2", continuity: "g1" }] }, /must be boundary edges in edges\.edgeIds: e2/);
  await reject({ edges: { bodyId: 5, edgeIds: ["e1"] }, edgeContinuity: [{ edgeId: "e1", continuity: "g3" as never }] }, /must be one of/);
  for (const tension of [0, 0.05, 1.5, Number.NaN]) await reject({ edges: { bodyId: 5, edgeIds: ["e1"] }, tension }, /tension must be between 0\.1 and 1\.0/);
  await reject({ edges: { bodyId: 5, edgeIds: ["e1"] }, quality: "ultra" as never }, /quality must be one of: auto, high, max/);
  assert.equal(f.calls.length, 0);
});
