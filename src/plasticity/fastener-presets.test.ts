import assert from "node:assert/strict";
import { test } from "node:test";

import * as presetsModule from "./fastener-presets.ts";
import {
  CLEARANCE_HOLE_SOURCE,
  COUNTERSUNK_HEAD_NOTE,
  COUNTERSUNK_HEAD_SOURCE,
  HEAT_SET_INSERT_NOTE,
  HEAT_SET_INSERT_SOURCE,
  UnsourcedFastenerValueError,
  clearanceHole,
  countersunkHead,
  fastenerPresetTable,
  heatSetInsert,
  requirePilotDiameter,
} from "./fastener-presets.ts";

// The follow-up exports are read through the module namespace, so that against an older presets file each test that
// needs them fails on its own instead of the whole file failing to load.
const { STOCK_SCREW_LENGTHS_MM, STOCK_SCREW_LENGTH_NOTE, TAP_DRILL_NOTE, TAP_DRILL_SOURCE, chooseStockScrewLength, shortestStockScrewLength, tapDrill } = presetsModule as unknown as {
  STOCK_SCREW_LENGTHS_MM: readonly number[];
  STOCK_SCREW_LENGTH_NOTE: string;
  TAP_DRILL_NOTE: string;
  TAP_DRILL_SOURCE: string;
  chooseStockScrewLength: (throughMm: number, holeDepthMm: number, rule: { minEngagementMm: number; minTipClearanceMm: number }) => { lengthMm: number; maxLengthMm: number; engagementMm: number } | undefined;
  shortestStockScrewLength: (throughMm: number, engagementMm: number) => number | undefined;
  tapDrill: (screw: "M2" | "M2.5" | "M3") => { screw: string; nominalDiameterMm: number; pitchMm: number; diameterMm: number; source: string; confidence: string; note: string };
};

test("clearance holes are the ISO 273 close / medium / free values with their source", () => {
  const expected = { "M2": [2.2, 2.4, 2.6], "M2.5": [2.7, 2.9, 3.1], "M3": [3.2, 3.4, 3.6] } as const;
  for (const [screw, values] of Object.entries(expected)) {
    for (const [index, fit] of (["close", "medium", "free"] as const).entries()) {
      const hole = clearanceHole(screw as "M2" | "M2.5" | "M3", fit);
      assert.equal(hole.diameterMm, values[index]);
      assert.equal(hole.fit, fit);
      assert.equal(hole.source, CLEARANCE_HOLE_SOURCE);
      assert.equal(hole.confidence, "medium");
    }
  }
  assert.equal(clearanceHole("M3").fit, "medium");
  assert.match(CLEARANCE_HOLE_SOURCE, /ISO 273.*amesweb\.info\/screws\/Metric-Clearance-Hole-Chart\.aspx.*fmcarbide\.com\/pages\/clearance-hole-chart/);
});

test("heat-set insert pockets are the CNC Kitchen values; the blind hole is insert length + 1 mm", () => {
  assert.deepEqual(heatSetInsert("M2"), { screw: "M2", insert: "M2x3", insertLengthMm: 3, holeDiameterMm: 3.2, minWallMm: 1.3, blindHoleDepthMm: 4, source: HEAT_SET_INSERT_SOURCE, confidence: "medium" });
  assert.deepEqual(heatSetInsert("M2.5"), { screw: "M2.5", insert: "M2.5x4", insertLengthMm: 4, holeDiameterMm: 4, minWallMm: 1.6, blindHoleDepthMm: 5, source: HEAT_SET_INSERT_SOURCE, confidence: "medium" });
  assert.deepEqual(heatSetInsert("M3", 5.7), { screw: "M3", insert: "M3x5.7", insertLengthMm: 5.7, holeDiameterMm: 4, minWallMm: 1.6, blindHoleDepthMm: 6.7, source: HEAT_SET_INSERT_SOURCE, confidence: "medium" });
  assert.deepEqual(heatSetInsert("M3", 3), { screw: "M3", insert: "M3x3", insertLengthMm: 3, holeDiameterMm: 4, minWallMm: 1.6, blindHoleDepthMm: 4, source: HEAT_SET_INSERT_SOURCE, confidence: "medium" });
  assert.match(HEAT_SET_INSERT_SOURCE, /CNC Kitchen.*cnckitchen\.com\/s\/CNCKitchen_Heat-Set-Insert-Dimensions-and-Design-Guidelines\.pdf/);
});

test("an ambiguous or unknown insert is refused, never guessed", () => {
  assert.throws(() => heatSetInsert("M3"), (error: unknown) => error instanceof UnsourcedFastenerValueError && /pass insertLengthMm 5\.7 or 3/.test(error.message));
  assert.throws(() => heatSetInsert("M3", 4), /No sourced CNC Kitchen M3 insert 4 mm long/);
  assert.throws(() => heatSetInsert("M2", 4), /No sourced CNC Kitchen M2 insert 4 mm long/);
});

test("the ISO 10642 countersunk head is sourced for M3 only; M2 and M2.5 are refused as not sourced", () => {
  assert.deepEqual(countersunkHead("M3"), { screw: "M3", headDiameterMaxMm: 6.72, includedAngleDeg: 90, source: COUNTERSUNK_HEAD_SOURCE, confidence: "medium" });
  assert.match(COUNTERSUNK_HEAD_SOURCE, /ISO 10642.*engineersedge\.com\/hardware\/bs_en_iso_10642_14583\.htm/);
  for (const screw of ["M2", "M2.5"] as const) {
    assert.throws(() => countersunkHead(screw), (error: unknown) => error instanceof UnsourcedFastenerValueError && /not sourced/.test(error.message) && /headDiameterMm/.test(error.message));
  }
});

test("a self-tapping pilot diameter is never defaulted", () => {
  assert.throws(() => requirePilotDiameter("M3", undefined, "standoffs.fastener"), (error: unknown) => error instanceof UnsourcedFastenerValueError && /standoffs\.fastener: .*not sourced; pass pilotDiameterMm/.test(error.message));
  assert.equal(requirePilotDiameter("M3", 2.5, "lid"), 2.5);
});

test("the preset table carries a source and confidence for every value and lists what is not sourced", () => {
  const table = fastenerPresetTable();
  for (const group of [table.clearanceHoles, table.heatSetInserts, table.countersunkHeads]) {
    assert.ok(group.source.length > 20);
    assert.equal(group.confidence, "medium");
    assert.ok(group.rows.length > 0);
    for (const row of group.rows) for (const value of Object.values(row)) assert.ok(typeof value === "string" || (typeof value === "number" && value > 0));
  }
  assert.equal(table.clearanceHoles.rows.length, 3);
  assert.equal(table.heatSetInserts.rows.length, 4);
  assert.deepEqual(table.countersunkHeads.rows, [{ screw: "M3", headDiameterMaxMm: 6.72, includedAngleDeg: 90 }]);
  assert.deepEqual(table.notSourced.map((entry) => entry.value), ["M2 countersunk head diameter", "M2.5 countersunk head diameter", "self-tapping pilot diameter for plastic"]);
  const m3 = fastenerPresetTable("M3");
  assert.deepEqual(m3.clearanceHoles.rows, [{ screw: "M3", closeMm: 3.2, mediumMm: 3.4, freeMm: 3.6 }]);
  assert.deepEqual(m3.heatSetInserts.rows.map((row) => row.insert), ["M3x5.7", "M3x3"]);
  assert.deepEqual(m3.notSourced.map((entry) => entry.value), ["self-tapping pilot diameter for plastic"]);
});

test("I: the sources say what they are: the ISO 273 pattern as two pages cite it, 6.72 as the theoretical sharp-corner head, two of the three M3 inserts", () => {
  assert.doesNotMatch(CLEARANCE_HOLE_SOURCE, /independent/);
  assert.match(CLEARANCE_HOLE_SOURCE, /following the ISO 273 pattern as cited by two chart pages, not the standard itself/);
  const table = fastenerPresetTable();
  assert.equal(table.countersunkHeads.note, COUNTERSUNK_HEAD_NOTE);
  assert.match(COUNTERSUNK_HEAD_NOTE, /^6\.72 mm is the theoretical sharp-corner head diameter/);
  assert.equal(table.heatSetInserts.note, HEAT_SET_INSERT_NOTE);
  assert.match(HEAT_SET_INSERT_NOTE, /three M3 inserts; this table holds two of them \(M3 x 5\.7 and M3 x 3\)\. M3 x 5 x 4 VORON \(length 4, hole 4\.4\) is not in the table/);
  // The third M3 insert is refused as not sourced, not guessed.
  assert.throws(() => heatSetInsert("M3", 4), /No sourced CNC Kitchen M3 insert 4 mm long; sourced lengths: 5\.7 or 3/);
});

// ------------------------------------------------------------------------------------------- follow-up F1
test("F1: the stocked screw lengths are the common M2 / M2.5 / M3 series, noted as not a cited standard", () => {
  assert.deepEqual([...STOCK_SCREW_LENGTHS_MM], [3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 30, 35, 40]);
  assert.match(STOCK_SCREW_LENGTH_NOTE, /^Commonly stocked lengths of M2, M2\.5 and M3 machine screws \(3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 30, 35, 40 mm\): the commonly stocked series, not a cited standard\.$/);
  const table = fastenerPresetTable();
  assert.deepEqual(table.screwLengths, { lengthsMm: [3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 30, 35, 40], note: STOCK_SCREW_LENGTH_NOTE });
  assert.deepEqual(fastenerPresetTable("M3").screwLengths, table.screwLengths);
});

test("F1: a table of fastener stacks gives the longest stocked length with 2 mm engagement and 1 mm tip clearance, or none", () => {
  const rule = { minEngagementMm: 2, minTipClearanceMm: 1 };
  // [length the screw passes before the standoff hole, hole depth] -> [length, bottoming length, engagement].
  const stacks: Array<[number, number, [number, number, number] | undefined]> = [
    [8.1, 5, [12, 13.1, 3.9]],    // 10.1 to 12.1
    [9.1, 6, [14, 15.1, 4.9]],    // 11.1 to 14.1: 14 (the old 2 mm / 4 mm steps had 12, then 16)
    [12.1, 6, [16, 18.1, 3.9]],   // 14.1 to 17.1
    [14.1, 6, [18, 20.1, 3.9]],   // 16.1 to 19.1: 18 (the old steps had 16, then 20: refused)
    [14.1, 6.9, [20, 21, 5.9]],   // 16.1 to 20: exactly 1 mm short of the bottom
    [16.1, 7, [22, 23.1, 5.9]],   // 18.1 to 22.1: 22 (the old steps had 20, then 24)
    [18.1, 8, [25, 26.1, 6.9]],   // 20.1 to 25.1: 25
    [22.1, 9, [30, 31.1, 7.9]],   // 24.1 to 30.1: 30
    [1, 3, [3, 4, 2]],            // 3 to 3: exactly 2 mm in and 1 mm short
    [38, 3, [40, 41, 2]],         // the longest stocked length
    [0.5, 3, undefined],          // 2.5 to 2.5: nothing under 3 mm is stocked
    [14.1, 4, undefined],         // 16.1 to 17.1 (an M3 x 3 insert pocket): between 16 and 18
    [14.1, 3, undefined],         // 16.1 to 16.1
    [28.1, 5, undefined],         // 30.1 to 32.1: between 30 and 35
    [38.1, 6, undefined],         // 40.1 to 43.1: past the longest stocked length
    [14.1, 2.9, undefined],       // a hole too shallow for 2 mm in and 1 mm short
  ];
  for (const [through, depth, expected] of stacks) {
    const choice = chooseStockScrewLength(through, depth, rule);
    assert.deepEqual(choice ? [choice.lengthMm, choice.maxLengthMm, choice.engagementMm] : undefined, expected, `through ${through}, hole ${depth}`);
    if (choice) {
      // The two conditions hold, and the next stocked length breaks one of them.
      assert.ok(choice.lengthMm - through >= 2 - 1e-9 && through + depth - choice.lengthMm >= 1 - 1e-9, `through ${through}, hole ${depth}`);
      const next = STOCK_SCREW_LENGTHS_MM[STOCK_SCREW_LENGTHS_MM.indexOf(choice.lengthMm) + 1];
      if (next !== undefined) assert.ok(through + depth - next < 1 - 1e-9, `through ${through}, hole ${depth}: ${next} would bottom`);
    }
  }
  // The shortest stocked length that reaches a given engagement (the pilot-depth default and the refusal's fix use it).
  assert.deepEqual([shortestStockScrewLength(14.1, 2), shortestStockScrewLength(14.1, 5), shortestStockScrewLength(28.1, 2), shortestStockScrewLength(39, 2)], [18, 20, 35, undefined]);
});

test("the tapping drills are nominal diameter - coarse pitch, marked low confidence and not a sourced pilot", () => {
  assert.deepEqual([tapDrill("M2").diameterMm, tapDrill("M2.5").diameterMm, tapDrill("M3").diameterMm], [1.6, 2.05, 2.5]);
  assert.deepEqual(tapDrill("M2.5"), { screw: "M2.5", nominalDiameterMm: 2.5, pitchMm: 0.45, diameterMm: 2.05, source: TAP_DRILL_SOURCE, confidence: "low", note: TAP_DRILL_NOTE });
  assert.match(TAP_DRILL_NOTE, /starting value, not a sourced pilot/);
  const table = fastenerPresetTable("M2.5");
  assert.deepEqual(table.tapDrills, { source: TAP_DRILL_SOURCE, confidence: "low", note: TAP_DRILL_NOTE, rows: [{ screw: "M2.5", nominalDiameterMm: 2.5, pitchMm: 0.45, diameterMm: 2.05 }] });
  // A caller-named screw still has no sourced pilot: the not-sourced list is unchanged.
  assert.throws(() => requirePilotDiameter("M2.5", undefined, "lid.fasteners"), UnsourcedFastenerValueError);
});
