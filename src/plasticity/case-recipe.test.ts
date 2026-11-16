import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BoardCaseRecipe,
  BoardCaseRecipeError,
  BoardCaseValidationError,
  deriveBoardCase,
  maxBossOverhangDeg,
  planBoardCase,
  requireBoardCaseInvariants,
  type BoardCaseInput,
  type BoardCaseOperations,
} from "./case-recipe.ts";
import { CALLER_SOURCE, CLEARANCE_HOLE_SOURCE, COUNTERSUNK_HEAD_SOURCE, HEAT_SET_INSERT_SOURCE } from "./fastener-presets.ts";
import type { RuntimeState } from "./runtime.ts";

type V3 = [number, number, number];

// ---------------------------------------------------------------------------------------------------- fake runtime
// Bodies, regions and an undo history; every mutation checks the revision it is given, records itself and can fail.
function fakeRuntime(options: { fail?: (operation: string, index: number) => Error | undefined; failUndo?: (index: number) => Error | undefined; keepTools?: (index: number) => boolean } = {}) {
  let revision = 0;
  let nextId = 100;
  let bodies: RuntimeState["bodies"] = [solid(1, "existing", [])];
  let regions: RuntimeState["regions"] = [];
  const history: Array<{ bodies: RuntimeState["bodies"]; regions: RuntimeState["regions"] }> = [];
  const calls: Array<{ operation: string; args: unknown[] }> = [];
  let undoCalls = 0;
  let reads = 0;
  const snapshot = (): RuntimeState => ({
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: `r${revision}`, dbVersion: revision,
    undoDepth: history.length, redoDepth: 0, construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" },
    regions: structuredClone(regions), bodies: structuredClone(bodies),
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
  const operations = {
    async state() { reads += 1; return snapshot(); },
    async createBox(originMm: V3, sizeMm: V3, name: string | undefined, given: string) {
      return mutate("createBox", [originMm, sizeMm, name ?? null], given, () => { bodies.push(solid(nextId++, name ?? null, boxEdges(nextId))); });
    },
    async createCylinder(centerMm: V3, radiusMm: number, heightMm: number, _name: string | undefined, given: string, axis: V3) {
      return mutate("createCylinder", [centerMm, radiusMm, heightMm, axis], given, () => { bodies.push(solid(nextId++, null, [])); });
    },
    async fillet(id: number, edgeIds: string[], radiusMm: number, given: string) {
      return mutate("fillet", [id, edgeIds, radiusMm], given, () => {});
    },
    async boolean(targetIds: number[], toolIds: number[], kind: string, keepTools: boolean, given: string) {
      return mutate("boolean", [targetIds, toolIds, kind, keepTools], given, () => { if (!options.keepTools?.(calls.length)) bodies = bodies.filter((body) => !toolIds.includes(body.id)); });
    },
    // A pointed cone leaves its profile Wire and one Solid, like the native command.
    async createCone(bottomCenterMm: V3, bottomRadiusMm: number, topRadiusMm: number, heightMm: number, axis: V3, radialDirection: V3, _name: string | undefined, given: string) {
      return mutate("createCone", [bottomCenterMm, bottomRadiusMm, topRadiusMm, heightMm, axis, radialDirection], given, () => {
        bodies.push({ ...solid(nextId++, null, []), type: "Wire" });
        bodies.push(solid(nextId++, null, []));
      });
    },
    async createPolyline(pointsMm: V3[], closed: boolean, given: string) {
      return mutate("createPolyline", [pointsMm, closed], given, () => {
        const id = nextId++;
        bodies.push({ ...solid(id, null, []), type: "Wire" });
        const min = [0, 1, 2].map((axis) => Math.min(...pointsMm.map((point) => point[axis]!))) as V3;
        const max = [0, 1, 2].map((axis) => Math.max(...pointsMm.map((point) => point[axis]!))) as V3;
        const normal = unit(cross(sub(pointsMm[1]!, pointsMm[0]!), sub(pointsMm[2]!, pointsMm[0]!)));
        regions.push({ id: `region-${id}`, entityId: id, islandVersionId: id, sketchId: id, sketchWireIds: [id], measurementSource: "render-mesh", displayBoundsMm: { min, max }, normal } as RuntimeState["regions"][number]);
      });
    },
    async extrudeRegions(regionIds: string[], distanceMm: number, given: string) {
      return mutate("extrudeRegions", [regionIds, distanceMm], given, () => {
        const normal = (regions.find((region) => region.id === regionIds[0]) as unknown as { normal: V3 }).normal;
        bodies.push(solid(nextId++, null, [0, 1, 2, 3].map((index) => line(`x${nextId}-${index}`, normal))));
      });
    },
    async revolveProfile(id: number, axisOriginMm: V3, axis: V3, angleDegrees: number, given: string) {
      return mutate("revolveProfile", [id, axisOriginMm, axis, angleDegrees], given, () => { bodies.push(solid(nextId++, null, [])); });
    },
    async remove(ids: number[], given: string) {
      return mutate("remove", [ids], given, () => { bodies = bodies.filter((body) => !ids.includes(body.id)); regions = regions.filter((region) => !region.sketchWireIds.some((id) => ids.includes(id))); });
    },
    async move(ids: number[], deltaMm: V3, given: string) { return mutate("move", [ids, deltaMm], given, () => {}); },
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
  return { operations: operations as unknown as BoardCaseOperations, calls, get undoCalls() { return undoCalls; }, get reads() { return reads; }, snapshot };
}

function solid(id: number, name: string | null, edges: RuntimeState["bodies"][number]["edges"]): RuntimeState["bodies"][number] {
  return { id, versionId: id, type: "Solid", name, boundsMm: null, faceIds: [], edgeIds: edges.map((edge) => edge.id), faces: [], edges };
}
function line(id: string, tangent: V3): RuntimeState["bodies"][number]["edges"][number] {
  return { id, curveType: "Line", line: true, circle: false, lengthMm: 1, centerMm: [0, 0, 0], tangent, boundsMm: { min: [0, 0, 0], max: [0, 0, 0] }, faceIds: [], vertexIds: [] };
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

// ------------------------------------------------------------------------------------------------- reference input
const REF: BoardCaseInput = {
  originMm: [0, 0, 0],
  board: { lengthMm: 30, widthMm: 20, holes: [{ xMm: 3, yMm: 3, diameterMm: 2.5 }, { xMm: 27, yMm: 17, diameterMm: 2.5 }], componentHeightMm: 5 },
  standoffs: { heightMm: 3, fastener: { screw: "M2.5", mode: "pilot", pilotDiameterMm: 2 } },
  lid: { fasteners: { screw: "M3", base: "pilot", pilotDiameterMm: 2.5, pilotDepthMm: 5, bossStyle: "hanging" } },
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
  lid: { fasteners: { screw: "M3", base: "pilot", pilotDiameterMm: 2.5, pilotDepthMm: 6, bossStyle: "hanging" } },
  openings: [{ wall: "x-", shape: "rounded-rect", widthMm: 9.2, heightMm: 3.4, cornerRadiusMm: 1.2, alongMm: 14.15, aboveBoardMm: 1.6, label: "usb" }],
  vents: { on: "lid", slots: 5, slotWidthMm: 2, slotLengthMm: 12, pitchMm: 4 },
  boardStandIn: true,
  revision: "r0",
};
const AUDIT: BoardCaseInput = {
  originMm: [0, 0, 0],
  board: { lengthMm: 75, widthMm: 45, holes: [[4, 4], [71, 4], [4, 41], [71, 41]].map(([xMm, yMm]) => ({ xMm: xMm!, yMm: yMm!, diameterMm: 2.7 })), componentHeightMm: 10.4 },
  standoffs: { heightMm: 5, outerDiameterMm: 7.5, fastener: { screw: "M2.5", mode: "heat-set-insert" } },
  lid: { fasteners: { screw: "M3", base: "heat-set-insert", insertLengthMm: 3, bossDiameterMm: 8, bossStyle: "hanging" } },
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
      name: "sensor pod: no holes, no standoffs, lid without screws",
      input: POD,
      expected: {
        outerMm: { min: [0, 0, 0], max: [22.1, 19.5, 11.1] }, cavityMm: { min: [2, 2, 2], max: [20.1, 17.5, 11.1] }, innerCornerRadiusMm: 0.15,
        boardMm: { min: [2.15, 2.15, 4], max: [19.95, 17.35, 5.6] }, wallTopZMm: 11.1, lidTopZMm: 13.1,
        standoffAxesMm: [], lidBossAxesMm: [], lipOuterMm: { min: [2.2, 2.2, 9.6], max: [19.9, 17.3, 11.1] }, openings: [], fasteners: {},
      },
    },
    {
      name: "exploded lid: lid features move up, the base stays",
      input: { ...POD, exploded: 10 },
      expected: { outerMm: { min: [0, 0, 0], max: [22.1, 19.5, 11.1] }, lidTopZMm: 23.1, explodedMm: 10, lipOuterMm: { min: [2.2, 2.2, 19.6], max: [19.9, 17.3, 21.1] } },
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
    const support = input.standoffs ? input.standoffs.heightMm ?? input.board.undersideClearanceMm ?? 2 : input.board.undersideClearanceMm ?? 2;
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
  assert.deepEqual(audit.standoffs, { screw: "M2.5", mode: "heat-set-insert", holeDiameterMm: 4, holeDepthMm: 5, outerDiametersMm: [7.5], heightMm: 5, source: HEAT_SET_INSERT_SOURCE, confidence: "medium", insert: "M2.5x4", minWallMm: 1.6 });
  assert.deepEqual(audit.lid, {
    screw: "M3", base: "heat-set-insert", bossDiameterMm: 8, bossLengthMm: 5,
    baseHole: { diameterMm: 4, depthMm: 4, source: HEAT_SET_INSERT_SOURCE, confidence: "medium", insert: "M3x3", minWallMm: 1.6 },
    lidHole: { diameterMm: 3.4, fit: "medium", source: CLEARANCE_HOLE_SOURCE, confidence: "medium" },
    countersink: { headDiameterMm: 6.72, includedAngleDeg: 90, depthMm: 1.66, source: COUNTERSUNK_HEAD_SOURCE, confidence: "medium" },
  });
  const benchmark = deriveBoardCase(BENCHMARK).fasteners;
  assert.equal(benchmark.standoffs?.source, CALLER_SOURCE);
  assert.equal(benchmark.standoffs?.holeDiameterMm, 2.5);
  assert.equal(benchmark.lid?.baseHole.source, CALLER_SOURCE);
  const through = deriveBoardCase(with_((value) => { value.standoffs = { heightMm: 3, fastener: { screw: "M2.5", mode: "through", clearanceFit: "free" } }; })).fasteners.standoffs;
  assert.deepEqual(through, { screw: "M2.5", mode: "through", holeDiameterMm: 3.1, holeDepthMm: 5, outerDiametersMm: [5.5], heightMm: 3, source: CLEARANCE_HOLE_SOURCE, confidence: "medium", clearanceFit: "free" });
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
  ["pilot standoffs without a pilot diameter", (input) => { delete input.standoffs!.fastener.pilotDiameterMm; }, /pilot diameter for M2\.5 in plastic is not sourced; pass pilotDiameterMm/],
  ["lid pilot without a pilot depth", (input) => { delete input.lid!.fasteners!.pilotDepthMm; }, /lid\.fasteners\.pilotDepthMm is required with base "pilot"/],
  ["ambiguous M3 insert", (input) => { input.lid!.fasteners = { screw: "M3", base: "heat-set-insert", bossDiameterMm: 8 }; }, /M3 has 2 sourced CNC Kitchen inserts; pass insertLengthMm 5\.7 or 3/],
  ["insert boss thinner than the sourced wall", (input) => { input.lid!.fasteners = { screw: "M3", base: "heat-set-insert", insertLengthMm: 5.7 }; }, /lid boss diameter 6 leaves less than the sourced 1\.6 mm insert wall/],
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
  const at = (index: number) => rounded(fake.calls[index]!.args);
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
  assert.deepEqual(at(22), [114, ["v115-0", "v115-1", "v115-2", "v115-3"], 3]);
  assert.deepEqual(at(23), [[2.2, 2.2, 17.1], [30.6, 20.6, 2], null]);
  assert.deepEqual(at(24), [115, ["v116-0", "v116-1", "v116-2", "v116-3"], 0.3]);
  assert.deepEqual(at(25), [[3.4, 3.4, 16.6], [28.2, 18.2, 3], null]);
  assert.deepEqual(at(26), [[4.5, 4.5, 16.6], 3.2, 3, [0, 0, 1]]);
  assert.deepEqual(at(30), [[115], [116, 117, 118, 119, 120], "difference", false]);
  assert.deepEqual(at(31), [[114], [115], "union", false]);
  // countersink: Ø3.4 medium clearance through the 2 mm lid, Ø6.72 x 90° head
  assert.deepEqual(at(32), [[4.5, 4.5, 21.1], 1.7, 3, [0, 0, -1]]);
  assert.deepEqual(rounded(fake.calls[33]!.args[0]), [[6.2, 4.5, 21.1], [7.86, 4.5, 21.1], [7.86, 4.5, 20.6], [6.2, 4.5, 18.94]]);
  assert.deepEqual((at(34) as unknown[]).slice(1), [[4.5, 4.5, 20.6], [0, 0, -1], 360]);
  // y+ wall opening: centre x = 2.5 + 15, bottom z = 6.6 + 1, profile 0.5 mm outside the outer face y = 25, cut 2 + 1 mm deep
  assert.deepEqual(rounded(fake.calls[45]!.args[0]), [[13.5, 25.5, 7.6], [21.5, 25.5, 7.6], [21.5, 25.5, 10.6], [13.5, 25.5, 10.6]]);
  assert.deepEqual((at(46) as unknown[]).slice(1), [3]);
  // board stand-in on the standoffs
  assert.deepEqual(at(57), [[2.5, 2.5, 5], [30, 20, 1.6], "ref-board"]);
  assert.deepEqual(at(58), [[5.5, 5.5, 7.1], 1.25, 2.6, [0, 0, -1]]);
  const wires = fake.calls.filter((entry) => entry.operation === "createPolyline").length;
  assert.equal((fake.calls.at(-1)!.args[0] as number[]).length, wires);

  assert.equal(result.recipe, "board-case");
  assert.deepEqual(result.derived, planBoardCase(REF).derived);
  assert.equal(result.undoSteps, fake.calls.length);
  assert.equal(result.steps.length, fake.calls.length);
  assert.deepEqual([...new Set(result.steps.map((entry) => entry.stage))], ["base-shell", "standoffs", "lid-bosses", "lid-shell", "lid-screw-holes", "opening:port", "vents", "board-stand-in", "cleanup"]);
  const final = fake.snapshot();
  assert.deepEqual(final.bodies.map((body) => [body.id, body.type, body.name]), [[1, "Solid", "existing"], [100, "Solid", "ref-base"], [114, "Solid", "ref-lid"], [143, "Solid", "ref-board"]]);
  assert.deepEqual(result.bodies, { baseId: 100, lidId: 114, boardId: 143 });
  assert.deepEqual(result.resultBodyIds, [100, 114, 143]);
  assert.equal(final.regions.length, 0, "no construction Regions left");
});

test("an exploded lid adds one move step; a case without fasteners skips the bosses, notches and lid holes", async () => {
  const fake = fakeRuntime();
  const result = await new BoardCaseRecipe(fake.operations).create({ ...POD, exploded: 12 });
  assert.deepEqual(fake.calls.map((entry) => entry.operation), ["createBox", "fillet", "createBox", "fillet", "boolean", "createBox", "fillet", "createBox", "createBox", "boolean", "boolean", "move"]);
  assert.deepEqual(fake.calls.at(-1)!.args, [[result.bodies.lidId], [0, 0, 12]]);
  assert.equal(result.undoSteps, 12);
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
  // 32 steps before the countersink pattern, plus its confirmed through cutter and profile
  assert.equal(error.completedSteps.length, 34);
  assert.equal(error.undoneSteps, 34);
  assert.equal(fake.undoCalls, 34);
  assert.equal(error.restored, true);
  assert.match(error.message, /failed in stage "lid-screw-holes" after 34 confirmed native steps; undid 34 native steps; the document matches the start .*revolve rejected/);
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
    fail: (operation) => operation === "extrudeRegions" ? new Error("extrude failed") : undefined,
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
const RISE = 0.5 * (Math.SQRT2 - 1); // lowest cone point inside the 0.5 mm rounded cavity corner above the apex

test("derived values per boss style (table, benchmark board and reference board)", () => {
  const table: Array<{ name: string; input: BoardCaseInput; expected: Record<string, unknown> }> = [
    {
      name: "benchmark hanging",
      input: styled(BENCHMARK, "hanging"),
      expected: {
        wallTopZMm: 23.6, lidBossBottomZMm: 16.6, bossStyle: "hanging", boardWallClearanceMm: { xNeg: 0.5, xPos: 0.5, yNeg: 0.5, yPos: 0.5 },
        printability: { baseOrientation: "floor-down", maxBossOverhangDeg: 90 }, outerMm: { min: [2000, 0, 0], max: [2056.5, 33.3, 23.6] },
      },
    },
    {
      name: "benchmark tapered: wall top rises by reach - rise, taper bottom = component top + 1",
      input: styled(BENCHMARK, "tapered"),
      expected: {
        wallTopZMm: 29.928427, lidBossBottomZMm: 22.928427, bossStyle: "tapered", boardWallClearanceMm: { xNeg: 0.5, xPos: 0.5, yNeg: 0.5, yPos: 0.5 },
        bossTaper: { angleDeg: 45, bottomZMm: 16.6, addedHeightMm: 6.328427 },
        printability: { baseOrientation: "floor-down", maxBossOverhangDeg: 45 }, outerMm: { min: [2000, 0, 0], max: [2056.5, 33.3, 29.928427] },
        lidBossAxesMm: [[2004.5, 4.5], [2052, 4.5], [2004.5, 28.8], [2052, 28.8]],
      },
    },
    {
      name: "benchmark floor: cavity grows 11 mm in x, bosses stand on the floor to the lower wall top",
      input: styled(BENCHMARK, "floor"),
      expected: {
        wallTopZMm: 18.1, lidBossBottomZMm: 2, bossStyle: "floor", cavityGrowthMm: [11, 0], boardWallClearanceMm: { xNeg: 6, xPos: 6, yNeg: 0.5, yPos: 0.5 },
        printability: { baseOrientation: "floor-down", maxBossOverhangDeg: 0 }, outerMm: { min: [2000, 0, 0], max: [2067.5, 33.3, 18.1] },
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
      name: "no lid screws: no boss fields, wall clearance still reported",
      input: POD,
      expected: { boardWallClearanceMm: { xNeg: 0.15, xPos: 0.15, yNeg: 0.15, yPos: 0.15 }, bossStyle: undefined, bossTaper: undefined, cavityGrowthMm: undefined, printability: undefined },
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

test("the default boss style is tapered", () => {
  assert.deepEqual(deriveBoardCase(styled(BENCHMARK)), deriveBoardCase(styled(BENCHMARK, "tapered")));
  assert.equal(deriveBoardCase(styled(BENCHMARK)).bossStyle, "tapered");
  assert.deepEqual(planBoardCase(styled(REF)).taper, planBoardCase(styled(REF, "tapered")).taper);
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
      assert.ok(printability.maxBossOverhangDeg <= 45 + 1e-6, `${style}: ${printability.maxBossOverhangDeg}`);
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
  assert.equal(deriveBoardCase(with_((value) => { value.lid!.lipDepthMm = 5.5; })).wallTopZMm > 0, true);
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
  ["a bossStyle outside the list", (input: BoardCaseInput) => { (input.lid!.fasteners as { bossStyle?: string }).bossStyle = "pillar"; }, /lid\.fasteners\.bossStyle must be one of tapered, hanging, floor \(got pillar\)/],
  ["a lid lip deeper than the boss with the tapered style", (input: BoardCaseInput) => { input.lid!.fasteners!.bossStyle = "tapered"; input.lid!.lipDepthMm = 5.6; }, /lid\.lipDepthMm 5\.6 must be at most the boss length 6 minus 0\.5 mm with the tapered style/],
  ["a thin wall with a big outer radius with the tapered style", (input: BoardCaseInput) => { input.lid!.fasteners!.bossStyle = "tapered"; input.walls = { wallMm: 0.8, outerCornerRadiusMm: 3 }; }, /the tapered boss gusset is clipped 0\.5 mm into each wall; with walls\.wallMm 0\.8 and walls\.outerCornerRadiusMm 3 that corner would show/],
  ["a wall opening on the taper", (input: BoardCaseInput) => { input.lid!.fasteners!.bossStyle = "tapered"; input.openings = [{ wall: "x-", shape: "rect", widthMm: 2, heightMm: 2, alongMm: 1.5, aboveBoardMm: 7.4, label: "low" }]; }, /low on wall x- collides with the 45 degree gusset under a lid boss/],
  ["a wall vent slot on the taper", (input: BoardCaseInput) => { input.lid!.fasteners!.bossStyle = "tapered"; input.openings = []; input.vents = { on: "x-", slots: 1, slotWidthMm: 1.5, slotLengthMm: 4, pitchMm: 3, centerAlongMm: 1.5, centerAcrossMm: 9 }; }, /vent slot 0 on wall x- collides with the 45 degree gusset under a lid boss/],
  ["a floor boss that would stand on a standoff", (input: BoardCaseInput) => { input.lid!.fasteners!.bossStyle = "floor"; input.board.holes = [{ xMm: 3, yMm: 3, diameterMm: 2.5 }, { xMm: 27, yMm: 17, diameterMm: 2.5 }]; input.standoffs!.outerDiameterMm = 12; }, /lid boss 0 collides with standoff 0/],
  ["a floor opening under a floor boss", (input: BoardCaseInput) => { input.lid!.fasteners!.bossStyle = "floor"; input.openings = [{ wall: "floor", shape: "circle", widthMm: 2, alongMm: -3.5, acrossMm: 2, label: "drain" }]; }, /drain on the floor collides with lid boss 0/],
  ["a wall opening through a floor boss", (input: BoardCaseInput) => { input.lid!.fasteners!.bossStyle = "floor"; input.openings = [{ wall: "x-", shape: "rect", widthMm: 2, heightMm: 2, alongMm: 2, aboveBoardMm: 3, label: "side" }]; }, /side on wall x- collides with lid boss 0/],
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
  const result = await new BoardCaseRecipe(fake.operations).create(styled(REF, "tapered"));
  const names = fake.calls.map((entry) => entry.operation === "boolean" ? `boolean:${(entry.args[2] as string)}` : entry.operation);
  const repeat = (list: string[], count: number) => Array.from({ length: count }, () => list).flat();
  assert.deepEqual(names.slice(0, 11), [
    "createBox", "fillet", "createBox", "fillet", "boolean:difference",
    ...repeat(["createCylinder"], 2), "boolean:union", ...repeat(["createCylinder"], 2), "boolean:difference",
  ]);
  const taperCalls = names.slice(11, 11 + 4 * 3 + 1);
  assert.deepEqual(taperCalls, [...repeat(["createBox", "createCone", "boolean:intersection"], 4), "boolean:union"]);
  const at = (index: number) => rounded(fake.calls[index]!.args);
  // corner 0 at the cavity min corner (2, 2): clip box 0.5 mm into the walls; pointed cone with its top disc 0.5 mm above the
  // boss bottom (radius = height = 7.035534, so 45 degrees) and its apex straight down on the corner at z 12.392893
  assert.deepEqual(at(11), [[1.5, 1.5, 11.892893], [32, 22, 8.035534], null]);
  assert.deepEqual(at(12), [[2, 2, 19.428427], 7.035534, 0, 7.035534, [0, 0, -1], [1, 0, 0]]);
  assert.deepEqual(at(13), [[108], [106], "intersection", false]);
  // corner 3 at the cavity max corner (33, 23)
  assert.deepEqual(at(21), [[33, 23, 19.428427], 7.035534, 0, 7.035534, [0, 0, -1], [1, 0, 0]]);
  assert.deepEqual(fake.calls[23]!.args, [[100], [108, 111, 114, 117], "union", false]);
  // the bosses follow the gusset, hung from 18.93 (0.5 mm into the cone) to the wall top 24.93
  assert.deepEqual(at(24), [[4.5, 4.5, 18.928427], 3, 6, [0, 0, 1]]);
  assert.equal(result.derived.bossTaper!.bottomZMm, 12.6);
  assert.equal(result.undoSteps, fake.calls.length);
  assert.ok(result.steps.some((step) => step.stage === "lid-boss-tapers" && step.operation === "clip-taper-cone"));
  const final = fake.snapshot();
  assert.deepEqual(final.bodies.map((body) => [body.type, body.name]), [["Solid", "existing"], ["Solid", "ref-base"], ["Solid", "ref-lid"], ["Solid", "ref-board"]]);
  assert.equal(final.regions.length, 0);
  assert.equal(names.at(-1), "remove");
});

test("the floor case grows the cavity cutter, stands the bosses on the floor and adds no taper steps", async () => {
  const fake = fakeRuntime();
  const result = await new BoardCaseRecipe(fake.operations).create(styled(REF, "floor"));
  const at = (index: number) => rounded(fake.calls[index]!.args);
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
  assert.deepEqual(result.steps.filter((step) => step.stage === "lid-boss-tapers"), []);
});

test("a failure in the tapered gusset stage undoes every step and names the stage", async () => {
  const fake = fakeRuntime({ fail: (operation) => operation === "createCone" ? new Error("Plasticity command failed: cone rejected") : undefined });
  const before = fake.snapshot();
  const error = await new BoardCaseRecipe(fake.operations).create(styled(REF, "tapered")).then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof BoardCaseRecipeError);
  assert.equal(error.failedStage, "lid-boss-tapers");
  assert.equal(error.restored, true);
  // 11 steps before the gusset, then the first corner's clip box
  assert.equal(error.completedSteps.length, 12);
  assert.equal(error.undoneSteps, 12);
  assert.deepEqual(fake.snapshot().bodies, before.bodies);
});
