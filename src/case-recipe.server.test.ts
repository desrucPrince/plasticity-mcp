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
        // Like Plasticity (live-verified, round 4): a closed profile's plane normal comes from the corner at its first
        // point (last point, first point, second point). Kept for horizontal profiles (the web profiles): up or down.
        const [last, first, second] = [points.at(-1)!, points[0]!, points[1]!];
        const up = (first[0] - last[0]) * (second[1] - first[1]) - (first[1] - last[1]) * (second[0] - first[0]) > 0;
        regions.push({ id: `region-${id}`, entityId: id, islandVersionId: id, sketchId: id, sketchWireIds: [id], measurementSource: "render-mesh", displayBoundsMm: { min, max }, ...(min[2] === max[2] ? { extrudesUp: up } : {}) } as RuntimeState["regions"][number]);
      });
    },
    // A horizontal profile's solid gets its bounds (the recipe checks that a web profile extruded up, round 4).
    async extrudeRegions(ids: string[], distance: number, given: string) {
      return mutate("extrudeRegions", given, () => {
        const region = regions.find((candidate) => candidate.id === ids[0]) as (RuntimeState["regions"][number] & { extrudesUp?: boolean }) | undefined;
        const flat = region && region.extrudesUp !== undefined ? region.displayBoundsMm : undefined;
        const far = flat ? flat.min[2] + (region!.extrudesUp ? distance : -distance) : 0;
        bodies.push(solid(nextId++, null, [], flat ? { min: [flat.min[0], flat.min[1], Math.min(flat.min[2], far)], max: [flat.max[0], flat.max[1], Math.max(flat.min[2], far)] } : null));
      });
    },
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
    assert.deepEqual(schema.properties.lid.properties.fasteners.properties.bossStyle.enum, ["tapered", "hanging", "floor", "stack"]);
    const bad = await client.callTool({ name: "plasticity_create_board_case", arguments: { ...CASE, lid: { fasteners: { ...CASE.lid.fasteners, bossStyle: "pillar" } }, revision: "r0" } });
    assert.equal(bad.isError, true);
    assert.deepEqual(calls, []);
  });
  // The tapered wall top (round-1 value; the inner radius is the 0.5 mm board clearance again).
  const taperedWallTop = 24.928427;
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
    assert.match(fasteners.bossStyle!.description ?? "", /^Default stack when the board has 2\+ holes .* else floor/);
    assert.match(schema.properties.walls.properties.outerCornerRadiusMm.description ?? "", /min\(radius - wall, board clearance\)/);
    const blocked = await client.callTool({ name: "plasticity_create_board_case", arguments: { ...CASE, lid: { fasteners: { ...CASE.lid.fasteners, allowBlockedBoard: undefined } }, revision: "r0" } });
    assert.equal(blocked.isError, true);
    assert.match(text(blocked), /hang over the board corners.*bossStyle "floor"/);
    const wrongType = await client.callTool({ name: "plasticity_create_board_case", arguments: { ...CASE, lid: { fasteners: { ...CASE.lid.fasteners, allowBlockedBoard: "yes" } }, revision: "r0" } });
    assert.equal(wrongType.isError, true);
    assert.deepEqual(calls, []);
  });
});

test("S: a stack case passes the strict schema without standoffs.fastener and builds through plasticity_call", async () => {
  await withClient(async (client, calls) => {
    const stack = {
      originMm: [2000, 0, 0],
      board: { lengthMm: 51.5, widthMm: 28.3, holes: [[2.6, 2.6], [48.9, 2.6], [2.6, 25.7], [48.9, 25.7]].map(([xMm, yMm]) => ({ xMm, yMm, diameterMm: 3 })), componentHeightMm: 8 },
      standoffs: { heightMm: 8, outerDiameterMm: 5 },
      lid: { fasteners: { screw: "M2.5", base: "pilot", pilotDiameterMm: 2.1, pilotDepthMm: 7, countersunk: false } },
    };
    const result = json(await client.callTool({ name: "plasticity_call", arguments: { toolName: "plasticity_create_board_case", arguments: { ...stack, revision: "r0" } } }));
    assert.equal(result.derived.bossStyle, "stack");
    assert.match(result.derived.bossStyleReason, /^default: the lid screws go through the 4 board holes/);
    assert.equal(result.derived.stack.postAxesMm.length, 4);
    assert.equal(result.undoSteps, calls.length);
    assert.equal(result.undoSteps, result.derived.plannedUndoSteps);
  });
});

// ------------------------------------------------------------------------------------------------- round 4 (D1, D2)
const cornerHoles = (length: number, width: number, diameterMm: number, inset: number) => [[inset, inset], [length - inset, inset], [inset, width - inset], [length - inset, width - inset]].map(([xMm, yMm]) => ({ xMm, yMm, diameterMm }));

test("D2: a default call with board holes and no standoffs key builds a support post under every hole, through plasticity_call and a lean batch", async () => {
  // The reviewer's input: the 51.5 x 28.3 board, four Ø3 holes 2.0 mm from the edges, M3 pilots, nothing else.
  const input = { originMm: [2000, 0, 0], board: { lengthMm: 51.5, widthMm: 28.3, holes: cornerHoles(51.5, 28.3, 3, 2), componentHeightMm: 8 }, lid: { fasteners: { screw: "M3", base: "pilot", pilotDiameterMm: 2.5, pilotDepthMm: 6 } }, boardStandIn: true };
  await withClient(async (client, calls) => {
    const result = json(await client.callTool({ name: "plasticity_call", arguments: { toolName: "plasticity_create_board_case", arguments: { ...input, revision: "r0" } } }));
    assert.equal(result.status, "completed");
    assert.equal(result.derived.bossStyle, "floor");
    assert.equal(result.derived.standoffAxesMm.length, 4);
    assert.deepEqual([result.derived.fasteners.standoffs.mode, result.derived.fasteners.standoffs.holeDiameterMm, result.derived.standoffTopZMm, result.derived.boardMm.min[2]], ["support", 0, 4, 4]);
    assert.equal(result.steps.filter((step: { operation: string }) => step.operation === "create-support-post").length, 4);
    assert.match(result.derived.assembly.note, /plain support posts: the board rests on them, unscrewed$/);
    assert.equal(result.undoSteps, calls.length);
    assert.equal(result.undoSteps, result.derived.plannedUndoSteps);
  });
  await withClient(async (client) => {
    const response = json(await client.callTool({ name: "plasticity_batch", arguments: { detail: "lean", steps: [{ toolName: "plasticity_create_board_case", arguments: input, return: ["derived.bossStyle", "derived.fasteners.standoffs.mode", "derived.standoffAxesMm", "derived.cornerGapMm"] }] } }));
    const first = response.steps[0].result;
    assert.deepEqual([first["derived.bossStyle"], first["derived.fasteners.standoffs.mode"], first["derived.standoffAxesMm"].length], ["floor", "support", 4]);
    // D5: the floor style's real diagonal play, sqrt 2 x 0.5.
    assert.ok(Math.abs(first["derived.cornerGapMm"] - Math.SQRT2 * 0.5) < 1e-6);
  });
});

test("D2: lid.fasteners.screw \"auto\" passes the strict schema and is resolved; another value is refused; the description states what the stack does not check", async () => {
  await withClient(async (client, calls) => {
    const tools = (await client.listTools()).tools;
    const board = tools.find((entry) => entry.name === "plasticity_create_board_case")!;
    assert.match(board.description ?? "", /a standoff under every board hole/);
    assert.match(board.description ?? "", /its lid posts reach to 0\.2 mm above the board and component positions are not checked/);
    assert.ok((board.description ?? "").length <= 600);
    const stack = { originMm: [2000, 0, 0], board: { lengthMm: 60, widthMm: 30, holes: cornerHoles(60, 30, 3, 4.5), componentHeightMm: 8 }, lid: { fasteners: { screw: "auto", base: "pilot", pilotDiameterMm: 2.1, pilotDepthMm: 6.9, countersunk: false } } };
    const wrong = await client.callTool({ name: "plasticity_create_board_case", arguments: { ...stack, lid: { fasteners: { ...stack.lid.fasteners, screw: "M4" } }, revision: "r0" } });
    assert.equal(wrong.isError, true);
    assert.deepEqual(calls, []);
    const result = json(await client.callTool({ name: "plasticity_create_board_case", arguments: { ...stack, revision: "r0" } }));
    assert.deepEqual([result.derived.bossStyle, result.derived.fasteners.lid.screw, result.derived.fasteners.standoffs.heightMm, result.derived.stack.screwLengthMm, result.derived.stack.screwLengthMaxMm], ["stack", "M2.5", 7.9, 20, 21]);
    assert.match(result.derived.fasteners.lid.screwReason, /^screw "auto": M2\.5, the largest whose close-fit clearance \(Ø2\.7\) passes the smallest board hole \(Ø3\)$/);
    assert.match(result.derived.stack.note, /component positions are not checked/);
    assert.equal(result.undoSteps, calls.length);
  });
});

test("D1: a plan the tangency guards refuse reaches the caller before any native call, with the nearest hole position that plans clean", async () => {
  await withClient(async (client, calls) => {
    const input = { originMm: [2000, 0, 0], board: { lengthMm: 35.7, widthMm: 37, holes: cornerHoles(35.7, 37, 2.2, 1.999), componentHeightMm: 6 }, walls: { wallMm: 2.4 }, standoffs: { fastener: { screw: "M2", mode: "pilot", pilotDiameterMm: 1.6 } }, lid: { fasteners: { screw: "M2", base: "pilot", pilotDiameterMm: 1.6, pilotDepthMm: 7, bossStyle: "floor", headDiameterMm: 3.8 } } };
    const refused = await client.callTool({ name: "plasticity_create_board_case", arguments: { ...input, revision: "r0" } });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /would have an edge under 0\.001 mm .*which the kernel cannot build reliably; move board\.holes\[0\] 0\.05 mm toward the board centre along x \(to xMm 2\.049\), and board\.holes\[2\] the same way: that plans clean/);
    assert.deepEqual(calls, []);
    // The named position builds.
    const holes = input.board.holes.map((hole, index) => index === 0 || index === 2 ? { ...hole, xMm: 2.049 } : hole);
    const result = json(await client.callTool({ name: "plasticity_create_board_case", arguments: { ...input, board: { ...input.board, holes }, revision: "r0" } }));
    assert.equal(result.status, "completed");
    assert.equal(result.undoSteps, calls.length);
  });
});

test("F3: the typical ESP32 call (screw auto, base pilot, no pilot keys) passes the strict schema and builds a stack; the presets list the stocked lengths and the tapping drills", async () => {
  // As few keys as the schema allows: the board with its four Ø3 holes 2.0 mm in, the USB opening, screw auto, base pilot.
  const input = { originMm: [2000, 0, 0], board: { lengthMm: 51.5, widthMm: 28.3, holes: cornerHoles(51.5, 28.3, 3, 2), componentHeightMm: 8 }, lid: { fasteners: { screw: "auto", base: "pilot" } }, openings: [{ wall: "x-", shape: "rect", widthMm: 9.2, heightMm: 3.4, alongMm: 14.15, aboveBoardMm: 0 }] };
  await withClient(async (client, calls) => {
    const result = json(await client.callTool({ name: "plasticity_create_board_case", arguments: { ...input, revision: "r0" } }));
    assert.equal(result.status, "completed");
    const derived = result.derived;
    assert.deepEqual([derived.bossStyle, derived.fasteners.lid.screw, derived.fasteners.lid.baseHole.diameterMm, derived.fasteners.lid.baseHole.depthMm, derived.fasteners.lid.baseHole.confidence], ["stack", "M2.5", 2.05, 6.9, "low"]);
    assert.deepEqual(derived.fasteners.lid.defaults.map((entry: string) => entry.split(":")[0]), ["pilotDiameterMm 2.05", "pilotDepthMm 6.9", "countersunk false"]);
    assert.deepEqual([derived.fasteners.standoffs.mode, derived.fasteners.standoffs.outerDiametersMm, derived.fasteners.standoffs.heightMm, derived.stack.postOuterDiametersMm, derived.stack.screwLengthMm], ["pilot", [4.5, 4.5, 4.5, 4.5], 7.9, [4.5, 4.5, 4.5, 4.5], 20]);
    assert.match(derived.fasteners.standoffs.outerDiameterReason, /^default: Ø4\.5, the largest \(in 0\.1 mm steps\) that keeps the lid post 0\.05 mm inside the lid lip outline \(board hole \+ 3 would be Ø6\)$/);
    assert.deepEqual(derived.stack.postAxesMm, derived.standoffAxesMm);
    assert.deepEqual([derived.outerMm.max[0] - derived.outerMm.min[0], Math.round((derived.outerMm.max[1] - derived.outerMm.min[1]) * 1e6) / 1e6, derived.outerMm.max[2] - derived.outerMm.min[2]], [56.5, 33.3, 22]);
    assert.equal(result.undoSteps, calls.length);
    assert.equal(result.undoSteps, derived.plannedUndoSteps);
    // A named screw still needs its pilot: refused before any native call.
    const before = calls.length;
    const named = await client.callTool({ name: "plasticity_create_board_case", arguments: { ...input, lid: { fasteners: { screw: "M2.5", base: "pilot" } }, revision: "r0" } });
    assert.equal(named.isError, true);
    assert.match(JSON.stringify(named.content), /a self-tapping pilot diameter for M2\.5 in plastic is not sourced; pass pilotDiameterMm/);
    assert.equal(calls.length, before);
    const board = (await client.listTools()).tools.find((entry) => entry.name === "plasticity_create_board_case")!;
    assert.ok((board.description ?? "").length <= 600);
    const fasteners = (board.inputSchema as unknown as { properties: { lid: { properties: { fasteners: { properties: Record<string, { description?: string }>; required?: string[] } } }; standoffs: { properties: Record<string, { description?: string }> } } }).properties;
    assert.deepEqual([...(fasteners.lid.properties.fasteners.required ?? [])].sort(), ["base", "screw"]);
    assert.match(fasteners.lid.properties.fasteners.properties.pilotDiameterMm!.description ?? "", /Screw auto: default the screw's ISO coarse tapping drill/);
    assert.match(fasteners.standoffs.properties.outerDiameterMm!.description ?? "", /with bossStyle stack the largest up to that .* A given value is never changed/);
  });
  await withClient(async (client) => {
    const presets = json(await client.callTool({ name: "plasticity_call", arguments: { toolName: "plasticity_fastener_presets", arguments: { screw: "M2.5" } } }));
    assert.deepEqual(presets.screwLengths.lengthsMm, [3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 30, 35, 40]);
    assert.match(presets.screwLengths.note, /the commonly stocked series, not a cited standard/);
    assert.deepEqual([presets.tapDrills.confidence, presets.tapDrills.rows], ["low", [{ screw: "M2.5", nominalDiameterMm: 2.5, pitchMm: 0.45, diameterMm: 2.05 }]]);
  }, true);
});
