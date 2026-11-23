import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer, type SessionLike } from "./server.ts";
import type { PlasticityOperations } from "./plasticity/operations.ts";
import type { RuntimeState } from "./plasticity/runtime.ts";

async function withSurfacingClient<T>(operations: Record<string, (...args: any[]) => Promise<unknown>>, run: (client: Client) => Promise<T>): Promise<T> {
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
  const client = new Client({ name: "organic2-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

// Server registrations of organic-tools-2: patch pre-check option, plasticity_check_patch_boundary,
// plasticity_continuity_report and plasticity_create_plane_curve.

function state(revision: string, bodies: Array<{ id: number; type: string }> = []): RuntimeState {
  return {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision,
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" },
    bodies: bodies.map(({ id, type }) => ({ id, versionId: id, type, name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] })),
  } as unknown as RuntimeState;
}

function json(response: unknown): any {
  const content = (response as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return JSON.parse(content.find((entry) => entry.type === "text")!.text!);
}

test("plasticity_patch_sheet_hole without precheck calls the operation as before and returns the plain compact result", async () => {
  const calls: unknown[][] = [];
  let current = state("r1", [{ id: 7, type: "Sheet" }]);
  await withSurfacingClient({
    async state() { return current; },
    async patchSheetHole(...args: unknown[]) { calls.push(args); current = state("r2", [{ id: 7, type: "Sheet" }]); return current; },
  }, async (client) => {
    const reply = json(await client.callTool({ name: "plasticity_patch_sheet_hole", arguments: { id: 7, edgeIds: ["e1"], continuity: "g1", revision: "r1" } }));
    assert.equal(reply.revision, "r2");
    assert.equal(reply.precheck, undefined);
    const options = calls[0]![3] as Record<string, unknown>;
    assert.equal("precheck" in options, false);
    assert.equal("onPrecheck" in options, false);
  });
});

test("plasticity_patch_sheet_hole precheck warn attaches the analysis; refuse and off are forwarded", async () => {
  const seen: string[] = [];
  let current = state("r1", [{ id: 7, type: "Sheet" }]);
  await withSurfacingClient({
    async state() { return current; },
    async patchSheetHole(_id: number, _edges: string[], _revision: string, options: { precheck?: string; onPrecheck?: (analysis: unknown) => void }) {
      seen.push(String(options.precheck));
      options.onPrecheck?.({ ok: false, problems: [{ kind: "angle-budget" }], corners: [], edges: [], summary: "s" });
      current = state("r2", [{ id: 7, type: "Sheet" }]);
      return current;
    },
  }, async (client) => {
    const reply = json(await client.callTool({ name: "plasticity_patch_sheet_hole", arguments: { id: 7, edgeIds: ["e1"], continuity: "g1", precheck: "warn", revision: "r1" } }));
    assert.equal(reply.precheck.ok, false);
    assert.equal(reply.precheck.problems[0].kind, "angle-budget");
    current = state("r1", [{ id: 7, type: "Sheet" }]);
    const off = json(await client.callTool({ name: "plasticity_patch_sheet_hole", arguments: { id: 7, edgeIds: ["e1"], continuity: "g1", precheck: "off", revision: "r1" } }));
    assert.equal(off.precheck, undefined);
    assert.deepEqual(seen, ["warn", "off"]);
    const bad = await client.callTool({ name: "plasticity_patch_sheet_hole", arguments: { id: 7, edgeIds: ["e1"], precheck: "maybe", revision: "r1" } });
    assert.equal(bad.isError, true);
  });
});

test("the new organic tools are registered read-only or writing as they should and validate their inputs", async () => {
  const received: Record<string, unknown[]> = {};
  let current = state("r1");
  await withSurfacingClient({
    async state() { return current; },
    async checkPatchBoundary(...args: unknown[]) { received.check = args; return { ok: true, problems: [], corners: [], edges: [], summary: "none" }; },
    async continuityReport(...args: unknown[]) { received.report = args; return { edgeCount: 0 }; },
    async createPlaneCurve(...args: unknown[]) {
      received.plane = args;
      current = state("r2", [{ id: 11, type: "Wire" }]);
      return { state: current, worldPointsMm: [[0, 5, 0], [1, 5, 1], [2, 5, 0]], frame: { originMm: [0, 5, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1], normal: [0, 1, 0] } };
    },
  }, async (client) => {
    const tools = (await client.listTools()).tools;
    for (const [name, readOnly] of [["plasticity_check_patch_boundary", true], ["plasticity_continuity_report", true], ["plasticity_create_plane_curve", false]] as const) {
      const entry = tools.find((candidate) => candidate.name === name);
      assert.ok(entry, name);
      assert.equal(entry!.annotations?.readOnlyHint, readOnly, name);
      assert.equal((entry!.inputSchema as { additionalProperties?: unknown }).additionalProperties, false, name);
    }
    const patchSchema = tools.find((candidate) => candidate.name === "plasticity_patch_sheet_hole")!.inputSchema as { properties: Record<string, { enum?: string[] }> };
    assert.deepEqual(patchSchema.properties.precheck!.enum, ["refuse", "warn", "off"]);

    const check = json(await client.callTool({ name: "plasticity_check_patch_boundary", arguments: { id: 7, edgeIds: ["e1", "e2"], continuity: "g1", faces: "single", revision: "r1" } }));
    assert.equal(check.ok, true);
    assert.deepEqual(received.check, [7, ["e1", "e2"], "r1", { curveIds: undefined, continuity: "g1", edgeContinuity: undefined, faces: "single", smoothness: undefined }]);

    json(await client.callTool({ name: "plasticity_continuity_report", arguments: { bodyId: 3, faceIds: ["f1"], faceMode: "touching", revision: "r1" } }));
    assert.deepEqual(received.report, [{ bodyId: 3, faceIds: ["f1"], faceMode: "touching", positionToleranceMm: 0.01, normalAngleToleranceDeg: 0.1, relativeCurvatureTolerance: 0.05 }, "r1"]);
    assert.equal((await client.callTool({ name: "plasticity_continuity_report", arguments: { revision: "r1" } })).isError, true);
    assert.equal((await client.callTool({ name: "plasticity_continuity_report", arguments: { wireIds: [4], faceIds: ["f1"], revision: "r1" } })).isError, true);

    const plane = json(await client.callTool({ name: "plasticity_create_plane_curve", arguments: { plane: "xz", offsetMm: 5, points2dMm: [[0, 0], [1, 1], [2, 0]], revision: "r1" } }));
    assert.equal(plane.wireId, 11);
    assert.deepEqual(plane.worldPointsMm[1], [1, 5, 1]);
    assert.deepEqual(plane.plane.normal, [0, 1, 0]);
    assert.deepEqual(received.plane, [{ plane: "xz", offsetMm: 5, points2dMm: [[0, 0], [1, 1], [2, 0]], mode: "control", closed: false }, "r1"]);
    // Control needs three points; interpolate takes two.
    assert.equal((await client.callTool({ name: "plasticity_create_plane_curve", arguments: { plane: "xy", points2dMm: [[0, 0], [1, 1]], revision: "r2" } })).isError, true);
  });
});
