import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { PLASTICITY_MCP_INSTRUCTIONS } from "./server-instructions.ts";
import { createCompactServer, type SessionLike } from "./server.ts";
import type { PlasticityOperations } from "./plasticity/operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./plasticity/runtime.ts";
import { checkBodyInterference } from "./plasticity/interference.ts";
import { measureSolidProperties } from "./plasticity/solid-properties.ts";
import { describeBody } from "./plasticity/semantic.ts";

// Tier 1 polish: a really hard describe_body cap, part-turn cylinders, count as features, robust grouping,
// describe_body in a batch without return, roundMm on real lengths only, and returnErrors.

type Vec = [number, number, number];
type Face = RuntimeState["bodies"][number]["faces"][number];
type Edge = RuntimeState["bodies"][number]["edges"][number];
const box = (min: Vec, max: Vec) => ({ min, max });
const text = (response: unknown): string => (response as { content: Array<{ type: string; text?: string }> }).content.find((entry) => entry.type === "text")!.text!;
const json = (response: unknown): any => JSON.parse(text(response));
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function plane(id: string, center: Vec, normal: Vec, half = 5, extra: Partial<Face> = {}): Face {
  return {
    id, surfaceType: "Plane", planar: true, centerMm: center, normal, radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null,
    boundsMm: box([center[0] - half * Math.abs(1 - Math.abs(normal[0])), center[1] - half * Math.abs(1 - Math.abs(normal[1])), center[2] - half * Math.abs(1 - Math.abs(normal[2]))],
      [center[0] + half * Math.abs(1 - Math.abs(normal[0])), center[1] + half * Math.abs(1 - Math.abs(normal[1])), center[2] + half * Math.abs(1 - Math.abs(normal[2]))]),
    edgeIds: ["e1"], ...extra,
  } as Face;
}
// A cylinder face. `outward` true: the normal points away from the axis (a boss); false: toward it (a hole).
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
const cone = (id: string, semiAngleRad: number): Face => ({ ...plane(id, [0, 0, 0], [0, 0, 1]), surfaceType: "Cone", planar: false, coneSemiAngleRad: semiAngleRad }) as Face;
function circle(id: string, center: Vec, faceIds: string[], geometry?: Edge["circleGeometry"]): Edge {
  return { id, curveType: "Circle", line: false, circle: true, lengthMm: 6.28, centerMm: center, tangent: [1, 0, 0], boundsMm: box(center, center), faceIds, vertexIds: [], ...(geometry ? { circleGeometry: geometry } : {}) } as Edge;
}
function line(id: string): Edge {
  return { id, curveType: "Line", line: true, circle: false, lengthMm: 10, centerMm: [0, 0, 0], tangent: [1, 0, 0], boundsMm: box([0, 0, 0], [0, 0, 0]), faceIds: ["f1"], vertexIds: [] } as Edge;
}
function bodyOf(id: number, faces: Face[], edges: Edge[] = [line("e1"), line("e2")], name: string | null = "part", bounds = box([0, 0, 0], [40, 30, 10])) {
  return { id, versionId: id * 10, type: "Solid", name, boundsMm: bounds, faceIds: faces.map((face) => face.id), edgeIds: edges.map((edge) => edge.id), faces, edges };
}
const stateOf = (bodies: unknown[]): RuntimeState => ({
  targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [],
  construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" }, bodies,
}) as unknown as RuntimeState;

function open(initial: RuntimeState) {
  let state = initial;
  let version = 1;
  const operations = {
    async state() { return state; },
    async fillet() { version += 1; state = { ...state, revision: `r${version}`, undoDepth: state.undoDepth + 1 } as RuntimeState; return state; },
  } as unknown as PlasticityOperations;
  return {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: { constructionPlanes: { available: false, reason: "test" }, activeWorkplane: { available: false, reason: "test" } } }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
}
async function connect(fake: SessionLike) {
  const server = createCompactServer(fake, undefined, undefined, undefined, null);
  const client = new Client({ name: "tier-1-polish-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
async function runBatch(client: Client, args: Record<string, unknown>) {
  const response = await client.callTool({ name: "plasticity_batch", arguments: args });
  assert.equal(response.isError, undefined, JSON.stringify(response.content));
  return json(response);
}

// ---------- 1. the hard cap ----------

test("describe_body stays within 4,096 bytes for 700 distinct cone half-angles, and says how many it left out", () => {
  const faces: Face[] = [plane("top", [20, 15, 10], [0, 0, 1], 15)];
  for (let index = 0; index < 700; index += 1) faces.push(cone(`k${index}`, 0.01 + index * 0.001));
  const described = describeBody(bodyOf(1, faces) as never, "r1");
  assert.ok(size(described) <= 4_096, `size ${size(described)}`);
  assert.equal(described.otherSurfaces.Cone!.count, 700);
  assert.equal(described.otherSurfaces.Cone!.halfAngleDeg!.length, 8);
  assert.equal(described.otherSurfaces.Cone!.more, 692);
});

test("describe_body cuts a 5,000-character name to 120 characters and stays within 4,096 bytes", () => {
  const described = describeBody(bodyOf(2, [plane("top", [20, 15, 10], [0, 0, 1], 15)], undefined, "n".repeat(5_000)) as never, "r1");
  assert.equal(described.name, "n".repeat(120));
  assert.ok(size(described) <= 4_096, `size ${size(described)}`);
  const short = describeBody(bodyOf(3, [plane("top", [20, 15, 10], [0, 0, 1], 15)], undefined, "x".repeat(120)) as never, "r1");
  assert.equal(short.name, "x".repeat(120), "120 characters stay whole");
  assert.equal(describeBody(bodyOf(4, [plane("top", [20, 15, 10], [0, 0, 1], 15)], undefined, null) as never, "r1").name, null);
});

test("describe_body with 3,000 cylinder groups fits 4,096 bytes in under 100 ms and keeps the groups with the most faces", () => {
  const faces: Face[] = [plane("top", [20, 15, 10], [0, 0, 1], 15)];
  // Group i has radius 1 + i * 0.01; every 100th group is a heavy one with 3 faces on 3 different axes, the rest have 1 face.
  for (let group = 0; group < 3_000; group += 1) {
    const radius = 1 + group * 0.01;
    const copies = group % 100 === 99 ? 3 : 1;
    for (let copy = 0; copy < copies; copy += 1) faces.push(cylinder(`c${group}-${copy}`, [copy * 5, group, 5], radius, false));
  }
  const started = performance.now();
  const described = describeBody(bodyOf(5, faces) as never, "r1");
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 100, `${elapsed.toFixed(1)} ms`);
  assert.ok(size(described) <= 4_096, `size ${size(described)}`);
  assert.equal(described.cylinders.length + described.cylindersMore!, 3_000, "kept plus dropped is every group");
  assert.equal(described.truncated, true);
  const heavy = described.cylinders.filter((group) => group.count === 3).length;
  assert.equal(heavy, Math.min(30, described.cylinders.length), "all 30 heavy groups stay, ahead of the smaller radii");
  assert.ok(described.cylinders.some((group) => group.radiusMm > 20), "radii are not simply the smallest ones");
});

test("describe_body with many slanted planes and long lists everywhere still fits, with true more counts", () => {
  const faces: Face[] = [];
  for (let index = 0; index < 500; index += 1) {
    const angle = 0.1 + index * 0.0011;
    faces.push(plane(`s${index}`, [index, 2, 3], [Math.cos(angle) * 0.7, Math.sin(angle) * 0.7, 0.7071], 3));
  }
  for (let index = 0; index < 120; index += 1) faces.push({ ...cylinder(`b${index}`, [1, 1, 1], 1 + index * 0.01, true, [0, 1, 0]), blendRadiusMm: 1 + index * 0.01 } as Face);
  for (let index = 0; index < 700; index += 1) faces.push(cone(`k${index}`, 0.01 + index * 0.001));
  for (let index = 0; index < 60; index += 1) faces.push(cylinder(`h${index}`, [index * 4, 0, 5], 1 + index * 0.5, false));
  const described = describeBody(bodyOf(6, faces, undefined, "n".repeat(5_000)) as never, "r1");
  assert.ok(size(described) <= 4_096, `size ${size(described)}`);
  assert.equal(described.faceCount, faces.length);
  const slanted = described.planes.slanted as unknown[];
  assert.equal(slanted.length + (described.planes.more?.slanted ?? 0), 500, "kept slanted planes plus more is every plane");
  assert.equal(Object.keys(described.blendRadii).length + (described.blendRadiiMore ?? 0), 120);
});

test("describe_body leaves whole sections out as a last resort, each with its More count", () => {
  // 600 surface types cannot be cut by a list cap: the section itself goes, and says how many it held.
  const faces: Face[] = [plane("top", [20, 15, 10], [0, 0, 1], 15), cylinder("h", [5, 5, 5], 2, false)];
  for (let index = 0; index < 600; index += 1) faces.push({ ...plane(`o${index}`, [0, 0, 0], [0, 0, 1]), surfaceType: `Exotic${index}`, planar: false } as Face);
  const described = describeBody(bodyOf(7, faces, undefined, "n".repeat(300)) as never, "r1");
  assert.ok(size(described) <= 4_096, `size ${size(described)}`);
  assert.deepEqual(described.otherSurfaces, {});
  assert.equal(described.otherSurfacesMore, 600);
  assert.equal(described.truncated, true);
  assert.equal(described.cylinders.length, 1, "the cylinders section stays when dropping the first section is enough");
  assert.equal(described.cylindersMore, undefined);
});

// ---------- 2 and 3. part-turn cylinders, count as features ----------

const arcGeometry = (center: Vec, radius: number, start: Vec, midpoint: Vec, end: Vec): Edge["circleGeometry"] => ({
  centerMm: center, radiusMm: radius, normal: [0, 0, 1], reference: [1, 0, 0], startMm: start, midpointMm: midpoint, endMm: end,
});

test("a cylinder face with one circle edge is an arc, with sweepDeg from the edge, never a hole or boss", () => {
  const h = Math.SQRT1_2 * 2;
  const quarter = circle("a1", [0, 0, 8], ["arc90"], arcGeometry([0, 0, 8], 2, [2, 0, 8], [h, h, 8], [0, 2, 8]));
  const threeQuarters = circle("a2", [0, 0, 8], ["arc270"], arcGeometry([0, 0, 8], 2, [2, 0, 8], [-h, h, 8], [0, -2, 8]));
  const faces = [
    cylinder("arc90", [10, 10, 5], 2, false, [0, 0, 1], { edgeIds: ["a1", "l1"] }),
    cylinder("arc270", [20, 10, 5], 2, true, [0, 0, 1], { edgeIds: ["a2", "l1"] }),
    cylinder("arcNoGeometry", [30, 10, 5], 2, false, [0, 0, 1], { edgeIds: ["a3", "l1"] }),
    cylinder("full", [40, 10, 5], 2, false, [0, 0, 1], { edgeIds: ["f1", "f2"] }),
  ];
  const edges = [quarter, threeQuarters, circle("a3", [0, 0, 8], ["arcNoGeometry"]), circle("f1", [40, 10, 8], ["full"]), circle("f2", [40, 10, 2], ["full"]), line("l1")];
  const described = describeBody(bodyOf(8, faces, edges) as never, "r1");
  const kinds = described.cylinders.map((group) => `${group.kind}:${group.sweepDeg ?? "-"}:${group.count}`);
  assert.deepEqual(kinds.sort(), ["arc:-:1", "arc:270:1", "arc:90:1", "hole:-:1"], "the full-turn hole is separate from the three arcs of the same radius");
  assert.equal(described.cylinders.filter((group) => group.kind === "hole" || group.kind === "boss").length, 1);
  const hole = described.cylinders.find((group) => group.kind === "hole")!;
  assert.deepEqual(hole.axisPointsMm.map((point) => point[0]), [40], "only the full-turn face is the hole");
  assert.equal("through" in described.cylinders.find((group) => group.kind === "arc")!, false, "an arc says nothing about through");
});

test("a face with a closed circle edge is a full turn; a face with two circle edges stays a hole or boss", () => {
  const closed = circle("c1", [0, 0, 8], ["one"], arcGeometry([0, 0, 8], 2, [2, 0, 8], [-2, 0, 8], [2, 0, 8]));
  const faces = [cylinder("one", [10, 10, 5], 2, false, [0, 0, 1], { edgeIds: ["c1", "l1"] }), cylinder("two", [20, 10, 5], 2, true, [0, 0, 1], { edgeIds: ["d1", "d2"] })];
  const described = describeBody(bodyOf(9, faces, [closed, circle("d1", [20, 10, 8], ["two"]), circle("d2", [20, 10, 2], ["two"]), line("l1")]) as never, "r1");
  assert.deepEqual(described.cylinders.map((group) => group.kind).sort(), ["boss", "hole"]);
});

test("count is the number of distinct axes; faces appears only when it differs", () => {
  const faces = [
    cylinder("a", [5, 5, 5], 2, false), cylinder("a2", [5, 5, 5], 2, false), cylinder("b", [25, 5, 5], 2, false), // two axes, three faces
    cylinder("c", [5, 25, 5], 3, true), // one axis, one face
  ];
  const described = describeBody(bodyOf(10, faces) as never, "r1");
  const holes = described.cylinders.find((group) => group.kind === "hole")!;
  assert.equal(holes.count, 2);
  assert.equal(holes.faces, 3);
  const boss = described.cylinders.find((group) => group.kind === "boss")!;
  assert.equal(boss.count, 1);
  assert.equal("faces" in boss, false);
  assert.deepEqual(Object.keys(holes), ["radiusMm", "axis", "kind", "count", "faces", "axisPointsMm"]);
  // Hole faces beyond the 16-point cap: count stays the true number of axes.
  const many = describeBody(bodyOf(11, Array.from({ length: 20 }, (_, index) => cylinder(`h${index}`, [index * 3, 0, 5], 1, false))) as never, "r1");
  assert.equal(many.cylinders[0]!.count, 20);
  assert.equal(many.cylinders[0]!.more, 4);
});

// ---------- 4. grouping robustness ----------

test("axis directions whose near-zero components differ in sign group together", () => {
  const slanted = (id: string, tiny: number): Face => cylinder(id, [5, 5, 5], 2, false, [tiny, 0.6, 0.8]);
  const described = describeBody(bodyOf(12, [slanted("p", 2e-9), slanted("n", -2e-9), slanted("m", -0.0)]) as never, "r1");
  assert.equal(described.cylinders.length, 1);
  assert.deepEqual(described.cylinders[0]!.axis, [0, 0.6, 0.8]);
  assert.equal(described.cylinders[0]!.count, 1, "and one axis point");
  assert.equal(described.cylinders[0]!.faces, 3);
  // A mirrored direction with a real first component still groups with its opposite.
  const mirrored = describeBody(bodyOf(13, [cylinder("a", [5, 5, 5], 2, false, [0.6, 0, 0.8]), cylinder("b", [5, 5, 5], 2, false, [-0.6, 0, -0.8])]) as never, "r1");
  assert.equal(mirrored.cylinders.length, 1);
});

test("axis points within 0.001 mm are one axis, also across a rounding boundary; farther ones are two", () => {
  const at = (id: string, x: number) => cylinder(id, [x, 5, 5], 2, false);
  const near = describeBody(bodyOf(14, [at("a", 5.0004), at("b", 5.0013), at("c", 5.00045)]) as never, "r1");
  assert.equal(near.cylinders[0]!.count, 1, "0.0009 mm apart across a 0.001 grid line");
  const far = describeBody(bodyOf(15, [at("a", 5.0004), at("b", 5.0016)]) as never, "r1");
  assert.equal(far.cylinders[0]!.count, 2);
});

test("radii within 0.0001 mm of a group's first radius join it, whichever rounding bucket they fall in", () => {
  const radius = (id: string, value: number) => cylinder(id, [5, 5, 5], value, false);
  const joined = describeBody(bodyOf(16, [radius("a", 2.50004), radius("b", 2.50014)]) as never, "r1");
  assert.equal(joined.cylinders.length, 1, "0.0001 apart; rounding to 4 decimals would split them");
  assert.equal(joined.cylinders[0]!.radiusMm, 2.5, "the first radius names the group");
  const apart = describeBody(bodyOf(17, [radius("a", 2.5), radius("b", 2.5003), radius("c", 2.50005)]) as never, "r1");
  assert.equal(apart.cylinders.length, 2);
  assert.equal(apart.cylinders.find((group) => group.radiusMm === 2.5)!.faces, 2, "2.50005 joins the first group");
});

// ---------- 5. describe_body in a batch ----------

function busyBody() {
  const faces: Face[] = [];
  const normals: Vec[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  normals.forEach((normal, direction) => { for (let index = 0; index < 8; index += 1) faces.push(plane(`p${direction}-${index}`, [index * 7.123, index * 2.5 + direction, index * 3.75], normal)); });
  for (let index = 0; index < 4; index += 1) faces.push(cylinder(`h${index}`, [index * 6.1, 5, 5], 2.25, false));
  return bodyOf(1, faces, undefined, "enclosure-base-with-a-name");
}
function manyFaces(count: number) {
  return bodyOf(2, Array.from({ length: count }, (_, index) => ({ ...plane(`f${index}`, [index, 0, 0], [0, 0, 1], 1), edgeIds: ["e1", "e2", "e3", "e4"] })));
}

test("a describe_body batch step without return comes back whole in both detail modes; other reads are still cut at 1,500 bytes", async () => {
  const body = busyBody();
  const whole = JSON.parse(JSON.stringify(describeBody(body as never, "r1")));
  assert.ok(size(whole) > 1_500, `the description is ${size(whole)} bytes`);
  const { client, close } = await connect(open(stateOf([body, manyFaces(40)])));
  for (const detail of ["lean", "standard"]) {
    const output = await runBatch(client, { detail, steps: [{ toolName: "plasticity_describe_body", arguments: { id: 1 } }, { toolName: "plasticity_find_faces", arguments: { query: { bodyIds: [2] } } }] });
    assert.deepEqual(output.steps[0].result, whole, detail);
    assert.equal(output.steps[1].result.truncated, true, `${detail}: the 1,500 B rule still holds for other reads`);
  }
  const several = await runBatch(client, { detail: "lean", steps: [{ toolName: "plasticity_describe_body", arguments: {} }] });
  assert.equal(several.steps[0].result.bodies.length, 2);
  assert.equal(several.steps[0].result.truncated, undefined);
  await close();
});

// ---------- 7. roundMm ----------

test("roundMm rounds lengths and projected lengths, and leaves rates, matrix rotation and angles alone", async () => {
  const face = {
    ...plane("f1", [1.123456, 2.987654, 3.5555], [0.123456, 0.654321, 0.745356], 3),
    radiusMm: 2.123456, boundsMm: box([0.123456, 0.654321, 0.987654], [4.111111, 5.222222, 6.333333]),
    curvaturePerMm: 0.123456, fractureEnergyNPerMm: 1.234567, stiffnessMPaPerMm: 2.345678, tractionNPerMm2: 3.456789,
    matrixWorldMm: [0.123456, 0.2, 0.3, 0, 0.4, 0.5, 0.6, 0, 0.7, 0.8, 0.9, 0, 10.123456, 20.234567, 30.345678, 1.234567],
    outerPerimeterMm: 12.123456, areaMm2: 9.87654321,
  };
  const { client, close } = await connect(open(stateOf([bodyOf(1, [face as unknown as Face])])));
  const output = await runBatch(client, { roundMm: 2, steps: [{ toolName: "plasticity_find_faces", arguments: { query: { bodyIds: [1] } } }] });
  const match = output.steps[0].result.matches[0];
  assert.deepEqual(match.centerMm, [1.12, 2.99, 3.56]);
  assert.equal(match.radiusMm, 2.12);
  assert.deepEqual(match.boundsMm, { min: [0.12, 0.65, 0.99], max: [4.11, 5.22, 6.33] });
  assert.equal(match.outerPerimeterMm, 12.12, "Per followed by a lower-case letter is not a rate");
  assert.equal(match.areaMm2, 9.88);
  assert.deepEqual(match.normal, [0.123456, 0.654321, 0.745356]);
  for (const key of ["curvaturePerMm", "fractureEnergyNPerMm", "stiffnessMPaPerMm", "tractionNPerMm2"]) assert.equal(match[key], (face as Record<string, unknown>)[key], key);
  assert.deepEqual(match.matrixWorldMm, [0.123456, 0.2, 0.3, 0, 0.4, 0.5, 0.6, 0, 0.7, 0.8, 0.9, 0, 10.12, 20.23, 30.35, 1.234567], "only the translation is rounded");
  await close();
});

test("roundMm follows the nearest ancestor key ending in Mm or Mm2 when a return path projects into a length", async () => {
  const face = {
    ...plane("f1", [1.123456, 2.987654, 3.5555], [0.123456, 0.654321, 0.745356], 3),
    boundsMm: box([0.123456, 0.654321, 0.987654], [4.111111, 5.222222, 6.333333]),
    curvaturePerMm: 0.123456,
    matrixWorldMm: [0.123456, 0.2, 0.3, 0, 0.4, 0.5, 0.6, 0, 0.7, 0.8, 0.9, 0, 10.123456, 20.234567, 30.345678, 1.234567],
  };
  const { client, close } = await connect(open(stateOf([bodyOf(1, [face as unknown as Face])])));
  const output = await runBatch(client, {
    roundMm: 1,
    steps: [{
      toolName: "plasticity_find_faces", arguments: { query: { bodyIds: [1] } },
      return: ["matches[*].boundsMm.min", "matches[*].centerMm[0]", "matches[*].normal", "matches[*].normal[0]", "matches[*].curvaturePerMm", "matches[*].matrixWorldMm", "matches[*].matrixWorldMm[12]", "matches[*].matrixWorldMm[0]", "count"],
    }],
  });
  const result = output.steps[0].result;
  assert.deepEqual(result["matches[*].boundsMm.min"], [[0.1, 0.7, 1]]);
  assert.deepEqual(result["matches[*].centerMm[0]"], [1.1]);
  assert.deepEqual(result["matches[*].normal"], [[0.123456, 0.654321, 0.745356]]);
  assert.deepEqual(result["matches[*].normal[0]"], [0.123456]);
  assert.deepEqual(result["matches[*].curvaturePerMm"], [0.123456]);
  assert.deepEqual(result["matches[*].matrixWorldMm"], [[0.123456, 0.2, 0.3, 0, 0.4, 0.5, 0.6, 0, 0.7, 0.8, 0.9, 0, 10.1, 20.2, 30.3, 1.234567]]);
  assert.deepEqual(result["matches[*].matrixWorldMm[12]"], [10.1]);
  assert.deepEqual(result["matches[*].matrixWorldMm[0]"], [0.123456]);
  assert.equal(result.count, 1);
  await close();
});

// ---------- 9, 8 and descriptions ----------

test("instructions name the right sortBy keys, and descriptions state the 8 KB cut and the describe_body meanings", async () => {
  assert.doesNotMatch(PLASTICITY_MCP_INSTRUCTIONS, /including "area"/);
  assert.match(PLASTICITY_MCP_INSTRUCTIONS, /find_faces \(sortBy area\|x\|y\|z\)\/find_edges \(length\|x\|y\|z\)/);
  const { client, close } = await connect(open(stateOf([manyFaces(3)])));
  const tools = (await client.listTools()).tools;
  const description = (name: string) => tools.find((candidate) => candidate.name === name)!.description ?? "";
  for (const name of ["plasticity_find_faces", "plasticity_find_edges"]) {
    assert.match(description(name), /over 8 KB is cut unless limit is set \(sortBy alone does not lift the cut\)/, name);
  }
  const describe = description("plasticity_describe_body");
  assert.match(describe, /signed offset along the normal/);
  assert.match(describe, /largest bounding box at that offset, not exact area/);
  assert.match(describe, /kind hole or boss \(full turn\) or arc \(part turn/);
  assert.match(describe, /count \(distinct axes; faces only when different\)/);
  assert.match(describe, /coaxial holes through opposite walls merge into one point/);
  assert.match(describe, /Always returns revision/);
  assert.match(describe, /Includes hole and boss axis positions: no face search needed for those/);
  await close();
});

// ---------- 10. stale revision wording ----------

test("exact solid properties and interference name a stale revision like every other tool", async () => {
  const runtime = { async getState() { return { revision: "r9", bodies: [] }; } } as unknown as PlasticityRuntime;
  await assert.rejects(measureSolidProperties(runtime, [7], "r1", "session-1"), /^Error: Stale reference: expected revision r1, current revision is r9$/);
  await assert.rejects(checkBodyInterference(runtime, [{ firstBodyId: 7, secondBodyId: 8 }], "r1", "session-1"), /^Error: Stale reference: expected revision r1, current revision is r9$/);
});

// ---------- 11. returnErrors ----------

test("a batch with a bad return path on a step that changed the document carries returnErrors at the top, in every reply shape", async () => {
  const body = bodyOf(1, [plane("top", [20, 15, 10], [0, 0, 1], 15)]);
  const { client, close } = await connect(open(stateOf([body])));
  const steps = [
    { toolName: "plasticity_fillet", arguments: { id: 1, edgeIds: ["e1"], radiusMm: 1 }, return: ["nothing.here"] },
    { toolName: "plasticity_fillet", arguments: { id: 1, edgeIds: ["e1"], radiusMm: 1 }, return: ["alsoNothing"] },
  ];
  for (const extra of [{ detail: "lean" }, {}, { verbose: true }]) {
    const output = await runBatch(client, { steps, ...extra });
    assert.equal(output.returnErrors, 2, JSON.stringify(extra));
    assert.equal(typeof output.steps[0].returnError, "string");
  }
  const clean = await runBatch(client, { detail: "lean", steps: [{ toolName: "plasticity_fillet", arguments: { id: 1, edgeIds: ["e1"], radiusMm: 1 } }] });
  assert.equal("returnErrors" in clean, false, "no count when no step carries returnError");
  await close();
});
