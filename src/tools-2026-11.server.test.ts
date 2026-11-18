import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer, type SessionLike } from "./server.ts";
import type { PlasticityOperations } from "./plasticity/operations.ts";
import type { RuntimeState } from "./plasticity/runtime.ts";

// Server-level tests of the 2026-11 tool changes: overwrite on the file-writing tools, long undo and redo.

const construction: RuntimeState["construction"] = { planes: [], activePlaneId: "standard:top", planeStateToken: "planes:empty", viewStateToken: "workplane:standard:top" };
const emptyState = (): RuntimeState => ({ targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction, regions: [], bodies: [] });

async function connect(operations: unknown) {
  const session = {
    async windows() { return []; }, async connect() { return emptyState(); }, get() { return operations as PlasticityOperations; },
    capabilities() { return { bindings: [], operations: { constructionPlanes: { available: false, reason: "test" }, activeWorkplane: { available: false, reason: "test" } } }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } as unknown as SessionLike;
  const server = createServer(session, undefined, undefined, undefined, null);
  const client = new Client({ name: "tools-2026-11", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const text = (response.content as Array<{ type: string; text?: string }>).find((part) => part.type === "text")?.text ?? "";
    return { isError: response.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return undefined; } })() };
  };
  return { client, call, async close() { await client.close(); await server.close(); } };
}

// ---------- item 1: overwrite ----------

/** Every tool that writes a file at a caller-given path: its operations method and the arguments of a plain call. */
const FILE_TOOLS: Array<{ tool: string; method: string; input: Record<string, unknown>; plain: unknown[] }> = [
  { tool: "plasticity_export_step", method: "exportStep", input: { ids: [1], path: "/out/a.step", revision: "r1" }, plain: [[1], "/out/a.step", "r1"] },
  { tool: "plasticity_export_parasolid", method: "exportParasolid", input: { ids: [1], path: "/out/a.x_t", revision: "r1" }, plain: [[1], "/out/a.x_t", "r1"] },
  { tool: "plasticity_export_iges", method: "exportIges", input: { ids: [1], path: "/out/a.igs", revision: "r1" }, plain: [[1], "/out/a.igs", "r1"] },
  { tool: "plasticity_export_sat", method: "exportSat", input: { ids: [1], path: "/out/a.sat", revision: "r1" }, plain: [[1], "/out/a.sat", "r1"] },
  { tool: "plasticity_export_stl", method: "exportStl", input: { ids: [1], path: "/out/a.stl", revision: "r1" }, plain: [[1], "/out/a.stl", "r1", 0.05, 15] },
  { tool: "plasticity_export_3mf", method: "export3mf", input: { ids: [1], path: "/out/a.3mf", revision: "r1" }, plain: [[1], "/out/a.3mf", "r1", 0.05, 15] },
  { tool: "plasticity_export_obj", method: "exportObj", input: { ids: [1], path: "/out/a.obj", revision: "r1" }, plain: [[1], "/out/a.obj", "r1", 0.05, 15] },
  { tool: "plasticity_export_svg", method: "exportSvg", input: { ids: [2], path: "/out/a.svg", revision: "r1" }, plain: [[2], "/out/a.svg", "r1", 0.05, 5] },
  { tool: "plasticity_export_hiddenline_svg", method: "exportHiddenLineSvg", input: { ids: [1], path: "/out/b.svg", revision: "r1" }, plain: [[1], "/out/b.svg", "r1", 0.05, 5, 1] },
  { tool: "plasticity_screenshot", method: "screenshot", input: { path: "/out/a.png" }, plain: ["/out/a.png", "window"] },
  { tool: "plasticity_save_copy", method: "saveCopy", input: { path: "/out/a.plasticity" }, plain: ["/out/a.plasticity"] },
];

function recordingOperations() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const operations = new Proxy({}, {
    get(_target, name) {
      if (name === "then") return undefined;
      if (name === "state") return async () => emptyState();
      if (name === "restorePendingScreenshotView") return async () => ({ restored: false });
      return async (...args: unknown[]) => { calls.push({ method: String(name), args }); return { path: String(args[1] ?? args[0]), bytes: 1 }; };
    },
  });
  return { operations, calls };
}

test("every file-writing tool takes overwrite, passes it on only when true, and states the rule", async () => {
  const { operations, calls } = recordingOperations();
  const { client, call, close } = await connect(operations);
  try {
    const listed = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    for (const entry of FILE_TOOLS) {
      const tool = listed.get(entry.tool);
      assert.ok(tool, entry.tool);
      const overwrite = (tool.inputSchema.properties as Record<string, { type?: string; default?: unknown }>).overwrite;
      assert.equal(overwrite?.type, "boolean", `${entry.tool} has overwrite`);
      assert.equal(overwrite?.default, false, `${entry.tool}: overwrite defaults to false`);
      assert.match(tool.description ?? "", /refused unless overwrite: true, which replaces a regular file only \(never a directory or a symbolic link\)/, `${entry.tool} states the overwrite rule`);
      assert.doesNotMatch(tool.description ?? "", /without overwriting/, entry.tool);

      calls.length = 0;
      const plain = await call(entry.tool, entry.input);
      assert.equal(plain.isError, false, plain.text);
      const explicit = await call(entry.tool, { ...entry.input, overwrite: false });
      assert.equal(explicit.isError, false, explicit.text);
      const replace = await call(entry.tool, { ...entry.input, overwrite: true });
      assert.equal(replace.isError, false, replace.text);
      const seen = calls.filter((item) => item.method === entry.method);
      assert.deepEqual(seen.map((item) => item.args), [entry.plain, entry.plain, [...entry.plain, { overwrite: true }]], entry.tool);
      const bad = await call(entry.tool, { ...entry.input, overwrite: "yes" });
      assert.equal(bad.isError, true, `${entry.tool}: overwrite must be a boolean`);
    }
    // An inline screenshot writes no file, so overwrite without path is a mistake that is said, not ignored.
    const inline = await call("plasticity_screenshot", { overwrite: true });
    assert.equal(inline.isError, true);
    assert.match(inline.text, /overwrite: true needs path/);
    // Opening a document keeps its backup rule: the backup path is never overwritten and takes no option.
    const open = listed.get("plasticity_open_document");
    assert.equal("overwrite" in (open!.inputSchema.properties as Record<string, unknown>), false);
  } finally {
    await close();
  }
});

// ---------- item 2: long undo and redo ----------

type Run = { stepsDone: number; stopped?: "history-empty" | "timed-out"; timeout?: string };

/** Operations whose stepHistoryMany does what `plan` says and moves the Undo depth by stepsDone. */
function historyOperations(plan: (direction: string, steps: number) => Run, undoDepth = 700) {
  let state: RuntimeState = { ...emptyState(), undoDepth, redoDepth: 0, revision: `r-${undoDepth}` };
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let renames = 0;
  const operations = {
    async state() { return state; },
    async stepHistoryMany(direction: "undo" | "redo", steps: number, revision?: string) {
      calls.push({ method: "stepHistoryMany", args: [direction, steps, revision] });
      const run = plan(direction, steps);
      const sign = direction === "undo" ? -1 : 1;
      state = { ...state, undoDepth: state.undoDepth + sign * run.stepsDone, redoDepth: state.redoDepth - sign * run.stepsDone };
      state = { ...state, revision: `r-${state.undoDepth}` };
      return { state, direction, stepsRequested: steps, stepsRemaining: steps - run.stepsDone, ...run };
    },
    async rename(...args: unknown[]) {
      calls.push({ method: "rename", args });
      renames += 1;
      if (renames === 2) throw new Error("rename failed");
      state = { ...state, undoDepth: state.undoDepth + 1, revision: `renamed-${renames}` };
      return state;
    },
  };
  return { operations, calls, current: () => state };
}

test("plasticity_undo and plasticity_redo take several hundred steps in one call and report a definite count", async () => {
  const { operations, calls, current } = historyOperations((_direction, steps) => ({ stepsDone: steps }));
  const { client, call, close } = await connect(operations);
  try {
    const undone = await call("plasticity_undo", { steps: 600, revision: "r-700" });
    assert.equal(undone.isError, false, undone.text);
    assert.deepEqual([undone.json.stepsRequested, undone.json.stepsDone, undone.json.stepsRemaining, "stopped" in undone.json, "note" in undone.json], [600, 600, 0, false, false]);
    assert.deepEqual([undone.json.undoDepth, undone.json.redoDepth, undone.json.revision], [100, 600, "r-100"]);
    const redone = await call("plasticity_redo", { steps: 600, revision: undone.json.revision });
    assert.equal(redone.isError, false, redone.text);
    assert.deepEqual([redone.json.stepsDone, redone.json.stepsRemaining, redone.json.undoDepth, redone.json.redoDepth], [600, 0, 700, 0]);
    // One call to the operations for the whole run: the server no longer loops over single steps itself.
    assert.deepEqual(calls, [{ method: "stepHistoryMany", args: ["undo", 600, "r-700"] }, { method: "stepHistoryMany", args: ["redo", 600, "r-100"] }]);
    assert.equal((await call("plasticity_undo", { steps: 5_000, revision: current().revision })).isError, false);
    assert.equal((await call("plasticity_undo", { steps: 5_001, revision: current().revision })).isError, true);
    assert.equal((await call("plasticity_undo", { steps: 0, revision: current().revision })).isError, true);
    for (const name of ["plasticity_undo", "plasticity_redo"]) {
      const tool = (await client.listTools()).tools.find((item) => item.name === name)!;
      assert.match(tool.description ?? "", /stepsRequested, stepsDone and stepsRemaining/);
      assert.match(tool.description ?? "", /it does not retry or go on, and the session needs no plasticity_reconcile/);
      assert.equal((tool.inputSchema.properties as Record<string, { maximum?: number }>).steps?.maximum, 5_000);
    }
  } finally {
    await close();
  }
});

test("a time-out part-way through plasticity_undo is a definite reply, not an error, and nothing goes on by itself", async () => {
  const { operations, calls } = historyOperations(() => ({ stepsDone: 251, stopped: "timed-out", timeout: "CDP request timed out: Runtime.callFunctionOn" }));
  const { call, close } = await connect(operations);
  try {
    const reply = await call("plasticity_undo", { steps: 600, revision: "r-700" });
    assert.equal(reply.isError, false, reply.text);
    assert.deepEqual([reply.json.stepsRequested, reply.json.stepsDone, reply.json.stepsRemaining, reply.json.stopped], [600, 251, 349, "timed-out"]);
    assert.deepEqual([reply.json.undoDepth, reply.json.redoDepth, reply.json.revision], [449, 251, "r-449"]);
    assert.match(reply.json.note, /timed out after 251 of 600 undo steps \(CDP request timed out: Runtime\.callFunctionOn\)/);
    assert.match(reply.json.note, /Nothing was retried and the run did not go on; call plasticity_undo again for the 349 remaining steps/);
    assert.equal(calls.length, 1, "one run, no continuation");
  } finally {
    await close();
  }
});

test("the history running out is reported, also for a session that has only undo() and redo()", async () => {
  const many = historyOperations(() => ({ stepsDone: 3, stopped: "history-empty" }));
  const first = await connect(many.operations);
  try {
    const reply = await first.call("plasticity_undo", { steps: 10, revision: "r-700" });
    assert.deepEqual([reply.json.stepsDone, reply.json.stepsRemaining, reply.json.stopped, reply.json.note], [3, 7, "history-empty", "The undo history ran out after 3 of 10 steps."]);
  } finally {
    await first.close();
  }
  // A session without stepHistoryMany (an older fake): one undo() per step, the revision on the first only.
  let state: RuntimeState = { ...emptyState(), undoDepth: 2 };
  const undoCalls: unknown[][] = [];
  const legacy = {
    async state() { return state; },
    async undo(...args: unknown[]) { undoCalls.push(args); state = { ...state, undoDepth: Math.max(0, state.undoDepth - 1), revision: `u${undoCalls.length}` }; return state; },
  };
  const second = await connect(legacy);
  try {
    const reply = await second.call("plasticity_undo", { steps: 5, revision: "r1" });
    assert.equal(reply.isError, false, reply.text);
    assert.deepEqual(undoCalls, [["r1"], []]);
    assert.deepEqual([reply.json.stepsRequested, reply.json.stepsDone, reply.json.stepsRemaining, reply.json.stopped, reply.json.undoDepth], [5, 2, 3, "history-empty", 0]);
    const empty = await second.call("plasticity_undo", { steps: 2, revision: "u2" });
    assert.deepEqual([empty.json.stepsDone, empty.json.stepsRemaining, empty.json.stopped], [0, 2, "history-empty"]);
  } finally {
    await second.close();
  }
});

test("plasticity_batch undoOnError stops at an undo that timed out and reports it as an undo error, as before", async () => {
  const { operations, calls } = historyOperations(() => ({ stepsDone: 1, stopped: "timed-out", timeout: "CDP request timed out: Runtime.callFunctionOn" }), 4);
  const { call, close } = await connect(operations);
  try {
    const reply = await call("plasticity_batch", { undoOnError: true, steps: [
      { toolName: "plasticity_rename", arguments: { id: 1, name: "a" } },
      { toolName: "plasticity_rename", arguments: { id: 1, name: "b" } },
    ] });
    assert.equal(reply.isError, true);
    const failure = JSON.parse(reply.text.slice(reply.text.indexOf("{")));
    assert.equal(failure.failedStep, 1);
    assert.match(failure.error, /rename failed/);
    assert.equal(failure.undoneSteps, 1, "the step the timed-out request applied is counted");
    assert.match(failure.undoError, /^CDP request timed out: Runtime\.callFunctionOn \(the document was read afterwards: that undo step was applied, and the session is not uncertain\)$/);
    assert.equal(calls.filter((item) => item.method === "stepHistoryMany").length, 1, "the rollback did not go on after the time-out");
  } finally {
    await close();
  }
});
