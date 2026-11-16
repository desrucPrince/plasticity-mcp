import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createCompactServer, type SessionLike } from "./server.ts";
import type { PlasticityOperations } from "./plasticity/operations.ts";
import { PlasticityRecipes, type RecipeOperations } from "./plasticity/recipes.ts";
import type { RuntimeState } from "./plasticity/runtime.ts";
import { describeBodies, describeBody, listBodies } from "./plasticity/semantic.ts";

// describe_body tells the truth: every derived field is provable from the read model or left out. No cavity field;
// through only under its two proofs; three byte limits that hold for one body, several bodies and the body list, also
// inside a batch; arcs by sweep; the lean status step names what it leaves out; keepProfile warnings; roundMm rate keys.

type Vec = [number, number, number];
type Face = RuntimeState["bodies"][number]["faces"][number];
type Edge = RuntimeState["bodies"][number]["edges"][number];
const box = (min: Vec, max: Vec) => ({ min, max });
const text = (response: unknown): string => (response as { content: Array<{ type: string; text?: string }> }).content.find((entry) => entry.type === "text")!.text!;
const json = (response: unknown): any => JSON.parse(text(response));
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

// ---------- fixtures ----------

function plane(id: string, center: Vec, normal: Vec, half: number, edgeIds: string[]): Face {
  const spread = (axis: number) => half * Math.abs(1 - Math.abs(normal[axis]!));
  return {
    id, surfaceType: "Plane", planar: true, centerMm: center, normal, radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null,
    boundsMm: box([center[0] - spread(0), center[1] - spread(1), center[2] - spread(2)], [center[0] + spread(0), center[1] + spread(1), center[2] + spread(2)]),
    edgeIds,
  } as Face;
}
// A bore (hole) or post (boss) face along z at (x, y), from z0 to z1.
function bore(id: string, at: [number, number], radius: number, z0: number, z1: number, edgeIds: string[], outward = false): Face {
  return {
    id, surfaceType: "Cylinder", planar: false, centerMm: [at[0] + radius, at[1], (z0 + z1) / 2], normal: [outward ? 1 : -1, 0, 0], radiusMm: radius, blendRadiusMm: null,
    axisOriginMm: [at[0], at[1], z0], axisDirection: [0, 0, 1],
    boundsMm: box([at[0] - radius, at[1] - radius, z0], [at[0] + radius, at[1] + radius, z1]), edgeIds,
  } as Face;
}
function other(id: string, surfaceType: string, edgeIds: string[], extra: Partial<Face> = {}): Face {
  return { ...plane(id, [0, 0, 0], [0, 0, 1], 1, edgeIds), surfaceType, planar: false, ...extra } as Face;
}
// A circle edge from startDeg to endDeg (360 sweep when equal) about (cx, cy, z), with geometry the sweep can be read from.
function ring(id: string, center: [number, number], z: number, radius: number, faceIds: string[], fromDeg = 0, toDeg = 360): Edge {
  const at = (deg: number): Vec => [center[0] + radius * Math.cos(deg * Math.PI / 180), center[1] + radius * Math.sin(deg * Math.PI / 180), z];
  const closed = toDeg - fromDeg >= 360;
  return {
    id, curveType: "Circle", line: false, circle: true, lengthMm: 1, centerMm: at((fromDeg + toDeg) / 2), tangent: [1, 0, 0], boundsMm: box([center[0] - radius, center[1] - radius, z], [center[0] + radius, center[1] + radius, z]),
    faceIds, vertexIds: [],
    circleGeometry: { centerMm: [center[0], center[1], z], radiusMm: radius, normal: [0, 0, 1], reference: [1, 0, 0], startMm: at(fromDeg), midpointMm: at((fromDeg + toDeg) / 2), endMm: closed ? at(fromDeg) : at(toDeg) },
  } as Edge;
}
function bodyOf(id: number, faces: Face[], edges: Edge[], bounds = box([0, 0, 0], [40, 30, 10]), name: string | null = "part") {
  return { id, versionId: id * 10, type: "Solid", name, boundsMm: bounds, faceIds: faces.map((face) => face.id), edgeIds: edges.map((edge) => edge.id), faces, edges };
}
const AT: [number, number] = [20, 15];
// The outer planes of a 40 x 30 x 10 block, with the hole edges `topEdges` on the top face and `bottomEdges` on the bottom face.
const blockPlanes = (topEdges: string[], bottomEdges: string[]): Face[] => [
  plane("top", [20, 15, 10], [0, 0, 1], 20, ["o1", "o2", "o3", "o4", ...topEdges]), plane("bottom", [20, 15, 0], [0, 0, -1], 20, ["o5", "o6", "o7", "o8", ...bottomEdges]),
];
const throughOf = (described: ReturnType<typeof describeBody>, radius = 2) => described.cylinders.find((group) => group.kind === "hole" && group.radiusMm === radius)!;

// ---------- through: provable or absent ----------

test("through: a true through hole reaches the body bounds at both ends: true", () => {
  const faces = [...blockPlanes(["ct"], ["cb"]), bore("bore", AT, 2, 0, 10, ["ct", "cb"])];
  const edges = [ring("ct", AT, 10, 2, ["bore", "top"]), ring("cb", AT, 0, 2, ["bore", "bottom"])];
  const group = throughOf(describeBody(bodyOf(1, faces, edges) as never, "r1"));
  assert.equal(group.through, true);
  assert.deepEqual(group.extentMm, [0, 10]);
  // Within 0.001 mm counts; 0.002 mm short does not (and nothing closes it, so nothing is said).
  const near = bodyOf(1, [...blockPlanes(["ct"], ["cb"]), bore("bore", AT, 2, 0.0005, 9.9995, ["ct", "cb"])], edges);
  assert.equal(throughOf(describeBody(near as never, "r1")).through, true);
  const short = bodyOf(1, [...blockPlanes(["ct"], ["cb"]), bore("bore", AT, 2, 0.002, 10, ["ct", "cb"])], edges);
  assert.equal("through" in throughOf(describeBody(short as never, "r1")), false);
});

test("through: a Sheet cup (cylinder wall plus bottom disc) says nothing; through is a claim about Solids", () => {
  // The wall spans the whole body bounds along z, so the bounds test used to read "through" although a disc closes the bottom.
  const faces = [bore("bore", AT, 2, 0, 10, ["ct", "cb"]), plane("floor", [20, 15, 0], [0, 0, 1], 2, ["cb"])];
  const edges = [ring("ct", AT, 10, 2, ["bore"]), ring("cb", AT, 0, 2, ["bore", "floor"])];
  const asSheet = { ...bodyOf(1, faces, edges), type: "Sheet" };
  const sheet = describeBody(asSheet as never, "r1");
  const group = throughOf(sheet);
  assert.equal("through" in group, false, "a Sheet reports no through at all");
  assert.deepEqual(group.extentMm, [0, 10], "the rest of the group is unchanged");
  // The same faces on a Solid still read through by the bounds test (a Solid's wall reaching both ends is the proof).
  assert.equal(throughOf(describeBody(bodyOf(1, faces, edges) as never, "r1")).through, true);
  // A Sheet whose floor would read "blind" says nothing either.
  const blind = { ...bodyOf(1, [...blockPlanes(["ct"], []), bore("bore", AT, 2, 4, 10, ["ct", "cf"]), plane("floor", [20, 15, 4], [0, 0, 1], 2, ["cf"])], [ring("ct", AT, 10, 2, ["bore", "top"]), ring("cf", AT, 4, 2, ["bore", "floor"])]), type: "Sheet" };
  assert.equal("through" in throughOf(describeBody(blind as never, "r1")), false);
});

test("through: a flat disc floor that closes the bore at one end: false", () => {
  const faces = [...blockPlanes(["ct"], []), bore("bore", AT, 2, 4, 10, ["ct", "cf"]), plane("floor", [20, 15, 4], [0, 0, 1], 2, ["cf"])];
  const edges = [ring("ct", AT, 10, 2, ["bore", "top"]), ring("cf", AT, 4, 2, ["bore", "floor"])];
  const group = throughOf(describeBody(bodyOf(1, faces, edges) as never, "r1"));
  assert.equal(group.through, false);
  assert.deepEqual(group.extentMm, [4, 10]);
  // Seam-split circles at each end (two half circles) are still one full turn, and the floor owns both of its half circles.
  const seamFaces = [...blockPlanes(["ct1", "ct2"], []), bore("bore", AT, 2, 4, 10, ["ct1", "ct2", "cf1", "cf2"]), plane("floor", [20, 15, 4], [0, 0, 1], 2, ["cf1", "cf2"])];
  const seamEdges = [ring("ct1", AT, 10, 2, ["bore", "top"], 0, 180), ring("ct2", AT, 10, 2, ["bore", "top"], 180, 360), ring("cf1", AT, 4, 2, ["bore", "floor"], 0, 180), ring("cf2", AT, 4, 2, ["bore", "floor"], 180, 360)];
  const seam = describeBody(bodyOf(1, seamFaces, seamEdges) as never, "r1");
  assert.equal(seam.cylinders.filter((entry) => entry.kind === "arc").length, 0);
  assert.equal(throughOf(seam).through, false);
});

test("through: a filleted floor, a chamfered floor, a stepped hole, a vented floor and a hole into a cavity say nothing", () => {
  // Filleted floor: the bore ends at a torus blend, then a smaller flat disc.
  const filleted = bodyOf(1, [...blockPlanes(["ct"], []), bore("bore", AT, 2, 4.5, 10, ["ct", "cf"]), other("blend", "Torus", ["cf", "ci"]), plane("floor", [20, 15, 4], [0, 0, 1], 1.5, ["ci"])],
    [ring("ct", AT, 10, 2, ["bore", "top"]), ring("cf", AT, 4.5, 2, ["bore", "blend"]), ring("ci", AT, 4, 1.5, ["blend", "floor"])]);
  assert.equal("through" in throughOf(describeBody(filleted as never, "r1")), false, "filleted floor");
  // Chamfered floor: a cone between the bore and the flat disc.
  const chamfered = bodyOf(1, [...blockPlanes(["ct"], []), bore("bore", AT, 2, 4.5, 10, ["ct", "cf"]), other("cone", "Cone", ["cf", "ci"]), plane("floor", [20, 15, 4], [0, 0, 1], 1.5, ["ci"])],
    [ring("ct", AT, 10, 2, ["bore", "top"]), ring("cf", AT, 4.5, 2, ["bore", "cone"]), ring("ci", AT, 4, 1.5, ["cone", "floor"])]);
  assert.equal("through" in throughOf(describeBody(chamfered as never, "r1")), false, "chamfered floor");
  // Stepped hole: a wide bore down to a step, then a narrow bore to the bottom. The annulus step is no disc floor for either.
  const stepped = describeBody(bodyOf(1, [...blockPlanes(["ct"], ["cb"]), bore("wide", AT, 3, 6, 10, ["ct", "cs1"]), plane("step", [20, 15, 6], [0, 0, 1], 3, ["cs1", "cs2"]), bore("narrow", AT, 2, 0, 6, ["cs2", "cb"])],
    [ring("ct", AT, 10, 3, ["wide", "top"]), ring("cs1", AT, 6, 3, ["wide", "step"]), ring("cs2", AT, 6, 2, ["step", "narrow"]), ring("cb", AT, 0, 2, ["narrow", "bottom"])]) as never, "r1");
  assert.equal("through" in throughOf(stepped, 3), false, "stepped wide bore");
  assert.equal("through" in throughOf(stepped, 2), false, "stepped narrow bore");
  // Vented floor: a flat floor with a smaller vent hole in it. The floor has an edge that is not the bore's.
  const vented = describeBody(bodyOf(1, [...blockPlanes(["ct"], ["cb"]), bore("bore", AT, 2, 4, 10, ["ct", "cf"]), plane("floor", [20, 15, 4], [0, 0, 1], 2, ["cf", "cv"]), bore("vent", AT, 0.5, 0, 4, ["cv", "cb"])],
    [ring("ct", AT, 10, 2, ["bore", "top"]), ring("cf", AT, 4, 2, ["bore", "floor"]), ring("cv", AT, 4, 0.5, ["floor", "vent"]), ring("cb", AT, 0, 0.5, ["vent", "bottom"])]) as never, "r1");
  assert.equal("through" in throughOf(vented, 2), false, "vented floor: not a closed bore");
  assert.equal("through" in throughOf(vented, 0.5), false, "the vent stops at the floor and cannot be shown to reach the other end");
  // A hole that opens into an internal cavity: its far end is the cavity roof, a big face with other edges.
  const cavityHole = describeBody(bodyOf(1, [...blockPlanes(["ct"], []), bore("bore", AT, 2, 8, 10, ["ct", "cr"]), plane("roof", [20, 15, 8], [0, 0, -1], 15, ["cr", "r1", "r2", "r3", "r4"])],
    [ring("ct", AT, 10, 2, ["bore", "top"]), ring("cr", AT, 8, 2, ["bore", "roof"])]) as never, "r1");
  assert.equal("through" in throughOf(cavityHole), false, "opens into a cavity");
  assert.deepEqual(throughOf(cavityHole).extentMm, [8, 10], "the extent is still given");
});

test("through: a bore that reaches both ends but has an unsure group (mixed holes) is left out", () => {
  const faces = [...blockPlanes(["ct", "ct2"], ["cb"]), bore("a", AT, 2, 0, 10, ["ct", "cb"]), bore("b", [8, 8], 2, 4, 10, ["ct2", "cf"]), plane("floor", [8, 8, 4], [0, 0, 1], 2, ["cf"])];
  const edges = [ring("ct", AT, 10, 2, ["a", "top"]), ring("cb", AT, 0, 2, ["a", "bottom"]), ring("ct2", [8, 8], 10, 2, ["b", "top"]), ring("cf", [8, 8], 4, 2, ["b", "floor"])];
  const described = describeBody(bodyOf(1, faces, edges) as never, "r1");
  assert.equal("through" in throughOf(described), false, "one hole through, one blind: the group says neither");
  assert.equal(throughOf(described).count, 2);
});

test("a slanted bore never says through", () => {
  const slanted = { ...bore("s", AT, 2, 0, 10, ["ct", "cb"]), axisDirection: [0.6, 0, 0.8] } as Face;
  const group = describeBody(bodyOf(1, [...blockPlanes(["ct"], ["cb"]), slanted], [ring("ct", AT, 10, 2, ["s", "top"]), ring("cb", AT, 0, 2, ["s", "bottom"])]) as never, "r1").cylinders[0]!;
  assert.equal("through" in group, false);
});

// ---------- cavity is gone ----------

test("describe_body has no cavity field: shelled boxes, plates with posts and bracket windows read their planes instead", () => {
  // A shelled box with a lid seat at z 8 and a real floor at z 2.
  const shelled = bodyOf(1, [
    plane("xn", [0, 15, 5], [-1, 0, 0], 15, ["a"]), plane("xp", [40, 15, 5], [1, 0, 0], 15, ["a"]), plane("yn", [20, 0, 5], [0, -1, 0], 20, ["a"]), plane("yp", [20, 30, 5], [0, 1, 0], 20, ["a"]),
    plane("bottom", [20, 15, 0], [0, 0, -1], 20, ["a"]), plane("rim", [20, 15, 10], [0, 0, 1], 20, ["a"]), plane("seat", [20, 15, 8], [0, 0, 1], 16, ["a"]), plane("floor", [20, 15, 2], [0, 0, 1], 16, ["a"]),
    plane("ixp", [2, 15, 5], [1, 0, 0], 12, ["a"]), plane("ixn", [38, 15, 5], [-1, 0, 0], 12, ["a"]), plane("iyp", [20, 2, 5], [0, 1, 0], 18, ["a"]), plane("iyn", [20, 28, 5], [0, -1, 0], 18, ["a"]),
  ], []);
  const described = describeBody(shelled as never, "r1") as unknown as Record<string, unknown>;
  assert.equal("cavity" in described, false);
  assert.equal(JSON.stringify(described).includes("cavity"), false);
  const planes = described.planes as Record<string, Array<{ mm: number }>>;
  assert.deepEqual(planes.zPos!.map((entry) => entry.mm), [2, 8, 10], "floor, seat and rim are all there, each with its own offset");
  assert.deepEqual(planes.xPos!.map((entry) => entry.mm), [2, 40], "the inner wall plane is an xPos entry just inside the bounds");
  assert.deepEqual(planes.xNeg!.map((entry) => entry.mm), [0, 38]);
  // A plate with four corner posts, and an L-bracket with a window, have no cavity either.
  const plate = bodyOf(2, [plane("top", [20, 15, 3], [0, 0, 1], 20, ["a"]), plane("bottom", [20, 15, 0], [0, 0, -1], 20, ["a"]), ...[[5, 5], [35, 5], [5, 25], [35, 25]].map(([x, y], index) => bore(`post${index}`, [x!, y!], 2, 3, 12, ["a", "b"], true))], [], box([0, 0, 0], [40, 30, 12]));
  assert.equal("cavity" in (describeBody(plate as never, "r1") as unknown as Record<string, unknown>), false);
});

// ---------- the three byte limits ----------

// A body whose full description is far over 4 KB: many plane offsets, cylinder groups, blends, cones and other surfaces.
function heavyBody(id: number, name = "x".repeat(5_000)) {
  const faces: Face[] = [];
  const normals: Vec[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  normals.forEach((normal, direction) => { for (let index = 0; index < 30; index += 1) faces.push(plane(`p${direction}-${index}`, [index * 3.123457 + direction, index * 2.5, index * 1.75], normal, 2, ["e1"])); });
  for (let index = 0; index < 60; index += 1) faces.push(bore(`h${index}`, [index * 4.1, 5], 1 + index * 0.05, 0, 10, ["e1", "e2"]));
  for (let index = 0; index < 40; index += 1) faces.push({ ...bore(`b${index}`, [index * 3, 90], 1, 0, 10, ["e1"], true), blendRadiusMm: 0.5 + index * 0.1 } as Face);
  for (let index = 0; index < 30; index += 1) faces.push(other(`k${index}`, "Cone", ["e1"], { coneSemiAngleRad: 0.01 + index * 0.02 }));
  for (let index = 0; index < 30; index += 1) faces.push(other(`o${index}`, `Exotic${index}`, ["e1"]));
  return bodyOf(id, faces, [ring("e1", [0, 0], 0, 1, ["h0"]), ring("e2", [0, 0], 10, 1, ["h0"])], box([0.123456789, 0.123456789, 0], [400.987654321, 100.5, 10.25]), name);
}

const OPEN_FAKE_EXTRA = {};
function open(bodies: unknown[], extra: Record<string, unknown> = OPEN_FAKE_EXTRA) {
  const state = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r26.d828fbe27cef1fe7", dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" }, bodies,
  } as unknown as RuntimeState;
  const operations = { async state() { return state; }, ...extra } as unknown as PlasticityOperations;
  return {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: { constructionPlanes: { available: false, reason: "test" }, activeWorkplane: { available: false, reason: "test" } } }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
}
async function connect(fake: SessionLike) {
  const server = createCompactServer(fake, undefined, undefined, undefined, null);
  const client = new Client({ name: "describe-truth-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
async function runBatch(client: Client, args: Record<string, unknown>) {
  const response = await client.callTool({ name: "plasticity_batch", arguments: args });
  assert.equal(response.isError, undefined, JSON.stringify(response.content));
  return json(response);
}

test("limit 1: one heavy body stays within 4,096 bytes", () => {
  const described = describeBody(heavyBody(1) as never, "r26.d828fbe27cef1fe7");
  assert.ok(size(described) <= 4_096, `size ${size(described)}`);
  assert.equal(described.truncated, true);
  assert.ok(size(describeBody(heavyBody(1) as never, "r1", 1_000_000)) > 8_000, "the untrimmed description is much bigger, so the cap really cuts");
});

test("limit 2: ids and the no-argument form with 8 heavy bodies stay within 12,000 bytes, every body present, nothing cut without a count", async () => {
  const bodies = Array.from({ length: 8 }, (_, index) => heavyBody(index + 1));
  const { client, close } = await connect(open(bodies));
  for (const args of [{}, { ids: [1, 2, 3, 4, 5, 6, 7, 8] }, { ids: [8, 7, 6, 5, 4, 3, 2, 1] }]) {
    const raw = text(await client.callTool({ name: "plasticity_describe_body", arguments: args }));
    assert.ok(Buffer.byteLength(raw) <= 12_000, `${JSON.stringify(args)}: ${Buffer.byteLength(raw)} bytes`);
    const reply = JSON.parse(raw);
    assert.equal(reply.revision, "r26.d828fbe27cef1fe7");
    assert.deepEqual(reply.bodies.map((body: { id: number }) => body.id), (args as { ids?: number[] }).ids ?? [1, 2, 3, 4, 5, 6, 7, 8], "no body is dropped");
    for (const body of reply.bodies) {
      assert.equal(body.faceCount, 6 * 30 + 60 + 40 + 30 + 30, "the true face count");
      assert.equal(body.truncated, true);
      assert.ok(body.cylindersMore > 0 || body.cylinders.length > 0);
      assert.equal(body.planes.more !== undefined || body.planesMore !== undefined, true, "what was left out of the planes is counted");
      assert.equal("revision" in body, false);
    }
  }
  // One heavy body through ids still gets at most the single-body 4 KB.
  const single = text(await client.callTool({ name: "plasticity_describe_body", arguments: { ids: [1] } }));
  assert.ok(Buffer.byteLength(single) <= 4_096 + 60, `ids [1]: ${Buffer.byteLength(single)} bytes`);
  await close();
});

test("limit 2: the share is equal, and small bodies are not trimmed", () => {
  const reply = describeBodies([heavyBody(1), heavyBody(2), heavyBody(3)] as never[], "r1");
  const sizes = reply.bodies.map((body) => size(body));
  assert.ok(size(reply) <= 12_000, `size ${size(reply)}`);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) < 150, `sizes ${sizes}`);
  const small = describeBodies([bodyOf(1, blockPlanes([], []), [])] as never[], "r1");
  assert.equal(small.bodies[0]!.truncated, undefined);
});

function listBody(id: number, name: string) {
  return bodyOf(id, [plane("top", [20, 15, 10], [0, 0, 1], 20, ["o1"])], [], box([0.123456789, -0.987654321, 1999.9999999], [100.55555555, 0.00049, 2100.44444444]), name);
}

test("limit 3: the list of more than 8 bodies is at most 40 entries within 6,000 bytes, with more and the hint", async () => {
  for (const count of [9, 41, 60, 500]) {
    const bodies = Array.from({ length: count }, (_, index) => listBody(index + 1, `${index}-${"n".repeat(5_000)}`));
    const { client, close } = await connect(open(bodies));
    const raw = text(await client.callTool({ name: "plasticity_describe_body", arguments: {} }));
    assert.ok(Buffer.byteLength(raw) <= 6_000, `${count} bodies: ${Buffer.byteLength(raw)} bytes`);
    const reply = JSON.parse(raw);
    assert.equal(reply.bodyCount, count);
    assert.ok(reply.bodies.length <= 40 && reply.bodies.length > 0, `${reply.bodies.length} entries`);
    assert.equal(reply.bodies.length + (reply.more ?? 0), count, "every body is shown or counted in more");
    assert.match(reply.hint, new RegExp(`${count} bodies; pass ids \\(1-8\\) to describe them`));
    for (const entry of reply.bodies) {
      assert.deepEqual(Object.keys(entry), ["id", "type", "name", "boundsMm"]);
      assert.ok(Array.from(entry.name as string).length <= 40);
      for (const value of [...entry.boundsMm.min, ...entry.boundsMm.max]) assert.ok(Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-6, `${value} has more than 3 decimals`);
    }
    assert.deepEqual(reply.bodies.slice(0, 3).map((entry: { id: number }) => entry.id), [1, 2, 3], "in body order");
    if (count > 40) assert.equal(reply.more > 0, true);
    if (count === 9) assert.equal("more" in reply, false, "nothing left out: no more field");
    await close();
  }
});

test("limit 3: listBodies drops entries until the list fits, and counts them", () => {
  const bodies = Array.from({ length: 100 }, (_, index) => listBody(index + 1, "n".repeat(300)));
  const reply = listBodies(bodies as never[], "r1", 8) as { bodies: unknown[]; more: number };
  assert.ok(size(reply) <= 6_000);
  assert.equal(reply.bodies.length + reply.more, 100);
  assert.equal(reply.bodies.length <= 40, true);
});

test("limits hold inside a lean batch: three describe steps of 8 heavy bodies, and the list form", async () => {
  const heavy = Array.from({ length: 8 }, (_, index) => heavyBody(index + 1));
  const first = await connect(open(heavy));
  const output = await runBatch(first.client, { detail: "lean", steps: [
    { toolName: "plasticity_describe_body", arguments: {} },
    { toolName: "plasticity_describe_body", arguments: { ids: [1, 2, 3, 4, 5, 6, 7, 8] } },
    { toolName: "plasticity_describe_body", arguments: { ids: [3, 4, 5, 6, 7, 8] } },
  ] });
  for (const step of output.steps) {
    assert.ok(size(step.result) <= 12_000, `step ${step.step}: ${size(step.result)} bytes`);
    assert.equal(step.result.truncated, undefined, "the batch does not cut it again");
    assert.ok(step.result.bodies.length >= 6);
  }
  assert.ok(size(output) < 12_000 * 3 + 2_000);
  await first.close();

  const many = await connect(open(Array.from({ length: 60 }, (_, index) => listBody(index + 1, "n".repeat(5_000)))));
  const listed = await runBatch(many.client, { detail: "lean", steps: [{ toolName: "plasticity_describe_body", arguments: {} }, { toolName: "plasticity_describe_body", arguments: {} }] });
  for (const step of listed.steps) {
    assert.ok(size(step.result) <= 6_000, `list step: ${size(step.result)} bytes`);
    assert.ok(step.result.bodies.length <= 40);
    assert.equal(step.result.more + step.result.bodies.length, 60);
  }
  await many.close();
});

test("the tool description states the three limits, the through proofs, and that walls and floors come from planes", async () => {
  const { client, close } = await connect(open([]));
  const description = (await client.listTools()).tools.find((tool) => tool.name === "plasticity_describe_body")!.description ?? "";
  assert.match(description, /one body at most 4,096 B/);
  assert.match(description, /ids or no id \(up to 8 bodies\) at most 12,000 B in all, each body getting an equal share/);
  assert.match(description, /list of more than 8 bodies at most 6,000 B/);
  assert.match(description, /first 40 bodies/);
  assert.match(description, /Read inner walls and floors from planes/);
  assert.match(description, /through true only when the bore reaches the body bounds at both ends, through false only when a flat disc face closes it at one end, otherwise no through field/);
  assert.doesNotMatch(description, /open-top cavity/);
  assert.doesNotMatch(description, /cavity floor and walls|cavity:/);
  await close();
});

// ---------- arcs by sweep ----------

test("a slot end is an arc of 180 degrees, and a rounded-rectangle corner an arc of 90, never a hole or a boss", () => {
  // Slot: one end of a 180-degree arc face in each of its two circle edges (top and bottom of the slot wall).
  const slot = bodyOf(1, [
    ...blockPlanes([], []),
    bore("slotEndA", [10, 15], 2, 0, 10, ["sa1", "sa2"]),
    bore("slotEndB", [30, 15], 2, 0, 10, ["sb1", "sb2"]),
  ], [ring("sa1", [10, 15], 10, 2, ["slotEndA"], 90, 270), ring("sa2", [10, 15], 0, 2, ["slotEndA"], 90, 270), ring("sb1", [30, 15], 10, 2, ["slotEndB"], -90, 90), ring("sb2", [30, 15], 0, 2, ["slotEndB"], -90, 90)]);
  const described = describeBody(slot as never, "r1");
  assert.deepEqual(described.cylinders.map((group) => [group.kind, group.sweepDeg, group.count]), [["arc", 180, 2]]);
  assert.equal("through" in described.cylinders[0]!, false);
  assert.equal(described.cylinders[0]!.axisPointsMm.length, 2, "their positions stay usable");

  // An imported plate whose four corners are quarter-circle faces (no blend radius): four arcs, no boss.
  const corners: Array<[number, number, number]> = [[3, 3, 180], [37, 3, 270], [37, 27, 0], [3, 27, 90]];
  const plate = bodyOf(2, [
    ...blockPlanes([], []),
    ...corners.map(([x, y], index) => bore(`corner${index}`, [x, y], 3, 0, 10, [`k${index}a`, `k${index}b`], true)),
  ], corners.flatMap(([x, y, from], index) => [ring(`k${index}a`, [x, y], 10, 3, [`corner${index}`], from, from + 90), ring(`k${index}b`, [x, y], 0, 3, [`corner${index}`], from, from + 90)]));
  const rounded = describeBody(plate as never, "r1");
  assert.deepEqual(rounded.cylinders.map((group) => [group.kind, group.sweepDeg, group.count]), [["arc", 90, 4]]);
});

test("a face is a full turn when the circle edges of one end sweep 360: one closed circle, or seam-split halves", () => {
  const closedFace = bore("closed", [10, 10], 2, 0, 10, ["c1", "c2"], true);
  const splitFace = bore("split", [30, 10], 2, 0, 10, ["s1", "s2", "s3", "s4"], true);
  const edges = [
    ring("c1", [10, 10], 10, 2, ["closed"]), ring("c2", [10, 10], 0, 2, ["closed"]),
    ring("s1", [30, 10], 10, 2, ["split"], 0, 180), ring("s2", [30, 10], 10, 2, ["split"], 180, 360), ring("s3", [30, 10], 0, 2, ["split"], 0, 180), ring("s4", [30, 10], 0, 2, ["split"], 180, 360),
  ];
  const described = describeBody(bodyOf(1, [...blockPlanes([], []), closedFace, splitFace], edges) as never, "r1");
  assert.deepEqual(described.cylinders.map((group) => [group.kind, group.count]), [["boss", 2]]);
  // Two half circles at each end are 180 + 180; two quarter circles at one end are 180 and make an arc.
  const quarters = bodyOf(2, [...blockPlanes([], []), bore("q", [10, 10], 2, 0, 10, ["q1", "q2", "q3", "q4"], true)], [
    ring("q1", [10, 10], 10, 2, ["q"], 0, 90), ring("q2", [10, 10], 10, 2, ["q"], 90, 180), ring("q3", [10, 10], 0, 2, ["q"], 0, 90), ring("q4", [10, 10], 0, 2, ["q"], 90, 180)]);
  assert.deepEqual(describeBody(quarters as never, "r1").cylinders.map((group) => [group.kind, group.sweepDeg]), [["arc", 180]]);
});

// ---------- lean status says what it leaves out ----------

test("the lean plasticity_status step names the keys it leaves out, and a return list fetches them", async () => {
  const bodies = Array.from({ length: 30 }, (_, index) => ({ ...bodyOf(index + 1, blockPlanes([], []), []), name: `part-${index + 1}` }));
  const { client, close } = await connect(open(bodies));
  const output = await runBatch(client, { detail: "lean", steps: [{ toolName: "plasticity_status", arguments: { bodyLimit: 50 } }] });
  const status = output.steps[0].result;
  assert.ok(Array.isArray(status.omitted), "omitted is a list");
  for (const key of ["regions", "construction", "documentToken"]) assert.ok(status.omitted.includes(key), `omitted names ${key}`);
  for (const key of status.omitted) assert.equal(key in status, false, `${key} is really absent`);
  for (const key of ["revision", "undoDepth", "bodies", "bodyPagination"]) assert.equal(status.omitted.includes(key), false, `${key} is shown or reported as bodyCount`);
  assert.equal(status.bodyCount, 30);
  const fetched = await runBatch(client, { detail: "lean", steps: [{ toolName: "plasticity_status", arguments: {}, return: ["documentToken", "regions"] }] });
  assert.deepEqual(fetched.steps[0].result, { documentToken: "doc-1", regions: [] });
  await close();
});

// ---------- keepProfile: false warns instead of failing a finished part ----------

function recipeBody(id: number, type: string, bounds = box([0, 0, 0], [1, 1, 1])) {
  return { id, versionId: id * 10, type, name: null, boundsMm: bounds, faceIds: [], edgeIds: [], faces: [], edges: [] };
}
function recipeScene(revision: string, bodies: unknown[], regions: unknown[] = []): RuntimeState {
  return {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision, dbVersion: 1, undoDepth: 0, redoDepth: 0, regions,
    construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" }, bodies,
  } as unknown as RuntimeState;
}
// remove behaviours: "fails" throws before anything changes; "failsAfterMoving" throws after the document moved on without deleting;
// "keeps" returns a state that still holds the Wire.
function recipeFake(remove: "works" | "fails" | "failsAfterMoving" | "keeps" | "unreadable") {
  const calls: string[] = [];
  let state = recipeScene("r1", [recipeBody(7, "Solid")]);
  let version = 1;
  let nextId = 8;
  let readable = true;
  const commit = (bodies: unknown[], regions: unknown[] = []) => { version += 1; state = recipeScene(`r${version}`, bodies, regions); return state; };
  const operations = {
    async state() { if (!readable) throw new Error("connection closed"); return state; },
    async createPolyline() {
      calls.push("createPolyline");
      const id = nextId++;
      return commit([...state.bodies, recipeBody(id, "Wire")], [{ id: `region-${id}`, entityId: 1, islandVersionId: 1, sketchId: 1, sketchWireIds: [id], measurementSource: "render-mesh", displayBoundsMm: box([0, 0, 0], [1, 1, 0]) }]);
    },
    async extrudeRegions() { calls.push("extrudeRegions"); return commit([...state.bodies, recipeBody(nextId++, "Solid", box([10, 9, 3.5], [30, 13, 14]))], state.regions as unknown[]); },
    async boolean(_targetIds: number[], toolIds: number[]) { calls.push("boolean"); return commit(state.bodies.filter((candidate) => !toolIds.includes(candidate.id))); },
    async remove(ids: number[]) {
      calls.push("remove");
      if (remove === "fails") throw new Error("native delete refused");
      if (remove === "unreadable") { readable = false; throw new Error("socket closed"); }
      if (remove === "failsAfterMoving") { commit(state.bodies); throw new Error("delete timed out after the commit"); }
      if (remove === "keeps") return commit(state.bodies);
      return commit(state.bodies.filter((candidate) => !ids.includes(candidate.id)));
    },
  } as unknown as RecipeOperations;
  return { operations, calls, current: () => state };
}
const RIB_POINTS: Vec[] = [[10, 9, 3.5], [30, 9, 3.5], [10, 9, 14]];
const ribInput = (extra: Record<string, unknown> = {}) => ({ targetId: 7, profilePointsMm: RIB_POINTS, thicknessMm: 4, revision: "r1", ...extra });

test("keepProfile false: a failed delete after the rib is complete reports completed with a warning, not a failure", async () => {
  const failed = recipeFake("fails");
  const result = await new PlasticityRecipes(failed.operations).createRib(ribInput({ keepProfile: false }));
  assert.equal(result.status, "completed");
  assert.equal(result.warning, "construction wire not removed: native delete refused");
  assert.equal("profileDeleted" in result, false);
  assert.equal(result.undoSteps, 3, "only the three confirmed steps");
  assert.deepEqual(result.steps.map((entry) => entry.operation), ["create-rib-profile", "extrude-rib", "union-rib-to-target"]);
  assert.equal(result.afterRevision, failed.current().revision);
  assert.deepEqual(failed.current().bodies.map((candidate) => candidate.id), [7, 8], "the Wire is still there, and the reply does not claim otherwise");

  const moved = recipeFake("failsAfterMoving");
  const movedResult = await new PlasticityRecipes(moved.operations).createRib(ribInput({ keepProfile: false }));
  assert.equal(movedResult.status, "completed");
  assert.match(movedResult.warning ?? "", /^construction wire not removed: delete timed out after the commit/);
  assert.equal(movedResult.undoSteps, 4, "the document moved, so that step is counted");
  assert.equal(movedResult.afterRevision, moved.current().revision);

  const kept = recipeFake("keeps");
  const keptResult = await new PlasticityRecipes(kept.operations).createRib(ribInput({ keepProfile: false }));
  assert.match(keptResult.warning ?? "", /construction wire not removed: 8 still present/);
  assert.equal("profileDeleted" in keptResult, false);

  const unreadable = recipeFake("unreadable");
  const unreadableResult = await new PlasticityRecipes(unreadable.operations).createRib(ribInput({ keepProfile: false }));
  assert.match(unreadableResult.warning ?? "", /construction wire not removed: socket closed; the state could not be read again, so check it/);
  assert.equal(unreadableResult.undoSteps, 3);

  const fine = recipeFake("works");
  const fineResult = await new PlasticityRecipes(fine.operations).createRib(ribInput({ keepProfile: false }));
  assert.equal(fineResult.profileDeleted, true);
  assert.equal("warning" in fineResult, false);
  assert.equal(fineResult.undoSteps, 4);
});

test("a rib warning is shown in a lean batch, and the tool descriptions say the delete clears the selection", async () => {
  const fake = recipeFake("fails");
  const session = {
    async windows() { return []; }, async connect() { return fake.operations.state(); }, get() { return fake.operations as unknown as PlasticityOperations; },
    capabilities() { return { bindings: [], operations: { constructionPlanes: { available: false, reason: "test" }, activeWorkplane: { available: false, reason: "test" } } }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const { client, close } = await connect(session);
  const output = await runBatch(client, { detail: "lean", steps: [{ toolName: "plasticity_create_rib", arguments: { targetId: 7, profilePointsMm: RIB_POINTS, thicknessMm: 4, keepProfile: false } }] });
  assert.equal(output.steps[0].result.status, "completed");
  assert.equal(output.steps[0].result.warning, "construction wire not removed: native delete refused");
  const tools = (await client.listTools()).tools;
  assert.match(tools.find((tool) => tool.name === "plasticity_create_rib")!.description ?? "", /clears the current selection/);
  for (const name of ["plasticity_create_countersink", "plasticity_create_countersink_pattern"]) {
    const found = json(await client.callTool({ name: "plasticity_call", arguments: { toolName: "catalog", query: name, limit: 1 } }));
    assert.match(JSON.stringify(found), /clears the current selection/, name);
  }
  assert.match(tools.find((tool) => tool.name === "plasticity_create_rib")!.description ?? "", /positive or negative pick the side and ignore the sign of thickness/);
  await close();
});

test("tool descriptions: create_pipes says approximate, join_sheets says exact coincidence and a closed result becomes a Solid", async () => {
  const fake = open([heavyBody(1)], {});
  const { client, close } = await connect(fake);
  const described = async (name: string) => JSON.stringify(json(await client.callTool({ name: "plasticity_call", arguments: { toolName: "catalog", query: name, limit: 1 } })));
  assert.match(await described("plasticity_create_pipes"), /approximate, not dimensionally exact; use a sweep for exact pipes/);
  assert.match(await described("plasticity_join_sheets"), /edges must coincide exactly; a closed result becomes a Solid/);
  await close();
});

// ---------- roundMm: only real lengths ----------

test("roundMm treats a key ending in PerMm or PerMm2 as a rate and rounds every other length, areas included", async () => {
  const fake = open([heavyBody(1)], {
    async exportStep(...args: unknown[]) {
      return {
        path: args[1], bytes: 4321, shearAreaPerPlaneMm2: 1.23456789, curvaturePerMm: 0.123456789, tractionNPerMm2: 0.987654321, areaMm2: 2.3456789, lengthMm: 1.23456789,
        planes: { zPos: [{ mm: 1.987654, face: "f1" }] }, extentMm: [0.123456, 9.87654], axisPointsMm: [[1.23456, 2.34567, 3.45678]], radiusMm: 2.5001, ratio: 0.333333, normal: [0.267261, 0.534522, 0.801784],
      };
    },
  });
  const { client, close } = await connect(fake);
  const output = await runBatch(client, { roundMm: 2, steps: [{ toolName: "plasticity_export_step", arguments: { ids: [1], path: "/tmp/plate.step" } }] });
  const result = output.steps[0].result;
  assert.equal(result.shearAreaPerPlaneMm2, 1.23, "an area is a length measure: rounded");
  assert.equal(result.curvaturePerMm, 0.123456789, "a rate keeps its precision");
  assert.equal(result.tractionNPerMm2, 0.987654321);
  assert.equal(result.areaMm2, 2.35);
  assert.equal(result.lengthMm, 1.23);
  assert.equal(result.planes.zPos[0].mm, 1.99, "a describe plane offset is a length");
  assert.deepEqual(result.extentMm, [0.12, 9.88]);
  assert.deepEqual(result.axisPointsMm, [[1.23, 2.35, 3.46]]);
  assert.equal(result.radiusMm, 2.5);
  assert.equal(result.ratio, 0.333333);
  assert.deepEqual(result.normal, [0.267261, 0.534522, 0.801784]);
  await close();
});

test("roundMm smaller than 4 applies to a describe_body step: plane offsets, extents and axis points", async () => {
  const faces = [...blockPlanes(["ct"], ["cb"]), bore("bore", [20.123456, 15.654321], 2, 0, 10, ["ct", "cb"]), plane("shelf", [20, 15, 4.987654], [0, 0, 1], 3, ["x"])];
  const edges = [ring("ct", [20.123456, 15.654321], 10, 2, ["bore", "top"]), ring("cb", [20.123456, 15.654321], 0, 2, ["bore", "bottom"])];
  const { client, close } = await connect(open([bodyOf(1, faces, edges)]));
  const output = await runBatch(client, { roundMm: 2, steps: [{ toolName: "plasticity_describe_body", arguments: { id: 1 } }] });
  const described = output.steps[0].result;
  assert.deepEqual(described.planes.zPos.map((entry: { mm: number }) => entry.mm), [4.99, 10]);
  assert.deepEqual(described.cylinders[0].axisPointsMm, [[20.12, 15.65, 5]]);
  assert.equal(described.cylinders[0].through, true);
  await close();
});
