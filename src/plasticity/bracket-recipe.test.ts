import assert from "node:assert/strict";
import { test } from "node:test";

import { bracketDerived, createBracket, gussetSizeLimit, planBracket, type BracketInput, type BracketOperations } from "./bracket-recipe.ts";
import { GuardedRunError, type Vector3 } from "./mate.ts";
import { CommittedChangeError } from "./operations.ts";
import type { RuntimeState } from "./runtime.ts";

type Vec = Vector3;
type Face = RuntimeState["bodies"][number]["faces"][number];
type Edge = RuntimeState["bodies"][number]["edges"][number];

const AUDIT: BracketInput = {
  originMm: [0, 0, 0], profile: "L", widthMm: 30, thicknessMm: 4, legs: { baseMm: 40, uprightMm: 40 }, innerBendRadiusMm: 5, cornerRadiusMm: 3,
  holes: [
    { leg: "base", diameterMm: 4.5, count: 2, layout: "explicit", positionsMm: [[26, 7.5], [26, 22.5]] },
    { leg: "upright", diameterMm: 4.5, count: 2, layout: "explicit", positionsMm: [[26, 7.5], [26, 22.5]] },
  ],
  gussets: { count: 1, thicknessMm: 4, sizeMm: 25 },
  revision: "r1",
};
const input = (extra: Partial<BracketInput>): BracketInput => ({ ...AUDIT, holes: undefined, gussets: undefined, ...extra });

// ---------- derived frames (pure tables) ----------

test("L: leg frames, bounds and the audit hole axes come from the parameters", () => {
  const derived = bracketDerived(planBracket({ ...AUDIT, originMm: [2000, 0, 0] }));
  assert.deepEqual(derived.boundsMm, { min: [2000, 0, 0], max: [2040, 30, 40] });
  assert.deepEqual(derived.legs.base, { planeNormal: [0, 0, -1], outerFaceOffsetMm: 0, frameOriginMm: [2000, 0, 0], alongAxis: [1, 0, 0], acrossAxis: [0, 1, 0], lengthMm: 40, flatSpanMm: [9, 40] });
  assert.deepEqual(derived.legs.upright, { planeNormal: [-1, 0, 0], outerFaceOffsetMm: 2000, frameOriginMm: [2000, 0, 0], alongAxis: [0, 0, 1], acrossAxis: [0, 1, 0], lengthMm: 40, flatSpanMm: [9, 40] });
  assert.deepEqual(derived.holeAxesMm, [
    { leg: "base", pointMm: [2026, 7.5, 0], axis: [0, 0, 1], diameterMm: 4.5 },
    { leg: "base", pointMm: [2026, 22.5, 0], axis: [0, 0, 1], diameterMm: 4.5 },
    { leg: "upright", pointMm: [2000, 7.5, 26], axis: [1, 0, 0], diameterMm: 4.5 },
    { leg: "upright", pointMm: [2000, 22.5, 26], axis: [1, 0, 0], diameterMm: 4.5 },
  ], "the audit bracket's hand-built holes: base x0+26, y 7.5/22.5; upright y 7.5/22.5, z 26");
  assert.deepEqual(derived.bendAxesMm, [{ pointMm: [2009, 0, 9], axis: [0, 1, 0], radiusMm: 5 }]);
  assert.deepEqual(derived.cornerAxesMm, [
    { pointMm: [2037, 3, 0], axis: [0, 0, 1], radiusMm: 3 }, { pointMm: [2037, 27, 0], axis: [0, 0, 1], radiusMm: 3 },
    { pointMm: [2000, 3, 37], axis: [1, 0, 0], radiusMm: 3 }, { pointMm: [2000, 27, 37], axis: [1, 0, 0], radiusMm: 3 },
  ]);
  assert.deepEqual(derived.gussetBoundsMm, [{ min: [2004, 13, 4], max: [2029, 17, 29] }], "centred on the 30 mm width: y 13..17");
});

test("U: three leg frames, two bends on the base and rounded tops of the side legs", () => {
  const plan = planBracket(input({ originMm: [10, 20, 30], profile: "U", thicknessMm: 3, legs: { baseMm: 50, leftMm: 30, rightMm: 25 }, innerBendRadiusMm: 2, cornerRadiusMm: 2 }));
  const derived = bracketDerived(plan);
  assert.deepEqual(derived.boundsMm, { min: [10, 20, 30], max: [60, 50, 60] });
  assert.deepEqual(Object.fromEntries(Object.entries(derived.legs).map(([name, leg]) => [name, [leg!.planeNormal, leg!.outerFaceOffsetMm, leg!.frameOriginMm, leg!.alongAxis, leg!.flatSpanMm]])), {
    base: [[0, 0, -1], 30, [10, 20, 30], [1, 0, 0], [5, 45]],
    left: [[-1, 0, 0], 10, [10, 20, 30], [0, 0, 1], [5, 30]],
    right: [[1, 0, 0], 60, [60, 20, 30], [0, 0, 1], [5, 25]],
  });
  assert.deepEqual(derived.bendAxesMm!.map((bend) => bend.pointMm), [[15, 20, 35], [55, 20, 35]]);
  assert.deepEqual(derived.cornerAxesMm!.map((corner) => [corner.pointMm, corner.axis]), [
    [[10, 22, 58], [1, 0, 0]], [[10, 48, 58], [1, 0, 0]], [[60, 22, 53], [1, 0, 0]], [[60, 48, 53], [1, 0, 0]],
  ]);
  assert.deepEqual(plan.boxes, [{ originMm: [10, 20, 30], sizeMm: [50, 30, 3] }, { originMm: [10, 20, 30], sizeMm: [3, 30, 30] }, { originMm: [57, 20, 30], sizeMm: [3, 30, 25] }]);
});

test("Z: lower runs -X from the web, web +X outer face, upper +Z outer face; bends on both sides of the web", () => {
  const plan = planBracket(input({ profile: "Z", thicknessMm: 3, legs: { lowerMm: 30, webMm: 30, upperMm: 30 }, innerBendRadiusMm: 2, cornerRadiusMm: 0 }));
  const derived = bracketDerived(plan);
  assert.deepEqual(derived.boundsMm, { min: [0, 0, 0], max: [57, 30, 30] });
  assert.deepEqual(derived.legs.lower, { planeNormal: [0, 0, -1], outerFaceOffsetMm: 0, frameOriginMm: [30, 0, 0], alongAxis: [-1, 0, 0], acrossAxis: [0, 1, 0], lengthMm: 30, flatSpanMm: [5, 30] });
  assert.deepEqual(derived.legs.web, { planeNormal: [1, 0, 0], outerFaceOffsetMm: 30, frameOriginMm: [30, 0, 0], alongAxis: [0, 0, 1], acrossAxis: [0, 1, 0], lengthMm: 30, flatSpanMm: [5, 25] });
  assert.deepEqual(derived.legs.upper, { planeNormal: [0, 0, 1], outerFaceOffsetMm: 30, frameOriginMm: [27, 0, 30], alongAxis: [1, 0, 0], acrossAxis: [0, 1, 0], lengthMm: 30, flatSpanMm: [5, 30] });
  assert.deepEqual(derived.bendAxesMm!.map((bend) => bend.pointMm), [[25, 0, 5], [32, 0, 25]]);
  assert.deepEqual(plan.bends.map((bend) => bend.edgeCenterMm), [[27, 15, 3], [30, 15, 27]], "the inner corner edges the fillet picks");
  assert.equal(derived.cornerAxesMm, undefined);
});

test("flat: one leg, both ends rounded, four corner axes", () => {
  const derived = bracketDerived(planBracket(input({ profile: "flat", legs: { lengthMm: 60 }, innerBendRadiusMm: 0, cornerRadiusMm: 5, thicknessMm: 3 })));
  assert.deepEqual(derived.boundsMm, { min: [0, 0, 0], max: [60, 30, 3] });
  assert.deepEqual(derived.legs.flat!.flatSpanMm, [0, 60]);
  assert.deepEqual(derived.cornerAxesMm!.map((corner) => corner.pointMm), [[5, 5, 0], [5, 25, 0], [55, 5, 0], [55, 25, 0]]);
  assert.equal(derived.bendAxesMm, undefined);
});

test("hole layouts: line-across, line-along and grid are placed in the leg frame from margin or pitch", () => {
  const axes = (holes: BracketInput["holes"], extra: Partial<BracketInput> = {}) => bracketDerived(planBracket(input({ holes, ...extra }))).holeAxesMm.map((hole) => hole.pointMm);
  // base flat span [9, 40], mid 24.5; width 30
  assert.deepEqual(axes([{ leg: "base", diameterMm: 4, count: 3, layout: "line-across", pitchMm: 8 }]), [[24.5, 7, 0], [24.5, 15, 0], [24.5, 23, 0]]);
  assert.deepEqual(axes([{ leg: "base", diameterMm: 4, count: 2, layout: "line-across", marginMm: 8 }]), [[24.5, 8, 0], [24.5, 22, 0]]);
  assert.deepEqual(axes([{ leg: "upright", diameterMm: 4, count: 2, layout: "line-along", pitchMm: 12 }]), [[0, 15, 18.5], [0, 15, 30.5]]);
  assert.deepEqual(axes([{ leg: "upright", diameterMm: 4, count: 2, layout: "line-along", marginMm: 8 }]), [[0, 15, 17], [0, 15, 32]]);
  assert.deepEqual(axes([{ leg: "base", diameterMm: 4, count: 1, layout: "line-across" }]), [[24.5, 15, 0]]);
  assert.deepEqual(axes([{ leg: "web", diameterMm: 3.4, count: 4, layout: "grid", marginMm: 8 }], { profile: "Z", thicknessMm: 3, legs: { lowerMm: 30, webMm: 30, upperMm: 30 }, innerBendRadiusMm: 2 }),
    [[30, 8, 13], [30, 8, 17], [30, 22, 13], [30, 22, 17]], "two rows marginMm from the side edges, columns marginMm from the flat span ends");
});

test("slots and countersinks: the slot axis is stated in world terms, a countersink opens on the inner face", () => {
  const derived = bracketDerived(planBracket(input({ profile: "U", thicknessMm: 3, legs: { baseMm: 50, leftMm: 30, rightMm: 25 }, innerBendRadiusMm: 2,
    holes: [{ leg: "base", diameterMm: 4, count: 2, layout: "line-along", pitchMm: 20, slot: { lengthMm: 10, direction: "across" } }, { leg: "left", diameterMm: 3.4, count: 1, layout: "line-across", countersunk: { headDiameterMm: 6.5 } }] })));
  assert.deepEqual(derived.holeAxesMm, [
    { leg: "base", pointMm: [15, 15, 0], axis: [0, 0, 1], diameterMm: 4, slot: { lengthMm: 10, directionAxis: [0, 1, 0] } },
    { leg: "base", pointMm: [35, 15, 0], axis: [0, 0, 1], diameterMm: 4, slot: { lengthMm: 10, directionAxis: [0, 1, 0] } },
    { leg: "left", pointMm: [0, 15, 17.5], axis: [1, 0, 0], diameterMm: 3.4, countersunk: { headDiameterMm: 6.5, side: "inner" } },
  ]);
});

test("gussets: one is centred; two sit at the edges or centred in each half; the profile meets the inner faces sizeMm from the corner", () => {
  const one = planBracket(input({ gussets: { count: 1, thicknessMm: 4, sizeMm: 25 } }));
  assert.deepEqual(one.gussets[0]!.profilePointsMm, [[3.5, 15, 3.5], [29.5, 15, 3.5], [3.5, 15, 29.5]], "overlap 0.5 inside the legs; hypotenuse x + z = 2t + size");
  assert.deepEqual(one.gussets[0]!.ribBoundsMm, { min: [3.5, 13, 3.5], max: [29.5, 17, 29.5] });
  const edges = planBracket(input({ gussets: { count: 2, thicknessMm: 3, sizeMm: 20, positions: "edges" } }));
  assert.deepEqual(edges.gussets.map((gusset) => [gusset.boundsMm.min[1], gusset.boundsMm.max[1]]), [[0, 3], [27, 30]]);
  const halves = planBracket(input({ gussets: { count: 2, thicknessMm: 3, sizeMm: 20, positions: "centered" } }));
  assert.deepEqual(halves.gussets.map((gusset) => [gusset.boundsMm.min[1], gusset.boundsMm.max[1]]), [[6, 9], [21, 24]]);
});

// ---------- validation (before any native call) ----------

test("validation rejects non-positive sizes and legs not longer than the thickness", () => {
  assert.throws(() => planBracket(input({ widthMm: 0 })), /widthMm must be a positive/);
  assert.throws(() => planBracket(input({ thicknessMm: -1 })), /thicknessMm must be a positive/);
  assert.throws(() => planBracket(input({ legs: { baseMm: 4, uprightMm: 40 } })), /L legs must be longer than thicknessMm/);
  assert.throws(() => planBracket(input({ profile: "U", legs: { baseMm: 8, leftMm: 20, rightMm: 20 }, innerBendRadiusMm: 0 })), /U baseMm must be longer than twice thicknessMm/);
  assert.throws(() => planBracket(input({ profile: "Z", legs: { lowerMm: 20, webMm: 8, upperMm: 20 }, innerBendRadiusMm: 0 })), /Z webMm must be longer than twice/);
  assert.throws(() => planBracket(input({ legs: { baseMm: 40, lengthMm: 40 } as BracketInput["legs"] })), /legs for profile L are baseMm, uprightMm; not lengthMm/);
  assert.throws(() => planBracket(input({ originMm: [0, Number.NaN, 0] })), /originMm must be three finite numbers/);
});

test("validation rejects a bend radius that does not fit, naming the limit", () => {
  assert.throws(() => planBracket(input({ innerBendRadiusMm: 36 })), /innerBendRadiusMm must be less than the shorter leg minus thickness \(36 mm\)/);
  assert.throws(() => planBracket(input({ profile: "U", legs: { baseMm: 20, leftMm: 30, rightMm: 30 }, innerBendRadiusMm: 6 })), /less than half the inner base length \(6 mm\)/);
  assert.throws(() => planBracket(input({ profile: "Z", legs: { lowerMm: 30, webMm: 20, upperMm: 30 }, innerBendRadiusMm: 6 })), /less than half the inner web length/);
  assert.throws(() => planBracket(input({ profile: "flat", legs: { lengthMm: 60 }, innerBendRadiusMm: 1 })), /A flat bracket has no bend/);
  assert.throws(() => planBracket(input({ cornerRadiusMm: 15 })), /cornerRadiusMm must be less than half the width \(15 mm\)/);
});

test("validation rejects holes nearer than one diameter to an edge, the bend or a rounded corner; allowEdgeHoles relaxes it", () => {
  const hole = (positionsMm: Array<[number, number]>, extra: Partial<BracketInput> = {}) => () => planBracket(input({ holes: [{ leg: "base", diameterMm: 4, count: positionsMm.length, layout: "explicit", positionsMm }], ...extra }));
  assert.throws(hole([[26, 5]]), /holes\[0\] \(leg base\) position 0 at \[26, 5\]: the hole must stay 4 mm \(1x diameter\) from the edges of the flat region of leg base \(along 9 to 40, across 0 to 30, corners rounded 3 mm\); allowEdgeHoles: true relaxes the distance/);
  assert.throws(hole([[14, 15]]), /stay 4 mm/, "1 mm past the bend tangent at 9 + 2 + 4");
  assert.doesNotThrow(hole([[34, 6]]), "1x diameter from both edges already clears a 3 mm corner round");
  assert.throws(hole([[33, 7]], { cornerRadiusMm: 10 }), /stay 4 mm/, "inside the shrunk rectangle but in the 10 mm rounded corner");
  assert.doesNotThrow(hole([[32, 8]], { cornerRadiusMm: 10 }));
  assert.doesNotThrow(hole([[26, 5]], { allowEdgeHoles: true }));
  assert.throws(hole([[26, 1]], { allowEdgeHoles: true }), /must stay inside the flat region/);
  assert.doesNotThrow(hole([[26, 6]]));
});

test("validation rejects holes on a gusset, overlapping holes, bad slots and countersinks, and the wrong leg", () => {
  const plan = (holes: BracketInput["holes"], extra: Partial<BracketInput> = {}) => () => planBracket(input({ holes, ...extra }));
  assert.throws(plan([{ leg: "base", diameterMm: 4, count: 1, layout: "explicit", positionsMm: [[20, 15]] }], { gussets: { count: 1, thicknessMm: 4, sizeMm: 25 } }), /position 0 at \[20, 15\]: the hole overlaps gusset 0/);
  assert.doesNotThrow(plan(AUDIT.holes, { gussets: AUDIT.gussets }), "the audit holes clear the centred gusset");
  assert.throws(plan([{ leg: "base", diameterMm: 4, count: 2, layout: "explicit", positionsMm: [[20, 10], [23, 12]] }]), /position 1 at \[23, 12\]: the hole overlaps holes\[0\] \(leg base\) position 0/);
  assert.throws(plan([{ leg: "base", diameterMm: 4, count: 1, layout: "line-across", slot: { lengthMm: 4, direction: "along" } }]), /slot.lengthMm \(overall, round ends included\) must be larger than diameterMm/);
  assert.throws(plan([{ leg: "base", diameterMm: 4, count: 1, layout: "line-across", slot: { lengthMm: 8, direction: "along" }, countersunk: { headDiameterMm: 8 } }]), /a slot cannot be countersunk/);
  assert.throws(plan([{ leg: "base", diameterMm: 3, count: 1, layout: "line-across", countersunk: { headDiameterMm: 12 } }]), /countersink for head 12 mm is 4.5 mm deep, not less than the 4 mm thickness/);
  assert.throws(plan([{ leg: "web", diameterMm: 3, count: 1, layout: "line-across" }]), /holes\[0\] \(leg web\): profile L has legs base, upright/);
});

test("validation rejects layouts without the fields they need", () => {
  const plan = (hole: Partial<NonNullable<BracketInput["holes"]>[number]>) => () => planBracket(input({ holes: [{ leg: "base", diameterMm: 3, count: 2, layout: "line-across", ...hole }] }));
  assert.throws(plan({}), /layout line-across with count 2 needs marginMm or pitchMm/);
  assert.throws(plan({ marginMm: 6, pitchMm: 10 }), /give marginMm or pitchMm, not both/);
  assert.throws(plan({ layout: "explicit", positionsMm: [[20, 10]] }), /needs positionsMm with exactly count \(2\)/);
  assert.throws(plan({ layout: "grid", count: 3, marginMm: 6 }), /layout grid needs an even count/);
  assert.throws(plan({ layout: "grid", count: 4 }), /layout grid needs marginMm/);
  assert.throws(plan({ positionsMm: [[20, 10], [20, 20]], marginMm: 6 }), /positionsMm is for layout explicit only/);
  assert.throws(plan({ count: 13, marginMm: 2 }), /count must be a whole number from 1 to 12/);
});

test("validation rejects gussets that do not fit, or on a profile other than L", () => {
  const plan = (gussets: BracketInput["gussets"], extra: Partial<BracketInput> = {}) => () => planBracket(input({ gussets, ...extra }));
  assert.throws(plan({ count: 1, thicknessMm: 4, sizeMm: 5 }), /gussets.sizeMm must be larger than innerBendRadiusMm \(5 mm\)/);
  assert.throws(plan({ count: 1, thicknessMm: 4, sizeMm: 34 }), /at most the shorter leg minus thickness and cornerRadiusMm \(33 mm\)/);
  assert.throws(plan({ count: 2, thicknessMm: 15, sizeMm: 20 }), /does not fit 2 gusset\(s\) on the 30 mm width/);
  assert.throws(plan({ count: 1, thicknessMm: 4, sizeMm: 20, positions: "edges" }), /one gusset is always centred/);
  assert.throws(plan({ count: 1, thicknessMm: 4, sizeMm: 20 }, { profile: "U", legs: { baseMm: 50, leftMm: 30, rightMm: 30 } }), /gussets are for the L profile only/);
});

// ---------- composition against a scripted fake ----------

function scriptedFake(options: { failOn?: string; uncertainOn?: string; skewBounds?: boolean; invalid?: boolean; sliver?: boolean; leakInto?: string } = {}) {
  type FBody = { id: number; type: string; name: string | null; boundsMm: { min: Vec; max: Vec }; faces: Face[]; edges: Edge[]; points?: Vec[]; cutter?: { origin: Vec; axis: Vec; radius: number; cone?: boolean }; ribFaces?: Face[] };
  let bodies: FBody[] = [];
  let regions: RuntimeState["regions"] = [];
  let next = 1;
  let rev = 1;
  let undoDepth = 0;
  const history: string[] = [];
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const line = (id: string, center: Vec, tangent: Vec, lengthMm: number): Edge => ({ id, curveType: "Line", line: true, circle: false, lengthMm, centerMm: center, tangent, boundsMm: { min: center, max: center }, faceIds: [], vertexIds: [] } as Edge);
  const plane = (id: string, center: Vec, normal: Vec): Face => ({ id, surfaceType: "Plane", planar: true, centerMm: center, normal, radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: center, max: center }, edgeIds: [] } as Face);
  const cylinder = (id: string, origin: Vec, axis: Vec, radius: number, blend: number | null, edgeIds: string[] = []): Face => ({ id, surfaceType: "Cylinder", planar: false, centerMm: [origin[0] + (axis[0] ? 1 : 0), origin[1] + (axis[0] ? 0 : radius), origin[2]] as Vec, normal: [0, -1, 0], radiusMm: radius, blendRadiusMm: blend, axisOriginMm: origin, axisDirection: axis, boundsMm: { min: origin, max: origin }, edgeIds } as Face);
  // What Plasticity reads back for the audit union at the origin (hand-written, not from the plan): the inner bend edge,
  // two decoy Y edges, the four free-corner edges and a decoy 30 mm edge.
  const unionEdges = [line("e-bend", [4, 15, 4], [0, 1, 0], 30), line("e-outer", [0, 15, 0], [0, 1, 0], 30), line("e-tip", [40, 15, 4], [0, -1, 0], 30),
    line("e-c1", [40, 0, 2], [0, 0, 1], 4), line("e-c2", [40, 30, 2], [0, 0, 1], 4), line("e-c3", [2, 0, 40], [-1, 0, 0], 4), line("e-c4", [2, 30, 40], [1, 0, 0], 4), line("e-x", [20, 0, 0], [1, 0, 0], 40)];
  const unionFaces = [plane("base-out", [20, 15, 0], [0, 0, -1]), plane("base-in", [22, 15, 4], [0, 0, 1]), plane("up-out", [0, 15, 20], [-1, 0, 0]), plane("up-in", [4, 15, 22], [1, 0, 0])];
  const filletFaces: Record<string, Face> = {
    "e-bend": cylinder("f-bend", [9, 15, 9], [0, -1, 0], 5, 5),
    "e-c1": cylinder("f-c1", [37, 3, 0], [0, 0, 1], 3, 3), "e-c2": cylinder("f-c2", [37, 27, 0], [0, 0, 1], 3, 3),
    "e-c3": cylinder("f-c3", [20, 3, 37], [-1, 0, 0], 3, 3), "e-c4": cylinder("f-c4", [20, 27, 37], [1, 0, 0], 3, 3),
  };
  const find = (id: number) => bodies.find((body) => body.id === id)!;
  const state = (): RuntimeState => ({
    targetId: "t", title: "Untitled", documentToken: "doc", revision: `r${rev}`, dbVersion: rev, undoDepth, redoDepth: 0, regions,
    construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" },
    bodies: bodies.map((body) => ({ id: body.id, versionId: body.id, type: body.type, name: body.name, boundsMm: body.boundsMm, faceIds: body.faces.map((face) => face.id), edgeIds: body.edges.map((edge) => edge.id), faces: body.faces, edges: body.edges })),
  } as unknown as RuntimeState);
  const mutate = (op: string, args: unknown[], revision: string, apply: () => void) => {
    calls.push({ op, args: [...args, revision] });
    if (options.uncertainOn === op) throw new Error("CDP request timed out: test");
    if (options.failOn === op) throw new Error(`${op} failed in the scripted fake`);
    if (revision !== `r${rev}`) throw new Error(`Stale reference: expected revision ${revision}, current revision is r${rev}`);
    history.push(JSON.stringify({ bodies, regions, next }));
    apply();
    rev += 1; undoDepth += 1;
    return state();
  };
  const bump = (body: Omit<FBody, "id">) => { const created = { ...body, id: next++ }; bodies.push(created); return created; };
  const operations = {
    async state() { return state(); },
    // The native B-Rep Check (read-only, not recorded in calls); options.invalid makes it report a defect.
    async validateBodies(ids: number[], revision: string) {
      if (revision !== `r${rev}`) throw new Error(`Stale reference: expected revision ${revision}, current revision is r${rev}`);
      return { documentToken: "doc", revision, measurementSource: "native-brep", bodies: ids.map((id) => ({ id, versionId: id, type: find(id).type, name: find(id).name, measurementSource: "native-brep", faceCount: 0, edgeCount: 0, boundaryEdgeIds: [], closed: !options.invalid, nativeCheckCodes: options.invalid ? [7] : [], nativeValid: !options.invalid, printableSolid: !options.invalid })) };
    },
    async undo() { calls.push({ op: "undo", args: [] }); ({ bodies, regions, next } = JSON.parse(history.pop()!)); rev += 1; undoDepth -= 1; return state(); },
    async createBox(origin: Vec, size: Vec, name: string | undefined, revision: string) {
      return mutate("createBox", [origin, size, name], revision, () => bump({ type: "Solid", name: name ?? null, boundsMm: { min: origin, max: [origin[0] + size[0], origin[1] + size[1], origin[2] + size[2]] }, faces: [], edges: [] }));
    },
    async boolean(targetIds: number[], toolIds: number[], kind: string, _keep: boolean, revision: string) {
      return mutate("boolean", [targetIds, toolIds, kind], revision, () => {
        const target = find(targetIds[0]!);
        for (const tool of toolIds.map(find)) {
          if (kind === "union") {
            target.boundsMm = { min: [0, 1, 2].map((i) => Math.min(target.boundsMm.min[i]!, tool.boundsMm.min[i]!)) as Vec, max: [0, 1, 2].map((i) => Math.max(target.boundsMm.max[i]!, tool.boundsMm.max[i]!)) as Vec };
            if (tool.ribFaces) target.faces.push(...tool.ribFaces);
            else if (target.edges.length === 0) { target.edges = [...unionEdges, ...(options.sliver ? [line("e-sliver", [20, 0, 4], [1, 0, 0], 0.04)] : [])]; target.faces = [...unionFaces]; }
          } else if (tool.cutter) {
            const { origin, axis, radius, cone } = tool.cutter;
            const n = target.faces.length;
            if (cone) { target.faces.push({ ...cylinder(`cone${n}`, origin, axis, 0, null), surfaceType: "Cone", radiusMm: null } as Face); continue; }
            const end: Vec = [origin[0] + axis[0] * 5, origin[1] + axis[1] * 5, origin[2] + axis[2] * 5];
            const circle = (id: string, c: Vec) => ({ id, curveType: "Circle", line: false, circle: true, lengthMm: 1, centerMm: c, tangent: [1, 0, 0], boundsMm: { min: c, max: c }, faceIds: [], vertexIds: [], circleGeometry: { centerMm: c, radiusMm: radius, normal: axis, reference: [0, 1, 0], startMm: [c[0], c[1] + radius, c[2]], midpointMm: [c[0], c[1] - radius, c[2]], endMm: [c[0], c[1] + radius, c[2]] } } as unknown as Edge);
            const edges = [circle(`h${n}a`, origin), circle(`h${n}b`, end)];
            target.edges.push(...edges);
            if (options.leakInto) target.faces = target.faces.map((face) => (face.id === options.leakInto ? { ...face, edgeIds: [...face.edgeIds, `leak${n}`] } : face));
            target.faces.push({ ...cylinder(`h${n}`, origin, axis, radius, null, edges.map((edge) => edge.id)), centerMm: [origin[0] + (axis[1] ? radius : 0), origin[1] + (axis[1] ? 0 : radius), origin[2] + (axis[2] ? 2 : 0) + (axis[0] ? 0 : 0)] as Vec, normal: (axis[1] ? [-1, 0, 0] : [0, -1, 0]) as Vec } as Face);
          }
        }
        bodies = bodies.filter((body) => !toolIds.includes(body.id));
        if (options.skewBounds) target.boundsMm = { min: target.boundsMm.min, max: [target.boundsMm.max[0] + 1e-3, target.boundsMm.max[1], target.boundsMm.max[2]] };
      });
    },
    async fillet(id: number, edgeIds: string[], radius: number, revision: string) {
      return mutate("fillet", [id, edgeIds, radius], revision, () => { const body = find(id); for (const edgeId of edgeIds) if (filletFaces[edgeId]) body.faces.push(filletFaces[edgeId]!); });
    },
    async createPolyline(points: Vec[], _closed: boolean, revision: string) {
      return mutate("createPolyline", [points], revision, () => {
        const wire = bump({ type: "Wire", name: null, boundsMm: { min: points[0]!, max: points[0]! }, faces: [], edges: [], points });
        const min = [0, 1, 2].map((i) => Math.min(...points.map((point) => point[i]!))) as Vec;
        const max = [0, 1, 2].map((i) => Math.max(...points.map((point) => point[i]!))) as Vec;
        regions = [...regions, { id: `region-${wire.id}`, entityId: wire.id, islandVersionId: 1, sketchId: 1, sketchWireIds: [wire.id], measurementSource: "render-mesh", displayBoundsMm: { min, max } }];
      });
    },
    async extrudeRegions(regionIds: string[], distanceMm: number, revision: string, extrude: { reverseDistanceMm?: number } = {}) {
      return mutate("extrudeRegions", [regionIds, distanceMm, extrude], revision, () => {
        const wire = find(regions.find((region) => region.id === regionIds[0])!.sketchWireIds[0]!);
        const points = wire.points!;
        const min = [0, 1, 2].map((i) => Math.min(...points.map((point) => point[i]!))) as Vec;
        const max = [0, 1, 2].map((i) => Math.max(...points.map((point) => point[i]!))) as Vec;
        // Profiles here lie in a y plane; the extrude spans [y - reverse, y + distance].
        min[1] -= extrude.reverseDistanceMm ?? 0; max[1] += distanceMm;
        if (wire.points!.some((point) => Math.abs(point[1] - points[0]![1]) > 1e-12)) {
          // A slot profile (in a z plane): extrude along -z/+z by the distance from the profile.
          min[1] += extrude.reverseDistanceMm ?? 0; max[1] -= distanceMm; max[2] += distanceMm;
          bump({ type: "Solid", name: null, boundsMm: { min, max }, faces: [], edges: [] });
          return;
        }
        bump({ type: "Solid", name: null, boundsMm: { min, max }, faces: [], edges: [], ribFaces: [plane(`rib-${next}-lo`, [15, min[1], 15], [0, -1, 0]), plane(`rib-${next}-hi`, [15, max[1], 15], [0, 1, 0])] });
      });
    },
    async createCylinder(center: Vec, radius: number, height: number, _name: string | undefined, revision: string, axis: Vec) {
      return mutate("createCylinder", [center, radius, height, axis], revision, () => bump({ type: "Solid", name: null, boundsMm: { min: center, max: center }, faces: [], edges: [], cutter: { origin: center, axis, radius } }));
    },
    async revolveProfile(id: number, origin: Vec, axis: Vec, _angle: number, revision: string) {
      return mutate("revolveProfile", [id, origin, axis], revision, () => bump({ type: "Solid", name: null, boundsMm: { min: origin, max: origin }, faces: [], edges: [], cutter: { origin, axis, radius: 0, cone: true } }));
    },
    async remove(ids: number[], revision: string) {
      return mutate("remove", [ids], revision, () => { bodies = bodies.filter((body) => !ids.includes(body.id)); regions = regions.filter((region) => !region.sketchWireIds.some((id) => ids.includes(id))); });
    },
    async rectangularPattern() { throw new Error("unused"); },
    async createPipes() { throw new Error("unused"); },
  };
  return { operations: operations as unknown as BracketOperations, calls, state };
}

test("the audit L-bracket composes boxes, a union, two fillets, a centred rib, two hole patterns and one Wire delete", async () => {
  const fake = scriptedFake();
  const result = await createBracket(fake.operations, AUDIT);
  assert.deepEqual(fake.calls, [
    { op: "createBox", args: [[0, 0, 0], [40, 30, 4], "bracket", "r1"] },
    { op: "createBox", args: [[0, 0, 0], [4, 30, 40], undefined, "r2"] },
    { op: "boolean", args: [[1], [2], "union", "r3"] },
    { op: "fillet", args: [1, ["e-bend"], 5, "r4"] },
    { op: "fillet", args: [1, ["e-c1", "e-c2", "e-c3", "e-c4"], 3, "r5"] },
    { op: "createPolyline", args: [[[3.5, 15, 3.5], [29.5, 15, 3.5], [3.5, 15, 29.5]], "r6"] },
    { op: "extrudeRegions", args: [["region-3"], 2, { reverseDistanceMm: 2 }, "r7"] },
    { op: "boolean", args: [[1], [4], "union", "r8"] },
    { op: "createCylinder", args: [[26, 7.5, -0.5], 2.25, 5, [0, 0, 1], "r9"] },
    { op: "createCylinder", args: [[26, 22.5, -0.5], 2.25, 5, [0, 0, 1], "r10"] },
    { op: "boolean", args: [[1], [5, 6], "difference", "r11"] },
    { op: "createCylinder", args: [[-0.5, 7.5, 26], 2.25, 5, [1, 0, 0], "r12"] },
    { op: "createCylinder", args: [[-0.5, 22.5, 26], 2.25, 5, [1, 0, 0], "r13"] },
    { op: "boolean", args: [[1], [7, 8], "difference", "r14"] },
    { op: "remove", args: [[3], "r15"] },
  ]);
  assert.equal(result.undoSteps, 15, "measured from the Undo depth");
  assert.equal(result.bodyId, 1);
  assert.deepEqual(result.steps.map((step) => step.operation), ["create-leg-box", "create-leg-box", "union-legs", "fillet-inner-bends", "fillet-free-corners", "gusset-rib", "holes-through-hole-pattern", "holes-through-hole-pattern", "delete-construction-wires"]);
  assert.deepEqual(result.faceIds, { base: { outerFaceId: "base-out", innerFaceId: "base-in" }, upright: { outerFaceId: "up-out", innerFaceId: "up-in" } });
  assert.deepEqual(fake.state().bodies.map((body) => body.id), [1], "no stray wires or cutters");
});

test("the gusset goes through the rib recipe with side centered: a two-sided extrude of half the thickness each way", async () => {
  const fake = scriptedFake();
  await createBracket(fake.operations, { ...AUDIT, holes: undefined });
  const extrude = fake.calls.find((call) => call.op === "extrudeRegions")!;
  assert.deepEqual(extrude.args.slice(1, 3), [2, { reverseDistanceMm: 2 }]);
});

test("a failed native step undoes every step taken; an uncertain one undoes nothing; bad input makes no native call", async () => {
  const failing = scriptedFake({ failOn: "remove" });
  await assert.rejects(createBracket(failing.operations, AUDIT), (error: unknown) => error instanceof GuardedRunError && error.undoneSteps === 14 && error.restored && /create_bracket failed; 14 Undo step\(s\) were undone/.test(error.message));
  assert.equal(failing.state().bodies.length, 0);
  assert.equal(failing.state().undoDepth, 0);

  const uncertain = scriptedFake({ uncertainOn: "fillet" });
  await assert.rejects(createBracket(uncertain.operations, AUDIT), (error: unknown) => error instanceof GuardedRunError && error.uncertain && /plasticity_reconcile/.test(error.message));
  assert.equal(uncertain.calls.some((call) => call.op === "undo"), false);

  const invalid = scriptedFake();
  await assert.rejects(createBracket(invalid.operations, { ...AUDIT, cornerRadiusMm: 20 }), /cornerRadiusMm/);
  await assert.rejects(createBracket(invalid.operations, { ...AUDIT, revision: "r0" }), /Stale reference/);
  assert.deepEqual(invalid.calls, []);
});

test("a read-back that does not match the plan is rolled back: all 5 steps undone, and the error says the document is unchanged", async () => {
  const fake = scriptedFake({ skewBounds: true });
  await assert.rejects(createBracket(fake.operations, { ...AUDIT, holes: undefined, gussets: undefined }),
    (error: unknown) => error instanceof GuardedRunError && !(error instanceof CommittedChangeError) && error.undoneSteps === 5 && error.restored && /create_bracket failed; 5 Undo step\(s\) were undone and the document is unchanged/.test(error.message) && /bounds/.test(error.message));
  assert.equal(fake.calls.filter((call) => call.op === "undo").length, 5);
  assert.equal(fake.state().undoDepth, 0);
  assert.equal(fake.state().bodies.length, 0);
});

test("slots and countersinks: their construction Wires are deleted in one step at the end; the countersink enters from the inner face", async () => {
  const fake = scriptedFake();
  const result = await createBracket(fake.operations, { ...AUDIT, gussets: undefined, holes: [
    { leg: "base", diameterMm: 4, count: 1, layout: "explicit", positionsMm: [[26, 9]], slot: { lengthMm: 8, direction: "along" } },
    { leg: "upright", diameterMm: 3.4, count: 1, layout: "explicit", positionsMm: [[26, 15]], countersunk: { headDiameterMm: 6.5 } },
  ] });
  const ops = fake.calls.map((call) => call.op);
  assert.deepEqual(ops.slice(5), ["createPolyline", "extrudeRegions", "createCylinder", "createCylinder", "boolean", "createCylinder", "createPolyline", "revolveProfile", "boolean", "remove"]);
  const sinkCylinder = fake.calls.filter((call) => call.op === "createCylinder")[2]!;
  assert.deepEqual(sinkCylinder.args.slice(0, 4), [[4.5, 15, 26], 1.7, 5, [-1, 0, 0]], "entry 0.5 inside the inner face x = 4, drilled toward the outer face");
  const remove = fake.calls.at(-1)!;
  assert.equal((remove.args[0] as number[]).length, 2, "the slot and countersink Wires go in one delete");
  assert.equal(result.undoSteps, 15);
  assert.equal(fake.state().bodies.length, 1);
});

// ---------- review fixes (defects 4-6 and 11 of the bracket-mate review) ----------

const L40 = (extra: Partial<BracketInput>): BracketInput => input({ originMm: [2000, 0, 0], legs: { baseMm: 40, uprightMm: 40 }, innerBendRadiusMm: 0, cornerRadiusMm: 0, ...extra });

test("defect 4: a gusset whose rib (with its overlap) would run past the leg end is refused before any native call, naming the largest size", async () => {
  // The review's gmax: 40 x 40, t 4, one gusset 36: the old limit allowed it and the rib ran 0.5 mm past both leg ends.
  assert.throws(() => planBracket(L40({ gussets: { count: 1, thicknessMm: 4, sizeMm: 36 } })), /gussets.sizeMm 36 is too large: the rib \(with its 0.5 mm overlap into the legs\) must end at least 0.05 mm inside each leg; the largest allowed gussets.sizeMm here is 35.45 mm/);
  assert.doesNotThrow(() => planBracket(L40({ gussets: { count: 1, thicknessMm: 4, sizeMm: 35.45 } })), "the stated largest size is accepted");
  const fake = scriptedFake();
  await assert.rejects(createBracket(fake.operations, L40({ originMm: [0, 0, 0], gussets: { count: 1, thicknessMm: 4, sizeMm: 36 } })), /largest allowed gussets.sizeMm here is 35.45 mm/);
  assert.deepEqual(fake.calls, []);
});

test("defect 5: gussets at the edges of a bracket with rounded corners are limited by the clip at the rounded corner", () => {
  // The review's gmaxrc: corner radius 3, two edge gussets 4 thick, size 33 left 0.042 mm edges at the corner rounds.
  assert.throws(() => planBracket(L40({ cornerRadiusMm: 3, gussets: { count: 2, thicknessMm: 4, sizeMm: 33 } })), /inside its 3 mm rounded corner; the largest allowed gussets.sizeMm here is 32.45 mm/);
  assert.doesNotThrow(() => planBracket(L40({ cornerRadiusMm: 3, gussets: { count: 2, thicknessMm: 4, sizeMm: 32.45 } })));
  // Clear of the corner zones (one centred gusset) the older limit, 33 here, still governs.
  assert.equal(gussetSizeLimit({ B: 40, H: 40, W: 30, t: 4, rc: 3, e: 0.5, spans: [[13, 17]] }), 33);
  assert.equal(gussetSizeLimit({ B: 40, H: 40, W: 30, t: 4, rc: 3, e: 0.5, spans: [[1, 5]] }), 33, "1 mm in from the side the corner round still leaves room for the tip");
  assert.equal(Math.round(gussetSizeLimit({ B: 40, H: 40, W: 30, t: 4, rc: 3, e: 0.5, spans: [[0.02, 4.02]] }) * 1e6) / 1e6, 32.795832, "0.02 mm from the side the tip meets the round");
});

test("defect 5: a built bracket with an edge shorter than 0.05 mm is rolled back by the sliver read-back", async () => {
  const fake = scriptedFake({ sliver: true });
  await assert.rejects(createBracket(fake.operations, { ...AUDIT, holes: undefined, gussets: undefined }),
    (error: unknown) => error instanceof GuardedRunError && error.restored && /1 edge\(s\) shorter than 0.05 mm \(a sliver\), the shortest 0.04 mm/.test(error.message) && /the document is unchanged/.test(error.message));
  assert.equal(fake.state().undoDepth, 0);
  assert.equal(fake.state().bodies.length, 0);
});

test("defect 6: a hole in a narrow U side leg overshoots less than half the free gap, so the cutter never reaches the other leg", async () => {
  // The review's unarrow: base 4.3, t 2, so the gap between the side legs is 0.3 mm.
  const narrow = input({ originMm: [0, 0, 0], profile: "U", widthMm: 20, thicknessMm: 2, legs: { baseMm: 4.3, leftMm: 20, rightMm: 20 }, innerBendRadiusMm: 0, cornerRadiusMm: 0, holes: [{ leg: "left", diameterMm: 4, count: 1, layout: "line-along" }] });
  const fake = scriptedFake();
  await createBracket(fake.operations, narrow);
  const cutter = fake.calls.find((call) => call.op === "createCylinder")!;
  const [start, radius, height, axis] = cutter.args as [Vec, number, number, Vec];
  assert.ok(Math.abs(start[0] + 0.15) < 1e-12 && start[1] === 10 && start[2] === 11, `starts 0.15 outside the outer face: ${JSON.stringify(start)}`);
  assert.deepEqual([radius, Math.round(height * 1e9) / 1e9, axis], [2, 2.3, [1, 0, 0]], "and ends 0.15 into the 0.3 mm gap");
  // A base hole, or a side-leg hole above the other leg's top, keeps the full 0.5 mm overshoot.
  const tall = planBracket(input({ originMm: [0, 0, 0], profile: "U", widthMm: 20, thicknessMm: 2, legs: { baseMm: 4.3, leftMm: 40, rightMm: 10 }, innerBendRadiusMm: 0, cornerRadiusMm: 0, holes: [{ leg: "left", diameterMm: 4, count: 1, layout: "explicit", positionsMm: [[30, 10]] }] }));
  assert.equal((tall.holes[0] as unknown as { overshootMm: number }).overshootMm, 0.5);
});

test("defect 6: a hole cut that changes another leg's faces is rolled back", async () => {
  const fake = scriptedFake({ leakInto: "up-in" });
  await assert.rejects(createBracket(fake.operations, { ...AUDIT, gussets: undefined, holes: [AUDIT.holes![0]!] }),
    (error: unknown) => error instanceof GuardedRunError && error.restored && /holes\[0\] on leg base changed the faces of leg upright \(outer\/inner planes: faces:edges 1:0\|1:0 before, 1:0\|1:2 after\): the cut reached another leg/.test(error.message));
  assert.equal(fake.state().undoDepth, 0);
});

test("defect 11: bracket dimensions above 10,000 mm, or below the 0.05 mm sliver limit, are refused before any native call", async () => {
  assert.throws(() => planBracket(L40({ legs: { baseMm: 2e6, uprightMm: 40 } })), /legs.baseMm 2000000 mm is above the 10000 mm limit for a bracket dimension/);
  assert.throws(() => planBracket(L40({ widthMm: 10001 })), /widthMm 10001 mm is above the 10000 mm limit/);
  assert.throws(() => planBracket(input({ profile: "Z", thicknessMm: 3, legs: { lowerMm: 6000, webMm: 30, upperMm: 6000 }, innerBendRadiusMm: 0, cornerRadiusMm: 0 })), /the bracket would be 11997 mm along X, above the 10000 mm limit/);
  assert.throws(() => planBracket(L40({ gussets: { count: 1, thicknessMm: 1e-7, sizeMm: 10 } })), /gussets.thicknessMm 1e-7 mm is below 0.05 mm/);
  assert.throws(() => planBracket(L40({ holes: [{ leg: "base", diameterMm: 1e-7, count: 1, layout: "line-along" }] })), /diameterMm 1e-7 mm is below 0.05 mm/);
  assert.throws(() => planBracket(L40({ innerBendRadiusMm: 1e-7 })), /innerBendRadiusMm 1e-7 mm is below 0.05 mm/);
  assert.throws(() => planBracket(L40({ widthMm: 1e-6, thicknessMm: 1e-6 })), /widthMm 0.000001 mm is below 0.05 mm/);
  assert.throws(() => planBracket(L40({ thicknessMm: 3.99, legs: { baseMm: 4.02, uprightMm: 40 } })), /the flat of leg base would be 0.03 mm long, shorter than 0.05 mm/);
  const fake = scriptedFake();
  await assert.rejects(createBracket(fake.operations, L40({ originMm: [0, 0, 0], legs: { baseMm: 2e6, uprightMm: 40 } })), /above the 10000 mm limit/);
  assert.deepEqual(fake.calls, []);
});

test("defect 11: a built bracket that the native Check finds invalid is rolled back", async () => {
  const fake = scriptedFake({ invalid: true });
  await assert.rejects(createBracket(fake.operations, { ...AUDIT, holes: undefined, gussets: undefined }),
    (error: unknown) => error instanceof GuardedRunError && error.restored && error.undoneSteps === 5 && /body 1 is not a closed, natively valid Solid/.test(error.message));
  assert.equal(fake.state().bodies.length, 0);
});
