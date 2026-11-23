import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer, extrudeFacesOutcome, type SessionLike } from "./server.ts";
import type { PlasticityOperations } from "./plasticity/operations.ts";
import type { RuntimeState } from "./plasticity/runtime.ts";
import { withMergedUnionProperties } from "./tool-catalog.ts";

// organic-tools-2 phase C server registrations: items 2, 6, 7, 8, 9, 15 and the new tool plasticity_inset_planar_face.

async function withClient<T>(operations: Record<string, (...args: any[]) => Promise<unknown>>, run: (client: Client) => Promise<T>): Promise<T> {
  const fake = {
    async windows() { return []; },
    async connect() { return {}; },
    get() { return operations as unknown as PlasticityOperations; },
    capabilities() { return { bindings: [], operations: { constructionPlanes: { available: false, reason: "test" }, activeWorkplane: { available: false, reason: "test" } } }; },
    async captureSnapshot() { return {}; },
    async changesSince() { return {}; },
    async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake, undefined, undefined, undefined, null);
  const client = new Client({ name: "organic2c-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { return await run(client); } finally { await client.close(); }
}

function state(revision: string, bodies: Array<{ id: number; type: string; versionId?: number }> = []): RuntimeState {
  return {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision,
    dbVersion: 1, undoDepth: Number(revision.slice(1)), redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" },
    bodies: bodies.map(({ id, type, versionId }) => ({ id, versionId: versionId ?? id, type, name: null, boundsMm: { min: [0, 0, 0], max: [1, 1, 1] }, faceIds: [], edgeIds: [], faces: [], edges: [] })),
  } as unknown as RuntimeState;
}

function json(response: unknown): any {
  const content = (response as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return JSON.parse(content.find((entry) => entry.type === "text")!.text!);
}

test("item 6: the catalog takes query (or name) inside arguments, and names its fields for any other key", async () => {
  await withClient({ async state() { return state("r1"); } }, async (client) => {
    const top = json(await client.callTool({ name: "plasticity_call", arguments: { toolName: "catalog", query: "plasticity_extrude_faces" } }));
    const nested = json(await client.callTool({ name: "plasticity_call", arguments: { toolName: "catalog", arguments: { query: "plasticity_extrude_faces" } } }));
    const byName = json(await client.callTool({ name: "plasticity_call", arguments: { toolName: "catalog", arguments: { name: "plasticity_extrude_faces" } } }));
    assert.equal(top.total, 1);
    assert.deepEqual(nested.tools.map((tool: { name: string }) => tool.name), ["plasticity_extrude_faces"]);
    assert.deepEqual(byName.tools.map((tool: { name: string }) => tool.name), ["plasticity_extrude_faces"]);
    const fuzzy = json(await client.callTool({ name: "plasticity_call", arguments: { toolName: "catalog", arguments: { query: "inset planar face", limit: 3 } } }));
    assert.equal(fuzzy.limit, 3);
    assert.equal(fuzzy.tools[0].name, "plasticity_inset_planar_face");
    const wrong = await client.callTool({ name: "plasticity_call", arguments: { toolName: "catalog", arguments: { search: "box" } } });
    assert.equal(wrong.isError, true);
    assert.match(JSON.stringify(wrong.content), /takes query \(or name\), schema, offset and limit.*unknown catalog argument search/);
    const two = await client.callTool({ name: "plasticity_call", arguments: { toolName: "catalog", query: "box", arguments: { query: "sphere" } } });
    assert.equal(two.isError, true);
  });
});

test("item 7: union input schemas export anyOf with merged top-level properties, in the catalog and in tools/list", async () => {
  const merged = withMergedUnionProperties({ anyOf: [{ type: "object", properties: { a: { type: "number" } }, required: ["a"] }, { type: "object", properties: { b: { type: "string" }, a: { type: "string" } } }] });
  assert.deepEqual(merged.properties, { a: { type: "number" }, b: { type: "string" } });
  assert.equal(merged.type, "object");
  assert.equal((merged.anyOf as unknown[]).length, 2);
  const plain = { type: "object", properties: { x: {} } };
  assert.equal(withMergedUnionProperties(plain), plain);
  await withClient({ async state() { return state("r1"); } }, async (client) => {
    for (const name of ["plasticity_create_rectangle", "plasticity_create_polyline"]) {
      const entry = json(await client.callTool({ name: "plasticity_call", arguments: { toolName: "catalog", query: name } })).tools[0];
      assert.ok(Object.keys(entry.inputSchema.properties).includes("revision"), name);
      assert.ok(entry.inputSchema.anyOf, name);
    }
  });
  await withClient({ async state() { return state("r1"); } }, async (client) => {
    const tools = (await client.listTools()).tools;
    const rectangle = tools.find((tool) => tool.name === "plasticity_create_rectangle")!;
    const properties = Object.keys((rectangle.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    assert.ok(properties.includes("widthMm") && properties.includes("heightMm"), properties.join(","));
  });
});

test("item 8: plasticity_set_visibility needs only the changed list", async () => {
  const calls: unknown[][] = [];
  let current = state("r1", [{ id: 4, type: "Solid" }]);
  await withClient({
    async state() { return current; },
    async setNodeVisibility(...args: unknown[]) { calls.push(args); current = state("r2", [{ id: 4, type: "Solid", versionId: 5 }]); return current; },
  }, async (client) => {
    const reply = await client.callTool({ name: "plasticity_call", arguments: { toolName: "plasticity_set_visibility", arguments: { bodyIds: [4], visible: false, revision: "r1" } } });
    assert.equal(reply.isError, undefined, JSON.stringify(reply.content));
    assert.deepEqual(calls[0], [[4], [], [], [], false, "r1"]);
    const empty = await client.callTool({ name: "plasticity_call", arguments: { toolName: "plasticity_set_visibility", arguments: { visible: true, revision: "r2" } } });
    assert.equal(empty.isError, true);
  });
});

test("item 9: plasticity_batch detail standard also carries summary with the lean shape", async () => {
  let current = state("r1", [{ id: 4, type: "Solid" }]);
  const ops = {
    async state() { return current; },
    async setNodeVisibility() { current = state("r2", [{ id: 4, type: "Solid" }, { id: 9, type: "Wire" }]); return current; },
  };
  await withClient(ops, async (client) => {
    const standard = json(await client.callTool({ name: "plasticity_batch", arguments: { steps: [{ toolName: "plasticity_set_visibility", arguments: { bodyIds: [4], visible: false } }], detail: "standard" } }));
    assert.equal(standard.summary.revision, "r2");
    assert.deepEqual(standard.summary.added.map((body: { id: number }) => body.id), [9]);
    assert.equal(standard.summary.undoSteps, 1);
    assert.ok(standard.change, "standard keeps its change block");
    current = state("r1", [{ id: 4, type: "Solid" }]);
    const lean = json(await client.callTool({ name: "plasticity_batch", arguments: { steps: [{ toolName: "plasticity_set_visibility", arguments: { bodyIds: [4], visible: false } }], detail: "lean" } }));
    assert.deepEqual(Object.keys(lean.summary).sort(), Object.keys(standard.summary).sort());
  });
});

test("item 2: extrude_faces boolean is forwarded only when set, and the reply says what happened", async () => {
  const calls: unknown[][] = [];
  let current = state("r1", [{ id: 1, type: "Solid" }]);
  await withClient({
    async state() { return current; },
    async extrudeFaces(...args: unknown[]) { calls.push(args); current = args[4] ? state("r2", [{ id: 1, type: "Solid", versionId: 7 }]) : state("r2", [{ id: 1, type: "Solid" }, { id: 2, type: "Solid" }]); return current; },
  }, async (client) => {
    const slab = json(await client.callTool({ name: "plasticity_extrude_faces", arguments: { id: 1, faceIds: ["f"], distanceMm: -1.5, revision: "r1" } }));
    assert.deepEqual(calls[0], [1, ["f"], -1.5, "r1"]);
    assert.deepEqual([slab.extrude.result, slab.extrude.newBodyIds, slab.extrude.operation], ["new-body", [2], "none"]);
    current = state("r1", [{ id: 1, type: "Solid" }]);
    const pocket = json(await client.callTool({ name: "plasticity_extrude_faces", arguments: { id: 1, faceIds: ["f"], distanceMm: -1.5, boolean: "fuse", revision: "r1" } }));
    assert.deepEqual(calls[1], [1, ["f"], -1.5, "r1", "fuse"]);
    assert.deepEqual([pocket.extrude.result, pocket.extrude.operation, pocket.extrude.sourceModified], ["source-modified", "difference", true]);
  });
  assert.deepEqual(extrudeFacesOutcome({ change: { added: [], modified: [] } }, 1, "union", "union").result, "unchanged");
});

test("item 15: check_patch_boundary takes every patch_sheet_hole argument; guideIds and toleranceMm are forwarded", async () => {
  const received: unknown[][] = [];
  await withClient({
    async state() { return state("r1"); },
    async checkPatchBoundary(...args: unknown[]) { received.push(args); return { ok: true, problems: [], corners: [], edges: [], summary: "none" }; },
  }, async (client) => {
    const reply = await client.callTool({ name: "plasticity_call", arguments: { toolName: "plasticity_check_patch_boundary", arguments: { id: 7, edgeIds: ["e1"], guideIds: [12], toleranceMm: 0.05, precheck: "warn", intent: "same call as the patch", continuity: "g2", revision: "r1" } } });
    assert.equal(reply.isError, undefined, JSON.stringify(reply.content));
    assert.deepEqual(received[0], [7, ["e1"], "r1", { curveIds: undefined, continuity: "g2", edgeContinuity: undefined, faces: undefined, smoothness: undefined, guideIds: [12], toleranceMm: 0.05 }]);
  });
});

test("plasticity_inset_planar_face: exactly one of faceId and faceIds, a positive inward distance and a nonzero depth", async () => {
  await withClient({ async state() { return state("r1", [{ id: 10, type: "Solid" }]); } }, async (client) => {
    const call = (args: Record<string, unknown>) => client.callTool({ name: "plasticity_call", arguments: { toolName: "plasticity_inset_planar_face", arguments: { bodyId: 10, revision: "r1", ...args } } });
    assert.equal((await call({ distanceMm: 2 })).isError, true);
    assert.equal((await call({ faceId: "a", faceIds: ["a"], distanceMm: 2 })).isError, true);
    assert.equal((await call({ faceId: "a", distanceMm: -2 })).isError, true);
    assert.equal((await call({ faceId: "a", distanceMm: 2, depthMm: 0 })).isError, true);
  });
});
