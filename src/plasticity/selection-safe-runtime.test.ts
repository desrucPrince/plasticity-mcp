import assert from "node:assert/strict";
import { test } from "node:test";

import { COMMAND_SOURCE, enableStateRead, stubPlasticity, within, type StubCommand } from "./selection-safe-stub.test.ts";

// The selection guard of PlasticityRuntime.mutate (runtime.ts, SELECTION_GUARD_SOURCE) against a stub of Plasticity's
// executor and selection. Every test here fails on the code before the guard: there mutate() sends the source as it is.

type Guarded = { selectionGuardReport(): { mode: string; passThrough?: string; cancelledAtEntry: string[]; cancelledWhileRunning: string[]; cancelledAtExit: string[]; saved: number; restored: number; dropped: number; restoredBy?: string; problems: string[] } | undefined };
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
  const computing = stubPlasticity();
  computing.select("2:1f1");
  computing.startDefault("OffsetFaceCommand", "Awaiting", [{ _state: { value: "updating" } }]);
  assert.deepEqual(await within(computing.runtime.mutate(COMMAND_SOURCE, [], [{}])), { ok: true, echo: null });
  assert.deepEqual(computing.cancelCalls, [], "the guard sent no cancel");
  assert.equal(reportOf(computing)!.mode, "pass-through");
  assert.match(reportOf(computing)!.passThrough!, /OffsetFaceCommand is active \(state Awaiting\)/);
  assert.deepEqual(computing.executed, [{ name: "ServerCommand", selectionAtStart: [], activeAtStart: "OffsetFaceCommand" }], "the source ran as it does without the guard: Plasticity's exec() interrupted the gizmo");
  assert.equal(computing.executor.active, undefined);
  assert.deepEqual(computing.selection(), ["2:1f1"], "the interrupt emptied the selection; it is put back");

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
  const source = `function () {
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
