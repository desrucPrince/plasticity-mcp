// plasticity_create_board_case: a two-part enclosure (base + lid) around a rectangular board, built in one call from
// parameters. Every derived dimension is computed here from the parameters (never read back from geometry) and returned
// with the result, so later steps never re-derive a cavity or a boss axis from faces.
//
// The plan (derived numbers, validation, the cutter list, the planned Undo step count) is a pure function: planBoardCase.
// Everything that can be predicted from the inputs is refused there, before the first native call: among it the two D1
// guards (no pair of features within 0.05 mm of tangent, no predicted edge under 0.1 mm), computed on the plan-view
// outlines by the engine at the end of this file. BoardCaseRecipe
// composes the existing recipes (screw boss, through hole, countersink, connector opening, slotted hole) and a few direct
// native operations, reads the result back (bounds, native validity, shortest edge) and, on a failure part-way or a failed
// read-back, undoes its own steps (measured by the Undo depth) before it reports.
import { mutationOutcomeIsUncertain, type RuntimeState } from "./runtime.ts";
import type { PlasticityOperations } from "./operations.ts";
import { PlasticityRecipes, type RecipeOperations, type RecipeStep } from "./recipes.ts";
import {
  CALLER_SOURCE,
  STOCK_SCREW_LENGTHS_MM,
  UnsourcedFastenerValueError,
  chooseStockScrewLength,
  clearanceHole,
  countersunkHead,
  heatSetInsert,
  requirePilotDiameter,
  shortestStockScrewLength,
  tapDrill,
  type ClearanceFit,
  type PresetConfidence,
  type ScrewSize,
} from "./fastener-presets.ts";

type Vector3 = [number, number, number];
type Vector2 = [number, number];
type Bounds = { min: Vector3; max: Vector3 };
type Rect = { min: Vector2; max: Vector2 };

export type CaseWall = "x-" | "x+" | "y-" | "y+";
export type CaseOpeningFace = CaseWall | "lid" | "floor";
export type CaseOpeningShape = "rect" | "rounded-rect" | "circle";
// How the lid screws are carried. "stack": no corner bosses; each lid screw runs lid -> lid post -> board hole -> standoff
// (the standoff takes the lid fastener's base). It is the default when the board has at least 2 holes, no
// standoffs.fastener is given and a stack plan passes every rule. Otherwise four corner bosses: standing on the floor in
// a wider cavity ("floor", the default then: the board drops in past them), hung from the walls with a 45 degree gusset
// under each ("tapered") or hung from the walls with a flat underside ("hanging"). The two hung styles overhang the board
// corners in plan view.
export type BossStyle = "tapered" | "hanging" | "floor" | "stack";
export const BOSS_STYLES: readonly BossStyle[] = ["tapered", "hanging", "floor", "stack"];
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
  // An explicit walls.innerCornerRadiusMm keeps at least this diagonal gap between the board corner and the arc.
  minCornerGapMm: 0.2,
  // Upper caps on the shell and the fit (mm).
  maxShellMm: 50,
  maxBoardClearanceMm: 50,
  // Lower limits that avoid degenerate native geometry.
  minBoardThicknessMm: 0.2,
  minOuterRadiusMm: 0.2,
  minFilletRadiusMm: 0.05,
  minOpeningSideMm: 0.5,
  minSlotWidthMm: 0.4,
  minSlotStraightMm: 0.5,
  minCornerRadiusMarginMm: 0.05,
  minLipDepthMm: 0.5,
  minLipNeckMm: 0.8,
  // R4: a gap narrower than this between a boss or standoff and a wall, or two of them, is closed by a web.
  minGapMm: 0.8,
  // D1: no two features may end up with a signed gap (clearance, or negative: overlap) within this of zero, unless a web
  // covers the spot.
  tangentBandMm: 0.05,
  // D1: an overlap shallower than this is not trusted as a merge; a web makes it a real one.
  mergeBandMm: 0.2,
  // D1: the plan refuses a body edge it predicts shorter than this (twice the read-back's minEdgeMm).
  minPlanEdgeMm: 0.1,
  // D1: and, in the body right after the webs are joined (edges the standoffs, bosses or posts then cover), one shorter than this.
  minWebStageEdgeMm: 0.01,
  webWallOverlapMm: 0.2,
  // S: a stack post ends this far above the board top; the keep-out in front of a wall opening runs this far past the
  // board edge.
  stackPostGapMm: 0.2,
  // D9: a stack screw keeps this much engagement in the standoff and this much clearance at the hole bottom.
  minEngagementMm: 2,
  minTipClearanceMm: 1,
  stackKeepOutPastBoardEdgeMm: 3,
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
  // A wall opening whose wall stands further than this from the board edge is reported (derived.openings[i].recessNote
  // and a warning): a connector at the board edge does not reach it.
  reportRecessOverMm: 1,
  // W5: an edge of a wall opening or wall vent slot keeps this far from the start of a corner arc and from the floor
  // top, or sits exactly on it.
  minOpeningEdgeMarginMm: 0.4,
  readBackToleranceMm: 1e-3,
  // A native volume (a web solid, the finished base, the finished lid) may differ from its planned volume by this
  // fraction (W1). The kernel agrees with the plan to about 1e-10 on the live cases.
  volumeRelativeTolerance: 1e-6,
  // Flat opening ceilings wider than this are listed in printability.openingCeilings.
  reportBridgeOverMm: 6,
} as const;

export const BOARD_CASE_PRINTABILITY_SCOPE = "maxBossOverhangDeg (with corner bosses only): the lid-screw boss undersides only (gusset or flat underside), base printed floor-down. lidPostOverhangDeg (stack only): the lid posts, upright when the lid prints top face down. lidMaxOverhangDeg: every lid face, lid printed top face down (the countersink cones are its only faces that are neither vertical nor horizontal). openingCeilings: the flat ceiling of every rect or rounded-rect wall opening wider than 6 mm (a bridge when the base prints floor-down). Not covered: the round crowns of circle wall openings, rounded opening corners and wall vent slot ends, and strength or material.";

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
  walls?: { wallMm?: number | undefined; floorMm?: number | undefined; lidMm?: number | undefined; outerCornerRadiusMm?: number | undefined; innerCornerRadiusMm?: number | undefined } | undefined;
  standoffs?: {
    heightMm?: number | undefined;
    outerDiameterMm?: number | undefined;
    // Optional. Without it the standoffs are plain support posts with no screw hole (derived.fasteners.standoffs.mode
    // "support"). With bossStyle "stack" the standoffs take the lid fastener's base and this is refused.
    fastener?: undefined | {
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
      // "auto": the largest of M3, M2.5, M2 that passes the smallest board hole (stack), else M3.
      screw: ScrewSize | "auto";
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
  // Wall openings (W2): the distance from the board edge to the inner face of this wall (fit.boardClearanceMm, plus
  // half the cavity growth when bossStyle "floor" grows the cavity along this wall's axis). Above 1 mm, recessNote
  // says why: a connector at the board edge then sits that far behind the opening.
  recessMm?: number;
  recessNote?: string;
  // Centre of the opening on the outer surface it is cut from (lid top, floor bottom or the outer wall face).
  centerMm: Vector3;
  // [width, height]: along the wall and vertical for a wall; along x and along y for the lid and the floor.
  sizeMm: Vector2;
  cornerRadiusMm?: number;
}

export interface BoardCaseOpeningCeiling { label: string; wall: CaseWall; widthMm: number; zMm: number }

// A web (R4, D1): it joins a feature to a wall or a corner (an axis-aligned box) or two features to each other (a strip:
// a polygon whose long sides are tangent to the smaller circle and whose ends are V notches inside the circles). gapMm is
// the gap it closes (negative: the overlap it joins). probeMm is a point inside the closed gap (or inside the joined
// material), at mid-height of the web. The build joins the webs of one height in plan view: see BoardCasePlan.webSolids.
export interface BoardCaseWeb {
  label: string;
  kind: "wall" | "corner" | "between";
  // The standoffs or bosses the web joins.
  features: string[];
  gapMm: number;
  box?: { originMm: Vector3; sizeMm: Vector3 };
  strip?: { cornersMm: Vector2[]; bottomZMm: number; heightMm: number };
  probeMm: Vector3;
}

export interface BoardCaseDerived {
  outerMm: Bounds;
  cavityMm: Bounds;
  innerCornerRadiusMm: number;
  // The real smallest diagonal play (D5): how far the board can slide toward a cavity corner, along the diagonal, before it
  // meets a wall, the rounded corner, a floor-standing boss or a web at board height. Without floor bosses that is
  // sqrt 2 x boardClearance - Ri x (sqrt 2 - 1); with bossStyle "floor" it is sqrt 2 x boardClearance.
  cornerGapMm: number;
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
  // Present with lid fasteners, with why (the input, or the default rule).
  bossStyle?: BossStyle;
  bossStyleReason?: string;
  // bossStyle "stack": the lid posts over the board holes and the screw length the stack needs.
  stack?: {
    postAxesMm: Vector2[];
    postOuterDiametersMm: number[];
    postBottomZMm: number;
    postLengthMm: number;
    holeDiameterMm: number;
    // The longest standard screw (2 mm steps to 12, then 4 mm steps) that keeps at least 2 mm engagement in the standoff and
    // 1 mm tip clearance; screwLengthMaxMm is the bottoming length (lid + post + 0.2 + board + hole depth).
    screwLengthMm: number;
    screwLengthMaxMm: number;
    engagementMm: number;
    // The posts reach 0.2 mm above the board inside the component envelope; component positions are not checked.
    note: string;
    // R4 on the lid: webs joining a post to the lid lip where they stand 0 to 0.8 mm apart.
    lidWebs: Array<{ label: string; gapMm: number }>;
  };
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
    // bossStyle "stack": the lid posts stand upright when the lid prints top face down.
    lidPostOverhangDeg?: number;
    openingCeilings: BoardCaseOpeningCeiling[];
  };
  lipOuterMm: Bounds;
  lipInnerMm: Bounds;
  openings: BoardCaseOpeningDerived[];
  vents?: { on: "lid" | CaseWall; centersMm: Vector3[]; slotDirection: Vector3; slotWidthMm: number; slotLengthMm: number };
  // The Undo steps the build will take (the composition below, step for step).
  plannedUndoSteps: number;
  // R4: the webs that close gaps narrower than limits.minGapMm (empty when there are none).
  webs: BoardCaseWeb[];
  fasteners: {
    standoffs?: {
      // Absent for "support" posts (no screw).
      screw?: ScrewSize;
      // "support": plain posts without a screw hole (a board with holes and no standoffs.fastener, outside bossStyle "stack").
      mode: "pilot" | "heat-set-insert" | "through" | "support";
      holeDiameterMm: number;
      holeDepthMm: number;
      // One entry per standoff, in the order of standoffAxesMm.
      outerDiametersMm: number[];
      heightMm: number;
      source: string;
      confidence?: PresetConfidence | "low";
      insert?: string;
      minWallMm?: number;
      clearanceFit?: ClearanceFit;
      // bossStyle "stack" only: why the standoffs (and the lid posts over them) have this diameter: the input, or the
      // default rule (the largest up to board hole + 3 that keeps the post inside the lid lip, never below the screw's
      // close-fit clearance + 1.6 mm).
      outerDiameterReason?: string;
    };
    lid?: {
      screw: ScrewSize;
      // Why this screw: the input, or the "auto" rule.
      screwReason: string;
      base: "pilot" | "heat-set-insert";
      bossDiameterMm: number;
      bossLengthMm: number;
      // Corner bosses (floor, tapered, hanging; W8): the longest stocked screw (lid plate + boss hole) with at least
      // 2 mm in the boss hole and 1 mm tip clearance, the length that bottoms, and the engagement of the chosen one.
      // (bossStyle "stack" reports these in derived.stack.)
      screwLengthMm?: number;
      screwLengthMaxMm?: number;
      engagementMm?: number;
      baseHole: { diameterMm: number; depthMm: number; source: string; confidence?: PresetConfidence | "low"; insert?: string; minWallMm?: number };
      // With screw "auto" only: every value the caller left out and the plan filled in, each with its rule.
      defaults?: string[];
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
  // A rounded-rect with radius = half the shorter side, built with the slotted hole recipe.
  slot?: boolean;
  // Delete this opening's profile Wire right after its cut: a later profile cut on the same face would otherwise see two
  // Regions for its profile (Plasticity keeps coplanar Wires in one sketch).
  dropProfile?: boolean;
  face?: CaseOpeningFace;
}

// A lid lip notch around a corner boss: a cylinder (radius boss + lid clearance), or, when the lip piece left between that
// cylinder and the corner would be shorter than minLipPieceMm, a box from the corner past the whole boss circle.
export type LipNotch =
  | { kind: "cylinder"; centerMm: Vector3; radiusMm: number; heightMm: number }
  | { kind: "box"; originMm: Vector3; sizeMm: Vector3; cornerPieceMm: number };

// One web solid: the plan-view union of the webs of one height range has one outline loop per solid (counter-clockwise).
// A loop that is an axis-aligned rectangle is built as a box; any other loop as a closed profile extruded up.
export interface BoardCaseWebSolid {
  // The webs the solid is made of.
  label: string;
  loopMm: Vector2[];
  box?: { originMm: Vector3; sizeMm: Vector3 };
  bottomZMm: number;
  heightMm: number;
  // The board holes whose standoffs or posts the solid joins.
  holes: number[];
}

export interface BoardCasePlan {
  name: string;
  derived: BoardCaseDerived;
  // W7: a board that no screw holds, an opening recessed more than 1 mm; each with its cause and the change (also the
  // reply's top-level `warnings`).
  warnings: string[];
  base: { boxOriginMm: Vector3; boxSizeMm: Vector3; outerRadiusMm: number; cavityOriginMm: Vector3; cavitySizeMm: Vector3; innerRadiusMm: number };
  standoffGroups: CylinderPattern[];
  webs: BoardCaseWeb[];
  // What the build makes of `webs` (and of `lidWebs`): see BoardCaseWebSolid.
  webSolids: BoardCaseWebSolid[];
  lidWebSolids?: BoardCaseWebSolid[];
  standoffFloorHoles?: { entryCentersMm: Vector3[]; diameterMm: number; depthMm: number };
  posts?: CylinderPattern;
  // bossStyle "stack": lid posts hanging from the plate (screw boss patterns on the lid, axis -z), and lid webs.
  lidPosts?: CylinderPattern[];
  lidWebs?: Array<{ label: string; gapMm: number; originMm: Vector3; sizeMm: Vector3 }>;
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

// The web union has a pinch point (see unionLoops); the plan adds the nearest change that plans (W4).
class WebPinchError extends BoardCaseValidationError {}

const EPS = 1e-9;
// A length within EPS of 0 is 0 (a difference of two decimal inputs is rarely exact in floating point).
const snapZero = (value: number): number => Math.abs(value) < EPS ? 0 : value;

// ---------------------------------------------------------------------------------------------------------------------
// Pure plan: defaults, derived dimensions, validation. Throws BoardCaseValidationError (or an unsourced-preset error)
// before any native call.
// ---------------------------------------------------------------------------------------------------------------------

export function deriveBoardCase(input: BoardCaseInput): BoardCaseDerived {
  return planBoardCase(input).derived;
}

// Thrown inside the plan when a step-down cap on the default stack diameter changes nothing; never reaches a caller.
class PostCapSpent extends Error {
  readonly stop: boolean;
  constructor(stop: boolean) { super("post cap spent"); this.stop = stop; }
}
// Refusals by a web rule: a D1 guard (near-tangent features, sliver edges), a lid web that would cross a screw hole,
// two lid posts in the gap band. In a stack these depend on the post diameter, so the default diameter steps down past them.
const webRuleRefusals = new WeakSet<Error>();

// `resolved` and `options` are for the plan's own use and for tests: the reasons of a default it already resolved;
// fixes: false leaves out the search for the nearest clean hole position when a D1 guard refuses; guards: false returns
// the plan without running the D1 guards (boardCaseTangencies and boardCaseShortEdges then report what they would refuse).
export function planBoardCase(input: BoardCaseInput, resolved?: { styleReason: string; screwReason?: string; auto?: boolean; postSearch?: boolean; postCapMm?: number; postCapWhy?: string }, options: { fixes?: boolean; guards?: boolean } = {}): BoardCasePlan {
  // Default boss style: "stack" when the board has at least 2 holes and a stack plan passes every rule, else "floor".
  const given = input.lid?.fasteners;
  if (given && given.bossStyle === undefined && !resolved) {
    const withStyle = (bossStyle: BossStyle): BoardCaseInput => ({ ...input, lid: { ...input.lid, fasteners: { ...given, bossStyle } } });
    const count = input.board?.holes?.length ?? 0;
    let reason: string;
    if (count < 2) reason = `default: the board has ${count} hole${count === 1 ? "" : "s"}, fewer than the 2 a screw stack needs, so the bosses stand on the floor`;
    else if (input.standoffs?.fastener) reason = "default: standoffs.fastener is given (the standoffs take their own screws), so the bosses stand on the floor";
    else if (given.growAxis !== undefined) {
      // W7: growAxis is a floor key, so the caller chose floor bosses. The reason still says whether a stack was possible.
      const { growAxis: _floorOnly, ...withoutGrowAxis } = given;
      let stackToo = "a screw stack is possible without it: leave growAxis out";
      try {
        planBoardCase({ ...input, lid: { ...input.lid, fasteners: { ...withoutGrowAxis, bossStyle: "stack" } } }, { styleReason: "probe" }, { ...options, fixes: false });
      } catch (error) {
        if (!(error instanceof BoardCaseValidationError) && !(error instanceof UnsourcedFastenerValueError)) throw error;
        stackToo = `a screw stack is not possible either (${error.message})`;
      }
      reason = `default: lid.fasteners.growAxis is given, which applies to bossStyle "floor" only, so the bosses stand on the floor; ${stackToo}`;
    } else {
      try {
        return planBoardCase(withStyle("stack"), { styleReason: `default: the lid screws go through the ${count} board holes into the standoffs (stack)` }, options);
      } catch (error) {
        if (!(error instanceof BoardCaseValidationError) && !(error instanceof UnsourcedFastenerValueError)) throw error;
        reason = `default: a screw stack is not possible (${error.message}), so the bosses stand on the floor`;
      }
    }
    try {
      return planBoardCase(withStyle("floor"), { styleReason: reason }, options);
    } catch (error) {
      if (error instanceof BoardCaseValidationError && reason.startsWith("default: a screw stack is not possible")) throw new BoardCaseValidationError(`${error.message} (the default bossStyle fell back to "floor" because ${reason.slice("default: ".length)})`);
      throw error;
    }
  }
  // lid.fasteners.screw "auto": a real size per style (the explicit screw is never changed).
  if (given && given.screw === "auto") {
    const style = given.bossStyle ?? DEFAULT_BOSS_STYLE;
    let screw: ScrewSize;
    let why: string;
    if (style === "stack") {
      const diameters = (input.board?.holes ?? []).map((hole) => hole.diameterMm);
      const smallest = diameters.length > 0 ? Math.min(...diameters) : 0;
      const fits = (["M3", "M2.5", "M2"] as const).find((size) => clearanceHole(size, "close").diameterMm <= smallest + EPS);
      if (!fits) throw new BoardCaseValidationError(`lid.fasteners.screw "auto": no screw passes the smallest board hole (Ø${smallest}); M2 needs its close-fit Ø${clearanceHole("M2", "close").diameterMm}`);
      screw = fits;
      why = `screw "auto": ${fits}, the largest whose close-fit clearance (Ø${clearanceHole(fits, "close").diameterMm}) passes the smallest board hole (Ø${smallest})`;
    } else {
      screw = "M3";
      why = `screw "auto": M3 (bossStyle "${style}" has no board holes to fit the screws through)`;
    }
    return planBoardCase({ ...input, lid: { ...input.lid, fasteners: { ...given, screw } } }, { styleReason: resolved?.styleReason ?? "lid.fasteners.bossStyle", screwReason: why, auto: true }, options);
  }
  // F2: in a stack with no standoffs.outerDiameterMm the default post and standoff diameter also has to pass the web
  // rules (webRuleRefusals). When one refuses the first default, the default steps down in 0.1 mm steps (never below
  // the smallest allowed, see the standoff section) to the largest diameter that plans; if none does, the first
  // refusal stands. Other refusals (an opening on a web, a screw that does not fit) are not stepped past.
  if (given?.bossStyle === "stack" && input.standoffs?.outerDiameterMm === undefined && !resolved?.postSearch && (input.board?.holes?.length ?? 0) > 0) {
    const inner = { ...(resolved ?? { styleReason: "lid.fasteners.bossStyle" }), postSearch: true };
    try {
      return planBoardCase(input, inner, { ...options, fixes: false });
    } catch (error) {
      if (!(error instanceof BoardCaseValidationError)) throw error;
      if (!webRuleRefusals.has(error)) { if (options.fixes === false) throw error; return planBoardCase(input, inner, options); }
      const why = error.message.split(", which the kernel cannot build reliably")[0]!;
      const top = Math.max(...input.board!.holes!.map((hole) => hole.diameterMm)) + 3;
      for (let cap = Math.ceil(top * 10 - 1e-6) / 10 - 0.1; cap > 0; cap = r9(cap - 0.1)) {
        try {
          return planBoardCase(input, { ...inner, postCapMm: r9(cap), postCapWhy: why.length > 300 ? `${why.slice(0, 300)}...` : why }, { ...options, fixes: false });
        } catch (trial) {
          if (trial instanceof PostCapSpent) { if (trial.stop) break; continue; }
          if (!(trial instanceof BoardCaseValidationError) && !(trial instanceof UnsourcedFastenerValueError)) throw trial;
        }
      }
      if (options.fixes === false) throw error;
      return planBoardCase(input, inner, options); // the first refusal again, now with its nearest clean change
    }
  }
  const fail = (message: string): never => { throw new BoardCaseValidationError(message); };
  // Why a changed input would be refused (undefined: it plans). For the changes a refusal names: they are planned
  // before they are named, once, never inside another such search (options.fixes false).
  const trialRefusal = (trial: BoardCaseInput): string | undefined => {
    try {
      planBoardCase(trial, { styleReason: resolved?.styleReason ?? "lid.fasteners.bossStyle", ...(resolved?.screwReason ? { screwReason: resolved.screwReason } : {}), ...(resolved?.auto ? { auto: true } : {}), postSearch: true }, { fixes: false });
      return undefined;
    } catch (error) {
      if (!(error instanceof BoardCaseValidationError) && !(error instanceof UnsourcedFastenerValueError)) throw error;
      return error.message;
    }
  };
  // The change a refusal names for one value: the computed nearest one if it plans, else the nearest in 0.05 mm steps
  // (up to 2 mm either way) that does; if none does, the computed one with the reason it is refused.
  const namedChange = (make: (delta: number) => { text: string; trial: BoardCaseInput }, first: number): string => {
    if (options.fixes === false) return make(first).text;
    const why = trialRefusal(make(first).trial);
    if (why === undefined) return make(first).text;
    for (let step = 1; step <= 40; step += 1) {
      for (const sign of first >= 0 ? [1, -1] : [-1, 1]) {
        const candidate = make(r9(first + sign * step * 0.05));
        if (trialRefusal(candidate.trial) === undefined) return candidate.text;
      }
    }
    return `${make(first).text} (that alone does not plan: ${why.length > 200 ? `${why.slice(0, 200)}...` : why})`;
  };
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
  for (const [label, value] of [["walls.wallMm", w], ["walls.floorMm", f], ["walls.lidMm", tl]] as const) atMost(label, value, LIMITS.maxShellMm, "shell");
  atMost("fit.boardClearanceMm", bc, LIMITS.maxBoardClearanceMm, "board clearance");
  if (T < LIMITS.minBoardThicknessMm - EPS) fail(`board.thicknessMm ${T} is below the ${LIMITS.minBoardThicknessMm} mm minimum board thickness`);
  if (Ro > 0 && Ro < LIMITS.minOuterRadiusMm - EPS) fail(`walls.outerCornerRadiusMm ${Ro} must be 0 (square) or at least ${LIMITS.minOuterRadiusMm} mm`);
  if (d < LIMITS.minLipDepthMm - EPS) fail(`lid.lipDepthMm ${d} is below the ${LIMITS.minLipDepthMm} mm minimum lip depth`);
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
  // (screw "auto" was resolved above, so the screw is a real size from here on.)
  type LidFasteners = Omit<NonNullable<NonNullable<BoardCaseInput["lid"]>["fasteners"]>, "screw"> & { screw: ScrewSize };
  let lidFasteners = input.lid?.fasteners as LidFasteners | undefined;
  // Stack rules are gathered and refused together, each with the input change that passes it (D2).
  const stackProblems: string[] = [];
  let stackWebRule = false;
  // W8: refused after the other lid rules (a countersink off the lid edge is the nearer cause of a thick lid's failure).
  let cornerScrewProblem: string | undefined;
  const bossStyle: BossStyle = lidFasteners?.bossStyle ?? DEFAULT_BOSS_STYLE;
  const stack = !!lidFasteners && bossStyle === "stack";
  // screw "auto" chose the screw, so the caller cannot know its pilot: the values left out are filled in, each with its
  // rule (derived.fasteners.lid.defaults). An explicit screw gets no default.
  const autoDefaults: string[] = [];
  let pilotDefaulted = false;
  let pilotDepthDefaulted = false;
  if (lidFasteners && resolved?.auto) {
    const filled: LidFasteners = { ...lidFasteners };
    const screw = filled.screw;
    if (filled.base === "pilot") {
      const drill = tapDrill(screw);
      if (filled.pilotDiameterMm === undefined) {
        filled.pilotDiameterMm = drill.diameterMm;
        pilotDefaulted = true;
        autoDefaults.push(`pilotDiameterMm ${drill.diameterMm}: the ${screw} tapping drill (${drill.nominalDiameterMm} - pitch ${drill.pitchMm}), a starting value for a screw that forms its thread in printed plastic (confidence low)`);
      } else if (filled.pilotDiameterMm >= drill.nominalDiameterMm - EPS) {
        const message = `lid.fasteners.pilotDiameterMm ${filled.pilotDiameterMm} is not smaller than the ${screw} thread (Ø${drill.nominalDiameterMm}) that screw "auto" chose, so the screw would not hold; leave pilotDiameterMm out (default Ø${drill.diameterMm}) or name the screw`;
        if (stack) stackProblems.push(message); else fail(message);
      }
      if (filled.pilotDepthMm === undefined) {
        // Two thread diameters of engagement. Stack: the shortest stocked screw that gives it, plus the tip clearance.
        const target = 2 * drill.nominalDiameterMm;
        const through = tl + Hc + headroomMm + d + T;
        let length = stack ? shortestStockScrewLength(through, target) : undefined;
        // A given standoffs.heightMm that does not hold that pilot: the longest stocked screw whose pilot it does hold
        // (still minEngagementMm in the standoff). If there is none, the usual default stands and the stack is refused.
        const givenHeight = stack && typeof input.standoffs?.heightMm === "number" ? input.standoffs.heightMm : undefined;
        let shortened: number | undefined;
        if (length !== undefined && givenHeight !== undefined && length - through + LIMITS.minTipClearanceMm > givenHeight + EPS) {
          const fitting = STOCK_SCREW_LENGTHS_MM.filter((stocked) => stocked - through >= LIMITS.minEngagementMm - EPS && stocked - through + LIMITS.minTipClearanceMm <= givenHeight + EPS).at(-1);
          if (fitting !== undefined) { shortened = r9(length - through + LIMITS.minTipClearanceMm); length = fitting; }
        }
        filled.pilotDepthMm = length !== undefined ? r9(length - through + LIMITS.minTipClearanceMm) : r9(target + (stack ? LIMITS.minTipClearanceMm : 0));
        pilotDepthDefaulted = true;
        autoDefaults.push(length !== undefined
          ? `pilotDepthMm ${filled.pilotDepthMm}: a stocked ${length} mm screw passes ${r9(through)} mm of lid, post and board and reaches ${r9(length - through)} mm into the standoff (${shortened !== undefined ? `the given standoffs.heightMm ${givenHeight} does not hold the ${shortened} mm pilot for 2 x ${drill.nominalDiameterMm}` : `at least 2 x ${drill.nominalDiameterMm}`}), with ${LIMITS.minTipClearanceMm} mm tip clearance`
          : `pilotDepthMm ${filled.pilotDepthMm}: 2 x the ${screw} thread diameter${stack ? ` + ${LIMITS.minTipClearanceMm} mm tip clearance` : ""}`);
      }
    }
    if (filled.countersunk === undefined && filled.headDiameterMm === undefined) {
      try { countersunkHead(screw); } catch (error) {
        if (!(error instanceof UnsourcedFastenerValueError)) throw error;
        filled.countersunk = false;
        autoDefaults.push(`countersunk false: the ${screw} countersunk head is not sourced, so the lid holes are plain (pass headDiameterMm for countersinks)`);
      }
    }
    lidFasteners = filled;
  }
  // Corner bosses exist with lid fasteners in every style but "stack".
  const corner = stack ? undefined : lidFasteners;
  if (!BOSS_STYLES.includes(bossStyle)) fail(`lid.fasteners.bossStyle must be one of ${BOSS_STYLES.join(", ")} (got ${String(bossStyle)})`);
  const allowBlockedBoard = lidFasteners?.allowBlockedBoard ?? false;
  if (typeof allowBlockedBoard !== "boolean") fail("lid.fasteners.allowBlockedBoard must be true or false");
  const growAxisInput = lidFasteners?.growAxis;
  if (growAxisInput !== undefined && growAxisInput !== "x" && growAxisInput !== "y") fail(`lid.fasteners.growAxis must be "x" or "y" (got ${String(growAxisInput)})`);
  if (growAxisInput !== undefined && bossStyle !== "floor") fail(`lid.fasteners.growAxis applies only to bossStyle "floor" (got bossStyle "${bossStyle}")`);
  // Default boss diameter: 6 mm, or the sourced insert wall around the insert hole when the base takes inserts.
  const lidInsertDefault = corner?.base === "heat-set-insert" && corner.bossDiameterMm === undefined ? heatSetInsert(corner.screw, corner.insertLengthMm) : undefined;
  if (stack && lidFasteners!.bossDiameterMm !== undefined) fail("lid.fasteners.bossDiameterMm is for corner bosses; with bossStyle \"stack\" the lid posts take the standoff diameter (standoffs.outerDiameterMm)");
  const bossD = corner ? positive("lid.fasteners.bossDiameterMm", corner.bossDiameterMm ?? (lidInsertDefault ? Math.max(6, r9(lidInsertDefault.holeDiameterMm + 2 * lidInsertDefault.minWallMm)) : 6)) : 0;
  const bossR = bossD / 2;
  // Each corner boss axis is this far from both adjoining inner walls, so the boss overlaps each wall by bossWallOverlapMm.
  const bossInset = bossR - bossWallOverlapMm;
  if (corner && bossInset <= 0) fail(`lid.fasteners.bossDiameterMm ${bossD} must exceed ${2 * bossWallOverlapMm} mm`);
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
      // W2: say which of the two values plans (each is planned once; not inside another search).
      const refusal = (axis: "x" | "y"): string | undefined => {
        const why = trialRefusal({ ...input, lid: { ...input.lid, fasteners: { ...input.lid!.fasteners!, growAxis: axis } } });
        return why !== undefined && why.length > 220 ? `${why.slice(0, 220)}...` : why;
      };
      let advice = "pass lid.fasteners.growAxis \"x\" or \"y\" to choose which walls move";
      if (options.fixes !== false) {
        const [x, y] = [refusal("x"), refusal("y")];
        advice = x === undefined && y === undefined ? `${advice} (both plan)`
          : x === undefined ? `pass lid.fasteners.growAxis "x" (it plans; "y" does not: ${y})`
            : y === undefined ? `pass lid.fasteners.growAxis "y" (it plans; "x" does not: ${x})`
              : `neither lid.fasteners.growAxis "x" (${x}) nor "y" (${y}) plans; use a bossStyle that does not widen the cavity ("stack", or "tapered" / "hanging" with allowBlockedBoard) or move an opening`;
      }
      fail(`bossStyle "floor" widens the cavity by ${r9(need)} mm along x or y, which moves that axis's two end walls ${r9(need / 2)} mm away from the board; openings sit on both x walls (${xOpen.join(", ")}) and y walls (${yOpen.join(", ")}), so ${advice}`);
    }
    growth = growAxis === "x" ? [need, 0] : [0, need];
  }

  // --- the shell -----------------------------------------------------------------------------------------------------
  const cavityL = L + 2 * bc + growth[0];
  const cavityW = W + 2 * bc + growth[1];
  const outerL = cavityL + 2 * w;
  const outerW = cavityW + 2 * w;
  if (Ro > 0 && Ro >= Math.min(outerL, outerW) / 2 - EPS) fail(`walls.outerCornerRadiusMm ${Ro} must be less than half the outer size (${r9(Math.min(outerL, outerW) / 2)})`);
  // Inner corner radius: the outer radius minus the wall (a uniform wall), but never more than the board clearance, so
  // the diagonal gap from the board's square corner to the arc (sqrt 2 x c - Ri x (sqrt 2 - 1)) is at least c, the play
  // reported on every side. walls.innerCornerRadiusMm sets it explicitly while that gap stays at least minCornerGapMm.
  const RiInput = input.walls?.innerCornerRadiusMm;
  let Ri: number;
  if (RiInput !== undefined) {
    Ri = nonnegative("walls.innerCornerRadiusMm", RiInput);
    const largest = (Math.SQRT2 * bc - LIMITS.minCornerGapMm) / (Math.SQRT2 - 1);
    if (Math.SQRT2 * bc - Ri * (Math.SQRT2 - 1) < LIMITS.minCornerGapMm - EPS) fail(`walls.innerCornerRadiusMm ${Ri} leaves a ${r3(Math.SQRT2 * bc - Ri * (Math.SQRT2 - 1))} mm diagonal gap between the board corner and the arc, below ${LIMITS.minCornerGapMm} mm; with fit.boardClearanceMm ${bc} it may be at most ${floor3(Math.max(0, largest))}`);
  } else {
    // (W3: a radius within 1e-9 of 0 is 0: 2.2 - 2 is 0.2000000000000002 in floating point.)
    Ri = Math.min(Math.max(0, snapZero(Ro - w)), bc);
  }
  if (RiInput !== undefined && Ri > Math.min(L + 2 * bc + growth[0], W + 2 * bc + growth[1]) / 2 - LIMITS.minFilletRadiusMm + EPS) fail(`walls.innerCornerRadiusMm ${Ri} must be less than half the cavity size minus ${LIMITS.minFilletRadiusMm} mm (${r9(Math.min(L + 2 * bc + growth[0], W + 2 * bc + growth[1]) / 2 - LIMITS.minFilletRadiusMm)})`);
  if (Ri > 0 && Ri < LIMITS.minFilletRadiusMm - EPS) fail(`the inner corner radius would be ${r9(Ri)} mm (${RiInput !== undefined ? "walls.innerCornerRadiusMm" : "min(walls.outerCornerRadiusMm - walls.wallMm, fit.boardClearanceMm)"}); it must be 0 or at least ${LIMITS.minFilletRadiusMm} mm (a smaller fillet fails natively)`);
  const RiCap = RiInput !== undefined ? Ri : bc;
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
    const maxRo = RiCap + (w * Math.SQRT2 - cornerLimit) / (Math.SQRT2 - 1);
    fail(`the corner wall is ${r3(cornerWall)} mm (walls.wallMm ${w} x sqrt 2 - (outer radius ${Ro} - inner radius ${r3(Ri)}) x (sqrt 2 - 1)), below the ${r3(cornerLimit)} mm minimum (the larger of ${LIMITS.minCornerWallMm} and ${LIMITS.minCornerWallFractionOfWall} x walls.wallMm); the inner radius is at most ${r3(RiCap)} (${RiInput !== undefined ? "walls.innerCornerRadiusMm" : "fit.boardClearanceMm"}), so walls.outerCornerRadiusMm may be at most ${floor3(maxRo)}`);
  }

  // --- standoffs -----------------------------------------------------------------------------------------------------
  if (stack) {
    if (input.standoffs?.fastener) stackProblems.push("with bossStyle \"stack\" the lid screws go into the standoffs, which take lid.fasteners.base; remove standoffs.fastener (giving both is ambiguous), or choose another bossStyle");
    if (holes.length < 2) stackProblems.push(`bossStyle "stack" needs at least 2 board holes for the lid screws (the board has ${holes.length}); give at least 2 board.holes`);
    const close = clearanceHole(lidFasteners!.screw, "close");
    const smallest = Math.min(...holes.map((hole) => hole.diameterMm));
    const fits = (["M3", "M2.5", "M2"] as const).find((size) => clearanceHole(size, "close").diameterMm <= smallest + EPS);
    holes.forEach((hole, index) => { if (hole.diameterMm < close.diameterMm - EPS) stackProblems.push(`bossStyle "stack": board.holes[${index}] (Ø${hole.diameterMm}) is smaller than the ${lidFasteners!.screw} close-fit clearance Ø${close.diameterMm}, so the lid screw cannot pass through the board; ${fits ? `use ${fits} or screw: "auto"` : `board holes of at least Ø${clearanceHole("M2", "close").diameterMm} (M2)`}`); });
  }
  // A board with holes always gets a standoff under every hole: with no standoffs block (outside "stack") they are plain
  // support posts. A board without holes has none and rests on the floor top.
  // With bossStyle "stack" the standoffs take the lid fastener's base, and the default height holds its hole: pilot
  // depth + 1, or the insert pocket (insert length + 1) + 1; never below 2 mm or the underside clearance.
  const stackHeight = stack && input.standoffs?.heightMm === undefined
    ? Math.max(2, U, lidFasteners!.base === "pilot" ? (lidFasteners!.pilotDepthMm ?? 0) + 1 : heatSetInsert(lidFasteners!.screw, lidFasteners!.insertLengthMm).blindHoleDepthMm + 1)
    : undefined;
  const standoffInput = stack ? { heightMm: input.standoffs?.heightMm ?? stackHeight, outerDiameterMm: input.standoffs?.outerDiameterMm } : input.standoffs ?? (holes.length > 0 ? {} : undefined);
  if (holes.length === 0 && !input.standoffs && input.board.undersideClearanceMm !== undefined) fail("board.undersideClearanceMm needs standoffs: a board without holes has none and rests on the floor; remove it or give board.holes");
  const supportH = standoffInput ? positive("standoffs.heightMm", standoffInput.heightMm ?? U) : 0;
  if (standoffInput) atMost("standoffs.heightMm", supportH, LIMITS.maxHeightMm, "height");
  if (standoffInput && supportH < U - EPS) fail(`standoffs.heightMm ${supportH} is below board.undersideClearanceMm ${U}: parts under the board would hit the floor`);
  if (standoffInput && holes.length === 0) fail("standoffs need board.holes: one standoff stands under each hole");
  const boardBottomZ = floorTopZ + supportH;
  const boardTopZ = boardBottomZ + T;
  const componentTopZ = boardTopZ + Hc;

  let standoffFastener: BoardCaseDerived["fasteners"]["standoffs"];
  const standoffGroups: CylinderPattern[] = [];
  let standoffFloorHoles: BoardCasePlan["standoffFloorHoles"];
  const standoffs: Array<{ label: string; axis: Vector2; radius: number; holeRadius: number }> = [];
  if (standoffInput) {
    const maybe: NonNullable<NonNullable<BoardCaseInput["standoffs"]>["fastener"]> | undefined = stack
      ? { screw: lidFasteners!.screw, mode: lidFasteners!.base, pilotDiameterMm: lidFasteners!.pilotDiameterMm, pilotDepthMm: lidFasteners!.pilotDepthMm, insertLengthMm: lidFasteners!.insertLengthMm }
      : (standoffInput as NonNullable<BoardCaseInput["standoffs"]>).fastener;
    // No fastener outside "stack": plain support posts (no screw hole).
    const fastener = (maybe ?? { screw: "M3", mode: "support" }) as { screw: ScrewSize; mode: "pilot" | "heat-set-insert" | "through" | "support"; pilotDiameterMm?: number | undefined; pilotDepthMm?: number | undefined; insertLengthMm?: number | undefined; clearanceFit?: ClearanceFit | undefined };
    const where = stack ? "lid.fasteners" : "standoffs.fastener";
    let holeDiameterMm: number;
    let holeDepthMm = supportH;
    let source: string;
    const extra: Partial<NonNullable<BoardCaseDerived["fasteners"]["standoffs"]>> = {};
    if (fastener.mode === "pilot") {
      holeDiameterMm = positive(`${where}.pilotDiameterMm`, requirePilotDiameter(fastener!.screw, fastener!.pilotDiameterMm, where));
      holeAtLeast(`${where}.pilotDiameterMm`, holeDiameterMm);
      holeDepthMm = positive(`${where}.pilotDepthMm`, fastener!.pilotDepthMm ?? supportH);
      if (holeDepthMm < LIMITS.minHoleDepthMm - EPS) fail(`${where}.pilotDepthMm ${holeDepthMm} is below the ${LIMITS.minHoleDepthMm} mm minimum hole depth`);
      if (stack && pilotDefaulted) Object.assign(extra, { confidence: "low" });
      if (holeDepthMm > supportH + EPS) (stack ? (message: string) => { stackProblems.push(message); } : fail)(`${where}.pilotDepthMm ${holeDepthMm}${pilotDepthDefaulted ? " (the default with screw \"auto\")" : ""} exceeds the standoff height ${supportH}${stack ? `; raise standoffs.heightMm to ${r9(holeDepthMm + 1)} or leave it out (the default holds the pilot)` : ""}`);
      source = stack && pilotDefaulted ? tapDrill(fastener.screw).source : CALLER_SOURCE;
    } else if (fastener.mode === "heat-set-insert") {
      const insert = heatSetInsert(fastener.screw, fastener.insertLengthMm);
      holeDiameterMm = insert.holeDiameterMm;
      holeDepthMm = insert.blindHoleDepthMm;
      if (holeDepthMm > supportH + EPS) fail(`the ${insert.insert} insert needs a ${holeDepthMm} mm blind hole, deeper than the ${supportH} mm standoff; raise standoffs.heightMm`);
      source = insert.source;
      Object.assign(extra, { confidence: insert.confidence, insert: insert.insert, minWallMm: insert.minWallMm });
    } else if (fastener.mode === "support") {
      holeDiameterMm = 0;
      holeDepthMm = 0;
      source = "none: plain support posts (no standoffs.fastener)";
    } else {
      const fit = fastener.clearanceFit ?? "medium";
      const hole = clearanceHole(fastener.screw, fit);
      holeDiameterMm = hole.diameterMm;
      source = hole.source;
      Object.assign(extra, { confidence: hole.confidence, clearanceFit: fit });
    }
    // Default standoff diameter: board hole + 3, or the sourced insert wall around the insert hole if that is larger.
    const insertMinimum = extra.minWallMm !== undefined ? holeDiameterMm + 2 * extra.minWallMm : 0;
    // Stack (F2): the lid post over each hole has the standoff's diameter and must stay tangentBandMm inside the lid lip
    // outline. So the default there is the largest diameter up to the usual one that does (in 0.1 mm steps), but never
    // below the screw's close-fit clearance + 1.6 mm or any other minimum of a standoff. (W6: the wall around the lid
    // post's hole is then 0.8 mm only with clearanceFit "close"; the hole actually cut has the chosen fit, so the wall
    // is 0.7 mm with the default "medium" and 0.6 mm with "free".) An explicit standoffs.outerDiameterMm is never changed.
    let outerDiameterReason: string | undefined;
    const outerDiameters = holes.map((hole) => standoffInput.outerDiameterMm ?? r9(Math.max(hole.diameterMm + 3, insertMinimum)));
    if (stack && standoffInput.outerDiameterMm !== undefined) outerDiameterReason = "standoffs.outerDiameterMm";
    if (stack && standoffInput.outerDiameterMm === undefined) {
      const lip: Rect = { min: [cavMin[0] + lc, cavMin[1] + lc], max: [cavMax[0] - lc, cavMax[1] - lc] };
      const close = clearanceHole(lidFasteners!.screw, "close").diameterMm;
      const through = clearanceHole(lidFasteners!.screw, lidFasteners!.clearanceFit ?? "medium").diameterMm;
      const reasons: string[] = [];
      // postCapMm: the step-down of the default while a plan rule refuses it (see the top of planBoardCase).
      const cap = resolved?.postCapMm;
      let capLowered = false;
      let capSpent = true;
      holes.forEach((hole, index) => {
        const usual = outerDiameters[index]!;
        const room = roundedRectInsideDistance([boardMin[0] + hole.xMm, boardMin[1] + hole.yMm], lip, Math.max(0, Ri - lc));
        const fits = Math.floor(2 * (room - LIMITS.tangentBandMm) * 10 + 1e-6) / 10;
        const least = r9(Math.max(close + 1.6, hole.diameterMm + LIMITS.standoffOverBoardHoleMm, insertMinimum, through + 2 * LIMITS.minHoleWallMm, holeDiameterMm + 2 * LIMITS.minHoleWallMm));
        const uncapped = r9(Math.max(least, Math.min(usual, fits)));
        const chosen = cap === undefined ? uncapped : r9(Math.max(least, Math.min(uncapped, cap)));
        if (cap !== undefined) {
          if (chosen < r9(Math.max(least, Math.min(uncapped, cap + 0.1))) - EPS) capLowered = true;
          if (chosen > least + EPS) capSpent = false;
        }
        outerDiameters[index] = chosen;
        reasons.push(chosen < uncapped - EPS
          ? `default: Ø${chosen}, the largest (in 0.1 mm steps) that passes the plan rules (at Ø${uncapped}: ${resolved!.postCapWhy})`
          : chosen >= usual - EPS
            ? `default: Ø${chosen}, ${insertMinimum > hole.diameterMm + 3 ? "the sourced insert wall around the insert hole" : "board hole + 3"}`
            : fits >= least - EPS
              ? `default: Ø${chosen}, the largest (in 0.1 mm steps) that keeps the lid post ${LIMITS.tangentBandMm} mm inside the lid lip outline (board hole + 3 would be Ø${usual})`
              : `default: Ø${chosen}, the smallest allowed for ${lidFasteners!.screw} (close-fit clearance Ø${close} + 1.6, a hole wall of ${LIMITS.minHoleWallMm} and board hole + ${LIMITS.standoffOverBoardHoleMm}); a post inside the lid lip outline could be at most Ø${fits}`);
      });
      // This cap changed no diameter (the plan would repeat the last one): skip it, and stop when every hole is at its smallest.
      if (cap !== undefined && !capLowered) throw new PostCapSpent(capSpent);
      outerDiameterReason = new Set(reasons).size === 1 ? reasons[0]! : reasons.map((reason, index) => `board.holes[${index}]: ${reason}`).join("; ");
    }
    holes.forEach((hole, index) => standoffs.push({ label: `standoff ${index}`, axis: [boardMin[0] + hole.xMm, boardMin[1] + hole.yMm], radius: outerDiameters[index]! / 2, holeRadius: holeDiameterMm / 2 }));
    outerDiameters.forEach((od, index) => {
      positive(`standoffs.outerDiameterMm (hole ${index})`, od);
      if (holeDiameterMm > 0 && od <= holeDiameterMm + EPS) fail(`standoff ${index}: outer diameter ${od} must exceed its ${holeDiameterMm} mm hole`);
      if (holeDiameterMm > 0 && (od - holeDiameterMm) / 2 < LIMITS.minHoleWallMm - EPS) fail(`standoff ${index}: outer diameter ${od} leaves a ${r9((od - holeDiameterMm) / 2)} mm wall around its ${holeDiameterMm} mm hole, below the ${LIMITS.minHoleWallMm} mm minimum (needs ${r9(holeDiameterMm + 2 * LIMITS.minHoleWallMm)})`);
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
    standoffFastener = { ...(fastener.mode === "support" ? {} : { screw: fastener.screw }), mode: fastener.mode, holeDiameterMm, holeDepthMm: fastener.mode === "through" ? r9(supportH + f) : holeDepthMm, outerDiametersMm: [...outerDiameters], heightMm: supportH, source, ...extra, ...(outerDiameterReason ? { outerDiameterReason } : {}) };
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
    if (lidFasteners.count !== undefined && (stack || lidFasteners.count !== 4)) fail(stack ? "lid.fasteners.count is for corner bosses; with bossStyle \"stack\" there is one lid screw per board hole" : "lid.fasteners.count must be 4 (one boss per cavity corner)");
    const fit = lidFasteners.clearanceFit ?? "medium";
    const lidHole = clearanceHole(lidFasteners.screw, fit);
    let baseHole: NonNullable<BoardCaseDerived["fasteners"]["lid"]>["baseHole"];
    if (lidFasteners.base === "pilot") {
      const diameterMm = positive("lid.fasteners.pilotDiameterMm", requirePilotDiameter(lidFasteners.screw, lidFasteners.pilotDiameterMm, "lid.fasteners"));
      holeAtLeast("lid.fasteners.pilotDiameterMm", diameterMm);
      if (lidFasteners.pilotDepthMm === undefined) fail("lid.fasteners.pilotDepthMm is required with base \"pilot\": it sets the corner boss length (boss = pilot depth + 1 mm)");
      const depthMm = positive("lid.fasteners.pilotDepthMm", lidFasteners.pilotDepthMm);
      atMost("lid.fasteners.pilotDepthMm", depthMm, LIMITS.maxHeightMm, "height");
      if (depthMm < LIMITS.minHoleDepthMm - EPS) fail(`lid.fasteners.pilotDepthMm ${depthMm} is below the ${LIMITS.minHoleDepthMm} mm minimum hole depth`);
      baseHole = pilotDefaulted ? { diameterMm, depthMm, source: tapDrill(lidFasteners.screw).source, confidence: "low" } : { diameterMm, depthMm, source: CALLER_SOURCE };
    } else {
      const insert = heatSetInsert(lidFasteners.screw, lidFasteners.insertLengthMm);
      if (corner && bossD < insert.holeDiameterMm + 2 * insert.minWallMm - EPS) {
        fail(`lid boss diameter ${bossD} leaves less than the sourced ${insert.minWallMm} mm insert wall around the ${insert.holeDiameterMm} mm ${insert.insert} hole (needs ${r9(insert.holeDiameterMm + 2 * insert.minWallMm)})`);
      }
      baseHole = { diameterMm: insert.holeDiameterMm, depthMm: insert.blindHoleDepthMm, source: insert.source, confidence: insert.confidence, insert: insert.insert, minWallMm: insert.minWallMm };
    }
    if (corner) {
      if (baseHole.diameterMm >= bossD - EPS) fail(`lid boss diameter ${bossD} must exceed its ${baseHole.diameterMm} mm hole`);
      if ((bossD - baseHole.diameterMm) / 2 < LIMITS.minHoleWallMm - EPS) fail(`lid boss diameter ${bossD} leaves a ${r9((bossD - baseHole.diameterMm) / 2)} mm wall around its ${baseHole.diameterMm} mm hole, below the ${LIMITS.minHoleWallMm} mm minimum (needs ${r9(baseHole.diameterMm + 2 * LIMITS.minHoleWallMm)})`);
      if (lidHole.diameterMm >= bossD - EPS) fail(`lid boss diameter ${bossD} must exceed the ${lidHole.diameterMm} mm lid clearance hole`);
      postLength = r9(baseHole.depthMm + bossFloorMm);
      postHole = { diameterMm: baseHole.diameterMm, depthMm: baseHole.depthMm };
    }
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
    // W8: corner bosses (floor, tapered, hanging): the screw passes the lid plate, then the boss hole. The longest
    // stocked length with minEngagementMm in the hole and minTipClearanceMm short of its bottom; none: refused, with
    // the nearest pilot depth and lid thickness that fit one. (The stack reports its own in derived.stack.)
    let cornerScrew: { screwLengthMm: number; screwLengthMaxMm: number; engagementMm: number } | undefined;
    if (corner) {
      const choice = chooseStockScrewLength(tl, baseHole.depthMm, { minEngagementMm: LIMITS.minEngagementMm, minTipClearanceMm: LIMITS.minTipClearanceMm });
      if (!choice) {
        const fixes: string[] = [];
        const next = shortestStockScrewLength(tl, LIMITS.minEngagementMm);
        const tried = (text: string, trial: BoardCaseInput): string => { const why = options.fixes === false ? undefined : trialRefusal(trial); return why === undefined ? text : `${text} (that alone does not plan: ${why.length > 160 ? `${why.slice(0, 160)}...` : why})`; };
        if (lidFasteners.base === "pilot" && next !== undefined) fixes.push(tried(`use lid.fasteners.pilotDepthMm ${r9(next - tl + LIMITS.minTipClearanceMm)} for a stocked ${next} mm screw`, { ...input, lid: { ...input.lid, fasteners: { ...input.lid!.fasteners!, pilotDepthMm: r9(next - tl + LIMITS.minTipClearanceMm) } } }));
        let nearest: { delta: number; length: number } | undefined;
        for (const length of STOCK_SCREW_LENGTHS_MM) {
          const low = length - baseHole.depthMm + LIMITS.minTipClearanceMm;
          const high = length - LIMITS.minEngagementMm;
          if (low > high + EPS) continue;
          const delta = tl > high ? high - tl : tl < low ? low - tl : 0;
          if (tl + delta > EPS && (!nearest || Math.abs(delta) < Math.abs(nearest.delta) - EPS)) nearest = { delta, length };
        }
        if (nearest) fixes.push(`${fixes.length > 0 ? "or " : ""}${tried(`use walls.lidMm ${r9(tl + nearest.delta)} for a stocked ${nearest.length} mm screw`, { ...input, walls: { ...input.walls, lidMm: r9(tl + nearest.delta) } })}`);
        if (fixes.length === 0) fixes.push(`use a boss hole at least ${LIMITS.minEngagementMm + LIMITS.minTipClearanceMm} mm deep`);
        cornerScrewProblem = (`no standard screw length fits the lid bosses: it needs between ${r9(tl + LIMITS.minEngagementMm)} and ${r9(tl + baseHole.depthMm - LIMITS.minTipClearanceMm)} mm (lid ${tl} mm, at least ${LIMITS.minEngagementMm} mm in the ${baseHole.depthMm} mm boss hole, ${LIMITS.minTipClearanceMm} mm tip clearance; stocked lengths ${STOCK_SCREW_LENGTHS_MM.join(", ")}); ${fixes.join(", ")}`);
      }
      if (choice) cornerScrew = { screwLengthMm: choice.lengthMm, screwLengthMaxMm: choice.maxLengthMm, engagementMm: choice.engagementMm };
    }
    lidFastener = {
      screw: lidFasteners.screw,
      screwReason: resolved?.screwReason ?? "lid.fasteners.screw",
      ...(autoDefaults.length > 0 ? { defaults: autoDefaults } : {}),
      base: lidFasteners.base,
      bossDiameterMm: bossD,
      bossLengthMm: postLength,
      ...(cornerScrew ?? {}),
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
    bossBottomZMm: corner && bossStyle !== "floor" ? postBottomZ : undefined,
    taperBottomZMm: lidFasteners && bossStyle === "tapered" ? taperBottomZ : undefined,
  });
  if (lidFasteners && bossStyle === "floor" && postLength > wallTopZ - floorTopZ + EPS) fail(`the ${postLength} mm boss hole does not fit the ${r9(wallTopZ - floorTopZ)} mm floor-standing boss`);
  if (postHole && postHole.depthMm > (bossStyle === "floor" ? wallTopZ - floorTopZ : postLength) - OV + EPS) fail(`the ${postHole.depthMm} mm boss hole must be at most the boss length minus ${OV} mm`);
  if (lidFastener && bossStyle === "floor") lidFastener.bossLengthMm = r9(wallTopZ - floorTopZ);
  // The no-overhang property is computed from the derived geometry, never assumed.
  const overhangGeometry: BossUndersideGeometry = {
    style: bossStyle, bossRadiusMm: bossR, bossInsetMm: bossInset, bossBottomZMm: postBottomZ, floorTopZMm: floorTopZ,
    ...(bossStyle === "tapered" ? { taper: { apexZMm: taperApexZ, topZMm: postBottomZ, topRadiusMm: taperReach } } : {}),
  };
  const maxBossOverhang = corner ? maxBossOverhangDeg(overhangGeometry) : undefined;
  if (maxBossOverhang !== undefined && bossStyle !== "hanging" && maxBossOverhang > BOSS_TAPER_ANGLE_DEG + BOSS_OVERHANG_TOLERANCE_DEG) {
    throw new BoardCaseValidationError(`internal: the ${bossStyle} boss underside overhangs ${maxBossOverhang} degrees, more than ${BOSS_TAPER_ANGLE_DEG}`);
  }

  // --- lip ring ------------------------------------------------------------------------------------------------------
  const lipInset = lc + lw;
  if (2 * lipInset >= Math.min(cavityL, cavityW) - EPS) fail(`lid lip (clearance ${lc} + wall ${lw} per side) does not fit the ${r9(cavityL)} x ${r9(cavityW)} cavity`);
  const lipRadius = Math.max(0, snapZero(Ri - lc));
  const lipInnerRadius = Math.max(0, snapZero(Ri - lipInset));
  for (const [label, radius] of [["lid lip corner radius (inner radius - fit.lidClearanceMm)", lipRadius], ["lid lip inner corner radius (inner radius - lid clearance - lip wall)", lipInnerRadius]] as const) {
    if (radius > 0 && radius < LIMITS.minFilletRadiusMm - EPS) fail(`the ${label} would be ${r9(radius)} mm; it must be 0 or at least ${LIMITS.minFilletRadiusMm} mm (a smaller fillet fails natively): change fit.lidClearanceMm or lid.lipWallMm`);
  }

  const s = bossInset;
  const posts: Array<{ label: string; axis: Vector2; radius: number }> = [];
  const cavityCorners: Vector2[] = [[cavMin[0], cavMin[1]], [cavMax[0], cavMin[1]], [cavMin[0], cavMax[1]], [cavMax[0], cavMax[1]]];
  if (corner) {
    const reach = s + bossD / 2 + lc;
    if (2 * reach >= Math.min(cavityL, cavityW) - EPS) {
      fail(`the four ${bossD} mm corner bosses (plus lid clearance) overlap each other in the ${r9(cavityL)} x ${r9(cavityW)} cavity`);
    }
    const corners: Vector2[] = [[cavMin[0] + s, cavMin[1] + s], [cavMax[0] - s, cavMin[1] + s], [cavMin[0] + s, cavMax[1] - s], [cavMax[0] - s, cavMax[1] - s]];
    corners.forEach((axis, index) => posts.push({ label: `lid boss ${index}`, axis: [r9(axis[0]), r9(axis[1])], radius: bossD / 2 }));
    // R2: a floor boss and a standoff both stand on the floor, so they may merge. The standoff hole is cut before the
    // bosses are joined, so the boss circle must stay minHoleWallMm clear of the standoff hole (and that also keeps the
    // material between the two holes); each hole keeps its own wall to the outside (checked with its diameter).
    if (bossStyle === "floor") {
      standoffs.forEach((standoff, standoffIndex) => posts.forEach((post) => {
        const distance = Math.hypot(post.axis[0] - standoff.axis[0], post.axis[1] - standoff.axis[1]);
        if (distance < post.radius + standoff.radius - EPS && distance < post.radius + standoff.holeRadius + LIMITS.minHoleWallMm - EPS) {
          fail(`${post.label} merges with ${standoff.label} but comes ${r3(distance - post.radius - standoff.holeRadius)} mm from its Ø${r9(2 * standoff.holeRadius)} hole, less than ${LIMITS.minHoleWallMm} mm: move board.holes[${standoffIndex}] at least ${r3(post.radius + standoff.holeRadius + LIMITS.minHoleWallMm - distance)} mm away from the corner, or use bossStyle "stack" (the lid screws go through the board holes into the standoffs, no corner bosses)`);
        }
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
  if (corner) {
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

  // R4: webs. Any gap narrower than minGapMm between a boss or standoff and a wall (or the rounded cavity corner), or
  // between two of them, is closed by a web the full height of the lower feature: a box from the feature's axis to the
  // wall (webWallOverlapMm into it) or to the corner, or a strip between two features as wide as the smaller diameter.
  // D1: a shallow overlap (under mergeBandMm) is webbed the same way, so no two features are left tangent. The webs of
  // one height are joined in plan view (webSolids) and built as one solid per loop, right after the cavity cut and before
  // the standoffs and bosses, so every hole is cut through them; a web that would cross another feature's hole at its
  // height is refused.
  const webs: BoardCaseWeb[] = [];
  const webParts: Array<{ label: string; polygon: Vector2[]; z: Vector2; holes: number[] }> = [];
  type WebFeature = { label: string; axis: Vector2; radius: number; z: Vector2; holeRadius: number; holeZ: Vector2; holes: number[] };
  const webFeatures: WebFeature[] = [];
  {
    const standoffHoleDepth = standoffFastener ? (standoffFastener.mode === "through" ? supportH + f : standoffFastener.holeDepthMm) : 0;
    webFeatures.push(
      ...standoffs.map((standoff, index) => ({ label: standoff.label, axis: standoff.axis, radius: standoff.radius, z: [floorTopZ - OV, boardBottomZ] as Vector2, holeRadius: standoff.holeRadius, holeZ: [boardBottomZ - standoffHoleDepth, boardBottomZ] as Vector2, holes: [index] })),
      ...posts.map((post) => ({ label: post.label, axis: post.axis, radius: post.radius, z: (bossStyle === "floor" ? [floorTopZ - OV, wallTopZ] : [postBottomZ, wallTopZ]) as Vector2, holeRadius: (postHole?.diameterMm ?? 0) / 2, holeZ: [wallTopZ - (postHole?.depthMm ?? 0), wallTopZ] as Vector2, holes: [] as number[] })),
    );
    const features = webFeatures;
    const gapLimit = LIMITS.minGapMm;
    const overlap = LIMITS.webWallOverlapMm;
    // Holes of other features at the web's height (a web only touches a hole it shares a height with).
    const holesOf = (except: WebFeature[], z: Vector2) => features.filter((feature) => !except.includes(feature) && feature.holeRadius > 0 && overlaps(feature.holeZ, z));
    const keepInside = (label: string, points: Vector2[]) => {
      const margin = Math.min(...points.map((point) => roundedRectInsideDistance(point, outerRect, Ro)));
      if (margin < LIMITS.standoffWallKeptMm - EPS) fail(`the web closing the gap at ${label} would come ${r3(margin)} mm from the outer surface (at least ${LIMITS.standoffWallKeptMm} mm): move the feature or thicken the wall`);
    };
    const wallGaps = (feature: WebFeature) => ({ "x-": feature.axis[0] - cavMin[0] - feature.radius, "x+": cavMax[0] - feature.axis[0] - feature.radius, "y-": feature.axis[1] - cavMin[1] - feature.radius, "y+": cavMax[1] - feature.axis[1] - feature.radius });
    // A gap, or an overlap shallower than mergeBandMm, under minGapMm gets a web (R4, D1).
    const near = (gap: number) => gap > -LIMITS.mergeBandMm + EPS && gap < gapLimit - EPS;
    const boxesOfFeature = new Map<WebFeature, Rect[]>();
    const boxWeb = (label: string, kind: BoardCaseWeb["kind"], gap: number, min: Vector2, max: Vector2, z: Vector2, probe: Vector2, ends: WebFeature[]) => {
      for (const other of holesOf(ends, z)) if (circleHitsRect(other.axis, other.holeRadius + LIMITS.minHoleWallMm, { min, max })) fail(`the web closing the ${r3(gap)} mm gap at ${label} would cross the ${other.label} hole; move the feature so the gap is 0 or at least ${gapLimit} mm`);
      keepInside(label, [[min[0], min[1]], [max[0], min[1]], [min[0], max[1]], [max[0], max[1]]]);
      webs.push({ label, kind, features: ends.map((end) => end.label), gapMm: r9(gap), box: { originMm: [r9(min[0]), r9(min[1]), r9(z[0])], sizeMm: [r9(max[0] - min[0]), r9(max[1] - min[1]), r9(z[1] - z[0])] }, probeMm: [r9(probe[0]), r9(probe[1]), r9((z[0] + OV + z[1]) / 2)] });
      webParts.push({ label, polygon: [[min[0], min[1]], [max[0], min[1]], [max[0], max[1]], [min[0], max[1]]], z, holes: ends.flatMap((end) => end.holes) });
      for (const end of ends) boxesOfFeature.set(end, [...(boxesOfFeature.get(end) ?? []), { min, max }]);
    };
    for (const feature of features) {
      const [ax, ay] = feature.axis;
      const r = feature.radius;
      // Distance from the circle to each inner wall plane (negative: it reaches into the wall).
      const gaps = wallGaps(feature);
      const nearX = gaps["x-"] < gaps["x+"] ? "x-" : "x+";
      const nearY = gaps["y-"] < gaps["y+"] ? "y-" : "y+";
      const cornerX = nearX === "x-" ? cavMin[0] : cavMax[0];
      const cornerY = nearY === "y-" ? cavMin[1] : cavMax[1];
      const sx = nearX === "x-" ? 1 : -1;
      const sy = nearY === "y-" ? 1 : -1;
      // The corner pocket: from the circle to the rounded corner along the diagonal through the corner arc's midpoint.
      const q = Ri * (1 - Math.SQRT1_2);
      const arcPoint: Vector2 = [cornerX + sx * q, cornerY + sy * q];
      const pocket = Math.hypot(ax - arcPoint[0], ay - arcPoint[1]) - r;
      const gx = gaps[nearX];
      const gy = gaps[nearY];
      // A box to each wall the circle is narrowly short of (as wide as the circle, along the wall, from its axis: the
      // feature's own hole is cut through it later).
      for (const wall of ["x-", "x+", "y-", "y+"] as const) {
        const gap = gaps[wall];
        if (!near(gap)) continue;
        const alongX = wall.startsWith("y");
        const face = wall === "x-" ? cavMin[0] : wall === "x+" ? cavMax[0] : wall === "y-" ? cavMin[1] : cavMax[1];
        const out = wall.endsWith("-") ? -1 : 1;
        const normal = [alongX ? ay : ax, face + out * overlap].sort((a, b) => a - b) as Vector2;
        const along: Vector2 = alongX ? [ax - r, ax + r] : [ay - r, ay + r];
        const min: Vector2 = alongX ? [along[0], normal[0]] : [normal[0], along[0]];
        const max: Vector2 = alongX ? [along[1], normal[1]] : [normal[1], along[1]];
        // The probe sits in the middle of the gap, or (no gap) just inside the wall face.
        const depth = gap > 0 ? gap / 2 : -0.1;
        const probe: Vector2 = alongX ? [ax, face - out * depth] : [face - out * depth, ay];
        boxWeb(`${feature.label} and wall ${wall}`, "wall", gap, min, max, feature.z, probe, [feature]);
      }
      // Near both walls of a corner: a box from the corner to the axis closes the corner pocket (and the niche the two
      // wall boxes leave at the corner).
      if (gx < gapLimit - EPS && gy < gapLimit - EPS && (near(gx) || near(gy) || near(pocket))) {
        const towards = Math.hypot(ax - arcPoint[0], ay - arcPoint[1]);
        // The probe sits in the pocket's middle, or (wall gaps only) in the niche just off the corner arc.
        const wallGap = Math.min(...[gx, gy].filter((value) => value > EPS), Infinity);
        const gapHere = near(pocket) ? pocket : Math.min(gx, gy);
        const reach = near(pocket) && pocket > 0 ? pocket / 2 : Math.min(wallGap / 2, 0.1);
        const probe: Vector2 = [arcPoint[0] + ((ax - arcPoint[0]) * reach) / towards, arcPoint[1] + ((ay - arcPoint[1]) * reach) / towards];
        const xs = [cornerX - sx * overlap, ax].sort((a, b) => a - b) as Vector2;
        const ys = [cornerY - sy * overlap, ay].sort((a, b) => a - b) as Vector2;
        boxWeb(`${feature.label} and the ${nearX}/${nearY} corner`, "corner", gapHere, [xs[0], ys[0]], [xs[1], ys[1]], feature.z, probe, [feature]);
      }
    }
    // Between two features that share a height: a strip as wide as the smaller diameter. Its two long sides are the
    // lines tangent to the smaller circle (they end on that circle, as a wall box's sides do); each end is a V notch
    // that stays inside its circle (apex half a radius from the axis toward the other feature), so no end face shows
    // outside a circle or runs through an axis. Where both features stand at one wall (or one does and the strip's side
    // leaves that wall at under 45 degrees), the strip also fills down to that wall between the two axes (a skirt), so no
    // pit or thin wedge is left under it.
    for (let first = 0; first < features.length; first += 1) {
      for (let second = first + 1; second < features.length; second += 1) {
        const a = features[first]!;
        const b = features[second]!;
        const z: Vector2 = [Math.max(a.z[0], b.z[0]), Math.min(a.z[1], b.z[1])];
        if (!(z[1] > z[0] + EPS)) continue;
        const distance = Math.hypot(b.axis[0] - a.axis[0], b.axis[1] - a.axis[1]);
        const circleGap = distance - a.radius - b.radius;
        // Two circles that overlap are joined the same way (the strip fills the two cusps where they cross), unless they
        // overlap so far that the strip's two end notches would meet.
        if (distance - a.radius / 2 - b.radius / 2 < LIMITS.mergeBandMm) continue;
        // The narrowest gap between the two, counting the wall and corner webs each already has (a web that comes within
        // minGapMm of the other feature leaves a slot of its own).
        const boxesOf = (feature: WebFeature) => (boxesOfFeature.get(feature) ?? []).filter(() => overlaps(feature.z, z));
        const circleToBox = (feature: WebFeature, box: Rect) => Math.hypot(Math.max(box.min[0] - feature.axis[0], 0, feature.axis[0] - box.max[0]), Math.max(box.min[1] - feature.axis[1], 0, feature.axis[1] - box.max[1])) - feature.radius;
        const boxGaps = [...boxesOf(b).map((box) => circleToBox(a, box)), ...boxesOf(a).map((box) => circleToBox(b, box)), ...boxesOf(a).flatMap((boxA) => boxesOf(b).map((boxB) => rectGap(boxA, boxB)))];
        const gap = Math.min(circleGap, ...boxGaps);
        if (!(circleGap < gapLimit - EPS) && !boxGaps.some(near)) continue;
        const dir: Vector2 = [(b.axis[0] - a.axis[0]) / distance, (b.axis[1] - a.axis[1]) / distance];
        const half = Math.min(a.radius, b.radius);
        const side: Vector2 = [-dir[1] * half, dir[0] * half];
        const at = (feature: WebFeature, along: number, across: number): Vector2 => [feature.axis[0] + dir[0] * along + side[0] * across, feature.axis[1] + dir[1] * along + side[1] * across];
        const corners: Vector2[] = [at(a, 0, -1), at(b, 0, -1), at(b, -b.radius / 2, 0), at(b, 0, 1), at(a, 0, 1), at(a, a.radius / 2, 0)];
        const parts: Vector2[][] = [corners];
        const gapsA = wallGaps(a);
        const gapsB = wallGaps(b);
        const ccw = (quad: Vector2[]) => (quad.reduce((sum, point, index) => { const after = quad[(index + 1) % quad.length]!; return sum + point[0] * after[1] - after[0] * point[1]; }, 0) > 0 ? quad : [...quad].reverse());
        for (const wall of ["x-", "x+", "y-", "y+"] as const) {
          const nearA = gapsA[wall] < gapLimit - EPS;
          const nearB = gapsB[wall] < gapLimit - EPS;
          if (!nearA && !nearB) continue;
          const alongIndex = wall.startsWith("y") ? 0 : 1;
          const normalIndex = 1 - alongIndex;
          const face = wall === "x-" ? cavMin[0] : wall === "x+" ? cavMax[0] : wall === "y-" ? cavMin[1] : cavMax[1];
          const inward = wall.endsWith("-") ? 1 : -1;
          const inWall = face - inward * overlap;
          const foot = (point: Vector2): Vector2 => (alongIndex === 0 ? [point[0], inWall] : [inWall, point[1]]);
          if (nearA && nearB) {
            // Both stand at this wall: fill between the two axes down into the wall.
            if (Math.abs(a.axis[alongIndex]! - b.axis[alongIndex]!) >= LIMITS.minPlanEdgeMm) parts.push(ccw([foot(a.axis), foot(b.axis), b.axis, a.axis]));
            continue;
          }
          // One stands at this wall and the strip's side leaves the wall at a shallow angle (under 45 degrees), less than
          // minGapMm clear of it at that feature: fill between the two axes down into the wall as well (no thin wedge, and
          // no sliver where the side, the wall and a circle would meet in one spot).
          const from = nearA ? a : b;
          const away: Vector2 = nearA ? dir : [-dir[0], -dir[1]];
          const rise = away[normalIndex]! * inward;
          if (!(rise > 1e-6 && rise < Math.SQRT1_2)) continue;
          const offset: Vector2 = side[normalIndex]! * inward < 0 ? side : [-side[0], -side[1]];
          const clear = (from.axis[normalIndex]! + offset[normalIndex]! - face) * inward;
          if (!(clear < gapLimit - EPS)) continue;
          parts.push(ccw([foot(a.axis), foot(b.axis), b.axis, a.axis]));
          // The other feature gets a box to the wall as wide as itself, like a feature that stands at the wall, so the
          // fill ends on faces tangent to that circle.
          const other = nearA ? b : a;
          const low = foot([other.axis[0] - other.radius, other.axis[1] - other.radius]);
          const high: Vector2 = alongIndex === 0 ? [other.axis[0] + other.radius, other.axis[1]] : [other.axis[0], other.axis[1] + other.radius];
          parts.push([[Math.min(low[0], high[0]), Math.min(low[1], high[1])], [Math.max(low[0], high[0]), Math.min(low[1], high[1])], [Math.max(low[0], high[0]), Math.max(low[1], high[1])], [Math.min(low[0], high[0]), Math.max(low[1], high[1])]]);
        }
        const label = `${a.label} and ${b.label}`;
        for (const part of parts) {
          const shape = polygonPlanShape(label, part, z, []);
          for (const other of holesOf([a, b], z)) if (shape.sdf(other.axis) < other.holeRadius + LIMITS.minHoleWallMm - EPS) fail(`the web closing the ${r3(gap)} mm gap between ${a.label} and ${b.label} would cross the ${other.label} hole`);
          keepInside(label, part);
          webParts.push({ label, polygon: part, z, holes: [...a.holes, ...b.holes] });
        }
        // The probe sits in the middle of the gap between the two circles (on the line of axes).
        const mid = a.radius + circleGap / 2;
        webs.push({ label, kind: "between", features: [a.label, b.label], gapMm: r9(gap), strip: { cornersMm: corners.map((point) => [r9(point[0]), r9(point[1])] as Vector2), bottomZMm: r9(z[0]), heightMm: r9(z[1] - z[0]) }, probeMm: [r9(a.axis[0] + dir[0] * mid), r9(a.axis[1] + dir[1] * mid), r9((z[0] + OV + z[1]) / 2)] });
      }
    }
  }
  // The webs of one height range, joined in plan view: one solid per outline loop (a box when the loop is a rectangle).
  // No web reaches further than webWallOverlapMm into a wall.
  // W4: webs that meet in a single point cannot be one solid; the refusal names the nearest change that plans.
  const withPinchFix = <T>(build: () => T): T => {
    try { return build(); } catch (error) {
      if (!(error instanceof WebPinchError) || options.fixes === false) throw error;
      const fix = nearestCleanChange(input, holes.map((_, index) => index), (trial) => { planBoardCase(trial, { styleReason: resolved?.styleReason ?? "lid.fasteners.bossStyle", ...(resolved?.screwReason ? { screwReason: resolved.screwReason } : {}), ...(resolved?.auto ? { auto: true } : {}), postSearch: true }, { fixes: false }); });
      throw new BoardCaseValidationError(`${error.message}; ${fix}`);
    }
  };
  const webSolids = withPinchFix(() => planWebSolids(webParts, OV, growRect(cavRect, LIMITS.webWallOverlapMm)));

  // --- S: screw stack (lid posts over the board holes) -----------------------------------------------------------------
  let lidPosts: CylinderPattern[] | undefined;
  const lidWebs: NonNullable<BoardCasePlan["lidWebs"]> = [];
  const lidWebParts: Array<{ label: string; polygon: Vector2[]; z: Vector2; holes: number[] }> = [];
  let stackDerived: BoardCaseDerived["stack"];
  const stackPosts: Array<{ label: string; axis: Vector2; radius: number; index: number }> = [];
  if (stack) {
    const postBottom = boardTopZ + LIMITS.stackPostGapMm;
    const postLength = wallTopZ - postBottom;
    const holeD = lidHoleSpec!.diameterMm;
    const lipOuterRect: Rect = { min: [cavMin[0] + lc, cavMin[1] + lc], max: [cavMax[0] - lc, cavMax[1] - lc] };
    const lipInnerRect: Rect = { min: [cavMin[0] + lipInset, cavMin[1] + lipInset], max: [cavMax[0] - lipInset, cavMax[1] - lipInset] };
    // The largest post diameter every post fits with tangentBandMm to the lip outline (the D2 fix for the outline rule).
    const outlineRoom = Math.min(...standoffs.map((standoff) => roundedRectInsideDistance(standoff.axis, lipOuterRect, lipRadius)));
    const maxPostOd = Math.floor(2 * (outlineRoom - LIMITS.tangentBandMm) * 1000 + 1e-6) / 1000;
    // The smallest diameter an explicit standoffs.outerDiameterMm may have at this hole (the standoff and post minimums).
    const minPostOd = (index: number) => r9(Math.max(holes[index]!.diameterMm + LIMITS.standoffOverBoardHoleMm, holeD + 2 * LIMITS.minHoleWallMm, standoffs[index]!.holeRadius * 2 + 2 * LIMITS.minHoleWallMm, standoffFastener?.minWallMm !== undefined ? standoffs[index]!.holeRadius * 2 + 2 * standoffFastener.minWallMm : 0));
    standoffs.forEach((standoff, index) => {
      const label = `the lid post over board.holes[${index}]`;
      if ((2 * standoff.radius - holeD) / 2 < LIMITS.minHoleWallMm - EPS) stackProblems.push(`${label} (Ø${r9(2 * standoff.radius)}, the standoff diameter) leaves less than ${LIMITS.minHoleWallMm} mm around its Ø${holeD} screw clearance hole; use standoffs.outerDiameterMm ${r9(holeD + 2 * LIMITS.minHoleWallMm)} or more`);
      // The post hangs inside the lid lip outline (it may merge into the lip) and keeps tangentBandMm to it; its hole keeps
      // minHoleWallMm to that outline.
      const outside = roundedRectInsideDistance(standoff.axis, lipOuterRect, lipRadius);
      if (outside - standoff.radius < LIMITS.tangentBandMm - EPS) stackProblems.push(`${label} ${r3(standoff.radius - outside) > 0 ? `reaches ${r3(standoff.radius - outside)} mm past` : `comes within ${r3(outside - standoff.radius)} mm of`} the lid lip outline toward the base wall (it must stay ${LIMITS.tangentBandMm} mm inside); ${maxPostOd >= minPostOd(index) - EPS ? `use standoffs.outerDiameterMm ${maxPostOd} or less${input.standoffs?.outerDiameterMm === undefined ? ` (the default does not go below Ø${r9(2 * standoff.radius)} for ${lidFasteners!.screw})` : ""}, or ` : ""}move the hole inward${maxPostOd >= minPostOd(index) - EPS ? "" : ` (no standoff diameter fits: at most Ø${maxPostOd} inside the lip, at least Ø${minPostOd(index)} for its holes)`}`);
      if (outside - holeD / 2 < LIMITS.minHoleWallMm - EPS) stackProblems.push(`${label}: its screw hole comes within ${r3(outside - holeD / 2)} mm of the lid lip outline (at least ${LIMITS.minHoleWallMm} mm); move board.holes[${index}] ${r3(LIMITS.minHoleWallMm - (outside - holeD / 2))} mm inward`);
      // A gap to the lip's inner face from -mergeBandMm (a shallow overlap) to minGapMm is closed by a lid web the lip's
      // height (R4, D1); near two lip sides a corner box closes the corner between the two side webs (D3).
      const overlap = Math.min(LIMITS.webWallOverlapMm, lw / 2);
      const gaps = { "x-": standoff.axis[0] - lipInnerRect.min[0] - standoff.radius, "x+": lipInnerRect.max[0] - standoff.axis[0] - standoff.radius, "y-": standoff.axis[1] - lipInnerRect.min[1] - standoff.radius, "y+": lipInnerRect.max[1] - standoff.axis[1] - standoff.radius };
      const inBand = (gap: number) => gap > -LIMITS.mergeBandMm + EPS && gap < LIMITS.minGapMm - EPS;
      const addLidWeb = (name: string, gap: number, min: Vector2, max: Vector2) => {
        for (const [otherIndex, other] of standoffs.entries()) if (otherIndex !== index && circleHitsRect(other.axis, holeD / 2 + LIMITS.minHoleWallMm, { min, max })) stackWebRule = true;
        for (const [otherIndex, other] of standoffs.entries()) if (otherIndex !== index && circleHitsRect(other.axis, holeD / 2 + LIMITS.minHoleWallMm, { min, max })) stackProblems.push(`the lid web closing the ${r3(gap)} mm gap between ${label} and the lid lip would cross the screw hole over board.holes[${otherIndex}]; move board.holes[${index}] so the post overlaps the lip by ${LIMITS.mergeBandMm} mm or stands ${LIMITS.minGapMm} mm clear`);
        lidWebs.push({ label: `${label} and the lid lip ${name}`, gapMm: r9(gap), originMm: [r9(min[0]), r9(min[1]), r9(lipBottomZ)], sizeMm: [r9(max[0] - min[0]), r9(max[1] - min[1]), r9(wallTopZ + OV - lipBottomZ)] });
        lidWebParts.push({ label: `${label} and the lid lip ${name}`, polygon: [[min[0], min[1]], [max[0], min[1]], [max[0], max[1]], [min[0], max[1]]], z: [lipBottomZ, wallTopZ + OV], holes: [index] });
      };
      for (const [side, gap] of Object.entries(gaps) as Array<[CaseWall, number]>) {
        if (!inBand(gap)) continue;
        const alongX = side.startsWith("y");
        const face = side === "x-" ? lipInnerRect.min[0] : side === "x+" ? lipInnerRect.max[0] : side === "y-" ? lipInnerRect.min[1] : lipInnerRect.max[1];
        const out = side.endsWith("-") ? -1 : 1;
        const normal = [alongX ? standoff.axis[1] : standoff.axis[0], face + out * overlap].sort((a, b) => a - b) as Vector2;
        const along: Vector2 = alongX ? [standoff.axis[0] - standoff.radius, standoff.axis[0] + standoff.radius] : [standoff.axis[1] - standoff.radius, standoff.axis[1] + standoff.radius];
        addLidWeb(side, gap, alongX ? [along[0], normal[0]] : [normal[0], along[0]], alongX ? [along[1], normal[1]] : [normal[1], along[1]]);
      }
      const nearX = gaps["x-"] < gaps["x+"] ? "x-" : "x+";
      const nearY = gaps["y-"] < gaps["y+"] ? "y-" : "y+";
      // The pocket between the post and the lip's inner corner (along the diagonal through the corner arc's midpoint).
      const sideX = nearX === "x-" ? 1 : -1;
      const sideY = nearY === "y-" ? 1 : -1;
      const round = lipInnerRadius * (1 - Math.SQRT1_2);
      const pocket = Math.hypot(standoff.axis[0] - ((nearX === "x-" ? lipInnerRect.min[0] : lipInnerRect.max[0]) + sideX * round), standoff.axis[1] - ((nearY === "y-" ? lipInnerRect.min[1] : lipInnerRect.max[1]) + sideY * round)) - standoff.radius;
      // A corner the post covers by tangentBandMm or more needs no web: the two lip faces leave the post well past it.
      const pocketed = pocket > -LIMITS.tangentBandMm + EPS && pocket < LIMITS.minGapMm - EPS;
      if (gaps[nearX] < LIMITS.minGapMm - EPS && gaps[nearY] < LIMITS.minGapMm - EPS && (inBand(gaps[nearX]) || inBand(gaps[nearY]) || pocketed)) {
        const cx = nearX === "x-" ? lipInnerRect.min[0] - overlap : lipInnerRect.max[0] + overlap;
        const cy = nearY === "y-" ? lipInnerRect.min[1] - overlap : lipInnerRect.max[1] + overlap;
        const xs = [cx, standoff.axis[0]].sort((a, b) => a - b) as Vector2;
        const ys = [cy, standoff.axis[1]].sort((a, b) => a - b) as Vector2;
        addLidWeb(`${nearX}/${nearY} corner`, pocketed ? pocket : Math.min(gaps[nearX], gaps[nearY]), [xs[0], ys[0]], [xs[1], ys[1]]);
      }
      stackPosts.push({ label, axis: standoff.axis, radius: standoff.radius, index });
    });
    // Posts merge where they overlap by at least mergeBandMm; a gap or shallow overlap under minGapMm between two posts
    // is refused (the lid prints top face down, a strip there would hold nothing).
    for (let first = 0; first < stackPosts.length; first += 1) for (let second = first + 1; second < stackPosts.length; second += 1) {
      const a = stackPosts[first]!;
      const b = stackPosts[second]!;
      const gap = Math.hypot(a.axis[0] - b.axis[0], a.axis[1] - b.axis[1]) - a.radius - b.radius;
      if (gap > -LIMITS.mergeBandMm + EPS && gap < LIMITS.minGapMm - EPS) stackWebRule = true;
      if (gap > -LIMITS.mergeBandMm + EPS && gap < LIMITS.minGapMm - EPS) stackProblems.push(`${a.label} and ${b.label} are ${r3(gap)} mm apart; move board.holes[${b.index}] ${r3(LIMITS.minGapMm - gap)} mm further from board.holes[${a.index}] (or ${r3(gap + LIMITS.mergeBandMm)} mm closer so they merge)`);
    }
    lidHoleSpec!.entryCentersMm = standoffs.map((standoff) => [r9(standoff.axis[0]), r9(standoff.axis[1]), r9(wallTopZ + tl)] as Vector3);
    const ods = [...new Set(standoffs.map((standoff) => r9(2 * standoff.radius)))];
    lidPosts = ods.map((od) => ({
      centersMm: standoffs.filter((standoff) => r9(2 * standoff.radius) === od).map((standoff) => [r9(standoff.axis[0]), r9(standoff.axis[1]), r9(wallTopZ)] as Vector3),
      outerDiameterMm: od,
      heightMm: r9(postLength),
      holeDiameterMm: holeD,
      holeDepthMm: r9(postLength),
      baseOverlapMm: OV,
    }));
    // D9, F1: the screw passes lid + post + 0.2 mm gap + board, then the standoff hole (pilot depth or insert pocket).
    // The longest stocked length with at least minEngagementMm in the standoff and minTipClearanceMm short of the hole
    // bottom; when none fits, the refusal names the nearest pilot depth and the nearest component height that would.
    const through = tl + postLength + LIMITS.stackPostGapMm + T;
    const holeDepth = lidFastener!.baseHole.depthMm;
    const maxLength = through + holeDepth;
    const screwLength = chooseStockScrewLength(through, holeDepth, { minEngagementMm: LIMITS.minEngagementMm, minTipClearanceMm: LIMITS.minTipClearanceMm })?.lengthMm;
    if (screwLength === undefined) {
      const fixes: string[] = [];
      const next = shortestStockScrewLength(through, LIMITS.minEngagementMm);
      if (lidFastener!.base === "pilot" && next !== undefined) {
        // A given standoffs.heightMm that would not hold the deeper pilot is named with it (the default height follows by itself).
        const depth = r9(next - through + LIMITS.minTipClearanceMm);
        const height = input.standoffs?.heightMm;
        fixes.push(`use lid.fasteners.pilotDepthMm ${depth} ${height !== undefined && height < depth + 1 - EPS ? `with standoffs.heightMm ${r9(depth + 1)} ` : ""}for a stocked ${next} mm screw${height === undefined ? " (the default standoff height follows)" : ""}`);
      }
      // The nearest component height: the through length that puts a stocked screw between the two limits.
      let nearest: { delta: number; length: number } | undefined;
      for (const length of STOCK_SCREW_LENGTHS_MM) {
        const low = length - holeDepth + LIMITS.minTipClearanceMm;
        const high = length - LIMITS.minEngagementMm;
        if (low > high + EPS) continue;
        const delta = through > high ? high - through : through < low ? low - through : 0;
        if (Hc + delta > EPS && (!nearest || Math.abs(delta) < Math.abs(nearest.delta) - EPS)) nearest = { delta, length };
      }
      if (nearest) fixes.push(`${fixes.length > 0 ? "or " : ""}use board.componentHeightMm ${r9(Hc + nearest.delta)} for a stocked ${nearest.length} mm screw`);
      if (fixes.length === 0) fixes.push(`use a standoff hole at least ${LIMITS.minEngagementMm + LIMITS.minTipClearanceMm} mm deep and a stack no longer than ${STOCK_SCREW_LENGTHS_MM.at(-1)! - LIMITS.minEngagementMm} mm`);
      stackProblems.push(`no standard screw length fits the stack: it needs between ${r9(through + LIMITS.minEngagementMm)} and ${r9(maxLength - LIMITS.minTipClearanceMm)} mm (lid + post + 0.2 mm gap + board = ${r9(through)} mm, at least ${LIMITS.minEngagementMm} mm in the ${holeDepth} mm standoff hole, ${LIMITS.minTipClearanceMm} mm tip clearance; stocked lengths ${STOCK_SCREW_LENGTHS_MM.join(", ")}); ${fixes.join(", ")}`);
    }
    const engagement = screwLength !== undefined ? r9(screwLength - through) : 0;
    stackDerived = {
      postAxesMm: standoffs.map((standoff) => [r9(standoff.axis[0]), r9(standoff.axis[1])] as Vector2),
      postOuterDiametersMm: standoffs.map((standoff) => r9(2 * standoff.radius)),
      postBottomZMm: r9(postBottom + exploded),
      postLengthMm: r9(postLength),
      holeDiameterMm: holeD,
      screwLengthMm: screwLength ?? 0,
      screwLengthMaxMm: r9(maxLength),
      engagementMm: engagement,
      note: "the posts reach 0.2 mm above the board inside the component envelope; component positions are not checked",
      lidWebs: lidWebs.map((web) => ({ label: web.label, gapMm: web.gapMm })),
    };
    lidFastener!.bossDiameterMm = Math.max(...ods);
    lidFastener!.bossLengthMm = r9(postLength);
    // The screw head (countersink rim) stays headInsideLidMm inside the lid outline over every post too.
    standoffs.forEach((standoff, index) => {
      const margin = roundedRectInsideDistance(standoff.axis, outerRect, Ro) - headCircleDiameter / 2;
      if (margin < LIMITS.headInsideLidMm - EPS) stackProblems.push(`the Ø${headCircleDiameter} ${lidHoleSpec?.countersink ? "countersink" : "screw head"} over board.holes[${index}] comes ${r3(margin)} mm from the lid edge; it must stay ${LIMITS.headInsideLidMm} mm inside the lid outline: move board.holes[${index}] ${r3(LIMITS.headInsideLidMm - margin)} mm inward or use a smaller head`);
    });
  }

  // The lid webs, joined in plan view like the base webs.
  const lidWebSolids = lidWebParts.length > 0 ? withPinchFix(() => planWebSolids(lidWebParts, OV)) : [];

  // Lid lip notches: the piece of lip a round notch leaves between itself and the corner; under minLipPieceMm the notch
  // becomes a box from the corner past the whole boss circle (boss + lid clearance), so no sliver remains.
  const lipCornerPiece = corner ? lipCornerPieceMm({ inset: s, notchRadius: bossR + lc, lipClearance: lc, lipWall: lw, outerRadius: lipRadius, innerRadius: lipInnerRadius }) : 0;
  const widenNotches = lipCornerPiece > 1e-6 && lipCornerPiece < LIMITS.minLipPieceMm - EPS;

  // --- openings ------------------------------------------------------------------------------------------------------
  const lipInnerRect: Rect = { min: [cavMin[0] + lipInset, cavMin[1] + lipInset], max: [cavMax[0] - lipInset, cavMax[1] - lipInset] };
  const floorRect: Rect = { min: [cavMin[0] + Ri, cavMin[1] + Ri], max: [cavMax[0] - Ri, cavMax[1] - Ri] };
  const lidKeepouts = [...posts, ...stackPosts].map((post) => ({
    label: post.label,
    axis: post.axis,
    // Corner bosses are notched into the lip with lid clearance; a stack post hangs from the lid itself.
    radius: Math.max(post.radius + (stack ? 0 : lc), (lidHoleSpec?.countersink?.majorDiameterMm ?? lidHoleSpec?.diameterMm ?? 0) / 2),
    headRadius: (lidHoleSpec?.countersink?.majorDiameterMm ?? lidHoleSpec?.diameterMm ?? 0) / 2,
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
    // Within minGapMm of the wall the cylinder is webbed to it (R4), so it counts as merged too.
    if (Math.abs(center[frame.normalIndex]! - frame.innerFace) >= radius + LIMITS.minGapMm - EPS) return false;
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
  const recessed: Array<{ label: string; wall: CaseWall; recess: number; grown: number }> = [];
  const checkWallFeature = (label: string, wall: CaseWall, along: Vector2, z: Vector2, fix?: { along: (delta: number) => { text: string; trial: BoardCaseInput }; z: (delta: number) => { text: string; trial: BoardCaseInput } }) => {
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
    // A web solid that stands at this wall (a wall box, or the fill under a strip between two features) is material
    // too: the cutter may not touch it.
    {
      const corners: Vector2[] = [[plan.min[0], plan.min[1]], [plan.max[0], plan.min[1]], [plan.max[0], plan.max[1]], [plan.min[0], plan.max[1]]];
      for (const solid of webSolids) {
        if (!overlaps(z, [Math.max(solid.bottomZMm, floorTopZ), solid.bottomZMm + solid.heightMm])) continue;
        if (polygonHitsRect(polygonPlanShape(solid.label, solid.loopMm, z, []), corners, plan)) fail(`${label} on wall ${wall} collides with the web at ${solid.label}`);
      }
    }
    // Stack posts keep out of the space in front of a wall opening: its along range + minWebMm, from the inner wall face
    // to stackKeepOutPastBoardEdgeMm inside the board edge, at the post's height.
    if (stackPosts.length > 0 && overlaps(z, [boardTopZ + LIMITS.stackPostGapMm, wallTopZ])) {
      const boardEdge = wall === "x-" ? boardMin[0] : wall === "x+" ? boardMin[0] + L : wall === "y-" ? boardMin[1] : boardMin[1] + W;
      const inward = wall.endsWith("-") ? 1 : -1;
      const depth = [frame.innerFace, boardEdge + inward * LIMITS.stackKeepOutPastBoardEdgeMm].sort((a, b) => a - b) as Vector2;
      const widened: Vector2 = [along[0] - LIMITS.minWebMm, along[1] + LIMITS.minWebMm];
      const keepOut: Rect = frame.alongIndex === 1 ? { min: [depth[0], widened[0]], max: [depth[1], widened[1]] } : { min: [widened[0], depth[0]], max: [widened[1], depth[1]] };
      for (const post of stackPosts) if (circleHitsRect(post.axis, post.radius, keepOut)) stackProblems.push(`${label} on wall ${wall}: ${post.label} stands in its keep-out (the opening's along range + ${LIMITS.minWebMm} mm, from the wall to ${LIMITS.stackKeepOutPastBoardEdgeMm} mm inside the board edge); move the opening along the wall or use bossStyle "floor"`);
    }
    // W5: no sliver beside a corner arc or above the floor. Each side edge sits exactly on the start of the inner corner
    // arc (cavity + inner radius) and of the outer one (outer face + outer radius), or keeps minOpeningEdgeMarginMm
    // from it on the flat side; the bottom edge sits exactly on the floor top or keeps that margin above it. (The top
    // edge ends at the lid lip bottom at the latest, a lip depth of 0.5 mm or more under the wall top.)
    {
      const margin = LIMITS.minOpeningEdgeMarginMm;
      const cavityAlong: Vector2 = frame.alongIndex === 0 ? [cavMin[0], cavMax[0]] : [cavMin[1], cavMax[1]];
      const starts = [...new Set([Ri, Math.max(0, snapZero(Ro - w))])];
      // Distance of an edge from the nearer cavity end, measured inward; allowed: exactly a start, or margin past it.
      const allowed = (inward: number) => starts.every((start) => Math.abs(inward - start) <= EPS || inward >= start + margin - EPS);
      const nearest = (inward: number): number => [...starts, ...starts.map((start) => start + margin)].filter(allowed).sort((a, b) => Math.abs(a - inward) - Math.abs(b - inward))[0]!;
      const low = along[0] - cavityAlong[0];
      const high = cavityAlong[1] - along[1];
      const where = (inward: number) => `${r9(inward)} mm from the cavity corner, where the corner arcs start at ${starts.map((start) => r9(start)).join(" and ")} mm`;
      if (!allowed(low)) fail(`${label} on wall ${wall}: its edge is ${where(low)}; an edge must sit exactly on an arc start or keep ${margin} mm from it (a narrower strip of wall is a sliver)${fix ? `; ${namedChange(fix.along, r9(nearest(low) - low))}` : ""}`);
      if (!allowed(high)) fail(`${label} on wall ${wall}: its edge is ${where(high)}; an edge must sit exactly on an arc start or keep ${margin} mm from it (a narrower strip of wall is a sliver)${fix ? `; ${namedChange(fix.along, r9(high - nearest(high)))}` : ""}`);
      const above = z[0] - floorTopZ;
      if (above > EPS && above < margin - EPS) fail(`${label} on wall ${wall}: its bottom edge is ${r9(above)} mm above the floor top; it must sit exactly on the floor top or at least ${margin} mm above it (a lower step is a sliver)${fix ? `; ${namedChange(fix.z, r9(above < margin / 2 ? -above : margin - above))}` : ""}`);
    }
    features.push({ label, face: wall, plan, inPlane: { min: [along[0], z[0]], max: [along[1], z[1]] }, z });
  };
  const checkFlatFeature = (label: string, face: "lid" | "floor", rect: Rect) => {
    const region = face === "lid" ? lipInnerRect : floorRect;
    if (!rectInside(rect, region)) {
      fail(`${label} on the ${face} (x ${r9(rect.min[0])}..${r9(rect.max[0])}, y ${r9(rect.min[1])}..${r9(rect.max[1])}) is not inside the ${face === "lid" ? "area inside the lid lip" : "flat floor"} (x ${r9(region.min[0])}..${r9(region.max[0])}, y ${r9(region.min[1])}..${r9(region.max[1])})`);
    }
    // A flat opening keeps minWebMm of material to a standoff or floor boss (floor) and to a countersink (lid).
    const keepWeb = (what: string, axis: Vector2, radius: number, web: number) => {
      if (circleHitsRect(axis, radius, rect)) fail(`${label} on the ${face} collides with ${what}`);
      if (web > 0 && circleHitsRect(axis, radius + web, rect)) fail(`${label} on the ${face} leaves less than the ${web} mm web to ${what}`);
    };
    if (face === "lid") {
      for (const keepout of lidKeepouts) {
        keepWeb(keepout.label, keepout.axis, keepout.radius, 0);
        if (keepout.headRadius > 0) keepWeb(`the ${keepout.label} screw head`, keepout.axis, keepout.headRadius, LIMITS.minWebMm);
      }
      // A lid web (between a post and the lip) hangs under the plate here.
      for (const solid of lidWebSolids) {
        const box: Rect = { min: [Math.min(...solid.loopMm.map((point) => point[0])), Math.min(...solid.loopMm.map((point) => point[1]))], max: [Math.max(...solid.loopMm.map((point) => point[0])), Math.max(...solid.loopMm.map((point) => point[1]))] };
        if (rectsOverlap(growRect(box, LIMITS.minWebMm), rect)) fail(`${label} on the lid leaves less than the ${LIMITS.minWebMm} mm web to the lid web at ${solid.label}`);
      }
    } else {
      for (const standoff of standoffs) keepWeb(standoff.label, standoff.axis, standoff.radius, LIMITS.minWebMm);
      if (bossStyle === "floor") for (const post of posts) keepWeb(post.label, post.axis, post.radius, LIMITS.minWebMm);
      for (const solid of webSolids) {
        if (solid.bottomZMm > floorTopZ + EPS) continue;
        const box: Rect = { min: [Math.min(...solid.loopMm.map((point) => point[0])), Math.min(...solid.loopMm.map((point) => point[1]))], max: [Math.max(...solid.loopMm.map((point) => point[0])), Math.max(...solid.loopMm.map((point) => point[1]))] };
        if (rectsOverlap(growRect(box, LIMITS.minWebMm), rect)) fail(`${label} on the floor leaves less than the ${LIMITS.minWebMm} mm web to the web between ${solid.label}`);
      }
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
      if (Math.min(width, height) < LIMITS.minOpeningSideMm - EPS) fail(`${label}: a ${opening.shape} opening needs sides of at least ${LIMITS.minOpeningSideMm} mm (got ${width} x ${height})`);
    }
    let corner = 0;
    // A rounded-rect whose radius is exactly half the shorter side is a slot (stadium) and is built as one.
    let slot = false;
    if (opening.shape === "rounded-rect") {
      corner = positive(`${label}: cornerRadiusMm`, opening.cornerRadiusMm);
      const half = Math.min(width, height) / 2;
      if (Math.abs(corner - half) <= EPS && Math.abs(width - height) > EPS) slot = true;
      else if (corner > half - LIMITS.minCornerRadiusMarginMm + EPS) fail(`${label}: cornerRadiusMm ${corner} must be at most half the shorter side minus ${LIMITS.minCornerRadiusMarginMm} mm (${r9(half - LIMITS.minCornerRadiusMarginMm)}), or exactly half (${r9(half)}) for a slot`);
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
      openings.push({ label, target: top ? "lid" : "base", shape: opening.shape, entryCenterMm: entry, axis: [0, 0, top ? -1 : 1], widthDirection: [1, 0, 0], widthMm: width, heightMm: height, cornerRadiusMm: corner, throughDepthMm: top ? tl : f, face: opening.wall, ...(slot ? { slot } : {}) });
      openingsDerived.push({ label, wall: opening.wall, shape: opening.shape, centerMm: [entry[0], entry[1], r9(top ? lidTopZ : oz)], sizeMm: [width, height], ...(corner > 0 ? { cornerRadiusMm: corner } : {}) });
    } else {
      if (opening.aboveBoardMm === undefined || !Number.isFinite(opening.aboveBoardMm)) fail(`${label}: a wall opening needs aboveBoardMm (its bottom above the board top surface)`);
      if (opening.acrossMm !== undefined) fail(`${label}: a wall opening takes aboveBoardMm, not acrossMm`);
      const frame = wallFrame(opening.wall);
      const alongCenter = frame.boardAlongMin + opening.alongMm;
      const zBottom = boardTopZ + opening.aboveBoardMm!;
      checkWallFeature(label, opening.wall, [alongCenter - width / 2, alongCenter + width / 2], [zBottom, zBottom + height], {
        along: (delta) => ({ text: `use alongMm ${r9(opening.alongMm + delta)}`, trial: { ...input, openings: input.openings!.map((other, at) => at === index ? { ...other, alongMm: r9(opening.alongMm + delta) } : other) } }),
        z: (delta) => ({ text: `use aboveBoardMm ${r9(opening.aboveBoardMm! + delta)}`, trial: { ...input, openings: input.openings!.map((other, at) => at === index ? { ...other, aboveBoardMm: r9(opening.aboveBoardMm! + delta) } : other) } }),
      });
      const entry: Vector3 = frame.alongIndex === 1 ? [frame.outerFace, alongCenter, zBottom + height / 2] : [alongCenter, frame.outerFace, zBottom + height / 2];
      const rounded = entry.map(r9) as Vector3;
      openings.push({ label, target: "base", shape: opening.shape, entryCenterMm: rounded, axis: frame.axis, widthDirection: frame.widthDirection, widthMm: width, heightMm: height, cornerRadiusMm: corner, throughDepthMm: w, face: opening.wall, ...(slot ? { slot } : {}) });
      const boardEdge = opening.wall === "x-" ? boardMin[0] : opening.wall === "x+" ? boardMin[0] + L : opening.wall === "y-" ? boardMin[1] : boardMin[1] + W;
      const recess = r9(Math.abs(boardEdge - frame.innerFace));
      const grown = growth[frame.normalIndex]! / 2;
      const recessNote = recess > LIMITS.reportRecessOverMm + EPS
        ? `the inner face of wall ${opening.wall} stands ${recess} mm from the board edge (fit.boardClearanceMm ${bc}${grown > 0 ? ` + ${r9(grown)} mm: bossStyle "floor" widens the cavity along ${frame.normalIndex === 0 ? "x" : "y"}` : ""}), so a connector at the board edge sits that far behind this opening`
        : undefined;
      openingsDerived.push({ label, wall: opening.wall, shape: opening.shape, recessMm: recess, ...(recessNote ? { recessNote } : {}), centerMm: rounded, sizeMm: [width, height], ...(corner > 0 ? { cornerRadiusMm: corner } : {}) });
      if (recessNote) recessed.push({ label, wall: opening.wall, recess, grown });
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
    if (sw < LIMITS.minSlotWidthMm - EPS) fail(`vents.slotWidthMm ${sw} is below the ${LIMITS.minSlotWidthMm} mm minimum slot width`);
    if (sl < sw + LIMITS.minSlotStraightMm - EPS) fail(`vents.slotLengthMm ${sl} must be at least vents.slotWidthMm + ${LIMITS.minSlotStraightMm} (${r9(sw + LIMITS.minSlotStraightMm)}): the straight part of a slot is at least ${LIMITS.minSlotStraightMm} mm`);
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
        checkWallFeature(`vent slot ${index}`, vent.on as CaseWall, [along - sw / 2, along + sw / 2], [zCenter - sl / 2, zCenter + sl / 2], {
          along: (delta) => ({ text: `use vents.centerAlongMm ${r9(alongCenter - frame.boardAlongMin + delta)}`, trial: { ...input, vents: { ...vent, centerAlongMm: r9(alongCenter - frame.boardAlongMin + delta) } } }),
          z: (delta) => ({ text: `use vents.centerAcrossMm ${r9(zCenter - boardTopZ + delta)}`, trial: { ...input, vents: { ...vent, centerAcrossMm: r9(zCenter - boardTopZ + delta) } } }),
        });
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

  // R1: a profile-based cut (rect, rounded-rect or slot opening; vent slots) followed by another on the same face deletes
  // its profile Wire right after its cut.
  openings.forEach((opening, index) => {
    if (opening.shape === "circle") return;
    const later = openings.slice(index + 1).some((other) => other.face === opening.face && other.shape !== "circle") || (input.vents !== undefined && input.vents.on === opening.face);
    if (later) opening.dropProfile = true;
  });

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
  if (cornerScrewProblem) fail(cornerScrewProblem);
  const dropIn = LIMITS.dropInClearanceMm;
  const grownBoard: Rect = { min: [boardMin[0] - dropIn, boardMin[1] - dropIn], max: [boardMin[0] + L + dropIn, boardMin[1] + W + dropIn] };
  const blockers = posts.filter((post) => circleHitsRect(post.axis, post.radius, grownBoard)).map((post) => post.label);
  if (taperHitsRect(grownBoard, [-Infinity, Infinity])) blockers.push("the 45 degree gussets");
  const boardDropIn = blockers.length === 0;
  // A blocker over the board outline itself stops the board; one only inside the 0.2 mm margin may let it pass, tightly.
  const boardRect: Rect = { min: [boardMin[0], boardMin[1]], max: [boardMin[0] + L, boardMin[1] + W] };
  const hardBlock = posts.some((post) => circleHitsRect(post.axis, post.radius, boardRect)) || taperHitsRect(boardRect, [-Infinity, Infinity]);
  const assembly = {
    boardDropIn,
    note: boardDropIn
      ? posts.length === 0
        ? stack ? "bossStyle \"stack\": no corner bosses (the lid screws run through the board holes), so the board drops straight in onto the standoffs" : "no corner bosses: the board drops straight in"
        : `plan view: no corner boss or gusset overlaps the board outline grown by ${dropIn} mm, so the board drops straight in past the ${bossStyle} bosses`
      : hardBlock
        ? `plan view: ${blockers.join(", ")} overlap the board outline, so the board cannot be lowered straight into the finished base${bossStyle === "floor" ? "" : "; bossStyle \"floor\" keeps the bosses beside the board"}`
        : `plan view: the board comes within ${dropIn} mm of ${blockers.join(", ")}, so it may not lower freely${bossStyle === "floor" ? " (fit.boardClearanceMm is below the drop-in clearance)" : "; bossStyle \"floor\" keeps the bosses beside the board"}`,
  };
  // D2: what the board rests on.
  if (holes.length === 0) assembly.note += ". The board has no holes, so there are no standoffs: it rests on the floor top";
  else if (standoffFastener?.mode === "support") assembly.note += ". With no standoffs.fastener the standoffs are plain support posts: the board rests on them, unscrewed";
  // W7: what a caller must not miss, also at the top level of the reply: a board that no screw holds, and an opening
  // whose wall stands away from the board edge. Each names its cause and the change that gives a fastened stack.
  const warnings: string[] = [];
  {
    const styleReason = resolved?.styleReason ?? "lid.fasteners.bossStyle";
    if (holes.length === 0) {
      warnings.push("the board is not fastened: board.holes is empty, so the case has no standoffs and the board rests loose on the floor. Change: give board.holes (2 or more, with lid.fasteners { screw: \"auto\", base: \"pilot\" }, for a screw stack through the board)");
    } else if (!stack && standoffFastener?.mode === "support") {
      const [cause, change] = !lidFasteners
        ? ["lid.fasteners is not given", "give lid.fasteners { screw: \"auto\", base: \"pilot\" } for a screw stack through the board holes, or standoffs.fastener to screw the board to its standoffs"]
        : styleReason === "lid.fasteners.bossStyle"
          ? [`lid.fasteners.bossStyle "${bossStyle}" is given`, "leave bossStyle out or use \"stack\" (the lid screws then hold the board), or give standoffs.fastener to screw the board to its standoffs"]
          : [styleReason, "make the change named there for a screw stack, or give standoffs.fastener to screw the board to its standoffs"];
      warnings.push(`the board is not fastened by screws: it rests on plain support posts, and ${lidFasteners ? `the lid screws go into ${bossStyle} corner bosses` : "the lid has no screws"}. Cause: ${cause}. Change: ${change}`);
    }
    for (const entry of recessed) {
      warnings.push(`${entry.label} on wall ${entry.wall} is recessed: the wall's inner face stands ${entry.recess} mm from the board edge, so a connector at the board edge does not reach the opening. Cause: ${entry.grown > 0 ? `bossStyle "floor" widens the cavity along ${entry.wall.startsWith("x") ? "x" : "y"} (${growAxisReason ?? "lid.fasteners.growAxis"})` : `fit.boardClearanceMm ${bc}`}. Change: ${entry.grown > 0 ? `a screw stack does not widen the cavity (${styleReason === "lid.fasteners.bossStyle" ? "leave bossStyle out or use \"stack\"" : "derived.bossStyleReason names what prevents it"}), or choose lid.fasteners.growAxis "${entry.wall.startsWith("x") ? "y" : "x"}" so that this wall does not move` : "a smaller fit.boardClearanceMm"}`);
    }
  }
  // D5: the real diagonal play: how far the board can slide toward each cavity corner (along the diagonal) before it
  // touches a wall, the rounded corner, a floor-standing boss or a web at board height; the smallest of the four.
  const boardZ: Vector2 = [boardBottomZ, boardTopZ];
  const obstacles = {
    circles: bossStyle === "floor" ? posts.map((post) => ({ axis: post.axis, radius: post.radius })) : [],
    webs: webSolids.filter((solid) => overlaps([solid.bottomZMm, solid.bottomZMm + solid.heightMm], boardZ)).map((solid) => polygonPlanShape(solid.label, solid.loopMm, boardZ, [])),
  };
  const collides = (dx: number, dy: number): boolean => {
    const rect: Rect = { min: [boardMin[0] + dx, boardMin[1] + dy], max: [boardMin[0] + L + dx, boardMin[1] + W + dy] };
    const corners: Vector2[] = [[rect.min[0], rect.min[1]], [rect.max[0], rect.min[1]], [rect.max[0], rect.max[1]], [rect.min[0], rect.max[1]]];
    // Exact tests (no tolerance), so the bisection ends on the touching position itself.
    if (corners.some((point) => roundedRectInsideDistance(point, cavRect, Ri) < 0)) return true;
    const reaches = (circle: { axis: Vector2; radius: number }) => Math.hypot(Math.max(rect.min[0] - circle.axis[0], 0, circle.axis[0] - rect.max[0]), Math.max(rect.min[1] - circle.axis[1], 0, circle.axis[1] - rect.max[1])) < circle.radius;
    return obstacles.circles.some(reaches) || obstacles.webs.some((web) => polygonHitsRect(web, corners, rect));
  };
  let realCornerGap = Infinity;
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    let low = 0;
    let high = Math.hypot(cavityL, cavityW);
    if (collides(0, 0)) { realCornerGap = 0; break; }
    for (let step = 0; step < 60; step += 1) {
      const mid = (low + high) / 2;
      if (collides((sx * mid) / Math.SQRT2, (sy * mid) / Math.SQRT2)) high = mid; else low = mid;
    }
    realCornerGap = Math.min(realCornerGap, low);
  }
  if (!boardDropIn && !allowBlockedBoard) {
    if (bossStyle === "floor") {
      fail(`the floor-standing corner bosses are fit.boardClearanceMm ${bc} mm from the board, less than the ${dropIn} mm the board needs to drop in past them; raise fit.boardClearanceMm to ${dropIn}, or pass lid.fasteners.allowBlockedBoard: true to build it anyway`);
    }
    fail(hardBlock
      ? `with bossStyle "${bossStyle}" the corner bosses${bossStyle === "tapered" ? " and their 45 degree gussets" : ""} hang over the board corners: in plan view ${blockers.join(", ")} overlap the board outline grown by ${dropIn} mm, so the board cannot be lowered into the finished base. Use bossStyle "floor" (the bosses stand beside the board), or pass lid.fasteners.allowBlockedBoard: true to build it anyway`
      : `with bossStyle "${bossStyle}" the board comes within ${dropIn} mm of ${blockers.join(", ")} in plan view, so it may not lower freely. Use bossStyle "floor" (the bosses stand beside the board), or pass lid.fasteners.allowBlockedBoard: true to build it anyway`);
  }

  const notches: LipNotch[] = posts.map((post, index) => {
    // A corner web of this boss rises to the wall top in the corner quadrant: no lip piece may stay there either.
    const cornerWebbed = webs.some((web) => web.kind === "corner" && web.features.includes(post.label));
    if (!widenNotches && !(cornerWebbed && lipCornerPiece > 1e-6)) return { kind: "cylinder", centerMm: [post.axis[0], post.axis[1], r9(lipBottomZ - OV)] as Vector3, radiusMm: r9(post.radius + lc), heightMm: r9(d + 3 * OV) };
    const corner = cavityCorners[index]!;
    const far: Vector2 = [post.axis[0] + Math.sign(post.axis[0] - corner[0]) * (post.radius + lc), post.axis[1] + Math.sign(post.axis[1] - corner[1]) * (post.radius + lc)];
    const near: Vector2 = [corner[0] - Math.sign(post.axis[0] - corner[0]) * OV, corner[1] - Math.sign(post.axis[1] - corner[1]) * OV];
    const min: Vector3 = [r9(Math.min(near[0], far[0])), r9(Math.min(near[1], far[1])), r9(lipBottomZ - OV)];
    return { kind: "box", originMm: min, sizeMm: [r9(Math.abs(far[0] - near[0])), r9(Math.abs(far[1] - near[1])), r9(d + 3 * OV)], cornerPieceMm: r9(lipCornerPiece) };
  });
  // The lip piece between the two notches of one side narrows where the notch discs come closest (the lip row nearest the
  // boss axes); it must stay minLipNeckMm wide there (a box notch cuts straight across at boss + lid clearance).
  if (posts.length > 0) {
    const notchRadius = bossR + lc;
    const band: Vector2 = [lc, lc + lw];
    const rowDistance = s < band[0] ? band[0] - s : s > band[1] ? s - band[1] : 0;
    const chordHalf = widenNotches ? notchRadius : rowDistance >= notchRadius ? 0 : Math.sqrt(notchRadius * notchRadius - rowDistance * rowDistance);
    for (const [side, length] of [["x", cavityL], ["y", cavityW]] as const) {
      const neck = length - 2 * s - 2 * chordHalf;
      if (neck < LIMITS.minLipNeckMm - EPS) fail(`the lid lip between the two boss notches along ${side} is ${r3(neck)} mm wide at its narrowest, below the ${LIMITS.minLipNeckMm} mm minimum: use a smaller lid.fasteners.bossDiameterMm, a thinner lid.lipWallMm or a larger board clearance`);
    }
  }

  const bounds = (min: Vector3, max: Vector3): Bounds => ({ min: min.map(r9) as Vector3, max: max.map(r9) as Vector3 });
  const lidHoles = lidHoleSpec;
  const body: Omit<BoardCasePlan, "name" | "derived"> = {
    warnings,
    base: {
      boxOriginMm: [ox, oy, oz],
      boxSizeMm: [r9(outerL), r9(outerW), r9(wallTopZ - oz)],
      outerRadiusMm: Ro,
      cavityOriginMm: [r9(cavMin[0]), r9(cavMin[1]), r9(floorTopZ)],
      cavitySizeMm: [r9(cavityL), r9(cavityW), r9(innerHeight + OV)],
      innerRadiusMm: r9(Ri),
    },
    standoffGroups,
    webs,
    webSolids,
    ...(standoffFloorHoles ? { standoffFloorHoles } : {}),
    ...(lidPosts ? { lidPosts } : {}),
    ...(lidWebs.length > 0 ? { lidWebs, lidWebSolids } : {}),
    ...(corner && postHole ? {
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
  // D2 (4): every failed stack rule, each with the input change that passes it.
  // The same rule failing at several holes is listed once, naming the other holes.
  if (stackProblems.length > 0) {
    const groups = new Map<string, { message: string; holes: string[] }>();
    for (const message of stackProblems) {
      const indexes = [...message.matchAll(/board\.holes\[(\d+)\]/g)].map((match) => match[1]!);
      const key = new Set(indexes).size === 1 ? message.replace(/board\.holes\[\d+\]/g, "board.holes[#]") : message;
      const group = groups.get(key);
      if (group) { if (!group.holes.includes(indexes[0]!)) group.holes.push(indexes[0]!); } else groups.set(key, { message, holes: new Set(indexes).size === 1 ? [indexes[0]!] : [] });
    }
    const listed = [...groups.values()].map(({ message, holes }) => holes.length > 1 ? `${message} (the same for ${holes.slice(1).map((index) => `board.holes[${index}]`).join(", ")})` : message);
    const refusal = new BoardCaseValidationError(`${listed[0]!.includes("bossStyle \"stack\"") ? "" : "bossStyle \"stack\": "}${listed.join("; ")}`);
    if (stackWebRule) webRuleRefusals.add(refusal);
    throw refusal;
  }
  const plannedUndoSteps = countBoardCaseSteps(body, exploded);
  if (plannedUndoSteps > LIMITS.maxUndoSteps) fail(`the build would take ${plannedUndoSteps} Undo steps, above the ${LIMITS.maxUndoSteps}-step limit; use fewer vent slots, openings or board holes`);

  const derived: BoardCaseDerived = {
    outerMm: bounds([ox, oy, oz], [ox + outerL, oy + outerW, wallTopZ]),
    cavityMm: bounds([cavMin[0], cavMin[1], floorTopZ], [cavMax[0], cavMax[1], wallTopZ]),
    innerCornerRadiusMm: r9(Ri),
    cornerGapMm: r9(realCornerGap),
    cornerWallMm: r9(cornerWall),
    floorTopZMm: r9(floorTopZ),
    boardMm: bounds([boardMin[0], boardMin[1], boardBottomZ], [boardMin[0] + L, boardMin[1] + W, boardTopZ]),
    boardTopZMm: r9(boardTopZ),
    componentTopZMm: r9(componentTopZ),
    wallTopZMm: r9(wallTopZ),
    lidTopZMm: r9(lidTopZ),
    lidMm: bounds([ox, oy, Math.min(lipBottomZ, stack ? boardTopZ + LIMITS.stackPostGapMm : lipBottomZ) + exploded], [ox + outerL, oy + outerW, lidTopZ]),
    explodedMm: exploded,
    standoffAxesMm: standoffs.map((standoff) => [r9(standoff.axis[0]), r9(standoff.axis[1])]),
    ...(standoffInput ? { standoffTopZMm: r9(boardBottomZ) } : {}),
    lidBossAxesMm: posts.map((post) => post.axis),
    ...(lidFasteners ? { bossStyle, bossStyleReason: resolved?.styleReason ?? "lid.fasteners.bossStyle" } : {}),
    ...(corner ? { lidBossBottomZMm: r9(postBottomZ) } : {}),
    ...(stackDerived ? { stack: stackDerived } : {}),
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
      ...(stack ? { lidPostOverhangDeg: 0 } : {}),
      openingCeilings,
    },
    lipOuterMm: bounds([cavMin[0] + lc, cavMin[1] + lc, lipBottomZ + exploded], [cavMax[0] - lc, cavMax[1] - lc, wallTopZ + exploded]),
    lipInnerMm: bounds([lipInnerRect.min[0], lipInnerRect.min[1], lipBottomZ + exploded], [lipInnerRect.max[0], lipInnerRect.max[1], wallTopZ + exploded]),
    openings: openingsDerived,
    ...(ventsDerived ? { vents: ventsDerived } : {}),
    plannedUndoSteps,
    webs,
    fasteners: { ...(standoffFastener ? { standoffs: standoffFastener } : {}), ...(lidFastener ? { lid: lidFastener } : {}) },
  };

  // D1: no pair of features within tangentBandMm of tangency (unless a web covers the spot) and no edge under
  // minPlanEdgeMm, in the finished bodies or right after the webs are joined. A plan that has one is refused with the
  // nearest board-hole position (or standoff diameter) that plans clean.
  const plan: BoardCasePlan = { name, derived, ...body };
  if (options.guards !== false) {
    const findings = [...boardCaseTangencies(plan), ...boardCaseShortEdges(plan)];
    if (findings.length > 0) {
      const first = findings[0]!;
      const where = `${first.body === "lid" ? "on the lid" : "in the base"}${first.stage === "webs" ? " (after the webs are joined)" : ""}`;
      const what = first.kind === "tangent"
        ? `${first.features.join(" and ")} would ${first.valueMm > 0 ? `stand ${r3(first.valueMm)} mm apart` : `overlap by only ${r3(-first.valueMm)} mm`} ${where}, within ${LIMITS.tangentBandMm} mm of tangent, with no web over the spot`
        : first.kind === "edge"
          ? `the outline where ${first.features.join(", ")} meet ${where} would have ${first.valueMm < 0.001 ? "an edge under 0.001 mm" : `a ${r3(first.valueMm)} mm edge`} at x ${r3(first.atMm[0])}, y ${r3(first.atMm[1])}, z ${r3(first.atMm[2])}, under the ${first.stage === "webs" ? LIMITS.minWebStageEdgeMm : LIMITS.minPlanEdgeMm} mm the plan allows`
          : `${first.features.join(", ")} would end ${r3(first.valueMm)} mm apart in height ${where}, under the ${first.stage === "webs" ? LIMITS.minWebStageEdgeMm : LIMITS.minPlanEdgeMm} mm the plan allows`;
      const more = findings.length > 1 ? ` (and ${findings.length - 1} more such spot${findings.length > 2 ? "s" : ""})` : "";
      const fix = options.fixes === false ? "move a board hole or change standoffs.outerDiameterMm" : nearestCleanChange(input, [...new Set(findings.flatMap((finding) => finding.holes))], (trial) => { planBoardCase(trial, { styleReason: resolved?.styleReason ?? "lid.fasteners.bossStyle", ...(resolved?.screwReason ? { screwReason: resolved.screwReason } : {}), ...(resolved?.auto ? { auto: true } : {}), postSearch: true }, { fixes: false }); });
      const refusal = new BoardCaseValidationError(`${what}${more}, which the kernel cannot build reliably; ${fix}`);
      webRuleRefusals.add(refusal);
      throw refusal;
    }
  }

  return plan;
}

// D1: what the plan guards refuse. "tangent": two features whose surfaces come within tangentBandMm of touching (a gap
// or an overlap) with no web over the spot. "edge": an edge of the body shorter than minPlanEdgeMm. "height": two
// feature tops less than minPlanEdgeMm apart. Stage "webs" is the body right after the webs are joined (before the
// standoffs, bosses or posts); "built" is the finished body.
export interface BoardCaseFinding {
  kind: "tangent" | "edge" | "height";
  body: "base" | "lid";
  stage: "built" | "webs";
  features: string[];
  valueMm: number;
  atMm: Vector3;
  // The board holes that place the features involved.
  holes: number[];
}

// The plan-view shapes of the two bodies, from the plan alone. Base: the cavity wall, the standoffs, the corner bosses
// and the web solids. Lid (bossStyle "stack" only): the lip ring, the posts and the lid web solids. Not modelled: the
// 45 degree gussets, the lip notches around corner bosses, openings, vents and screw holes (each has its own plan rule).
export function boardCasePlanShapes(plan: BoardCasePlan): { base: PlanShape[]; lid: PlanShape[] } {
  const known = planShapes.get(plan);
  if (known) return known;
  const d = plan.derived;
  const floor = d.floorTopZMm;
  const top = d.wallTopZMm;
  const cavity: Rect = { min: [d.cavityMm.min[0], d.cavityMm.min[1]], max: [d.cavityMm.max[0], d.cavityMm.max[1]] };
  const base: PlanShape[] = [{ label: "the cavity wall", kind: "wall", z: [floor, top], holes: [], curves: roundedRectCurves(cavity, d.innerCornerRadiusMm, false), sdf: (p) => roundedRectInsideDistance(p, cavity, d.innerCornerRadiusMm) }];
  const diameters = d.fasteners.standoffs?.outerDiametersMm ?? [];
  d.standoffAxesMm.forEach((axis, index) => base.push(circlePlanShape(`standoff ${index}`, axis, diameters[index]! / 2, [floor, d.standoffTopZMm ?? floor], [index])));
  if (d.fasteners.lid && d.bossStyle !== "stack") d.lidBossAxesMm.forEach((axis, index) => base.push(circlePlanShape(`lid boss ${index}`, axis, d.fasteners.lid!.bossDiameterMm / 2, [d.lidBossBottomZMm ?? floor, top], [])));
  for (const solid of plan.webSolids) base.push(polygonPlanShape(`the web at ${solid.label}`, solid.loopMm, [Math.max(solid.bottomZMm, floor), Math.min(solid.bottomZMm + solid.heightMm, top)], solid.holes));
  const lid: PlanShape[] = [];
  if (d.stack) {
    const lift = d.explodedMm;
    const lipZ: Vector2 = [d.lipOuterMm.min[2] - lift, top];
    const outer: Rect = { min: [d.lipOuterMm.min[0], d.lipOuterMm.min[1]], max: [d.lipOuterMm.max[0], d.lipOuterMm.max[1]] };
    const inner: Rect = { min: [d.lipInnerMm.min[0], d.lipInnerMm.min[1]], max: [d.lipInnerMm.max[0], d.lipInnerMm.max[1]] };
    lid.push({ label: "the lid lip", kind: "lip", z: lipZ, holes: [], curves: [...roundedRectCurves(outer, plan.lid.lipRadiusMm, true), ...roundedRectCurves(inner, plan.lid.lipInnerRadiusMm, false)], sdf: (p) => Math.max(-roundedRectInsideDistance(p, outer, plan.lid.lipRadiusMm), roundedRectInsideDistance(p, inner, plan.lid.lipInnerRadiusMm)) });
    d.stack.postAxesMm.forEach((axis, index) => lid.push(circlePlanShape(`the lid post over board.holes[${index}]`, axis, d.stack!.postOuterDiametersMm[index]! / 2, [d.stack!.postBottomZMm - lift, top], [index])));
    for (const solid of plan.lidWebSolids ?? []) lid.push(polygonPlanShape(`the lid web at ${solid.label}`, solid.loopMm, [solid.bottomZMm, top], solid.holes));
  }
  planShapes.set(plan, { base, lid });
  return { base, lid };
}

const planShapes = new WeakMap<BoardCasePlan, { base: PlanShape[]; lid: PlanShape[] }>();

const shapeSamples = new WeakMap<PlanShape, { points: Vector2[]; box: Rect }>();

// Points along a shape's boundary, at most 0.02 mm apart (so a sampled distance is within 0.01 mm of the true one).
function samplesOf(shape: PlanShape): { points: Vector2[]; box: Rect } {
  const known = shapeSamples.get(shape);
  if (known) return known;
  const points: Vector2[] = [];
  for (const curve of shape.curves) {
    const count = Math.max(1, Math.ceil(curveLength(curve) / 0.02));
    const [t0, t1] = curve.kind === "seg" ? [0, 1] : [curve.a0, curve.a1];
    for (let index = 0; index <= count; index += 1) points.push(curvePoint(curve, t0 + ((t1 - t0) * index) / count));
  }
  const box: Rect = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
  for (const point of points) { box.min[0] = Math.min(box.min[0], point[0]); box.min[1] = Math.min(box.min[1], point[1]); box.max[0] = Math.max(box.max[0], point[0]); box.max[1] = Math.max(box.max[1], point[1]); }
  const entry = { points, box };
  shapeSamples.set(shape, entry);
  return entry;
}

// D1, the pair rule: the signed gap of two features is the least distance from either one's surface to the other's
// material (negative: the depth one reaches into the other). A pair within tangentBandMm of zero is a finding unless
// the spot lies at least 0.1 mm inside a web that spans the height the two share (the web makes it a solid merge). Two
// webs are not a pair: webs are joined in the plan, and the edge rule covers what their solids leave.
export function boardCaseTangencies(plan: BoardCasePlan): BoardCaseFinding[] {
  const band = BOARD_CASE_LIMITS.tangentBandMm;
  const pad = band + 0.03;
  const findings: BoardCaseFinding[] = [];
  const bodies = boardCasePlanShapes(plan);
  for (const body of ["base", "lid"] as const) {
    const shapes = bodies[body];
    for (let i = 0; i < shapes.length; i += 1) for (let j = i + 1; j < shapes.length; j += 1) {
      const a = shapes[i]!;
      const b = shapes[j]!;
      if (a.kind === "web" && b.kind === "web") continue;
      const low = Math.max(a.z[0], b.z[0]);
      const high = Math.min(a.z[1], b.z[1]);
      if (!(high > low + 1e-9)) continue;
      let gap = Infinity;
      let at: Vector2 = [0, 0];
      // A point deeper than the band inside the other feature settles it: the pair overlaps for real.
      const scan = (from: PlanShape, to: PlanShape) => {
        if (gap <= -band) return;
        for (const p of samplesOf(from).points) {
          const value = to.sdf(p);
          if (value < gap) { gap = value; at = p; if (value <= -band) return; }
        }
      };
      const enclosing = (shape: PlanShape) => shape.kind === "wall" || shape.kind === "lip";
      if (enclosing(a) || enclosing(b)) {
        // A wall or a lip surrounds the other feature: the nearest approach lies on the other feature's surface.
        scan(enclosing(a) ? b : a, enclosing(a) ? a : b);
      } else {
        // Shapes whose boxes are further apart than the band cannot be within it.
        const boxA = samplesOf(a).box;
        const boxB = samplesOf(b).box;
        if (boxA.min[0] > boxB.max[0] + pad || boxB.min[0] > boxA.max[0] + pad || boxA.min[1] > boxB.max[1] + pad || boxB.min[1] > boxA.max[1] + pad) continue;
        scan(a, b);
        scan(b, a);
      }
      if (!(Math.abs(gap) < band - 1e-9)) continue;
      if (shapes.some((other) => other.kind === "web" && other !== a && other !== b && other.z[0] <= low + 1e-9 && other.z[1] >= high - 1e-9 && other.sdf(at) <= -0.1)) continue;
      findings.push({ kind: "tangent", body, stage: "built", features: [a.label, b.label], valueMm: r9(gap), atMm: [r9(at[0]), r9(at[1]), r9((low + high) / 2)], holes: [...new Set([...a.holes, ...b.holes])] });
    }
  }
  return findings;
}

// D1, the edge rule: every horizontal edge of the body lies at a height where a feature starts or ends, and is a piece
// of the plan-view outline there; the vertical edges are as long as the height steps. Each is computed exactly (lines and
// arcs) for the finished body (a finding under minPlanEdgeMm) and for the body right after its webs are joined (a finding
// under minWebStageEdgeMm: those edges are covered again by the standoffs, bosses or posts).
export function boardCaseShortEdges(plan: BoardCasePlan): BoardCaseFinding[] {
  const findings: BoardCaseFinding[] = [];
  const bodies = boardCasePlanShapes(plan);
  for (const body of ["base", "lid"] as const) {
    // Under the base's features is the floor; over the lid's features is the lid plate.
    const [under, over]: [PlanRegion, PlanRegion] = body === "base" ? ["solid", "empty"] : ["empty", "solid"];
    for (const stage of ["webs", "built"] as const) {
      const limit = stage === "built" ? BOARD_CASE_LIMITS.minPlanEdgeMm : BOARD_CASE_LIMITS.minWebStageEdgeMm;
      const shapes = stage === "built" ? bodies[body] : bodies[body].filter((shape) => shape.kind !== "circle");
      if (stage === "webs" && !shapes.some((shape) => shape.kind === "web")) continue;
      const heights = [...new Set(shapes.flatMap((shape) => shape.z).map(r9))].sort((left, right) => left - right);
      const between = (low: number, high: number) => shapes.map((_, index) => index).filter((index) => shapes[index]!.z[0] <= low + 1e-9 && shapes[index]!.z[1] >= high - 1e-9);
      heights.forEach((z, index) => {
        if (index > 0 && z - heights[index - 1]! < limit - 1e-9) findings.push({ kind: "height", body, stage, features: shapes.filter((shape) => shape.z.some((end) => Math.abs(end - z) < 1e-9 || Math.abs(end - heights[index - 1]!) < 1e-9)).map((shape) => shape.label).slice(0, 4), valueMm: r9(z - heights[index - 1]!), atMm: [0, 0, z], holes: [] });
        const lower = index === 0 ? under : between(heights[index - 1]!, z);
        const upper = index === heights.length - 1 ? over : between(z, heights[index + 1]!);
        for (const edge of mergePieces(boundaryPieces(shapes, lower, upper))) {
          if (edge.lengthMm >= limit - 1e-9) continue;
          const involved = edge.shapes.map((shape) => shapes[shape]!);
          findings.push({ kind: "edge", body, stage, features: involved.map((shape) => shape.label), valueMm: r9(edge.lengthMm), atMm: [r9(edge.atMm[0]), r9(edge.atMm[1]), z], holes: [...new Set(involved.flatMap((shape) => shape.holes))] });
        }
      });
    }
  }
  return findings;
}

// D1: the nearest input change that plans clean, for a refusal. The board holes that place the features involved are
// moved together, 0.05 mm at a time up to 1.5 mm, toward the board centre or toward the board edge, along x or along y;
// then standoffs.outerDiameterMm is tried 0.1 mm at a time up to 1 mm either way. The first trial that plans is named.
function nearestCleanChange(input: BoardCaseInput, culprits: number[], tryPlan: (trial: BoardCaseInput) => void): string {
  const holes = input.board.holes ?? [];
  const passes = (trial: BoardCaseInput): boolean => {
    try { tryPlan(trial); return true; } catch (error) { if (error instanceof BoardCaseValidationError || error instanceof UnsourcedFastenerValueError) return false; throw error; }
  };
  if (culprits.length > 0) {
    for (let step = 1; step <= 30; step += 1) {
      const by = r9(step * 0.05);
      for (const [axis, toward] of [[0, 1], [0, -1], [1, 1], [1, -1]] as const) {
        const size = axis === 0 ? input.board.lengthMm : input.board.widthMm;
        const moved = holes.map((hole, index) => {
          if (!culprits.includes(index)) return hole;
          const value = axis === 0 ? hole.xMm : hole.yMm;
          const next = r9(value + (value < size / 2 ? 1 : -1) * toward * by);
          return axis === 0 ? { ...hole, xMm: next } : { ...hole, yMm: next };
        });
        if (!passes({ ...input, board: { ...input.board, holes: moved } })) continue;
        const first = culprits[0]!;
        const others = culprits.slice(1).map((index) => `board.holes[${index}]`);
        return `move board.holes[${first}] ${by} mm toward the board ${toward === 1 ? "centre" : "edge"} along ${axis === 0 ? "x" : "y"} (to ${axis === 0 ? "xMm" : "yMm"} ${axis === 0 ? moved[first]!.xMm : moved[first]!.yMm})${others.length > 0 ? `, and ${others.join(", ")} the same way` : ""}: that plans clean`;
      }
    }
  }
  if (holes.length > 0) {
    const current = input.standoffs?.outerDiameterMm ?? Math.max(...(culprits.length > 0 ? culprits : holes.map((_, index) => index)).map((index) => holes[index]!.diameterMm + 3));
    for (let step = 1; step <= 10; step += 1) {
      for (const sign of [-1, 1]) {
        const outerDiameterMm = r9(current + sign * step * 0.1);
        if (outerDiameterMm > 0 && passes({ ...input, standoffs: { ...input.standoffs, outerDiameterMm } })) return `use standoffs.outerDiameterMm ${outerDiameterMm}: that plans clean`;
      }
    }
  }
  return "no board-hole move up to 1.5 mm and no standoffs.outerDiameterMm within 1 mm plans clean; change walls.wallMm, fit.boardClearanceMm or lid.fasteners.bossDiameterMm by at least 0.1 mm";
}

// The Undo steps the composition in BoardCaseRecipe.create takes for a plan, step for step (sub-recipe counts as the
// recipes report them). Renames are not counted: the bodies are created with their names.
export function countBoardCaseSteps(plan: Omit<BoardCasePlan, "name" | "derived">, exploded: number): number {
  const pattern = (count: number, single: number, perItem: number) => count === 1 ? single : perItem * count + 1;
  let steps = 1 + (plan.base.outerRadiusMm > 0 ? 1 : 0) + 1 + (plan.base.innerRadiusMm > 0 ? 1 : 0) + 1;
  if (plan.webSolids.length > 0) steps += plan.webSolids.reduce((sum, solid) => sum + (solid.box ? 1 : 2), 0) + 1;
  for (const group of plan.standoffGroups) steps += group.holeDiameterMm === 0 ? group.centersMm.length + 1 : group.centersMm.length === 1 ? 4 : 2 * group.centersMm.length + 2;
  if (plan.standoffFloorHoles) steps += pattern(plan.standoffFloorHoles.entryCentersMm.length, 2, 1);
  if (plan.taper) steps += 3 * plan.taper.cones.length + 1;
  if (plan.posts) steps += plan.posts.centersMm.length === 1 ? 4 : 2 * plan.posts.centersMm.length + 2;
  if (plan.lidWebSolids && plan.lidWebSolids.length > 0) steps += plan.lidWebSolids.reduce((sum, solid) => sum + (solid.box ? 1 : 2), 0) + 1;
  for (const group of plan.lidPosts ?? []) steps += group.centersMm.length === 1 ? 4 : 2 * group.centersMm.length + 2;
  const lid = plan.lid;
  steps += 1 + (lid.plateRadiusMm > 0 ? 1 : 0) + 1 + (lid.lipRadiusMm > 0 ? 1 : 0) + 1 + (lid.lipInnerRadiusMm > 0 ? 1 : 0) + lid.notches.length + 2;
  if (lid.holes) steps += lid.holes.countersink ? pattern(lid.holes.entryCentersMm.length, 4, 3) : pattern(lid.holes.entryCentersMm.length, 2, 1);
  for (const opening of plan.openings) steps += (opening.shape === "circle" ? 2 : opening.slot ? 5 : 3 + (opening.cornerRadiusMm > 0 ? 1 : 0)) + (opening.dropProfile ? 1 : 0);
  if (plan.vents) steps += pattern(plan.vents.entryCentersMm.length, 5, 4);
  if (plan.board) {
    steps += 1;
    for (const group of plan.board.holeGroups) steps += pattern(group.entryCentersMm.length, 2, 1);
  }
  // One delete for the construction Wires the cone, countersink, connector opening and slot recipes keep.
  if (plan.taper || lid.holes?.countersink || plan.openings.some((opening) => opening.shape !== "circle" && !opening.dropProfile) || plan.vents || [...plan.webSolids, ...(plan.lidWebSolids ?? [])].some((solid) => !solid.box)) steps += 1;
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

export type BoardCaseOperations = RecipeOperations & Pick<PlasticityOperations, "undo" | "remove" | "move" | "rename" | "createCone" | "validateBodies" | "measureSolidProperties"> & {
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
  // What the caller must not miss (W7): the board is not fastened by screws, or an opening is recessed more than 1 mm
  // behind the board edge. Each entry names the input that caused it and the change that gives a fastened stack.
  // Empty when there is nothing to warn about.
  warnings: string[];
  // The same warnings in one string, present only when there is one: a lean plasticity_batch step shows a recipe's
  // `warning` (and only lists the other keys as omitted).
  warning?: string;
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
  // Native volumes of the base and the lid against the volumes the plan predicts (within relativeTolerance); `note`
  // says why a body's volume is not predicted (it is then only measured).
  volumesMm3: { relativeTolerance: number; base: { measured: number; predicted?: number; note?: string }; lid: { measured: number; predicted?: number; note?: string } };
}

export class BoardCaseRecipeError extends Error {
  readonly failedStage: string;
  readonly completedSteps: BoardCaseStep[];
  readonly undoneSteps: number;
  readonly restored: boolean;
  readonly uncertain: boolean;
  readonly lastConfirmedRevision: string;

  constructor(details: { cause: unknown; failedStage: string; completedSteps: BoardCaseStep[]; undoneSteps: number; restored: boolean; uncertain: boolean; lastConfirmedRevision: string; restoreNote?: string; measuredSteps?: number }) {
    const raw = details.cause instanceof Error ? details.cause.message : String(details.cause);
    // A sub-recipe reports "partial geometry remains"; once the board case has undone everything, that is no longer true (D8).
    const detail = details.restored && !details.uncertain ? raw.replace(/partial geometry remains/g, "its partial geometry was undone with the rest") : raw;
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
    const sub = async (run: (revision: string) => Promise<SubRecipeResult>, targetId: number): Promise<SubRecipeResult> => {
      const before = current;
      const listedBefore = steps.length;
      try {
        const report = await run(current.revision);
        steps.push(...report.steps.map((entry) => ({ stage, operation: entry.operation, beforeRevision: entry.beforeRevision, afterRevision: entry.afterRevision, affectedBodyIds: entry.affectedBodyIds })));
        current = await ops.state();
        requireSameDocument(initial, current);
        if (current.revision !== report.afterRevision) throw new Error(`${stage}: the document moved on after the sub-recipe (${report.afterRevision} -> ${current.revision})`);
        if (report.resultBodyIds.length !== 1 || report.resultBodyIds[0] !== targetId) throw new Error(`${stage}: expected the sub-recipe to keep body ${targetId}, got ${report.resultBodyIds.join(", ")}`);
        return report;
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
    // Web solids: a box, or a closed profile (its Region found by its bounds) extruded up. Every solid is then proven
    // against its plan by its native volume (W1): a Region is picked by its bounds, and a foreign closed curve on the
    // profile's plane can notch or pierce it without moving them.
    const webBodies = async (solids: BoardCaseWebSolid[], word: string): Promise<number[]> => {
      const ids: number[] = [];
      const planned: Array<{ id: number; label: string; volumeMm3: number; how: string }> = [];
      for (const solid of solids) {
        if (solid.box) {
          const box = solid.box;
          const boxId = await create(`create-${word}-box`, (revision) => ops.createBox(box.originMm, box.sizeMm, undefined, revision));
          ids.push(boxId);
          planned.push({ id: boxId, label: solid.label, volumeMm3: box.sizeMm[0] * box.sizeMm[1] * box.sizeMm[2], how: `${r9(box.sizeMm[0])} x ${r9(box.sizeMm[1])} x ${r9(box.sizeMm[2])} mm` });
          continue;
        }
        const points = solid.loopMm.map((point) => [point[0], point[1], solid.bottomZMm] as Vector3);
        const profileId = await create(`create-${word}-profile`, (revision) => ops.createPolyline(points, true, revision), "Wire");
        const expected = { min: [Math.min(...points.map((point) => point[0])), Math.min(...points.map((point) => point[1]))], max: [Math.max(...points.map((point) => point[0])), Math.max(...points.map((point) => point[1]))] };
        const matching = current.regions.filter((region) => region.sketchWireIds.includes(profileId) && Math.abs(region.displayBoundsMm.min[0] - expected.min[0]!) <= 0.05 && Math.abs(region.displayBoundsMm.min[1] - expected.min[1]!) <= 0.05 && Math.abs(region.displayBoundsMm.max[0] - expected.max[0]!) <= 0.05 && Math.abs(region.displayBoundsMm.max[1] - expected.max[1]!) <= 0.05);
        if (matching.length !== 1) throw new Error(`${stage}: expected one Region for the web profile ${profileId}, found ${matching.length}`);
        const webId = await create(`extrude-${word}`, (revision) => ops.extrudeRegions([matching[0]!.id], solid.heightMm, revision));
        // A profile extrudes along its own plane normal. Prove it went up: the read-back cannot (a web that hangs under
        // the lip, or sinks into the floor, changes no body bounds).
        const bounds = current.bodies.find((body) => body.id === webId)?.boundsMm ?? null;
        const tolerance = BOARD_CASE_LIMITS.readBackToleranceMm;
        if (!bounds || Math.abs(bounds.min[2] - solid.bottomZMm) > tolerance || Math.abs(bounds.max[2] - (solid.bottomZMm + solid.heightMm)) > tolerance) {
          throw new Error(`${stage}: the web profile ${profileId} must extrude from z ${solid.bottomZMm} up to ${r9(solid.bottomZMm + solid.heightMm)}, but its solid ${bounds ? `spans z ${r9(bounds.min[2])} to ${r9(bounds.max[2])}` : "has no readable bounds"}`);
        }
        ids.push(webId);
        const area = loopAreaMm2(solid.loopMm);
        planned.push({ id: webId, label: solid.label, volumeMm3: area * solid.heightMm, how: `outline area ${r6(area)} mm2 x height ${r9(solid.heightMm)} mm` });
      }
      // One native read for all of them, before they are joined.
      if (planned.length > 0) {
        const measured = await ops.measureSolidProperties(planned.map((entry) => entry.id), current.revision);
        for (const entry of planned) {
          const actual = measured.bodies.find((body) => body.id === entry.id)?.volumeMm3;
          if (actual === undefined || !Number.isFinite(actual) || Math.abs(actual - entry.volumeMm3) > BOARD_CASE_LIMITS.volumeRelativeTolerance * entry.volumeMm3) {
            throw new Error(`${stage}: the web solid ${entry.id} (${entry.label}) has a volume of ${actual === undefined ? "unknown" : r6(actual)} mm3, not the planned ${r6(entry.volumeMm3)} mm3 (${entry.how}); another closed curve on the profile's plane changes its Region, so the web would be notched or pierced. Move or delete that curve`);
          }
        }
      }
      return ids;
    };

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

      // Webs that close narrow gaps (R4), joined before the standoffs and bosses so their holes are cut through them.
      if (plan.webSolids.length > 0) {
        stage = "webs";
        const webIds = await webBodies(plan.webSolids, "web");
        await native("join-webs", (revision) => ops.boolean([baseId], webIds, "union", false, revision), (_before, after) => { requireSolid(after, baseId, stage); requireAbsent(after, webIds, stage); return [baseId]; });
      }

      // Standoffs under the board holes.
      stage = "standoffs";
      for (const group of plan.standoffGroups) {
        if (group.holeDiameterMm > 0) { await sub((revision) => bossPattern(recipes, baseId, group, revision), baseId); continue; }
        // Support posts (D2): plain cylinders from overlap below the floor top to the standoff top, joined in one step.
        const postIds: number[] = [];
        for (const center of group.centersMm) postIds.push(await create("create-support-post", (revision) => ops.createCylinder([center[0], center[1], r9(center[2] - group.baseOverlapMm)], group.outerDiameterMm / 2, r9(group.heightMm + group.baseOverlapMm), undefined, revision, [0, 0, 1])));
        await native("join-support-posts", (revision) => ops.boolean([baseId], postIds, "union", false, revision), (_before, after) => { requireSolid(after, baseId, stage); requireAbsent(after, postIds, stage); return [baseId]; });
      }
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
      // Stack: lid webs (R4, the lip's height), then the posts hanging from the plate with their screw clearance holes.
      if (plan.lidWebSolids && plan.lidWebSolids.length > 0) {
        stage = "lid-webs";
        const webIds = await webBodies(plan.lidWebSolids, "lid-web");
        await native("join-lid-webs", (revision) => ops.boolean([lidId], webIds, "union", false, revision), (_before, after) => { requireSolid(after, lidId, stage); requireAbsent(after, webIds, stage); return [lidId]; });
      }
      if (plan.lidPosts) {
        stage = "lid-posts";
        for (const group of plan.lidPosts) await sub((revision) => bossPattern(recipes, lidId, group, revision, [0, 0, -1]), lidId);
      }
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
        const heightDirection: Vector3 = [opening.axis[1] * opening.widthDirection[2] - opening.axis[2] * opening.widthDirection[1], opening.axis[2] * opening.widthDirection[0] - opening.axis[0] * opening.widthDirection[2], opening.axis[0] * opening.widthDirection[1] - opening.axis[1] * opening.widthDirection[0]];
        const report = await sub((revision) => opening.shape === "circle"
          ? recipes.createThroughHole({ targetId, entryCenterMm: opening.entryCenterMm, axis: opening.axis, holeDiameterMm: opening.widthMm, throughDepthMm: opening.throughDepthMm, overshootMm: BOARD_CASE_CONSTANTS.overshootMm, revision })
          : opening.slot
            // Radius = half the shorter side: a slot along the longer side.
            ? recipes.createSlottedHole({ targetId, entryCenterMm: opening.entryCenterMm, axis: opening.axis, slotDirection: opening.widthMm >= opening.heightMm ? opening.widthDirection : heightDirection.map((value) => Math.abs(value) < 1e-12 ? 0 : value) as Vector3, overallLengthMm: Math.max(opening.widthMm, opening.heightMm), widthMm: Math.min(opening.widthMm, opening.heightMm), throughDepthMm: opening.throughDepthMm, overshootMm: BOARD_CASE_CONSTANTS.overshootMm, revision })
            : recipes.createConnectorOpening({ targetId, entryCenterMm: opening.entryCenterMm, axis: opening.axis, widthDirection: opening.widthDirection, widthMm: opening.widthMm, heightMm: opening.heightMm, cornerRadiusMm: opening.cornerRadiusMm, throughDepthMm: opening.throughDepthMm, overshootMm: BOARD_CASE_CONSTANTS.overshootMm, revision }), targetId);
        if (opening.dropProfile) {
          // Another profile cut follows on this face: remove this profile Wire now (see OpeningCut.dropProfile).
          const profileId = (report as { profileBodyId?: number }).profileBodyId ?? addedIds(initial, current, "Wire").at(-1);
          if (profileId === undefined) throw new Error(`${stage}: the opening profile Wire is missing`);
          await native("delete-opening-profile", (revision) => ops.remove([profileId], revision), (_before, after) => { requireAbsent(after, [profileId], stage); return [profileId]; });
        }
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
        warnings: plan.warnings,
        ...(plan.warnings.length > 0 ? { warning: plan.warnings.map((entry, index) => plan.warnings.length > 1 ? `(${index + 1}) ${entry}` : entry).join(" ") } : {}),
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
    // Whole-result proof (W1): the native volumes of the base and the lid equal the volumes the plan predicts.
    const predicted = boardCaseVolumes(plan);
    const properties = await this.operations.measureSolidProperties([baseId, lidId], state.revision);
    const volumeOf = (id: number, label: string, expected: number | undefined, note: string | undefined): BoardCaseReadBack["volumesMm3"]["base"] => {
      const measured = properties.bodies.find((body) => body.id === id)?.volumeMm3;
      if (measured === undefined || !Number.isFinite(measured)) { problems.push(`the ${label} volume could not be read`); return { measured: Number.NaN, ...(note ? { note } : {}) }; }
      if (expected !== undefined && Math.abs(measured - expected) > BOARD_CASE_LIMITS.volumeRelativeTolerance * expected) problems.push(`the ${label} volume ${r6(measured)} mm3 differs from the planned ${r6(expected)} mm3 by ${r6(measured - expected)} mm3 (material is missing or extra somewhere in the body)`);
      return { measured: r6(measured), ...(expected !== undefined ? { predicted: expected } : {}), ...(note ? { note } : {}) };
    };
    const volumesMm3 = { relativeTolerance: BOARD_CASE_LIMITS.volumeRelativeTolerance, base: volumeOf(baseId, "base", predicted.baseMm3, predicted.baseNote), lid: volumeOf(lidId, "lid", predicted.lidMm3, predicted.lidNote) };
    if (problems.length > 0) throw new Error(`read-back: ${problems.slice(0, 6).join("; ")}${problems.length > 6 ? `; and ${problems.length - 6} more` : ""}`);
    return {
      toleranceMm: tolerance,
      baseBoundsMm: baseBoundsMm!,
      lidBoundsMm: lidBoundsMm!,
      ...(boardBoundsMm ? { boardBoundsMm } : {}),
      bodies,
      minEdgeMm: r9(minEdgeMm),
      volumesMm3,
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

function bossPattern(recipes: PlasticityRecipes, targetId: number, pattern: CylinderPattern, revision: string, axis: Vector3 = [0, 0, 1]): Promise<SubRecipeResult> {
  const shared = { targetId, axis, outerDiameterMm: pattern.outerDiameterMm, heightMm: pattern.heightMm, holeDiameterMm: pattern.holeDiameterMm, holeDepthMm: pattern.holeDepthMm, baseOverlapMm: pattern.baseOverlapMm, cutterOvershootMm: BOARD_CASE_CONSTANTS.overshootMm, revision };
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

// Does a polygon overlap an axis-aligned rectangle (more than touching it)?
function polygonHitsRect(polygon: PlanShape, corners: Vector2[], rect: Rect): boolean {
  const box = polygon.box;
  if (box && (rect.min[0] >= box[2] || rect.max[0] <= box[0] || rect.min[1] >= box[3] || rect.max[1] <= box[1])) return false;
  if (corners.some((point) => polygon.sdf(point) < -EPS)) return true;
  const inside = (point: Vector2) => point[0] > rect.min[0] + EPS && point[0] < rect.max[0] - EPS && point[1] > rect.min[1] + EPS && point[1] < rect.max[1] - EPS;
  for (const curve of polygon.curves) {
    if (curve.kind !== "seg") continue;
    if (inside(curve.a) || inside([(curve.a[0] + curve.b[0]) / 2, (curve.a[1] + curve.b[1]) / 2])) return true;
    // An edge that crosses the rectangle has a point inside it between its crossings of the rectangle's side lines.
    const cuts = [0, 1];
    for (const axis of [0, 1] as const) for (const value of [rect.min[axis], rect.max[axis]]) { const span = curve.b[axis] - curve.a[axis]; if (Math.abs(span) > EPS) { const t = (value - curve.a[axis]) / span; if (t > 0 && t < 1) cuts.push(t); } }
    cuts.sort((left, right) => left - right);
    for (let index = 0; index + 1 < cuts.length; index += 1) { const t = (cuts[index]! + cuts[index + 1]!) / 2; if (inside([curve.a[0] + (curve.b[0] - curve.a[0]) * t, curve.a[1] + (curve.b[1] - curve.a[1]) * t])) return true; }
  }
  return false;
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

// The solids that build a set of web polygons: per height range, the plan-view union of every polygon that spans the
// range, one solid per outline loop. Profiles of different ranges that start at one height are staggered by 0.1 mm
// (inside the floor), so they never share a sketch plane.
function planWebSolids(parts: Array<{ label: string; polygon: Vector2[]; z: Vector2; holes: number[] }>, stagger: number, clip?: Rect): BoardCaseWebSolid[] {
  const ranges: Vector2[] = [];
  for (const part of parts) if (!ranges.some((range) => Math.abs(range[0] - part.z[0]) < EPS && Math.abs(range[1] - part.z[1]) < EPS)) ranges.push(part.z);
  ranges.sort((left, right) => left[1] - right[1] || left[0] - right[0]);
  const solids: BoardCaseWebSolid[] = [];
  const started = new Map<number, number>();
  for (const range of ranges) {
    const members = parts.filter((part) => part.z[0] <= range[0] + EPS && part.z[1] >= range[1] - EPS);
    const key = r9(range[0]);
    const shift = (started.get(key) ?? 0) * 0.1;
    if (shift >= stagger - EPS) throw new BoardCaseValidationError("the webs that close the narrow gaps have more than five height ranges");
    let profiles = false;
    for (const loop of unionLoops(members.map((part) => part.polygon), clip)) {
      const shape = polygonPlanShape("loop", loop, range, []);
      const inLoop = members.filter((part) => shape.sdf([part.polygon.reduce((sum, point) => sum + point[0], 0) / part.polygon.length, part.polygon.reduce((sum, point) => sum + point[1], 0) / part.polygon.length]) < 1e-6);
      const holes = [...new Set(inLoop.flatMap((part) => part.holes))].sort((left, right) => left - right);
      const names = [...new Set(inLoop.map((part) => part.label))];
      const label = names.length > 3 ? `${names.slice(0, 3).join("; ")}; and ${names.length - 3} more` : names.join("; ");
      const xs = loop.map((point) => point[0]);
      const ys = loop.map((point) => point[1]);
      const min: Vector2 = [Math.min(...xs), Math.min(...ys)];
      const max: Vector2 = [Math.max(...xs), Math.max(...ys)];
      const rectangle = loop.length === 4 && loop.every((point) => (Math.abs(point[0] - min[0]) < 1e-9 || Math.abs(point[0] - max[0]) < 1e-9) && (Math.abs(point[1] - min[1]) < 1e-9 || Math.abs(point[1] - max[1]) < 1e-9));
      // Plasticity takes a closed profile's plane normal from the corner at its first point (last point, first point,
      // second point: live-verified), and extrudes along it. The profile therefore starts at a convex corner, so the
      // normal points up; where it can, the next corner is convex too (first three points counter-clockwise as well).
      const count = loop.length;
      const turn = (index: number) => { const a = loop[(index + count - 1) % count]!; const b = loop[index % count]!; const c = loop[(index + 1) % count]!; return ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) / (Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1])); };
      const score = (index: number) => (turn(index) > 1e-6 && turn(index + 1) > 1e-6 ? 2 + Math.min(turn(index), turn(index + 1)) : turn(index));
      const startAt = loop.map((_, index) => index).reduce((best, index) => (score(index) > score(best) + 1e-12 ? index : best), 0);
      const loopMm = loop.map((_, index) => loop[(startAt + index) % count]!).map((point) => [r9(point[0]), r9(point[1])] as Vector2);
      if (rectangle) solids.push({ label, loopMm, box: { originMm: [r9(min[0]), r9(min[1]), r9(range[0])], sizeMm: [r9(max[0] - min[0]), r9(max[1] - min[1]), r9(range[1] - range[0])] }, bottomZMm: r9(range[0]), heightMm: r9(range[1] - range[0]), holes });
      else { profiles = true; solids.push({ label, loopMm, bottomZMm: r9(range[0] + shift), heightMm: r9(range[1] - range[0] - shift), holes }); }
    }
    if (profiles) started.set(key, (started.get(key) ?? 0) + 1);
  }
  return solids;
}

// ---------------------------------------------------------------------------------------------------------------------
// Plan-view outline engine (D1). Every base and lid feature is a vertical prism, so the built body is, between two
// heights, the plan-view union of the features that exist there. The engine works on that union exactly (lines and
// circular arcs): it joins the web polygons into loops, predicts the length of every horizontal edge the kernel will
// build, and measures the signed gap of every pair of features.
// ---------------------------------------------------------------------------------------------------------------------

// A boundary curve. Material lies on the left of a segment's direction; an arc runs counter-clockwise from a0 to a1 and
// bounds a disc (solid) or a round hole in material (not solid: a rounded cavity corner).
type Curve2 = { kind: "seg"; a: Vector2; b: Vector2 } | { kind: "arc"; c: Vector2; r: number; a0: number; a1: number; solid: boolean };

export interface PlanShape {
  label: string;
  kind: "wall" | "lip" | "circle" | "web";
  // The height range the feature exists over.
  z: Vector2;
  // The board holes whose position places this feature (for the refusal's fix).
  holes: number[];
  curves: Curve2[];
  // Signed distance to the feature's boundary, negative inside its material.
  sdf: (point: Vector2) => number;
  // A circle's or a web's bounding box (its material lies inside it); a wall or a lip has none.
  box?: [number, number, number, number];
}

const OUTLINE_TOL = 1e-9;
// Two carriers that come this close to tangent touch in one point (the webs' sides are tangent to their circles by
// construction, exact to about 1e-9 after rounding; a real near-tangent pair is the pair rule's business).
const TANGENT_TOL = 1e-7;
// Points this close are one vertex, and no piece of curve is shorter (far under the kernel's own resolution).
const VERTEX_TOL = 2e-6;
const TAU = 2 * Math.PI;

function curveLength(curve: Curve2): number {
  return curve.kind === "seg" ? Math.hypot(curve.b[0] - curve.a[0], curve.b[1] - curve.a[1]) : curve.r * (curve.a1 - curve.a0);
}

function curvePoint(curve: Curve2, t: number): Vector2 {
  return curve.kind === "seg"
    ? [curve.a[0] + (curve.b[0] - curve.a[0]) * t, curve.a[1] + (curve.b[1] - curve.a[1]) * t]
    : [curve.c[0] + curve.r * Math.cos(t), curve.c[1] + curve.r * Math.sin(t)];
}

// Unit normal pointing away from the material.
function curveNormal(curve: Curve2, t: number): Vector2 {
  if (curve.kind === "seg") {
    const length = curveLength(curve);
    return [(curve.b[1] - curve.a[1]) / length, -(curve.b[0] - curve.a[0]) / length];
  }
  const sign = curve.solid ? 1 : -1;
  return [sign * Math.cos(t), sign * Math.sin(t)];
}

// The curve parameter of a point known to lie on the curve's carrier (line or circle), or undefined outside its extent.
function curveParam(curve: Curve2, point: Vector2): number | undefined {
  if (curve.kind === "seg") {
    const vx = curve.b[0] - curve.a[0];
    const vy = curve.b[1] - curve.a[1];
    const squared = vx * vx + vy * vy;
    const t = ((point[0] - curve.a[0]) * vx + (point[1] - curve.a[1]) * vy) / squared;
    const slack = VERTEX_TOL / Math.sqrt(squared);
    return t < -slack || t > 1 + slack ? undefined : Math.max(0, Math.min(1, t));
  }
  const slack = VERTEX_TOL / curve.r;
  let angle = Math.atan2(point[1] - curve.c[1], point[0] - curve.c[0]);
  while (angle < curve.a0 - slack) angle += TAU;
  while (angle > curve.a0 - slack + TAU) angle -= TAU;
  return angle > curve.a1 + slack ? undefined : Math.max(curve.a0, Math.min(curve.a1, angle));
}

// Where two curves' carriers meet (candidates: each is then tested against both extents).
function carrierIntersections(first: Curve2, second: Curve2): Vector2[] {
  if (first.kind === "seg" && second.kind === "seg") {
    const r: Vector2 = [first.b[0] - first.a[0], first.b[1] - first.a[1]];
    const s: Vector2 = [second.b[0] - second.a[0], second.b[1] - second.a[1]];
    const q: Vector2 = [second.a[0] - first.a[0], second.a[1] - first.a[1]];
    const cross = r[0] * s[1] - r[1] * s[0];
    const lengths = Math.hypot(r[0], r[1]) * Math.hypot(s[0], s[1]);
    if (Math.abs(cross) > 1e-12 * lengths) {
      const t = (q[0] * s[1] - q[1] * s[0]) / cross;
      return [[first.a[0] + r[0] * t, first.a[1] + r[1] * t]];
    }
    // Parallel: collinear segments split each other at their end points.
    if (Math.abs(q[0] * r[1] - q[1] * r[0]) / Math.hypot(r[0], r[1]) > OUTLINE_TOL) return [];
    return [first.a, first.b, second.a, second.b];
  }
  if (first.kind === "arc" && second.kind === "arc") {
    const dx = second.c[0] - first.c[0];
    const dy = second.c[1] - first.c[1];
    const distance = Math.hypot(dx, dy);
    if (distance < OUTLINE_TOL && Math.abs(first.r - second.r) < OUTLINE_TOL) return [curvePoint(first, first.a0), curvePoint(first, first.a1), curvePoint(second, second.a0), curvePoint(second, second.a1)];
    if (distance < OUTLINE_TOL || distance > first.r + second.r + TANGENT_TOL || distance < Math.abs(first.r - second.r) - TANGENT_TOL) return [];
    const along = (distance * distance + first.r * first.r - second.r * second.r) / (2 * distance);
    const squared = first.r * first.r - along * along;
    const foot: Vector2 = [first.c[0] + (dx * along) / distance, first.c[1] + (dy * along) / distance];
    if (squared <= 2 * first.r * TANGENT_TOL) return [[first.c[0] + (dx * first.r) / distance * Math.sign(along || 1), first.c[1] + (dy * first.r) / distance * Math.sign(along || 1)]];
    const half = Math.sqrt(squared);
    return [[foot[0] - (dy * half) / distance, foot[1] + (dx * half) / distance], [foot[0] + (dy * half) / distance, foot[1] - (dx * half) / distance]];
  }
  const line = (first.kind === "seg" ? first : second) as Extract<Curve2, { kind: "seg" }>;
  const circle = (first.kind === "arc" ? first : second) as Extract<Curve2, { kind: "arc" }>;
  const vx = line.b[0] - line.a[0];
  const vy = line.b[1] - line.a[1];
  const length = Math.hypot(vx, vy);
  const ux = vx / length;
  const uy = vy / length;
  const along = (circle.c[0] - line.a[0]) * ux + (circle.c[1] - line.a[1]) * uy;
  const foot: Vector2 = [line.a[0] + ux * along, line.a[1] + uy * along];
  const offset = Math.hypot(circle.c[0] - foot[0], circle.c[1] - foot[1]);
  if (offset > circle.r + TANGENT_TOL) return [];
  if (offset > circle.r - TANGENT_TOL) return [[circle.c[0] + ((foot[0] - circle.c[0]) * circle.r) / offset, circle.c[1] + ((foot[1] - circle.c[1]) * circle.r) / offset]];
  const half = Math.sqrt(circle.r * circle.r - offset * offset);
  return [[foot[0] - ux * half, foot[1] - uy * half], [foot[0] + ux * half, foot[1] + uy * half]];
}

interface OutlinePiece { shape: number; curve: Curve2; t0: number; t1: number; p0: Vector2; p1: Vector2; mid: Vector2; normal: Vector2; length: number }

// Every curve of the given shapes, cut at every point where a curve of another shape meets it.
function arrangeCurves(shapes: PlanShape[], use: number[]): OutlinePiece[] {
  // A curve's box (an arc's is its whole circle's), grown by the vertex tolerance.
  const boxOf = (curve: Curve2): [number, number, number, number] => curve.kind === "seg"
    ? [Math.min(curve.a[0], curve.b[0]) - VERTEX_TOL, Math.min(curve.a[1], curve.b[1]) - VERTEX_TOL, Math.max(curve.a[0], curve.b[0]) + VERTEX_TOL, Math.max(curve.a[1], curve.b[1]) + VERTEX_TOL]
    : [curve.c[0] - curve.r - VERTEX_TOL, curve.c[1] - curve.r - VERTEX_TOL, curve.c[0] + curve.r + VERTEX_TOL, curve.c[1] + curve.r + VERTEX_TOL];
  const curves = use.flatMap((shape) => shapes[shape]!.curves.map((curve) => ({ shape, curve, box: boxOf(curve), cuts: curve.kind === "seg" ? [0, 1] : [curve.a0, curve.a1] })));
  for (let i = 0; i < curves.length; i += 1) {
    for (let j = i + 1; j < curves.length; j += 1) {
      const a = curves[i]!;
      const b = curves[j]!;
      if (a.shape === b.shape) continue;
      if (a.box[0] > b.box[2] || b.box[0] > a.box[2] || a.box[1] > b.box[3] || b.box[1] > a.box[3]) continue;
      for (const point of carrierIntersections(a.curve, b.curve)) {
        const ta = curveParam(a.curve, point);
        const tb = curveParam(b.curve, point);
        if (ta === undefined || tb === undefined) continue;
        // A candidate from a collinear or co-circular pair must lie on both carriers (it always does otherwise).
        if (Math.hypot(curvePoint(a.curve, ta)[0] - point[0], curvePoint(a.curve, ta)[1] - point[1]) > VERTEX_TOL || Math.hypot(curvePoint(b.curve, tb)[0] - point[0], curvePoint(b.curve, tb)[1] - point[1]) > VERTEX_TOL) continue;
        a.cuts.push(ta);
        b.cuts.push(tb);
      }
    }
  }
  const pieces: OutlinePiece[] = [];
  for (const { shape, curve, cuts } of curves) {
    const scale = curve.kind === "seg" ? curveLength(curve) : curve.r;
    const sorted = [...cuts].sort((left, right) => left - right);
    for (let index = 0; index + 1 < sorted.length; index += 1) {
      const t0 = sorted[index]!;
      const t1 = sorted[index + 1]!;
      const length = (t1 - t0) * scale;
      if (length < VERTEX_TOL) continue;
      const middle = (t0 + t1) / 2;
      pieces.push({ shape, curve, t0, t1, p0: curvePoint(curve, t0), p1: curvePoint(curve, t1), mid: curvePoint(curve, middle), normal: curveNormal(curve, middle), length });
    }
  }
  return pieces;
}

type PlanRegion = number[] | "solid" | "empty";
const OUTLINE_STEP = 1e-6;

function inRegion(shapes: PlanShape[], region: PlanRegion, point: Vector2): boolean {
  if (region === "solid") return true;
  if (region === "empty") return false;
  for (const index of region) {
    const shape = shapes[index]!;
    const box = shape.box;
    if (box && (point[0] < box[0] || point[0] > box[2] || point[1] < box[1] || point[1] > box[3])) continue;
    if (shape.sdf(point) < 0) return true;
  }
  return false;
}

// The pieces of curve that bound a plan-view region: at a height where the material below is `lower` and the material
// above is `upper`, the horizontal faces are the points in exactly one of the two, and these pieces are their edges.
// With `lower` empty and `upper` a set, they are that set's union outline.
function boundaryPieces(shapes: PlanShape[], lower: PlanRegion, upper: PlanRegion): OutlinePiece[] {
  const use = [...new Set([...(Array.isArray(lower) ? lower : []), ...(Array.isArray(upper) ? upper : [])])];
  return regionBoundary(shapes, use, (point: Vector2) => inRegion(shapes, lower, point) !== inRegion(shapes, upper, point));
}

// The pieces of the given shapes' curves that bound the region `face` describes.
function regionBoundary(shapes: PlanShape[], use: number[], face: (point: Vector2) => boolean): OutlinePiece[] {
  const kept: OutlinePiece[] = [];
  for (const piece of arrangeCurves(shapes, use)) {
    const inner: Vector2 = [piece.mid[0] - piece.normal[0] * OUTLINE_STEP, piece.mid[1] - piece.normal[1] * OUTLINE_STEP];
    const outer: Vector2 = [piece.mid[0] + piece.normal[0] * OUTLINE_STEP, piece.mid[1] + piece.normal[1] * OUTLINE_STEP];
    if (face(inner) === face(outer)) continue;
    // Two features with a shared face give the same piece twice.
    const near = (a: Vector2, b: Vector2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 2 * VERTEX_TOL;
    if (kept.some((other) => other.curve.kind === piece.curve.kind && near(other.mid, piece.mid) && ((near(other.p0, piece.p0) && near(other.p1, piece.p1)) || (near(other.p0, piece.p1) && near(other.p1, piece.p0))))) continue;
    kept.push(piece);
  }
  return kept;
}

function sameCarrier(first: Curve2, second: Curve2): boolean {
  if (first.kind === "arc" && second.kind === "arc") return Math.hypot(first.c[0] - second.c[0], first.c[1] - second.c[1]) < 1e-7 && Math.abs(first.r - second.r) < 1e-7;
  if (first.kind !== "seg" || second.kind !== "seg") return false;
  const r: Vector2 = [first.b[0] - first.a[0], first.b[1] - first.a[1]];
  const s: Vector2 = [second.b[0] - second.a[0], second.b[1] - second.a[1]];
  const length = Math.hypot(r[0], r[1]);
  return Math.abs(r[0] * s[1] - r[1] * s[0]) < 1e-9 * length * Math.hypot(s[0], s[1]) && Math.abs((second.a[0] - first.a[0]) * r[1] - (second.a[1] - first.a[1]) * r[0]) / length < 1e-7;
}

export interface PlanEdge { lengthMm: number; atMm: Vector2; shapes: number[] }

// The edges those pieces make: pieces of one line or circle that meet end to end with nothing else at the joint are one edge.
function mergePieces(pieces: OutlinePiece[]): PlanEdge[] {
  const ends: Array<{ piece: number; point: Vector2 }> = [];
  pieces.forEach((piece, index) => { ends.push({ piece: index, point: piece.p0 }, { piece: index, point: piece.p1 }); });
  const cluster = ends.map((_, index) => index);
  const find = (index: number): number => (cluster[index] === index ? index : (cluster[index] = find(cluster[index]!)));
  for (let i = 0; i < ends.length; i += 1) for (let j = i + 1; j < ends.length; j += 1) if (Math.hypot(ends[i]!.point[0] - ends[j]!.point[0], ends[i]!.point[1] - ends[j]!.point[1]) < 2 * VERTEX_TOL) cluster[find(i)] = find(j);
  const joints = new Map<number, number[]>();
  ends.forEach((end, index) => { const root = find(index); joints.set(root, [...(joints.get(root) ?? []), end.piece]); });
  const group = pieces.map((_, index) => index);
  const top = (index: number): number => (group[index] === index ? index : (group[index] = top(group[index]!)));
  const neighbours = pieces.map(() => new Set<number>());
  for (const members of joints.values()) {
    for (const member of members) for (const other of members) neighbours[member]!.add(pieces[other]!.shape);
    if (members.length === 2 && members[0] !== members[1] && sameCarrier(pieces[members[0]!]!.curve, pieces[members[1]!]!.curve)) group[top(members[0]!)] = top(members[1]!);
  }
  const edges = new Map<number, PlanEdge>();
  pieces.forEach((piece, index) => {
    const root = top(index);
    const edge = edges.get(root) ?? { lengthMm: 0, atMm: piece.mid, shapes: [] };
    edge.lengthMm += piece.length;
    edge.shapes = [...new Set([...edge.shapes, ...neighbours[index]!])];
    edges.set(root, edge);
  });
  return [...edges.values()];
}

// Join polygons into the outline loops of their union (counter-clockwise outer loops), cut off at a clip rectangle when
// one is given. Throws when the union has a pinch point or a hole, which the plan refuses.
function unionLoops(polygons: Vector2[][], clip?: Rect): Vector2[][] {
  const shapes = polygons.map((points, index) => polygonPlanShape(`polygon ${index}`, points, [0, 1], []));
  const members = shapes.length;
  if (clip) shapes.push(polygonPlanShape("clip", [[clip.min[0], clip.min[1]], [clip.max[0], clip.min[1]], [clip.max[0], clip.max[1]], [clip.min[0], clip.max[1]]], [0, 1], []));
  const pieces = regionBoundary(shapes, shapes.map((_, index) => index), (point) => (!clip || shapes[members]!.sdf(point) < 0) && shapes.some((shape, index) => index < members && shape.sdf(point) < 0));
  const loops: Vector2[][] = [];
  const used = pieces.map(() => false);
  for (let start = 0; start < pieces.length; start += 1) {
    if (used[start]) continue;
    const loop: Vector2[] = [];
    let current = start;
    for (let guard = 0; guard <= pieces.length; guard += 1) {
      used[current] = true;
      loop.push(pieces[current]!.p0);
      const end = pieces[current]!.p1;
      if (Math.hypot(end[0] - pieces[start]!.p0[0], end[1] - pieces[start]!.p0[1]) < 2 * VERTEX_TOL) break;
      const next = pieces.map((_, index) => index).filter((index) => !used[index] && Math.hypot(pieces[index]!.p0[0] - end[0], pieces[index]!.p0[1] - end[1]) < 2 * VERTEX_TOL);
      if (next.length !== 1) throw new WebPinchError("the webs that close the narrow gaps touch at a single point, which cannot be built as one solid");
      current = next[0]!;
    }
    // Drop the vertices that lie on a straight run.
    const corners = loop.filter((point, index) => {
      const before = loop[(index + loop.length - 1) % loop.length]!;
      const after = loop[(index + 1) % loop.length]!;
      const ax = point[0] - before[0];
      const ay = point[1] - before[1];
      const bx = after[0] - point[0];
      const by = after[1] - point[1];
      return Math.abs(ax * by - ay * bx) > 1e-9 * Math.hypot(ax, ay) * Math.hypot(bx, by);
    });
    const area = corners.reduce((sum, point, index) => { const after = corners[(index + 1) % corners.length]!; return sum + point[0] * after[1] - after[0] * point[1]; }, 0) / 2;
    if (area <= 0 || corners.length < 3) throw new BoardCaseValidationError("the webs that close the narrow gaps enclose a pocket, which cannot be built as one solid");
    loops.push(corners);
  }
  return loops;
}

function polygonPlanShape(label: string, points: Vector2[], z: Vector2, holes: number[]): PlanShape {
  const count = points.length;
  const sdf = (p: Vector2): number => {
    let inside = false;
    let least = Infinity;
    for (let index = 0; index < count; index += 1) {
      const a = points[index]!;
      const b = points[index + 1 === count ? 0 : index + 1]!;
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
      const vx = b[0] - a[0];
      const vy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / (vx * vx + vy * vy)));
      const dx = p[0] - a[0] - t * vx;
      const dy = p[1] - a[1] - t * vy;
      const squared = dx * dx + dy * dy;
      if (squared < least) least = squared;
    }
    return (inside ? -1 : 1) * Math.sqrt(least);
  };
  const box: [number, number, number, number] = [Math.min(...points.map((point) => point[0])), Math.min(...points.map((point) => point[1])), Math.max(...points.map((point) => point[0])), Math.max(...points.map((point) => point[1]))];
  return { label, kind: "web", z, holes, curves: points.map((point, index) => ({ kind: "seg", a: point, b: points[(index + 1) % count]! })), sdf, box };
}

function circlePlanShape(label: string, center: Vector2, radius: number, z: Vector2, holes: number[]): PlanShape {
  return { label, kind: "circle", z, holes, curves: [{ kind: "arc", c: center, r: radius, a0: 0, a1: TAU, solid: true }], sdf: (p) => Math.hypot(p[0] - center[0], p[1] - center[1]) - radius, box: [center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius] };
}

// The curves of a rounded rectangle, with the material inside it or outside it.
function roundedRectCurves(rect: Rect, radius: number, materialInside: boolean): Curve2[] {
  const rho = Math.max(0, Math.min(radius, (rect.max[0] - rect.min[0]) / 2, (rect.max[1] - rect.min[1]) / 2));
  const [x0, y0] = rect.min;
  const [x1, y1] = rect.max;
  // Counter-clockwise: bottom, right, top, left.
  const sides: Array<[Vector2, Vector2]> = [[[x0 + rho, y0], [x1 - rho, y0]], [[x1, y0 + rho], [x1, y1 - rho]], [[x1 - rho, y1], [x0 + rho, y1]], [[x0, y1 - rho], [x0, y0 + rho]]];
  const curves: Curve2[] = sides.filter(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]) > OUTLINE_TOL).map(([a, b]) => (materialInside ? { kind: "seg", a, b } : { kind: "seg", a: b, b: a }));
  if (rho > 0) {
    const centres: Array<[Vector2, number]> = [[[x0 + rho, y0 + rho], Math.PI], [[x1 - rho, y0 + rho], 1.5 * Math.PI], [[x1 - rho, y1 - rho], 0], [[x0 + rho, y1 - rho], 0.5 * Math.PI]];
    for (const [c, a0] of centres) curves.push({ kind: "arc", c, r: rho, a0, a1: a0 + Math.PI / 2, solid: materialInside });
  }
  return curves;
}

// ---------------------------------------------------------------------------------------------- predicted volumes (W1)
// The volume of the finished base and lid, from the plan alone, for the read-back's whole-result proof. The build is a
// sequence of joins and cuts of upright prisms (rounded boxes, cylinders, web outlines), so at every height the body's
// plan-view section is the same sequence applied to their outlines; its area comes from the exact line and arc outline
// engine above, and the volume is the sum over the height bands. Cutters that are not upright prisms (a round or
// rounded opening or vent slot through a wall, a countersink cone) are added in closed form after a check that only
// full material lies in their path (the same sweep with the cutter's bounding prism must remove exactly that prism).
// Not predicted: the base of bossStyle "tapered" (the clipped gusset cones) and a cutter whose path is not full material.
interface VolumePrism { shape: PlanShape; z0: number; z1: number }
interface VolumeStep { op: "union" | "difference"; solid: VolumePrism; minus?: VolumePrism[] }
interface VolumeExtra { label: string; bound: VolumePrism; boundMm3: number; cutMm3: number }

export interface BoardCaseVolumePrediction {
  // Predicted volume in mm3; absent when the plan cannot predict it exactly (`note` says why).
  baseMm3?: number;
  lidMm3?: number;
  baseNote?: string;
  lidNote?: string;
}

const rectPrism = (min: Vector2, max: Vector2, radius: number, z0: number, z1: number): VolumePrism => {
  const rect: Rect = { min, max };
  return { shape: { label: "", kind: "wall", z: [z0, z1], holes: [], curves: roundedRectCurves(rect, radius, true), sdf: (p) => -roundedRectInsideDistance(p, rect, radius), box: [min[0], min[1], max[0], max[1]] }, z0, z1 };
};
const boxPrism = (origin: Vector3, size: Vector3, radius = 0): VolumePrism => rectPrism([origin[0], origin[1]], [origin[0] + size[0], origin[1] + size[1]], radius, origin[2], origin[2] + size[2]);
const cylinderPrism = (center: Vector2 | Vector3, radius: number, z0: number, z1: number): VolumePrism => ({ shape: circlePlanShape("", [center[0], center[1]], radius, [z0, z1], []), z0, z1 });

// The volume of a sequence of prism joins and cuts (a cut's `minus` prisms are taken out of the solid before it is joined).
function prismSequenceVolume(steps: VolumeStep[]): number {
  const prisms = steps.flatMap((step) => [step.solid, ...(step.minus ?? [])]);
  const shapes = prisms.map((prism) => prism.shape);
  const indexOf = new Map(prisms.map((prism, index) => [prism, index] as const));
  const levels = [...new Set(prisms.flatMap((prism) => [r9(prism.z0), r9(prism.z1)]))].sort((left, right) => left - right);
  const has = (prism: VolumePrism, point: Vector2): boolean => {
    const box = prism.shape.box;
    if (box && (point[0] < box[0] || point[0] > box[2] || point[1] < box[1] || point[1] > box[3])) return false;
    return prism.shape.sdf(point) < 0;
  };
  let volume = 0;
  for (let level = 0; level + 1 < levels.length; level += 1) {
    const height = levels[level + 1]! - levels[level]!;
    const z = (levels[level]! + levels[level + 1]!) / 2;
    const on = (prism: VolumePrism) => prism.z0 < z && z < prism.z1;
    const active = steps.filter((step) => on(step.solid));
    if (active.length === 0) continue;
    const inside = (point: Vector2): boolean => {
      let solid = false;
      for (const step of active) {
        if ((step.op === "union") === solid) continue;
        if (!has(step.solid, point)) continue;
        if (step.minus?.some((prism) => on(prism) && has(prism, point))) continue;
        solid = step.op === "union";
      }
      return solid;
    };
    const use = active.flatMap((step) => [step.solid, ...(step.minus ?? []).filter(on)]).map((prism) => indexOf.get(prism)!);
    let area = 0;
    for (const piece of regionBoundary(shapes, use, inside)) {
      // The region lies on one side of the piece; the area is the boundary integral of x times the outward normal's x.
      const outward = inside([piece.mid[0] - piece.normal[0] * OUTLINE_STEP, piece.mid[1] - piece.normal[1] * OUTLINE_STEP]) ? 1 : -1;
      const curve = piece.curve;
      area += outward * (curve.kind === "seg"
        ? piece.normal[0] * piece.length * (piece.p0[0] + piece.p1[0]) / 2
        : (curve.solid ? 1 : -1) * curve.r * (curve.c[0] * (Math.sin(piece.t1) - Math.sin(piece.t0)) + curve.r * ((piece.t1 - piece.t0) / 2 + (Math.sin(2 * piece.t1) - Math.sin(2 * piece.t0)) / 4)));
    }
    volume += area * height;
  }
  return volume;
}

export function boardCaseVolumes(plan: BoardCasePlan): BoardCaseVolumePrediction {
  const known = planVolumes.get(plan);
  if (known) return known;
  const OV = BOARD_CASE_CONSTANTS.overshootMm;
  const union = (solid: VolumePrism, minus?: VolumePrism[]): VolumeStep => ({ op: "union", solid, ...(minus ? { minus } : {}) });
  const cut = (solid: VolumePrism): VolumeStep => ({ op: "difference", solid });
  const webPrism = (solid: BoardCaseWebSolid): VolumePrism => solid.box
    ? boxPrism(solid.box.originMm, solid.box.sizeMm)
    : { shape: polygonPlanShape("", solid.loopMm, [solid.bottomZMm, solid.bottomZMm + solid.heightMm], []), z0: solid.bottomZMm, z1: solid.bottomZMm + solid.heightMm };
  // A screw boss pattern: every boss joined, then every hole cut from the boss tops (see createScrewBossPattern).
  const bosses = (steps: VolumeStep[], group: CylinderPattern, up: boolean): void => {
    for (const c of group.centersMm) steps.push(union(up ? cylinderPrism(c, group.outerDiameterMm / 2, c[2] - group.baseOverlapMm, c[2] + group.heightMm) : cylinderPrism(c, group.outerDiameterMm / 2, c[2] - group.heightMm, c[2] + group.baseOverlapMm)));
    if (group.holeDiameterMm > 0) for (const c of group.centersMm) steps.push(cut(up ? cylinderPrism(c, group.holeDiameterMm / 2, c[2] + group.heightMm - group.holeDepthMm, c[2] + group.heightMm + OV) : cylinderPrism(c, group.holeDiameterMm / 2, c[2] - group.heightMm - OV, c[2] - group.heightMm + group.holeDepthMm)));
  };
  // A cutter along z from its entry point (through hole, slot, connector opening on the lid or the floor).
  const zRange = (entry: Vector3, axisZ: number, depth: number): Vector2 => axisZ > 0 ? [entry[2] - OV, entry[2] + depth + OV] : [entry[2] - depth - OV, entry[2] + OV];
  const flatShape = (center: Vector3, width: number, height: number, radius: number, z: Vector2): VolumePrism => rectPrism([center[0] - width / 2, center[1] - height / 2], [center[0] + width / 2, center[1] + height / 2], radius, z[0], z[1]);
  // A cutter through a wall: its bounding prism (the profile's box, from the overshoot outside to the overshoot inside).
  const wallBound = (entry: Vector3, axis: Vector3, across: number, vertical: number, depth: number): VolumePrism => {
    const alongX = Math.abs(axis[0]) > 0.5;
    const a = alongX ? entry[0] : entry[1];
    const sign = (alongX ? axis[0] : axis[1]) > 0 ? 1 : -1;
    const reach: Vector2 = sign > 0 ? [a - OV, a + depth + OV] : [a - depth - OV, a + OV];
    const side: Vector2 = alongX ? [entry[1] - across / 2, entry[1] + across / 2] : [entry[0] - across / 2, entry[0] + across / 2];
    return alongX ? rectPrism([reach[0], side[0]], [reach[1], side[1]], 0, entry[2] - vertical / 2, entry[2] + vertical / 2) : rectPrism([side[0], reach[0]], [side[1], reach[1]], 0, entry[2] - vertical / 2, entry[2] + vertical / 2);
  };
  const roundedArea = (width: number, height: number, radius: number) => width * height - (4 - Math.PI) * radius * radius;
  const body = (target: "base" | "lid"): { steps: VolumeStep[]; extras: VolumeExtra[] } => {
    const steps: VolumeStep[] = [];
    const extras: VolumeExtra[] = [];
    if (target === "base") {
      steps.push(union(boxPrism(plan.base.boxOriginMm, plan.base.boxSizeMm, plan.base.outerRadiusMm)), cut(boxPrism(plan.base.cavityOriginMm, plan.base.cavitySizeMm, plan.base.innerRadiusMm)));
      for (const solid of plan.webSolids) steps.push(union(webPrism(solid)));
      for (const group of plan.standoffGroups) bosses(steps, group, true);
      if (plan.standoffFloorHoles) for (const c of plan.standoffFloorHoles.entryCentersMm) steps.push(cut(cylinderPrism(c, plan.standoffFloorHoles.diameterMm / 2, ...zRange(c, 1, plan.standoffFloorHoles.depthMm))));
      if (plan.posts) bosses(steps, plan.posts, true);
    } else {
      const lid = plan.lid;
      steps.push(union(boxPrism(lid.plateOriginMm, lid.plateSizeMm, lid.plateRadiusMm)));
      steps.push(union(boxPrism(lid.lipOriginMm, lid.lipSizeMm, lid.lipRadiusMm), [boxPrism(lid.lipInnerOriginMm, lid.lipInnerSizeMm, lid.lipInnerRadiusMm), ...lid.notches.map((notch) => notch.kind === "cylinder" ? cylinderPrism(notch.centerMm, notch.radiusMm, notch.centerMm[2], notch.centerMm[2] + notch.heightMm) : boxPrism(notch.originMm, notch.sizeMm))]));
      for (const solid of plan.lidWebSolids ?? []) steps.push(union(webPrism(solid)));
      for (const group of plan.lidPosts ?? []) bosses(steps, group, false);
      if (lid.holes) {
        const holes = lid.holes;
        for (const c of holes.entryCentersMm) steps.push(cut(cylinderPrism(c, holes.diameterMm / 2, ...zRange(c, -1, holes.depthMm))));
        if (holes.countersink) {
          const major = holes.countersink.majorDiameterMm / 2;
          const through = holes.diameterMm / 2;
          const depth = (major - through) / Math.tan((holes.countersink.includedAngleDeg * Math.PI) / 360);
          for (const [index, c] of holes.entryCentersMm.entries()) extras.push({ label: `the countersink of lid hole ${index}`, bound: cylinderPrism(c, major, c[2] - depth, c[2] + OV), boundMm3: Math.PI * (major * major - through * through) * depth, cutMm3: Math.PI * depth * ((major * major + major * through + through * through) / 3 - through * through) });
        }
      }
    }
    for (const opening of plan.openings) {
      if (opening.target !== target) continue;
      const radius = opening.shape === "circle" ? opening.widthMm / 2 : opening.slot ? Math.min(opening.widthMm, opening.heightMm) / 2 : opening.cornerRadiusMm;
      const [across, vertical] = opening.shape === "circle" ? [opening.widthMm, opening.widthMm] : [opening.widthMm, opening.heightMm];
      if (Math.abs(opening.axis[2]) > 0.5) {
        const z = zRange(opening.entryCenterMm, opening.axis[2], opening.throughDepthMm);
        steps.push(cut(opening.shape === "circle" ? cylinderPrism(opening.entryCenterMm, radius, z[0], z[1]) : flatShape(opening.entryCenterMm, across, vertical, radius, z)));
      } else if (radius <= 0) {
        steps.push(cut(wallBound(opening.entryCenterMm, opening.axis, across, vertical, opening.throughDepthMm)));
      } else {
        extras.push({ label: opening.label, bound: wallBound(opening.entryCenterMm, opening.axis, across, vertical, opening.throughDepthMm), boundMm3: across * vertical * opening.throughDepthMm, cutMm3: roundedArea(across, vertical, radius) * opening.throughDepthMm });
      }
    }
    if (plan.vents && plan.vents.target === target) {
      const vents = plan.vents;
      for (const [index, c] of vents.entryCentersMm.entries()) {
        if (Math.abs(vents.axis[2]) > 0.5) {
          const z = zRange(c, vents.axis[2], vents.throughDepthMm);
          // Lid slots run along y (slotDirection), width along x.
          steps.push(cut(flatShape(c, vents.widthMm, vents.overallLengthMm, vents.widthMm / 2, z)));
        } else {
          extras.push({ label: `vent slot ${index}`, bound: wallBound(c, vents.axis, vents.widthMm, vents.overallLengthMm, vents.throughDepthMm), boundMm3: vents.widthMm * vents.overallLengthMm * vents.throughDepthMm, cutMm3: roundedArea(vents.widthMm, vents.overallLengthMm, vents.widthMm / 2) * vents.throughDepthMm });
        }
      }
    }
    return { steps, extras };
  };
  const predict = (target: "base" | "lid"): { mm3?: number; note?: string } => {
    if (target === "base" && plan.taper) return { note: "not predicted: the clipped 45 degree gusset cones of bossStyle \"tapered\" are not upright prisms (the web solids are still proven one by one)" };
    const { steps, extras } = body(target);
    const plain = prismSequenceVolume(steps);
    if (extras.length === 0) return { mm3: r6(plain) };
    // Each such cutter must pass through full material only: with their bounding prisms cut too, exactly those prisms go.
    const bounded = prismSequenceVolume([...steps, ...extras.map((extra) => cut(extra.bound))]);
    const expected = extras.reduce((sum, extra) => sum + extra.boundMm3, 0);
    if (Math.abs(plain - bounded - expected) > 1e-6 * Math.max(1, expected)) return { note: `not predicted: the path of a cutter that is not an upright prism (${extras.map((extra) => extra.label).join(", ")}) is not full material everywhere (their bounding prisms would remove ${r6(plain - bounded)} mm3, not ${r6(expected)})` };
    return { mm3: r6(plain - extras.reduce((sum, extra) => sum + extra.cutMm3, 0)) };
  };
  // A failure of the outline engine itself is not a wrong build: that volume is then not predicted, and says so.
  const safely = (target: "base" | "lid"): { mm3?: number; note?: string } => {
    try { return predict(target); } catch (error) { return { note: `not predicted: the outline engine could not compute the ${target}'s sections (${error instanceof Error ? error.message.slice(0, 160) : String(error)})` }; }
  };
  const base = safely("base");
  const lid = safely("lid");
  const result: BoardCaseVolumePrediction = { ...(base.mm3 !== undefined ? { baseMm3: base.mm3 } : {}), ...(lid.mm3 !== undefined ? { lidMm3: lid.mm3 } : {}), ...(base.note ? { baseNote: base.note } : {}), ...(lid.note ? { lidNote: lid.note } : {}) };
  planVolumes.set(plan, result);
  return result;
}

const planVolumes = new WeakMap<BoardCasePlan, BoardCaseVolumePrediction>();

function r6(value: number): number {
  return Math.round(value * 1e6) / 1e6 + 0;
}

// The area of a plan-view loop (shoelace).
function loopAreaMm2(loop: Vector2[]): number {
  let twice = 0;
  for (let index = 0; index < loop.length; index += 1) {
    const a = loop[index]!;
    const b = loop[(index + 1) % loop.length]!;
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(twice) / 2;
}
