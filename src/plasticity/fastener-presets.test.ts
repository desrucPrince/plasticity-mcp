import assert from "node:assert/strict";
import { test } from "node:test";

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
