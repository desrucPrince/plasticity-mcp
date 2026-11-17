import assert from "node:assert/strict";
import { test } from "node:test";

import { COMMAND_SOURCE, DRAGGED_GIZMO, enableStateRead, stubPlasticity, UNTOUCHED_GIZMO, within, type StubCommand } from "./selection-safe-stub.test.ts";

// The selection guard of PlasticityRuntime.mutate (runtime.ts, SELECTION_GUARD_SOURCE) against a stub of Plasticity's
// executor and selection. Every test here fails on the code before the guard: there mutate() sends the source as it is.

type Guarded = { selectionGuardReport(): { mode: string; passThrough?: string; late?: boolean; cancelledAtEntry: string[]; cancelledWhileRunning: string[]; cancelledAtExit: string[]; saved: number; restored: number; dropped: number; restoredBy?: string; problems: string[] } | undefined };
const reportOf = (stub: ReturnType<typeof stubPlasticity>) => (stub.runtime as unknown as Guarded).selectionGuardReport?.();

test("a command returns although the selected face of an untouched body would chain a default command", async () => {
  const stub = stubPlasticity();
  stub.select("2:1f1");
  const result = await within(stub.runtime.mutate<{ ok: boolean; echo: unknown }>(COMMAND_SOURCE, [], [{ echo: 7 }]), 2_000, "mutate with a face selected");
  assert.deepEqual(result, { ok: true, echo: 7 }, "the source's own result, without the guard's envelope");
  assert.deepEqual(stub.executed, [{ name: "ServerCommand", selectionAtStart: [], activeAtStart: null }], "the server's command starts with an empty selection");
  assert.equal(stub.defaultsStarted.length, 0, "no default command was started, so nothing had to be cancelled");
  assert.deepEqual(stub.cancelCalls, []);
  assert.equal(stub.executor.active, undefined, "no command is left active");
  assert.deepEqual(stub.selection(), ["2:1f1"], "the selection is put back");
  assert.equal(stub.runtime.isUncertain(), false);
  assert.deepEqual(reportOf(stub), { mode: "guarded", cancelledAtEntry: [], cancelledWhileRunning: [], cancelledAtExit: [], saved: 1, restored: 1, dropped: 0, restoredBy: "memento", problems: [] });
  assert.deepEqual(stub.log, []);
});

test("nothing selected: the guard sends no selection change and the source sees its arguments and the editor as `this`", async () => {
  const stub = stubPlasticity();
  const before = stub.signals.selectionChanged;
  // A synchronous source, as the measurement overlay refresh is.
  assert.deepEqual(await stub.runtime.mutate("function (first, second) { return [this.marker, first, second]; }", [], [1, { two: 2 }]), ["editor", 1, { two: 2 }]);
  assert.equal(await stub.runtime.mutate("async function () {}", [], []), undefined, "a source that returns nothing still returns nothing");
  assert.deepEqual(await within(stub.runtime.mutate(COMMAND_SOURCE, [], [{}])), { ok: true, echo: null });
  assert.equal(stub.signals.selectionChanged, before);
  assert.equal(stub.selected.restoreCalls, 0);
  assert.equal(reportOf(stub)?.restoredBy, "nothing-to-restore");
});

test("the selection is put back after a successful edit: untouched items stay, items of a rebuilt body go, a whole body follows its stable id", async () => {
  const stub = stubPlasticity();
  // Body version 1 (stable 1) is untouched; version 2 (stable 5) is rebuilt as version 9.
  stub.select("2:1f1", "2:2f3", "0:2e4", "4:2", "4:1", "0:1e7");
  await within(stub.runtime.mutate(COMMAND_SOURCE, [], [{ replace: [[2, 9]] }]));
  assert.deepEqual(stub.selection(), ["2:1f1", "4:9", "4:1", "0:1e7"], "in the order they were selected");
  assert.equal(stub.executor.active, undefined);
  const report = reportOf(stub)!;
  assert.deepEqual([report.saved, report.restored, report.dropped, report.restoredBy], [6, 4, 2, "memento"]);
  assert.doesNotThrow(() => stub.selected.validate(), "no stale id is left in the selection");
  // A deleted body: everything of it goes, the rest stays.
  stub.select("4:9", "2:9f1", "2:1f1");
  await within(stub.runtime.mutate(COMMAND_SOURCE, [], [{ replace: [[9, null]] }]));
  assert.deepEqual(stub.selection(), ["2:1f1"]);
  // Everything selected is gone: the selection ends empty, and that is not a problem.
  stub.select("2:1f1");
  await within(stub.runtime.mutate(COMMAND_SOURCE, [], [{ replace: [[1, 12]] }]));
  assert.deepEqual(stub.selection(), []);
  assert.deepEqual(reportOf(stub)!.problems, []);
});

test("the selection is put back after a failed command, and the command's own error is the one thrown", async () => {
  const stub = stubPlasticity();
  stub.select("2:1f1", "4:2");
  // A failed command sends the selection back to that of the last history step (here: empty).
  await assert.rejects(within(stub.runtime.mutate(COMMAND_SOURCE, [], [{ fail: "fillet too large" }])), /^Error: Plasticity command failed: Error: fillet too large$/);
  assert.deepEqual(stub.selection(), ["2:1f1", "4:2"]);
  assert.equal(stub.executor.active, undefined);
  assert.equal(stub.runtime.isUncertain(), false, "a certain failure does not make the session uncertain");
  // The same when the last history step holds a face selection (a click of the user): the failure does not chain, the guard still restores.
  stub.setLastCommitSelection("2:2f9");
  await assert.rejects(within(stub.runtime.mutate(COMMAND_SOURCE, [], [{ fail: "boom" }])), /boom/);
  assert.deepEqual(stub.selection(), ["2:1f1", "4:2"]);
  // A source that throws before it runs any command (a validation error).
  await assert.rejects(within(stub.runtime.mutate("async function () { throw new Error('Unknown body ID: 77'); }", [], [])), /Unknown body ID: 77/);
  assert.deepEqual(stub.selection(), ["2:1f1", "4:2"]);
});

test("a default command that idles in Awaiting at entry is cancelled; a command in any other state is never cancelled", async () => {
  // 1. The user's gizmo: OffsetFaceCommand, agent automatic, Awaiting, its factory idle.
  const idle = stubPlasticity();
  idle.select("2:1f1");
  idle.startDefault("OffsetFaceCommand", "Awaiting", [{ _state: { value: "none" } }, { _state: null }]);
  assert.deepEqual(await within(idle.runtime.mutate(COMMAND_SOURCE, [], [{}])), { ok: true, echo: null });
  assert.deepEqual(idle.cancelCalls, [{ name: "OffsetFaceCommand", agent: "automatic", state: "Awaiting" }]);
  assert.deepEqual(idle.executed, [{ name: "ServerCommand", selectionAtStart: [], activeAtStart: null }], "the server's command starts after the gizmo has ended, with an empty selection");
  assert.equal(idle.executor.active, undefined);
  assert.deepEqual(idle.selection(), ["2:1f1"], "the application is left with the same selection");
  assert.deepEqual(reportOf(idle)!.cancelledAtEntry, ["OffsetFaceCommand"]);

  // 2. The same gizmo while its factory computes (the user drags it): the command reads Awaiting, and is not cancelled.
  // It is the user's work, so the edit is refused before its source runs (see the tests on a gizmo the user is editing).
  const computing = stubPlasticity();
  computing.select("2:1f1");
  computing.startDefault("OffsetFaceCommand", "Awaiting", [{ _state: { value: "updating" } }]);
  await assert.rejects(within(computing.runtime.mutate(COMMAND_SOURCE, [], [{}])), /Plasticity is busy: the user is editing with the OffsetFaceCommand gizmo/);
  assert.deepEqual(computing.cancelCalls, [], "the guard sent no cancel");
  assert.deepEqual(computing.executed, [], "the source did not run, so Plasticity's exec() did not interrupt the gizmo either");
  assert.equal(computing.executor.active?.command.constructor.name, "OffsetFaceCommand");
  assert.deepEqual(computing.selection(), ["2:1f1"]);

  // 3. A command of the user (agent user) that awaits its dialog: not a default command, not cancelled.
  const user = stubPlasticity();
  user.select("0:1e2");
  const dialog: StubCommand = { agent: "user", _state: "Awaiting", resources: [], constructor: { name: "FilletShellCommand" } };
  user.executor.active = { command: dialog };
  void user.awaitCommand(dialog);
  assert.deepEqual(await within(user.runtime.mutate(COMMAND_SOURCE, [], [{ echo: "x" }])), { ok: true, echo: "x" }, "the call returns the source's result");
  assert.deepEqual(user.cancelCalls, [], "the guard sent no cancel (the interrupt is Plasticity's own, inside exec())");
  assert.equal(reportOf(user)!.mode, "pass-through");
  assert.deepEqual(user.executed, [{ name: "ServerCommand", selectionAtStart: [], activeAtStart: "FilletShellCommand" }]);
  assert.equal(user.executor.active, undefined);
  assert.deepEqual(user.selection(), ["0:1e2"], "the interrupt sent the selection back to the last history step (nothing); the saved selection is put back");
  assert.equal(reportOf(user)!.restoredBy, "memento");

  // 3b. The same when the last history step holds that selection (a click of the user): Plasticity keeps it and shows
  // its gizmo again after the edit, as before the guard. The guard leaves both alone, and the call still returns.
  const clicked = stubPlasticity();
  clicked.select("0:1e2");
  clicked.setLastCommitSelection("0:1e2");
  const clickedDialog: StubCommand = { agent: "user", _state: "Awaiting", resources: [], constructor: { name: "FilletShellCommand" } };
  clicked.executor.active = { command: clickedDialog };
  void clicked.awaitCommand(clickedDialog);
  assert.deepEqual(await within(clicked.runtime.mutate(COMMAND_SOURCE, [], [{}])), { ok: true, echo: null });
  assert.deepEqual(clicked.cancelCalls, []);
  assert.deepEqual(clicked.selection(), ["0:1e2"]);
  assert.equal(clicked.executor.active?.command.agent, "automatic", "the default command Plasticity chained for the first exec()");
  assert.equal(reportOf(clicked)!.restoredBy, "left");

  // 4. A default command that is not Awaiting (still starting) and never gets there: not cancelled either.
  const starting = stubPlasticity();
  starting.select("2:1f1");
  starting.startDefault("PushFaceCommand", "None");
  assert.deepEqual(await within(starting.runtime.mutate(COMMAND_SOURCE, [], [{}]), 5_000), { ok: true, echo: null });
  assert.deepEqual(starting.cancelCalls, []);
  assert.equal(reportOf(starting)!.mode, "pass-through");
  assert.deepEqual(starting.selection(), ["2:1f1"]);
});

test("a command of the source that is still active when the source returns: the result comes back, and the selection is put back when that command ends", async () => {
  const stub = stubPlasticity();
  stub.select("2:1f1", "4:2");
  // A pick command that was left to finish (its outcome is undetermined): the source returns with it active.
  const source = `async function () {
    await this.exec(new this.commands.ServerCommand());
    this.executor.active = { command: { agent: 'user', _state: 'None', resources: [], constructor: { name: 'AlignEdgeCommand' } } };
    return 'left running';
  }`;
  assert.equal(await within(stub.runtime.mutate(source, [], [])), "left running");
  assert.equal(stub.executor.active?.command.constructor.name, "AlignEdgeCommand", "the guard did not cancel it");
  assert.deepEqual(stub.cancelCalls, []);
  assert.deepEqual(stub.selection(), [], "the selection is that command's own while it runs");
  assert.equal(reportOf(stub)!.restoredBy, "deferred");
  assert.match(stub.log.join("\n"), /AlignEdgeCommand is still active; the selection is put back when it ends/);
  stub.executor.active = undefined;
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(stub.selection(), ["2:1f1", "4:2"]);
});

test("a default command that appears while the source is pending is cancelled, so the call returns", async () => {
  // The source's own command leaves a face selected (as a click during the call would): the executor chains.
  const stub = stubPlasticity();
  const result = await within(stub.runtime.mutate(COMMAND_SOURCE, [], [{ select: ["2:1f1"] }]), 2_000, "mutate behind a chained default command");
  assert.deepEqual(result, { ok: true, echo: null });
  assert.deepEqual(stub.cancelCalls, [{ name: "OffsetFaceCommand", agent: "automatic", state: "Awaiting" }]);
  assert.deepEqual(reportOf(stub)!.cancelledWhileRunning, ["OffsetFaceCommand"]);
  assert.equal(stub.executor.active, undefined);
  assert.deepEqual(stub.selection(), [], "the selection of before the call (none) is put back");
});

test("a history step that restores a selection and chains a default command: the call returns, the command is cancelled, the user's selection is back", async () => {
  const stub = stubPlasticity();
  // The step also takes body version 2 back to version 8, in a new geometry model object.
  stub.history.undoStack.push({ selection: new Set(["2:1f3"]), replace: [[2, 8]] });
  stub.select("4:1", "4:2", "2:2f5");
  // stepHistory's shape: the undo() promise is not awaited, the step counts as applied once the stack has shrunk.
  const source = `async function () {
    const before = this.history.undoStack.length;
    this.undo().then(() => {}, () => {});
    while (this.history.undoStack.length >= before) await new Promise(resolve => setTimeout(resolve, 5));
    return 'applied';
  }`;
  assert.equal(await within(stub.runtime.mutate(source, [], [])), "applied");
  assert.deepEqual(stub.cancelCalls, [{ name: "OffsetFaceCommand", agent: "automatic", state: "Awaiting" }]);
  assert.deepEqual(reportOf(stub)!.cancelledAtExit, ["OffsetFaceCommand"]);
  assert.equal(stub.executor.active, undefined);
  assert.deepEqual(stub.selection(), ["4:1", "4:8"], "the whole body follows its stable id into the restored document; the face of the replaced version goes");
  assert.deepEqual(stub.log, []);
});

test("a restore that fails does not lose the call's result: the items are added again and the failure is logged", async () => {
  // Plasticity refuses the memento: the guard falls back to adding the items, and says so in the log.
  const stub = stubPlasticity({ restoreThrows: true });
  stub.select("2:1f1", "4:2");
  assert.deepEqual(await within(stub.runtime.mutate(COMMAND_SOURCE, [], [{ echo: "kept" }])), { ok: true, echo: "kept" });
  assert.deepEqual(stub.selection().sort(), ["2:1f1", "4:2"], "the selection is not left empty while its items exist");
  assert.equal(reportOf(stub)!.restoredBy, "items");
  assert.ok(stub.log.length > 0 && stub.log.every((line) => line.startsWith("[plasticity-mcp] selection guard: ")), "every problem is one log line");
  assert.match(stub.log.join("\n"), /the selection memento was not accepted: restore refused/);

  // Nothing works (the memento and add() both throw): the result still comes back, the log says the selection is empty.
  const broken = stubPlasticity({ restoreThrows: true, addThrows: true });
  broken.select("2:1f1");
  assert.deepEqual(await within(broken.runtime.mutate(COMMAND_SOURCE, [], [{ echo: 1 }])), { ok: true, echo: 1 });
  assert.deepEqual(broken.selection(), []);
  assert.match(broken.log.join("\n"), /the selection could not be put back and is empty \(1 of its 1 items still exist\)/);
  assert.equal(broken.runtime.isUncertain(), false);

  // The source fails and the restore fails: the source's error is thrown; the guard's problems reach the log with the next call.
  const both = stubPlasticity({ restoreThrows: true, addThrows: true });
  both.select("2:1f1");
  await assert.rejects(within(both.runtime.mutate(COMMAND_SOURCE, [], [{ fail: "no effect" }])), /^Error: Plasticity command failed: Error: no effect$/);
  assert.deepEqual(both.log, []);
  both.select();
  assert.deepEqual(await within(both.runtime.mutate(COMMAND_SOURCE, [], [{}])), { ok: true, echo: null });
  assert.match(both.log.join("\n"), /the selection could not be put back and is empty/);
});

test("a build without the selection memento runs the source as before", async () => {
  const stub = stubPlasticity();
  (stub.selected as unknown as { saveToMemento?: unknown }).saveToMemento = undefined;
  assert.deepEqual(await within(stub.runtime.mutate(COMMAND_SOURCE, [], [{ echo: 3 }])), { ok: true, echo: 3 });
  assert.equal(reportOf(stub)!.mode, "pass-through");
});

test("reconcile clears a default command a timed-out call left Awaiting, says so, and never repeats the mutation", async () => {
  const withState = enableStateRead;

  // The state a hung call leaves: the edit committed, OffsetFaceCommand Awaiting, the session uncertain.
  const stub = stubPlasticity();
  withState(stub);
  stub.select("2:1f1");
  stub.startDefault("OffsetFaceCommand", "Awaiting");
  stub.runtime.markUncertain();
  const callsBefore = stub.cdpCalls();
  await assert.rejects(stub.runtime.mutate(COMMAND_SOURCE, [], [{}]), /Previous mutation outcome is uncertain; call reconcile before another mutation/);
  assert.equal(stub.cdpCalls(), callsBefore, "an uncertain session sends nothing to Plasticity");
  const reconciled = await within(stub.runtime.reconcile()) as { revision: string; recovery?: { cancelledDefaultCommands?: string[]; activeCommand?: unknown; note: string } };
  assert.deepEqual(reconciled.recovery?.cancelledDefaultCommands, ["OffsetFaceCommand"]);
  assert.match(reconciled.recovery!.note, /Cancelled OffsetFaceCommand: an idle default command .* No edit was undone or repeated, and the selection was kept\./);
  assert.equal(reconciled.recovery!.activeCommand, undefined);
  assert.deepEqual(stub.cancelCalls, [{ name: "OffsetFaceCommand", agent: "automatic", state: "Awaiting" }]);
  assert.equal(stub.executor.active, undefined);
  assert.deepEqual(stub.selection(), ["2:1f1"]);
  assert.deepEqual(stub.executed, [], "reconcile ran no command: nothing was retried or undone");
  assert.equal(stub.history.undoStack.length, 0);
  assert.equal(stub.runtime.isUncertain(), false);
  assert.match(reconciled.revision, /^r0\./);

  // Nothing active: the reply has no recovery field.
  const idle = stubPlasticity();
  withState(idle);
  assert.equal("recovery" in await idle.runtime.reconcile(), false);

  // A command that is not an idle default command is reported and left alone.
  const busy = stubPlasticity();
  withState(busy);
  busy.executor.active = { command: { agent: "user", _state: "Awaiting", resources: [], constructor: { name: "BooleanCommand" } } };
  const left = await busy.runtime.reconcile() as { recovery?: { cancelledDefaultCommands?: string[]; activeCommand?: unknown; note: string } };
  assert.deepEqual(left.recovery?.activeCommand, { name: "BooleanCommand", state: "Awaiting", default: false });
  assert.equal(left.recovery?.cancelledDefaultCommands, undefined);
  assert.match(left.recovery!.note, /BooleanCommand is still active \(state Awaiting\) and was not touched/);
  assert.deepEqual(busy.cancelCalls, []);
  assert.equal(busy.executor.active?.command.constructor.name, "BooleanCommand");
});

// ---- A default gizmo the user is editing (D1): nothing cancels it.

test("a default gizmo the user has dragged is not cancelled at entry: the edit is refused before it runs, and says why", async () => {
  // Three signs of the user's work, each alone: the factory left "none" with a preview, the command's own flag, a temp.
  const signs: Array<[string, (command: StubCommand) => void]> = [
    ["factory updated, one temp", (command) => { command.resources = DRAGGED_GIZMO(); }],
    ["the command flags its factory as changed", (command) => { command._isFactoryChanged = true; }],
    ["a temporary object in a factory that still reads none", (command) => { command.resources = [{ _state: { value: "none" }, temps: new Set([1]) }]; }],
  ];
  for (const [label, touch] of signs) {
    const stub = stubPlasticity();
    stub.select("0:1e2");
    const gizmo = stub.startDefault("FilletShellCommand", "Awaiting", UNTOUCHED_GIZMO());
    touch(gizmo);
    const before = stub.signals.selectionChanged;
    await assert.rejects(within(stub.runtime.mutate(COMMAND_SOURCE, [], [{}])), (error: Error) => {
      assert.match(error.message, /^Plasticity command failed: Error: Plasticity is busy: the user is editing with the FilletShellCommand gizmo \(it holds a preview with changes that are not committed\)\. Finish or cancel that gizmo in Plasticity, then repeat this call\. Nothing was changed, and the gizmo and its preview were left as they are\.$/, label);
      return true;
    }, label);
    assert.deepEqual(stub.cancelCalls, [], label);
    assert.deepEqual(stub.executed, [], `${label}: the source never ran`);
    assert.equal(stub.executor.active?.command, gizmo, `${label}: the gizmo is still the active command`);
    assert.equal(gizmo._state, "Awaiting", label);
    assert.deepEqual(stub.selection(), ["0:1e2"], label);
    assert.equal(stub.signals.selectionChanged, before, `${label}: the selection was not emptied and put back`);
    assert.equal(stub.runtime.isUncertain(), false, `${label}: a refusal is a certain error`);
  }
  // The same gizmo untouched is the idle one: cancelled, and the edit runs.
  const idle = stubPlasticity();
  idle.select("0:1e2");
  idle.startDefault("FilletShellCommand", "Awaiting", UNTOUCHED_GIZMO());
  assert.deepEqual(await within(idle.runtime.mutate(COMMAND_SOURCE, [], [{}])), { ok: true, echo: null });
  assert.deepEqual(idle.cancelCalls, [{ name: "FilletShellCommand", agent: "automatic", state: "Awaiting" }]);
});

test("a read, a source that runs no command (an export, a saved copy) and reconcile leave a gizmo alone, dragged or not", async () => {
  for (const resources of [DRAGGED_GIZMO, UNTOUCHED_GIZMO]) {
    const stub = stubPlasticity();
    enableStateRead(stub);
    stub.select("0:1e2");
    const gizmo = stub.startDefault("FilletShellCommand", "Awaiting", resources());
    const before = stub.signals.selectionChanged;
    // A read.
    assert.equal(await stub.runtime.read("function () { return this.marker; }"), "editor");
    // A mutate() source without a command, as plasticity_save_copy, the exports and the section analyses send: it
    // reaches the renderer as it is, without the guard around it.
    const quiet = "async function (args) { return { saved: args.path }; }";
    assert.deepEqual(await stub.runtime.mutate(quiet, [], [{ path: "/tmp/copy.plasticity" }]), { saved: "/tmp/copy.plasticity" });
    assert.equal(stub.sent.at(-1), quiet);
    assert.deepEqual(stub.cancelCalls, []);
    assert.equal(stub.executor.active?.command, gizmo);
    assert.deepEqual(stub.selection(), ["0:1e2"]);
    assert.equal(stub.signals.selectionChanged, before);
  }
  // reconcile: an untouched gizmo left behind is cancelled (the recovery); a dragged one is reported and left.
  const dragged = stubPlasticity();
  enableStateRead(dragged);
  dragged.select("0:1e2");
  const gizmo = dragged.startDefault("FilletShellCommand", "Awaiting", DRAGGED_GIZMO());
  const reply = await dragged.runtime.reconcile() as { recovery?: { cancelledDefaultCommands?: string[]; activeCommand?: unknown; note: string } };
  assert.deepEqual(dragged.cancelCalls, []);
  assert.equal(dragged.executor.active?.command, gizmo);
  assert.equal(reply.recovery?.cancelledDefaultCommands, undefined);
  assert.deepEqual(reply.recovery?.activeCommand, { name: "FilletShellCommand", state: "Awaiting", default: true, edited: true });
  assert.match(reply.recovery!.note, /FilletShellCommand is active and holds changes the user made \(the preview of its gizmo\); it was not touched\./);
  // What the live window does while that preview is held: Plasticity refuses the snapshot the state read takes. A
  // read says what that means; reconcile names the command it left, and the session stays as it was.
  Object.assign(dragged.editor, { measurements: { snapshot: () => { throw new Error("snapshot(): scratch active"); } } });
  Reflect.set(dragged.runtime, "uncertain", true);
  await assert.rejects(dragged.runtime.getState(), /^Error: Plasticity is busy: the user is editing in Plasticity \(a gizmo or a command holds a preview with changes that are not committed\), so the document cannot be read right now\. Finish or cancel it in Plasticity, then repeat this call\. Nothing was changed/);
  await assert.rejects(dragged.runtime.reconcile(), /^Error: Plasticity is busy: the user is editing, so the document cannot be read and the session was not reconciled\. FilletShellCommand is active and holds changes the user made \(the preview of its gizmo\); it was not touched\.[\s\S]*Repeat plasticity_reconcile after the user has finished or cancelled it/);
  assert.deepEqual(dragged.cancelCalls, []);
  assert.equal(dragged.executor.active?.command, gizmo);
  assert.equal(dragged.runtime.isUncertain(), true);
});

test("the watcher does not cancel a gizmo the user is dragging while a source is pending", async () => {
  const stub = stubPlasticity();
  // The source waits; meanwhile the user starts a gizmo and drags it.
  const source = `async function () { await this.exec(new this.commands.ServerCommand()); await new Promise(resolve => { this.__release = resolve; }); return 'done'; }`;
  const pending = stub.runtime.mutate(source, [], []);
  await new Promise((resolve) => setTimeout(resolve, 20));
  stub.select("0:1e2");
  const gizmo = stub.startDefault("FilletShellCommand", "Awaiting", DRAGGED_GIZMO());
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(stub.cancelCalls, [], "five checks of the watcher went by");
  assert.equal(stub.executor.active?.command, gizmo);
  (stub.editor as unknown as { __release(): void }).__release();
  assert.equal(await within(pending), "done");
  assert.deepEqual(stub.cancelCalls, []);
});

// ---- A source that outlives its call (D2).

const HANGING = `async function () { await this.exec(new this.commands.ServerCommand()); await new Promise(resolve => { this.__release = resolve; }); return 'late'; }`;
const release = (stub: ReturnType<typeof stubPlasticity>) => (stub.editor as unknown as { __release(): void }).__release();

test("the watcher stops with the call: after a return, and at the budget of a call that was given up", async () => {
  // After a normal return a gizmo is nobody's business.
  const returned = stubPlasticity();
  await within(returned.runtime.mutate(COMMAND_SOURCE, [], [{}]));
  returned.select("0:1e2");
  returned.startDefault("FilletShellCommand", "Awaiting", UNTOUCHED_GIZMO());
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(returned.cancelCalls, []);

  // A source that does not settle within its call's timeout (120 ms here): the call is given up, the source goes on.
  const stub = stubPlasticity();
  stub.select("2:1f1");
  await assert.rejects(stub.runtime.mutate(HANGING, [], [], 120), /CDP request timed out/);
  assert.equal(stub.runtime.isUncertain(), true);
  // The user now clicks an edge: Plasticity starts its idle gizmo. The abandoned guard must not cancel it.
  stub.select("0:2e5");
  const gizmo = stub.startDefault("FilletShellCommand", "Awaiting", UNTOUCHED_GIZMO());
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(stub.cancelCalls, [], "no watcher runs past the budget");
  assert.equal(stub.executor.active?.command, gizmo);
  // The source settles at last: the selection the user made in the meantime stays; the stale one is not put back.
  release(stub);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(stub.selection(), ["0:2e5"]);
  assert.equal(stub.executor.active?.command, gizmo);
  assert.deepEqual(stub.cancelCalls, []);
});

test("a source that settles late puts the saved selection back only into the empty selection the guard left", async () => {
  const stub = stubPlasticity();
  stub.select("2:1f1", "4:2");
  await assert.rejects(stub.runtime.mutate(HANGING, [], [], 80), /CDP request timed out/);
  assert.deepEqual(stub.selection(), [], "set aside while the source is pending");
  await new Promise((resolve) => setTimeout(resolve, 60));
  release(stub);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(stub.selection(), ["2:1f1", "4:2"], "nobody selected anything in the meantime: it comes back");

  // The user selects something else after the call was given up (no gizmo, a plain selection): it stays when the
  // source settles, and the stale selection is not put back over it.
  const newer = stubPlasticity();
  newer.select("2:1f1", "4:2");
  await assert.rejects(newer.runtime.mutate(HANGING, [], [], 80), /CDP request timed out/);
  newer.select("0:2e5");
  await new Promise((resolve) => setTimeout(resolve, 60));
  release(newer);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(newer.selection(), ["0:2e5"], "the newer selection of the user wins");
  assert.deepEqual(newer.cancelCalls, []);
});

test("reconcile puts an abandoned guard's selection back into an empty selection, says so, and leaves a newer selection alone", async () => {
  type Reply = { recovery?: { restoredSelection?: number; cancelledDefaultCommands?: string[]; note: string } };
  // 1. Nothing selected since: reconcile puts the saved selection back.
  const empty = stubPlasticity();
  enableStateRead(empty);
  empty.select("2:1f1", "4:2");
  await assert.rejects(empty.runtime.mutate(HANGING, [], [], 80), /CDP request timed out/);
  assert.deepEqual(empty.selection(), []);
  const repaired = await within(empty.runtime.reconcile()) as Reply;
  assert.equal(repaired.recovery?.restoredSelection, 2);
  assert.match(repaired.recovery!.note, /Put back the selection \(2 items\) that a call which timed out had set aside\./);
  assert.deepEqual(empty.selection(), ["2:1f1", "4:2"]);
  assert.equal(empty.runtime.isUncertain(), false);
  // The user deselects; the source settles afterwards: the selection that reconcile already handed back does not return.
  empty.select();
  release(empty);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(empty.selection(), []);
  assert.equal("recovery" in await empty.runtime.reconcile(), false, "nothing is left to repair");

  // 2. The user selected something else: reconcile leaves it and says the saved selection was not put back.
  const newer = stubPlasticity();
  enableStateRead(newer);
  newer.select("2:1f1");
  await assert.rejects(newer.runtime.mutate(HANGING, [], [], 80), /CDP request timed out/);
  newer.select("0:2e5");
  const left = await within(newer.runtime.reconcile()) as Reply;
  assert.equal(left.recovery?.restoredSelection, undefined);
  assert.match(left.recovery!.note, /A call that timed out had set aside a selection of 1 item; it was not put back, because something else is selected now\./);
  assert.deepEqual(newer.selection(), ["0:2e5"]);
  release(newer);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(newer.selection(), ["0:2e5"]);
});
