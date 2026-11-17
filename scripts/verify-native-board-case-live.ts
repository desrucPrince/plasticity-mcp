#!/usr/bin/env node
// Live acceptance for plasticity_create_board_case. Builds the board cases on an isolated Plasticity and checks every
// `derived` field against INDEPENDENT reads (find_faces / find_edges with limit 1000, validate_bodies,
// check_interference, parallel planar face clearance; never describe_body), including the read-back the recipe itself
// reports (base bounds = outerMm, lid bounds = lidMm, closed and valid, no edge under 0.05 mm). Each case with a board
// stand-in also lifts the board straight up in 3 mm steps until it clears the wall top and checks base-board interference
// at every step: derived.assembly.boardDropIn must equal "no interference at any step". After each case one batched undo
// of the measured undoSteps must restore the document. The "rejects" case sends the reviewer's bad inputs, each of which
// must be refused with the Undo depth, the body count and the revision unchanged (the former forced native failure, a
// 1e-6 mm board, is now refused in the plan and sits in that list). Every built case also gets the R4 web probes; the pod
// and the stack case get the diagonal corner-gap shift. The script refuses to run without PLASTICITY_CDP_URL on 127.0.0.1
// and restores the baseline in finally.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOL = 1e-3;
const LONG = { timeout: 900_000, resetTimeoutOnProgress: true };

type V3 = [number, number, number];
type V2 = [number, number];
type Bounds = { min: V3; max: V3 };
type Face = { id: string; bodyId: number; surfaceType: string; planar: boolean; normal: V3; radiusMm: number | null; axisOriginMm: V3 | null; axisDirection: V3 | null; boundsMm: Bounds; centerMm: V3; coneSemiAngleRad?: number };
type Edge = { id: string; bodyId: number; curveType: string; circle: boolean; boundsMm: Bounds; centerMm: V3; circleGeometry?: { centerMm: V3; radiusMm: number; normal: V3 } };

export const BOARD_CASES = ["benchmark", "benchmark-tapered", "benchmark-hanging", "audit", "pod", "lip-notch", "openings", "corner-holes", "stack", "inserts", "rejects"] as const;
type CaseName = typeof BOARD_CASES[number];

interface Options { help: boolean; target?: string; output?: string; allowDisposableMutations: boolean; cases: CaseName[] }

export function parseBoardCaseAcceptanceArgs(argv: string[]): Options {
  const options: Options = { help: argv.length === 0, allowDisposableMutations: false, cases: [...BOARD_CASES] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target" || argument === "--output" || argument === "--case") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--target") options.target = value;
      else if (argument === "--output") options.output = value;
      else {
        const names = value.split(",");
        for (const name of names) if (!(BOARD_CASES as readonly string[]).includes(name)) throw new Error(`Unknown case: ${name}`);
        options.cases = names as CaseName[];
      }
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live board-case acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live board-case acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live board-case acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  PLASTICITY_CDP_URL=http://127.0.0.1:<port> node scripts/verify-native-board-case-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY [--case ${BOARD_CASES.join(",")}]

Builds the board cases at x >= 2000 mm (the benchmark board in all three lid-boss styles: floor by default, tapered and
hanging with allowBlockedBoard; the audit enclosure; the pod; the reviewer's square-corner case with box lip notches), verifies every derived field and the read-back with
independent reads, lifts each board stand-in out of its base in 3 mm steps (boardDropIn), undoes each case with one
batched undo of the measured undoSteps, probes every R4 web, shifts the board diagonally for the corner gap (pod, stack),
builds two-opening walls, the corner-hole board (floor and stack) and an insert case, and sends the reviewer's bad inputs
(each refused with nothing changed). The document's Undo depth and body count are restored. Run only against an
isolated instance (npm run start:plasticity-isolated).`;

// ------------------------------------------------------------------------------------------------- the three cases
const HOLES_BENCHMARK = [[2.6, 2.6], [48.9, 2.6], [2.6, 25.7], [48.9, 25.7]].map(([xMm, yMm]) => ({ xMm, yMm, diameterMm: 3 }));
export function caseArguments(name: CaseName): Record<string, unknown> {
  if (name === "benchmark" || name === "benchmark-tapered" || name === "benchmark-hanging") {
    // The multi-part benchmark's board: 51.5 x 28.3 x 1.6, four Ø3 holes, 8 mm parts, 4 mm standoffs with Ø2.5 pilots,
    // a 9.2 x 3.4 r1.2 opening centred on the x- wall 1.6 mm above the board top, four M3 countersunk lid screws into
    // Ø2.5 pilots, a five-slot lid vent, board stand-in. "benchmark" leaves bossStyle out (the default, floor: the x-
    // opening sends the cavity growth to y); the two hung styles name it and pass allowBlockedBoard (their bosses overhang
    // the board corners, so boardDropIn is false).
    const bossStyle = name === "benchmark-hanging" ? { bossStyle: "hanging", allowBlockedBoard: true } : name === "benchmark-tapered" ? { bossStyle: "tapered", allowBlockedBoard: true } : {};
    return {
      originMm: [2000, 0, 0],
      board: { lengthMm: 51.5, widthMm: 28.3, holes: HOLES_BENCHMARK, componentHeightMm: 8 },
      standoffs: { heightMm: 4, fastener: { screw: "M3", mode: "pilot", pilotDiameterMm: 2.5 } },
      lid: { fasteners: { screw: "M3", base: "pilot", pilotDiameterMm: 2.5, pilotDepthMm: 6, ...bossStyle } },
      openings: [{ wall: "x-", shape: "rounded-rect", widthMm: 9.2, heightMm: 3.4, cornerRadiusMm: 1.2, alongMm: 14.15, aboveBoardMm: 1.6, label: "usb" }],
      vents: { on: "lid", slots: 5, slotWidthMm: 2, slotLengthMm: 12, pitchMm: 4 },
      boardStandIn: true,
      name: name === "benchmark" ? "esp" : name === "benchmark-hanging" ? "esp-hanging" : "esp-tapered",
    };
  }
  if (name === "audit") {
    // The audit enclosure equivalent: a 75 x 45 board, heat-set inserts in the standoffs (M2.5 x 4) and in the Ø8 lid
    // bosses (M3 x 3), a 12 x 6 r2 opening on the y- wall. Default (floor) bosses: the y- opening sends the 15 mm cavity
    // growth to x, so the cavity is 91 x 46 and the outer 95 x 50.
    return {
      originMm: [2100, 0, 0],
      board: { lengthMm: 75, widthMm: 45, holes: [[4, 4], [71, 4], [4, 41], [71, 41]].map(([xMm, yMm]) => ({ xMm, yMm, diameterMm: 2.7 })), componentHeightMm: 10.4 },
      standoffs: { heightMm: 5, outerDiameterMm: 7.5, fastener: { screw: "M2.5", mode: "heat-set-insert" } },
      lid: { fasteners: { screw: "M3", base: "heat-set-insert", insertLengthMm: 3, bossDiameterMm: 8 } },
      openings: [{ wall: "y-", shape: "rounded-rect", widthMm: 12, heightMm: 6, cornerRadiusMm: 2, alongMm: 37.5, aboveBoardMm: 1, label: "port" }],
      boardStandIn: true,
      name: "audit",
    };
  }
  if (name === "openings") {
    // R1: two rect openings on each of three walls (webs 0.4 on x-, 1 on y-, 10 mm on y+), two rounded-rects stacked
    // with a slot (radius = half the height) on x+, two floor rects and two lid rects.
    const pair = (wall: string, web: number) => [{ wall, shape: "rect", widthMm: 5, heightMm: 3, alongMm: 10, aboveBoardMm: 1, label: `${wall} a` }, { wall, shape: "rect", widthMm: 5, heightMm: 3, alongMm: 15 + web, aboveBoardMm: 1, label: `${wall} b` }];
    const xPlus = [
      { wall: "x+", shape: "rounded-rect", widthMm: 6, heightMm: 2.5, cornerRadiusMm: 0.8, alongMm: 10, aboveBoardMm: 0.5, label: "x+ rr low" },
      { wall: "x+", shape: "rounded-rect", widthMm: 6, heightMm: 2.5, cornerRadiusMm: 0.8, alongMm: 10, aboveBoardMm: 3.5, label: "x+ rr high" },
      { wall: "x+", shape: "rounded-rect", widthMm: 8, heightMm: 3, cornerRadiusMm: 1.5, alongMm: 25, aboveBoardMm: 1, label: "x+ slot" },
    ];
    const flat = (wall: string) => [{ wall, shape: "rect", widthMm: 6, heightMm: 4, alongMm: 15, acrossMm: 20, label: `${wall} a` }, { wall, shape: "rect", widthMm: 6, heightMm: 4, alongMm: 22, acrossMm: 20, label: `${wall} b` }];
    return { originMm: [2400, 0, 0], board: { lengthMm: 60, widthMm: 40, componentHeightMm: 8 }, openings: [...pair("x-", 0.4), ...pair("y-", 1), ...pair("y+", 10), ...xPlus, ...flat("floor"), ...flat("lid")], boardStandIn: true, name: "two" };
  }
  if (name === "corner-holes" || name === "stack") {
    // The 51.5 x 28.3 board. corner-holes (R2): four Ø3 holes 2.0 mm from the edges, default standoffs, M3 lid screws,
    // default (floor) style with a usb opening: the floor bosses merge with the standoffs. stack (S): the benchmark holes
    // (2.6 mm in, Ø3), M2.5 screws (Ø3 passes its 2.7 close fit; M3's 3.2 does not), Ø5 standoffs 4 mm tall with Ø2.1 x 4
    // pilots, plain lid holes, a usb opening on the short x- end and a button on the long y- wall.
    const at = name === "stack" ? 2.6 : 2;
    const holes = [[at, at], [51.5 - at, at], [at, 28.3 - at], [51.5 - at, 28.3 - at]].map(([xMm, yMm]) => ({ xMm, yMm, diameterMm: 3 }));
    const usb = { wall: "x-", shape: "rounded-rect", widthMm: 9.2, heightMm: 3.4, cornerRadiusMm: 1.2, alongMm: 14.15, aboveBoardMm: 1.6, label: "usb" };
    if (name === "corner-holes") return { originMm: [2500, 0, 0], board: { lengthMm: 51.5, widthMm: 28.3, holes, componentHeightMm: 8 }, standoffs: { fastener: { screw: "M3", mode: "pilot", pilotDiameterMm: 2.5 } }, lid: { fasteners: { screw: "M3", base: "pilot", pilotDiameterMm: 2.5, pilotDepthMm: 6 } }, openings: [usb], boardStandIn: true, name: "corner" };
    return { originMm: [2600, 0, 0], board: { lengthMm: 51.5, widthMm: 28.3, holes, componentHeightMm: 8 }, standoffs: { heightMm: 4, outerDiameterMm: 5 }, lid: { fasteners: { screw: "M2.5", base: "pilot", pilotDiameterMm: 2.1, pilotDepthMm: 4, countersunk: false } }, openings: [usb, { wall: "y-", shape: "rect", widthMm: 6, heightMm: 3, alongMm: 25.75, aboveBoardMm: 1, label: "button" }], vents: { on: "lid", slots: 5, slotWidthMm: 2, slotLengthMm: 12, pitchMm: 4 }, boardStandIn: true, name: "stack" };
  }
  if (name === "inserts") {
    // R7: heat-set inserts with the default standoff and boss diameters (both rise to insert hole + 2 x sourced wall).
    return { originMm: [2700, 0, 0], board: { lengthMm: 60, widthMm: 40, holes: [{ xMm: 6, yMm: 6, diameterMm: 2.7 }, { xMm: 54, yMm: 34, diameterMm: 2.7 }], componentHeightMm: 8 }, standoffs: { heightMm: 5, fastener: { screw: "M2.5", mode: "heat-set-insert" } }, lid: { fasteners: { screw: "M3", base: "heat-set-insert", insertLengthMm: 3 } }, boardStandIn: true, name: "insert" };
  }
  if (name === "lip-notch") {
    // The reviewer's P5 without the lift: square outer corners and Ø6 hanging bosses, where a round lip notch would leave
    // a 0.075 mm lip sliver at each corner; the plan uses box notches instead, and the read-back must find no edge under
    // 0.05 mm. The bosses overhang the board corners (allowBlockedBoard; boardDropIn false).
    return {
      originMm: [2300, 0, 0],
      board: { lengthMm: 60, widthMm: 40, componentHeightMm: 8 },
      walls: { outerCornerRadiusMm: 0 },
      lid: { fasteners: { screw: "M3", base: "pilot", pilotDiameterMm: 2.5, pilotDepthMm: 6, bossStyle: "hanging", allowBlockedBoard: true } },
      boardStandIn: true,
      name: "notch",
    };
  }
  // A small sensor pod: 17.8 x 15.2 x 1.6 board, no holes (friction fit, 0.15 mm clearance), a 10 x 4 notch on the x+
  // wall, lid without screws.
  const pod = {
    originMm: [2200, 0, 0],
    board: { lengthMm: 17.8, widthMm: 15.2, componentHeightMm: 3 },
    fit: { boardClearanceMm: 0.15 },
    boardStandIn: true,
  };
  return { ...pod, openings: [{ wall: "x+", shape: "rect", widthMm: 10, heightMm: 4, alongMm: 7.6, aboveBoardMm: -0.5, label: "notch" }], name: "pod" };
}

// The reviewer's bad inputs (60 x 40 board, 8 mm parts unless stated); every one must be refused before any edit.
const reviewBoard = (extra: Record<string, unknown> = {}) => ({ lengthMm: 60, widthMm: 40, componentHeightMm: 8, ...extra });
const reviewLid = (extra: Record<string, unknown> = {}) => ({ fasteners: { screw: "M3", base: "pilot", pilotDiameterMm: 2.5, pilotDepthMm: 6, ...extra } });
export const REVIEW_REJECTS: Array<[string, Record<string, unknown>, RegExp]> = [
  ["2a corner wall: wall 0.8, clearance 0.2", { board: reviewBoard(), walls: { wallMm: 0.8 }, fit: { boardClearanceMm: 0.2 } }, /the corner wall is -0\.028 mm/],
  ["2b corner wall: wall 0.8", { board: reviewBoard(), walls: { wallMm: 0.8 } }, /the corner wall is 0\.096 mm/],
  ["2c corner wall: outer radius 6", { board: reviewBoard(), walls: { outerCornerRadiusMm: 6 } }, /the corner wall is 0\.55 mm/],
  ["2d corner wall: outer radius 9, hanging", { board: reviewBoard(), walls: { outerCornerRadiusMm: 9 }, lid: reviewLid({ bossStyle: "hanging" }) }, /the corner wall is -0\.692 mm/],
  ["2d corner wall: outer radius 12, floor", { board: reviewBoard(), walls: { outerCornerRadiusMm: 12 }, lid: reviewLid({ bossStyle: "floor" }) }, /the corner wall is -1\.935 mm/],
  ["defect 1: hole at x 1.6 with 0.8 walls", { board: reviewBoard({ holes: [{ xMm: 1.6, yMm: 20, diameterMm: 3 }] }), walls: { wallMm: 0.8, outerCornerRadiusMm: 0 }, standoffs: { fastener: { screw: "M3", mode: "pilot", pilotDiameterMm: 2.5 } } }, /standoff 0 .* reaches 0\.9 mm into the wall/],
  ["defect 1: standoff Ø30, holes 4 mm from the edges", { board: reviewBoard({ holes: [{ xMm: 4, yMm: 4, diameterMm: 3 }, { xMm: 50, yMm: 30, diameterMm: 3 }] }), standoffs: { outerDiameterMm: 30, fastener: { screw: "M3", mode: "pilot", pilotDiameterMm: 2.5 } } }, /standoff 0 .* reaches 10\.5 mm into the wall/],
  ["defect 3: standoff Ø5 under a Ø6 hole", { board: reviewBoard({ holes: [{ xMm: 10, yMm: 10, diameterMm: 6 }, { xMm: 50, yMm: 30, diameterMm: 6 }] }), standoffs: { outerDiameterMm: 5, fastener: { screw: "M3", mode: "pilot", pilotDiameterMm: 2.5 } }, boardStandIn: true }, /outer diameter 5 must exceed the Ø6 board hole above it by at least 1 mm/],
  ["A: tapered bosses over the board corners (no allowBlockedBoard)", { board: reviewBoard(), lid: { lipDepthMm: 6.5, ...reviewLid({ bossStyle: "tapered" }) }, boardStandIn: true }, /hang over the board corners.*bossStyle "floor"/],
  ["defect 6: vent pitch = width + 1e-8", { board: reviewBoard(), vents: { on: "lid", slots: 3, slotWidthMm: 2, slotLengthMm: 10, pitchMm: 2 + 1e-8 } }, /vents\.pitchMm .* by at least 0\.4 mm/],
  ["defect 6: board hole Ø1e-7", { board: reviewBoard({ holes: [{ xMm: 5, yMm: 5, diameterMm: 1e-7 }] }), boardStandIn: true }, /below the 0\.5 mm minimum hole diameter/],
  ["defect 6: lip wall 1e-7", { board: reviewBoard(), lid: { lipWallMm: 1e-7 } }, /below the 0\.4 mm minimum lip wall/],
  ["defect 6: two touching wall openings", { board: reviewBoard(), openings: [{ wall: "x-", shape: "rect", widthMm: 5, heightMm: 3, alongMm: 10, aboveBoardMm: 1 }, { wall: "x-", shape: "rect", widthMm: 5, heightMm: 3, alongMm: 15, aboveBoardMm: 1 }] }, /leave a 0 mm web between them/],
  ["defect 6: a 1e6 mm board", { board: reviewBoard({ lengthMm: 1e6, widthMm: 1e6 }) }, /exceeds the 500 mm board size limit/],
  ["defect 6: 1e7 mm parts", { board: reviewBoard({ componentHeightMm: 1e7 }) }, /exceeds the 200 mm height limit/],
  ["D: Ø5 bosses in 1.2 mm walls", { board: reviewBoard(), walls: { wallMm: 1.2, outerCornerRadiusMm: 1 }, lid: reviewLid({ bossStyle: "hanging", bossDiameterMm: 5 }) }, /lid boss 0 \(Ø5\) is 0\.7 mm from the outer surface/],
  ["B: openings on both x and y walls with floor bosses", { board: reviewBoard(), lid: reviewLid({ bossStyle: "floor" }), openings: [{ wall: "x-", shape: "rect", widthMm: 6, heightMm: 3, alongMm: 20, aboveBoardMm: 1 }, { wall: "y+", shape: "rect", widthMm: 6, heightMm: 3, alongMm: 30, aboveBoardMm: 1 }] }, /pass lid\.fasteners\.growAxis "x" or "y"/],
  // R5 (round 3): the late failures now refused in the plan.
  ["R5: wall 1e6", { board: reviewBoard(), walls: { wallMm: 1e6, outerCornerRadiusMm: 0 } }, /walls\.wallMm 1000000 exceeds the 50 mm shell limit/],
  ["R5: board clearance 1e6", { board: reviewBoard(), fit: { boardClearanceMm: 1e6 } }, /fit\.boardClearanceMm 1000000 exceeds the 50 mm board clearance limit/],
  ["R5: lid pilot depth 1e6", { board: reviewBoard(), lid: reviewLid({ pilotDepthMm: 1e6 }) }, /lid\.fasteners\.pilotDepthMm 1000000 exceeds the 200 mm height limit/],
  ["R5: board thickness 1e-6", { board: reviewBoard({ thicknessMm: 1e-6 }), boardStandIn: true }, /below the 0\.2 mm minimum board thickness/],
  ["R5: lip depth 1e-6", { board: reviewBoard(), lid: { lipDepthMm: 1e-6 } }, /below the 0\.5 mm minimum lip depth/],
  ["R5: outer radius 2.0000001 (inner 1e-7)", { board: reviewBoard(), walls: { outerCornerRadiusMm: 2.0000001 } }, /the inner corner radius would be 1e-7 mm/],
  ["R5: opening 0.01 x 0.01", { board: reviewBoard(), openings: [{ wall: "y-", shape: "rect", widthMm: 0.01, heightMm: 0.01, alongMm: 30, aboveBoardMm: 1 }] }, /needs sides of at least 0\.5 mm/],
  ["R5: vent slot width 0.01", { board: reviewBoard(), vents: { on: "lid", slots: 2, slotWidthMm: 0.01, slotLengthMm: 5, pitchMm: 4 } }, /below the 0\.4 mm minimum slot width/],
  ["R5: rounded-rect radius 1.49 of 3", { board: reviewBoard(), openings: [{ wall: "y-", shape: "rounded-rect", widthMm: 8, heightMm: 3, cornerRadiusMm: 1.49, alongMm: 30, aboveBoardMm: 1 }] }, /or exactly half \(1\.5\) for a slot/],
  ["R5: lip neck (30 x 10.46 board, lip wall 2.3)", { board: { lengthMm: 30, widthMm: 10.46, componentHeightMm: 8 }, lid: { lipWallMm: 2.3, ...reviewLid() } }, /the lid lip between the two boss notches along y is 0\.06 mm wide/],
  ["S: stack with a hole smaller than the M3 close fit", { board: reviewBoard({ holes: [{ xMm: 4, yMm: 4, diameterMm: 3 }, { xMm: 56, yMm: 36, diameterMm: 3 }] }), lid: reviewLid({ bossStyle: "stack" }) }, /is smaller than the M3 close-fit clearance Ø3\.2/],
];

// --------------------------------------------------------------------------------------------------------- checks
type Check = { field: string; check: string; ok: boolean; expected?: unknown; actual?: unknown };

class Checks {
  list: Check[] = [];
  add(field: string, check: string, ok: boolean, expected?: unknown, actual?: unknown): void {
    this.list.push({ field, check, ok, ...(expected !== undefined ? { expected } : {}), ...(actual !== undefined ? { actual } : {}) });
  }
  near(field: string, check: string, actual: number | undefined, expected: number, tol = TOL): void {
    this.add(field, check, typeof actual === "number" && Math.abs(actual - expected) <= tol, expected, actual);
  }
  boundsNear(field: string, check: string, actual: Bounds | undefined, expected: Bounds, tol = TOL): void {
    const ok = !!actual && [0, 1, 2].every((axis) => Math.abs(actual.min[axis]! - expected.min[axis]!) <= tol && Math.abs(actual.max[axis]! - expected.max[axis]!) <= tol);
    this.add(field, check, ok, expected, actual);
  }
  axesNear(field: string, check: string, actual: V2[], expected: V2[], tol = TOL): void {
    const remaining = [...actual];
    const ok = expected.every((point) => {
      const index = remaining.findIndex((candidate) => Math.abs(candidate[0] - point[0]) <= tol && Math.abs(candidate[1] - point[1]) <= tol);
      if (index < 0) return false;
      remaining.splice(index, 1);
      return true;
    }) && remaining.length === 0;
    this.add(field, check, ok, expected, actual);
  }
}

const union = (list: Bounds[]): Bounds | undefined => list.length === 0 ? undefined : {
  min: [0, 1, 2].map((axis) => Math.min(...list.map((bounds) => bounds.min[axis]!))) as V3,
  max: [0, 1, 2].map((axis) => Math.max(...list.map((bounds) => bounds.max[axis]!))) as V3,
};
const near = (a: number, b: number, tol = TOL) => Math.abs(a - b) <= tol;
const along = (vector: V3, axis: V3) => near(vector[0], axis[0], 1e-6) && near(vector[1], axis[1], 1e-6) && near(vector[2], axis[2], 1e-6);
const uniqueAxes = (faces: Face[]): V2[] => {
  const out: V2[] = [];
  for (const face of faces) {
    const point: V2 = [r3(face.axisOriginMm![0]), r3(face.axisOriginMm![1])];
    if (!out.some((other) => near(other[0], point[0]) && near(other[1], point[1]))) out.push(point);
  }
  return out;
};
const r3 = (value: number) => Math.round(value * 1000) / 1000;

async function verifyCase(client: Client, args: Record<string, unknown>, result: any, revision: string): Promise<Check[]> {
  const derived = result.derived;
  const { baseId, lidId, boardId } = result.bodies as { baseId: number; lidId: number; boardId?: number };
  const checks = new Checks();
  const faces = async (bodyId: number): Promise<Face[]> => (await call(client, "plasticity_find_faces", { revision, query: { bodyIds: [bodyId] }, limit: 1000 })).matches;
  const circles = async (bodyId: number): Promise<Edge[]> => (await call(client, "plasticity_find_edges", { revision, query: { bodyIds: [bodyId], circle: true }, limit: 1000 })).matches;
  const baseFaces = await faces(baseId);
  const lidFaces = await faces(lidId);
  const boardFaces = boardId !== undefined ? await faces(boardId) : [];
  const lidCircles = await circles(lidId);
  const planar = (list: Face[], normal: V3, coordinate: number, axis: 0 | 1 | 2) => list.filter((face) => face.planar && along(face.normal, normal) && near(face.boundsMm.min[axis], coordinate) && near(face.boundsMm.max[axis], coordinate));
  const cylinders = (list: Face[], radius: number) => list.filter((face) => /cylinder/i.test(face.surfaceType) && face.radiusMm !== null && near(face.radiusMm, radius, 1e-6) && face.axisDirection && Math.abs(Math.abs(face.axisDirection[2]) - 1) < 1e-6);
  const ids = [baseId, lidId, ...(boardId !== undefined ? [boardId] : [])];
  // Boss gussets and floor bosses split a wall into several faces (and the rounded cavity corners trim its ends): pick the face that
  // spans the given z range and overlaps the given along-wall range the most, else the first.
  const wallSpanning = (list: Face[], normal: V3, coordinate: number, axis: 0 | 1 | 2, z: V2, along: V2): Face | undefined => {
    const candidates = planar(list, normal, coordinate, axis);
    const alongAxis = axis === 0 ? 1 : 0;
    const overlap = (face: Face) => Math.min(face.boundsMm.max[alongAxis]!, along[1]) - Math.max(face.boundsMm.min[alongAxis]!, along[0]);
    return candidates.filter((face) => face.boundsMm.min[2] <= z[0] + TOL && face.boundsMm.max[2] >= z[1] - TOL && overlap(face) > 0).sort((a, b) => overlap(b) - overlap(a))[0] ?? candidates[0];
  };

  // Solids and validity.
  const validation = await call(client, "plasticity_validate_bodies", { ids, revision });
  checks.add("bodies", "base, lid (and board) are closed, native-valid printable Solids", validation.bodies.length === ids.length && validation.bodies.every((body: any) => body.closed && body.nativeValid && body.printableSolid), ids, validation.bodies.map((body: any) => ({ id: body.id, closed: body.closed, nativeValid: body.nativeValid, printableSolid: body.printableSolid })));
  // Read-back, independently: no edge shorter than 0.05 mm on any body; the lid's face bounds are derived.lidMm; the
  // recipe's own readBack says the same.
  const shortest: Record<string, number> = {};
  for (const id of ids) {
    const edges = (await call(client, "plasticity_find_edges", { revision, query: { bodyIds: [id] }, limit: 1000 })).matches as Array<{ lengthMm: number }>;
    shortest[String(id)] = Math.min(...edges.map((edge) => edge.lengthMm));
  }
  checks.add("readBack", "no edge shorter than 0.05 mm on base, lid or board (find_edges)", Object.values(shortest).every((length) => length >= 0.05), 0.05, shortest);
  checks.boundsNear("lidMm", "union of the lid's face bounds", union(lidFaces.map((face) => face.boundsMm)), derived.lidMm);
  const readBack = result.readBack;
  checks.add("readBack", "the recipe's readBack: bodies closed and valid, shortest edge at least 0.05 mm", !!readBack && readBack.bodies.length === ids.length && readBack.bodies.every((body: any) => body.closed && body.nativeValid) && readBack.minEdgeMm >= 0.05 && Math.abs(readBack.minEdgeMm - Math.min(...Object.values(shortest))) <= TOL, Math.min(...Object.values(shortest)), readBack);
  checks.boundsNear("readBack", "readBack.baseBoundsMm = derived.outerMm", readBack?.baseBoundsMm, derived.outerMm);
  checks.boundsNear("readBack", "readBack.lidBoundsMm = derived.lidMm", readBack?.lidBoundsMm, derived.lidMm);
  if (boardId !== undefined) checks.boundsNear("readBack", "readBack.boardBoundsMm = derived.boardMm", readBack?.boardBoundsMm, derived.boardMm);
  checks.add("plannedUndoSteps", "derived.plannedUndoSteps = undoSteps", derived.plannedUndoSteps === result.undoSteps, derived.plannedUndoSteps, result.undoSteps);
  const boxNotches = result.steps.filter((step: { operation: string }) => step.operation === "create-lip-corner-notch-cutter").length;
  if (boxNotches > 0) checks.add("lid", "box lip notches (the round notch would leave a lip piece under 1 mm): four, and no lid edge under 0.05 mm", boxNotches === 4 && shortest[String(lidId)]! >= 0.05, 4, { boxNotches, lidShortestEdgeMm: shortest[String(lidId)] });

  // outerMm: bounds of every base face; the four outer corners keep the outer radius.
  checks.boundsNear("outerMm", "union of the base's face bounds", union(baseFaces.map((face) => face.boundsMm)), derived.outerMm);
  const outerRadius = (args.walls as { outerCornerRadiusMm?: number } | undefined)?.outerCornerRadiusMm ?? 3;
  checks.add("outerMm", outerRadius > 0 ? `four outer corner cylinders r${outerRadius} on the base` : "square outer corners: no corner cylinder spans the base height", (outerRadius > 0 ? cylinders(baseFaces, outerRadius) : baseFaces.filter((face) => /cylinder/i.test(face.surfaceType))).filter((face) => near(face.boundsMm.min[2], derived.outerMm.min[2]) && near(face.boundsMm.max[2], derived.outerMm.max[2])).length === (outerRadius > 0 ? 4 : 0));
  // cavityMm: the four flat inner walls at the cavity planes, the floor and the rim.
  const cav = derived.cavityMm as Bounds;
  const walls: Array<[string, V3, number, 0 | 1]> = [["x-", [1, 0, 0], cav.min[0], 0], ["x+", [-1, 0, 0], cav.max[0], 0], ["y-", [0, 1, 0], cav.min[1], 1], ["y+", [0, -1, 0], cav.max[1], 1]];
  for (const [label, normal, coordinate, axis] of walls) {
    const found = planar(baseFaces, normal, coordinate, axis);
    checks.add("cavityMm", `inner wall ${label} plane at ${coordinate}`, found.length >= 1, coordinate, found.map((face) => face.boundsMm));
  }
  const floor = planar(baseFaces, [0, 0, 1], derived.floorTopZMm, 2);
  const floorBounds = union(floor.map((face) => face.boundsMm));
  checks.add("cavityMm", "floor faces cover the cavity in x and y", !!floorBounds && near(floorBounds.min[0], cav.min[0]) && near(floorBounds.max[0], cav.max[0]) && near(floorBounds.min[1], cav.min[1]) && near(floorBounds.max[1], cav.max[1]), { min: cav.min, max: cav.max }, floorBounds);
  checks.near("floorTopZMm", "floor face z", floor[0]?.boundsMm.min[2], derived.floorTopZMm);
  checks.near("cavityMm", "cavity top = base top z", union(baseFaces.map((face) => face.boundsMm))?.max[2], cav.max[2]);
  const rim = planar(baseFaces, [0, 0, 1], derived.wallTopZMm, 2);
  checks.add("wallTopZMm", "wall rim faces face up at the wall top", rim.length >= 1, derived.wallTopZMm, rim.length);
  // R4 corner webs cover the inner corner arc up to their top (a floor boss's web covers it to the wall top): each corner
  // without a web has an arc from the floor top, a corner with a lower web an arc from the web top, a full-height web none.
  {
    const cornerWebs = (derived.webs as Array<{ kind: string; box?: { originMm: V3; sizeMm: V3 } }>).filter((web) => web.kind === "corner" && web.box);
    const cornerPoints: V2[] = [[cav.min[0], cav.min[1]], [cav.max[0], cav.min[1]], [cav.min[0], cav.max[1]], [cav.max[0], cav.max[1]]];
    const expectedStarts: number[] = [];
    for (const [cx, cy] of cornerPoints) {
      // The arc is exposed wherever no corner web covers it, from the floor top to the wall top: one arc face starts at
      // the bottom of each exposed stretch.
      const covered = cornerWebs.filter((web) => cx >= web.box!.originMm[0] - TOL && cx <= web.box!.originMm[0] + web.box!.sizeMm[0] + TOL && cy >= web.box!.originMm[1] - TOL && cy <= web.box!.originMm[1] + web.box!.sizeMm[1] + TOL)
        .map((web) => [web.box!.originMm[2], web.box!.originMm[2] + web.box!.sizeMm[2]] as V2).sort((a, b) => a[0] - b[0]);
      let z = derived.floorTopZMm;
      for (const [low, high] of covered) {
        if (low > z + TOL) { expectedStarts.push(r3(z)); }
        z = Math.max(z, high);
      }
      if (z < derived.wallTopZMm - TOL) expectedStarts.push(r3(z));
    }
    const arcs = cylinders(baseFaces, derived.innerCornerRadiusMm).map((face) => r3(face.boundsMm.min[2])).sort((a, b) => a - b);
    checks.add("innerCornerRadiusMm", `inner corner cylinders r${derived.innerCornerRadiusMm} start at the floor top or at the top of the corner web`, derived.innerCornerRadiusMm === 0 || JSON.stringify(arcs) === JSON.stringify(expectedStarts.sort((a, b) => a - b)), expectedStarts, arcs);
  }

  // Lid: top, lip outer and inner faces, lip bottom.
  checks.near("lidTopZMm", "lid top face z", planar(lidFaces, [0, 0, 1], derived.lidTopZMm, 2)[0]?.boundsMm.min[2], derived.lidTopZMm);
  checks.near("lidTopZMm", "lid bounds max z", union(lidFaces.map((face) => face.boundsMm))?.max[2], derived.lidTopZMm);
  const lip = derived.lipOuterMm as Bounds;
  const lipInner = derived.lipInnerMm as Bounds;
  const lipFaces: Array<[string, V3, number, 0 | 1]> = [["x-", [-1, 0, 0], lip.min[0], 0], ["x+", [1, 0, 0], lip.max[0], 0], ["y-", [0, -1, 0], lip.min[1], 1], ["y+", [0, 1, 0], lip.max[1], 1]];
  const lipInnerFaces: Array<[string, V3, number, 0 | 1]> = [["x-", [1, 0, 0], lipInner.min[0], 0], ["x+", [-1, 0, 0], lipInner.max[0], 0], ["y-", [0, 1, 0], lipInner.min[1], 1], ["y+", [0, -1, 0], lipInner.max[1], 1]];
  for (const [label, normal, coordinate, axis] of lipFaces) {
    const found = planar(lidFaces, normal, coordinate, axis).filter((face) => near(face.boundsMm.min[2], lip.min[2]) && near(face.boundsMm.max[2], lip.max[2]));
    checks.add("lipOuterMm", `lip outer face ${label} at ${coordinate}, z ${lip.min[2]}..${lip.max[2]}`, found.length >= 1, coordinate, found.length);
  }
  for (const [label, normal, coordinate, axis] of lipInnerFaces) {
    const found = planar(lidFaces, normal, coordinate, axis).filter((face) => near(face.boundsMm.min[2], lipInner.min[2]) && near(face.boundsMm.max[2], lipInner.max[2]));
    checks.add("lipInnerMm", `lip inner face ${label} at ${coordinate}`, found.length >= 1, coordinate, found.length);
  }
  checks.near("lidMm", "lid bounds min z = derived.lidMm min z (lip bottom, or the stack post bottoms)", union(lidFaces.map((face) => face.boundsMm))?.min[2], derived.lidMm.min[2]);
  checks.add("componentTopZMm", "lip bottom is headroom (1 mm) above the component top", lip.min[2] - derived.componentTopZMm >= 1 - TOL, 1, r3(lip.min[2] - derived.componentTopZMm));
  // Lid lip clearance per side, measured face to face.
  const lc = (args.fit as { lidClearanceMm?: number } | undefined)?.lidClearanceMm ?? 0.2;
  for (const [index, [label, normal, coordinate, axis]] of lipFaces.entries()) {
    // The lip is split by the boss notches: measure its longest piece against the wall face under it.
    const alongAxis = axis === 0 ? 1 : 0;
    const lipFace = planar(lidFaces, normal, coordinate, axis).filter((face) => near(face.boundsMm.min[2], lip.min[2])).sort((a, b) => (b.boundsMm.max[alongAxis]! - b.boundsMm.min[alongAxis]!) - (a.boundsMm.max[alongAxis]! - a.boundsMm.min[alongAxis]!))[0];
    const wall = lipFace ? wallSpanning(baseFaces, walls[index]![1], walls[index]![2], walls[index]![3], [lipFace.boundsMm.min[2], lipFace.boundsMm.max[2]], [lipFace.boundsMm.min[alongAxis]!, lipFace.boundsMm.max[alongAxis]!]) : undefined;
    if (!lipFace || !wall) { checks.add("lipOuterMm", `lip clearance ${label}`, false, lc, "faces missing"); continue; }
    const measured = await call(client, "plasticity_measure_parallel_planar_face_clearance", { first: { bodyId: lidId, faceId: lipFace.id }, second: { bodyId: baseId, faceId: wall.id }, revision });
    checks.near("lipOuterMm", `lip to wall clearance ${label} = lidClearance`, measured.minimumDistanceMm, lc);
  }

  // Standoffs: outer cylinders and holes at the derived axes, tops at the standoff top.
  const fasteners = derived.fasteners;
  if (fasteners.standoffs) {
    const s = fasteners.standoffs;
    const outer = s.outerDiametersMm.flatMap((od: number) => cylinders(baseFaces, od / 2)).filter((face: Face) => near(face.boundsMm.max[2], derived.standoffTopZMm) && near(face.boundsMm.min[2], derived.floorTopZMm));
    checks.axesNear("standoffAxesMm", "standoff outer cylinders (floor to standoff top)", uniqueAxes(outer), derived.standoffAxesMm);
    const holes = cylinders(baseFaces, s.holeDiameterMm / 2).filter((face) => near(face.boundsMm.max[2], derived.standoffTopZMm));
    checks.axesNear("standoffAxesMm", `standoff holes Ø${s.holeDiameterMm} (${s.mode}, ${s.source.slice(0, 24)}...)`, uniqueAxes(holes), derived.standoffAxesMm);
    const bottom = s.mode === "through" ? derived.outerMm.min[2] : derived.standoffTopZMm - s.holeDepthMm;
    checks.add("fasteners.standoffs", `standoff hole depth ${s.holeDepthMm} (bottom z ${r3(bottom)})`, holes.length > 0 && holes.every((face) => near(face.boundsMm.min[2], bottom) || (s.mode === "through" && face.boundsMm.min[2] <= derived.floorTopZMm + TOL)), bottom, holes.map((face) => r3(face.boundsMm.min[2])));
    checks.near("standoffTopZMm", "standoff top faces", planar(baseFaces, [0, 0, 1], derived.standoffTopZMm, 2)[0]?.boundsMm.min[2], derived.standoffTopZMm);
  } else {
    checks.add("standoffAxesMm", "no standoffs requested, none derived", derived.standoffAxesMm.length === 0);
  }

  // Stack (S): lid posts over the board holes, coaxial lid clearance holes, posts 0.2 mm above the board.
  if (derived.bossStyle === "stack") {
    const st = derived.stack as { postAxesMm: V2[]; postOuterDiametersMm: number[]; postBottomZMm: number; holeDiameterMm: number };
    const postFaces = [...new Set(st.postOuterDiametersMm)].flatMap((od) => cylinders(lidFaces, od / 2)).filter((face) => near(face.boundsMm.min[2], st.postBottomZMm));
    checks.axesNear("stack", "lid post cylinders end at the post bottom, on the board-hole axes", uniqueAxes(postFaces), st.postAxesMm);
    const clearance = cylinders(lidFaces, st.holeDiameterMm / 2).filter((face) => near(face.boundsMm.min[2], st.postBottomZMm) || near(face.boundsMm.max[2], derived.lidTopZMm));
    checks.axesNear("stack", `lid clearance holes Ø${st.holeDiameterMm} coaxial with the posts (post bottom to lid top)`, uniqueAxes(clearance), st.postAxesMm);
    checks.add("stack", "the clearance holes run from the post bottom to the lid top", near(Math.min(...clearance.map((face) => face.boundsMm.min[2])), st.postBottomZMm) && near(Math.max(...clearance.map((face) => face.boundsMm.max[2])), derived.lidTopZMm), [st.postBottomZMm, derived.lidTopZMm], clearance.map((face) => [r3(face.boundsMm.min[2]), r3(face.boundsMm.max[2])]));
    checks.axesNear("stack", "standoff holes coaxial with the posts", uniqueAxes(cylinders(baseFaces, fasteners.standoffs.holeDiameterMm / 2).filter((face) => near(face.boundsMm.max[2], derived.standoffTopZMm))), st.postAxesMm);
    if (boardId !== undefined) {
      const boardTop = planar(boardFaces, [0, 0, 1], derived.boardTopZMm, 2)[0];
      checks.add("stack", "post bottom 0.2 mm above the board top (faces)", !!boardTop && near(union(postFaces.map((face) => face.boundsMm))!.min[2] - boardTop.boundsMm.max[2], 0.2), 0.2, boardTop ? r3(union(postFaces.map((face) => face.boundsMm))!.min[2] - boardTop.boundsMm.max[2]) : null);
    }
    checks.add("stack", "no corner bosses and no notches", derived.lidBossAxesMm.length === 0 && derived.bossTaper === undefined && derived.cavityGrowthMm === undefined);
  }
  // Lid bosses: corner posts (hanging, hanging on a 45 degree gusset, or standing on the floor), their holes, the coaxial lid holes and countersinks.
  if (fasteners.lid && derived.bossStyle !== "stack") {
    const l = fasteners.lid;
    const style = derived.bossStyle as "tapered" | "hanging" | "floor";
    const overshoot = result.constants.overshootMm as number;
    checks.add("bossStyle", `derived.bossStyle is ${style}`, style === ((args.lid as any).fasteners.bossStyle ?? "floor"), (args.lid as any).fasteners.bossStyle ?? "floor", style);
    // Inside the cavity only: the outer corner rounds can share the boss radius but run from the base bottom.
    const posts = cylinders(baseFaces, l.bossDiameterMm / 2).filter((face) => near(face.boundsMm.max[2], derived.wallTopZMm) && (style === "floor" ? near(face.boundsMm.min[2], derived.floorTopZMm) : face.boundsMm.min[2] > derived.floorTopZMm + TOL));
    checks.axesNear("lidBossAxesMm", `corner boss cylinders Ø${l.bossDiameterMm}`, uniqueAxes(posts), derived.lidBossAxesMm);
    // A tapered boss rises out of the top of its gusset (the joint is one overshoot above the boss bottom).
    const exposedBottom = style === "tapered" ? derived.lidBossBottomZMm + overshoot : derived.lidBossBottomZMm;
    checks.add("lidBossBottomZMm", style === "tapered" ? "tapered boss cylinders rise from the gusset top (boss bottom + overshoot)" : style === "floor" ? "floor boss cylinders start at the floor top" : "corner bosses start at the derived bottom z", posts.length > 0 && posts.every((face) => near(face.boundsMm.min[2], exposedBottom)), exposedBottom, posts.map((face) => r3(face.boundsMm.min[2])));
    if (style !== "floor") checks.add("componentTopZMm", "corner boss bottom is headroom (1 mm) above the component top", derived.lidBossBottomZMm - derived.componentTopZMm >= 1 - TOL);
    if (style === "floor") checks.add("fasteners.lid.bossLengthMm", "floor boss length = wall top - floor top", near(l.bossLengthMm, derived.wallTopZMm - derived.floorTopZMm), derived.wallTopZMm - derived.floorTopZMm, l.bossLengthMm);
    const baseHoles = cylinders(baseFaces, l.baseHole.diameterMm / 2).filter((face) => near(face.boundsMm.max[2], derived.wallTopZMm));
    checks.axesNear("lidBossAxesMm", `boss holes Ø${l.baseHole.diameterMm} (${l.base})`, uniqueAxes(baseHoles), derived.lidBossAxesMm);
    checks.add("fasteners.lid", `boss hole depth ${l.baseHole.depthMm}`, baseHoles.length > 0 && baseHoles.every((face) => near(face.boundsMm.min[2], derived.wallTopZMm - l.baseHole.depthMm)), derived.wallTopZMm - l.baseHole.depthMm, baseHoles.map((face) => r3(face.boundsMm.min[2])));
    const lidHoles = cylinders(lidFaces, l.lidHole.diameterMm / 2);
    checks.axesNear("lidBossAxesMm", `lid clearance holes Ø${l.lidHole.diameterMm} (${l.lidHole.fit}) coaxial with the bosses`, uniqueAxes(lidHoles), derived.lidBossAxesMm);
    if (l.countersink) {
      const head = lidCircles.filter((edge) => edge.circleGeometry && near(edge.circleGeometry.radiusMm, l.countersink.headDiameterMm / 2, 1e-6) && near(edge.circleGeometry.centerMm[2], derived.lidTopZMm));
      checks.axesNear("fasteners.lid.countersink", `countersink rims Ø${l.countersink.headDiameterMm} on the lid top`, head.map((edge) => [r3(edge.circleGeometry!.centerMm[0]), r3(edge.circleGeometry!.centerMm[1])] as V2), derived.lidBossAxesMm);
      const cones = lidFaces.filter((face) => /cone/i.test(face.surfaceType));
      checks.add("fasteners.lid.countersink", `four cones ${l.countersink.depthMm} deep, ${l.countersink.includedAngleDeg}° included`, cones.length === 4 && cones.every((face) => near(face.boundsMm.max[2] - face.boundsMm.min[2], l.countersink.depthMm) && (face.coneSemiAngleRad === undefined || near(face.coneSemiAngleRad * 360 / Math.PI, l.countersink.includedAngleDeg, 1e-6))), l.countersink.depthMm, cones.map((face) => ({ depth: r3(face.boundsMm.max[2] - face.boundsMm.min[2]), semiAngleRad: face.coneSemiAngleRad })));
    }

    // Style-specific geometry, read from the faces.
    const baseCones = baseFaces.filter((face) => /cone/i.test(face.surfaceType));
    const cornerAxes = [[cav.min[0], cav.min[1]], [cav.max[0], cav.min[1]], [cav.min[0], cav.max[1]], [cav.max[0], cav.max[1]]] as V2[];
    if (style === "tapered") {
      const taper = derived.bossTaper as { angleDeg: number; bottomZMm: number; addedHeightMm: number };
      checks.add("bossTaper", "one cone face under each boss (four on the base)", baseCones.length === 4, 4, baseCones.map((face) => ({ id: face.id, surface: face.surfaceType })));
      checks.add("bossTaper", `every taper cone has a ${taper.angleDeg}° half-angle (read from the face data)`, baseCones.length === 4 && baseCones.every((face) => typeof face.coneSemiAngleRad === "number" && near((face.coneSemiAngleRad * 180) / Math.PI, taper.angleDeg, 1e-6)), taper.angleDeg, baseCones.map((face) => face.coneSemiAngleRad === undefined ? null : (face.coneSemiAngleRad * 180) / Math.PI));
      checks.add("bossTaper", "taper cone axes are vertical lines through the four cavity corners", baseCones.length === 4 && baseCones.every((face) => !!face.axisDirection && Math.abs(Math.abs(face.axisDirection[2]) - 1) < 1e-6), cornerAxes, baseCones.map((face) => face.axisDirection));
      checks.axesNear("bossTaper", "taper cone axes at the cavity corners", uniqueAxes(baseCones.filter((face) => face.axisOriginMm)), cornerAxes);
      checks.add("bossTaper", `lowest point of each taper cone is bossTaper.bottomZMm ${taper.bottomZMm}`, baseCones.length === 4 && baseCones.every((face) => near(face.boundsMm.min[2], taper.bottomZMm)), taper.bottomZMm, baseCones.map((face) => r3(face.boundsMm.min[2])));
      checks.add("bossTaper", `top of each taper cone is the boss bottom + overshoot ${r3(exposedBottom)}`, baseCones.length === 4 && baseCones.every((face) => near(face.boundsMm.max[2], exposedBottom)), exposedBottom, baseCones.map((face) => r3(face.boundsMm.max[2])));
      checks.add("bossTaper", "taper bottom is at least componentTop + 1 mm (clear of the board keep-out)", taper.bottomZMm >= derived.componentTopZMm + 1 - TOL, derived.componentTopZMm + 1, taper.bottomZMm);
      checks.add("bossTaper", "taper cones stay inside the cavity footprint (nothing protrudes past the inner walls)", baseCones.every((face) => face.boundsMm.min[0] >= cav.min[0] - TOL && face.boundsMm.max[0] <= cav.max[0] + TOL && face.boundsMm.min[1] >= cav.min[1] - TOL && face.boundsMm.max[1] <= cav.max[1] + TOL), cav, baseCones.map((face) => face.boundsMm));
      checks.add("bossTaper", "taper top faces: an up-facing plane at the gusset top joins each cone to its boss", planar(baseFaces, [0, 0, 1], exposedBottom, 2).length >= 4, exposedBottom, planar(baseFaces, [0, 0, 1], exposedBottom, 2).length);
      checks.add("bossTaper", "no base face leaves the outer bounds (nothing through the outer walls)", (() => { const all = union(baseFaces.map((face) => face.boundsMm)); return !!all && near(all.min[0], derived.outerMm.min[0]) && near(all.max[0], derived.outerMm.max[0]) && near(all.min[1], derived.outerMm.min[1]) && near(all.max[1], derived.outerMm.max[1]); })());
    } else {
      checks.add("bossTaper", `no taper cones on a ${style} case`, baseCones.length === 0 && derived.bossTaper === undefined, 0, baseCones.length);
    }
    if (style === "floor") {
      const growth = derived.cavityGrowthMm as V2;
      const board = args.board as { lengthMm: number; widthMm: number };
      const bcMm = (args.fit as { boardClearanceMm?: number } | undefined)?.boardClearanceMm ?? 0.5;
      checks.add("cavityGrowthMm", "cavity = board + 2 x boardClearance + growth, in x and y", near(cav.max[0] - cav.min[0], board.lengthMm + 2 * bcMm + growth[0]) && near(cav.max[1] - cav.min[1], board.widthMm + 2 * bcMm + growth[1]), growth, [r3(cav.max[0] - cav.min[0] - board.lengthMm - 2 * bcMm), r3(cav.max[1] - cav.min[1] - board.widthMm - 2 * bcMm)]);
    } else {
      checks.add("cavityGrowthMm", `no cavity growth on a ${style} case`, derived.cavityGrowthMm === undefined);
    }
    const printability = derived.printability as { baseOrientation: string; maxBossOverhangDeg: number };
    checks.add("printability", `maxBossOverhangDeg ${printability.maxBossOverhangDeg} is ${style === "hanging" ? "90 (flat underside)" : style === "tapered" ? "45" : "0 (boss stands on the floor)"}, base floor-down`, printability.baseOrientation === "floor-down" && near(printability.maxBossOverhangDeg, { hanging: 90, tapered: 45, floor: 0 }[style], 1e-6), { hanging: 90, tapered: 45, floor: 0 }[style], printability.maxBossOverhangDeg);
  } else {
    checks.add("lidBossAxesMm", "no lid fasteners requested, none derived", derived.lidBossAxesMm.length === 0);
    checks.add("printability", "no lid fasteners: no boss fields (printability without maxBossOverhangDeg)", derived.printability?.maxBossOverhangDeg === undefined && derived.bossTaper === undefined && derived.cavityGrowthMm === undefined);
  }

  // printability: top face down for the lid, and every flat wall-opening ceiling over 6 mm (width - 2 x corner radius).
  const ceilings = (derived.openings as Array<{ label: string; wall: string; shape: string; sizeMm: V2; cornerRadiusMm?: number }>)
    .filter((opening) => opening.wall !== "lid" && opening.wall !== "floor" && opening.shape !== "circle" && opening.sizeMm[0] - 2 * (opening.cornerRadiusMm ?? 0) > 6)
    .map((opening) => opening.label);
  checks.add("printability", "openingCeilings lists every flat wall-opening ceiling wider than 6 mm; the lid prints top face down", derived.printability.lidPrintOrientation === "top face down" && JSON.stringify(derived.printability.openingCeilings.map((entry: { label: string }) => entry.label)) === JSON.stringify(ceilings), ceilings, derived.printability.openingCeilings);

  // Board stand-in: bounds, seat on the standoffs, clearance to each wall.
  if (boardId !== undefined) {
    checks.boundsNear("boardMm", "union of the board's face bounds", union(boardFaces.map((face) => face.boundsMm)), derived.boardMm);
    checks.near("boardTopZMm", "board top face z", planar(boardFaces, [0, 0, 1], derived.boardTopZMm, 2)[0]?.boundsMm.min[2], derived.boardTopZMm);
    const bottom = planar(boardFaces, [0, 0, -1], derived.boardMm.min[2], 2)[0];
    if (fasteners.standoffs) {
      const tops = planar(baseFaces, [0, 0, 1], derived.standoffTopZMm, 2);
      const gaps: number[] = [];
      for (const top of tops) gaps.push((await call(client, "plasticity_measure_parallel_planar_face_clearance", { first: { bodyId: boardId, faceId: bottom!.id }, second: { bodyId: baseId, faceId: top.id }, revision })).minimumDistanceMm);
      checks.add("boardMm", "board sits on every standoff (gap 0)", tops.length === derived.standoffAxesMm.length && gaps.every((gap) => near(gap, 0)), 0, gaps);
    }
    const wallClearance = derived.boardWallClearanceMm as { xNeg: number; xPos: number; yNeg: number; yPos: number };
    const expectedClearance = [wallClearance.xNeg, wallClearance.xPos, wallClearance.yNeg, wallClearance.yPos];
    const boardSides: Array<[V3, number, 0 | 1]> = [[[-1, 0, 0], derived.boardMm.min[0], 0], [[1, 0, 0], derived.boardMm.max[0], 0], [[0, -1, 0], derived.boardMm.min[1], 1], [[0, 1, 0], derived.boardMm.max[1], 1]];
    for (const [index, [normal, coordinate, axis]] of boardSides.entries()) {
      const side = planar(boardFaces, normal, coordinate, axis)[0];
      const wall = wallSpanning(baseFaces, walls[index]![1], walls[index]![2], walls[index]![3], [derived.boardMm.min[2], derived.boardMm.max[2]], walls[index]![3] === 0 ? [derived.boardMm.min[1], derived.boardMm.max[1]] : [derived.boardMm.min[0], derived.boardMm.max[0]]);
      if (!side || !wall) { checks.add("boardMm", `board clearance ${walls[index]![0]}`, false, expectedClearance[index], "faces missing"); continue; }
      const measured = await call(client, "plasticity_measure_parallel_planar_face_clearance", { first: { bodyId: boardId, faceId: side.id }, second: { bodyId: baseId, faceId: wall.id }, revision });
      checks.near("boardWallClearanceMm", `board to wall ${walls[index]![0]} clearance = derived.boardWallClearanceMm`, measured.minimumDistanceMm, expectedClearance[index]!);
    }
    const boardHoles = (args.board as { holes?: Array<{ diameterMm: number }> }).holes ?? [];
    if (boardHoles.length > 0) {
      const found = [...new Set(boardHoles.map((hole) => hole.diameterMm))].flatMap((diameter) => cylinders(boardFaces, diameter / 2));
      checks.axesNear("boardMm", "board holes coaxial with the standoffs", uniqueAxes(found), derived.standoffAxesMm);
    }
  }

  // Interference: none between any pair.
  const pairs = [[baseId, lidId], ...(boardId !== undefined ? [[baseId, boardId], [lidId, boardId]] : [])].map(([firstBodyId, secondBodyId]) => ({ firstBodyId, secondBodyId }));
  const interference = await call(client, "plasticity_check_interference", { pairs, revision });
  checks.add("bodies", "no volumetric interference between base, lid and board", interference.pairs.every((pair: any) => pair.status === "no-volumetric-interference"), "no-volumetric-interference", interference.pairs.map((pair: any) => pair.status));

  // Openings: the faces that line each opening through its wall give its centre and size.
  for (const opening of derived.openings as Array<{ label: string; wall: string; shape: string; centerMm: V3; sizeMm: V2; cornerRadiusMm?: number }>) {
    const flat = opening.wall === "lid" || opening.wall === "floor";
    const list = opening.wall === "lid" ? lidFaces : baseFaces;
    const normalAxis = flat ? 2 : opening.wall.startsWith("x") ? 0 : 1;
    const alongAxis = flat ? 0 : opening.wall.startsWith("x") ? 1 : 0;
    const crossAxis = flat ? 1 : 2;
    const wallMm = (args.walls as { wallMm?: number } | undefined)?.wallMm ?? 2;
    const slab: V2 = flat ? [opening.centerMm[2] - (opening.wall === "lid" ? 2 : 0), opening.centerMm[2] + (opening.wall === "lid" ? 0 : 2)] : opening.wall.endsWith("-") ? [opening.centerMm[normalAxis], opening.centerMm[normalAxis] + wallMm] : [opening.centerMm[normalAxis] - wallMm, opening.centerMm[normalAxis]];
    const half: V2 = [opening.sizeMm[0] / 2, opening.sizeMm[1] / 2];
    const lining = list.filter((face) => {
      if (face.planar && Math.abs(face.normal[normalAxis]) > 0.999) return false;
      const b = face.boundsMm;
      return b.min[normalAxis] >= slab[0] - TOL && b.max[normalAxis] <= slab[1] + TOL
        && b.min[alongAxis] >= opening.centerMm[alongAxis] - half[0] - 0.01 && b.max[alongAxis] <= opening.centerMm[alongAxis] + half[0] + 0.01
        && b.min[crossAxis] >= opening.centerMm[crossAxis] - half[1] - 0.01 && b.max[crossAxis] <= opening.centerMm[crossAxis] + half[1] + 0.01;
    });
    const box = union(lining.map((face) => face.boundsMm));
    const ok = !!box && near((box.min[alongAxis] + box.max[alongAxis]) / 2, opening.centerMm[alongAxis]) && near((box.min[crossAxis] + box.max[crossAxis]) / 2, opening.centerMm[crossAxis])
      && near(box.max[alongAxis] - box.min[alongAxis], opening.sizeMm[0]) && near(box.max[crossAxis] - box.min[crossAxis], opening.sizeMm[1]) && near(box.min[normalAxis], slab[0]) && near(box.max[normalAxis], slab[1]);
    checks.add("openings", `${opening.label} on ${opening.wall}: centre ${JSON.stringify(opening.centerMm)}, size ${opening.sizeMm.join(" x ")}`, ok, { centerMm: opening.centerMm, sizeMm: opening.sizeMm }, box ? { center: [alongAxis, crossAxis].map((axis) => r3((box.min[axis]! + box.max[axis]!) / 2)), size: [r3(box.max[alongAxis]! - box.min[alongAxis]!), r3(box.max[crossAxis]! - box.min[crossAxis]!)], faces: lining.length } : null);
    // A rounded-rect whose radius is half its shorter side is built as a slot: two round ends instead of four corners.
    const slotEnds = opening.cornerRadiusMm !== undefined && Math.abs(opening.cornerRadiusMm - Math.min(...opening.sizeMm) / 2) < 1e-9;
    if (opening.cornerRadiusMm) checks.add("openings", `${opening.label}: ${slotEnds ? "two round slot ends" : "four corner cylinders"} r${opening.cornerRadiusMm}`, lining.filter((face) => /cylinder/i.test(face.surfaceType) && face.radiusMm !== null && near(face.radiusMm, opening.cornerRadiusMm!, 1e-6)).length === (slotEnds ? 2 : 4));
  }

  // Vents: two round-end cylinders per slot, at centre +- (length - width) / 2 along the slot direction.
  if (derived.vents) {
    const v = derived.vents as { on: string; centersMm: V3[]; slotDirection: V3; slotWidthMm: number; slotLengthMm: number };
    const list = v.on === "lid" ? lidFaces : baseFaces;
    const ends = list.filter((face) => /cylinder/i.test(face.surfaceType) && face.radiusMm !== null && near(face.radiusMm, v.slotWidthMm / 2, 1e-6));
    const offset = (v.slotLengthMm - v.slotWidthMm) / 2;
    const plane = v.on === "lid" ? [0, 1] : v.on.startsWith("x") ? [1, 2] : [0, 2];
    const expected = v.centersMm.flatMap((center) => [-1, 1].map((sign) => {
      const point = center.map((value, axis) => value + sign * offset * v.slotDirection[axis]!) as V3;
      return [r3(point[plane[0]!]!), r3(point[plane[1]!]!)] as V2;
    }));
    const actual = ends.map((face) => {
      const axisPoint = face.axisOriginMm!;
      return v.on === "lid" ? [r3(axisPoint[0]), r3(axisPoint[1])] as V2 : [r3(axisPoint[plane[0]!]!), r3(face.centerMm[plane[1]!]!)] as V2;
    });
    checks.axesNear("vents", `${v.centersMm.length} slots ${v.slotWidthMm} x ${v.slotLengthMm} (round-end axes)`, actual, expected);
  }
  return checks.list;
}

// Lift the board stand-in straight up in 3 mm steps until its bottom is above the wall top, checking base-board
// interference at the start and after every step; then undo the lifts. derived.assembly.boardDropIn must equal "no
// interference at any step" (an unsupported interference answer fails the check: it proves nothing).
async function liftBoard(client: Client, result: any): Promise<Check[]> {
  const derived = result.derived;
  const { baseId, boardId } = result.bodies as { baseId: number; boardId: number };
  const start = await call(client, "plasticity_status", {});
  const need = derived.wallTopZMm - derived.boardMm.min[2];
  const steps: Array<{ liftedMm: number; status: string }> = [];
  let lifted = 0;
  let revision = start.revision as string;
  let moves = 0;
  for (;;) {
    const interference = await call(client, "plasticity_check_interference", { pairs: [{ firstBodyId: baseId, secondBodyId: boardId }], revision });
    steps.push({ liftedMm: lifted, status: interference.pairs[0].status });
    if (lifted > need) break;
    await call(client, "plasticity_move", { ids: [boardId], deltaMm: [0, 0, 3], intent: "Board-case acceptance: lift the board stand-in 3 mm", revision });
    moves += 1;
    lifted += 3;
    revision = (await call(client, "plasticity_status", {})).revision;
  }
  const now = await call(client, "plasticity_status", {});
  if (moves > 0) await call(client, "plasticity_undo", { steps: moves, intent: "Board-case acceptance: put the board stand-in back", revision: now.revision });
  const back = await call(client, "plasticity_status", {});
  const clear = steps.every((step) => step.status === "no-volumetric-interference");
  const decided = steps.every((step) => step.status === "no-volumetric-interference" || step.status === "interfere");
  return [
    { field: "assembly.boardDropIn", check: `lifting the board in 3 mm steps to ${r3(lifted)} mm (bottom above the wall top): boardDropIn ${derived.assembly.boardDropIn} = no interference at every step`, ok: decided && clear === derived.assembly.boardDropIn, expected: derived.assembly.boardDropIn, actual: steps },
    { field: "assembly.boardDropIn", check: "the lifts were undone (Undo depth and bodies back to the built case)", ok: back.undoDepth === start.undoDepth && sameBodies(back, start), expected: start.undoDepth, actual: back.undoDepth },
  ];
}

// R4 read-back (independent): no plasticity_probe_surface tool exists in this server, so each planned web is probed with a
// small box in the gap it closes (cube side 0.7 x gap / sqrt 2, at most 0.3 mm; 0.4 mm tall) and plasticity_check_interference
// against the base: the intersection must be one Solid with the probe's own bounds (the whole probe is inside base material).
// A control probe in the empty component space must not interfere. The probes are undone with one undo.
async function probeWebs(client: Client, result: any): Promise<Check[]> {
  const derived = result.derived;
  const baseId = result.bodies.baseId as number;
  const start = await call(client, "plasticity_status", {});
  const webs = derived.webs as Array<{ label: string; gapMm: number; probeMm: V3 }>;
  const probes = [...webs.map((web) => ({ label: web.label, center: web.probeMm, side: Math.min(0.3, (0.7 * web.gapMm) / Math.SQRT2), expect: "inside" as const })),
    { label: "control: empty component space over the board centre", center: [(derived.boardMm.min[0] + derived.boardMm.max[0]) / 2, (derived.boardMm.min[1] + derived.boardMm.max[1]) / 2, (derived.boardTopZMm + derived.componentTopZMm) / 2] as V3, side: 0.3, expect: "empty" as const }];
  const results: Array<{ label: string; ok: boolean; status: string; bounds?: unknown }> = [];
  let created = 0;
  for (const probe of probes) {
    const before = await call(client, "plasticity_status", {});
    const origin = [probe.center[0] - probe.side / 2, probe.center[1] - probe.side / 2, probe.center[2] - 0.2] as V3;
    await call(client, "plasticity_create_box", { originMm: origin, sizeMm: [probe.side, probe.side, 0.4], intent: "Board-case acceptance: R4 web probe", revision: before.revision });
    created += 1;
    const status = await call(client, "plasticity_status", {});
    const probeId = status.bodies.find((body: any) => !before.bodies.some((old: any) => old.id === body.id))?.id;
    const interference = await call(client, "plasticity_check_interference", { pairs: [{ firstBodyId: baseId, secondBodyId: probeId }], revision: status.revision });
    const pair = interference.pairs[0];
    const box = pair.intersectionBodies?.length === 1 ? pair.intersectionBodies[0].boundsMm : undefined;
    const inside = pair.status === "interfere" && !!box && [0, 1, 2].every((axis) => Math.abs(box.min[axis] - origin[axis]!) <= 1e-3 && Math.abs(box.max[axis] - (origin[axis]! + (axis === 2 ? 0.4 : probe.side))) <= 1e-3);
    results.push({ label: probe.label, ok: probe.expect === "inside" ? inside : pair.status === "no-volumetric-interference", status: pair.status, ...(box ? { bounds: box } : {}) });
  }
  const now = await call(client, "plasticity_status", {});
  if (created > 0) await call(client, "plasticity_undo", { steps: created, intent: "Board-case acceptance: remove the R4 probes", revision: now.revision });
  const back = await call(client, "plasticity_status", {});
  return [
    { field: "webs", check: `R4 read-back: ${webs.length} web probe(s) fully inside base material, the control probe in empty space`, ok: results.every((entry) => entry.ok), actual: results },
    { field: "webs", check: "the probes were undone", ok: back.undoDepth === start.undoDepth && sameBodies(back, start), expected: start.undoDepth, actual: back.undoDepth },
  ];
}

// R3: shift the board stand-in diagonally toward the x-/y- cavity corner: free at 0.9 x cornerGapMm / sqrt 2 per axis,
// interfering at 1.1 x. Only for a case with no boss beside that board corner.
async function shiftCorner(client: Client, result: any): Promise<Check[]> {
  const derived = result.derived;
  const { baseId, boardId } = result.bodies as { baseId: number; boardId: number };
  const start = await call(client, "plasticity_status", {});
  const answers: Array<{ factor: number; status: string }> = [];
  for (const factor of [0.9, 1.1]) {
    const delta = (factor * derived.cornerGapMm) / Math.SQRT2;
    const before = await call(client, "plasticity_status", {});
    await call(client, "plasticity_move", { ids: [boardId], deltaMm: [-delta, -delta, 0], intent: "Board-case acceptance: shift the board toward the corner", revision: before.revision });
    const moved = await call(client, "plasticity_status", {});
    const interference = await call(client, "plasticity_check_interference", { pairs: [{ firstBodyId: baseId, secondBodyId: boardId }], revision: moved.revision });
    answers.push({ factor, status: interference.pairs[0].status });
    await call(client, "plasticity_undo", { steps: 1, intent: "Board-case acceptance: put the board back", revision: moved.revision });
  }
  const back = await call(client, "plasticity_status", {});
  return [
    { field: "cornerGapMm", check: `diagonal shift by 0.9 x and 1.1 x cornerGapMm ${derived.cornerGapMm} / sqrt 2: free, then interfering`, ok: answers[0]!.status === "no-volumetric-interference" && answers[1]!.status === "interfere", expected: ["no-volumetric-interference", "interfere"], actual: answers },
    { field: "cornerGapMm", check: "the shifts were undone", ok: back.undoDepth === start.undoDepth && sameBodies(back, start), expected: start.undoDepth, actual: back.undoDepth },
  ];
}

// ----------------------------------------------------------------------------------------------------------- main
async function main(): Promise<void> {
  const options = parseBoardCaseAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const endpoint = process.env.PLASTICITY_CDP_URL;
  if (!endpoint) throw new Error("Refusing: set PLASTICITY_CDP_URL to the isolated instance (http://127.0.0.1:<port>)");
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error("Refusing: PLASTICITY_CDP_URL must be http://127.0.0.1:<port>");
  const output = resolve(options.output!);
  await mkdir(output, { recursive: false, mode: 0o700 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), endpoint, targetId: options.target, cases: {} as Record<string, unknown> };
  const client = await startMcp(endpoint, output);
  let baseline: any;
  try {
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    baseline = await call(client, "plasticity_connect", { targetId: options.target });
    evidence.baseline = summary(baseline);
    const cases = evidence.cases as Record<string, unknown>;
    for (const name of options.cases) {
      const before = await call(client, "plasticity_status", {});
      requireCondition(before.undoDepth === baseline.undoDepth && sameBodies(before, baseline), `Document is not at the baseline before case ${name}`);
      if (name === "rejects") {
        const checks: Check[] = [];
        for (const [label, input, pattern] of REVIEW_REJECTS) {
          const status = await call(client, "plasticity_status", {});
          const response = await client.callTool({ name: "plasticity_create_board_case", arguments: { originMm: [2600, 0, 0], name: "reject", ...input, revision: status.revision } }, undefined, LONG);
          const reply = toolText(response);
          const later = await call(client, "plasticity_status", {});
          const unchanged = later.undoDepth === status.undoDepth && later.bodies.length === status.bodies.length && later.revision === status.revision;
          checks.push({ field: "rejects", check: `refused, nothing changed: ${label}`, ok: "isError" in response && response.isError === true && pattern.test(reply) && unchanged, expected: String(pattern), actual: { reply: reply.slice(0, 300), undoDepth: later.undoDepth, bodies: later.bodies.length } });
        }
        cases[name] = { checks };
        console.log(JSON.stringify({ case: name, inputs: REVIEW_REJECTS.length, passed: checks.filter((check) => check.ok).length, total: checks.length, failedChecks: checks.filter((check) => !check.ok) }));
        continue;
      }
      const args = caseArguments(name);
      const requestBytes = Buffer.byteLength(JSON.stringify(args));
      const startedAt = performance.now();
      const response = await client.callTool({ name: "plasticity_create_board_case", arguments: { ...args, revision: before.revision } }, undefined, LONG);
      const clientMs = Math.round(performance.now() - startedAt);
      const text = toolText(response);
      const after = await call(client, "plasticity_status", {});
      if ("isError" in response && response.isError) throw new Error(`Case ${name} failed: ${text.slice(0, 2_000)}`);
      const result = JSON.parse(text);
      const serverMs = result.timing?.totalMs ?? null;
      const checks = await verifyCase(client, args, result, after.revision);
      const baseFaceCount = (await call(client, "plasticity_find_faces", { revision: after.revision, query: { bodyIds: [result.bodies.baseId] }, limit: 1000 })).matches.length;
      const baseEdgeCount = (await call(client, "plasticity_find_edges", { revision: after.revision, query: { bodyIds: [result.bodies.baseId] }, limit: 1000 })).matches.length;
      if (result.bodies.boardId !== undefined) checks.push(...await liftBoard(client, result));
      checks.push(...await probeWebs(client, result));
      if (result.bodies.boardId !== undefined && (name === "pod" || name === "stack")) checks.push(...await shiftCorner(client, result));
      const measuredDepth = after.undoDepth - before.undoDepth;
      checks.push({ field: "undoSteps", check: "undoSteps equals the measured Undo depth change", ok: result.undoSteps === measuredDepth, expected: measuredDepth, actual: result.undoSteps });
      const expectedIds = [result.bodies.baseId, result.bodies.lidId, ...(result.bodies.boardId !== undefined ? [result.bodies.boardId] : [])].sort((a: number, b: number) => a - b);
      const added = after.bodies.filter((body: any) => !before.bodies.some((old: any) => old.id === body.id));
      checks.push({ field: "bodies", check: "no stray bodies (only base, lid and board added; no Wires)", ok: JSON.stringify(added.map((body: any) => body.id).sort((a: number, b: number) => a - b)) === JSON.stringify(expectedIds) && added.every((body: any) => body.type === "Solid"), expected: expectedIds, actual: added.map((body: any) => ({ id: body.id, type: body.type })) });
      const prefix = args.name as string;
      checks.push({ field: "bodies", check: `bodies named ${prefix}-base, ${prefix}-lid, ${prefix}-board`, ok: added.find((body: any) => body.id === result.bodies.baseId)?.name === `${prefix}-base` && added.find((body: any) => body.id === result.bodies.lidId)?.name === `${prefix}-lid` && (result.bodies.boardId === undefined || added.find((body: any) => body.id === result.bodies.boardId)?.name === `${prefix}-board`), actual: added.map((body: any) => body.name) });
      checks.push({ field: "bodies", check: "baseline bodies untouched", ok: baseline.bodies.every((body: any) => after.bodies.some((now: any) => now.id === body.id)) });
      // Lean batch projection of the same tool's result is exercised by the server tests; here: one batched undo.
      const undo = await client.callTool({ name: "plasticity_batch", arguments: { steps: [{ toolName: "plasticity_undo", arguments: { steps: result.undoSteps } }], detail: "lean" } }, undefined, LONG);
      if ("isError" in undo && undo.isError) throw new Error(`Batch undo failed: ${toolText(undo).slice(0, 1_000)}`);
      const restored = await call(client, "plasticity_status", {});
      checks.push({ field: "undoSteps", check: `one batch undo of ${result.undoSteps} steps restores the document`, ok: restored.undoDepth === baseline.undoDepth && sameBodies(restored, baseline), expected: { undoDepth: baseline.undoDepth, bodies: baseline.bodies.length }, actual: { undoDepth: restored.undoDepth, bodies: restored.bodies.length } });
      cases[name] = { requestBytes, clientMs, serverMs, timing: result.timing ?? null, undoSteps: result.undoSteps, stepCount: result.steps.length, baseFaceCount, baseEdgeCount, bodies: result.bodies, derived: result.derived, checks };
      console.log(JSON.stringify({ case: name, bossStyle: result.derived.bossStyle ?? null, requestBytes, serverMs, clientMs, undoSteps: result.undoSteps, baseFaces: baseFaceCount, baseEdges: baseEdgeCount, passed: checks.filter((check) => check.ok).length, total: checks.length, failedChecks: checks.filter((check) => !check.ok) }));
    }
    const end = await call(client, "plasticity_status", {});
    evidence.end = summary(end);
    // Across styles: the tapered wall top is the hanging wall top plus the reported added height.
    const tapered = cases["benchmark-tapered"] as any;
    const hanging = cases["benchmark-hanging"] as any;
    if (tapered?.derived?.bossTaper && hanging?.derived) {
      tapered.checks.push({ field: "bossTaper.addedHeightMm", check: "added height = tapered wall top - hanging wall top (two live builds)", ok: Math.abs(tapered.derived.bossTaper.addedHeightMm - (tapered.derived.wallTopZMm - hanging.derived.wallTopZMm)) <= TOL, expected: tapered.derived.wallTopZMm - hanging.derived.wallTopZMm, actual: tapered.derived.bossTaper.addedHeightMm });
    }
    // S: the stack case's outer footprint equals the hanging style's for the same 51.5 x 28.3 board (nothing grows).
    const stackCase = cases["stack"] as any;
    if (stackCase?.derived && hanging?.derived) {
      const size = (bounds: Bounds) => [r3(bounds.max[0] - bounds.min[0]), r3(bounds.max[1] - bounds.min[1])];
      stackCase.checks.push({ field: "stack", check: "outer footprint = the hanging benchmark's (two live builds)", ok: JSON.stringify(size(stackCase.derived.outerMm)) === JSON.stringify(size(hanging.derived.outerMm)), expected: size(hanging.derived.outerMm), actual: size(stackCase.derived.outerMm) });
    }
    const allChecks = Object.values(cases).flatMap((entry: any) => entry.checks as Check[]);
    evidence.ok = end.undoDepth === baseline.undoDepth && sameBodies(end, baseline) && allChecks.every((check) => check.ok);
    evidence.completedAt = new Date().toISOString();
    await writeFile(join(output, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ ok: evidence.ok, baseline: evidence.baseline, end: evidence.end, checks: { passed: allChecks.filter((check) => check.ok).length, total: allChecks.length }, evidence: join(output, "evidence.json") }));
    if (!evidence.ok) process.exitCode = 1;
  } catch (error) {
    evidence.error = (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
    await writeFile(join(output, "failure.json"), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 }).catch(() => {});
    throw error;
  } finally {
    // Restore the baseline: undo whatever this run left above the starting Undo depth.
    try {
      if (baseline) {
        let status = await call(client, "plasticity_status", {});
        if (status.documentToken === baseline.documentToken && status.undoDepth > baseline.undoDepth) {
          status = await call(client, "plasticity_undo", { steps: status.undoDepth - baseline.undoDepth, intent: "Restore the board-case acceptance baseline", revision: status.revision });
        }
        console.error(JSON.stringify({ restored: status.undoDepth === baseline.undoDepth && sameBodies(status, baseline), undoDepth: status.undoDepth, bodies: status.bodies.length }));
      }
    } catch (restoreError) {
      console.error(`Baseline restore failed; inspect the disposable document: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
    }
    await client.close().catch(() => {});
  }
}

async function startMcp(endpoint: string, output: string): Promise<Client> {
  const inherited = Object.fromEntries(["PATH", "HOME", "TMPDIR"].flatMap((key) => typeof process.env[key] === "string" ? [[key, process.env[key]!]] : []));
  const env = {
    ...inherited,
    PLASTICITY_CDP_URL: endpoint,
    PLASTICITY_AUTO_LAUNCH: "0",
    PLASTICITY_HUD: "0",
    PLASTICITY_HUD_NOTIFY: "0",
    PLASTICITY_TIMING: "1",
    PLASTICITY_STRENGTH_ROOT: join(output, "strength-store"),
    PLASTICITY_CONSTRUCTION_HISTORY_ROOT: join(output, "history"),
    PLASTICITY_CODEX_EXECUTABLE: "/nonexistent/codex",
  };
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env, stderr: "pipe" });
  const client = new Client({ name: "plasticity-native-board-case-live", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args }, undefined, LONG);
  const text = toolText(response);
  if ("isError" in response && response.isError) throw new Error(`${name}: ${text.slice(0, 2_000)}`);
  return JSON.parse(text);
}

function toolText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content");
  const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string");
  if (!item) throw new Error("MCP tool returned no text result");
  return item.text;
}

function sameBodies(left: any, right: any): boolean {
  const key = (state: any) => JSON.stringify(state.bodies.map((body: any) => [body.id, body.type]).sort((a: number[], b: number[]) => a[0]! - b[0]!));
  return key(left) === key(right);
}
function summary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, bodyCount: state.bodies.length }; }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
