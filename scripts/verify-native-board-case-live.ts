#!/usr/bin/env node
// Live acceptance for plasticity_create_board_case. Builds the board cases on an isolated Plasticity and checks every
// `derived` field against INDEPENDENT reads (find_faces / find_edges with limit 1000, validate_bodies,
// check_interference, parallel planar face clearance; never describe_body), including the read-back the recipe itself
// reports (base bounds = outerMm, lid bounds = lidMm, closed and valid, no edge under 0.05 mm). Each case with a board
// stand-in also lifts the board straight up in 3 mm steps until it clears the wall top and checks base-board interference
// at every step: derived.assembly.boardDropIn must equal "no interference at any step". After each case one batched undo
// of the measured undoSteps must restore the document. The "rejects" case sends the reviewer's bad inputs, each of which
// must be refused with the Undo depth, the body count and the revision unchanged (the former forced native failure, a
// 1e-6 mm board, is now refused in the plan and sits in that list). Every built case also gets the R4 web probes; the pod,
// the stack case, the benchmark (floor) and the first D2 case get the diagonal corner-gap shift (D5).
// Follow-up: "d2-holes-3-auto" and "esp32" (screw auto, no pilot keys) must build as stacks with the default post
// diameter inside the lid lip, a standoff under every hole, coaxial posts, a board that lifts out and no interference.
// Round 4: the reviewer's three D2 inputs (a standoff under every hole, measured; the board rests on them); "lip-corner"
// (D3: a line of probe boxes through the lip corner, all inside lid material); and "tangents" (D1: 49 near-tangent
// inputs, the reviewer's own among them, each built, read back and undone; a late failure fails the run). The script refuses to run without
// PLASTICITY_CDP_URL on 127.0.0.1 and restores the baseline in finally; its last line states the Undo depth and the body
// count it leaves.
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

export const BOARD_CASES = ["benchmark", "benchmark-tapered", "benchmark-hanging", "audit", "pod", "lip-notch", "openings", "corner-holes", "stack", "inserts", "d2-holes-3", "d2-holes-3.2", "d2-inserts", "d2-holes-3-auto", "esp32", "lip-corner", "tangents", "final-fixes", "foreign-wires", "rejects"] as const;
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
builds two-opening walls, the corner-hole board (floor and stack) and an insert case, the three default inputs that
used to leave the board on nothing (a support post under every hole), the first of them with screw auto and the typical
ESP32 call (both stacks by default: Ø4.5 posts inside the lid lip, default pilots), a stack whose posts sit 0.3 mm from two lip sides
(probed through the lip corner), 49 near-tangent inputs (each built, read back and undone), the final-fix inputs (W2 to
W8: each built, with the warnings, the recess and the screw length it must report), the typical call with the reviewer's
two foreign closed Wires on the web profile plane (each must fail in stage "webs" and leave the Wire untouched; W1), and
sends the reviewer's bad
inputs (each refused with nothing changed). The document's Undo depth and body count are restored. Run only against an
isolated instance (npm run start:plasticity-isolated).`;

// ------------------------------------------------------------------------------------------------- the cases
const HOLES_BENCHMARK = [[2.6, 2.6], [48.9, 2.6], [2.6, 25.7], [48.9, 25.7]].map(([xMm, yMm]) => ({ xMm, yMm, diameterMm: 3 }));
// Four holes the same distance from the board edges.
const cornerHoles = (length: number, width: number, diameterMm: number, inset: number) => [[inset, inset], [length - inset, inset], [inset, width - inset], [length - inset, width - inset]].map(([xMm, yMm]) => ({ xMm, yMm, diameterMm }));
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
    // (2.6 mm in, Ø3), M2.5 screws (Ø3 passes its 2.7 close fit; M3's 3.2 does not), Ø5 standoffs 8 mm tall with Ø2.1 x 7
    // pilots (round 4, D9: a standard 20 mm screw fits), plain lid holes, a usb opening on the short x- end and a button on the long y- wall.
    const at = name === "stack" ? 2.6 : 2;
    const holes = [[at, at], [51.5 - at, at], [at, 28.3 - at], [51.5 - at, 28.3 - at]].map(([xMm, yMm]) => ({ xMm, yMm, diameterMm: 3 }));
    const usb = { wall: "x-", shape: "rounded-rect", widthMm: 9.2, heightMm: 3.4, cornerRadiusMm: 1.2, alongMm: 14.15, aboveBoardMm: 1.6, label: "usb" };
    if (name === "corner-holes") return { originMm: [2500, 0, 0], board: { lengthMm: 51.5, widthMm: 28.3, holes, componentHeightMm: 8 }, standoffs: { fastener: { screw: "M3", mode: "pilot", pilotDiameterMm: 2.5 } }, lid: { fasteners: { screw: "M3", base: "pilot", pilotDiameterMm: 2.5, pilotDepthMm: 6 } }, openings: [usb], boardStandIn: true, name: "corner" };
    return { originMm: [2600, 0, 0], board: { lengthMm: 51.5, widthMm: 28.3, holes, componentHeightMm: 8 }, standoffs: { heightMm: 8, outerDiameterMm: 5 }, lid: { fasteners: { screw: "M2.5", base: "pilot", pilotDiameterMm: 2.1, pilotDepthMm: 7, countersunk: false } }, openings: [usb, { wall: "y-", shape: "rect", widthMm: 6, heightMm: 3, alongMm: 25.75, aboveBoardMm: 1, label: "button" }], vents: { on: "lid", slots: 5, slotWidthMm: 2, slotLengthMm: 12, pitchMm: 4 }, boardStandIn: true, name: "stack" };
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
  if (name === "d2-holes-3" || name === "d2-holes-3.2" || name === "d2-inserts") {
    // D2: the reviewer's three default inputs (no standoffs key, no bossStyle): the 51.5 x 28.3 board with four holes
    // 2.0 mm from the edges and M3 lid screws. Each falls back to floor bosses and must put a plain support post under
    // every hole.
    const holes = cornerHoles(51.5, 28.3, name === "d2-holes-3.2" ? 3.2 : 3, 2);
    const fasteners = name === "d2-inserts" ? { screw: "M3", base: "heat-set-insert", insertLengthMm: 3 } : { screw: "M3", base: "pilot", pilotDiameterMm: 2.5, pilotDepthMm: 6 };
    return { originMm: [name === "d2-holes-3" ? 2800 : name === "d2-holes-3.2" ? 2900 : 3000, 0, 0], board: { lengthMm: 51.5, widthMm: 28.3, holes, componentHeightMm: 8 }, lid: { fasteners }, boardStandIn: true, name: name === "d2-holes-3" ? "d2a" : name === "d2-holes-3.2" ? "d2b" : "d2c" };
  }
  if (name === "d2-holes-3-auto") {
    // Follow-up F2/F3: the first D2 input with screw "auto" and the pilot keys left out. M2.5 passes the Ø3 holes and the
    // default post (Ø4.5) fits inside the lid lip, so it builds as a stack.
    return { originMm: [3300, 0, 0], board: { lengthMm: 51.5, widthMm: 28.3, holes: cornerHoles(51.5, 28.3, 3, 2), componentHeightMm: 8 }, lid: { fasteners: { screw: "auto", base: "pilot" } }, boardStandIn: true, name: "d2s" };
  }
  if (name === "esp32") {
    // Follow-up F3: a typical ESP32 dev board call with as few keys as the schema allows: the board, its four Ø3 holes
    // 2.0 mm in, the USB opening on a short end, screw "auto" and base "pilot". boardStandIn is added only so that the
    // board can be measured and lifted out; no name (the bodies are case-base, case-lid, case-board).
    return { originMm: [3400, 0, 0], board: { lengthMm: 51.5, widthMm: 28.3, holes: cornerHoles(51.5, 28.3, 3, 2), componentHeightMm: 8 }, lid: { fasteners: { screw: "auto", base: "pilot" } }, openings: [{ wall: "x-", shape: "rect", widthMm: 9.2, heightMm: 3.4, alongMm: 14.15, aboveBoardMm: 0 }], boardStandIn: true };
  }
  if (name === "lip-corner") {
    // D3: Ø6.2 lid posts 0.3 mm from both lip faces of their corner (holes 4.3 mm in). Round 3 left a 0.3 x 0.3 mm pit
    // between the two side webs at each lip corner.
    return { originMm: [3100, 0, 0], board: { lengthMm: 60, widthMm: 30, holes: cornerHoles(60, 30, 3.2, 4.3), componentHeightMm: 8 }, standoffs: { heightMm: 8 }, lid: { fasteners: { screw: "M3", base: "pilot", pilotDiameterMm: 2.5, pilotDepthMm: 7 } }, boardStandIn: true, name: "lipc" };
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

// D1: near-tangent inputs (a feature within 0.06 mm of touching a wall, a lip face or another feature, or exactly
// tangent). Bands a, b and c are the reviewer's; d to g put the other styles on a tangent position. Every one must plan,
// build, pass the read-back and undo cleanly.
export function tangentSample(): Array<[string, Record<string, unknown>]> {
  const origin = [3200, 0, 0];
  const m3 = { screw: "M3", base: "pilot", pilotDiameterMm: 2.5, pilotDepthMm: 6 };
  const sample: Array<[string, Record<string, unknown>]> = [];
  // a: stack, Ø6.2 lid posts tangent to both lip faces of their corner at 4.0 mm in.
  for (const inset of [3.95, 3.99, 3.999, 4, 4.001, 4.01, 4.03, 4.049, 4.06, 4.3]) sample.push([`a: lid post and lip, holes ${inset} mm in`, { originMm: origin, board: { lengthMm: 60, widthMm: 30, holes: cornerHoles(60, 30, 3.2, inset), componentHeightMm: 8 }, standoffs: { heightMm: 8 }, lid: { fasteners: { ...m3, pilotDepthMm: 7 } } }]);
  // b: floor with standoffs.fastener, Ø6 standoffs tangent to their y wall at 2.5 mm in (and 0.02 mm from the floor boss).
  // 2.49, 2.5, 2.51 and 2.56 are the reviewer's own inputs (tan249 to tan256), board stand-in included.
  for (const inset of [2.45, 2.49, 2.499, 2.5, 2.501, 2.51, 2.53, 2.549, 2.56]) {
    const literal = [2.49, 2.5, 2.51, 2.56].includes(inset);
    sample.push([`b: standoff and wall, holes ${inset} mm in${literal ? ` (the reviewer's tan${Math.round(inset * 100)})` : ""}`, { originMm: origin, board: { lengthMm: 51.5, widthMm: 28.3, holes: cornerHoles(51.5, 28.3, 3, inset), componentHeightMm: 8 }, standoffs: { fastener: { screw: "M2.5", mode: "pilot", pilotDiameterMm: 2.1 } }, lid: { fasteners: m3 }, ...(literal ? { boardStandIn: true } : {}) }]);
  }
  // c: the strip between a standoff and a floor boss (round 3: 0.0019 and 0.0356 mm edges).
  for (const [length, width] of [[35, 25.4], [25, 18]] as const) for (const [diameter, screw, pilot, head] of [[2.2, "M2", 1.6, 3.8], [2.7, "M2.5", 2.1, 4.7]] as const) for (const inset of [2.45, 2.5, 2.55]) sample.push([`c: standoff and floor boss, ${length} x ${width}, Ø${diameter} holes ${inset} mm in`, { originMm: origin, board: { lengthMm: length, widthMm: width, holes: cornerHoles(length, width, diameter, inset), componentHeightMm: 8 }, standoffs: { heightMm: 5, fastener: { screw, mode: "pilot", pilotDiameterMm: pilot } }, lid: { fasteners: { screw, base: "pilot", pilotDiameterMm: pilot, pilotDepthMm: 5, headDiameterMm: head } } }]);
  // d: the default with no standoffs key: Ø6 support posts tangent to their y wall.
  for (const inset of [2.49, 2.5, 2.51]) sample.push([`d: support post and wall, holes ${inset} mm in`, { originMm: origin, board: { lengthMm: 51.5, widthMm: 28.3, holes: cornerHoles(51.5, 28.3, 3, inset), componentHeightMm: 8 }, lid: { fasteners: m3 } }]);
  // e, f: hung bosses; Ø6 standoffs tangent to both walls of their corner.
  for (const inset of [2.49, 2.5, 2.51, 2.53]) sample.push([`e: standoff and two walls, hanging, holes ${inset} mm in`, { originMm: origin, board: { lengthMm: 60, widthMm: 40, holes: cornerHoles(60, 40, 3, inset), componentHeightMm: 8 }, standoffs: { fastener: { screw: "M2.5", mode: "pilot", pilotDiameterMm: 2.1 } }, lid: { fasteners: { ...m3, bossStyle: "hanging", allowBlockedBoard: true } } }]);
  for (const inset of [2.49, 2.5, 2.51]) sample.push([`f: standoff and two walls, tapered, holes ${inset} mm in`, { originMm: origin, board: { lengthMm: 60, widthMm: 40, holes: cornerHoles(60, 40, 3, inset), componentHeightMm: 8 }, standoffs: { fastener: { screw: "M2.5", mode: "pilot", pilotDiameterMm: 2.1 } }, lid: { fasteners: { ...m3, bossStyle: "tapered", allowBlockedBoard: true } } }]);
  // g: stack, two holes on the board's centre line: Ø5 posts tangent to one lip face at 3.4 mm in.
  for (const inset of [3.39, 3.4, 3.41, 3.43]) sample.push([`g: lid post and one lip face, holes ${inset} mm in`, { originMm: origin, board: { lengthMm: 51.5, widthMm: 28.3, holes: [{ xMm: inset, yMm: 14.15, diameterMm: 3 }, { xMm: 51.5 - inset, yMm: 14.15, diameterMm: 3 }], componentHeightMm: 8 }, standoffs: { heightMm: 8, outerDiameterMm: 5 }, lid: { fasteners: { screw: "M2.5", base: "pilot", pilotDiameterMm: 2.1, pilotDepthMm: 7, countersunk: false } } }]);
  // The reviewer's own stack inputs, unchanged (6 mm standoffs, 6 mm pilots): round 3 picked the stack and failed late
  // (b2in, 4.0 mm in, and b5 with two openings: Boolean error) or in the read-back (lip403: a 0.03 mm edge). They are
  // stacks again: an 18 mm screw is a stocked length (follow-up F1). (The reviewer's "true default" input, defStack,
  // is in the rejects since W8: its 2 mm pilots hold no screw.)
  for (const [name, inset] of [["b2in", 4], ["lip403", 4.03], ["lip406", 4.06]] as const) sample.push([`reviewer's ${name}: 60 x 30, holes ${inset} mm in, standoffs.heightMm 6, Ø2.5 x 6 pilots`, { originMm: origin, board: { lengthMm: 60, widthMm: 30, holes: cornerHoles(60, 30, 3.2, inset), componentHeightMm: 8 }, standoffs: { heightMm: 6 }, lid: { fasteners: m3 }, boardStandIn: true }]);
  sample.push(["reviewer's b5: 60 x 30, holes 4 mm in, standoffs.heightMm 6, Ø2.5 x 6 pilots, openings on x- and y+", { originMm: origin, board: { lengthMm: 60, widthMm: 30, holes: cornerHoles(60, 30, 3.2, 4), componentHeightMm: 8 }, standoffs: { heightMm: 6 }, lid: { fasteners: m3 }, openings: [{ wall: "x-", shape: "rounded-rect", widthMm: 9.5, heightMm: 3.6, cornerRadiusMm: 1, alongMm: 15, aboveBoardMm: 0, label: "usb-c" }, { wall: "y+", shape: "rect", widthMm: 12, heightMm: 5, alongMm: 30, aboveBoardMm: 0.5, label: "side" }], boardStandIn: true }]);
  return sample;
}

// The reviewer's bad inputs (60 x 40 board, 8 mm parts unless stated); every one must be refused before any edit.
const reviewBoard = (extra: Record<string, unknown> = {}) => ({ lengthMm: 60, widthMm: 40, componentHeightMm: 8, ...extra });
const reviewLid = (extra: Record<string, unknown> = {}) => ({ fasteners: { screw: "M3", base: "pilot", pilotDiameterMm: 2.5, pilotDepthMm: 6, ...extra } });
// Final fixes: the reviewer's inputs for W2 to W5 and W7 (the typical call is the 51.5 x 28.3 board with four Ø3 holes
// 2.0 mm in, a USB-C opening on x-, screw auto and base pilot).
const W_USB = { wall: "x-", shape: "rounded-rect", widthMm: 9.5, heightMm: 3.6, cornerRadiusMm: 1, alongMm: 14.15, aboveBoardMm: 0, label: "usb-c" };
const W4_INPUT = { board: { lengthMm: 20, widthMm: 15, holes: [{ xMm: 2.5, yMm: 4.5, diameterMm: 3 }, { xMm: 17.5, yMm: 4.5, diameterMm: 3 }, { xMm: 2.5, yMm: 10.5, diameterMm: 3 }, { xMm: 17.5, yMm: 10.5, diameterMm: 3 }], componentHeightMm: 8 }, lid: { fasteners: { screw: "M2.5", base: "pilot", pilotDiameterMm: 2.05, pilotDepthMm: 6, headDiameterMm: 4.7, bossStyle: "floor" } } };
const wBare = (opening: Record<string, unknown>) => ({ board: { lengthMm: 51.5, widthMm: 28.3, componentHeightMm: 8 }, openings: [{ wall: "y-", shape: "rect", widthMm: 6, heightMm: 4, label: "o", ...opening }] });
export const TYPICAL_CALL = { originMm: [2000, 0, 0], board: { lengthMm: 51.5, widthMm: 28.3, holes: cornerHoles(51.5, 28.3, 3, 2), componentHeightMm: 8 }, lid: { fasteners: { screw: "auto", base: "pilot" } }, openings: [W_USB], boardStandIn: true };
// The volumes of the typical call in a clean document, as the kernel measured them before the final fixes (the base
// is the reviewer's 10,980.395 mm3).
export const TYPICAL_VOLUMES_MM3 = { base: 10980.395366, lid: 4324.735657 };
// The reviewer's two foreign closed Wires on the web profile plane (z 1.5): A crosses a web outline (a notch and a
// 0.727 mm air gap beside standoff 0), C lies inside it (a 0.4 x 0.4 mm shaft). Both gave "completed" before W1.
const square = (x0: number, y0: number, x1: number, y1: number, z: number) => [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];
export const FOREIGN_WIRES: Array<[string, number[][]]> = [
  ["A: a square crossing the web outline beside standoff 0", square(2002.55, 6.15, 2003.75, 7.35, 1.5)],
  ["C: a square inside the web outline", square(2002.2, 6.2, 2002.6, 6.6, 1.5)],
];
// Inputs that must build (each is built, read back and undone like a near-tangent input), with what the reply must say.
export function finalFixBuilds(): Array<[string, Record<string, unknown>, (result: any) => string | undefined]> {
  const origin = [3500, 0, 0];
  const bare = { lengthMm: 51.5, widthMm: 28.3, componentHeightMm: 8 };
  const typical = (fasteners: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ ...TYPICAL_CALL, originMm: origin, lid: { fasteners: { screw: "auto", base: "pilot", ...fasteners } }, ...extra });
  const unfastened = (cause: RegExp) => (result: any) => result.derived.bossStyle === "floor" && result.derived.fasteners.lid.screw === "M3" && result.derived.fasteners.standoffs.mode === "support" && result.warnings.length === 1 && /^the board is not fastened by screws: /.test(result.warnings[0]) && cause.test(result.warnings[0]) ? undefined : JSON.stringify([result.derived.bossStyle, result.warnings]);
  return [
    ["W3: walls.outerCornerRadiusMm 2.2 (wall 2 + lid clearance 0.2): the lid lip corner is square", { originMm: origin, board: bare, walls: { outerCornerRadiusMm: 2.2 } }, (result) => result.derived.innerCornerRadiusMm === 0.2 ? undefined : `inner radius ${result.derived.innerCornerRadiusMm}`],
    ["W3: radius 2.6 with wall 2.4", { originMm: origin, board: bare, walls: { wallMm: 2.4, outerCornerRadiusMm: 2.6 } }, (result) => result.derived.innerCornerRadiusMm === 0.2 ? undefined : `inner radius ${result.derived.innerCornerRadiusMm}`],
    ["W3: radius 3.2 with wall 3", { originMm: origin, board: bare, walls: { wallMm: 3, outerCornerRadiusMm: 3.2 } }, (result) => result.derived.innerCornerRadiusMm === 0.2 ? undefined : `inner radius ${result.derived.innerCornerRadiusMm}`],
    ["W4: the refused input with standoffs.outerDiameterMm 5", { originMm: origin, ...W4_INPUT, standoffs: { outerDiameterMm: 5 } }, () => undefined],
    ["W4: the refused input with the named change (holes 0.35 mm toward the centre along x)", { originMm: origin, ...W4_INPUT, board: { ...W4_INPUT.board, holes: W4_INPUT.board.holes.map((hole) => ({ ...hole, xMm: hole.xMm < 10 ? 2.85 : 17.15 })) } }, () => undefined],
    ["W5: the opening edge exactly on the outer corner arc start (alongMm 3.5, the named value)", { originMm: origin, ...wBare({ alongMm: 3.5, aboveBoardMm: 0.5 }) }, () => undefined],
    ["W5: the opening edge 0.4 mm past the arc start (alongMm 3.9)", { originMm: origin, ...wBare({ alongMm: 3.9, aboveBoardMm: 0.5 }) }, () => undefined],
    ["W5: the opening bottom exactly on the floor top (aboveBoardMm -1.6, the named value)", { originMm: origin, ...wBare({ alongMm: 20, aboveBoardMm: -1.6 }) }, () => undefined],
    ["W5: the opening bottom 0.4 mm above the floor top (aboveBoardMm -1.2)", { originMm: origin, ...wBare({ alongMm: 20, aboveBoardMm: -1.2 }) }, () => undefined],
    ["W2: floor bosses, openings on x- and y+, growAxis x: the USB opening is recessed 6 mm, noted and warned", { originMm: origin, board: { lengthMm: 51.5, widthMm: 28.3, holes: cornerHoles(51.5, 28.3, 3.2, 2), componentHeightMm: 8 }, lid: { fasteners: { screw: "auto", base: "pilot", growAxis: "x" } }, openings: [W_USB, { wall: "y+", shape: "rect", widthMm: 6, heightMm: 3, alongMm: 25, aboveBoardMm: 0.5, label: "btn" }], boardStandIn: true },
      (result) => result.derived.openings[0].recessMm === 6 && /stands 6 mm from the board edge/.test(result.derived.openings[0].recessNote ?? "") && result.derived.openings[1].recessMm === 0.5 && result.derived.openings[1].recessNote === undefined && result.warnings.length === 2 && /^usb-c on wall x- is recessed: /.test(result.warnings[1]) ? undefined : JSON.stringify([result.derived.openings, result.warnings])],
    ["W7: the typical call: a fastened stack, no warnings", typical(), (result) => result.derived.bossStyle === "stack" && result.warnings.length === 0 ? undefined : JSON.stringify([result.derived.bossStyle, result.warnings])],
    ["W7: the typical call with countersunk: true: floor bosses, the board unfastened, warned", typical({ countersunk: true }), unfastened(/countersunk head diameter for M2\.5 is not sourced .* set countersunk: false/)],
    ["W7: the typical call with pilotDiameterMm 2.5", typical({ pilotDiameterMm: 2.5 }), unfastened(/pilotDiameterMm 2\.5 is not smaller than the M2\.5 thread .* leave pilotDiameterMm out/)],
    ["W7: the typical call with standoffs.heightMm 3", typical({}, { standoffs: { heightMm: 3 } }), unfastened(/exceeds the standoff height 3; raise standoffs\.heightMm to 7\.9 or leave it out/)],
    ["W8: floor bosses report the screw (lid 2 + pilot 6: a 6 mm screw, bottoming at 8)", { originMm: origin, board: { lengthMm: 51.5, widthMm: 28.3, holes: cornerHoles(51.5, 28.3, 3.2, 4.5), componentHeightMm: 8 }, lid: { fasteners: { screw: "M3", base: "pilot", pilotDiameterMm: 2.5, pilotDepthMm: 6, bossStyle: "floor" } }, boardStandIn: true }, (result) => result.derived.fasteners.lid.screwLengthMm === 6 && result.derived.fasteners.lid.screwLengthMaxMm === 8 && result.derived.fasteners.lid.engagementMm === 4 ? undefined : JSON.stringify(result.derived.fasteners.lid)],
  ];
}

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
  // Round 4.
  // (Follow-up F1: with 6 mm pilots an 18 mm screw now fits, so this reject uses 3 mm pilots.)
  ["D9: a stack with no stocked screw length (3 mm pilots)", { board: reviewBoard({ holes: cornerHoles(60, 40, 3.2, 4.5) }), lid: reviewLid({ bossStyle: "stack", pilotDepthMm: 3 }) }, /no standard screw length fits the stack: it needs between 16\.1 and 16\.1 mm .*stocked lengths 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 30, 35, 40\); use lid\.fasteners\.pilotDepthMm 4\.9 for a stocked 18 mm screw .*, or use board\.componentHeightMm 7\.9 for a stocked 16 mm screw/],
  ["D2: an underside clearance on a board without holes", { board: reviewBoard({ undersideClearanceMm: 3 }) }, /board\.undersideClearanceMm needs standoffs: a board without holes has none and rests on the floor/],
  // (Final fixes, W8: the reviewer's "true default" input, 2 mm pilots, was a floor case in the near-tangent sample; a
  // 2 mm pilot holds no screw in a stack or in a corner boss, so it is refused.)
  ["W8: the reviewer's defStack (2 mm pilots hold no screw: no stack, and no corner-boss screw)", { board: { lengthMm: 60, widthMm: 30, holes: cornerHoles(60, 30, 3.2, 5), componentHeightMm: 8 }, lid: reviewLid({ pilotDepthMm: 2 }), boardStandIn: true }, /no standard screw length fits the lid bosses: it needs between 4 and 3 mm \(lid 2 mm, at least 2 mm in the 2 mm boss hole, 1 mm tip clearance; .*use lid\.fasteners\.pilotDepthMm 3 for a stocked 4 mm screw.*the default bossStyle fell back to "floor" because a screw stack is not possible/],
  // Final fixes W2, W4, W5 (the reviewer's inputs).
  ["W2: floor fallback with openings on x- and y+ (Ø3.2 holes 2.0 mm in): both growAxis values plan", { board: { lengthMm: 51.5, widthMm: 28.3, holes: cornerHoles(51.5, 28.3, 3.2, 2), componentHeightMm: 8 }, lid: { fasteners: { screw: "auto", base: "pilot" } }, openings: [W_USB, { wall: "y+", shape: "rect", widthMm: 6, heightMm: 3, alongMm: 25, aboveBoardMm: 0.5, label: "btn" }] }, /openings sit on both x walls \(x-\) and y walls \(y\+\), so pass lid\.fasteners\.growAxis "x" or "y" to choose which walls move \(both plan\) \(the default bossStyle fell back to "floor" because a screw stack is not possible/],
  ["W2: the same with the y+ opening near a corner: only growAxis x plans", { board: { lengthMm: 51.5, widthMm: 28.3, holes: cornerHoles(51.5, 28.3, 3.2, 2), componentHeightMm: 8 }, lid: reviewLid({ bossStyle: "floor" }), openings: [W_USB, { wall: "y+", shape: "rect", widthMm: 6, heightMm: 3, alongMm: 6, aboveBoardMm: 0.5, label: "btn" }] }, /so pass lid\.fasteners\.growAxis "x" \(it plans; "y" does not: btn on wall y\+ collides with lid boss 2\)/],
  ["W4: webs that touch at a single point, with the nearest change", W4_INPUT, /the webs that close the narrow gaps touch at a single point, which cannot be built as one solid; move board\.holes\[0\] 0\.35 mm toward the board centre along x \(to xMm 2\.85\), and board\.holes\[1\], board\.holes\[2\], board\.holes\[3\] the same way: that plans clean/],
  ["W5: an opening flush with the board corner (it would cut the rounded outer corner)", wBare({ alongMm: 3, aboveBoardMm: 0.5 }), /its edge is 0\.5 mm from the cavity corner, where the corner arcs start at 0\.5 and 1 mm; an edge must sit exactly on an arc start or keep 0\.4 mm from it .*; use alongMm 3\.5/],
  ["W5: alongMm 3.01 (a 0.01 mm strip beside the corner fillet)", wBare({ alongMm: 3.01, aboveBoardMm: 0.5 }), /its edge is 0\.51 mm from the cavity corner, .*; use alongMm 3\.5/],
  ["W5: aboveBoardMm -1.59 (a 0.01 mm step above the floor)", wBare({ alongMm: 20, aboveBoardMm: -1.59 }), /its bottom edge is 0\.01 mm above the floor top; it must sit exactly on the floor top or at least 0\.4 mm above it .*; use aboveBoardMm -1\.6/],
  ["W8: corner bosses with a 2.5 mm pilot (no stocked screw)", { board: reviewBoard(), lid: reviewLid({ bossStyle: "floor", pilotDepthMm: 2.5 }) }, /no standard screw length fits the lid bosses: it needs between 4 and 3\.5 mm .*; use lid\.fasteners\.pilotDepthMm 3 for a stocked 4 mm screw/],
  ["D2: screw auto with board holes under the M2 close fit", { board: reviewBoard({ holes: cornerHoles(60, 40, 2, 4.5) }), lid: { fasteners: { screw: "auto", base: "pilot", pilotDiameterMm: 1.6, pilotDepthMm: 6.9, bossStyle: "stack", countersunk: false } } }, /lid\.fasteners\.screw "auto": no screw passes the smallest board hole \(Ø2\)/],
  ["D1: a strip side 0.0005 mm off a face of its own web (holes 1.999 mm in): refused with the nearest clean hole position", { board: { lengthMm: 35.7, widthMm: 37, holes: cornerHoles(35.7, 37, 2.2, 1.999), componentHeightMm: 6 }, walls: { wallMm: 2.4 }, standoffs: { fastener: { screw: "M2", mode: "pilot", pilotDiameterMm: 1.6 } }, lid: { fasteners: { screw: "M2", base: "pilot", pilotDiameterMm: 1.6, pilotDepthMm: 7, bossStyle: "floor", headDiameterMm: 3.8 } } }, /would have an edge under 0\.001 mm .* move board\.holes\[0\] 0\.05 mm toward the board centre along x \(to xMm 2\.049\), and board\.holes\[2\] the same way: that plans clean/],
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
    // D2: a standoff under every board hole, on the hole's axis (from the arguments and the board's measured bounds).
    const holeAxes = (((args.board as { holes?: Array<{ xMm: number; yMm: number }> }).holes) ?? []).map((hole) => [r3(derived.boardMm.min[0] + hole.xMm), r3(derived.boardMm.min[1] + hole.yMm)] as V2);
    checks.axesNear("standoffAxesMm", `D2: a standoff cylinder under each of the ${holeAxes.length} board holes (floor top to board bottom)`, uniqueAxes(outer), holeAxes);
    if (s.mode === "support") {
      // Plain support posts: no hole. No smaller cylinder face shares a standoff axis at or below the standoff top.
      const bores = baseFaces.filter((face) => /cylinder/i.test(face.surfaceType) && face.radiusMm !== null && face.axisOriginMm && face.axisDirection && Math.abs(Math.abs(face.axisDirection[2]) - 1) < 1e-6 && face.boundsMm.max[2] <= derived.standoffTopZMm + TOL && holeAxes.some((axis, index) => near(face.axisOriginMm![0], axis[0]) && near(face.axisOriginMm![1], axis[1]) && face.radiusMm! < s.outerDiametersMm[index] / 2 - TOL));
      checks.add("fasteners.standoffs", "support posts (no standoffs.fastener): no hole in any standoff", bores.length === 0 && s.holeDiameterMm === 0 && s.screw === undefined, 0, bores.map((face) => ({ id: face.id, radiusMm: face.radiusMm })));
    } else {
      const holes = cylinders(baseFaces, s.holeDiameterMm / 2).filter((face) => near(face.boundsMm.max[2], derived.standoffTopZMm));
      checks.axesNear("standoffAxesMm", `standoff holes Ø${s.holeDiameterMm} (${s.mode}, ${s.source.slice(0, 24)}...)`, uniqueAxes(holes), derived.standoffAxesMm);
      const bottom = s.mode === "through" ? derived.outerMm.min[2] : derived.standoffTopZMm - s.holeDepthMm;
      checks.add("fasteners.standoffs", `standoff hole depth ${s.holeDepthMm} (bottom z ${r3(bottom)})`, holes.length > 0 && holes.every((face) => near(face.boundsMm.min[2], bottom) || (s.mode === "through" && face.boundsMm.min[2] <= derived.floorTopZMm + TOL)), bottom, holes.map((face) => r3(face.boundsMm.min[2])));
    }
    checks.near("standoffTopZMm", "standoff top faces", planar(baseFaces, [0, 0, 1], derived.standoffTopZMm, 2)[0]?.boundsMm.min[2], derived.standoffTopZMm);
  } else {
    // A board without holes has no standoffs and rests on the floor top (D2).
    checks.add("standoffAxesMm", "no board holes: no standoffs derived, and the board bottom is the floor top", derived.standoffAxesMm.length === 0 && ((args.board as { holes?: unknown[] }).holes ?? []).length === 0 && near(derived.boardMm.min[2], derived.floorTopZMm), derived.floorTopZMm, derived.boardMm.min[2]);
  }

  // Stack (S): lid posts over the board holes, coaxial lid clearance holes, posts 0.2 mm above the board.
  if (derived.bossStyle === "stack") {
    const st = derived.stack as { postAxesMm: V2[]; postOuterDiametersMm: number[]; postBottomZMm: number; holeDiameterMm: number };
    const postFaces = [...new Set(st.postOuterDiametersMm)].flatMap((od) => cylinders(lidFaces, od / 2)).filter((face) => near(face.boundsMm.min[2], st.postBottomZMm));
    checks.axesNear("stack", "lid post cylinders end at the post bottom, on the board-hole axes", uniqueAxes(postFaces), st.postAxesMm);
    const clearance = cylinders(lidFaces, st.holeDiameterMm / 2).filter((face) => near(face.boundsMm.min[2], st.postBottomZMm) || near(face.boundsMm.max[2], derived.lidTopZMm));
    checks.axesNear("stack", `lid clearance holes Ø${st.holeDiameterMm} coaxial with the posts (post bottom to lid top)`, uniqueAxes(clearance), st.postAxesMm);
    // With a countersink the cylinder ends where the cone starts (round 4: the stack case has plain holes, the lip-corner case countersinks).
    const holeTop = derived.lidTopZMm - (fasteners.lid.countersink?.depthMm ?? 0);
    checks.add("stack", fasteners.lid.countersink ? "the clearance holes run from the post bottom to the countersink under the lid top" : "the clearance holes run from the post bottom to the lid top", near(Math.min(...clearance.map((face) => face.boundsMm.min[2])), st.postBottomZMm) && near(Math.max(...clearance.map((face) => face.boundsMm.max[2])), holeTop), [st.postBottomZMm, holeTop], clearance.map((face) => [r3(face.boundsMm.min[2]), r3(face.boundsMm.max[2])]));
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
    } else {
      // No standoffs: the board bottom lies on the floor top.
      const floorFace = planar(baseFaces, [0, 0, 1], derived.floorTopZMm, 2)[0];
      const gap = bottom && floorFace ? (await call(client, "plasticity_measure_parallel_planar_face_clearance", { first: { bodyId: boardId, faceId: bottom.id }, second: { bodyId: baseId, faceId: floorFace.id }, revision })).minimumDistanceMm : undefined;
      checks.near("boardMm", "no standoffs: the board rests on the floor top (gap 0)", gap, 0);
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
// Follow-up F2/F3: the two screw-auto cases. From the faces: four lid posts and four standoffs of the default diameter
// on the board-hole axes, every post at least 0.05 mm inside the measured lid lip outline, pilot holes of the default
// tapping-drill diameter and depth, and the defaults listed in derived.
async function stackDefaults(client: Client, result: any, minimalCall: boolean): Promise<Check[]> {
  const derived = result.derived;
  const checks: Check[] = [];
  // (The lift and the probes before this moved and restored bodies: read the revision again.)
  const revision = (await call(client, "plasticity_status", {})).revision as string;
  const lidFaces = (await call(client, "plasticity_find_faces", { revision, query: { bodyIds: [result.bodies.lidId] }, limit: 1000 })).matches as Face[];
  const baseFaces = (await call(client, "plasticity_find_faces", { revision, query: { bodyIds: [result.bodies.baseId] }, limit: 1000 })).matches as Face[];
  checks.push({ field: "bossStyle", check: "F3: the default boss style is the stack", ok: derived.bossStyle === "stack" && String(derived.bossStyleReason).startsWith("default: the lid screws go through the 4 board holes"), expected: "stack", actual: [derived.bossStyle, derived.bossStyleReason] });
  const od = derived.fasteners.standoffs.outerDiametersMm[0] as number;
  const upright = (face: Face) => /cylinder/i.test(face.surfaceType) && face.radiusMm !== null && !!face.axisOriginMm && !!face.axisDirection && Math.abs(Math.abs(face.axisDirection[2]) - 1) < 1e-6;
  const posts = lidFaces.filter((face) => upright(face) && Math.abs(face.radiusMm! - od / 2) <= TOL && Math.abs(face.boundsMm.min[2] - derived.stack.postBottomZMm) <= TOL);
  const standoffs = baseFaces.filter((face) => upright(face) && Math.abs(face.radiusMm! - od / 2) <= TOL && Math.abs(face.boundsMm.max[2] - derived.standoffTopZMm) <= TOL);
  const axesOf = (faces: Face[]) => [...new Set(faces.map((face) => `${r3(face.axisOriginMm![0])},${r3(face.axisOriginMm![1])}`))].sort();
  const holeAxes = (derived.standoffAxesMm as V2[]).map((axis) => `${r3(axis[0])},${r3(axis[1])}`).sort();
  checks.push({ field: "fasteners.standoffs", check: `F2: four lid posts and four standoffs Ø${od} (the default), coaxial, on the board-hole axes`, ok: od === 4.5 && JSON.stringify(axesOf(posts)) === JSON.stringify(holeAxes) && JSON.stringify(axesOf(standoffs)) === JSON.stringify(holeAxes) && holeAxes.length === 4, expected: holeAxes, actual: { od, posts: axesOf(posts), standoffs: axesOf(standoffs) } });
  // The lid lip's outer faces, measured: the vertical planar lid faces farthest out below the lid plate.
  const lipBand = lidFaces.filter((face) => face.planar && Math.abs(face.normal[2]) < 1e-6 && face.boundsMm.max[2] <= derived.wallTopZMm + TOL && face.boundsMm.min[2] >= derived.lipOuterMm.min[2] - TOL);
  const side = (axis: 0 | 1, sign: 1 | -1) => { const values = lipBand.filter((face) => Math.abs(face.normal[axis] - sign) < 1e-6).map((face) => face.centerMm[axis]); return values.length === 0 ? Number.NaN : sign > 0 ? Math.max(...values) : Math.min(...values); };
  const lip = { min: [side(0, -1), side(1, -1)], max: [side(0, 1), side(1, 1)] };
  const inside = posts.map((face) => r3(Math.min(face.axisOriginMm![0] - lip.min[0]!, lip.max[0]! - face.axisOriginMm![0], face.axisOriginMm![1] - lip.min[1]!, lip.max[1]! - face.axisOriginMm![1]) - face.radiusMm!));
  checks.push({ field: "fasteners.standoffs", check: "F2: every lid post stays 0.05 mm or more inside the measured lid lip outline", ok: inside.length >= 4 && inside.every((value) => value >= 0.05 - TOL) && Math.abs(lip.min[0]! - derived.lipOuterMm.min[0]) <= TOL && Math.abs(lip.max[1]! - derived.lipOuterMm.max[1]) <= TOL, expected: ">= 0.05", actual: { inside, lip } });
  checks.push({ field: "fasteners.standoffs", check: "F2: derived says why the diameter was chosen", ok: /^default: Ø4\.5, the largest \(in 0\.1 mm steps\) that keeps the lid post 0\.05 mm inside the lid lip outline \(board hole \+ 3 would be Ø6\)$/.test(derived.fasteners.standoffs.outerDiameterReason ?? ""), actual: derived.fasteners.standoffs.outerDiameterReason });
  const pilots = baseFaces.filter((face) => upright(face) && Math.abs(face.radiusMm! - 2.05 / 2) <= TOL && Math.abs(face.boundsMm.max[2] - derived.standoffTopZMm) <= TOL);
  checks.push({ field: "fasteners.lid", check: "F3: screw auto took M2.5; the default pilots are Ø2.05 x 6.9 in every standoff (measured), for a stocked 20 mm screw; the lid holes are plain", ok: derived.fasteners.lid.screw === "M2.5" && JSON.stringify(axesOf(pilots)) === JSON.stringify(holeAxes) && pilots.every((face) => Math.abs(face.boundsMm.min[2] - (derived.standoffTopZMm - 6.9)) <= TOL) && derived.stack.screwLengthMm === 20 && derived.fasteners.lid.countersink === undefined && derived.fasteners.lid.baseHole.confidence === "low", expected: { screw: "M2.5", pilot: [2.05, 6.9], screwLengthMm: 20 }, actual: { screw: derived.fasteners.lid.screw, pilots: axesOf(pilots), bottoms: pilots.map((face) => r3(face.boundsMm.min[2])), screwLengthMm: derived.stack.screwLengthMm } });
  checks.push({ field: "fasteners.lid", check: "F3: derived lists the three defaults (pilot diameter, pilot depth, plain lid holes)", ok: JSON.stringify((derived.fasteners.lid.defaults ?? []).map((entry: string) => entry.split(":")[0])) === JSON.stringify(["pilotDiameterMm 2.05", "pilotDepthMm 6.9", "countersunk false"]), actual: derived.fasteners.lid.defaults });
  const size = [r3(derived.outerMm.max[0] - derived.outerMm.min[0]), r3(derived.outerMm.max[1] - derived.outerMm.min[1]), r3(derived.outerMm.max[2] - derived.outerMm.min[2])];
  checks.push({ field: "outerMm", check: "F3: outer size 56.5 x 33.3 x 22 (the read-back check compares it with the base bounds)", ok: JSON.stringify(size) === JSON.stringify([56.5, 33.3, 22]), expected: [56.5, 33.3, 22], actual: size });
  if (minimalCall) checks.push({ field: "openings", check: "F3: the USB opening is cut (one opening derived on wall x-)", ok: derived.openings.length === 1 && derived.openings[0].wall === "x-", actual: derived.openings });
  return checks;
}

// W1: the native volumes of the finished base and lid (plasticity_measure_solid_properties, independent of the recipe's
// own read) against result.readBack.volumesMm3: measured equal, and equal to the predicted volume where there is one.
async function independentVolumes(client: Client, result: any, revision: string): Promise<{ ok: boolean; base: number; lid: number; predicted: boolean; unpredicted?: string; note?: string; actual: unknown }> {
  const read = await call(client, "plasticity_measure_solid_properties", { ids: [result.bodies.baseId, result.bodies.lidId], revision });
  const [base, lid] = [read.bodies.find((body: any) => body.id === result.bodies.baseId)?.volumeMm3 as number, read.bodies.find((body: any) => body.id === result.bodies.lidId)?.volumeMm3 as number];
  const reported = result.readBack?.volumesMm3;
  const close = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-6 * Math.abs(b);
  const each = (measured: number, entry: any) => !!entry && close(entry.measured, measured) && (entry.predicted === undefined ? typeof entry.note === "string" : close(measured, entry.predicted));
  const ok = !!reported && each(base, reported.base) && each(lid, reported.lid);
  const unpredicted = reported?.base?.predicted === undefined ? "base" : reported?.lid?.predicted === undefined ? "lid" : undefined;
  return { ok, base, lid, predicted: unpredicted === undefined, ...(unpredicted ? { unpredicted, note: String(reported?.[unpredicted]?.note).slice(0, 80) } : {}), actual: { base: { native: base, readBack: reported?.base }, lid: { native: lid, readBack: reported?.lid } } };
}

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
  // A web that closes no gap (it joins two features that touch or overlap: round 4) is probed with the smallest box.
  const probes = [...webs.map((web) => ({ label: web.label, center: web.probeMm, side: Math.max(0.06, Math.min(0.3, (0.7 * web.gapMm) / Math.SQRT2)), expect: "inside" as const })),
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

// D3 read-back (independent): a line of probe boxes (0.06 mm cubes, 0.4 mm tall, at the lip's mid height) through the lip
// corner beside the first lid post: from 0.15 mm inside the lip, across the corner and the square where round 3 left a pit
// between the two side webs, to 0.2 mm inside the post, every 0.1 mm along the diagonal. Each box must lie wholly inside
// lid material (plasticity_check_interference: one intersection Solid with the probe's own bounds). A control box in the
// empty cavity under the lid must not touch it. The probes are undone with one undo.
async function probeLipCorner(client: Client, result: any): Promise<Check[]> {
  const derived = result.derived;
  const lidId = result.bodies.lidId as number;
  const start = await call(client, "plasticity_status", {});
  const lip = derived.lipInnerMm as Bounds;
  const z = (lip.min[2] + lip.max[2]) / 2;
  const post = derived.stack.postAxesMm[0] as V2;
  const radius = derived.stack.postOuterDiametersMm[0] / 2;
  const length = Math.hypot(post[0] - lip.min[0], post[1] - lip.min[1]);
  const direction: V2 = [(post[0] - lip.min[0]) / length, (post[1] - lip.min[1]) / length];
  const probes: Array<{ label: string; center: V3; expect: "inside" | "empty" }> = [];
  for (let along = -0.15; along <= length - radius + 0.2 + 1e-9; along += 0.1) probes.push({ label: `${r3(along)} mm from the lip corner toward the post`, center: [lip.min[0] + direction[0] * along, lip.min[1] + direction[1] * along, z], expect: "inside" });
  probes.push({ label: "control: the empty cavity over the board centre, at the lip's height", center: [(derived.boardMm.min[0] + derived.boardMm.max[0]) / 2, (derived.boardMm.min[1] + derived.boardMm.max[1]) / 2, z], expect: "empty" });
  const side = 0.06;
  const results: Array<{ label: string; ok: boolean; status: string }> = [];
  let created = 0;
  for (const probe of probes) {
    const before = await call(client, "plasticity_status", {});
    const origin = [probe.center[0] - side / 2, probe.center[1] - side / 2, probe.center[2] - 0.2] as V3;
    await call(client, "plasticity_create_box", { originMm: origin, sizeMm: [side, side, 0.4], intent: "Board-case acceptance: D3 lip corner probe", revision: before.revision });
    created += 1;
    const status = await call(client, "plasticity_status", {});
    const probeId = status.bodies.find((body: any) => !before.bodies.some((old: any) => old.id === body.id))?.id;
    const pair = (await call(client, "plasticity_check_interference", { pairs: [{ firstBodyId: lidId, secondBodyId: probeId }], revision: status.revision })).pairs[0];
    const box = pair.intersectionBodies?.length === 1 ? pair.intersectionBodies[0].boundsMm : undefined;
    const inside = pair.status === "interfere" && !!box && [0, 1, 2].every((axis) => Math.abs(box.min[axis] - origin[axis]!) <= 1e-3 && Math.abs(box.max[axis] - (origin[axis]! + (axis === 2 ? 0.4 : side))) <= 1e-3);
    results.push({ label: probe.label, ok: probe.expect === "inside" ? inside : pair.status === "no-volumetric-interference", status: pair.status });
  }
  const now = await call(client, "plasticity_status", {});
  if (created > 0) await call(client, "plasticity_undo", { steps: created, intent: "Board-case acceptance: remove the D3 probes", revision: now.revision });
  const back = await call(client, "plasticity_status", {});
  return [
    { field: "stack.lidWebs", check: `D3: ${probes.length - 1} probe boxes on a line through the lip corner (lip, corner, former pit, web, post) are all inside lid material; the control box in the cavity is not`, ok: results.every((entry) => entry.ok), actual: results },
    { field: "stack.lidWebs", check: "D3: the probes were undone", ok: back.undoDepth === start.undoDepth && sameBodies(back, start), expected: start.undoDepth, actual: back.undoDepth },
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
      if (name === "tangents") {
        // D1: every near-tangent input builds, passes the read-back and is undone; a late failure (or a plan refusal)
        // fails its check.
        const checks: Check[] = [];
        const builds: Array<Record<string, unknown>> = [];
        let lateFailures = 0;
        let refusedInPlan = 0;
        const sample = tangentSample();
        for (const [label, input] of sample) {
          const status = await call(client, "plasticity_status", {});
          const startedAt = performance.now();
          const response = await client.callTool({ name: "plasticity_create_board_case", arguments: { ...input, name: "tan", revision: status.revision } }, undefined, LONG);
          const reply = toolText(response);
          const after = await call(client, "plasticity_status", {});
          if ("isError" in response && response.isError) {
            const stage = /failed in stage "([^"]+)"/.exec(reply)?.[1];
            if (stage) lateFailures += 1; else refusedInPlan += 1;
            checks.push({ field: "tangents", check: `builds: ${label}`, ok: false, expected: "completed", actual: { failed: stage ? `late, in stage ${stage}` : "refused in the plan", reply: reply.slice(0, 400), undoDepth: after.undoDepth, bodies: after.bodies.length } });
            if (after.undoDepth > status.undoDepth) await call(client, "plasticity_undo", { steps: after.undoDepth - status.undoDepth, intent: "Board-case acceptance: clear a failed near-tangent case", revision: after.revision });
            continue;
          }
          const result = JSON.parse(reply);
          const added = after.bodies.filter((body: any) => !status.bodies.some((old: any) => old.id === body.id));
          const bodyCount = input.boardStandIn ? 3 : 2;
          const holeCount = ((input.board as { holes?: unknown[] }).holes ?? []).length;
          const sound = result.status === "completed" && result.undoSteps === after.undoDepth - status.undoDepth && result.undoSteps === result.derived.plannedUndoSteps
            && result.readBack.bodies.length === bodyCount && result.readBack.bodies.every((body: any) => body.closed && body.nativeValid) && result.readBack.minEdgeMm >= 0.05
            && added.length === bodyCount && added.every((body: any) => body.type === "Solid") && result.derived.standoffAxesMm.length === holeCount;
          const undo = await client.callTool({ name: "plasticity_batch", arguments: { steps: [{ toolName: "plasticity_undo", arguments: { steps: result.undoSteps } }], detail: "lean" } }, undefined, LONG);
          const restored = await call(client, "plasticity_status", {});
          const undone = !("isError" in undo && undo.isError) && restored.undoDepth === baseline.undoDepth && sameBodies(restored, baseline);
          const build = { label, bossStyle: result.derived.bossStyle ?? null, standoffs: `${result.derived.fasteners.standoffs?.mode} x ${result.derived.standoffAxesMm.length}`, undoSteps: result.undoSteps, minEdgeMm: result.readBack.minEdgeMm, webs: result.derived.webs.length, lidWebs: result.derived.stack?.lidWebs.length ?? 0, clientMs: Math.round(performance.now() - startedAt) };
          builds.push(build);
          checks.push({ field: "tangents", check: `builds, reads back (closed, valid, no edge under 0.05 mm, ${result.undoSteps} planned = measured steps, a standoff per hole) and one batch undo restores the document: ${label}`, ok: sound && undone, actual: build });
        }
        const minEdgeMm = Math.min(...builds.map((build) => build.minEdgeMm as number));
        checks.push({ field: "tangents", check: `D1: ${sample.length} near-tangent inputs, zero late failures, zero plan refusals`, ok: sample.length >= 40 && lateFailures === 0 && refusedInPlan === 0 && builds.length === sample.length, expected: { inputs: sample.length, lateFailures: 0, refusedInPlan: 0 }, actual: { built: builds.length, lateFailures, refusedInPlan } });
        cases[name] = { inputs: sample.length, built: builds.length, lateFailures, refusedInPlan, minEdgeMm, builds, checks };
        console.log(JSON.stringify({ case: name, inputs: sample.length, built: builds.length, lateFailures, refusedInPlan, minEdgeMm, undoSteps: builds.map((build) => build.undoSteps), passed: checks.filter((check) => check.ok).length, total: checks.length, failedChecks: checks.filter((check) => !check.ok) }));
        continue;
      }
      if (name === "final-fixes") {
        // W2 to W8: every input builds, reads back (volumes included), says what it must and is undone.
        const checks: Check[] = [];
        const list = finalFixBuilds();
        for (const [label, input, expect] of list) {
          const status = await call(client, "plasticity_status", {});
          const response = await client.callTool({ name: "plasticity_create_board_case", arguments: { ...input, name: "fix", revision: status.revision } }, undefined, LONG);
          const reply = toolText(response);
          const after = await call(client, "plasticity_status", {});
          if ("isError" in response && response.isError) {
            checks.push({ field: "final-fixes", check: `builds: ${label}`, ok: false, expected: "completed", actual: { reply: reply.slice(0, 500), undoDepth: after.undoDepth } });
            if (after.undoDepth > status.undoDepth) await call(client, "plasticity_undo", { steps: after.undoDepth - status.undoDepth, intent: "Board-case acceptance: clear a failed final-fix case", revision: after.revision });
            continue;
          }
          const result = JSON.parse(reply);
          const volumes = await independentVolumes(client, result, after.revision);
          const said = expect(result);
          const sound = result.status === "completed" && result.undoSteps === after.undoDepth - status.undoDepth && result.readBack.bodies.every((body: any) => body.closed && body.nativeValid) && result.readBack.minEdgeMm >= 0.05 && Array.isArray(result.warnings);
          const undo = await client.callTool({ name: "plasticity_batch", arguments: { steps: [{ toolName: "plasticity_undo", arguments: { steps: result.undoSteps } }], detail: "lean" } }, undefined, LONG);
          const restored = await call(client, "plasticity_status", {});
          const undone = !("isError" in undo && undo.isError) && restored.undoDepth === baseline.undoDepth && sameBodies(restored, baseline);
          checks.push({ field: "final-fixes", check: `builds, reads back (closed, valid, volumes = the plan), says what it must and is undone: ${label}`, ok: sound && undone && volumes.ok && said === undefined, actual: { bossStyle: result.derived.bossStyle ?? null, undoSteps: result.undoSteps, minEdgeMm: result.readBack.minEdgeMm, volumes: volumes.actual, warnings: result.warnings.length, ...(said ? { said } : {}) } });
        }
        cases[name] = { inputs: list.length, checks };
        console.log(JSON.stringify({ case: name, inputs: list.length, passed: checks.filter((check) => check.ok).length, total: checks.length, failedChecks: checks.filter((check) => !check.ok) }));
        continue;
      }
      if (name === "foreign-wires") {
        // W1: the typical call in the clean document builds with the same volumes as before the fix. Then, with each
        // of the reviewer's closed Wires on the web profile plane, it must fail in stage "webs" and leave the document
        // as it was before the call: the Undo depth, the bodies, and the foreign Wire with its id and bounds.
        const checks: Check[] = [];
        const start = await call(client, "plasticity_status", {});
        const cleanResponse = await client.callTool({ name: "plasticity_create_board_case", arguments: { ...TYPICAL_CALL, name: "typ", revision: start.revision } }, undefined, LONG);
        const cleanAfter = await call(client, "plasticity_status", {});
        if ("isError" in cleanResponse && cleanResponse.isError) {
          checks.push({ field: "foreign-wires", check: "the typical call builds in the clean document", ok: false, actual: toolText(cleanResponse).slice(0, 600) });
        } else {
          const result = JSON.parse(toolText(cleanResponse));
          const volumes = await independentVolumes(client, result, cleanAfter.revision);
          const same = Math.abs(volumes.base - TYPICAL_VOLUMES_MM3.base) <= 1e-6 * TYPICAL_VOLUMES_MM3.base && Math.abs(volumes.lid - TYPICAL_VOLUMES_MM3.lid) <= 1e-6 * TYPICAL_VOLUMES_MM3.lid;
          checks.push({ field: "foreign-wires", check: `the typical call builds in the clean document with the volumes it had before the fix (base ${TYPICAL_VOLUMES_MM3.base}, lid ${TYPICAL_VOLUMES_MM3.lid} mm3), equal to the plan's prediction, as a stack without warnings`, ok: volumes.ok && same && result.derived.bossStyle === "stack" && result.warnings.length === 0, expected: TYPICAL_VOLUMES_MM3, actual: volumes.actual });
        }
        if (cleanAfter.undoDepth > start.undoDepth) await call(client, "plasticity_undo", { steps: cleanAfter.undoDepth - start.undoDepth, intent: "Board-case acceptance: undo the clean typical build", revision: cleanAfter.revision });
        for (const [label, points] of FOREIGN_WIRES) {
          const before = await call(client, "plasticity_status", {});
          await call(client, "plasticity_create_polyline", { pointsMm: points, closed: true, intent: "Board-case acceptance: a foreign closed Wire on the web profile plane", revision: before.revision });
          const withWire = await call(client, "plasticity_status", {});
          const wire = withWire.bodies.find((body: any) => !before.bodies.some((old: any) => old.id === body.id));
          const response = await client.callTool({ name: "plasticity_create_board_case", arguments: { ...TYPICAL_CALL, name: "typ", revision: withWire.revision } }, undefined, LONG);
          const reply = toolText(response);
          const later = await call(client, "plasticity_status", {});
          const wireNow = later.bodies.find((body: any) => body.id === wire?.id);
          const failed = "isError" in response && response.isError === true && /failed in stage "webs"/.test(reply) && /has a volume of [0-9.]+ mm3, not the planned [0-9.]+ mm3/.test(reply);
          const untouched = later.undoDepth === withWire.undoDepth && sameBodies(later, withWire) && !!wire && wire.type === "Wire" && JSON.stringify(wireNow?.boundsMm) === JSON.stringify(wire.boundsMm) && wireNow?.type === "Wire";
          checks.push({ field: "foreign-wires", check: `W1: with the foreign Wire the call fails in stage "webs" on the web solid's volume; the Undo depth and the bodies are as before the call and the Wire is still there, untouched: ${label}`, ok: failed && untouched, expected: { stage: "webs", undoDepth: withWire.undoDepth, bodies: withWire.bodies.length }, actual: { reply: reply.replace(/\s+/g, " ").slice(0, 420), undoDepth: later.undoDepth, bodies: later.bodies.length, wire: wireNow ? { id: wireNow.id, type: wireNow.type, boundsMm: wireNow.boundsMm } : null } });
          // Remove the foreign Wire again (and anything a wrong success left).
          if (later.undoDepth > before.undoDepth) await call(client, "plasticity_undo", { steps: later.undoDepth - before.undoDepth, intent: "Board-case acceptance: remove the foreign Wire", revision: later.revision });
          const cleared = await call(client, "plasticity_status", {});
          checks.push({ field: "foreign-wires", check: `the document is back at the baseline after the Wire is undone: ${label}`, ok: cleared.undoDepth === baseline.undoDepth && sameBodies(cleared, baseline), actual: { undoDepth: cleared.undoDepth, bodies: cleared.bodies.length } });
        }
        cases[name] = { checks };
        console.log(JSON.stringify({ case: name, wires: FOREIGN_WIRES.length, passed: checks.filter((check) => check.ok).length, total: checks.length, failedChecks: checks.filter((check) => !check.ok) }));
        continue;
      }
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
      // D5: also on two floor cases, where the play is sqrt 2 x the board clearance (the grown axis moves the bosses away).
      if (result.bodies.boardId !== undefined && (name === "pod" || name === "stack" || name === "benchmark" || name === "d2-holes-3")) checks.push(...await shiftCorner(client, result));
      if (name === "lip-corner") checks.push(...await probeLipCorner(client, result));
      if (name === "d2-holes-3-auto" || name === "esp32") checks.push(...await stackDefaults(client, result, name === "esp32"));
      // W1: the reply's volumes against an independent native read and the plan's prediction.
      {
        const volumes = await independentVolumes(client, result, (await call(client, "plasticity_status", {})).revision);
        checks.push({ field: "readBack.volumesMm3", check: `W1: the base and lid volumes in the read-back equal an independent native read${volumes.predicted ? " and the plan's prediction (1e-6 relative)" : ` (the ${volumes.unpredicted} volume is not predicted: ${volumes.note})`}`, ok: volumes.ok, actual: volumes.actual });
      }
      const measuredDepth = after.undoDepth - before.undoDepth;
      checks.push({ field: "undoSteps", check: "undoSteps equals the measured Undo depth change", ok: result.undoSteps === measuredDepth, expected: measuredDepth, actual: result.undoSteps });
      const expectedIds = [result.bodies.baseId, result.bodies.lidId, ...(result.bodies.boardId !== undefined ? [result.bodies.boardId] : [])].sort((a: number, b: number) => a - b);
      const added = after.bodies.filter((body: any) => !before.bodies.some((old: any) => old.id === body.id));
      checks.push({ field: "bodies", check: "no stray bodies (only base, lid and board added; no Wires)", ok: JSON.stringify(added.map((body: any) => body.id).sort((a: number, b: number) => a - b)) === JSON.stringify(expectedIds) && added.every((body: any) => body.type === "Solid"), expected: expectedIds, actual: added.map((body: any) => ({ id: body.id, type: body.type })) });
      const prefix = (args.name as string | undefined) ?? "case";
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
    PLASTICITY_MCP_STATE_DIR: join(output, "state"),
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
