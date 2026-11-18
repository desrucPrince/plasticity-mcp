import assert from "node:assert/strict";
import { test } from "node:test";

import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

// plasticity_undo / plasticity_redo with many steps: one history step per CDP request, one document read at the end,
// and a definite count when a request times out part-way (PlasticityOperations.stepHistoryMany).

const construction: RuntimeState["construction"] = { planes: [], activePlaneId: "standard:top", planeStateToken: "planes:empty", viewStateToken: "workplane:standard:top" };
const TIMEOUT = "CDP request timed out: Runtime.callFunctionOn";

type Fate = Record<string, unknown> | "throw";

/** A runtime whose page applies one history step per mutate(); `timeoutAt` makes that request (1-based) time out. */
function fakeRuntime(options: { undoDepth?: number; redoDepth?: number; timeoutAt?: number; appliedBeforeTimeout?: boolean; fate?: (depths: { undoDepth: number; redoDepth: number }) => Fate; reconcile?: "throw" | "moved"; failAt?: number } = {}) {
  let undoDepth = options.undoDepth ?? 0;
  let redoDepth = options.redoDepth ?? 0;
  let uncertain = false;
  const log: string[] = [];
  const steps: Array<{ source: string; direction: string; token: unknown; timeoutMs: unknown; settleMs: unknown; cdpTimeout: unknown }> = [];
  const fateReads: Array<{ source: string; args: Record<string, unknown>; cdpTimeout: unknown }> = [];
  const state = (): RuntimeState => ({ targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: `r-${undoDepth}-${redoDepth}`, dbVersion: 1, undoDepth, redoDepth, construction, regions: [], bodies: [] });
  const apply = (direction: string) => {
    if (direction === "undo") { undoDepth -= 1; redoDepth += 1; } else { undoDepth += 1; redoDepth -= 1; }
  };
  const runtime = {
    isUncertain: () => uncertain,
    markUncertain() { uncertain = true; log.push("markUncertain"); },
    mutationCount: () => steps.length,
    async getState() { log.push("getState"); return state(); },
    async mutate(source: string, _bindings: string[], values: unknown[], cdpTimeout?: number) {
      if (uncertain) throw new Error("Previous mutation outcome is uncertain; call reconcile before another mutation");
      const args = values[0] as { direction: string; token?: string; timeoutMs: number; settleMs: number };
      steps.push({ source, direction: args.direction, token: args.token, timeoutMs: args.timeoutMs, settleMs: args.settleMs, cdpTimeout });
      log.push(`step ${steps.length}`);
      if (options.failAt === steps.length) throw new Error("Plasticity command failed: Error: Plasticity is busy");
      const depth = args.direction === "undo" ? undoDepth : redoDepth;
      if (options.timeoutAt === steps.length) {
        if (options.appliedBeforeTimeout !== false && depth > 0) apply(args.direction);
        uncertain = true;
        throw new Error(TIMEOUT);
      }
      if (depth === 0) return { outcome: "empty", undoDepth, redoDepth };
      apply(args.direction);
      return { outcome: "resolved", undoDepth, redoDepth };
    },
    async read(source: string, values: unknown[], cdpTimeout?: number) {
      fateReads.push({ source, args: values[0] as Record<string, unknown>, cdpTimeout });
      log.push("fate");
      const fate = options.fate ? options.fate({ undoDepth, redoDepth }) : { known: true, running: false, started: true, settled: true, rejected: null, outcome: "resolved", moved: true, busy: false, undoDepth, redoDepth };
      if (fate === "throw") throw new Error(TIMEOUT);
      return fate;
    },
    async reconcile() {
      log.push("reconcile");
      if (options.reconcile === "throw") throw new Error(TIMEOUT);
      if (options.reconcile === "moved") undoDepth += 3; // somebody edited the document between the two reads
      uncertain = false;
      return state();
    },
  };
  return { runtime: runtime as unknown as PlasticityRuntime, steps, fateReads, log, uncertain: () => uncertain, depths: () => ({ undoDepth, redoDepth }) };
}

test("600 undo steps and 600 redo steps: one history step per request, one document read at the end", async () => {
  const f = fakeRuntime({ undoDepth: 601 });
  const operations = new PlasticityOperations(f.runtime);
  const undone = await operations.stepHistoryMany("undo", 600, "r-601-0");
  assert.deepEqual({ ...undone, state: undefined }, { state: undefined, direction: "undo", stepsRequested: 600, stepsDone: 600, stepsRemaining: 0 });
  assert.equal(undone.state.undoDepth, 1);
  assert.equal(undone.state.redoDepth, 600);
  assert.equal(f.steps.length, 600, "600 requests for 600 steps");
  assert.ok(f.steps.every((step) => step.direction === "undo" && step.timeoutMs === 10_000 && step.settleMs === 250));
  assert.equal(new Set(f.steps.map((step) => step.token)).size, 600, "every request carries its own token");
  // The request keeps the client's own limit (10 s); nothing stretches it.
  assert.ok(f.steps.every((step) => step.cdpTimeout === undefined));
  // The page side of every request is the same one-step source: no loop over steps in the page.
  assert.equal(new Set(f.steps.map((step) => step.source)).size, 1);
  assert.doesNotMatch(f.steps[0]!.source, /args\.steps|args\.count/);
  // The document is read for the revision check and once at the end, not after every step.
  assert.equal(f.log.filter((entry) => entry === "getState").length, 2);
  assert.deepEqual(f.log.slice(0, 2), ["getState", "step 1"]);
  assert.deepEqual(f.log.slice(-2), ["step 600", "getState"]);
  assert.equal(f.fateReads.length, 0);

  const redone = await operations.stepHistoryMany("redo", 600, undone.state.revision);
  assert.deepEqual([redone.stepsDone, redone.stepsRemaining, redone.stopped], [600, 0, undefined]);
  assert.deepEqual(f.depths(), { undoDepth: 601, redoDepth: 0 });
  assert.equal(f.steps.length, 1200);
  await assert.rejects(operations.stepHistoryMany("undo", 5, "stale"), /Stale reference/);
  await assert.rejects(operations.stepHistoryMany("undo", 0, redone.state.revision), /positive integer/);
});

test("the run stops when the history runs out and says so", async () => {
  const f = fakeRuntime({ undoDepth: 3 });
  const run = await new PlasticityOperations(f.runtime).stepHistoryMany("undo", 10, "r-3-0");
  assert.deepEqual([run.stepsRequested, run.stepsDone, run.stepsRemaining, run.stopped], [10, 3, 7, "history-empty"]);
  assert.equal(run.state.undoDepth, 0);
  assert.equal(f.steps.length, 4, "three steps and the request that found the history empty");
});

test("a request that times out part-way: the step's fate is read, the session is reconciled, and the count is definite", async () => {
  // Request 251 of 600 times out; the page had applied that step.
  const applied = fakeRuntime({ undoDepth: 700, timeoutAt: 251 });
  const run = await new PlasticityOperations(applied.runtime).stepHistoryMany("undo", 600, "r-700-0");
  assert.deepEqual([run.stepsRequested, run.stepsDone, run.stepsRemaining, run.stopped, run.timeout], [600, 251, 349, "timed-out", TIMEOUT]);
  assert.equal(run.state.undoDepth, 449);
  assert.equal(run.state.redoDepth, 251);
  assert.equal(run.state.revision, "r-449-251");
  // It stopped there: no request after the one that timed out, no retry.
  assert.equal(applied.steps.length, 251);
  assert.deepEqual(applied.log.slice(-4), ["step 251", "fate", "reconcile", "getState"]);
  assert.equal(applied.uncertain(), false, "the depth was read, so no reconcile is left to the caller");
  // The fate read names the request it asks about and waits for it less long than its own CDP limit.
  assert.equal(applied.fateReads.length, 1);
  assert.equal(applied.fateReads[0]!.args.token, applied.steps[250]!.token);
  assert.ok(Number(applied.fateReads[0]!.args.waitMs) > 0 && Number(applied.fateReads[0]!.args.waitMs) < Number(applied.fateReads[0]!.cdpTimeout));
  assert.doesNotMatch(applied.fateReads[0]!.source, /\.undo\(\)|\.redo\(\)|\[args\.direction\]\(\)|\.exec\(/, "the fate read runs no command");

  // The same time-out, but the page says the step never started (Plasticity was busy): 250 done, not 251.
  const notStarted = fakeRuntime({ undoDepth: 700, timeoutAt: 251, appliedBeforeTimeout: false, fate: (depths) => ({ known: true, running: false, started: false, settled: false, rejected: null, outcome: null, moved: false, busy: true, ...depths }) });
  const second = await new PlasticityOperations(notStarted.runtime).stepHistoryMany("undo", 600, "r-700-0");
  assert.deepEqual([second.stepsDone, second.stepsRemaining, second.stopped], [250, 350, "timed-out"]);
  assert.equal(second.state.undoDepth, 450);
  assert.equal(notStarted.uncertain(), false);

  // The native promise was rejected and the stack did not move: not applied.
  const rejected = fakeRuntime({ undoDepth: 10, timeoutAt: 4, appliedBeforeTimeout: false, fate: (depths) => ({ known: true, running: false, started: true, settled: false, rejected: "native failure", outcome: null, moved: false, busy: false, ...depths }) });
  const third = await new PlasticityOperations(rejected.runtime).stepHistoryMany("undo", 8, "r-10-0");
  assert.deepEqual([third.stepsDone, third.stepsRemaining, third.stopped], [3, 5, "timed-out"]);

  // Redo: the step counted itself as applied while its promise stayed pending (a default command awaits).
  const redo = fakeRuntime({ undoDepth: 1, redoDepth: 9, timeoutAt: 2, fate: (depths) => ({ known: true, running: false, started: true, settled: false, rejected: null, outcome: "applied", moved: true, busy: true, ...depths }) });
  const fourth = await new PlasticityOperations(redo.runtime).stepHistoryMany("redo", 9, "r-1-9");
  assert.deepEqual([fourth.stepsDone, fourth.stepsRemaining, fourth.stopped], [2, 7, "timed-out"]);
  assert.deepEqual([fourth.state.undoDepth, fourth.state.redoDepth], [3, 7]);
});

test("a time-out whose outcome cannot be proven stays uncertain, as before", async () => {
  const cases: Array<[string, Parameters<typeof fakeRuntime>[0]]> = [
    ["the step is still running", { fate: (depths) => ({ known: true, running: true, started: true, settled: false, rejected: null, outcome: null, moved: false, busy: true, ...depths }) }],
    ["the page has no record of the request", { fate: (depths) => ({ known: false, ...depths }) }],
    ["the native promise is still pending and the step made no decision", { fate: (depths) => ({ known: true, running: false, started: true, settled: false, rejected: null, outcome: null, moved: true, busy: false, ...depths }) }],
    ["the promise settled but the stack did not move", { appliedBeforeTimeout: false, fate: (depths) => ({ known: true, running: false, started: true, settled: true, rejected: null, outcome: "resolved", moved: false, busy: false, ...depths }) }],
    ["the depths do not match the count", { fate: (depths) => ({ known: true, running: false, started: true, settled: true, rejected: null, outcome: "resolved", moved: true, busy: false, undoDepth: depths.undoDepth - 2, redoDepth: depths.redoDepth }) }],
    ["the fate read times out too", { fate: () => "throw" }],
    ["the reconcile read fails", { reconcile: "throw" }],
  ];
  for (const [name, options] of cases) {
    const f = fakeRuntime({ undoDepth: 50, timeoutAt: 7, ...options });
    await assert.rejects(new PlasticityOperations(f.runtime).stepHistoryMany("undo", 40, "r-50-0"), (error: Error) => {
      assert.equal(error.message, TIMEOUT, name);
      return true;
    });
    assert.equal(f.uncertain(), true, `${name}: the session stays uncertain`);
    assert.equal(f.steps.length, 7, `${name}: nothing was sent after the time-out`);
    assert.equal(f.log.includes("reconcile"), name === "the reconcile read fails", name);
  }
  // The document moved between the fate read and the reconcile read: the session is marked uncertain again.
  const moved = fakeRuntime({ undoDepth: 50, timeoutAt: 7, reconcile: "moved" });
  await assert.rejects(new PlasticityOperations(moved.runtime).stepHistoryMany("undo", 40, "r-50-0"), new RegExp(TIMEOUT));
  assert.deepEqual(moved.log.slice(-3), ["fate", "reconcile", "markUncertain"]);
  assert.equal(moved.uncertain(), true);
});

test("an error that is not a time-out fails the run without a fate read; undo() and redo() are one step and one read as before", async () => {
  const f = fakeRuntime({ undoDepth: 9, failAt: 3 });
  const operations = new PlasticityOperations(f.runtime);
  await assert.rejects(operations.stepHistoryMany("undo", 5, "r-9-0"), /Plasticity is busy/);
  assert.equal(f.fateReads.length, 0);
  assert.equal(f.uncertain(), false);
  assert.equal(f.steps.length, 3);

  const single = fakeRuntime({ undoDepth: 2, timeoutAt: 2 });
  const one = new PlasticityOperations(single.runtime);
  const state = await one.undo("r-2-0");
  assert.equal(state.undoDepth, 1);
  assert.equal(single.steps[0]!.token, undefined, "the single step of a recipe keeps no fate record");
  // A recipe's own undo that times out is uncertain, exactly as before: no fate read, no reconcile.
  await assert.rejects(one.undo(), new RegExp(TIMEOUT));
  assert.equal(single.uncertain(), true);
  assert.deepEqual(single.log.slice(-1), ["step 2"]);
});

// ---------- the page side: the real sources against a stub of the editor ----------

type Mode = "settle" | "pending" | "reject" | "held";
function stubEditor(mode: Mode, undoDepth = 3) {
  let release: () => void = () => {};
  const editor = {
    executor: { isBusy: false, active: undefined as undefined | { command: { agent: string; _state: string } } },
    history: { undoStack: Array.from({ length: undoDepth }, (_, index) => index), redoStack: [] as number[] },
    calls: 0,
    release() { release(); },
    async step(from: number[], to: number[]) {
      editor.calls += 1;
      await Promise.resolve();
      if (mode === "reject") throw new Error("native failure");
      if (mode === "held") await new Promise<void>((resolve) => { release = resolve; });
      to.push(from.pop()!);
      if (mode === "pending") {
        // The history state holds a face selection: the default command of it awaits (the executor does not read busy
        // for it, as in selection-safe-stub.test.ts), and the promise never settles.
        editor.executor.active = { command: { agent: "automatic", _state: "Awaiting" } };
        await new Promise(() => {});
      }
    },
    undo() { return editor.step(editor.history.undoStack, editor.history.redoStack); },
    redo() { return editor.step(editor.history.redoStack, editor.history.undoStack); },
  };
  return editor;
}
const compile = (source: string) => (0, eval)(`(${source})`) as (this: unknown, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** The two page sources, as PlasticityOperations sends them. */
async function pageSources() {
  const f = fakeRuntime({ undoDepth: 5, timeoutAt: 1 });
  await new PlasticityOperations(f.runtime).stepHistoryMany("undo", 1, "r-5-0");
  return { step: compile(f.steps[0]!.source), fate: compile(f.fateReads[0]!.source) };
}

test("the page's step ends when the native promise settles, without waiting for a timer, and returns the depths", async () => {
  const { step, fate } = await pageSources();
  const editor = stubEditor("settle");
  const started = performance.now();
  const results = [];
  for (let index = 0; index < 3; index += 1) results.push(await step.call(editor, { direction: "undo", timeoutMs: 10_000, settleMs: 250, token: `t${index}` }));
  const elapsed = performance.now() - started;
  assert.deepEqual(results, [{ outcome: "resolved", undoDepth: 2, redoDepth: 1 }, { outcome: "resolved", undoDepth: 1, redoDepth: 2 }, { outcome: "resolved", undoDepth: 0, redoDepth: 3 }]);
  // Before, every step waited for its first 25 ms timer: three steps took 75 ms or more.
  assert.ok(elapsed < 60, `three settled steps took ${elapsed.toFixed(1)} ms`);
  assert.deepEqual(await step.call(editor, { direction: "undo", timeoutMs: 10_000, settleMs: 250, token: "t3" }), { outcome: "empty", undoDepth: 0, redoDepth: 3 });
  assert.equal(editor.calls, 3, "an empty history runs nothing");
  assert.deepEqual(await fate.call(editor, { token: "t3", waitMs: 50 }), { known: true, running: false, started: false, settled: false, rejected: null, outcome: "empty", moved: false, busy: false, undoDepth: 0, redoDepth: 3 });
  assert.deepEqual(await fate.call(editor, { token: "another request", waitMs: 50 }), { known: false, undoDepth: 0, redoDepth: 3 });
  const redone = await step.call(editor, { direction: "redo", timeoutMs: 10_000, settleMs: 250, token: "t4" });
  assert.deepEqual(redone, { outcome: "resolved", undoDepth: 1, redoDepth: 2 });
  assert.deepEqual(await fate.call(editor, { token: "t4", waitMs: 50 }), { known: true, running: false, started: true, settled: true, rejected: null, outcome: "resolved", moved: true, busy: false, undoDepth: 1, redoDepth: 2 });
});

test("the page's step counts a pending promise as applied once the stack shrank and the default command awaits", async () => {
  const { step, fate } = await pageSources();
  const editor = stubEditor("pending");
  const result = await step.call(editor, { direction: "undo", timeoutMs: 10_000, settleMs: 250, token: "p1" });
  assert.deepEqual(result, { outcome: "applied", undoDepth: 2, redoDepth: 1 });
  assert.deepEqual(await fate.call(editor, { token: "p1", waitMs: 50 }), { known: true, running: false, started: true, settled: false, rejected: null, outcome: "applied", moved: true, busy: false, undoDepth: 2, redoDepth: 1 });
});

test("the page's step fails for a rejected promise and for a busy executor, and its record says the step was not applied", async () => {
  const { step, fate } = await pageSources();
  const rejecting = stubEditor("reject");
  await assert.rejects(step.call(rejecting, { direction: "undo", timeoutMs: 10_000, settleMs: 250, token: "r1" }), /native failure/);
  assert.deepEqual(await fate.call(rejecting, { token: "r1", waitMs: 50 }), { known: true, running: false, started: true, settled: false, rejected: "native failure", outcome: null, moved: false, busy: false, undoDepth: 3, redoDepth: 0 });
  const busy = stubEditor("settle");
  busy.executor.isBusy = true;
  await assert.rejects(step.call(busy, { direction: "undo", timeoutMs: 10_000, settleMs: 250, token: "b1" }), /Plasticity is busy/);
  assert.equal(busy.calls, 0);
  assert.deepEqual(await fate.call(busy, { token: "b1", waitMs: 50 }), { known: true, running: false, started: false, settled: false, rejected: null, outcome: null, moved: false, busy: true, undoDepth: 3, redoDepth: 0 });
  // A step that never settles and never moves the stack ends at its own deadline; its record keeps the promise as pending.
  const stuck = stubEditor("held");
  await assert.rejects(step.call(stuck, { direction: "undo", timeoutMs: 60, settleMs: 250, token: "s1" }), /undo did not complete within 60 ms/);
  const record = await fate.call(stuck, { token: "s1", waitMs: 50 });
  assert.deepEqual([record.running, record.started, record.settled, record.rejected, record.outcome, record.moved], [false, true, false, null, null, false]);
});

test("the fate read waits for a step that is still running, and gives up after waitMs", async () => {
  const { step, fate } = await pageSources();
  const editor = stubEditor("held");
  const running = step.call(editor, { direction: "undo", timeoutMs: 10_000, settleMs: 250, token: "h1" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  // Still running after a short wait: not definite.
  const early = await fate.call(editor, { token: "h1", waitMs: 20 });
  assert.deepEqual([early.known, early.running, early.started, early.settled, early.moved], [true, true, true, false, false]);
  // A longer wait ends as soon as the step does, not at its timer.
  const waited = performance.now();
  const late = fate.call(editor, { token: "h1", waitMs: 5_000 });
  setTimeout(() => editor.release(), 20);
  const settled = await late;
  assert.ok(performance.now() - waited < 1_000);
  assert.deepEqual([settled.known, settled.running, settled.started, settled.settled, settled.outcome, settled.moved, settled.undoDepth, settled.redoDepth], [true, false, true, true, "resolved", true, 2, 1]);
  assert.deepEqual(await running, { outcome: "resolved", undoDepth: 2, redoDepth: 1 });
});
