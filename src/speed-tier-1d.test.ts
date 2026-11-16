import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { PLASTICITY_MCP_INSTRUCTIONS } from "./server-instructions.ts";
import { createCompactServer, type SessionLike } from "./server.ts";
import type { PlasticityOperations } from "./plasticity/operations.ts";
import { PlasticityRecipes, type RecipeOperations } from "./plasticity/recipes.ts";
import type { RuntimeState } from "./plasticity/runtime.ts";
import { describeBody } from "./plasticity/semantic.ts";

// Speed tier 1d: rib side/bounds, edgeQuery and faceQuery selection, describe_body for mating parts,
// truncation hints, the lean status step, and keepProfile on the construction-Wire recipes.

type Vec = [number, number, number];
type Face = RuntimeState["bodies"][number]["faces"][number];
type Edge = RuntimeState["bodies"][number]["edges"][number];
const box = (min: Vec, max: Vec) => ({ min, max });
const text = (response: unknown): string => (response as { content: Array<{ type: string; text?: string }> }).content.find((entry) => entry.type === "text")!.text!;
const json = (response: unknown): any => JSON.parse(text(response));
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

// ---------- recipe fakes ----------

function recipeBody(id: number, type: string, bounds = box([0, 0, 0], [1, 1, 1])) {
  return { id, versionId: id * 10, type, name: null, boundsMm: bounds, faceIds: [], edgeIds: [], faces: [], edges: [] };
}
function recipeScene(revision: string, bodies: unknown[], regions: unknown[] = []): RuntimeState {
  return {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision, dbVersion: 1, undoDepth: 0, redoDepth: 0, regions,
    construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" }, bodies,
  } as unknown as RuntimeState;
}

// One stateful fake for the rib and countersink recipes. `remove` is left out when withRemove is false.
function recipeFake(withRemove = true) {
  const calls: Array<Record<string, unknown>> = [];
  const target = recipeBody(7, "Solid");
  let state = recipeScene("r1", [target]);
  let version = 1;
  let nextId = 8;
  const commit = (bodies: unknown[], regions: unknown[] = []) => {
    version += 1;
    state = recipeScene(`r${version}`, bodies, regions);
    return state;
  };
  const operations = {
    async state() { return state; },
    async createPolyline(pointsMm: unknown, closed: boolean, revision: string) {
      calls.push({ operation: "createPolyline", closed, revision });
      const id = nextId++;
      return commit([...state.bodies, recipeBody(id, "Wire")], [{ id: `region-${id}`, entityId: 1, islandVersionId: 1, sketchId: 1, sketchWireIds: [id], measurementSource: "render-mesh", displayBoundsMm: box([0, 0, 0], [1, 1, 0]) }]);
    },
    async extrudeRegions(regionIds: string[], distanceMm: number, revision: string, options?: unknown) {
      calls.push({ operation: "extrudeRegions", regionIds, distanceMm, revision, ...(options === undefined ? {} : { options }) });
      const id = nextId++;
      return commit([...state.bodies, recipeBody(id, "Solid", box([10.00001, 8.999999999, 3.5], [30, 13.0000000004, 14]))], state.regions as unknown[]);
    },
    async createCylinder(...args: unknown[]) {
      calls.push({ operation: "createCylinder", revision: args[4] });
      return commit([...state.bodies, recipeBody(nextId++, "Solid")]);
    },
    async revolveProfile(id: number, _origin: unknown, _axis: unknown, _angle: number, revision: string) {
      calls.push({ operation: "revolveProfile", id, revision });
      return commit([...state.bodies, recipeBody(nextId++, "Solid")]);
    },
    async boolean(targetIds: number[], toolIds: number[], kind: string, keepTools: boolean, revision: string) {
      calls.push({ operation: "boolean", targetIds, toolIds, kind, keepTools, revision });
      return commit(state.bodies.filter((candidate) => !toolIds.includes(candidate.id)));
    },
    ...(withRemove ? {
      async remove(ids: number[], revision: string) {
        calls.push({ operation: "remove", ids, revision });
        return commit(state.bodies.filter((candidate) => !ids.includes(candidate.id)));
      },
    } : {}),
  } as unknown as RecipeOperations;
  return { operations, calls, current: () => state };
}

const RIB_POINTS: Vec[] = [[10, 9, 3.5], [30, 9, 3.5], [10, 9, 14]];
const ribInput = (extra: Record<string, unknown> = {}) => ({ targetId: 7, profilePointsMm: RIB_POINTS, thicknessMm: 4, revision: "r1", ...extra });

test("rib without side keeps today's signed extrude call and reports where the rib landed", async () => {
  const fake = recipeFake();
  const result = await new PlasticityRecipes(fake.operations).createRib(ribInput());
  assert.deepEqual(fake.calls.map((call) => call.operation), ["createPolyline", "extrudeRegions", "boolean"]);
  assert.deepEqual(fake.calls[1], { operation: "extrudeRegions", regionIds: ["region-8"], distanceMm: 4, revision: "r2" }, "no options key, exactly as before");
  assert.deepEqual(result.ribBoundsMm, { min: [10, 9, 3.5], max: [30, 13, 14] }, "the added solid's bounds before the union, rounded to 4 decimals");
  assert.equal(result.undoSteps, 3);
  assert.equal("profileDeleted" in result, false);
  assert.deepEqual(fake.current().bodies.map((candidate) => candidate.id), [7, 8], "the profile Wire stays by default");
});

test("rib side centered splits |thickness| about the plane; positive and negative ignore the sign of thickness", async () => {
  for (const thicknessMm of [4, -4]) {
    const fake = recipeFake();
    await new PlasticityRecipes(fake.operations).createRib(ribInput({ side: "centered", thicknessMm }));
    assert.deepEqual(fake.calls[1], { operation: "extrudeRegions", regionIds: ["region-8"], distanceMm: 2, revision: "r2", options: { reverseDistanceMm: 2 } }, `thickness ${thicknessMm}`);
  }
  for (const [side, thicknessMm, expected] of [["positive", 4, 4], ["positive", -4, 4], ["negative", 4, -4], ["negative", -4, -4]] as const) {
    const fake = recipeFake();
    await new PlasticityRecipes(fake.operations).createRib(ribInput({ side, thicknessMm }));
    assert.deepEqual(fake.calls[1], { operation: "extrudeRegions", regionIds: ["region-8"], distanceMm: expected, revision: "r2" }, `${side} ${thicknessMm}`);
  }
});

test("rib keepProfile false deletes the profile Wire in one more undo step and says so; true or omitted changes nothing", async () => {
  const fake = recipeFake();
  const result = await new PlasticityRecipes(fake.operations).createRib(ribInput({ keepProfile: false }));
  assert.deepEqual(fake.calls.map((call) => call.operation), ["createPolyline", "extrudeRegions", "boolean", "remove"]);
  assert.deepEqual(fake.calls[3], { operation: "remove", ids: [8], revision: "r4" });
  assert.equal(result.profileDeleted, true);
  assert.equal(result.profileBodyId, 8);
  assert.equal(result.undoSteps, 4);
  assert.deepEqual(result.steps.map((entry) => entry.operation), ["create-rib-profile", "extrude-rib", "union-rib-to-target", "delete-construction-profile"]);
  assert.deepEqual(fake.current().bodies.map((candidate) => candidate.id), [7], "no Wire is left");

  const kept = recipeFake();
  const keptResult = await new PlasticityRecipes(kept.operations).createRib(ribInput({ keepProfile: true }));
  assert.equal(keptResult.undoSteps, 3);
  assert.equal(kept.calls.some((call) => call.operation === "remove"), false);
});

test("keepProfile false without native delete support fails before any mutation", async () => {
  const fake = recipeFake(false);
  await assert.rejects(new PlasticityRecipes(fake.operations).createRib(ribInput({ keepProfile: false })), /requires native delete support/);
  assert.deepEqual(fake.calls, []);
});

test("countersink and countersink pattern: keepProfile false deletes every profile Wire in one step", async () => {
  const single = recipeFake();
  const input = { targetId: 7, entryCenterMm: [10, 12, 8], axis: [0, 0, -1], radialDirection: [1, 0, 0], throughDiameterMm: 4, countersinkMajorDiameterMm: 8, includedAngleDeg: 90, throughDepthMm: 8, overshootMm: 0.5, revision: "r1" } as const;
  const kept = await new PlasticityRecipes(single.operations).createCountersink({ ...input, entryCenterMm: [10, 12, 8], axis: [0, 0, -1], radialDirection: [1, 0, 0] });
  assert.equal(kept.undoSteps, 4);
  assert.equal(single.calls.some((call) => call.operation === "remove"), false);
  assert.equal(single.current().bodies.some((candidate) => candidate.type === "Wire"), true, "today's behaviour: the Wire stays");

  const dropped = recipeFake();
  const droppedResult = await new PlasticityRecipes(dropped.operations).createCountersink({ ...input, entryCenterMm: [10, 12, 8], axis: [0, 0, -1], radialDirection: [1, 0, 0], keepProfile: false });
  assert.equal(droppedResult.undoSteps, 5);
  assert.equal(droppedResult.profileDeleted, true);
  assert.equal(dropped.current().bodies.some((candidate) => candidate.type === "Wire"), false);

  const pattern = recipeFake();
  const patternResult = await new PlasticityRecipes(pattern.operations).createCountersinkPattern({
    targetId: 7, entryCentersMm: [[10, 12, 8], [20, 12, 8]], axis: [0, 0, -1], radialDirection: [1, 0, 0], throughDiameterMm: 4, countersinkMajorDiameterMm: 8,
    includedAngleDeg: 90, throughDepthMm: 8, overshootMm: 0.5, keepProfile: false, revision: "r1",
  });
  const removes = pattern.calls.filter((call) => call.operation === "remove");
  assert.equal(removes.length, 1, "one delete for both Wires");
  assert.equal((removes[0]!.ids as number[]).length, 2);
  assert.equal(patternResult.profilesDeleted, true);
  assert.equal(pattern.current().bodies.some((candidate) => candidate.type === "Wire"), false);
});

// ---------- server fixture ----------

function plane(id: string, center: Vec, normal: Vec, half = 5, extra: Partial<Face> = {}): Face {
  return {
    id, surfaceType: "Plane", planar: true, centerMm: center, normal, radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null,
    boundsMm: box([center[0] - half * Math.abs(1 - Math.abs(normal[0])), center[1] - half * Math.abs(1 - Math.abs(normal[1])), center[2] - half * Math.abs(1 - Math.abs(normal[2]))],
      [center[0] + half * Math.abs(1 - Math.abs(normal[0])), center[1] + half * Math.abs(1 - Math.abs(normal[1])), center[2] + half * Math.abs(1 - Math.abs(normal[2]))]),
    edgeIds: ["e1"], ...extra,
  } as Face;
}
function line(id: string, tangent: Vec, center: Vec, lengthMm: number, faceIds: string[]): Edge {
  return { id, curveType: "Line", line: true, circle: false, lengthMm, centerMm: center, tangent, boundsMm: box(center, center), faceIds, vertexIds: [] } as Edge;
}
function circle(id: string, center: Vec, faceIds: string[], lengthMm = 6.28): Edge {
  return { id, curveType: "Circle", line: false, circle: true, lengthMm, centerMm: center, tangent: [1, 0, 0], boundsMm: box(center, center), faceIds, vertexIds: [] } as Edge;
}

// A 40 x 30 x 10 block: four vertical edges (e1-e4, length 10), four top rim edges (e5-e8, lengths 40/30/40/30) next to the top face.
function blockBody(id = 1) {
  const faces = [
    plane("top", [20, 15, 10], [0, 0, 1], 15), plane("shelf", [20, 15, 4], [0, 0, 1], 15), plane("bottom", [20, 15, 0], [0, 0, -1], 15),
    plane("right", [40, 15, 5], [1, 0, 0]), plane("left", [0, 15, 5], [-1, 0, 0]),
  ];
  const edges = [
    line("e1", [0, 0, 1], [0, 0, 5], 10, ["left"]), line("e2", [0, 0, 1], [40, 0, 5], 10, ["right"]),
    line("e3", [0, 0, 1], [0, 30, 5], 10, ["left"]), line("e4", [0, 0, 1], [40, 30, 5], 10, ["right"]),
    line("e5", [1, 0, 0], [20, 0, 10], 40, ["top", "right"]), line("e6", [0, 1, 0], [40, 15, 10], 30, ["top", "right"]),
    line("e7", [1, 0, 0], [20, 30, 10], 40, ["top", "left"]), line("e8", [0, 1, 0], [0, 15, 10], 30, ["top", "left"]),
    line("e9", [1, 0, 0], [20, 0, 4], 40, ["shelf"]),
  ];
  return { id, versionId: id * 10, type: "Solid", name: "block", boundsMm: box([0, 0, 0], [40, 30, 10]), faceIds: faces.map((item) => item.id), edgeIds: edges.map((item) => item.id), faces, edges };
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
  const commit = (next: Partial<RuntimeState> = {}) => {
    version += 1;
    state = { ...state, ...next, revision: `r${version}`, undoDepth: state.undoDepth + 1, dbVersion: version } as RuntimeState;
    return state;
  };
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
  return { fake, calls, current: () => state, commit: (bodies: unknown[]) => commit({ bodies: bodies as RuntimeState["bodies"] }) };
}
async function connect(fake: SessionLike) {
  const server = createCompactServer(fake, undefined, undefined, undefined, null);
  const client = new Client({ name: "speed-tier-1d-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
async function runBatch(client: Client, args: Record<string, unknown>) {
  const response = await client.callTool({ name: "plasticity_batch", arguments: args });
  assert.equal(response.isError, undefined, JSON.stringify(response.content));
  return json(response);
}

// ---------- edgeQuery on fillet and chamfer ----------

test("fillet edgeQuery resolves like find_edges on the body and adds edgeCount; edgeIds stays as it was", async () => {
  const run = open(stateOf([blockBody()]));
  const { client, close } = await connect(run.fake);
  const found = json(await client.callTool({ name: "plasticity_find_edges", arguments: { revision: "r1", query: { bodyIds: [1], line: true, direction: { vector: [0, 0, 1] } } } }));
  const reply = json(await client.callTool({ name: "plasticity_fillet", arguments: { id: 1, edgeQuery: { line: true, direction: { vector: [0, 0, 1] } }, radiusMm: 2, revision: "r1" } }));
  assert.deepEqual(run.calls[0]!.args, [1, found.matches.map((match: { id: string }) => match.id), 2, "r1", "round"]);
  assert.deepEqual(run.calls[0]!.args[1], ["e1", "e2", "e3", "e4"]);
  assert.equal(reply.edgeCount, 4);

  const direct = json(await client.callTool({ name: "plasticity_fillet", arguments: { id: 1, edgeIds: ["e5"], radiusMm: 1, revision: run.current().revision } }));
  assert.deepEqual(run.calls[1]!.args, [1, ["e5"], 1, run.calls[1]!.args[3], "round"]);
  assert.equal("edgeCount" in direct, false, "the edgeIds path replies as before");
  await close();
});

test("chamfer edgeQuery takes sortBy, order and limit like find_edges, and the adjacentFace shorthand names the top rim", async () => {
  const run = open(stateOf([blockBody()]));
  const { client, close } = await connect(run.fake);
  const longest = json(await client.callTool({ name: "plasticity_chamfer", arguments: { id: 1, edgeQuery: { line: true }, sortBy: "length", limit: 2, distanceMm: 1, revision: "r1" } }));
  assert.deepEqual(run.calls[0]!.args[1], ["e5", "e7"], "longest two first (ties keep their order)");
  assert.equal(longest.edgeCount, 2);

  const rim = json(await client.callTool({ name: "plasticity_chamfer", arguments: {
    id: 1, edgeQuery: { adjacentFace: { planar: true, normal: { vector: [0, 0, 1] }, sortBy: "z", order: "desc", limit: 1 } }, distanceMm: 1, revision: run.current().revision,
  } }));
  assert.deepEqual(run.calls[1]!.args[1], ["e5", "e6", "e7", "e8"], "edges of the highest upward face");
  assert.equal(rim.edgeCount, 4);
  await close();
});

test("edgeQuery and edgeIds: exactly one; sortBy, order and limit need edgeQuery; bad queries and empty matches say why", async () => {
  const run = open(stateOf([blockBody()]));
  const { client, close } = await connect(run.fake);
  const attempt = async (tool: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name: tool, arguments: { id: 1, distanceMm: 1, radiusMm: 1, revision: "r1", ...args } });
    assert.equal(response.isError, true, JSON.stringify(args));
    return text(response);
  };
  assert.match(await attempt("plasticity_fillet", {}), /exactly one of edgeIds or edgeQuery/);
  assert.match(await attempt("plasticity_chamfer", { edgeIds: ["e1"], edgeQuery: { line: true } }), /exactly one of edgeIds or edgeQuery/);
  assert.match(await attempt("plasticity_chamfer", { edgeIds: ["e1"], limit: 2 }), /edgeQuery only/);
  assert.match(await attempt("plasticity_fillet", { edgeQuery: { bogus: true } }), /Invalid edgeQuery/);
  assert.match(await attempt("plasticity_fillet", { edgeQuery: { bodyIds: [1] } }), /Invalid edgeQuery/, "the body is the tool's id");
  const empty = await attempt("plasticity_chamfer", { edgeQuery: { circle: true } });
  assert.match(empty, /edgeQuery matched no edges on body 1: \{"circle":true\}/, "the query is echoed");
  assert.match(await attempt("plasticity_chamfer", { edgeQuery: { adjacentFace: { planar: true, normal: { vector: [0, 0, 1] } } } }), /matched 2 faces.*limit 1/);
  assert.match(await attempt("plasticity_chamfer", { edgeQuery: { adjacentFace: { surfaceTypes: ["Torus"] } } }), /matched no faces/);
  assert.match(await attempt("plasticity_chamfer", { id: 9, edgeQuery: { line: true } }), /Unknown body ID: 9/);
  assert.match(await attempt("plasticity_chamfer", { edgeQuery: { line: true }, revision: "r0" }), /Stale reference/);
  assert.deepEqual(run.calls, [], "nothing ran");
  await close();
});

test("edgeQuery works as a batch step with revision auto-fill, and a later step sees the new revision", async () => {
  const run = open(stateOf([blockBody()]));
  const { client, close } = await connect(run.fake);
  const output = await runBatch(client, { detail: "lean", steps: [
    { toolName: "plasticity_fillet", arguments: { id: 1, edgeQuery: { line: true, direction: { vector: [0, 0, 1] } }, radiusMm: 2 } },
    { toolName: "plasticity_chamfer", arguments: { id: 1, edgeQuery: { adjacentFace: { planar: true, normal: { vector: [0, 0, 1] }, sortBy: "z", order: "desc", limit: 1 } }, distanceMm: 1 } },
  ] });
  assert.deepEqual(run.calls.map((call) => [call.op, call.args[1], call.args[3]]), [["fillet", ["e1", "e2", "e3", "e4"], "r1"], ["chamfer", ["e5", "e6", "e7", "e8"], "r2"]]);
  assert.equal(output.steps[0].result.edgeCount, 4);
  assert.equal(output.summary.undoSteps, 2);
  await close();
});

test("extrude_faces faceQuery resolves like find_faces; exactly one of faceIds and faceQuery", async () => {
  const run = open(stateOf([blockBody()]));
  const { client, close } = await connect(run.fake);
  const reply = json(await client.callTool({ name: "plasticity_extrude_faces", arguments: { id: 1, faceQuery: { planar: true, normal: { vector: [0, 0, 1] } }, sortBy: "z", order: "desc", limit: 1, distanceMm: 3, revision: "r1" } }));
  assert.deepEqual(run.calls[0]!.args, [1, ["top"], 3, "r1"]);
  assert.equal(reply.faceCount, 1);
  for (const bad of [{}, { faceIds: ["top"], faceQuery: { planar: true } }, { faceIds: ["top"], limit: 1 }, { faceQuery: { surfaceTypes: ["Torus"] } }]) {
    const response = await client.callTool({ name: "plasticity_extrude_faces", arguments: { id: 1, distanceMm: 1, revision: run.current().revision, ...bad } });
    assert.equal(response.isError, true, JSON.stringify(bad));
  }
  assert.equal(run.calls.length, 1);
  await close();
});

// ---------- describe_body ----------

const GOLDEN_SINGLE = '{"id":1,"type":"Solid","name":"part","revision":"r1","boundsMm":{"min":[0,0,0],"max":[40,30,10]},"sizeMm":[40,30,10],"faceCount":9,"edgeCount":3,"vertexCount":4,"planes":{"xNeg":[{"mm":0,"face":"left"}],"xPos":[{"mm":40,"face":"right"}],"yNeg":[{"mm":0,"face":"front"}],"yPos":[{"mm":30,"face":"back"}],"zNeg":[{"mm":0,"face":"bottom"}],"zPos":[{"mm":10,"face":"top"}]},"cylinders":[{"radiusMm":2.25,"axis":"z","kind":"hole","count":2,"faces":3,"axisPointsMm":[[7.5,7.5,5],[32.5,7.5,5]]}],"otherSurfaces":{},"blendRadii":{}}';

function cylinderFace(id: string, axisPoint: Vec, radius: number, outward: boolean, extra: Partial<Face> = {}): Face {
  const center: Vec = [axisPoint[0] + radius, axisPoint[1], axisPoint[2]];
  const sign = outward ? 1 : -1;
  return {
    id, surfaceType: "Cylinder", planar: false, centerMm: center, normal: [sign, 0, 0], radiusMm: radius, blendRadiusMm: null,
    axisOriginMm: [axisPoint[0], axisPoint[1], axisPoint[2] - 3], axisDirection: [0, 0, 1],
    boundsMm: box([center[0] - radius, center[1] - radius, center[2] - 1], [center[0] + radius, center[1] + radius, center[2] + 1]), edgeIds: ["e1", "e2"], ...extra,
  } as Face;
}
function bodyOf(id: number, faces: Face[], edges: Edge[] = [], bounds = box([0, 0, 0], [40, 30, 10])) {
  const fallback = [line("e1", [1, 0, 0], [0, 0, 0], 10, ["f1"]), line("e2", [1, 0, 0], [1, 0, 0], 10, ["f1"]), line("e3", [1, 0, 0], [2, 0, 0], 10, ["f1"])];
  const all = edges.length > 0 ? edges : fallback;
  return { id, versionId: id * 10, type: "Solid", name: "part", boundsMm: bounds, faceIds: faces.map((face) => face.id), edgeIds: all.map((edge) => edge.id), faces, edges: all };
}
test("describe_body with one id replies exactly as before (byte for byte), without any wrapper", async () => {
  // The same body the tier 1c tests use; the golden string was taken from the code before tier 1d.
  const planeAt = (id: string, center: Vec, normal: Vec, half = 5) => plane(id, center, normal, half, {});
  const radial: Vec = [1, 0, 0];
  const hole = (id: string, axisPoint: Vec) => ({
    id, surfaceType: "Cylinder", planar: false, centerMm: [axisPoint[0] + radial[0] * 2.25, axisPoint[1], axisPoint[2]] as Vec, normal: [-1, 0, 0] as Vec, radiusMm: 2.25, blendRadiusMm: null,
    axisOriginMm: [axisPoint[0], axisPoint[1], axisPoint[2] - 3] as Vec, axisDirection: [0, 0, 1] as Vec,
    boundsMm: box([axisPoint[0] + 2.25 - 2.25, axisPoint[1] - 2.25, axisPoint[2] - 1], [axisPoint[0] + 2.25 + 2.25, axisPoint[1] + 2.25, axisPoint[2] + 1]), edgeIds: ["e1", "e2"],
  }) as unknown as Face;
  const faces = [
    planeAt("top", [20, 15, 10], [0, 0, 1], 15), planeAt("bottom", [20, 15, 0], [0, 0, -1], 15), planeAt("right", [40, 15, 5], [1, 0, 0]), planeAt("left", [0, 15, 5], [-1, 0, 0]),
    planeAt("front", [20, 0, 5], [0, -1, 0]), planeAt("back", [20, 30, 5], [0, 1, 0]),
    hole("h1", [7.5, 7.5, 5]), hole("h2", [32.5, 7.5, 5]), hole("h2b", [32.5, 7.5, 5]),
  ];
  const body = bodyOf(1, faces, [line("e1", [1, 0, 0], [0, 0, 0], 10, ["f1"]), line("e2", [1, 0, 0], [1, 0, 0], 10, ["f1"]), line("e3", [1, 0, 0], [2, 0, 0], 10, ["f1"])]);
  body.edges[0]!.vertexIds = [1, 2]; body.edges[1]!.vertexIds = [2, 3]; body.edges[2]!.vertexIds = [3, 4];
  const run = open(stateOf([body]));
  const { client, close } = await connect(run.fake);
  const reply = text(await client.callTool({ name: "plasticity_describe_body", arguments: { id: 1 } }));
  assert.equal(reply, GOLDEN_SINGLE);
  assert.equal(reply, JSON.stringify(describeBody(body as never, "r1")));
  await close();
});

test("describe_body with ids describes each body once and carries the document revision", async () => {
  const run = open(stateOf([blockBody(1), blockBody(2), blockBody(3)], "r5"));
  const { client, close } = await connect(run.fake);
  const reply = json(await client.callTool({ name: "plasticity_describe_body", arguments: { ids: [3, 1] } }));
  assert.equal(reply.revision, "r5");
  assert.deepEqual(reply.bodies.map((body: { id: number }) => body.id), [3, 1], "in the order asked");
  assert.equal("revision" in reply.bodies[0], false, "the revision is stated once");
  const single = json(await client.callTool({ name: "plasticity_describe_body", arguments: { id: 3 } }));
  const { revision: _revision, ...withoutRevision } = single;
  assert.deepEqual(reply.bodies[0], withoutRevision);
  for (const bad of [{ ids: [] }, { ids: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, { ids: [1], id: 1 }, { ids: [0] }, { ids: [1, 99] }]) {
    const response = await client.callTool({ name: "plasticity_describe_body", arguments: bad });
    assert.equal(response.isError, true, JSON.stringify(bad));
  }
  await close();
});

test("describe_body with no ids describes every body up to 8, and lists the bodies with a hint above that", async () => {
  const few = open(stateOf([blockBody(1), blockBody(2)]));
  const first = await connect(few.fake);
  const all = json(await first.client.callTool({ name: "plasticity_describe_body", arguments: {} }));
  assert.deepEqual(all.bodies.map((body: { id: number }) => body.id), [1, 2]);
  assert.equal(all.revision, "r1");
  await first.close();

  const many = open(stateOf(Array.from({ length: 9 }, (_, index) => blockBody(index + 1))));
  const second = await connect(many.fake);
  const list = json(await second.client.callTool({ name: "plasticity_describe_body", arguments: {} }));
  assert.equal(list.bodyCount, 9);
  assert.deepEqual(Object.keys(list.bodies[0]), ["id", "type", "name", "boundsMm"]);
  assert.match(list.hint, /9 bodies; pass ids \(1-8\)/);
  assert.equal("planes" in list.bodies[0], false);
  await second.close();

  const none = open(stateOf([]));
  const third = await connect(none.fake);
  assert.deepEqual(json(await third.client.callTool({ name: "plasticity_describe_body", arguments: {} })), { revision: "r1", bodies: [] });
  await third.close();
});

// An open box: outer walls at 0 and 40 (x), 0 and 30 (y), floor at z 2, rim at z 10; inner walls at 2 and 38 (x), 2 and 28 (y); a small cut-out wall pair inside.
function openBox(extra: Face[] = [], extraEdges: Edge[] = []) {
  const faces = [
    plane("xn", [0, 15, 5], [-1, 0, 0], 15), plane("xp", [40, 15, 5], [1, 0, 0], 15), plane("yn", [20, 0, 5], [0, -1, 0], 20), plane("yp", [20, 30, 5], [0, 1, 0], 20),
    plane("bottom", [20, 15, 0], [0, 0, -1], 20), plane("rim", [20, 15, 10], [0, 0, 1], 20),
    plane("ixp", [2, 15, 6], [1, 0, 0], 13), plane("ixn", [38, 15, 6], [-1, 0, 0], 13), plane("iyp", [20, 2, 6], [0, 1, 0], 18), plane("iyn", [20, 28, 6], [0, -1, 0], 18),
    plane("floor", [20, 15, 2], [0, 0, 1], 18),
    // A narrow notch in the wall: a wall pair that is closer together but tiny.
    plane("nxp", [18, 0, 6], [1, 0, 0], 1), plane("nxn", [22, 0, 6], [-1, 0, 0], 1),
    ...extra,
  ];
  return bodyOf(5, faces, extraEdges.length > 0 ? extraEdges : [line("e1", [1, 0, 0], [0, 0, 0], 10, ["f1"])]);
}

test("describe_body reads an open-top cavity from the planes: the widest inward wall pair on x and y, and the floor", () => {
  const described = describeBody(openBox() as never, "r1");
  assert.deepEqual(described.cavity, { xMm: [2, 38], yMm: [2, 28], floorZMm: 2 }, "the notch pair is closer but smaller: not the cavity");
  // A plate with a rectangular through slot has wall pairs and no floor: no cavity.
  const slotted = bodyOf(6, [plane("top", [20, 15, 10], [0, 0, 1], 20), plane("bottom", [20, 15, 0], [0, 0, -1], 20),
    plane("xn", [0, 15, 5], [-1, 0, 0]), plane("xp", [40, 15, 5], [1, 0, 0]), plane("yn", [20, 0, 5], [0, -1, 0]), plane("yp", [20, 30, 5], [0, 1, 0]),
    plane("sxp", [10, 15, 5], [1, 0, 0], 5), plane("sxn", [30, 15, 5], [-1, 0, 0], 5), plane("syp", [20, 10, 5], [0, 1, 0], 5), plane("syn", [20, 20, 5], [0, -1, 0], 5)]);
  assert.equal("cavity" in describeBody(slotted as never, "r1"), false);
  // A solid block has none either.
  assert.equal("cavity" in describeBody(blockBody() as never, "r1"), false);
});

test("describe_body tells through from blind holes and gives the axial extent, only when the faces are full-turn", () => {
  const hole = (id: string, at: Vec, edgeIds: string[]) => cylinderFace(id, at, 1.25, false, { edgeIds, boundsMm: box([at[0] + 1.25 - 1.25, at[1] - 1.25, 15], [at[0] + 1.25 + 1.25, at[1] + 1.25, 23]) });
  const faces = [
    plane("top", [20, 15, 25], [0, 0, 1], 15, { edgeIds: ["t1", "t2", "t3"] }),
    plane("floorA", [5, 5, 15], [0, 0, 1], 1.25, { edgeIds: ["a2"] }), // one edge: a flat floor closes hole A at the bottom
    plane("wallB", [15, 5, 15], [0, 0, 1], 5, { edgeIds: ["b2", "b9", "b8", "b7"] }), // a bigger face continues past hole B: through
    hole("hA", [5, 5, 19], ["a1", "a2"]), hole("hB", [15, 5, 19], ["b1", "b2"]),
  ];
  const edges = [
    circle("a1", [5, 5, 23], ["hA", "top"]), circle("a2", [5, 5, 15], ["hA", "floorA"]),
    circle("b1", [15, 5, 23], ["hB", "top"]), circle("b2", [15, 5, 15], ["hB", "wallB"]),
  ];
  const described = describeBody(bodyOf(7, faces, edges) as never, "r1");
  const holes = described.cylinders.filter((group) => group.kind === "hole");
  assert.equal(holes.length, 1, "same radius and axis: one group");
  assert.equal("through" in holes[0]!, false, "mixed through and blind: not reported for the group");

  const blindOnly = describeBody(bodyOf(8, [faces[0]!, faces[1]!, faces[3]!], [edges[0]!, edges[1]!]) as never, "r1");
  assert.equal(blindOnly.cylinders[0]!.through, false);
  assert.deepEqual(blindOnly.cylinders[0]!.extentMm, [15, 23]);
  const throughOnly = describeBody(bodyOf(9, [faces[0]!, faces[2]!, faces[4]!], [edges[2]!, edges[3]!]) as never, "r1");
  assert.equal(throughOnly.cylinders[0]!.through, true);
  assert.deepEqual(throughOnly.cylinders[0]!.extentMm, [15, 23]);
  // A face without circle edges says neither.
  const unknown = describeBody(bodyOf(10, [faces[3]!]) as never, "r1");
  assert.equal("through" in unknown.cylinders[0]!, false);
  assert.equal("extentMm" in unknown.cylinders[0]!, false);
  // Bosses get the extent but no through or blind.
  const boss = cylinderFace("boss", [5, 5, 19], 3, true, { edgeIds: ["c1", "c2"], boundsMm: box([5, 2, 15], [11, 8, 23]) });
  const bossBody = describeBody(bodyOf(11, [boss], [circle("c1", [5, 5, 23], ["boss"]), circle("c2", [5, 5, 15], ["boss"])]) as never, "r1");
  assert.equal(bossBody.cylinders[0]!.kind, "boss");
  assert.deepEqual(bossBody.cylinders[0]!.extentMm, [15, 23]);
  assert.equal("through" in bossBody.cylinders[0]!, false);
});

test("describe_body stays small: the tier 1c enclosure shape with the new fields is under 1.7 KB", () => {
  const faces: Face[] = [
    plane("xn0", [0, 25, 12], [-1, 0, 0], 25), plane("xp0", [80, 25, 12], [1, 0, 0], 25), plane("yn0", [40, 0, 12], [0, -1, 0], 40), plane("yp0", [40, 50, 12], [0, 1, 0], 40),
    plane("floor", [40, 25, 2], [0, 0, 1], 38), plane("rim", [40, 25, 25], [0, 0, 1], 40), plane("bottom", [40, 25, 0], [0, 0, -1], 40),
    plane("ixp", [2, 25, 12], [1, 0, 0], 22), plane("ixn", [78, 25, 12], [-1, 0, 0], 22), plane("iyp", [40, 2, 12], [0, 1, 0], 36), plane("iyn", [40, 48, 12], [0, -1, 0], 36),
  ];
  const edges: Edge[] = [];
  [[4.5, 4.5], [75.5, 4.5], [4.5, 45.5], [75.5, 45.5]].forEach(([x, y], index) => {
    faces.push(cylinderFace(`p${index}`, [x!, y!, 19], 1.25, false, { edgeIds: [`pa${index}`, `pb${index}`], boundsMm: box([x! - 1.25, y! - 1.25, 15], [x! + 1.25, y! + 1.25, 23]) }));
    faces.push(cylinderFace(`b${index}`, [x!, y!, 12.5], 3, true, { edgeIds: [`ba${index}`, `bb${index}`], boundsMm: box([x! - 3, y! - 3, 2], [x! + 3, y! + 3, 23]) }));
    faces.push(plane(`pf${index}`, [x!, y!, 15], [0, 0, 1], 1.25, { edgeIds: [`pb${index}`] }));
    faces.push(plane(`bt${index}`, [x!, y!, 23], [0, 0, 1], 3, { edgeIds: [`ba${index}`, `pa${index}`] }));
    edges.push(circle(`pa${index}`, [x!, y!, 23], [`p${index}`, `bt${index}`]), circle(`pb${index}`, [x!, y!, 15], [`p${index}`, `pf${index}`]));
    edges.push(circle(`ba${index}`, [x!, y!, 23], [`b${index}`, `bt${index}`]), circle(`bb${index}`, [x!, y!, 2], [`b${index}`, "floor"]));
  });
  const described = describeBody(bodyOf(1, faces, edges, box([0, 0, 0], [80, 50, 25])) as never, "r26.d828fbe27cef1fe7");
  assert.deepEqual(described.cavity, { xMm: [2, 78], yMm: [2, 48], floorZMm: 2 });
  const pilots = described.cylinders.find((group) => group.kind === "hole")!;
  assert.equal(pilots.through, false);
  assert.deepEqual(pilots.extentMm, [15, 23]);
  assert.ok(size(described) <= 1_700, `size ${size(described)}`);
});

// ---------- hints and the lean status step ----------

function manyFaces(count: number) {
  const faces = Array.from({ length: count }, (_, index) => ({ ...plane(`f${index}`, [index, 0, 0], [0, 0, 1], 1), edgeIds: ["e1", "e2", "e3", "e4"] }));
  return bodyOf(1, faces);
}

test("a cut direct find reply starts with a concrete next move; the older hint stays", async () => {
  const run = open(stateOf([manyFaces(200)]));
  const { client, close } = await connect(run.fake);
  const reply = json(await client.callTool({ name: "plasticity_find_faces", arguments: { revision: "r1", query: { bodyIds: [1] } } }));
  assert.equal(Object.keys(reply)[0], "next", "first in the reply");
  assert.equal(reply.next, "200 matches; add limit (e.g. 20) with sortBy, or use plasticity_describe_body for hole, boss and plane positions");
  assert.equal(reply.truncated, true);
  assert.equal(reply.hint, "add limit/sortBy or narrow the query");
  assert.ok(size(reply) <= 8_000);
  const edges = open(stateOf([{ ...manyFaces(3), edges: Array.from({ length: 150 }, (_, index) => line(`g${index}`, [1, 0, 0], [index, 0, 0], index + 1, ["f1"])) }]));
  const second = await connect(edges.fake);
  const edgeReply = json(await second.client.callTool({ name: "plasticity_find_edges", arguments: { revision: "r1", query: { bodyIds: [1] } } }));
  assert.equal(edgeReply.truncated, true);
  assert.match(edgeReply.next, /^150 matches; add limit \(e\.g\. 20\) with sortBy, or narrow the query$/);
  await second.close();
  await close();
});

test("a batch read step cut at 1,500 bytes carries the same kind of next move, first", async () => {
  const run = open(stateOf([manyFaces(40)]));
  const { client, close } = await connect(run.fake);
  const output = await runBatch(client, { steps: [{ toolName: "plasticity_find_faces", arguments: { query: { bodyIds: [1] } } }] });
  const cut = output.steps[0].result;
  assert.equal(cut.truncated, true);
  assert.equal(Object.keys(cut)[0], "next");
  assert.match(cut.next, /^40 matches; add return: \["matches\[\*\]\.id"\]/);
  assert.match(cut.next, /plasticity_describe_body/);
  assert.equal(cut.hint, "add return: [...] to this step", "the older hint stays");
  await close();
});

test("plasticity_status as a lean batch step without return answers with the header, not a cut blob", async () => {
  const bodies = Array.from({ length: 30 }, (_, index) => ({ ...blockBody(index + 1), name: `part-${index + 1}` }));
  const run = open(stateOf(bodies, "r9"));
  const { client, close } = await connect(run.fake);
  const output = await runBatch(client, { detail: "lean", steps: [{ toolName: "plasticity_status", arguments: { bodyLimit: 50 } }] });
  const status = output.steps[0].result;
  assert.equal(status.truncated, undefined);
  assert.equal(status.revision, "r9");
  assert.equal(status.undoDepth, 0);
  assert.equal(status.bodyCount, 30);
  assert.equal(status.bodies.length, 20);
  assert.deepEqual(Object.keys(status.bodies[0]), ["id", "type", "name", "boundsMm"]);
  assert.equal(status.moreBodies, 10);
  assert.ok(size(status) < 2_500, `size ${size(status)}`);

  const projected = await runBatch(client, { detail: "lean", steps: [{ toolName: "plasticity_status", arguments: {}, return: ["bodyPagination.total"] }] });
  assert.deepEqual(projected.steps[0].result, { "bodyPagination.total": 30 }, "return still wins");

  const standard = await runBatch(client, { steps: [{ toolName: "plasticity_status", arguments: {} }] });
  assert.equal(standard.steps[0].result.truncated, true, "outside lean mode it is the explicit cut note, as before");

  const small = open(stateOf([blockBody()]));
  const tiny = await connect(small.fake);
  const whole = await runBatch(tiny.client, { detail: "lean", steps: [{ toolName: "plasticity_status", arguments: {} }] });
  assert.equal(whole.steps[0].result.targetId, "window-1", "a status small enough to fit comes back whole");
  await tiny.close();
  await close();
});

// ---------- server surface: rib, descriptions, instructions ----------

test("the rib tool takes side and keepProfile, forwards them, and lean keeps ribBoundsMm out unless return asks", async () => {
  const fake = recipeFake();
  const session = {
    async windows() { return []; }, async connect() { return fake.operations.state(); }, get() { return fake.operations as unknown as PlasticityOperations; },
    capabilities() { return { bindings: [], operations: { constructionPlanes: { available: false, reason: "test" }, activeWorkplane: { available: false, reason: "test" } } }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const { client, close } = await connect(session);
  const tool = (await client.listTools()).tools.find((entry) => entry.name === "plasticity_create_rib")!;
  assert.match(tool.description ?? "", /right-hand normal/);
  assert.match(tool.description ?? "", /ribBoundsMm/);
  const props = (tool.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
  assert.deepEqual(props.side!.enum, ["centered", "positive", "negative"]);
  assert.ok("keepProfile" in props);

  const bad = await client.callTool({ name: "plasticity_create_rib", arguments: { targetId: 7, profilePointsMm: RIB_POINTS, thicknessMm: 4, side: "left", revision: "r1" } });
  assert.equal(bad.isError, true);

  const output = await runBatch(client, { detail: "lean", steps: [
    { toolName: "plasticity_create_rib", arguments: { targetId: 7, profilePointsMm: RIB_POINTS, thicknessMm: 4, side: "centered", keepProfile: false } },
    { toolName: "plasticity_status", arguments: {}, return: ["undoDepth"] },
  ] });
  assert.equal(output.steps[0].result.status, "completed");
  assert.equal(JSON.stringify(output.steps[0]).includes("ribBoundsMm"), false);
  assert.equal(fake.calls.some((call) => call.operation === "remove"), true);
  assert.equal(output.summary.added, undefined, "the construction Wire was deleted, so it is not listed as added");

  const second = recipeFake();
  const again = await connect({ ...session, get() { return second.operations as unknown as PlasticityOperations; }, async connect() { return second.operations.state(); } } satisfies SessionLike);
  const picked = await runBatch(again.client, { detail: "lean", steps: [{ toolName: "plasticity_create_rib", arguments: { targetId: 7, profilePointsMm: RIB_POINTS, thicknessMm: 4 }, return: ["ribBoundsMm"] }] });
  assert.deepEqual(picked.steps[0].result, { ribBoundsMm: { min: [10, 9, 3.5], max: [30, 13, 14] } });
  assert.deepEqual(picked.summary.added.map((body: { type: string }) => body.type), ["Wire"], "by default the Wire is listed, because it stays");
  await again.close();
  await close();
});

test("tool descriptions and instructions name edgeQuery, describe_body without an id, and stay within the size budget", async () => {
  const run = open(stateOf([blockBody()]));
  const { client, close } = await connect(run.fake);
  const tools = (await client.listTools()).tools;
  for (const name of ["plasticity_fillet", "plasticity_chamfer"]) {
    const entry = tools.find((candidate) => candidate.name === name)!;
    assert.match(entry.description ?? "", /edgeQuery/);
    assert.ok("edgeQuery" in (entry.inputSchema as { properties: object }).properties);
    assert.ok("edgeIds" in (entry.inputSchema as { properties: object }).properties);
  }
  assert.match(tools.find((candidate) => candidate.name === "plasticity_describe_body")!.description ?? "", /Includes hole and boss axis positions: no face search needed for those/);
  assert.match(PLASTICITY_MCP_INSTRUCTIONS, /edgeQuery/);
  assert.match(PLASTICITY_MCP_INSTRUCTIONS, /plasticity_describe_body, with no id, as the first and last read/);
  // The tier 1c instructions were 4,349 bytes; the 1d paragraph may grow by 250 characters at most.
  assert.ok(Buffer.byteLength(PLASTICITY_MCP_INSTRUCTIONS) - 4_349 <= 250, `grew by ${Buffer.byteLength(PLASTICITY_MCP_INSTRUCTIONS) - 4_349}`);
  await close();
});
