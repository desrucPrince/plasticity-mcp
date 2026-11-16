import assert from "node:assert/strict";
import { test } from "node:test";
import { PICK_COMMAND_SETTLE_MS, PlasticityOperations, type PickCommandTimeouts } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

// Re-review of 61b054e, Part 1. The fake runs the real generated renderer source against a stub editor (the same
// model as driving-distance-lifecycle.test.ts) and adds the cases that review found:
// - item 1: a commit that lands after a cancel which followed finish(). Live on 26.1.3 a cancel after finish()
//   discarded the commit in every trial (discovery/probes-2026-11-followups/probe-late-commit.json), but that is one
//   build: the tool reports such a cancel as undetermined unless it sees the commit land in the settle window;
// - item 2: a commit with no Undo step that did not reach the requested distance;
// - item 3: a read-back that must see the moving face's own plane change;
// - item 5: foreign commands named in errors, early interruptions, and builds without Face.GetAnyPointOn.

type Scenario =
  | "commit" | "reject" | "hang" | "slow-commit" | "commit-fails" | "commit-noop" | "commit-nothing-moves"
  | "commit-other-face" | "commit-flush" | "commit-cross" | "interrupted" | "finish-throws" | "no-dialog";

interface Options {
  executor?: "rejecting" | "swallowing";
  cancel?: "normal" | "throws" | "ignored";
  /** Delay between finish() and the commit for "slow-commit" and "finish-throws". */
  commitDelayMs?: number;
  foreignAfterCommit?: boolean;
  refDistanceM?: number;
  extraFaces?: Face[];
  /** "commit-other-face": the face that moves instead of the moving face. */
  otherFaceId?: string;
  /** "commit-flush": the existing coplanar face the moving face merges into. */
  flushFaceId?: string;
  /** Kernel faces have no GetAnyPointOn (an older or newer Plasticity build). */
  noGetAnyPointOn?: boolean;
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

class Interrupt extends Error {}

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
    targetId: "window", title: "Driving distance late commit", documentToken: "document", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0,
    construction: { planes: [], activePlaneId: "standard:top", planeStateToken: "planes", viewStateToken: "view" },
    regions: [], bodies: [body], measurements: [],
  } as unknown as RuntimeState;

  const faceViews = new Map(FACE_IDS.map((id, index) => [id, { face: id, entityId: 700 + index }]));
  const view = { constructor: { name: "Solid" }, high: { faces: { versionIds: FACE_IDS, get: (index: number) => faceViews.get(FACE_IDS[index]!) }, edges: { versionIds: [] } } };
  const kernelFaces = FACE_IDS.map((id, index) => ({
    Id: () => 700 + index,
    ...(options.noGetAnyPointOn ? {} : {
      GetAnyPointOn: () => {
        const point = faces.find((face) => face.id === id)!.centerMm;
        return { position: { x: point[0] / 1000, y: point[1] / 1000, z: point[2] / 1000 } };
      },
    }),
  }));
  const geometryModel = new Map<number, { view: unknown; model: unknown }>([[105, { view, model: { GetFaces: () => ({ Size: () => kernelFaces.length, Get: (index: number) => kernelFaces[index] }) } }]]);

  const seen: { selection?: unknown[]; dialog?: FakeDialog; cancelled: number; committedAt?: number } = { cancelled: 0 };
  const sceneObjects: unknown[] = [];
  const selectedFaces = new Set<unknown>();
  const hits = new Map<unknown, { point: Vector3; normal: Vector3 | undefined }>();
  const undoStack: unknown[] = [];
  const refDistanceM = options.refDistanceM ?? 0.02;
  const foreign = { constructor: { name: "ForeignCommand" } };
  const userCommand = { constructor: { name: "UserBoxCommand" } };

  const moveFace = (id: string | undefined, deltaMm: number) => {
    const face = faces.find((candidate) => candidate.id === id);
    if (face) face.centerMm = face.centerMm.map((value, axis) => value + face.normal[axis]! * deltaMm) as [number, number, number];
  };

  class DimensionDistanceCommand {
    remember = true;
    private rejectRun: ((error: Error) => void) | undefined;
    editor: unknown;
    constructor(editor: unknown) { this.editor = editor; }
    cancel() { this.rejectRun?.(new Error("Cancelled")); }
    async execute(): Promise<unknown> {
      seen.selection = [...selectedFaces];
      if (scenario === "reject") throw new Error("Operation has no effect");
      if (scenario === "interrupted") {
        // A user command takes over before the dialog opens.
        executor.pending = userCommand;
        throw new Interrupt("Command interrupted");
      }
      return await new Promise((resolve, reject) => {
        this.rejectRun = (error) => { sceneObjects.length = 0; reject(error); };
        if (scenario === "no-dialog") return;
        const hit = hits.values().next().value?.point as Vector3 | undefined;
        const normal = hits.values().next().value?.normal as Vector3 | undefined;
        const to = hit && normal ? new Vector3(hit.x - normal.x * refDistanceM, hit.y - normal.y * refDistanceM, hit.z - normal.z * refDistanceM) : undefined;
        const dialog = new FakeDialog({ refDistance: refDistanceM, distance: refDistanceM, clickPoint: hit, to });
        seen.dialog = dialog;
        const selectedIds = () => (seen.selection as Array<{ face: string }>).map((entry) => entry.face);
        const commit = () => {
          sceneObjects.length = 0;
          seen.committedAt = Date.now();
          const change = ((dialog.params.distance as number) - refDistanceM) * 1000;
          if (scenario === "commit-fails") { reject(new Error("Kernel failed")); return; }
          if (scenario === "commit-noop") { resolve(undefined); return; }
          undoStack.push({ distance: dialog.params.distance });
          body.versionId += 1;
          const movingId = selectedIds().at(-1);
          if (scenario === "commit-nothing-moves") { /* the version changes, nothing moves */ }
          else if (scenario === "commit-other-face") {
            // Another face moves to where the moving face should have gone (or, for the reference, by the change).
            const other = faces.find((face) => face.id === options.otherFaceId)!;
            if (other.normal[0] > 0) other.centerMm = [2000 + (dialog.params.distance as number) * 1000, other.centerMm[1], other.centerMm[2]];
            else moveFace(options.otherFaceId, change);
          }
          else if (scenario === "commit-flush") {
            // The moving face reaches the coplanar face at the target and merges into it.
            const index = faces.findIndex((face) => face.id === movingId);
            faces.splice(index, 1);
            body.faceIds = faces.map((face) => face.id);
          } else if (scenario === "commit-cross") {
            // The moving face lands on the far side of the reference, distanceMm from it.
            const moving = faces.find((face) => face.id === movingId)!;
            moving.centerMm = [2000 - (dialog.params.distance as number) * 1000, moving.centerMm[1], moving.centerMm[2]];
          } else moveFace(movingId, change);
          resolve(undefined);
        };
        dialog.onFinish = () => {
          if (scenario === "hang") return;
          if (scenario === "slow-commit") { setTimeout(commit, options.commitDelayMs ?? 400); return; }
          if (scenario === "finish-throws") { setTimeout(commit, options.commitDelayMs ?? 400); throw new Error("finish exploded after starting the commit"); }
          commit();
        };
        sceneObjects.push({ unrelated: true }, dialog);
      });
    }
  }

  const executor = {
    isBusy: false,
    pending: null as { constructor: { name: string } } | null,
    active: null as { command: { cancel?: () => void; constructor: { name: string } } } | null,
    cancelActiveCommand() {
      seen.cancelled += 1;
      if (options.cancel === "throws") throw new Error("cancel exploded");
      if (options.cancel === "ignored") return;
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
    async exec(command: DimensionDistanceCommand) {
      executor.active = { command };
      try {
        await command.execute();
      } catch (error) {
        if (options.executor !== "swallowing") throw error;
      } finally {
        if (executor.active?.command === command) executor.active = null;
        if (executor.pending) { executor.active = { command: executor.pending }; executor.pending = null; }
      }
      if (options.foreignAfterCommit) executor.active = { command: foreign };
    },
  };

  const calls: Array<{ source: string; bindings: string[]; values: unknown[]; timeoutMs: number | undefined }> = [];
  let uncertain = false;
  const runtime = {
    async getState() { return structuredClone(state); },
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
    calls, seen, executor, undoStack, selectedFaces, hits, faces, foreign, body,
    isUncertain: () => uncertain,
  };
}

const FAST: PickCommandTimeouts = { dialogMs: 60, finishMs: 80, cancelMs: 60 };
const PAIR = { bodyId: 5, movingFaceId: "fxp", referenceFaceId: "fxn", distanceMm: 30 };
const RECONCILE = /the result is uncertain\. Call plasticity_reconcile before any other edit/;
// Round 4: a determinate mismatch (one clean Undo step, wrong geometry) is a CERTAIN error that names the undo.
const UNDO_RESTORES = /The document is in a known state at revision \S+: one Undo step was added, and plasticity_undo restores the previous geometry/;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function assertCleanEnd(f: ReturnType<typeof fixture>) {
  assert.equal(f.executor.active, null, "no active command");
  assert.equal(f.selectedFaces.size, 0, "selection cleared");
  assert.equal(f.hits.size, 0, "hits cleared");
}

// ---- item 1: a cancel after finish() is never reported as certain or unchanged

test("slow commit + a NORMAL cancel after finish(): uncertain with plasticity_reconcile, never 'unchanged'; the commit really lands later", async () => {
  for (const executor of ["rejecting", "swallowing"] as const) {
    const f = fixture("slow-commit", { executor, commitDelayMs: 400 });
    await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), (error: Error) => {
      assert.match(error.message, /did not finish within 80 ms after its dialog was finished \(finish phase\); Plasticity cancelled it, but a commit that finish\(\) started may still land/);
      assert.match(error.message, RECONCILE);
      assert.doesNotMatch(error.message, /unchanged/);
      return true;
    }, executor);
    assert.equal(f.isUncertain(), true, executor);
    assert.equal(f.seen.cancelled, 1, `${executor}: our command was cancelled`);
    assertCleanEnd(f);
    assert.equal(f.undoStack.length, 0, `${executor}: nothing landed while the tool watched`);
    await sleep(600);
    // The stub evidence from the review: the commit lands after the "successful" cancel.
    assert.equal(f.undoStack.length, 1, `${executor}: the late commit landed`);
    assert.equal(f.faces.find((face) => face.id === "fxp")!.centerMm[0], 2030, executor);
  }
});

test("a commit that lands inside the settle window after the cancel is reported as a normal, read-back success", async () => {
  const timeouts: PickCommandTimeouts = { dialogMs: 60, finishMs: 80, cancelMs: 600, settleMs: 300 };
  for (const executor of ["rejecting", "swallowing"] as const) {
    const f = fixture("slow-commit", { executor, commitDelayMs: 150 });
    const result = await f.operations.setDrivingDistance(PAIR, "r1", timeouts);
    assert.equal(result.changed, true, executor);
    assert.equal(result.undoSteps, 1);
    assert.equal(result.planeOffsetMm, 2030, "the post-commit plane check ran");
    assert.equal(result.movedFaceId, "fxp");
    assert.match(result.message ?? "", /landed after the 80 ms finish wait/);
    assert.equal(f.seen.cancelled, 1);
    assert.equal(f.isUncertain(), false, executor);
    assertCleanEnd(f);
  }
});

test("a late commit inside the settle window is still read back: a wrong plane is uncertain, not success", async () => {
  const timeouts: PickCommandTimeouts = { dialogMs: 60, finishMs: 80, cancelMs: 600, settleMs: 300 };
  const f = fixture("slow-commit", { commitDelayMs: 150, refDistanceM: 0.025 });
  // refDistance says 25 mm, the fake moves fxp by (30 - 25) mm to 2025: 25 mm from fxn, not 30.
  await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", timeouts), /read-back does not match/);
  assert.equal(f.isUncertain(), true);
});

test("the settle window never runs past the cancelMs budget, so the CDP timeout needs no extra margin", async () => {
  const f = fixture("slow-commit", { commitDelayMs: 400 });
  const started = Date.now();
  await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", { ...FAST, settleMs: 5_000 }), RECONCILE);
  assert.ok(Date.now() - started < 350, `returned after ${Date.now() - started} ms: the 5 s settle window was capped by cancelMs 60`);
  assert.equal(f.calls[0]!.timeoutMs, FAST.dialogMs + FAST.finishMs + FAST.cancelMs + 6_000);
  assert.equal((f.calls[0]!.values[0] as { settleMs: number }).settleMs, 5_000);
  const g = fixture();
  await g.operations.setDrivingDistance(PAIR, "r1", FAST);
  assert.equal((g.calls[0]!.values[0] as { settleMs: number }).settleMs, PICK_COMMAND_SETTLE_MS, "default settle window");
});

test("a drive step that throws AFTER finish() is undetermined, not a certain cancel", async () => {
  for (const executor of ["rejecting", "swallowing"] as const) {
    const f = fixture("finish-throws", { executor, commitDelayMs: 400 });
    await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), (error: Error) => {
      assert.match(error.message, /after its dialog was finished \(drive phase\): finish exploded after starting the commit/);
      assert.match(error.message, RECONCILE);
      assert.doesNotMatch(error.message, /unchanged/);
      return true;
    });
    assert.equal(f.isUncertain(), true, executor);
  }
});

test("a timeout BEFORE finish() keeps the certain cancel: dialog phase, a drive that never returns, a drive that never finishes", async () => {
  const f = fixture("no-dialog");
  await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), /^Error: Driving distance did not finish within 60 ms \(dialog phase\); Plasticity cancelled it and the document is unchanged$/);
  assert.equal(f.isUncertain(), false);
  assertCleanEnd(f);
  const run = (g: ReturnType<typeof fixture>, drive: string) => (g.operations as unknown as { runPickCommand(spec: unknown): Promise<unknown> }).runPickCommand({
    command: "DimensionDistanceCommand", dialog: "DimensionDistanceSpaceDialog",
    select: [{ kind: "face", bodyId: 5, id: "fxn" }, { kind: "face", bodyId: 5, id: "fxp" }],
    hits: [{ item: { kind: "face", bodyId: 5, id: "fxp" }, pointM: [2.02, 0.005, 0.0025], normalM: [1, 0, 0], onFace: true }],
    drive, driveArgs: { distanceM: 0.03 }, rejectedMessage: "no effect", label: "Pick probe", timeouts: FAST,
  });
  // The drive sets the distance and never returns (finish() not called): drive phase, certain.
  const g = fixture("slow-commit");
  await assert.rejects(run(g, "dialog.params.distance = driveArgs.distanceM; await new Promise(() => {});"), /^Error: Pick probe did not finish within 80 ms \(drive phase\): the drive step did not return; Plasticity cancelled it and the document is unchanged$/);
  assert.equal(g.isUncertain(), false);
  assert.equal(g.seen.dialog!.finished, 0);
  assertCleanEnd(g);
  // The drive returns without finish() (live-verified in probe-cancel.json): finish phase, certain.
  const h = fixture("slow-commit");
  await assert.rejects(run(h, "dialog.params.distance = driveArgs.distanceM; return null;"), /^Error: Pick probe did not finish within 80 ms \(finish phase\); Plasticity cancelled it and the document is unchanged$/);
  assert.equal(h.isUncertain(), false);
  await sleep(450);
  assert.equal(h.undoStack.length, 0, "without finish() nothing ever lands");
});

test("a cancel that fails after finish() is still uncertain and names the cancel error", async () => {
  const f = fixture("slow-commit", { cancel: "throws", executor: "swallowing" });
  await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), /could not cancel it .*the result is uncertain.*Cancel error: cancel exploded/);
  assert.equal(f.isUncertain(), true);
});

// ---- item 2: a commit with no Undo step that did not reach the request is an error

test("no Undo step, unchanged body, distance not reached after finish(): 'Plasticity made no change', runtime uncertain (round 4: no no-effect rejection)", async () => {
  for (const [input, refDistanceM, message] of [
    [PAIR, 0.02, "Plasticity made no change: distance is still 20 mm, requested 30 mm"],
    [{ bodyId: 5, movingFaceId: "fz", distanceMm: 20 }, 0.012, "Plasticity made no change: distance is still 12 mm, requested 20 mm"],
  ] as const) {
    const f = fixture("commit-noop", { refDistanceM });
    await assert.rejects(f.operations.setDrivingDistance(input, "r1", FAST), (error: Error) => {
      assert.ok(error.message.includes(message), error.message);
      assert.match(error.message, RECONCILE);
      return true;
    });
    assert.equal(f.isUncertain(), true, "finish() was called and Plasticity gave no no-effect rejection");
    assertCleanEnd(f);
  }
});

test("no Undo step and the distance already equals the request (within 1e-6 mm), but no no-effect rejection after finish(): uncertain (round 4)", async () => {
  const f = fixture("commit-noop", { refDistanceM: 0.012 });
  await assert.rejects(f.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fz", distanceMm: 12 + 5e-7 }, "r1", FAST), RECONCILE);
  assert.equal(f.isUncertain(), true);
});

// ---- item 3: the read-back must see the moving face's plane change

test("nothing moved but another face already sits at the target offset: an error, not success", async () => {
  const f = fixture("commit-nothing-moves", { extraFaces: [{ id: "fx30", surfaceType: "Plane", planar: true, centerMm: [2030, 2, 1], normal: [1, 0, 0], edgeIds: [] }] });
  await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), (error: Error) => {
    assert.match(error.message, /read-back does not match: no face moved to 2030 mm/);
    assert.match(error.message, /Plasticity made no change: distance is still 20 mm, requested 30 mm/);
    assert.match(error.message, UNDO_RESTORES);
    return true;
  });
  assert.equal(f.isUncertain(), false, "an Undo step was added in a known way: a certain error, plasticity_undo restores it");
});

test("a different face moved to the target while the moving face stayed: an error naming it", async () => {
  // A stepped +x face at x 2010 moves to 2030 instead of fxp.
  const f = fixture("commit-other-face", { otherFaceId: "fx10", extraFaces: [{ id: "fx10", surfaceType: "Plane", planar: true, centerMm: [2010, 2, 1], normal: [1, 0, 0], edgeIds: [] }] });
  await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), (error: Error) => {
    assert.match(error.message, /a different face moved \(planes at 2010 mm lost a face; the moving face at 2020 mm did not move\)/);
    assert.match(error.message, UNDO_RESTORES);
    return true;
  });
  assert.equal(f.isUncertain(), false);
});

test("the reference face moved instead of the moving face: an error, the reference plane is checked", async () => {
  const f = fixture("commit-other-face", { otherFaceId: "fxn" });
  await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), /read-back does not match: no face moved to 2030 mm/);
  assert.equal(f.isUncertain(), false);
});

test("make flush: the moving face merges into an existing coplanar face at the target, a success", async () => {
  const f = fixture("commit-flush", { extraFaces: [{ id: "fx30", surfaceType: "Plane", planar: true, centerMm: [2030, 2, 1], normal: [1, 0, 0], edgeIds: [] }] });
  const result = await f.operations.setDrivingDistance(PAIR, "r1", FAST);
  assert.equal(result.changed, true);
  assert.equal(result.undoSteps, 1);
  assert.equal(result.planeOffsetMm, 2030);
  assert.equal(result.movedFaceId, "fx30", "the merged face carries the moved plane");
  assert.equal(f.isUncertain(), false);
});

test("a moving face that lands on the far side of the reference, at the requested distance, is accepted", async () => {
  const f = fixture("commit-cross");
  const result = await f.operations.setDrivingDistance(PAIR, "r1", FAST);
  assert.equal(result.changed, true);
  assert.equal(result.planeOffsetMm, 1970, "30 mm on the other side of the reference at 2000");
});

// ---- item 5: foreign commands, interruptions, unsupported builds

test("a foreign command active after a non-commit outcome is named in the error and left alone", async () => {
  const f = fixture("commit-fails", { executor: "swallowing", foreignAfterCommit: true });
  await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), /^Error: Driving distance failed: Kernel failed; another Plasticity command \(ForeignCommand\) is active and was left alone; its dialog was finished, so a commit may still land; the result is uncertain\. Call plasticity_reconcile before any other edit$/);
  assert.equal(f.seen.cancelled, 0);
  assert.equal(f.executor.active?.command, f.foreign);
  assert.equal(f.isUncertain(), true);
});

test("an early interruption by a user command reads as interrupted, not as no effect", async () => {
  for (const executor of ["rejecting", "swallowing"] as const) {
    const f = fixture("interrupted", { executor });
    await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), (error: Error) => {
      assert.match(error.message, /^Driving distance was interrupted before its dialog opened by another Plasticity command \(UserBoxCommand\), which was left alone: Command interrupted; the document is unchanged$/);
      assert.doesNotMatch(error.message, /no effect/);
      return true;
    });
    assert.equal(f.seen.cancelled, 0, "the user's command is never cancelled");
    assert.equal(f.isUncertain(), false);
  }
});

test("a build without Face.GetAnyPointOn fails before the command starts with a tidy message", async () => {
  const f = fixture("commit", { noGetAnyPointOn: true });
  f.selectedFaces.add("user selection");
  await assert.rejects(f.operations.setDrivingDistance(PAIR, "r1", FAST), (error: Error) => {
    assert.equal(error.message, "Driving distance is not supported on this Plasticity build (Face.GetAnyPointOn is missing); nothing was changed");
    assert.doesNotMatch(error.message, /TypeError|is not a function/);
    return true;
  });
  assert.equal(f.seen.selection, undefined, "the command never ran");
  assert.deepEqual([...f.selectedFaces], ["user selection"], "the user's selection is untouched");
  assert.equal(f.isUncertain(), false);
});
