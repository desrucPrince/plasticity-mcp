import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer, type SessionLike } from "./server.ts";
import type { ConstructionHistoryEntry, ConstructionHistoryStore } from "./plasticity/construction-history.ts";
import { PlasticityOperations } from "./plasticity/operations.ts";
import { enableStateRead, stubPlasticity, within } from "./plasticity/selection-safe-stub.test.ts";

// The selection guard through the server: the real PlasticityOperations on the real PlasticityRuntime, over a stub of
// Plasticity's executor and selection (selection-safe-stub.test.ts). History steps, batch steps and plasticity_reconcile.

async function fixture() {
  const stub = stubPlasticity();
  enableStateRead(stub);
  const operations = new PlasticityOperations(stub.runtime, "session-1");
  const history = { async append(_entry: ConstructionHistoryEntry) {} } as unknown as ConstructionHistoryStore;
  const session = {
    async windows() { return []; }, async connect() { return null; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: operations.constructionCapabilities() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(session, undefined, undefined, undefined, history);
  const client = new Client({ name: "selection-safe", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await within(client.callTool({ name, arguments: args }), 8_000, name);
    const text = (response.content as Array<{ type: string; text?: string }>).find((part) => part.type === "text")?.text ?? "";
    return { isError: response.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return undefined; } })() };
  };
  const revision = async () => (await call("plasticity_status")).json.revision as string;
  return { stub, client, call, revision, async close() { await client.close(); await server.close(); } };
}

test("plasticity_undo and plasticity_redo over a history step that holds a face selection return, leave no command active and keep the user's selection", async () => {
  const { stub, call, revision, close } = await fixture();
  // Two history steps; the state of each holds a face selection (a click of the user at that time).
  stub.history.undoStack.push({ selection: new Set(["2:1f3"]) }, { selection: new Set(["2:2f8"]) });
  stub.select("4:1", "2:2f5");
  const undone = await call("plasticity_undo", { steps: 1, intent: "test", revision: await revision() });
  assert.equal(undone.isError, false, undone.text);
  assert.equal(undone.json.undoDepth, 1);
  assert.deepEqual(stub.cancelCalls, [{ name: "OffsetFaceCommand", agent: "automatic", state: "Awaiting" }], "the default command the step chained was cancelled, and nothing else");
  assert.equal(stub.executor.active, undefined);
  assert.deepEqual(stub.selection(), ["4:1", "2:2f5"], "not the selection of the history step");
  const redone = await call("plasticity_redo", { steps: 1, intent: "test", revision: undone.json.revision });
  assert.equal(redone.isError, false, redone.text);
  assert.equal(redone.json.undoDepth, 2);
  assert.equal(stub.executor.active, undefined);
  assert.deepEqual(stub.selection(), ["4:1", "2:2f5"]);
  assert.equal(stub.runtime.isUncertain(), false);
  assert.deepEqual(stub.log, []);
  await close();
});

test("every step of plasticity_batch runs inside the guard", async () => {
  const { stub, call, close } = await fixture();
  stub.history.undoStack.push({ selection: new Set(["2:1f3"]) }, { selection: new Set(["2:2f8"]) });
  stub.select("0:1e4");
  const batch = await call("plasticity_batch", { steps: [
    { toolName: "plasticity_undo", arguments: { steps: 1, intent: "test" } },
    { toolName: "plasticity_undo", arguments: { steps: 1, intent: "test" } },
    { toolName: "plasticity_redo", arguments: { steps: 2, intent: "test" } },
  ] });
  assert.equal(batch.isError, false, batch.text);
  assert.equal(batch.json.steps.length, 3);
  // Four history steps (1 + 1 + 2), each chained a default command for the face its state holds: all four were cancelled.
  assert.equal(stub.cancelCalls.length, 4);
  assert.ok(stub.cancelCalls.every((cancel) => cancel.agent === "automatic" && cancel.state === "Awaiting"));
  assert.equal(stub.executor.active, undefined);
  assert.deepEqual(stub.selection(), ["0:1e4"]);
  assert.equal(stub.history.undoStack.length, 2);
  await close();
});

test("plasticity_reconcile says in recovery that it cancelled an idle default command, and has no recovery field otherwise", async () => {
  const { stub, client, call, close } = await fixture();
  const idle = await call("plasticity_reconcile");
  assert.equal(idle.isError, false, idle.text);
  assert.equal("recovery" in idle.json, false);
  // What a call that hung before the guard leaves: the session uncertain, OffsetFaceCommand Awaiting.
  stub.select("2:1f1");
  stub.startDefault("OffsetFaceCommand", "Awaiting");
  stub.runtime.markUncertain();
  const refused = await call("plasticity_undo", { steps: 1, intent: "test", revision: idle.json.revision });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /uncertain/);
  const reconciled = await call("plasticity_reconcile");
  assert.equal(reconciled.isError, false, reconciled.text);
  assert.deepEqual(reconciled.json.recovery.cancelledDefaultCommands, ["OffsetFaceCommand"]);
  assert.match(reconciled.json.recovery.note, /No edit was undone or repeated/);
  assert.equal(stub.executor.active, undefined);
  assert.deepEqual(stub.selection(), ["2:1f1"]);
  assert.equal(stub.runtime.isUncertain(), false);
  assert.deepEqual(stub.executed, [], "no command ran: the uncertain edit was neither repeated nor undone");
  const tools = (await client.listTools()).tools;
  assert.match(tools.find((tool) => tool.name === "plasticity_reconcile")!.description ?? "", /recovery\.cancelledDefaultCommands/);
  assert.match(tools.find((tool) => tool.name === "plasticity_set_driving_distance")!.description ?? "", /clears the current Plasticity selection while it runs and puts it back afterwards/);
  await close();
});
