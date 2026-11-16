import assert from "node:assert/strict";
import { test } from "node:test";

import * as operationsModule from "./operations.ts";
import { PlasticityOperations, type DrivingDistanceGeometryFace, type PickCommandTimeouts } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

// Round 4, Part 2: the post-commit read-back tracks WHERE the faces were (plane plus footprint), not the set of
// plane offsets. The four reviewer scenarios (moving face at 2020, reference at 2000, request 30) must be rejected as
// committed-mismatch; nine legitimate edits must be accepted. The body version is not part of the check (the docs say so).

type V = [number, number, number];
type Face = DrivingDistanceGeometryFace;
const plane = (id: string, normal: V, centerMm: V, min: V, max: V): Face => ({ id, planar: true, normal, centerMm, boundsMm: { min, max } });
// A 20 x 10 x 5 box from x0 to x1 (y 0..10, z 0..5).
const box = (x0 = 2000, x1 = 2020, suffix = ""): Face[] => [
  plane(`fxp${suffix}`, [1, 0, 0], [x1, 5, 2.5], [x1, 0, 0], [x1, 10, 5]),
  plane(`fxn${suffix}`, [-1, 0, 0], [x0, 5, 2.5], [x0, 0, 0], [x0, 10, 5]),
  plane(`fyp${suffix}`, [0, 1, 0], [(x0 + x1) / 2, 10, 2.5], [x0, 10, 0], [x1, 10, 5]),
  plane(`fyn${suffix}`, [0, -1, 0], [(x0 + x1) / 2, 0, 2.5], [x0, 0, 0], [x1, 0, 5]),
  plane(`fzp${suffix}`, [0, 0, 1], [(x0 + x1) / 2, 5, 5], [x0, 0, 5], [x1, 10, 5]),
  plane(`fzn${suffix}`, [0, 0, -1], [(x0 + x1) / 2, 5, 0], [x0, 0, 0], [x1, 10, 0]),
];
const without = (faces: Face[], ...ids: string[]) => faces.filter((face) => !ids.includes(face.id));
const check = (before: Face[], after: Face[], extra: Partial<Parameters<typeof operationsModule.checkDrivingDistanceGeometry>[0]> = {}) =>
  operationsModule.checkDrivingDistanceGeometry({ bodyId: 5, movingFaceId: "fxp", referenceFaceId: "fxn", distanceMm: 30, before, after, ...extra });

// ---- the four reviewer scenarios: each was accepted by the round-3 plane-set check

test("wrong (i): a different same-direction face at 1970 moves to 2030 while the moving face stays", () => {
  const step = plane("fstep", [1, 0, 0], [1970, 15, 2.5], [1970, 10, 0], [1970, 20, 5]);
  const result = check([...box(), step], [...box(), { ...step, id: "fstep2", centerMm: [2030, 15, 2.5], boundsMm: { min: [2030, 10, 0], max: [2030, 20, 5] } }]);
  assert.equal(result.ok, false);
  assert.equal(result.conditions.left, false, "(1) the moving face is still at 2020 over its footprint");
  assert.match(result.problem!, /^a different face moved \(planes at 1970 mm lost a face; the moving face at 2020 mm did not move\)$/);
});

test("wrong (ii): a coplanar sibling 500 mm sideways moves instead of the moving face", () => {
  const sibling = plane("fsib", [1, 0, 0], [2020, 505, 2.5], [2020, 500, 0], [2020, 510, 5]);
  const result = check([...box(), sibling], [...box(), { ...sibling, id: "fsib2", centerMm: [2030, 505, 2.5], boundsMm: { min: [2030, 500, 0], max: [2030, 510, 5] } }]);
  assert.equal(result.ok, false);
  assert.equal(result.conditions.left, false);
  assert.equal(result.conditions.reached, false, "(2) the face at 2030 does not cover the moving face's hit point");
  assert.match(result.problem!, /^no face moved to 2030 mm \(the moving face 5:fxp is still at 2020 mm over its footprint; a face at 2030 mm exists, but not over the moving face's footprint\)$/);
});

test("wrong (iii): the moving face stays and a NEW face appears at 2030", () => {
  const result = check(box(), [...box(), plane("fnew", [1, 0, 0], [2030, 5, 2.5], [2030, 0, 0], [2030, 10, 5])]);
  assert.equal(result.ok, false);
  assert.equal(result.conditions.left, false);
  assert.match(result.problem!, /^no face moved to 2030 mm \(the moving face 5:fxp is still at 2020 mm over its footprint\)$/);
});

test("wrong (iv): the reference moves to 1990 while another -x plane sits at 2000 (true distance 40)", () => {
  const other = plane("fother", [-1, 0, 0], [2000, 505, 2.5], [2000, 500, 0], [2000, 510, 5]);
  const after = [...without(box(1990, 2030), "fxn"), plane("fxn2", [-1, 0, 0], [1990, 5, 2.5], [1990, 0, 0], [1990, 10, 5]), other];
  const result = check([...box(), other], after);
  assert.equal(result.ok, false);
  assert.equal(result.conditions.reference, false, "(3) no -x face remains at 2000 over the reference's centre");
  assert.match(result.problem!, /^the reference face 5:fxn moved \(no face remains at 2000 mm over its centre\)$/);
});

// ---- nine legitimate edits

test("legit: a plain move, and the moved face split in two at the target", () => {
  assert.equal(check(box(), box(2000, 2030, "'")).ok, true);
  const after = [...without(box(2000, 2030, "'"), "fxp'"),
    plane("fa", [1, 0, 0], [2030, 3.5, 2.5], [2030, 0, 0], [2030, 7, 5]), plane("fb", [1, 0, 0], [2030, 8.5, 2.5], [2030, 7, 0], [2030, 10, 5])];
  const result = check(box(), after);
  assert.equal(result.ok, true, result.problem ?? "");
  assert.equal(result.movedFace!.id, "fa", "the piece over the hit point (y 5)");
  assert.equal(result.reachedOffsetMm, 2030);
});

test("legit: the reference face gets a new ID, and the reference face splits", () => {
  const renamed = box(2000, 2030, "'").map((face) => face.id === "fxn'" ? { ...face, id: "fxn-new" } : face);
  assert.equal(check(box(), renamed).ok, true);
  const split = [...without(box(2000, 2030, "'"), "fxn'"),
    plane("fna", [-1, 0, 0], [2000, 2.5, 2.5], [2000, 0, 0], [2000, 5, 5]), plane("fnb", [-1, 0, 0], [2000, 7.5, 2.5], [2000, 5, 0], [2000, 10, 5])];
  const result = check(box(), split);
  assert.equal(result.ok, true, result.problem ?? "");
});

test("legit: make flush, the moving face merges into a coplanar sibling at the target", () => {
  // An L: the moving +x face at 2020 (y 0..10) and a sibling +x face at 2030 (y 10..20).
  const sibling = plane("fsib", [1, 0, 0], [2030, 15, 2.5], [2030, 10, 0], [2030, 20, 5]);
  const merged = plane("fmerged", [1, 0, 0], [2030, 10, 2.5], [2030, 0, 0], [2030, 20, 5]);
  const result = check([...box(), sibling], [...without(box(2000, 2030, "'"), "fxp'"), merged]);
  assert.equal(result.ok, true, result.problem ?? "");
  assert.equal(result.movedFace!.id, "fmerged");
});

test("legit: a small step between the old and the target offset is swallowed by the move", () => {
  const step = plane("fstep", [1, 0, 0], [2025, 11, 2.5], [2025, 10, 0], [2025, 12, 5]);
  const result = check([...box(), step], box(2000, 2030, "'"));
  assert.equal(result.ok, true, result.problem ?? "");
  // A step OUTSIDE the old..target range that disappears is not legitimate.
  const far = plane("ffar", [1, 0, 0], [2040, 11, 2.5], [2040, 10, 0], [2040, 12, 5]);
  const wrong = check([...box(), far], box(2000, 2030, "'"));
  assert.equal(wrong.ok, false);
  assert.match(wrong.problem!, /^other faces changed along the normal \(planes gone from 2040 mm\)$/);
});

test("legit: a tilted pair with non-round numbers", () => {
  const n: V = [0.6, 0.8, 0];
  const u: V = [-0.8, 0.6, 0];
  const w: V = [0, 0, 1];
  const at = (offset: number, lateral: number): V => [n[0] * offset + u[0] * lateral, n[1] * offset + u[1] * lateral, 3.25];
  const rect = (id: string, normal: V, center: V): Face => {
    const corners = [[-10, -5], [-10, 5], [10, -5], [10, 5]].map(([a, b]) => center.map((value, axis) => value + u[axis]! * a! + w[axis]! * b!) as V);
    const min = [0, 1, 2].map((axis) => Math.min(...corners.map((corner) => corner[axis]!))) as V;
    const max = [0, 1, 2].map((axis) => Math.max(...corners.map((corner) => corner[axis]!))) as V;
    return { id, planar: true, normal, centerMm: center, boundsMm: { min, max } };
  };
  const before = [rect("fm", n, at(1234.567, 7.125)), rect("fr", [-0.6, -0.8, 0], at(1200.123, 7.125))];
  const after = [rect("fm2", n, at(1200.123 + 41.2345, 7.125)), rect("fr2", [-0.6, -0.8, 0], at(1200.123, 7.125))];
  const result = operationsModule.checkDrivingDistanceGeometry({ bodyId: 5, movingFaceId: "fm", referenceFaceId: "fr", distanceMm: 41.2345, before, after });
  assert.equal(result.ok, true, result.problem ?? "");
  assert.ok(Math.abs(result.measuredMm! - 41.2345) <= 1e-6, String(result.measuredMm));
});

test("legit: slot walls that face each other (the slot width 10 -> 14 mm)", () => {
  const walls = (right: number): Face[] => [
    plane("outer+x", [1, 0, 0], [2040, 10, 5], [2040, 0, 0], [2040, 20, 10]),
    plane("outer-x", [-1, 0, 0], [2000, 10, 5], [2000, 0, 0], [2000, 20, 10]),
    plane("wallA", [1, 0, 0], [2015, 10, 7.5], [2015, 0, 5], [2015, 20, 10]),
    plane(`wallB${right}`, [-1, 0, 0], [right, 10, 7.5], [right, 0, 5], [right, 20, 10]),
    plane("floor", [0, 0, 1], [(2015 + right) / 2, 10, 5], [2015, 0, 5], [right, 20, 5]),
  ];
  const result = operationsModule.checkDrivingDistanceGeometry({ bodyId: 5, movingFaceId: "wallB2025", referenceFaceId: "wallA", distanceMm: 14, before: walls(2025), after: walls(2029) });
  assert.equal(result.ok, true, result.problem ?? "");
  assert.equal(result.reachedOffsetMm, -2029, "offsets run along the moving wall's -x normal");
});

test("legit: a reversed stepped pair (the lower +z face moves 5 -> 8 mm below the upper one)", () => {
  const stepped = (lower: number): Face[] => [
    plane("upper", [0, 0, 1], [2010, 5, 10], [2000, 0, 10], [2020, 10, 10]),
    plane(`lower${lower}`, [0, 0, 1], [2030, 5, lower], [2020, 0, lower], [2040, 10, lower]),
    plane("bottom", [0, 0, -1], [2020, 5, 0], [2000, 0, 0], [2040, 10, 0]),
    plane("riser", [1, 0, 0], [2020, 5, (10 + lower) / 2], [2020, 0, lower], [2020, 10, 10]),
  ];
  const result = operationsModule.checkDrivingDistanceGeometry({ bodyId: 5, movingFaceId: "lower5", referenceFaceId: "upper", distanceMm: 8, before: stepped(5), after: stepped(2) });
  assert.equal(result.ok, true, result.problem ?? "");
  assert.equal(result.reachedOffsetMm, 2);
});

test("legit: single-face mode, with Plasticity's reference point on a face and with no face under it", () => {
  const before = box();
  const after = box().map((face) => face.id === "fzp" ? { ...face, id: "fzp'", centerMm: [2010, 5, 12] as V, boundsMm: { min: [2000, 0, 12] as V, max: [2020, 10, 12] as V } } : face);
  const onFace = operationsModule.checkDrivingDistanceGeometry({ bodyId: 5, movingFaceId: "fzp", distanceMm: 12, referencePointMm: [2010, 5, 0], before, after });
  assert.equal(onFace.ok, true, onFace.problem ?? "");
  assert.equal(onFace.conditions.reference, true, "the -z face under `to` was checked");
  const nowhere = operationsModule.checkDrivingDistanceGeometry({ bodyId: 5, movingFaceId: "fzp", distanceMm: 12, referenceOffsetMm: 0, before, after });
  assert.equal(nowhere.ok, true);
  // The -z face under `to` moving away is caught in single-face mode too.
  const moved = after.map((face) => face.id === "fzn" ? { ...face, centerMm: [2010, 5, -1] as V, boundsMm: { min: [2000, 0, -1] as V, max: [2020, 10, -1] as V } } : face);
  const wrong = operationsModule.checkDrivingDistanceGeometry({ bodyId: 5, movingFaceId: "fzp", distanceMm: 12, referencePointMm: [2010, 5, 0], before, after: moved });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.conditions.reference, false);
});

test("the step-deleted case: the moving face is removed, and the check names it", () => {
  // Stepped block: the lower +z face (z 5) set 12 mm below the upper one goes past the bottom; Plasticity removes the
  // low part (live, probe-pair-layouts.json stepped_reversed_lower_moves_5_to_12_past_zero).
  const before: Face[] = [
    plane("upper", [0, 0, 1], [2010, 5, 10], [2000, 0, 10], [2020, 10, 10]),
    plane("lower", [0, 0, 1], [2030, 5, 5], [2020, 0, 5], [2040, 10, 5]),
    plane("bottom", [0, 0, -1], [2020, 5, 0], [2000, 0, 0], [2040, 10, 0]),
  ];
  const after: Face[] = [plane("upper'", [0, 0, 1], [2010, 5, 10], [2000, 0, 10], [2020, 10, 10]), plane("bottom'", [0, 0, -1], [2010, 5, 0], [2000, 0, 0], [2020, 10, 0])];
  const result = operationsModule.checkDrivingDistanceGeometry({ bodyId: 5, movingFaceId: "lower", referenceFaceId: "upper", distanceMm: 12, before, after });
  assert.equal(result.ok, false);
  assert.match(result.problem!, /^no face moved to -2 mm: the moving face 5:lower was removed \(no face facing \[0, 0, 1\] remains at 5 mm over its footprint, and none reached either distance from the reference\)$/);
});

// ---- ambiguity: a bounds box cannot prove "still at" or "reached" when a coplanar sibling's box covers the click point

// Faces facing +x at 2040 over a -x face at 2000: the moving island/pad face and a coplanar sibling whose bounds box
// covers the island's centre. The reference is the -x face at 2000.
const wide = (id: string, normal: V, x: number, y: [number, number], z: [number, number]): Face => plane(id, normal, [x, (y[0] + y[1]) / 2, (z[0] + z[1]) / 2], [x, y[0], z[0]], [x, y[1], z[1]]);
const SIBLING_NOTE = /another coplanar face overlaps the footprint \(5:fring\); could not prove which face moved/;

test("island inside a ring-shaped coplanar face: the correct edit is an ambiguous success, not a mismatch", () => {
  const ring = wide("fring", [1, 0, 0], 2040, [0, 40], [0, 20]);
  const island = wide("fisl", [1, 0, 0], 2040, [15, 25], [5, 15]);
  const ref = wide("fref", [-1, 0, 0], 2000, [0, 40], [0, 20]);
  const after = [ring, wide("fisl2", [1, 0, 0], 2050, [15, 25], [5, 15]), ref];
  const result = operationsModule.checkDrivingDistanceGeometry({ bodyId: 5, movingFaceId: "fisl", referenceFaceId: "fref", distanceMm: 50, before: [ring, island, ref], after });
  assert.equal(result.ok, true, result.problem ?? "");
  assert.equal(result.ambiguous, true);
  assert.match(result.note!, SIBLING_NOTE);
  assert.equal(result.movedFace!.id, "fisl2");
  assert.equal(result.reachedOffsetMm, 2050);
  assert.ok(Math.abs(result.measuredMm! - 50) <= 1e-6);
});

test("pad beside an L-shaped coplanar face whose bounds box covers the pad: ambiguous success", () => {
  const ell = wide("fring", [1, 0, 0], 2040, [0, 40], [0, 40]);
  const pad = wide("fpad", [1, 0, 0], 2040, [25, 40], [25, 40]);
  const ref = wide("fref", [-1, 0, 0], 2000, [0, 40], [0, 40]);
  const after = [ell, wide("fpad2", [1, 0, 0], 2047.5, [25, 40], [25, 40]), ref];
  const result = operationsModule.checkDrivingDistanceGeometry({ bodyId: 5, movingFaceId: "fpad", referenceFaceId: "fref", distanceMm: 47.5, before: [ell, pad, ref], after });
  assert.equal(result.ok, true, result.problem ?? "");
  assert.equal(result.ambiguous, true);
  assert.match(result.note!, SIBLING_NOTE);
});

test("a slanted adjacent wall shifts the moved face sideways off the click point: ambiguous success, but a face far away is still a mismatch", () => {
  // The moving +x face (y 0..10) lands at 2030 with its footprint shifted 6 mm along y: its box no longer covers the click point (y 5).
  const shifted = (shift: number) => [...without(box(), "fxp"), plane("fxp2", [1, 0, 0], [2030, 5 + shift, 2.5], [2030, shift, 0], [2030, 10 + shift, 5])];
  const near6 = check(box(), shifted(6));
  assert.equal(near6.ok, true, near6.problem ?? "");
  assert.equal(near6.ambiguous, true);
  assert.match(near6.note!, /the moved face no longer covers the click point \(it shifted sideways\) and 5:fxp2 at the target adjoins the old footprint; could not prove which face moved/);
  assert.equal(near6.movedFace!.id, "fxp2");
  // 500 mm away it is the sibling-moved case (ii): certain.
  const far = check(box(), shifted(500));
  assert.equal(far.ok, false);
  assert.equal(far.ambiguous, false);
  assert.match(far.problem!, /^no face moved to 2030 mm: the moving face 5:fxp was removed/);
});

test("ambiguity does not weaken the certain mismatches: the moving face stays, the reference moves, the distance is wrong", () => {
  const ring = wide("fring", [1, 0, 0], 2040, [0, 40], [0, 20]);
  const island = wide("fisl", [1, 0, 0], 2040, [15, 25], [5, 15]);
  const ref = wide("fref", [-1, 0, 0], 2000, [0, 40], [0, 20]);
  const pair = { bodyId: 5, movingFaceId: "fisl", referenceFaceId: "fref", distanceMm: 50, before: [ring, island, ref] };
  // The island stays and a NEW face appears at 2050 over it: both faces still cover the click point at 2040.
  const stays = operationsModule.checkDrivingDistanceGeometry({ ...pair, after: [ring, island, wide("fnew", [1, 0, 0], 2050, [15, 25], [5, 15]), ref] });
  assert.equal(stays.ok, false);
  assert.equal(stays.ambiguous, false);
  assert.equal(stays.conditions.left, false, "the count of covering faces did not fall: the island is still there");
  assert.match(stays.problem!, /^no face moved to 2050 mm \(the moving face 5:fisl is still at 2040 mm over its footprint\)$/);
  // The reference moved: certain, whatever the siblings.
  const refMoved = operationsModule.checkDrivingDistanceGeometry({ ...pair, after: [ring, wide("fisl2", [1, 0, 0], 2050, [15, 25], [5, 15]), wide("fref2", [-1, 0, 0], 1995, [0, 40], [0, 20])] });
  assert.equal(refMoved.ok, false);
  assert.equal(refMoved.conditions.reference, false);
  // The measured distance is wrong: the island ends at 2049 (49 mm), certain.
  const wrongDistance = operationsModule.checkDrivingDistanceGeometry({ ...pair, after: [ring, wide("fisl2", [1, 0, 0], 2049, [15, 25], [5, 15]), ref] });
  assert.equal(wrongDistance.ok, false);
  assert.equal(wrongDistance.ambiguous, false);
});

test("what a bounds box genuinely cannot tell: the ring moves to the target instead of the island, and both look like a correct edit", () => {
  // Before: ring and island coplanar at 2040, the ring's box covers the island's centre. After: the island stays at 2040
  // and a face whose box covers the click point sits at 2050. The covering count fell by one and a face reached the target:
  // the same boxes as the correct edit, so the check says "ambiguous", never "still at" with an undo.
  const ring = wide("fring", [1, 0, 0], 2040, [0, 40], [0, 20]);
  const island = wide("fisl", [1, 0, 0], 2040, [15, 25], [5, 15]);
  const ref = wide("fref", [-1, 0, 0], 2000, [0, 40], [0, 20]);
  const result = operationsModule.checkDrivingDistanceGeometry({ bodyId: 5, movingFaceId: "fisl", referenceFaceId: "fref", distanceMm: 50, before: [ring, island, ref], after: [island, wide("fring2", [1, 0, 0], 2050, [0, 40], [0, 20]), ref] });
  assert.equal(result.ok, true, result.problem ?? "");
  assert.equal(result.ambiguous, true);
});

test("the four reviewer scenarios stay certain mismatches: a sibling's box never covers their click point, so none turns ambiguous", () => {
  const step = plane("fstep", [1, 0, 0], [1970, 15, 2.5], [1970, 10, 0], [1970, 20, 5]);
  const sibling = plane("fsib", [1, 0, 0], [2020, 505, 2.5], [2020, 500, 0], [2020, 510, 5]);
  const other = plane("fother", [-1, 0, 0], [2000, 505, 2.5], [2000, 500, 0], [2000, 510, 5]);
  const cases: Array<[string, Face[], Face[]]> = [
    ["(i)", [...box(), step], [...box(), { ...step, id: "fstep2", centerMm: [2030, 15, 2.5], boundsMm: { min: [2030, 10, 0], max: [2030, 20, 5] } }]],
    ["(ii)", [...box(), sibling], [...box(), { ...sibling, id: "fsib2", centerMm: [2030, 505, 2.5], boundsMm: { min: [2030, 500, 0], max: [2030, 510, 5] } }]],
    ["(iii)", box(), [...box(), plane("fnew", [1, 0, 0], [2030, 5, 2.5], [2030, 0, 0], [2030, 10, 5])]],
    ["(iv)", [...box(), other], [...without(box(1990, 2030), "fxn"), plane("fxn2", [-1, 0, 0], [1990, 5, 2.5], [1990, 0, 0], [1990, 10, 5]), other]],
  ];
  for (const [label, before, after] of cases) {
    const result = check(before, after);
    assert.equal(result.ok, false, label);
    assert.equal(result.ambiguous, false, label);
    assert.equal(result.note, null, label);
  }
});

// ---- end to end: setDrivingDistance over a stub editor whose commit applies a given face list

function commitWorld(before: Face[], afterOf: (distanceM: number) => Face[], options: { bumpVersion?: boolean } = {}) {
  let faces = structuredClone(before);
  let version = 105;
  let revision = 1;
  const undoStack: Face[][] = [];
  const sceneObjects: unknown[] = [];
  const selected = new Set<unknown>();
  const hits = new Map<unknown, unknown>();
  class Vector3 { x: number; y: number; z: number; constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } }
  class FakeDialog { params: Record<string, unknown>; finish?: () => void; constructor(params: Record<string, unknown>) { this.params = params; } }
  const ids = () => faces.map((face) => face.id);
  const view = { constructor: { name: "Solid" }, high: { get faces() { return { versionIds: ids(), get: (index: number) => ({ face: ids()[index], entityId: 700 + index }) }; }, edges: { versionIds: [] } } };
  const model = { GetFaces: () => ({ Size: () => faces.length, Get: (index: number) => ({ Id: () => 700 + index, GetAnyPointOn: () => { const p = faces[index]!.centerMm; return { position: { x: p[0] / 1000, y: p[1] / 1000, z: p[2] / 1000 } }; } }) }) };
  class DimensionDistanceCommand {
    remember = true;
    editor: unknown;
    constructor(editor: unknown) { this.editor = editor; }
    async execute(): Promise<unknown> {
      return await new Promise((resolve) => {
        const dialog = new FakeDialog({ refDistance: 0.02, distance: 0.02 });
        dialog.finish = () => {
          sceneObjects.length = 0;
          undoStack.push(faces);
          faces = structuredClone(afterOf(dialog.params.distance as number));
          revision += 1;
          if (options.bumpVersion !== false) version += 1;
          resolve(undefined);
        };
        sceneObjects.push(dialog);
      });
    }
  }
  const executor = { isBusy: false, active: null as unknown, cancelActiveCommand() {} };
  const editor = {
    geo: { read: { geometryModel: new Map([[105, { view, model }]]), automatics: new Set() }, lookupStableId(versionId: number) { return versionId - 100; } },
    db: { version: 1, commit() { return undefined; } }, executor, history: { undoStack, redoStack: [] as unknown[] },
    helpers: { scene: { traverse(visit: (object: unknown) => void) { for (const object of [...sceneObjects]) visit(object); } } },
    selection: { selected: { faces: selected, add(item: unknown) { selected.add(item); }, removeAll() { selected.clear(); } }, hits: { hits, record(item: unknown, point: unknown) { hits.set(item, point); }, clear() { hits.clear(); } } },
    async exec(command: DimensionDistanceCommand) { executor.active = { command }; try { await command.execute(); } finally { executor.active = null; } },
    async undo() { const previous = undoStack.pop(); if (previous) { faces = previous; revision += 1; version += 1; } },
  };
  let uncertain = false;
  const runtime = {
    async getState() {
      return {
        targetId: "window", title: "geometry", documentToken: "document", revision: `r${revision}`, dbVersion: revision, undoDepth: undoStack.length, redoDepth: 0,
        construction: { planes: [], activePlaneId: null, planeStateToken: "planes", viewStateToken: "view" }, regions: [], measurements: [],
        bodies: [{ id: 5, versionId: version, type: "Solid", name: null, boundsMm: null, faceIds: ids(), edgeIds: [], faces: structuredClone(faces).map((face) => ({ ...face, surfaceType: "Plane", edgeIds: [] })), edges: [] }],
      } as unknown as RuntimeState;
    },
    async mutate(source: string, bindings: string[], values: unknown[]) {
      if (uncertain) throw new Error("Previous mutation outcome is uncertain; call reconcile before another mutation");
      const native = Function(`return (${source})`)();
      return await native.call(editor, ...bindings.map((name) => ({ DimensionDistanceCommand, DimensionDistanceSpaceDialog: FakeDialog, Vector3 } as Record<string, unknown>)[name]), ...values);
    },
    async read() { throw new Error("unexpected read"); },
    isUncertain() { return uncertain; },
    markUncertain() { uncertain = true; },
  } as unknown as PlasticityRuntime;
  return { operations: new PlasticityOperations(runtime), isUncertain: () => uncertain, faces: () => faces, undoDepth: () => undoStack.length };
}

const FAST: PickCommandTimeouts = { dialogMs: 100, finishMs: 200, cancelMs: 100 };
const PAIR = { bodyId: 5, movingFaceId: "fxp", referenceFaceId: "fxn", distanceMm: 30 };

test("end to end: the island, the L-pad and the slanted wall edits succeed with verification ambiguous and a note; undo stays available", async () => {
  const ring = wide("fring", [1, 0, 0], 2040, [0, 40], [0, 20]);
  const island = wide("fisl", [1, 0, 0], 2040, [15, 25], [5, 15]);
  const ref = wide("fref", [-1, 0, 0], 2000, [0, 40], [0, 20]);
  const pair = { bodyId: 5, movingFaceId: "fisl", referenceFaceId: "fref", distanceMm: 50 };
  const w = commitWorld([ring, island, ref], () => [ring, wide("fisl2", [1, 0, 0], 2050, [15, 25], [5, 15]), ref]);
  const result = await w.operations.setDrivingDistance(pair, "r1", FAST);
  assert.equal(result.changed, true);
  assert.equal(result.verification, "ambiguous");
  assert.match(result.note!, /another coplanar face overlaps the footprint \(5:fring\); could not prove which face moved/);
  assert.equal(result.movedFaceId, "fisl2");
  assert.equal(result.planeOffsetMm, 2050);
  assert.equal(result.undoSteps, 1);
  assert.equal(w.isUncertain(), false);
  // A plain verified edit carries no verification field.
  const plain = commitWorld(box(), (distanceM) => box(2000, 2000 + distanceM * 1000, "'"));
  const verified = await plain.operations.setDrivingDistance(PAIR, "r1", FAST);
  assert.equal("verification" in verified, false);
  assert.equal("note" in verified, false);
  // The L-pad and the slanted wall.
  const ell = wide("fring", [1, 0, 0], 2040, [0, 40], [0, 40]);
  const pad = wide("fpad", [1, 0, 0], 2040, [25, 40], [25, 40]);
  const lref = wide("fref", [-1, 0, 0], 2000, [0, 40], [0, 40]);
  const lpad = commitWorld([ell, pad, lref], () => [ell, wide("fpad2", [1, 0, 0], 2047.5, [25, 40], [25, 40]), lref]);
  const padResult = await lpad.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "fpad", referenceFaceId: "fref", distanceMm: 47.5 }, "r1", FAST);
  assert.equal(padResult.verification, "ambiguous");
  const slanted = commitWorld(box(), () => [...without(box(2000, 2030, "'"), "fxp'"), plane("fxp2", [1, 0, 0], [2030, 11, 2.5], [2030, 6, 0], [2030, 16, 5])]);
  const slantResult = await slanted.operations.setDrivingDistance(PAIR, "r1", FAST);
  assert.equal(slantResult.verification, "ambiguous");
  assert.match(slantResult.note!, /shifted sideways/);
  assert.equal(slanted.isUncertain(), false);
});

test("end to end: the four reviewer scenarios are certain committed-mismatch errors that name the undo", async () => {
  const step = plane("fstep", [1, 0, 0], [1970, 15, 2.5], [1970, 10, 0], [1970, 20, 5]);
  const sibling = plane("fsib", [1, 0, 0], [2020, 505, 2.5], [2020, 500, 0], [2020, 510, 5]);
  const other = plane("fother", [-1, 0, 0], [2000, 505, 2.5], [2000, 500, 0], [2000, 510, 5]);
  const cases: Array<[string, Face[], Face[], RegExp]> = [
    ["(i)", [...box(), step], [...box(), { ...step, id: "fstep2", centerMm: [2030, 15, 2.5], boundsMm: { min: [2030, 10, 0], max: [2030, 20, 5] } }], /a different face moved/],
    ["(ii)", [...box(), sibling], [...box(), { ...sibling, id: "fsib2", centerMm: [2030, 505, 2.5], boundsMm: { min: [2030, 500, 0], max: [2030, 510, 5] } }], /not over the moving face's footprint/],
    ["(iii)", box(), [...box(), plane("fnew", [1, 0, 0], [2030, 5, 2.5], [2030, 0, 0], [2030, 10, 5])], /the moving face 5:fxp is still at 2020 mm/],
    ["(iv)", [...box(), other], [...without(box(1990, 2030), "fxn"), plane("fxn2", [-1, 0, 0], [1990, 5, 2.5], [1990, 0, 0], [1990, 10, 5]), other], /the reference face 5:fxn moved/],
  ];
  for (const [label, before, after, pattern] of cases) {
    const w = commitWorld(before, () => after);
    await assert.rejects(w.operations.setDrivingDistance(PAIR, "r1", FAST), (error: Error) => {
      assert.ok(error instanceof operationsModule.CommittedChangeError, `${label}: a CommittedChangeError`);
      assert.equal((error as operationsModule.CommittedChangeError).revision, "r2", label);
      assert.match(error.message, pattern, label);
      assert.match(error.message, /The document is in a known state at revision r2: one Undo step was added, and plasticity_undo restores the previous geometry$/, label);
      assert.doesNotMatch(error.message, /uncertain|timed? ?out|timeout/i, `${label}: the journal must not read it as unknown`);
      return true;
    });
    assert.equal(w.isUncertain(), false, `${label}: a determinate change keeps the runtime certain`);
    // One undo restores the body without a reconcile.
    await w.operations.undo("r2");
    assert.equal(w.undoDepth(), 0, label);
    assert.deepEqual(w.faces().map((face) => face.id), before.map((face) => face.id), label);
  }
});

test("end to end: the step-deleted case is a certain mismatch naming the removed face; one undo restores it", async () => {
  const before: Face[] = [
    plane("upper", [0, 0, 1], [2010, 5, 10], [2000, 0, 10], [2020, 10, 10]),
    plane("lower", [0, 0, 1], [2030, 5, 5], [2020, 0, 5], [2040, 10, 5]),
    plane("bottom", [0, 0, -1], [2020, 5, 0], [2000, 0, 0], [2040, 10, 0]),
  ];
  const w = commitWorld(before, () => [plane("upper'", [0, 0, 1], [2010, 5, 10], [2000, 0, 10], [2020, 10, 10]), plane("bottom'", [0, 0, -1], [2010, 5, 0], [2000, 0, 0], [2020, 10, 0])]);
  await assert.rejects(w.operations.setDrivingDistance({ bodyId: 5, movingFaceId: "lower", referenceFaceId: "upper", distanceMm: 12 }, "r1", FAST), (error: Error) => {
    assert.match(error.message, /^Driving distance committed one Undo step, but the read-back does not match: no face moved to -2 mm: the moving face 5:lower was removed/);
    assert.match(error.message, /one Undo step was added, and plasticity_undo restores the previous geometry$/);
    return true;
  });
  assert.equal(w.isUncertain(), false);
  await w.operations.undo("r2");
  assert.deepEqual(w.faces(), before, "one undo restores the body, no reconcile");
});

test("version rule: the body version is not part of the check (a correct move without a version bump is accepted)", async () => {
  const w = commitWorld(box(), (distanceM) => box(2000, 2000 + distanceM * 1000, "'"), { bumpVersion: false });
  const result = await w.operations.setDrivingDistance(PAIR, "r1", FAST);
  assert.equal(result.changed, true);
  assert.equal(result.planeOffsetMm, 2030);
  assert.equal(result.movedFaceId, "fxp'");
  // A version bump with the wrong geometry is still a mismatch.
  const v = commitWorld(box(), () => box(), { bumpVersion: true });
  await assert.rejects(v.operations.setDrivingDistance(PAIR, "r1", FAST), /no face moved to 2030 mm .*Plasticity made no change: distance is still 20 mm, requested 30 mm/);
  assert.equal(v.isUncertain(), false);
});
