// plasticity_create_bracket: one call builds a sheet-style bracket (L, U, Z or flat) as one Solid.
//
// The bracket is built axis-aligned from originMm, its bounds minimum: the width runs along +Y, the profile lies in the
// XZ plane. Every leg has a frame (see LEG FRAMES below) in which holes are placed as [along, across] millimetres. All
// derived values are computed from the parameters before any native call, and read back from the built body after it.
//
// Native steps, in order: one box per leg and one union (L, U, Z); one fillet for the inner bends (innerBendRadiusMm > 0;
// the outer corner of a bend stays sharp, as in the audit bracket); one fillet for the free outer corners
// (cornerRadiusMm > 0); one rib recipe per gusset (side "centered"); one hole recipe per hole item; one delete of the
// construction Wires the rib, slot and countersink recipes leave. A native failure undoes every step taken.
//
// LEG FRAMES. o = originMm, t = thickness, W = width, r = inner bend radius. "Outer face" is the face on the convex side of
// the bend(s); planeNormal points out of it. frameOriginMm is the outer face's corner at the bend end (y = o.y); alongAxis
// points from the bend toward the free end; acrossAxis is +Y for every leg. flatSpanMm is the along range clear of bends.
//   L  base    normal -Z  origin o                along +X  flat [t+r, base]
//      upright normal -X  origin o                along +Z  flat [t+r, upright]
//   U  base    normal -Z  origin o                along +X  flat [t+r, base-t-r]
//      left    normal -X  origin o                along +Z  flat [t+r, left]
//      right   normal +X  origin o+(base,0,0)     along +Z  flat [t+r, right]
//   Z  lower   normal -Z  origin o+(lower,0,0)    along -X  flat [t+r, lower]
//      web     normal +X  origin o+(lower,0,0)    along +Z  flat [t+r, web-t-r]
//      upper   normal +Z  origin o+(lower-t,0,web) along +X flat [t+r, upper]
//   flat flat  normal -Z  origin o                along +X  flat [0, length]
import type { PlasticityOperations } from "./operations.ts";
import { PlasticityRecipes, type RecipeOperations } from "./recipes.ts";
import type { RuntimeState } from "./runtime.ts";
import {
  add, boundsNear, clean, coaxialOffset, committedMismatch, COINCIDENT_MM, distance, fullTurnCylinders, parallelSine, PARALLEL_SINE, round6, runGuarded, scale, sub,
  type Bounds, type MateStep, type UndoCapable, type Vector3,
} from "./mate.ts";

export type BracketProfile = "L" | "U" | "Z" | "flat";
export type BracketLegName = "base" | "upright" | "left" | "right" | "lower" | "web" | "upper" | "flat";
export const PROFILE_LEGS: Record<BracketProfile, BracketLegName[]> = { L: ["base", "upright"], U: ["base", "left", "right"], Z: ["lower", "web", "upper"], flat: ["flat"] };
const LEG_INPUT_KEYS: Record<BracketProfile, string[]> = { L: ["baseMm", "uprightMm"], U: ["baseMm", "leftMm", "rightMm"], Z: ["lowerMm", "webMm", "upperMm"], flat: ["lengthMm"] };

export interface BracketHoleInput {
  leg: BracketLegName;
  diameterMm: number;
  count: number;
  layout: "line-across" | "line-along" | "grid" | "explicit";
  marginMm?: number | undefined;
  pitchMm?: number | undefined;
  positionsMm?: Array<[number, number]> | undefined;
  slot?: { lengthMm: number; direction: "along" | "across" } | undefined;
  countersunk?: { headDiameterMm: number } | undefined;
}
export interface BracketGussetInput { count: 1 | 2; thicknessMm: number; sizeMm: number; positions?: "centered" | "edges" | undefined }
export interface BracketInput {
  originMm: Vector3;
  name?: string | undefined;
  profile: BracketProfile;
  widthMm: number;
  thicknessMm: number;
  legs: Partial<Record<"baseMm" | "uprightMm" | "leftMm" | "rightMm" | "lowerMm" | "webMm" | "upperMm" | "lengthMm", number>>;
  innerBendRadiusMm?: number | undefined;
  cornerRadiusMm?: number | undefined;
  holes?: BracketHoleInput[] | undefined;
  allowEdgeHoles?: boolean | undefined;
  gussets?: BracketGussetInput | undefined;
  revision: string;
}

export interface BracketLegFrame {
  planeNormal: Vector3;
  outerFaceOffsetMm: number; // the outer face's coordinate on the normal's axis
  frameOriginMm: Vector3;
  alongAxis: Vector3;
  acrossAxis: Vector3;
  lengthMm: number;
  flatSpanMm: [number, number];
}
interface LegPlan extends BracketLegFrame { name: BracketLegName; roundedStart: boolean; roundedEnd: boolean; normalIndex: number }
export interface BracketHoleAxis {
  leg: BracketLegName;
  pointMm: Vector3; // on the outer face
  axis: Vector3; // into the leg (minus planeNormal)
  diameterMm: number;
  slot?: { lengthMm: number; directionAxis: Vector3 };
  countersunk?: { headDiameterMm: number; side: "inner" };
}
interface PlannedHole extends BracketHoleAxis { item: number; position: number; alongMm: number; acrossMm: number }
export interface BracketPlan {
  profile: BracketProfile;
  name: string;
  widthMm: number;
  thicknessMm: number;
  innerBendRadiusMm: number;
  cornerRadiusMm: number;
  boundsMm: Bounds;
  boxes: Array<{ originMm: Vector3; sizeMm: Vector3 }>;
  legs: LegPlan[];
  bends: Array<{ edgeCenterMm: Vector3; axisPointMm: Vector3 }>;
  corners: Array<{ edgeCenterMm: Vector3; edgeDirection: Vector3; axisPointMm: Vector3 }>;
  gussets: Array<{ profilePointsMm: Vector3[]; thicknessMm: number; boundsMm: Bounds; ribBoundsMm: Bounds }>;
  holes: PlannedHole[];
}
export interface BracketDerived {
  boundsMm: Bounds;
  legs: Partial<Record<BracketLegName, BracketLegFrame>>;
  holeAxesMm: BracketHoleAxis[];
  bendAxesMm?: Array<{ pointMm: Vector3; axis: Vector3; radiusMm: number }>;
  cornerAxesMm?: Array<{ pointMm: Vector3; axis: Vector3; radiusMm: number }>;
  gussetBoundsMm?: Bounds[];
}
export interface BracketResult {
  recipe: "bracket";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  bodyId: number;
  name: string;
  profile: BracketProfile;
  derived: BracketDerived;
  faceIds: Partial<Record<BracketLegName, { outerFaceId?: string; innerFaceId?: string }>>;
  undoSteps: number;
  steps: MateStep[];
}
export type BracketOperations = RecipeOperations & UndoCapable & { rename?: PlasticityOperations["rename"] | undefined };

const ACROSS: Vector3 = [0, 1, 0];
const OVERSHOOT_MM = 0.5;
const CLEAR_MM = 1e-3; // the least clearance that is not tangency
const finite = (value: number) => Number.isFinite(value);

function positive(value: number | undefined, label: string): number {
  if (value === undefined || !finite(value) || value <= 0) throw new Error(`${label} must be a positive number of millimetres`);
  return value;
}

// ---------- 2D helpers in a leg frame: points are [along, across] ----------
type P2 = [number, number];
const d2 = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function pointSegment(p: P2, a: P2, b: P2): number {
  const ab: P2 = [b[0] - a[0], b[1] - a[1]];
  const l2 = ab[0] ** 2 + ab[1] ** 2;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2)) : 0;
  return d2(p, [a[0] + t * ab[0], a[1] + t * ab[1]]);
}
function segmentsIntersect(a: P2, b: P2, c: P2, d: P2): boolean {
  const orient = (p: P2, q: P2, r: P2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}
function segmentSegment(a: P2, b: P2, c: P2, d: P2): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(pointSegment(a, c, d), pointSegment(b, c, d), pointSegment(c, a, b), pointSegment(d, a, b));
}
function segmentRect(a: P2, b: P2, lo: P2, hi: P2): number {
  const inside = (p: P2) => p[0] >= lo[0] && p[0] <= hi[0] && p[1] >= lo[1] && p[1] <= hi[1];
  if (inside(a) || inside(b)) return 0;
  const corners: P2[] = [lo, [hi[0], lo[1]], hi, [lo[0], hi[1]]];
  return Math.min(...corners.map((corner, i) => segmentSegment(a, b, corner, corners[(i + 1) % 4]!)));
}

// ---------- planning (pure) ----------

function legPlan(name: BracketLegName, normal: Vector3, origin: Vector3, along: Vector3, lengthMm: number, span: [number, number], roundedStart: boolean, roundedEnd: boolean): LegPlan {
  const normalIndex = normal.findIndex((value) => value !== 0);
  return { name, planeNormal: normal, outerFaceOffsetMm: origin[normalIndex]!, frameOriginMm: origin, alongAxis: along, acrossAxis: ACROSS, lengthMm, flatSpanMm: span, roundedStart, roundedEnd, normalIndex };
}
const legPoint = (leg: LegPlan, along: number, across: number): Vector3 => add(add(leg.frameOriginMm, scale(leg.alongAxis, along)), scale(leg.acrossAxis, across));

/** Pure: validates the input and computes every native argument and derived value. Throws before any native call. */
export function planBracket(input: BracketInput): BracketPlan {
  if (input.originMm.length !== 3 || input.originMm.some((value) => !finite(value))) throw new Error("originMm must be three finite numbers");
  const o = input.originMm;
  const W = positive(input.widthMm, "widthMm");
  const t = positive(input.thicknessMm, "thicknessMm");
  const r = input.innerBendRadiusMm ?? 0;
  const rc = input.cornerRadiusMm ?? 0;
  if (!finite(r) || r < 0) throw new Error("innerBendRadiusMm must be zero or positive");
  if (!finite(rc) || rc < 0) throw new Error("cornerRadiusMm must be zero or positive");
  const keys = LEG_INPUT_KEYS[input.profile];
  if (!keys) throw new Error(`Unknown bracket profile: ${String(input.profile)}`);
  const extra = Object.keys(input.legs).filter((key) => !keys.includes(key));
  if (extra.length > 0) throw new Error(`legs for profile ${input.profile} are ${keys.join(", ")}; not ${extra.join(", ")}`);
  const leg = (key: string) => positive(input.legs[key as keyof BracketInput["legs"]], `legs.${key}`);

  let legs: LegPlan[];
  let boxes: BracketPlan["boxes"];
  let bends: BracketPlan["bends"] = [];
  let size: Vector3;
  const bend = (cx: number, cz: number, ax: number, az: number) => ({ edgeCenterMm: [o[0] + cx, o[1] + W / 2, o[2] + cz] as Vector3, axisPointMm: [o[0] + ax, o[1], o[2] + az] as Vector3 });
  if (input.profile === "L") {
    const B = leg("baseMm"), H = leg("uprightMm");
    if (B <= t || H <= t) throw new Error("L legs must be longer than thicknessMm");
    if (r >= Math.min(B, H) - t) throw new Error(`innerBendRadiusMm must be less than the shorter leg minus thickness (${Math.min(B, H) - t} mm)`);
    legs = [
      legPlan("base", [0, 0, -1], [...o], [1, 0, 0], B, [t + r, B], false, true),
      legPlan("upright", [-1, 0, 0], [...o], [0, 0, 1], H, [t + r, H], false, true),
    ];
    boxes = [{ originMm: [...o], sizeMm: [B, W, t] }, { originMm: [...o], sizeMm: [t, W, H] }];
    bends = [bend(t, t, t + r, t + r)];
    size = [B, W, H];
  } else if (input.profile === "U") {
    const B = leg("baseMm"), Lh = leg("leftMm"), Rh = leg("rightMm");
    if (B <= 2 * t) throw new Error("U baseMm must be longer than twice thicknessMm");
    if (Lh <= t || Rh <= t) throw new Error("U left and right legs must be longer than thicknessMm");
    if (r >= Math.min(Lh, Rh) - t) throw new Error(`innerBendRadiusMm must be less than the shorter side leg minus thickness (${Math.min(Lh, Rh) - t} mm)`);
    if (2 * r >= B - 2 * t) throw new Error(`innerBendRadiusMm must be less than half the inner base length (${(B - 2 * t) / 2} mm): both bends sit on the base`);
    legs = [
      legPlan("base", [0, 0, -1], [...o], [1, 0, 0], B, [t + r, B - t - r], false, false),
      legPlan("left", [-1, 0, 0], [...o], [0, 0, 1], Lh, [t + r, Lh], false, true),
      legPlan("right", [1, 0, 0], [o[0] + B, o[1], o[2]], [0, 0, 1], Rh, [t + r, Rh], false, true),
    ];
    boxes = [{ originMm: [...o], sizeMm: [B, W, t] }, { originMm: [...o], sizeMm: [t, W, Lh] }, { originMm: [o[0] + B - t, o[1], o[2]], sizeMm: [t, W, Rh] }];
    bends = [bend(t, t, t + r, t + r), bend(B - t, t, B - t - r, t + r)];
    size = [B, W, Math.max(Lh, Rh)];
  } else if (input.profile === "Z") {
    const Lo = leg("lowerMm"), Hw = leg("webMm"), Up = leg("upperMm");
    if (Lo <= t || Up <= t) throw new Error("Z lower and upper legs must be longer than thicknessMm");
    if (Hw <= 2 * t) throw new Error("Z webMm must be longer than twice thicknessMm");
    if (r >= Math.min(Lo, Hw) - t || r >= Math.min(Up, Hw) - t) throw new Error(`innerBendRadiusMm must be less than the shorter adjacent leg minus thickness (${Math.min(Lo, Up, Hw) - t} mm)`);
    if (2 * r >= Hw - 2 * t) throw new Error(`innerBendRadiusMm must be less than half the inner web length (${(Hw - 2 * t) / 2} mm): both bends sit on the web`);
    legs = [
      legPlan("lower", [0, 0, -1], [o[0] + Lo, o[1], o[2]], [-1, 0, 0], Lo, [t + r, Lo], false, true),
      legPlan("web", [1, 0, 0], [o[0] + Lo, o[1], o[2]], [0, 0, 1], Hw, [t + r, Hw - t - r], false, false),
      legPlan("upper", [0, 0, 1], [o[0] + Lo - t, o[1], o[2] + Hw], [1, 0, 0], Up, [t + r, Up], false, true),
    ];
    boxes = [{ originMm: [...o], sizeMm: [Lo, W, t] }, { originMm: [o[0] + Lo - t, o[1], o[2]], sizeMm: [t, W, Hw] }, { originMm: [o[0] + Lo - t, o[1], o[2] + Hw - t], sizeMm: [Up, W, t] }];
    bends = [bend(Lo - t, t, Lo - t - r, t + r), bend(Lo, Hw - t, Lo + r, Hw - t - r)];
    size = [Lo - t + Up, W, Hw];
  } else {
    const Lf = leg("lengthMm");
    if (r > 0) throw new Error("A flat bracket has no bend: innerBendRadiusMm must be 0");
    legs = [legPlan("flat", [0, 0, -1], [...o], [1, 0, 0], Lf, [0, Lf], true, true)];
    boxes = [{ originMm: [...o], sizeMm: [Lf, W, t] }];
    size = [Lf, W, t];
  }
  if (r === 0) bends = [];

  // Corner rounds of the free ends, in the leg's plane.
  const corners: BracketPlan["corners"] = [];
  if (rc > 0) {
    if (rc >= W / 2) throw new Error(`cornerRadiusMm must be less than half the width (${W / 2} mm)`);
    for (const plan of legs) {
      const flat = plan.flatSpanMm[1] - plan.flatSpanMm[0];
      if ((plan.roundedStart || plan.roundedEnd) && rc >= (plan.roundedStart && plan.roundedEnd ? flat / 2 : flat)) throw new Error(`cornerRadiusMm must be less than the flat length of leg ${plan.name} (${plan.roundedStart && plan.roundedEnd ? flat / 2 : flat} mm)`);
      for (const [rounded, along, inward] of [[plan.roundedStart, 0, rc], [plan.roundedEnd, plan.lengthMm, plan.lengthMm - rc]] as const) {
        if (!rounded) continue;
        for (const [across, acrossIn] of [[0, rc], [W, W - rc]] as const) {
          corners.push({
            edgeCenterMm: sub(legPoint(plan, along, across), scale(plan.planeNormal, t / 2)),
            edgeDirection: plan.planeNormal.map(Math.abs) as Vector3,
            axisPointMm: legPoint(plan, inward, acrossIn),
          });
        }
      }
    }
  }

  // Gussets (L only), centred on their own plane through the rib recipe.
  const gussets: BracketPlan["gussets"] = [];
  if (input.gussets) {
    const g = input.gussets;
    if (input.profile !== "L") throw new Error("gussets are for the L profile only");
    const tg = positive(g.thicknessMm, "gussets.thicknessMm");
    const S = positive(g.sizeMm, "gussets.sizeMm");
    if (g.count !== 1 && g.count !== 2) throw new Error("gussets.count must be 1 or 2");
    const positions = g.positions ?? (g.count === 1 ? "centered" : "edges");
    if (g.count === 1 && positions !== "centered") throw new Error("one gusset is always centred on the width: positions must be \"centered\"");
    if (g.count === 1 ? tg >= W : tg >= W / 2) throw new Error(`gussets.thicknessMm ${tg} does not fit ${g.count} gusset(s) on the ${W} mm width`);
    const [B, H] = [legs[0]!.lengthMm, legs[1]!.lengthMm];
    if (S <= r) throw new Error(`gussets.sizeMm must be larger than innerBendRadiusMm (${r} mm)`);
    if (S + t > Math.min(B, H) - rc) throw new Error(`gussets.sizeMm must be at most the shorter leg minus thickness and cornerRadiusMm (${Math.min(B, H) - rc - t} mm)`);
    const centres = g.count === 1 ? [W / 2] : positions === "edges" ? [tg / 2, W - tg / 2] : [W / 4, (3 * W) / 4];
    const e = Math.min(0.5, t / 4);
    for (const gy of centres) {
      const p = (x: number, z: number): Vector3 => [o[0] + x, o[1] + gy, o[2] + z];
      gussets.push({
        profilePointsMm: [p(t - e, t - e), p(t + S + e, t - e), p(t - e, t + S + e)],
        thicknessMm: tg,
        boundsMm: { min: p(t, t).map((value, i) => (i === 1 ? value - tg / 2 : value)) as Vector3, max: p(t + S, t + S).map((value, i) => (i === 1 ? value + tg / 2 : value)) as Vector3 },
        ribBoundsMm: { min: p(t - e, t - e).map((value, i) => (i === 1 ? value - tg / 2 : value)) as Vector3, max: p(t + S + e, t + S + e).map((value, i) => (i === 1 ? value + tg / 2 : value)) as Vector3 },
      });
    }
  }

  const holes = planHoles(input, legs, gussets, W, t);
  const boundsMm: Bounds = { min: [...o], max: add(o, size) };
  return { profile: input.profile, name: input.name ?? "bracket", widthMm: W, thicknessMm: t, innerBendRadiusMm: r, cornerRadiusMm: rc, boundsMm, boxes, legs, bends, corners, gussets, holes };
}

function layoutPositions(hole: BracketHoleInput, plan: LegPlan, W: number, label: string): P2[] {
  const n = hole.count;
  if (!Number.isInteger(n) || n < 1 || n > 12) throw new Error(`${label}: count must be a whole number from 1 to 12`);
  const [s0, s1] = plan.flatSpanMm;
  const mid = (s0 + s1) / 2;
  if (hole.layout === "explicit") {
    if (!hole.positionsMm || hole.positionsMm.length !== n) throw new Error(`${label}: layout explicit needs positionsMm with exactly count (${n}) [along, across] pairs`);
    if (hole.marginMm !== undefined || hole.pitchMm !== undefined) throw new Error(`${label}: layout explicit takes positionsMm only, not marginMm or pitchMm`);
    return hole.positionsMm.map((position) => {
      if (position.length !== 2 || position.some((value) => !finite(value))) throw new Error(`${label}: every position is [along, across] in millimetres`);
      return [position[0], position[1]];
    });
  }
  if (hole.positionsMm !== undefined) throw new Error(`${label}: positionsMm is for layout explicit only`);
  if (hole.marginMm !== undefined && hole.pitchMm !== undefined && hole.layout !== "grid") throw new Error(`${label}: give marginMm or pitchMm, not both`);
  if (hole.marginMm !== undefined && !(hole.marginMm > 0)) throw new Error(`${label}: marginMm must be positive`);
  if (hole.pitchMm !== undefined && !(hole.pitchMm > 0)) throw new Error(`${label}: pitchMm must be positive`);
  const spread = (count: number, from: number, to: number, centre: number): number[] => {
    if (count === 1) return [centre];
    if (hole.pitchMm !== undefined) return Array.from({ length: count }, (_, i) => centre + (i - (count - 1) / 2) * hole.pitchMm!);
    if (hole.marginMm !== undefined) return Array.from({ length: count }, (_, i) => from + hole.marginMm! + i * (to - from - 2 * hole.marginMm!) / (count - 1));
    throw new Error(`${label}: layout ${hole.layout} with count ${count} needs marginMm or pitchMm`);
  };
  if (hole.layout === "line-across") return spread(n, 0, W, W / 2).map((across): P2 => [mid, across]);
  if (hole.layout === "line-along") return spread(n, s0, s1, mid).map((along): P2 => [along, W / 2]);
  if (n % 2 !== 0) throw new Error(`${label}: layout grid needs an even count (two rows across)`);
  if (hole.marginMm === undefined) throw new Error(`${label}: layout grid needs marginMm (the rows sit marginMm from each side edge)`);
  const columns = n / 2;
  const alongs = columns === 1 ? [mid] : hole.pitchMm !== undefined
    ? Array.from({ length: columns }, (_, i) => mid + (i - (columns - 1) / 2) * hole.pitchMm!)
    : Array.from({ length: columns }, (_, i) => s0 + hole.marginMm! + i * (s1 - s0 - 2 * hole.marginMm!) / (columns - 1));
  return [hole.marginMm, W - hole.marginMm].flatMap((across) => alongs.map((along): P2 => [along, across]));
}

/** The footprint of one hole in its leg frame: a segment (a point for a round hole) and a radius. */
function footprint(hole: BracketHoleInput, at: P2): { a: P2; b: P2; radius: number } {
  if (hole.slot) {
    const half = (hole.slot.lengthMm - hole.diameterMm) / 2;
    const step: P2 = hole.slot.direction === "along" ? [half, 0] : [0, half];
    return { a: [at[0] - step[0], at[1] - step[1]], b: [at[0] + step[0], at[1] + step[1]], radius: hole.diameterMm / 2 };
  }
  return { a: at, b: at, radius: (hole.countersunk?.headDiameterMm ?? hole.diameterMm) / 2 };
}

/** Is a point inside the leg's flat region shrunk by delta, with the free-end corners rounded? */
function insideShrunkLeg(plan: LegPlan, W: number, rc: number, delta: number, p: P2): boolean {
  const [s0, s1] = plan.flatSpanMm;
  if (p[0] < s0 + delta - 1e-12 || p[0] > s1 - delta + 1e-12 || p[1] < delta - 1e-12 || p[1] > W - delta + 1e-12) return false;
  if (rc <= delta) return true;
  for (const [rounded, cornerAlong, inZone] of [[plan.roundedStart, s0 + rc, p[0] < s0 + rc], [plan.roundedEnd, s1 - rc, p[0] > s1 - rc]] as const) {
    if (!rounded || !inZone) continue;
    for (const [cornerAcross, zone] of [[rc, p[1] < rc], [W - rc, p[1] > W - rc]] as const) {
      if (zone && d2(p, [cornerAlong, cornerAcross]) > rc - delta + 1e-12) return false;
    }
  }
  return true;
}

function planHoles(input: BracketInput, legs: LegPlan[], gussets: BracketPlan["gussets"], W: number, t: number): PlannedHole[] {
  const holes: PlannedHole[] = [];
  const footprints: Array<{ label: string; leg: BracketLegName; a: P2; b: P2; radius: number }> = [];
  const rc = input.cornerRadiusMm ?? 0;
  if ((input.holes?.length ?? 0) > 16) throw new Error("A bracket takes at most 16 hole items");
  for (const [item, hole] of (input.holes ?? []).entries()) {
    const label = `holes[${item}] (leg ${hole.leg})`;
    const plan = legs.find((candidate) => candidate.name === hole.leg);
    if (!plan) throw new Error(`${label}: profile ${input.profile} has legs ${PROFILE_LEGS[input.profile].join(", ")}`);
    positive(hole.diameterMm, `${label} diameterMm`);
    if (hole.slot && hole.countersunk) throw new Error(`${label}: a slot cannot be countersunk`);
    if (hole.slot && !(hole.slot.lengthMm > hole.diameterMm)) throw new Error(`${label}: slot.lengthMm (overall, round ends included) must be larger than diameterMm`);
    if (hole.countersunk) {
      if (!(hole.countersunk.headDiameterMm > hole.diameterMm)) throw new Error(`${label}: countersunk.headDiameterMm must be larger than diameterMm`);
      if ((hole.countersunk.headDiameterMm - hole.diameterMm) / 2 >= t - CLEAR_MM) throw new Error(`${label}: a 90 degree countersink for head ${hole.countersunk.headDiameterMm} mm is ${(hole.countersunk.headDiameterMm - hole.diameterMm) / 2} mm deep, not less than the ${t} mm thickness`);
    }
    const margin = input.allowEdgeHoles ? CLEAR_MM : hole.diameterMm;
    for (const [position, at] of layoutPositions(hole, plan, W, label).entries()) {
      const where = `${label} position ${position} at [${round6(at as unknown as Vector3).slice(0, 2).join(", ")}]`;
      const shape = footprint(hole, at);
      const delta = shape.radius + margin;
      if (!insideShrunkLeg(plan, W, rc, delta, shape.a) || !insideShrunkLeg(plan, W, rc, delta, shape.b)) {
        throw new Error(`${where}: the hole must stay ${input.allowEdgeHoles ? "inside" : `${hole.diameterMm} mm (1x diameter) from the edges of`} the flat region of leg ${hole.leg} (along ${plan.flatSpanMm[0]} to ${plan.flatSpanMm[1]}, across 0 to ${W}${rc > 0 ? `, corners rounded ${rc} mm` : ""})${input.allowEdgeHoles ? "" : "; allowEdgeHoles: true relaxes the distance"}`);
      }
      if (input.profile === "L" && (hole.leg === "base" || hole.leg === "upright")) {
        for (const [index, gusset] of gussets.entries()) {
          const lo: P2 = [t, gusset.boundsMm.min[1] - input.originMm[1]];
          const hi: P2 = [t + (gusset.boundsMm.max[0] - gusset.boundsMm.min[0]), gusset.boundsMm.max[1] - input.originMm[1]];
          if (segmentRect(shape.a, shape.b, lo, hi) <= shape.radius + CLEAR_MM) throw new Error(`${where}: the hole overlaps gusset ${index} (across ${lo[1]} to ${hi[1]}, along ${lo[0]} to ${hi[0]})`);
        }
      }
      for (const other of footprints) {
        if (other.leg === hole.leg && segmentSegment(shape.a, shape.b, other.a, other.b) <= shape.radius + other.radius + CLEAR_MM) throw new Error(`${where}: the hole overlaps ${other.label}`);
      }
      footprints.push({ label: where, leg: hole.leg, ...shape });
      const pointMm = legPoint(plan, at[0], at[1]);
      holes.push({
        item, position, leg: hole.leg, alongMm: at[0], acrossMm: at[1],
        pointMm, axis: clean(scale(plan.planeNormal, -1)), diameterMm: hole.diameterMm,
        ...(hole.slot ? { slot: { lengthMm: hole.slot.lengthMm, directionAxis: hole.slot.direction === "along" ? [...plan.alongAxis] as Vector3 : [...plan.acrossAxis] as Vector3 } } : {}),
        ...(hole.countersunk ? { countersunk: { headDiameterMm: hole.countersunk.headDiameterMm, side: "inner" as const } } : {}),
      });
    }
  }
  if (holes.length > 64) throw new Error(`A bracket takes at most 64 holes; this input makes ${holes.length}`);
  return holes;
}

/** Pure: the derived values of a plan, as the tool reports them. */
export function bracketDerived(plan: BracketPlan): BracketDerived {
  const legs: BracketDerived["legs"] = {};
  for (const leg of plan.legs) legs[leg.name] = { planeNormal: leg.planeNormal, outerFaceOffsetMm: leg.outerFaceOffsetMm, frameOriginMm: leg.frameOriginMm, alongAxis: leg.alongAxis, acrossAxis: leg.acrossAxis, lengthMm: leg.lengthMm, flatSpanMm: leg.flatSpanMm };
  return {
    boundsMm: plan.boundsMm,
    legs,
    holeAxesMm: plan.holes.map(({ leg, pointMm, axis, diameterMm, slot, countersunk }) => ({ leg, pointMm, axis, diameterMm, ...(slot ? { slot } : {}), ...(countersunk ? { countersunk } : {}) })),
    ...(plan.bends.length > 0 ? { bendAxesMm: plan.bends.map((bend) => ({ pointMm: bend.axisPointMm, axis: [0, 1, 0] as Vector3, radiusMm: plan.innerBendRadiusMm })) } : {}),
    ...(plan.corners.length > 0 ? { cornerAxesMm: plan.corners.map((corner) => ({ pointMm: corner.axisPointMm, axis: corner.edgeDirection, radiusMm: plan.cornerRadiusMm })) } : {}),
    ...(plan.gussets.length > 0 ? { gussetBoundsMm: plan.gussets.map((gusset) => gusset.boundsMm) } : {}),
  };
}

// ---------- read-back (pure) ----------

/** Every check of the built body against the plan; an empty list means it holds. */
export function verifyBracket(plan: BracketPlan, state: RuntimeState, bodyId: number, initial: RuntimeState, ribBounds: Array<Bounds | undefined>): string[] {
  const problems: string[] = [];
  const body = state.bodies.find((candidate) => candidate.id === bodyId);
  if (!body || body.type !== "Solid") return [`body ${bodyId} is not a current Solid`];
  const known = new Set(initial.bodies.map((candidate) => candidate.id));
  const strays = state.bodies.filter((candidate) => !known.has(candidate.id) && candidate.id !== bodyId).map((candidate) => `${candidate.type} ${candidate.id}`);
  if (strays.length > 0) problems.push(`stray bodies left: ${strays.join(", ")}`);
  const removed = initial.bodies.filter((candidate) => !state.bodies.some((after) => after.id === candidate.id)).map((candidate) => candidate.id);
  if (removed.length > 0) problems.push(`bodies removed: ${removed.join(", ")}`);
  if (!body.boundsMm || !boundsNear(body.boundsMm, plan.boundsMm)) problems.push(`bounds ${JSON.stringify(body.boundsMm)} differ from ${JSON.stringify(plan.boundsMm)}`);
  const cylinderOn = (radius: number, point: Vector3, axis: Vector3, surface = "Cylinder") => body.faces.some((face) => face.surfaceType === surface && face.axisOriginMm && face.axisDirection
    && (surface !== "Cylinder" || (face.radiusMm !== null && Math.abs(face.radiusMm - radius) <= COINCIDENT_MM))
    && coaxialOffset(point, axis, face.axisOriginMm, face.axisDirection) <= COINCIDENT_MM);
  for (const [index, bend] of plan.bends.entries()) if (!cylinderOn(plan.innerBendRadiusMm, bend.axisPointMm, [0, 1, 0])) problems.push(`bend ${index}: no r${plan.innerBendRadiusMm} cylinder on the axis through ${JSON.stringify(round6(bend.axisPointMm))}`);
  for (const [index, corner] of plan.corners.entries()) if (!cylinderOn(plan.cornerRadiusMm, corner.axisPointMm, corner.edgeDirection)) problems.push(`corner ${index}: no r${plan.cornerRadiusMm} cylinder on the axis through ${JSON.stringify(round6(corner.axisPointMm))}`);
  const holes = fullTurnCylinders(body).filter((cylinder) => cylinder.kind === "hole");
  for (const hole of plan.holes) {
    const where = `holes[${hole.item}] position ${hole.position}`;
    if (hole.slot) {
      const half = (hole.slot.lengthMm - hole.diameterMm) / 2;
      for (const sign of [-1, 1]) {
        const end = add(hole.pointMm, scale(hole.slot.directionAxis, sign * half));
        if (!cylinderOn(hole.diameterMm / 2, end, hole.axis)) problems.push(`${where}: no slot end of radius ${hole.diameterMm / 2} on the axis through ${JSON.stringify(round6(end))}`);
      }
      continue;
    }
    if (!holes.some((cylinder) => Math.abs(cylinder.radiusMm - hole.diameterMm / 2) <= COINCIDENT_MM && coaxialOffset(hole.pointMm, hole.axis, cylinder.originMm, cylinder.direction) <= COINCIDENT_MM)) {
      problems.push(`${where}: no full-turn Ø${hole.diameterMm} hole coaxial with ${JSON.stringify(round6(hole.pointMm))} within 1e-6 mm`);
    }
    if (hole.countersunk && !cylinderOn(0, hole.pointMm, hole.axis, "Cone")) problems.push(`${where}: no countersink cone on the hole axis`);
  }
  for (const [index, gusset] of plan.gussets.entries()) {
    const bounds = ribBounds[index];
    // The rib recipe rounds ribBoundsMm to 4 decimals.
    if (!bounds || !boundsNear(bounds, gusset.ribBoundsMm, 1e-4)) problems.push(`gusset ${index}: rib bounds ${JSON.stringify(bounds)} differ from ${JSON.stringify(gusset.ribBoundsMm)}`);
    for (const side of [gusset.boundsMm.min[1], gusset.boundsMm.max[1]]) {
      if (!body.faces.some((face) => face.planar && parallelSine(face.normal, [0, 1, 0]) <= PARALLEL_SINE && Math.abs(face.centerMm[1] - side) <= COINCIDENT_MM)) problems.push(`gusset ${index}: no side face at y ${side}`);
    }
  }
  return problems;
}

/** Read-back face ids of each leg's outer and inner face: given only when exactly one planar face matches. */
export function legFaceIds(plan: BracketPlan, body: RuntimeState["bodies"][number]): BracketResult["faceIds"] {
  const out: BracketResult["faceIds"] = {};
  for (const leg of plan.legs) {
    const k = leg.normalIndex;
    const sign = leg.planeNormal[k]!;
    const find = (direction: number, offset: number) => body.faces.filter((face) => face.planar && Math.abs(face.normal[k]! - direction) <= 1e-9 && Math.abs(face.centerMm[k]! - offset) <= COINCIDENT_MM);
    const outer = find(sign, leg.outerFaceOffsetMm);
    const inner = find(-sign, leg.outerFaceOffsetMm - sign * plan.thicknessMm);
    out[leg.name] = { ...(outer.length === 1 ? { outerFaceId: outer[0]!.id } : {}), ...(inner.length === 1 ? { innerFaceId: inner[0]!.id } : {}) };
  }
  return out;
}

// ---------- execution ----------

function singleAdded(before: RuntimeState, after: RuntimeState, type: string, label: string): number {
  if (after.documentToken !== before.documentToken) throw new Error("Plasticity document changed during the bracket recipe");
  const known = new Set(before.bodies.map((body) => body.id));
  const added = after.bodies.filter((body) => !known.has(body.id));
  if (added.length !== 1 || added[0]!.type !== type) throw new Error(`Expected one ${type} for ${label}, found ${added.length} new bodies`);
  return added[0]!.id;
}

function lineEdges(state: RuntimeState, bodyId: number, expected: Array<{ centerMm: Vector3; direction: Vector3; lengthMm: number }>, label: string): string[] {
  const body = state.bodies.find((candidate) => candidate.id === bodyId);
  if (!body) throw new Error(`Bracket body ${bodyId} is missing before the ${label} fillet`);
  return expected.map((want) => {
    const matches = body.edges.filter((edge) => edge.line && parallelSine(edge.tangent, want.direction) <= PARALLEL_SINE && distance(edge.centerMm, want.centerMm) <= COINCIDENT_MM && Math.abs(edge.lengthMm - want.lengthMm) <= COINCIDENT_MM);
    if (matches.length !== 1) throw new Error(`Expected one ${label} edge at ${JSON.stringify(round6(want.centerMm))}, found ${matches.length}`);
    return matches[0]!.id;
  });
}

export async function createBracket(operations: BracketOperations, input: BracketInput): Promise<BracketResult> {
  const plan = planBracket(input);
  if (plan.holes.some((hole) => hole.countersunk) && !operations.revolveProfile) throw new Error("Countersunk bracket holes need native profile revolve support");
  if ((plan.gussets.length > 0 || plan.holes.some((hole) => hole.slot || hole.countersunk)) && !operations.remove) throw new Error("This bracket needs native delete support to remove its construction Wires");
  const initial = await operations.state();
  if (initial.revision !== input.revision) throw new Error(`Stale reference: expected revision ${input.revision}, current revision is ${initial.revision}`);
  const steps: MateStep[] = [];
  const ribBounds: Array<Bounds | undefined> = [];
  const recipes = new PlasticityRecipes(operations);
  const W = plan.widthMm;
  const t = plan.thicknessMm;

  const bodyId = await runGuarded(operations, "create_bracket", initial, async () => {
    let current = initial;
    const record = (operation: string, before: RuntimeState | string, after: RuntimeState | string, ids: number[]) => steps.push({
      operation, beforeRevision: typeof before === "string" ? before : before.revision, afterRevision: typeof after === "string" ? after : after.revision, affectedBodyIds: ids,
    });
    const boxIds: number[] = [];
    for (const [index, box] of plan.boxes.entries()) {
      const before = current;
      current = await operations.createBox(box.originMm, box.sizeMm, index === 0 ? plan.name : undefined, current.revision);
      const id = singleAdded(before, current, "Solid", `bracket box ${index}`);
      boxIds.push(id);
      record("create-leg-box", before, current, [id]);
    }
    let id = boxIds[0]!;
    if (boxIds.length > 1) {
      const before = current;
      current = await operations.boolean([id], boxIds.slice(1), "union", false, current.revision);
      const known = new Set(initial.bodies.map((body) => body.id));
      const solids = current.bodies.filter((body) => !known.has(body.id));
      if (solids.length !== 1 || solids[0]!.type !== "Solid") throw new Error(`Expected the leg union to leave one Solid, found ${solids.length} new bodies`);
      id = solids[0]!.id;
      record("union-legs", before, current, [id]);
    }
    if (plan.bends.length > 0) {
      const edges = lineEdges(current, id, plan.bends.map((bend) => ({ centerMm: bend.edgeCenterMm, direction: ACROSS, lengthMm: W })), "inner bend");
      const before = current;
      current = await operations.fillet(id, edges, plan.innerBendRadiusMm, current.revision);
      record("fillet-inner-bends", before, current, [id]);
    }
    if (plan.corners.length > 0) {
      const edges = lineEdges(current, id, plan.corners.map((corner) => ({ centerMm: corner.edgeCenterMm, direction: corner.edgeDirection, lengthMm: t })), "free corner");
      const before = current;
      current = await operations.fillet(id, edges, plan.cornerRadiusMm, current.revision);
      record("fillet-free-corners", before, current, [id]);
    }
    let revision = current.revision;
    const wires: number[] = [];
    for (const gusset of plan.gussets) {
      const result = await recipes.createRib({ targetId: id, profilePointsMm: gusset.profilePointsMm, thicknessMm: gusset.thicknessMm, side: "centered", revision });
      id = result.resultBodyIds[0]!;
      wires.push(result.profileBodyId);
      ribBounds.push(result.ribBoundsMm);
      record("gusset-rib", result.beforeRevision, result.afterRevision, [id]);
      revision = result.afterRevision;
    }
    const items = new Map<number, PlannedHole[]>();
    for (const hole of plan.holes) items.set(hole.item, [...(items.get(hole.item) ?? []), hole]);
    for (const group of items.values()) {
      const first = group[0]!;
      const leg = plan.legs.find((candidate) => candidate.name === first.leg)!;
      const outer = group.map((hole) => hole.pointMm);
      let result: { resultBodyIds: number[]; beforeRevision: string; afterRevision: string; recipe: string };
      if (first.slot) {
        const shared = { targetId: id, axis: first.axis, slotDirection: first.slot.directionAxis, overallLengthMm: first.slot.lengthMm, widthMm: first.diameterMm, throughDepthMm: t, overshootMm: OVERSHOOT_MM, revision };
        if (outer.length === 1) { const slot = await recipes.createSlottedHole({ ...shared, entryCenterMm: outer[0]! }); wires.push(slot.profileBodyId); result = slot; }
        else { const slots = await recipes.createSlottedHolePattern({ ...shared, entryCentersMm: outer }); wires.push(...slots.profileBodyIds); result = slots; }
      } else if (first.countersunk) {
        // The countersink opens on the inner face: entry on the inner face, drilled toward the outer face.
        const inner = outer.map((point) => sub(point, scale(leg.planeNormal, t)));
        const shared = { targetId: id, axis: leg.planeNormal, radialDirection: ACROSS, throughDiameterMm: first.diameterMm, countersinkMajorDiameterMm: first.countersunk.headDiameterMm, includedAngleDeg: 90, throughDepthMm: t, overshootMm: OVERSHOOT_MM, revision };
        if (inner.length === 1) { const sink = await recipes.createCountersink({ ...shared, entryCenterMm: inner[0]! }); wires.push(sink.profileBodyId); result = sink; }
        else { const sinks = await recipes.createCountersinkPattern({ ...shared, entryCentersMm: inner }); wires.push(...sinks.profileBodyIds); result = sinks; }
      } else {
        const shared = { targetId: id, axis: first.axis, holeDiameterMm: first.diameterMm, throughDepthMm: t, overshootMm: OVERSHOOT_MM, revision };
        result = outer.length === 1 ? await recipes.createThroughHole({ ...shared, entryCenterMm: outer[0]! }) : await recipes.createThroughHolePattern({ ...shared, entryCentersMm: outer });
      }
      id = result.resultBodyIds[0]!;
      record(`holes-${result.recipe}`, result.beforeRevision, result.afterRevision, [id]);
      revision = result.afterRevision;
    }
    if (wires.length > 0) {
      const before = revision;
      const after = await operations.remove!(wires, revision);
      const left = wires.filter((wire) => after.bodies.some((body) => body.id === wire));
      if (left.length > 0) throw new Error(`Construction Wires were not removed: ${left.join(", ")}`);
      record("delete-construction-wires", before, after, wires);
      revision = after.revision;
    }
    current = await operations.state();
    const body = current.bodies.find((candidate) => candidate.id === id);
    if (body && body.name !== plan.name && operations.rename) {
      const after = await operations.rename(id, plan.name, current.revision);
      record("rename-bracket", current, after, [id]);
    }
    return id;
  });

  const final = await operations.state();
  const problems = verifyBracket(plan, final, bodyId, initial, ribBounds);
  if (problems.length > 0) throw committedMismatch("create_bracket", problems, final, initial);
  const body = final.bodies.find((candidate) => candidate.id === bodyId)!;
  return {
    recipe: "bracket",
    status: "completed",
    documentToken: final.documentToken,
    beforeRevision: initial.revision,
    afterRevision: final.revision,
    bodyId,
    name: body.name ?? plan.name,
    profile: plan.profile,
    derived: bracketDerived(plan),
    faceIds: legFaceIds(plan, body),
    undoSteps: final.undoDepth - initial.undoDepth,
    steps,
  };
}
