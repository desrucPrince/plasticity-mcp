import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createCompactServer, type SessionLike } from "./server.ts";
import type { PlasticityOperations } from "./plasticity/operations.ts";
import { findEdges, findFaces } from "./plasticity/semantic.ts";
import type { RuntimeState } from "./plasticity/runtime.ts";

// An empty list criterion (adjacentFaceIds: [], adjacentEdgeIds: [], ...) names nothing and matches nothing. It never selects everything:
// not in the matchers, not in find_edges / find_faces, and not in the edgeQuery / faceQuery of fillet, chamfer and extrude_faces.

type Vec = [number, number, number];
type Face = RuntimeState["bodies"][number]["faces"][number];
type Edge = RuntimeState["bodies"][number]["edges"][number];
const box = (min: Vec, max: Vec) => ({ min, max });
const text = (response: unknown): string => (response as { content: Array<{ type: string; text?: string }> }).content.find((entry) => entry.type === "text")!.text!;
const json = (response: unknown): any => JSON.parse(text(response));

function plane(id: string, center: Vec, normal: Vec, half = 5): Face {
  const spread = (axis: number) => half * Math.abs(1 - Math.abs(normal[axis]!));
  return {
    id, surfaceType: "Plane", planar: true, centerMm: center, normal, radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null,
    boundsMm: box([center[0] - spread(0), center[1] - spread(1), center[2] - spread(2)], [center[0] + spread(0), center[1] + spread(1), center[2] + spread(2)]), edgeIds: ["e1"],
  } as Face;
}
function line(id: string, tangent: Vec, center: Vec, lengthMm: number, faceIds: string[]): Edge {
  return { id, curveType: "Line", line: true, circle: false, lengthMm, centerMm: center, tangent, boundsMm: box(center, center), faceIds, vertexIds: [] } as Edge;
}
function bodyOf(faces: Face[], edges: Edge[]) {
  return { id: 1, versionId: 10, type: "Solid", name: "part", boundsMm: box([0, 0, 0], [40, 30, 10]), faceIds: faces.map((face) => face.id), edgeIds: edges.map((edge) => edge.id), faces, edges };
}
// Four vertical edges (e1-e4, length 10, ties), four top edges (e5-e8, lengths 40, 30, 40, 30) and two faces at the same height.
function block() {
  return bodyOf(
    [plane("top", [20, 15, 10], [0, 0, 1], 15), plane("shelf", [20, 15, 10], [0, 0, 1], 15), plane("low", [20, 15, 4], [0, 0, 1], 15), plane("bottom", [20, 15, 0], [0, 0, -1], 15)],
    [
      line("e1", [0, 0, 1], [0, 0, 5], 10, ["top"]), line("e2", [0, 0, 1], [40, 0, 5], 10, ["top"]), line("e3", [0, 0, 1], [0, 30, 5], 10, ["top"]), line("e4", [0, 0, 1], [40, 30, 5], 10, ["top"]),
      line("e5", [1, 0, 0], [20, 0, 10], 40, ["top"]), line("e6", [0, 1, 0], [40, 15, 10], 30, ["top"]), line("e7", [1, 0, 0], [20, 30, 10], 40, ["top"]), line("e8", [0, 1, 0], [0, 15, 10], 30, ["top"]),
    ],
  );
}
function stateOf(bodies: unknown[], revision = "r1"): RuntimeState {
  return {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision, dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" }, bodies,
  } as unknown as RuntimeState;
}
function open(initial: RuntimeState, extra: Record<string, unknown> = {}) {
  let state = initial;
  let version = 1;
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const commit = () => { version += 1; state = { ...state, revision: `r${version}`, undoDepth: state.undoDepth + 1, dbVersion: version } as RuntimeState; return state; };
  const operations = {
    async state() { return state; },
    async fillet(...args: unknown[]) { calls.push({ op: "fillet", args }); return commit(); },
    async chamfer(...args: unknown[]) { calls.push({ op: "chamfer", args }); return commit(); },
    async extrudeFaces(...args: unknown[]) { calls.push({ op: "extrudeFaces", args }); return commit(); },
    ...extra,
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: { constructionPlanes: { available: false, reason: "test" }, activeWorkplane: { available: false, reason: "test" } } }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  return { fake, calls, current: () => state };
}
async function connect(fake: SessionLike) {
  const server = createCompactServer(fake, undefined, undefined, undefined, null);
  const client = new Client({ name: "empty-list-query-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const fail = async (client: Client, name: string, args: Record<string, unknown>): Promise<string> => {
  const response = await client.callTool({ name, arguments: { id: 1, radiusMm: 1, distanceMm: 1, revision: "r1", ...args } });
  assert.equal(response.isError, true, `${name} ${JSON.stringify(args)} should fail`);
  return text(response);
};

test("matcher audit: every list-valued criterion with an empty list matches nothing", () => {
  const state = stateOf([block()]);
  assert.ok(findEdges(state, {}).length > 0, "the control: no criterion matches every edge");
  assert.ok(findFaces(state, {}).length > 0);
  // Edge list criteria: adjacentFaceIds (was every() on [] = all), edgeIds, curveTypes, bodyIds.
  assert.deepEqual(findEdges(state, { adjacentFaceIds: [] }), []);
  assert.deepEqual(findEdges(state, { edgeIds: [] }), []);
  assert.deepEqual(findEdges(state, { curveTypes: [] }), []);
  assert.deepEqual(findEdges(state, { bodyIds: [] }), []);
  // Face list criteria: adjacentEdgeIds (was every() on [] = all), surfaceTypes, bodyIds.
  assert.deepEqual(findFaces(state, { adjacentEdgeIds: [] }), []);
  assert.deepEqual(findFaces(state, { surfaceTypes: [] }), []);
  assert.deepEqual(findFaces(state, { bodyIds: [] }), []);
  // A non-empty list still works, and an empty one beside a real criterion still matches nothing.
  assert.equal(findEdges(state, { adjacentFaceIds: ["top"] }).length, 8);
  assert.deepEqual(findEdges(state, { adjacentFaceIds: [], line: true }), []);
  assert.deepEqual(findFaces(state, { adjacentEdgeIds: [], planar: true }), []);
});

test("direct plasticity_find_edges / plasticity_find_faces: an explicitly empty adjacency list returns zero matches", async () => {
  const run = open(stateOf([block()]));
  const { client, close } = await connect(run.fake);
  const edges = json(await client.callTool({ name: "plasticity_find_edges", arguments: { revision: "r1", query: { adjacentFaceIds: [] } } }));
  assert.equal(edges.count, 0);
  assert.deepEqual(edges.matches, []);
  const faces = json(await client.callTool({ name: "plasticity_find_faces", arguments: { revision: "r1", query: { adjacentEdgeIds: [] } } }));
  assert.equal(faces.count, 0);
  assert.deepEqual(faces.matches, []);
  const control = json(await client.callTool({ name: "plasticity_find_edges", arguments: { revision: "r1", query: { adjacentFaceIds: ["top"] } } }));
  assert.equal(control.count, 8);
  await close();
});

test("edgeQuery / faceQuery with an empty list is rejected by name and mutates nothing: direct and through plasticity_call", async () => {
  const run = open(stateOf([block()]));
  const { client, close } = await connect(run.fake);
  assert.match(await fail(client, "plasticity_fillet", { edgeQuery: { adjacentFaceIds: [] } }), /edgeQuery: adjacentFaceIds is an empty list/);
  assert.match(await fail(client, "plasticity_chamfer", { edgeQuery: { adjacentFaceIds: [] } }), /edgeQuery: adjacentFaceIds is an empty list/);
  assert.match(await fail(client, "plasticity_extrude_faces", { faceQuery: { adjacentEdgeIds: [] } }), /faceQuery: adjacentEdgeIds is an empty list/);
  // An empty list beside a real criterion is rejected too, not left to match nothing.
  assert.match(await fail(client, "plasticity_fillet", { edgeQuery: { line: true, adjacentFaceIds: [] } }), /adjacentFaceIds is an empty list/);
  assert.match(await fail(client, "plasticity_fillet", { edgeQuery: { edgeIds: [] } }), /edgeIds is an empty list/);
  assert.match(await fail(client, "plasticity_fillet", { edgeQuery: { curveTypes: [] } }), /curveTypes is an empty list/);
  assert.match(await fail(client, "plasticity_extrude_faces", { faceQuery: { surfaceTypes: [] } }), /surfaceTypes is an empty list/);
  assert.match(await fail(client, "plasticity_fillet", { edgeQuery: { adjacentFace: { surfaceTypes: [] } } }), /edgeQuery\.adjacentFace: surfaceTypes is an empty list/);
  // Through the router.
  for (const [toolName, args] of [
    ["plasticity_fillet", { id: 1, edgeQuery: { adjacentFaceIds: [] }, radiusMm: 1, revision: "r1" }],
    ["plasticity_chamfer", { id: 1, edgeQuery: { adjacentFaceIds: [] }, distanceMm: 1, revision: "r1" }],
    ["plasticity_extrude_faces", { id: 1, faceQuery: { adjacentEdgeIds: [] }, distanceMm: 1, revision: "r1" }],
  ] as const) {
    const routed = await client.callTool({ name: "plasticity_call", arguments: { toolName, arguments: args } });
    assert.equal(routed.isError, true, toolName);
    assert.match(text(routed), /is an empty list/, toolName);
  }
  assert.deepEqual(run.calls, [], "no native call ran");
  // The same queries with a real id list still work.
  const reply = json(await client.callTool({ name: "plasticity_fillet", arguments: { id: 1, edgeQuery: { adjacentFaceIds: ["top"] }, radiusMm: 1, revision: "r1" } }));
  assert.equal(reply.edgeCount, 8);
  await close();
});

test("batch: an empty $n reference in edgeQuery / faceQuery stops the step before it runs and names the reference", async () => {
  const run = open(stateOf([block()]));
  const { client, close } = await connect(run.fake);
  const noMatch = { toolName: "plasticity_find_faces", arguments: { query: { bodyIds: [1], surfaceTypes: ["Cone"] } } };
  const fillet = await client.callTool({ name: "plasticity_batch", arguments: { steps: [noMatch, { toolName: "plasticity_fillet", arguments: { id: 1, edgeQuery: { adjacentFaceIds: "$0.result.matches[*].id" }, radiusMm: 1 } }] } });
  assert.equal(fillet.isError, true);
  const failed = JSON.parse(text(fillet));
  assert.equal(failed.failedStep, 1);
  assert.match(failed.error, /edgeQuery: adjacentFaceIds is empty because \$0\.result\.matches\[\*\]\.id matched nothing in step 0/);
  assert.match(failed.error, /nothing ran/);
  const extrude = await client.callTool({ name: "plasticity_batch", arguments: { undoOnError: true, steps: [
    { toolName: "plasticity_find_edges", arguments: { query: { bodyIds: [1], curveTypes: ["Arc"] } } },
    { toolName: "plasticity_extrude_faces", arguments: { id: 1, faceQuery: { adjacentEdgeIds: ["$0.result.matches[*].id"] }, distanceMm: 1 } },
  ] } });
  assert.equal(extrude.isError, true);
  assert.match(JSON.parse(text(extrude)).error, /faceQuery: adjacentEdgeIds is empty because \$0\.result\.matches\[\*\]\.id matched nothing in step 0/);
  // A literal empty list in a batch is caught by the tool itself.
  const literal = await client.callTool({ name: "plasticity_batch", arguments: { steps: [{ toolName: "plasticity_chamfer", arguments: { id: 1, edgeQuery: { adjacentFaceIds: [] }, distanceMm: 1 } }] } });
  assert.equal(literal.isError, true);
  assert.match(text(literal), /adjacentFaceIds is an empty list/);
  assert.deepEqual(run.calls, [], "no fillet, chamfer or extrude ran");
  // The same chain with a non-empty reference works.
  const ok = json(await client.callTool({ name: "plasticity_batch", arguments: { steps: [
    { toolName: "plasticity_find_faces", arguments: { query: { bodyIds: [1], planar: true }, sortBy: "z", order: "desc", limit: 1 } },
    { toolName: "plasticity_fillet", arguments: { id: 1, edgeQuery: { adjacentFaceIds: ["$0.result.matches[*].id"] }, radiusMm: 1 } },
  ] } }));
  assert.ok(ok.steps);
  assert.equal(run.calls.length, 1);
  await close();
});
