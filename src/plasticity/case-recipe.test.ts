import assert from "node:assert/strict";
import { test } from "node:test";

import * as recipeModule from "./case-recipe.ts";
import {
  BOARD_CASE_LIMITS,
  BOARD_CASE_PRINTABILITY_SCOPE,
  BoardCaseRecipe,
  BoardCaseRecipeError,
  BoardCaseValidationError,
  countBoardCaseSteps,
  deriveBoardCase,
  lipCornerPieceMm,
  maxBossOverhangDeg,
  planBoardCase,
  requireBoardCaseInvariants,
  roundedRectInsideDistance,
  type BoardCaseFinding,
  type BoardCaseInput,
  type BoardCaseOperations,
  type BoardCasePlan,
  type BoardCaseWebSolid,
} from "./case-recipe.ts";

// The round 4 exports are read through the module namespace, so that against an older recipe each test that needs them
// fails on its own instead of the whole file failing to load.
const { boardCaseShortEdges, boardCaseTangencies } = recipeModule as unknown as { boardCaseShortEdges: (plan: BoardCasePlan) => BoardCaseFinding[]; boardCaseTangencies: (plan: BoardCasePlan) => BoardCaseFinding[] };
import { CALLER_SOURCE, CLEARANCE_HOLE_SOURCE, COUNTERSUNK_HEAD_SOURCE, HEAT_SET_INSERT_SOURCE } from "./fastener-presets.ts";
import type { RuntimeState } from "./runtime.ts";

type V3 = [number, number, number];

// ---------------------------------------------------------------------------------------------------- fake runtime
// Bodies, regions and an undo history; every mutation checks the revision it is given, records itself and can fail.
// Bodies carry native-style bounds (boxes, cylinders, cones and extrusions; a union grows the target, an intersection
// clips it, a move shifts it) so the recipe's read-back can compare them with the plan. validateBodies is a read, not a
// recorded call.
function fakeRuntime(options: { fail?: (operation: string, index: number) => Error | undefined; failUndo?: (index: number) => Error | undefined; keepTools?: (index: number) => boolean; noRegion?: (index: number) => boolean; sharedSketch?: boolean; invalid?: (id: number) => boolean; shortEdge?: (id: number) => boolean; skipMove?: boolean; flipProfile?: (index: number) => boolean } = {}) {
  let revision = 0;
  let nextId = 100;
  let bodies: RuntimeState["bodies"] = [solid(1, "existing", [])];
  let regions: RuntimeState["regions"] = [];
  const history: Array<{ bodies: RuntimeState["bodies"]; regions: RuntimeState["regions"] }> = [];
  const calls: Array<{ operation: string; args: unknown[] }> = [];
  let undoCalls = 0;
  let reads = 0;
  let validations = 0;
  const snapshot = (): RuntimeState => ({
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: `r${revision}`, dbVersion: revision,
    undoDepth: history.length, redoDepth: 0, construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" },
    regions: structuredClone(regions), bodies: structuredClone(bodies).map((body) => options.shortEdge?.(body.id) ? { ...body, edges: [...body.edges, line(`short-${body.id}`, [1, 0, 0], 0.01)] } : body),
  });
  const mutate = (operation: string, args: unknown[], given: string | undefined, apply: () => void): RuntimeState => {
    calls.push({ operation, args });
    if (given !== undefined && given !== `r${revision}`) throw new Error(`Stale reference: expected revision ${given}, current revision is r${revision}`);
    const failure = options.fail?.(operation, calls.length);
    if (failure) throw failure;
    history.push({ bodies: structuredClone(bodies), regions: structuredClone(regions) });
    apply();
    revision += 1;
    return snapshot();
  };
  const withBounds = (body: RuntimeState["bodies"][number], boundsMm: RuntimeState["bodies"][number]["boundsMm"]) => ({ ...body, boundsMm });
  const operations = {
    async state() { reads += 1; return snapshot(); },
    async createBox(originMm: V3, sizeMm: V3, name: string | undefined, given: string) {
      return mutate("createBox", [originMm, sizeMm, name ?? null], given, () => { bodies.push(withBounds(solid(nextId++, name ?? null, boxEdges(nextId)), { min: [...originMm], max: originMm.map((value, axis) => value + sizeMm[axis]!) as V3 })); });
    },
    async createCylinder(centerMm: V3, radiusMm: number, heightMm: number, _name: string | undefined, given: string, axis: V3) {
      return mutate("createCylinder", [centerMm, radiusMm, heightMm, axis], given, () => { bodies.push(withBounds(solid(nextId++, null, []), axialBounds(centerMm, axis, heightMm, radiusMm))); });
    },
    async fillet(id: number, edgeIds: string[], radiusMm: number, given: string) {
      return mutate("fillet", [id, edgeIds, radiusMm], given, () => {});
    },
    async boolean(targetIds: number[], toolIds: number[], kind: string, keepTools: boolean, given: string) {
      return mutate("boolean", [targetIds, toolIds, kind, keepTools], given, () => {
        const target = bodies.find((body) => body.id === targetIds[0]);
        const tools = bodies.filter((body) => toolIds.includes(body.id) && body.boundsMm);
        if (target?.boundsMm && kind === "union") for (const tool of tools) target.boundsMm = { min: target.boundsMm.min.map((value, axis) => Math.min(value, tool.boundsMm!.min[axis]!)) as V3, max: target.boundsMm.max.map((value, axis) => Math.max(value, tool.boundsMm!.max[axis]!)) as V3 };
        if (target?.boundsMm && kind === "intersection") for (const tool of tools) target.boundsMm = { min: target.boundsMm.min.map((value, axis) => Math.max(value, tool.boundsMm!.min[axis]!)) as V3, max: target.boundsMm.max.map((value, axis) => Math.min(value, tool.boundsMm!.max[axis]!)) as V3 };
        if (!options.keepTools?.(calls.length)) bodies = bodies.filter((body) => !toolIds.includes(body.id));
      });
    },
    // A pointed cone leaves its profile Wire and one Solid, like the native command.
    async createCone(bottomCenterMm: V3, bottomRadiusMm: number, topRadiusMm: number, heightMm: number, axis: V3, radialDirection: V3, _name: string | undefined, given: string) {
      return mutate("createCone", [bottomCenterMm, bottomRadiusMm, topRadiusMm, heightMm, axis, radialDirection], given, () => {
        bodies.push({ ...solid(nextId++, null, []), type: "Wire" });
        bodies.push(withBounds(solid(nextId++, null, []), axialBounds(bottomCenterMm, axis, heightMm, Math.max(bottomRadiusMm, topRadiusMm))));
      });
    },
    async createPolyline(pointsMm: V3[], closed: boolean, given: string) {
      return mutate("createPolyline", [pointsMm, closed], given, () => {
        const id = nextId++;
        bodies.push({ ...solid(id, null, []), type: "Wire" });
        if (options.noRegion?.(calls.length)) return;
        const min = [0, 1, 2].map((axis) => Math.min(...pointsMm.map((point) => point[axis]!))) as V3;
        const max = [0, 1, 2].map((axis) => Math.max(...pointsMm.map((point) => point[axis]!))) as V3;
        // Like Plasticity (live-verified, round 4): a closed profile's plane normal comes from the corner at its first
        // point (last point, first point, second point); an open one from its first three points.
        const natural = closed && pointsMm.length > 3 ? unit(cross(sub(pointsMm[0]!, pointsMm.at(-1)!), sub(pointsMm[1]!, pointsMm[0]!))) : unit(cross(sub(pointsMm[1]!, pointsMm[0]!), sub(pointsMm[2]!, pointsMm[0]!)));
        // flipProfile: a renderer that takes the other normal for this profile (it then extrudes the wrong way).
        const normal = options.flipProfile?.(calls.length) ? natural.map((value) => -value) as V3 : natural;
        // sharedSketch: like Plasticity, coplanar Wires share one sketch, so every Region on that plane lists all of them.
        const planeKey = [...normal.map((value) => Math.round(Math.abs(value) * 1e6)), Math.round(Math.abs(normal[0] * pointsMm[0]![0] + normal[1] * pointsMm[0]![1] + normal[2] * pointsMm[0]![2]) * 1e6)].join(":");
        const coplanar = options.sharedSketch ? regions.filter((region) => (region as unknown as { planeKey: string }).planeKey === planeKey) : [];
        const wireIds = [...new Set([...coplanar.flatMap((region) => region.sketchWireIds), id])];
        for (const region of coplanar) region.sketchWireIds = wireIds;
        regions.push({ id: `region-${id}`, entityId: id, islandVersionId: id, sketchId: id, sketchWireIds: wireIds, measurementSource: "render-mesh", displayBoundsMm: { min, max }, normal, planeKey } as unknown as RuntimeState["regions"][number]);
      });
    },
    async extrudeRegions(regionIds: string[], distanceMm: number, given: string) {
      return mutate("extrudeRegions", [regionIds, distanceMm], given, () => {
        const region = regions.find((candidate) => candidate.id === regionIds[0]) as unknown as { normal: V3; displayBoundsMm: { min: V3; max: V3 } };
        const far = { min: region.displayBoundsMm.min.map((value, axis) => value + region.normal[axis]! * distanceMm) as V3, max: region.displayBoundsMm.max.map((value, axis) => value + region.normal[axis]! * distanceMm) as V3 };
        bodies.push(withBounds(solid(nextId++, null, [0, 1, 2, 3].map((index) => line(`x${nextId}-${index}`, region.normal))), { min: region.displayBoundsMm.min.map((value, axis) => Math.min(value, far.min[axis]!)) as V3, max: region.displayBoundsMm.max.map((value, axis) => Math.max(value, far.max[axis]!)) as V3 }));
      });
    },
    async revolveProfile(id: number, axisOriginMm: V3, axis: V3, angleDegrees: number, given: string) {
      return mutate("revolveProfile", [id, axisOriginMm, axis, angleDegrees], given, () => { bodies.push(solid(nextId++, null, [])); });
    },
    async remove(ids: number[], given: string) {
      return mutate("remove", [ids], given, () => {
        bodies = bodies.filter((body) => !ids.includes(body.id));
        // A Region goes with its own Wire; coplanar Regions forget the removed Wire.
        regions = regions.filter((region) => !ids.includes(region.entityId)).map((region) => ({ ...region, sketchWireIds: region.sketchWireIds.filter((id) => !ids.includes(id)) }));
      });
    },
    async move(ids: number[], deltaMm: V3, given: string) {
      return mutate("move", [ids, deltaMm], given, () => {
        if (options.skipMove) return;
        for (const body of bodies) if (ids.includes(body.id) && body.boundsMm) body.boundsMm = { min: body.boundsMm.min.map((value, axis) => value + deltaMm[axis]!) as V3, max: body.boundsMm.max.map((value, axis) => value + deltaMm[axis]!) as V3 };
      });
    },
    async validateBodies(ids: number[], given: string) {
      if (given !== `r${revision}`) throw new Error("stale validate");
      validations += 1;
      return { documentToken: "doc-1", revision: given, measurementSource: "native-brep", bodies: ids.map((id) => ({ id, closed: !options.invalid?.(id), nativeValid: !options.invalid?.(id), printableSolid: !options.invalid?.(id), nativeCheckCodes: options.invalid?.(id) ? [1] : [] })) };
    },
    async rename(id: number, name: string, given: string) { return mutate("rename", [id, name], given, () => { bodies.find((body) => body.id === id)!.name = name; }); },
    async undo(given?: string) {
      undoCalls += 1;
      if (given !== undefined && given !== `r${revision}`) throw new Error("stale undo");
      const failure = options.failUndo?.(undoCalls);
      if (failure) throw failure;
      const last = history.pop();
      if (last) { bodies = last.bodies; regions = last.regions; }
      revision += 1;
      return snapshot();
    },
    async rectangularPattern() { throw new Error("unexpected rectangular pattern"); },
    async createPipes() { throw new Error("unexpected pipe"); },
  };
  return { operations: operations as unknown as BoardCaseOperations, calls, get undoCalls() { return undoCalls; }, get reads() { return reads; }, get validations() { return validations; }, snapshot };
}

function solid(id: number, name: string | null, edges: RuntimeState["bodies"][number]["edges"]): RuntimeState["bodies"][number] {
  return { id, versionId: id, type: "Solid", name, boundsMm: null, faceIds: [], edgeIds: edges.map((edge) => edge.id), faces: [], edges };
}
function line(id: string, tangent: V3, lengthMm = 1): RuntimeState["bodies"][number]["edges"][number] {
  return { id, curveType: "Line", line: true, circle: false, lengthMm, centerMm: [0, 0, 0], tangent, boundsMm: { min: [0, 0, 0], max: [0, 0, 0] }, faceIds: [], vertexIds: [] };
}
// Bounds of an axis-aligned cylinder or cone from its base centre along the axis.
function axialBounds(center: V3, axis: V3, height: number, radius: number): { min: V3; max: V3 } {
  const end = center.map((value, index) => value + axis[index]! * height) as V3;
  const along = (index: number) => Math.abs(axis[index]!) > 0.5;
  return {
    min: center.map((value, index) => along(index) ? Math.min(value, end[index]!) : value - radius) as V3,
    max: center.map((value, index) => along(index) ? Math.max(value, end[index]!) : value + radius) as V3,
  };
}
function boxEdges(seed: number) {
  return [
    ...[0, 1, 2, 3].map((index) => line(`v${seed}-${index}`, [0, 0, 1])),
    ...[0, 1, 2, 3].map((index) => line(`a${seed}-${index}`, [1, 0, 0])),
    ...[0, 1, 2, 3].map((index) => line(`b${seed}-${index}`, [0, 1, 0])),
  ];
}
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const length = Math.hypot(...a); return a.map((value) => value / length) as V3; };
const rounded = (value: unknown): unknown => typeof value === "number" ? Math.round(value * 1e6) / 1e6 + 0 : Array.isArray(value) ? value.map(rounded) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rounded(item)])) : value;

const r6 = (value: number) => Math.round(value * 1e6) / 1e6 + 0;
const r3 = (value: number) => Math.round(value * 1e3) / 1e3 + 0;
// Inner corner radius (R3, the round-1 rule): min(outer radius - wall, board clearance).
const innerRadius = (outer: number, wall: number, clearance: number) => Math.min(Math.max(0, outer - wall), clearance);
// Web calls (a box 1, a profile loop 2, plus one join) and web bodies (a box 1, a loop 2: profile Wire and Solid) a plan
// adds (R4; round 4: the webs of one height are joined in plan view, one solid per outline loop).
const webCalls = (input: BoardCaseInput) => { const solids = planBoardCase(input).webSolids; return solids.length === 0 ? 0 : solids.reduce((sum, solid) => sum + (solid.box ? 1 : 2), 0) + 1; };
const webBodies = (input: BoardCaseInput) => planBoardCase(input).webSolids.reduce((sum, solid) => sum + (solid.box ? 1 : 2), 0);
// ------------------------------------------------------------------------------------------------- reference input
const REF: BoardCaseInput = {
  originMm: [0, 0, 0],
  board: { lengthMm: 30, widthMm: 20, holes: [{ xMm: 3, yMm: 3, diameterMm: 2.5 }, { xMm: 27, yMm: 17, diameterMm: 2.5 }], componentHeightMm: 5 },
  standoffs: { heightMm: 3, fastener: { screw: "M2.5", mode: "pilot", pilotDiameterMm: 2 } },
  lid: { fasteners: { screw: "M3", base: "pilot", pilotDiameterMm: 2.5, pilotDepthMm: 5, bossStyle: "hanging", allowBlockedBoard: true } },
  openings: [{ wall: "y+", shape: "rect", widthMm: 8, heightMm: 3, alongMm: 15, aboveBoardMm: 1, label: "port" }],
  vents: { on: "lid", slots: 2, slotWidthMm: 1.5, slotLengthMm: 6, pitchMm: 4 },
  boardStandIn: true,
  name: "ref",
  revision: "r0",
};
const with_ = (patch: (input: BoardCaseInput) => void): BoardCaseInput => { const input = structuredClone(REF); patch(input); return input; };

const BENCHMARK: BoardCaseInput = {
  originMm: [2000, 0, 0],
  board: { lengthMm: 51.5, widthMm: 28.3, holes: [[2.6, 2.6], [48.9, 2.6], [2.6, 25.7], [48.9, 25.7]].map(([xMm, yMm]) => ({ xMm: xMm!, yMm: yMm!, diameterMm: 3 })), componentHeightMm: 8 },
  standoffs: { heightMm: 4, fastener: { screw: "M3", mode: "pilot", pilotDiameterMm: 2.5 } },
  lid: { fasteners: { screw: "M3", base: "pilot", pilotDiameterMm: 2.5, pilotDepthMm: 6, bossStyle: "hanging", allowBlockedBoard: true } },
  openings: [{ wall: "x-", shape: "rounded-rect", widthMm: 9.2, heightMm: 3.4, cornerRadiusMm: 1.2, alongMm: 14.15, aboveBoardMm: 1.6, label: "usb" }],
  vents: { on: "lid", slots: 5, slotWidthMm: 2, slotLengthMm: 12, pitchMm: 4 },
  boardStandIn: true,
  revision: "r0",
};
const AUDIT: BoardCaseInput = {
  originMm: [0, 0, 0],
  board: { lengthMm: 75, widthMm: 45, holes: [[4, 4], [71, 4], [4, 41], [71, 41]].map(([xMm, yMm]) => ({ xMm: xMm!, yMm: yMm!, diameterMm: 2.7 })), componentHeightMm: 10.4 },
  standoffs: { heightMm: 5, outerDiameterMm: 7.5, fastener: { screw: "M2.5", mode: "heat-set-insert" } },
  lid: { fasteners: { screw: "M3", base: "heat-set-insert", insertLengthMm: 3, bossDiameterMm: 8, bossStyle: "hanging", allowBlockedBoard: true } },
  revision: "r0",
};
const POD: BoardCaseInput = { originMm: [0, 0, 0], board: { lengthMm: 17.8, widthMm: 15.2, componentHeightMm: 3 }, fit: { boardClearanceMm: 0.15 }, revision: "r0" };

// ------------------------------------------------------------------------------------------------- derived formulas
test("derived dimensions follow the stated formulas (table of cases)", () => {
  const table: Array<{ name: string; input: BoardCaseInput; expected: Record<string, unknown> }> = [
    {
      name: "audit enclosure equivalent: 76 x 46 cavity, 80 x 50 x 25 base",
      input: AUDIT,
      expected: {
        outerMm: { min: [0, 0, 0], max: [80, 50, 25] }, cavityMm: { min: [2, 2, 2], max: [78, 48, 25] }, innerCornerRadiusMm: 0.5,
        floorTopZMm: 2, boardTopZMm: 8.6, componentTopZMm: 19, wallTopZMm: 25, lidTopZMm: 27, explodedMm: 0,
        boardMm: { min: [2.5, 2.5, 7], max: [77.5, 47.5, 8.6] },
        standoffAxesMm: [[6.5, 6.5], [73.5, 6.5], [6.5, 43.5], [73.5, 43.5]], standoffTopZMm: 7,
        lidBossAxesMm: [[5.5, 5.5], [74.5, 5.5], [5.5, 44.5], [74.5, 44.5]], lidBossBottomZMm: 20,
        lipOuterMm: { min: [2.2, 2.2, 23.5], max: [77.8, 47.8, 25] }, lipInnerMm: { min: [3.4, 3.4, 23.5], max: [76.6, 46.6, 25] },
      },
    },
    {
      name: "multi-part benchmark board",
      input: BENCHMARK,
      expected: {
        outerMm: { min: [2000, 0, 0], max: [2056.5, 33.3, 23.6] }, cavityMm: { min: [2002, 2, 2], max: [2054.5, 31.3, 23.6] },
        floorTopZMm: 2, boardTopZMm: 7.6, componentTopZMm: 15.6, wallTopZMm: 23.6, lidTopZMm: 25.6,
        standoffAxesMm: [[2005.1, 5.1], [2051.4, 5.1], [2005.1, 28.2], [2051.4, 28.2]],
        lidBossAxesMm: [[2004.5, 4.5], [2052, 4.5], [2004.5, 28.8], [2052, 28.8]], lidBossBottomZMm: 16.6,
        openings: [{ label: "usb", wall: "x-", shape: "rounded-rect", centerMm: [2000, 16.65, 10.9], sizeMm: [9.2, 3.4], cornerRadiusMm: 1.2 }],
      },
    },
    {
      // Round 4 (D2): a board with no holes has no standoffs and rests on the floor top (it floated 2 mm up before).
      name: "sensor pod: no holes, no standoffs, lid without screws",
      input: POD,
      expected: {
        outerMm: { min: [0, 0, 0], max: [22.1, 19.5, 9.1] }, cavityMm: { min: [2, 2, 2], max: [20.1, 17.5, 9.1] }, innerCornerRadiusMm: 0.15,
        boardMm: { min: [2.15, 2.15, 2], max: [19.95, 17.35, 3.6] }, wallTopZMm: 9.1, lidTopZMm: 11.1,
        standoffAxesMm: [], lidBossAxesMm: [], lipOuterMm: { min: [2.2, 2.2, 7.6], max: [19.9, 17.3, 9.1] }, openings: [], fasteners: {},
      },
    },
    {
      name: "exploded lid: lid features move up, the base stays",
      input: { ...POD, exploded: 10 },
      expected: { outerMm: { min: [0, 0, 0], max: [22.1, 19.5, 9.1] }, lidTopZMm: 21.1, explodedMm: 10, lipOuterMm: { min: [2.2, 2.2, 17.6], max: [19.9, 17.3, 19.1] } },
    },
  ];
  for (const { name, input, expected } of table) {
    const derived = deriveBoardCase(input) as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(rounded(derived[key]), value, `${name}: ${key}`);
  }
});

test("the heights obey wallTop = floorTop + support + board + parts + 1 + max(lip, boss length) and the cavity is board + 2 x clearance", () => {
  for (const input of [REF, BENCHMARK, AUDIT, POD, with_((value) => { value.lid = { lipDepthMm: 4 }; })]) {
    const derived = deriveBoardCase(input);
    // Round 4 (D2): a board with holes always gets standoffs (default height = the underside clearance); one without
    // holes rests on the floor top (support 0).
    const support = input.standoffs ? input.standoffs.heightMm ?? input.board.undersideClearanceMm ?? 2 : (input.board.holes?.length ?? 0) > 0 ? input.board.undersideClearanceMm ?? 2 : 0;
    const boss = derived.fasteners.lid?.bossLengthMm ?? 0;
    const lip = input.lid?.lipDepthMm ?? 1.5;
    const expectedWall = derived.floorTopZMm + support + (input.board.thicknessMm ?? 1.6) + input.board.componentHeightMm + 1 + Math.max(lip, boss);
    assert.ok(Math.abs(derived.wallTopZMm - expectedWall) < 1e-9);
    const clearance = input.fit?.boardClearanceMm ?? 0.5;
    assert.ok(Math.abs(derived.cavityMm.max[0] - derived.cavityMm.min[0] - input.board.lengthMm - 2 * clearance) < 1e-9);
    assert.ok(Math.abs(derived.cavityMm.max[1] - derived.cavityMm.min[1] - input.board.widthMm - 2 * clearance) < 1e-9);
    assert.ok(Math.abs(derived.outerMm.max[0] - derived.outerMm.min[0] - (derived.cavityMm.max[0] - derived.cavityMm.min[0]) - 2 * (input.walls?.wallMm ?? 2)) < 1e-9);
    const lc = input.fit?.lidClearanceMm ?? 0.2;
    assert.ok(Math.abs(derived.lipOuterMm.min[0] - derived.cavityMm.min[0] - lc) < 1e-9);
    assert.ok(Math.abs(derived.cavityMm.max[1] - derived.lipOuterMm.max[1] - lc) < 1e-9);
    assert.ok(derived.lipOuterMm.min[2] - derived.componentTopZMm >= 1 - 1e-9);
    if (derived.lidBossBottomZMm !== undefined) assert.ok(derived.lidBossBottomZMm - derived.componentTopZMm >= 1 - 1e-9);
  }
});

// ------------------------------------------------------------------------------------------------- preset echo
test("every preset value a build uses is echoed in derived.fasteners with its source", () => {
  const audit = deriveBoardCase(AUDIT).fasteners;
  assert.deepEqual(audit.standoffs, { screw: "M2.5", mode: "heat-set-insert", holeDiameterMm: 4, holeDepthMm: 5, outerDiametersMm: [7.5, 7.5, 7.5, 7.5], heightMm: 5, source: HEAT_SET_INSERT_SOURCE, confidence: "medium", insert: "M2.5x4", minWallMm: 1.6 });
  assert.deepEqual(audit.lid, {
    screw: "M3", screwReason: "lid.fasteners.screw", base: "heat-set-insert", bossDiameterMm: 8, bossLengthMm: 5,
    baseHole: { diameterMm: 4, depthMm: 4, source: HEAT_SET_INSERT_SOURCE, confidence: "medium", insert: "M3x3", minWallMm: 1.6 },
    lidHole: { diameterMm: 3.4, fit: "medium", source: CLEARANCE_HOLE_SOURCE, confidence: "medium" },
    countersink: { headDiameterMm: 6.72, includedAngleDeg: 90, depthMm: 1.66, source: COUNTERSUNK_HEAD_SOURCE, confidence: "medium" },
  });
  const benchmark = deriveBoardCase(BENCHMARK).fasteners;
  assert.equal(benchmark.standoffs?.source, CALLER_SOURCE);
  assert.equal(benchmark.standoffs?.holeDiameterMm, 2.5);
  assert.equal(benchmark.lid?.baseHole.source, CALLER_SOURCE);
  const through = deriveBoardCase(with_((value) => { value.standoffs = { heightMm: 3, fastener: { screw: "M2.5", mode: "through", clearanceFit: "free" } }; })).fasteners.standoffs;
  assert.deepEqual(through, { screw: "M2.5", mode: "through", holeDiameterMm: 3.1, holeDepthMm: 5, outerDiametersMm: [5.5, 5.5], heightMm: 3, source: CLEARANCE_HOLE_SOURCE, confidence: "medium", clearanceFit: "free" });
  const explicitHead = deriveBoardCase(with_((value) => { value.lid!.fasteners = { screw: "M2.5", base: "pilot", pilotDiameterMm: 2, pilotDepthMm: 4, headDiameterMm: 5 }; })).fasteners.lid?.countersink;
  assert.deepEqual(explicitHead, { headDiameterMm: 5, includedAngleDeg: 90, depthMm: 1.05, source: CALLER_SOURCE });
});

// ------------------------------------------------------------------------------------------------- validation
const REJECTIONS: Array<[string, (input: BoardCaseInput) => void, RegExp]> = [
  ["board length zero", (input) => { input.board.lengthMm = 0; }, /board\.lengthMm must be a positive number/],
  ["negative component height", (input) => { input.board.componentHeightMm = -1; }, /board\.componentHeightMm must be a positive number/],
  ["zero lid clearance", (input) => { input.fit = { lidClearanceMm: 0 }; }, /fit\.lidClearanceMm must be a positive number/],
  ["zero floor", (input) => { input.walls = { floorMm: 0 }; }, /walls\.floorMm must be a positive number/],
  ["lid thinner than the lip joint", (input) => { input.walls = { lidMm: 0.4 }; }, /walls\.lidMm 0\.4 must exceed 0\.5 mm/],
  ["wall below 0.8 mm", (input) => { input.walls = { wallMm: 0.7 }; }, /walls\.wallMm must be at least 0\.8 mm/],
  ["board hole outside the board", (input) => { input.board.holes![0] = { xMm: 1, yMm: 3, diameterMm: 2.5 }; }, /board\.holes\[0\] .* is not inside the 30 x 20 board/],
  ["overlapping board holes", (input) => { input.board.holes![1] = { xMm: 4, yMm: 3, diameterMm: 2.5 }; }, /board\.holes\[0\] and board\.holes\[1\] overlap/],
  ["standoff lower than the underside clearance", (input) => { input.standoffs!.heightMm = 1.5; }, /standoffs\.heightMm 1\.5 is below board\.undersideClearanceMm 2/],
  ["outer corner radius too large", (input) => { input.walls = { outerCornerRadiusMm: 12.5 }; }, /outerCornerRadiusMm 12\.5 must be less than half the outer size/],
  ["wall opening outside the flat wall span", (input) => { input.openings![0]!.alongMm = 29; }, /port on wall y\+ runs from 27\.5 to 35\.5 along it, outside the flat wall span 2\.5 to 32\.5/],
  ["wall opening into the lid lip band", (input) => { input.openings![0]!.aboveBoardMm = 9; }, /port on wall y\+ spans z 15\.6 to 18\.6, outside the open wall band z 2 \(floor top\) to 17\.1/],
  ["wall opening colliding with a standoff", (input) => { input.standoffs!.outerDiameterMm = 7; input.openings = [{ wall: "x-", shape: "rect", widthMm: 2, heightMm: 2, alongMm: 3, aboveBoardMm: -4.4, label: "low" }]; }, /low on wall x- collides with standoff 0/],
  ["wall opening colliding with a lid boss", (input) => { input.openings = [{ wall: "x-", shape: "rect", widthMm: 2, heightMm: 2, alongMm: 2, aboveBoardMm: 7, label: "high" }]; }, /high on wall x- collides with lid boss 0/],
  ["lid opening colliding with a lid boss", (input) => { input.openings = [{ wall: "lid", shape: "rect", widthMm: 2, heightMm: 2, alongMm: 3, acrossMm: 3, label: "window" }]; }, /window on the lid collides with lid boss 0/],
  ["floor opening colliding with a standoff", (input) => { input.openings = [{ wall: "floor", shape: "circle", widthMm: 2, alongMm: 3, acrossMm: 3, label: "drain" }]; }, /drain on the floor collides with standoff 0/],
  ["lid opening outside the lip", (input) => { input.openings = [{ wall: "lid", shape: "rect", widthMm: 2, heightMm: 2, alongMm: -0.5, acrossMm: 10, label: "edge" }]; }, /edge on the lid .* is not inside the area inside the lid lip/],
  ["vent slot overlapping a lid opening", (input) => { input.openings = [{ wall: "lid", shape: "rect", widthMm: 2, heightMm: 2, alongMm: 13, acrossMm: 10 }]; }, /opening 0 and vent slot 0 overlap on the lid/],
  ["vent pitch not above slot width", (input) => { input.vents!.pitchMm = 1.5; }, /vents\.pitchMm 1\.5 must exceed vents\.slotWidthMm 1\.5/],
  ["rounded-rect without a corner radius", (input) => { input.openings![0]!.shape = "rounded-rect"; }, /port: cornerRadiusMm must be a positive number/],
  ["wall opening without aboveBoardMm", (input) => { delete input.openings![0]!.aboveBoardMm; }, /port: a wall opening needs aboveBoardMm/],
  ["countersunk M2.5 without a sourced head", (input) => { input.lid!.fasteners!.screw = "M2.5"; }, /countersunk head diameter for M2\.5 is not sourced/],
  ["pilot standoffs without a pilot diameter", (input) => { delete input.standoffs!.fastener!.pilotDiameterMm; }, /pilot diameter for M2\.5 in plastic is not sourced; pass pilotDiameterMm/],
  ["lid pilot without a pilot depth", (input) => { delete input.lid!.fasteners!.pilotDepthMm; }, /lid\.fasteners\.pilotDepthMm is required with base "pilot"/],
  ["ambiguous M3 insert", (input) => { input.lid!.fasteners = { screw: "M3", base: "heat-set-insert", bossDiameterMm: 8 }; }, /M3 has 2 sourced CNC Kitchen inserts; pass insertLengthMm 5\.7 or 3/],
  // bossDiameterMm 6 pinned: the default boss now grows to the insert wall (R7).
  ["insert boss thinner than the sourced wall", (input) => { input.lid!.fasteners = { screw: "M3", base: "heat-set-insert", insertLengthMm: 5.7, bossDiameterMm: 6 }; }, /lid boss diameter 6 leaves less than the sourced 1\.6 mm insert wall/],
  ["insert deeper than the standoff", (input) => { input.standoffs = { heightMm: 3, outerDiameterMm: 7.5, fastener: { screw: "M2.5", mode: "heat-set-insert" } }; }, /M2\.5x4 insert needs a 5 mm blind hole, deeper than the 3 mm standoff/],
  ["countersink deeper than the lid", (input) => { input.walls = { lidMm: 1.5 }; }, /6\.72 mm countersink is 1\.66 mm deep, not less than walls\.lidMm 1\.5/],
  ["corner bosses overlapping in a small cavity", (input) => { input.board = { lengthMm: 8, widthMm: 8, componentHeightMm: 3 }; delete input.standoffs; delete input.openings; delete input.vents; }, /four 6 mm corner bosses .* overlap each other/],
];

for (const [name, patch, pattern] of REJECTIONS) {
  test(`validation rejects ${name} before any native call`, async () => {
    const input = with_(patch);
    assert.throws(() => planBoardCase(input), pattern);
    const fake = fakeRuntime();
    await assert.rejects(new BoardCaseRecipe(fake.operations).create(input), pattern);
    assert.equal(fake.calls.length, 0, "no native mutation");
    assert.equal(fake.reads, 0, "not even a state read");
  });
}

test("the unmodified reference input passes validation", () => {
  assert.ok(planBoardCase(REF));
});

test("the height invariants reject a lip that is not shorter than the inner height or reaches the component space", () => {
  assert.throws(() => requireBoardCaseInvariants({ lipDepthMm: 5, innerHeightMm: 4, lipBottomZMm: 10, componentTopZMm: 5 }), (error: unknown) => error instanceof BoardCaseValidationError && /lid\.lipDepthMm 5 must be less than the base inner height 4/.test(error.message));
  assert.throws(() => requireBoardCaseInvariants({ lipDepthMm: 1.5, innerHeightMm: 20, lipBottomZMm: 5.5, componentTopZMm: 5 }), /lid lip bottom z 5\.5 reaches into the component space/);
  assert.throws(() => requireBoardCaseInvariants({ lipDepthMm: 1.5, innerHeightMm: 20, lipBottomZMm: 10, componentTopZMm: 5, bossBottomZMm: 5.2 }), /lid boss bottom z 5\.2 reaches into the component space/);
  assert.doesNotThrow(() => requireBoardCaseInvariants({ lipDepthMm: 1.5, innerHeightMm: 20, lipBottomZMm: 10, componentTopZMm: 5, bossBottomZMm: 6 }));
});

test("a stale revision is refused after one read, with no mutation", async () => {
  const fake = fakeRuntime();
  await assert.rejects(new BoardCaseRecipe(fake.operations).create({ ...REF, revision: "r7" }), /Stale reference: expected revision r7, current revision is r0/);
  assert.equal(fake.calls.length, 0);
});

// ------------------------------------------------------------------------------------------------- composition
test("the reference case composes the shell, the existing recipes and the cleanup in order, with exact arguments", async () => {
  const fake = fakeRuntime();
  const result = await new BoardCaseRecipe(fake.operations).create(REF);
  const names = fake.calls.map((entry) => entry.operation === "boolean" ? `boolean:${(entry.args[2] as string)}` : entry.operation);
  const repeat = (list: string[], count: number) => Array.from({ length: count }, () => list).flat();
  assert.deepEqual(names, [
    // base shell
    "createBox", "fillet", "createBox", "fillet", "boolean:difference",
    // R4 webs: each standoff is 0.75 mm from two walls (two wall boxes and a corner box, joined in plan view into one
    // L-shaped profile each: round 4), each boss leaves a 0.33 mm corner pocket (a corner box each): two profile loops,
    // four boxes, one join
    ...repeat(["createPolyline", "extrudeRegions"], 2), ...repeat(["createBox"], 4), "boolean:union",
    // standoffs (screw boss pattern: bosses, union, pilots, difference)
    ...repeat(["createCylinder"], 2), "boolean:union", ...repeat(["createCylinder"], 2), "boolean:difference",
    // corner bosses for the lid screws
    ...repeat(["createCylinder"], 4), "boolean:union", ...repeat(["createCylinder"], 4), "boolean:difference",
    // lid plate, lip block, lip inner cutter (square: no fillet), four notches, ring, join
    "createBox", "fillet", "createBox", "fillet", "createBox", ...repeat(["createCylinder"], 4), "boolean:difference", "boolean:union",
    // countersink pattern
    ...repeat(["createCylinder", "createPolyline", "revolveProfile"], 4), "boolean:difference",
    // rect opening (connector opening without fillet)
    "createPolyline", "extrudeRegions", "boolean:difference",
    // two vent slots (slotted hole pattern)
    ...repeat(["createPolyline", "extrudeRegions", "createCylinder", "createCylinder"], 2), "boolean:difference",
    // board stand-in and its holes
    "createBox", "createCylinder", "createCylinder", "boolean:difference",
    // construction Wires in one delete
    "remove",
  ]);
  // Calls after the base shell sit W = 9 later (the R4 web stage); the eight web bodies (two profile Wires, two loop
  // solids, four boxes) shift later body ids by N = 8.
  const W = 9;
  const N = 8;
  // The two web profiles: counter-clockwise L shapes from 0.2 mm inside both walls to the standoff axis and its far
  // tangents, at z 1.5 (0.5 mm into the floor), extruded 3.5 mm up to the standoff top.
  assert.deepEqual(rounded(fake.calls[5]!.args), [[[5.5, 8.25, 1.5], [1.8, 8.25, 1.5], [1.8, 1.8, 1.5], [8.25, 1.8, 1.5], [8.25, 5.5, 1.5], [5.5, 5.5, 1.5]], true]);
  assert.deepEqual((fake.calls[6]!.args as unknown[])[1], 3.5);
  const at = (index: number) => rounded(fake.calls[index < 5 ? index : index + W]!.args);
  assert.deepEqual(at(0), [[0, 0, 0], [35, 25, 18.6], "ref-base"]);
  assert.deepEqual(at(1), [100, ["v101-0", "v101-1", "v101-2", "v101-3"], 3]);
  assert.deepEqual(at(2), [[2, 2, 2], [31, 21, 17.1], null]);
  assert.deepEqual(at(3), [101, ["v102-0", "v102-1", "v102-2", "v102-3"], 0.5]);
  assert.deepEqual(at(4), [[100], [101], "difference", false]);
  // standoff bosses start 0.5 mm into the floor; pilots are cut from the top down to the floor top
  assert.deepEqual(at(5), [[5.5, 5.5, 1.5], 2.75, 3.5, [0, 0, 1]]);
  assert.deepEqual(at(6), [[29.5, 19.5, 1.5], 2.75, 3.5, [0, 0, 1]]);
  assert.deepEqual(at(8), [[5.5, 5.5, 5.5], 1, 3.5, [0, 0, -1]]);
  // corner bosses hang from the walls: z 12.6 (component top 11.6 + 1) to the wall top 18.6
  assert.deepEqual(at(11), [[4.5, 4.5, 12.6], 3, 6, [0, 0, 1]]);
  assert.deepEqual(at(14), [[30.5, 20.5, 12.6], 3, 6, [0, 0, 1]]);
  assert.deepEqual(at(16), [[4.5, 4.5, 19.1], 1.25, 5.5, [0, 0, -1]]);
  // lid plate on the wall top, lip block 0.5 mm into the plate, square inner cutter, notch cutters r = boss + 0.2
  assert.deepEqual(at(21), [[0, 0, 18.6], [35, 25, 2], "ref-lid"]);
  assert.deepEqual(at(22), [114 + N, [`v${115 + N}-0`, `v${115 + N}-1`, `v${115 + N}-2`, `v${115 + N}-3`], 3]);
  assert.deepEqual(at(23), [[2.2, 2.2, 17.1], [30.6, 20.6, 2], null]);
  assert.deepEqual(at(24), [115 + N, [`v${116 + N}-0`, `v${116 + N}-1`, `v${116 + N}-2`, `v${116 + N}-3`], 0.3]);
  assert.deepEqual(at(25), [[3.4, 3.4, 16.6], [28.2, 18.2, 3], null]);
  assert.deepEqual(at(26), [[4.5, 4.5, 16.6], 3.2, 3, [0, 0, 1]]);
  assert.deepEqual(at(30), [[115 + N], [116, 117, 118, 119, 120].map((id) => id + N), "difference", false]);
  assert.deepEqual(at(31), [[114 + N], [115 + N], "union", false]);
  // countersink: Ø3.4 medium clearance through the 2 mm lid, Ø6.72 x 90° head
  assert.deepEqual(at(32), [[4.5, 4.5, 21.1], 1.7, 3, [0, 0, -1]]);
  assert.deepEqual(rounded(fake.calls[33 + W]!.args[0]), [[6.2, 4.5, 21.1], [7.86, 4.5, 21.1], [7.86, 4.5, 20.6], [6.2, 4.5, 18.94]]);
  assert.deepEqual((at(34) as unknown[]).slice(1), [[4.5, 4.5, 20.6], [0, 0, -1], 360]);
  // y+ wall opening: centre x = 2.5 + 15, bottom z = 6.6 + 1, profile 0.5 mm outside the outer face y = 25, cut 2 + 1 mm deep
  assert.deepEqual(rounded(fake.calls[45 + W]!.args[0]), [[13.5, 25.5, 7.6], [21.5, 25.5, 7.6], [21.5, 25.5, 10.6], [13.5, 25.5, 10.6]]);
  assert.deepEqual((at(46) as unknown[]).slice(1), [3]);
  // board stand-in on the standoffs
  assert.deepEqual(at(57), [[2.5, 2.5, 5], [30, 20, 1.6], "ref-board"]);
  assert.deepEqual(at(58), [[5.5, 5.5, 7.1], 1.25, 2.6, [0, 0, -1]]);
  const wires = fake.calls.filter((entry) => entry.operation === "createPolyline").length;
  assert.equal((fake.calls.at(-1)!.args[0] as number[]).length, wires);

  assert.equal(result.recipe, "board-case");
  assert.deepEqual(result.derived, planBoardCase(REF).derived);
  assert.equal(result.undoSteps, fake.calls.length);
  assert.equal(result.undoSteps, result.derived.plannedUndoSteps);
  assert.equal(result.steps.length, fake.calls.length);
  assert.deepEqual([...new Set(result.steps.map((entry) => entry.stage))], ["base-shell", "webs", "standoffs", "lid-bosses", "lid-shell", "lid-screw-holes", "opening:port", "vents", "board-stand-in", "cleanup"]);
  const final = fake.snapshot();
  assert.deepEqual(final.bodies.map((body) => [body.id, body.type, body.name]), [[1, "Solid", "existing"], [100, "Solid", "ref-base"], [114 + N, "Solid", "ref-lid"], [143 + N, "Solid", "ref-board"]]);
  assert.deepEqual(result.bodies, { baseId: 100, lidId: 114 + N, boardId: 143 + N });
  assert.deepEqual(result.resultBodyIds, [100, 114 + N, 143 + N]);
  assert.equal(final.regions.length, 0, "no construction Regions left");
});

test("an exploded lid adds one move step; a case without fasteners skips the bosses, notches and lid holes", async () => {
  const fake = fakeRuntime();
  const result = await new BoardCaseRecipe(fake.operations).create({ ...POD, exploded: 12 });
  assert.deepEqual(fake.calls.map((entry) => entry.operation), ["createBox", "fillet", "createBox", "fillet", "boolean", "createBox", "fillet", "createBox", "createBox", "boolean", "boolean", "move"]);
  assert.deepEqual(fake.calls.at(-1)!.args, [[result.bodies.lidId], [0, 0, 12]]);
  assert.equal(result.undoSteps, 12);
  assert.equal(result.undoSteps, result.derived.plannedUndoSteps);
  assert.equal(result.bodies.boardId, undefined);
});

// ------------------------------------------------------------------------------------------------- partial failure
test("a native failure part-way undoes every step the recipe made and names the failed stage", async () => {
  const fake = fakeRuntime({ fail: (operation) => operation === "revolveProfile" ? new Error("Plasticity command failed: revolve rejected") : undefined });
  const before = fake.snapshot();
  const error = await new BoardCaseRecipe(fake.operations).create(REF).then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof BoardCaseRecipeError);
  assert.equal(error.failedStage, "lid-screw-holes");
  assert.equal(error.uncertain, false);
  // 32 steps before the countersink pattern plus the 9 R4 web steps (round 4: two profile loops, four boxes, one join;
  // it was 11), plus its confirmed through cutter and profile
  assert.equal(error.completedSteps.length, 43);
  assert.equal(error.undoneSteps, 43);
  assert.equal(fake.undoCalls, 43);
  assert.equal(error.restored, true);
  assert.match(error.message, /failed in stage "lid-screw-holes" after 43 confirmed native steps; undid 43 native steps; the document matches the start .*revolve rejected/);
  const after = fake.snapshot();
  assert.equal(after.undoDepth, before.undoDepth);
  assert.deepEqual(after.bodies, before.bodies);
  assert.deepEqual(after.regions, before.regions);
  assert.equal(error.lastConfirmedRevision, after.revision);
});

test("a failing first native step leaves nothing to undo", async () => {
  const fake = fakeRuntime({ fail: (_operation, index) => index === 1 ? new Error("Kernel failed") : undefined });
  const error = await new BoardCaseRecipe(fake.operations).create(REF).then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof BoardCaseRecipeError);
  assert.equal(error.failedStage, "base-shell");
  assert.equal(error.undoneSteps, 0);
  assert.equal(error.restored, true);
  assert.equal(fake.undoCalls, 0);
});

test("an uncertain native result is not undone and says to reconcile", async () => {
  const fake = fakeRuntime({ fail: (_operation, index) => index === 10 ? new Error("CDP request timed out: Runtime.evaluate") : undefined });
  const error = await new BoardCaseRecipe(fake.operations).create(REF).then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof BoardCaseRecipeError);
  assert.equal(error.uncertain, true);
  assert.equal(error.undoneSteps, 0);
  assert.equal(error.restored, false);
  assert.equal(fake.undoCalls, 0);
  assert.match(error.message, /uncertain, so nothing was undone; call plasticity_reconcile first/);
});

test("an undo that fails during the rollback is reported, not hidden", async () => {
  const fake = fakeRuntime({
    // The y+ opening's extrude (round 4: the two web profiles are extruded earlier, at calls 7 and 9).
    fail: (operation, index) => operation === "extrudeRegions" && index > 20 ? new Error("extrude failed") : undefined,
    failUndo: (index) => index === 3 ? new Error("undo refused") : undefined,
  });
  const error = await new BoardCaseRecipe(fake.operations).create(REF).then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof BoardCaseRecipeError);
  assert.equal(error.failedStage, "opening:port");
  assert.equal(error.restored, false);
  assert.equal(error.undoneSteps, 2);
  assert.match(error.message, /does not match the start \(undo failed: undo refused\)/);
});

test("a native step whose read-back check fails is still reported and undone", async () => {
  // The cavity Boolean (call 5) lands but leaves its cutter: the recipe must count that step and undo all five.
  const fake = fakeRuntime({ keepTools: (index) => index === 5 });
  const error = await new BoardCaseRecipe(fake.operations).create(REF).then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof BoardCaseRecipeError);
  assert.equal(error.failedStage, "base-shell");
  assert.match(error.message, /bodies were not consumed: 101/);
  assert.equal(error.completedSteps.length, 5);
  assert.equal(error.completedSteps.at(-1)!.operation, "cut-cavity");
  assert.equal(error.undoneSteps, 5);
  assert.equal(error.restored, true);
});

// ------------------------------------------------------------------------------------------------- boss styles
const styled = (base: BoardCaseInput, bossStyle?: "tapered" | "hanging" | "floor"): BoardCaseInput => {
  const input = structuredClone(base);
  if (bossStyle === undefined) delete input.lid!.fasteners!.bossStyle;
  else input.lid!.fasteners!.bossStyle = bossStyle;
  return input;
};
const REACH = 2.5 * Math.SQRT2 + 3; // farthest boss point from its wall corner: bossInset x sqrt 2 + bossRadius (Ø6 boss)
const REACH_BENCH = REACH; // the benchmark uses the same Ø6 bosses
const growX = (input: BoardCaseInput): BoardCaseInput => { const copy = structuredClone(input); copy.lid!.fasteners!.growAxis = "x"; return copy; };
const RISE = 0.5 * (Math.SQRT2 - 1); // lowest cone point inside the 0.5 mm rounded cavity corner above the apex
const LID = (countersunk: boolean, openingCeilings: unknown[] = []) => ({ scope: BOARD_CASE_PRINTABILITY_SCOPE, lidPrintOrientation: "top face down", lidMaxOverhangDeg: countersunk ? 45 : 0, openingCeilings });
const USB_CEILING = [{ label: "usb", wall: "x-", widthMm: 6.8, zMm: 12.6 }]; // 9.2 wide, r1.2 corners: a 6.8 mm flat ceiling

test("derived values per boss style (table, benchmark board and reference board)", () => {
  const table: Array<{ name: string; input: BoardCaseInput; expected: Record<string, unknown> }> = [
    {
      name: "benchmark hanging",
      input: styled(BENCHMARK, "hanging"),
      expected: {
        wallTopZMm: 23.6, lidBossBottomZMm: 16.6, bossStyle: "hanging", boardWallClearanceMm: { xNeg: 0.5, xPos: 0.5, yNeg: 0.5, yPos: 0.5 },
        printability: { baseOrientation: "floor-down", maxBossOverhangDeg: 90, ...LID(true, USB_CEILING) }, outerMm: { min: [2000, 0, 0], max: [2056.5, 33.3, 23.6] },
      },
    },
    {
      name: "benchmark tapered: wall top rises by reach - rise, taper bottom = component top + 1",
      input: styled(BENCHMARK, "tapered"),
      expected: {
        wallTopZMm: 29.928427, lidBossBottomZMm: 22.928427, bossStyle: "tapered", boardWallClearanceMm: { xNeg: 0.5, xPos: 0.5, yNeg: 0.5, yPos: 0.5 },
        bossTaper: { angleDeg: 45, bottomZMm: 16.6, addedHeightMm: 6.328427 },
        printability: { baseOrientation: "floor-down", maxBossOverhangDeg: 45, ...LID(true, USB_CEILING) }, outerMm: { min: [2000, 0, 0], max: [2056.5, 33.3, 29.928427] },
        lidBossAxesMm: [[2004.5, 4.5], [2052, 4.5], [2004.5, 28.8], [2052, 28.8]],
      },
    },
    {
      // growAxis "x" pinned: the benchmark's x- opening would send the default growth to y (B), tested separately.
      name: "benchmark floor: cavity grows 11 mm in x, bosses stand on the floor to the lower wall top",
      input: growX(styled(BENCHMARK, "floor")),
      expected: {
        wallTopZMm: 18.1, lidBossBottomZMm: 2, bossStyle: "floor", cavityGrowthMm: [11, 0], boardWallClearanceMm: { xNeg: 6, xPos: 6, yNeg: 0.5, yPos: 0.5 },
        printability: { baseOrientation: "floor-down", maxBossOverhangDeg: 0, ...LID(true, USB_CEILING) }, outerMm: { min: [2000, 0, 0], max: [2067.5, 33.3, 18.1] },
        cavityMm: { min: [2002, 2, 2], max: [2065.5, 31.3, 18.1] }, boardMm: { min: [2008, 2.5, 6], max: [2059.5, 30.8, 7.6] },
        lidBossAxesMm: [[2004.5, 4.5], [2063, 4.5], [2004.5, 28.8], [2063, 28.8]],
        standoffAxesMm: [[2010.6, 5.1], [2056.9, 5.1], [2010.6, 28.2], [2056.9, 28.2]],
        openings: [{ label: "usb", wall: "x-", shape: "rounded-rect", centerMm: [2000, 16.65, 10.9], sizeMm: [9.2, 3.4], cornerRadiusMm: 1.2 }],
      },
    },
    {
      name: "reference tapered",
      input: styled(REF, "tapered"),
      expected: { wallTopZMm: 24.928427, lidBossBottomZMm: 18.928427, bossTaper: { angleDeg: 45, bottomZMm: 12.6, addedHeightMm: 6.328427 }, outerMm: { min: [0, 0, 0], max: [35, 25, 24.928427] } },
    },
    {
      name: "reference floor: x grows because growing x adds less floor area",
      input: styled(REF, "floor"),
      expected: { wallTopZMm: 14.1, cavityGrowthMm: [11, 0], boardWallClearanceMm: { xNeg: 6, xPos: 6, yNeg: 0.5, yPos: 0.5 }, outerMm: { min: [0, 0, 0], max: [46, 25, 14.1] }, standoffAxesMm: [[11, 5.5], [35, 19.5]] },
    },
    {
      // printability is always present now (H: the lid orientation and opening ceilings concern every case); without lid
      // screws it carries no boss field.
      name: "no lid screws: no boss fields, wall clearance still reported",
      input: POD,
      expected: { boardWallClearanceMm: { xNeg: 0.15, xPos: 0.15, yNeg: 0.15, yPos: 0.15 }, bossStyle: undefined, bossTaper: undefined, cavityGrowthMm: undefined, printability: { baseOrientation: "floor-down", ...LID(false) } },
    },
  ];
  for (const { name, input, expected } of table) {
    const derived = deriveBoardCase(input) as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(rounded(derived[key]), value, `${name}: ${key}`);
  }
  // Only the style that uses a field reports it.
  assert.equal(deriveBoardCase(styled(BENCHMARK, "hanging")).bossTaper, undefined);
  assert.equal(deriveBoardCase(styled(BENCHMARK, "floor")).bossTaper, undefined);
  assert.equal(deriveBoardCase(styled(BENCHMARK, "tapered")).cavityGrowthMm, undefined);
  assert.equal(deriveBoardCase(styled(BENCHMARK, "hanging")).cavityGrowthMm, undefined);
});

test("the default boss style is floor", () => {
  // (bossStyleReason, new in round 3, says "default: ..." for the first and "lid.fasteners.bossStyle" for the second.)
  assert.deepEqual({ ...deriveBoardCase(styled(BENCHMARK)), bossStyleReason: undefined }, { ...deriveBoardCase(styled(BENCHMARK, "floor")), bossStyleReason: undefined });
  assert.equal(deriveBoardCase(styled(BENCHMARK)).bossStyle, "floor");
  assert.deepEqual(planBoardCase(styled(REF)).posts, planBoardCase(styled(REF, "floor")).posts);
  assert.equal(planBoardCase(styled(REF)).taper, undefined);
});

test("the hanging style keeps today's geometry: heights and bosses do not depend on the taper", () => {
  for (const input of [REF, BENCHMARK, AUDIT]) {
    const hanging = deriveBoardCase(input);
    assert.equal(hanging.bossStyle, "hanging");
    const expectedWall = hanging.componentTopZMm + 1 + Math.max(input.lid?.lipDepthMm ?? 1.5, hanging.fasteners.lid!.bossLengthMm);
    assert.ok(Math.abs(hanging.wallTopZMm - expectedWall) < 1e-9);
    assert.equal(hanging.lidBossBottomZMm, r(hanging.wallTopZMm - hanging.fasteners.lid!.bossLengthMm));
  }
});
function r(value: number): number { return Math.round(value * 1e9) / 1e9; }

test("maxBossOverhangDeg is computed from the geometry: 90 hanging, 45 tapered, 0 floor, and it catches a shallow or short cone", () => {
  const base = { bossRadiusMm: 3, bossInsetMm: 2.5, bossBottomZMm: 20, floorTopZMm: 2 };
  assert.equal(maxBossOverhangDeg({ ...base, style: "hanging" }), 90);
  assert.equal(maxBossOverhangDeg({ ...base, style: "tapered" }), 90, "a tapered boss without a cone has a flat underside");
  assert.equal(maxBossOverhangDeg({ ...base, style: "floor", bossBottomZMm: 2 }), 0);
  assert.equal(maxBossOverhangDeg({ ...base, style: "floor", bossBottomZMm: 5 }), 90, "a floor boss that does not reach the floor has an underside");
  assert.ok(Math.abs(maxBossOverhangDeg({ ...base, style: "tapered", taper: { apexZMm: 20 - REACH, topZMm: 20, topRadiusMm: REACH } }) - 45) < 1e-9);
  // a taller cone is steeper: fewer degrees from vertical
  const steep = maxBossOverhangDeg({ ...base, style: "tapered", taper: { apexZMm: 20 - 2 * REACH, topZMm: 20, topRadiusMm: REACH } });
  assert.ok(steep < 45 && Math.abs(steep - (Math.atan(0.5) * 180) / Math.PI) < 1e-9);
  // a cone that is too short for its radius leans more than 45 degrees
  const shallow = maxBossOverhangDeg({ ...base, style: "tapered", taper: { apexZMm: 20 - REACH * 0.8, topZMm: 20, topRadiusMm: REACH } });
  assert.ok(shallow > 45 + 1e-6, `shallow cone gives ${shallow}`);
  // a cone whose top disc does not cover the boss footprint leaves a flat underside
  assert.equal(maxBossOverhangDeg({ ...base, style: "tapered", taper: { apexZMm: 20 - REACH + 1, topZMm: 20, topRadiusMm: REACH - 1 } }), 90);
  // a cone that ends below the boss bottom does not carry it
  assert.equal(maxBossOverhangDeg({ ...base, style: "tapered", taper: { apexZMm: 10 - REACH, topZMm: 10, topRadiusMm: REACH } }), 90);
});

test("derived.printability reports the checked overhang: at most 45 degrees (+1e-6) for tapered and floor, exactly 90 for hanging", () => {
  const inputs = [REF, BENCHMARK, AUDIT, with_((value) => { value.lid!.fasteners!.bossDiameterMm = 9; })];
  for (const input of inputs) {
    for (const style of ["tapered", "floor"] as const) {
      const printability = deriveBoardCase(styled(input, style)).printability!;
      assert.equal(printability.baseOrientation, "floor-down");
      assert.ok(printability.maxBossOverhangDeg! <= 45 + 1e-6, `${style}: ${printability.maxBossOverhangDeg}`);
    }
    assert.equal(deriveBoardCase(styled(input, "hanging")).printability!.maxBossOverhangDeg, 90);
  }
  assert.equal(deriveBoardCase(styled(BENCHMARK, "tapered")).printability!.maxBossOverhangDeg, 45);
  assert.equal(deriveBoardCase(styled(BENCHMARK, "floor")).printability!.maxBossOverhangDeg, 0);
});

test("the taper stays out of the board keep-out: its lowest point is at least component top + 1, and the wall top rises to make it so", () => {
  const cases: Array<[string, BoardCaseInput]> = [
    ["reference", styled(REF, "tapered")],
    ["benchmark", styled(BENCHMARK, "tapered")],
    ["audit, 8 mm bosses", styled(AUDIT, "tapered")],
    ["tall parts", with_((value) => { value.board.componentHeightMm = 25; value.lid!.fasteners!.bossStyle = "tapered"; })],
    ["square outer corners (no rounded cavity corner, apex is exposed)", with_((value) => { value.walls = { outerCornerRadiusMm: 0 }; value.lid!.fasteners!.bossStyle = "tapered"; })],
  ];
  for (const [name, input] of cases) {
    const tapered = deriveBoardCase(input);
    const hanging = deriveBoardCase(styled(input, "hanging"));
    const taper = tapered.bossTaper!;
    assert.ok(taper.bottomZMm >= tapered.componentTopZMm + 1 - 1e-9, `${name}: bottom ${taper.bottomZMm} vs component top ${tapered.componentTopZMm}`);
    assert.ok(Math.abs(taper.bottomZMm - (tapered.componentTopZMm + 1)) < 1e-9, `${name}: the wall top rises by exactly the amount needed`);
    assert.ok(taper.addedHeightMm > 0, `${name}: the headroom had to grow`);
    assert.ok(Math.abs(taper.addedHeightMm - (tapered.wallTopZMm - hanging.wallTopZMm)) < 1e-9, `${name}: addedHeightMm = wall top difference`);
    const rise = (tapered.innerCornerRadiusMm) * (Math.SQRT2 - 1);
    const reach = ((input.lid!.fasteners!.bossDiameterMm ?? 6) / 2 - 0.5) * Math.SQRT2 + (input.lid!.fasteners!.bossDiameterMm ?? 6) / 2;
    assert.ok(Math.abs(taper.addedHeightMm - (reach - rise)) < 1e-8, `${name}: added height = reach ${reach} - rise ${rise}`);
    // the boss and the taper keep the existing 1 mm headroom; the lip does too
    assert.ok(tapered.lidBossBottomZMm! >= tapered.componentTopZMm + 1 - 1e-9);
    assert.ok(tapered.lipOuterMm.min[2] >= tapered.componentTopZMm + 1 - 1e-9);
  }
  assert.throws(() => requireBoardCaseInvariants({ lipDepthMm: 1.5, innerHeightMm: 20, lipBottomZMm: 10, componentTopZMm: 5, taperBottomZMm: 5.5 }), /lid boss taper bottom z 5\.5 reaches into the component space/);
  assert.doesNotThrow(() => requireBoardCaseInvariants({ lipDepthMm: 1.5, innerHeightMm: 20, lipBottomZMm: 10, componentTopZMm: 5, taperBottomZMm: 6 }));
  // A deep lid lip no longer fits the tapered style (the lip would meet the gusset), but the hanging style still accepts it.
  assert.equal(deriveBoardCase(with_((value) => { value.lid!.lipDepthMm = 5.5; })).wallTopZMm, 18.6);
  assert.equal(deriveBoardCase(with_((value) => { value.lid!.lipDepthMm = 5.6; })).wallTopZMm, 18.6);
});

test("floor style: the cavity grows in one axis by 2 x (inset + radius); ties go to the axis that adds less floor area; the board stays centred", () => {
  const noOpenings = (patch: (value: BoardCaseInput) => void) => with_((value) => { value.openings = undefined; patch(value); });
  const long = deriveBoardCase(styled(REF, "floor")); // 30 x 20: growing x adds 11 x 21, growing y would add 11 x 31
  assert.deepEqual(long.cavityGrowthMm, [11, 0]);
  const tall = deriveBoardCase(noOpenings((value) => { value.board = { lengthMm: 20, widthMm: 30, holes: [{ xMm: 3, yMm: 3, diameterMm: 2.5 }, { xMm: 17, yMm: 27, diameterMm: 2.5 }], componentHeightMm: 5 }; value.lid!.fasteners!.bossStyle = "floor"; }));
  assert.deepEqual(tall.cavityGrowthMm, [0, 11]);
  assert.deepEqual(tall.boardWallClearanceMm, { xNeg: 0.5, xPos: 0.5, yNeg: 6, yPos: 6 });
  const square = deriveBoardCase(noOpenings((value) => { value.board = { lengthMm: 24, widthMm: 24, holes: [{ xMm: 3, yMm: 3, diameterMm: 2.5 }, { xMm: 21, yMm: 21, diameterMm: 2.5 }], componentHeightMm: 5 }; value.lid!.fasteners!.bossStyle = "floor"; }));
  assert.deepEqual(square.cavityGrowthMm, [11, 0], "equal area: x");
  // A bigger boss grows the cavity by 2 x (inset + radius) = 4 x radius - 1.
  const wide = deriveBoardCase(noOpenings((value) => { value.lid!.fasteners!.bossDiameterMm = 8; value.lid!.fasteners!.bossStyle = "floor"; }));
  assert.deepEqual(wide.cavityGrowthMm, [15, 0]);
  assert.deepEqual(wide.boardWallClearanceMm, { xNeg: 8, xPos: 8, yNeg: 0.5, yPos: 0.5 });
  for (const derived of [long, tall, square, wide]) {
    // The board is centred, the other axis keeps boardClearance exactly, and every boss lies outside board + boardClearance.
    const c = derived.boardWallClearanceMm;
    assert.ok(Math.abs(c.xNeg - c.xPos) < 1e-9 && Math.abs(c.yNeg - c.yPos) < 1e-9);
    const bossR = derived.fasteners.lid!.bossDiameterMm / 2;
    const keepOut = { min: [derived.boardMm.min[0] - 0.5, derived.boardMm.min[1] - 0.5], max: [derived.boardMm.max[0] + 0.5, derived.boardMm.max[1] + 0.5] };
    for (const [x, y] of derived.lidBossAxesMm) {
      const dx = Math.max(keepOut.min[0]! - x, 0, x - keepOut.max[0]!);
      const dy = Math.max(keepOut.min[1]! - y, 0, y - keepOut.max[1]!);
      assert.ok(Math.hypot(dx, dy) >= bossR - 1e-9, `boss at ${x}, ${y} is inside the keep-out`);
    }
    const growth = derived.cavityGrowthMm!;
    assert.ok(Math.abs(c.xNeg - (0.5 + growth[0] / 2)) < 1e-9 && Math.abs(c.yNeg - (0.5 + growth[1] / 2)) < 1e-9);
    assert.ok(Math.abs(derived.cavityMm.max[0] - derived.cavityMm.min[0] - ((derived.boardMm.max[0] - derived.boardMm.min[0]) + 1 + growth[0])) < 1e-9);
  }
  // Openings stay referenced to the board: the x- wall opening centre along y does not change, a lid opening follows the board.
  const lidOpening = (style: "hanging" | "floor") => deriveBoardCase(with_((value) => { value.openings = [{ wall: "lid", shape: "rect", widthMm: 4, heightMm: 4, alongMm: 15, acrossMm: 10, label: "window" }]; value.vents = undefined; value.lid!.fasteners!.bossStyle = style; })).openings[0]!.centerMm;
  assert.deepEqual(lidOpening("hanging").slice(0, 2), [17.5, 12.5]);
  assert.deepEqual(lidOpening("floor").slice(0, 2), [23, 12.5], "shifted by half the 11 mm growth, with the board");
  // Wall height and the lip use the lower floor-style wall top, and the boss length is the floor-to-wall-top length.
  const floor = deriveBoardCase(styled(BENCHMARK, "floor"));
  assert.equal(floor.fasteners.lid!.bossLengthMm, floor.wallTopZMm - floor.floorTopZMm);
  assert.equal(floor.lipOuterMm.min[2] - floor.componentTopZMm >= 1 - 1e-9, true);
});

for (const [name, patch, pattern] of [
  ["a bossStyle outside the list", (input: BoardCaseInput) => { (input.lid!.fasteners as { bossStyle?: string }).bossStyle = "pillar"; }, /lid\.fasteners\.bossStyle must be one of tapered, hanging, floor, stack \(got pillar\)/],
  ["a lid lip deeper than the boss with the tapered style", (input: BoardCaseInput) => { input.lid!.fasteners!.bossStyle = "tapered"; input.lid!.lipDepthMm = 5.6; }, /lid\.lipDepthMm 5\.6 must be at most the boss length 6 minus 0\.5 mm with the tapered style/],
  ["a thin wall with a big outer radius with the tapered style", (input: BoardCaseInput) => { input.lid!.fasteners!.bossStyle = "tapered"; input.walls = { wallMm: 0.8, outerCornerRadiusMm: 3 }; }, /the tapered boss gusset is clipped 0\.5 mm into each wall; with walls\.wallMm 0\.8 and walls\.outerCornerRadiusMm 3 that corner would show/],
  ["a wall opening on the taper", (input: BoardCaseInput) => { input.lid!.fasteners!.bossStyle = "tapered"; input.openings = [{ wall: "x-", shape: "rect", widthMm: 2, heightMm: 2, alongMm: 1.5, aboveBoardMm: 7.4, label: "low" }]; }, /low on wall x- collides with the 45 degree gusset under a lid boss/],
  ["a wall vent slot on the taper", (input: BoardCaseInput) => { input.lid!.fasteners!.bossStyle = "tapered"; input.openings = []; input.vents = { on: "x-", slots: 1, slotWidthMm: 1.5, slotLengthMm: 4, pitchMm: 3, centerAlongMm: 1.5, centerAcrossMm: 9 }; }, /vent slot 0 on wall x- collides with the 45 degree gusset under a lid boss/],
  // R2: a floor boss may merge with a standoff; it is refused only when it would cover the standoff's hole (through-mode
  // Ø3.4 clearance hole under a Ø3 board hole at 1.55 mm from the corner edges).
  ["a floor boss that would cover a standoff hole", (input: BoardCaseInput) => { input.lid!.fasteners!.bossStyle = "floor"; input.board.holes = [{ xMm: 1.55, yMm: 1.55, diameterMm: 3 }, { xMm: 28.45, yMm: 18.45, diameterMm: 3 }]; input.standoffs = { heightMm: 3, fastener: { screw: "M3", mode: "through" } }; }, /lid boss 0 merges with standoff 0 but comes 0\.\d+ mm from its Ø3\.4 hole, less than 0\.4 mm: move board\.holes\[0\] .* or use bossStyle "stack"/],
  ["a floor opening under a floor boss", (input: BoardCaseInput) => { input.lid!.fasteners!.bossStyle = "floor"; input.openings = [{ wall: "floor", shape: "circle", widthMm: 2, alongMm: -3.5, acrossMm: 2, label: "drain" }]; }, /drain on the floor collides with lid boss 0/],
  // growAxis "x" pinned: with only an x- opening the default floor growth would now go to y (B) and move the board away.
  ["a wall opening through a floor boss", (input: BoardCaseInput) => { input.lid!.fasteners!.bossStyle = "floor"; input.lid!.fasteners!.growAxis = "x"; input.openings = [{ wall: "x-", shape: "rect", widthMm: 2, heightMm: 2, alongMm: 2, aboveBoardMm: 3, label: "side" }]; }, /side on wall x- collides with lid boss 0/],
] as Array<[string, (input: BoardCaseInput) => void, RegExp]>) {
  test(`validation rejects ${name} before any native call`, async () => {
    const input = with_(patch);
    assert.throws(() => planBoardCase(input), pattern);
    const fake = fakeRuntime();
    await assert.rejects(new BoardCaseRecipe(fake.operations).create(input), pattern);
    assert.equal(fake.calls.length, 0, "no native mutation");
    assert.equal(fake.reads, 0, "not even a state read");
  });
}

test("the same far-from-the-corner opening is accepted in all three styles", () => {
  for (const style of ["tapered", "hanging", "floor"] as const) {
    const input = with_((value) => { value.lid!.fasteners!.bossStyle = style; value.openings = [{ wall: "x-", shape: "rect", widthMm: 2, heightMm: 2, alongMm: 9, aboveBoardMm: 3, label: "far" }]; });
    assert.ok(planBoardCase(input), style);
  }
});

test("the tapered case composes clip box, cone, clip and one join before the bosses, with exact arguments", async () => {
  const fake = fakeRuntime();
  const input = styled(REF, "tapered");
  const result = await new BoardCaseRecipe(fake.operations).create(input);
  const names = fake.calls.map((entry) => entry.operation === "boolean" ? `boolean:${(entry.args[2] as string)}` : entry.operation);
  const repeat = (list: string[], count: number) => Array.from({ length: count }, () => list).flat();
  // Calls after the base shell sit W later (the R4 web stage); web bodies shift later body ids by N.
  // R4 webs after the base shell: standoffs 0.75 mm from two walls (two wall boxes and a corner box each) and four boss
  // corner pockets: two profile loops (the standoffs' joined webs), four boxes and one join (round 4: W = 9 calls, N = 8
  // bodies; it was ten boxes and one join).
  const W = 9;
  const N = 8;
  assert.deepEqual(names.slice(5, 5 + W), [...repeat(["createPolyline", "extrudeRegions"], 2), ...repeat(["createBox"], 4), "boolean:union"]);
  const shifted = (index: number) => index < 5 ? index : index + W;
  assert.deepEqual([...names.slice(0, 5), ...names.slice(5 + W, 11 + W)], [
    "createBox", "fillet", "createBox", "fillet", "boolean:difference",
    ...repeat(["createCylinder"], 2), "boolean:union", ...repeat(["createCylinder"], 2), "boolean:difference",
  ]);
  const taperCalls = names.slice(11 + W, 11 + W + 4 * 3 + 1);
  assert.deepEqual(taperCalls, [...repeat(["createBox", "createCone", "boolean:intersection"], 4), "boolean:union"]);
  const at = (index: number) => rounded(fake.calls[shifted(index)]!.args);
  // corner 0 at the cavity min corner (2, 2): clip box 0.5 mm into the walls; pointed cone with its top disc 0.5 mm above the
  // boss bottom (radius = height = 7.035534, so 45 degrees) and its apex straight down on the corner at z 12.392893
  assert.deepEqual(at(3), [101, ["v102-0", "v102-1", "v102-2", "v102-3"], 0.5]);
  assert.deepEqual(at(11), [[1.5, 1.5, 11.892893], [32, 22, 8.035534], null]);
  assert.deepEqual(at(12), [[2, 2, 19.428427], 7.035534, 0, 7.035534, [0, 0, -1], [1, 0, 0]]);
  assert.deepEqual(at(13), [[108 + N], [106 + N], "intersection", false]);
  // corner 3 at the cavity max corner (33, 23)
  assert.deepEqual(at(21), [[33, 23, 19.428427], 7.035534, 0, 7.035534, [0, 0, -1], [1, 0, 0]]);
  assert.deepEqual(fake.calls[shifted(23)]!.args, [[100], [108, 111, 114, 117].map((id) => id + N), "union", false]);
  // the bosses follow the gusset, hung from 18.93 (0.5 mm into the cone) to the wall top 24.93
  assert.deepEqual(at(24), [[4.5, 4.5, 18.928427], 3, 6, [0, 0, 1]]);
  assert.equal(result.derived.bossTaper!.bottomZMm, 12.6);
  assert.equal(result.undoSteps, fake.calls.length);
  assert.equal(result.undoSteps, result.derived.plannedUndoSteps);
  assert.ok(result.steps.some((step) => step.stage === "lid-boss-tapers" && step.operation === "clip-taper-cone"));
  const final = fake.snapshot();
  assert.deepEqual(final.bodies.map((body) => [body.type, body.name]), [["Solid", "existing"], ["Solid", "ref-base"], ["Solid", "ref-lid"], ["Solid", "ref-board"]]);
  assert.equal(final.regions.length, 0);
  assert.equal(names.at(-1), "remove");
});

test("the floor case grows the cavity cutter, stands the bosses on the floor and adds no taper steps", async () => {
  const fake = fakeRuntime();
  const input = styled(REF, "floor");
  const result = await new BoardCaseRecipe(fake.operations).create(input);
  // R4 webs after the base shell: standoff 0 and 1 each 0.75 mm from a y wall and from a floor boss. Round 4: each
  // standoff's wall box, its strip to the boss, the fill under the strip and that boss's corner box are one profile loop
  // (profile + extrude); the other two bosses' corner boxes stay boxes; then the four full-height corner boxes; one join:
  // W = 11 calls.
  const W = 11;
  assert.deepEqual(fake.calls.slice(5, 5 + W).map((entry) => entry.operation === "boolean" ? `boolean:${String(entry.args[2])}` : entry.operation), ["createPolyline", "extrudeRegions", "createPolyline", "extrudeRegions", ...Array.from({ length: 6 }, () => "createBox"), "boolean:union"]);
  const at = (index: number) => rounded(fake.calls[index < 5 ? index : index + W]!.args);
  assert.deepEqual(at(0), [[0, 0, 0], [46, 25, 14.1], "ref-base"]);
  assert.deepEqual(at(2), [[2, 2, 2], [42, 21, 12.6], null]);
  assert.equal(fake.calls.filter((entry) => entry.operation === "boolean" && entry.args[2] === "intersection").length, 0);
  // standoffs follow the board (x + 6), then the four floor bosses start at the floor top and rise to the wall top
  assert.deepEqual(at(5), [[11, 5.5, 1.5], 2.75, 3.5, [0, 0, 1]]);
  assert.deepEqual(at(11), [[4.5, 4.5, 1.5], 3, 12.6, [0, 0, 1]]);
  assert.deepEqual(at(14), [[41.5, 20.5, 1.5], 3, 12.6, [0, 0, 1]]);
  assert.deepEqual(at(16), [[4.5, 4.5, 14.6], 1.25, 5.5, [0, 0, -1]]);
  assert.deepEqual(result.derived.cavityGrowthMm, [11, 0]);
  assert.equal(result.undoSteps, fake.calls.length);
  assert.equal(result.undoSteps, result.derived.plannedUndoSteps);
  assert.deepEqual(result.steps.filter((step) => step.stage === "lid-boss-tapers"), []);
});

test("a failure in the tapered gusset stage undoes every step and names the stage", async () => {
  const fake = fakeRuntime({ fail: (operation) => operation === "createCone" ? new Error("Plasticity command failed: cone rejected") : undefined });
  const before = fake.snapshot();
  const error = await new BoardCaseRecipe(fake.operations).create(styled(REF, "tapered")).then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof BoardCaseRecipeError);
  assert.equal(error.failedStage, "lid-boss-tapers");
  assert.equal(error.restored, true);
  // 11 steps before the gusset (plus the R4 web stage: 9 steps since round 4), then the first corner's clip box
  assert.equal(error.completedSteps.length, 12 + 9);
  assert.equal(error.undoneSteps, 12 + 9);
  assert.deepEqual(fake.snapshot().bodies, before.bodies);
});

// =============================================================================================== review follow-ups (A-I)
// The reviewer's board unless stated: 60 x 40, 8 mm parts.
const review = (patch: (input: BoardCaseInput) => void = () => {}): BoardCaseInput => {
  const input: BoardCaseInput = { originMm: [0, 0, 0], board: { lengthMm: 60, widthMm: 40, componentHeightMm: 8 }, revision: "r0" };
  patch(input);
  return input;
};
type LidFasteners = NonNullable<NonNullable<BoardCaseInput["lid"]>["fasteners"]>;
const lidPilot = (extra: Partial<LidFasteners> = {}): NonNullable<BoardCaseInput["lid"]> => ({ fasteners: { screw: "M3", base: "pilot", pilotDiameterMm: 2.5, pilotDepthMm: 6, ...extra } });
const refusedBeforeNative = async (input: BoardCaseInput, pattern: RegExp) => {
  assert.throws(() => planBoardCase(input), (error: unknown) => error instanceof BoardCaseValidationError && pattern.test(error.message), `expected ${pattern}`);
  const fake = fakeRuntime();
  await assert.rejects(new BoardCaseRecipe(fake.operations).create(input), pattern);
  assert.equal(fake.calls.length, 0, "no native mutation");
  assert.equal(fake.reads, 0, "not even a state read");
};
const build = async (input: BoardCaseInput, options: Parameters<typeof fakeRuntime>[0] = {}) => {
  const fake = fakeRuntime(options);
  const result = await new BoardCaseRecipe(fake.operations).create(input);
  return { fake, result };
};
const escape = (value: number | string) => String(value).replace(/[.+()]/g, (match) => `\\${match}`);

// ------------------------------------------------------------------------------------------- A: board insertion
test("A: the default bossStyle is floor, and derived.assembly says the board drops in", () => {
  const derived = deriveBoardCase(review((input) => { input.lid = lidPilot(); }));
  assert.equal(derived.bossStyle, "floor");
  assert.deepEqual(derived.assembly, { boardDropIn: true, note: "plan view: no corner boss or gusset overlaps the board outline grown by 0.2 mm, so the board drops straight in past the floor bosses. The board has no holes, so there are no standoffs: it rests on the floor top" });
  assert.deepEqual(deriveBoardCase(POD).assembly, { boardDropIn: true, note: "no corner bosses: the board drops straight in. The board has no holes, so there are no standoffs: it rests on the floor top" });
});

test("A: tapered and hanging are refused when the bosses block the board, and the refusal names bossStyle floor", async () => {
  for (const bossStyle of ["tapered", "hanging"] as const) {
    await refusedBeforeNative(review((input) => { input.lid = lidPilot({ bossStyle }); }), new RegExp(`with bossStyle "${bossStyle}" the corner bosses.* hang over the board corners: in plan view lid boss 0, lid boss 1, lid boss 2, lid boss 3.* overlap the board outline grown by 0\\.2 mm, so the board cannot be lowered into the finished base\\. Use bossStyle "floor".*allowBlockedBoard: true`));
  }
});

test("A: with allowBlockedBoard the hung styles build and report boardDropIn false", async () => {
  for (const bossStyle of ["tapered", "hanging"] as const) {
    const { fake, result } = await build(review((input) => { input.lid = lidPilot({ bossStyle, allowBlockedBoard: true }); input.boardStandIn = true; }));
    assert.equal(result.derived.assembly.boardDropIn, false, bossStyle);
    assert.match(result.derived.assembly.note, bossStyle === "tapered" ? /lid boss 0, lid boss 1, lid boss 2, lid boss 3, the 45 degree gussets overlap/ : /lid boss 0, lid boss 1, lid boss 2, lid boss 3 overlap/);
    assert.equal(result.undoSteps, fake.calls.length);
  }
});

test("A: boardDropIn is computed in plan view from the boss circles and the gusset discs", () => {
  // Hung Ø6 bosses sit 2.5 mm from both walls; they clear the board grown by 0.2 mm when sqrt 2 x (c - 0.2 - 2.5) >= 3.
  const clearAt = 2.7 + 3 / Math.SQRT2;
  const hanging = (clearance: number) => deriveBoardCase(review((input) => { input.fit = { boardClearanceMm: clearance }; input.lid = lidPilot({ bossStyle: "hanging", allowBlockedBoard: true }); })).assembly.boardDropIn;
  assert.equal(hanging(clearAt + 0.01), true);
  assert.equal(hanging(clearAt - 0.01), false);
  // The gusset top disc (radius reach + 0.5 around the cavity corner) clears it when sqrt 2 x (c - 0.2) >= reach + 0.5.
  const gussetClearAt = 0.2 + (REACH + 0.5) / Math.SQRT2;
  const tapered = (clearance: number) => deriveBoardCase(review((input) => { input.fit = { boardClearanceMm: clearance }; input.lid = lidPilot({ bossStyle: "tapered", allowBlockedBoard: true }); })).assembly;
  assert.equal(tapered(gussetClearAt + 0.01).boardDropIn, true);
  assert.deepEqual(tapered(gussetClearAt - 0.01), { boardDropIn: false, note: "plan view: the board comes within 0.2 mm of the 45 degree gussets, so it may not lower freely; bossStyle \"floor\" keeps the bosses beside the board. The board has no holes, so there are no standoffs: it rests on the floor top" });
  // Clear hung bosses need no override.
  assert.ok(planBoardCase(review((input) => { input.fit = { boardClearanceMm: clearAt + 0.01 }; input.lid = lidPilot({ bossStyle: "hanging" }); })));
});

test("A: floor bosses closer to the board than 0.2 mm block it (boardClearanceMm 0.15)", async () => {
  await refusedBeforeNative(review((input) => { input.fit = { boardClearanceMm: 0.15 }; input.lid = lidPilot(); }), /the floor-standing corner bosses are fit\.boardClearanceMm 0\.15 mm from the board, less than the 0\.2 mm the board needs to drop in past them; raise fit\.boardClearanceMm to 0\.2/);
  assert.equal(deriveBoardCase(review((input) => { input.fit = { boardClearanceMm: 0.15 }; input.lid = lidPilot({ allowBlockedBoard: true }); })).assembly.boardDropIn, false);
  assert.equal(deriveBoardCase(review((input) => { input.fit = { boardClearanceMm: 0.2 }; input.lid = lidPilot(); })).assembly.boardDropIn, true, "touching the grown outline is not an overlap");
});

// ------------------------------------------------------------------------------------------- B: floor growth axis
test("B: the floor cavity grows along the axis whose end walls carry no opening", () => {
  const grow = (patch: (input: BoardCaseInput) => void) => { const derived = deriveBoardCase(review((input) => { input.lid = lidPilot(); patch(input); })); return [derived.growAxis, derived.growAxisReason, derived.cavityGrowthMm, derived.boardWallClearanceMm] as const; };
  // 60 x 40: growing x adds 11 x 41 of floor, growing y 11 x 61, so x without openings.
  assert.deepEqual(grow(() => {}), ["x", "no wall carries an opening: the axis that adds less floor area", [11, 0], { xNeg: 6, xPos: 6, yNeg: 0.5, yPos: 0.5 }]);
  const xOpening = { wall: "x-" as const, shape: "rect" as const, widthMm: 6, heightMm: 3, alongMm: 20, aboveBoardMm: 1, label: "usb" };
  assert.deepEqual(grow((input) => { input.openings = [xOpening]; }), ["y", "the x walls carry openings (x-)", [0, 11], { xNeg: 0.5, xPos: 0.5, yNeg: 6, yPos: 6 }]);
  assert.deepEqual(grow((input) => { input.openings = [{ ...xOpening, wall: "y+", alongMm: 30 }]; })[0], "x");
  assert.deepEqual(grow((input) => { input.vents = { on: "x+", slots: 2, slotWidthMm: 1.5, slotLengthMm: 4, pitchMm: 4 }; }).slice(0, 2), ["x", "no wall carries an opening: the axis that adds less floor area"], "a wall vent does not count as an opening (R6)");
  assert.deepEqual(grow((input) => { input.vents = { on: "lid", slots: 2, slotWidthMm: 1.5, slotLengthMm: 6, pitchMm: 4 }; input.openings = [{ wall: "floor", shape: "circle", widthMm: 3, alongMm: 30, acrossMm: 20 }]; })[0], "x", "lid and floor openings move no wall");
  // The x- opening stays at the board edge: the board is 0.5 mm from that wall.
  const benchmark = deriveBoardCase(styled(BENCHMARK, "floor"));
  assert.deepEqual([benchmark.growAxis, benchmark.cavityGrowthMm, benchmark.boardWallClearanceMm.xNeg], ["y", [0, 11], 0.5]);
});

test("B: openings on both axes are refused unless lid.fasteners.growAxis names the axis (reviewer cases A and C)", async () => {
  const both = (growAxis?: "x" | "y") => review((input) => {
    input.lid = lidPilot(growAxis ? { growAxis } : {});
    input.openings = [{ wall: "x-", shape: "rect", widthMm: 6, heightMm: 3, alongMm: 20, aboveBoardMm: 1 }, { wall: "y+", shape: "rect", widthMm: 6, heightMm: 3, alongMm: 30, aboveBoardMm: 1 }];
  });
  await refusedBeforeNative(both(), /bossStyle "floor" widens the cavity by 11 mm along x or y, which moves that axis's two end walls 5\.5 mm away from the board; openings sit on both x walls \(x-\) and y walls \(y\+\), so pass lid\.fasteners\.growAxis "x" or "y"/);
  assert.deepEqual([deriveBoardCase(both("x")).cavityGrowthMm, deriveBoardCase(both("x")).growAxisReason], [[11, 0], "lid.fasteners.growAxis"]);
  assert.deepEqual(deriveBoardCase(both("y")).cavityGrowthMm, [0, 11]);
  // The reviewer's case C (120 x 30 board, x- usb, y+ vent, floor bosses).
  const caseC: BoardCaseInput = {
    originMm: [2500, 0, -5],
    board: { lengthMm: 120, widthMm: 30, holes: [{ xMm: 5, yMm: 6, diameterMm: 3.2 }, { xMm: 112, yMm: 6, diameterMm: 3.2 }, { xMm: 70, yMm: 25, diameterMm: 3.2 }], componentHeightMm: 2 },
    standoffs: { fastener: { screw: "M3", mode: "through" } },
    lid: { fasteners: { screw: "M3", base: "pilot", pilotDiameterMm: 2.5, pilotDepthMm: 5, bossStyle: "floor" } },
    openings: [{ wall: "x-", shape: "rounded-rect", widthMm: 9, heightMm: 1.2, cornerRadiusMm: 0.4, alongMm: 15, aboveBoardMm: 0.2, label: "usb" }, { wall: "floor", shape: "rect", widthMm: 10, heightMm: 5, alongMm: 40, acrossMm: 15, label: "hatch" }],
    vents: { on: "y+", slots: 5, slotWidthMm: 1, slotLengthMm: 2.4, pitchMm: 3, centerAlongMm: 30 },
    boardStandIn: true,
    revision: "r0",
  };
  // R6: its y+ wall vent does not count, so the x- usb alone sends the growth to y.
  assert.equal(deriveBoardCase(caseC).growAxis, "y");
});

test("B: growAxis is refused outside the floor style", async () => {
  await refusedBeforeNative(review((input) => { input.lid = lidPilot({ bossStyle: "hanging", allowBlockedBoard: true, growAxis: "x" }); }), /lid\.fasteners\.growAxis applies only to bossStyle "floor" \(got bossStyle "hanging"\)/);
});

// ------------------------------------------------------------------------------------------- C: standoffs
test("C: a standoff may reach at most wallMm - 0.4 into the wall (reviewer T2 and P2)", async () => {
  // T2: a Ø3 hole 1.6 mm from the board edge with 0.8 mm walls: the Ø6 standoff reaches 0.5 + 1.6 - 3 = -0.9 past the cavity.
  await refusedBeforeNative(review((input) => { input.board.holes = [{ xMm: 1.6, yMm: 20, diameterMm: 3 }]; input.walls = { wallMm: 0.8, outerCornerRadiusMm: 0 }; input.standoffs = { fastener: { screw: "M3", mode: "pilot", pilotDiameterMm: 2.5 } }; }), /standoff 0 \(Ø6 under board\.holes\[0\]\) reaches 0\.9 mm into the wall and leaves -0\.1 mm of wall outside it; a standoff may reach at most walls\.wallMm - 0\.4 = 0\.4 mm into it/);
  // P2: Ø30 standoffs under holes 4 mm from the board edges.
  await refusedBeforeNative(review((input) => { input.board.holes = [{ xMm: 4, yMm: 4, diameterMm: 3 }, { xMm: 50, yMm: 30, diameterMm: 3 }]; input.standoffs = { outerDiameterMm: 30, fastener: { screw: "M3", mode: "pilot", pilotDiameterMm: 2.5 } }; }), /standoff 0 \(Ø30 under board\.holes\[0\]\) reaches 10\.5 mm into the wall/);
  // The limit itself: a Ø9 standoff at x 2.4 reaches exactly 1.6 mm into a 2 mm wall; at x 2.3 it reaches 1.7.
  const at = (xMm: number) => review((input) => { input.board.holes = [{ xMm, yMm: 20, diameterMm: 3 }]; input.standoffs = { outerDiameterMm: 9, fastener: { screw: "M3", mode: "pilot", pilotDiameterMm: 2.5 } }; });
  assert.ok(planBoardCase(at(2.4)));
  await refusedBeforeNative(at(2.3), /reaches 1\.7 mm into the wall/);
  // At a rounded corner the board clearance caps the inner radius (0.5), so the corner wall is thinner than
  // walls.wallMm there: the wall left outside the standoff is measured to the outer profile too.
  const corner = review((input) => { input.walls = { outerCornerRadiusMm: 3.7 }; input.board.holes = [{ xMm: 1, yMm: 1, diameterMm: 1 }]; input.standoffs = { outerDiameterMm: 6.1, fastener: { screw: "M2", mode: "pilot", pilotDiameterMm: 0.6 } }; });
  const outside = roundedRectInsideDistance([3.5, 3.5], { min: [0, 0], max: [65, 45] }, 3.7) - 3.05;
  assert.ok(outside > 0 && outside < 0.4, "the Ø6.1 circle leaves under 0.4 mm of wall at the rounded outer corner");
  await refusedBeforeNative(corner, new RegExp(`standoff 0 \\(Ø6\\.1 under board\\.holes\\[0\\]\\) reaches .* mm into the wall and leaves ${escape(Math.round(outside * 1000) / 1000)} mm of wall outside it`));
});

test("C: a standoff is at least 1 mm wider than its board hole (reviewer P3)", async () => {
  const p3 = (outerDiameterMm: number) => review((input) => { input.board.holes = [{ xMm: 10, yMm: 10, diameterMm: 6 }, { xMm: 50, yMm: 30, diameterMm: 6 }]; input.standoffs = { outerDiameterMm, fastener: { screw: "M3", mode: "pilot", pilotDiameterMm: 2.5 } }; input.boardStandIn = true; });
  await refusedBeforeNative(p3(5), /standoff 0: outer diameter 5 must exceed the Ø6 board hole above it by at least 1 mm \(needs 7\)/);
  await refusedBeforeNative(p3(6.9), /outer diameter 6\.9 must exceed the Ø6 board hole/);
  assert.ok(planBoardCase(p3(7)));
});

test("C: fasteners.standoffs.outerDiametersMm has one entry per standoff, in the order of standoffAxesMm", () => {
  const holes = [{ xMm: 3.1, yMm: 4.2, diameterMm: 2.7 }, { xMm: 39.4, yMm: 5, diameterMm: 2.7 }, { xMm: 20, yMm: 27.5, diameterMm: 3.2 }];
  const plan = planBoardCase(review((input) => { input.board.holes = holes; input.standoffs = { fastener: { screw: "M2.5", mode: "pilot", pilotDiameterMm: 2.1 } }; }));
  assert.deepEqual(plan.derived.fasteners.standoffs!.outerDiametersMm, [5.7, 5.7, 6.2]);
  assert.equal(plan.derived.standoffAxesMm.length, 3);
  const reversed = planBoardCase(review((input) => { input.board.holes = [...holes].reverse(); input.standoffs = { fastener: { screw: "M2.5", mode: "pilot", pilotDiameterMm: 2.1 } }; }));
  assert.deepEqual(reversed.derived.fasteners.standoffs!.outerDiametersMm, [6.2, 5.7, 5.7]);
  // The build still groups equal diameters into one pattern each.
  assert.deepEqual(plan.standoffGroups.map((group) => [group.outerDiameterMm, group.centersMm.length]), [[5.7, 2], [6.2, 1]]);
});

// ------------------------------------------------------------------------------------------- D: corners
const cornerWallOf = (wall: number, outer: number, inner: number) => wall * Math.SQRT2 - (outer - inner) * (Math.SQRT2 - 1);
test("D: derived.cornerWallMm = wall x sqrt 2 - (outer radius - inner radius) x (sqrt 2 - 1)", () => {
  const corner = (walls: BoardCaseInput["walls"], clearance = 0.5) => deriveBoardCase(review((input) => { input.walls = walls; input.fit = { boardClearanceMm: clearance }; }));
  assert.equal(r6(corner({}).cornerWallMm), r6(cornerWallOf(2, 3, 0.5)), "radius 3, wall 2: inner radius 0.5 (the board clearance)");
  assert.equal(r6(corner({ outerCornerRadiusMm: 0 }).cornerWallMm), r6(2 * Math.SQRT2));
  const big = corner({ outerCornerRadiusMm: 3.5 });
  assert.equal(r6(big.innerCornerRadiusMm), r6(innerRadius(3.5, 2, 0.5)));
  assert.equal(r6(big.cornerWallMm), r6(cornerWallOf(2, 3.5, innerRadius(3.5, 2, 0.5))));
  const pod = deriveBoardCase(POD);
  assert.equal(r6(pod.cornerWallMm), r6(cornerWallOf(2, 3, innerRadius(3, 2, 0.15))));
});

test("R3: the inner corner radius is min(radius - wall, board clearance); cornerGapMm is the diagonal play; walls.innerCornerRadiusMm keeps 0.2 mm", async () => {
  for (const clearance of [0.15, 0.2, 0.5, 1]) {
    const derived = deriveBoardCase(review((input) => { input.fit = { boardClearanceMm: clearance }; }));
    assert.equal(derived.innerCornerRadiusMm, Math.min(1, clearance));
    // Diagonal gap from the board corner (c, c) to the arc centred at (ri, ri): sqrt 2 x c - ri x (sqrt 2 - 1).
    assert.equal(r6(derived.cornerGapMm), r6(Math.SQRT2 * clearance - Math.min(1, clearance) * (Math.SQRT2 - 1)));
    if (clearance <= 1) assert.ok(derived.cornerGapMm >= clearance - 1e-9, `clearance ${clearance}: the corner play is at least the side play`);
  }
  const explicit = (innerCornerRadiusMm: number) => review((input) => { input.walls = { innerCornerRadiusMm }; });
  // 0.5 mm clearance: the gap stays 0.2 mm up to (0.5 sqrt 2 - 0.2) / (sqrt 2 - 1) = 1.224 mm.
  const largest = (0.5 * Math.SQRT2 - 0.2) / (Math.SQRT2 - 1);
  assert.equal(r6(deriveBoardCase(explicit(1.2)).cornerGapMm), r6(0.5 * Math.SQRT2 - 1.2 * (Math.SQRT2 - 1)));
  await refusedBeforeNative(explicit(1.3), new RegExp(`walls\\.innerCornerRadiusMm 1\\.3 leaves a ${escape(Math.round((0.5 * Math.SQRT2 - 1.3 * (Math.SQRT2 - 1)) * 1000) / 1000)} mm diagonal gap .* below 0\\.2 mm; with fit\\.boardClearanceMm 0\\.5 it may be at most ${escape(Math.floor(largest * 1000 + 1e-6) / 1000)}`));
  assert.equal(deriveBoardCase(review()).innerCornerRadiusMm, 0.5, "radius 3 - wall 2 = 1, capped at the 0.5 mm clearance");
});

test("D: the reviewer's corner inputs 2a-2d are refused with the largest outer radius allowed, and that radius builds", async () => {
  const cases: Array<[string, (input: BoardCaseInput) => void, number, number, number]> = [
    // [name, patch, wall, clearance, outer radius]
    ["2a: wall 0.8, clearance 0.2", (input) => { input.walls = { wallMm: 0.8 }; input.fit = { boardClearanceMm: 0.2 }; }, 0.8, 0.2, 3],
    ["2b: wall 0.8", (input) => { input.walls = { wallMm: 0.8 }; }, 0.8, 0.5, 3],
    ["2c: outer radius 6", (input) => { input.walls = { outerCornerRadiusMm: 6 }; }, 2, 0.5, 6],
    ["2d: outer radius 9, hanging", (input) => { input.walls = { outerCornerRadiusMm: 9 }; input.lid = lidPilot({ bossStyle: "hanging", allowBlockedBoard: true }); }, 2, 0.5, 9],
    ["2d: outer radius 12, floor", (input) => { input.walls = { outerCornerRadiusMm: 12 }; input.lid = lidPilot(); }, 2, 0.5, 12],
  ];
  for (const [name, patch, wall, clearance, outer] of cases) {
    const ri = innerRadius(outer, wall, clearance);
    const limit = Math.max(0.8, 0.75 * wall);
    const riMax = clearance;
    const largest = Math.floor((riMax + (wall * Math.SQRT2 - limit) / (Math.SQRT2 - 1)) * 1000 + 1e-6) / 1000;
    await refusedBeforeNative(review(patch), new RegExp(`the corner wall is ${escape(Math.round(cornerWallOf(wall, outer, ri) * 1000) / 1000)} mm .*below the ${escape(limit)} mm minimum .*walls\\.outerCornerRadiusMm may be at most ${escape(largest)}$`));
    const fixed = review((input) => { patch(input); input.walls = { ...input.walls, outerCornerRadiusMm: largest }; });
    const derived = deriveBoardCase(fixed);
    assert.ok(derived.cornerWallMm >= limit - 1e-9, `${name}: ${derived.cornerWallMm}`);
    const { result } = await build(fixed);
    assert.equal(result.derived.cornerWallMm, derived.cornerWallMm, name);
  }
});

test("D: every boss and gusset stays 0.8 mm inside the outer profile, rounded corner included", async () => {
  // Reviewer P11: 1.2 mm walls, Ø5 hanging bosses: 1.2 - 0.5 = 0.7 mm of wall outside each boss.
  await refusedBeforeNative(review((input) => { input.walls = { wallMm: 1.2, outerCornerRadiusMm: 1 }; input.lid = lidPilot({ bossStyle: "hanging", bossDiameterMm: 5 }); }), /lid boss 0 \(Ø5\) is 0\.7 mm from the outer surface; every boss and gusset must stay 0\.8 mm inside the outer profile/);
  // (Plain lid holes: the Ø6.72 countersink would reach past this thin lid edge, refused by E.)
  assert.ok(planBoardCase(review((input) => { input.walls = { wallMm: 1.3, outerCornerRadiusMm: 1 }; input.lid = lidPilot({ bossStyle: "hanging", bossDiameterMm: 5, allowBlockedBoard: true, countersunk: false }); })), "1.3 mm walls leave exactly 0.8");
  // Tapered at outer radius 4.5: the gusset corner (0.5 mm into both walls) is 4.5 - sqrt 2 x 3 mm inside the rounded corner.
  // (Radius 3.7 is the largest the corner wall allows with the 0.5 mm inner radius; 4.5 is refused by that rule first.)
  await refusedBeforeNative(review((input) => { input.walls = { outerCornerRadiusMm: 3.7 }; input.lid = lidPilot({ bossStyle: "tapered", allowBlockedBoard: true }); }), new RegExp(`the 45 degree gussets reach ${escape(Math.round((3.7 - Math.SQRT2 * 2.2) * 1000) / 1000)} mm from the outer surface at the rounded corners`));
  assert.equal(roundedRectInsideDistance([1.5, 1.5], { min: [0, 0], max: [40, 40] }, 4.5), 4.5 - Math.SQRT2 * 3);
});

// ------------------------------------------------------------------------------------------- E: lid
test("E: the countersink (or head) circle stays 0.5 mm inside the lid outline", async () => {
  const lidWith = (extra: Partial<LidFasteners>, lidMm = 6) => review((input) => { input.walls = { lidMm }; input.lid = lidPilot({ bossStyle: "hanging", allowBlockedBoard: true, ...extra }); });
  // The boss axis is wall 2 + inset 2.5 = 4.5 mm from the outer faces.
  await refusedBeforeNative(lidWith({ screw: "M2.5", headDiameterMm: 12 }), /the Ø12 countersink over lid boss 0 comes -1\.5 mm from the lid edge; it must stay 0\.5 mm inside the lid outline/);
  await refusedBeforeNative(lidWith({ screw: "M2.5", headDiameterMm: 100 }, 50), /the Ø100 countersink over lid boss 0 comes -45\.5 mm from the lid edge/);
  await refusedBeforeNative(lidWith({ countersunk: false, headDiameterMm: 8.2 }), /the Ø8\.2 screw head over lid boss 0 comes 0\.4 mm from the lid edge/);
  assert.ok(planBoardCase(lidWith({ screw: "M2.5", headDiameterMm: 8 })), "8 mm leaves exactly 0.5");
});

test("E: a lip piece shorter than 1 mm between a boss notch and its corner is removed by a box notch", async () => {
  const square = (bossDiameterMm: number) => (bossDiameterMm / 2 - 0.5) - Math.sqrt((bossDiameterMm / 2 + 0.2) ** 2 - (0.2 - (bossDiameterMm / 2 - 0.5)) ** 2) - 0.2;
  const notch = (outer: number, bossDiameterMm: number) => planBoardCase(review((input) => { input.walls = { outerCornerRadiusMm: outer }; input.lid = lidPilot({ bossStyle: "hanging", allowBlockedBoard: true, bossDiameterMm }); })).lid.notches;
  // Square corners: the piece is s - sqrt((R + lc)^2 - (lc - s)^2) - lc along each side.
  assert.ok(Math.abs(lipCornerPieceMm({ inset: 2.5, notchRadius: 3.2, lipClearance: 0.2, lipWall: 1.2, outerRadius: 0, innerRadius: 0 }) - (2.5 - Math.sqrt(3.2 ** 2 - 2.3 ** 2) - 0.2)) < 1e-3);
  for (const [outer, boss, kind] of [[0, 6, "box"], [3, 8, "box"], [0, 7.5, "box"], [0, 10, "cylinder"], [3, 6, "cylinder"]] as const) {
    const notches = notch(outer, boss);
    assert.equal(notches.length, 4);
    assert.ok(notches.every((entry) => entry.kind === kind), `radius ${outer}, Ø${boss}: ${notches[0]!.kind}`);
  }
  assert.ok(Math.abs((notch(0, 6)[0] as { cornerPieceMm: number }).cornerPieceMm - square(6)) < 1e-3, "Ø6, square corner: 0.075 mm");
  assert.ok(square(10) >= 1, "Ø10 leaves a 1.38 mm piece, kept");
  // The box runs from 0.5 mm outside the cavity corner past the whole boss circle (boss radius + lid clearance), from
  // 0.5 mm below the lip bottom (wall top 19.6 - lip 1.5 = 18.1; round 4: the hole-less board rests on the floor) for
  // lip + 3 x 0.5 mm.
  const box = notch(0, 6)[0] as { kind: string; originMm: number[]; sizeMm: number[] };
  assert.deepEqual([box.kind, rounded(box.originMm), rounded(box.sizeMm)], ["box", [1.5, 1.5, 17.6], [0.5 + 2.5 + 3.2, 0.5 + 2.5 + 3.2, 3]]);
  const far = notch(0, 6)[3] as { originMm: number[]; sizeMm: number[] };
  assert.deepEqual((rounded(far.originMm.map((value, axis) => value + far.sizeMm[axis]!)) as number[]).slice(0, 2), [2 + 61 + 0.5, 2 + 41 + 0.5], "corner 3 runs to 0.5 mm past the far cavity corner (wall 2 + board 60 + 2 x 0.5)");
  // Reviewer P5 (radius 0, Ø6 bosses, exploded 7) builds with box notches and passes the read-back.
  const { fake, result } = await build(review((input) => { input.walls = { outerCornerRadiusMm: 0 }; input.lid = lidPilot({ bossStyle: "hanging", allowBlockedBoard: true }); input.exploded = 7; }));
  assert.deepEqual(result.steps.filter((step) => step.operation === "create-lip-corner-notch-cutter").length, 4);
  assert.equal(result.undoSteps, result.derived.plannedUndoSteps);
  assert.equal(result.undoSteps, fake.calls.length);
});

// ------------------------------------------------------------------------------------------- F: rules in the plan
test("F: the limits that ran after the first edit are refused in the plan (reviewer P6, P7, P8, P10, P12, P13)", async () => {
  const cases: Array<[string, (input: BoardCaseInput) => void, RegExp]> = [
    ["P6: vent pitch = width + 1e-8", (input) => { input.vents = { on: "lid", slots: 3, slotWidthMm: 2, slotLengthMm: 10, pitchMm: 2 + 1e-8 }; }, /vents\.pitchMm 2\.00000001 must exceed vents\.slotWidthMm 2 by at least 0\.4 mm \(the web between two slots\), so at least 2\.4/],
    ["P7: board hole Ø1e-7", (input) => { input.board.holes = [{ xMm: 5, yMm: 5, diameterMm: 1e-7 }]; input.boardStandIn = true; }, /board\.holes\[0\]\.diameterMm 1e-7 is below the 0\.5 mm minimum hole diameter/],
    ["P8: lip wall 1e-7", (input) => { input.lid = { lipWallMm: 1e-7 }; }, /lid\.lipWallMm 1e-7 is below the 0\.4 mm minimum lip wall/],
    ["P10: two wall openings that touch", (input) => { input.openings = [{ wall: "x-", shape: "rect", widthMm: 5, heightMm: 3, alongMm: 10, aboveBoardMm: 1 }, { wall: "x-", shape: "rect", widthMm: 5, heightMm: 3, alongMm: 15, aboveBoardMm: 1 }]; }, /opening 0 and opening 1 on the wall x- leave a 0 mm web between them; openings on one face need at least 0\.4 mm/],
    ["P12: a 1e6 mm board", (input) => { input.board.lengthMm = 1e6; input.board.widthMm = 1e6; }, /board\.lengthMm 1000000 exceeds the 500 mm board size limit/],
    ["P13: 1e7 mm parts", (input) => { input.board.componentHeightMm = 1e7; }, /board\.componentHeightMm 10000000 exceeds the 200 mm height limit/],
    ["board width 500.1", (input) => { input.board.widthMm = 500.1; }, /board\.widthMm 500\.1 exceeds the 500 mm board size limit/],
    ["standoff height 201", (input) => { input.board.holes = [{ xMm: 10, yMm: 10, diameterMm: 3 }]; input.standoffs = { heightMm: 201, fastener: { screw: "M3", mode: "pilot", pilotDiameterMm: 2.5 } }; }, /standoffs\.heightMm 201 exceeds the 200 mm height limit/],
    ["exploded 250", (input) => { input.exploded = 250; }, /exploded 250 exceeds the 200 mm height limit/],
    ["lid pilot Ø0.3", (input) => { input.lid = lidPilot({ pilotDiameterMm: 0.3 }); }, /lid\.fasteners\.pilotDiameterMm 0\.3 is below the 0\.5 mm minimum hole diameter/],
    ["standoff pilot Ø0.4", (input) => { input.board.holes = [{ xMm: 10, yMm: 10, diameterMm: 3 }]; input.standoffs = { fastener: { screw: "M3", mode: "pilot", pilotDiameterMm: 0.4 } }; }, /standoffs\.fastener\.pilotDiameterMm 0\.4 is below the 0\.5 mm minimum hole diameter/],
    ["circle opening Ø0.3", (input) => { input.openings = [{ wall: "lid", shape: "circle", widthMm: 0.3, alongMm: 30, acrossMm: 20, label: "pin" }]; }, /pin: widthMm \(circle diameter\) 0\.3 is below the 0\.5 mm minimum hole diameter/],
    // The reviewer's plan-level probes (plan1.mjs) that the plan still accepted after A-I:
    ["floor 1e-7", (input) => { input.walls = { floorMm: 1e-7 }; }, /walls\.floorMm 1e-7 is below the 0\.8 mm minimum floor/],
    ["origin 1e12", (input) => { input.originMm = [1e12, 0, 0]; }, /originMm must stay within 100000 mm of the document origin/],
    ["lid pilot depth 1e-6", (input) => { input.lid = lidPilot({ bossStyle: "hanging", allowBlockedBoard: true, pilotDepthMm: 1e-6 }); }, /lid\.fasteners\.pilotDepthMm 0\.000001 is below the 0\.5 mm minimum hole depth|lid\.fasteners\.pilotDepthMm 1e-6 is below the 0\.5 mm minimum hole depth/],
    ["lid pilot Ø5.99 in a Ø6 boss", (input) => { input.lid = lidPilot({ bossStyle: "hanging", allowBlockedBoard: true, pilotDiameterMm: 5.99 }); }, /lid boss diameter 6 leaves a 0\.005 mm wall around its 5\.99 mm hole, below the 0\.4 mm minimum \(needs 6\.79\)/],
    ["standoff pilot Ø3 in a Ø3.5 standoff", (input) => { input.board.holes = [{ xMm: 10, yMm: 10, diameterMm: 2.5 }]; input.standoffs = { outerDiameterMm: 3.5, fastener: { screw: "M3", mode: "pilot", pilotDiameterMm: 3 } }; }, /standoff 0: outer diameter 3\.5 leaves a 0\.25 mm wall around its 3 mm hole, below the 0\.4 mm minimum \(needs 3\.8\)/],
    ["standoff pilot depth 0.2", (input) => { input.board.holes = [{ xMm: 10, yMm: 10, diameterMm: 3 }]; input.standoffs = { fastener: { screw: "M3", mode: "pilot", pilotDiameterMm: 2.5, pilotDepthMm: 0.2 } }; }, /standoffs\.fastener\.pilotDepthMm 0\.2 is below the 0\.5 mm minimum hole depth/],
  ];
  for (const [name, patch, pattern] of cases) {
    await test(name, () => refusedBeforeNative(review(patch), pattern));
  }
});

test("F: openings on one face keep a web of at least 0.4 mm", async () => {
  const pair = (gap: number, wall: "x-" | "lid") => review((input) => {
    input.openings = wall === "lid"
      ? [{ wall, shape: "rect", widthMm: 5, heightMm: 3, alongMm: 20, acrossMm: 20, label: "a" }, { wall, shape: "rect", widthMm: 5, heightMm: 3, alongMm: 25 + gap, acrossMm: 20, label: "b" }]
      : [{ wall, shape: "rect", widthMm: 5, heightMm: 3, alongMm: 10, aboveBoardMm: 1, label: "a" }, { wall, shape: "rect", widthMm: 5, heightMm: 3, alongMm: 15 + gap, aboveBoardMm: 1, label: "b" }];
  });
  for (const wall of ["x-", "lid"] as const) {
    await refusedBeforeNative(pair(0.3, wall), new RegExp(`a and b on the ${wall === "lid" ? "lid" : "wall x-"} leave a 0\\.3 mm web between them`));
    await refusedBeforeNative(pair(-1, wall), /a and b overlap/);
    assert.ok(planBoardCase(pair(0.4, wall)), `${wall}: 0.4 mm is enough`);
  }
});

test("F: derived.plannedUndoSteps equals the measured undoSteps for every composition", async () => {
  const inputs: Array<[string, BoardCaseInput]> = [
    ["reference (hanging)", REF], ["reference tapered", styled(REF, "tapered")], ["reference floor", styled(REF, "floor")],
    ["audit (inserts, box notches)", AUDIT], ["pod exploded", { ...POD, exploded: 12 }], ["benchmark", BENCHMARK], ["benchmark floor", styled(BENCHMARK, "floor")],
    ["through standoffs", with_((value) => { value.standoffs = { heightMm: 3, fastener: { screw: "M2.5", mode: "through", clearanceFit: "free" } }; })],
    ["one standoff, one hole", with_((value) => { value.board.holes = [{ xMm: 15, yMm: 10, diameterMm: 2.5 }]; })],
    ["wall vents, one vent", with_((value) => { value.vents = { on: "x+", slots: 1, slotWidthMm: 1.5, slotLengthMm: 4, pitchMm: 3 }; })],
    ["plain lid holes", with_((value) => { value.lid!.fasteners!.countersunk = false; })],
    ["square corners", with_((value) => { value.walls = { outerCornerRadiusMm: 0 }; })],
    ["circle and rounded openings", with_((value) => { value.openings = [{ wall: "y+", shape: "circle", widthMm: 3, alongMm: 15, aboveBoardMm: 1 }, { wall: "lid", shape: "rounded-rect", widthMm: 6, heightMm: 3, cornerRadiusMm: 1, alongMm: 15, acrossMm: 4 }]; value.vents = undefined; })],
  ];
  for (const [name, input] of inputs) {
    const { fake, result } = await build(input);
    assert.equal(result.undoSteps, fake.calls.length, name);
    assert.equal(result.derived.plannedUndoSteps, result.undoSteps, name);
    const plan = planBoardCase(input);
    assert.equal(countBoardCaseSteps(plan, plan.derived.explodedMm), result.undoSteps, name);
  }
});

test("F: a plan above 400 Undo steps is refused with its count", async () => {
  const big = (openings: number) => review((input) => {
    input.board = { lengthMm: 400, widthMm: 300, componentHeightMm: 8, holes: Array.from({ length: 32 }, (_, index) => ({ xMm: 20 + 45 * (index % 8), yMm: 20 + 80 * Math.floor(index / 8), diameterMm: 1 })) };
    input.standoffs = { fastener: { screw: "M2", mode: "pilot", pilotDiameterMm: 0.6 } };
    input.boardStandIn = true;
    input.vents = { on: "lid", slots: 64, slotWidthMm: 1, slotLengthMm: 10, pitchMm: 1.5 };
    input.openings = Array.from({ length: openings }, (_, index) => ({ wall: "y-" as const, shape: "rect" as const, widthMm: 5, heightMm: 2, alongMm: 20 + 30 * index, aboveBoardMm: 1 }));
  });
  // base 5 (box, fillet, cavity, fillet, cut) + standoffs 2 x 32 + 2 + lid shell 7 + vents 4 x 64 + 1 + board 1 + 32 + 1
  // + cleanup 1 = 370, plus 3 per rect opening and (R1) one profile delete for every opening but the last on the wall.
  assert.equal(deriveBoardCase(big(7)).plannedUndoSteps, 370 + 3 * 7 + 6);
  await refusedBeforeNative(big(8), /the build would take 401 Undo steps, above the 400-step limit/);
});

// ------------------------------------------------------------------------------------------- G: real footprints
test("G: a wall opening is checked against the real footprint of a boss or standoff that merges into the wall", async () => {
  // A hung Ø6 boss at y 4.5 overlaps the x- wall, so it shows over y 1.5..7.5 behind the wall. An opening at y 7.1..9.1
  // misses the 0.5 mm cutter overshoot (the cutter test alone accepts it) but sits in front of the boss.
  const beside = (alongMm: number) => with_((value) => { value.openings = [{ wall: "x-", shape: "rect", widthMm: 2, heightMm: 2, alongMm, aboveBoardMm: 6.4, label: "beside" }]; });
  await refusedBeforeNative(beside(5.6), /beside on wall x- collides with lid boss 0/);
  assert.ok(planBoardCase(beside(6.1)), "y 7.6..9.6 clears the boss footprint 1.5..7.5");
  // A Ø6 standoff 2.5 mm from the x- wall merges 0.5 mm into it; an opening at y 24.9..26.9 is in front of it (y 19.5..25.5).
  const standoff = (alongMm: number) => review((input) => {
    input.board.holes = [{ xMm: 2, yMm: 20, diameterMm: 3 }];
    input.standoffs = { fastener: { screw: "M3", mode: "pilot", pilotDiameterMm: 2.5 } };
    input.openings = [{ wall: "x-", shape: "rect", widthMm: 2, heightMm: 1, alongMm, aboveBoardMm: -3.1, label: "low" }];
  });
  await refusedBeforeNative(standoff(23.4), /low on wall x- collides with standoff 0/);
  assert.ok(planBoardCase(standoff(24.1)));
});

// ------------------------------------------------------------------------------------------- H: printability
test("H: printability states its scope, the lid's top-face-down overhang and every flat opening ceiling over 6 mm", () => {
  const derived = deriveBoardCase(with_((value) => {
    value.openings = [
      { wall: "y+", shape: "rect", widthMm: 8, heightMm: 3, alongMm: 15, aboveBoardMm: 1, label: "port" },
      { wall: "x-", shape: "rounded-rect", widthMm: 9.2, heightMm: 3.4, cornerRadiusMm: 1.2, alongMm: 10, aboveBoardMm: 1, label: "usb" },
      { wall: "x+", shape: "rect", widthMm: 6, heightMm: 2, alongMm: 10, aboveBoardMm: 1, label: "six" },
      { wall: "y-", shape: "circle", widthMm: 3, alongMm: 15, aboveBoardMm: 1, label: "jack" },
      { wall: "lid", shape: "rect", widthMm: 10, heightMm: 3, alongMm: 15, acrossMm: 4, label: "window" },
    ];
    value.vents = undefined;
  }));
  assert.deepEqual(derived.printability, {
    baseOrientation: "floor-down", maxBossOverhangDeg: 90, scope: BOARD_CASE_PRINTABILITY_SCOPE, lidPrintOrientation: "top face down", lidMaxOverhangDeg: 45,
    // board top 6.6 + 1: the port ceiling at 10.6, the usb ceiling at 11 (9.2 - 2 x 1.2 = 6.8 flat); 6 is not wider than 6.
    openingCeilings: [{ label: "port", wall: "y+", widthMm: 8, zMm: 10.6 }, { label: "usb", wall: "x-", widthMm: 6.8, zMm: 11 }],
  });
  assert.match(derived.printability!.scope, /Not covered: the round crowns of circle wall openings, rounded opening corners and wall vent slot ends/);
  assert.equal(deriveBoardCase(with_((value) => { value.lid!.fasteners!.countersunk = false; })).printability!.lidMaxOverhangDeg, 0);
  // Without lid screws: no boss field, but the lid orientation and the opening ceilings (the pod's 10 mm x+ notch).
  const pod = deriveBoardCase({ ...POD, openings: [{ wall: "x+", shape: "rect", widthMm: 10, heightMm: 4, alongMm: 7.6, aboveBoardMm: -0.5, label: "notch" }] }).printability;
  assert.deepEqual(pod, { baseOrientation: "floor-down", scope: BOARD_CASE_PRINTABILITY_SCOPE, lidPrintOrientation: "top face down", lidMaxOverhangDeg: 0, openingCeilings: [{ label: "notch", wall: "x+", widthMm: 10, zMm: 3.6 - 0.5 + 4 }] });
});

// ------------------------------------------------------------------------------------------- I: reporting
test("I: a sub-recipe step that lands but fails its own check is listed with its profile Wire, and undone; the counts agree", async () => {
  // Call 46 is the y+ opening's profile polyline: it lands without a Region, so the connector opening recipe throws before
  // it lists the step.
  const shift = 9; // the R4 web stage of REF (round 4: two profile loops, four boxes, one join)
  const fake = fakeRuntime({ noRegion: (index) => index === 46 + shift });
  const error = await new BoardCaseRecipe(fake.operations).create(REF).then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof BoardCaseRecipeError);
  assert.equal(fake.calls[45 + shift]!.operation, "createPolyline");
  assert.equal(error.failedStage, "opening:port");
  assert.equal(error.completedSteps.length, 46 + shift);
  assert.equal(error.undoneSteps, 46 + shift);
  assert.match(error.message, new RegExp(`after ${46 + shift} confirmed native steps; undid ${46 + shift} native steps; the document matches the start`));
  const last = error.completedSteps.at(-1)!;
  assert.match(last.operation, /missing from its report/);
  assert.equal(last.affectedBodyIds.length, 1, "the profile Wire");
  assert.equal(error.restored, true);
});

test("I: rejections without a test until now: an insert wall too thin on a standoff, a corner radius on a rect opening", async () => {
  await refusedBeforeNative(with_((value) => { value.standoffs = { heightMm: 5, outerDiameterMm: 6.5, fastener: { screw: "M2.5", mode: "heat-set-insert" } }; }), /standoff 0: outer diameter 6\.5 leaves less than the sourced 1\.6 mm insert wall around the 4 mm hole \(needs 7\.2\)/);
  await refusedBeforeNative(with_((value) => { value.openings![0]!.cornerRadiusMm = 1; }), /port: a rect opening has square corners; use shape "rounded-rect" for cornerRadiusMm/);
});

test("I: through standoffs: the floor-hole stage cuts each clearance hole up through the floor under its standoff", async () => {
  const { fake, result } = await build(with_((value) => { value.standoffs = { heightMm: 3, fastener: { screw: "M2.5", mode: "through", clearanceFit: "free" } }; }));
  const stages = result.steps.map((step) => step.stage);
  const first = stages.indexOf("standoff-floor-holes");
  assert.ok(first > 0 && stages.lastIndexOf("standoffs") === first - 1, "after the standoffs");
  // Two Ø3.1 holes (free fit) through the 2 mm floor from the base bottom, 0.5 mm overshoot each side, then one cut.
  const calls = fake.calls.slice(first, first + 3).map((entry) => entry.operation === "boolean" ? `boolean:${String(entry.args[2])}` : entry.operation);
  assert.deepEqual(calls, ["createCylinder", "createCylinder", "boolean:difference"]);
  assert.deepEqual(rounded(fake.calls[first]!.args), [[5.5, 5.5, -0.5], 1.55, 3, [0, 0, 1]]);
  assert.deepEqual(rounded(fake.calls[first + 1]!.args), [[29.5, 19.5, -0.5], 1.55, 3, [0, 0, 1]]);
  assert.equal(result.derived.fasteners.standoffs!.holeDepthMm, 5, "standoff 3 + floor 2");
  assert.equal(result.undoSteps, result.derived.plannedUndoSteps);
});

// ------------------------------------------------------------------------------------------- read-back (governing rule)
test("read-back: a finished case reports native bounds equal to the plan, closed valid bodies and the shortest edge", async () => {
  const { fake, result } = await build({ ...REF, exploded: 5 });
  assert.equal(fake.validations, 1);
  assert.deepEqual(result.readBack, {
    toleranceMm: 1e-3, baseBoundsMm: result.derived.outerMm, lidBoundsMm: result.derived.lidMm, boardBoundsMm: result.derived.boardMm,
    bodies: [result.bodies.baseId, result.bodies.lidId, result.bodies.boardId!].map((id) => ({ id, closed: true, nativeValid: true })), minEdgeMm: 1,
  });
  // The lid's planned bounds: outer x/y, from the lip bottom (+ exploded) to the lid top.
  assert.deepEqual(result.derived.lidMm, { min: [0, 0, 17.1 + 5], max: [35, 25, 18.6 + 2 + 5] });
});

test("read-back: an invalid body, a sliver edge or bounds off the plan fail the call, which undoes every step and says so", async () => {
  const cases: Array<[string, Parameters<typeof fakeRuntime>[0], RegExp, BoardCaseInput]> = [
    ["invalid base", { invalid: (id) => id === 100 }, /read-back: body 100 is not closed, not natively valid/, REF],
    // The lid is body 122 (round 4: eight web bodies before it instead of ten).
    ["sliver edge on the lid", { shortEdge: (id) => id === 122 }, /read-back: body 122 has a 0\.01 mm edge \(short-122\), shorter than 0\.05 mm/, REF],
    ["lid not where planned", { skipMove: true }, /read-back: the lid bounds .* differ from the planned .* by up to 4 mm/, { ...REF, exploded: 4 }],
  ];
  for (const [name, options, pattern, input] of cases) {
    const fake = fakeRuntime(options);
    const before = fake.snapshot();
    const error = await new BoardCaseRecipe(fake.operations).create(input).then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof BoardCaseRecipeError, name);
    assert.equal(error.failedStage, "read-back", name);
    assert.match(error.message, pattern, name);
    assert.equal(error.undoneSteps, fake.calls.length, name);
    assert.match(error.message, new RegExp(`after ${error.completedSteps.length} confirmed native steps; undid ${error.completedSteps.length} native steps; the document matches the start`), name);
    assert.deepEqual(fake.snapshot().bodies, before.bodies, name);
    assert.equal(fake.snapshot().undoDepth, before.undoDepth, name);
  }
});

// =============================================================================================== round 3 (R1-R8)
const buildShared = (input: BoardCaseInput) => build(input, { sharedSketch: true });

test("R1: two profile openings on one face build; each profile Wire is removed right after its cut", async () => {
  const pair = (wall: "x-" | "lid" | "floor", second: Record<string, unknown>, shape: "rect" | "rounded-rect" = "rect") => review((input) => {
    const base = wall === "x-" ? { wall, shape, widthMm: 5, heightMm: 3, alongMm: 10, aboveBoardMm: 1 } : { wall, shape, widthMm: 6, heightMm: 4, alongMm: 10, acrossMm: 10 };
    const corner = shape === "rounded-rect" ? { cornerRadiusMm: 1 } : {};
    input.openings = [{ ...base, ...corner, label: "a" }, { ...base, ...corner, ...second, label: "b" }] as BoardCaseInput["openings"];
  });
  const cases: Array<[string, BoardCaseInput]> = [
    ["two rects on wall x-, web 0.4", pair("x-", { alongMm: 15.4 })],
    ["two rects on wall x-, web 1", pair("x-", { alongMm: 16 })],
    ["two rects on wall x-, web 10", pair("x-", { alongMm: 25 })],
    ["two rounded-rects on wall x-", pair("x-", { alongMm: 16 }, "rounded-rect")],
    ["two stacked rects on wall x-", review((input) => { input.openings = [{ wall: "x-", shape: "rect", widthMm: 5, heightMm: 2, alongMm: 20, aboveBoardMm: 0.5 }, { wall: "x-", shape: "rect", widthMm: 5, heightMm: 2, alongMm: 20, aboveBoardMm: 3 }]; })],
    ["two floor rects", pair("floor", { alongMm: 16.5 })],
    ["two lid rects", pair("lid", { alongMm: 30 })],
    ["a lid rect and lid vents", review((input) => { input.openings = [{ wall: "lid", shape: "rect", widthMm: 6, heightMm: 4, alongMm: 10, acrossMm: 10 }]; input.vents = { on: "lid", slots: 3, slotWidthMm: 2, slotLengthMm: 10, pitchMm: 4, centerAlongMm: 40 }; })],
  ];
  for (const [name, input] of cases) {
    const { fake, result } = await buildShared(input);
    assert.equal(result.undoSteps, result.derived.plannedUndoSteps, name);
    assert.equal(result.undoSteps, fake.calls.length, name);
    assert.equal(result.steps.filter((step) => step.operation === "delete-opening-profile").length, 1, name);
    assert.equal(fake.snapshot().regions.length, 0, `${name}: no construction Region left`);
  }
  // One opening, or openings on different faces, keep the single cleanup delete.
  assert.equal(planBoardCase(REF).openings[0]!.dropProfile, undefined);
});

test("R2: a floor boss and a standoff merge when each hole keeps 0.4 mm (51.5 x 28.3 board, holes 2 mm from the edges)", async () => {
  const input: BoardCaseInput = {
    originMm: [0, 0, 0],
    board: { lengthMm: 51.5, widthMm: 28.3, componentHeightMm: 8, holes: [[2, 2], [49.5, 2], [2, 26.3], [49.5, 26.3]].map(([xMm, yMm]) => ({ xMm: xMm!, yMm: yMm!, diameterMm: 3 })) },
    standoffs: { fastener: { screw: "M3", mode: "pilot", pilotDiameterMm: 2.5 } },
    lid: { fasteners: { screw: "M3", base: "pilot", pilotDiameterMm: 2.5, pilotDepthMm: 6 } },
    openings: [{ wall: "x-", shape: "rounded-rect", widthMm: 9, heightMm: 3.5, cornerRadiusMm: 1, alongMm: 14.15, aboveBoardMm: 0, label: "usb" }],
    boardStandIn: true,
    revision: "r0",
  };
  const plan = planBoardCase(input);
  assert.equal(plan.derived.bossStyle, "floor");
  // standoff 0 at (4.5, 10) and boss 0 at (4.5, 4.5): 5.5 mm apart, radii 3 + 3: merged; the boss stays 5.5 - 3 - 1.25 mm off the pilot.
  const [standoff] = plan.derived.standoffAxesMm;
  const [boss] = plan.derived.lidBossAxesMm;
  assert.ok(Math.hypot(standoff![0] - boss![0], standoff![1] - boss![1]) < 6);
  const { result } = await build(input);
  assert.equal(result.undoSteps, result.derived.plannedUndoSteps);
});

test("R4: gaps under 0.8 mm are closed by webs (benchmark, default floor), each with a probe point inside the closed gap", async () => {
  const derived = deriveBoardCase(styled(BENCHMARK, "floor"));
  const kinds = derived.webs.map((web) => web.kind);
  assert.deepEqual([kinds.filter((kind) => kind === "wall").length, kinds.filter((kind) => kind === "corner").length, kinds.filter((kind) => kind === "between").length], [4, 4, 4]);
  for (const web of derived.webs) {
    assert.ok(web.gapMm > 0 && web.gapMm < 0.8, `${web.label}: ${web.gapMm}`);
    const [px, py] = web.probeMm;
    // The probe lies in the web and in no feature circle (it is in the gap the web closes).
    if (web.box) assert.ok(px >= web.box.originMm[0] && px <= web.box.originMm[0] + web.box.sizeMm[0] && py >= web.box.originMm[1] && py <= web.box.originMm[1] + web.box.sizeMm[1], web.label);
    const circles = [...derived.standoffAxesMm.map((axis) => [axis, 3] as const), ...derived.lidBossAxesMm.map((axis) => [axis, 3] as const)];
    assert.ok(circles.every(([axis, radius]) => Math.hypot(px - axis[0], py - axis[1]) > radius), web.label);
  }
  // The board's x- wall gap: the standoff 0.1 mm from the wall (x = 2 + 0.5 + 2.6 - 3).
  assert.ok(derived.webs.some((web) => web.label === "standoff 0 and wall x-" && Math.abs(web.gapMm - 0.1) < 1e-9));
  // Built: one web stage (boxes and two-step strips, one join) right after the base shell.
  const { fake, result } = await build(styled(BENCHMARK, "floor"));
  assert.equal(result.undoSteps, result.derived.plannedUndoSteps);
  assert.equal(result.undoSteps, fake.calls.length);
  const stages = result.steps.map((step) => step.stage);
  assert.equal(stages.indexOf("webs"), 5);
  assert.equal(result.steps.filter((step) => step.stage === "webs" && step.operation === "join-webs").length, 1);
});

test("R4: a floor opening keeps 0.4 mm to a standoff and a lid opening 0.4 mm to a countersink (reviewer TF1, TF2)", async () => {
  await refusedBeforeNative(review((input) => { input.board.holes = [{ xMm: 10, yMm: 10, diameterMm: 3 }]; input.standoffs = { fastener: { screw: "M3", mode: "pilot", pilotDiameterMm: 2.5 } }; input.openings = [{ wall: "floor", shape: "rect", widthMm: 5, heightMm: 4, alongMm: 4.5, acrossMm: 10, label: "tf1" }]; }), /tf1 on the floor leaves less than the 0\.4 mm web to standoff 0/);
  await refusedBeforeNative(review((input) => { input.lid = lidPilot({ bossStyle: "floor" }); input.openings = [{ wall: "lid", shape: "rect", widthMm: 5, heightMm: 4, alongMm: 2.36, acrossMm: 4, label: "tf2" }]; }), /tf2 on the lid leaves less than the 0\.4 mm web to the lid boss 0 screw head/);
});

test("R5: the remaining late failures are refused in the plan (reviewer cases7, TF4, plan2)", async () => {
  const cases: Array<[string, (input: BoardCaseInput) => void, RegExp]> = [
    ["wall 1e6", (input) => { input.walls = { wallMm: 1e6, outerCornerRadiusMm: 0 }; }, /walls\.wallMm 1000000 exceeds the 50 mm shell limit/],
    ["floor 1e6", (input) => { input.walls = { floorMm: 1e6 }; }, /walls\.floorMm 1000000 exceeds the 50 mm shell limit/],
    ["lid 51", (input) => { input.walls = { lidMm: 51 }; }, /walls\.lidMm 51 exceeds the 50 mm shell limit/],
    ["board clearance 1e6", (input) => { input.fit = { boardClearanceMm: 1e6 }; }, /fit\.boardClearanceMm 1000000 exceeds the 50 mm board clearance limit/],
    ["lid pilot depth 1e6", (input) => { input.lid = lidPilot({ pilotDepthMm: 1e6 }); }, /lid\.fasteners\.pilotDepthMm 1000000 exceeds the 200 mm height limit/],
    ["board thickness 1e-6", (input) => { input.board.thicknessMm = 1e-6; input.boardStandIn = true; }, /board\.thicknessMm 0\.000001 is below the 0\.2 mm minimum board thickness/],
    ["lip depth 1e-6", (input) => { input.lid = { lipDepthMm: 1e-6 }; }, /lid\.lipDepthMm 0\.000001 is below the 0\.5 mm minimum lip depth/],
    ["outer radius 1e-6", (input) => { input.walls = { outerCornerRadiusMm: 1e-6 }; }, /walls\.outerCornerRadiusMm 0\.000001 must be 0 \(square\) or at least 0\.2 mm/],
    ["outer radius 2.0000001 (inner 1e-7)", (input) => { input.walls = { outerCornerRadiusMm: 2.0000001 }; }, /the inner corner radius would be 1e-7 mm .* it must be 0 or at least 0\.05 mm/],
    ["lid clearance 0.4999 (lip radius 1e-4)", (input) => { input.fit = { lidClearanceMm: 0.4999 }; }, /the lid lip corner radius .* would be 0\.0001 mm; it must be 0 or at least 0\.05 mm/],
    ["opening 0.01 x 0.01", (input) => { input.openings = [{ wall: "y-", shape: "rect", widthMm: 0.01, heightMm: 0.01, alongMm: 30, aboveBoardMm: 1, label: "dot" }]; }, /dot: a rect opening needs sides of at least 0\.5 mm/],
    ["vent slot width 0.01", (input) => { input.vents = { on: "lid", slots: 2, slotWidthMm: 0.01, slotLengthMm: 5, pitchMm: 4 }; }, /vents\.slotWidthMm 0\.01 is below the 0\.4 mm minimum slot width/],
    ["slot length = width + 0.02", (input) => { input.vents = { on: "lid", slots: 2, slotWidthMm: 2, slotLengthMm: 2.02, pitchMm: 4 }; }, /vents\.slotLengthMm 2\.02 must be at least vents\.slotWidthMm \+ 0\.5 \(2\.5\)/],
    ["rounded-rect radius 1.49 of 3", (input) => { input.openings = [{ wall: "y-", shape: "rounded-rect", widthMm: 8, heightMm: 3, cornerRadiusMm: 1.49, alongMm: 30, aboveBoardMm: 1, label: "rr" }]; }, /rr: cornerRadiusMm 1\.49 must be at most half the shorter side minus 0\.05 mm \(1\.45\), or exactly half \(1\.5\) for a slot/],
    ["TF4: lip neck between two notches", (input) => { input.board = { lengthMm: 30, widthMm: 10.46, componentHeightMm: 8 }; input.lid = { lipWallMm: 2.3, ...lidPilot() }; }, /the lid lip between the two boss notches along y is 0\.06 mm wide at its narrowest, below the 0\.8 mm minimum/],
  ];
  for (const [name, patch, pattern] of cases) await test(name, () => refusedBeforeNative(review(patch), pattern));
});

test("R5: a rounded-rect with radius exactly half the shorter side is built as a slot", async () => {
  const input = review((input) => { input.openings = [{ wall: "y-", shape: "rounded-rect", widthMm: 8, heightMm: 3, cornerRadiusMm: 1.5, alongMm: 30, aboveBoardMm: 1, label: "slot" }]; });
  assert.equal(planBoardCase(input).openings[0]!.slot, true);
  const { fake, result } = await build(input);
  const stage = result.steps.filter((step) => step.stage === "opening:slot").map((step) => step.operation);
  assert.deepEqual(stage, ["create-slot-profile", "extrude-slot-center-cutter", "create-slot-end-cutter", "create-slot-end-cutter", "boolean-difference"]);
  assert.equal(result.undoSteps, result.derived.plannedUndoSteps);
  assert.equal(result.undoSteps, fake.calls.length);
});

test("R6: a wall vent does not move the floor growth axis", () => {
  const withVent = deriveBoardCase(review((input) => { input.lid = lidPilot(); input.vents = { on: "y+", slots: 2, slotWidthMm: 1.5, slotLengthMm: 4, pitchMm: 4 }; }));
  const without = deriveBoardCase(review((input) => { input.lid = lidPilot(); }));
  assert.deepEqual([withVent.growAxis, withVent.cavityGrowthMm], [without.growAxis, without.cavityGrowthMm]);
  assert.equal(withVent.growAxisReason, "no wall carries an opening: the axis that adds less floor area");
});

test("R7: heat-set inserts work with the default standoff and boss diameters", async () => {
  const input = review((input) => {
    input.board.holes = [{ xMm: 6, yMm: 6, diameterMm: 2.7 }, { xMm: 54, yMm: 34, diameterMm: 2.7 }];
    input.standoffs = { heightMm: 5, fastener: { screw: "M2.5", mode: "heat-set-insert" } };
    input.lid = { fasteners: { screw: "M3", base: "heat-set-insert", insertLengthMm: 3 } };
  });
  const derived = deriveBoardCase(input);
  // Sourced insert hole 4 + 2 x 1.6 mm wall = 7.2 for both (board hole + 3 = 5.7 would leave too thin a wall).
  assert.deepEqual(derived.fasteners.standoffs!.outerDiametersMm, [7.2, 7.2]);
  assert.equal(derived.fasteners.lid!.bossDiameterMm, 7.2);
  const { result } = await build(input);
  assert.equal(result.undoSteps, result.derived.plannedUndoSteps);
  // A larger explicit diameter is kept; the plain default is unchanged without inserts.
  assert.equal(deriveBoardCase(review((value) => { value.lid = lidPilot(); })).fasteners.lid!.bossDiameterMm, 6);
});

test("R8: assembly.note says 'may not lower freely' inside the 0.2 mm margin and 'cannot be lowered' over the board outline", () => {
  // Hung Ø6 bosses clear the board itself when sqrt 2 x (c - 2.5) >= 3 (c >= 4.62) and its 0.2 mm margin from c >= 4.82.
  const note = (clearance: number) => deriveBoardCase(review((input) => { input.fit = { boardClearanceMm: clearance }; input.lid = lidPilot({ bossStyle: "hanging", allowBlockedBoard: true }); })).assembly;
  assert.deepEqual(note(4.7), { boardDropIn: false, note: "plan view: the board comes within 0.2 mm of lid boss 0, lid boss 1, lid boss 2, lid boss 3, so it may not lower freely; bossStyle \"floor\" keeps the bosses beside the board. The board has no holes, so there are no standoffs: it rests on the floor top" });
  assert.match(note(1).note, /overlap the board outline, so the board cannot be lowered straight into the finished base/);
});

// =============================================================================================== S: screw stack
const STACK: BoardCaseInput = {
  originMm: [0, 0, 0],
  board: { lengthMm: 51.5, widthMm: 28.3, holes: [[2.6, 2.6], [48.9, 2.6], [2.6, 25.7], [48.9, 25.7]].map(([xMm, yMm]) => ({ xMm: xMm!, yMm: yMm!, diameterMm: 3 })), componentHeightMm: 8 },
  // Round 4 (D9): 8 mm standoffs with 7 mm pilots, so a standard 20 mm screw fits (through 14.1, bottoming at 21.1).
  standoffs: { heightMm: 8, outerDiameterMm: 5 },
  // M2.5: the Ø3 board holes pass its 2.7 mm close-fit clearance (M3's is 3.2, refused below).
  lid: { fasteners: { screw: "M2.5", base: "pilot", pilotDiameterMm: 2.1, pilotDepthMm: 7, countersunk: false } },
  openings: [{ wall: "x-", shape: "rounded-rect", widthMm: 9.2, heightMm: 3.4, cornerRadiusMm: 1.2, alongMm: 14.15, aboveBoardMm: 1.6, label: "usb" }, { wall: "y-", shape: "rect", widthMm: 6, heightMm: 3, alongMm: 25.75, aboveBoardMm: 1, label: "button" }],
  boardStandIn: true,
  revision: "r0",
};

test("S: the default is stack when the board has 2+ holes the screws pass and no standoffs.fastener; derived reports the stack", () => {
  const derived = deriveBoardCase(STACK);
  assert.equal(derived.bossStyle, "stack");
  assert.equal(derived.bossStyleReason, "default: the lid screws go through the 4 board holes into the standoffs (stack)");
  // Board bottom 2 + 8, top 11.6; posts from 11.8 up to the wall top 11.6 + 8 + 1 + 1.5 = 22.1. D9: through the stack is
  // 2 + 10.3 + 0.2 + 1.6 = 14.1 mm, a screw bottoms at 14.1 + 7 = 21.1, and the longest standard length with 1 mm tip
  // clearance and 2 mm engagement is 20 (5.9 mm in the pilot).
  assert.deepEqual(derived.stack, { postAxesMm: derived.standoffAxesMm, postOuterDiametersMm: [5, 5, 5, 5], postBottomZMm: 11.8, postLengthMm: 10.3, holeDiameterMm: 2.9, screwLengthMm: 20, screwLengthMaxMm: 21.1, engagementMm: 5.9, note: "the posts reach 0.2 mm above the board inside the component envelope; component positions are not checked", lidWebs: [] });
  assert.deepEqual(derived.assembly, { boardDropIn: true, note: "bossStyle \"stack\": no corner bosses (the lid screws run through the board holes), so the board drops straight in onto the standoffs" });
  assert.deepEqual(derived.lidBossAxesMm, []);
  assert.equal(derived.cavityGrowthMm, undefined);
  assert.equal(derived.printability.lidPostOverhangDeg, 0);
  assert.equal(derived.printability.maxBossOverhangDeg, undefined);
  // The standoff holes take the lid fastener's base: Ø2.1 pilots 4 mm deep.
  assert.deepEqual([derived.fasteners.standoffs!.mode, derived.fasteners.standoffs!.holeDiameterMm, derived.fasteners.standoffs!.holeDepthMm], ["pilot", 2.1, 7]);
  // The outer footprint equals the hanging style's (nothing grows), and the lid reaches down to the post bottoms.
  const hanging = deriveBoardCase({ ...STACK, standoffs: { heightMm: 4, outerDiameterMm: 5, fastener: { screw: "M2.5", mode: "pilot", pilotDiameterMm: 2.1 } }, lid: { fasteners: { ...STACK.lid!.fasteners!, bossStyle: "hanging", allowBlockedBoard: true, pilotDepthMm: 6 } } });
  assert.deepEqual([derived.outerMm.min.slice(0, 2), derived.outerMm.max.slice(0, 2)], [hanging.outerMm.min.slice(0, 2), hanging.outerMm.max.slice(0, 2)]);
  assert.equal(derived.lidMm.min[2], 11.8);
});

test("S: stack is refused in the plan (and the default falls back to floor, saying why)", async () => {
  const lid = (extra: Partial<LidFasteners>) => ({ fasteners: { ...STACK.lid!.fasteners!, bossStyle: "stack" as const, ...extra } });
  await refusedBeforeNative({ ...STACK, board: { ...STACK.board, holes: [STACK.board.holes![0]!] }, lid: lid({}) }, /bossStyle "stack" needs at least 2 board holes for the lid screws \(the board has 1\)/);
  await refusedBeforeNative({ ...STACK, lid: lid({ screw: "M3", pilotDiameterMm: 2.5 }) }, /bossStyle "stack": board\.holes\[0\] \(Ø3\) is smaller than the M3 close-fit clearance Ø3\.2/);
  await refusedBeforeNative({ ...STACK, standoffs: { heightMm: 4, fastener: { screw: "M2.5", mode: "pilot", pilotDiameterMm: 2.1 } }, lid: lid({}) }, /with bossStyle "stack" the lid screws go into the standoffs, which take lid\.fasteners\.base; remove standoffs\.fastener/);
  await refusedBeforeNative({ ...STACK, standoffs: { heightMm: 8 }, lid: lid({}) }, /the lid post over board\.holes\[0\] reaches 0\.1 mm past the lid lip outline/);
  await refusedBeforeNative({ ...STACK, lid: lid({}), openings: [{ wall: "x-", shape: "rect", widthMm: 4, heightMm: 3, alongMm: 4, aboveBoardMm: 1, label: "near" }] }, /near on wall x-: the lid post over board\.holes\[0\] stands in its keep-out/);
  await refusedBeforeNative({ ...STACK, standoffs: { heightMm: 4, outerDiameterMm: 5 }, lid: lid({ pilotDepthMm: 5 }) }, /lid\.fasteners\.pilotDepthMm 5 exceeds the standoff height 4; raise standoffs\.heightMm/);
  // Default with M3: the stack is not possible (Ø3 < 3.2), so it falls back to floor and says why. Round 4 (D2): with
  // standoffs and no standoffs.fastener the floor fallback builds plain support posts under every hole (it was refused).
  const m3 = { fasteners: { screw: "M3" as const, base: "pilot" as const, pilotDiameterMm: 2.5, pilotDepthMm: 4 } };
  const supported = deriveBoardCase({ ...STACK, openings: [STACK.openings![0]!], lid: m3 });
  assert.equal(supported.bossStyle, "floor");
  assert.deepEqual([supported.fasteners.standoffs!.mode, supported.standoffAxesMm.length], ["support", 4]);
  assert.match(supported.bossStyleReason!, /^default: a screw stack is not possible \(bossStyle "stack": board\.holes\[0\] \(Ø3\) is smaller than the M3 close-fit clearance Ø3\.2/);
  const fallback = deriveBoardCase({ ...STACK, standoffs: undefined, openings: [STACK.openings![0]!], lid: m3 });
  assert.equal(fallback.bossStyle, "floor");
  assert.match(fallback.bossStyleReason!, /^default: a screw stack is not possible \(bossStyle "stack": board\.holes\[0\] \(Ø3\) is smaller than the M3 close-fit clearance Ø3\.2.*\), so the bosses stand on the floor$/);
  assert.equal(deriveBoardCase(REF).bossStyleReason, "lid.fasteners.bossStyle");
  assert.match(deriveBoardCase(styled(REF)).bossStyleReason!, /^default: standoffs\.fastener is given/);
});

test("S: the stack builds: lid posts hang from the plate coaxial with the board holes and the standoff pilots; read-back passes", async () => {
  const { fake, result } = await build(STACK);
  const derived = result.derived;
  assert.equal(result.undoSteps, derived.plannedUndoSteps);
  assert.equal(result.undoSteps, fake.calls.length);
  const stages = [...new Set(result.steps.map((step) => step.stage))];
  assert.deepEqual(stages, ["base-shell", "webs", "standoffs", "lid-shell", "lid-posts", "lid-screw-holes", "opening:usb", "opening:button", "board-stand-in", "cleanup"]);
  const posts = fake.calls.filter((entry) => entry.operation === "createCylinder" && entry.args[1] === 2.5 && JSON.stringify(entry.args[3]) === JSON.stringify([0, 0, -1]));
  // Post cylinders: from 0.5 mm inside the plate (z 22.1 + 0.5) down 10.3 + 0.5 to the post bottom 11.8; then the
  // Ø2.9 clearance holes from the post bottom up (cut from the free end).
  const axes = derived.standoffAxesMm.map(([x, y]) => [x, y]);
  assert.deepEqual(rounded(posts.slice(0, 4).map((entry) => entry.args)), axes.map(([x, y]) => [[x, y, 22.6], 2.5, 10.8, [0, 0, -1]]));
  // Lid screw holes: plain Ø2.9 through the plate on the same axes; standoff pilots Ø2.1 on the same axes.
  const lidHoles = fake.calls.filter((entry) => entry.operation === "createCylinder" && Math.abs((entry.args[1] as number) - 1.45) < 1e-9 && JSON.stringify(entry.args[3]) === JSON.stringify([0, 0, -1]));
  for (const [x, y] of axes) assert.ok(lidHoles.some((entry) => Math.abs((entry.args[0] as number[])[0]! - x!) < 1e-9 && Math.abs((entry.args[0] as number[])[1]! - y!) < 1e-9), `lid hole at ${x}, ${y}`);
  assert.ok(result.readBack.lidBoundsMm.min[2] === 11.8, "the lid's read-back bounds reach the post bottoms");
  assert.equal(derived.assembly.boardDropIn, true);
});

// R4 independent check (plan view, sampled): at each height, group the standoffs, bosses and webs into connected solids
// (touching or overlapping, the walls being one more solid); no two separate solids may be 0 to 0.8 mm apart.
function narrowGaps(input: BoardCaseInput): string[] {
  const plan = planBoardCase(input);
  const d = plan.derived;
  type Prim = { label: string; z: [number, number]; inside: (p: [number, number]) => number; samples: Array<[number, number]> };
  const cav = { min: [d.cavityMm.min[0], d.cavityMm.min[1]] as [number, number], max: [d.cavityMm.max[0], d.cavityMm.max[1]] as [number, number] };
  const ri = d.innerCornerRadiusMm;
  const step = 0.02;
  const circle = (label: string, c: [number, number], r: number, z: [number, number]): Prim => ({ label, z, inside: (p) => r - Math.hypot(p[0] - c[0], p[1] - c[1]), samples: Array.from({ length: 1440 }, (_, i) => [c[0] + r * Math.cos((i * Math.PI) / 720), c[1] + r * Math.sin((i * Math.PI) / 720)] as [number, number]) });
  const polygon = (label: string, points: Array<[number, number]>, z: [number, number]): Prim => {
    const edges = points.map((point, i) => [point, points[(i + 1) % points.length]!] as const);
    const samples: Array<[number, number]> = [];
    for (const [a, b] of edges) { const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step)); for (let i = 0; i <= n; i += 1) samples.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]); }
    const segment = (p: [number, number], a: readonly [number, number], b: readonly [number, number]) => { const vx = b[0] - a[0], vy = b[1] - a[1]; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / (vx * vx + vy * vy))); return Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy); };
    const contains = (p: [number, number]) => { let inside = false; for (const [a, b] of edges) if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside; return inside; };
    return { label, z, inside: (p) => (contains(p) ? 1 : -1) * Math.min(...edges.map(([a, b]) => segment(p, a, b))), samples };
  };
  const prims: Prim[] = [];
  const holeOf = new Map<string, number>();
  d.standoffAxesMm.forEach((axis, i) => prims.push(circle(`standoff ${i}`, axis as [number, number], d.fasteners.standoffs!.outerDiametersMm[i]! / 2, [d.floorTopZMm, d.standoffTopZMm!])));
  if (d.fasteners.lid && d.bossStyle !== "stack") d.lidBossAxesMm.forEach((axis, i) => prims.push(circle(`lid boss ${i}`, axis as [number, number], d.fasteners.lid!.bossDiameterMm / 2, [d.lidBossBottomZMm!, d.wallTopZMm])));
  for (const web of d.webs) {
    if (web.box) { const b = web.box; prims.push(polygon(web.label, [[b.originMm[0], b.originMm[1]], [b.originMm[0] + b.sizeMm[0], b.originMm[1]], [b.originMm[0] + b.sizeMm[0], b.originMm[1] + b.sizeMm[1]], [b.originMm[0], b.originMm[1] + b.sizeMm[1]]], [Math.max(b.originMm[2], d.floorTopZMm), b.originMm[2] + b.sizeMm[2]])); }
    else prims.push(polygon(web.label, web.strip!.cornersMm as Array<[number, number]>, [Math.max(web.strip!.bottomZMm, d.floorTopZMm), web.strip!.bottomZMm + web.strip!.heightMm]));
  }
  void holeOf;
  const wallGap = (p: [number, number]) => roundedRectInsideDistance(p, cav, ri);
  const problems: string[] = [];
  const heights = [...new Set(prims.flatMap((prim) => [prim.z[0] + 0.05, (prim.z[0] + prim.z[1]) / 2, prim.z[1] - 0.05]))];
  for (const z of heights) {
    const here = prims.filter((prim) => prim.z[0] < z && prim.z[1] > z);
    // Distance between two primitives: 0 when they overlap or touch, else the sampled boundary distance.
    const dist = (a: Prim, b: Prim) => Math.max(0, Math.min(...a.samples.map((p) => -b.inside(p)), ...b.samples.map((p) => -a.inside(p))));
    const wallDist = (a: Prim) => Math.max(0, Math.min(...a.samples.map(wallGap)));
    const parent = here.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    const WALL = -1;
    const touchesWall = here.map((prim) => wallDist(prim) <= 1e-6);
    for (let i = 0; i < here.length; i += 1) for (let j = i + 1; j < here.length; j += 1) if (dist(here[i]!, here[j]!) <= 1e-6) parent[find(i)] = find(j);
    const groupWall = new Set(here.map((_, i) => i).filter((i) => touchesWall[i]).map(find));
    for (let i = 0; i < here.length; i += 1) {
      if (!groupWall.has(find(i))) { const g = wallDist(here[i]!); if (g > 1e-6 && g < 0.8 - 1e-6) problems.push(`z ${z.toFixed(2)}: ${here[i]!.label} is ${g.toFixed(3)} mm from the wall`); }
      for (let j = i + 1; j < here.length; j += 1) {
        if (find(i) === find(j) || (groupWall.has(find(i)) && groupWall.has(find(j)))) continue;
        const g = dist(here[i]!, here[j]!);
        if (g > 1e-6 && g < 0.8 - 1e-6) problems.push(`z ${z.toFixed(2)}: ${here[i]!.label} and ${here[j]!.label} are ${g.toFixed(3)} mm apart`);
      }
    }
    void WALL;
  }
  return [...new Set(problems)];
}

test("R4: after the webs, no two separate solids at one height are 0 to 0.8 mm apart (sampled plan check on every live case and the reviewer boards)", async () => {
  const { caseArguments } = await import("../../scripts/verify-native-board-case-live.ts");
  const live = (["benchmark", "benchmark-tapered", "benchmark-hanging", "audit", "pod", "lip-notch", "openings", "corner-holes", "stack", "inserts"] as const).map((name) => [name, { ...caseArguments(name), revision: "r0" } as unknown as BoardCaseInput] as const);
  for (const [name, input] of [...live, ["REF", REF], ["REF tapered", styled(REF, "tapered")], ["REF floor", styled(REF, "floor")], ["AUDIT", AUDIT], ["BENCHMARK floor", styled(BENCHMARK, "floor")]] as const) {
    assert.deepEqual(narrowGaps(input), [], name);
  }
});

test("R4: a boss with a corner web gets the box lip notch whenever a lip corner piece would remain (no lip over the web)", () => {
  const plan = (innerCornerRadiusMm: number, bossDiameterMm: number) => planBoardCase(review((input) => { input.walls = { innerCornerRadiusMm }; input.lid = lidPilot({ bossStyle: "hanging", allowBlockedBoard: true, bossDiameterMm }); }));
  // Ø9.5 with a 1.2 mm inner radius: a corner pocket of 0.76 mm (webbed) and a lip corner piece over 1 mm: box notch.
  const webbed = plan(1.2, 9.5);
  assert.ok(webbed.derived.webs.some((web) => web.kind === "corner" && web.features.includes("lid boss 0")));
  assert.ok(lipCornerPieceMm({ inset: 4.25, notchRadius: 4.95, lipClearance: 0.2, lipWall: 1.2, outerRadius: 1, innerRadius: 0 }) >= 1);
  assert.ok(webbed.lid.notches.every((notch) => notch.kind === "box"));
  // Ø10 with a square corner: a 1.36 mm pocket (no web) and a 1.38 mm piece: the round notch stays.
  const open = planBoardCase(review((input) => { input.walls = { outerCornerRadiusMm: 0 }; input.lid = lidPilot({ bossStyle: "hanging", allowBlockedBoard: true, bossDiameterMm: 10 }); }));
  assert.ok(!open.derived.webs.some((web) => web.kind === "corner"));
  assert.ok(open.lid.notches.every((notch) => notch.kind === "cylinder"));
});

test("R3: walls.innerCornerRadiusMm is refused above half the cavity", async () => {
  await refusedBeforeNative(review((input) => { input.fit = { boardClearanceMm: 30 }; input.walls = { innerCornerRadiusMm: 60 }; }), /walls\.innerCornerRadiusMm 60 must be less than half the cavity size minus 0\.05 mm \(49\.95\)/);
});

test("S: a lid post 0 to 0.8 mm from the lip's inner face is joined to the lip by a lid web (built)", async () => {
  // Holes 3.7 mm from the x edges: post axes 2 + 0.5 + 3.7 = 6.2 from the outer face, the lip inner face at 2 + 1.4 = 3.4,
  // so a Ø5 post leaves 6.2 - 3.4 - 2.5 = 0.3 mm.
  const input: BoardCaseInput = { ...STACK, board: { ...STACK.board, holes: [{ xMm: 3.7, yMm: 14.15, diameterMm: 3 }, { xMm: 47.8, yMm: 14.15, diameterMm: 3 }] }, openings: [STACK.openings![1]!] };
  const plan = planBoardCase(input);
  assert.deepEqual(plan.derived.stack!.lidWebs.map((web) => [web.label, r6(web.gapMm)]), [["the lid post over board.holes[0] and the lid lip x-", 0.3], ["the lid post over board.holes[1] and the lid lip x+", 0.3]]);
  // The web is the lip's height (lip bottom to 0.5 mm into the plate) and as wide as the post.
  const web = plan.lidWebs![0]!;
  assert.deepEqual([rounded(web.sizeMm[1]), rounded(web.sizeMm[2])], [5, rounded(plan.derived.wallTopZMm + 0.5 - (plan.derived.wallTopZMm - 1.5))]);
  const { fake, result } = await build(input);
  assert.ok(result.steps.some((step) => step.stage === "lid-webs" && step.operation === "join-lid-webs"));
  assert.equal(result.undoSteps, result.derived.plannedUndoSteps);
  assert.equal(result.undoSteps, fake.calls.length);
});

// =============================================================================================== round 4 (D1-D9)
const corners4 = (length: number, width: number, diameterMm: number, inset: number) => [[inset, inset], [length - inset, inset], [inset, width - inset], [length - inset, width - inset]].map(([xMm, yMm]) => ({ xMm: xMm!, yMm: yMm!, diameterMm }));
const m3Pilot = { screw: "M3" as const, base: "pilot" as const, pilotDiameterMm: 2.5, pilotDepthMm: 6 };
// The reviewer's three D2 inputs: the 51.5 x 28.3 board, four holes 2.0 mm from the edges, M3 lid screws, no standoffs key.
const D2_INPUTS: Array<[string, BoardCaseInput]> = [
  ["Ø3 holes, Ø2.5 x 6 pilots", { originMm: [0, 0, 0], board: { lengthMm: 51.5, widthMm: 28.3, holes: corners4(51.5, 28.3, 3, 2), componentHeightMm: 8 }, lid: { fasteners: { ...m3Pilot } }, boardStandIn: true, revision: "r0" }],
  ["Ø3.2 holes, Ø2.5 x 6 pilots", { originMm: [0, 0, 0], board: { lengthMm: 51.5, widthMm: 28.3, holes: corners4(51.5, 28.3, 3.2, 2), componentHeightMm: 8 }, lid: { fasteners: { ...m3Pilot } }, boardStandIn: true, revision: "r0" }],
  ["Ø3 holes, heat-set inserts", { originMm: [0, 0, 0], board: { lengthMm: 51.5, widthMm: 28.3, holes: corners4(51.5, 28.3, 3, 2), componentHeightMm: 8 }, lid: { fasteners: { screw: "M3", base: "heat-set-insert", insertLengthMm: 3 } }, boardStandIn: true, revision: "r0" }],
];

test("D2: the reviewer's three default inputs give a supported board: floor bosses and a plain support post under every hole", async () => {
  for (const [name, input] of D2_INPUTS) {
    const derived = deriveBoardCase(input);
    assert.equal(derived.bossStyle, "floor", name);
    // A standoff under every hole, on the hole's axis (board origin = cavity + clearance + half the growth).
    assert.deepEqual(derived.standoffAxesMm, input.board.holes!.map((hole) => [r6(derived.boardMm.min[0] + hole.xMm), r6(derived.boardMm.min[1] + hole.yMm)]), name);
    const standoffs = derived.fasteners.standoffs!;
    assert.deepEqual([standoffs.mode, standoffs.screw, standoffs.holeDiameterMm, standoffs.holeDepthMm, standoffs.heightMm, standoffs.source], ["support", undefined, 0, 0, 2, "none: plain support posts (no standoffs.fastener)"], name);
    // The board stand-in rests on them: its bottom is the standoff top, 2 mm (the underside clearance) above the floor.
    assert.deepEqual([derived.standoffTopZMm, derived.boardMm.min[2], derived.floorTopZMm], [4, 4, 2], name);
    assert.match(derived.assembly.note, /With no standoffs\.fastener the standoffs are plain support posts: the board rests on them, unscrewed$/, name);
    const { fake, result } = await build(input);
    const posts = result.steps.filter((step) => step.stage === "standoffs").map((step) => step.operation);
    assert.deepEqual(posts, ["create-support-post", "create-support-post", "create-support-post", "create-support-post", "join-support-posts"], name);
    // Each post is a plain cylinder from 0.5 mm inside the floor to the standoff top; no hole is cut in it.
    const cylinders = fake.calls.filter((entry) => entry.operation === "createCylinder" && Math.abs((entry.args[1] as number) - standoffs.outerDiametersMm[0]! / 2) < 1e-9 && (entry.args[0] as number[])[2] === 1.5 && entry.args[2] === 2.5);
    assert.deepEqual(rounded(cylinders.map((entry) => [(entry.args[0] as number[]).slice(0, 2), entry.args[2]])), derived.standoffAxesMm.map((axis) => [axis, 2.5]), name);
    assert.equal(result.undoSteps, result.derived.plannedUndoSteps, name);
    assert.equal(result.undoSteps, fake.calls.length, name);
    assert.deepEqual(result.readBack.boardBoundsMm, derived.boardMm, name);
  }
});

test("D2: every style puts a standoff under every hole; a board without holes has none and rests on the floor", () => {
  const board = D2_INPUTS[0]![1].board;
  for (const bossStyle of ["floor", "tapered", "hanging"] as const) {
    const derived = deriveBoardCase({ originMm: [0, 0, 0], board, lid: { fasteners: { ...m3Pilot, bossStyle, ...(bossStyle === "floor" ? {} : { allowBlockedBoard: true }) } }, revision: "r0" });
    assert.deepEqual([derived.bossStyle, derived.standoffAxesMm.length, derived.fasteners.standoffs!.mode, derived.standoffTopZMm, derived.boardMm.min[2]], [bossStyle, 4, "support", 4, 4], bossStyle);
  }
  // With a standoffs.fastener block the standoffs keep their screw holes, as before.
  assert.equal(deriveBoardCase({ originMm: [0, 0, 0], board, standoffs: { fastener: { screw: "M2.5", mode: "pilot", pilotDiameterMm: 2.1 } }, lid: { fasteners: { ...m3Pilot } }, revision: "r0" }).fasteners.standoffs!.mode, "pilot");
  // No lid screws at all: support posts too.
  assert.deepEqual([deriveBoardCase({ originMm: [0, 0, 0], board, revision: "r0" }).fasteners.standoffs!.mode, deriveBoardCase({ originMm: [0, 0, 0], board, revision: "r0" }).standoffAxesMm.length], ["support", 4]);
  // No holes: no standoffs; the board sits on the floor top and derived says so.
  const bare = deriveBoardCase(POD);
  assert.deepEqual([bare.standoffAxesMm, bare.fasteners.standoffs, bare.standoffTopZMm, bare.boardMm.min[2], bare.floorTopZMm], [[], undefined, undefined, 2, 2]);
  assert.match(bare.assembly.note, /The board has no holes, so there are no standoffs: it rests on the floor top$/);
  // An underside clearance cannot be kept without standoffs: refused, naming the fix.
  assert.throws(() => planBoardCase({ ...POD, board: { ...POD.board, undersideClearanceMm: 3 } }), /board\.undersideClearanceMm needs standoffs: a board without holes has none and rests on the floor; remove it or give board\.holes/);
});

// A 60 x 30 board with four holes 4.5 mm from the edges: Ø6.2 posts clear the lid lip, so a stack is possible.
const stackBoard = (diameterMm = 3.2, componentHeightMm = 8) => ({ lengthMm: 60, widthMm: 30, holes: corners4(60, 30, diameterMm, 4.5), componentHeightMm });

test("D2: in a stack the default standoff height holds the lid fastener (pilot depth + 1; insert pocket + 1), and the case height follows", () => {
  // Pilot 6.9 mm deep: standoffs 7.9 (it was 2, so the stack was refused); the board and the wall top rise with it.
  const pilot = deriveBoardCase({ originMm: [0, 0, 0], board: stackBoard(), lid: { fasteners: { ...m3Pilot, pilotDepthMm: 6.9 } }, revision: "r0" });
  assert.deepEqual([pilot.bossStyle, pilot.fasteners.standoffs!.heightMm, pilot.fasteners.standoffs!.holeDepthMm, pilot.standoffTopZMm, pilot.boardMm.min[2], pilot.wallTopZMm], ["stack", 7.9, 6.9, 9.9, 9.9, 2 + 7.9 + 1.6 + 8 + 1 + 1.5]);
  // M3 x 3 insert: pocket 4 (insert + 1), standoffs 5; M3 x 5.7: pocket 6.7, standoffs 7.7 (7.4 mm parts so a 16 mm screw fits).
  const insert = (insertLengthMm: number) => deriveBoardCase({ originMm: [0, 0, 0], board: stackBoard(3.2, 7.4), lid: { fasteners: { screw: "M3", base: "heat-set-insert", insertLengthMm, bossStyle: "stack" } }, revision: "r0" });
  assert.deepEqual([insert(3).fasteners.standoffs!.heightMm, insert(3).fasteners.standoffs!.holeDepthMm, insert(3).stack!.screwLengthMm], [5, 4, 16]);
  assert.deepEqual([insert(5.7).fasteners.standoffs!.heightMm, insert(5.7).fasteners.standoffs!.holeDepthMm, insert(5.7).stack!.screwLengthMm], [7.7, 6.7, 16]);
  // Never below the underside clearance (2 by default, 6 here; the 3.5 mm pilot alone would give 4.5), and an explicit
  // height still wins.
  assert.equal(deriveBoardCase({ originMm: [0, 0, 0], board: { ...stackBoard(3.2, 7.4), undersideClearanceMm: 6 }, lid: { fasteners: { ...m3Pilot, pilotDepthMm: 3.5, bossStyle: "stack" } }, revision: "r0" }).fasteners.standoffs!.heightMm, 6);
  assert.equal(deriveBoardCase({ originMm: [0, 0, 0], board: stackBoard(), standoffs: { heightMm: 9 }, lid: { fasteners: { ...m3Pilot, pilotDepthMm: 6.9 } }, revision: "r0" }).fasteners.standoffs!.heightMm, 9);
  // A shallow pilot never makes the default lower than 2 mm: the refusal is the screw length, not the standoff height.
  assert.throws(() => planBoardCase({ originMm: [0, 0, 0], board: stackBoard(), lid: { fasteners: { ...m3Pilot, pilotDepthMm: 0.8, bossStyle: "stack" } }, revision: "r0" }), (error: unknown) => error instanceof BoardCaseValidationError && /no standard screw length fits the stack/.test(error.message) && !/exceeds the standoff height/.test(error.message));
});

test("D2: lid.fasteners.screw \"auto\" takes the largest of M3, M2.5, M2 that passes the smallest board hole (stack), else M3, and says why", () => {
  const auto = (diameterMm: number, pilotDiameterMm: number, extra: Record<string, unknown> = {}) => deriveBoardCase({ originMm: [0, 0, 0], board: stackBoard(diameterMm), lid: { fasteners: { screw: "auto", base: "pilot", pilotDiameterMm, pilotDepthMm: 6.9, bossStyle: "stack", countersunk: false, ...extra } }, revision: "r0" }).fasteners.lid!;
  assert.deepEqual([auto(3.4, 2.5).screw, auto(3.4, 2.5).screwReason], ["M3", "screw \"auto\": M3, the largest whose close-fit clearance (Ø3.2) passes the smallest board hole (Ø3.4)"]);
  assert.deepEqual([auto(3, 2.1).screw, auto(3, 2.1).screwReason], ["M2.5", "screw \"auto\": M2.5, the largest whose close-fit clearance (Ø2.7) passes the smallest board hole (Ø3)"]);
  assert.deepEqual([auto(2.3, 1.6).screw, auto(2.3, 1.6).screwReason], ["M2", "screw \"auto\": M2, the largest whose close-fit clearance (Ø2.2) passes the smallest board hole (Ø2.3)"]);
  // The lid clearance hole follows the chosen screw (M2.5 medium: Ø2.9).
  assert.equal(auto(3, 2.1).lidHole.diameterMm, 2.9);
  assert.throws(() => auto(2, 1.6), /lid\.fasteners\.screw "auto": no screw passes the smallest board hole \(Ø2\); M2 needs its close-fit Ø2\.2/);
  // A style with no board holes to fit: M3.
  assert.deepEqual([auto(3, 2.5, { bossStyle: "floor", pilotDepthMm: 6 }).screw, auto(3, 2.5, { bossStyle: "floor", pilotDepthMm: 6 }).screwReason], ["M3", "screw \"auto\": M3 (bossStyle \"floor\" has no board holes to fit the screws through)"]);
  // The default style with "auto": the stack takes M2.5 through the Ø3 holes.
  const byDefault = deriveBoardCase({ originMm: [0, 0, 0], board: stackBoard(3), lid: { fasteners: { screw: "auto", base: "pilot", pilotDiameterMm: 2.1, pilotDepthMm: 6.9, countersunk: false } }, revision: "r0" });
  assert.deepEqual([byDefault.bossStyle, byDefault.fasteners.lid!.screw], ["stack", "M2.5"]);
  // An explicit screw is never changed: M3 through Ø3 holes is refused, and says what would pass.
  const explicit = { originMm: [0, 0, 0] as [number, number, number], board: stackBoard(3), lid: { fasteners: { ...m3Pilot, pilotDepthMm: 6.9, bossStyle: "stack" as const } }, revision: "r0" };
  assert.throws(() => planBoardCase(explicit), /board\.holes\[0\] \(Ø3\) is smaller than the M3 close-fit clearance Ø3\.2, so the lid screw cannot pass through the board; use M2\.5 or screw: "auto"/);
  assert.equal(deriveBoardCase({ originMm: [0, 0, 0], board: stackBoard(3.2), lid: { fasteners: { ...m3Pilot, pilotDepthMm: 6.9 } }, revision: "r0" }).fasteners.lid!.screwReason, "lid.fasteners.screw");
});

test("D2: bossStyleReason lists every stack rule that failed, each with the input change that passes it; with those changes the default is the stack", () => {
  const input = D2_INPUTS[0]![1];
  const reason = deriveBoardCase(input).bossStyleReason!;
  assert.match(reason, /^default: a screw stack is not possible \(bossStyle "stack": /);
  // Three rules fail, each once (the other holes are named, not repeated), each with its fix.
  assert.match(reason, /board\.holes\[0\] \(Ø3\) is smaller than the M3 close-fit clearance Ø3\.2, so the lid screw cannot pass through the board; use M2\.5 or screw: "auto" \(the same for board\.holes\[1\], board\.holes\[2\], board\.holes\[3\]\)/);
  assert.match(reason, /the lid post over board\.holes\[0\] reaches 0\.7 mm past the lid lip outline toward the base wall \(it must stay 0\.05 mm inside\); use standoffs\.outerDiameterMm 4\.499 or less, or move the hole inward \(the same for board\.holes\[1\], board\.holes\[2\], board\.holes\[3\]\)/);
  assert.match(reason, /no standard screw length fits the stack: it needs between 16\.1 and 19\.1 mm .*; use lid\.fasteners\.pilotDepthMm 6\.9 for a 20 mm screw \(the default standoff height follows\)\), so the bosses stand on the floor$/);
  assert.equal(reason.split("; ").filter((part) => /^(bossStyle "stack": )?(board\.holes|the lid post|no standard)/.test(part.replace(/^default: a screw stack is not possible \(/, ""))).length, 3);
  // Apply the three named changes (screw "auto" with the M2.5 pilot, Ø4.499 standoffs, 6.9 mm pilots): the default is the stack.
  const fixed = deriveBoardCase({ ...input, standoffs: { outerDiameterMm: 4.499 }, lid: { fasteners: { screw: "auto", base: "pilot", pilotDiameterMm: 2.1, pilotDepthMm: 6.9, countersunk: false } } });
  assert.deepEqual([fixed.bossStyle, fixed.bossStyleReason, fixed.fasteners.lid!.screw, fixed.stack!.screwLengthMm], ["stack", "default: the lid screws go through the 4 board holes into the standoffs (stack)", "M2.5", 20]);
});

// ------------------------------------------------------------------------------------------------------- D1
// The round-3 construction, for comparison: every web its own solid, each strip a rectangle from half a radius inside
// one circle to half a radius inside the other (its end faces showed outside the circles).
function round3Webs(plan: BoardCasePlan): BoardCasePlan {
  const d = plan.derived;
  const feature = (label: string) => {
    const index = Number(label.split(" ").at(-1));
    return label.startsWith("standoff") ? { axis: d.standoffAxesMm[index]!, radius: d.fasteners.standoffs!.outerDiametersMm[index]! / 2 } : { axis: d.lidBossAxesMm[index]!, radius: d.fasteners.lid!.bossDiameterMm / 2 };
  };
  const webSolids: BoardCaseWebSolid[] = d.webs.map((web) => {
    if (web.box) {
      const [x, y, z] = web.box.originMm;
      const [sx, sy, sz] = web.box.sizeMm;
      return { label: web.label, loopMm: [[x, y], [x + sx, y], [x + sx, y + sy], [x, y + sy]], bottomZMm: z, heightMm: sz, holes: [] };
    }
    const a = feature(web.features[0]!);
    const b = feature(web.features[1]!);
    const distance = Math.hypot(b.axis[0] - a.axis[0], b.axis[1] - a.axis[1]);
    const dir = [(b.axis[0] - a.axis[0]) / distance, (b.axis[1] - a.axis[1]) / distance] as const;
    const half = Math.min(a.radius, b.radius);
    const side = [-dir[1] * half, dir[0] * half] as const;
    const from = [a.axis[0] + (dir[0] * a.radius) / 2, a.axis[1] + (dir[1] * a.radius) / 2] as const;
    const to = [a.axis[0] + dir[0] * (distance - b.radius / 2), a.axis[1] + dir[1] * (distance - b.radius / 2)] as const;
    return { label: web.label, loopMm: [[from[0] - side[0], from[1] - side[1]], [to[0] - side[0], to[1] - side[1]], [to[0] + side[0], to[1] + side[1]], [from[0] + side[0], from[1] + side[1]]], bottomZMm: web.strip!.bottomZMm, heightMm: web.strip!.heightMm, holes: [] };
  });
  return { ...plan, webSolids };
}
const shortestBuiltEdge = (plan: BoardCasePlan) => Math.min(...boardCaseShortEdges(plan).filter((finding) => finding.stage === "built").map((finding) => finding.valueMm));
const clean = (plan: BoardCasePlan) => [boardCaseTangencies(plan), boardCaseShortEdges(plan)];
// Plasticity takes a closed profile's normal from the corner at its first point; a web profile must start at a convex one.
const profilesPointUp = (plan: BoardCasePlan) => [...plan.webSolids, ...(plan.lidWebSolids ?? [])].filter((solid) => !solid.box).every((solid) => {
  const [last, first, second] = [solid.loopMm.at(-1)!, solid.loopMm[0]!, solid.loopMm[1]!];
  return (first[0] - last[0]) * (second[1] - first[1]) - (first[1] - last[1]) * (second[0] - first[0]) > 1e-9;
});

test("D1a: a lid post tangent or near-tangent to the lip's inner face is joined to it by one web solid (stack)", async () => {
  // The reviewer's board: 60 x 30, Ø3.2 holes, Ø6.2 posts; 4.0 mm in, the posts are tangent to both lip faces of their
  // corner. (8 mm standoffs and 7 mm pilots, so a standard 20 mm screw fits: D9.)
  const input = (inset: number): BoardCaseInput => ({ originMm: [0, 0, 0], board: { lengthMm: 60, widthMm: 30, holes: corners4(60, 30, 3.2, inset), componentHeightMm: 8 }, standoffs: { heightMm: 8 }, lid: { fasteners: { ...m3Pilot, pilotDepthMm: 7 } }, revision: "r0" });
  for (const [inset, gap] of [[3.999, -0.001], [4, 0], [4.001, 0.001], [4.03, 0.03], [4.06, 0.06]] as const) {
    const plan = planBoardCase(input(inset));
    assert.equal(plan.derived.bossStyle, "stack", String(inset));
    // Two side webs and a corner box per post, joined into one L-shaped solid that reaches 0.2 mm into the lip.
    assert.deepEqual(plan.derived.stack!.lidWebs.map((web) => r6(web.gapMm)), Array.from({ length: 12 }, () => gap), String(inset));
    assert.deepEqual(plan.lidWebSolids!.map((solid) => solid.loopMm.length), [6, 6, 6, 6], String(inset));
    const lip = plan.derived.lipInnerMm;
    const first = plan.lidWebSolids!.find((solid) => solid.holes[0] === 0)!;
    const [postX, postY] = plan.derived.stack!.postAxesMm[0]!;
    assert.deepEqual(rounded([...first.loopMm].sort((a, b) => a[0] - b[0] || a[1] - b[1])), rounded([[lip.min[0] - 0.2, lip.min[1] - 0.2], [lip.min[0] - 0.2, postY + 3.1], [postX, postY], [postX, postY + 3.1], [postX + 3.1, lip.min[1] - 0.2], [postX + 3.1, postY]]), String(inset));
    assert.deepEqual(clean(plan), [[], []], String(inset));
    assert.ok(profilesPointUp(plan), String(inset));
    // Without the web solids the pair rule reports the four posts against the lip, at their signed gap.
    const bare = boardCaseTangencies({ ...plan, lidWebSolids: [] });
    if (Math.abs(gap) < 0.05) assert.deepEqual(bare.map((finding) => [finding.kind, finding.body, finding.features[0], r3(finding.valueMm)]), [0, 1, 2, 3].map((index) => ["tangent", "lid", "the lid lip", gap]).map((entry, index) => [entry[0], entry[1], entry[2], entry[3]].map((value, slot) => slot === 2 ? "the lid lip" : value)), String(inset));
    else assert.deepEqual(bare, [], String(inset));
    // The round-3 webs (two boxes per post, no corner box) left a pit as wide as the gap: an edge of that length.
    const sides = plan.lidWebs!.filter((web) => !web.label.endsWith("corner")).map((web) => ({ label: web.label, loopMm: [[web.originMm[0], web.originMm[1]], [web.originMm[0] + web.sizeMm[0], web.originMm[1]], [web.originMm[0] + web.sizeMm[0], web.originMm[1] + web.sizeMm[1]], [web.originMm[0], web.originMm[1] + web.sizeMm[1]]] as Array<[number, number]>, bottomZMm: web.originMm[2], heightMm: web.sizeMm[2], holes: [] }));
    if (gap > 0) assert.equal(r6(shortestBuiltEdge({ ...plan, lidWebSolids: sides })), gap, String(inset));
    const { fake, result } = await build(input(inset));
    assert.deepEqual(result.steps.filter((step) => step.stage === "lid-webs").map((step) => step.operation), [...Array.from({ length: 4 }, () => ["create-lid-web-profile", "extrude-lid-web"]).flat(), "join-lid-webs"], String(inset));
    assert.equal(result.undoSteps, fake.calls.length, String(inset));
    assert.equal(result.undoSteps, result.derived.plannedUndoSteps, String(inset));
  }
});

test("D1b: a standoff tangent or near-tangent to the cavity wall is joined to it, and to the floor boss beside it, by one web solid", async () => {
  // The reviewer's board: 51.5 x 28.3, Ø3 holes (Ø6 standoffs with Ø2.1 pilots), M3 floor bosses; 2.5 mm in, each
  // standoff is tangent to its y wall. The live read-back measured the round-3 edge at 2.49, 2.5 and 2.51.
  const input = (inset: number): BoardCaseInput => ({ originMm: [0, 0, 0], board: { lengthMm: 51.5, widthMm: 28.3, holes: corners4(51.5, 28.3, 3, inset), componentHeightMm: 8 }, standoffs: { fastener: { screw: "M2.5", mode: "pilot", pilotDiameterMm: 2.1 } }, lid: { fasteners: { ...m3Pilot } }, revision: "r0" });
  for (const [inset, gap, round3] of [[2.49, -0.01, 0.032979013], [2.5, 0, 0.035589326], [2.51, 0.01, 0.038196717], [2.56, 0.06, 0.051189293]] as const) {
    const plan = planBoardCase(input(inset));
    assert.equal(plan.derived.bossStyle, "floor", String(inset));
    assert.deepEqual(plan.derived.webs.filter((web) => web.kind === "wall").map((web) => [web.label, r6(web.gapMm)]), [0, 1, 2, 3].map((index) => [`standoff ${index} and wall ${index < 2 ? "y-" : "y+"}`, gap]), String(inset));
    // Per corner: the standoff's wall box, the strip to the boss, the fill under it and the boss's corner box are one
    // loop; the four bosses' full-height corner boxes stay boxes.
    assert.deepEqual(plan.webSolids.map((solid) => solid.box ? "box" : solid.loopMm.length), [9, 9, 9, 9, "box", "box", "box", "box"], String(inset));
    assert.deepEqual(plan.webSolids[0]!.holes, [0], String(inset));
    assert.deepEqual(clean(plan), [[], []], String(inset));
    assert.ok(profilesPointUp(plan), String(inset));
    // No web reaches more than 0.2 mm into a wall.
    const cavity = plan.derived.cavityMm;
    for (const solid of plan.webSolids) for (const point of solid.loopMm) assert.ok(point[0] >= cavity.min[0] - 0.2 - 1e-9 && point[0] <= cavity.max[0] + 0.2 + 1e-9 && point[1] >= cavity.min[1] - 0.2 - 1e-9 && point[1] <= cavity.max[1] + 0.2 + 1e-9, String(inset));
    // Without the webs: the standoffs against the wall (within the band), and against the bosses 0.02 mm away.
    const bare = boardCaseTangencies({ ...plan, webSolids: [] });
    assert.deepEqual(bare.filter((finding) => finding.features.includes("the cavity wall")).map((finding) => r3(finding.valueMm)), Math.abs(gap) < 0.05 ? [gap, gap, gap, gap] : [], String(inset));
    // The round-3 construction is predicted to give exactly the edge the live read-back measured.
    assert.ok(Math.abs(shortestBuiltEdge(round3Webs(plan)) - round3) < 1e-8, `${inset}: ${shortestBuiltEdge(round3Webs(plan))}`);
    const { fake, result } = await build(input(inset));
    assert.deepEqual(result.steps.filter((step) => step.stage === "webs").map((step) => step.operation), [...Array.from({ length: 4 }, () => ["create-web-profile", "extrude-web"]).flat(), ...Array.from({ length: 4 }, () => "create-web-box"), "join-webs"], String(inset));
    assert.equal(result.undoSteps, fake.calls.length, String(inset));
    assert.equal(result.undoSteps, result.derived.plannedUndoSteps, String(inset));
  }
});

test("D1c: the web between a standoff and a floor boss leaves no sliver (the round-3 strip gave the 0.0019 and 0.0356 mm edges)", () => {
  for (const [length, width] of [[35, 25.4], [25, 18]] as const) {
    for (const [diameter, screw, pilot, round3] of [[2.2, "M2", 1.6, 0.001923789], [2.7, "M2.5", 2.1, 0.035589326]] as const) {
      const name = `${length} x ${width}, Ø${diameter}`;
      const plan = planBoardCase({ originMm: [0, 0, 0], board: { lengthMm: length, widthMm: width, holes: corners4(length, width, diameter, 2.5), componentHeightMm: 8 }, standoffs: { heightMm: 5, fastener: { screw, mode: "pilot", pilotDiameterMm: pilot } }, lid: { fasteners: { screw, base: "pilot", pilotDiameterMm: pilot, pilotDepthMm: 5, headDiameterMm: screw === "M2" ? 3.8 : 4.7 } }, revision: "r0" });
      assert.equal(plan.derived.webs.filter((web) => web.kind === "between").length, 4, name);
      assert.deepEqual(clean(plan), [[], []], name);
      assert.ok(Math.abs(shortestBuiltEdge(round3Webs(plan)) - round3) < 1e-8, `${name}: ${shortestBuiltEdge(round3Webs(plan))}`);
      // The strip: its long sides end on the smaller circle (tangent points), its end notches stay inside the circles.
      const strip = plan.derived.webs.find((web) => web.kind === "between")!.strip!;
      assert.equal(strip.cornersMm.length, 6, name);
      const standoff = plan.derived.standoffAxesMm[0]!;
      const radius = plan.derived.fasteners.standoffs!.outerDiametersMm[0]! / 2;
      const fromAxis = strip.cornersMm.map((point) => Math.hypot(point[0] - standoff[0], point[1] - standoff[1]));
      assert.ok(Math.abs(fromAxis[0]! - radius) < 1e-6 && Math.abs(fromAxis[4]! - radius) < 1e-6 && Math.abs(fromAxis[5]! - radius / 2) < 1e-6, name);
    }
  }
});

test("D1: a plan the guards refuse names the nearest hole position that plans clean, and that position plans", () => {
  // Holes 1.999 mm in: each standoff's axis is 0.001 mm off its floor boss's, so a strip side runs 0.0005 mm from a
  // face of the same loop.
  const input: BoardCaseInput = { originMm: [0, 0, 0], board: { lengthMm: 35.7, widthMm: 37, holes: corners4(35.7, 37, 2.2, 1.999), componentHeightMm: 6 }, walls: { wallMm: 2.4 }, standoffs: { fastener: { screw: "M2", mode: "pilot", pilotDiameterMm: 1.6 } }, lid: { fasteners: { screw: "M2", base: "pilot", pilotDiameterMm: 1.6, pilotDepthMm: 7, bossStyle: "floor", headDiameterMm: 3.8 } }, revision: "r0" };
  const message = (() => { try { planBoardCase(input); return ""; } catch (error) { return (error as Error).message; } })();
  assert.match(message, /^the outline where standoff 0, the web at .* meet in the base would have an edge under 0\.001 mm at x 7\.499, y 10\.399, z 2, under the 0\.1 mm the plan allows \(and 3 more such spots\), which the kernel cannot build reliably; move board\.holes\[0\] 0\.05 mm toward the board centre along x \(to xMm 2\.049\), and board\.holes\[2\] the same way: that plans clean$/);
  const holes = input.board.holes!.map((hole, index) => index === 0 || index === 2 ? { ...hole, xMm: 2.049 } : hole);
  assert.deepEqual(clean(planBoardCase({ ...input, board: { ...input.board, holes } })), [[], []]);
  // The findings themselves, from the unguarded plan.
  const findings = boardCaseShortEdges(planBoardCase(input, undefined, { guards: false }));
  assert.deepEqual([...new Set(findings.map((finding) => `${finding.kind} ${finding.body} ${finding.stage} ${finding.holes.join(",")}`))], ["edge base built 0", "edge base built 2"]);
  assert.ok(findings.every((finding) => finding.valueMm < 0.001));
});

// An independent check of the pair rule for the sweep (its own sampling and distances): every pair of features of one
// body that shares a height, as { standoff / boss / post circles, cavity wall or lip faces, web solids }. A pair is
// "near" when its signed gap (least distance from one's surface to the other's material, negative inside) is within
// 0.05 mm of zero and the spot is not at least 0.1 mm inside a web solid.
function nearTangentPairs(plan: BoardCasePlan, countWebs = true): string[] {
  const d = plan.derived;
  type Prim = { label: string; z: [number, number]; web?: boolean; depth: (p: [number, number]) => number; samples: Array<[number, number]> };
  const circle = (label: string, c: [number, number], r: number, z: [number, number]): Prim => {
    const count = Math.ceil((2 * Math.PI * r) / 0.02);
    return { label, z, depth: (p) => Math.hypot(p[0] - c[0], p[1] - c[1]) - r, samples: Array.from({ length: count }, (_, i) => [c[0] + r * Math.cos((2 * Math.PI * i) / count), c[1] + r * Math.sin((2 * Math.PI * i) / count)] as [number, number]) };
  };
  const polygon = (label: string, points: Array<[number, number]>, z: [number, number]): Prim => {
    const edges = points.map((point, i) => [point, points[(i + 1) % points.length]!] as const);
    const samples: Array<[number, number]> = [];
    for (const [a, b] of edges) { const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.02)); for (let i = 0; i <= n; i += 1) samples.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]); }
    const toEdge = (p: [number, number], a: readonly [number, number], b: readonly [number, number]) => { const vx = b[0] - a[0], vy = b[1] - a[1]; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / (vx * vx + vy * vy))); return Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy); };
    const inside = (p: [number, number]) => { let hit = false; for (const [a, b] of edges) if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit; return hit; };
    return { label, z, web: true, depth: (p) => { let least = Infinity; for (const [a, b] of edges) least = Math.min(least, toEdge(p, a, b)); return (inside(p) ? -1 : 1) * least; }, samples };
  };
  const rect = (bounds: { min: number[]; max: number[] }) => ({ min: [bounds.min[0]!, bounds.min[1]!] as [number, number], max: [bounds.max[0]!, bounds.max[1]!] as [number, number] });
  const bodies: Prim[][] = [];
  const cavity = rect(d.cavityMm);
  const base: Prim[] = [{ label: "wall", z: [d.floorTopZMm, d.wallTopZMm], depth: (p) => roundedRectInsideDistance(p, cavity, d.innerCornerRadiusMm), samples: [] }];
  d.standoffAxesMm.forEach((axis, i) => base.push(circle(`standoff ${i}`, axis as [number, number], d.fasteners.standoffs!.outerDiametersMm[i]! / 2, [d.floorTopZMm, d.standoffTopZMm!])));
  if (d.fasteners.lid && d.bossStyle !== "stack") d.lidBossAxesMm.forEach((axis, i) => base.push(circle(`boss ${i}`, axis as [number, number], d.fasteners.lid!.bossDiameterMm / 2, [d.lidBossBottomZMm!, d.wallTopZMm])));
  if (countWebs) for (const solid of plan.webSolids) base.push(polygon(`web ${solid.label}`, solid.loopMm, [Math.max(solid.bottomZMm, d.floorTopZMm), solid.bottomZMm + solid.heightMm]));
  bodies.push(base);
  if (d.stack) {
    const outer = rect(d.lipOuterMm);
    const inner = rect(d.lipInnerMm);
    const lipBottom = d.lipOuterMm.min[2] - d.explodedMm;
    const lid: Prim[] = [{ label: "lip", z: [lipBottom, d.wallTopZMm], depth: (p) => Math.max(-roundedRectInsideDistance(p, outer, plan.lid.lipRadiusMm), roundedRectInsideDistance(p, inner, plan.lid.lipInnerRadiusMm)), samples: [] }];
    d.stack.postAxesMm.forEach((axis, i) => lid.push(circle(`post ${i}`, axis as [number, number], d.stack!.postOuterDiametersMm[i]! / 2, [d.stack!.postBottomZMm - d.explodedMm, d.wallTopZMm])));
    if (countWebs) for (const solid of plan.lidWebSolids ?? []) lid.push(polygon(`lid web ${solid.label}`, solid.loopMm, [lipBottom, d.wallTopZMm]));
    bodies.push(lid);
  }
  const near: string[] = [];
  for (const prims of bodies) for (let i = 0; i < prims.length; i += 1) for (let j = i + 1; j < prims.length; j += 1) {
    const a = prims[i]!;
    const b = prims[j]!;
    if ((a.web && b.web) || !(Math.min(a.z[1], b.z[1]) > Math.max(a.z[0], b.z[0]) + 1e-9)) continue;
    // Two sampled features whose boxes are more than 0.1 mm apart cannot be within the band (a wall or a lip has no samples).
    const box = (prim: Prim) => prim.samples.reduce((acc, p) => [Math.min(acc[0]!, p[0]), Math.min(acc[1]!, p[1]), Math.max(acc[2]!, p[0]), Math.max(acc[3]!, p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
    if (a.samples.length > 0 && b.samples.length > 0) {
      const [boxA, boxB] = [box(a), box(b)];
      if (boxA[0]! > boxB[2]! + 0.1 || boxB[0]! > boxA[2]! + 0.1 || boxA[1]! > boxB[3]! + 0.1 || boxB[1]! > boxA[3]! + 0.1) continue;
    }
    let gap = Infinity;
    let at: [number, number] = [0, 0];
    for (const [from, to] of [[a, b], [b, a]] as const) for (const p of from.samples) { const value = to.depth(p); if (value < gap) { gap = value; at = p; } }
    if (!(Math.abs(gap) < 0.05 - 1e-9)) continue;
    if (prims.some((other) => other.web && other !== a && other !== b && other.z[0] <= Math.max(a.z[0], b.z[0]) + 1e-9 && other.z[1] >= Math.min(a.z[1], b.z[1]) - 1e-9 && other.depth(at) <= -0.1)) continue;
    near.push(`${a.label} / ${b.label}: ${gap.toFixed(4)}`);
  }
  return near;
}

test("D1: a fixed-seed sweep of more than 3,000 passing plans has no feature pair within 0.05 mm of tangent and no edge under 0.1 mm", () => {
  // Boards 25 to 70 mm, holes 2.0 to 4.5 mm from the edges in 0.05 mm steps (a third nudged 0.001 to 0.03 mm, to sit
  // just off a tangent position), M2 / M2.5 / M3, walls 1.6 to 2.4 mm, every style and the default.
  let seed = 20261116;
  const random = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  const sizes = { M2: [2.2, 1.6, 3.8], "M2.5": [2.7, 2.1, 4.7], M3: [3.2, 2.5, undefined] } as const;
  const passed: Record<string, number> = {};
  const refusedByGuard: string[] = [];
  let inputs = 0;
  let rawNear = 0;
  let webbed = 0;
  let checkedIndependently = 0;
  while (Object.values(passed).reduce((sum, count) => sum + count, 0) < 3200 && inputs < 6000) {
    inputs += 1;
    const length = 25 + Math.round(random() * 450) / 10;
    const width = 25 + Math.round(random() * 450) / 10;
    const screw = pick(["M2", "M2.5", "M3"] as const);
    const style = pick([undefined, "stack", "floor", "tapered", "hanging"] as const);
    const [close, pilot, head] = sizes[screw];
    const diameter = close + pick([0, 0, 0.2]);
    const inset = () => r6(2 + Math.round(random() * 50) * 0.05 + (random() < 0.33 ? pick([-0.03, -0.01, -0.001, 0.001, 0.01, 0.03]) : 0));
    const ix = inset();
    const iy = random() < 0.6 ? ix : inset();
    const holes = (random() < 0.75 ? [[ix, iy], [length - ix, iy], [ix, width - iy], [length - ix, width - iy]] : [[ix, iy], [length - ix, width - iy]]).map(([x, y]) => ({ xMm: r6(x!), yMm: r6(y!), diameterMm: diameter }));
    const kind = style === "stack" ? pick(["none", "height", "diameter"] as const) : pick(["none", "fastener", "height", "diameter"] as const);
    const standoffs = kind === "none" ? undefined : kind === "fastener" ? { fastener: { screw, mode: "pilot" as const, pilotDiameterMm: pilot } } : kind === "height" ? { heightMm: pick([3, 5, 8]) } : { outerDiameterMm: diameter + pick([1.5, 2, 2.5, 3.5]) };
    const input: BoardCaseInput = {
      originMm: [0, 0, 0], board: { lengthMm: length, widthMm: width, holes, componentHeightMm: 3 + Math.round(random() * 8) }, walls: { wallMm: pick([1.6, 1.8, 2, 2.2, 2.4]) },
      ...(standoffs ? { standoffs } : {}),
      lid: { fasteners: { screw: random() < 0.15 ? "auto" : screw, base: "pilot", pilotDiameterMm: pilot, pilotDepthMm: pick([4, 5, 6, 7]), ...(style ? { bossStyle: style } : {}), ...(style === "tapered" || style === "hanging" ? { allowBlockedBoard: true } : {}), ...(head ? { headDiameterMm: head } : {}), countersunk: random() < 0.5 } },
      revision: "r0",
    };
    let plan: BoardCasePlan;
    try {
      plan = planBoardCase(input, undefined, { fixes: false });
    } catch (error) {
      assert.ok(error instanceof BoardCaseValidationError, `input ${inputs}: ${String(error)}`);
      if (/within 0\.05 mm of tangent|under the 0\.1 mm the plan allows|under the 0\.01 mm the plan allows/.test(error.message.replace(/\(the default bossStyle fell back.*$/, ""))) refusedByGuard.push(`input ${inputs}: ${error.message.slice(0, 160)}`);
      continue;
    }
    const key = `${plan.derived.bossStyle}${style ? "" : " (default)"}`;
    passed[key] = (passed[key] ?? 0) + 1;
    // The rule's own predictors, on every passing plan.
    assert.deepEqual(clean(plan), [[], []], `input ${inputs}`);
    assert.ok(profilesPointUp(plan), `input ${inputs}: a web profile would extrude down`);
    assert.equal(plan.derived.standoffAxesMm.length, holes.length, `input ${inputs}: a standoff under every hole`);
    if (plan.webSolids.length + (plan.lidWebSolids?.length ?? 0) > 0) webbed += 1;
    // The independent check, on the passing plans of every fourth input: no near pair as built, and whether there was one
    // before the webs.
    if (inputs % 4 === 0) {
      checkedIndependently += 1;
      assert.deepEqual(nearTangentPairs(plan), [], `input ${inputs}`);
      if (nearTangentPairs(plan, false).length > 0) rawNear += 1;
    }
  }
  const total = Object.values(passed).reduce((sum, count) => sum + count, 0);
  assert.ok(total >= 3200, `passing plans: ${total} of ${inputs}`);
  for (const key of ["stack", "stack (default)", "floor", "floor (default)", "tapered", "hanging"]) assert.ok((passed[key] ?? 0) >= 150, `${key}: ${passed[key] ?? 0}`);
  // The sweep does sit on tangent positions: among the plans checked independently, dozens had a pair within the band
  // before the webs (all snapped to a merge), and the guards refused only a handful of the inputs.
  assert.ok(checkedIndependently >= 700 && rawNear >= 25, `checked ${checkedIndependently}, near before the webs ${rawNear}`);
  assert.ok(webbed >= 2500, `plans with webs: ${webbed}`);
  assert.ok(refusedByGuard.length <= 10, refusedByGuard.join("\n"));
});

// ------------------------------------------------------------------------------------------------------- D3
test("D3: a lid post near two lip sides gets one web solid that fills the lip corner (no pit between two side webs)", async () => {
  // Holes 4.3 mm in: Ø6.2 posts 0.3 mm from both lip faces of their corner. Round 3 built two boxes per post and left a
  // 0.3 x 0.3 mm pit, 1.5 mm deep, between them at the lip corner.
  const input: BoardCaseInput = { originMm: [0, 0, 0], board: { lengthMm: 60, widthMm: 30, holes: corners4(60, 30, 3.2, 4.3), componentHeightMm: 8 }, standoffs: { heightMm: 8 }, lid: { fasteners: { ...m3Pilot, pilotDepthMm: 7 } }, revision: "r0" };
  const plan = planBoardCase(input);
  const lip = plan.derived.lipInnerMm;
  assert.deepEqual(plan.derived.stack!.lidWebs.slice(0, 3).map((web) => [web.label, r6(web.gapMm)]), [["the lid post over board.holes[0] and the lid lip x-", 0.3], ["the lid post over board.holes[0] and the lid lip y-", 0.3], ["the lid post over board.holes[0] and the lid lip x-/y- corner", 0.3]]);
  assert.equal(plan.lidWebSolids!.length, 4);
  // The pit's middle (0.15 mm off both lip faces) is inside the first post's web solid, and so is the lip corner itself.
  const inside = (loop: Array<[number, number]>, p: [number, number]) => { let hit = false; loop.forEach((a, i) => { const b = loop[(i + 1) % loop.length]!; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit; }); return hit; };
  const loop = plan.lidWebSolids![0]!.loopMm;
  assert.ok(inside(loop, [lip.min[0] + 0.15, lip.min[1] + 0.15]) && inside(loop, [lip.min[0] - 0.1, lip.min[1] - 0.1]));
  // In the round-3 webs (the two side boxes) it was in neither.
  const sides = plan.lidWebs!.filter((web) => !web.label.endsWith("corner") && web.label.includes("holes[0]"));
  assert.equal(sides.length, 2);
  assert.ok(sides.every((web) => !(lip.min[0] + 0.15 > web.originMm[0] && lip.min[0] + 0.15 < web.originMm[0] + web.sizeMm[0] && lip.min[1] + 0.15 > web.originMm[1] && lip.min[1] + 0.15 < web.originMm[1] + web.sizeMm[1])));
  // The solid is the lip's height (from the lip bottom to 0.5 mm into the plate).
  assert.deepEqual([plan.lidWebSolids![0]!.bottomZMm, plan.lidWebSolids![0]!.heightMm], [plan.derived.lipInnerMm.min[2], 1.5 + 0.5]);
  const { fake, result } = await build(input);
  // Each profile extrudes up (the fake takes the plane normal from the corner at the first point, like Plasticity).
  const extrusions = fake.calls.filter((entry) => entry.operation === "extrudeRegions");
  assert.equal(extrusions.length, 4);
  assert.ok(profilesPointUp(plan));
  assert.equal(result.undoSteps, result.derived.plannedUndoSteps);
});

// ------------------------------------------------------------------------------------------------------- D5
test("D5: derived.cornerGapMm is the real smallest diagonal play in every style (floor: the grown axis moves the corner away)", () => {
  // Independent: slide the board toward each cavity corner in 0.0005 mm steps until it leaves the rounded cavity or
  // meets a floor boss or a full-height web box.
  const play = (input: BoardCaseInput): number => {
    const plan = planBoardCase(input);
    const d = plan.derived;
    const cavity = { min: [d.cavityMm.min[0], d.cavityMm.min[1]] as [number, number], max: [d.cavityMm.max[0], d.cavityMm.max[1]] as [number, number] };
    const bosses = d.bossStyle === "floor" ? d.lidBossAxesMm : [];
    const radius = (d.fasteners.lid?.bossDiameterMm ?? 0) / 2;
    const boxes = plan.webSolids.filter((solid) => solid.box && solid.bottomZMm + solid.heightMm > d.boardMm.min[2] + 1e-9 && solid.bottomZMm < d.boardMm.max[2] - 1e-9).map((solid) => solid.box!);
    let least = Infinity;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      for (let slide = 0; slide < 20; slide += 0.0005) {
        const dx = (sx * slide) / Math.SQRT2;
        const dy = (sy * slide) / Math.SQRT2;
        const min = [d.boardMm.min[0] + dx, d.boardMm.min[1] + dy] as const;
        const max = [d.boardMm.max[0] + dx, d.boardMm.max[1] + dy] as const;
        const outside = ([[min[0], min[1]], [max[0], min[1]], [min[0], max[1]], [max[0], max[1]]] as Array<[number, number]>).some((point) => roundedRectInsideDistance(point, cavity, d.innerCornerRadiusMm) < 0);
        const boss = bosses.some((axis) => Math.hypot(Math.max(min[0] - axis[0], 0, axis[0] - max[0]), Math.max(min[1] - axis[1], 0, axis[1] - max[1])) < radius);
        const box = boxes.some((entry) => min[0] < entry.originMm[0] + entry.sizeMm[0] && max[0] > entry.originMm[0] && min[1] < entry.originMm[1] + entry.sizeMm[1] && max[1] > entry.originMm[1]);
        if (outside || boss || box) { least = Math.min(least, slide); break; }
      }
    }
    return least;
  };
  const cases: Array<[string, BoardCaseInput, number]> = [
    // Floor: the corner bosses stand beside the board on the grown axis, so the board meets the other axis's wall first:
    // sqrt 2 x 0.5 (round 3 reported 0.5, the hung styles' value).
    ["benchmark, floor", styled(BENCHMARK, "floor"), Math.SQRT2 * 0.5],
    ["60 x 40, floor, clearance 0.8", review((input) => { input.fit = { boardClearanceMm: 0.8 }; input.lid = lidPilot({ bossStyle: "floor" }); }), Math.SQRT2 * 0.8],
    // Hung bosses, a stack and no bosses: the rounded cavity corner, sqrt 2 x c - Ri x (sqrt 2 - 1).
    ["benchmark, hanging", BENCHMARK, 0.5],
    ["stack", STACK, 0.5],
    ["pod", POD, Math.SQRT2 * 0.15 - 0.15 * (Math.SQRT2 - 1)],
    ["60 x 40, square corners", review((input) => { input.walls = { outerCornerRadiusMm: 0 }; }), Math.SQRT2 * 0.5],
  ];
  for (const [name, input, expected] of cases) {
    const derived = deriveBoardCase(input).cornerGapMm;
    assert.ok(Math.abs(derived - expected) < 1e-8, `${name}: ${derived} vs ${expected}`);
    assert.ok(Math.abs(derived - play(input)) < 1e-3, `${name}: ${derived} vs the stepped ${play(input)}`);
  }
});

// ------------------------------------------------------------------------------------------------------- D9
test("D9: stack.screwLengthMm is the longest standard length with 1 mm tip clearance and 2 mm engagement; screwLengthMaxMm is the bottoming length", () => {
  // (The standoff height is given, pilot depth + 1, so this test does not lean on the D2 default.)
  const stack = (componentHeightMm: number, pilotDepthMm: number) => deriveBoardCase({ originMm: [0, 0, 0], board: stackBoard(3.2, componentHeightMm), standoffs: { heightMm: pilotDepthMm + 1 }, lid: { fasteners: { ...m3Pilot, pilotDepthMm, bossStyle: "stack" } }, revision: "r0" }).stack!;
  // Through the stack: lid 2 + post (parts + 1 + lip 1.5 - 0.2) + 0.2 + board 1.6 = parts + 6.1.
  // 8 mm parts, 6.9 mm pilots: through 14.1, bottoming 21; the standard lengths are ..., 12, 16, 20, 24: 20 (5.9 in the pilot).
  assert.deepEqual([stack(8, 6.9).screwLengthMm, stack(8, 6.9).screwLengthMaxMm, stack(8, 6.9).engagementMm], [20, 21, 5.9]);
  // 6 mm parts, 6 mm pilots: through 12.1, bottoming 18.1: 16 (3.9 in the pilot; 20 would bottom).
  assert.deepEqual([stack(6, 6).screwLengthMm, stack(6, 6).screwLengthMaxMm, stack(6, 6).engagementMm], [16, 18.1, 3.9]);
  // 2 mm parts, 5 mm pilots: through 8.1, bottoming 13.1: 2 mm steps up to 12, so 12 (12.1 is the limit; 3.9 in the pilot).
  assert.deepEqual([stack(2, 5).screwLengthMm, stack(2, 5).screwLengthMaxMm, stack(2, 5).engagementMm], [12, 13.1, 3.9]);
  assert.match(stack(8, 6.9).note, /^the posts reach 0\.2 mm above the board inside the component envelope; component positions are not checked$/);
  // No standard length between 16.1 (2 mm in) and 19.1 (1 mm short of the bottom): refused, with the pilot depth that fits.
  assert.throws(() => stack(8, 6), /bossStyle "stack": no standard screw length fits the stack: it needs between 16\.1 and 19\.1 mm \(lid \+ post \+ 0\.2 mm gap \+ board = 14\.1 mm, at least 2 mm in the 6 mm standoff hole, 1 mm tip clearance; standard lengths step 2 mm to 12, then 4 mm\); use lid\.fasteners\.pilotDepthMm 6\.9 for a 20 mm screw \(the default standoff height follows\)/);
});

// ------------------------------------------------------------------------------------------------------- D8
test("D8: a sub-recipe failure that the board case rolled back says once that everything was undone", async () => {
  // The standoff pattern's union (the second Boolean union: the first joins the webs) fails natively.
  const secondUnionFails = (options: Parameters<typeof fakeRuntime>[0] = {}) => {
    let unions = 0;
    const inner = fakeRuntime(options);
    const original = inner.operations.boolean.bind(inner.operations);
    inner.operations.boolean = (async (targets: number[], tools: number[], kind: string, keep: boolean, revision: string) => {
      if (kind === "union" && (unions += 1) === 2) throw new Error("Plasticity command failed: Error: Operation Boolean failed at PK_BODY_boolean_2 with error `21653`.");
      return original(targets, tools, kind as never, keep, revision);
    }) as typeof inner.operations.boolean;
    return inner;
  };
  const runtime = secondUnionFails();
  const before = runtime.snapshot();
  const error = await new BoardCaseRecipe(runtime.operations).create(REF).then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof BoardCaseRecipeError);
  assert.equal(error.failedStage, "standoffs");
  assert.equal(error.restored, true);
  assert.match(error.message, /^Board case recipe failed in stage "standoffs" after 16 confirmed native steps; undid 16 native steps; the document matches the start \(bodies and Undo depth\); revision r\d+: Screw boss pattern recipe failed after 2\/6 confirmed steps; its partial geometry was undone with the rest; last confirmed revision r16: Plasticity command failed: .*21653/);
  assert.doesNotMatch(error.message, /partial geometry remains/);
  assert.deepEqual(runtime.snapshot().bodies, before.bodies);
  // When the rollback itself fails, the inner text stays: partial geometry does remain.
  const stuck = secondUnionFails({ failUndo: (index) => index === 2 ? new Error("undo refused") : undefined });
  const left = await new BoardCaseRecipe(stuck.operations).create(REF).then(() => undefined, (caught: unknown) => caught);
  assert.ok(left instanceof BoardCaseRecipeError);
  assert.equal(left.restored, false);
  assert.match(left.message, /does not match the start \(undo failed: undo refused\); inspect it; revision r\d+: Screw boss pattern recipe failed after 2\/6 confirmed steps; partial geometry remains/);
});

test("D1, D2: the live script's near-tangent sample (49 inputs) plans clean on tangent positions, its D2 and D3 cases plan, and every reject is refused", async () => {
  const { tangentSample, caseArguments, REVIEW_REJECTS } = await import("../../scripts/verify-native-board-case-live.ts");
  const sample = tangentSample();
  assert.equal(sample.length, 49);
  for (const band of ["a", "b", "c"]) assert.ok(sample.filter(([label]) => label.startsWith(`${band}:`)).length >= 9, `the reviewer's band ${band}`);
  const styles = new Set<string>();
  for (const [label, input] of sample) {
    const plan = planBoardCase({ ...input, revision: "r0" } as unknown as BoardCaseInput);
    styles.add(plan.derived.bossStyle!);
    assert.deepEqual(clean(plan), [[], []], label);
    assert.ok(profilesPointUp(plan), label);
    // Bands a, b and d to g sit within 0.06 mm of a tangent position (band a's last input is the D3 pit, 0.3 mm);
    // band c is the reviewer's strip between a standoff and a floor boss.
    const gaps = [...plan.derived.webs.map((web) => web.gapMm), ...(plan.derived.stack?.lidWebs.map((web) => web.gapMm) ?? [])];
    assert.ok(gaps.length > 0, label);
    if (label.startsWith("reviewer's")) {
      // The reviewer's own stack inputs: no standard screw fits, so floor bosses and a support post under every hole.
      assert.deepEqual([plan.derived.bossStyle, plan.derived.fasteners.standoffs!.mode, plan.derived.standoffAxesMm.length], ["floor", "support", 4], label);
      assert.match(plan.derived.bossStyleReason!, /no standard screw length fits the stack/, label);
    } else if (label.startsWith("c:")) assert.equal(plan.derived.webs.filter((web) => web.kind === "between").length, 4, label);
    else if (!label.includes("holes 4.3 mm in")) assert.ok(Math.min(...gaps.map(Math.abs)) <= 0.06 + 1e-9, `${label}: ${Math.min(...gaps.map(Math.abs))}`);
  }
  assert.deepEqual([...styles].sort(), ["floor", "hanging", "stack", "tapered"]);
  // The three D2 cases: floor bosses and a support post under each of the four holes; the D3 case: a stack with four lid web solids.
  for (const name of ["d2-holes-3", "d2-holes-3.2", "d2-inserts"] as const) {
    const derived = deriveBoardCase({ ...caseArguments(name), revision: "r0" } as unknown as BoardCaseInput);
    assert.deepEqual([derived.bossStyle, derived.fasteners.standoffs!.mode, derived.standoffAxesMm.length], ["floor", "support", 4], name);
  }
  const lipCorner = planBoardCase({ ...caseArguments("lip-corner"), revision: "r0" } as unknown as BoardCaseInput);
  assert.deepEqual([lipCorner.derived.bossStyle, lipCorner.lidWebSolids!.length], ["stack", 4]);
  for (const [label, input, pattern] of REVIEW_REJECTS) assert.throws(() => planBoardCase({ originMm: [2600, 0, 0], name: "reject", ...input, revision: "r0" } as unknown as BoardCaseInput), (error: unknown) => error instanceof Error && pattern.test(error.message), label);
});

test("D1, D3: a web profile that extrudes the wrong way is caught at once and rolled back (the read-back alone would not see it)", async () => {
  // Base: the first web profile of the D1b case (call 6) extrudes down into the floor.
  const floor: BoardCaseInput = { originMm: [0, 0, 0], board: { lengthMm: 51.5, widthMm: 28.3, holes: corners4(51.5, 28.3, 3, 2.5), componentHeightMm: 8 }, standoffs: { fastener: { screw: "M2.5", mode: "pilot", pilotDiameterMm: 2.1 } }, lid: { fasteners: { ...m3Pilot } }, revision: "r0" };
  const stack: BoardCaseInput = { originMm: [0, 0, 0], board: { lengthMm: 60, widthMm: 30, holes: corners4(60, 30, 3.2, 4.3), componentHeightMm: 8 }, standoffs: { heightMm: 8 }, lid: { fasteners: { ...m3Pilot, pilotDepthMm: 7 } }, revision: "r0" };
  for (const [name, input, stage, pattern] of [
    ["base web", floor, "webs", /the web profile \d+ must extrude from z 1\.5 up to 4, but its solid spans z -1 to 1\.5/],
    // Lid: a web that hangs 2 mm under the lip stays inside the lid's bounds (the posts reach lower), so only this check sees it.
    ["lid web", stack, "lid-webs", /the web profile \d+ must extrude from z 20\.6 up to 22\.6, but its solid spans z 18\.6 to 20\.6/],
  ] as const) {
    const clean = fakeRuntime();
    await new BoardCaseRecipe(clean.operations).create(input);
    const first = clean.calls.findIndex((entry, index) => entry.operation === "createPolyline" && clean.calls[index + 1]?.operation === "extrudeRegions" && (stage === "webs" || index > 20)) + 1;
    const fake = fakeRuntime({ flipProfile: (index) => index === first });
    const before = fake.snapshot();
    const error = await new BoardCaseRecipe(fake.operations).create(input).then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof BoardCaseRecipeError, name);
    assert.equal(error.failedStage, stage, name);
    assert.match(error.message, pattern, name);
    assert.equal(error.restored, true, name);
    assert.deepEqual(fake.snapshot().bodies, before.bodies, name);
    assert.equal(fake.snapshot().undoDepth, before.undoDepth, name);
  }
});

test("D1: an opening may not be cut where a web solid stands at the wall or hangs under the lid", async () => {
  // Floor style, holes 3.0 mm in: boss 0 covers x 1.5 to 7.5 along the y- wall and standoff 0 covers 8 to 14; the fill
  // under the strip between them stands at the wall from 4.5 to 11. A 0.5 mm opening at 7.5 to 8, below the board,
  // misses both circles' footprints but would cut into that fill.
  const base: BoardCaseInput = { originMm: [0, 0, 0], board: { lengthMm: 51.5, widthMm: 28.3, holes: corners4(51.5, 28.3, 3, 3), componentHeightMm: 8 }, standoffs: { fastener: { screw: "M2.5", mode: "pilot", pilotDiameterMm: 2.1 } }, lid: { fasteners: { ...m3Pilot, growAxis: "x" } }, revision: "r0" };
  const plan = planBoardCase(base);
  assert.deepEqual([plan.derived.lidBossAxesMm[0], plan.derived.standoffAxesMm[0], plan.derived.boardMm.min[0]], [[4.5, 4.5], [11, 5.5], 8]);
  await refusedBeforeNative({ ...base, openings: [{ wall: "y-", shape: "rect", widthMm: 0.5, heightMm: 1, alongMm: -0.25, aboveBoardMm: -3.4, label: "low" }] }, /low on wall y- collides with the web at standoff 0 and wall y-; lid boss 0 and the x-\/y- corner; standoff 0 and lid boss 0/);
  // The same opening above the board (over the webs, which end at the board bottom) is fine.
  assert.ok(planBoardCase({ ...base, openings: [{ wall: "y-", shape: "rect", widthMm: 0.5, heightMm: 1, alongMm: -0.25, aboveBoardMm: 1, label: "high" }] }));
  // Stack, posts 0.3 mm from two lip sides: a 1 x 1 lid opening in the corner between post and lip sits on the lid web.
  const stack: BoardCaseInput = { originMm: [0, 0, 0], board: { lengthMm: 60, widthMm: 30, holes: corners4(60, 30, 3.2, 4.3), componentHeightMm: 8 }, standoffs: { heightMm: 8 }, lid: { fasteners: { ...m3Pilot, pilotDepthMm: 7, countersunk: false, bossStyle: "stack" } }, revision: "r0" };
  const corner = [{ wall: "lid" as const, shape: "rect" as const, widthMm: 1, heightMm: 1, alongMm: 1.5, acrossMm: 1.5, label: "corner" }];
  await refusedBeforeNative({ ...stack, openings: corner }, /corner on the lid leaves less than the 0\.4 mm web to the lid web at the lid post over board\.holes\[0\] and the lid lip x-/);
  assert.equal(planBoardCase({ ...stack, openings: [{ wall: "lid", shape: "rect", widthMm: 6, heightMm: 6, alongMm: 30, acrossMm: 15, label: "middle" }] }).derived.bossStyle, "stack");
  // By default the same opening sends the case to floor bosses, and the reason says why.
  const fallback = deriveBoardCase({ ...stack, lid: { fasteners: { ...m3Pilot, pilotDepthMm: 7, countersunk: false } }, openings: corner });
  assert.equal(fallback.bossStyle, "floor");
  assert.match(fallback.bossStyleReason!, /corner on the lid leaves less than the 0\.4 mm web to the lid web/);
});
