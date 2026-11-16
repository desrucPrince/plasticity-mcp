import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createCompactServer, type SessionLike } from "./server.ts";
import type { PlasticityOperations } from "./plasticity/operations.ts";
import type { RuntimeState } from "./plasticity/runtime.ts";
import { describeBody } from "./plasticity/semantic.ts";

// Speed tier 1c: plasticity_describe_body, find replies that cannot overflow, body_info size guard.

type Vec = [number, number, number];
const box = (min: Vec, max: Vec) => ({ min, max });
type Face = RuntimeState["bodies"][number]["faces"][number];

function plane(id: string, center: Vec, normal: Vec, half = 5, extra: Partial<Face> = {}): Face {
  return {
    id, surfaceType: "Plane", planar: true, centerMm: center, normal, radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null,
    boundsMm: box([center[0] - half * Math.abs(1 - Math.abs(normal[0])), center[1] - half * Math.abs(1 - Math.abs(normal[1])), center[2] - half * Math.abs(1 - Math.abs(normal[2]))],
      [center[0] + half * Math.abs(1 - Math.abs(normal[0])), center[1] + half * Math.abs(1 - Math.abs(normal[1])), center[2] + half * Math.abs(1 - Math.abs(normal[2]))]),
    edgeIds: ["e1"], ...extra,
  } as Face;
}
// A cylinder face. `outward` true: the normal points away from the axis (a boss or outer wall); false: toward it (a hole).
function cylinder(id: string, axisPoint: Vec, radius: number, outward: boolean, axis: Vec = [0, 0, 1], extra: Partial<Face> = {}): Face {
  const radial: Vec = axis[2] !== 0 ? [1, 0, 0] : [0, 0, 1];
  const center: Vec = [axisPoint[0] + radial[0] * radius, axisPoint[1] + radial[1] * radius, axisPoint[2] + radial[2] * radius];
  const sign = outward ? 1 : -1;
  return {
    id, surfaceType: "Cylinder", planar: false, centerMm: center, normal: [radial[0] * sign, radial[1] * sign, radial[2] * sign], radiusMm: radius, blendRadiusMm: null,
    axisOriginMm: [axisPoint[0] - axis[0] * 3, axisPoint[1] - axis[1] * 3, axisPoint[2] - axis[2] * 3], axisDirection: axis,
    boundsMm: box([center[0] - radius, center[1] - radius, center[2] - 1], [center[0] + radius, center[1] + radius, center[2] + 1]), edgeIds: ["e1", "e2"], ...extra,
  } as Face;
}
function bodyOf(id: number, faces: Face[], bounds = box([0, 0, 0], [40, 30, 10]), name: string | null = "part") {
  return {
    id, versionId: id * 10, type: "Solid", name, boundsMm: bounds, faceIds: faces.map((face) => face.id), edgeIds: ["e1", "e2", "e3"], faces,
    edges: [
      { id: "e1", curveType: "Line", line: true, circle: false, lengthMm: 10, centerMm: [0, 0, 0], tangent: [1, 0, 0], boundsMm: bounds, faceIds: ["f1"], vertexIds: [1, 2] },
      { id: "e2", curveType: "Line", line: true, circle: false, lengthMm: 10, centerMm: [1, 0, 0], tangent: [1, 0, 0], boundsMm: bounds, faceIds: ["f1"], vertexIds: [2, 3] },
      { id: "e3", curveType: "Line", line: true, circle: false, lengthMm: 10, centerMm: [2, 0, 0], tangent: [1, 0, 0], boundsMm: bounds, faceIds: ["f1"], vertexIds: [3, 4] },
    ],
  };
}
const stateOf = (bodies: unknown[]): RuntimeState => ({
  targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [],
  construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" }, bodies,
}) as unknown as RuntimeState;

async function open(state: RuntimeState) {
  let reads = 0;
  const operations = { async state() { reads += 1; return state; } } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: { constructionPlanes: { available: false, reason: "test" }, activeWorkplane: { available: false, reason: "test" } } }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createCompactServer(fake, undefined, undefined, undefined, null);
  const client = new Client({ name: "speed-tier-1c-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  return { client, reads: () => reads, close: async () => { await client.close(); await server.close(); } };
}
const text = (response: unknown): string => (response as { content: Array<{ type: string; text?: string }> }).content.find((entry) => entry.type === "text")!.text!;
const json = (response: unknown): any => JSON.parse(text(response));
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const planeList = (description: ReturnType<typeof describeBody>, direction: string) => description.planes[direction] as Array<{ normal?: number[]; mm: number; count?: number; face: string }>;

// ---------- describe_body ----------

function boxWithHoles() {
  return bodyOf(1, [
    plane("top", [20, 15, 10], [0, 0, 1], 15), plane("bottom", [20, 15, 0], [0, 0, -1], 15), plane("right", [40, 15, 5], [1, 0, 0]), plane("left", [0, 15, 5], [-1, 0, 0]),
    plane("front", [20, 0, 5], [0, -1, 0]), plane("back", [20, 30, 5], [0, 1, 0]),
    cylinder("h1", [7.5, 7.5, 5], 2.25, false), cylinder("h2", [32.5, 7.5, 5], 2.25, false),
    // The same hole split in two faces shows up once as an axis.
    cylinder("h2b", [32.5, 7.5, 5], 2.25, false),
  ]);
}

test("describe_body groups planes by outward normal and lists holes with their axes", () => {
  const description = describeBody(boxWithHoles() as never, "r7");
  assert.equal(description.id, 1);
  assert.equal(description.revision, "r7");
  assert.deepEqual(description.sizeMm, [40, 30, 10]);
  assert.equal(description.faceCount, 9);
  assert.equal(description.edgeCount, 3);
  assert.equal(description.vertexCount, 4);
  assert.deepEqual(planeList(description, "zPos"), [{ mm: 10, face: "top" }]);
  assert.deepEqual(planeList(description, "zNeg"), [{ mm: 0, face: "bottom" }]);
  assert.deepEqual(planeList(description, "xPos"), [{ mm: 40, face: "right" }]);
  assert.deepEqual(planeList(description, "xNeg"), [{ mm: 0, face: "left" }], "a -x plane is placed by its x coordinate");
  assert.deepEqual(description.cylinders, [{ radiusMm: 2.25, axis: "z", kind: "hole", count: 2, faces: 3, axisPointsMm: [[7.5, 7.5, 5], [32.5, 7.5, 5]] }]);
  assert.deepEqual(description.otherSurfaces, {});
  assert.deepEqual(description.blendRadii, {});
});

test("describe_body tells bosses (convex) from holes (concave) and keeps them in separate groups", () => {
  const faces = [
    plane("floor", [20, 15, 2], [0, 0, 1], 15), plane("outer", [20, 15, 0], [0, 0, -1], 15),
    cylinder("b1", [5, 5, 3], 3, true), cylinder("b2", [35, 5, 3], 3, true),
    cylinder("p1", [5, 5, 6], 3, false), // same radius and axis direction, concave
    cylinder("side", [10, 10, 4], 1.5, true, [1, 0, 0]),
  ];
  const description = describeBody(bodyOf(2, faces) as never, "r1");
  const kinds = description.cylinders.map((group) => `${group.radiusMm}:${group.axis}:${group.kind}:${group.count}`);
  assert.deepEqual(kinds, ["1.5:x:boss:1", "3:z:boss:2", "3:z:hole:1"]);
  const x = description.cylinders.find((group) => group.axis === "x")!;
  assert.deepEqual(x.axisPointsMm, [[10, 10, 4]], "the axis point lies on the axis at the face centre");
});

test("describe_body omits kind when the normal does not say which way the surface faces", () => {
  const sideways = cylinder("c", [5, 5, 3], 3, true, [0, 0, 1], { normal: [0, 0, 1] });
  const description = describeBody(bodyOf(3, [sideways]) as never, "r1");
  assert.equal("kind" in description.cylinders[0]!, false);
});

test("describe_body reports blend radii apart from the cylinders, and other surfaces with cone half-angles", () => {
  const blend = (id: string, radius: number) => cylinder(id, [1, 1, 1], radius, true, [0, 1, 0], { blendRadiusMm: radius });
  const faces = [
    plane("t", [0, 0, 10], [0, 0, 1]), blend("b1", 5), blend("b2", 5), blend("b3", 3),
    cylinder("hole", [7, 7, 5], 2.25, false),
    { ...plane("cone", [0, 0, 0], [0, 0, 1]), surfaceType: "Cone", planar: false, coneSemiAngleRad: Math.PI / 4 },
    { ...plane("cone2", [0, 0, 0], [0, 0, 1]), surfaceType: "Cone", planar: false, coneSemiAngleRad: Math.PI / 4 },
    { ...plane("sphere", [0, 0, 0], [0, 0, 1]), surfaceType: "Sphere", planar: false },
    { ...plane("torus", [0, 0, 0], [0, 0, 1]), surfaceType: "Torus", planar: false },
  ] as Face[];
  const description = describeBody(bodyOf(4, faces) as never, "r1");
  assert.deepEqual(description.blendRadii, { "3": 1, "5": 2 });
  assert.deepEqual(description.cylinders.map((group) => group.radiusMm), [2.25], "blend faces are not listed as cylinders");
  assert.deepEqual(description.otherSurfaces, { Cone: { count: 2, halfAngleDeg: [45] }, Sphere: { count: 1 }, Torus: { count: 1 } });
});

test("describe_body names slanted planes by their normal and rounds to 4 decimals", () => {
  const slanted: Vec = [0.6, 0, 0.8];
  const description = describeBody(bodyOf(5, [plane("s", [1.123456789, 2, 3.987654321], slanted)], box([0, 0, 0], [1.123456789, 2, 3.987654321])) as never, "r1");
  assert.deepEqual(Object.keys(description.planes), ["slanted"]);
  assert.deepEqual(planeList(description, "slanted")[0], { normal: [0.6, 0, 0.8], mm: 3.8642, face: "s" });
  assert.deepEqual(description.sizeMm, [1.1235, 2, 3.9877]);
});

test("describe_body picks the largest face at a repeated plane offset", () => {
  const faces = [plane("small", [5, 5, 10], [0, 0, 1], 1), plane("big", [20, 15, 10], [0, 0, 1], 12), plane("mid", [30, 5, 10], [0, 0, 1], 4)];
  const description = describeBody(bodyOf(6, faces) as never, "r1");
  assert.deepEqual(planeList(description, "zPos"), [{ mm: 10, count: 3, face: "big" }]);
});

test("describe_body caps 12 offsets per direction and 16 axis points per group with a more count", () => {
  const faces: Face[] = [];
  for (let index = 0; index < 15; index += 1) faces.push(plane(`z${index}`, [5, 5, index * 2], [0, 0, 1]));
  for (let index = 0; index < 20; index += 1) faces.push(cylinder(`h${index}`, [index * 3, 0, 5], 1, false));
  const description = describeBody(bodyOf(7, faces) as never, "r1");
  assert.equal(planeList(description, "zPos").length, 12);
  assert.deepEqual(description.planes.more, { zPos: 3 });
  assert.deepEqual(planeList(description, "zPos").map((offset) => offset.mm).slice(0, 3), [0, 2, 4], "ascending by offset");
  assert.equal(description.cylinders[0]!.axisPointsMm.length, 16);
  assert.equal(description.cylinders[0]!.more, 4);
  assert.equal(description.cylinders[0]!.count, 20, "count keeps the true number of faces");
});

test("describe_body stays under 4 KB for a busy body and keeps the more counts true", () => {
  const faces: Face[] = [];
  const normals: Vec[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  normals.forEach((normal, direction) => {
    for (let index = 0; index < 12; index += 1) faces.push(plane(`p${direction}-${index}`, [index * 1.123456, index * 2.5 + direction, index * 3.75], normal));
  });
  for (let radius = 1; radius <= 10; radius += 1) {
    for (let index = 0; index < 16; index += 1) faces.push(cylinder(`c${radius}-${index}`, [index * 7.123456, radius * 11.654321, 5], radius, index % 2 === 0));
  }
  const full = describeBody(bodyOf(8, faces) as never, "r1");
  assert.ok(size(full) <= 4096, `size ${size(full)}`);
  const planeFaces = Object.entries(full.planes).filter(([key]) => key !== "more").reduce((sum, [key]) => sum + planeList(full, key).length + (full.planes.more?.[key] ?? 0), 0);
  assert.equal(planeFaces, 72, "kept offsets plus more equals the distinct offsets");
  for (const group of full.cylinders) assert.ok(group.axisPointsMm.length + (group.more ?? 0) >= 1);
  assert.equal(full.faceCount, faces.length);
});

test("describe_body is small for ordinary parts", () => {
  assert.ok(size(describeBody(boxWithHoles() as never, "r1")) < 1_500);
});

test("describe_body is strict, read-only, in the compact list once, and reachable through plasticity_call", async () => {
  const { client, close } = await open(stateOf([boxWithHoles()]));
  const tools = (await client.listTools()).tools.filter((tool) => tool.name === "plasticity_describe_body");
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.annotations?.readOnlyHint, true);
  assert.equal((tools[0]!.inputSchema as { additionalProperties?: unknown }).additionalProperties, false);
  assert.match(tools[0]!.description ?? "", /plasticity_body_info/);

  const direct = json(await client.callTool({ name: "plasticity_describe_body", arguments: { id: 1 } }));
  assert.equal(direct.id, 1);
  assert.equal(direct.revision, "r1");
  const routed = json(await client.callTool({ name: "plasticity_call", arguments: { toolName: "plasticity_describe_body", arguments: { id: 1 } } }));
  assert.deepEqual(routed, direct);

  for (const bad of [{ id: 0 }, { id: 1.5 }, { id: 1, extra: true }, { id: "1" }]) { // {} is valid since tier 1d: it describes every body
    const response = await client.callTool({ name: "plasticity_describe_body", arguments: bad });
    assert.equal(response.isError, true, JSON.stringify(bad));
  }
  const unknown = await client.callTool({ name: "plasticity_describe_body", arguments: { id: 99 } });
  assert.equal(unknown.isError, true);
  assert.match(text(unknown), /Unknown body ID: 99/);
  await close();
});

test("describe_body works as a batch read step, with return paths on plain keys", async () => {
  const { client, close } = await open(stateOf([boxWithHoles()]));
  const response = json(await client.callTool({ name: "plasticity_batch", arguments: { steps: [
    { toolName: "plasticity_describe_body", arguments: { id: 1 }, return: ["cylinders", "planes.zNeg", "planes.zPos[0].mm", "sizeMm"] },
  ] } }));
  const result = response.steps[0].result;
  assert.equal(result.cylinders[0].kind, "hole");
  assert.equal(result["planes.zNeg"][0].face, "bottom");
  assert.equal(result["planes.zPos[0].mm"], 10);
  assert.deepEqual(result.sizeMm, [40, 30, 10]);

  const plain = json(await client.callTool({ name: "plasticity_batch", arguments: { detail: "lean", steps: [{ toolName: "plasticity_describe_body", arguments: { id: 1 } }] } }));
  assert.equal(plain.steps[0].result.id, 1, "a reply of 1.5 KB or less comes back whole");
  await close();
});

// ---------- find replies ----------

function manyFaces(count: number) {
  const faces = Array.from({ length: count }, (_, index) => ({ ...plane(`f${index}`, [index, 0, 0], [0, 0, 1], 1), edgeIds: ["e1", "e2", "e3", "e4"] }));
  return bodyOf(1, faces);
}
function manyEdges(count: number) {
  const body = bodyOf(1, [plane("f1", [0, 0, 0], [0, 0, 1])]);
  body.edges = Array.from({ length: count }, (_, index) => ({ id: `e${index}`, curveType: "Line", line: true, circle: false, lengthMm: index + 1, centerMm: [index, 0, 0], tangent: [1, 0, 0], boundsMm: box([index, 0, 0], [index + 1, 0, 0]), faceIds: ["f1"], vertexIds: [] }));
  return body;
}

test("a direct find_faces reply over 8,000 bytes keeps the matches that fit, with count, truncated and hint", async () => {
  const { client, close } = await open(stateOf([manyFaces(200)]));
  const reply = json(await client.callTool({ name: "plasticity_find_faces", arguments: { revision: "r1", query: { bodyIds: [1] } } }));
  assert.equal(reply.count, 200);
  assert.equal(reply.truncated, true);
  assert.equal(reply.hint, "add limit/sortBy or narrow the query");
  assert.ok(reply.matches.length > 0 && reply.matches.length < 200);
  assert.deepEqual(reply.matches.map((match: { id: string }) => match.id), Array.from({ length: reply.matches.length }, (_, index) => `f${index}`), "existing order, from the start");
  assert.ok(size(reply) <= 8_000, `size ${size(reply)}`);
  // One more match would not have fit.
  const more = { ...reply, matches: [...reply.matches, { ...reply.matches[0], id: `f${reply.matches.length}` }] };
  assert.ok(size(more) > 8_000);
  await close();
});

test("a direct find_edges reply over 8,000 bytes is cut the same way, and a reply at or under 8,000 bytes is untouched", async () => {
  const { client, close } = await open(stateOf([manyEdges(150)]));
  const reply = json(await client.callTool({ name: "plasticity_find_edges", arguments: { revision: "r1", query: { bodyIds: [1] } } }));
  assert.equal(reply.count, 150);
  assert.equal(reply.truncated, true);
  assert.ok(size(reply) <= 8_000);

  const small = await client.callTool({ name: "plasticity_find_edges", arguments: { revision: "r1", query: { bodyIds: [1], lengthMm: { value: 3, tolerance: 0.1 } } } });
  const body = json(small);
  assert.deepEqual(Object.keys(body), ["documentToken", "revision", "measurementSource", "count", "matches"], "no new keys below the cap");
  assert.equal(text(small), JSON.stringify({ documentToken: "doc-1", revision: "r1", measurementSource: "native-brep", count: 1, matches: body.matches }));
  await close();
});

test("a reply just under the cap is byte-identical to the uncut reply", async () => {
  // Bodies of 1..60 faces, one server: the largest full reply that still fits under 8,000 bytes.
  const bodies = Array.from({ length: 60 }, (_, index) => ({ ...manyFaces(index + 1), id: index + 1 }));
  const { client, close } = await open(stateOf(bodies));
  let best: { faces: number; reply: string } | undefined;
  for (const body of bodies) {
    const response = await client.callTool({ name: "plasticity_find_faces", arguments: { revision: "r1", query: { bodyIds: [body.id] } } });
    const reply = text(response);
    if (JSON.parse(reply).truncated === true) break;
    best = { faces: body.id, reply };
  }
  assert.ok(best && Buffer.byteLength(best.reply) <= 8_000 && Buffer.byteLength(best.reply) > 7_000, `bytes ${best && Buffer.byteLength(best.reply)}`);
  const parsed = JSON.parse(best.reply);
  assert.equal(parsed.matches.length, best.faces);
  assert.equal(best.reply, JSON.stringify({ documentToken: "doc-1", revision: "r1", measurementSource: "native-brep", count: best.faces, matches: parsed.matches }));
  await close();
});

test("an explicit limit is honoured above 8 KB, and a batch find step is never cut", async () => {
  const { client, close } = await open(stateOf([manyFaces(200)]));
  const limited = json(await client.callTool({ name: "plasticity_find_faces", arguments: { revision: "r1", query: { bodyIds: [1] }, limit: 150 } }));
  assert.equal(limited.matches.length, 150);
  assert.equal("truncated" in limited, false);
  assert.ok(size(limited) > 8_000);

  const batch = json(await client.callTool({ name: "plasticity_batch", arguments: { steps: [
    { toolName: "plasticity_find_faces", arguments: { query: { bodyIds: [1] } }, return: ["count", "matches[*].id"] },
  ] } }));
  assert.equal(batch.steps[0].result.count, 200);
  assert.equal(batch.steps[0].result["matches[*].id"].length, 200, "the batch reads every match");

  const viaCall = json(await client.callTool({ name: "plasticity_call", arguments: { toolName: "plasticity_find_faces", arguments: { revision: "r1", query: { bodyIds: [1] } } } }));
  assert.equal(viaCall.truncated, true, "a direct call through plasticity_call is a direct call");
  await close();
});

// ---------- body_info ----------

test("body_info keeps today's reply by default and adds only a hint above 20,000 bytes", async () => {
  const small = boxWithHoles();
  const big = manyFaces(130);
  big.edges = manyEdges(100).edges;
  const { client, close } = await open(stateOf([small, { ...big, id: 2 }]));
  const smallReply = await client.callTool({ name: "plasticity_body_info", arguments: { id: 1 } });
  assert.equal(text(smallReply), JSON.stringify({ documentToken: "doc-1", revision: "r1", measurementSource: "native-brep", body: small }));

  const bigReply = json(await client.callTool({ name: "plasticity_body_info", arguments: { id: 2 } }));
  assert.ok(size({ ...bigReply, hint: undefined }) > 20_000);
  assert.equal(bigReply.hint, "large reply; use plasticity_describe_body, or pass edges:false/vertices:false");
  assert.deepEqual(bigReply.body, JSON.parse(JSON.stringify({ ...big, id: 2 })), "nothing is dropped by default");
  assert.deepEqual(Object.keys(bigReply), ["documentToken", "revision", "measurementSource", "body", "hint"]);
  await close();
});

test("body_info flags take lists out of the reply, and an explicit flag suppresses the hint", async () => {
  const big = { ...manyFaces(130), id: 2 };
  big.edges = manyEdges(100).edges;
  (big as { vertices?: unknown }).vertices = [{ id: 1, positionMm: [0, 0, 0], edgeIds: ["e1"], faceIds: ["f1"] }];
  const { client, close } = await open(stateOf([big]));
  const call = async (args: Record<string, unknown>) => json(await client.callTool({ name: "plasticity_body_info", arguments: { id: 2, ...args } }));

  const noEdges = await call({ edges: false });
  assert.equal("edges" in noEdges.body, false);
  assert.equal(noEdges.body.faces.length, 130);
  assert.equal(noEdges.body.vertices.length, 1);
  assert.equal(noEdges.body.edgeIds.length, 3, "edge ids stay");
  assert.equal("hint" in noEdges, false);

  const noFaces = await call({ faces: false, vertices: false });
  assert.equal("faces" in noFaces.body, false);
  assert.equal("vertices" in noFaces.body, false);
  assert.equal(noFaces.body.edges.length, 100);
  assert.equal("hint" in noFaces, false);

  const everything = await call({ faces: true, edges: true, vertices: true });
  assert.equal(everything.body.faces.length, 130);
  assert.equal(everything.body.edges.length, 100);
  assert.equal("hint" in everything, false, "explicit flags, even true, mean the caller chose");
  await close();
});
