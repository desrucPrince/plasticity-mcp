import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer, type SessionLike } from "./server.ts";
import type { PlasticityOperations } from "./plasticity/operations.ts";
import type { RuntimeState } from "./plasticity/runtime.ts";

// Server registrations touched by the review follow-ups (driving distance lifecycle, face control points).

function emptyState(): RuntimeState {
  return {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" }, bodies: [],
  };
}

function parseToolJson(response: unknown): any {
  const content = (response as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const item = content.find((entry) => entry.type === "text" && typeof entry.text === "string");
  if (!item) throw new Error("Tool response has no JSON text");
  return JSON.parse(item.text!);
}

async function withOperationsClient<T>(operations: Record<string, (...args: unknown[]) => Promise<unknown>>, run: (client: Client) => Promise<T>): Promise<T> {
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
  const client = new Client({ name: "review-followups-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

test("plasticity_hide_face_control_points is registered once, strict, directly after the show tool", async () => {
  await withOperationsClient({}, async (client) => {
    const tools = (await client.listTools()).tools;
    const names = tools.map((entry) => entry.name);
    assert.equal(names.filter((name) => name === "plasticity_hide_face_control_points").length, 1);
    assert.equal(names.indexOf("plasticity_hide_face_control_points"), names.indexOf("plasticity_show_face_control_points") + 1);
    const hide = tools.find((entry) => entry.name === "plasticity_hide_face_control_points")!;
    const schema = hide.inputSchema as { additionalProperties?: unknown; properties?: Record<string, unknown>; required?: string[] };
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ["bodyId", "faceIds", "intent", "revision"]);
    assert.deepEqual([...(schema.required ?? [])].sort(), ["bodyId", "faceIds", "revision"]);
    assert.match(hide.description ?? "", /history step/);
    assert.match(hide.description ?? "", /cvIds of the body's remaining shown points change/);
    const show = tools.find((entry) => entry.name === "plasticity_show_face_control_points")!.description ?? "";
    assert.match(show, /valid only at the revision/);
    assert.match(show, /faceId/);
    assert.match(show, /non-BSurf faces are rejected before any edit/);
    assert.match(show, /stale cvId is rejected, never applied to another point/);
    assert.match(show, /plasticity_hide_face_control_points/);
    assert.match(tools.find((entry) => entry.name === "plasticity_move_face_control_points")!.description ?? "", /read back/);
  });
});

test("show, hide and move return faces, undoSteps and messages next to the compact change", async () => {
  const received: Record<string, unknown[]> = {};
  const points = [{ cvId: "67c0", faceId: "67f3210", index: 0, positionMm: [2900, 0, 0] }];
  await withOperationsClient({
    async showFaceControlPoints(...args: unknown[]) { received.show = args; return { state: emptyState(), faces: [{ requestedFaceId: "66f3210", faceId: "67f3210", controlPointCount: 1 }], controlPoints: points, undoSteps: 1 }; },
    async hideFaceControlPoints(...args: unknown[]) { received.hide = args; return { state: emptyState(), faces: [{ requestedFaceId: "66f3210", faceId: "66f3210", controlPointCount: 0 }], controlPoints: [], undoSteps: 0, message: "no control points of these faces are shown; nothing changed" }; },
    async moveFaceControlPoints(...args: unknown[]) { received.move = args; return { state: emptyState(), controlPoints: points, undoSteps: 1 }; },
    async state() { return emptyState(); },
  }, async (client) => {
    const show = await client.callTool({ name: "plasticity_show_face_control_points", arguments: { bodyId: 9, faceIds: ["66f3210"], revision: "r1" } });
    assert.equal(show.isError, undefined, JSON.stringify(show.content));
    assert.deepEqual(received.show, [9, ["66f3210"], "r1"]);
    const shown = parseToolJson(show);
    assert.deepEqual(shown.faces, [{ requestedFaceId: "66f3210", faceId: "67f3210", controlPointCount: 1 }]);
    assert.deepEqual(shown.controlPoints, points);
    assert.equal(shown.undoSteps, 1);
    assert.equal(typeof shown.revision, "string");
    const hide = await client.callTool({ name: "plasticity_hide_face_control_points", arguments: { bodyId: 9, faceIds: ["66f3210"], revision: "r1", intent: "tidy" } });
    assert.equal(hide.isError, undefined, JSON.stringify(hide.content));
    assert.deepEqual(received.hide, [9, ["66f3210"], "r1"]);
    assert.equal(parseToolJson(hide).undoSteps, 0);
    assert.match(parseToolJson(hide).message, /nothing changed/);
    const move = await client.callTool({ name: "plasticity_move_face_control_points", arguments: { bodyId: 9, cvIds: ["67c0"], deltaMm: [0, 0, 1], revision: "r1" } });
    assert.equal(move.isError, undefined, JSON.stringify(move.content));
    assert.equal(parseToolJson(move).undoSteps, 1);
    assert.deepEqual(received.move, [9, ["67c0"], [0, 0, 1], "r1"]);
    delete received.move;
    for (const bad of [{ cvIds: [0] }, { cvIds: [""] }, { cvIds: ["67c0", "67c0"] }, { cvIds: [] }]) {
      const response = await client.callTool({ name: "plasticity_move_face_control_points", arguments: { bodyId: 9, deltaMm: [0, 0, 1], revision: "r1", ...bad } });
      assert.equal(response.isError, true, JSON.stringify(bad));
    }
    assert.equal(received.move, undefined, "integer or empty cvIds never reach the operation");
    delete received.hide;
    for (const bad of [{ faceIds: [] }, { faceIds: ["a", "a"] }, { bodyId: 0 }, { show: false }]) {
      const response = await client.callTool({ name: "plasticity_hide_face_control_points", arguments: { bodyId: 9, faceIds: ["66f3210"], revision: "r1", ...bad } });
      assert.equal(response.isError, true, JSON.stringify(bad));
    }
    assert.equal(received.hide, undefined, "a rejected hide never reaches the operation");
  });
});

test("plasticity_set_driving_distance says it clears the selection and passes the read-back fields through", async () => {
  await withOperationsClient({
    async setDrivingDistance() {
      return { state: { ...emptyState(), revision: "r2", undoDepth: 1 }, changed: true, previousDistanceMm: 20, distanceMm: 30, undoSteps: 1, movedFaceId: "8f514", movingFaceId: "8f514", planeOffsetMm: 2030 };
    },
    async state() { return emptyState(); },
  }, async (client) => {
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "plasticity_set_driving_distance")!;
    assert.match(tool.description ?? "", /clears the current Plasticity selection/);
    assert.match(tool.description ?? "", /same way \(two steps of a stepped block\)/);
    assert.match(tool.description ?? "", /changed false and undoSteps 0/);
    assert.match(tool.description ?? "", /Verified on Plasticity 26\.1\.3 only/);
    const response = await client.callTool({ name: "plasticity_set_driving_distance", arguments: { bodyId: 5, movingFaceId: "7f514", referenceFaceId: "7f559", distanceMm: 30, revision: "r1" } });
    assert.equal(response.isError, undefined, JSON.stringify(response.content));
    const output = parseToolJson(response);
    assert.equal(output.changed, true);
    assert.equal(output.movedFaceId, "8f514");
    assert.equal(output.planeOffsetMm, 2030);
    assert.equal(output.state, undefined, "the raw state is not echoed; the compact change is");
  });
});

test("plasticity_set_driving_distance reports a no-op without an error", async () => {
  await withOperationsClient({
    async setDrivingDistance() {
      return { state: emptyState(), changed: false, previousDistanceMm: 20, distanceMm: 20, undoSteps: 0, movedFaceId: null, movingFaceId: "7f514", planeOffsetMm: 2020, message: "distance already 20 mm; nothing changed" };
    },
    async state() { return emptyState(); },
  }, async (client) => {
    const response = await client.callTool({ name: "plasticity_set_driving_distance", arguments: { bodyId: 5, movingFaceId: "7f514", referenceFaceId: "7f559", distanceMm: 20, revision: "r1" } });
    assert.equal(response.isError, undefined, JSON.stringify(response.content));
    const output = parseToolJson(response);
    assert.equal(output.changed, false);
    assert.equal(output.undoSteps, 0);
    assert.match(output.message, /distance already 20 mm/);
  });
});

test("the X-sided patch and PolySplines descriptions state only what was verified live", async () => {
  await withOperationsClient({}, async (client) => {
    const tools = (await client.listTools()).tools;
    const xsided = tools.find((entry) => entry.name === "plasticity_xsided_patch")!.description ?? "";
    assert.match(xsided, /closed edge loop of a Solid/);
    assert.match(xsided, /with curveIds or with edges/);
    assert.match(xsided, /tested only with a Studio licence/);
    const poly = tools.find((entry) => entry.name === "plasticity_convert_reference_mesh_to_polysplines")!.description ?? "";
    assert.match(poly, /triangle mesh also converts/);
    assert.match(poly, /not verified/);
    assert.doesNotMatch(poly, /pins open boundaries/);
    assert.doesNotMatch(poly, /merges patches into fewer faces/);
  });
});
