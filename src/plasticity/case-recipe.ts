// plasticity_create_board_case: a two-part enclosure (base + lid) around a rectangular board, built in one call from
// parameters. Every derived dimension is computed here from the parameters (never read back from geometry) and returned
// with the result, so later steps never re-derive a cavity or a boss axis from faces.
//
// The plan (derived numbers, validation, the cutter list, the planned Undo step count) is a pure function: planBoardCase.
// Everything that can be predicted from the inputs is refused there, before the first native call. BoardCaseRecipe
// composes the existing recipes (screw boss, through hole, countersink, connector opening, slotted hole) and a few direct
// native operations, reads the result back (bounds, native validity, shortest edge) and, on a failure part-way or a failed
// read-back, undoes its own steps (measured by the Undo depth) before it reports.
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
// How the four lid-screw bosses are carried: standing on the floor in a wider cavity ("floor", the default: the board
// drops in past them), hung from the walls with a 45 degree gusset under each ("tapered") or hung from the walls with a
// flat underside ("hanging"). The two hung styles overhang the board corners in plan view.
export type BossStyle = "tapered" | "hanging" | "floor";
export const BOSS_STYLES: readonly BossStyle[] = ["tapered", "hanging", "floor"];
export const DEFAULT_BOSS_STYLE: BossStyle = "floor";
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

// Limits the plan enforces before any native call (all millimetres unless named otherwise). Returned as `limits`.
export const BOARD_CASE_LIMITS = {
  maxBoardSizeMm: 500,
  maxHeightMm: 200,
  minHoleDiameterMm: 0.5,
  // A pilot hole is at least this deep.
  minHoleDepthMm: 0.5,
  // The thinnest material the plan builds: the lip wall, the wall around a pilot or clearance hole in a boss or standoff.
  minLipWallMm: 0.4,
  minHoleWallMm: 0.4,
  // The floor, like the wall, is at least this thick.
  minFloorMm: 0.8,
  // originMm stays within this distance of the document origin (the kernel's modelling space is finite).
  maxOriginMm: 100000,
  // Material kept between two openings (or vent slots) on one face.
  minWebMm: 0.4,
  maxUndoSteps: 400,
  // The real corner wall (diagonal) must be at least the larger of these two.
  minCornerWallMm: 0.8,
  minCornerWallFractionOfWall: 0.75,
  // The board's square corner keeps this much to the rounded cavity corner.
  cornerFitMarginMm: 0.05,
  // Every boss and gusset stays this far inside the outer profile.
  bossInsideOuterMm: 0.8,
  // The lid-screw head (countersink) circle stays this far inside the lid outline.
  headInsideLidMm: 0.5,
  // A lid lip piece between a boss notch and a corner shorter than this is removed (the notch is widened to the corner).
  minLipPieceMm: 1,
  // A standoff may reach into the wall, but this much wall stays outside it.
  standoffWallKeptMm: 0.4,
  // A standoff is at least this much wider than its board hole.
  standoffOverBoardHoleMm: 1,
  // Plan-view clearance the board needs to drop into the finished base past the corner bosses.
  dropInClearanceMm: 0.2,
  // The read-back refuses an edge shorter than this.
  minEdgeMm: 0.05,
  // The read-back compares bounds within this tolerance.
  readBackToleranceMm: 1e-3,
  // Flat opening ceilings wider than this are listed in printability.openingCeilings.
  reportBridgeOverMm: 6,
} as const;

export const BOARD_CASE_PRINTABILITY_SCOPE = "maxBossOverhangDeg (with lid screws only): the lid-screw boss undersides only (gusset or flat underside), base printed floor-down. lidMaxOverhangDeg: every lid face, lid printed top face down (the countersink cones are its only faces that are neither vertical nor horizontal). openingCeilings: the flat ceiling of every rect or rounded-rect wall opening wider than 6 mm (a bridge when the base prints floor-down). Not covered: the round crowns of circle wall openings, rounded opening corners and wall vent slot ends, and strength or material.";

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
      // tapered/hanging: build even though the bosses block the board from dropping in (derived.assembly.boardDropIn false).
      allowBlockedBoard?: boolean | undefined;
      // floor: the axis the cavity grows along (default: the axis whose end walls carry no opening).
      growAxis?: "x" | "y" | undefined;
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

export interface BoardCaseOpeningCeiling { label: string; wall: CaseWall; widthMm: number; zMm: number }

export interface BoardCaseDerived {
  outerMm: Bounds;
  cavityMm: Bounds;
  innerCornerRadiusMm: number;
  // The real corner wall along the corner diagonal: wallMm x sqrt 2 - (outer radius - inner radius) x (sqrt 2 - 1).
  cornerWallMm: number;
  floorTopZMm: number;
  boardMm: Bounds;
  boardTopZMm: number;
  componentTopZMm: number;
  wallTopZMm: number;
  lidTopZMm: number;
  // The lid's planned bounds (plate and lip, with the exploded lift).
  lidMm: Bounds;
  explodedMm: number;
  standoffAxesMm: Vector2[];
  standoffTopZMm?: number;
  lidBossAxesMm: Vector2[];
  lidBossBottomZMm?: number;
  // Present with lid fasteners.
  bossStyle?: BossStyle;
  // Plan view: can the board be lowered straight into the finished base?
  assembly: { boardDropIn: boolean; note: string };
  // Free space between each board edge and the cavity wall. boardClearance on every side, plus half the cavity growth
  // on the two sides of the grown axis for bossStyle "floor".
  boardWallClearanceMm: { xNeg: number; xPos: number; yNeg: number; yPos: number };
  // bossStyle "floor" only: how much the cavity grew in [x, y] beyond board + 2 x boardClearance, the axis, and why.
  cavityGrowthMm?: Vector2;
  growAxis?: "x" | "y";
  growAxisReason?: string;
  // bossStyle "tapered" only. bottomZMm is the lowest point of the taper inside the cavity.
  bossTaper?: { angleDeg: 45; bottomZMm: number; addedHeightMm: number };
  // Always present; `scope` says what it covers. maxBossOverhangDeg is present with lid fasteners (bosses) only.
  printability: {
    baseOrientation: "floor-down";
    maxBossOverhangDeg?: number;
    scope: string;
    lidPrintOrientation: "top face down";
    lidMaxOverhangDeg: number;
    openingCeilings: BoardCaseOpeningCeiling[];
  };
  lipOuterMm: Bounds;
  lipInnerMm: Bounds;
  openings: BoardCaseOpeningDerived[];
  vents?: { on: "lid" | CaseWall; centersMm: Vector3[]; slotDirection: Vector3; slotWidthMm: number; slotLengthMm: number };
  // The Undo steps the build will take (the composition below, step for step).
  plannedUndoSteps: number;
  fasteners: {
    standoffs?: {
      screw: ScrewSize;
      mode: "pilot" | "heat-set-insert" | "through";
      holeDiameterMm: number;
      holeDepthMm: number;
      // One entry per standoff, in the order of standoffAxesMm.
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

// A lid lip notch around a corner boss: a cylinder (radius boss + lid clearance), or, when the lip piece left between that
// cylinder and the corner would be shorter than minLipPieceMm, a box from the corner past the whole boss circle.
export type LipNotch =
  | { kind: "cylinder"; centerMm: Vector3; radiusMm: number; heightMm: number }
  | { kind: "box"; originMm: Vector3; sizeMm: Vector3; cornerPieceMm: number };

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
    notches: LipNotch[];
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
  const LIMITS = BOARD_CASE_LIMITS;
  const atMost = (label: string, value: number, limit: number, what: string) => { if (value > limit + EPS) fail(`${label} ${value} exceeds the ${limit} mm ${what} limit`); };
  const holeAtLeast = (label: string, value: number) => { if (value < LIMITS.minHoleDiameterMm - EPS) fail(`${label} ${value} is below the ${LIMITS.minHoleDiameterMm} mm minimum hole diameter`); };
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
  atMost("board.lengthMm", L, LIMITS.maxBoardSizeMm, "board size");
  atMost("board.widthMm", W, LIMITS.maxBoardSizeMm, "board size");
  for (const [label, value] of [["board.thicknessMm", T], ["board.componentHeightMm", Hc], ["board.undersideClearanceMm", U], ["lid.lipDepthMm", d], ["exploded", exploded]] as const) atMost(label, value, LIMITS.maxHeightMm, "height");
  if (lw < LIMITS.minLipWallMm - EPS) fail(`lid.lipWallMm ${lw} is below the ${LIMITS.minLipWallMm} mm minimum lip wall`);
  if (f < LIMITS.minFloorMm - EPS) fail(`walls.floorMm ${f} is below the ${LIMITS.minFloorMm} mm minimum floor`);
  if (input.originMm.some((value) => Math.abs(value) > LIMITS.maxOriginMm)) fail(`originMm must stay within ${LIMITS.maxOriginMm} mm of the document origin (got ${input.originMm.join(", ")})`);

  const holes = input.board.holes ?? [];
  if (holes.length > 32) fail("board.holes takes at most 32 holes");
  holes.forEach((hole, index) => {
    const r = positive(`board.holes[${index}].diameterMm`, hole.diameterMm) / 2;
    holeAtLeast(`board.holes[${index}].diameterMm`, hole.diameterMm);
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
  const bossStyle: BossStyle = lidFasteners?.bossStyle ?? DEFAULT_BOSS_STYLE;
  if (!BOSS_STYLES.includes(bossStyle)) fail(`lid.fasteners.bossStyle must be one of ${BOSS_STYLES.join(", ")} (got ${String(bossStyle)})`);
  const allowBlockedBoard = lidFasteners?.allowBlockedBoard ?? false;
  if (typeof allowBlockedBoard !== "boolean") fail("lid.fasteners.allowBlockedBoard must be true or false");
  const growAxisInput = lidFasteners?.growAxis;
  if (growAxisInput !== undefined && growAxisInput !== "x" && growAxisInput !== "y") fail(`lid.fasteners.growAxis must be "x" or "y" (got ${String(growAxisInput)})`);
  if (growAxisInput !== undefined && bossStyle !== "floor") fail(`lid.fasteners.growAxis applies only to bossStyle "floor" (got bossStyle "${bossStyle}")`);
  const bossD = lidFasteners ? positive("lid.fasteners.bossDiameterMm", lidFasteners.bossDiameterMm ?? 6) : 0;
  const bossR = bossD / 2;
  // Each corner boss axis is this far from both adjoining inner walls, so the boss overlaps each wall by bossWallOverlapMm.
  const bossInset = bossR - bossWallOverlapMm;
  if (lidFasteners && bossInset <= 0) fail(`lid.fasteners.bossDiameterMm ${bossD} must exceed ${2 * bossWallOverlapMm} mm`);
  // "floor": a boss standing on the floor must lie outside the board keep-out (board outline + boardClearance). The keep-out
  // edge must be at least one boss radius from the boss axis, so the cavity grows by 2 x (bossInset + bossR) in ONE axis.
  // Growing an axis moves its two end walls away from the board, so an opening on one of them would no longer reach the
  // board edge. Rule: grow the axis whose two end walls carry no opening (wall openings and wall vents count); when neither
  // carries one, the axis whose growth adds less floor area (x when growing x adds no more area than growing y); when both
  // carry one, refuse unless lid.fasteners.growAxis names the axis. The other axis keeps boardClearance exactly.
  let growth: Vector2 = [0, 0];
  let growAxis: "x" | "y" | undefined;
  let growAxisReason: string | undefined;
  if (lidFasteners && bossStyle === "floor") {
    const need = 2 * (bossInset + bossR);
    const opened = new Set<CaseWall>([
      ...(input.openings ?? []).map((opening) => opening.wall).filter((wall): wall is CaseWall => wall !== "lid" && wall !== "floor"),
      ...(input.vents && input.vents.on !== "lid" ? [input.vents.on] : []),
    ]);
    const xOpen = (["x-", "x+"] as const).filter((wall) => opened.has(wall));
    const yOpen = (["y-", "y+"] as const).filter((wall) => opened.has(wall));
    if (growAxisInput !== undefined) {
      growAxis = growAxisInput;
      growAxisReason = "lid.fasteners.growAxis";
    } else if (xOpen.length === 0 && yOpen.length === 0) {
      const areaX = need * (W + 2 * bc);
      const areaY = need * (L + 2 * bc);
      growAxis = areaX <= areaY + EPS ? "x" : "y";
      growAxisReason = "no wall carries an opening: the axis that adds less floor area";
    } else if (yOpen.length === 0) {
      growAxis = "y";
      growAxisReason = `the x walls carry openings (${xOpen.join(", ")})`;
    } else if (xOpen.length === 0) {
      growAxis = "x";
      growAxisReason = `the y walls carry openings (${yOpen.join(", ")})`;
    } else {
      fail(`bossStyle "floor" widens the cavity by ${r9(need)} mm along x or y, which moves that axis's two end walls ${r9(need / 2)} mm away from the board; openings sit on both x walls (${xOpen.join(", ")}) and y walls (${yOpen.join(", ")}), so pass lid.fasteners.growAxis "x" or "y" to choose which walls move`);
    }
    growth = growAxis === "x" ? [need, 0] : [0, need];
  }

  // --- the shell -----------------------------------------------------------------------------------------------------
  const cavityL = L + 2 * bc + growth[0];
  const cavityW = W + 2 * bc + growth[1];
  const outerL = cavityL + 2 * w;
  const outerW = cavityW + 2 * w;
  if (Ro > 0 && Ro >= Math.min(outerL, outerW) / 2 - EPS) fail(`walls.outerCornerRadiusMm ${Ro} must be less than half the outer size (${r9(Math.min(outerL, outerW) / 2)})`);
  // Inner corner radius: the outer radius minus the wall (a uniform wall), but never more than the board's square corner
  // allows. The board corner sits boardClearance (c) from both walls; a cavity corner of radius Ri clears it when
  // Ri <= c x (2 + sqrt 2). The plan keeps cornerFitMarginMm between the board corner and the arc:
  // Ri <= (c x sqrt 2 - margin) / (sqrt 2 - 1).
  const RiBoard = Math.max(0, (Math.SQRT2 * bc - LIMITS.cornerFitMarginMm) / (Math.SQRT2 - 1));
  const Ri = Math.min(Math.max(0, Ro - w), RiBoard);
  const cornerWall = w * Math.SQRT2 - (Ro - Ri) * (Math.SQRT2 - 1);
  const cavMin: Vector2 = [ox + w, oy + w];
  const cavMax: Vector2 = [ox + w + cavityL, oy + w + cavityW];
  const cavRect: Rect = { min: cavMin, max: cavMax };
  const outerRect: Rect = { min: [ox, oy], max: [ox + outerL, oy + outerW] };
  const floorTopZ = oz + f;
  const boardMin: Vector2 = [cavMin[0] + bc + growth[0] / 2, cavMin[1] + bc + growth[1] / 2];
  if (lidFasteners && bossStyle === "tapered" && Ro > 0 && w - bossWallOverlapMm < Ro * (1 - Math.SQRT1_2) - EPS) {
    fail(`the tapered boss gusset is clipped ${bossWallOverlapMm} mm into each wall; with walls.wallMm ${w} and walls.outerCornerRadiusMm ${Ro} that corner would show outside the rounded outer corner (needs wallMm - ${bossWallOverlapMm} >= ${r9(Ro * (1 - Math.SQRT1_2))}); thicken the wall, reduce the outer radius or use bossStyle "hanging"`);
  }
  const cornerLimit = Math.max(LIMITS.minCornerWallMm, LIMITS.minCornerWallFractionOfWall * w);
  if (cornerWall < cornerLimit - EPS) {
    const maxRo = RiBoard + (w * Math.SQRT2 - cornerLimit) / (Math.SQRT2 - 1);
    fail(`the corner wall is ${r3(cornerWall)} mm (walls.wallMm ${w} x sqrt 2 - (outer radius ${Ro} - inner radius ${r3(Ri)}) x (sqrt 2 - 1)), below the ${r3(cornerLimit)} mm minimum (the larger of ${LIMITS.minCornerWallMm} and ${LIMITS.minCornerWallFractionOfWall} x walls.wallMm); the board's square corner caps the inner radius at ${r3(RiBoard)}, so walls.outerCornerRadiusMm may be at most ${floor3(maxRo)}`);
  }

  // --- standoffs -----------------------------------------------------------------------------------------------------
  const standoffInput = input.standoffs;
  const supportH = standoffInput ? positive("standoffs.heightMm", standoffInput.heightMm ?? U) : U;
  if (standoffInput) atMost("standoffs.heightMm", supportH, LIMITS.maxHeightMm, "height");
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
      holeAtLeast("standoffs.fastener.pilotDiameterMm", holeDiameterMm);
      holeDepthMm = positive("standoffs.fastener.pilotDepthMm", fastener.pilotDepthMm ?? supportH);
      if (holeDepthMm < LIMITS.minHoleDepthMm - EPS) fail(`standoffs.fastener.pilotDepthMm ${holeDepthMm} is below the ${LIMITS.minHoleDepthMm} mm minimum hole depth`);
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
    holes.forEach((hole, index) => standoffs.push({ label: `standoff ${index}`, axis: [boardMin[0] + hole.xMm, boardMin[1] + hole.yMm], radius: outerDiameters[index]! / 2 }));
    outerDiameters.forEach((od, index) => {
      positive(`standoffs.outerDiameterMm (hole ${index})`, od);
      if (od <= holeDiameterMm + EPS) fail(`standoff ${index}: outer diameter ${od} must exceed its ${holeDiameterMm} mm hole`);
      if ((od - holeDiameterMm) / 2 < LIMITS.minHoleWallMm - EPS) fail(`standoff ${index}: outer diameter ${od} leaves a ${r9((od - holeDiameterMm) / 2)} mm wall around its ${holeDiameterMm} mm hole, below the ${LIMITS.minHoleWallMm} mm minimum (needs ${r9(holeDiameterMm + 2 * LIMITS.minHoleWallMm)})`);
      if (extra.minWallMm !== undefined && od < holeDiameterMm + 2 * extra.minWallMm - EPS) {
        fail(`standoff ${index}: outer diameter ${od} leaves less than the sourced ${extra.minWallMm} mm insert wall around the ${holeDiameterMm} mm hole (needs ${r9(holeDiameterMm + 2 * extra.minWallMm)})`);
      }
      const boardHole = holes[index]!.diameterMm;
      if (od < boardHole + LIMITS.standoffOverBoardHoleMm - EPS) fail(`standoff ${index}: outer diameter ${od} must exceed the Ø${boardHole} board hole above it by at least ${LIMITS.standoffOverBoardHoleMm} mm (needs ${r9(boardHole + LIMITS.standoffOverBoardHoleMm)}), or the board has nothing to sit on`);
    });
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
    standoffFastener = { screw: fastener.screw, mode: fastener.mode, holeDiameterMm, holeDepthMm: fastener.mode === "through" ? r9(supportH + f) : holeDepthMm, outerDiametersMm: [...outerDiameters], heightMm: supportH, source, ...extra };
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
  // The circle the screw head needs on the lid top: the countersink rim, or the given head (or the hole) without one.
  let headCircleDiameter = 0;
  if (lidFasteners) {
    if (lidFasteners.count !== undefined && lidFasteners.count !== 4) fail("lid.fasteners.count must be 4 (one boss per cavity corner)");
    const fit = lidFasteners.clearanceFit ?? "medium";
    const lidHole = clearanceHole(lidFasteners.screw, fit);
    let baseHole: NonNullable<BoardCaseDerived["fasteners"]["lid"]>["baseHole"];
    if (lidFasteners.base === "pilot") {
      const diameterMm = positive("lid.fasteners.pilotDiameterMm", requirePilotDiameter(lidFasteners.screw, lidFasteners.pilotDiameterMm, "lid.fasteners"));
      holeAtLeast("lid.fasteners.pilotDiameterMm", diameterMm);
      if (lidFasteners.pilotDepthMm === undefined) fail("lid.fasteners.pilotDepthMm is required with base \"pilot\": it sets the corner boss length (boss = pilot depth + 1 mm)");
      const depthMm = positive("lid.fasteners.pilotDepthMm", lidFasteners.pilotDepthMm);
      if (depthMm < LIMITS.minHoleDepthMm - EPS) fail(`lid.fasteners.pilotDepthMm ${depthMm} is below the ${LIMITS.minHoleDepthMm} mm minimum hole depth`);
      baseHole = { diameterMm, depthMm, source: CALLER_SOURCE };
    } else {
      const insert = heatSetInsert(lidFasteners.screw, lidFasteners.insertLengthMm);
      if (bossD < insert.holeDiameterMm + 2 * insert.minWallMm - EPS) {
        fail(`lid boss diameter ${bossD} leaves less than the sourced ${insert.minWallMm} mm insert wall around the ${insert.holeDiameterMm} mm ${insert.insert} hole (needs ${r9(insert.holeDiameterMm + 2 * insert.minWallMm)})`);
      }
      baseHole = { diameterMm: insert.holeDiameterMm, depthMm: insert.blindHoleDepthMm, source: insert.source, confidence: insert.confidence, insert: insert.insert, minWallMm: insert.minWallMm };
    }
    if (baseHole.diameterMm >= bossD - EPS) fail(`lid boss diameter ${bossD} must exceed its ${baseHole.diameterMm} mm hole`);
    if ((bossD - baseHole.diameterMm) / 2 < LIMITS.minHoleWallMm - EPS) fail(`lid boss diameter ${bossD} leaves a ${r9((bossD - baseHole.diameterMm) / 2)} mm wall around its ${baseHole.diameterMm} mm hole, below the ${LIMITS.minHoleWallMm} mm minimum (needs ${r9(baseHole.diameterMm + 2 * LIMITS.minHoleWallMm)})`);
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
      headCircleDiameter = headDiameterMm;
    } else {
      headCircleDiameter = lidFasteners.headDiameterMm !== undefined ? positive("lid.fasteners.headDiameterMm", lidFasteners.headDiameterMm) : lidHole.diameterMm;
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
  const cavityCorners: Vector2[] = [[cavMin[0], cavMin[1]], [cavMax[0], cavMin[1]], [cavMin[0], cavMax[1]], [cavMax[0], cavMax[1]]];
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
  // A standoff may merge into the wall, but walls.wallMm - standoffWallKeptMm is as far as it may reach into it.
  {
    const reach = w - LIMITS.standoffWallKeptMm;
    const grownCavity = growRect(cavRect, reach);
    standoffs.forEach((standoff, index) => {
      // Where the board caps the inner radius the corner wall is thinner than walls.wallMm, so the wall left outside the
      // standoff is also measured to the outer profile itself.
      const outside = roundedRectInsideDistance(standoff.axis, outerRect, Ro) - standoff.radius;
      if (roundedRectInsideDistance(standoff.axis, grownCavity, Ri + reach) < standoff.radius - EPS || outside < LIMITS.standoffWallKeptMm - EPS) {
        const into = standoff.radius - roundedRectInsideDistance(standoff.axis, cavRect, Ri);
        fail(`standoff ${index} (Ø${r9(2 * standoff.radius)} under board.holes[${index}]) reaches ${r3(into)} mm into the wall and leaves ${r3(outside)} mm of wall outside it; a standoff may reach at most walls.wallMm - ${LIMITS.standoffWallKeptMm} = ${r9(reach)} mm into it, so ${LIMITS.standoffWallKeptMm} mm of wall stays outside it (rounded corners included): move the hole inward, use a smaller standoffs.outerDiameterMm or thicken the wall`);
      }
    });
  }
  if (lidFasteners) {
    // Every boss, and (tapered) every gusset, stays bossInsideOuterMm inside the outer profile, rounded corners included.
    // A gusset is clipped bossWallOverlap into the walls, so its outermost points are the corners of the cavity grown by
    // that overlap (the cone top disc always covers them).
    for (const post of posts) {
      const margin = roundedRectInsideDistance(post.axis, outerRect, Ro) - post.radius;
      if (margin < LIMITS.bossInsideOuterMm - EPS) {
        fail(`${post.label} (Ø${bossD}) is ${r3(margin)} mm from the outer surface; every boss and gusset must stay ${LIMITS.bossInsideOuterMm} mm inside the outer profile, rounded corners included (a boss overlaps its walls by ${bossWallOverlapMm} mm, so walls.wallMm must be at least ${LIMITS.bossInsideOuterMm + bossWallOverlapMm}): thicken the wall or reduce walls.outerCornerRadiusMm`);
      }
    }
    if (bossStyle === "tapered") {
      const clip = growRect(cavRect, bossWallOverlapMm);
      const clipCorners: Vector2[] = [[clip.min[0], clip.min[1]], [clip.max[0], clip.min[1]], [clip.min[0], clip.max[1]], [clip.max[0], clip.max[1]]];
      const margin = Math.min(...clipCorners.map((point) => roundedRectInsideDistance(point, outerRect, Ro)));
      if (margin < LIMITS.bossInsideOuterMm - EPS) {
        fail(`the 45 degree gussets reach ${r3(margin)} mm from the outer surface at the rounded corners; every boss and gusset must stay ${LIMITS.bossInsideOuterMm} mm inside the outer profile: reduce walls.outerCornerRadiusMm, thicken the wall or use bossStyle "floor"`);
      }
    }
    // The screw head (countersink rim) stays headInsideLidMm inside the lid outline, rounded corners included.
    for (const [index, post] of posts.entries()) {
      const margin = roundedRectInsideDistance(post.axis, outerRect, Ro) - headCircleDiameter / 2;
      if (margin < LIMITS.headInsideLidMm - EPS) {
        fail(`the Ø${headCircleDiameter} ${lidHoleSpec?.countersink ? "countersink" : "screw head"} over lid boss ${index} comes ${r3(margin)} mm from the lid edge; it must stay ${LIMITS.headInsideLidMm} mm inside the lid outline, rounded corners included: use a smaller head, a smaller walls.outerCornerRadiusMm or thicker walls`);
      }
    }
  }

  // Lid lip notches: the piece of lip a round notch leaves between itself and the corner; under minLipPieceMm the notch
  // becomes a box from the corner past the whole boss circle (boss + lid clearance), so no sliver remains.
  const lipCornerPiece = lidFasteners ? lipCornerPieceMm({ inset: s, notchRadius: bossR + lc, lipClearance: lc, lipWall: lw, outerRadius: lipRadius, innerRadius: lipInnerRadius }) : 0;
  const widenNotches = lipCornerPiece > 1e-6 && lipCornerPiece < LIMITS.minLipPieceMm - EPS;

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
  // A cylinder (standoff or boss) collides with a wall feature when the cutter would touch it, or, when the cylinder
  // reaches the inner wall plane (it merges into the wall), when the feature overlaps its footprint on the wall: its
  // whole diameter along the wall over its height.
  const cylinderHitsWallFeature = (wall: CaseWall, along: Vector2, z: Vector2, center: Vector2, radius: number, height: Vector2): boolean => {
    if (!overlaps(z, height)) return false;
    if (circleHitsRect(center, radius, wallCutterRect(wall, along))) return true;
    const frame = wallFrame(wall);
    if (Math.abs(center[frame.normalIndex]! - frame.innerFace) >= radius - EPS) return false;
    const c = center[frame.alongIndex]!;
    return overlaps(along, [c - radius, c + radius]);
  };
  const standoffZ: Vector2 = [floorTopZ - OV, boardBottomZ];
  const postZ: Vector2 = [postBottomZ, wallTopZ];
  // Tapered gusset: a cone with its apex on each cavity corner, 45 degrees from vertical, flaring to the boss and a
  // bossWallOverlap further (the joint above the boss bottom). At height z its plan is a disc of radius z - apexZ around the
  // corner, clipped bossWallOverlap into the walls. Its footprint on a wall is that disc's chord along the inner wall plane,
  // which is the full radius (the corner lies on the plane), so the plan test below is also the wall-footprint test.
  const taperTopZ = postBottomZ + OV;
  const taperCorners: Vector2[] = posts.length > 0 && bossStyle === "tapered" ? cavityCorners : [];
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
      if (cylinderHitsWallFeature(wall, along, z, standoff.axis, standoff.radius, standoffZ)) fail(`${label} on wall ${wall} collides with ${standoff.label}`);
    }
    for (const post of posts) {
      if (cylinderHitsWallFeature(wall, along, z, post.axis, post.radius, postZ)) fail(`${label} on wall ${wall} collides with ${post.label}`);
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
  const openingCeilings: BoardCaseOpeningCeiling[] = [];
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
      holeAtLeast(`${label}: widthMm (circle diameter)`, width);
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
      // A flat ceiling (rect, or the straight part of a rounded-rect) is a bridge when the base prints floor-down.
      const flat = opening.shape === "circle" ? 0 : width - 2 * corner;
      if (flat > LIMITS.reportBridgeOverMm + EPS) openingCeilings.push({ label, wall: opening.wall, widthMm: r9(flat), zMm: r9(zBottom + height) });
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
    if (vent.slots > 1 && pitch < sw + LIMITS.minWebMm - EPS) fail(`vents.pitchMm ${pitch} must exceed vents.slotWidthMm ${sw} by at least ${LIMITS.minWebMm} mm (the web between two slots), so at least ${r9(sw + LIMITS.minWebMm)}`);
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
  // Openings and vent slots on one face must not overlap (their profiles would share Regions) and must leave a web of at
  // least minWebMm between them (touching openings leave none).
  for (let first = 0; first < features.length; first += 1) {
    for (let second = first + 1; second < features.length; second += 1) {
      const a = features[first]!;
      const b = features[second]!;
      if (a.face !== b.face) continue;
      const where = a.face === "lid" || a.face === "floor" ? a.face : `wall ${a.face}`;
      if (rectsOverlap(a.inPlane, b.inPlane)) fail(`${a.label} and ${b.label} overlap on the ${where}`);
      const web = rectGap(a.inPlane, b.inPlane);
      if (web < LIMITS.minWebMm - EPS) fail(`${a.label} and ${b.label} on the ${where} leave a ${r9(Math.max(0, web))} mm web between them; openings on one face need at least ${LIMITS.minWebMm} mm`);
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

  // --- assembly: can the board drop into the finished base? (plan view) ----------------------------------------------
  // It can when no corner boss and no gusset overlaps the board outline grown by dropInClearanceMm.
  const dropIn = LIMITS.dropInClearanceMm;
  const grownBoard: Rect = { min: [boardMin[0] - dropIn, boardMin[1] - dropIn], max: [boardMin[0] + L + dropIn, boardMin[1] + W + dropIn] };
  const blockers = posts.filter((post) => circleHitsRect(post.axis, post.radius, grownBoard)).map((post) => post.label);
  if (taperHitsRect(grownBoard, [-Infinity, Infinity])) blockers.push("the 45 degree gussets");
  const boardDropIn = blockers.length === 0;
  const assembly = {
    boardDropIn,
    note: boardDropIn
      ? posts.length === 0
        ? "no corner bosses: the board drops straight in"
        : `plan view: no corner boss or gusset overlaps the board outline grown by ${dropIn} mm, so the board drops straight in past the ${bossStyle} bosses`
      : `plan view: ${blockers.join(", ")} overlap the board outline grown by ${dropIn} mm, so the board cannot be lowered straight into the finished base${bossStyle === "floor" ? " (fit.boardClearanceMm is below the drop-in clearance)" : "; bossStyle \"floor\" keeps the bosses beside the board"}`,
  };
  if (!boardDropIn && !allowBlockedBoard) {
    if (bossStyle === "floor") {
      fail(`the floor-standing corner bosses are fit.boardClearanceMm ${bc} mm from the board, less than the ${dropIn} mm the board needs to drop in past them; raise fit.boardClearanceMm to ${dropIn}, or pass lid.fasteners.allowBlockedBoard: true to build it anyway`);
    }
    fail(`with bossStyle "${bossStyle}" the corner bosses${bossStyle === "tapered" ? " and their 45 degree gussets" : ""} hang over the board corners: in plan view ${blockers.join(", ")} overlap the board outline grown by ${dropIn} mm, so the board cannot be lowered into the finished base. Use bossStyle "floor" (the bosses stand beside the board), or pass lid.fasteners.allowBlockedBoard: true to build it anyway`);
  }

  const notches: LipNotch[] = posts.map((post, index) => {
    if (!widenNotches) return { kind: "cylinder", centerMm: [post.axis[0], post.axis[1], r9(lipBottomZ - OV)] as Vector3, radiusMm: r9(post.radius + lc), heightMm: r9(d + 3 * OV) };
    const corner = cavityCorners[index]!;
    const far: Vector2 = [post.axis[0] + Math.sign(post.axis[0] - corner[0]) * (post.radius + lc), post.axis[1] + Math.sign(post.axis[1] - corner[1]) * (post.radius + lc)];
    const near: Vector2 = [corner[0] - Math.sign(post.axis[0] - corner[0]) * OV, corner[1] - Math.sign(post.axis[1] - corner[1]) * OV];
    const min: Vector3 = [r9(Math.min(near[0], far[0])), r9(Math.min(near[1], far[1])), r9(lipBottomZ - OV)];
    return { kind: "box", originMm: min, sizeMm: [r9(Math.abs(far[0] - near[0])), r9(Math.abs(far[1] - near[1])), r9(d + 3 * OV)], cornerPieceMm: r9(lipCornerPiece) };
  });

  const bounds = (min: Vector3, max: Vector3): Bounds => ({ min: min.map(r9) as Vector3, max: max.map(r9) as Vector3 });
  const lidHoles = lidHoleSpec;
  const body: Omit<BoardCasePlan, "name" | "derived"> = {
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
      notches,
      ...(lidHoles ? { holes: lidHoles } : {}),
    },
    openings,
    ...(vents ? { vents } : {}),
    ...(board ? { board } : {}),
  };
  const plannedUndoSteps = countBoardCaseSteps(body, exploded);
  if (plannedUndoSteps > LIMITS.maxUndoSteps) fail(`the build would take ${plannedUndoSteps} Undo steps, above the ${LIMITS.maxUndoSteps}-step limit; use fewer vent slots, openings or board holes`);

  const derived: BoardCaseDerived = {
    outerMm: bounds([ox, oy, oz], [ox + outerL, oy + outerW, wallTopZ]),
    cavityMm: bounds([cavMin[0], cavMin[1], floorTopZ], [cavMax[0], cavMax[1], wallTopZ]),
    innerCornerRadiusMm: r9(Ri),
    cornerWallMm: r9(cornerWall),
    floorTopZMm: r9(floorTopZ),
    boardMm: bounds([boardMin[0], boardMin[1], boardBottomZ], [boardMin[0] + L, boardMin[1] + W, boardTopZ]),
    boardTopZMm: r9(boardTopZ),
    componentTopZMm: r9(componentTopZ),
    wallTopZMm: r9(wallTopZ),
    lidTopZMm: r9(lidTopZ),
    lidMm: bounds([ox, oy, lipBottomZ + exploded], [ox + outerL, oy + outerW, lidTopZ]),
    explodedMm: exploded,
    standoffAxesMm: standoffs.map((standoff) => [r9(standoff.axis[0]), r9(standoff.axis[1])]),
    ...(standoffInput ? { standoffTopZMm: r9(boardBottomZ) } : {}),
    lidBossAxesMm: posts.map((post) => post.axis),
    ...(lidFasteners ? { lidBossBottomZMm: r9(postBottomZ), bossStyle } : {}),
    assembly,
    boardWallClearanceMm: {
      xNeg: r9(boardMin[0] - cavMin[0]), xPos: r9(cavMax[0] - (boardMin[0] + L)),
      yNeg: r9(boardMin[1] - cavMin[1]), yPos: r9(cavMax[1] - (boardMin[1] + W)),
    },
    ...(lidFasteners && bossStyle === "floor" ? { cavityGrowthMm: [r9(growth[0]), r9(growth[1])] as Vector2, growAxis: growAxis!, growAxisReason: growAxisReason! } : {}),
    ...(lidFasteners && bossStyle === "tapered" ? { bossTaper: { angleDeg: BOSS_TAPER_ANGLE_DEG, bottomZMm: r9(taperBottomZ), addedHeightMm: r9(wallTopZ - hangingWallTopZ) } } : {}),
    printability: {
      baseOrientation: "floor-down" as const,
      ...(maxBossOverhang !== undefined ? { maxBossOverhangDeg: r9(maxBossOverhang) } : {}),
      scope: BOARD_CASE_PRINTABILITY_SCOPE,
      lidPrintOrientation: "top face down" as const,
      // Top face down, a countersink widens toward the bed: its cone faces down at half the included angle from
      // vertical. Every other lid face (plate, lip, notches, holes, lid openings, lid vents) is vertical or horizontal.
      lidMaxOverhangDeg: r9(lidHoleSpec?.countersink ? lidHoleSpec.countersink.includedAngleDeg / 2 : 0),
      openingCeilings,
    },
    lipOuterMm: bounds([cavMin[0] + lc, cavMin[1] + lc, lipBottomZ + exploded], [cavMax[0] - lc, cavMax[1] - lc, wallTopZ + exploded]),
    lipInnerMm: bounds([lipInnerRect.min[0], lipInnerRect.min[1], lipBottomZ + exploded], [lipInnerRect.max[0], lipInnerRect.max[1], wallTopZ + exploded]),
    openings: openingsDerived,
    ...(ventsDerived ? { vents: ventsDerived } : {}),
    plannedUndoSteps,
    fasteners: { ...(standoffFastener ? { standoffs: standoffFastener } : {}), ...(lidFastener ? { lid: lidFastener } : {}) },
  };

  return { name, derived, ...body };
}

// The Undo steps the composition in BoardCaseRecipe.create takes for a plan, step for step (sub-recipe counts as the
// recipes report them). Renames are not counted: the bodies are created with their names.
export function countBoardCaseSteps(plan: Omit<BoardCasePlan, "name" | "derived">, exploded: number): number {
  const pattern = (count: number, single: number, perItem: number) => count === 1 ? single : perItem * count + 1;
  let steps = 1 + (plan.base.outerRadiusMm > 0 ? 1 : 0) + 1 + (plan.base.innerRadiusMm > 0 ? 1 : 0) + 1;
  for (const group of plan.standoffGroups) steps += group.centersMm.length === 1 ? 4 : 2 * group.centersMm.length + 2;
  if (plan.standoffFloorHoles) steps += pattern(plan.standoffFloorHoles.entryCentersMm.length, 2, 1);
  if (plan.taper) steps += 3 * plan.taper.cones.length + 1;
  if (plan.posts) steps += plan.posts.centersMm.length === 1 ? 4 : 2 * plan.posts.centersMm.length + 2;
  const lid = plan.lid;
  steps += 1 + (lid.plateRadiusMm > 0 ? 1 : 0) + 1 + (lid.lipRadiusMm > 0 ? 1 : 0) + 1 + (lid.lipInnerRadiusMm > 0 ? 1 : 0) + lid.notches.length + 2;
  if (lid.holes) steps += lid.holes.countersink ? pattern(lid.holes.entryCentersMm.length, 4, 3) : pattern(lid.holes.entryCentersMm.length, 2, 1);
  for (const opening of plan.openings) steps += opening.shape === "circle" ? 2 : 3 + (opening.cornerRadiusMm > 0 ? 1 : 0);
  if (plan.vents) steps += pattern(plan.vents.entryCentersMm.length, 5, 4);
  if (plan.board) {
    steps += 1;
    for (const group of plan.board.holeGroups) steps += pattern(group.entryCentersMm.length, 2, 1);
  }
  // One delete for the construction Wires the cone, countersink, connector opening and slot recipes keep.
  if (plan.taper || lid.holes?.countersink || plan.openings.some((opening) => opening.shape !== "circle") || plan.vents) steps += 1;
  if (exploded > 0) steps += 1;
  return steps;
}

// The piece of lid lip a round notch leaves between itself and its corner, as its extent along the lip side (mm; 0 when
// the notch, or the rounded lip corner, leaves nothing). Coordinates from the cavity corner, both axes into the cavity;
// the corner is symmetric in x and y. The lip ring is the band between the lip outer profile (lid clearance from the wall,
// corner radius outerRadius) and the lip inner profile (one lip wall further in, corner radius innerRadius). Rows are
// sampled every (inset - lipClearance) / 4000 mm.
export function lipCornerPieceMm(geometry: { inset: number; notchRadius: number; lipClearance: number; lipWall: number; outerRadius: number; innerRadius: number }): number {
  const { inset: s, notchRadius, lipClearance: lc, lipWall: lw, outerRadius: ro, innerRadius: ri } = geometry;
  const rows = 4000;
  let minX = Infinity;
  let maxX = -Infinity;
  const band = lc + lw;
  for (let row = 0; row <= rows; row += 1) {
    const y = lc + ((s - lc) * row) / rows;
    const chord = notchRadius * notchRadius - (y - s) * (y - s);
    // Left edge of the notch disc at this row (the disc is centred on the boss axis, (s, s)).
    let right = chord > 0 ? s - Math.sqrt(chord) : s;
    // Left edge of the lip outer profile (rounded corner centred at (lc + ro, lc + ro)).
    const oc = lc + ro;
    const left = ro > 0 && y < oc ? oc - Math.sqrt(Math.max(0, ro * ro - (oc - y) * (oc - y))) : lc;
    // Above the lip's y band only the x band is lip: its right edge is the lip inner profile.
    if (y > band) {
      const ic = band + ri;
      const inner = ri > 0 && y < ic ? ic - Math.sqrt(Math.max(0, ri * ri - (ic - y) * (ic - y))) : band;
      right = Math.min(right, inner);
    }
    if (right > left + 1e-9) {
      minX = Math.min(minX, left);
      maxX = Math.max(maxX, right);
    }
  }
  return maxX > minX ? maxX - minX : 0;
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

export type BoardCaseOperations = RecipeOperations & Pick<PlasticityOperations, "undo" | "remove" | "move" | "rename" | "createCone" | "validateBodies"> & {
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
  // The limits the plan enforced and the read-back used.
  limits: typeof BOARD_CASE_LIMITS;
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  bodies: { baseId: number; lidId: number; boardId?: number };
  derived: BoardCaseDerived;
  resultBodyIds: number[];
  // Measured: the Undo depth after the call minus the Undo depth before it (equals derived.plannedUndoSteps).
  undoSteps: number;
  steps: BoardCaseStep[];
  // Native read-back of the finished bodies; the call fails (and undoes itself) when any of it does not hold.
  readBack: BoardCaseReadBack;
}

export interface BoardCaseReadBack {
  toleranceMm: number;
  // Native body bounds: base = derived.outerMm, lid = derived.lidMm, board = derived.boardMm (within toleranceMm).
  baseBoundsMm: Bounds;
  lidBoundsMm: Bounds;
  boardBoundsMm?: Bounds;
  // Native B-Rep Check: every body closed and valid.
  bodies: Array<{ id: number; closed: boolean; nativeValid: boolean }>;
  // Shortest edge over the bodies (at least limits.minEdgeMm).
  minEdgeMm: number;
}

export class BoardCaseRecipeError extends Error {
  readonly failedStage: string;
  readonly completedSteps: BoardCaseStep[];
  readonly undoneSteps: number;
  readonly restored: boolean;
  readonly uncertain: boolean;
  readonly lastConfirmedRevision: string;

  constructor(details: { cause: unknown; failedStage: string; completedSteps: BoardCaseStep[]; undoneSteps: number; restored: boolean; uncertain: boolean; lastConfirmedRevision: string; restoreNote?: string; measuredSteps?: number }) {
    const detail = details.cause instanceof Error ? details.cause.message : String(details.cause);
    const mismatch = details.measuredSteps !== undefined && details.measuredSteps !== details.completedSteps.length
      ? ` (the Undo depth rose by ${details.measuredSteps}, not ${details.completedSteps.length})`
      : "";
    const state = details.uncertain
      ? "the last native result is uncertain, so nothing was undone; call plasticity_reconcile first"
      : details.restored
        ? `undid ${details.undoneSteps} native steps; the document matches the start (bodies and Undo depth)`
        : `undid ${details.undoneSteps} native steps but the document does not match the start${details.restoreNote ? ` (${details.restoreNote})` : ""}; inspect it`;
    super(`Board case recipe failed in stage "${details.failedStage}" after ${details.completedSteps.length} confirmed native steps${mismatch}; ${state}; revision ${details.lastConfirmedRevision}: ${detail}`, { cause: details.cause });
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
      const before = current;
      const listedBefore = steps.length;
      try {
        const report = await run(current.revision);
        steps.push(...report.steps.map((entry) => ({ stage, operation: entry.operation, beforeRevision: entry.beforeRevision, afterRevision: entry.afterRevision, affectedBodyIds: entry.affectedBodyIds })));
        current = await ops.state();
        requireSameDocument(initial, current);
        if (current.revision !== report.afterRevision) throw new Error(`${stage}: the document moved on after the sub-recipe (${report.afterRevision} -> ${current.revision})`);
        if (report.resultBodyIds.length !== 1 || report.resultBodyIds[0] !== targetId) throw new Error(`${stage}: expected the sub-recipe to keep body ${targetId}, got ${report.resultBodyIds.join(", ")}`);
      } catch (error) {
        const partial = (error as { completedSteps?: RecipeStep[] }).completedSteps;
        if (Array.isArray(partial) && steps.length === listedBefore) steps.push(...partial.map((entry) => ({ stage, operation: entry.operation, beforeRevision: entry.beforeRevision, afterRevision: entry.afterRevision, affectedBodyIds: entry.affectedBodyIds })));
        // A sub-recipe lists a step only after its own check passes, so a step that landed and then failed its check (a
        // profile Wire without its Region, a Boolean with the wrong result) is missing from its report. The Undo depth
        // says how many landed: list the missing ones, with the bodies no listed step accounts for (the profile Wire).
        if (!(mutationOutcomeIsUncertain(error) || (error as { uncertain?: unknown }).uncertain === true)) {
          try {
            const now = await ops.state();
            if (now.documentToken === initial.documentToken) {
              const landed = now.undoDepth - before.undoDepth;
              const listed = steps.length - listedBefore;
              if (landed > listed) {
                const accounted = new Set(steps.slice(listedBefore).flatMap((entry) => entry.affectedBodyIds));
                const unlisted = addedIds(before, now, undefined).filter((id) => !accounted.has(id));
                for (let index = listed; index < landed; index += 1) {
                  steps.push({ stage, operation: "sub-recipe step missing from its report (counted by Undo depth)", beforeRevision: steps.at(-1)?.afterRevision ?? before.revision, afterRevision: now.revision, affectedBodyIds: index === listed ? unlisted : [] });
                }
              }
              current = now;
            }
          } catch { /* the rollback reads the state again and reports what it finds */ }
        }
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
        notchIds.push(notch.kind === "cylinder"
          ? await create("create-lip-notch-cutter", (revision) => ops.createCylinder(notch.centerMm, notch.radiusMm, notch.heightMm, undefined, revision, [0, 0, 1]))
          // The round notch would leave a sliver of lip at the corner: the box notch removes the lip from the corner past the boss.
          : await create("create-lip-corner-notch-cutter", (revision) => ops.createBox(notch.originMm, notch.sizeMm, undefined, revision)));
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

      // Read-back: the finished bodies must prove the plan (bounds, closed and valid, no sliver edge).
      stage = "read-back";
      const readBack = await this.readBack(plan, current, baseId, lidId, boardId);

      return {
        recipe: "board-case",
        status: "completed",
        units: "mm",
        constants: BOARD_CASE_CONSTANTS,
        limits: BOARD_CASE_LIMITS,
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        bodies: { baseId, lidId, ...(boardId !== undefined ? { boardId } : {}) },
        derived: plan.derived,
        resultBodyIds: expected,
        undoSteps: current.undoDepth - initial.undoDepth,
        steps,
        readBack,
      };
    } catch (error) {
      throw await this.rollback(error, stage, steps, initial);
    }
  }

  // Native read-back of the finished bodies. Throws (so the caller rolls back) when the base bounds differ from
  // derived.outerMm, the lid bounds from derived.lidMm, the board bounds from derived.boardMm, a body is not closed and
  // natively valid, or an edge is shorter than limits.minEdgeMm.
  private async readBack(plan: BoardCasePlan, state: RuntimeState, baseId: number, lidId: number, boardId: number | undefined): Promise<BoardCaseReadBack> {
    const tolerance = BOARD_CASE_LIMITS.readBackToleranceMm;
    const problems: string[] = [];
    const boundsOf = (id: number, label: string, expected: Bounds): Bounds | undefined => {
      const actual = state.bodies.find((body) => body.id === id)?.boundsMm ?? null;
      if (!actual) { problems.push(`the ${label} bounds could not be read`); return undefined; }
      const off = [0, 1, 2].flatMap((axis) => [Math.abs(actual.min[axis]! - expected.min[axis]!), Math.abs(actual.max[axis]! - expected.max[axis]!)]);
      if (Math.max(...off) > tolerance) problems.push(`the ${label} bounds ${JSON.stringify(roundBounds(actual))} differ from the planned ${JSON.stringify(expected)} by up to ${r9(Math.max(...off))} mm`);
      return roundBounds(actual);
    };
    const baseBoundsMm = boundsOf(baseId, "base", plan.derived.outerMm);
    const lidBoundsMm = boundsOf(lidId, "lid", plan.derived.lidMm);
    const boardBoundsMm = boardId !== undefined ? boundsOf(boardId, "board stand-in", plan.derived.boardMm) : undefined;
    const ids = [baseId, lidId, ...(boardId !== undefined ? [boardId] : [])];
    const validation = await this.operations.validateBodies(ids, state.revision);
    const bodies = ids.map((id) => {
      const entry = validation.bodies.find((candidate) => candidate.id === id);
      return { id, closed: entry?.closed === true, nativeValid: entry?.nativeValid === true };
    });
    for (const entry of bodies) if (!entry.closed || !entry.nativeValid) problems.push(`body ${entry.id} is ${entry.closed ? "" : "not closed, "}${entry.nativeValid ? "natively valid" : "not natively valid"}`);
    let minEdgeMm = Infinity;
    for (const id of ids) {
      const edges = state.bodies.find((body) => body.id === id)?.edges ?? [];
      for (const edge of edges) {
        if (edge.lengthMm < minEdgeMm) minEdgeMm = edge.lengthMm;
        if (edge.lengthMm < BOARD_CASE_LIMITS.minEdgeMm) problems.push(`body ${id} has a ${r9(edge.lengthMm)} mm edge (${edge.id}), shorter than ${BOARD_CASE_LIMITS.minEdgeMm} mm`);
      }
    }
    if (problems.length > 0) throw new Error(`read-back: ${problems.slice(0, 6).join("; ")}${problems.length > 6 ? `; and ${problems.length - 6} more` : ""}`);
    return {
      toleranceMm: tolerance,
      baseBoundsMm: baseBoundsMm!,
      lidBoundsMm: lidBoundsMm!,
      ...(boardBoundsMm ? { boardBoundsMm } : {}),
      bodies,
      minEdgeMm: r9(minEdgeMm),
    };
  }

  // Undo exactly the steps this call added (by Undo depth), unless the last native result is uncertain.
  private async rollback(error: unknown, failedStage: string, steps: BoardCaseStep[], initial: RuntimeState): Promise<BoardCaseRecipeError> {
    const uncertain = mutationOutcomeIsUncertain(error) || (error as { uncertain?: unknown }).uncertain === true;
    const base: { cause: unknown; failedStage: string; completedSteps: BoardCaseStep[]; measuredSteps?: number } = { cause: error, failedStage, completedSteps: steps };
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
    const measuredSteps = state.undoDepth - initial.undoDepth;
    base.measuredSteps = measuredSteps;
    try {
      for (let remaining = measuredSteps; remaining > 0; remaining -= 1) {
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

function rectGap(a: Rect, b: Rect): number {
  const gx = Math.max(a.min[0] - b.max[0], b.min[0] - a.max[0]);
  const gy = Math.max(a.min[1] - b.max[1], b.min[1] - a.max[1]);
  return gx > 0 && gy > 0 ? Math.hypot(gx, gy) : Math.max(gx, gy);
}

function growRect(rect: Rect, by: number): Rect {
  return { min: [rect.min[0] - by, rect.min[1] - by], max: [rect.max[0] + by, rect.max[1] + by] };
}

// Distance from a point to the boundary of a rounded rectangle (corner radius `radius`), positive inside, negative outside.
export function roundedRectInsideDistance(point: Vector2, rect: Rect, radius: number): number {
  const rho = Math.max(0, Math.min(radius, (rect.max[0] - rect.min[0]) / 2, (rect.max[1] - rect.min[1]) / 2));
  const dx = Math.max(rect.min[0] + rho - point[0], 0, point[0] - (rect.max[0] - rho));
  const dy = Math.max(rect.min[1] + rho - point[1], 0, point[1] - (rect.max[1] - rho));
  if (dx > 0 && dy > 0) return rho - Math.hypot(dx, dy);
  return Math.min(point[0] - rect.min[0], rect.max[0] - point[0], point[1] - rect.min[1], rect.max[1] - point[1]);
}

function roundBounds(bounds: { min: number[]; max: number[] }): Bounds {
  return { min: bounds.min.map(r9) as Vector3, max: bounds.max.map(r9) as Vector3 };
}

function r3(value: number): number {
  return Math.round(value * 1000) / 1000 + 0;
}

function floor3(value: number): number {
  return Math.floor(value * 1000 + 1e-6) / 1000 + 0;
}

function r9(value: number): number {
  const rounded = Math.round(value * 1e9) / 1e9;
  return Object.is(rounded, -0) ? 0 : rounded;
}
