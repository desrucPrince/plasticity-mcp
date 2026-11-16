import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createCompactServer, type SessionLike } from "../server.ts";
import type { ConstructionHistoryEntry, ConstructionHistoryStore } from "./construction-history.ts";
import { PlasticityOperations, type PickCommandTimeouts } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

// Round 4 of plasticity_set_driving_distance: the outcome space is closed by one invariant.
// INVARIANT: the tool never returns a certain non-success result while a commit of ours can still land.
// (a) a table over the cross-product of the classifier inputs; (b) a simulation that runs the real generated native
// source against a stub editor in every lifecycle combination and checks the invariant 3 s after each run; then the
// generic-helper fixes and the Part 3 consistency items (batch undoOnError, face control points).
// The classifier is imported dynamically, so the simulation also runs against older code that has no classifier.

type Kind = "committed-verified" | "committed-mismatch" | "rejected-unchanged" | "undetermined";
type Classifier = typeof import("./pick-command-outcome.ts");
const classifierModule = async (): Promise<Classifier> => await import("./pick-command-outcome.ts");

// ---- (a) the table

const SETTLE_KINDS = ["resolved", "rejected-no-effect", "rejected-cancel-like", "rejected-abort", "rejected-other", "never"] as const;
const LANDS_LATE = ["no", "within-settle", "after-settle"] as const;
const CANCELS = ["not-needed", "ok", "failed", "threw"] as const;
type SettleKind = typeof SETTLE_KINDS[number];
interface Row {
  finishCalled: boolean; settle: SettleKind; undoDelta: 0 | 1 | 2; landsLate: typeof LANDS_LATE[number];
  ourActive: boolean; foreignActive: boolean; cancel: typeof CANCELS[number]; cleanup: "ok" | "threw"; geometry: "pass" | "fail" | null;
}
// Error texts as the live probes recorded them (discovery/probes-2026-11-followups/probe-late-commit.json and the
// probe-driving / probe-washer rejections); the cancel-like ones rotate through the three seen live.
const CANCEL_TEXTS = ["invalid state: cancelled", "Invalid state transition", "Cancelled"];
const errorOf = (settle: SettleKind, index: number): { text: string | null; name: string | null } => {
  switch (settle) {
    case "rejected-no-effect": return { text: "Operation has no effect", name: "Error" };
    case "rejected-cancel-like": return { text: CANCEL_TEXTS[index % CANCEL_TEXTS.length]!, name: "Error" };
    case "rejected-abort": return { text: "Operation failed at PK_TOPOL_facet_2 with error `PK_ERROR_aborted` (945) ", name: "Error" };
    case "rejected-other": return { text: "Kernel failed", name: "Error" };
    default: return { text: null, name: null };
  }
};

// Pruning rule (impossible combinations), stated once:
// P1 a commit can land late only after finish() (no commit without finish());
// P2 a commit can land late only if none is counted yet (one command commits at most once): undoDelta 0;
// P3 a commit cannot land late after Plasticity's no-effect rejection: it is the kernel refusing THIS commit, so
//    nothing is pending (the spec's rejected-unchanged definition rests on this);
// P4 "never settled" means the helper's cancel did not settle it: cancel is failed or threw;
// P5 a cancel counts as ok only when our command is no longer active;
// P6 the geometry check runs exactly when finish() was called and the Undo delta after the settle window is 1.
function rows(): Row[] {
  const result: Row[] = [];
  for (const finishCalled of [false, true]) for (const settle of SETTLE_KINDS) for (const undoDelta of [0, 1, 2] as const)
    for (const landsLate of LANDS_LATE) for (const ourActive of [false, true]) for (const foreignActive of [false, true])
      for (const cancel of CANCELS) for (const cleanup of ["ok", "threw"] as const) {
        if (landsLate !== "no" && !finishCalled) continue; // P1
        if (landsLate !== "no" && undoDelta !== 0) continue; // P2
        if (landsLate !== "no" && settle === "rejected-no-effect") continue; // P3
        if (settle === "never" && cancel !== "failed" && cancel !== "threw") continue; // P4
        if (cancel === "ok" && ourActive) continue; // P5
        const afterSettle = undoDelta + (landsLate === "within-settle" ? 1 : 0);
        const geometries = finishCalled && afterSettle === 1 ? (["pass", "fail"] as const) : [null]; // P6
        for (const geometry of geometries) result.push({ finishCalled, settle, undoDelta, landsLate, ourActive, foreignActive, cancel, cleanup, geometry });
      }
  return result;
}

const factsOf = (row: Row, index: number) => {
  const error = errorOf(row.settle, index);
  const afterSettle = row.undoDelta + (row.landsLate === "within-settle" ? 1 : 0);
  return {
    malformed: null, finishCalled: row.finishCalled, lateFinish: false,
    settle: row.settle === "resolved" ? "resolved" as const : row.settle === "never" ? "never" as const : "rejected" as const,
    errorText: error.text, errorName: error.name,
    undoDeltaAtReturn: row.undoDelta, undoDeltaAfterSettle: afterSettle,
    ourActive: row.ourActive, foreignActive: row.foreignActive ? "UserBoxCommand" : null,
    cancel: row.cancel, cleanup: row.cleanup,
    bodyChanged: afterSettle > 0, geometry: row.geometry,
  };
};

// The expected outcome, written from the spec's prose (Part 1), not from the implementation's table.
function expected(row: Row): Kind {
  const afterSettle = row.undoDelta + (row.landsLate === "within-settle" ? 1 : 0);
  // UNDETERMINED for anything that leaves our command or the cleanup in doubt.
  if (row.cleanup === "threw" || row.cancel === "failed" || row.cancel === "threw" || row.settle === "never" || row.ourActive) return "undetermined";
  // finish() never called: no commit of ours can land; unchanged when the history did not change.
  if (!row.finishCalled) return afterSettle === 0 ? "rejected-unchanged" : "undetermined";
  // COMMITTED-VERIFIED: one Undo step, nothing of ours active, the geometry check passes.
  if (afterSettle === 1 && row.geometry === "pass") return "committed-verified";
  // COMMITTED-MISMATCH: a clean commit (execute() resolved, no error, no foreign command, no cancel) with wrong geometry.
  if (afterSettle === 1 && row.geometry === "fail" && row.settle === "resolved" && !row.foreignActive && row.cancel === "not-needed") return "committed-mismatch";
  // REJECTED-UNCHANGED after finish(): only the no-effect rejection, nothing active, no cancel, nothing landed.
  if (afterSettle === 0 && row.settle === "rejected-no-effect" && !row.foreignActive && row.cancel === "not-needed") return "rejected-unchanged";
  return "undetermined";
}

test("(a) classification table: every row of the pruned cross-product matches the spec's outcome and the invariant", async () => {
  const { classifyPickOutcome } = await classifierModule();
  const all = rows();
  const counts = new Map<Kind, number>();
  const failures: string[] = [];
  for (const [index, row] of all.entries()) {
    const outcome = classifyPickOutcome(factsOf(row, index));
    counts.set(outcome.kind, (counts.get(outcome.kind) ?? 0) + 1);
    const want = expected(row);
    if (outcome.kind !== want) failures.push(`${JSON.stringify(row)} -> ${outcome.kind} (${outcome.reason}), expected ${want}`);
    // The invariant against the ground truth the classifier cannot see.
    if (row.landsLate === "after-settle" && outcome.kind !== "undetermined") failures.push(`INVARIANT ${JSON.stringify(row)}: a commit lands after the settle window, but the outcome is ${outcome.kind}`);
    if (outcome.kind === "rejected-unchanged" && (row.landsLate !== "no" || row.undoDelta !== 0)) failures.push(`INVARIANT ${JSON.stringify(row)}: "unchanged" although a commit is counted or still lands`);
    if (outcome.kind === "committed-verified" && row.geometry !== "pass") failures.push(`${JSON.stringify(row)}: success without a passing geometry check`);
  }
  console.log(`classification table: ${all.length} rows (of ${2 * 6 * 3 * 3 * 2 * 2 * 4 * 2} before pruning, x2 geometry where it runs); ${[...counts].map(([kind, count]) => `${kind} ${count}`).join(", ")}`);
  assert.deepEqual(failures, []);
  assert.ok(all.length >= 1000, `${all.length} rows`);
  for (const kind of ["committed-verified", "committed-mismatch", "rejected-unchanged", "undetermined"] as const) assert.ok((counts.get(kind) ?? 0) > 0, `${kind} is reachable`);
});

test("(a) classification table: malformed records, a late finish() and a changed body are never certain-unchanged", async () => {
  const { classifyPickOutcome, PICK_OUTCOME_TABLE } = await classifierModule();
  const clean = {
    malformed: null, finishCalled: true, lateFinish: false, settle: "rejected" as const, errorText: "Operation has no effect", errorName: "Error",
    undoDeltaAtReturn: 0, undoDeltaAfterSettle: 0, ourActive: false, foreignActive: null, cancel: "not-needed" as const, cleanup: "ok" as const,
    bodyChanged: false, geometry: null,
  };
  assert.equal(classifyPickOutcome(clean).kind, "rejected-unchanged");
  assert.equal(classifyPickOutcome({ ...clean, malformed: "the native record lacks finishCalled" }).kind, "undetermined");
  assert.equal(classifyPickOutcome({ ...clean, lateFinish: true }).reason, "late-finish");
  assert.equal(classifyPickOutcome({ ...clean, bodyChanged: true }).kind, "undetermined");
  assert.equal(classifyPickOutcome({ ...clean, bodyChanged: null }).kind, "undetermined");
  assert.equal(classifyPickOutcome({ ...clean, finishCalled: false, bodyChanged: true }).kind, "undetermined");
  assert.equal(classifyPickOutcome({ ...clean, undoDeltaAtReturn: 1, undoDeltaAfterSettle: 0 }).reason, "history-shrank");
  // The no-effect matcher is anchored to the live text; a cancel that mentions it is not a no-effect rejection.
  assert.equal(classifyPickOutcome({ ...clean, errorText: "Exec.execute:rejected CommandExecutor  Operation has no effect" }).kind, "rejected-unchanged");
  assert.equal(classifyPickOutcome({ ...clean, errorText: "Operation has no effect (cancelled)" }).kind, "undetermined");
  assert.equal(classifyPickOutcome({ ...clean, errorText: "invalid state: cancelled" }).kind, "undetermined");
  // Before finish(): a plain no-effect rejection with an unrelated active command is "no-effect", not "interrupted".
  assert.equal(classifyPickOutcome({ ...clean, finishCalled: false, foreignActive: "UserBoxCommand" }).reason, "no-effect");
  assert.equal(classifyPickOutcome({ ...clean, finishCalled: false, errorText: "Command interrupted", errorName: "Interrupt", foreignActive: "UserBoxCommand" }).reason, "interrupted");
  assert.ok(PICK_OUTCOME_TABLE.length > 10, "one table, readable in one place");
});

// ---- the stub world: a 20 x 10 x 5 box at x 2000, faces with bounds, a real Undo history

type V = [number, number, number];
type Face = { id: string; surfaceType: string; planar: boolean; centerMm: V; normal: V; boundsMm: { min: V; max: V }; edgeIds: string[] };
const boxFaces = (x0 = 2000, x1 = 2020): Face[] => [
  { id: "fxp", surfaceType: "Plane", planar: true, centerMm: [x1, 5, 2.5], normal: [1, 0, 0], boundsMm: { min: [x1, 0, 0], max: [x1, 10, 5] }, edgeIds: [] },
  { id: "fxn", surfaceType: "Plane", planar: true, centerMm: [x0, 5, 2.5], normal: [-1, 0, 0], boundsMm: { min: [x0, 0, 0], max: [x0, 10, 5] }, edgeIds: [] },
  { id: "fyp", surfaceType: "Plane", planar: true, centerMm: [(x0 + x1) / 2, 10, 2.5], normal: [0, 1, 0], boundsMm: { min: [x0, 10, 0], max: [x1, 10, 5] }, edgeIds: [] },
  { id: "fyn", surfaceType: "Plane", planar: true, centerMm: [(x0 + x1) / 2, 0, 2.5], normal: [0, -1, 0], boundsMm: { min: [x0, 0, 0], max: [x1, 0, 5] }, edgeIds: [] },
  { id: "fzp", surfaceType: "Plane", planar: true, centerMm: [(x0 + x1) / 2, 5, 5], normal: [0, 0, 1], boundsMm: { min: [x0, 0, 5], max: [x1, 10, 5] }, edgeIds: [] },
  { id: "fzn", surfaceType: "Plane", planar: true, centerMm: [(x0 + x1) / 2, 5, 0], normal: [0, 0, -1], boundsMm: { min: [x0, 0, 0], max: [x1, 10, 0] }, edgeIds: [] },
];

interface WorldOptions {
  executor: "rejecting" | "swallowing";
  canceller: "nobody" | "us" | "ext5" | "ext30" | "ext200" | "foreign";
  /** ms after finish() at which the commit lands; null: never. */
  commitMs: number | null;
  cancelDiscards: boolean;
  finish: "yes" | "never" | "throws";
  /** "wrong-reference": the commit moves the reference face instead (a clean commit with the wrong geometry). */
  commitKind?: "right" | "wrong-reference";
  /** execute() rejects at once with this text, before any dialog; with foreignAfterReject a user command then starts. */
  rejectAtOnce?: string;
  foreignAfterReject?: boolean;
}

class Vector3 {
  x: number; y: number; z: number;
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
}
class FakeDialog {
  params: Record<string, unknown>;
  finish?: () => void;
  constructor(params: Record<string, unknown>) { this.params = params; }
}

function world(options: WorldOptions) {
  let faces = boxFaces();
  let version = 105;
  let revision = 1;
  const undoStack: Face[][] = [];
  const redoStack: Face[][] = [];
  const sceneObjects: unknown[] = [];
  const selected = new Set<unknown>();
  const hits = new Map<unknown, { point: Vector3; normal: Vector3 | undefined }>();
  const foreign = { constructor: { name: "UserBoxCommand" } };
  const ids = () => faces.map((face) => face.id);
  const view = { constructor: { name: "Solid" }, high: { get faces() { return { versionIds: ids(), get: (index: number) => ({ face: ids()[index], entityId: 700 + index }) }; }, edges: { versionIds: [] } } };
  const model = { GetFaces: () => ({ Size: () => faces.length, Get: (index: number) => ({ Id: () => 700 + index, GetAnyPointOn: () => { const p = faces[index]!.centerMm; return { position: { x: p[0] / 1000, y: p[1] / 1000, z: p[2] / 1000 } }; } }) }) };
  const geometryModel = new Map<number, unknown>([[105, { view, model }]]);
  const commitGeometry = (distanceM: number) => {
    undoStack.push(structuredClone(faces));
    redoStack.length = 0;
    version += 1; revision += 1;
    if (options.commitKind === "wrong-reference") {
      const reference = faces.find((face) => face.id === "fxn")!;
      reference.centerMm = [1990, 5, 2.5]; reference.boundsMm = { min: [1990, 0, 0], max: [1990, 10, 5] };
    } else faces = boxFaces(2000, 2000 + distanceM * 1000);
  };

  class DimensionDistanceCommand {
    remember = true;
    editor: unknown;
    private rejectRun: ((error: Error) => void) | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    constructor(editor: unknown) { this.editor = editor; }
    cancel(reason = "invalid state: cancelled") {
      if (options.cancelDiscards && this.timer) { clearTimeout(this.timer); this.timer = undefined; }
      const reject = this.rejectRun;
      this.rejectRun = undefined;
      reject?.(new Error(reason));
    }
    async execute(): Promise<unknown> {
      if (options.rejectAtOnce !== undefined) {
        if (options.foreignAfterReject) setTimeout(() => { executor.active = { command: foreign }; }, 0);
        throw new Error(options.rejectAtOnce);
      }
      return await new Promise((resolve, reject) => {
        this.rejectRun = (error) => { sceneObjects.length = 0; reject(error); };
        const hit = hits.values().next().value?.point as Vector3 | undefined;
        const dialog = new FakeDialog({ refDistance: 0.02, distance: 0.02, to: hit ? new Vector3(hit.x - 0.02, hit.y, hit.z) : undefined });
        const startCanceller = () => {
          const at = { ext5: 5, ext30: 30, ext200: 200, foreign: 30 }[options.canceller as "ext5"];
          if (at === undefined) return;
          setTimeout(() => {
            if (executor.active?.command !== this) return;
            if (options.canceller === "foreign") { this.cancel("Invalid state transition"); executor.active = { command: foreign }; }
            else executor.cancelActiveCommand();
          }, at);
        };
        if (options.finish !== "never") {
          dialog.finish = () => {
            startCanceller();
            if (options.commitMs !== null) {
              this.timer = setTimeout(() => {
                this.timer = undefined;
                sceneObjects.length = 0;
                commitGeometry(dialog.params.distance as number);
                resolve(undefined); // no effect when the command was already cancelled: the commit landed anyway
              }, options.commitMs);
            }
            if (options.finish === "throws") throw new Error("finish exploded after starting the commit");
          };
        } else startCanceller();
        sceneObjects.push({ unrelated: true }, dialog);
      });
    }
  }
  const executor = {
    isBusy: false,
    active: null as { command: { cancel?: () => void; constructor: { name: string } } } | null,
    cancelActiveCommand() { this.active?.command.cancel?.(); },
  };
  const editor = {
    geo: { read: { geometryModel, automatics: new Set<number>() }, lookupStableId(versionId: number) { return versionId - 100; } },
    db: { version: 1, commit() { return undefined; } },
    executor,
    history: { undoStack, redoStack },
    helpers: { scene: { traverse(visit: (object: unknown) => void) { for (const object of [...sceneObjects]) visit(object); } } },
    selection: {
      selected: { faces: selected, add(item: unknown) { selected.add(item); }, removeAll() { selected.clear(); } },
      hits: { hits, record(item: unknown, point: Vector3, normal?: Vector3) { hits.set(item, { point, normal }); }, clear() { hits.clear(); } },
    },
    async exec(command: DimensionDistanceCommand) {
      executor.active = { command };
      try { await command.execute(); } catch (error) { if (options.executor === "rejecting") throw error; }
      finally { if (executor.active?.command === command) executor.active = null; }
    },
    async undo() { const previous = undoStack.pop(); if (previous) { redoStack.push(faces); faces = previous; version += 1; revision += 1; } },
    async redo() { const next = redoStack.pop(); if (next) { undoStack.push(faces); faces = next; version += 1; revision += 1; } },
  };
  let uncertain = false;
  const state = (): RuntimeState => ({
    targetId: "window", title: "Driving distance outcomes", documentToken: "document", revision: `r${revision}`, dbVersion: revision, undoDepth: undoStack.length, redoDepth: redoStack.length,
    construction: { planes: [], activePlaneId: "standard:top", planeStateToken: "planes", viewStateToken: "view" },
    regions: [], measurements: [],
    bodies: [{ id: 5, versionId: version, type: "Solid", name: null, boundsMm: null, faceIds: ids(), edgeIds: [], faces: structuredClone(faces), edges: [] }],
  }) as unknown as RuntimeState;
  const runtime = {
    async getState() { return state(); },
    async mutate(source: string, bindings: string[], values: unknown[]) {
      if (uncertain) throw new Error("Previous mutation outcome is uncertain; call reconcile before another mutation");
      const native = Function(`return (${source})`)();
      const bound = bindings.map((name) => ({ DimensionDistanceCommand, DimensionDistanceSpaceDialog: FakeDialog, Vector3 } as Record<string, unknown>)[name]);
      return await native.call(editor, ...bound, ...values);
    },
    async read() { throw new Error("unexpected read"); },
    isUncertain() { return uncertain; },
    markUncertain() { uncertain = true; },
    reconcile() { uncertain = false; },
  } as unknown as PlasticityRuntime;
  const geometry = () => ({ undo: undoStack.length, fxp: faces.find((face) => face.id === "fxp")?.centerMm[0] ?? null, fxn: faces.find((face) => face.id === "fxn")?.centerMm[0] ?? null });
  return { operations: new PlasticityOperations(runtime), runtime, geometry, isUncertain: () => uncertain, executor, foreign };
}

const PAIR = { bodyId: 5, movingFaceId: "fxp", referenceFaceId: "fxn", distanceMm: 30 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const RECONCILE = /the result is uncertain\. Call plasticity_reconcile before any other edit/;

// ---- (b) the simulation property test

test("(b) simulation: in every lifecycle combination the invariant holds 3 s after the tool returned", { timeout: 60_000 }, async () => {
  const scenarios: WorldOptions[] = [];
  for (const executor of ["rejecting", "swallowing"] as const) for (const canceller of ["nobody", "us", "ext5", "ext30", "ext200", "foreign"] as const)
    for (const commitMs of [null, 9, 100, 400, 1500]) for (const cancelDiscards of [true, false]) for (const finish of ["yes", "never", "throws"] as const) {
      scenarios.push({ executor, canceller, commitMs, cancelDiscards, finish });
    }
  const SHORT: PickCommandTimeouts = { dialogMs: 200, finishMs: 50, cancelMs: 300, settleMs: 250 };
  const LONG: PickCommandTimeouts = { dialogMs: 200, finishMs: 2_500, cancelMs: 300, settleMs: 250 };
  const describe = (s: WorldOptions) => `executor=${s.executor} canceller=${s.canceller} commit=${s.commitMs ?? "never"} cancel=${s.cancelDiscards ? "discards" : "keeps"} finish=${s.finish}`;
  const results = await Promise.all(scenarios.map(async (scenario) => {
    const w = world(scenario);
    const before = w.geometry();
    let said: { kind: "success" | "no-op" | "error"; text: string; mismatch: boolean };
    try {
      const result = await w.operations.setDrivingDistance(PAIR, "r1", scenario.canceller === "us" ? SHORT : LONG);
      said = { kind: result.changed ? "success" : "no-op", text: result.message ?? "", mismatch: false };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      // A certain committed-mismatch names its Undo step; every other certain error claims "unchanged".
      said = { kind: "error", text, mismatch: typeof (error as { revision?: unknown }).revision === "string" && /plasticity_undo restores/.test(text) };
    }
    const uncertainAtReturn = w.isUncertain();
    const atReturn = w.geometry();
    await sleep(3_000);
    const later = w.geometry();
    const same = (a: typeof later, b: typeof later) => a.undo === b.undo && a.fxp === b.fxp && a.fxn === b.fxn;
    let violation: string | null = null;
    if (said.kind === "success") {
      if (!(later.undo === before.undo + 1 && later.fxp === 2030 && later.fxn === 2000)) violation = `success, but 3 s later the geometry is ${JSON.stringify(later)}`;
    } else if (!uncertainAtReturn) {
      if (said.mismatch) { if (!same(later, atReturn)) violation = `certain mismatch, but the document changed after it returned: ${JSON.stringify(atReturn)} -> ${JSON.stringify(later)}`; }
      else if (!same(later, before)) violation = `certain "${said.kind === "no-op" ? "no-op" : said.text.slice(0, 160)}", but 3 s later ${JSON.stringify(later)} (before ${JSON.stringify(before)})`;
    }
    return { scenario, said, uncertainAtReturn, violation };
  }));
  const violations = results.filter((entry) => entry.violation !== null).map((entry) => `${describe(entry.scenario)}: ${entry.violation}`);
  const tally = (predicate: (entry: typeof results[number]) => boolean) => results.filter(predicate).length;
  console.log(`simulation: ${results.length} scenarios run; success ${tally((entry) => entry.said.kind === "success")}, certain errors ${tally((entry) => entry.said.kind === "error" && !entry.uncertainAtReturn)}, uncertain ${tally((entry) => entry.uncertainAtReturn)}, violations ${violations.length}`);
  for (const line of violations) console.log(`VIOLATION ${line}`);
  // The reviewer's scenario: an external cancel 30 ms after finish(), the commit at 400 ms, both executor modes.
  const reviewer = results.filter((entry) => entry.scenario.canceller === "ext30" && entry.scenario.commitMs === 400 && entry.scenario.finish === "yes");
  assert.equal(reviewer.length, 4, "both executor modes x both cancel effects");
  for (const entry of reviewer) assert.equal(entry.uncertainAtReturn, true, `reviewer scenario ${describe(entry.scenario)} said ${JSON.stringify(entry.said)}`);
  assert.ok(results.length >= 300, `${results.length} scenarios`);
  assert.deepEqual(violations, []);
});

// ---- generic-helper fixes

const runPick = (operations: PlasticityOperations, drive: string, timeouts: PickCommandTimeouts) => (operations as unknown as { runPickCommand(spec: unknown): Promise<unknown> }).runPickCommand({
  command: "DimensionDistanceCommand", dialog: "DimensionDistanceSpaceDialog",
  select: [{ kind: "face", bodyId: 5, id: "fxn" }, { kind: "face", bodyId: 5, id: "fxp" }],
  hits: [{ item: { kind: "face", bodyId: 5, id: "fxp" }, pointM: [2.02, 0.005, 0.0025], normalM: [1, 0, 0], onFace: true }],
  drive, driveArgs: { distanceM: 0.03 }, rejectedMessage: "no effect", label: "Pick probe", timeouts,
});

test("a drive step that calls finish() after it returned is refused and undetermined; the commit never starts", async () => {
  const w = world({ executor: "swallowing", canceller: "nobody", commitMs: 9, cancelDiscards: true, finish: "yes" });
  const timeouts: PickCommandTimeouts = { dialogMs: 200, finishMs: 100, cancelMs: 300, settleMs: 250 };
  // The drive returns at once and calls finish() 20 ms later, asynchronously.
  await assert.rejects(runPick(w.operations, "dialog.params.distance = driveArgs.distanceM; setTimeout(() => { try { dialog.finish(); } catch {} }, 20); return null;", timeouts), (error: Error) => {
    assert.match(error.message, /drive step called finish\(\) after it had returned; the call was refused/);
    assert.match(error.message, RECONCILE);
    return true;
  });
  assert.equal(w.isUncertain(), true);
  await sleep(200);
  assert.equal(w.geometry().undo, 0, "the refused finish() started no commit");
});

test("a late finish() after the native call returned is refused too: nothing ever lands", async () => {
  const w = world({ executor: "rejecting", canceller: "nobody", commitMs: 9, cancelDiscards: false, finish: "yes" });
  const timeouts: PickCommandTimeouts = { dialogMs: 200, finishMs: 30, cancelMs: 100, settleMs: 50 };
  // The drive keeps the dialog and calls finish() 600 ms later, long after the helper returned.
  await assert.rejects(runPick(w.operations, "dialog.params.distance = driveArgs.distanceM; setTimeout(() => { try { dialog.finish(); } catch {} }, 600); return null;", timeouts), /\(finish phase\); Plasticity cancelled it and the document is unchanged/);
  await sleep(800);
  assert.deepEqual(w.geometry(), { undo: 0, fxp: 2020, fxn: 2000 }, "a finish() after the helper returned never starts a commit");
});

test("a drive that throws after an instant commit: success, and the note says the drive threw (not 'after the finish wait')", async () => {
  for (const executor of ["rejecting", "swallowing"] as const) {
    const w = world({ executor, canceller: "nobody", commitMs: 0, cancelDiscards: false, finish: "throws" });
    const result = await w.operations.setDrivingDistance(PAIR, "r1", { dialogMs: 200, finishMs: 8_000, cancelMs: 300, settleMs: 250 });
    assert.equal(result.changed, true, executor);
    assert.equal(result.planeOffsetMm, 2030);
    assert.doesNotMatch(result.message ?? "", /finish wait/, executor);
    assert.match(result.message ?? "", /drive step threw after finish\(\) \(finish exploded after starting the commit\); the commit landed and was read back/);
    assert.equal(w.isUncertain(), false);
  }
});

test("a plain no-effect rejection followed by an unrelated active command reads as no effect, not interrupted", async () => {
  for (const executor of ["rejecting", "swallowing"] as const) {
    const w = world({ executor, canceller: "nobody", commitMs: null, cancelDiscards: true, finish: "yes", rejectAtOnce: "Operation has no effect", foreignAfterReject: true });
    await assert.rejects(w.operations.setDrivingDistance(PAIR, "r1", { dialogMs: 100, finishMs: 100, cancelMs: 100 }), (error: Error) => {
      assert.equal(error.message, "Plasticity could not dimension these faces (no effect): Operation has no effect; another Plasticity command (UserBoxCommand) is active and was left alone");
      assert.doesNotMatch(error.message, /interrupted/);
      return true;
    }, executor);
    assert.equal(w.executor.active?.command, w.foreign, "the user's command is left alone");
    assert.equal(w.isUncertain(), false);
  }
});

// ---- Part 3: plasticity_batch with undoOnError after a driving-distance step

function batchHarness(options: WorldOptions) {
  const w = world(options);
  const journal: ConstructionHistoryEntry[] = [];
  const history = { async append(entry: ConstructionHistoryEntry) { journal.push(entry); } } as unknown as ConstructionHistoryStore;
  const session = {
    async windows() { return []; }, async connect() { return null; }, get() { return w.operations; },
    capabilities() { return { bindings: [], operations: w.operations.constructionCapabilities() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createCompactServer(session, undefined, undefined, undefined, history);
  const client = new Client({ name: "driving-distance-outcomes", version: "1.0.0" });
  return {
    w, journal,
    async open() { const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport); await client.connect(clientTransport); },
    async call(name: string, args: Record<string, unknown>) {
      const response = await client.callTool({ name, arguments: args });
      const text = (response.content as Array<{ type: string; text?: string }>).find((part) => part.type === "text")?.text ?? "";
      return { isError: response.isError === true, text };
    },
    async close() { await client.close(); await server.close(); },
  };
}
const batchError = (text: string) => JSON.parse(text.slice(text.indexOf("{"))) as { failedStep: number; error: string; undoneSteps: number; undo?: string; undoError?: string };

test("batch undoOnError after a committed-mismatch step: the undo works (runtime certain) and the step's error is kept", async () => {
  const h = batchHarness({ executor: "swallowing", canceller: "nobody", commitMs: 9, cancelDiscards: true, finish: "yes", commitKind: "wrong-reference" });
  await h.open();
  const reply = await h.call("plasticity_batch", { undoOnError: true, steps: [
    { toolName: "plasticity_set_driving_distance", arguments: { bodyId: 5, movingFaceId: "fxp", referenceFaceId: "fxn", distanceMm: 30 } },
  ] });
  assert.equal(reply.isError, true);
  const parsed = batchError(reply.text);
  assert.match(parsed.error, /^Driving distance committed one Undo step, but the read-back does not match: no face moved to 2030 mm/);
  assert.match(parsed.error, /The document is in a known state at revision r2: one Undo step was added, and plasticity_undo restores the previous geometry/);
  assert.equal(parsed.undoneSteps, 1, "undoOnError undid the mismatched step");
  assert.equal(parsed.undo, undefined);
  assert.equal(h.w.isUncertain(), false);
  assert.deepEqual(h.w.geometry(), { undo: 0, fxp: 2020, fxn: 2000 }, "one undo restored the body without a reconcile");
  await h.close();
});

test("batch undoOnError after an undetermined step: the step's error comes first and the undo is not attempted", async () => {
  const h = batchHarness({ executor: "rejecting", canceller: "ext30", commitMs: 400, cancelDiscards: false, finish: "yes" });
  await h.open();
  const reply = await h.call("plasticity_batch", { undoOnError: true, steps: [
    { toolName: "plasticity_set_driving_distance", arguments: { bodyId: 5, movingFaceId: "fxp", referenceFaceId: "fxn", distanceMm: 30 } },
  ] });
  assert.equal(reply.isError, true);
  const parsed = batchError(reply.text);
  assert.match(parsed.error, /^Driving distance failed: invalid state: cancelled; its dialog was finished, so a commit may still land; the result is uncertain/);
  assert.equal(parsed.undoneSteps, 0);
  assert.match(parsed.undo ?? "", /^not attempted because the result of the failed step is uncertain; call reconcile/);
  assert.ok(reply.text.indexOf("\"error\"") < reply.text.indexOf("\"undo\""), "the step's error comes before the undo note");
  assert.equal(h.w.isUncertain(), true);
  await h.close();
});

// ---- Part 3: face control points (same fake model as face-control-points-2.test.ts: ShellCVs carry no face link,
// view.high.cvs lists the shown faces' points face by face in kernel face order, every edit bumps the body version)

type Fields = Record<string, any>;
const cvGrid = (x0: number, peak: number): number[] => {
  const points: number[] = [];
  for (const [x, z] of [[x0, 0], [x0 + 0.00667, peak], [x0 + 0.01333, peak], [x0 + 0.02, 0]] as const) points.push(x, 0, z, x, 0.02, z);
  return points;
};
function facePoints(options: { stepsPerEdit?: number; reshapeOnMove?: boolean; x0?: number } = {}) {
  const x0 = options.x0 ?? 2.9;
  const kernel = [{ entity: 3210, vertices: cvGrid(x0, 0.010667) }, { entity: 3307, vertices: cvGrid(x0 + 0.02, 0.010667) }];
  const viewOrder = [...kernel].reverse().map((face) => face.entity);
  let version = 66;
  const shown = new Set<number>();
  const faceId = (entity: number) => `${version}f${entity}`;
  const view: Fields = { constructor: { name: "Sheet" }, high: { cvs: [] as Fields[], faces: {} } };
  const rebuild = () => {
    view.high.faces = { versionIds: viewOrder.map(faceId), get: (index: number) => ({ entityId: viewOrder[index] }) };
    const cvs: Fields[] = [];
    for (const face of kernel) {
      if (!shown.has(face.entity)) continue;
      for (let index = 0; index < Math.min(face.vertices.length / 3, 8); index += 1) {
        const [x, y, z] = face.vertices.slice(index * 3, index * 3 + 3).map((value) => Math.fround(value));
        cvs.push({ id: cvs.length, versionId: `${version}c${cvs.length}`, position: { x, y, z }, face: face.entity, index });
      }
    }
    view.high.cvs = cvs;
  };
  rebuild();
  const model = { GetFaces: () => ({ Size: () => kernel.length, Get: (index: number) => ({
    Id: () => kernel[index]!.entity,
    GetSurface: () => ({ surface: Object.assign(Object.create({ constructor: { name: "BSurf" } }), { GetInfo: () => ({ uVertices: kernel[index]!.vertices.length / 6, vVertices: 2, vertices: Float64Array.from(kernel[index]!.vertices) }) }) }),
  }) }) };
  const undoStack: unknown[] = [];
  const state = () => ({
    targetId: "window", title: "Face control points round 4", documentToken: "document", revision: `r${undoStack.length + 1}v${version}`, dbVersion: 1, undoDepth: undoStack.length, redoDepth: 0,
    construction: { planes: [], activePlaneId: "standard:top", planeStateToken: "planes", viewStateToken: "view" },
    bodies: [{ id: 9, versionId: version, type: "Sheet", name: null, boundsMm: null, faceIds: viewOrder.map(faceId), edgeIds: [],
      faces: viewOrder.map((entity) => ({ id: faceId(entity), surfaceType: "BSurf", planar: false, centerMm: [0, 0, 0], normal: [0, 0, 1], edgeIds: [] })), edges: [] }],
    measurements: [],
  }) as unknown as RuntimeState;
  let mutations = 0;
  const stub = (name: string) => class {
    resource() { return this; }
    move = { value: [] as number[], fromArray(value: number[]) { this.value = value; return this; } };
    async commit() {
      const self = this as unknown as Fields;
      for (let step = 0; step < (options.stepsPerEdit ?? 1); step += 1) undoStack.push(name);
      if (name === "ShowFacePointsFactory") for (const face of self.faces as Array<{ entityId: number }>) { if (self.show === false) shown.delete(face.entityId); else shown.add(face.entityId); }
      if (name === "MultiMoveControlPointFactory") {
        const [dx, dy, dz] = self.move.value as number[];
        for (const cv of self.cvs as Fields[]) {
          const face = kernel.find((candidate) => candidate.entity === cv.face)!;
          face.vertices[cv.index * 3] = face.vertices[cv.index * 3]! + dx!; face.vertices[cv.index * 3 + 1] = face.vertices[cv.index * 3 + 1]! + dy!; face.vertices[cv.index * 3 + 2] = face.vertices[cv.index * 3 + 2]! + dz!;
          if (options.reshapeOnMove) face.vertices.push(...face.vertices.slice(-6).map((value, index) => value + (index % 3 === 0 ? 0.001 : 0)));
        }
      }
      version += 1;
      rebuild();
      return [];
    }
  };
  const editor = {
    geo: { read: { geometryModel: new Map<number, Fields>([[109, { view, model }]]), automatics: new Set<number>() }, lookupStableId(versionId: number) { return versionId - 100; } },
    db: { version: 1, commit() { return undefined; } }, executor: { isBusy: false }, selection: { selected: { add() {}, removeAll() {} } },
    commands: new Proxy({}, { get: () => class { remember = true; execute: () => Promise<unknown> = async () => undefined; } }),
    async exec(command: { execute(): Promise<unknown> }) { await command.execute(); },
  };
  const run = async (source: string, bindings: string[], values: unknown[]) => await Function(`return (${source})`)().call(editor, ...bindings.map(stub), ...values);
  const runtime = {
    async getState() { return state(); },
    async mutate(source: string, bindings: string[], values: unknown[]) { mutations += 1; return await run(source, bindings, values); },
    async read(source: string, values: unknown[]) { return await run(source, [], values ?? []); },
    isUncertain() { return false; },
  } as unknown as PlasticityRuntime;
  return { operations: new PlasticityOperations(runtime), faceId, revision: () => state().revision, undoDepth: () => undoStack.length, mutations: () => mutations };
}
const A = 3210, B = 3307;

test("face points: the coincident-point move error carries the new revision and says undo, re-read the cvIds, include both", async () => {
  const f = facePoints({ reshapeOnMove: true });
  const shown = await f.operations.showFaceControlPoints(9, [f.faceId(A), f.faceId(B)], "r1v66");
  const a6 = shown.controlPoints.find((point) => point.faceId === f.faceId(A) && point.index === 6)!;
  await assert.rejects(f.operations.moveFaceControlPoints(9, [a6.cvId], [0, 0, 5], f.revision()), (error: Error) => {
    const revision = f.revision();
    assert.equal((error as { revision?: string }).revision, revision, "the error carries the new revision");
    assert.equal((error as { undoSteps?: number }).undoSteps, 1);
    assert.ok(error.message.includes(`The document is now at revision ${revision}; undo with plasticity_undo, re-read the cvIds with plasticity_show_face_control_points, then include both cvIds to move a shared edge point`), error.message);
    return true;
  });
});

test("face points: when the twin point's face is not shown, the hint says to show that face first and include both cvIds", async () => {
  const f = facePoints({ reshapeOnMove: true });
  const shown = await f.operations.showFaceControlPoints(9, [f.faceId(A)], "r1v66");
  const a6 = shown.controlPoints.find((point) => point.index === 6)!;
  const hiddenB = `9:${f.faceId(B)}`;
  await assert.rejects(f.operations.moveFaceControlPoints(9, [a6.cvId], [0, 0, 5], f.revision()), (error: Error) => {
    assert.match(error.message, new RegExp(`cv ${a6.cvId} sits on an edge shared with face ${hiddenB}, whose control points are not shown: .*show that face with plasticity_show_face_control_points first`));
    assert.match(error.message, /include both cvIds to move a shared edge point; inspect the body or undo$/);
    return true;
  });
  // A move that passes the read-back still carries the hint as a message.
  const g = facePoints();
  const shownG = await g.operations.showFaceControlPoints(9, [g.faceId(A)], "r1v66");
  const moved = await g.operations.moveFaceControlPoints(9, [shownG.controlPoints.find((point) => point.index === 6)!.cvId], [0, 0, 5], g.revision());
  assert.match(moved.message ?? "", /whose control points are not shown: .*show that face .*first; include both cvIds to move a shared edge point$/);
});

test("face points: a delta below the read-back resolution is refused before any edit", async () => {
  for (const [x0, delta, resolution] of [[2.9, [0, 0, 0.0005], "0.001"], [120, [0.05, 0, 0], "0.096"]] as const) {
    const f = facePoints({ x0 });
    const shown = await f.operations.showFaceControlPoints(9, [f.faceId(A)], "r1v66");
    const before = f.mutations();
    await assert.rejects(f.operations.moveFaceControlPoints(9, [shown.controlPoints[0]!.cvId], [...delta], f.revision()), (error: Error) => {
      assert.match(error.message, new RegExp(`^Face control point move delta \\[${delta.join(", ").replace(/\./g, "\\.")}\\] mm is below the verifiable resolution ${resolution.replace(".", "\\.")} mm at this distance from the origin \\(cv ${shown.controlPoints[0]!.cvId}\\): the read-back could not tell the move from no move; nothing was changed$`));
      return true;
    }, `${x0} m`);
    assert.equal(f.mutations(), before, "no native edit");
  }
  // Just above the resolution the move runs and reads back.
  const g = facePoints();
  const shownG = await g.operations.showFaceControlPoints(9, [g.faceId(A)], "r1v66");
  const moved = await g.operations.moveFaceControlPoints(9, [shownG.controlPoints[0]!.cvId], [0, 0, 0.002], g.revision());
  assert.equal(moved.undoSteps, 1);
});

test("face points: a verified move whose Undo depth did not change reports undoSteps null with a note", async () => {
  const f = facePoints({ stepsPerEdit: 0 });
  const shown = await f.operations.showFaceControlPoints(9, [f.faceId(A)], "r1v66");
  assert.equal(shown.undoSteps, 0, "show keeps its measured 0");
  const moved = await f.operations.moveFaceControlPoints(9, [shown.controlPoints[2]!.cvId], [0, 0, 1], f.revision());
  assert.equal(moved.undoSteps, null);
  assert.match(moved.message ?? "", /the move was read back, but the Undo depth did not change, so the number of Undo steps is unknown \(undoSteps null\)/);
});
