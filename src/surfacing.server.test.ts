import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createCompactServer, createServer, type SessionLike } from "./server.ts";
import type { PlasticityOperations } from "./plasticity/operations.ts";
import type { RuntimeState } from "./plasticity/runtime.ts";

// Server registrations of the surfacing tools: schemas, direct calls, plasticity_call and lean batch steps.

function emptyState(bodies: RuntimeState["bodies"] = []): RuntimeState {
  return {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" }, bodies,
  };
}

function parseToolJson(response: unknown): any {
  const content = (response as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const item = content.find((entry) => entry.type === "text" && typeof entry.text === "string");
  if (!item) throw new Error("Tool response has no JSON text");
  return JSON.parse(item.text!);
}

export async function withSurfacingClient<T>(operations: Record<string, (...args: any[]) => Promise<unknown>>, run: (client: Client) => Promise<T>, compact = false): Promise<T> {
  const fake = {
    async windows() { return []; },
    async connect() { return {}; },
    get() { return operations as unknown as PlasticityOperations; },
    capabilities() { return { bindings: [], operations: { constructionPlanes: { available: false, reason: "test" }, activeWorkplane: { available: false, reason: "test" } } }; },
    async captureSnapshot() { return {}; },
    async changesSince() { return {}; },
    async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = compact ? createCompactServer(fake, undefined, undefined, undefined, null) : createServer(fake, undefined, undefined, undefined, null);
  const client = new Client({ name: "surfacing-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

const probeReply = { id: 7, bodyType: "Solid", revision: "r1", source: "native-brep-ray-newton", acceptResidualMm: 1e-6, rays: [{ originMm: [0, 0, 31], direction: [0, 0, -1], atMm: [0, 0], hits: 1, intersections: [{ pointMm: [0, 0, 14], faceId: "7f1", normal: [0, 0, 1], distanceMm: 17, residualMm: 0 }] }], note: "n" };

test("plasticity_probe_surface and plasticity_exact_bounds are registered right after the continuity tool, strict and read-only", async () => {
  await withSurfacingClient({}, async (client) => {
    const tools = (await client.listTools()).tools;
    const names = tools.map((entry) => entry.name);
    const at = names.indexOf("plasticity_analyze_surface_continuity");
    assert.equal(names[at + 1], "plasticity_probe_surface");
    assert.equal(names[at + 2], "plasticity_exact_bounds");
    for (const name of ["plasticity_probe_surface", "plasticity_exact_bounds"]) {
      const tool = tools.find((entry) => entry.name === name)!;
      assert.equal((tool.inputSchema as { additionalProperties?: unknown }).additionalProperties, false);
      assert.equal(tool.annotations?.readOnlyHint, true);
    }
    const probe = tools.find((entry) => entry.name === "plasticity_probe_surface")!.description ?? "";
    assert.match(probe, /hits: 0 means the ray misses/);
    assert.match(probe, /control-hull box/);
    assert.match(probe, /-axis from 1 mm outside/);
    const describe = tools.find((entry) => entry.name === "plasticity_describe_body")!.description ?? "";
    assert.match(describe, /boundsExact says whether boundsMm is the exact extent/);
    const status = tools.find((entry) => entry.name === "plasticity_status")!.description ?? "";
    assert.match(status, /conservative box .*plasticity_exact_bounds gives its exact extent/);
  });
});

test("plasticity_probe_surface validates before the operation and passes rays or a grid through", async () => {
  const received: unknown[][] = [];
  await withSurfacingClient({ async probeSurface(...args: unknown[]) { received.push(args); return probeReply; } }, async (client) => {
    const bad = [
      { id: 7, revision: "r1" },
      { id: 7, revision: "r1", rays: [{ originMm: [0, 0, 0], direction: [0, 0, 1] }], gridMm: { at: [[0, 0]] } },
      { id: 7, revision: "r1", rays: [{ originMm: [0, 0, 0], direction: [0, 0, 0] }] },
      { id: 7, revision: "r1", rays: [] },
      { id: 7, revision: "r1", rays: Array.from({ length: 65 }, () => ({ originMm: [0, 0, 0], direction: [0, 0, 1] })) },
      { id: 7, revision: "r1", gridMm: { at: [[0, 0]], axis: "w" } },
      { id: 7, revision: "r1", gridMm: { at: [[0, 0]] }, extra: 1 },
      { id: 7, gridMm: { at: [[0, 0]] } },
    ];
    for (const args of bad) assert.equal((await client.callTool({ name: "plasticity_probe_surface", arguments: args })).isError, true, JSON.stringify(args));
    assert.equal(received.length, 0);
    const direct = await client.callTool({ name: "plasticity_probe_surface", arguments: { id: 7, revision: "r1", gridMm: { at: [[0, 0]] } } });
    assert.deepEqual(parseToolJson(direct), probeReply);
    assert.deepEqual(received[0], [{ id: 7, gridMm: { axis: "z", at: [[0, 0]] } }, "r1"]);
    await client.callTool({ name: "plasticity_probe_surface", arguments: { id: 7, revision: "r1", rays: [{ originMm: [1, 2, 3], direction: [0, 0, -1] }] } });
    assert.deepEqual(received[1], [{ id: 7, rays: [{ originMm: [1, 2, 3], direction: [0, 0, -1] }] }, "r1"]);
  });
});

test("plasticity_probe_surface and plasticity_exact_bounds work through plasticity_call and a lean batch", async () => {
  const exact = { revision: "r1", method: "native-support-points", toleranceMm: 0.001, bodies: [{ id: 7, type: "Solid", boundsMm: { min: [0, 0, 0], max: [1, 1, 1] }, exact: true, maxErrorMm: 1e-5, conservativeBoundsMm: null, overshootMm: 0 }], note: "n" };
  const calls: string[] = [];
  await withSurfacingClient({
    async state() { return emptyState(); },
    async probeSurface() { calls.push("probe"); return probeReply; },
    async exactBounds(ids: number[], revision?: string) { calls.push(`exact:${ids.join(",")}:${revision}`); return exact; },
  }, async (client) => {
    const routed = await client.callTool({ name: "plasticity_call", arguments: { toolName: "plasticity_probe_surface", arguments: { id: 7, revision: "r1", gridMm: { at: [[0, 0]] } } } });
    assert.deepEqual(parseToolJson(routed), probeReply);
    const routedExact = await client.callTool({ name: "plasticity_call", arguments: { toolName: "plasticity_exact_bounds", arguments: { ids: [7] } } });
    assert.deepEqual(parseToolJson(routedExact), exact);
    const batch = await client.callTool({ name: "plasticity_batch", arguments: { detail: "lean", steps: [
      { toolName: "plasticity_probe_surface", arguments: { id: 7, gridMm: { at: [[0, 0]] } }, return: ["rays[0].intersections[0].pointMm"] },
      { toolName: "plasticity_exact_bounds", arguments: { ids: [7] }, return: ["bodies[0].boundsMm.max"] },
    ] } });
    assert.equal(batch.isError, undefined, JSON.stringify(batch));
    const reply = parseToolJson(batch);
    assert.deepEqual(reply.steps.map((step: { result: unknown }) => step.result), [{ "rays[0].intersections[0].pointMm": [0, 0, 14] }, { "bodies[0].boundsMm.max": [1, 1, 1] }]);
    assert.deepEqual(calls, ["probe", "exact:7:undefined", "probe", "exact:7:r1"]);
  });
});

test("plasticity_describe_body adds boundsExact and boundsNote from the operations layer, and nothing when it is absent", async () => {
  const body = { id: 7, versionId: 70, type: "Sheet", name: "pad", boundsMm: { min: [0, 0, 0], max: [10, 20, 9] }, boundsMethod: "native-box", faceIds: ["7f1"], edgeIds: [], faces: [{ id: "7f1", surfaceType: "BSpline", planar: false, centerMm: [5, 10, 4], normal: [0, 0, 1], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 0], max: [10, 20, 9] }, edgeIds: [] }], edges: [] } as unknown as RuntimeState["bodies"][number];
  await withSurfacingClient({
    async state() { return emptyState([body]); },
    async describeBoundsExactness() { return new Map([[7, { boundsExact: false, boundsNote: "conservative kernel box (B-spline control hull), up to 2.25 mm too large; plasticity_exact_bounds gives the exact extent" }]]); },
  }, async (client) => {
    const one = parseToolJson(await client.callTool({ name: "plasticity_describe_body", arguments: { id: 7 } }));
    assert.equal(one.boundsExact, false);
    assert.match(one.boundsNote, /control hull/);
    const many = parseToolJson(await client.callTool({ name: "plasticity_describe_body", arguments: { ids: [7] } }));
    assert.equal(many.bodies[0].boundsExact, false);
  });
  await withSurfacingClient({ async state() { return emptyState([body]); } }, async (client) => {
    const one = parseToolJson(await client.callTool({ name: "plasticity_describe_body", arguments: { id: 7 } }));
    assert.equal("boundsExact" in one, false);
  });
});

test("the compact catalog keeps plasticity_probe_surface callable through plasticity_call", async () => {
  await withSurfacingClient({ async probeSurface() { return probeReply; } }, async (client) => {
    const found = parseToolJson(await client.callTool({ name: "plasticity_call", arguments: { toolName: "catalog", query: "plasticity_probe_surface" } }));
    assert.equal(found.tools[0].name, "plasticity_probe_surface");
    const routed = await client.callTool({ name: "plasticity_call", arguments: { toolName: "plasticity_probe_surface", arguments: { id: 7, revision: "r1", gridMm: { at: [[0, 0]] } } } });
    assert.deepEqual(parseToolJson(routed), probeReply);
  }, true);
});

test("plasticity_screenshot passes shader and frame to the operations layer for a file and for the inline JPEG; bad values fail first", async () => {
  const views: unknown[] = [];
  const captures: string[] = [];
  await withSurfacingClient({
    async screenshot(path: string, mode: string) { captures.push(`file:${path}:${mode}`); return { path, bytes: 10 }; },
    async screenshotImage(maxWidth: number) { captures.push(`inline:${maxWidth}`); return { data: "/9j/AA==", mimeType: "image/jpeg", width: 10, height: 8, bytes: 4 }; },
    async screenshotView(view: unknown, capture: () => Promise<Record<string, unknown>>) { views.push(view); return { ...(await capture()), view: { shader: { mode: "topo", previous: null, restored: null } } }; },
  }, async (client) => {
    for (const bad of [{ shader: "curvature" }, { frame: { bodyIds: [] } }, { frame: { bodyIds: [1, 1] } }, { frame: { bodyIds: [1], extra: true } }]) {
      assert.equal((await client.callTool({ name: "plasticity_screenshot", arguments: bad })).isError, true, JSON.stringify(bad));
    }
    assert.equal(views.length, 0);
    const file = parseToolJson(await client.callTool({ name: "plasticity_screenshot", arguments: { path: "/tmp/x.png", captureMode: "viewport", shader: "topo", frame: { bodyIds: [3] } } }));
    assert.deepEqual(file, { path: "/tmp/x.png", bytes: 10, view: { shader: { mode: "topo", previous: null, restored: null } } });
    const inline = await client.callTool({ name: "plasticity_screenshot", arguments: { shader: "topo", maxWidth: 256 } });
    const content = inline.content as Array<{ type: string; text?: string }>;
    assert.ok(content.some((entry) => entry.type === "image"));
    assert.equal(JSON.parse(content.find((entry) => entry.type === "text")!.text!).view.shader.mode, "topo");
    assert.deepEqual(views, [{ shader: "topo", frame: { bodyIds: [3] } }, { shader: "topo" }]);
    assert.deepEqual(captures, ["file:/tmp/x.png:viewport", "inline:256"]);
    // Without shader or frame the old path runs and screenshotView is not called.
    await client.callTool({ name: "plasticity_screenshot", arguments: { path: "/tmp/y.png" } });
    assert.equal(views.length, 2);
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "plasticity_screenshot")!;
    assert.match(tool.description ?? "", /restores the previous shader in the same call, also when the capture fails/);
  });
});

test("the continuity description explains relative G2, interior and worstAt", async () => {
  await withSurfacingClient({}, async (client) => {
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "plasticity_analyze_surface_continuity")!;
    assert.match(tool.description ?? "", /reads 1\.0 whenever one side is flat/);
    assert.match(tool.description ?? "", /samples 5\.\.94/);
    assert.match(tool.description ?? "", /worstAt/);
    const xsided = (await client.listTools()).tools.find((entry) => entry.name === "plasticity_xsided_patch")!;
    assert.match(xsided.description ?? "", /keeps the raw XNurbs code and says what it means: 30 = /);
  });
});
