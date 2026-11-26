import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  continuityGateSummary,
  continuityPlanFailureMessage,
  curvatureRangeSlice,
  continuitySampleSummary,
  evaluateContinuityPlan,
  matchContinuityPlan,
  mixedG2Sample,
  nativeMaximumCheckOutcome,
  nativeMaximumChecksNeeded,
  planItemCheckLevels,
  planItemTolerances,
  requireAbsoluteCurvatureTolerance,
  withContinuitySummary,
  type ContinuityGateSamples,
  type ContinuityGateSummary,
  type ContinuityNativeMaxima,
  type ContinuityPlanItem,
  type DenseContinuitySamples,
  type Vector3,
} from "./surfacing.ts";
import { CROSS_EDGE_EVALUATOR_SOURCE, FACE_PARAMETER_CLAMP_SOURCE, PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime } from "./runtime.ts";

// Continuity gate (spec bench/specs/gate.md): the mixed G2 rule, effective classes, the native-maximum cross-check and the
// plan evaluation, on synthetic samples.

const TOL = { positionMm: 0.01, normalAngleDeg: 0.1, relativeCurvature: 0.05, absoluteCurvaturePerMm: 0.001 };
const N = 100;
const points = (): Vector3[] => Array.from({ length: N }, (_, i) => [i, 0, 0] as Vector3);

/** 100 samples: G0 and G1 zero unless given, curvature across from k1/k2 (numbers or per-sample functions). */
function samples(k1: number | ((i: number) => number | null), k2: number | ((i: number) => number | null), extra: { g1Deg?: (i: number) => number; g0Mm?: (i: number) => number; g2Rel?: (i: number) => number; nativeK?: [number | null, number | null] | null } = {}): ContinuityGateSamples {
  const f = (k: number | ((i: number) => number | null)) => (typeof k === "number" ? () => k : k);
  const side1 = Array.from({ length: N }, (_, i) => f(k1)(i));
  const side2 = Array.from({ length: N }, (_, i) => f(k2)(i));
  const relative = (a: number | null, b: number | null) => (a === null || b === null ? 1 : Math.abs(a) + Math.abs(b) > 0 ? Math.min(1, Math.abs(a - b) / (Math.abs(a) + Math.abs(b))) : 0);
  return {
    g0Mm: Array.from({ length: N }, (_, i) => extra.g0Mm?.(i) ?? 0),
    g1Deg: Array.from({ length: N }, (_, i) => extra.g1Deg?.(i) ?? 0),
    g2Rel: Array.from({ length: N }, (_, i) => extra.g2Rel?.(i) ?? relative(side1[i]!, side2[i]!)),
    pointsMm: points(),
    curvatureAcross: { side1PerMm: side1, side2PerMm: side2 },
    // The curvatures at the native G2 maximum: sample 50's unless given (null: the kernel read none there).
    nativeG2CurvaturePerMm: extra.nativeK !== undefined ? extra.nativeK : [side1[50]!, side2[50]!],
  };
}
const nativeOf = (s: ContinuityGateSamples, over: Partial<ContinuityNativeMaxima> = {}): ContinuityNativeMaxima => ({
  g0Mm: Math.max(...s.g0Mm), g1Deg: Math.max(...s.g1Deg), g2Rel: Math.max(...s.g2Rel), g0AtMm: [0, 0, 0], g1AtMm: [50, 0, 0], g2AtMm: [50, 0, 0], ...over,
});
const gate = (s: ContinuityGateSamples, over: Partial<ContinuityNativeMaxima> = {}) => continuityGateSummary(s, nativeOf(s, over), TOL);

test("mixed G2 rule on single samples: relative OR absolute, flat label when only the absolute term passes", () => {
  // Real mismatch (flank/side boundary layer): 0.077 against 0.0019 /mm fails.
  assert.equal(mixedG2Sample(0.077, 0.0019, 0.05, 0.001).verdict, "fail");
  // R5 against R10 (0.2 vs 0.1 /mm): relative 1/3, |dk| 0.1: fails.
  const r5r10 = mixedG2Sample(0.2, 0.1, 0.05, 0.001);
  assert.equal(r5r10.verdict, "fail");
  assert.ok(Math.abs(r5r10.relative! - 1 / 3) < 1e-12);
  // Plane against a fillet R5 (0 vs 0.2): fails.
  assert.equal(mixedG2Sample(0, 0.2, 0.05, 0.001).verdict, "fail");
  // Near the absolute threshold both pass, by the absolute term (flat), although relative reads 0.8 and 0.833: no cliff.
  const below = mixedG2Sample(0.0009, 0.0001, 0.05, 0.001);
  const at = mixedG2Sample(0.0011, 0.0001, 0.05, 0.001);
  assert.equal(below.verdict, "flat");
  assert.equal(at.verdict, "flat");
  assert.ok(below.relative! > 0.05 && at.relative! > 0.05);
  // Clearly past the absolute term with a relative mismatch: fails.
  assert.equal(mixedG2Sample(0.0012, 0.0001, 0.05, 0.001).verdict, "fail");
  // Matched curvature: the relative test decides (measured pass), whatever the size.
  assert.equal(mixedG2Sample(0.2, 0.2005, 0.05, 0.001).verdict, "pass");
  assert.equal(mixedG2Sample(0.00002, 0.000021, 0.05, 0.001).verdict, "pass");
  // Both exactly flat: 0/0 decides nothing, so it is flat (passes only by the absolute term).
  assert.equal(mixedG2Sample(0, 0, 0.05, 0.001).verdict, "flat");
  // Without both curvatures: the native relative value alone decides; with nothing it fails (never passes silently).
  assert.deepEqual([mixedG2Sample(null, 0.1, 0.05, 0.001, 0.01).verdict, mixedG2Sample(null, 0.1, 0.05, 0.001, 0.9).verdict, mixedG2Sample(null, null, 0.05, 0.001).verdict], ["pass", "fail", "fail"]);
});

test("absoluteCurvatureTolerancePerMm must be finite and greater than 0", () => {
  assert.equal(requireAbsoluteCurvatureTolerance(0.001), 0.001);
  for (const bad of [0, -0.001, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => requireAbsoluteCurvatureTolerance(bad), /absoluteCurvatureTolerancePerMm must be a finite number greater than 0/);
});

test("all flat across: every interior sample passes only by the absolute term, G2 not measurable but still G2", () => {
  // Side/back style: 1.8e-5 against 8.4e-4 /mm: relative 0.96, |dk| 8.2e-4.
  const s = samples(1.8e-5, 8.4e-4);
  const g = gate(s);
  assert.equal(g.g2.status, "flat-across");
  assert.equal(g.g2.flatSampleCount, 90);
  assert.equal(g.g2.measurableSampleCount, 0);
  assert.equal(g.g2.interiorRelMaxMeasured, null);
  assert.ok(Math.abs(g.g2.interiorAbsDifferenceMaxPerMm - 8.22e-4) < 1e-12);
  assert.equal(g.effectiveInteriorClass, "G2");
  assert.equal(g.g2NotMeasurable, true);
  assert.equal(g.note, "G2 not measurable (flat across)");
  // The old rule calls it G1 (relative 0.96): unchanged.
  assert.equal(continuitySampleSummary(s, nativeOf(s), TOL).interiorClass, "G1");
});

test("partly flat: some interior samples flat, the rest decided by the relative test", () => {
  const s = samples((i) => (i < 50 ? 1e-5 : 0.1), (i) => (i < 50 ? 5e-4 : 0.1004));
  const g = gate(s);
  assert.equal(g.g2.status, "partly-flat");
  assert.equal(g.g2.flatSampleCount, 45);
  assert.equal(g.g2.measurableSampleCount, 45);
  assert.ok(g.g2.interiorRelMaxMeasured! < 0.01);
  assert.equal(g.effectiveInteriorClass, "G2");
  assert.equal(g.g2NotMeasurable, false);
  assert.equal(g.note, undefined);
  // A partly flat edge with one real mismatch in the run fails G2.
  const bad = gate(samples((i) => (i === 40 ? 0.077 : i < 50 ? 1e-5 : 0.1), (i) => (i === 40 ? 0.0019 : i < 50 ? 5e-4 : 0.1004)));
  assert.equal(bad.g2.status, "partly-flat");
  assert.equal(bad.g2.failingSampleCount, 1);
  assert.equal(bad.effectiveInteriorClass, "G1");
});

test("measured: the real flank/side mismatch, R5 against R10 and plane against R5 all stay G2 failures", () => {
  for (const [k1, k2] of [[0.077, 0.0019], [0.2, 0.1], [0, 0.2]] as const) {
    const g = gate(samples(k1, k2));
    assert.equal(g.g2.status, "measured", `${k1}/${k2}`);
    assert.equal(g.effectiveInteriorClass, "G1", `${k1}/${k2}`);
    assert.equal(g.effectiveClass, "G1", `${k1}/${k2}`);
  }
  const flank = gate(samples(0.077, 0.0019));
  assert.ok(Math.abs(flank.g2.interiorRelMaxMeasured! - (0.077 - 0.0019) / (0.077 + 0.0019)) < 1e-12);
  assert.ok(Math.abs(flank.g2.interiorAbsDifferenceMaxPerMm - 0.0751) < 1e-12);
});

test("effectiveClass counts the native G2 maximum by the mixed rule; without curvatures there, by its relative value", () => {
  assert.equal(gate(samples(1e-5, 5e-4)).effectiveClass, "G2");
  const unread = samples(1e-5, 5e-4, { nativeK: null });
  assert.deepEqual([gate(unread).effectiveClass, gate(unread).effectiveInteriorClass], ["G1", "G2"]);
});

test("near-threshold pairs 0.0009/0.0001 and 0.0011/0.0001 both pass G2 (no cliff)", () => {
  for (const k1 of [0.0009, 0.0011]) {
    const g = gate(samples(k1, 0.0001));
    assert.equal(g.effectiveInteriorClass, "G2", String(k1));
    assert.equal(g.effectiveClass, "G2", String(k1));
    assert.equal(g.g2.status, "flat-across", String(k1));
  }
});

test("G0 and G1 are judged on all samples in both effective classes: a corner-only 0.3 degree deviation fails G1 at 0.1", () => {
  const s = samples(0.1, 0.1, { g1Deg: (i) => (i === 2 ? 0.3 : 0.01) });
  const g = gate(s);
  assert.equal(g.effectiveClass, "G0");
  assert.equal(g.effectiveInteriorClass, "G0");
  assert.equal(g.effectiveMaxima.g1Deg, 0.3);
  // The existing interiorClass leaves the corner out (unchanged meaning).
  assert.equal(continuitySampleSummary(s, nativeOf(s), TOL).interiorClass, "G2");
  // A corner G0 gap too.
  assert.equal(gate(samples(0.1, 0.1, { g0Mm: (i) => (i === 98 ? 0.05 : 0) })).effectiveInteriorClass, "none");
  // G2 at a corner only: effectiveClass (all samples) fails, effectiveInteriorClass passes.
  const corner = gate(samples((i) => (i === 1 ? 0.2 : 0.1), 0.1));
  assert.deepEqual([corner.effectiveClass, corner.effectiveInteriorClass], ["G1", "G2"]);
});

test("sharp evidence: interior normal angle minimum and maximum come from samples 5..94", () => {
  const g = gate(samples(0, 0, { g1Deg: (i) => (i < 5 ? 0.2 : 30 + i / 10) }));
  assert.equal(g.normalAngleInteriorMinDeg, 30.5);
  assert.equal(g.normalAngleInteriorMaxDeg, 39.4);
});

test("native-maximum cross-check runs only when a native maximum fails while the samples at that level pass", () => {
  const s = samples(0.1, 0.1, { g1Deg: () => 0.058 });
  // G1 native 90 degrees mid-edge, samples 0.058: G1 is checked at tolerance 0.5.
  const tol = { ...TOL, normalAngleDeg: 0.5 };
  assert.deepEqual(nativeMaximumChecksNeeded(s, nativeOf(s, { g1Deg: 90, g1AtMm: [31, 19, 125] }), tol), [{ level: "G1", value: 90, atMm: [31, 19, 125] }]);
  // The samples fail too (tolerance 0.05): no check, the edge fails anyway.
  assert.deepEqual(nativeMaximumChecksNeeded(s, nativeOf(s, { g1Deg: 90 }), { ...TOL, normalAngleDeg: 0.05 }), []);
  // The native maximum passes: no check.
  assert.deepEqual(nativeMaximumChecksNeeded(s, nativeOf(s), tol), []);
  // G0: native gap with every sample on.
  assert.deepEqual(nativeMaximumChecksNeeded(s, nativeOf(s, { g0Mm: 5, g0AtMm: [1, 2, 3] }), tol).map((need) => need.level), ["G0"]);
  // Levels filter.
  assert.deepEqual(nativeMaximumChecksNeeded(s, nativeOf(s, { g0Mm: 5, g1Deg: 90 }), tol, ["G1"]).map((need) => need.level), ["G1"]);
  // G2: the native maximum is judged by the mixed rule with the curvatures read at its location.
  const flat = samples(1e-5, 5e-4, { nativeK: [1e-5, 6e-4] });
  assert.deepEqual(nativeMaximumChecksNeeded(flat, nativeOf(flat, { g2Rel: 1 }), TOL), [], "native relative 1 but flat at its location: no failure");
  const bump = samples(1e-5, 5e-4, { nativeK: [0.05, 0.001] });
  assert.deepEqual(nativeMaximumChecksNeeded(bump, nativeOf(bump, { g2Rel: 0.96 }), TOL).map((need) => need.level), ["G2"]);
  // Without the curvatures at the native location, its relative value decides.
  const noK = samples(0.1, 0.1, { nativeK: null });
  assert.deepEqual(nativeMaximumChecksNeeded(noK, nativeOf(noK, { g2Rel: 0.5 }), TOL).map((need) => need.level), ["G2"]);
  // G2 samples failing: no G2 check.
  const failing = samples(0.077, 0.0019, { nativeK: [0.077, 0.0019] });
  assert.deepEqual(nativeMaximumChecksNeeded(failing, nativeOf(failing), TOL), []);
});

function dense(g1: number[], extra: Partial<DenseContinuitySamples> = {}): DenseContinuitySamples {
  return { g0Mm: g1.map(() => 0), g1Deg: g1, side1PerMm: g1.map(() => 0.1), side2PerMm: g1.map(() => 0.1), pointsMm: g1.map((_, i) => [i, 1, 0] as Vector3), ...extra };
}

test("native-maximum cross-check decision: agrees only when the dense resample also fails the tolerance", () => {
  const tol = { ...TOL, normalAngleDeg: 0.5 };
  const need = { level: "G1" as const, value: 90, atMm: [31, 19, 125] as Vector3 };
  const quiet = nativeMaximumCheckOutcome(need, dense([0.01, 0.059, 0.03, null as unknown as number]), tol);
  assert.equal(quiet.agrees, false);
  assert.equal(quiet.dense.max, 0.059);
  assert.deepEqual(quiet.dense.atMm, [1, 1, 0]);
  assert.equal(quiet.dense.count, 3);
  assert.deepEqual(quiet.native, { value: 90, atMm: [31, 19, 125] });
  const real = nativeMaximumCheckOutcome(need, dense([0.01, 0.7, 0.03]), tol);
  assert.equal(real.agrees, true);
  assert.equal(real.dense.failingCount, 1);
  // Nothing read: the native maximum stands.
  assert.equal(nativeMaximumCheckOutcome(need, dense([]), tol).agrees, true);
  // G2 level: the mixed rule on the dense curvatures.
  const g2Need = { level: "G2" as const, value: 1, atMm: null };
  assert.equal(nativeMaximumCheckOutcome(g2Need, dense([0, 0], { side1PerMm: [1e-5, 2e-5], side2PerMm: [6e-4, 7e-4] }), TOL).agrees, false);
  const g2Real = nativeMaximumCheckOutcome(g2Need, dense([0, 0], { side1PerMm: [1e-5, 0.05], side2PerMm: [6e-4, 0.001] }), TOL);
  assert.equal(g2Real.agrees, true);
  assert.ok(Math.abs(g2Real.dense.max - 0.049 / 0.051) < 1e-12);
  // G0 level.
  assert.equal(nativeMaximumCheckOutcome({ level: "G0", value: 5, atMm: null }, dense([0], { g0Mm: [0.002] }), TOL).agrees, false);
});

test("effective classes use the dense maximum where the cross-check disagrees, and the native maximum where it agrees", () => {
  const tol = { ...TOL, normalAngleDeg: 0.5 };
  const s = samples(1e-5, 3e-4, { g1Deg: () => 0.058 });
  const native = nativeOf(s, { g1Deg: 90, g1AtMm: [31, 19, 125] });
  const need = nativeMaximumChecksNeeded(s, native, tol)[0]!;
  const disagree = nativeMaximumCheckOutcome(need, dense([0.059, 0.02]), tol);
  const agree = nativeMaximumCheckOutcome(need, dense([0.059, 0.9]), tol);
  const without = continuityGateSummary(s, native, tol);
  const withDisagree = continuityGateSummary(s, native, tol, [disagree]);
  const withAgree = continuityGateSummary(s, native, tol, [agree]);
  assert.equal(without.effectiveClass, "G0");
  assert.equal(withDisagree.effectiveClass, "G2");
  assert.equal(withDisagree.effectiveInteriorClass, "G2");
  assert.equal(withDisagree.effectiveMaxima.g1Deg, 0.059);
  assert.equal(withAgree.effectiveClass, "G0");
  assert.equal(withAgree.effectiveMaxima.g1Deg, 90);
  assert.deepEqual(withDisagree.nativeMaximumChecks, [disagree]);
});

test("withContinuitySummary adds the gate fields only when asked, keeps every earlier field, and drops the internal series", () => {
  const s = samples(1e-5, 3e-4, { g1Deg: () => 0.058, nativeK: [1e-5, 3e-4] });
  const row = { edge: { bodyId: 1, edgeId: "e" }, maximumPositionDeviationMm: 0, maximumNormalAngleDeviationDeg: 90, maximumRelativeCurvatureDeviation: 1, maximumNormalAngleDeviationAtMm: [3, 0, 0], samples: s, edgeEndsMm: [[0, 0, 0], [99, 0, 0]] };
  const old = withContinuitySummary(row, TOL);
  const extended = withContinuitySummary(row, TOL, false, { absoluteCurvaturePerMm: 0.001 }) as Record<string, unknown>;
  for (const key of Object.keys(old)) assert.deepEqual(extended[key], (old as Record<string, unknown>)[key], key);
  assert.equal("samples" in extended, false);
  assert.equal("effectiveContinuity" in old, false);
  assert.equal(extended.effectiveContinuity, "G0");
  assert.equal(extended.effectiveInteriorContinuity, "G0");
  assert.equal(extended.g2NotMeasurable, true);
  assert.equal((extended.g2 as { status: string }).status, "flat-across");
  assert.equal((extended.curvatureAcross as { flatSamples: number }).flatSamples, 100);
  const kept = withContinuitySummary(row, TOL, true, { absoluteCurvaturePerMm: 0.001 }) as Record<string, unknown>;
  assert.deepEqual((kept.samples as ContinuityGateSamples).curvatureAcross, s.curvatureAcross);
});

// ---------------------------------------------------------------- plan ----------------------------------------------------------------
const EDGES = [
  { edgeId: "band", faceIds: ["fBand", "fSide"], polylineMm: [[40, -10, 100], [42, -5.6, 101.8], [44, 0, 103]] as Vector3[] },
  { edgeId: "flank", faceIds: ["fSide", "fFlank"], polylineMm: [[44.3, -10, 29.28], [44.3, 0, 29.28]] as Vector3[] },
  { edgeId: "back", faceIds: ["fBand", "fBack"], polylineMm: [[0, 20, 120], [30, 20, 125]] as Vector3[] },
  { edgeId: "rim", faceIds: ["fBack", "fBottom"], polylineMm: [[0, 50, 0], [10, 50, 0]] as Vector3[] },
];

test("plan selectors: edgeIds, faceIds, throughPointMm, betweenPointsMm and rest", () => {
  const distances: Record<string, [number, number]> = { fBand: [0.1, 50], fBack: [60, 0.2], fSide: [9, 9], fFlank: [9, 9], fBottom: [9, 9] };
  const plan: ContinuityPlanItem[] = [
    { select: { throughPointMm: [42.0, -5.6, 101.9] }, target: "G2" },
    { select: { faceIds: ["fFlank", "fSide"] }, target: "G2" },
    { select: { betweenPointsMm: [[0, 0, 0], [1, 1, 1]] }, target: "G1" },
    { select: { rest: true }, target: "any" },
  ];
  const matches = matchContinuityPlan(plan, EDGES, { faceDistanceMm: (_item, point, faceId) => distances[faceId]![point] });
  assert.deepEqual(matches, [["band"], ["flank"], ["back"], ["rim"]]);
  // throughPointMm tolerance: 0.5 mm by default.
  assert.deepEqual(matchContinuityPlan([{ select: { throughPointMm: [42, -5.6, 102.5] }, target: "G2" }], EDGES), [[]]);
  assert.deepEqual(matchContinuityPlan([{ select: { throughPointMm: [42, -5.6, 102.5], toleranceMm: 1 }, target: "G2" }], EDGES), [["band"]]);
  // betweenPointsMm in either order of the points.
  assert.deepEqual(matchContinuityPlan([{ select: { betweenPointsMm: [[1, 1, 1], [0, 0, 0]] }, target: "G1" }], EDGES, { faceDistanceMm: (_item, point, faceId) => distances[faceId]![point === 0 ? 1 : 0] }), [["back"]]);
  assert.deepEqual(matchContinuityPlan([{ select: { edgeIds: ["rim", "band"] }, target: "G0" }], EDGES), [["rim", "band"]]);
});

test("plan matching errors: duplicate match, rest not last, two rests, unknown edge, seam edge", () => {
  assert.throws(() => matchContinuityPlan([{ select: { edgeIds: ["band"] }, target: "G2" }, { select: { faceIds: ["fBand", "fSide"] }, target: "G1" }], EDGES), /Edge band is matched by plan items #0 and #1/);
  assert.throws(() => matchContinuityPlan([{ select: { rest: true }, target: "any" }, { select: { edgeIds: ["band"] }, target: "G2" }], EDGES), /rest selector must be the last/);
  assert.throws(() => matchContinuityPlan([{ select: { rest: true }, target: "any" }, { select: { rest: true }, target: "any" }], EDGES), /rest/);
  assert.throws(() => matchContinuityPlan([{ select: { edgeIds: ["nope"] }, target: "G2" }], EDGES), /nope is not a current edge shared by two faces/);
  assert.throws(() => matchContinuityPlan([{ name: "seam", select: { edgeIds: ["s1"] }, target: "G2" }], EDGES, { seamEdgeIds: ["s1"] }), /Plan item seam: edge s1 is a seam/);
});

const flatAcross = gate(samples(1.8e-5, 8.4e-4));
const measuredG2 = gate(samples(0.1, 0.1003));
const flankG1 = gate(samples(0.077, 0.0019));
const crease = gate(samples(0, 0, { g1Deg: () => 90 }));
const softCrease = gate(samples(0, 0, { g1Deg: (i) => (i === 50 ? 0.5 : 30) }));

function evaluate(plan: ContinuityPlanItem[], gates: Record<string, ContinuityGateSummary>, matches?: string[][]) {
  const matched = matches ?? matchContinuityPlan(plan, EDGES);
  return evaluateContinuityPlan(plan, matched, (_item, edgeId) => gates[edgeId], { twoFaceEdgeIds: EDGES.map((edge) => edge.edgeId), seamEdgeIds: ["seam1"] });
}

test("plan targets: G2 measured, G2 flat across (allowed by default, refused with allowFlatAcross false), G1, G0, sharp, any", () => {
  const result = evaluate([
    { name: "band/side", select: { edgeIds: ["band"] }, target: "G2" },
    { name: "back", select: { edgeIds: ["back"] }, target: "G2" },
    { name: "flank/side", select: { edgeIds: ["flank"] }, target: "G1" },
    { name: "rim", select: { edgeIds: ["rim"] }, target: "sharp" },
  ], { band: flatAcross, back: measuredG2, flank: flankG1, rim: crease });
  assert.equal(result.pass, true);
  assert.equal(result.firstFailure, null);
  assert.equal(result.items[0]!.edges[0]!.achieved, "G2 (not measurable: flat across)");
  assert.equal(result.items[0]!.edges[0]!.g2Status, "flat-across");
  assert.equal(result.items[1]!.edges[0]!.achieved, "G2");
  assert.equal(result.items[2]!.edges[0]!.achieved, "G1");
  assert.equal(result.items[3]!.edges[0]!.achieved, "sharp");
  assert.equal(result.unmatchedTwoFaceEdges, 0);
  assert.deepEqual(result.seamEdgesNotChecked, { count: 1, edgeIds: ["seam1"] });

  const strict = evaluate([{ name: "band/side", select: { edgeIds: ["band"] }, target: "G2", allowFlatAcross: false }], { band: flatAcross });
  assert.equal(strict.pass, false);
  assert.equal(strict.firstFailure!.achieved, "G2 (not measurable: flat across)");
  assert.match(strict.firstFailure!.reason, /allowFlatAcross is false/);
  assert.equal(strict.unmatchedTwoFaceEdges, 3);

  // A real mismatch fails a G2 target, with the numbers in the reason.
  const g2 = evaluate([{ name: "flank/side", select: { edgeIds: ["flank"] }, target: "G2" }], { flank: flankG1 });
  assert.equal(g2.pass, false);
  assert.equal(g2.firstFailure!.achieved, "G1");
  assert.match(g2.firstFailure!.reason, /interior samples fail G2: relative mismatch up to 0\.952 > 0\.05 and \|k1 - k2\| up to 0\.0751 \/mm > 0\.001 \/mm/);
  // G1 passes on G1 or G2, not on G0; G0 passes on G0, not on a gap.
  assert.equal(evaluate([{ select: { edgeIds: ["rim"] }, target: "G1" }], { rim: crease }).items[0]!.pass, false);
  assert.equal(evaluate([{ select: { edgeIds: ["rim"] }, target: "G0" }], { rim: crease }).items[0]!.pass, true);
  assert.equal(evaluate([{ select: { edgeIds: ["rim"] }, target: "G0" }], { rim: gate(samples(0, 0, { g0Mm: () => 0.5 })) }).items[0]!.pass, false);
  // sharp needs the interior minimum at least 1 degree: one 0.5 degree sample fails it; a smooth edge fails it.
  assert.equal(evaluate([{ select: { edgeIds: ["rim"] }, target: "sharp" }], { rim: softCrease }).items[0]!.pass, false);
  assert.equal(evaluate([{ select: { edgeIds: ["back"] }, target: "sharp" }], { back: measuredG2 }).items[0]!.edges[0]!.achieved, "G2");
  // any always passes, measured or not.
  const any = evaluate([{ select: { rest: true }, target: "any" }], {});
  assert.equal(any.pass, true);
  assert.equal(any.items[0]!.matched, 4);
});

test("plan per-item tolerances override the defaults; region all uses effectiveClass", () => {
  const item: ContinuityPlanItem = { select: { edgeIds: ["band"] }, target: "G1", normalAngleToleranceDeg: 0.5 };
  assert.deepEqual(planItemTolerances(item, { relativeCurvatureTolerance: 0.1 }), { positionMm: 0.01, normalAngleDeg: 0.5, relativeCurvature: 0.1, absoluteCurvaturePerMm: 0.001 });
  assert.deepEqual(planItemTolerances({ select: { rest: true }, target: "any" }, { absoluteCurvatureTolerancePerMm: 0.002 }).absoluteCurvaturePerMm, 0.002);
  assert.deepEqual(planItemCheckLevels({ select: { rest: true }, target: "G2" }), ["G0", "G1"]);
  assert.deepEqual(planItemCheckLevels({ select: { rest: true }, target: "G2", region: "all" }), ["G0", "G1", "G2"]);
  assert.deepEqual(planItemCheckLevels({ select: { rest: true }, target: "any" }), []);
  const corner = gate(samples((i) => (i === 1 ? 0.2 : 0.1), 0.1));
  assert.equal(evaluate([{ select: { edgeIds: ["back"] }, target: "G2" }], { back: corner }).pass, true);
  const all = evaluate([{ select: { edgeIds: ["back"] }, target: "G2", region: "all" }], { back: corner });
  assert.equal(all.pass, false);
  assert.match(all.firstFailure!.reason, /edge ends or at the native G2 maximum/);
});

test("plan expectCount, empty selectors and first-failure order", () => {
  const plan: ContinuityPlanItem[] = [
    { name: "band/side", select: { edgeIds: ["band"] }, target: "G2" },
    { name: "flank/side", select: { faceIds: ["fSide", "fFlank"] }, target: "G2", expectCount: 1 },
    { name: "back", select: { edgeIds: ["back"] }, target: "sharp" },
    { name: "rest", select: { rest: true }, target: "any" },
  ];
  const result = evaluate(plan, { band: flatAcross, flank: flankG1, back: measuredG2 });
  assert.equal(result.pass, false);
  assert.deepEqual([result.items.map((item) => item.pass)], [[true, false, false, true]]);
  assert.equal(result.firstFailure!.item, "flank/side");
  assert.equal(result.firstFailure!.itemIndex, 1);
  assert.equal(result.firstFailure!.edgeId, "flank");
  assert.equal(result.firstFailure!.target, "G2");
  // expectCount mismatch (topology drift) fails the item before its edges.
  const drift = evaluate([{ name: "two", select: { faceIds: ["fSide", "fFlank"] }, target: "G2", expectCount: 2 }], { flank: measuredG2 });
  assert.equal(drift.pass, false);
  assert.equal(drift.items[0]!.reason, "expected 2 edges, matched 1");
  assert.deepEqual([drift.firstFailure!.edgeId, drift.firstFailure!.achieved], [null, null]);
  // A selector that matches nothing fails unless expectCount is 0.
  const none = evaluate([{ select: { throughPointMm: [999, 0, 0] }, target: "G2" }], {});
  assert.equal(none.pass, false);
  assert.match(none.firstFailure!.reason, /matched no edge/);
  assert.equal(evaluate([{ select: { throughPointMm: [999, 0, 0] }, target: "G2", expectCount: 0 }], {}).pass, true);
  // The assert-mode message starts with the fixed prefix and names the first failure.
  const message = continuityPlanFailureMessage(result);
  assert.ok(message.startsWith("Continuity plan failed: item flank/side, edge flank, target G2, achieved G1: "), message);
});

test("C2: curvatureRangeSlice keeps [t0, t1] of the arc length with values interpolated at both ends", () => {
  // 11 samples 1 mm apart on a line, magnitude = position.
  const positions = Array.from({ length: 11 }, (_, i) => [i, 0, 0] as Vector3);
  const magnitudes = positions.map((p) => p[0] / 10);
  assert.deepEqual(curvatureRangeSlice(positions, magnitudes, [0, 1]), magnitudes);
  const middle = curvatureRangeSlice(positions, magnitudes, [0.25, 0.55]);
  assert.ok(Math.abs(middle[0]! - 0.25) < 1e-12 && Math.abs(middle[middle.length - 1]! - 0.55) < 1e-12);
  assert.deepEqual(middle.slice(1, -1), [0.3, 0.4, 0.5]);
  // Arc length, not sample index: uneven spacing.
  const uneven: Vector3[] = [[0, 0, 0], [1, 0, 0], [9, 0, 0], [10, 0, 0]];
  assert.deepEqual(curvatureRangeSlice(uneven, [0, 1, 2, 3], [0.05, 0.95]).map((value) => Number(value.toFixed(9))), [0.5, 1, 2, 2.5]);
  for (const bad of [[0.5, 0.5], [-0.1, 0.5], [0.2, 1.1], [0.6, 0.4]] as Array<[number, number]>) assert.throws(() => curvatureRangeSlice(positions, magnitudes, bad), /curvatureRange must be/);
});

// ---------------------------------------------------------------- review follow-ups ----------------------------------------------------------------
test("follow-up 1: on a resampled row the samples are the measurement, so effectiveClass has no native G2 term", () => {
  // The reviewer's case: 100 samples 1.8e-5 vs 8.4e-4 /mm, relative 0.958, no curvature at a native location.
  const s = samples(1.8e-5, 8.4e-4, { g2Rel: () => 0.958, nativeK: null });
  delete (s as { nativeG2CurvaturePerMm?: unknown }).nativeG2CurvaturePerMm;
  const native = { g0Mm: 0, g1Deg: 0, g2Rel: 0.958 };
  // Without the flag the relative maximum stands in for the native G2 term: G1 although every sample passes.
  assert.equal(continuityGateSummary(s, native, TOL).effectiveClass, "G1");
  const resampled = continuityGateSummary(s, native, TOL, [], { samplesAreMeasurement: true });
  assert.equal(resampled.effectiveClass, "G2");
  assert.equal(resampled.effectiveInteriorClass, "G2");
  assert.equal(resampled.g2.status, "flat-across");
  // withContinuitySummary sets the flag from measurementSource.
  const row = { measurementSource: "resampled", maximumPositionDeviationMm: 0, maximumNormalAngleDeviationDeg: 0, maximumRelativeCurvatureDeviation: 0.958, samples: s };
  const summarized = withContinuitySummary(row, TOL, false, { absoluteCurvaturePerMm: 0.001 }) as Record<string, unknown>;
  assert.equal(summarized.effectiveContinuity, "G2");
  assert.equal(summarized.g2NotMeasurable, true);
  // A real mismatch on a resampled row still fails.
  const bad = samples(0.077, 0.0019, { nativeK: null });
  assert.equal(continuityGateSummary(bad, nativeOf(bad), TOL, [], { samplesAreMeasurement: true }).effectiveClass, "G1");
});

test("follow-up 3: without the +-2 mm window (no location, or a read error) agrees false never overrides the native maximum", () => {
  const tol = { ...TOL, normalAngleDeg: 0.5 };
  const s = samples(1e-5, 3e-4, { g1Deg: () => 0.058 });
  const native = nativeOf(s, { g1Deg: 90, g1AtMm: [31, 19, 125] });
  const need = nativeMaximumChecksNeeded(s, native, tol)[0]!;
  const quiet = dense([0.059, 0.02]);
  const ok = nativeMaximumCheckOutcome(need, quiet, tol);
  assert.deepEqual([ok.agrees, ok.overrides, ok.localWindowMissing, ok.error], [false, true, undefined, undefined]);
  const failed = nativeMaximumCheckOutcome(need, quiet, tol, { error: "window read failed" });
  assert.deepEqual([failed.agrees, failed.overrides, failed.error], [false, false, "window read failed"]);
  const noLocation = nativeMaximumCheckOutcome({ ...need, atMm: null }, quiet, tol);
  assert.deepEqual([noLocation.agrees, noLocation.overrides, noLocation.localWindowMissing], [false, false, true]);
  assert.equal(nativeMaximumCheckOutcome(need, quiet, tol, { missing: true }).overrides, false);
  // The native 90 degrees stands in the effective classes when the check cannot override.
  assert.equal(continuityGateSummary(s, native, tol, [ok]).effectiveClass, "G2");
  for (const check of [failed, noLocation]) {
    const g = continuityGateSummary(s, native, tol, [check]);
    assert.equal(g.effectiveClass, "G0");
    assert.equal(g.effectiveMaxima.g1Deg, 90);
  }
});

test("follow-up 2: the face parameter clamp moves a parameter just outside the face's parameter bounds onto them, and nothing else", () => {
  // The Face API's parameters are normalized over face.GetSurface() uMin..uMax / vMin..vMax (live: raw = uMin + u (uMax - uMin)).
  const make = (0, eval)(FACE_PARAMETER_CLAMP_SOURCE) as (face: unknown) => (u: number, v: number) => [number, number];
  const face = (bounds: Record<string, number>) => ({ GetSurface: () => bounds });
  const clamp = make(face({ uMin: -14.547, uMax: -0.023, vMin: 0, vMax: 4 }));
  // Inside: unchanged, exactly.
  assert.deepEqual(clamp(0.3, 0.999), [0.3, 0.999]);
  assert.deepEqual(clamp(0, 1), [0, 1]);
  // Within 1e-3 of the range outside: onto the bound (u -9e-6 and -3.7e-4 were live cases).
  assert.deepEqual(clamp(-9e-6, 1 + 5e-5), [0, 1]);
  assert.deepEqual(clamp(-3.7e-4, 1 + 9e-4), [0, 1]);
  // Farther out than 1e-3 of the range: unchanged (not a boundary rounding).
  assert.deepEqual(clamp(-0.005, 1.01), [-0.005, 1.01]);
  // Bounds unreadable or degenerate: unchanged.
  assert.deepEqual(make(face({ uMin: Number.NaN, uMax: 1, vMin: 0, vMax: 1 }))(-9e-6, 0.5), [-9e-6, 0.5]);
  assert.deepEqual(make({ GetSurface: () => { throw new Error("no surface"); } })(-9e-6, 0.5), [-9e-6, 0.5]);
  assert.deepEqual(make(face({ uMin: 0, uMax: 0, vMin: 0, vMax: 1 }))(-9e-6, 0.5), [-9e-6, 0.5]);
  // Every continuity EvalBasis read goes through it: the shared evaluator, the resample block and the absolute-curvature read.
  assert.match(CROSS_EDGE_EVALUATOR_SOURCE, /face\.EvalBasis\(\.\.\.clamps\[k\]\(near\.u, near\.v\)\)/);
  assert.doesNotMatch(CROSS_EDGE_EVALUATOR_SOURCE, /EvalBasis\(near\.u, near\.v\)/);
  const source = readFileSync(new URL("./operations.ts", import.meta.url), "utf8");
  const calls = source.match(/EvalBasis\([^;]*;/g) ?? [];
  assert.equal(calls.length, 3, calls.join("\n"));
  assert.ok(calls.every((call) => /clamps\[k\]|clampsAB\[k\]|FACE_PARAMETER_CLAMP_SOURCE/.test(call)), calls.join("\n"));
});

test("follow-up 3 wiring: nativeMaximumChecks reads each need's +-2 mm window from the dense read (error, empty, good)", async () => {
  const tol = { ...TOL, normalAngleDeg: 0.5 };
  const at: Vector3 = [31, 19, 125];
  const row = (edgeId: string) => ({
    edge: { bodyId: 317, edgeId }, adjacentFaces: [{ faceId: "fa" }, { faceId: "fb" }], bodyVersionId: 9,
    maximumPositionDeviationMm: 0, maximumNormalAngleDeviationDeg: 90, maximumRelativeCurvatureDeviation: 1, maximumNormalAngleDeviationAtMm: at,
    samples: samples(1e-5, 3e-4, { g1Deg: () => 0.058 }),
  });
  const series = (edgeId: string, local: unknown[], windowPoints: Array<Vector3 | null>) => ({
    edgeId, g0Mm: [0, 0, ...windowPoints.map(() => 0)], g1Deg: [0.05, 0.02, ...windowPoints.map((p) => (p ? 0.03 : null))],
    side1PerMm: [0, 0, ...windowPoints.map(() => 0)], side2PerMm: [0, 0, ...windowPoints.map(() => 0)], pointsMm: [[0, 0, 0], [1, 0, 0], ...windowPoints], local,
  });
  let sent: any;
  const runtime = { async readNative(_source: string, _bindings: string[], values: unknown[]) {
    sent = values[0];
    return [
      series("e-error", [{ atMm: at, error: "kernel refused" }], []),
      series("e-empty", [{ atMm: at, startIndex: 2, count: 2 }], [null, null]),
      series("e-good", [{ atMm: at, startIndex: 2, count: 2 }], [[30, 19, 125], [31, 19, 125]]),
    ];
  } } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime);
  const out = await operations.nativeMaximumChecks(["e-error", "e-empty", "e-good"].map((edgeId) => ({ row: row(edgeId), tolerances: tol })));
  assert.deepEqual(sent.edges.map((edge: { locationsMm: Vector3[] }) => edge.locationsMm), [[at], [at], [at]]);
  const [error, empty, good] = out.map((entry) => entry.checks[0]!);
  assert.deepEqual([error!.agrees, error!.overrides], [false, false]);
  assert.match(error!.error!, /could not be read: kernel refused/);
  assert.deepEqual([empty!.agrees, empty!.overrides], [false, false]);
  assert.match(empty!.error!, /read no points/);
  assert.deepEqual([good!.agrees, good!.overrides, good!.error], [false, true, undefined]);
});
