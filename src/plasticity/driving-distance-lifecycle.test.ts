import assert from "node:assert/strict";
import { test } from "node:test";
import { SELECT_STORE_BINDINGS } from "./native-discovery.ts";
import { PlasticityOperations, type PickCommandTimeouts } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

// Lifecycle tests for runPickCommand / setDrivingDistance (review of aff5fb3). The fake runs the real generated
// renderer source against a stub editor. Unlike driving-distance.test.ts, the executor can run in the mode
// Plasticity 26.1.3 really has: exec() RESOLVES even when execute() throws (prove-driving-distance.json trials 9
// and 11: execError set, execRejected null). Failure scenarios cover throwing cancels, foreign active commands,
// undo-delta guards, the post-commit read-back and the no-op paths.

type Scenario =
  | "commit" | "reject" | "hang" | "slow-commit" | "commit-fails" | "finish-no-effect" | "drive-throws"
  | "commit-noop" | "commit-noop-body-changed" | "commit-two-steps" | "commit-wrong-face" | "commit-nothing-moves";

interface Options {
  executor?: "rejecting" | "swallowing";
  cancel?: "normal" | "throws" | "ignored";
  /** After our command commits, a different command becomes active (the 'chained' branch). */
  foreignAfterCommit?: boolean;
  /** While our dialog hangs, a different command becomes the active one. */
  foreignDuringHang?: boolean;
  /** helpers.scene.traverse throws once the command has started (started-then-catch path). */
  traverseThrows?: boolean;
  /** selection.hits.clear throws on its second call (the cleanup after the command started). */
  cleanupThrows?: boolean;
  /** refDistance the fake dialog reports, in meters. */
  refDistanceM?: number;
  /** Kernel GetAnyPointOn per face id, in mm; defaults to the face centre. */
  anyPointMm?: Record<string, [number, number, number]>;
  /** Replace the native result (for Node-side guards). */
  nativeOverride?: unknown;
  /** Extra faces on body 5. */
  extraFaces?: Face[];
}

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

type Face = { id: string; surfaceType: string; planar: boolean; centerMm: [number, number, number]; normal: [number, number, number]; edgeIds: string[] };
const baseFaces = (): Face[] => [
  { id: "fxp", surfaceType: "Plane", planar: true, centerMm: [2020, 5, 2.5], normal: [1, 0, 0], edgeIds: [] },
  { id: "fxn", surfaceType: "Plane", planar: true, centerMm: [2000, 5, 2.5], normal: [-1, 0, 0], edgeIds: [] },
  { id: "fyp", surfaceType: "Plane", planar: true, centerMm: [2010, 10, 2.5], normal: [0, 1, 0], edgeIds: [] },
  { id: "fz", surfaceType: "Plane", planar: true, centerMm: [2010, 5, 5], normal: [0, 0, 1], edgeIds: [] },
  { id: "fzn", surfaceType: "Plane", planar: true, centerMm: [2010, 5, 0], normal: [0, 0, -1], edgeIds: [] },
];

function fixture(scenario: Scenario = "commit", options: Options = {}) {
  const faces = [...baseFaces(), ...(options.extraFaces ?? [])];
  const FACE_IDS = faces.map((face) => face.id);
  const body = { id: 5, versionId: 105, type: "Solid", name: null, boundsMm: null, faceIds: [...FACE_IDS], edgeIds: [], faces, edges: [] };
  const state = {
    targetId: "window", title: "Driving distance lifecycle", documentToken: "document", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0,
    construction: { planes: [], activePlaneId: "standard:top", planeStateToken: "planes", viewStateToken: "view" },
    regions: [], bodies: [body], measurements: [],
  } as unknown as RuntimeState;

  const faceViews = new Map(FACE_IDS.map((id, index) => [id, { face: id, entityId: 700 + index }]));
  const view = { constructor: { name: "Solid" }, high: { faces: { versionIds: FACE_IDS, get: (index: number) => faceViews.get(FACE_IDS[index]!) }, edges: { versionIds: [] } } };
  const kernelFaces = FACE_IDS.map((id, index) => ({
    Id: () => 700 + index,
    GetAnyPointOn: () => {
      const point = options.anyPointMm?.[id] ?? faces.find((face) => face.id === id)!.centerMm;
      return { position: { x: point[0] / 1000, y: point[1] / 1000, z: point[2] / 1000 } };
    },
  }));
  const geometryModel = new Map<number, { view: unknown; model: unknown }>([[105, { view, model: { GetFaces: () => ({ Size: () => kernelFaces.length, Get: (index: number) => kernelFaces[index] }) } }]]);

  const seen: { selection?: unknown[]; hits?: Array<{ item: unknown; point: number[]; normal: number[] | undefined }>; dialog?: FakeDialog; cancelled: number } = { cancelled: 0 };
  const sceneObjects: unknown[] = [];
  const selectedFaces = new Set<unknown>();
  const hits = new Map<unknown, { point: Vector3; normal: Vector3 | undefined }>();
  const undoStack: unknown[] = [];
  const refDistanceM = options.refDistanceM ?? 0.02;
  const foreign = { constructor: { name: "ForeignCommand" } };
  let clearCalls = 0;

  // Moves a face of the fake body along its normal by deltaMm and bumps the body version, like a commit.
  const moveFace = (id: string | undefined, deltaMm: number) => {
    const face = faces.find((candidate) => candidate.id === id);
    if (face) face.centerMm = face.centerMm.map((value, axis) => value + face.normal[axis]! * deltaMm) as [number, number, number];
    body.versionId += 1;
  };

  class DimensionDistanceCommand {
    remember = true;
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
        const hit = hits.values().next().value?.point as Vector3 | undefined;
        const normal = hits.values().next().value?.normal as Vector3 | undefined;
        const to = hit && normal ? new Vector3(hit.x - normal.x * refDistanceM, hit.y - normal.y * refDistanceM, hit.z - normal.z * refDistanceM) : undefined;
        const dialog = new FakeDialog({ refDistance: refDistanceM, distance: refDistanceM, clickPoint: hit, to });
        seen.dialog = dialog;
        if (scenario === "drive-throws") Object.defineProperty(dialog.params, "distance", { set() { throw new Error("read-only distance"); } });
        const selectedIds = () => (seen.selection as Array<{ face: string }>).map((entry) => entry.face);
        const commit = () => {
          sceneObjects.length = 0;
          const change = ((dialog.params.distance as number) - refDistanceM) * 1000;
          if (scenario === "commit-fails") { reject(new Error("Kernel failed")); return; }
          if (scenario === "finish-no-effect") { reject(new Error("Operation has no effect")); return; }
          if (scenario === "commit-noop") { resolve(undefined); return; }
          if (scenario === "commit-noop-body-changed") { body.versionId += 1; resolve(undefined); return; }
          undoStack.push({ distance: dialog.params.distance });
          if (scenario === "commit-two-steps") undoStack.push({ selection: true });
          if (scenario === "commit-wrong-face") moveFace(selectedIds()[0], change);
          else if (scenario === "commit-nothing-moves") body.versionId += 1;
          else moveFace(selectedIds().at(-1), change);
          resolve(undefined);
        };
        dialog.onFinish = () => {
          if (scenario === "hang") {
            if (options.foreignDuringHang) executor.active = { command: foreign };
            return;
          }
          if (scenario === "slow-commit") { setTimeout(commit, 400); return; }
          commit();
        };
        sceneObjects.push({ unrelated: true }, dialog);
      });
    }
  }

  const executor = {
    isBusy: false,
    active: null as { command: { cancel?: () => void; constructor: { name: string } } } | null,
    cancelActiveCommand() {
      seen.cancelled += 1;
      if (options.cancel === "throws") throw new Error("cancel exploded");
      if (options.cancel === "ignored") return;
      this.active?.command.cancel?.();
    },
  };
  let started = false;
  const editor = {
    geo: { read: { geometryModel, automatics: new Set<number>() }, lookupStableId(version: number) { return version - 100; } },
    db: { version: 1, commit() { return undefined; } },
    executor,
    history: { undoStack },
    helpers: { scene: { traverse(visit: (object: unknown) => void) {
      if (options.traverseThrows && started) throw new Error("traverse exploded");
      for (const object of [...sceneObjects]) visit(object);
    } } },
    selection: {
      selected: { faces: selectedFaces, add(item: unknown) { selectedFaces.add(item); }, removeAll() { selectedFaces.clear(); } },
      hits: {
        hits,
        record(item: unknown, point: Vector3, normal?: Vector3) { hits.set(item, { point, normal }); },
        clear() { clearCalls += 1; if (options.cleanupThrows && clearCalls > 1) throw new Error("hits.clear exploded"); hits.clear(); },
      },
    },
    // Rejecting mode: exec() rejects with the execute() error. Swallowing mode (the real 26.1.3 executor):
    // exec() resolves anyway. The command is active while it runs; leftover selected faces start PushFace.
    async exec(command: DimensionDistanceCommand) {
      started = true;
      executor.active = { command };
      try {
        await command.execute();
      } catch (error) {
        if (options.executor !== "swallowing") throw error;
      } finally {
        if (executor.active?.command === command) executor.active = null;
      }
      if (selectedFaces.size > 0) executor.active = { command: { constructor: { name: "PushFaceCommand" } } };
      if (options.foreignAfterCommit) executor.active = { command: foreign };
    },
  };

  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  let uncertain = false;
  const runtime = {
    async getState() { return structuredClone(state); },
    async mutate(source: string, bindings: string[], values: unknown[]) {
      calls.push({ source, bindings, values });
      if (Object.hasOwn(options, "nativeOverride")) return options.nativeOverride;
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
    calls, seen, executor, undoStack, selectedFaces, hits, faceViews, faces, foreign,
    isUncertain: () => uncertain,
  };
}

const FAST: PickCommandTimeouts = { dialogMs: 60, finishMs: 80, cancelMs: 60 };
const PAIR = { bodyId: 5, movingFaceId: "fxp", referenceFaceId: "fxn", distanceMm: 30 };
const RECONCILE = /the result is uncertain\. Call plasticity_reconcile before any other edit/;

function assertCleanEnd(f: ReturnType<typeof fixture>) {
  assert.equal(f.executor.active, null, "no active command");
  assert.equal(f.selectedFaces.size, 0, "selection cleared");
  assert.equal(f.hits.size, 0, "hits cleared");
}

// ---- item 1: a throwing cancel never escapes the native function

test("a hang plus a throwing cancel marks the runtime uncertain and names plasticity_reconcile", async () => {
  const f = fixture("hang", { cancel: "throws" });
  await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), (error: Error) => {
    assert.match(error.message, /could not cancel it \(still active: DimensionDistanceCommand\)/);
    assert.match(error.message, RECONCILE);
    assert.match(error.message, /Cancel error: cancel exploded/);
    return true;
  });
  assert.equal(f.seen.cancelled, 1, "cancelActiveCommand ran once and threw");
  assert.equal(f.isUncertain(), true);
  assert.equal(f.selectedFaces.size, 0, "selection cleared even when the cancel throws");
  assert.equal(f.hits.size, 0, "hits cleared even when the cancel throws");
});

test("a slow commit plus a throwing cancel marks the runtime uncertain: the commit may still land", async () => {
  for (const executor of ["rejecting", "swallowing"] as const) {
    const f = fixture("slow-commit", { cancel: "throws", executor });
    await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), RECONCILE);
    assert.equal(f.isUncertain(), true, executor);
    assert.equal(f.seen.dialog!.finished, 1);
    assert.equal(f.undoStack.length, 0, "nothing committed yet when Node returns");
  }
});

test("started-then-catch: an unexpected error after the start cancels our command and reports a certain failure", async () => {
  const f = fixture("hang", { traverseThrows: true });
  await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), /^Error: Driving distance failed: traverse exploded; the document is unchanged$/);
  assert.equal(f.seen.cancelled, 1);
  assertCleanEnd(f);
  assert.equal(f.isUncertain(), false);
});

test("started-then-catch with a throwing cancel is uncertain, not a plain failure", async () => {
  const f = fixture("hang", { traverseThrows: true, cancel: "throws" });
  await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), RECONCILE);
  assert.equal(f.isUncertain(), true);
});

test("a cleanup that throws after the start marks the runtime uncertain", async () => {
  const f = fixture("commit", { cleanupThrows: true });
  await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), /undetermined state \(cleanup failed: hits\.clear exploded\)/);
  assert.equal(f.isUncertain(), true);
});

// ---- item 2: the real executor swallows execute() errors

test("swallowing executor: an early rejection carries the native reason after the required prefix", async () => {
  const f = fixture("reject", { executor: "swallowing" });
  await assert.rejects(
    f.operations.setDrivingDistance(PAIR, "r1", FAST),
    /^Error: Plasticity could not dimension these faces \(no effect\): Operation has no effect$/,
  );
  assert.equal(f.seen.cancelled, 0);
  assert.equal(f.undoStack.length, 0);
  assertCleanEnd(f);
  assert.equal(f.isUncertain(), false);
});

test("swallowing executor: a commit that fails after finish() reports that failure, not an Undo count", async () => {
  const f = fixture("commit-fails", { executor: "swallowing" });
  await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), /^Error: Driving distance failed: Kernel failed; the document is unchanged$/);
  assert.equal(f.seen.dialog!.finished, 1);
  assertCleanEnd(f);
  assert.equal(f.isUncertain(), false);
});

test("swallowing executor: a hang is cancelled and the Cancel error is not read as a failure", async () => {
  const f = fixture("hang", { executor: "swallowing" });
  await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), /did not finish within 80 ms \(finish phase\); Plasticity cancelled it and the document is unchanged/);
  assertCleanEnd(f);
  assert.equal(f.isUncertain(), false);
});

test("swallowing executor: a normal commit still succeeds and is read back", async () => {
  const f = fixture("commit", { executor: "swallowing" });
  const result = await f.operations.setDrivingDistance(PAIR, "r1", FAST);
  assert.equal(result.changed, true);
  assert.equal(result.undoSteps, 1);
  assert.equal(result.movedFaceId, "fxp");
  assert.equal(result.planeOffsetMm, 2030);
  assertCleanEnd(f);
});

// ---- item 3: undo deltas, no-ops and the equal-distance pre-check

test("a commit of two Undo steps marks the runtime uncertain", async () => {
  const f = fixture("commit-two-steps");
  await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), /committed 2 Undo steps instead of 1; the result is uncertain/);
  assert.equal(f.isUncertain(), true);
});

test("a commit with no Undo step but a changed body marks the runtime uncertain", async () => {
  const f = fixture("commit-noop-body-changed");
  await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), /committed no Undo step but body 5 changed; the result is uncertain/);
  assert.equal(f.isUncertain(), true);
});

test("a commit with no Undo step and an unchanged body is a clear no-op", async () => {
  const f = fixture("commit-noop", { refDistanceM: 0.012 });
  const result = await f.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fz", distanceMm: 12 }, "r1", FAST);
  assert.equal(result.changed, false);
  assert.equal(result.undoSteps, 0);
  assert.equal(result.movedFaceId, null);
  assert.match(result.message ?? "", /^distance already 12 mm/);
  assert.equal(f.isUncertain(), false);
});

test("single-face mode, equal distance: finish() gives no effect, reported as a no-op, not an error", async () => {
  const f = fixture("finish-no-effect", { executor: "swallowing", refDistanceM: 0.005 });
  const result = await f.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fz", distanceMm: 5 }, "r1", FAST);
  assert.equal(result.changed, false);
  assert.equal(result.undoSteps, 0);
  assert.equal(result.previousDistanceMm, 5);
  assert.match(result.message ?? "", /^distance already 5 mm; nothing changed$/);
  assertCleanEnd(f);
  assert.equal(f.isUncertain(), false);
});

test("single-face mode, a different distance that Plasticity refuses after finish() is a plain certain failure", async () => {
  const f = fixture("finish-no-effect", { executor: "swallowing", refDistanceM: 0.005 });
  await assert.rejects(f.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fz", distanceMm: 9 }, "r1", FAST), /^Error: Driving distance failed: Operation has no effect; the document is unchanged$/);
  assert.equal(f.isUncertain(), false);
});

test("with a reference face, an equal distance returns a no-op without any native call", async () => {
  for (const distanceMm of [20, 20 + 5e-7, 20 - 5e-7]) {
    const f = fixture();
    const result = await f.operations.setDrivingDistance({ ...PAIR, distanceMm }, "r1", FAST);
    assert.equal(f.calls.length, 0, `no native call for ${distanceMm}`);
    assert.equal(result.changed, false);
    assert.equal(result.undoSteps, 0);
    assert.equal(result.previousDistanceMm, 20);
    assert.equal(result.planeOffsetMm, 2020);
    assert.match(result.message ?? "", /^distance already 20 mm/);
  }
  const g = fixture();
  await g.operations.setDrivingDistance({ ...PAIR, distanceMm: 20.00001 }, "r1", FAST);
  assert.equal(g.calls.length, 1, "a change above 1e-6 mm runs the command");
});

test("Node-side guards: no outcome, an unknown outcome and a non-commit that changed the Undo history are uncertain", async () => {
  const base = { error: null, drive: null, driveThrew: false, settled: true, ourActive: false, foreignActive: null, cancelError: null, cleanupError: null, end: null, phase: null };
  const cases: Array<[unknown, RegExp]> = [
    [null, /returned no outcome; the result is uncertain/],
    [{ undoDelta: 0 }, /returned no outcome; the result is uncertain/],
    [{ ...base, outcome: "undetermined", undoDelta: 0 }, /undetermined state/],
    [{ ...base, outcome: "cancelled", undoDelta: 1, phase: "finish" }, /ended as cancelled but changed the Undo history by 1; the result is uncertain/],
    [{ ...base, outcome: "rejected", undoDelta: -1 }, /ended as rejected but changed the Undo history by -1/],
    [{ ...base, outcome: "committed", undoDelta: 3 }, /committed 3 Undo steps instead of 1; the result is uncertain/],
    [{ ...base, outcome: "committed", undoDelta: 1, settled: false }, /never settled/],
    [{ ...base, outcome: "committed", undoDelta: 1, ourActive: true, end: { activeCommand: "DimensionDistanceCommand", selectedCount: 0, hitCount: 0, spaceInputFocused: false } }, /still active: DimensionDistanceCommand/],
    [{ ...base, outcome: "surprise", undoDelta: 0 }, /unknown outcome surprise/],
  ];
  for (const [nativeOverride, pattern] of cases) {
    const f = fixture("commit", { nativeOverride });
    await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), pattern, JSON.stringify(nativeOverride));
    assert.equal(f.isUncertain(), true, JSON.stringify(nativeOverride));
  }
});

// ---- item 4: post-commit read-back

test("a successful commit returns the moved face and its new plane offset, single-face mode included", async () => {
  const f = fixture();
  const result = await f.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fz", distanceMm: 12 }, "r1", FAST);
  assert.equal(result.changed, true);
  assert.equal(result.movedFaceId, "fz");
  assert.equal(result.planeOffsetMm, 12 - 20 + 5, "moved by distance - refDistance along +z");
  const g = fixture("commit", { refDistanceM: 0.005 });
  const single = await g.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fz", distanceMm: 12 }, "r1", FAST);
  assert.equal(single.planeOffsetMm, 12, "reference point `to` sits on the -z plane at z 0");
  assert.equal(single.previousDistanceMm, 5);
});

test("a commit that moves the reference instead of the moving face marks the runtime uncertain and says what moved", async () => {
  const f = fixture("commit-wrong-face");
  await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), (error: Error) => {
    assert.match(error.message, /read-back does not match: no face moved to 2030 mm/);
    assert.match(error.message, /planes now: fxp@2020, fxn@1990/);
    assert.match(error.message, RECONCILE);
    return true;
  });
  assert.equal(f.isUncertain(), true);
});

test("a commit after which no plane moved marks the runtime uncertain", async () => {
  const f = fixture("commit-nothing-moves");
  await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), /no face moved to 2030 mm/);
  assert.equal(f.isUncertain(), true);
});

// ---- item 6: only OUR command is ever cancelled

test("the chained branch: a different command active after our commit is never cancelled and never reported as ours", async () => {
  const f = fixture("commit", { foreignAfterCommit: true });
  const result = await f.operations.setDrivingDistance(PAIR, "r1", FAST);
  assert.equal(f.seen.cancelled, 0, "the foreign command was not cancelled");
  assert.equal(f.executor.active?.command, f.foreign, "the foreign command is still active");
  assert.equal(result.changed, true);
  assert.match(result.warning ?? "", /ForeignCommand.*not part of this edit and was left alone/);
  assert.equal(f.isUncertain(), false);
});

test("a hang while a different command became active: the foreign command is not cancelled; ours is uncertain", async () => {
  const f = fixture("hang", { foreignDuringHang: true });
  await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), (error: Error) => {
    assert.match(error.message, /still active: ForeignCommand/);
    assert.match(error.message, RECONCILE);
    return true;
  });
  assert.equal(f.seen.cancelled, 0, "cancelActiveCommand was never called on the foreign command");
  assert.equal(f.executor.active?.command, f.foreign);
  assert.equal(f.isUncertain(), true);
});

// ---- items 7 and 8

test("the hit is the kernel's own point on the moving face, not the face midpoint", async () => {
  const f = fixture("commit", { anyPointMm: { fxp: [2020, 2.25, 4.5] } });
  await f.operations.setDrivingDistance(PAIR, "r1", FAST);
  assert.deepEqual(f.seen.hits![0]!.point.map((value) => Math.round(value * 1e9) / 1e9), [2.02, 0.00225, 0.0045]);
  assert.deepEqual(f.seen.hits![0]!.normal, [1, 0, 0]);
  assert.equal(f.seen.hits![0]!.item, f.faceViews.get("fxp"));
});

test("a drive step that throws does not read as a timeout", async () => {
  for (const executor of ["rejecting", "swallowing"] as const) {
    const f = fixture("drive-throws", { executor });
    await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), (error: Error) => {
      assert.match(error.message, /^Driving distance drive step threw \(drive phase\): read-only distance; Plasticity cancelled it and the document is unchanged$/);
      assert.doesNotMatch(error.message, /did not finish within/);
      return true;
    });
    assertCleanEnd(f);
  }
});

test("a same-direction pair (stepped faces) is allowed and moves the last selected face", async () => {
  // fz (+z at z 5) and a second +z face at z 0 stand in for a stepped block.
  const f = fixture("commit", { refDistanceM: 0.005, extraFaces: [{ id: "fstep", surfaceType: "Plane", planar: true, centerMm: [2030, 5, 0], normal: [0, 0, 1], edgeIds: [] }] });
  const result = await f.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fz", referenceFaceId: "fstep", distanceMm: 8 }, "r1", FAST);
  assert.deepEqual(f.seen.selection, [f.faceViews.get("fstep"), f.faceViews.get("fz")], "selection order is [reference, moving]");
  assert.equal(result.changed, true);
  assert.equal(result.planeOffsetMm, 8);
  assert.equal(result.movedFaceId, "fz");
});

test("the selection and hits are always clear and no command of ours is active after a certain outcome", async () => {
  const certain: Array<[Scenario, Options]> = [
    ["commit", {}], ["reject", { executor: "swallowing" }], ["hang", {}], ["commit-fails", { executor: "swallowing" }],
    ["drive-throws", {}], ["commit-noop", {}], ["finish-no-effect", { executor: "swallowing", refDistanceM: 0.03 }],
  ];
  for (const [scenario, options] of certain) {
    const f = fixture(scenario, options);
    await f.operations.setDrivingDistance(PAIR, "r1", FAST).catch(() => undefined);
    assert.equal(f.isUncertain(), false, scenario);
    assertCleanEnd(f);
  }
});

// ---- item 5: the 26.2 store route binds the dialog class

test("the store-route binding selection binds DimensionDistanceSpaceDialog, which is neither a Factory nor a Command", () => {
  class ConstructionPlaneDatabase {}
  class Vector3 {}
  class Quaternion {}
  class Matrix4 {}
  class DimensionDistanceSpaceDialog {}
  class DimensionDistanceCommand {}
  class SomeOtherSpaceDialog {}
  const editor = { commands: {}, viewports: [{ camera: { position: new Vector3(), quaternion: new Quaternion(), matrixWorld: new Matrix4() } }] };
  const roots = { kernel: {}, enums: {} };
  const select = Function(`return (${SELECT_STORE_BINDINGS})`)() as (this: unknown[], editor: unknown, roots: unknown) => Record<string, unknown>;
  const result = select.call([ConstructionPlaneDatabase, DimensionDistanceSpaceDialog, DimensionDistanceCommand, SomeOtherSpaceDialog], editor, roots);
  assert.equal(result.DimensionDistanceSpaceDialog, DimensionDistanceSpaceDialog);
  assert.equal(result.DimensionDistanceCommand, DimensionDistanceCommand);
  assert.equal(result.SomeOtherSpaceDialog, undefined, "the extras list stays minimal");
  const ambiguous = select.call([ConstructionPlaneDatabase, DimensionDistanceSpaceDialog, class DimensionDistanceSpaceDialog {}], editor, roots);
  assert.equal(ambiguous.DimensionDistanceSpaceDialog, undefined, "an ambiguous dialog class is not bound, so the runtime reports it unavailable");
});
