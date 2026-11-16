import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createCompactServer, createServer, type SessionLike } from "./server.ts";
import type { PlasticityOperations } from "./plasticity/operations.ts";
import type { RuntimeState } from "./plasticity/runtime.ts";
import { exposeDirectTool } from "./tool-catalog.ts";

type V3 = [number, number, number];

// A small stateful fake: enough native operations for a board case with standoffs, lid screws and an opening. Bodies carry
// box/cylinder bounds (a union grows the target, an intersection clips it) for the recipe's read-back; validateBodies is a
// read and is not recorded in `calls`.
function fakeOperations() {
  let revision = 0;
  let nextId = 10;
  let bodies: RuntimeState["bodies"] = [];
  let regions: RuntimeState["regions"] = [];
  const history: Array<{ bodies: RuntimeState["bodies"]; regions: RuntimeState["regions"] }> = [];
  const calls: string[] = [];
  const state = (): RuntimeState => ({
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: `r${revision}`, dbVersion: revision, undoDepth: history.length, redoDepth: 0,
    construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" }, regions: structuredClone(regions), bodies: structuredClone(bodies),
  });
  const edge = (id: string, tangent: V3) => ({ id, curveType: "Line", line: true, circle: false, lengthMm: 1, centerMm: [0, 0, 0] as V3, tangent, boundsMm: { min: [0, 0, 0] as V3, max: [0, 0, 0] as V3 }, faceIds: [], vertexIds: [] });
  const solid = (id: number, name: string | null, tangents: V3[], boundsMm: { min: V3; max: V3 } | null = null) => ({ id, versionId: id, type: "Solid", name, boundsMm, faceIds: [], edgeIds: tangents.map((_, index) => `e${id}-${index}`), faces: [], edges: tangents.map((tangent, index) => edge(`e${id}-${index}`, tangent)) });
  const axial = (center: V3, axis: V3, height: number, radius: number) => {
    const end = center.map((value, index) => value + axis[index]! * height) as V3;
    const along = (index: number) => Math.abs(axis[index]!) > 0.5;
    return { min: center.map((value, index) => along(index) ? Math.min(value, end[index]!) : value - radius) as V3, max: center.map((value, index) => along(index) ? Math.max(value, end[index]!) : value + radius) as V3 };
  };
  const mutate = (operation: string, given: string | undefined, apply: () => void) => {
    calls.push(operation);
    if (given !== undefined && given !== `r${revision}`) throw new Error(`Stale reference: expected revision ${given}, current revision is r${revision}`);
    history.push({ bodies: structuredClone(bodies), regions: structuredClone(regions) });
    apply();
    revision += 1;
    return state();
  };
  const vertical: V3[] = [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1], [1, 0, 0], [0, 1, 0]];
  const operations = {
    async state() { return state(); },
    async createBox(origin: V3, size: V3, name: string | undefined, given: string) { return mutate("createBox", given, () => { bodies.push(solid(nextId++, name ?? null, vertical, { min: [...origin], max: origin.map((value, axis) => value + size[axis]!) as V3 })); }); },
    async createCylinder(center: V3, radius: number, height: number, _name: string | undefined, given: string, axis: V3 = [0, 0, 1]) { return mutate("createCylinder", given, () => { bodies.push(solid(nextId++, null, [], axial(center, axis, height, radius))); }); },
    async fillet(_id: number, _edges: string[], _radius: number, given: string) { return mutate("fillet", given, () => {}); },
    async boolean(targets: number[], tools: number[], kind: string, _keep: boolean, given: string) {
      return mutate("boolean", given, () => {
        const target = bodies.find((body) => body.id === targets[0]);
        for (const tool of bodies.filter((body) => tools.includes(body.id) && body.boundsMm)) {
          if (!target?.boundsMm) break;
          if (kind === "union") target.boundsMm = { min: target.boundsMm.min.map((value, axis) => Math.min(value, tool.boundsMm!.min[axis]!)) as V3, max: target.boundsMm.max.map((value, axis) => Math.max(value, tool.boundsMm!.max[axis]!)) as V3 };
          if (kind === "intersection") target.boundsMm = { min: target.boundsMm.min.map((value, axis) => Math.max(value, tool.boundsMm!.min[axis]!)) as V3, max: target.boundsMm.max.map((value, axis) => Math.min(value, tool.boundsMm!.max[axis]!)) as V3 };
        }
        bodies = bodies.filter((body) => !tools.includes(body.id));
      });
    },
    async createCone(center: V3, radius: number, topRadius: number, height: number, axis: V3, _radial: V3, _name: string | undefined, given: string) {
      return mutate("createCone", given, () => { bodies.push({ ...solid(nextId++, null, []), type: "Wire" }); bodies.push(solid(nextId++, null, [], axial(center, axis, height, Math.max(radius, topRadius)))); });
    },
    async validateBodies(ids: number[], given: string) {
      if (given !== `r${revision}`) throw new Error("stale validate");
      return { documentToken: "doc-1", revision: given, measurementSource: "native-brep", bodies: ids.map((id) => ({ id, closed: true, nativeValid: true, printableSolid: true, nativeCheckCodes: [] })) };
    },
    async createPolyline(points: V3[], _closed: boolean, given: string) {
      return mutate("createPolyline", given, () => {
        const id = nextId++;
        bodies.push({ ...solid(id, null, []), type: "Wire" });
        const min = [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis]!))) as V3;
        const max = [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis]!))) as V3;
        regions.push({ id: `region-${id}`, entityId: id, islandVersionId: id, sketchId: id, sketchWireIds: [id], measurementSource: "render-mesh", displayBoundsMm: { min, max } });
      });
    },
    async extrudeRegions(_ids: string[], _distance: number, given: string) { return mutate("extrudeRegions", given, () => { bodies.push(solid(nextId++, null, [])); }); },
    async revolveProfile(_id: number, _origin: V3, _axis: V3, _angle: number, given: string) { return mutate("revolveProfile", given, () => { bodies.push(solid(nextId++, null, [])); }); },
    async remove(ids: number[], given: string) { return mutate("remove", given, () => { bodies = bodies.filter((body) => !ids.includes(body.id)); regions = regions.filter((region) => !region.sketchWireIds.some((id) => ids.includes(id))); }); },
    async move(_ids: number[], _delta: V3, given: string) { return mutate("move", given, () => {}); },
    async rename(id: number, name: string, given: string) { return mutate("rename", given, () => { bodies.find((body) => body.id === id)!.name = name; }); },
    async undo() { const last = history.pop(); if (last) { bodies = last.bodies; regions = last.regions; } revision += 1; return state(); },
  };
  return { operations, calls };
}

async function withClient<T>(run: (client: Client, calls: string[]) => Promise<T>, compact = false): Promise<T> {
  const fake = fakeOperations();
  const session = {
    async windows() { return []; },
    async connect() { return {}; },
    get() { return fake.operations as unknown as PlasticityOperations; },
    capabilities() { return { bindings: [], operations: { constructionPlanes: { available: false, reason: "test" }, activeWorkplane: { available: false, reason: "test" } } }; },
    async captureSnapshot() { return {}; },
    async changesSince() { return {}; },
    async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = (compact ? createCompactServer : createServer)(session, undefined, undefined, undefined, null);
  const client = new Client({ name: "case-recipe-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client, fake.calls);
  } finally {
    await client.close();
  }
}

function json(response: unknown): any {
  const content = (response as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return JSON.parse(content.find((entry) => entry.type === "text")!.text!);
}
function text(response: unknown): string {
  return ((response as { content?: Array<{ type: string; text?: string }> }).content ?? []).find((entry) => entry.type === "text")?.text ?? "";
}

const CASE = {
  originMm: [2000, 0, 0],
  board: { lengthMm: 30, widthMm: 20, holes: [{ xMm: 3, yMm: 3, diameterMm: 2.5 }, { xMm: 27, yMm: 17, diameterMm: 2.5 }], componentHeightMm: 5 },
  standoffs: { heightMm: 3, fastener: { screw: "M2.5", mode: "pilot", pilotDiameterMm: 2 } },
  // bossStyle pinned to the previous default (tapered) with the A override, so the projected numbers below keep their values.
  lid: { fasteners: { screw: "M3", base: "pilot", pilotDiameterMm: 2.5, pilotDepthMm: 5, bossStyle: "tapered", allowBlockedBoard: true } },
  openings: [{ wall: "x-", shape: "rect", widthMm: 6, heightMm: 3, alongMm: 10, aboveBoardMm: 1 }],
};

test("plasticity_create_board_case and plasticity_fastener_presets are registered once, strict, with a short description", async () => {
  await withClient(async (client) => {
    const tools = (await client.listTools()).tools;
    for (const name of ["plasticity_create_board_case", "plasticity_fastener_presets"]) assert.equal(tools.filter((entry) => entry.name === name).length, 1, name);
    const board = tools.find((entry) => entry.name === "plasticity_create_board_case")!;
    assert.ok((board.description ?? "").length <= 600, `description is ${(board.description ?? "").length} chars`);
    const schema = board.inputSchema as { additionalProperties?: unknown; properties: Record<string, { additionalProperties?: unknown; items?: { additionalProperties?: unknown } }>; required?: string[] };
    assert.equal(schema.additionalProperties, false);
    for (const key of ["board", "fit", "walls", "standoffs", "lid", "vents"]) assert.equal(schema.properties[key]!.additionalProperties, false, key);
    assert.equal(schema.properties.openings!.items!.additionalProperties, false);
    assert.deepEqual([...(schema.required ?? [])].sort(), ["board", "originMm", "revision"]);
    assert.equal(board.annotations?.readOnlyHint, false);
    const presets = tools.find((entry) => entry.name === "plasticity_fastener_presets")!;
    assert.equal((presets.inputSchema as { additionalProperties?: unknown }).additionalProperties, false);
    assert.equal(presets.annotations?.readOnlyHint, true);
  });
});

test("the board case is in the compact tool list; the presets stay reachable through plasticity_call", async () => {
  assert.equal(exposeDirectTool("compact", "plasticity_create_board_case"), true);
  await withClient(async (client) => {
    const names = (await client.listTools()).tools.map((entry) => entry.name);
    assert.ok(names.includes("plasticity_create_board_case"));
    assert.ok(!names.includes("plasticity_fastener_presets"));
    const presets = json(await client.callTool({ name: "plasticity_call", arguments: { toolName: "plasticity_fastener_presets", arguments: { screw: "M3" } } }));
    assert.match(presets.clearanceHoles.source, /ISO 273/);
    assert.equal(presets.clearanceHoles.confidence, "medium");
    assert.deepEqual(presets.countersunkHeads.rows, [{ screw: "M3", headDiameterMaxMm: 6.72, includedAngleDeg: 90 }]);
    const catalog = json(await client.callTool({ name: "plasticity_call", arguments: { toolName: "catalog", query: "plasticity_create_board_case" } }));
    assert.equal(catalog.tools[0].name, "plasticity_create_board_case");
    assert.equal(catalog.tools[0].inputSchema.additionalProperties, false);
  }, true);
});

test("unknown keys are refused by the schema before any native call", async () => {
  await withClient(async (client, calls) => {
    const top = await client.callTool({ name: "plasticity_create_board_case", arguments: { ...CASE, colour: "red", revision: "r0" } });
    assert.equal(top.isError, true);
    const nested = await client.callTool({ name: "plasticity_create_board_case", arguments: { ...CASE, board: { ...CASE.board, colour: "red" }, revision: "r0" } });
    assert.equal(nested.isError, true);
    const opening = await client.callTool({ name: "plasticity_create_board_case", arguments: { ...CASE, openings: [{ ...CASE.openings[0], depthMm: 3 }], revision: "r0" } });
    assert.equal(opening.isError, true);
    const count = await client.callTool({ name: "plasticity_create_board_case", arguments: { ...CASE, lid: { fasteners: { ...CASE.lid.fasteners, count: 6 } }, revision: "r0" } });
    assert.equal(count.isError, true);
    assert.deepEqual(calls, []);
  });
});

test("an unsourced fastener request is refused through the server before any native call", async () => {
  await withClient(async (client, calls) => {
    const response = await client.callTool({ name: "plasticity_create_board_case", arguments: { ...CASE, lid: { fasteners: { screw: "M2", base: "pilot", pilotDiameterMm: 1.6, pilotDepthMm: 4 } }, revision: "r0" } });
    assert.equal(response.isError, true);
    assert.match(text(response), /countersunk head diameter for M2 is not sourced/);
    assert.deepEqual(calls, []);
  });
});

test("plasticity_call dispatches the board case with its strict schema", async () => {
  await withClient(async (client, calls) => {
    const result = json(await client.callTool({ name: "plasticity_call", arguments: { toolName: "plasticity_create_board_case", arguments: { ...CASE, revision: "r0" } } }));
    assert.equal(result.recipe, "board-case");
    assert.equal(result.status, "completed");
    assert.deepEqual(Object.keys(result.bodies), ["baseId", "lidId"]);
    assert.equal(result.undoSteps, calls.length);
    assert.equal(result.derived.lidBossAxesMm.length, 4);
    assert.equal(calls.at(-1), "remove");
  });
});

test("the board case works as a lean plasticity_batch step and return projects bodies and derived fields", async () => {
  await withClient(async (client, calls) => {
    const response = await client.callTool({ name: "plasticity_batch", arguments: { detail: "lean", steps: [
      { toolName: "plasticity_create_board_case", arguments: CASE, return: ["bodies", "derived.lidBossAxesMm"] },
      { toolName: "plasticity_create_board_case", arguments: { ...CASE, originMm: [2100, 0, 0], name: "second" } },
    ] } });
    assert.equal(response.isError, undefined, text(response));
    const reply = json(response);
    const first = reply.steps[0].result;
    assert.deepEqual(Object.keys(first), ["bodies", "derived.lidBossAxesMm"]);
    assert.deepEqual(Object.keys(first.bodies), ["baseId", "lidId"]);
    assert.deepEqual(first["derived.lidBossAxesMm"], [[2004.5, 4.5], [2030.5, 4.5], [2004.5, 20.5], [2030.5, 20.5]]);
    // Without return, a lean recipe step replies with its status only.
    assert.equal(reply.steps[1].result.status, "completed");
    assert.equal(reply.steps[1].result.derived, undefined);
    assert.equal(reply.summary.undoSteps, calls.length);
    assert.deepEqual(reply.summary.added.map((body: { name: string }) => body.name).sort(), ["case-base", "case-lid", "second-base", "second-lid"]);
  });
});

test("lid.fasteners.bossStyle is a strict enum defaulting to floor; each style builds through the server", async () => {
  await withClient(async (client, calls) => {
    const tools = (await client.listTools()).tools;
    const schema = tools.find((entry) => entry.name === "plasticity_create_board_case")!.inputSchema as unknown as { properties: { lid: { properties: { fasteners: { properties: { bossStyle: { enum?: string[] } } } } } } };
    assert.deepEqual(schema.properties.lid.properties.fasteners.properties.bossStyle.enum, ["tapered", "hanging", "floor"]);
    const bad = await client.callTool({ name: "plasticity_create_board_case", arguments: { ...CASE, lid: { fasteners: { ...CASE.lid.fasteners, bossStyle: "pillar" } }, revision: "r0" } });
    assert.equal(bad.isError, true);
    assert.deepEqual(calls, []);
  });
  // The tapered wall top: componentTop 6.6 + 5 + 1 = 12.6, + boss length 6, + reach (2.5 sqrt 2 + 3), - rise (1 mm inner radius x (sqrt 2 - 1)).
  const taperedWallTop = Math.round((12.6 + 6 + 2.5 * Math.SQRT2 + 3 - (Math.SQRT2 - 1)) * 1e6) / 1e6;
  // No bossStyle: the default floor style; CASE has an x- wall opening, so the cavity grows along y (B). "floor" with
  // growAxis "x" keeps the x growth of the earlier rows.
  for (const [style, growAxis, expectedWallTop] of [[undefined, undefined, 14.1], ["tapered", undefined, taperedWallTop], ["hanging", undefined, 18.6], ["floor", "x", 14.1]] as const) {
    await withClient(async (client) => {
      const { bossStyle: _pinned, ...unstyled } = CASE.lid.fasteners;
      const fasteners = style === undefined ? unstyled : { ...unstyled, bossStyle: style, ...(growAxis ? { growAxis } : {}) };
      const result = json(await client.callTool({ name: "plasticity_create_board_case", arguments: { ...CASE, lid: { fasteners }, revision: "r0" } }));
      const effective = style ?? "floor";
      assert.equal(result.derived.bossStyle, effective);
      assert.equal(Math.round(result.derived.wallTopZMm * 1e6) / 1e6, expectedWallTop, String(style));
      assert.equal(result.derived.printability.baseOrientation, "floor-down");
      assert.equal(result.derived.printability.maxBossOverhangDeg, { tapered: 45, hanging: 90, floor: 0 }[effective]);
      assert.deepEqual(result.derived.boardWallClearanceMm, effective !== "floor" ? { xNeg: 0.5, xPos: 0.5, yNeg: 0.5, yPos: 0.5 } : growAxis === "x" ? { xNeg: 6, xPos: 6, yNeg: 0.5, yPos: 0.5 } : { xNeg: 0.5, xPos: 0.5, yNeg: 6, yPos: 6 });
      assert.equal(result.derived.bossTaper !== undefined, effective === "tapered");
      assert.deepEqual(result.derived.cavityGrowthMm, effective !== "floor" ? undefined : growAxis === "x" ? [11, 0] : [0, 11]);
      assert.equal(result.derived.assembly.boardDropIn, effective === "floor");
      assert.equal(result.undoSteps, result.derived.plannedUndoSteps);
    });
  }
});

test("allowBlockedBoard and growAxis are strict schema fields; the corner radius text states the inner radius rule", async () => {
  await withClient(async (client, calls) => {
    const tools = (await client.listTools()).tools;
    const schema = tools.find((entry) => entry.name === "plasticity_create_board_case")!.inputSchema as unknown as { properties: { walls: { properties: { outerCornerRadiusMm: { description?: string } } }; lid: { properties: { fasteners: { properties: Record<string, { type?: string; enum?: string[]; description?: string }> } } } } };
    const fasteners = schema.properties.lid.properties.fasteners.properties;
    assert.equal(fasteners.allowBlockedBoard!.type, "boolean");
    assert.deepEqual(fasteners.growAxis!.enum, ["x", "y"]);
    assert.match(fasteners.bossStyle!.description ?? "", /^Default floor/);
    assert.match(schema.properties.walls.properties.outerCornerRadiusMm.description ?? "", /min\(radius - wall, .*board corner/);
    const blocked = await client.callTool({ name: "plasticity_create_board_case", arguments: { ...CASE, lid: { fasteners: { ...CASE.lid.fasteners, allowBlockedBoard: undefined } }, revision: "r0" } });
    assert.equal(blocked.isError, true);
    assert.match(text(blocked), /hang over the board corners.*bossStyle "floor"/);
    const wrongType = await client.callTool({ name: "plasticity_create_board_case", arguments: { ...CASE, lid: { fasteners: { ...CASE.lid.fasteners, allowBlockedBoard: "yes" } }, revision: "r0" } });
    assert.equal(wrongType.isError, true);
    assert.deepEqual(calls, []);
  });
});
