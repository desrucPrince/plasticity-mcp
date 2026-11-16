#!/usr/bin/env node
// Live acceptance for plasticity_create_board_case. Builds three cases on an isolated Plasticity and checks every
// `derived` field against INDEPENDENT reads (find_faces / find_edges with limit 1000, validate_bodies,
// check_interference, parallel planar face clearance; never describe_body). After each case one batched undo of the
// measured undoSteps must restore the document. A forced native failure (a corner fillet that cannot be built) must
// undo itself. The script refuses to run without PLASTICITY_CDP_URL on 127.0.0.1 and restores the baseline in finally.
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

export const BOARD_CASES = ["benchmark", "audit", "pod", "failure"] as const;
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

Builds the three board cases at x >= 2000 mm, verifies every derived field with independent reads, undoes each case with
one batched undo of the measured undoSteps, forces one native failure and checks that it undid itself. The document's
Undo depth and body count are restored. Run only against an isolated instance (npm run start:plasticity-isolated).`;

// ------------------------------------------------------------------------------------------------- the three cases
const HOLES_BENCHMARK = [[2.6, 2.6], [48.9, 2.6], [2.6, 25.7], [48.9, 25.7]].map(([xMm, yMm]) => ({ xMm, yMm, diameterMm: 3 }));
export function caseArguments(name: CaseName): Record<string, unknown> {
  if (name === "benchmark") {
    // The multi-part benchmark's board: 51.5 x 28.3 x 1.6, four Ø3 holes, 8 mm parts, 4 mm standoffs with Ø2.5 pilots,
    // a 9.2 x 3.4 r1.2 opening centred on the x- wall 1.6 mm above the board top, four M3 countersunk lid screws into
    // Ø2.5 pilots, a five-slot lid vent, board stand-in.
    return {
      originMm: [2000, 0, 0],
      board: { lengthMm: 51.5, widthMm: 28.3, holes: HOLES_BENCHMARK, componentHeightMm: 8 },
      standoffs: { heightMm: 4, fastener: { screw: "M3", mode: "pilot", pilotDiameterMm: 2.5 } },
      lid: { fasteners: { screw: "M3", base: "pilot", pilotDiameterMm: 2.5, pilotDepthMm: 6 } },
      openings: [{ wall: "x-", shape: "rounded-rect", widthMm: 9.2, heightMm: 3.4, cornerRadiusMm: 1.2, alongMm: 14.15, aboveBoardMm: 1.6, label: "usb" }],
      vents: { on: "lid", slots: 5, slotWidthMm: 2, slotLengthMm: 12, pitchMm: 4 },
      boardStandIn: true,
      name: "esp",
    };
  }
  if (name === "audit") {
    // The audit enclosure equivalent: cavity 76 x 46 gives an 80 x 50 outer with 2 mm walls, 25 mm tall base; heat-set
    // inserts in the standoffs (M2.5 x 4) and in the lid bosses (M3 x 3); a 12 x 6 r2 opening on the y- wall.
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
  // A small sensor pod: 17.8 x 15.2 x 1.6 board, no holes (friction fit, 0.15 mm clearance), a 10 x 4 notch on the x+
  // wall, lid without screws. (The failure case reuses it with an outer corner radius the fillet cannot build.)
  const pod = {
    originMm: [2200, 0, 0],
    board: { lengthMm: 17.8, widthMm: 15.2, componentHeightMm: 3 },
    fit: { boardClearanceMm: 0.15 },
    boardStandIn: true,
  };
  if (name === "failure") {
    // Passes validation (every dimension positive) but the 1e-6 mm board stand-in is below the kernel's resolution, so
    // its native box fails late in the build, after the base and the lid exist.
    return { ...pod, board: { ...pod.board, thicknessMm: 0.000001 }, name: "fail" };
  }
  return { ...pod, openings: [{ wall: "x+", shape: "rect", widthMm: 10, heightMm: 4, alongMm: 7.6, aboveBoardMm: -0.5, label: "notch" }], name: "pod" };
}

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

  // Solids and validity.
  const validation = await call(client, "plasticity_validate_bodies", { ids, revision });
  checks.add("bodies", "base, lid (and board) are native-valid printable Solids", validation.bodies.length === ids.length && validation.bodies.every((body: any) => body.nativeValid && body.printableSolid), ids, validation.bodies.map((body: any) => ({ id: body.id, nativeValid: body.nativeValid, printableSolid: body.printableSolid })));

  // outerMm: bounds of every base face; the four outer corners keep the outer radius.
  checks.boundsNear("outerMm", "union of the base's face bounds", union(baseFaces.map((face) => face.boundsMm)), derived.outerMm);
  const outerRadius = (args.walls as { outerCornerRadiusMm?: number } | undefined)?.outerCornerRadiusMm ?? 3;
  checks.add("outerMm", `four outer corner cylinders r${outerRadius} on the base`, cylinders(baseFaces, outerRadius).filter((face) => near(face.boundsMm.min[2], derived.outerMm.min[2]) && near(face.boundsMm.max[2], derived.outerMm.max[2])).length === 4);
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
  checks.add("innerCornerRadiusMm", `inner corner cylinders r${derived.innerCornerRadiusMm} start at the floor`, derived.innerCornerRadiusMm === 0 || cylinders(baseFaces, derived.innerCornerRadiusMm).filter((face) => near(face.boundsMm.min[2], derived.floorTopZMm)).length === 4);

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
  checks.near("lipOuterMm", "lid bounds min z = lip bottom", union(lidFaces.map((face) => face.boundsMm))?.min[2], lip.min[2]);
  checks.add("componentTopZMm", "lip bottom is headroom (1 mm) above the component top", lip.min[2] - derived.componentTopZMm >= 1 - TOL, 1, r3(lip.min[2] - derived.componentTopZMm));
  // Lid lip clearance per side, measured face to face.
  const lc = (args.fit as { lidClearanceMm?: number } | undefined)?.lidClearanceMm ?? 0.2;
  for (const [index, [label, normal, coordinate, axis]] of lipFaces.entries()) {
    const lipFace = planar(lidFaces, normal, coordinate, axis).filter((face) => near(face.boundsMm.min[2], lip.min[2]))[0];
    const wall = planar(baseFaces, walls[index]![1], walls[index]![2], walls[index]![3])[0];
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

  // Lid bosses: hanging corner posts, their holes, the coaxial lid holes and countersinks.
  if (fasteners.lid) {
    const l = fasteners.lid;
    // Inside the cavity only: the outer corner rounds can share the boss radius but run from the base bottom.
    const posts = cylinders(baseFaces, l.bossDiameterMm / 2).filter((face) => near(face.boundsMm.max[2], derived.wallTopZMm) && face.boundsMm.min[2] > derived.floorTopZMm + TOL);
    checks.axesNear("lidBossAxesMm", `corner boss cylinders Ø${l.bossDiameterMm}`, uniqueAxes(posts), derived.lidBossAxesMm);
    checks.add("lidBossBottomZMm", "corner bosses start at the derived bottom z", posts.length > 0 && posts.every((face) => near(face.boundsMm.min[2], derived.lidBossBottomZMm)), derived.lidBossBottomZMm, posts.map((face) => r3(face.boundsMm.min[2])));
    checks.add("componentTopZMm", "corner boss bottom is headroom (1 mm) above the component top", derived.lidBossBottomZMm - derived.componentTopZMm >= 1 - TOL);
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
  } else {
    checks.add("lidBossAxesMm", "no lid fasteners requested, none derived", derived.lidBossAxesMm.length === 0);
  }

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
    const bc = (args.fit as { boardClearanceMm?: number } | undefined)?.boardClearanceMm ?? 0.5;
    const boardSides: Array<[V3, number, 0 | 1]> = [[[-1, 0, 0], derived.boardMm.min[0], 0], [[1, 0, 0], derived.boardMm.max[0], 0], [[0, -1, 0], derived.boardMm.min[1], 1], [[0, 1, 0], derived.boardMm.max[1], 1]];
    for (const [index, [normal, coordinate, axis]] of boardSides.entries()) {
      const side = planar(boardFaces, normal, coordinate, axis)[0];
      const wall = planar(baseFaces, walls[index]![1], walls[index]![2], walls[index]![3])[0];
      if (!side || !wall) { checks.add("boardMm", `board clearance ${walls[index]![0]}`, false, bc, "faces missing"); continue; }
      const measured = await call(client, "plasticity_measure_parallel_planar_face_clearance", { first: { bodyId: boardId, faceId: side.id }, second: { bodyId: baseId, faceId: wall.id }, revision });
      checks.near("boardMm", `board to wall ${walls[index]![0]} clearance = boardClearance`, measured.minimumDistanceMm, bc);
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
    if (opening.cornerRadiusMm) checks.add("openings", `${opening.label}: four corner cylinders r${opening.cornerRadiusMm}`, lining.filter((face) => /cylinder/i.test(face.surfaceType) && face.radiusMm !== null && near(face.radiusMm, opening.cornerRadiusMm!, 1e-6)).length === 4);
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
      const args = caseArguments(name);
      const requestBytes = Buffer.byteLength(JSON.stringify(args));
      const startedAt = performance.now();
      const response = await client.callTool({ name: "plasticity_create_board_case", arguments: { ...args, revision: before.revision } }, undefined, LONG);
      const clientMs = Math.round(performance.now() - startedAt);
      const text = toolText(response);
      const after = await call(client, "plasticity_status", {});
      if (name === "failure") {
        const failed = "isError" in response && response.isError === true;
        const checks: Check[] = [
          { field: "failure", check: "the call fails", ok: failed, actual: text.slice(0, 600) },
          { field: "failure", check: "the error names the failed stage and the undo", ok: /failed in stage "[^"]+" after \d+ confirmed native steps; undid \d+ native steps; the document matches the start/.test(text), actual: text.slice(0, 400) },
          { field: "failure", check: "undo depth back at the baseline", ok: after.undoDepth === baseline.undoDepth, expected: baseline.undoDepth, actual: after.undoDepth },
          { field: "failure", check: "bodies back at the baseline", ok: sameBodies(after, baseline), expected: baseline.bodies.length, actual: after.bodies.length },
        ];
        const steps = Number(/after (\d+) confirmed native steps/.exec(text)?.[1] ?? NaN);
        const undone = Number(/undid (\d+) native steps/.exec(text)?.[1] ?? NaN);
        checks.push({ field: "failure", check: "native steps were done before the failure and all were undone", ok: steps > 0 && undone === steps, expected: steps, actual: undone });
        cases[name] = { requestBytes, clientMs, error: text.slice(0, 1_500), checks };
        console.log(JSON.stringify({ case: name, requestBytes, clientMs, passed: checks.filter((check) => check.ok).length, total: checks.length, failedChecks: checks.filter((check) => !check.ok) }));
        continue;
      }
      if ("isError" in response && response.isError) throw new Error(`Case ${name} failed: ${text.slice(0, 2_000)}`);
      const result = JSON.parse(text);
      const serverMs = result.timing?.totalMs ?? null;
      const checks = await verifyCase(client, args, result, after.revision);
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
      cases[name] = { requestBytes, clientMs, serverMs, timing: result.timing ?? null, undoSteps: result.undoSteps, stepCount: result.steps.length, bodies: result.bodies, derived: result.derived, checks };
      console.log(JSON.stringify({ case: name, requestBytes, serverMs, clientMs, undoSteps: result.undoSteps, passed: checks.filter((check) => check.ok).length, total: checks.length, failedChecks: checks.filter((check) => !check.ok) }));
    }
    const end = await call(client, "plasticity_status", {});
    evidence.end = summary(end);
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
