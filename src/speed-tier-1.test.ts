import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createCompactServer, type SessionLike } from "./server.ts";
import type { PlasticityOperations } from "./plasticity/operations.ts";
import type { RuntimeState } from "./plasticity/runtime.ts";

// Speed tier 1: batch reply shaping (return, detail, roundMm), tool-specific step fields,
// find_faces/find_edges selection, and the compact tool list.

type Vec = [number, number, number];
const box = (min: Vec, max: Vec) => ({ min, max });

const face = (id: string, center: Vec, extra: Record<string, unknown> = {}) => ({
  id, surfaceType: "Plane", planar: true, centerMm: center, normal: [0, 0, 1], radiusMm: null, blendRadiusMm: null,
  axisOriginMm: null, axisDirection: null, boundsMm: box([center[0] - 1, center[1] - 1, center[2]], [center[0] + 1, center[1] + 1, center[2]]),
  edgeIds: ["e1", "e2"], padding: "p".repeat(120), ...extra,
});
const edge = (id: string, curveType: string, lengthMm: number, center: Vec) => ({
  id, curveType, line: curveType === "Line", circle: curveType === "Circle", lengthMm, centerMm: center, tangent: [1, 0, 0],
  boundsMm: box(center, center), faceIds: ["f1"], vertexIds: [],
});

function plate(extraEdges: ReturnType<typeof edge>[] = []) {
  const faces = [
    face("f1", [20, 15, 10]),
    face("f2", [7.5, 7.5, 5], { surfaceType: "Cylinder", planar: false, radiusMm: 2.25, axisOriginMm: [7.5, 7.5, 0], axisDirection: [0, 0, 1] }),
    face("f3", [32.5, 7.5, 5], { surfaceType: "Cylinder", planar: false, radiusMm: 2.25, axisOriginMm: [32.5, 7.5, 0], axisDirection: [0, 0, 1] }),
    face("f4", [20, 15, 0], { normal: [0, 0, -1] }),
    face("f5", [40, 15, 5], { normal: [1, 0, 0] }),
  ];
  const edges = [
    edge("e1", "Line", 40, [20, 0, 0]), edge("e2", "Line", 30, [0, 15, 0]), edge("e3", "Line", 10, [40, 0, 5]),
    edge("e4", "Circle", 14.137166941, [7.5, 7.5, 5]), edge("e5", "Line", 25, [10, 30, 0]), ...extraEdges,
  ];
  return {
    id: 1, versionId: 10, type: "Solid", name: "plate", boundsMm: box([0, 0, 0], [40, 30, 10]),
    faceIds: faces.map((item) => item.id), edgeIds: edges.map((item) => item.id), faces, edges,
  };
}

function toolBody(id: number) {
  return { id, versionId: id * 10, type: "Solid", name: null, boundsMm: box([0, 0, 0], [1.123456, 1, 1]), faceIds: [], edgeIds: [], faces: [], edges: [] };
}

function baseState(): RuntimeState {
  return {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" },
    bodies: [plate()],
  } as unknown as RuntimeState;
}

function unavailableConstruction() {
  return { constructionPlanes: { available: false, reason: "test" }, activeWorkplane: { available: false, reason: "test" } };
}

function parseToolJson(response: unknown): any {
  const content = (response as { content: Array<{ type: string; text?: string }> }).content;
  return JSON.parse(content.find((entry) => entry.type === "text")!.text!);
}

function fixture() {
  let state = baseState();
  let nextId = 10;
  let version = 1;
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const commit = (next: Partial<RuntimeState>) => {
    version += 1;
    state = { ...state, ...next, revision: `r${version}`, undoDepth: state.undoDepth + 1, dbVersion: version } as RuntimeState;
    return state;
  };
  const operations = {
    async state() { return state; },
    async createBox(...args: unknown[]) {
      calls.push({ op: "createBox", args });
      return commit({ bodies: [...state.bodies, toolBody(nextId++)] as unknown as RuntimeState["bodies"] });
    },
    async boolean(targetIds: number[], toolIds: number[], ...rest: unknown[]) {
      calls.push({ op: "boolean", args: [targetIds, toolIds, ...rest] });
      const seams = [edge("s1", "Circle", 3.1415, [9, 9, 9]), edge("s2", "Circle", 6.2831, [9, 9, 8]), edge("s3", "Line", 7, [9, 9, 7])];
      const bodies = state.bodies.filter((item) => !toolIds.includes(item.id)).map((item) => (targetIds.includes(item.id) ? plate(seams) : item));
      return commit({ bodies: bodies as unknown as RuntimeState["bodies"] });
    },
    async fillet(...args: unknown[]) { calls.push({ op: "fillet", args }); return commit({}); },
    async showFaceControlPoints(...args: unknown[]) {
      calls.push({ op: "showFaceControlPoints", args });
      return { state: commit({}), controlPoints: [{ cvId: 3, positionMm: [1.123456789, 2, 3] }, { cvId: 4, positionMm: [4, 5, 6] }] };
    },
    async moveFaceControlPoints(...args: unknown[]) {
      calls.push({ op: "moveFaceControlPoints", args });
      return { state: commit({}), controlPoints: [{ cvId: 3, positionMm: [1, 2, 4] }] };
    },
    async setDrivingDistance(...args: unknown[]) {
      calls.push({ op: "setDrivingDistance", args });
      return { state: commit({}), previousDistanceMm: 20.123456789, distanceMm: 30, undoSteps: 1 };
    },
    async exportStep(...args: unknown[]) {
      calls.push({ op: "exportStep", args });
      return { path: args[1], bytes: 4321 };
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  return { fake, calls };
}

async function connect(fake: SessionLike) {
  const server = createCompactServer(fake, undefined, undefined, undefined, null);
  const client = new Client({ name: "speed-tier-1-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

async function runBatch(client: Client, args: Record<string, unknown>) {
  const response = await client.callTool({ name: "plasticity_batch", arguments: args });
  assert.equal(response.isError, undefined, JSON.stringify(response.content));
  return parseToolJson(response);
}

const STANDARD_STEPS = [
  { toolName: "plasticity_create_box", arguments: { originMm: [0, 0, 0], sizeMm: [2, 2, 2] } },
  { toolName: "plasticity_boolean", arguments: { targetIds: [1], toolIds: ["$0.added[0]"], operation: "difference" } },
  { toolName: "plasticity_find_edges", arguments: { query: { bodyIds: [1], circle: true } } },
  { toolName: "plasticity_fillet", arguments: { id: 1, edgeIds: "$1.result.createdEdges[*].edgeId", radiusMm: 1 } },
];

// The reply the server produced before this change, captured from the unmodified code for STANDARD_STEPS.
const STANDARD_REPLY_BEFORE = String.raw`{"revision":"r4","undoSteps":3,"bodyCount":1,"change":{"added":[],"removed":[],"modified":[{"id":1,"after":{"id":1,"versionId":10,"type":"Solid","name":"plate","boundsMm":{"min":[0,0,0],"max":[40,30,10]},"faceCount":5,"edgeCount":8,"vertexCount":null}}],"regionsAdded":[]},"steps":[{"step":0,"toolName":"plasticity_create_box","added":[10],"removed":[],"regionsAdded":[],"addedBodies":[{"id":10,"versionId":100,"type":"Solid","name":null,"boundsMm":{"min":[0,0,0],"max":[1.123456,1,1]},"faceCount":0,"edgeCount":0,"vertexCount":null}]},{"step":1,"toolName":"plasticity_boolean","added":[],"removed":[10],"regionsAdded":[],"addedBodies":[],"createdEdges":[{"bodyId":1,"edgeId":"s1","curveType":"Circle","lengthMm":3.1415},{"bodyId":1,"edgeId":"s2","curveType":"Circle","lengthMm":6.2831},{"bodyId":1,"edgeId":"s3","curveType":"Line","lengthMm":7}]},{"step":2,"toolName":"plasticity_find_edges","result":{"documentToken":"doc-1","revision":"r3","measurementSource":"native-brep","count":3,"matches":[{"bodyId":1,"id":"e4","curveType":"Circle","line":false,"circle":true,"lengthMm":14.137166941,"centerMm":[7.5,7.5,5],"tangent":[1,0,0],"boundsMm":{"min":[7.5,7.5,5],"max":[7.5,7.5,5]},"faceIds":["f1"],"vertexIds":[]},{"bodyId":1,"id":"s1","curveType":"Circle","line":false,"circle":true,"lengthMm":3.1415,"centerMm":[9,9,9],"tangent":[1,0,0],"boundsMm":{"min":[9,9,9],"max":[9,9,9]},"faceIds":["f1"],"vertexIds":[]},{"bodyId":1,"id":"s2","curveType":"Circle","line":false,"circle":true,"lengthMm":6.2831,"centerMm":[9,9,8],"tangent":[1,0,0],"boundsMm":{"min":[9,9,8],"max":[9,9,8]},"faceIds":["f1"],"vertexIds":[]}]}},{"step":3,"toolName":"plasticity_fillet","added":[],"removed":[],"regionsAdded":[],"addedBodies":[]}]}`;

test("standard detail is the default and keeps today's reply byte for byte", async () => {
  const { fake } = fixture();
  const { client, close } = await connect(fake);
  const defaultReply = await client.callTool({ name: "plasticity_batch", arguments: { steps: STANDARD_STEPS } });
  const defaultText = (defaultReply.content as Array<{ text: string }>)[0]!.text;
  if (process.env.CAPTURE === "1") { console.log(`CAPTURE ${defaultText}`); await close(); return; }
  assert.equal(defaultText, STANDARD_REPLY_BEFORE);
  const second = fixture();
  const other = await connect(second.fake);
  const explicit = await other.client.callTool({ name: "plasticity_batch", arguments: { detail: "standard", steps: STANDARD_STEPS } });
  assert.equal((explicit.content as Array<{ text: string }>)[0]!.text, defaultText, "detail: standard equals the default");
  await other.close();
  await close();
});

test("a read step's return list projects exactly those paths", async () => {
  const { fake } = fixture();
  const { client, close } = await connect(fake);
  const output = await runBatch(client, { steps: [
    { toolName: "plasticity_find_faces", arguments: { query: { radiusMm: { value: 2.25 } } }, return: ["matches[*].id", "matches[*].axisOriginMm", "count"] },
    { toolName: "plasticity_find_edges", arguments: { query: { bodyIds: [1] } }, return: ["matches[0].lengthMm", "matches[*].centerMm"] },
  ] });
  assert.deepEqual(output.steps[0].result, {
    "matches[*].id": ["f2", "f3"],
    "matches[*].axisOriginMm": [[7.5, 7.5, 0], [32.5, 7.5, 0]],
    count: 2,
  });
  assert.deepEqual(Object.keys(output.steps[1].result), ["matches[0].lengthMm", "matches[*].centerMm"]);
  assert.equal(output.steps[1].result["matches[0].lengthMm"], 40);
  assert.equal(output.steps[1].result["matches[*].centerMm"].length, 5);
  await close();
});

test("a return path that does not resolve fails the batch and names the step and the path", async () => {
  const { fake } = fixture();
  const { client, close } = await connect(fake);
  const failed = await client.callTool({ name: "plasticity_batch", arguments: { steps: [
    { toolName: "plasticity_find_faces", arguments: { query: {} }, return: ["matches[*].noSuchField"] },
  ] } });
  assert.equal(failed.isError, true);
  const text = JSON.stringify(failed.content);
  assert.match(text, /failedStep\\?":0/);
  assert.match(text, /plasticity_find_faces/);
  assert.match(text, /step 0 \(plasticity_find_faces\)/);
  assert.match(text, /return path \\*"matches\[\*\]\.noSuchField\\*"/);
  const invalid = await client.callTool({ name: "plasticity_batch", arguments: { steps: [
    { toolName: "plasticity_find_faces", arguments: { query: {} }, return: ["matches[*]..id"] },
  ] } });
  assert.equal(invalid.isError, true, "a malformed path is rejected");
  await close();
});

test("a large read result is never cut without the explicit note, and return avoids it", async () => {
  const { fake } = fixture();
  const { client, close } = await connect(fake);
  const output = await runBatch(client, { steps: [
    { toolName: "plasticity_find_faces", arguments: { query: {} } },
    { toolName: "plasticity_find_faces", arguments: { query: { radiusMm: { value: 2.25 } } } },
    { toolName: "plasticity_find_faces", arguments: { query: {} }, return: ["matches[*].id"] },
  ] });
  const big = output.steps[0].result;
  assert.equal(big.truncated, true);
  assert.equal(big.hint, "add return: [...] to this step");
  assert.deepEqual(big.ids, ["f1", "f2", "f3", "f4", "f5"]);
  assert.equal(typeof big.bytes, "number");
  assert.ok(big.bytes > 1_500);
  assert.equal(output.steps[1].result.truncated, undefined, "a result of 1,500 bytes or less comes back whole");
  assert.equal(output.steps[1].result.matches.length, 2);
  assert.deepEqual(output.steps[2].result, { "matches[*].id": ["f1", "f2", "f3", "f4", "f5"] });
  await close();
});

const LEAN_STEPS = [
  { toolName: "plasticity_create_box", arguments: { originMm: [0, 0, 0], sizeMm: [2, 2, 2] } },
  { toolName: "plasticity_boolean", arguments: { targetIds: [1], toolIds: ["$0.added[0]"], operation: "difference" } },
  { toolName: "plasticity_find_edges", arguments: { query: { bodyIds: [1], circle: true } }, return: ["matches[*].id"] },
  { toolName: "plasticity_fillet", arguments: { id: 1, edgeIds: "$1.result.createdEdges[*].edgeId", radiusMm: 1 } },
  { toolName: "plasticity_show_face_control_points", arguments: { bodyId: 1, faceIds: ["f1"] } },
  { toolName: "plasticity_move_face_control_points", arguments: { bodyId: 1, cvIds: "$4.result.controlPoints[*].cvId", deltaMm: [0, 0, 1] } },
  { toolName: "plasticity_fillet", arguments: { id: 1, edgeIds: "$2.result.matches[*].id", radiusMm: 0.5 } },
];

function hasEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0 || value.some(hasEmptyContainer);
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length === 0 || entries.some(([, item]) => hasEmptyContainer(item));
  }
  return false;
}

test("lean detail drops the createdEdges echo, consumed bodies and empty containers, and ends with one summary", async () => {
  const { fake } = fixture();
  const { client, close } = await connect(fake);
  const standard = await runBatch(client, { steps: LEAN_STEPS });
  const lean = await runBatchOnFresh({ detail: "lean", steps: LEAN_STEPS });
  assert.deepEqual(Object.keys(lean).sort(), ["steps", "summary"]);
  assert.equal(lean.steps.length, 7);

  assert.equal("addedBodies" in lean.steps[0], false, "the cutter a later step consumed is not echoed");
  assert.deepEqual(lean.steps[0].added, [10]);
  assert.equal("removed" in lean.steps[0], false);
  assert.equal("regionsAdded" in lean.steps[0], false);
  assert.equal("createdEdges" in lean.steps[1], false);
  assert.equal(lean.steps[1].createdEdgeCount, 3);
  assert.deepEqual(lean.steps[1].removed, [10]);
  assert.equal(standard.steps[1].createdEdges.length, 3, "standard still echoes the edges");
  assert.equal(standard.steps[0].addedBodies.length, 1, "standard still echoes the consumed body");

  for (const step of lean.steps) assert.equal(hasEmptyContainer({ ...step, result: undefined }), false, JSON.stringify(step));
  assert.equal(hasEmptyContainer(lean.summary), false);

  assert.equal(lean.summary.revision, standard.revision);
  assert.equal(lean.summary.undoSteps, standard.undoSteps);
  assert.equal("added" in lean.summary, false, "nothing created survived: the box was the cutter");
  assert.deepEqual(lean.summary.modified.map((body: { id: number }) => body.id), [1]);
  assert.deepEqual(Object.keys(lean.summary.modified[0]).sort(), ["boundsMm", "edgeCount", "faceCount", "id", "name", "type"]);
  assert.ok(JSON.stringify(lean).length < JSON.stringify(standard).length, "lean is smaller");
  await close();
});

async function runBatchOnFresh(args: Record<string, unknown>) {
  const { fake } = fixture();
  const { client, close } = await connect(fake);
  try { return await runBatch(client, args); } finally { await close(); }
}

test("lean summary lists a created body that survives", async () => {
  const output = await runBatchOnFresh({ detail: "lean", steps: [
    { toolName: "plasticity_create_box", arguments: { originMm: [0, 0, 0], sizeMm: [2, 2, 2], name: "keep" } },
  ] });
  assert.deepEqual(output.summary.added.map((body: { id: number }) => body.id), [10]);
  assert.deepEqual(output.steps[0].addedBodies.map((body: { id: number }) => body.id), [10]);
});

test("stored step results stay whole: four reference paths resolve in lean mode", async () => {
  const { fake, calls } = fixture();
  const { client, close } = await connect(fake);
  await runBatch(client, { detail: "lean", roundMm: 1, steps: LEAN_STEPS });
  const fillets = calls.filter((call) => call.op === "fillet");
  assert.deepEqual(fillets[0]!.args.slice(0, 3), [1, ["s1", "s2", "s3"].filter((id) => ["s1", "s2", "s3"].includes(id)), 1], "$n.result.createdEdges[*].edgeId");
  assert.deepEqual(fillets[1]!.args.slice(0, 3), [1, ["e4", "s1", "s2"], 0.5], "$n.result.matches[*].id");
  assert.deepEqual(calls.find((call) => call.op === "moveFaceControlPoints")!.args.slice(0, 3), [1, [3, 4], [0, 0, 1]], "$n.result.controlPoints[*].cvId");
  assert.deepEqual(calls.find((call) => call.op === "boolean")!.args.slice(0, 2), [[1], [10]], "$n.added[0]");
  await close();
});

test("mutating steps carry their tool-specific result fields in both detail modes", async () => {
  const steps = [
    { toolName: "plasticity_show_face_control_points", arguments: { bodyId: 1, faceIds: ["f1"] } },
    { toolName: "plasticity_export_step", arguments: { ids: [1], path: "/tmp/plate.step" } },
    { toolName: "plasticity_set_driving_distance", arguments: { bodyId: 1, movingFaceId: "f1", distanceMm: 30 } },
    { toolName: "plasticity_set_driving_distance", arguments: { bodyId: 1, movingFaceId: "f1", distanceMm: 30 }, return: ["previousDistanceMm", "undoSteps"] },
  ];
  for (const detail of ["standard", "lean"]) {
    const output = await runBatchOnFresh({ detail, steps });
    assert.deepEqual(output.steps[0].result.controlPoints.map((point: { cvId: number }) => point.cvId), [3, 4], detail);
    assert.deepEqual(output.steps[1].result, { path: "/tmp/plate.step", bytes: 4321 }, detail);
    assert.equal(output.steps[2].result.previousDistanceMm, 20.123456789, detail);
    assert.equal(output.steps[2].result.distanceMm, 30);
    assert.equal("bodies" in output.steps[2].result, false, "scene state is not echoed");
    assert.equal("change" in output.steps[2].result, false);
    assert.deepEqual(output.steps[3].result, { previousDistanceMm: 20.123456789, undoSteps: 1 }, `${detail}: return projects tool fields`);
  }
});

test("roundMm rounds the reply only, never the stored results", async () => {
  const steps = [
    { toolName: "plasticity_show_face_control_points", arguments: { bodyId: 1, faceIds: ["f1"] } },
    { toolName: "plasticity_create_box", arguments: { originMm: [0, 0, 0], sizeMm: [2, 2, 2] } },
    { toolName: "plasticity_move_face_control_points", arguments: { bodyId: 1, cvIds: [3], deltaMm: ["$0.result.controlPoints[0].positionMm[0]", 0, 1] } },
  ];
  const { fake, calls } = fixture();
  const { client, close } = await connect(fake);
  const rounded = await runBatch(client, { roundMm: 2, steps });
  assert.deepEqual(rounded.steps[0].result.controlPoints[0].positionMm, [1.12, 2, 3]);
  assert.equal(rounded.steps[1].addedBodies[0].boundsMm.max[0], 1.12);
  const moveArgs = calls.find((call) => call.op === "moveFaceControlPoints")!.args;
  assert.equal((moveArgs[2] as number[])[0], 1.123456789, "a later step reads the stored, unrounded value");
  await close();
  const off = await runBatchOnFresh({ steps });
  assert.equal(off.steps[0].result.controlPoints[0].positionMm[0], 1.123456789, "off by default");
  const bad = await connect(fixture().fake);
  const rejected = await bad.client.callTool({ name: "plasticity_batch", arguments: { roundMm: 7, steps } });
  assert.equal(rejected.isError, true, "roundMm is limited to 0-6 decimals");
  await bad.close();
});

async function findCall(name: string, args: Record<string, unknown>) {
  const { fake } = fixture();
  const { client, close } = await connect(fake);
  try {
    const response = await client.callTool({ name, arguments: { revision: "r1", ...args } });
    assert.equal(response.isError, undefined, JSON.stringify(response.content));
    return parseToolJson(response);
  } finally { await close(); }
}

test("find_faces sorts by centre coordinate, orders, limits and still counts every match", async () => {
  const plain = await findCall("plasticity_find_faces", { query: {} });
  assert.deepEqual(plain.matches.map((match: { id: string }) => match.id), ["f1", "f2", "f3", "f4", "f5"]);
  assert.equal(plain.count, 5);
  assert.equal(plain.returned, undefined);

  const byX = await findCall("plasticity_find_faces", { query: {}, sortBy: "x" });
  assert.deepEqual(byX.matches.map((match: { id: string }) => match.id), ["f2", "f1", "f4", "f3", "f5"], "ascending by centre x, ties keep their order");
  const byXDesc = await findCall("plasticity_find_faces", { query: {}, sortBy: "x", order: "desc" });
  assert.deepEqual(byXDesc.matches.map((match: { id: string }) => match.id), ["f5", "f3", "f1", "f4", "f2"]);
  const byZLimited = await findCall("plasticity_find_faces", { query: {}, sortBy: "z", order: "desc", limit: 2 });
  assert.deepEqual(byZLimited.matches.map((match: { id: string }) => match.id), ["f1", "f2"]);
  assert.equal(byZLimited.count, 5, "count is the total before the limit");
  const limitOnly = await findCall("plasticity_find_faces", { query: {}, limit: 3 });
  assert.deepEqual(limitOnly.matches.map((match: { id: string }) => match.id), ["f1", "f2", "f3"]);
  assert.equal(limitOnly.count, 5);
  const { fake } = fixture();
  const { client, close } = await connect(fake);
  const area = await client.callTool({ name: "plasticity_find_faces", arguments: { revision: "r1", query: {}, sortBy: "area" } });
  assert.equal(area.isError, true, "area is not in the read model, so it is not offered");
  const tooMany = await client.callTool({ name: "plasticity_find_faces", arguments: { revision: "r1", query: {}, limit: 1001 } });
  assert.equal(tooMany.isError, true);
  await close();
});

test("find_edges sorts by length (longest first by default) or by centre coordinate", async () => {
  const plain = await findCall("plasticity_find_edges", { query: {} });
  assert.deepEqual(plain.matches.map((match: { id: string }) => match.id), ["e1", "e2", "e3", "e4", "e5"]);
  const byLength = await findCall("plasticity_find_edges", { query: {}, sortBy: "length" });
  assert.deepEqual(byLength.matches.map((match: { id: string }) => match.id), ["e1", "e2", "e5", "e4", "e3"], "descending by default");
  const shortest = await findCall("plasticity_find_edges", { query: {}, sortBy: "length", order: "asc", limit: 2 });
  assert.deepEqual(shortest.matches.map((match: { id: string }) => match.id), ["e3", "e4"]);
  assert.equal(shortest.count, 5);
  const byY = await findCall("plasticity_find_edges", { query: {}, sortBy: "y" });
  assert.deepEqual(byY.matches.map((match: { id: string }) => match.id), ["e1", "e3", "e4", "e2", "e5"], "centre y ascending by default");
  const { fake } = fixture();
  const { client, close } = await connect(fake);
  const area = await client.callTool({ name: "plasticity_find_edges", arguments: { revision: "r1", query: {}, sortBy: "area" } });
  assert.equal(area.isError, true);
  await close();
});

test("the compact tool list adds the recipe, check and set tools", async () => {
  const { fake } = fixture();
  const { client, close } = await connect(fake);
  const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
  for (const name of [
    "plasticity_create_rib", "plasticity_create_screw_boss_pattern", "plasticity_create_connector_opening",
    "plasticity_create_through_hole_pattern", "plasticity_create_countersink_pattern", "plasticity_check_interference",
    "plasticity_measure_parallel_planar_face_clearance", "plasticity_set_driving_distance",
  ]) assert.ok(names.has(name), name);
  await close();
});

test("the instructions and descriptions steer agents to lean batches, return and sortBy", async () => {
  const { fake } = fixture();
  const { client, close } = await connect(fake);
  const instructions = client.getInstructions() ?? "";
  assert.match(instructions, /detail: "lean"/);
  assert.match(instructions, /return/);
  assert.match(instructions, /sortBy/);
  const tools = (await client.listTools()).tools;
  assert.match(tools.find((tool) => tool.name === "plasticity_create_cylinder")!.description ?? "", /centerMm is the centre of the BASE face/);
  assert.match(tools.find((tool) => tool.name === "plasticity_find_faces")!.description ?? "", /boundsMm matches by overlap/);
  assert.match(tools.find((tool) => tool.name === "plasticity_find_edges")!.description ?? "", /boundsMm matches by overlap/);
  await close();
});

test("a failed step in a lean batch reports the completed steps in the lean shape", async () => {
  const { fake } = fixture();
  const { client, close } = await connect(fake);
  const failed = await client.callTool({ name: "plasticity_batch", arguments: { detail: "lean", undoOnError: false, steps: [
    { toolName: "plasticity_create_box", arguments: { originMm: [0, 0, 0], sizeMm: [2, 2, 2] } },
    { toolName: "plasticity_boolean", arguments: { targetIds: [1], toolIds: ["$0.added[0]"], operation: "difference" } },
    { toolName: "plasticity_find_faces", arguments: { query: {} }, return: ["matches[0].nope"] },
  ] } });
  assert.equal(failed.isError, true);
  const body = JSON.parse((failed.content as Array<{ text: string }>)[0]!.text);
  assert.equal(body.failedStep, 2);
  assert.equal(body.completedSteps.length, 2);
  assert.equal("addedBodies" in body.completedSteps[0], false, "the consumed cutter is already left out");
  assert.equal(body.completedSteps[1].createdEdgeCount, 3);
  await close();
});

test("return on a mutating step can project the change payload as well as tool fields", async () => {
  const output = await runBatchOnFresh({ steps: [
    { toolName: "plasticity_set_driving_distance", arguments: { bodyId: 1, movingFaceId: "f1", distanceMm: 30 }, return: ["change.revisionChanged", "distanceMm"] },
  ] });
  assert.deepEqual(output.steps[0].result, { "change.revisionChanged": true, distanceMm: 30 });
});

test("roundMm 0 rounds to whole numbers and leaves ids and counts alone", async () => {
  const output = await runBatchOnFresh({ roundMm: 0, detail: "lean", steps: [
    { toolName: "plasticity_set_driving_distance", arguments: { bodyId: 1, movingFaceId: "f1", distanceMm: 30 } },
    { toolName: "plasticity_find_edges", arguments: { query: { circle: true } }, return: ["matches[*].lengthMm", "count"] },
  ] });
  assert.equal(output.steps[0].result.previousDistanceMm, 20);
  assert.deepEqual(output.steps[1].result, { "matches[*].lengthMm": [14], count: 1 });
  assert.equal(output.summary.undoSteps, 1);
});

test("find tools without sortBy, order or limit return what they returned before", async () => {
  const faces = await findCall("plasticity_find_faces", { query: { planar: true } });
  assert.deepEqual(Object.keys(faces), ["documentToken", "revision", "measurementSource", "count", "matches"]);
  assert.deepEqual(faces.matches.map((match: { id: string }) => match.id), ["f1", "f4", "f5"]);
  assert.equal(faces.count, 3);
  const edges = await findCall("plasticity_find_edges", { query: { line: true } });
  assert.deepEqual(Object.keys(edges), ["documentToken", "revision", "measurementSource", "count", "matches"]);
  assert.deepEqual(edges.matches.map((match: { id: string }) => match.id), ["e1", "e2", "e3", "e5"]);
  assert.equal(edges.count, 4);
  const orderOnly = await findCall("plasticity_find_edges", { query: { line: true }, order: "asc" });
  assert.deepEqual(orderOnly.matches.map((match: { id: string }) => match.id), ["e1", "e2", "e3", "e5"], "order without sortBy changes nothing");
});

test("a larger read result carries the hint and its count, and a projection of it stays small", async () => {
  const { fake } = fixture();
  const { client, close } = await connect(fake);
  const output = await runBatch(client, { steps: [
    { toolName: "plasticity_find_faces", arguments: { query: {} } },
    { toolName: "plasticity_find_faces", arguments: { query: { planar: true, normal: { vector: [0, 0, 1] } } }, return: ["count"] },
  ] });
  assert.equal(output.steps[0].result.truncated, true);
  assert.equal(output.steps[0].result.count, 5);
  assert.ok(JSON.stringify(output.steps[0].result).length < 400);
  assert.deepEqual(output.steps[1].result, { count: 1 });
  await close();
});
