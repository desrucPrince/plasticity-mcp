import assert from "node:assert/strict";
import { test } from "node:test";
import { PICK_COMMAND_CDP_MARGIN_MS, PICK_COMMAND_TIMEOUTS, PlasticityOperations, type PickCommandTimeouts } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

// Executes the source setDrivingDistance hands to the runtime (the generic runPickCommand source plus the driving
// distance drive step) against a stub editor with a fake executor, command, dialog and SelectionHitsSession. The
// fake command behaves like DimensionDistanceCommand in discovery/probes-2026-11-pick/FINDINGS.md: it reads the
// selection and the click point, opens a dialog, and commits one Undo step on finish().

type Scenario = "commit" | "reject" | "hang" | "no-dialog" | "cancel-ignored" | "drive-throws" | "commit-fails";

class Vector3 {
  x: number; y: number; z: number;
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  toArray() { return [this.x, this.y, this.z]; }
}

class FakeDialog {
  finished = 0;
  onFinish: () => void = () => {};
  params: Record<string, unknown>;
  constructor(params: Record<string, unknown>) { this.params = params; }
  finish() { this.finished += 1; this.onFinish(); }
}

const FACE_IDS = ["fxp", "fxn", "fyp", "fz", "fcyl"];
const FACES = [
  { id: "fxp", surfaceType: "Plane", planar: true, centerMm: [2020, 5, 2.5], normal: [1, 0, 0] },
  { id: "fxn", surfaceType: "Plane", planar: true, centerMm: [2000, 5, 2.5], normal: [-1, 0, 0] },
  { id: "fyp", surfaceType: "Plane", planar: true, centerMm: [2010, 10, 2.5], normal: [0, 1, 0] },
  { id: "fz", surfaceType: "Plane", planar: true, centerMm: [2010, 5, 5], normal: [0, 0, 1] },
  { id: "fcyl", surfaceType: "Cylinder", planar: false, centerMm: [2030, 5, 2.5], normal: [1, 0, 0] },
];

function fixture(scenario: Scenario = "commit", options: { busy?: boolean; active?: boolean } = {}) {
  const state = {
    targetId: "window", title: "Driving distance", documentToken: "document", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0,
    construction: { planes: [], activePlaneId: "standard:top", planeStateToken: "planes", viewStateToken: "view" },
    regions: [],
    bodies: [
      { id: 5, versionId: 105, type: "Solid", name: null, boundsMm: null, faceIds: [...FACE_IDS], edgeIds: [], faces: FACES.map((face) => ({ ...face, edgeIds: [] })), edges: [] },
      { id: 6, versionId: 106, type: "Solid", name: null, boundsMm: null, faceIds: ["other"], edgeIds: [], faces: [{ id: "other", surfaceType: "Plane", planar: true, centerMm: [0, 0, 0], normal: [1, 0, 0] }], edges: [] },
      { id: 7, versionId: 107, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
    ],
    measurements: [],
  } as unknown as RuntimeState;

  const faceViews = new Map(FACE_IDS.map((id) => [id, { face: id, parentBody: 5 }]));
  const view = { constructor: { name: "Solid" }, high: { faces: { versionIds: FACE_IDS, get: (index: number) => faceViews.get(FACE_IDS[index]!) }, edges: { versionIds: [] } } };
  const geometryModel = new Map<number, { view: unknown }>([[105, { view }]]);

  // What the fake command saw when it ran, and how the session ended.
  const seen: { selection?: unknown[]; hits?: Array<{ item: unknown; point: number[]; normal: number[] | undefined }>; dialog?: FakeDialog; cancelled: number } = { cancelled: 0 };
  const sceneObjects: unknown[] = [];
  const selectedFaces = new Set<unknown>();
  const hits = new Map<unknown, { point: Vector3; normal: Vector3 | undefined }>();
  const undoStack: unknown[] = [];

  let commandSeq = 0;
  class DimensionDistanceCommand {
    remember = true;
    seq = ++commandSeq;
    private rejectRun: ((error: Error) => void) | undefined;
    editor: unknown;
    constructor(editor: unknown) { this.editor = editor; }
    cancel() { this.rejectRun?.(new Error("Cancelled")); }
    async execute(): Promise<unknown> {
      seen.selection = [...selectedFaces];
      seen.hits = [...hits].map(([item, hit]) => ({ item, point: hit.point.toArray(), normal: hit.normal?.toArray() }));
      if (scenario === "reject") throw new Error("Operation has no effect");
      return await new Promise((resolve, reject) => {
        this.rejectRun = (error) => { sceneObjects.length = 0; reject(error); };
        if (scenario === "no-dialog") return;
        const dialog = new FakeDialog({ refDistance: 0.019999999999999796, distance: 0.02, clickPoint: hits.values().next().value?.point });
        seen.dialog = dialog;
        if (scenario === "drive-throws") Object.defineProperty(dialog.params, "distance", { set() { throw new Error("read-only distance"); } });
        dialog.onFinish = () => {
          if (scenario === "hang" || scenario === "cancel-ignored") return;
          sceneObjects.length = 0;
          if (scenario === "commit-fails") { reject(new Error("Kernel failed")); return; }
          undoStack.push({ distance: dialog.params.distance });
          resolve(undefined);
        };
        sceneObjects.push({ unrelated: true }, dialog);
      });
    }
  }

  const executor = {
    isBusy: options.busy ?? false,
    active: (options.active ? { command: { constructor: { name: "PushFaceCommand" } } } : null) as { command: { cancel?: () => void; constructor: { name: string } } } | null,
    cancelActiveCommand() {
      seen.cancelled += 1;
      if (scenario === "cancel-ignored") return;
      this.active?.command.cancel?.();
    },
  };
  const editor = {
    geo: { read: { geometryModel, automatics: new Set<number>() }, lookupStableId(version: number) { return version - 100; } },
    db: { version: 1, commit() { return undefined; } },
    executor,
    history: { undoStack },
    helpers: { scene: { traverse(visit: (object: unknown) => void) { for (const object of [...sceneObjects]) visit(object); } } },
    selection: {
      selected: { faces: selectedFaces, add(item: unknown) { selectedFaces.add(item); }, removeAll() { selectedFaces.clear(); } },
      hits: {
        hits,
        record(item: unknown, point: Vector3, normal?: Vector3) { hits.set(item, { point, normal }); },
        clear() { hits.clear(); },
      },
    },
    // Like Plasticity's executor: the command is active while it runs, and faces still selected when execute()
    // returns start the default PushFace chain, which stays active.
    async exec(command: DimensionDistanceCommand) {
      executor.active = { command };
      try {
        await command.execute();
      } finally {
        executor.active = null;
      }
      if (selectedFaces.size > 0) executor.active = { command: { constructor: { name: "PushFaceCommand" } } };
    },
  };

  const calls: Array<{ source: string; bindings: string[]; values: unknown[]; timeoutMs: number | undefined }> = [];
  let uncertain = false;
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[], timeoutMs?: number) {
      calls.push({ source, bindings, values, timeoutMs });
      const native = Function(`return (${source})`)();
      const bound = bindings.map((name) => ({ DimensionDistanceCommand, DimensionDistanceSpaceDialog: FakeDialog, Vector3 } as Record<string, unknown>)[name]);
      return await native.call(editor, ...bound, ...values);
    },
    async read() { throw new Error("unexpected read"); },
    isUncertain() { return uncertain; },
    markUncertain() { uncertain = true; },
  } as unknown as PlasticityRuntime;
  return {
    operations: new PlasticityOperations(runtime),
    calls, seen, executor, undoStack, selectedFaces, hits, faceViews, sceneObjects,
    isUncertain: () => uncertain,
  };
}

const FAST: PickCommandTimeouts = { dialogMs: 60, finishMs: 80, cancelMs: 60 };

function assertCleanEnd(f: ReturnType<typeof fixture>) {
  assert.equal(f.executor.active, null, "no active command");
  assert.equal(f.selectedFaces.size, 0, "selection cleared");
  assert.equal(f.hits.size, 0, "hits cleared");
}

test("setDrivingDistance selects [reference, moving], seeds the hit on the moving face and finishes the dialog in meters", async () => {
  const f = fixture();
  const result = await f.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fxp", referenceFaceId: "fxn", distanceMm: 30 }, "r1");
  assert.equal(f.calls.length, 1, "one native call");
  assert.deepEqual(f.calls[0]!.bindings, ["DimensionDistanceCommand", "DimensionDistanceSpaceDialog", "Vector3"]);
  assert.deepEqual(f.seen.selection, [f.faceViews.get("fxn"), f.faceViews.get("fxp")], "selection order is [reference, moving]");
  assert.equal(f.seen.hits!.length, 1);
  assert.equal(f.seen.hits![0]!.item, f.faceViews.get("fxp"), "hit on the moving face");
  assert.deepEqual(f.seen.hits![0]!.point.map((value) => Math.round(value * 1e9) / 1e9), [2.02, 0.005, 0.0025], "moving face center in meters");
  assert.deepEqual(f.seen.hits![0]!.normal, [1, 0, 0], "outward normal of the moving face");
  assert.equal(f.seen.dialog!.params.distance, 0.03, "dialog distance in meters");
  assert.equal(f.seen.dialog!.finished, 1, "finish() called once");
  assert.equal(f.undoStack.length, 1);
  assert.equal(f.seen.cancelled, 0);
  assertCleanEnd(f);
  assert.equal(result.previousDistanceMm, 20, "refDistance converted to mm without float noise");
  assert.equal(result.distanceMm, 30);
  assert.equal(result.undoSteps, 1);
  assert.equal(result.state.revision, "r1");
  assert.equal(f.isUncertain(), false);
});

test("setDrivingDistance without a reference selects only the moving face", async () => {
  const f = fixture();
  await f.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fz", distanceMm: 12.5 }, "r1");
  assert.deepEqual(f.seen.selection, [f.faceViews.get("fz")]);
  assert.equal(f.seen.hits![0]!.item, f.faceViews.get("fz"));
  assert.deepEqual(f.seen.hits![0]!.normal, [0, 0, 1]);
  assert.equal(f.seen.dialog!.params.distance, 0.0125);
  assertCleanEnd(f);
});

test("runPickCommand clears the selection inside execute so no default PushFace command chains", async () => {
  const f = fixture();
  await f.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fxp", referenceFaceId: "fxn", distanceMm: 30 }, "r1");
  // The fake exec starts a PushFace chain when faces are still selected after execute(); none started.
  assert.equal(f.executor.active, null);
});

test("the CDP timeout of the single mutate call outlives every internal wait by at least 5 s", async () => {
  const f = fixture();
  await f.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fxp", referenceFaceId: "fxn", distanceMm: 30 }, "r1");
  const { timeoutMs, values } = f.calls[0]!;
  const timeouts = (values[0] as { timeouts: PickCommandTimeouts }).timeouts;
  assert.deepEqual(timeouts, { ...PICK_COMMAND_TIMEOUTS });
  assert.ok(PICK_COMMAND_CDP_MARGIN_MS >= 5_000);
  assert.ok(timeoutMs! >= timeouts.dialogMs + timeouts.finishMs + timeouts.cancelMs + 5_000, `CDP timeout ${timeoutMs}`);
  const g = fixture();
  await g.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fxp", distanceMm: 30 }, "r1", FAST);
  assert.equal(g.calls[0]!.timeoutMs, FAST.dialogMs + FAST.finishMs + FAST.cancelMs + PICK_COMMAND_CDP_MARGIN_MS);
});

test("a command that rejects before its dialog appears reports no effect and cleans up", async () => {
  const f = fixture("reject");
  await assert.rejects(
    f.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fxp", referenceFaceId: "fxn", distanceMm: 30 }, "r1", FAST),
    /^Error: Plasticity could not dimension these faces \(no effect\): Operation has no effect$/,
  );
  assert.equal(f.seen.dialog, undefined, "no dialog");
  assert.equal(f.seen.cancelled, 0, "nothing to cancel");
  assert.equal(f.undoStack.length, 0);
  assertCleanEnd(f);
  assert.equal(f.isUncertain(), false);
});

test("a dialog that never finishes is cancelled in the same call: no commit, cleanup done, runtime stays certain", async () => {
  const f = fixture("hang");
  const started = Date.now();
  await assert.rejects(
    f.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fxp", referenceFaceId: "fxn", distanceMm: 30 }, "r1", FAST),
    (error: Error) => {
      assert.match(error.message, /did not finish within 80 ms \(finish phase\); Plasticity cancelled it and the document is unchanged/);
      assert.doesNotMatch(error.message, /timed?\s*out|uncertain/i, "the journal must not classify a certain cancel as unknown");
      return true;
    },
  );
  assert.ok(Date.now() - started < 2_000, "short injected timeouts keep the test fast");
  assert.equal(f.seen.dialog!.finished, 1, "the drive step called finish()");
  assert.equal(f.seen.cancelled, 1, "cancelActiveCommand called once");
  assert.equal(f.undoStack.length, 0, "no commit");
  assertCleanEnd(f);
  assert.equal(f.isUncertain(), false);
});

test("a command that never opens its dialog is cancelled after the dialog wait", async () => {
  const f = fixture("no-dialog");
  await assert.rejects(
    f.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fxp", distanceMm: 30 }, "r1", FAST),
    /did not finish within 60 ms \(dialog phase\); Plasticity cancelled it and the document is unchanged/,
  );
  assert.equal(f.seen.cancelled, 1);
  assert.equal(f.undoStack.length, 0);
  assertCleanEnd(f);
  assert.equal(f.isUncertain(), false);
});

test("a cancel that does not take marks the runtime uncertain for plasticity_reconcile", async () => {
  const f = fixture("cancel-ignored");
  await assert.rejects(
    f.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fxp", referenceFaceId: "fxn", distanceMm: 30 }, "r1", FAST),
    /could not cancel it \(still active: DimensionDistanceCommand\); the result is uncertain\. Call plasticity_reconcile/,
  );
  assert.equal(f.seen.cancelled, 1);
  assert.equal(f.isUncertain(), true);
  assert.equal(f.selectedFaces.size, 0, "selection cleared even when the cancel fails");
  assert.equal(f.hits.size, 0, "hits cleared even when the cancel fails");
});

test("a drive step that throws cancels the command and leaves the document unchanged", async () => {
  const f = fixture("drive-throws");
  await assert.rejects(
    f.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fxp", referenceFaceId: "fxn", distanceMm: 30 }, "r1", FAST),
    /\(drive phase\): read-only distance; Plasticity cancelled it/,
  );
  assert.equal(f.seen.dialog!.finished, 0);
  assert.equal(f.seen.cancelled, 1);
  assert.equal(f.undoStack.length, 0);
  assertCleanEnd(f);
  assert.equal(f.isUncertain(), false);
});

test("a commit that fails after finish() reports the failure without an Undo step", async () => {
  const f = fixture("commit-fails");
  await assert.rejects(
    f.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fxp", referenceFaceId: "fxn", distanceMm: 30 }, "r1", FAST),
    /^Error: Driving distance failed: Kernel failed; the document is unchanged$/,
  );
  assert.equal(f.seen.cancelled, 0);
  assertCleanEnd(f);
  assert.equal(f.isUncertain(), false);
});

test("runPickCommand refuses to start while a command is active or the executor is busy", async () => {
  for (const options of [{ active: true }, { busy: true }]) {
    const f = fixture("commit", options);
    f.selectedFaces.add("user selection");
    await assert.rejects(
      f.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fxp", referenceFaceId: "fxn", distanceMm: 30 }, "r1", FAST),
      options.active ? /Plasticity is busy \(PushFaceCommand is active\)/ : /Plasticity is busy/,
    );
    assert.equal(f.seen.selection, undefined, "the command never ran");
    assert.equal(f.seen.cancelled, 0, "a busy guard never cancels the user's command");
    assert.deepEqual([...f.selectedFaces], ["user selection"], "the guard leaves the selection alone");
    assert.equal(f.undoStack.length, 0);
    assert.equal(f.isUncertain(), false);
  }
});

test("setDrivingDistance validation failures make no native call", async () => {
  const cases: Array<[Record<string, unknown>, RegExp, string?]> = [
    [{ bodyId: 5, movingFaceId: "fxp", referenceFaceId: "fyp", distanceMm: 30 }, /must be parallel planes/],
    [{ bodyId: 5, movingFaceId: "fxp", referenceFaceId: "fz", distanceMm: 30 }, /must be parallel planes/],
    [{ bodyId: 5, movingFaceId: "fxp", referenceFaceId: "fxp", distanceMm: 30 }, /must differ/],
    [{ bodyId: 5, movingFaceId: "fcyl", distanceMm: 30 }, /moving face must be planar/],
    [{ bodyId: 5, movingFaceId: "fxp", referenceFaceId: "fcyl", distanceMm: 30 }, /reference face must be planar/],
    [{ bodyId: 5, movingFaceId: "other", distanceMm: 30 }, /Stale or unknown moving face: 5:other/],
    [{ bodyId: 5, movingFaceId: "fxp", referenceFaceId: "other", distanceMm: 30 }, /Stale or unknown reference face: 5:other/],
    [{ bodyId: 6, movingFaceId: "fxp", distanceMm: 30 }, /Stale or unknown moving face: 6:fxp/],
    [{ bodyId: 7, movingFaceId: "fxp", distanceMm: 30 }, /current Solid or Sheet body: 7/],
    [{ bodyId: 99, movingFaceId: "fxp", distanceMm: 30 }, /current Solid or Sheet body: 99/],
    [{ bodyId: 5, movingFaceId: "fxp", distanceMm: 0 }, /positive finite/],
    [{ bodyId: 5, movingFaceId: "fxp", distanceMm: -5 }, /positive finite/],
    [{ bodyId: 5, movingFaceId: "fxp", distanceMm: Number.NaN }, /positive finite/],
    [{ bodyId: 5, movingFaceId: "fxp", distanceMm: Number.POSITIVE_INFINITY }, /positive finite/],
    [{ bodyId: 5, movingFaceId: "fxp", distanceMm: 30 }, /Stale reference: expected revision r0/, "r0"],
  ];
  for (const [input, pattern, revision] of cases) {
    const f = fixture();
    await assert.rejects(f.operations.setDrivingDistance(input as never, revision ?? "r1"), pattern, JSON.stringify(input));
    assert.equal(f.calls.length, 0, `no native call for ${JSON.stringify(input)}`);
  }
});

test("setDrivingDistance rejects a coplanar parallel reference before any native call", async () => {
  const f = fixture();
  const body = (await (f.operations as unknown as { runtime: PlasticityRuntime }).runtime.getState()).bodies[0]!;
  body.faces.push({ id: "fxp2", surfaceType: "Plane", planar: true, centerMm: [2020, 9, 1], normal: [1, 0, 0] } as never);
  body.faceIds.push("fxp2");
  await assert.rejects(f.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fxp", referenceFaceId: "fxp2", distanceMm: 30 }, "r1"), /lie in the same plane/);
  assert.equal(f.calls.length, 0);
});

test("runPickCommand rejects nonpositive injected timeouts before any native call", async () => {
  const f = fixture();
  await assert.rejects(
    f.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fxp", distanceMm: 30 }, "r1", { dialogMs: 0, finishMs: 10, cancelMs: 10 }),
    /dialogMs must be a positive whole number/,
  );
  assert.equal(f.calls.length, 0);
});

test("the pick-command source is generic: the command, the dialog and the drive step are parameters", async () => {
  const f = fixture();
  await f.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fxp", referenceFaceId: "fxn", distanceMm: 30 }, "r1");
  const source = f.calls[0]!.source;
  assert.doesNotMatch(source, /DimensionDistance/, "no command or dialog name is baked into the native source");
  assert.match(source, /params\.distance = driveArgs\.distanceM/, "the drive step is spliced in");
  assert.match(source, /const nativeApi = /, "tagged with nativeFunction");
  const values = f.calls[0]!.values[0] as { select: unknown[]; hits: unknown[]; driveArgs: unknown };
  assert.deepEqual(values.select, [{ kind: "face", bodyId: 5, id: "fxn" }, { kind: "face", bodyId: 5, id: "fxp" }]);
  assert.deepEqual(values.driveArgs, { distanceM: 0.03 });
});
