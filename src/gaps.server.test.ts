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

// C1 through the server: a chamfer the tool rolls back itself, alone and inside plasticity_batch.
type Body = RuntimeState["bodies"][number];
function body(id: number, version: number, faces: number[], edges: Array<{ entity: number; faces: number[]; radiusMm?: number }>): Body {
  const faceId = (entity: number) => `${version}f${entity}`;
  return {
    id, versionId: version, type: "Solid", name: null, boundsMm: { min: [0, 0, 0], max: [1, 1, 1] },
    faceIds: faces.map(faceId), edgeIds: edges.map((edge) => `${version}e${edge.entity}`),
    faces: faces.map((entity) => ({ id: faceId(entity), surfaceType: "Plane", planar: true, centerMm: [0, 0, 0], normal: [0, 0, 1], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 0], max: [0, 0, 0] }, edgeIds: [] })),
    edges: edges.map((edge) => ({ id: `${version}e${edge.entity}`, curveType: edge.radiusMm === undefined ? "Line" : "Circle", line: edge.radiusMm === undefined, circle: edge.radiusMm !== undefined, lengthMm: 10, centerMm: [0, 0, 0], tangent: [1, 0, 0], boundsMm: { min: [0, 0, 0], max: [0, 0, 0] }, faceIds: edge.faces.map(faceId), vertexIds: [], ...(edge.radiusMm === undefined ? {} : { circleGeometry: { centerMm: [0, 0, 0], radiusMm: edge.radiusMm, normal: [0, 0, 1], reference: [1, 0, 0], startMm: [0, 0, 0], midpointMm: [0, 0, 0], endMm: [0, 0, 0] } }) })),
  } as unknown as Body;
}

function chamferServerFixture() {
  // Body 8: one box edge (faces 1, 2) that chamfers well. Body 9: a line (1, 2) tangent to an R7 arc (1, 3); the chamfer
  // makes a face for the line only.
  const good = { before: body(8, 10, [1, 2], [{ entity: 100, faces: [1, 2] }]), after: body(8, 11, [1, 2, 40], [{ entity: 110, faces: [1, 40] }, { entity: 111, faces: [2, 40] }]) };
  const bad = { before: body(9, 20, [1, 2, 3], [{ entity: 100, faces: [1, 2] }, { entity: 101, faces: [1, 3], radiusMm: 7 }]), after: body(9, 21, [1, 2, 3, 40], [{ entity: 110, faces: [1, 40] }, { entity: 111, faces: [2, 40] }, { entity: 112, faces: [3, 40] }]) };
  const history: Body[][] = [[good.before, bad.before]];
  let version = 1;
  const kinds: string[] = [];
  const current = () => history[history.length - 1]!;
  const state = (): RuntimeState => ({
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: `r${version}`, dbVersion: version, undoDepth: history.length - 1, redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" }, bodies: structuredClone(current()),
  }) as unknown as RuntimeState;
  const identities = (item: Body): Array<[string, number]> => item.faceIds.map((id) => [id, Number(id.split("f")[1])]);
  const runtime = {
    async getState() { return state(); },
    async readRevisionProbe() { const s = state(); return { documentToken: s.documentToken, revision: s.revision, viewStateToken: "v", activePlaneId: null, bodyNames: [], regions: [] }; },
    async mutate(_source: string, _bindings: string[], values: unknown[]) {
      const args = values[0] as { direction?: string; id?: number };
      version += 1;
      if (args.direction === "undo") { kinds.push("undo"); if (history.length > 1) history.pop(); return "applied"; }
      kinds.push(`chamfer ${args.id}`);
      const pair = args.id === 8 ? good : bad;
      const beforeBody = current().find((item) => item.id === args.id)!;
      history.push(current().map((item) => (item.id === args.id ? pair.after : item)));
      return { chain: args.id === 9 ? ["20e100", "20e101"] : ["10e100"], chainError: null, facesBefore: identities(beforeBody), facesAfter: identities(pair.after) };
    },
    isUncertain() { return false; }, mutationCount() { return kinds.length; },
    async read() { return undefined; }, async readNative() { return undefined; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-1");
  const store = { async append(_entry: ConstructionHistoryEntry) {} } as unknown as ConstructionHistoryStore;
  const session = {
    async windows() { return []; }, async connect() { return null; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: operations.constructionCapabilities() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createCompactServer(session, undefined, undefined, undefined, store);
  const client = new Client({ name: "gaps-chamfer", version: "1.0.0" });
  return {
    kinds, state, client,
    async open() { const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a); },
    async call(name: string, args: Record<string, unknown>) {
      const response = await client.callTool({ name, arguments: args });
      const text = (response.content as Array<{ type: string; text?: string }>).find((part) => part.type === "text")?.text ?? "";
      return { isError: response.isError === true, text };
    },
    async close() { await client.close(); await server.close(); },
  };
}

test("plasticity_chamfer describes its read-back, and a partial chamfer comes back as an error with the document as before", async () => {
  const f = chamferServerFixture();
  await f.open();
  try {
    const description = (await f.client.listTools()).tools.find((tool) => tool.name === "plasticity_chamfer")?.description ?? "";
    assert.match(description, /tangent chain/);
    assert.match(description, /every edge Plasticity chamfered, chain included, got its own new face/);
    assert.match(description, /does not check the distance/);
    assert.match(description, /undoes its own step/);
    const before = f.state();
    const result = await f.call("plasticity_chamfer", { id: 9, edgeIds: ["20e100"], distanceMm: 7.41, revision: before.revision });
    assert.equal(result.isError, true);
    assert.match(result.text, /1 of the 2 edges it chamfered \(1 selected, 1 more along their tangent chain\) got no chamfer face: 20e101 \(Circle R7 mm\)/);
    assert.match(result.text, /the document is as it was before this call/);
    assert.deepEqual(f.kinds, ["chamfer 9", "undo"]);
    assert.equal(f.state().undoDepth, before.undoDepth);
    assert.deepEqual(f.state().bodies, before.bodies);
  } finally { await f.close(); }
});

test("plasticity_batch with undoOnError: a chamfer that rolled itself back is not undone twice, and its message asks for no undo", async () => {
  for (const undoOnError of [true, false]) {
    const f = chamferServerFixture();
    await f.open();
    try {
      const start = f.state();
      const result = await f.call("plasticity_batch", { undoOnError, steps: [
        { toolName: "plasticity_chamfer", arguments: { id: 8, edgeIds: ["10e100"], distanceMm: 1 } },
        { toolName: "plasticity_chamfer", arguments: { id: 9, edgeIds: ["20e100", "20e101"], distanceMm: 7.41 } },
      ] });
      assert.equal(result.isError, true);
      const reply = JSON.parse(result.text) as { failedStep: number; error: string; undoneSteps: number };
      assert.equal(reply.failedStep, 1);
      assert.match(reply.error, /The tool undid its own step: the document is as it was before this call .* No undo is needed for this call\./);
      assert.doesNotMatch(reply.error, /plasticity_undo/);
      if (undoOnError) {
        assert.equal(reply.undoneSteps, 1, "only the first step is undone by the batch");
        assert.deepEqual(f.kinds, ["chamfer 8", "chamfer 9", "undo", "undo"]);
        assert.equal(f.state().undoDepth, start.undoDepth);
        assert.deepEqual(f.state().bodies, start.bodies);
      } else {
        assert.equal(reply.undoneSteps, 0);
        assert.deepEqual(f.kinds, ["chamfer 8", "chamfer 9", "undo"]);
        assert.equal(f.state().undoDepth, start.undoDepth + 1, "the first step stays");
      }
    } finally { await f.close(); }
  }
});

test("plasticity_boolean describes several targets, and two targets with two tools go to one native call", async () => {
  const f = fixture();
  await f.open();
  try {
    const description = (await f.client.listTools()).tools.find((tool) => tool.name === "plasticity_boolean")?.description ?? "";
    assert.match(description, /With several targets, intersection applies to each target on its own/);
    assert.match(description, /names the target and the tool/);
    assert.match(description, /the rollback changes it/);
    const result = await f.call("plasticity_boolean", { targetIds: [1, 4], toolIds: [2, 3], operation: "intersection", keepTools: true, revision: f.state().revision });
    assert.equal(result.isError, false, result.text);
    assert.equal(f.mutations.length, 1);
    assert.deepEqual(f.mutations[0]!.values, [{ targetIds: [1, 4], toolIds: [2, 3], keepTools: true }]);
    assert.match(f.mutations[0]!.source, /factory\.targets = \[find\(targetId\)\]/);
  } finally { await f.close(); }
});

test("plasticity_screenshot describes the camera settle and restore fields", async () => {
  const f = fixture();
  await f.open();
  try {
    const description = (await f.client.listTools()).tools.find((tool) => tool.name === "plasticity_screenshot")?.description ?? "";
    assert.match(description, /up to 2 s/);
    assert.match(description, /cameraSettled/);
    assert.match(description, /cameraRestored/);
  } finally { await f.close(); }
});
