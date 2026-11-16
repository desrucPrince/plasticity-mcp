// plasticity_create_board_case: a two-part enclosure (base + lid) around a rectangular board, built in one call from
// parameters. Every derived dimension is computed here from the parameters (never read back from geometry) and returned
// with the result, so later steps never re-derive a cavity or a boss axis from faces.
//
// The plan (derived numbers, validation, the cutter list) is a pure function: planBoardCase. BoardCaseRecipe composes the
// existing recipes (screw boss, through hole, countersink, connector opening, slotted hole) and a few direct native
// operations, and on a failure part-way undoes its own steps (measured by the Undo depth) before it reports.
import { mutationOutcomeIsUncertain, type RuntimeState } from "./runtime.ts";
import type { PlasticityOperations } from "./operations.ts";
import { PlasticityRecipes, type RecipeOperations, type RecipeStep } from "./recipes.ts";
import {
  CALLER_SOURCE,
  clearanceHole,
  countersunkHead,
  heatSetInsert,
  requirePilotDiameter,
  type ClearanceFit,
  type ScrewSize,
} from "./fastener-presets.ts";

type Vector3 = [number, number, number];
type Vector2 = [number, number];
type Bounds = { min: Vector3; max: Vector3 };
type Rect = { min: Vector2; max: Vector2 };

export type CaseWall = "x-" | "x+" | "y-" | "y+";
export type CaseOpeningFace = CaseWall | "lid" | "floor";
export type CaseOpeningShape = "rect" | "rounded-rect" | "circle";
// How the four lid-screw bosses are carried: hung from the walls with a 45 degree gusset under each ("tapered", the default),
// hung from the walls with a flat underside ("hanging"), or standing on the floor in a wider cavity ("floor").
export type BossStyle = "tapered" | "hanging" | "floor";
export const BOSS_STYLES: readonly BossStyle[] = ["tapered", "hanging", "floor"];
// Self-supporting angle of the taper under a hanging boss, measured from vertical.
export const BOSS_TAPER_ANGLE_DEG = 45;
// The overhang check allows this much above the taper angle for floating-point noise.
export const BOSS_OVERHANG_TOLERANCE_DEG = 1e-6;

// Fixed geometric construction constants (not engineering values): they are stated in the docs and in `derived`.
export const BOARD_CASE_CONSTANTS = {
  // Clear height kept between the tallest component and the lowest lid feature.
  headroomMm: 1,
  // A corner boss overlaps each adjoining wall by this much so it unions with the shell.
  bossWallOverlapMm: 0.5,
  // Closed material kept under a lid-screw hole at the bottom of its corner boss.
  bossFloorMm: 1,
  // Cutters and joined parts run past the faces they meet by this much (no coplanar Booleans).
  overshootMm: 0.5,
} as const;

export interface BoardCaseInput {
  originMm: Vector3;
  board: {
    lengthMm: number;
    widthMm: number;
    thicknessMm?: number | undefined;
    holes?: Array<{ xMm: number; yMm: number; diameterMm: number }> | undefined;
    componentHeightMm: number;
    undersideClearanceMm?: number | undefined;
  };
  fit?: { boardClearanceMm?: number | undefined; lidClearanceMm?: number | undefined } | undefined;
  walls?: { wallMm?: number | undefined; floorMm?: number | undefined; lidMm?: number | undefined; outerCornerRadiusMm?: number | undefined } | undefined;
  standoffs?: {
    heightMm?: number | undefined;
    outerDiameterMm?: number | undefined;
    fastener: {
      screw: ScrewSize;
      mode: "pilot" | "heat-set-insert" | "through";
      pilotDiameterMm?: number | undefined;
      pilotDepthMm?: number | undefined;
      insertLengthMm?: number | undefined;
      clearanceFit?: ClearanceFit | undefined;
    };
  } | undefined;
  lid?: {
    lipDepthMm?: number | undefined;
    lipWallMm?: number | undefined;
    fasteners?: {
      screw: ScrewSize;
      count?: 4 | undefined;
      bossDiameterMm?: number | undefined;
      bossStyle?: BossStyle | undefined;
      countersunk?: boolean | undefined;
      headDiameterMm?: number | undefined;
      base: "pilot" | "heat-set-insert";
      pilotDiameterMm?: number | undefined;
      pilotDepthMm?: number | undefined;
      insertLengthMm?: number | undefined;
      clearanceFit?: ClearanceFit | undefined;
    } | undefined;
  } | undefined;
  openings?: Array<{
    wall: CaseOpeningFace;
    shape: CaseOpeningShape;
    widthMm: number;
    heightMm?: number | undefined;
    cornerRadiusMm?: number | undefined;
    alongMm: number;
    aboveBoardMm?: number | undefined;
    acrossMm?: number | undefined;
    label?: string | undefined;
  }> | undefined;
  vents?: {
    on: "lid" | CaseWall;
    slots: number;
    slotWidthMm: number;
    slotLengthMm: number;
    pitchMm: number;
    centerAlongMm?: number | undefined;
    centerAcrossMm?: number | undefined;
  } | undefined;
  boardStandIn?: boolean | undefined;
  name?: string | undefined;
  exploded?: number | undefined;
  revision: string;
}

export interface BoardCaseOpeningDerived {
  label: string;
  wall: CaseOpeningFace;
  shape: CaseOpeningShape;
  // Centre of the opening on the outer surface it is cut from (lid top, floor bottom or the outer wall face).
  centerMm: Vector3;
  // [width, height]: along the wall and vertical for a wall; along x and along y for the lid and the floor.
  sizeMm: Vector2;
  cornerRadiusMm?: number;
}

export interface BoardCaseDerived {
  outerMm: Bounds;
  cavityMm: Bounds;
  innerCornerRadiusMm: number;
  floorTopZMm: number;
  boardMm: Bounds;
  boardTopZMm: number;
  componentTopZMm: number;
  wallTopZMm: number;
  lidTopZMm: number;
  explodedMm: number;
  standoffAxesMm: Vector2[];
  standoffTopZMm?: number;
  lidBossAxesMm: Vector2[];
  lidBossBottomZMm?: number;
  // Present with lid fasteners.
  bossStyle?: BossStyle;
  // Free space between each board edge and the cavity wall. boardClearance on every side, plus half the cavity growth
  // on the two sides of the grown axis for bossStyle "floor".
  boardWallClearanceMm: { xNeg: number; xPos: number; yNeg: number; yPos: number };
  // bossStyle "floor" only: how much the cavity grew in [x, y] beyond board + 2 x boardClearance.
  cavityGrowthMm?: Vector2;
  // bossStyle "tapered" only. bottomZMm is the lowest point of the taper inside the cavity.
  bossTaper?: { angleDeg: 45; bottomZMm: number; addedHeightMm: number };
  // Present with lid fasteners; says nothing about the rest of the part.
  printability?: { baseOrientation: "floor-down"; maxBossOverhangDeg: number };
  lipOuterMm: Bounds;
  lipInnerMm: Bounds;
  openings: BoardCaseOpeningDerived[];
  vents?: { on: "lid" | CaseWall; centersMm: Vector3[]; slotDirection: Vector3; slotWidthMm: number; slotLengthMm: number };
  fasteners: {
    standoffs?: {
      screw: ScrewSize;
      mode: "pilot" | "heat-set-insert" | "through";
      holeDiameterMm: number;
      holeDepthMm: number;
      outerDiametersMm: number[];
      heightMm: number;
      source: string;
      confidence?: "medium";
      insert?: string;
      minWallMm?: number;
      clearanceFit?: ClearanceFit;
    };
    lid?: {
      screw: ScrewSize;
      base: "pilot" | "heat-set-insert";
      bossDiameterMm: number;
      bossLengthMm: number;
      baseHole: { diameterMm: number; depthMm: number; source: string; confidence?: "medium"; insert?: string; minWallMm?: number };
      lidHole: { diameterMm: number; fit: ClearanceFit; source: string; confidence: "medium" };
      countersink?: { headDiameterMm: number; includedAngleDeg: number; depthMm: number; source: string; confidence?: "medium" };
    };
  };
}

interface CylinderPattern { centersMm: Vector3[]; outerDiameterMm: number; heightMm: number; holeDiameterMm: number; holeDepthMm: number; baseOverlapMm: number }

interface OpeningCut {
  label: string;
  target: "base" | "lid";
  shape: CaseOpeningShape;
  entryCenterMm: Vector3;
  axis: Vector3;
  widthDirection: Vector3;
  widthMm: number;
  heightMm: number;
  cornerRadiusMm: number;
  throughDepthMm: number;
}

export interface BoardCasePlan {
  name: string;
  derived: BoardCaseDerived;
  base: { boxOriginMm: Vector3; boxSizeMm: Vector3; outerRadiusMm: number; cavityOriginMm: Vector3; cavitySizeMm: Vector3; innerRadiusMm: number };
  standoffGroups: CylinderPattern[];
  standoffFloorHoles?: { entryCentersMm: Vector3[]; diameterMm: number; depthMm: number };
  posts?: CylinderPattern;
  // bossStyle "tapered": one clipped cone per corner (apex on the wall corner), joined to the base before the bosses.
  taper?: { cones: Array<{ topCenterMm: Vector3; radiusMm: number; heightMm: number }>; clipOriginMm: Vector3; clipSizeMm: Vector3 };
  lid: {
    plateOriginMm: Vector3;
    plateSizeMm: Vector3;
    plateRadiusMm: number;
    lipOriginMm: Vector3;
    lipSizeMm: Vector3;
    lipRadiusMm: number;
    lipInnerOriginMm: Vector3;
    lipInnerSizeMm: Vector3;
    lipInnerRadiusMm: number;
    notches: Array<{ centerMm: Vector3; radiusMm: number; heightMm: number }>;
    holes?: { entryCentersMm: Vector3[]; diameterMm: number; depthMm: number; countersink?: { majorDiameterMm: number; includedAngleDeg: number } };
  };
  openings: OpeningCut[];
  vents?: { target: "base" | "lid"; entryCentersMm: Vector3[]; axis: Vector3; slotDirection: Vector3; widthMm: number; overallLengthMm: number; throughDepthMm: number };
  board?: { originMm: Vector3; sizeMm: Vector3; holeGroups: Array<{ diameterMm: number; entryCentersMm: Vector3[] }> };
}

export class BoardCaseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardCaseValidationError";
  }
}

const EPS = 1e-9;

// ---------------------------------------------------------------------------------------------------------------------
// Pure plan: defaults, derived dimensions, validation. Throws BoardCaseValidationError (or an unsourced-preset error)
// before any native call.
// ---------------------------------------------------------------------------------------------------------------------

export function deriveBoardCase(input: BoardCaseInput): BoardCaseDerived {
  return planBoardCase(input).derived;
}

export function planBoardCase(input: BoardCaseInput): BoardCasePlan {
  const fail = (message: string): never => { throw new BoardCaseValidationError(message); };
  const positive = (label: string, value: number | undefined): number => {
    if (value === undefined || !Number.isFinite(value) || value <= 0) fail(`${label} must be a positive number of millimetres (got ${String(value)})`);
    return value!;
  };
  const nonnegative = (label: string, value: number): number => {
    if (!Number.isFinite(value) || value < 0) fail(`${label} must be zero or more (got ${String(value)})`);
    return value;
  };
  if (!Array.isArray(input.originMm) || input.originMm.length !== 3 || input.originMm.some((value) => !Number.isFinite(value))) fail("originMm must be three finite numbers");
  const [ox, oy, oz] = input.originMm;
  const name = (input.name ?? "case").trim();
  if (name.length === 0 || name.length > 80) fail("name must be 1 to 80 characters");

  const L = positive("board.lengthMm", input.board.lengthMm);
  const W = positive("board.widthMm", input.board.widthMm);
  const T = positive("board.thicknessMm", input.board.thicknessMm ?? 1.6);
  const Hc = positive("board.componentHeightMm", input.board.componentHeightMm);
  const U = positive("board.undersideClearanceMm", input.board.undersideClearanceMm ?? 2);
  const bc = positive("fit.boardClearanceMm", input.fit?.boardClearanceMm ?? 0.5);
  const lc = positive("fit.lidClearanceMm", input.fit?.lidClearanceMm ?? 0.2);
  const w = positive("walls.wallMm", input.walls?.wallMm ?? 2);
  if (w < 0.8) fail(`walls.wallMm must be at least 0.8 mm (got ${w})`);
  const f = positive("walls.floorMm", input.walls?.floorMm ?? 2);
  const tl = positive("walls.lidMm", input.walls?.lidMm ?? 2);
  const Ro = nonnegative("walls.outerCornerRadiusMm", input.walls?.outerCornerRadiusMm ?? 3);
  const d = positive("lid.lipDepthMm", input.lid?.lipDepthMm ?? 1.5);
  const lw = positive("lid.lipWallMm", input.lid?.lipWallMm ?? 1.2);
  const exploded = nonnegative("exploded", input.exploded ?? 0);
  const { headroomMm, bossWallOverlapMm, bossFloorMm, overshootMm: OV } = BOARD_CASE_CONSTANTS;

  const holes = input.board.holes ?? [];
  if (holes.length > 32) fail("board.holes takes at most 32 holes");
  holes.forEach((hole, index) => {
    const r = positive(`board.holes[${index}].diameterMm`, hole.diameterMm) / 2;
    if (![hole.xMm, hole.yMm].every(Number.isFinite)) fail(`board.holes[${index}] position must be finite`);
    if (hole.xMm - r <= 0 || hole.xMm + r >= L || hole.yMm - r <= 0 || hole.yMm + r >= W) {
      fail(`board.holes[${index}] (Ø${hole.diameterMm} at ${hole.xMm}, ${hole.yMm}) is not inside the ${L} x ${W} board`);
    }
    holes.slice(0, index).forEach((other, otherIndex) => {
      if (Math.hypot(hole.xMm - other.xMm, hole.yMm - other.yMm) < (hole.diameterMm + other.diameterMm) / 2 - EPS) fail(`board.holes[${otherIndex}] and board.holes[${index}] overlap`);
    });
  });
  if (tl <= OV + EPS) fail(`walls.lidMm ${tl} must exceed ${OV} mm: the lid lip is joined ${OV} mm into the lid plate`);

  // --- lid-screw boss style (decided first: "floor" widens the cavity) -----------------------------------------------
  const lidFasteners = input.lid?.fasteners;
  const bossStyle: BossStyle = lidFasteners?.bossStyle ?? "tapered";
  if (!BOSS_STYLES.includes(bossStyle)) fail(`lid.fasteners.bossStyle must be one of ${BOSS_STYLES.join(", ")} (got ${String(bossStyle)})`);
  const bossD = lidFasteners ? positive("lid.fasteners.bossDiameterMm", lidFasteners.bossDiameterMm ?? 6) : 0;
  const bossR = bossD / 2;
  // Each corner boss axis is this far from both adjoining inner walls, so the boss overlaps each wall by bossWallOverlapMm.
  const bossInset = bossR - bossWallOverlapMm;
  if (lidFasteners && bossInset <= 0) fail(`lid.fasteners.bossDiameterMm ${bossD} must exceed ${2 * bossWallOverlapMm} mm`);
  // "floor": a boss standing on the floor must lie outside the board keep-out (board outline + boardClearance). The keep-out
  // edge must be at least one boss radius from the boss axis, so the cavity grows by 2 x (bossInset + bossR) in ONE axis. Rule:
  // grow the axis that needs less growth; the two corner-boss axes need the same, so the tie goes to the axis whose growth adds
  // less floor area (x when growing x adds no more area than growing y). The other axis keeps boardClearance exactly.
  let growth: Vector2 = [0, 0];
  if (lidFasteners && bossStyle === "floor") {
    const needX = 2 * (bossInset + bossR);
    const needY = 2 * (bossInset + bossR);
    const areaX = needX * (W + 2 * bc);
    const areaY = needY * (L + 2 * bc);
    growth = needX < needY - EPS ? [needX, 0] : needY < needX - EPS ? [0, needY] : areaX <= areaY + EPS ? [needX, 0] : [0, needY];
  }

  // --- the shell -----------------------------------------------------------------------------------------------------
  const cavityL = L + 2 * bc + growth[0];
  const cavityW = W + 2 * bc + growth[1];
  const outerL = cavityL + 2 * w;
  const outerW = cavityW + 2 * w;
  if (Ro > 0 && Ro >= Math.min(outerL, outerW) / 2 - EPS) fail(`walls.outerCornerRadiusMm ${Ro} must be less than half the outer size (${r9(Math.min(outerL, outerW) / 2)})`);
  // Inner corner radius: the outer radius minus the wall, but never more than the board clearance, so the board's square
  // corners keep at least boardClearance to the rounded cavity corners too (a larger radius cuts into the board corner).
  const Ri = Math.min(Math.max(0, Ro - w), bc);
  const cavMin: Vector2 = [ox + w, oy + w];
  const cavMax: Vector2 = [ox + w + cavityL, oy + w + cavityW];
  const floorTopZ = oz + f;
  const boardMin: Vector2 = [cavMin[0] + bc + growth[0] / 2, cavMin[1] + bc + growth[1] / 2];
  if (lidFasteners && bossStyle === "tapered" && Ro > 0 && w - bossWallOverlapMm < Ro * (1 - Math.SQRT1_2) - EPS) {
    fail(`the tapered boss gusset is clipped ${bossWallOverlapMm} mm into each wall; with walls.wallMm ${w} and walls.outerCornerRadiusMm ${Ro} that corner would show outside the rounded outer corner (needs wallMm - ${bossWallOverlapMm} >= ${r9(Ro * (1 - Math.SQRT1_2))}); thicken the wall, reduce the outer radius or use bossStyle "hanging"`);
  }

  // --- standoffs -----------------------------------------------------------------------------------------------------
  const standoffInput = input.standoffs;
  const supportH = standoffInput ? positive("standoffs.heightMm", standoffInput.heightMm ?? U) : U;
  if (standoffInput && supportH < U - EPS) fail(`standoffs.heightMm ${supportH} is below board.undersideClearanceMm ${U}: parts under the board would hit the floor`);
  if (standoffInput && holes.length === 0) fail("standoffs need board.holes: one standoff stands under each hole");
  const boardBottomZ = floorTopZ + supportH;
  const boardTopZ = boardBottomZ + T;
  const componentTopZ = boardTopZ + Hc;

  let standoffFastener: BoardCaseDerived["fasteners"]["standoffs"];
  const standoffGroups: CylinderPattern[] = [];
  let standoffFloorHoles: BoardCasePlan["standoffFloorHoles"];
  const standoffs: Array<{ label: string; axis: Vector2; radius: number }> = [];
  if (standoffInput) {
    const fastener = standoffInput.fastener;
    let holeDiameterMm: number;
    let holeDepthMm = supportH;
    let source: string;
    const extra: Partial<NonNullable<BoardCaseDerived["fasteners"]["standoffs"]>> = {};
    if (fastener.mode === "pilot") {
      holeDiameterMm = positive("standoffs.fastener.pilotDiameterMm", requirePilotDiameter(fastener.screw, fastener.pilotDiameterMm, "standoffs.fastener"));
      holeDepthMm = positive("standoffs.fastener.pilotDepthMm", fastener.pilotDepthMm ?? supportH);
      if (holeDepthMm > supportH + EPS) fail(`standoffs.fastener.pilotDepthMm ${holeDepthMm} exceeds the standoff height ${supportH}`);
      source = CALLER_SOURCE;
    } else if (fastener.mode === "heat-set-insert") {
      const insert = heatSetInsert(fastener.screw, fastener.insertLengthMm);
      holeDiameterMm = insert.holeDiameterMm;
      holeDepthMm = insert.blindHoleDepthMm;
      if (holeDepthMm > supportH + EPS) fail(`the ${insert.insert} insert needs a ${holeDepthMm} mm blind hole, deeper than the ${supportH} mm standoff; raise standoffs.heightMm`);
      source = insert.source;
      Object.assign(extra, { confidence: insert.confidence, insert: insert.insert, minWallMm: insert.minWallMm });
    } else {
      const fit = fastener.clearanceFit ?? "medium";
      const hole = clearanceHole(fastener.screw, fit);
      holeDiameterMm = hole.diameterMm;
      source = hole.source;
      Object.assign(extra, { confidence: hole.confidence, clearanceFit: fit });
    }
    const outerDiameters = holes.map((hole) => standoffInput.outerDiameterMm ?? r9(hole.diameterMm + 3));
    outerDiameters.forEach((od, index) => {
      positive(`standoffs.outerDiameterMm (hole ${index})`, od);
      if (od <= holeDiameterMm + EPS) fail(`standoff ${index}: outer diameter ${od} must exceed its ${holeDiameterMm} mm hole`);
      if (extra.minWallMm !== undefined && od < holeDiameterMm + 2 * extra.minWallMm - EPS) {
        fail(`standoff ${index}: outer diameter ${od} leaves less than the sourced ${extra.minWallMm} mm insert wall around the ${holeDiameterMm} mm hole (needs ${r9(holeDiameterMm + 2 * extra.minWallMm)})`);
      }
    });
    holes.forEach((hole, index) => standoffs.push({ label: `standoff ${index}`, axis: [boardMin[0] + hole.xMm, boardMin[1] + hole.yMm], radius: outerDiameters[index]! / 2 }));
    for (const od of [...new Set(outerDiameters)]) {
      standoffGroups.push({
        centersMm: standoffs.filter((_, index) => outerDiameters[index] === od).map((standoff) => [r9(standoff.axis[0]), r9(standoff.axis[1]), r9(floorTopZ)] as Vector3),
        outerDiameterMm: od,
        heightMm: supportH,
        holeDiameterMm,
        holeDepthMm,
        baseOverlapMm: OV,
      });
    }
    if (fastener.mode === "through") {
      standoffFloorHoles = { entryCentersMm: standoffs.map((standoff) => [r9(standoff.axis[0]), r9(standoff.axis[1]), oz] as Vector3), diameterMm: holeDiameterMm, depthMm: f };
    }
    standoffFastener = { screw: fastener.screw, mode: fastener.mode, holeDiameterMm, holeDepthMm: fastener.mode === "through" ? r9(supportH + f) : holeDepthMm, outerDiametersMm: [...new Set(outerDiameters)], heightMm: supportH, source, ...extra };
  }

  // --- lid-screw corner bosses ---------------------------------------------------------------------------------------
  // The cavity is board + clearance on every side, so a floor-standing corner boss would always overlap the board's
  // corners ("floor" widens the cavity instead). "hanging" and "tapered" bosses hang from the two walls of each corner,
  // above the component envelope (componentTop + headroom), and their tops are flush with the wall top so the lid plate
  // clamps on them. "tapered" adds a 45 degree gusset under each boss so nothing overhangs more than 45 degrees.
  let lidFastener: BoardCaseDerived["fasteners"]["lid"];
  let postLength = 0;
  let postHole: { diameterMm: number; depthMm: number } | undefined;
  let lidHoleSpec: BoardCasePlan["lid"]["holes"];
  if (lidFasteners) {
    if (lidFasteners.count !== undefined && lidFasteners.count !== 4) fail("lid.fasteners.count must be 4 (one boss per cavity corner)");
    const fit = lidFasteners.clearanceFit ?? "medium";
    const lidHole = clearanceHole(lidFasteners.screw, fit);
    let baseHole: NonNullable<BoardCaseDerived["fasteners"]["lid"]>["baseHole"];
    if (lidFasteners.base === "pilot") {
      const diameterMm = positive("lid.fasteners.pilotDiameterMm", requirePilotDiameter(lidFasteners.screw, lidFasteners.pilotDiameterMm, "lid.fasteners"));
      if (lidFasteners.pilotDepthMm === undefined) fail("lid.fasteners.pilotDepthMm is required with base \"pilot\": it sets the corner boss length (boss = pilot depth + 1 mm)");
      const depthMm = positive("lid.fasteners.pilotDepthMm", lidFasteners.pilotDepthMm);
      baseHole = { diameterMm, depthMm, source: CALLER_SOURCE };
    } else {
      const insert = heatSetInsert(lidFasteners.screw, lidFasteners.insertLengthMm);
      if (bossD < insert.holeDiameterMm + 2 * insert.minWallMm - EPS) {
        fail(`lid boss diameter ${bossD} leaves less than the sourced ${insert.minWallMm} mm insert wall around the ${insert.holeDiameterMm} mm ${insert.insert} hole (needs ${r9(insert.holeDiameterMm + 2 * insert.minWallMm)})`);
      }
      baseHole = { diameterMm: insert.holeDiameterMm, depthMm: insert.blindHoleDepthMm, source: insert.source, confidence: insert.confidence, insert: insert.insert, minWallMm: insert.minWallMm };
    }
    if (baseHole.diameterMm >= bossD - EPS) fail(`lid boss diameter ${bossD} must exceed its ${baseHole.diameterMm} mm hole`);
    if (lidHole.diameterMm >= bossD - EPS) fail(`lid boss diameter ${bossD} must exceed the ${lidHole.diameterMm} mm lid clearance hole`);
    postLength = r9(baseHole.depthMm + bossFloorMm);
    postHole = { diameterMm: baseHole.diameterMm, depthMm: baseHole.depthMm };
    let countersink: NonNullable<BoardCaseDerived["fasteners"]["lid"]>["countersink"];
    if (lidFasteners.countersunk ?? true) {
      let headDiameterMm: number;
      let includedAngleDeg = 90;
      let source = CALLER_SOURCE;
      let confidence: "medium" | undefined;
      if (lidFasteners.headDiameterMm !== undefined) {
        headDiameterMm = positive("lid.fasteners.headDiameterMm", lidFasteners.headDiameterMm);
      } else {
        const head = countersunkHead(lidFasteners.screw);
        headDiameterMm = head.headDiameterMaxMm;
        includedAngleDeg = head.includedAngleDeg;
        source = head.source;
        confidence = head.confidence;
      }
      if (headDiameterMm <= lidHole.diameterMm + EPS) fail(`countersink head diameter ${headDiameterMm} must exceed the ${lidHole.diameterMm} mm lid clearance hole`);
      const depthMm = r9((headDiameterMm - lidHole.diameterMm) / (2 * Math.tan((includedAngleDeg * Math.PI) / 360)));
      if (depthMm >= tl - EPS) fail(`the ${headDiameterMm} mm countersink is ${depthMm} mm deep, not less than walls.lidMm ${tl}; thicken the lid`);
      countersink = { headDiameterMm, includedAngleDeg, depthMm, source, ...(confidence ? { confidence } : {}) };
    }
    lidFastener = {
      screw: lidFasteners.screw,
      base: lidFasteners.base,
      bossDiameterMm: bossD,
      bossLengthMm: postLength,
      baseHole,
      lidHole: { diameterMm: lidHole.diameterMm, fit, source: lidHole.source, confidence: lidHole.confidence },
      ...(countersink ? { countersink } : {}),
    };
    lidHoleSpec = {
      entryCentersMm: [],
      diameterMm: lidHole.diameterMm,
      depthMm: tl,
      ...(countersink ? { countersink: { majorDiameterMm: countersink.headDiameterMm, includedAngleDeg: countersink.includedAngleDeg } } : {}),
    };
  }

  // --- heights -------------------------------------------------------------------------------------------------------
  // hanging: wallTop = componentTop + headroom + max(lipDepth, bossLength): the lip and the corner bosses both stay above
  // the component envelope plus headroom.
  // tapered: the boss sits on a 45 degree gusset whose apex is the wall corner. The gusset must cover the boss footprint
  // (farthest point from the corner: bossInset x sqrt 2 + bossR), so it is that tall; its lowest point inside the cavity
  // (the rounded cavity corner keeps the apex inside the wall) must stay above componentTop + headroom, so the wall top
  // rises by the taper height. The lid lip must stay above the gusset's flared top.
  // floor: the boss stands on the floor and rises to the wall top; the wall top only has to hold the lip and the hole depth.
  const headroomTopZ = componentTopZ + headroomMm;
  const hangingWallTopZ = headroomTopZ + Math.max(d, postLength);
  const taperReach = bossInset * Math.SQRT2 + bossR;
  // Lowest point of the cone inside the rounded cavity corner, above the cone apex on the wall corner.
  const taperRise = Ri > 0 ? Ri * (Math.SQRT2 - 1) : 0;
  let wallTopZ = hangingWallTopZ;
  if (lidFasteners && bossStyle === "floor") wallTopZ = Math.max(headroomTopZ + d, floorTopZ + postLength);
  if (lidFasteners && bossStyle === "tapered") {
    if (d > postLength - OV + EPS) fail(`lid.lipDepthMm ${d} must be at most the boss length ${postLength} minus ${OV} mm with the tapered style, or the lid lip would meet the gusset under the boss; shorten the lip, deepen the boss hole or use bossStyle "hanging"`);
    wallTopZ = Math.max(hangingWallTopZ, headroomTopZ + postLength + taperReach - taperRise);
  }
  const innerHeight = wallTopZ - floorTopZ;
  const lipBottomZ = wallTopZ - d;
  const postBottomZ = lidFasteners && bossStyle === "floor" ? floorTopZ : wallTopZ - postLength;
  const taperApexZ = postBottomZ - taperReach;
  const taperBottomZ = taperApexZ + taperRise;
  const lidTopZ = wallTopZ + tl + exploded;
  requireBoardCaseInvariants({
    lipDepthMm: d, innerHeightMm: innerHeight, lipBottomZMm: lipBottomZ, componentTopZMm: componentTopZ,
    bossBottomZMm: lidFasteners && bossStyle !== "floor" ? postBottomZ : undefined,
    taperBottomZMm: lidFasteners && bossStyle === "tapered" ? taperBottomZ : undefined,
  });
  if (lidFasteners && bossStyle === "floor" && postLength > wallTopZ - floorTopZ + EPS) fail(`the ${postLength} mm boss hole does not fit the ${r9(wallTopZ - floorTopZ)} mm floor-standing boss`);
  if (lidFastener && bossStyle === "floor") lidFastener.bossLengthMm = r9(wallTopZ - floorTopZ);
  // The no-overhang property is computed from the derived geometry, never assumed.
  const overhangGeometry: BossUndersideGeometry = {
    style: bossStyle, bossRadiusMm: bossR, bossInsetMm: bossInset, bossBottomZMm: postBottomZ, floorTopZMm: floorTopZ,
    ...(bossStyle === "tapered" ? { taper: { apexZMm: taperApexZ, topZMm: postBottomZ, topRadiusMm: taperReach } } : {}),
  };
  const maxBossOverhang = lidFasteners ? maxBossOverhangDeg(overhangGeometry) : undefined;
  if (maxBossOverhang !== undefined && bossStyle !== "hanging" && maxBossOverhang > BOSS_TAPER_ANGLE_DEG + BOSS_OVERHANG_TOLERANCE_DEG) {
    throw new BoardCaseValidationError(`internal: the ${bossStyle} boss underside overhangs ${maxBossOverhang} degrees, more than ${BOSS_TAPER_ANGLE_DEG}`);
  }

  // --- lip ring ------------------------------------------------------------------------------------------------------
  const lipInset = lc + lw;
  if (2 * lipInset >= Math.min(cavityL, cavityW) - EPS) fail(`lid lip (clearance ${lc} + wall ${lw} per side) does not fit the ${r9(cavityL)} x ${r9(cavityW)} cavity`);
  const lipRadius = Math.max(0, Ri - lc);
  const lipInnerRadius = Math.max(0, Ri - lipInset);

  const s = bossInset;
  const posts: Array<{ label: string; axis: Vector2; radius: number }> = [];
  if (lidFasteners) {
    const reach = s + bossD / 2 + lc;
    if (2 * reach >= Math.min(cavityL, cavityW) - EPS) {
      fail(`the four ${bossD} mm corner bosses (plus lid clearance) overlap each other in the ${r9(cavityL)} x ${r9(cavityW)} cavity`);
    }
    const corners: Vector2[] = [[cavMin[0] + s, cavMin[1] + s], [cavMax[0] - s, cavMin[1] + s], [cavMin[0] + s, cavMax[1] - s], [cavMax[0] - s, cavMax[1] - s]];
    corners.forEach((axis, index) => posts.push({ label: `lid boss ${index}`, axis: [r9(axis[0]), r9(axis[1])], radius: bossD / 2 }));
    if (bossStyle === "floor") {
      standoffs.forEach((standoff) => posts.forEach((post) => {
        if (Math.hypot(post.axis[0] - standoff.axis[0], post.axis[1] - standoff.axis[1]) < post.radius + standoff.radius - EPS) fail(`${post.label} collides with ${standoff.label}`);
      }));
    }
    lidHoleSpec!.entryCentersMm = posts.map((post) => [post.axis[0], post.axis[1], r9(wallTopZ + tl)] as Vector3);
  }

  // --- openings ------------------------------------------------------------------------------------------------------
  const lipInnerRect: Rect = { min: [cavMin[0] + lipInset, cavMin[1] + lipInset], max: [cavMax[0] - lipInset, cavMax[1] - lipInset] };
  const floorRect: Rect = { min: [cavMin[0] + Ri, cavMin[1] + Ri], max: [cavMax[0] - Ri, cavMax[1] - Ri] };
  const lidKeepouts = posts.map((post) => ({
    label: post.label,
    axis: post.axis,
    radius: Math.max(post.radius + lc, (lidHoleSpec?.countersink?.majorDiameterMm ?? lidHoleSpec?.diameterMm ?? 0) / 2),
  }));
  const wallFrame = (wall: CaseWall) => {
    const alongIndex = wall === "x-" || wall === "x+" ? 1 : 0;
    const normalIndex = 1 - alongIndex;
    const outerFace = wall === "x-" ? ox : wall === "x+" ? ox + outerL : wall === "y-" ? oy : oy + outerW;
    const innerFace = wall === "x-" ? cavMin[0] : wall === "x+" ? cavMax[0] : wall === "y-" ? cavMin[1] : cavMax[1];
    const inward = wall.endsWith("-") ? 1 : -1;
    const axis: Vector3 = normalIndex === 0 ? [inward, 0, 0] : [0, inward, 0];
    const widthDirection: Vector3 = alongIndex === 1 ? [0, 1, 0] : [1, 0, 0];
    const span: Vector2 = [(alongIndex === 0 ? cavMin[0] : cavMin[1]) + Ri, (alongIndex === 0 ? cavMax[0] : cavMax[1]) - Ri];
    return { alongIndex, normalIndex, outerFace, innerFace, axis, widthDirection, span, boardAlongMin: boardMin[alongIndex]! };
  };
  // Plan rectangle of a wall cutter (the wall slab plus the cutter overshoot on both sides) over an along-range.
  const wallCutterRect = (wall: CaseWall, along: Vector2): Rect => {
    const frame = wallFrame(wall);
    const normal: Vector2 = [Math.min(frame.outerFace, frame.innerFace) - OV, Math.max(frame.outerFace, frame.innerFace) + OV];
    return frame.alongIndex === 1 ? { min: [normal[0], along[0]], max: [normal[1], along[1]] } : { min: [along[0], normal[0]], max: [along[1], normal[1]] };
  };
  const standoffZ: Vector2 = [floorTopZ - OV, boardBottomZ];
  const postZ: Vector2 = [postBottomZ, wallTopZ];
  // Tapered gusset: a cone with its apex on each cavity corner, 45 degrees from vertical, flaring to the boss and a
  // bossWallOverlap further (the joint above the boss bottom). At height z its plan is a disc of radius z - apexZ around the
  // corner, clipped bossWallOverlap into the walls.
  const taperTopZ = postBottomZ + OV;
  const taperCorners: Vector2[] = posts.length > 0 && bossStyle === "tapered"
    ? [[cavMin[0], cavMin[1]], [cavMax[0], cavMin[1]], [cavMin[0], cavMax[1]], [cavMax[0], cavMax[1]]]
    : [];
  const taperHitsRect = (rect: Rect, z: Vector2): boolean => {
    if (taperCorners.length === 0 || !overlaps(z, [taperApexZ, taperTopZ])) return false;
    const radius = Math.min(z[1], taperTopZ) - taperApexZ;
    return taperCorners.some((corner, index) => {
      const signX = index % 2 === 0 ? 1 : -1;
      const signY = index < 2 ? 1 : -1;
      const u = [signX * (rect.min[0] - corner[0]), signX * (rect.max[0] - corner[0])].sort((a, b) => a - b) as Vector2;
      const v = [signY * (rect.min[1] - corner[1]), signY * (rect.max[1] - corner[1])].sort((a, b) => a - b) as Vector2;
      const uc: Vector2 = [Math.max(u[0], -bossWallOverlapMm), u[1]];
      const vc: Vector2 = [Math.max(v[0], -bossWallOverlapMm), v[1]];
      if (uc[0] > uc[1] || vc[0] > vc[1]) return false;
      const du = uc[0] > 0 ? uc[0] : uc[1] < 0 ? -uc[1] : 0;
      const dv = vc[0] > 0 ? vc[0] : vc[1] < 0 ? -vc[1] : 0;
      return Math.hypot(du, dv) < radius - EPS;
    });
  };
  type Feature = { label: string; face: CaseOpeningFace; plan: Rect; inPlane: Rect; z?: Vector2 };
  const features: Feature[] = [];
  const checkWallFeature = (label: string, wall: CaseWall, along: Vector2, z: Vector2) => {
    const frame = wallFrame(wall);
    if (along[0] < frame.span[0] - EPS || along[1] > frame.span[1] + EPS) {
      fail(`${label} on wall ${wall} runs from ${r9(along[0])} to ${r9(along[1])} along it, outside the flat wall span ${r9(frame.span[0])} to ${r9(frame.span[1])}`);
    }
    if (z[0] < floorTopZ - EPS || z[1] > lipBottomZ + EPS) {
      fail(`${label} on wall ${wall} spans z ${r9(z[0])} to ${r9(z[1])}, outside the open wall band z ${r9(floorTopZ)} (floor top) to ${r9(lipBottomZ)} (lid lip bottom)`);
    }
    const plan = wallCutterRect(wall, along);
    for (const standoff of standoffs) {
      if (overlaps(z, standoffZ) && circleHitsRect(standoff.axis, standoff.radius, plan)) fail(`${label} on wall ${wall} collides with ${standoff.label}`);
    }
    for (const post of posts) {
      if (overlaps(z, postZ) && circleHitsRect(post.axis, post.radius, plan)) fail(`${label} on wall ${wall} collides with ${post.label}`);
    }
    if (taperHitsRect(plan, z)) fail(`${label} on wall ${wall} collides with the 45 degree gusset under a lid boss`);
    features.push({ label, face: wall, plan, inPlane: { min: [along[0], z[0]], max: [along[1], z[1]] }, z });
  };
  const checkFlatFeature = (label: string, face: "lid" | "floor", rect: Rect) => {
    const region = face === "lid" ? lipInnerRect : floorRect;
    if (!rectInside(rect, region)) {
      fail(`${label} on the ${face} (x ${r9(rect.min[0])}..${r9(rect.max[0])}, y ${r9(rect.min[1])}..${r9(rect.max[1])}) is not inside the ${face === "lid" ? "area inside the lid lip" : "flat floor"} (x ${r9(region.min[0])}..${r9(region.max[0])}, y ${r9(region.min[1])}..${r9(region.max[1])})`);
    }
    if (face === "lid") {
      for (const keepout of lidKeepouts) if (circleHitsRect(keepout.axis, keepout.radius, rect)) fail(`${label} on the lid collides with ${keepout.label}`);
    } else {
      for (const standoff of standoffs) if (circleHitsRect(standoff.axis, standoff.radius, rect)) fail(`${label} on the floor collides with ${standoff.label}`);
      if (bossStyle === "floor") for (const post of posts) if (circleHitsRect(post.axis, post.radius, rect)) fail(`${label} on the floor collides with ${post.label}`);
    }
    features.push({ label, face, plan: rect, inPlane: rect });
  };

  const openings: OpeningCut[] = [];
  const openingsDerived: BoardCaseOpeningDerived[] = [];
  const openingLabels = new Set<string>();
  (input.openings ?? []).forEach((opening, index) => {
    const label = opening.label?.trim() || `opening ${index}`;
    if (openingLabels.has(label)) fail(`opening label "${label}" is used twice`);
    openingLabels.add(label);
    const width = positive(`${label}: widthMm`, opening.widthMm);
    let height: number;
    if (opening.shape === "circle") {
      if (opening.heightMm !== undefined && Math.abs(opening.heightMm - width) > EPS) fail(`${label}: a circle opening takes widthMm as its diameter; heightMm, when given, must equal it`);
      if (opening.cornerRadiusMm !== undefined) fail(`${label}: a circle opening has no cornerRadiusMm`);
      height = width;
    } else {
      height = positive(`${label}: heightMm`, opening.heightMm);
    }
    let corner = 0;
    if (opening.shape === "rounded-rect") {
      corner = positive(`${label}: cornerRadiusMm`, opening.cornerRadiusMm);
      if (corner >= Math.min(width, height) / 2 - EPS) fail(`${label}: cornerRadiusMm ${corner} must be less than half the width and height`);
    } else if (opening.shape === "rect" && opening.cornerRadiusMm !== undefined && opening.cornerRadiusMm !== 0) {
      fail(`${label}: a rect opening has square corners; use shape "rounded-rect" for cornerRadiusMm`);
    }
    if (!Number.isFinite(opening.alongMm)) fail(`${label}: alongMm must be finite`);
    if (opening.wall === "lid" || opening.wall === "floor") {
      if (opening.acrossMm === undefined || !Number.isFinite(opening.acrossMm)) fail(`${label}: a ${opening.wall} opening needs acrossMm (its centre along y from the board's min-y edge)`);
      if (opening.aboveBoardMm !== undefined) fail(`${label}: a ${opening.wall} opening takes acrossMm, not aboveBoardMm`);
      const center: Vector2 = [boardMin[0] + opening.alongMm, boardMin[1] + opening.acrossMm!];
      checkFlatFeature(label, opening.wall, { min: [center[0] - width / 2, center[1] - height / 2], max: [center[0] + width / 2, center[1] + height / 2] });
      const top = opening.wall === "lid";
      const entry: Vector3 = [r9(center[0]), r9(center[1]), r9(top ? wallTopZ + tl : oz)];
      openings.push({ label, target: top ? "lid" : "base", shape: opening.shape, entryCenterMm: entry, axis: [0, 0, top ? -1 : 1], widthDirection: [1, 0, 0], widthMm: width, heightMm: height, cornerRadiusMm: corner, throughDepthMm: top ? tl : f });
      openingsDerived.push({ label, wall: opening.wall, shape: opening.shape, centerMm: [entry[0], entry[1], r9(top ? lidTopZ : oz)], sizeMm: [width, height], ...(corner > 0 ? { cornerRadiusMm: corner } : {}) });
    } else {
      if (opening.aboveBoardMm === undefined || !Number.isFinite(opening.aboveBoardMm)) fail(`${label}: a wall opening needs aboveBoardMm (its bottom above the board top surface)`);
      if (opening.acrossMm !== undefined) fail(`${label}: a wall opening takes aboveBoardMm, not acrossMm`);
      const frame = wallFrame(opening.wall);
      const alongCenter = frame.boardAlongMin + opening.alongMm;
      const zBottom = boardTopZ + opening.aboveBoardMm!;
      checkWallFeature(label, opening.wall, [alongCenter - width / 2, alongCenter + width / 2], [zBottom, zBottom + height]);
      const entry: Vector3 = frame.alongIndex === 1 ? [frame.outerFace, alongCenter, zBottom + height / 2] : [alongCenter, frame.outerFace, zBottom + height / 2];
      const rounded = entry.map(r9) as Vector3;
      openings.push({ label, target: "base", shape: opening.shape, entryCenterMm: rounded, axis: frame.axis, widthDirection: frame.widthDirection, widthMm: width, heightMm: height, cornerRadiusMm: corner, throughDepthMm: w });
      openingsDerived.push({ label, wall: opening.wall, shape: opening.shape, centerMm: rounded, sizeMm: [width, height], ...(corner > 0 ? { cornerRadiusMm: corner } : {}) });
    }
  });

  // --- vents ---------------------------------------------------------------------------------------------------------
  let vents: BoardCasePlan["vents"];
  let ventsDerived: BoardCaseDerived["vents"];
  if (input.vents) {
    const vent = input.vents;
    if (!Number.isInteger(vent.slots) || vent.slots < 1 || vent.slots > 64) fail("vents.slots must be an integer from 1 to 64");
    const sw = positive("vents.slotWidthMm", vent.slotWidthMm);
    const sl = positive("vents.slotLengthMm", vent.slotLengthMm);
    const pitch = positive("vents.pitchMm", vent.pitchMm);
    if (sl <= sw + EPS) fail(`vents.slotLengthMm ${sl} must exceed vents.slotWidthMm ${sw} (the length includes the round ends)`);
    if (vent.slots > 1 && pitch <= sw + EPS) fail(`vents.pitchMm ${pitch} must exceed vents.slotWidthMm ${sw}, or the slots merge`);
    const offsets = Array.from({ length: vent.slots }, (_, index) => (index - (vent.slots - 1) / 2) * pitch);
    const centers: Vector3[] = [];
    if (vent.on === "lid") {
      const cx = boardMin[0] + (vent.centerAlongMm ?? L / 2);
      const cy = boardMin[1] + (vent.centerAcrossMm ?? W / 2);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) fail("vents centre must be finite");
      offsets.forEach((offset, index) => {
        const x = cx + offset;
        checkFlatFeature(`vent slot ${index}`, "lid", { min: [x - sw / 2, cy - sl / 2], max: [x + sw / 2, cy + sl / 2] });
        centers.push([r9(x), r9(cy), r9(wallTopZ + tl)]);
      });
      vents = { target: "lid", entryCentersMm: centers, axis: [0, 0, -1], slotDirection: [0, 1, 0], widthMm: sw, overallLengthMm: sl, throughDepthMm: tl };
      ventsDerived = { on: "lid", centersMm: centers.map((center) => [center[0], center[1], r9(lidTopZ)] as Vector3), slotDirection: [0, 1, 0], slotWidthMm: sw, slotLengthMm: sl };
    } else {
      const frame = wallFrame(vent.on);
      const alongCenter = frame.boardAlongMin + (vent.centerAlongMm ?? (frame.alongIndex === 0 ? L : W) / 2);
      const zCenter = vent.centerAcrossMm !== undefined ? boardTopZ + vent.centerAcrossMm : (floorTopZ + lipBottomZ) / 2;
      if (!Number.isFinite(alongCenter) || !Number.isFinite(zCenter)) fail("vents centre must be finite");
      offsets.forEach((offset, index) => {
        const along = alongCenter + offset;
        checkWallFeature(`vent slot ${index}`, vent.on as CaseWall, [along - sw / 2, along + sw / 2], [zCenter - sl / 2, zCenter + sl / 2]);
        centers.push((frame.alongIndex === 1 ? [frame.outerFace, along, zCenter] : [along, frame.outerFace, zCenter]).map(r9) as Vector3);
      });
      vents = { target: "base", entryCentersMm: centers, axis: frame.axis, slotDirection: [0, 0, 1], widthMm: sw, overallLengthMm: sl, throughDepthMm: w };
      ventsDerived = { on: vent.on, centersMm: centers, slotDirection: [0, 0, 1], slotWidthMm: sw, slotLengthMm: sl };
    }
  }
  // Openings and vent slots on one face must not overlap: their profiles would share Regions.
  for (let first = 0; first < features.length; first += 1) {
    for (let second = first + 1; second < features.length; second += 1) {
      const a = features[first]!;
      const b = features[second]!;
      if (a.face === b.face && rectsOverlap(a.inPlane, b.inPlane)) fail(`${a.label} and ${b.label} overlap on the ${a.face === "lid" || a.face === "floor" ? a.face : `wall ${a.face}`}`);
    }
  }

  // --- board stand-in ------------------------------------------------------------------------------------------------
  let board: BoardCasePlan["board"];
  if (input.boardStandIn) {
    const groups = new Map<number, Vector3[]>();
    for (const hole of holes) {
      const list = groups.get(hole.diameterMm) ?? [];
      list.push([r9(boardMin[0] + hole.xMm), r9(boardMin[1] + hole.yMm), r9(boardTopZ)]);
      groups.set(hole.diameterMm, list);
    }
    board = { originMm: [r9(boardMin[0]), r9(boardMin[1]), r9(boardBottomZ)], sizeMm: [L, W, T], holeGroups: [...groups].map(([diameterMm, entryCentersMm]) => ({ diameterMm, entryCentersMm })) };
  }

  const bounds = (min: Vector3, max: Vector3): Bounds => ({ min: min.map(r9) as Vector3, max: max.map(r9) as Vector3 });
  const derived: BoardCaseDerived = {
    outerMm: bounds([ox, oy, oz], [ox + outerL, oy + outerW, wallTopZ]),
    cavityMm: bounds([cavMin[0], cavMin[1], floorTopZ], [cavMax[0], cavMax[1], wallTopZ]),
    innerCornerRadiusMm: r9(Ri),
    floorTopZMm: r9(floorTopZ),
    boardMm: bounds([boardMin[0], boardMin[1], boardBottomZ], [boardMin[0] + L, boardMin[1] + W, boardTopZ]),
    boardTopZMm: r9(boardTopZ),
    componentTopZMm: r9(componentTopZ),
    wallTopZMm: r9(wallTopZ),
    lidTopZMm: r9(lidTopZ),
    explodedMm: exploded,
    standoffAxesMm: standoffs.map((standoff) => [r9(standoff.axis[0]), r9(standoff.axis[1])]),
    ...(standoffInput ? { standoffTopZMm: r9(boardBottomZ) } : {}),
    lidBossAxesMm: posts.map((post) => post.axis),
    ...(lidFasteners ? { lidBossBottomZMm: r9(postBottomZ), bossStyle } : {}),
    boardWallClearanceMm: {
      xNeg: r9(boardMin[0] - cavMin[0]), xPos: r9(cavMax[0] - (boardMin[0] + L)),
      yNeg: r9(boardMin[1] - cavMin[1]), yPos: r9(cavMax[1] - (boardMin[1] + W)),
    },
    ...(lidFasteners && bossStyle === "floor" ? { cavityGrowthMm: [r9(growth[0]), r9(growth[1])] as Vector2 } : {}),
    ...(lidFasteners && bossStyle === "tapered" ? { bossTaper: { angleDeg: BOSS_TAPER_ANGLE_DEG, bottomZMm: r9(taperBottomZ), addedHeightMm: r9(wallTopZ - hangingWallTopZ) } } : {}),
    ...(maxBossOverhang !== undefined ? { printability: { baseOrientation: "floor-down" as const, maxBossOverhangDeg: r9(maxBossOverhang) } } : {}),
    lipOuterMm: bounds([cavMin[0] + lc, cavMin[1] + lc, lipBottomZ + exploded], [cavMax[0] - lc, cavMax[1] - lc, wallTopZ + exploded]),
    lipInnerMm: bounds([lipInnerRect.min[0], lipInnerRect.min[1], lipBottomZ + exploded], [lipInnerRect.max[0], lipInnerRect.max[1], wallTopZ + exploded]),
    openings: openingsDerived,
    ...(ventsDerived ? { vents: ventsDerived } : {}),
    fasteners: { ...(standoffFastener ? { standoffs: standoffFastener } : {}), ...(lidFastener ? { lid: lidFastener } : {}) },
  };

  return {
    name,
    derived,
    base: {
      boxOriginMm: [ox, oy, oz],
      boxSizeMm: [r9(outerL), r9(outerW), r9(wallTopZ - oz)],
      outerRadiusMm: Ro,
      cavityOriginMm: [r9(cavMin[0]), r9(cavMin[1]), r9(floorTopZ)],
      cavitySizeMm: [r9(cavityL), r9(cavityW), r9(innerHeight + OV)],
      innerRadiusMm: r9(Ri),
    },
    standoffGroups,
    ...(standoffFloorHoles ? { standoffFloorHoles } : {}),
    ...(lidFasteners && postHole ? {
      posts: {
        // Hung bosses start at postBottom (the cylinder reaches OV below its base centre); floor bosses stand on the floor top.
        centersMm: posts.map((post) => [post.axis[0], post.axis[1], r9(bossStyle === "floor" ? floorTopZ : postBottomZ + OV)] as Vector3),
        outerDiameterMm: bossD,
        heightMm: r9(bossStyle === "floor" ? wallTopZ - floorTopZ : postLength - OV),
        holeDiameterMm: postHole.diameterMm,
        holeDepthMm: postHole.depthMm,
        baseOverlapMm: OV,
      },
    } : {}),
    ...(lidFasteners && bossStyle === "tapered" ? {
      taper: {
        // A pointed cone: top disc (radius = height, 45 degrees) at the joint height, apex straight down on the wall corner.
        cones: taperCorners.map((corner) => ({
          topCenterMm: [r9(corner[0]), r9(corner[1]), r9(taperTopZ)] as Vector3,
          radiusMm: r9(taperTopZ - taperApexZ),
          heightMm: r9(taperTopZ - taperApexZ),
        })),
        clipOriginMm: [r9(cavMin[0] - bossWallOverlapMm), r9(cavMin[1] - bossWallOverlapMm), r9(taperApexZ - OV)] as Vector3,
        clipSizeMm: [r9(cavityL + 2 * bossWallOverlapMm), r9(cavityW + 2 * bossWallOverlapMm), r9(taperTopZ - taperApexZ + 2 * OV)] as Vector3,
      },
    } : {}),
    lid: {
      plateOriginMm: [ox, oy, r9(wallTopZ)],
      plateSizeMm: [r9(outerL), r9(outerW), tl],
      plateRadiusMm: Ro,
      lipOriginMm: [r9(cavMin[0] + lc), r9(cavMin[1] + lc), r9(lipBottomZ)],
      lipSizeMm: [r9(cavityL - 2 * lc), r9(cavityW - 2 * lc), r9(d + OV)],
      lipRadiusMm: r9(lipRadius),
      lipInnerOriginMm: [r9(lipInnerRect.min[0]), r9(lipInnerRect.min[1]), r9(lipBottomZ - OV)],
      lipInnerSizeMm: [r9(cavityL - 2 * lipInset), r9(cavityW - 2 * lipInset), r9(d + 3 * OV)],
      lipInnerRadiusMm: r9(lipInnerRadius),
      notches: posts.map((post) => ({ centerMm: [post.axis[0], post.axis[1], r9(lipBottomZ - OV)] as Vector3, radiusMm: r9(post.radius + lc), heightMm: r9(d + 3 * OV) })),
      ...(lidHoleSpec ? { holes: lidHoleSpec } : {}),
    },
    openings,
    ...(vents ? { vents } : {}),
    ...(board ? { board } : {}),
  };
}

// Structural invariants of the height formula. They hold for every accepted input; the check stays so a later formula
// change cannot silently build a lip or a boss into the component space.
export function requireBoardCaseInvariants(values: { lipDepthMm: number; innerHeightMm: number; lipBottomZMm: number; componentTopZMm: number; bossBottomZMm?: number | undefined; taperBottomZMm?: number | undefined }): void {
  if (!(values.lipDepthMm < values.innerHeightMm - EPS)) throw new BoardCaseValidationError(`lid.lipDepthMm ${values.lipDepthMm} must be less than the base inner height ${r9(values.innerHeightMm)}`);
  const headroom = BOARD_CASE_CONSTANTS.headroomMm;
  if (values.lipBottomZMm < values.componentTopZMm + headroom - EPS) throw new BoardCaseValidationError(`the lid lip bottom z ${r9(values.lipBottomZMm)} reaches into the component space (component top ${r9(values.componentTopZMm)} + ${headroom} mm headroom)`);
  if (values.bossBottomZMm !== undefined && values.bossBottomZMm < values.componentTopZMm + headroom - EPS) {
    throw new BoardCaseValidationError(`the lid boss bottom z ${r9(values.bossBottomZMm)} reaches into the component space (component top ${r9(values.componentTopZMm)} + ${headroom} mm headroom)`);
  }
  if (values.taperBottomZMm !== undefined && values.taperBottomZMm < values.componentTopZMm + headroom - EPS) {
    throw new BoardCaseValidationError(`the lid boss taper bottom z ${r9(values.taperBottomZMm)} reaches into the component space (component top ${r9(values.componentTopZMm)} + ${headroom} mm headroom)`);
  }
}

// Geometry of one lid-screw boss underside, in the numbers the plan derives. For floor-down printing the overhang of a
// surface is the angle between its inward-facing downward slope and vertical: 0 for a vertical wall, 90 for a flat underside.
export interface BossUndersideGeometry {
  style: BossStyle;
  bossRadiusMm: number;
  // Distance from the boss axis to each of the two walls of its corner.
  bossInsetMm: number;
  bossBottomZMm: number;
  floorTopZMm: number;
  // "tapered": a cone with its apex on the wall corner, ending at the boss bottom with this radius.
  taper?: { apexZMm: number; topZMm: number; topRadiusMm: number };
}

// The largest overhang, in degrees from vertical, of the boss underside when the base prints floor-down.
// - A boss standing on the floor has no underside: its wall is vertical (0).
// - A hung boss with no gusset has a flat underside (90).
// - A hung boss on a corner cone: the cone surface leans atan(radius / height) from vertical, but only when the cone's top
//   disc covers the whole boss footprint (the point farthest from the wall corner); any uncovered footprint is a flat underside.
export function maxBossOverhangDeg(geometry: BossUndersideGeometry): number {
  if (geometry.style === "floor") return Math.abs(geometry.bossBottomZMm - geometry.floorTopZMm) <= EPS ? 0 : 90;
  const taper = geometry.taper;
  if (geometry.style === "hanging" || !taper) return 90;
  const height = taper.topZMm - taper.apexZMm;
  if (!(height > EPS) || !(taper.topRadiusMm > EPS)) return 90;
  const footprintReach = geometry.bossInsetMm * Math.SQRT2 + geometry.bossRadiusMm;
  if (taper.topRadiusMm < footprintReach - 1e-9 || Math.abs(taper.topZMm - geometry.bossBottomZMm) > 1e-9) return 90;
  return r9((Math.atan2(taper.topRadiusMm, height) * 180) / Math.PI);
}

// ---------------------------------------------------------------------------------------------------------------------
// Native composition
// ---------------------------------------------------------------------------------------------------------------------

export type BoardCaseOperations = RecipeOperations & Pick<PlasticityOperations, "undo" | "remove" | "move" | "rename" | "createCone"> & {
  revolveProfile: NonNullable<RecipeOperations["revolveProfile"]>;
};

export interface BoardCaseStep {
  stage: string;
  operation: string;
  beforeRevision: string;
  afterRevision: string;
  affectedBodyIds: number[];
}

export interface BoardCaseResult {
  recipe: "board-case";
  status: "completed";
  units: "mm";
  // The fixed construction constants the derived numbers use (headroom, boss overlap, boss floor, overshoot).
  constants: typeof BOARD_CASE_CONSTANTS;
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  bodies: { baseId: number; lidId: number; boardId?: number };
  derived: BoardCaseDerived;
  resultBodyIds: number[];
  // Measured: the Undo depth after the call minus the Undo depth before it.
  undoSteps: number;
  steps: BoardCaseStep[];
}

export class BoardCaseRecipeError extends Error {
  readonly failedStage: string;
  readonly completedSteps: BoardCaseStep[];
  readonly undoneSteps: number;
  readonly restored: boolean;
  readonly uncertain: boolean;
  readonly lastConfirmedRevision: string;

  constructor(details: { cause: unknown; failedStage: string; completedSteps: BoardCaseStep[]; undoneSteps: number; restored: boolean; uncertain: boolean; lastConfirmedRevision: string; restoreNote?: string }) {
    const detail = details.cause instanceof Error ? details.cause.message : String(details.cause);
    const state = details.uncertain
      ? "the last native result is uncertain, so nothing was undone; call plasticity_reconcile first"
      : details.restored
        ? `undid ${details.undoneSteps} native steps; the document matches the start (bodies and Undo depth)`
        : `undid ${details.undoneSteps} native steps but the document does not match the start${details.restoreNote ? ` (${details.restoreNote})` : ""}; inspect it`;
    super(`Board case recipe failed in stage "${details.failedStage}" after ${details.completedSteps.length} confirmed native steps; ${state}; revision ${details.lastConfirmedRevision}: ${detail}`, { cause: details.cause });
    this.name = "BoardCaseRecipeError";
    this.failedStage = details.failedStage;
    this.completedSteps = [...details.completedSteps];
    this.undoneSteps = details.undoneSteps;
    this.restored = details.restored;
    this.uncertain = details.uncertain;
    this.lastConfirmedRevision = details.lastConfirmedRevision;
  }
}

interface SubRecipeResult { afterRevision: string; documentToken: string; steps: RecipeStep[]; resultBodyIds: number[] }

export class BoardCaseRecipe {
  private readonly operations: BoardCaseOperations;

  constructor(operations: BoardCaseOperations) {
    this.operations = operations;
  }

  async create(input: BoardCaseInput): Promise<BoardCaseResult> {
    const plan = planBoardCase(input);
    const ops = this.operations;
    const recipes = new PlasticityRecipes(ops);
    const initial = await ops.state();
    if (initial.revision !== input.revision) throw new Error(`Stale reference: expected revision ${input.revision}, current revision is ${initial.revision}`);

    const steps: BoardCaseStep[] = [];
    let current = initial;
    let stage = "base-shell";
    const native = async (operation: string, run: (revision: string) => Promise<RuntimeState>, affected: (before: RuntimeState, after: RuntimeState) => number[]): Promise<RuntimeState> => {
      const before = current;
      const after = await run(before.revision);
      requireSameDocument(before, after);
      current = after;
      // The native step has landed: record it even when its read-back check fails, so the report matches the undo.
      const entry: BoardCaseStep = { stage, operation, beforeRevision: before.revision, afterRevision: after.revision, affectedBodyIds: [] };
      steps.push(entry);
      entry.affectedBodyIds = affected(before, after);
      return after;
    };
    const create = async (operation: string, run: (revision: string) => Promise<RuntimeState>, type = "Solid"): Promise<number> => {
      let id = 0;
      await native(operation, run, (before, after) => [id = singleAdded(before, after, `${stage} ${operation}`, type)]);
      return id;
    };
    const sub = async (run: (revision: string) => Promise<SubRecipeResult>, targetId: number): Promise<void> => {
      try {
        const report = await run(current.revision);
        steps.push(...report.steps.map((entry) => ({ stage, operation: entry.operation, beforeRevision: entry.beforeRevision, afterRevision: entry.afterRevision, affectedBodyIds: entry.affectedBodyIds })));
        current = await ops.state();
        requireSameDocument(initial, current);
        if (current.revision !== report.afterRevision) throw new Error(`${stage}: the document moved on after the sub-recipe (${report.afterRevision} -> ${current.revision})`);
        if (report.resultBodyIds.length !== 1 || report.resultBodyIds[0] !== targetId) throw new Error(`${stage}: expected the sub-recipe to keep body ${targetId}, got ${report.resultBodyIds.join(", ")}`);
      } catch (error) {
        const partial = (error as { completedSteps?: RecipeStep[] }).completedSteps;
        if (Array.isArray(partial)) steps.push(...partial.map((entry) => ({ stage, operation: entry.operation, beforeRevision: entry.beforeRevision, afterRevision: entry.afterRevision, affectedBodyIds: entry.affectedBodyIds })));
        throw error;
      }
    };
    const solidKept = (id: number) => (_before: RuntimeState, after: RuntimeState) => { requireSolid(after, id, stage); return [id]; };

    let baseId = 0;
    let lidId = 0;
    let boardId: number | undefined;
    try {
      // Base shell: outer block, rounded corners, cavity cutter with the inner corner radius.
      baseId = await create("create-base-block", (revision) => ops.createBox(plan.base.boxOriginMm, plan.base.boxSizeMm, `${plan.name}-base`, revision));
      if (plan.base.outerRadiusMm > 0) await native("round-base-corners", (revision) => ops.fillet(baseId, verticalEdgeIds(current, baseId, "base block"), plan.base.outerRadiusMm, revision), solidKept(baseId));
      const cavityId = await create("create-cavity-cutter", (revision) => ops.createBox(plan.base.cavityOriginMm, plan.base.cavitySizeMm, undefined, revision));
      if (plan.base.innerRadiusMm > 0) await native("round-cavity-cutter", (revision) => ops.fillet(cavityId, verticalEdgeIds(current, cavityId, "cavity cutter"), plan.base.innerRadiusMm, revision), solidKept(cavityId));
      await native("cut-cavity", (revision) => ops.boolean([baseId], [cavityId], "difference", false, revision), (_before, after) => { requireSolid(after, baseId, stage); requireAbsent(after, [cavityId], stage); return [baseId]; });

      // Standoffs under the board holes.
      stage = "standoffs";
      for (const group of plan.standoffGroups) await sub((revision) => bossPattern(recipes, baseId, group, revision), baseId);
      if (plan.standoffFloorHoles) {
        stage = "standoff-floor-holes";
        const holes = plan.standoffFloorHoles;
        await sub((revision) => throughHoles(recipes, baseId, holes.entryCentersMm, [0, 0, 1], holes.diameterMm, holes.depthMm, revision), baseId);
      }
      // Tapered style: a 45 degree gusset under each hanging boss. Each pointed cone (apex down, on the wall corner) is clipped to
      // the cavity plus the 0.5 mm wall overlap, then all four are joined to the base before the bosses.
      if (plan.taper) {
        stage = "lid-boss-tapers";
        const taper = plan.taper;
        const coneIds: number[] = [];
        for (const cone of taper.cones) {
          const clipId = await create("create-taper-clip-box", (revision) => ops.createBox(taper.clipOriginMm, taper.clipSizeMm, undefined, revision));
          // createCone also leaves its profile Wire; the cleanup stage deletes it with the other construction Wires.
          let coneId = 0;
          await native("create-taper-cone", (revision) => ops.createCone(cone.topCenterMm, cone.radiusMm, 0, cone.heightMm, [0, 0, -1], [1, 0, 0], undefined, revision), (before, after) => {
            const solids = addedIds(before, after, "Solid");
            if (solids.length !== 1) throw new Error(`${stage}: expected one Solid from the taper cone, found ${solids.length}`);
            coneId = solids[0]!;
            return addedIds(before, after, undefined);
          });
          await native("clip-taper-cone", (revision) => ops.boolean([coneId], [clipId], "intersection", false, revision), (_before, after) => { requireSolid(after, coneId, stage); requireAbsent(after, [clipId], stage); return [coneId]; });
          coneIds.push(coneId);
        }
        await native("join-tapers", (revision) => ops.boolean([baseId], coneIds, "union", false, revision), (_before, after) => { requireSolid(after, baseId, stage); requireAbsent(after, coneIds, stage); return [baseId]; });
      }
      // Corner bosses for the lid screws.
      if (plan.posts) {
        stage = "lid-bosses";
        const posts = plan.posts;
        await sub((revision) => bossPattern(recipes, baseId, posts, revision), baseId);
      }

      // Lid plate and lip ring.
      stage = "lid-shell";
      lidId = await create("create-lid-plate", (revision) => ops.createBox(plan.lid.plateOriginMm, plan.lid.plateSizeMm, `${plan.name}-lid`, revision));
      if (plan.lid.plateRadiusMm > 0) await native("round-lid-corners", (revision) => ops.fillet(lidId, verticalEdgeIds(current, lidId, "lid plate"), plan.lid.plateRadiusMm, revision), solidKept(lidId));
      const lipId = await create("create-lip-block", (revision) => ops.createBox(plan.lid.lipOriginMm, plan.lid.lipSizeMm, undefined, revision));
      if (plan.lid.lipRadiusMm > 0) await native("round-lip-block", (revision) => ops.fillet(lipId, verticalEdgeIds(current, lipId, "lip block"), plan.lid.lipRadiusMm, revision), solidKept(lipId));
      const lipInnerId = await create("create-lip-inner-cutter", (revision) => ops.createBox(plan.lid.lipInnerOriginMm, plan.lid.lipInnerSizeMm, undefined, revision));
      if (plan.lid.lipInnerRadiusMm > 0) await native("round-lip-inner-cutter", (revision) => ops.fillet(lipInnerId, verticalEdgeIds(current, lipInnerId, "lip inner cutter"), plan.lid.lipInnerRadiusMm, revision), solidKept(lipInnerId));
      const notchIds: number[] = [];
      for (const notch of plan.lid.notches) {
        notchIds.push(await create("create-lip-notch-cutter", (revision) => ops.createCylinder(notch.centerMm, notch.radiusMm, notch.heightMm, undefined, revision, [0, 0, 1])));
      }
      let ringIds: number[] = [];
      await native("form-lip-ring", (revision) => ops.boolean([lipId], [lipInnerId, ...notchIds], "difference", false, revision), (before, after) => {
        requireAbsent(after, [lipInnerId, ...notchIds], stage);
        // Notches around the corner bosses split the ring into one piece per side; Plasticity may report them as more Solids.
        ringIds = [...(after.bodies.some((body) => body.id === lipId && body.type === "Solid") ? [lipId] : []), ...addedIds(before, after, "Solid")];
        if (ringIds.length === 0) throw new Error("lid-shell: the lip ring Boolean left no Solid");
        return ringIds;
      });
      await native("join-lip-to-lid", (revision) => ops.boolean([lidId], ringIds, "union", false, revision), (_before, after) => { requireSolid(after, lidId, stage); requireAbsent(after, ringIds, stage); return [lidId]; });
      if (plan.lid.holes) {
        stage = "lid-screw-holes";
        const holes = plan.lid.holes;
        const countersink = holes.countersink;
        await sub((revision) => countersink
          ? recipes.createCountersinkPattern({ targetId: lidId, entryCentersMm: holes.entryCentersMm, axis: [0, 0, -1], radialDirection: [1, 0, 0], throughDiameterMm: holes.diameterMm, countersinkMajorDiameterMm: countersink.majorDiameterMm, includedAngleDeg: countersink.includedAngleDeg, throughDepthMm: holes.depthMm, overshootMm: BOARD_CASE_CONSTANTS.overshootMm, revision })
          : throughHoles(recipes, lidId, holes.entryCentersMm, [0, 0, -1], holes.diameterMm, holes.depthMm, revision), lidId);
      }

      // Openings and vents.
      for (const opening of plan.openings) {
        stage = `opening:${opening.label}`;
        const targetId = opening.target === "lid" ? lidId : baseId;
        await sub((revision) => opening.shape === "circle"
          ? recipes.createThroughHole({ targetId, entryCenterMm: opening.entryCenterMm, axis: opening.axis, holeDiameterMm: opening.widthMm, throughDepthMm: opening.throughDepthMm, overshootMm: BOARD_CASE_CONSTANTS.overshootMm, revision })
          : recipes.createConnectorOpening({ targetId, entryCenterMm: opening.entryCenterMm, axis: opening.axis, widthDirection: opening.widthDirection, widthMm: opening.widthMm, heightMm: opening.heightMm, cornerRadiusMm: opening.cornerRadiusMm, throughDepthMm: opening.throughDepthMm, overshootMm: BOARD_CASE_CONSTANTS.overshootMm, revision }), targetId);
      }
      if (plan.vents) {
        stage = "vents";
        const vents = plan.vents;
        const targetId = vents.target === "lid" ? lidId : baseId;
        const slot = { targetId, axis: vents.axis, slotDirection: vents.slotDirection, overallLengthMm: vents.overallLengthMm, widthMm: vents.widthMm, throughDepthMm: vents.throughDepthMm, overshootMm: BOARD_CASE_CONSTANTS.overshootMm };
        await sub((revision) => vents.entryCentersMm.length === 1
          ? recipes.createSlottedHole({ ...slot, entryCenterMm: vents.entryCentersMm[0]!, revision })
          : recipes.createSlottedHolePattern({ ...slot, entryCentersMm: vents.entryCentersMm, revision }), targetId);
      }

      // Board stand-in for fit checks.
      if (plan.board) {
        stage = "board-stand-in";
        const board = plan.board;
        const id = await create("create-board-plate", (revision) => ops.createBox(board.originMm, board.sizeMm, `${plan.name}-board`, revision));
        boardId = id;
        for (const group of board.holeGroups) await sub((revision) => throughHoles(recipes, id, group.entryCentersMm, [0, 0, -1], group.diameterMm, board.sizeMm[2], revision), id);
      }

      // Construction Wires the sub-recipes kept (connector, slot and countersink profiles) are removed in one step.
      stage = "cleanup";
      const kept = new Set([baseId, lidId, ...(boardId !== undefined ? [boardId] : [])]);
      const leftovers = addedIds(initial, current, undefined).filter((id) => !kept.has(id));
      const strayNonWires = leftovers.filter((id) => current.bodies.find((body) => body.id === id)?.type !== "Wire");
      if (strayNonWires.length > 0) throw new Error(`cleanup: unexpected bodies left by the recipe: ${strayNonWires.join(", ")}`);
      if (leftovers.length > 0) {
        await native("delete-construction-wires", (revision) => ops.remove(leftovers, revision), (_before, after) => { requireAbsent(after, leftovers, stage); return leftovers; });
      }
      if (plan.derived.explodedMm > 0) {
        stage = "explode";
        await native("lift-lid", (revision) => ops.move([lidId], [0, 0, plan.derived.explodedMm], revision), solidKept(lidId));
      }
      stage = "names";
      for (const [id, name] of [[baseId, `${plan.name}-base`], [lidId, `${plan.name}-lid`], ...(boardId !== undefined ? [[boardId, `${plan.name}-board`]] : [])] as Array<[number, string]>) {
        if (current.bodies.find((body) => body.id === id)?.name !== name) await native("rename-body", (revision) => ops.rename(id, name, revision), solidKept(id));
      }

      stage = "final-check";
      const added = addedIds(initial, current, undefined).sort((left, right) => left - right);
      const expected = [...kept].sort((left, right) => left - right);
      if (JSON.stringify(added) !== JSON.stringify(expected)) throw new Error(`final-check: expected new bodies ${expected.join(", ")}, found ${added.join(", ")}`);
      for (const id of expected) requireSolid(current, id, stage);
      const missing = initial.bodies.filter((body) => !current.bodies.some((candidate) => candidate.id === body.id)).map((body) => body.id);
      if (missing.length > 0) throw new Error(`final-check: the recipe changed bodies it does not own: ${missing.join(", ")}`);

      return {
        recipe: "board-case",
        status: "completed",
        units: "mm",
        constants: BOARD_CASE_CONSTANTS,
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        bodies: { baseId, lidId, ...(boardId !== undefined ? { boardId } : {}) },
        derived: plan.derived,
        resultBodyIds: expected,
        undoSteps: current.undoDepth - initial.undoDepth,
        steps,
      };
    } catch (error) {
      throw await this.rollback(error, stage, steps, initial);
    }
  }

  // Undo exactly the steps this call added (by Undo depth), unless the last native result is uncertain.
  private async rollback(error: unknown, failedStage: string, steps: BoardCaseStep[], initial: RuntimeState): Promise<BoardCaseRecipeError> {
    const uncertain = mutationOutcomeIsUncertain(error) || (error as { uncertain?: unknown }).uncertain === true;
    const base = { cause: error, failedStage, completedSteps: steps };
    if (uncertain) return new BoardCaseRecipeError({ ...base, undoneSteps: 0, restored: false, uncertain: true, lastConfirmedRevision: steps.at(-1)?.afterRevision ?? initial.revision });
    let undone = 0;
    let state: RuntimeState;
    try {
      state = await this.operations.state();
    } catch (readError) {
      return new BoardCaseRecipeError({ ...base, undoneSteps: 0, restored: false, uncertain: false, lastConfirmedRevision: steps.at(-1)?.afterRevision ?? initial.revision, restoreNote: `state read failed: ${readError instanceof Error ? readError.message : String(readError)}` });
    }
    if (state.documentToken !== initial.documentToken) {
      return new BoardCaseRecipeError({ ...base, undoneSteps: 0, restored: false, uncertain: false, lastConfirmedRevision: state.revision, restoreNote: "the document changed, so nothing was undone" });
    }
    let note: string | undefined;
    try {
      for (let remaining = state.undoDepth - initial.undoDepth; remaining > 0; remaining -= 1) {
        const before = state.undoDepth;
        state = await this.operations.undo(state.revision);
        undone += 1;
        if (state.undoDepth >= before) { note = `Undo did not lower the Undo depth (${before} -> ${state.undoDepth})`; break; }
      }
    } catch (undoError) {
      note = `undo failed: ${undoError instanceof Error ? undoError.message : String(undoError)}`;
      try { state = await this.operations.state(); } catch { /* keep the last state */ }
    }
    const restored = state.documentToken === initial.documentToken && state.undoDepth === initial.undoDepth && sameBodies(initial, state);
    if (!restored && !note) note = `Undo depth ${state.undoDepth} (start ${initial.undoDepth}), ${state.bodies.length} bodies (start ${initial.bodies.length})`;
    return new BoardCaseRecipeError({ ...base, undoneSteps: undone, restored, uncertain: false, lastConfirmedRevision: state.revision, ...(note ? { restoreNote: note } : {}) });
  }
}

function bossPattern(recipes: PlasticityRecipes, targetId: number, pattern: CylinderPattern, revision: string): Promise<SubRecipeResult> {
  const shared = { targetId, axis: [0, 0, 1] as Vector3, outerDiameterMm: pattern.outerDiameterMm, heightMm: pattern.heightMm, holeDiameterMm: pattern.holeDiameterMm, holeDepthMm: pattern.holeDepthMm, baseOverlapMm: pattern.baseOverlapMm, cutterOvershootMm: BOARD_CASE_CONSTANTS.overshootMm, revision };
  return pattern.centersMm.length === 1
    ? recipes.createScrewBoss({ ...shared, baseCenterMm: pattern.centersMm[0]! })
    : recipes.createScrewBossPattern({ ...shared, baseCentersMm: pattern.centersMm });
}

function throughHoles(recipes: PlasticityRecipes, targetId: number, centers: Vector3[], axis: Vector3, diameterMm: number, depthMm: number, revision: string): Promise<SubRecipeResult> {
  const shared = { targetId, axis, holeDiameterMm: diameterMm, throughDepthMm: depthMm, overshootMm: BOARD_CASE_CONSTANTS.overshootMm, revision };
  return centers.length === 1 ? recipes.createThroughHole({ ...shared, entryCenterMm: centers[0]! }) : recipes.createThroughHolePattern({ ...shared, entryCentersMm: centers });
}

function verticalEdgeIds(state: RuntimeState, bodyId: number, label: string): string[] {
  const body = state.bodies.find((candidate) => candidate.id === bodyId);
  if (!body) throw new Error(`${label} ${bodyId} disappeared`);
  const ids = body.edges.filter((edge) => {
    if (!edge.line) return false;
    const length = Math.hypot(...edge.tangent);
    return length > 1e-9 && Math.abs(Math.abs(edge.tangent[2] / length) - 1) < 1e-6;
  }).map((edge) => edge.id);
  if (ids.length !== 4) throw new Error(`Expected four vertical edges on the ${label} ${bodyId}, found ${ids.length}`);
  return ids;
}

function singleAdded(before: RuntimeState, after: RuntimeState, label: string, type: string): number {
  const added = addedIds(before, after, undefined);
  if (added.length !== 1 || after.bodies.find((body) => body.id === added[0])?.type !== type) throw new Error(`Expected one ${type} from ${label}, found ${added.length} new bodies`);
  return added[0]!;
}

function addedIds(before: RuntimeState, after: RuntimeState, type: string | undefined): number[] {
  requireSameDocument(before, after);
  const known = new Set(before.bodies.map((body) => body.id));
  return after.bodies.filter((body) => !known.has(body.id) && (type === undefined || body.type === type)).map((body) => body.id);
}

function requireSolid(state: RuntimeState, id: number, label: string): void {
  if (state.bodies.find((body) => body.id === id)?.type !== "Solid") throw new Error(`${label}: body ${id} is not a current Solid`);
}

function requireAbsent(state: RuntimeState, ids: number[], label: string): void {
  const remaining = ids.filter((id) => state.bodies.some((body) => body.id === id));
  if (remaining.length > 0) throw new Error(`${label}: bodies were not consumed: ${remaining.join(", ")}`);
}

function requireSameDocument(before: RuntimeState, after: RuntimeState): void {
  if (before.documentToken !== after.documentToken) throw new Error("Plasticity document changed during the board case recipe");
}

function sameBodies(left: RuntimeState, right: RuntimeState): boolean {
  const key = (state: RuntimeState) => JSON.stringify(state.bodies.map((body) => [body.id, body.type, body.name]).sort((a, b) => Number(a[0]) - Number(b[0])));
  return key(left) === key(right);
}

function overlaps(a: Vector2, b: Vector2): boolean {
  return a[0] < b[1] - EPS && b[0] < a[1] - EPS;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return overlaps([a.min[0], a.max[0]], [b.min[0], b.max[0]]) && overlaps([a.min[1], a.max[1]], [b.min[1], b.max[1]]);
}

function rectInside(inner: Rect, outer: Rect): boolean {
  return inner.min[0] >= outer.min[0] - EPS && inner.min[1] >= outer.min[1] - EPS && inner.max[0] <= outer.max[0] + EPS && inner.max[1] <= outer.max[1] + EPS;
}

function circleHitsRect(center: Vector2, radius: number, rect: Rect): boolean {
  const dx = Math.max(rect.min[0] - center[0], 0, center[0] - rect.max[0]);
  const dy = Math.max(rect.min[1] - center[1], 0, center[1] - rect.max[1]);
  return Math.hypot(dx, dy) < radius - EPS;
}

function r9(value: number): number {
  const rounded = Math.round(value * 1e9) / 1e9;
  return Object.is(rounded, -0) ? 0 : rounded;
}
