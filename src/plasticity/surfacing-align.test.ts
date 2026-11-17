import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { CommittedChangeError, PlasticityOperations, type PickCommandTimeouts } from "./operations.ts";
import { classifyPickOutcome, PICK_OUTCOME_TABLE } from "./pick-command-outcome.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";
import { SURFACE_ALIGN_DRIVE, SURFACE_ALIGN_READBACK_SOURCE } from "./surfacing.ts";

// plasticity_surface_align (P6) on runPickCommand: the real generated renderer source runs against a stub editor whose
// AlignEdgeDialog is a DOM element (a stub document), with the 26.1.3 executor that swallows execute() errors.

type Scenario = "commit" | "update-throws" | "never-ready" | "updating" | "computing" | "hang-after-finish" | "commit-misses";

const CONTINUITY = { C1: 23150, C2: 23151, C3: 23152, G1: 23153, G2: 23154, G3: 23155, G0: 23156, Free: 23157 };

class Vector3 { x: number; y: number; z: number; constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } }

class FakeAlignDialog {
  params: Record<string, any>;
  isConnected = true;
  finished = 0;
  onFinish: () => void = () => {};
  constructor(params: Record<string, any>) { this.params = params; }
  finish() { this.finished += 1; this.onFinish(); }
}

const restoreDocument = (globalThis as { document?: unknown }).document;
afterEach(() => { (globalThis as { document?: unknown }).document = restoreDocument; });

function fixture(scenario: Scenario = "commit", options: { cancel?: "normal" | "throws"; readGapM?: number; observable?: boolean } = {}) {
  const sheet = (id: number, edgeIds: string[]) => ({
    id, versionId: 100 + id, type: "Sheet", name: null, boundsMm: null, faceIds: [`${id}f1`], edgeIds,
    faces: [], edges: edgeIds.map((edgeId) => ({ id: edgeId, faceIds: [`${id}f1`] })),
  });
  const moving = sheet(8, ["8e1", "8e2"]);
  const reference = sheet(7, ["7e1", "7e2"]);
  const solid = { ...sheet(9, ["9e1"]), type: "Solid" };
  const state = {
    targetId: "w", title: "align", documentToken: "doc", revision: "r1", dbVersion: 1, undoDepth: 4, redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" }, bodies: [reference, moving, solid],
  } as unknown as RuntimeState;
  const edgeView = (versionId: string) => ({ versionId, entityId: Number(versionId.replace(/\D/g, "")) });
  const views = new Map<number, unknown>([7, 8].map((id) => {
    const ids = id === 7 ? reference.edgeIds : moving.edgeIds;
    return [100 + id, { view: { constructor: { name: "Sheet" }, high: { edges: { versionIds: ids, get: (index: number) => edgeView(ids[index]!) }, faces: { versionIds: [] } } }, model: {} }];
  }));
  const selected: unknown[] = [];
  // The user's own selection before the call: one face of the reference Sheet (body 7).
  const userFaces = new Set<unknown>();
  const userFace = { isFace: true, versionId: "107f1" };
  userFaces.add(userFace);
  const undoStack: unknown[] = [];
  const seen: { selection?: string[]; perEdge?: Array<[string, number]>; updateBeforeFinish?: boolean; dialog?: FakeAlignDialog; cancelled: number } = { cancelled: 0 };
  let dom: unknown[] = [];
  (globalThis as { document?: unknown }).document = { querySelectorAll: () => dom, querySelector: () => null };

  class AlignEdgeCommand {
    remember = true;
    _state: unknown = null;
    private rejectRun: ((error: Error) => void) | undefined;
    cancel() { this.rejectRun?.(new Error("Cancel")); }
    async execute(): Promise<unknown> {
      seen.selection = (selected as Array<{ versionId: string }>).map((entry) => entry.versionId);
      return await new Promise((resolve, reject) => {
        this.rejectRun = (error) => { dom = []; reject(error); };
        let updated = false;
        const factory: Record<string, any> = {
          pairs: [edgeView(seen.selection![0]!), edgeView(seen.selection![1]!)],
          _state: { value: { tag: "updating" } },
          setContinuityForEdge(edge: { versionId: string }, value: number) { (seen.perEdge ??= []).push([edge.versionId, value]); },
          // Live (26.1.3): the factory reads "updating" while update() runs and "updated" after it; the command stays Awaiting.
          async update() { factory._state = { value: { tag: "updating" } }; if (scenario === "update-throws") throw new Error("XNurbs operation failed with error `30`."); await new Promise((done) => setTimeout(done, 2)); updated = true; factory._state = { value: { tag: "updated" } }; },
        };
        if (options.observable === false) { delete factory._state; }
        const dialog = new FakeAlignDialog(factory);
        seen.dialog = dialog;
        dom = [{ notADialog: true }, dialog];
        // The states are the ones measured live on 26.1.3 (probes-2026-11-surfacing FINDINGS, "Command and factory states"):
        // the dialog appears with the command "None" and the factory "updating"; about 20 ms later the command is Awaiting
        // and the factory "updated"; from finish() the command stays Awaiting (factory "updated") until the commit has
        // landed, then it is Finished and the factory "committed".
        // never-ready: the command is Awaiting and its factory is idle but never "updated" (a cancel is allowed).
        // updating: the command is Awaiting while its factory never stops updating (a cancel must never be sent).
        // computing: the command never reaches Awaiting (a cancel must never be sent).
        this._state = { tag: "None" };
        if (scenario === "never-ready") setTimeout(() => { this._state = { tag: "Awaiting" }; factory._state = { value: { tag: "failed" } }; }, 20);
        else if (scenario === "updating") setTimeout(() => { this._state = { tag: "Awaiting" }; }, 20);
        else if (scenario !== "computing" && options.observable !== false) setTimeout(() => { this._state = { tag: "Awaiting" }; factory._state = { value: { tag: "updated" } }; }, 20);
        dialog.onFinish = () => {
          seen.updateBeforeFinish = updated;
          // A commit that never lands: the command stays Awaiting and the factory "updated", exactly as in the first
          // milliseconds of a real commit, so the states alone cannot tell a stalled commit from an idle command.
          if (scenario === "hang-after-finish") return;
          dom = [];
          undoStack.push({ align: true });
          moving.versionId += 1;
          this._state = { tag: "Finished" };
          if (factory._state) factory._state = { value: { tag: "committed" } };
          resolve(undefined);
        };
      });
    }
  }
  const executor = {
    isBusy: false,
    active: null as { command: { cancel?: () => void; constructor: { name: string } } } | null,
    cancelActiveCommand() { seen.cancelled += 1; if (options.cancel === "throws") throw new Error("cancel exploded"); this.active?.command.cancel?.(); },
  };
  const editor = {
    geo: { read: { geometryModel: views, automatics: new Set<number>() }, lookupStableId(version: number) { return version - 100; } },
    db: { version: 1, commit() { return undefined; } },
    executor,
    history: { undoStack },
    helpers: { scene: { traverse() {} } },
    selection: {
      selected: {
        faces: userFaces, edges: new Set(),
        add(item: unknown) { if ((item as { isFace?: boolean }).isFace) userFaces.add(item); else selected.push(item); },
        removeAll() { selected.length = 0; userFaces.clear(); },
        // Plasticity's selection memento: ids "<kind>:<versionId>", the body version leading the versionId.
        saveToMemento() { return { ids: new Set([...userFaces].map((face) => `2:${(face as { versionId: string }).versionId}`)) }; },
        restoreFromMemento(memento: { ids: Set<string> }) { userFaces.clear(); for (const id of memento.ids) if (id === `2:${userFace.versionId}`) userFaces.add(userFace); },
      },
      hits: { hits: new Map(), record() { throw new Error("no hit is recorded for Surface Align"); }, clear() {} },
    },
    async exec(command: AlignEdgeCommand) {
      executor.active = { command };
      try { await command.execute(); } catch { /* the 26.1.3 executor swallows execute() errors */ } finally { if (executor.active?.command === command) executor.active = null; }
    },
  };
  const calls: Array<{ kind: string; source: string; bindings: string[]; values: unknown[] }> = [];
  let uncertain = false;
  const runtime = {
    async getState() { return structuredClone(state); },
    async mutate(source: string, bindings: string[], values: unknown[]) {
      calls.push({ kind: "mutate", source, bindings, values });
      const native = Function(`return (${source})`)();
      const bound = bindings.map((name) => ({ AlignEdgeCommand, AlignEdgeDialog: FakeAlignDialog, Vector3, ContinuityType: CONTINUITY } as Record<string, unknown>)[name]);
      return await native.call(editor, ...bound, ...values);
    },
    async read(source: string, values: unknown[]) {
      calls.push({ kind: "read", source, bindings: [], values });
      return { referenceFound: true, movingEdgeId: "8e9", maxGapM: options.readGapM ?? (scenario === "commit-misses" ? 5e-4 : 0), maxNormalAngleDeg: 1e-6, samples: 21 };
    },
    markUncertain() { uncertain = true; },
    isUncertain() { return uncertain; },
  } as unknown as PlasticityRuntime;
  return { operations: new PlasticityOperations(runtime), calls, seen, undoStack, isUncertain: () => uncertain, userFaces, userFace };
}

const align = (f: ReturnType<typeof fixture>, timeouts?: PickCommandTimeouts) =>
  f.operations.surfaceAlign({ moving: { bodyId: 8, edgeId: "8e1" }, reference: { bodyId: 7, edgeId: "7e2" }, continuity: "g1" }, "r1", timeouts);

test("surfaceAlign selects [moving, reference], waits for Awaiting, keys continuity by the reference edge, updates, then finishes", async () => {
  const f = fixture("commit");
  const result = await align(f);
  const mutate = f.calls.find((call) => call.kind === "mutate")!;
  assert.deepEqual(mutate.bindings, ["AlignEdgeCommand", "AlignEdgeDialog", "Vector3", "ContinuityType"]);
  assert.match(mutate.source, /async function \(Command, Dialog, Vector3, ContinuityType, args\)/);
  assert.equal((mutate.values[0] as { domDialog?: boolean }).domDialog, true);
  assert.deepEqual((mutate.values[0] as { hits: unknown[] }).hits, []);
  assert.deepEqual(f.seen.selection, ["8e1", "7e2"]);
  assert.deepEqual(f.seen.perEdge, [["7e2", 23153]]);
  assert.equal(f.seen.updateBeforeFinish, true);
  assert.equal(f.seen.dialog!.finished, 1);
  assert.equal(result.undoSteps, 1);
  assert.equal(result.readiness, "awaiting");
  assert.deepEqual(result.moving, { bodyId: 8, edgeId: "8e9" });
  assert.deepEqual(result.coincidence, { maxGapMm: 0, toleranceMm: 0.001, samples: 21 });
  assert.equal(result.achieved, "not measured");
  assert.match(result.note, /plasticity_join_sheets.*plasticity_analyze_surface_continuity/);
  const read = f.calls.find((call) => call.kind === "read")!;
  assert.equal(read.source, SURFACE_ALIGN_READBACK_SOURCE);
  assert.deepEqual(read.values, [{ reference: { bodyId: 7, edgeId: "7e2" }, movingBodyId: 8, samples: 21 }]);
  assert.equal(f.isUncertain(), false);
});

test("a build without the command/factory states waits the fixed 500 ms before finish()", async () => {
  const f = fixture("commit", { observable: false });
  const started = Date.now();
  const result = await align(f);
  assert.equal(result.readiness, "fixed-wait");
  assert.ok(Date.now() - started >= 480);
});

test("a pair that cannot align fails in update() before finish(): a certain rejection, nothing changed", async () => {
  const f = fixture("update-throws");
  await assert.rejects(align(f), (error: Error) => {
    assert.doesNotMatch(error.message, /reconcile/);
    assert.match(error.message, /Surface Align/);
    return true;
  });
  assert.equal(f.seen.dialog!.finished, 0);
  assert.equal(f.undoStack.length, 0);
  assert.equal(f.isUncertain(), false);
});

test("a stall before finish() (never ready, short injected timeout) is cancelled and certain: nothing changed", async () => {
  const f = fixture("never-ready");
  await assert.rejects(align(f, { dialogMs: 1000, finishMs: 60, cancelMs: 1000 }), (error: Error) => { assert.doesNotMatch(error.message, /reconcile/); return true; });
  assert.equal(f.seen.dialog!.finished, 0);
  assert.equal(f.seen.cancelled, 1);
  assert.equal(f.isUncertain(), false);
});

test("a stall after finish() is never reported as unchanged: undetermined, the session is uncertain", async () => {
  const f = fixture("hang-after-finish");
  await assert.rejects(align(f, { dialogMs: 1000, finishMs: 150, cancelMs: 300, settleMs: 50 }), /reconcile/);
  assert.equal(f.seen.dialog!.finished, 1);
  assert.equal(f.isUncertain(), true);
});

test("a cancel that throws during a stall is undetermined", async () => {
  const f = fixture("never-ready", { cancel: "throws" });
  await assert.rejects(align(f, { dialogMs: 1000, finishMs: 60, cancelMs: 300 }), /reconcile/);
  assert.equal(f.isUncertain(), true);
});

test("a commit whose moving edge misses the reference edge is a certain mismatch with undo advice", async () => {
  const f = fixture("commit-misses");
  await assert.rejects(align(f), (error: Error) => {
    assert.ok(error instanceof CommittedChangeError);
    assert.match(error.message, /plasticity_undo restores/);
    assert.match(error.message, /0\.5 mm from the reference edge/);
    return true;
  });
  assert.equal(f.isUncertain(), false);
});

test("surfaceAlign validates bodies, edges and continuity before any native call", async () => {
  const f = fixture();
  const reject = (input: Parameters<PlasticityOperations["surfaceAlign"]>[0], pattern: RegExp) => assert.rejects(f.operations.surfaceAlign(input, "r1"), pattern);
  await reject({ moving: { bodyId: 8, edgeId: "8e1" }, reference: { bodyId: 8, edgeId: "8e2" }, continuity: "g1" }, /two different Sheet bodies/);
  await reject({ moving: { bodyId: 9, edgeId: "9e1" }, reference: { bodyId: 7, edgeId: "7e1" }, continuity: "g1" }, /must be a current Sheet body/);
  await reject({ moving: { bodyId: 8, edgeId: "nope" }, reference: { bodyId: 7, edgeId: "7e1" }, continuity: "g1" }, /Stale or unknown moving edge/);
  await reject({ moving: { bodyId: 8, edgeId: "8e1" }, reference: { bodyId: 7, edgeId: "7e1" }, continuity: "g3" as never }, /continuity must be one of: g0, g1, g2/);
  await assert.rejects(f.operations.surfaceAlign({ moving: { bodyId: 8, edgeId: "8e1" }, reference: { bodyId: 7, edgeId: "7e1" }, continuity: "g1" }, "old"), /Stale reference/);
  assert.equal(f.calls.length, 0);
});

test("the classifier invariant still holds: after finish() only the no-effect rejection may claim unchanged", () => {
  // The P6 lifecycle adds no new facts; the table is unchanged and its after-finish rows never say unchanged otherwise.
  for (const errorText of [null, "Cancel", "Kernel failed"]) {
    const outcome = classifyPickOutcome({ finishCalled: true, lateFinish: false, settle: "rejected", errorText, errorName: null, undoDeltaAtReturn: 0, undoDeltaAfterSettle: 0, ourActive: false, foreignActive: null, cancel: "ok", cleanup: "ok", bodyChanged: false, geometry: null });
    assert.notEqual(outcome.kind, "rejected-unchanged", String(errorText));
  }
  assert.ok(PICK_OUTCOME_TABLE.length > 0);
  assert.match(SURFACE_ALIGN_DRIVE, /factory\.setContinuityForEdge\(pairOf\(driveArgs\.referenceEdgeId\), continuity\);\s*await factory\.update\(\);\s*dialog\.finish\(\);/);
});

test("a drive that outlives its budget stops before touching the factory (no continuity set, no update, no finish)", async () => {
  const f = fixture("never-ready");
  await assert.rejects(align(f, { dialogMs: 1000, finishMs: 40, cancelMs: 1000 }));
  // Let the abandoned drive step run on; it must see that the helper stopped waiting.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(f.seen.perEdge, undefined);
  assert.equal(f.seen.dialog!.finished, 0);
  assert.match(SURFACE_ALIGN_DRIVE, /open\(\)/);
});

test("no cancel is ever sent while the command is not Awaiting: a computing command is left running and the outcome is undetermined", async () => {
  const f = fixture("computing");
  await assert.rejects(align(f, { dialogMs: 1000, finishMs: 40, cancelMs: 200 }), /reconcile/);
  assert.equal(f.seen.cancelled, 0);
  assert.equal(f.isUncertain(), true);
  const mutate = f.calls.find((call) => call.kind === "mutate")!;
  assert.equal((mutate.values[0] as { cancelOnlyWhenAwaiting?: boolean }).cancelOnlyWhenAwaiting, true);
  assert.equal((mutate.values[0] as { restoreSelection?: boolean }).restoreSelection, true);
});

test("A2: a factory still updating under an Awaiting command is never cancelled: left running, undetermined", async () => {
  const f = fixture("updating");
  await assert.rejects(align(f, { dialogMs: 1000, finishMs: 60, cancelMs: 200 }), (error: Error) => { assert.match(error.message, /reconcile/); assert.match(error.message, /factory state updating/); return true; });
  assert.equal(f.seen.dialog!.finished, 0);
  assert.equal(f.seen.cancelled, 0);
  assert.equal(f.isUncertain(), true);
});

test("A2: after finish() the command still reads Awaiting while the commit runs: no cancel is sent then either", async () => {
  const f = fixture("hang-after-finish");
  await assert.rejects(align(f, { dialogMs: 1000, finishMs: 150, cancelMs: 200, settleMs: 50 }), (error: Error) => { assert.match(error.message, /reconcile/); assert.match(error.message, /after finish\(\)/); return true; });
  assert.equal(f.seen.cancelled, 0);
  assert.equal(f.isUncertain(), true);
});

test("a stall after finish() is not cancelled while the commit computes (state not Awaiting)", async () => {
  const f = fixture("hang-after-finish");
  await assert.rejects(align(f, { dialogMs: 1000, finishMs: 150, cancelMs: 200, settleMs: 50 }), /reconcile/);
  assert.equal(f.seen.dialog!.finished, 1);
  assert.equal(f.seen.cancelled, 0);
  assert.equal(f.isUncertain(), true);
});

test("the user's selection is put back after a verified align and after a refusal in update()", async () => {
  const ok = fixture("commit");
  await align(ok);
  assert.deepEqual([...ok.userFaces], [ok.userFace]);
  const refused = fixture("update-throws");
  await assert.rejects(align(refused));
  assert.deepEqual([...refused.userFaces], [refused.userFace]);
});
