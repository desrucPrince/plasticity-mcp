import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createCompactServer, type SessionLike } from "./server.ts";
import type { ConstructionHistoryEntry, ConstructionHistoryStore } from "./plasticity/construction-history.ts";
import { PlasticityOperations } from "./plasticity/operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./plasticity/runtime.ts";

// Server wiring of the gap fixes: plasticity_delete_section_analysis (id or all), plasticity_boolean with several tools.

function fixture() {
  let sections = 1;
  let version = 1;
  const mutations: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const state = (): RuntimeState => ({
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: `r${version}`, dbVersion: version, undoDepth: 0, redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" },
    sectionAnalyses: Array.from({ length: sections }, (_, index) => ({ id: index + 3, name: null, originMm: [0, 0, 5], normal: [0, 0, 1], visible: true, registeredViewportCount: 1 })),
    bodies: [],
  }) as unknown as RuntimeState;
  const runtime = {
    async getState() { return structuredClone(state()); },
    async readRevisionProbe() { const s = state(); return { documentToken: s.documentToken, revision: s.revision, viewStateToken: "v", activePlaneId: null, bodyNames: [], regions: [] }; },
    async mutate(source: string, bindings: string[], values: unknown[]) {
      mutations.push({ source, bindings, values });
      if (/shading\.section = null/.test(source)) sections = 0;
      version += 1;
      return {};
    },
    isUncertain() { return false; }, mutationCount() { return mutations.length; },
    async read() { return undefined; }, async readNative() { return undefined; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-1");
  const history = { async append(_entry: ConstructionHistoryEntry) {} } as unknown as ConstructionHistoryStore;
  const session = {
    async windows() { return []; }, async connect() { return null; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: operations.constructionCapabilities() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createCompactServer(session, undefined, undefined, undefined, history);
  const client = new Client({ name: "gaps", version: "1.0.0" });
  return {
    mutations, state, client,
    async open() { const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a); },
    async call(name: string, args: Record<string, unknown>) {
      // Tools outside the compact list go through the plasticity_call router, like a client without them listed.
      const response = name === "plasticity_delete_section_analysis"
        ? await client.callTool({ name: "plasticity_call", arguments: { toolName: name, arguments: args } })
        : await client.callTool({ name, arguments: args });
      const text = (response.content as Array<{ type: string; text?: string }>).find((part) => part.type === "text")?.text ?? "";
      return { isError: response.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return text; } })() };
    },
    async close() { await client.close(); await server.close(); },
  };
}

test("plasticity_delete_section_analysis takes exactly one of id and all", async () => {
  const f = fixture();
  await f.open();
  try {
    const neither = await f.call("plasticity_delete_section_analysis", { revision: f.state().revision });
    assert.equal(neither.isError, true);
    assert.match(neither.text, /id/);
    assert.match(neither.text, /all: true/);
    const both = await f.call("plasticity_delete_section_analysis", { id: 3, all: true, revision: f.state().revision });
    assert.equal(both.isError, true);
    assert.match(both.text, /not both/);
    const falsy = await f.call("plasticity_delete_section_analysis", { all: false, revision: f.state().revision });
    assert.equal(falsy.isError, true);
    assert.equal(f.mutations.length, 0);

    const byAll = await f.call("plasticity_delete_section_analysis", { all: true, revision: f.state().revision });
    assert.equal(byAll.isError, false, byAll.text);
    assert.deepEqual(byAll.json.sectionAnalyses, []);
    assert.equal(f.mutations.length, 1);
  } finally { await f.close(); }
});

test("plasticity_delete_section_analysis with an id still deletes that one analysis", async () => {
  const f = fixture();
  await f.open();
  try {
    const byId = await f.call("plasticity_delete_section_analysis", { id: 3, revision: f.state().revision });
    assert.equal(byId.isError, false, byId.text);
    assert.deepEqual(f.mutations[0]!.values, [{ id: 3 }]);
  } finally { await f.close(); }
});

test("plasticity_boolean describes the multi-tool meaning and runs one native call for an intersection of two tools", async () => {
  const f = fixture();
  await f.open();
  try {
    const tools = await f.client.listTools();
    const description = tools.tools.find((tool) => tool.name === "plasticity_boolean")?.description ?? "";
    assert.match(description, /intersection keeps only what lies inside the target and every tool/);
    assert.match(description, /difference removes every tool from the target/);
    assert.match(description, /union merges/);
    const result = await f.call("plasticity_boolean", { targetIds: [1], toolIds: [2, 3], operation: "intersection", revision: f.state().revision });
    assert.equal(result.isError, false, result.text);
    assert.equal(f.mutations.length, 1);
    assert.deepEqual(f.mutations[0]!.bindings, ["BooleanFactory"]);
    assert.deepEqual(f.mutations[0]!.values, [{ targetIds: [1], toolIds: [2, 3], keepTools: false }]);
    assert.match(f.mutations[0]!.source, /for \(const toolId of args\.toolIds\)/);
  } finally { await f.close(); }
});
