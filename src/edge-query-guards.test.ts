import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { PLASTICITY_MCP_INSTRUCTIONS } from "./server-instructions.ts";
import { createCompactServer, type SessionLike } from "./server.ts";
import type { PlasticityOperations } from "./plasticity/operations.ts";
import type { RuntimeState } from "./plasticity/runtime.ts";

// edgeQuery / faceQuery guards on fillet, chamfer and extrude_faces: an empty query never means "all", prototype keys are
// refused, ties are deterministic, limit needs sortBy, and the replies and errors name what was picked.

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
  const client = new Client({ name: "edge-query-guards-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const failure = async (client: Client, name: string, args: Record<string, unknown>): Promise<string> => {
  const response = await client.callTool({ name, arguments: { id: 1, radiusMm: 1, distanceMm: 1, revision: "r1", ...args } });
  assert.equal(response.isError, true, `${name} ${JSON.stringify(args)} should fail`);
  return text(response);
};

test("an empty edgeQuery or faceQuery is an error, never every edge or face; nothing runs", async () => {
  const run = open(stateOf([block()]));
  const { client, close } = await connect(run.fake);
  assert.match(await failure(client, "plasticity_fillet", { edgeQuery: {} }), /edgeQuery needs at least one criterion/);
  assert.match(await failure(client, "plasticity_chamfer", { edgeQuery: {} }), /edgeQuery needs at least one criterion/);
  assert.match(await failure(client, "plasticity_extrude_faces", { faceQuery: {} }), /faceQuery needs at least one criterion/);
  assert.match(await failure(client, "plasticity_fillet", { edgeQuery: { adjacentFace: {} } }), /adjacentFace needs at least one criterion/);
  assert.match(await failure(client, "plasticity_fillet", { edgeQuery: { adjacentFace: { sortBy: "z", limit: 1 } } }), /adjacentFace needs at least one criterion/);
  const batch = await client.callTool({ name: "plasticity_batch", arguments: { steps: [{ toolName: "plasticity_fillet", arguments: { id: 1, edgeQuery: {}, radiusMm: 1 } }] } });
  assert.equal(batch.isError, true);
  assert.match(text(batch), /edgeQuery needs at least one criterion/);
  assert.deepEqual(run.calls, [], "no native call ran");
  // A real criterion still works.
  const reply = json(await client.callTool({ name: "plasticity_fillet", arguments: { id: 1, edgeQuery: { line: true }, radiusMm: 1, revision: "r1" } }));
  assert.equal(reply.edgeCount, 8);
  await close();
});

test("__proto__, constructor and prototype keys are refused by name, also nested, not dropped silently", async () => {
  const run = open(stateOf([block()]));
  const { client, close } = await connect(run.fake);
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const edgeQuery = JSON.parse(`{"${key}": {"line": true}}`);
    assert.ok(Object.getOwnPropertyNames(edgeQuery).includes(key), `${key} is an own key of the raw query`);
    assert.match(await failure(client, "plasticity_fillet", { edgeQuery }), new RegExp(`edgeQuery\\.${key} is not allowed`), key);
    assert.match(await failure(client, "plasticity_chamfer", { edgeQuery: JSON.parse(`{"line": true, "${key}": 1}`) }), new RegExp(`${key} is not allowed`), key);
    assert.match(await failure(client, "plasticity_extrude_faces", { faceQuery: JSON.parse(`{"${key}": {"planar": true}}`) }), new RegExp(`faceQuery\\.${key} is not allowed`), key);
    assert.match(await failure(client, "plasticity_fillet", { edgeQuery: JSON.parse(`{"adjacentFace": {"${key}": 1, "planar": true}}`) }), new RegExp(`${key} is not allowed`), key);
  }
  const viaBatch = await client.callTool({ name: "plasticity_batch", arguments: { steps: [{ toolName: "plasticity_fillet", arguments: { id: 1, edgeQuery: JSON.parse('{"__proto__": {"line": true}}'), radiusMm: 1 } }] } });
  assert.equal(viaBatch.isError, true);
  assert.match(text(viaBatch), /__proto__ is not allowed/);
  assert.deepEqual(run.calls, []);
  await close();
});

test("ties are broken by quantised value, then id: the same edges come out whatever the model order", async () => {
  const forward = block();
  const shuffled = block();
  shuffled.edges.reverse();
  const picks: string[][] = [];
  for (const body of [forward, shuffled]) {
    const run = open(stateOf([body]));
    const { client, close } = await connect(run.fake);
    const reply = json(await client.callTool({ name: "plasticity_chamfer", arguments: { id: 1, edgeQuery: { line: true }, sortBy: "length", limit: 3, distanceMm: 1, revision: "r1" } }));
    picks.push(run.calls[0]!.args[1] as string[]);
    assert.deepEqual(reply.edgeIds, ["e5", "e7", "e6"], "the 40 mm edges, then the first 30 mm edge by id");
    assert.equal(reply.tie, true, "limit 3 cuts through the two 30 mm edges");
    await close();
  }
  assert.deepEqual(picks[0], picks[1]);

  // Values closer than 1e-6 mm are one value; the id decides.
  const close1 = block();
  close1.edges[4]!.lengthMm = 40.0000004;
  const run = open(stateOf([close1]));
  const connected = await connect(run.fake);
  const reply = json(await connected.client.callTool({ name: "plasticity_chamfer", arguments: { id: 1, edgeQuery: { line: true }, sortBy: "length", limit: 1, distanceMm: 1, revision: "r1" } }));
  assert.deepEqual(reply.edgeIds, ["e5"]);
  assert.equal(reply.tie, true, "e5 and e7 are the same length within 1e-6 mm");
  await connected.close();
});

test("tie appears only when limit cuts through a group of equal values", async () => {
  const run = open(stateOf([block()]));
  const { client, close } = await connect(run.fake);
  const clean = json(await client.callTool({ name: "plasticity_chamfer", arguments: { id: 1, edgeQuery: { line: true }, sortBy: "length", limit: 2, distanceMm: 1, revision: "r1" } }));
  assert.deepEqual(clean.edgeIds, ["e5", "e7"]);
  assert.equal("tie" in clean, false, "the two longest are the whole 40 mm group");
  const all = json(await client.callTool({ name: "plasticity_chamfer", arguments: { id: 1, edgeQuery: { line: true }, sortBy: "length", distanceMm: 1, revision: run.current().revision } }));
  assert.equal("tie" in all, false, "no limit, no cut");
  const faces = json(await client.callTool({ name: "plasticity_extrude_faces", arguments: { id: 1, faceQuery: { planar: true, normal: { vector: [0, 0, 1] } }, sortBy: "z", order: "desc", limit: 1, distanceMm: 1, revision: run.current().revision } }));
  assert.deepEqual(faces.faceIds, ["shelf"], "top and shelf share z 10; the id decides");
  assert.equal(faces.tie, true);
  await close();
});

test("limit needs sortBy on edgeQuery and faceQuery", async () => {
  const run = open(stateOf([block()]));
  const { client, close } = await connect(run.fake);
  assert.match(await failure(client, "plasticity_fillet", { edgeQuery: { line: true }, limit: 2 }), /limit needs sortBy/);
  assert.match(await failure(client, "plasticity_chamfer", { edgeQuery: { line: true }, limit: 2 }), /limit needs sortBy/);
  assert.match(await failure(client, "plasticity_extrude_faces", { faceQuery: { planar: true }, limit: 1 }), /limit needs sortBy/);
  assert.match(await failure(client, "plasticity_fillet", { edgeQuery: { adjacentFace: { planar: true, limit: 1 } } }), /limit needs sortBy/);
  assert.deepEqual(run.calls, []);
  await close();
});

test("a native failure after a query pick names the count and the first 8 ids, and keeps its own message", async () => {
  const many = block();
  for (let index = 9; index <= 20; index += 1) many.edges.push(line(`e${index}`, [1, 0, 0], [index, 0, 1], 5, ["low"]));
  const run = open(stateOf([many]), {
    async fillet() { throw new Error("Fillet failed: radius too large"); },
    async chamfer() { throw new Error("Chamfer failed"); },
    async extrudeFaces() { throw new Error("Extrude failed"); },
  });
  const { client, close } = await connect(run.fake);
  const fillet = await failure(client, "plasticity_fillet", { edgeQuery: { line: true } });
  assert.match(fillet, /Fillet failed: radius too large \(edgeQuery picked 20 edges; first 8: e1, e2, e3, e4, e5, e6, e7, e8\)/);
  assert.doesNotMatch(fillet, /e9\b/);
  assert.match(await failure(client, "plasticity_chamfer", { edgeQuery: { circle: false }, sortBy: "length", limit: 2 }), /Chamfer failed \(edgeQuery picked 2 edges; first 2: e5, e7\)/);
  assert.match(await failure(client, "plasticity_extrude_faces", { faceQuery: { planar: true } }), /Extrude failed \(faceQuery picked 4 faces; first 4: top, shelf, low, bottom\)/);
  // edgeIds picks are the caller's own and are not annotated.
  assert.doesNotMatch(await failure(client, "plasticity_fillet", { edgeIds: ["e1"] }), /edgeQuery picked/);
  await close();
});

test("a reply lists edgeIds up to 16 edges, and gives edgeCount only above that", async () => {
  const many = block();
  for (let index = 9; index <= 20; index += 1) many.edges.push(line(`e${index}`, [1, 0, 0], [index, 0, 1], 5, ["low"]));
  const run = open(stateOf([many]));
  const { client, close } = await connect(run.fake);
  const sixteen = json(await client.callTool({ name: "plasticity_fillet", arguments: { id: 1, edgeQuery: { line: true }, sortBy: "length", limit: 16, radiusMm: 1, revision: "r1" } }));
  assert.equal(sixteen.edgeCount, 16);
  assert.equal(sixteen.edgeIds.length, 16);
  const twenty = json(await client.callTool({ name: "plasticity_fillet", arguments: { id: 1, edgeQuery: { line: true }, radiusMm: 1, revision: run.current().revision } }));
  assert.equal(twenty.edgeCount, 20);
  assert.equal("edgeIds" in twenty, false, "above 16 edges only the count");
  assert.equal("tie" in twenty, false);
  await close();
});

test("the adjacentFace shorthand selects every edge of the face, inner loops included; the read model has no outer loop, so there is no outerLoopOnly", async () => {
  // A top face with an outer loop (e5-e8) and an inner pocket loop (p1-p4): the shorthand takes all eight.
  const body = block();
  body.faces.find((face) => face.id === "shelf")!.centerMm = [20, 15, 9];
  for (let index = 1; index <= 4; index += 1) body.edges.push(line(`p${index}`, [1, 0, 0], [10 + index, 10, 10], 5, ["top"]));
  const run = open(stateOf([body]));
  const { client, close } = await connect(run.fake);
  const reply = json(await client.callTool({ name: "plasticity_chamfer", arguments: { id: 1, edgeQuery: { adjacentFace: { planar: true, normal: { vector: [0, 0, 1] }, sortBy: "z", order: "desc", limit: 1 } }, distanceMm: 1, revision: "r1" } }));
  assert.equal("tie" in reply, false, "the shelf is lower: no tie");
  assert.equal(reply.edgeCount, 12, "inner loop edges are included");
  assert.match(await failure(client, "plasticity_chamfer", { edgeQuery: { adjacentFace: { planar: true, outerLoopOnly: true } }, revision: run.current().revision }), /Invalid edgeQuery/);
  assert.match(PLASTICITY_MCP_INSTRUCTIONS, /every edge of the top face, inner loops included/);
  assert.match(PLASTICITY_MCP_INSTRUCTIONS, /never empty/);
  assert.ok(Buffer.byteLength(PLASTICITY_MCP_INSTRUCTIONS) - 4_349 <= 250, `instructions grew by ${Buffer.byteLength(PLASTICITY_MCP_INSTRUCTIONS) - 4_349}`);
  await close();
});

test("the edgeQuery and faceQuery fields stay objects in the tool list and say they are never empty", async () => {
  const { client, close } = await connect(open(stateOf([block()])).fake);
  const tools = (await client.listTools()).tools;
  for (const [tool, field] of [["plasticity_fillet", "edgeQuery"], ["plasticity_chamfer", "edgeQuery"], ["plasticity_extrude_faces", "faceQuery"]] as const) {
    const property = (tools.find((entry) => entry.name === tool)!.inputSchema as { properties: Record<string, { description?: string }> }).properties[field]!;
    assert.match(property.description ?? "", /needs at least one criterion/, `${tool}.${field}`);
  }
  await close();
});
