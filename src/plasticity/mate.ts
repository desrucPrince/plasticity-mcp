// Two mate helpers for multi-part work, plus the guarded runner they share with the bracket recipe.
//
// plasticity_place_body moves (and optionally turns in 90 degree steps) one body so that an anchor on it lands on an anchor
// of another body. Anchors are bounds points or the centre (the kernel's own midpoint, as find_faces reports it) of an
// explicit planar face id. Nothing is recognised: the caller names the faces. Faces are never turned to mate.
//
// plasticity_transfer_holes cuts holes into a target that line up with cylinder axes of a source. The axes come only from
// full-turn cylindrical faces of the source, selected by exact radius (and optionally axis, kind and a box), or from
// explicit axes. Partial arcs, blends and faces whose circle edges carry no geometry are never used.
//
// Provable or refused. Everything predictable from the inputs is refused before the first native call. After the native
// steps both read the result again; when the read-back does not prove the request, the tool undoes its own steps
// (counted from the Undo depth) and says the document is unchanged. A native step that fails is undone the same way; an
// uncertain one is not touched (reconcile first).
import { CommittedChangeError, type PlasticityOperations } from "./operations.ts";
import { PlasticityRecipes, type RecipeOperations } from "./recipes.ts";
import { mutationOutcomeIsUncertain, type RuntimeState } from "./runtime.ts";

export type Vector3 = [number, number, number];
export type Bounds = { min: Vector3; max: Vector3 };
type Body = RuntimeState["bodies"][number];
type Face = Body["faces"][number];
type Edge = Body["edges"][number];

/** Points and axes that must coincide after an edit, in millimetres. */
export const COINCIDENT_MM = 1e-6;
/** Two unit directions are parallel when the sine of the angle between them is at most this. */
export const PARALLEL_SINE = 1e-9;
/** place_body: two face normals are parallel (or opposed) when the sine of their angle is at most this. */
export const MATE_PARALLEL_SINE = 1e-6;
/** No edge of a built or cut body may be shorter than this (a sliver); also the least wall left under a blind floor. */
export const MIN_FEATURE_MM = 0.05;
const FULL_TURN_DEG = 359.9;
const AXIS_END_MM = 1e-3; // circle edges whose centres lie this close along the axis are one end of a face
const MAX_UNDO = 500;

// ---------- vector helpers ----------

export const add = (a: Vector3, b: Vector3): Vector3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vector3, b: Vector3): Vector3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vector3, k: number): Vector3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vector3, b: Vector3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vector3, b: Vector3): Vector3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: Vector3): number => Math.hypot(a[0], a[1], a[2]);
export const distance = (a: Vector3, b: Vector3): number => length(sub(a, b));
export function unit(a: Vector3, label = "Direction"): Vector3 {
  if (a.some((value) => !Number.isFinite(value))) throw new Error(`${label} must contain finite values`);
  const size = length(a);
  if (!(size > 1e-12)) throw new Error(`${label} must be nonzero`);
  return [a[0] / size, a[1] / size, a[2] / size];
}
export const clean = (a: readonly number[]): Vector3 => a.map((value) => (Math.abs(value) < 1e-12 ? 0 : value)) as Vector3;
export const round6 = (a: readonly number[]): Vector3 => a.map((value) => { const r = Math.round(value * 1e6) / 1e6; return Object.is(r, -0) ? 0 : r; }) as Vector3;
/** sine of the angle between two directions (unit or not); 0 when parallel or anti-parallel. */
export const parallelSine = (a: Vector3, b: Vector3): number => length(cross(unit(a), unit(b)));
export const boundsCenter = (b: Bounds): Vector3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
export function boundsNear(a: Bounds, b: Bounds, tolerance = COINCIDENT_MM): boolean {
  return [0, 1, 2].every((i) => Math.abs(a.min[i]! - b.min[i]!) <= tolerance && Math.abs(a.max[i]! - b.max[i]!) <= tolerance);
}
export function perpendicular(direction: Vector3): Vector3 {
  const d = unit(direction);
  const helper: Vector3 = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return unit(cross(d, helper));
}
/** Distance between two parallel lines, or Infinity when they are not parallel within PARALLEL_SINE. */
export function coaxialOffset(originA: Vector3, directionA: Vector3, originB: Vector3, directionB: Vector3): number {
  if (parallelSine(directionA, directionB) > PARALLEL_SINE) return Number.POSITIVE_INFINITY;
  return length(cross(sub(originB, originA), unit(directionA)));
}
const AXES: Record<"x" | "y" | "z", Vector3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

// ---------- the guarded runner ----------

export interface UndoCapable {
  state(): Promise<RuntimeState>;
  undo(revision?: string): Promise<RuntimeState>;
}

/** A failed guarded run. uncertain: nothing was undone (reconcile first). Otherwise undoneSteps steps were undone. */
export class GuardedRunError extends Error {
  readonly uncertain: boolean;
  readonly undoneSteps: number;
  readonly restored: boolean;
  constructor(message: string, details: { uncertain: boolean; undoneSteps: number; restored: boolean; cause: unknown }) {
    super(message, { cause: details.cause });
    this.uncertain = details.uncertain;
    this.undoneSteps = details.undoneSteps;
    this.restored = details.restored;
  }
}

function causeIsUncertain(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 8; current = (current as { cause?: unknown }).cause, depth += 1) {
    if (mutationOutcomeIsUncertain(current)) return true;
    if (typeof current === "object" && (current as { uncertain?: unknown }).uncertain === true) return true;
  }
  return false;
}

function sameBodyIds(left: RuntimeState, right: RuntimeState): boolean {
  const a = left.bodies.map((body) => body.id).sort((x, y) => x - y);
  const b = right.bodies.map((body) => body.id).sort((x, y) => x - y);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Runs native steps. When one fails, every Undo step added since `initial` is undone (measured from the Undo depth),
 * unless the failure is uncertain (a CDP timeout or an uncertain sub-recipe): then nothing is touched and the error says
 * to reconcile. A CommittedChangeError (a read-back mismatch after the steps completed) passes through untouched.
 */
export async function runGuarded<T>(operations: UndoCapable, label: string, initial: RuntimeState, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CommittedChangeError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    const runtimeUncertain = (operations as { runtime?: { isUncertain?: () => boolean } }).runtime?.isUncertain?.() === true;
    if (runtimeUncertain || causeIsUncertain(error)) {
      throw new GuardedRunError(`${label} failed and the last native result is uncertain, so nothing was undone; call plasticity_reconcile before anything else: ${detail}`, { uncertain: true, undoneSteps: 0, restored: false, cause: error });
    }
    let current: RuntimeState;
    try {
      current = await operations.state();
    } catch (readError) {
      throw new GuardedRunError(`${label} failed and the document could not be read again, so nothing was undone; call plasticity_reconcile: ${detail} (read: ${readError instanceof Error ? readError.message : String(readError)})`, { uncertain: true, undoneSteps: 0, restored: false, cause: error });
    }
    if (current.documentToken !== initial.documentToken) {
      throw new GuardedRunError(`${label} failed and the Plasticity document changed, so nothing was undone: ${detail}`, { uncertain: true, undoneSteps: 0, restored: false, cause: error });
    }
    let undone = 0;
    let stuck: string | undefined;
    try {
      while (current.undoDepth > initial.undoDepth && undone < MAX_UNDO) {
        const depth = current.undoDepth;
        current = await operations.undo(current.revision);
        undone += 1;
        if (current.undoDepth >= depth) { stuck = `Undo did not lower the Undo depth (${depth} -> ${current.undoDepth})`; break; }
      }
    } catch (undoError) {
      const remaining = Math.max(0, current.undoDepth - initial.undoDepth);
      throw new GuardedRunError(`${label} failed; undoing its steps failed after ${undone} Undo step(s) (${undoError instanceof Error ? undoError.message : String(undoError)}), so ${remaining} of its step(s) may remain; call plasticity_reconcile. The step error was: ${detail}`, { uncertain: true, undoneSteps: undone, restored: false, cause: error });
    }
    const restored = !stuck && current.documentToken === initial.documentToken && current.undoDepth === initial.undoDepth && sameBodyIds(current, initial);
    const where = restored
      ? `the document is unchanged (back to its ${initial.bodies.length} bodies at Undo depth ${initial.undoDepth}, revision ${current.revision})`
      : `but the document is not back at the start: ${stuck ?? `Undo depth ${current.undoDepth} (was ${initial.undoDepth}), ${current.bodies.length} bodies (was ${initial.bodies.length})`}, so ${Math.max(0, current.undoDepth - initial.undoDepth)} of its step(s) may remain; call plasticity_reconcile`;
    throw new GuardedRunError(`${label} failed; ${undone} Undo step(s) were undone and ${where}: ${detail}`, { uncertain: false, undoneSteps: undone, restored, cause: error });
  }
}

/** A read-back that does not prove the request, thrown inside runGuarded so the tool's own steps are undone. */
export class ReadBackError extends Error {}
export function readBackError(problems: string[]): ReadBackError {
  const shown = problems.slice(0, 8).join("; ") + (problems.length > 8 ? `; and ${problems.length - 8} more` : "");
  return new ReadBackError(`the read-back does not match: ${shown}`);
}

/** The read-back problems of a native B-Rep Check: closed and natively valid, as plasticity_validate_bodies reports it. */
export async function validityProblems(operations: { validateBodies: PlasticityOperations["validateBodies"] }, bodyId: number, revision: string): Promise<string[]> {
  try {
    const result = await operations.validateBodies([bodyId], revision);
    const body = result.bodies.find((candidate) => candidate.id === bodyId);
    if (!body) return [`native Check returned no result for body ${bodyId}`];
    if (body.type !== "Solid" || !body.closed || !body.nativeValid) return [`body ${bodyId} is not a closed, natively valid Solid (type ${body.type}, closed ${body.closed}, native Check codes ${JSON.stringify(body.nativeCheckCodes)})`];
    return [];
  } catch (error) {
    return [`native Check of body ${bodyId} failed: ${error instanceof Error ? error.message : String(error)}`];
  }
}

/** Read-back problems for edges shorter than MIN_FEATURE_MM (slivers). */
export function sliverProblems(body: Body): string[] {
  const short = body.edges.filter((edge) => edge.lengthMm < MIN_FEATURE_MM);
  if (short.length === 0) return [];
  return [`${short.length} edge(s) shorter than ${MIN_FEATURE_MM} mm (a sliver), the shortest ${round6([Math.min(...short.map((edge) => edge.lengthMm)), 0, 0])[0]} mm at ${JSON.stringify(round6(short[0]!.centerMm))}`];
}

/** Formats an angle so that a small nonzero angle never prints as zero. */
export function formatDeg(deg: number): string {
  return deg >= 1e-3 || deg === 0 ? deg.toFixed(6) : deg.toExponential(3);
}

// ---------- full-turn cylinder faces (the provable part of describe_body's cylinder logic) ----------

/** Sweep of one circle edge about its centre, from start, midpoint and end; 360 for a closed circle. Undefined without geometry. */
export function circleSweepDeg(edge: Edge): number | undefined {
  const geometry = edge.circleGeometry;
  if (!geometry) return undefined;
  const { centerMm: center, startMm: start, midpointMm: middle, endMm: end } = geometry;
  if (distance(start, end) < AXIS_END_MM) return 360;
  const first = sub(start, center);
  const last = sub(end, center);
  const mid = sub(middle, center);
  const lengths = length(first) * length(last);
  if (lengths < 1e-12) return undefined;
  const short = Math.acos(Math.max(-1, Math.min(1, dot(first, last) / lengths))) * 180 / Math.PI;
  const onShortSide = dot(mid, add(first, last)) >= 0;
  return onShortSide || short > 179.95 ? short : 360 - short;
}

export interface CylinderAxis {
  faceId: string;
  radiusMm: number;
  kind: "hole" | "boss";
  originMm: Vector3; // the face centre projected onto the axis
  direction: Vector3;
  extentMm: [number, number]; // the face's circle ends along `direction`, measured from the origin of direction (dot with direction)
  circleEdges: Edge[];
}

/**
 * The full-turn cylinder faces of one body: a Cylinder face that is not a blend, has an axis, and whose circle edges at
 * one end sweep 360 degrees (every circle edge must carry its geometry: an unmeasurable face is left out). Hole or boss
 * comes from the face normal at its centre against the axis; a face that says neither is left out.
 */
export function fullTurnCylinders(body: Body): CylinderAxis[] {
  const edgeById = new Map((body.edges ?? []).map((edge) => [edge.id, edge]));
  const found: CylinderAxis[] = [];
  for (const face of body.faces) {
    if (face.surfaceType !== "Cylinder" || face.radiusMm === null || !face.axisOriginMm || !face.axisDirection) continue;
    if (face.blendRadiusMm !== null && face.blendRadiusMm > 0) continue;
    const direction = unit(face.axisDirection, "Cylinder axis");
    const circleEdges = face.edgeIds.map((id) => edgeById.get(id)).filter((edge): edge is Edge => edge?.circle === true);
    if (circleEdges.length === 0 || circleEdges.some((edge) => !edge.circleGeometry)) continue;
    const ends = new Map<number, number>();
    let measurable = true;
    for (const edge of circleEdges) {
      const sweep = circleSweepDeg(edge);
      if (sweep === undefined) { measurable = false; break; }
      const key = Math.round(dot(edge.circleGeometry!.centerMm, direction) / AXIS_END_MM);
      ends.set(key, (ends.get(key) ?? 0) + sweep);
    }
    if (!measurable || ![...ends.values()].some((sweep) => sweep >= FULL_TURN_DEG)) continue;
    const along = dot(sub(face.centerMm, face.axisOriginMm), direction);
    const origin = add(face.axisOriginMm, scale(direction, along));
    const radial = sub(face.centerMm, origin);
    const radialLength = length(radial);
    const facing = radialLength > 1e-9 ? dot(face.normal, radial) / radialLength : 0;
    const kind = facing < -0.5 ? "hole" as const : facing > 0.5 ? "boss" as const : undefined;
    if (!kind) continue;
    const positions = circleEdges.map((edge) => dot(edge.circleGeometry!.centerMm, direction));
    found.push({ faceId: face.id, radiusMm: face.radiusMm, kind, originMm: origin, direction, extentMm: [Math.min(...positions), Math.max(...positions)], circleEdges });
  }
  return found;
}

// ---------- plasticity_place_body ----------

export const ANCHOR_POINTS = ["min", "max", "center", "bottom-center", "top-center", "x--center", "x+-center", "y--center", "y+-center", "z--center", "z+-center"] as const;
export type AnchorPoint = typeof ANCHOR_POINTS[number];

export function boundsAnchor(bounds: Bounds, point: AnchorPoint): Vector3 {
  const c = boundsCenter(bounds);
  switch (point) {
    case "min": return [...bounds.min];
    case "max": return [...bounds.max];
    case "center": return c;
    case "bottom-center": return [c[0], c[1], bounds.min[2]];
    case "top-center": return [c[0], c[1], bounds.max[2]];
    default: {
      const axis = "xyz".indexOf(point[0]!);
      const value = point[1] === "-" ? bounds.min[axis]! : bounds.max[axis]!;
      const result: Vector3 = [...c];
      result[axis] = value;
      return result;
    }
  }
}

/** Right-hand rotation by quarterTurns x 90 degrees about +axis, as an exact integer matrix (rows). */
export function quarterTurnMatrix(axis: "x" | "y" | "z", quarterTurns: number): number[][] {
  const k = ((quarterTurns % 4) + 4) % 4;
  const c = [1, 0, -1, 0][k]!;
  const s = [0, 1, 0, -1][k]!;
  if (axis === "x") return [[1, 0, 0], [0, c, -s], [0, s, c]];
  if (axis === "y") return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}
export const applyMatrix = (m: number[][], v: Vector3): Vector3 => clean([0, 1, 2].map((row) => m[row]![0]! * v[0] + m[row]![1]! * v[1] + m[row]![2]! * v[2]));
function rotateAbout(m: number[][], pivot: Vector3, point: Vector3): Vector3 { return add(pivot, applyMatrix(m, sub(point, pivot))); }
export function rotateBounds(m: number[][], pivot: Vector3, bounds: Bounds): Bounds {
  const corners: Vector3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) for (const z of [bounds.min[2], bounds.max[2]]) corners.push(rotateAbout(m, pivot, [x, y, z]));
  return {
    min: [0, 1, 2].map((i) => Math.min(...corners.map((corner) => corner[i]!))) as Vector3,
    max: [0, 1, 2].map((i) => Math.max(...corners.map((corner) => corner[i]!))) as Vector3,
  };
}

export interface PlaceAnchor { point?: AnchorPoint | undefined; faceId?: string | undefined }
export interface PlaceBodyInput {
  id: number;
  anchor: PlaceAnchor;
  to: PlaceAnchor & { bodyId: number };
  offsetMm?: Vector3 | undefined;
  gapMm?: number | undefined;
  rotate?: { axis: "x" | "y" | "z"; quarterTurns: 1 | 2 | 3 } | undefined;
  copy?: boolean | undefined;
  // Two faces: "mating" (the default) needs opposed normals; "aligned" places same-facing faces flush.
  relation?: "mating" | "aligned" | undefined;
  // A negative gapMm overlaps the bodies; it is refused unless this is true.
  allowOverlap?: boolean | undefined;
  revision: string;
}
export interface MateStep { operation: string; beforeRevision: string; afterRevision: string; affectedBodyIds: number[] }
export interface PlaceBodyResult {
  recipe: "place-body";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  bodyId: number;
  copiedFromId?: number;
  relation?: "mating" | "parallel";
  rotation?: { axis: "x" | "y" | "z"; quarterTurns: number; pivotMm: Vector3 };
  deltaMm: Vector3;
  anchorMm: Vector3;
  boundsMm: Bounds;
  movedFaceId?: string;
  undoSteps: number;
  steps: MateStep[];
}
export type PlaceOperations = UndoCapable & Pick<PlasticityOperations, "move" | "rotate" | "duplicateBodies">;

function requireAnchor(anchor: PlaceAnchor, label: string): void {
  if ((anchor.point === undefined) === (anchor.faceId === undefined)) throw new Error(`${label} needs exactly one of point or faceId`);
}
function planarFace(body: Body, faceId: string, label: string): Face {
  const face = body.faces.find((candidate) => candidate.id === faceId);
  if (!face) throw new Error(`${label} face ${faceId} is not a current face of body ${body.id}`);
  if (!face.planar) throw new Error(`${label} face ${faceId} of body ${body.id} is not planar (${face.surfaceType})`);
  return face;
}
const angleDeg = (a: Vector3, b: Vector3): number => Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) * 180 / Math.PI;

/** Pure: the rigid transform place_body applies, from the current state. Throws the input errors before any native call. */
export function planPlacement(state: RuntimeState, input: PlaceBodyInput) {
  if (state.revision !== input.revision) throw new Error(`Stale reference: expected revision ${input.revision}, current revision is ${state.revision}`);
  requireAnchor(input.anchor, "anchor");
  requireAnchor(input.to, "to");
  const moving = state.bodies.find((body) => body.id === input.id);
  if (!moving) throw new Error(`Unknown body ID to move: ${input.id}`);
  if (moving.type !== "Solid" && moving.type !== "Sheet") throw new Error(`place_body moves a Solid or Sheet; body ${input.id} is a ${moving.type}`);
  if (!moving.boundsMm) throw new Error(`Body ${input.id} has no bounds`);
  const fixed = state.bodies.find((body) => body.id === input.to.bodyId);
  if (!fixed) throw new Error(`Unknown fixed body ID: ${input.to.bodyId}`);
  if (!fixed.boundsMm) throw new Error(`Body ${input.to.bodyId} has no bounds`);
  if (fixed.id === moving.id && !input.copy) throw new Error("to.bodyId is the body being moved; set copy: true to place a copy against the original");
  const bothFaces = input.anchor.faceId !== undefined && input.to.faceId !== undefined;
  if (input.gapMm !== undefined && !bothFaces) throw new Error("gapMm needs a faceId on both anchor and to; use offsetMm with bounds points");
  if (input.relation !== undefined && !bothFaces) throw new Error("relation needs a faceId on both anchor and to");
  if (input.gapMm !== undefined && input.gapMm < 0 && input.allowOverlap !== true) throw new Error(`gapMm ${input.gapMm} pushes the faces ${-input.gapMm} mm into each other, so the bodies would overlap; pass allowOverlap: true to place them so`);
  const pivot = boundsCenter(moving.boundsMm);
  const matrix = input.rotate ? quarterTurnMatrix(input.rotate.axis, input.rotate.quarterTurns) : quarterTurnMatrix("z", 0);
  const rotatedBounds = input.rotate ? rotateBounds(matrix, pivot, moving.boundsMm) : { min: [...moving.boundsMm.min] as Vector3, max: [...moving.boundsMm.max] as Vector3 };

  let movingPoint: Vector3;
  let movingNormal: Vector3 | undefined;
  if (input.anchor.faceId !== undefined) {
    const face = planarFace(moving, input.anchor.faceId, "anchor");
    movingPoint = rotateAbout(matrix, pivot, face.centerMm);
    movingNormal = unit(applyMatrix(matrix, face.normal), "anchor face normal");
  } else movingPoint = boundsAnchor(rotatedBounds, input.anchor.point!);

  let fixedPoint: Vector3;
  let fixedNormal: Vector3 | undefined;
  if (input.to.faceId !== undefined) {
    const face = planarFace(fixed, input.to.faceId, "to");
    fixedPoint = [...face.centerMm];
    fixedNormal = unit(face.normal, "to face normal");
  } else fixedPoint = boundsAnchor(fixed.boundsMm, input.to.point!);

  let relation: "mating" | "parallel" | undefined;
  if (movingNormal && fixedNormal) {
    const sine = parallelSine(movingNormal, fixedNormal);
    if (sine > MATE_PARALLEL_SINE) {
      const angle = angleDeg(movingNormal, fixedNormal);
      const offParallel = Math.min(angle, 180 - angle);
      throw new Error(`Faces are neither mating nor parallel${input.rotate ? " after the rotation" : ""}: anchor normal ${JSON.stringify(round6(movingNormal))}, to normal ${JSON.stringify(round6(fixedNormal))} (${formatDeg(angle)} degrees apart, ${formatDeg(offParallel)} degrees off parallel; sine ${sine.toExponential(3)}, limit ${MATE_PARALLEL_SINE}). place_body does not turn bodies to make faces mate; add rotate (quarter turns) or pick other faces`);
    }
    relation = dot(movingNormal, fixedNormal) < 0 ? "mating" : "parallel";
    const wanted = input.relation ?? "mating";
    if (wanted === "mating" && relation === "parallel") {
      throw new Error(`anchor face ${input.anchor.faceId} and to face ${input.to.faceId} face the same way${input.rotate ? " after the rotation" : ""} (normals ${JSON.stringify(round6(movingNormal))} and ${JSON.stringify(round6(fixedNormal))}): a mate needs opposed normals, and placing them flush would put the body inside the other. Flip the body (rotate with quarterTurns 2 about an axis in the face plane) or pass relation: "aligned" to place same-facing faces flush`);
    }
    if (wanted === "aligned" && relation === "mating") {
      throw new Error(`relation "aligned" asks for same-facing faces, but anchor face ${input.anchor.faceId} and to face ${input.to.faceId} have opposed normals (they mate); leave relation out for a mate`);
    }
  }
  const target = add(add(fixedPoint, fixedNormal && input.gapMm !== undefined ? scale(fixedNormal, input.gapMm) : [0, 0, 0]), input.offsetMm ?? [0, 0, 0]);
  const delta = clean(sub(target, movingPoint));
  return {
    moving, fixed, pivot, matrix, relation, movingNormal, target,
    rotatedBounds,
    expectedBounds: { min: add(rotatedBounds.min, delta), max: add(rotatedBounds.max, delta) } as Bounds,
    expectedFaceCenter: input.anchor.faceId !== undefined ? add(movingPoint, delta) : undefined,
    delta,
  };
}

export async function placeBody(operations: PlaceOperations, input: PlaceBodyInput): Promise<PlaceBodyResult> {
  const initial = await operations.state();
  const plan = planPlacement(initial, input);
  const steps: MateStep[] = [];
  const record = (operation: string, before: RuntimeState, after: RuntimeState, ids: number[]) => {
    if (after.documentToken !== before.documentToken) throw new Error("Plasticity document changed during place_body");
    steps.push({ operation, beforeRevision: before.revision, afterRevision: after.revision, affectedBodyIds: ids });
  };
  const moved = await runGuarded(operations, "place_body", initial, async () => {
    let current = initial;
    let bodyId = input.id;
    const hasDelta = plan.delta.some((value) => Math.abs(value) > 1e-12);
    if (input.copy) {
      const before = current;
      current = await operations.duplicateBodies([input.id], input.rotate ? [0, 0, 0] : plan.delta, current.revision);
      const known = new Set(before.bodies.map((body) => body.id));
      const added = current.bodies.filter((body) => !known.has(body.id));
      if (added.length !== 1) throw new Error(`Expected one copy of body ${input.id}, found ${added.length} new bodies`);
      bodyId = added[0]!.id;
      record("duplicate-body", before, current, [bodyId]);
    }
    if (input.rotate) {
      const before = current;
      current = await operations.rotate([bodyId], plan.pivot, AXES[input.rotate.axis], input.rotate.quarterTurns * 90, current.revision);
      record("rotate-body", before, current, [bodyId]);
    }
    if (hasDelta && !(input.copy && !input.rotate)) {
      const before = current;
      current = await operations.move([bodyId], plan.delta, current.revision);
      record("move-body", before, current, [bodyId]);
    }

    // Read back from a fresh state: the bounds, the anchor and the fixed body. A mismatch undoes the steps above.
    const final = await operations.state();
    const problems: string[] = [];
    const body = final.bodies.find((candidate) => candidate.id === bodyId);
    let movedFaceId: string | undefined;
    let anchorMm: Vector3 = plan.target;
    if (!body || !body.boundsMm) problems.push(`body ${bodyId} is missing after the move`);
    else {
      if (!boundsNear(body.boundsMm, plan.expectedBounds)) problems.push(`bounds ${JSON.stringify({ min: round6(body.boundsMm.min), max: round6(body.boundsMm.max) })} differ from the expected ${JSON.stringify({ min: round6(plan.expectedBounds.min), max: round6(plan.expectedBounds.max) })}`);
      if (input.anchor.point !== undefined) {
        anchorMm = boundsAnchor(body.boundsMm, input.anchor.point);
        if (distance(anchorMm, plan.target) > COINCIDENT_MM) problems.push(`anchor ${input.anchor.point} is at ${JSON.stringify(round6(anchorMm))}, ${distance(anchorMm, plan.target)} mm from the target ${JSON.stringify(round6(plan.target))}`);
      } else {
        const matches = body.faces.filter((face) => face.planar && parallelSine(face.normal, plan.movingNormal!) <= 1e-6 && dot(face.normal, plan.movingNormal!) > 0 && distance(face.centerMm, plan.expectedFaceCenter!) <= COINCIDENT_MM);
        if (matches.length !== 1) problems.push(`expected one planar face at ${JSON.stringify(round6(plan.expectedFaceCenter!))} with normal ${JSON.stringify(round6(plan.movingNormal!))} on body ${body.id}, found ${matches.length}`);
        else { movedFaceId = matches[0]!.id; anchorMm = [...matches[0]!.centerMm]; }
      }
    }
    const fixedAfter = final.bodies.find((candidate) => candidate.id === plan.fixed.id);
    if (plan.fixed.id !== bodyId && (!fixedAfter?.boundsMm || !boundsNear(fixedAfter.boundsMm, plan.fixed.boundsMm!, 1e-9))) problems.push(`the fixed body ${plan.fixed.id} changed`);
    if (input.copy) {
      const original = final.bodies.find((candidate) => candidate.id === input.id);
      if (!original?.boundsMm || !boundsNear(original.boundsMm, plan.moving.boundsMm!, 1e-9)) problems.push(`the original body ${input.id} changed`);
    }
    if (problems.length > 0) throw readBackError(problems);
    return { bodyId, final, body: body!, movedFaceId, anchorMm };
  });
  const { final, body, movedFaceId, anchorMm } = moved;
  return {
    recipe: "place-body",
    status: "completed",
    documentToken: final.documentToken,
    beforeRevision: initial.revision,
    afterRevision: final.revision,
    bodyId: moved.bodyId,
    ...(input.copy ? { copiedFromId: input.id } : {}),
    ...(plan.relation ? { relation: plan.relation } : {}),
    ...(input.rotate ? { rotation: { axis: input.rotate.axis, quarterTurns: input.rotate.quarterTurns, pivotMm: round6(plan.pivot) } } : {}),
    deltaMm: round6(plan.delta),
    anchorMm: round6(anchorMm),
    boundsMm: { min: round6(body!.boundsMm!.min), max: round6(body!.boundsMm!.max) },
    ...(movedFaceId ? { movedFaceId } : {}),
    undoSteps: final.undoDepth - initial.undoDepth,
    steps,
  };
}

// ---------- plasticity_transfer_holes ----------

export interface TransferSelect {
  radiusMm: number;
  toleranceMm?: number | undefined;
  axis?: "x" | "y" | "z" | Vector3 | undefined;
  // transfer_holes defaults to "hole". selectSourceAxes itself takes undefined as "any".
  kind?: "hole" | "boss" | "any" | undefined;
  withinMm?: Bounds | undefined;
}
export interface TransferHoleSpec {
  diameterMm: number;
  depthMm?: number | undefined;
  through?: true | undefined;
  countersunk?: { headDiameterMm: number } | undefined;
  counterbore?: { diameterMm: number; depthMm: number } | undefined;
}
export interface TransferHolesInput {
  sourceId: number;
  targetId: number;
  select?: TransferSelect | undefined;
  axesMm?: Array<{ pointMm: Vector3; axis: Vector3 }> | undefined;
  hole: TransferHoleSpec;
  // "error" (default): an axis that misses the target refuses the call. "skip": it is listed in skipped, the rest are cut.
  onMiss?: "error" | "skip" | undefined;
  revision: string;
}
export interface SourceAxis { pointMm: Vector3; direction: Vector3; faceIds: string[]; radiusMm?: number; kind?: "hole" | "boss" }
export interface PlannedHole {
  index: number;
  source: SourceAxis;
  entryPointMm: Vector3; // on the target's entry face
  direction: Vector3; // the drill direction, into the target
  entryFaceId: string;
  entryProof: "edges" | "bounds";
  farDistanceMm: number; // from the entry point to where the axis leaves the target bounds
  nextFaceMm?: number; // from the entry point to the next planar target face normal to the axis (the far side of the wall)
  wallMm?: number; // nextFaceMm when no other target face can lie on the axis before it: the proven local wall thickness
}
/** A per-axis refusal. code "miss" is the only one onMiss: "skip" passes over. */
export class AxisRefusal extends Error {
  readonly code: "miss" | "existing-hole" | "non-planar" | "between" | "rim" | "precedes";
  constructor(code: AxisRefusal["code"], message: string) { super(message); this.code = code; }
}
export interface TransferHolesResult {
  recipe: "transfer-holes";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  sourceId: number;
  targetId: number;
  axesMm: Array<{ pointMm: Vector3; axis: Vector3; entryPointMm: Vector3; entryFaceId: string; sourceFaceIds?: string[]; kind: "hole" | "boss" | "explicit" }>;
  axisCount: number; // axes cut
  holeCount: number; // separate bores proven by read-back (one axis through both walls of a U is 2)
  targetHoleCount: number; // equals holeCount
  holes: Array<{ axisIndex: number; holeFaceId: string; axisOriginMm: Vector3; axisDirection: Vector3; coaxialOffsetMm: number; bores: number }>;
  skipped?: Array<{ axisIndex: number; pointMm: Vector3; axis: Vector3; reason: string }>;
  maxCoaxialOffsetMm: number;
  undoSteps: number;
  steps: MateStep[];
}
export type TransferOperations = RecipeOperations & UndoCapable & { validateBodies: PlasticityOperations["validateBodies"] };

/** Distinct full-turn cylinder radii of a body (for the no-match error), with kind and the number of distinct axes. */
export function cylinderRadiiSummary(body: Body): Array<{ radiusMm: number; kind: "hole" | "boss"; axes: number }> {
  const groups = new Map<string, { radiusMm: number; kind: "hole" | "boss"; axes: SourceAxis[] }>();
  for (const cylinder of fullTurnCylinders(body)) {
    const key = `${Math.round(cylinder.radiusMm * 1e4)}|${cylinder.kind}`;
    const group = groups.get(key) ?? { radiusMm: Math.round(cylinder.radiusMm * 1e4) / 1e4, kind: cylinder.kind, axes: [] };
    groups.set(key, group);
    if (!group.axes.some((axis) => coaxialOffset(axis.pointMm, axis.direction, cylinder.originMm, cylinder.direction) <= COINCIDENT_MM)) group.axes.push({ pointMm: cylinder.originMm, direction: cylinder.direction, faceIds: [cylinder.faceId] });
  }
  return [...groups.values()].sort((a, b) => a.radiusMm - b.radiusMm || a.kind.localeCompare(b.kind)).map((group) => ({ radiusMm: group.radiusMm, kind: group.kind, axes: group.axes.length }));
}

/** Pure: the source axes a selection picks, coaxial faces merged into one axis. */
export function selectSourceAxes(body: Body, select: TransferSelect): SourceAxis[] {
  const tolerance = select.toleranceMm ?? 0.01;
  const wanted = select.axis === undefined ? undefined : typeof select.axis === "string" ? AXES[select.axis] : unit(select.axis, "select.axis");
  const picked: SourceAxis[] = [];
  for (const cylinder of fullTurnCylinders(body)) {
    if (Math.abs(cylinder.radiusMm - select.radiusMm) > tolerance) continue;
    if (select.kind && select.kind !== "any" && cylinder.kind !== select.kind) continue;
    if (wanted && parallelSine(cylinder.direction, wanted) > PARALLEL_SINE) continue;
    if (select.withinMm && ![0, 1, 2].every((i) => cylinder.originMm[i]! >= select.withinMm!.min[i]! - COINCIDENT_MM && cylinder.originMm[i]! <= select.withinMm!.max[i]! + COINCIDENT_MM)) continue;
    const known = picked.find((axis) => coaxialOffset(axis.pointMm, axis.direction, cylinder.originMm, cylinder.direction) <= COINCIDENT_MM);
    if (known) known.faceIds.push(cylinder.faceId);
    else picked.push({ pointMm: cylinder.originMm, direction: cylinder.direction, faceIds: [cylinder.faceId], radiusMm: cylinder.radiusMm, kind: cylinder.kind });
  }
  return picked;
}

// Point-in-planar-face from the face's own edges (lines and measured circles): exact, or undefined when an edge is
// of another kind or carries no geometry. Returns the boundary distance as well.
type Planar2D = { origin: Vector3; u: Vector3; v: Vector3 };
const to2d = (frame: Planar2D, point: Vector3): [number, number] => [dot(sub(point, frame.origin), frame.u), dot(sub(point, frame.origin), frame.v)];
const RAY: [number, number] = [Math.cos(0.9083), Math.sin(0.9083)];
const ccw = (from: number, to: number): number => { let d = to - from; while (d < 0) d += 2 * Math.PI; while (d >= 2 * Math.PI) d -= 2 * Math.PI; return d; };

export function pointInPlanarFace(body: Body, face: Face, point: Vector3): { inside: boolean; boundaryDistanceMm: number } | undefined {
  const normal = unit(face.normal, "face normal");
  const u = perpendicular(normal);
  const frame: Planar2D = { origin: face.centerMm, u, v: cross(normal, u) };
  const q = to2d(frame, point);
  const edgeById = new Map(body.edges.map((edge) => [edge.id, edge]));
  let crossings = 0;
  let nearest = Number.POSITIVE_INFINITY;
  for (const edgeId of face.edgeIds) {
    const edge = edgeById.get(edgeId);
    if (!edge) return undefined;
    if (edge.line) {
      const half = scale(unit(edge.tangent, "edge tangent"), edge.lengthMm / 2);
      const a = to2d(frame, sub(edge.centerMm, half));
      const b = to2d(frame, add(edge.centerMm, half));
      const ab: [number, number] = [b[0] - a[0], b[1] - a[1]];
      const abLength2 = ab[0] ** 2 + ab[1] ** 2;
      const t = abLength2 > 0 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1]) / abLength2)) : 0;
      nearest = Math.min(nearest, Math.hypot(q[0] - a[0] - t * ab[0], q[1] - a[1] - t * ab[1]));
      const denominator = RAY[0] * ab[1] - RAY[1] * ab[0];
      if (Math.abs(denominator) > 1e-15) {
        const s = ((a[0] - q[0]) * ab[1] - (a[1] - q[1]) * ab[0]) / denominator; // along the ray
        const w = ((a[0] - q[0]) * RAY[1] - (a[1] - q[1]) * RAY[0]) / denominator; // along the segment
        if (s > 0 && w >= 0 && w < 1) crossings += 1;
      }
    } else if (edge.circle && edge.circleGeometry) {
      const g = edge.circleGeometry;
      const c = to2d(frame, g.centerMm);
      const r = g.radiusMm;
      const angle = (p: [number, number]) => Math.atan2(p[1] - c[1], p[0] - c[0]);
      const full = distance(g.startMm, g.endMm) < AXIS_END_MM;
      const s0 = angle(to2d(frame, g.startMm));
      const m0 = angle(to2d(frame, g.midpointMm));
      const e0 = angle(to2d(frame, g.endMm));
      const ccwArc = ccw(s0, m0) <= ccw(s0, e0);
      const onArc = (theta: number) => full || (ccwArc ? ccw(s0, theta) <= ccw(s0, e0) : ccw(e0, theta) <= ccw(e0, s0));
      const qAngle = angle(q);
      const radial = Math.hypot(q[0] - c[0], q[1] - c[1]);
      nearest = Math.min(nearest, onArc(qAngle) ? Math.abs(radial - r) : Math.min(...[g.startMm, g.endMm].map((p) => { const p2 = to2d(frame, p); return Math.hypot(q[0] - p2[0], q[1] - p2[1]); })));
      // ray-circle: |q + s RAY - c|^2 = r^2
      const fx = q[0] - c[0];
      const fy = q[1] - c[1];
      const b = fx * RAY[0] + fy * RAY[1];
      const disc = b * b - (fx * fx + fy * fy - r * r);
      if (disc > 0) {
        const root = Math.sqrt(disc);
        for (const s of [-b - root, -b + root]) {
          if (s <= 0) continue;
          const hit: [number, number] = [q[0] + s * RAY[0], q[1] + s * RAY[1]];
          const theta = angle(hit);
          // Half-open at the end point so a vertex shared by two arcs or an arc and a line counts once.
          if (full || (onArc(theta) && Math.hypot(hit[0] - to2d(frame, g.endMm)[0], hit[1] - to2d(frame, g.endMm)[1]) > 1e-12)) crossings += 1;
        }
      }
    } else return undefined;
  }
  return { inside: crossings % 2 === 1, boundaryDistanceMm: nearest };
}

/** Where a line enters and leaves a box: [sIn, sOut] along a unit direction, or undefined when it misses. */
export function lineBoxSpan(point: Vector3, direction: Vector3, bounds: Bounds): [number, number] | undefined {
  let low = Number.NEGATIVE_INFINITY;
  let high = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i += 1) {
    const d = direction[i]!;
    if (Math.abs(d) < 1e-15) {
      if (point[i]! < bounds.min[i]! - COINCIDENT_MM || point[i]! > bounds.max[i]! + COINCIDENT_MM) return undefined;
      continue;
    }
    const a = (bounds.min[i]! - point[i]!) / d;
    const b = (bounds.max[i]! - point[i]!) / d;
    low = Math.max(low, Math.min(a, b));
    high = Math.min(high, Math.max(a, b));
  }
  return low <= high + COINCIDENT_MM ? [low, high] : undefined;
}

const describeAxis = (index: number, axis: SourceAxis) => `axis ${index} (point ${JSON.stringify(round6(axis.pointMm))}, direction ${JSON.stringify(round6(axis.direction))})`;

/**
 * Pure: the entry of one axis into the target. The axis sign is ignored: the drill runs from the reference point (the
 * source face's axis point, or pointMm) toward the side where the target is. The entry is the first planar target face,
 * normal to the axis, that the line crosses going away from the reference point; its outward normal must face the
 * reference point and the hole rim (entryRadiusMm) must lie inside it.
 */
export function planEntry(target: Body, axis: SourceAxis, index: number, entryRadiusMm: number): PlannedHole {
  if (!target.boundsMm) throw new Error(`Target body ${target.id} has no bounds`);
  const d = unit(axis.direction, "axis");
  const label = describeAxis(index, axis);
  // An existing hole on this axis (an inward-facing cylinder or cone, such as a bore or a countersink): the tool cuts new
  // holes only, it never re-cuts or enlarges one. An outward face on the axis (a rod, a boss, a round corner) is no hole;
  // a coaxial face whose facing cannot be proven is refused too, since it might be one.
  for (const face of target.faces) {
    if ((face.surfaceType !== "Cylinder" && face.surfaceType !== "Cone") || !face.axisOriginMm || !face.axisDirection) continue;
    if (parallelSine(face.axisDirection, d) > MATE_PARALLEL_SINE || length(cross(sub(face.axisOriginMm, axis.pointMm), d)) > 1e-3) continue;
    const facing = surfaceFacing(face);
    if (facing === "boss") continue;
    const where = `(face ${face.id}${face.radiusMm !== null ? `, radius ${round6([face.radiusMm, 0, 0])[0]} mm` : ""})`;
    if (facing === "hole") throw new AxisRefusal("existing-hole", `${label}: the target already has a hole on this axis ${where}; transfer_holes cuts new holes only and does not re-cut or enlarge an existing one`);
    throw new AxisRefusal("existing-hole", `${label}: the target has a ${face.surfaceType.toLowerCase()} face on this axis ${where} whose facing cannot be proven, so it may be an existing hole; transfer_holes cuts new holes only`);
  }
  const span = lineBoxSpan(axis.pointMm, d, target.boundsMm);
  if (!span || span[1] - span[0] <= COINCIDENT_MM) throw new AxisRefusal("miss", `${label} misses the target body ${target.id} (its bounds)`);
  const all = planarCrossings(target, axis.pointMm, d);
  if (all.length === 0) {
    const touched = target.faces.filter((face) => lineMayTouchFace(target, face, axis.pointMm, d));
    if (touched.length === 0) throw new AxisRefusal("miss", `${label} misses the target body ${target.id} (no face of it lies on the axis)`);
    throw new AxisRefusal("non-planar", `${label} crosses no planar face of the target normal to the axis: it meets the target only through non-planar, oblique or tangent faces (${touched.slice(0, 4).map((face) => `${face.id} ${face.surfaceType}`).join(", ")}), and a non-planar or oblique entry is not supported`);
  }
  const ahead = all.filter((crossing) => crossing.s > COINCIDENT_MM);
  const behind = all.filter((crossing) => crossing.s < -COINCIDENT_MM);
  // A target face through the reference point itself (a part touching the source face the point lies on) is the entry
  // when the rest of the target lies on one side.
  const onPoint = all.filter((crossing) => Math.abs(crossing.s) <= COINCIDENT_MM);
  if (ahead.length > 0 && behind.length > 0) {
    throw new AxisRefusal("between", `${label}: the reference point lies between target faces (the target is on both sides of it along the axis); give axesMm with a point outside the target on the entry side`);
  }
  const sign = behind.length > 0 ? -1 : ahead.length > 0 ? 1 : onPoint.length > 0 && dot(onPoint[0]!.face.normal, d) > 0 ? -1 : 1;
  const direction = clean(scale(d, sign));
  const crossings = [...onPoint.map((crossing) => ({ ...crossing, s: 0 })), ...(sign > 0 ? ahead : behind).map((crossing) => ({ ...crossing, s: crossing.s * sign }))].sort((a, b) => a.s - b.s);
  const first = crossings[0]!;
  if (dot(first.face.normal, direction) >= 0) throw new AxisRefusal("non-planar", `${label}: the first planar target face along the axis (${first.face.id}) faces away from the source, so the axis enters the target through a non-planar face: a non-planar or oblique entry is not supported`);
  if (first.boundary < entryRadiusMm + 1e-3) throw new AxisRefusal("rim", `${label}: the hole rim (radius ${entryRadiusMm} mm) does not fit inside the entry face ${first.face.id} (${first.boundary.toFixed(4)} mm to its edge)`);
  const entryPointMm = add(axis.pointMm, scale(direction, first.s));
  // The entry must be the first material on the axis: no other target face may lie on the bore before the entry plane.
  // Decided conservatively in the drill's frame: the face's extent (from its line and circle edges for a planar face,
  // from its bounds otherwise) starts before the plane and reaches within the rim radius of the axis.
  for (const face of target.faces) {
    if (face.id === first.face.id) continue;
    const extent = faceExtentAlong(target, face, entryPointMm, direction);
    if (extent.sMin >= -1e-3 || extent.lateralMm > entryRadiusMm + 1e-3) continue;
    throw new AxisRefusal("precedes", `${label}: target face ${face.id} (${face.surfaceType}) may lie on the bore before the entry face ${first.face.id} (it starts ${round6([-extent.sMin, 0, 0])[0]} mm before the entry plane): material precedes the first planar face, and the hole would skip it`);
  }
  const exit = lineBoxSpan(entryPointMm, direction, target.boundsMm)!;
  // The far side of the wall: the next planar face normal to the axis. It is the proven wall thickness only when no
  // other face (curved, oblique, a plane through the axis, or a face known only by its bounds) can lie on the axis first.
  const next = crossings.find((crossing) => crossing.s > first.s + COINCIDENT_MM);
  const nextFaceMm = next ? next.s - first.s : undefined;
  const reach = nextFaceMm ?? exit[1];
  const crossingIds = new Set(crossings.filter((crossing) => crossing.proof === "edges").map((crossing) => crossing.face.id));
  const unproven = target.faces.some((face) => {
    if (face.id === first.face.id || crossingIds.has(face.id)) return false;
    if (face.planar && parallelSine(face.normal, direction) <= PARALLEL_SINE && pointInPlanarFace(target, face, add(entryPointMm, scale(direction, dot(sub(face.centerMm, entryPointMm), direction))))) return false;
    if (face.planar && Math.abs(dot(unit(face.normal), direction)) <= PARALLEL_SINE && Math.abs(dot(sub(entryPointMm, face.centerMm), unit(face.normal))) > COINCIDENT_MM) return false;
    const hit = lineBoxSpan(entryPointMm, direction, grow(face.boundsMm, 1e-3));
    return !!hit && hit[1] > COINCIDENT_MM && hit[0] < reach - COINCIDENT_MM;
  });
  return {
    index, source: axis, entryPointMm, direction, entryFaceId: first.face.id, entryProof: first.proof, farDistanceMm: exit[1],
    ...(nextFaceMm !== undefined ? { nextFaceMm } : {}),
    ...(nextFaceMm !== undefined && !unproven && next!.proof === "edges" ? { wallMm: nextFaceMm } : {}),
  };
}

/**
 * A conservative extent of a face in the frame of a line (origin, unit direction): the least position along the line and
 * the distance from the line to the face's box across it. A planar face lies in the hull of its edges, so its line and
 * measured circle edges bound it; any other face (or a planar one with other edges) is bounded by its bounds box.
 */
function faceExtentAlong(body: Body, face: Face, origin: Vector3, direction: Vector3): { sMin: number; lateralMm: number } {
  const u = perpendicular(direction);
  const v = cross(direction, u);
  const frame = [direction, u, v];
  const low = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const high = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const take = (point: Vector3, spread: (axis: Vector3) => number = () => 0) => frame.forEach((axis, i) => {
    const at = dot(sub(point, origin), axis);
    const by = spread(axis);
    low[i] = Math.min(low[i]!, at - by);
    high[i] = Math.max(high[i]!, at + by);
  });
  const edgeById = new Map(body.edges.map((edge) => [edge.id, edge]));
  const edges = face.edgeIds.map((id) => edgeById.get(id));
  const fromEdges = face.planar && edges.length > 0 && edges.every((edge) => !!edge && (edge.line || (edge.circle && !!edge.circleGeometry)));
  if (fromEdges) {
    for (const edge of edges as Edge[]) {
      if (edge.line) {
        const half = scale(unit(edge.tangent, "edge tangent"), edge.lengthMm / 2);
        take(sub(edge.centerMm, half));
        take(add(edge.centerMm, half));
      } else {
        const g = edge.circleGeometry!;
        const normal = unit(g.normal, "circle normal");
        take(g.centerMm, (axis) => g.radiusMm * Math.sqrt(Math.max(0, 1 - dot(normal, axis) ** 2)));
      }
    }
  } else for (const corner of boxCorners(face.boundsMm)) take(corner);
  const gap = (i: number) => Math.max(0, low[i]!, -high[i]!);
  return { sMin: low[0]!, lateralMm: Math.hypot(gap(1), gap(2)) };
}

const boxCorners = (box: Bounds): Vector3[] => {
  const corners: Vector3[] = [];
  for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) corners.push([x, y, z]);
  return corners;
};
const grow = (box: Bounds, by: number): Bounds => ({ min: box.min.map((value) => value - by) as Vector3, max: box.max.map((value) => value + by) as Vector3 });

/** A cylinder or cone face: hole (normal toward its axis), boss (away from it), or undefined when the normal says neither. */
function surfaceFacing(face: Face): "hole" | "boss" | undefined {
  if (!face.axisOriginMm || !face.axisDirection) return undefined;
  const direction = unit(face.axisDirection, "surface axis");
  const origin = add(face.axisOriginMm, scale(direction, dot(sub(face.centerMm, face.axisOriginMm), direction)));
  const radial = sub(face.centerMm, origin);
  const radialLength = length(radial);
  const facing = radialLength > 1e-9 ? dot(face.normal, radial) / radialLength : 0;
  return facing < -0.5 ? "hole" : facing > 0.5 ? "boss" : undefined;
}

/**
 * Can the line touch this face? Exact for a planar face normal to the line with line and circle edges (inside or on its
 * boundary) and for a planar face parallel to the line (only when the line lies in its plane); from the face bounds
 * otherwise.
 */
function lineMayTouchFace(body: Body, face: Face, point: Vector3, d: Vector3): boolean {
  // A cylinder whose axis runs along the line meets it only where the line lies on the cylinder.
  if (face.surfaceType === "Cylinder" && face.radiusMm !== null && face.axisOriginMm && face.axisDirection && parallelSine(face.axisDirection, d) <= PARALLEL_SINE) {
    return Math.abs(length(cross(sub(point, face.axisOriginMm), d)) - face.radiusMm) <= COINCIDENT_MM;
  }
  if (face.planar) {
    const n = unit(face.normal, "face normal");
    if (parallelSine(n, d) <= PARALLEL_SINE) {
      const hit = add(point, scale(d, dot(sub(face.centerMm, point), d)));
      const exact = pointInPlanarFace(body, face, hit);
      if (exact) return exact.inside || exact.boundaryDistanceMm <= COINCIDENT_MM;
    } else if (Math.abs(dot(n, d)) <= PARALLEL_SINE && Math.abs(dot(sub(point, face.centerMm), n)) > COINCIDENT_MM) return false;
  }
  return !!lineBoxSpan(point, d, grow(face.boundsMm, 1e-3));
}

/** Planar faces normal to a line that the line crosses inside the face, with the signed position s along d. */
function planarCrossings(target: Body, point: Vector3, d: Vector3): Array<{ face: Face; s: number; proof: "edges" | "bounds"; boundary: number }> {
  const crossings: Array<{ face: Face; s: number; proof: "edges" | "bounds"; boundary: number }> = [];
  for (const face of target.faces) {
    if (!face.planar || parallelSine(face.normal, d) > PARALLEL_SINE) continue;
    const s = dot(sub(face.centerMm, point), d);
    const hit = add(point, scale(d, s));
    const exact = pointInPlanarFace(target, face, hit);
    if (exact) {
      if (exact.inside || exact.boundaryDistanceMm <= COINCIDENT_MM) crossings.push({ face, s, proof: "edges", boundary: exact.inside ? exact.boundaryDistanceMm : 0 });
    } else {
      const inBounds = [0, 1, 2].every((i) => hit[i]! >= face.boundsMm.min[i]! - 1e-3 && hit[i]! <= face.boundsMm.max[i]! + 1e-3);
      if (inBounds) {
        const boundary = Math.min(...[0, 1, 2].filter((i) => face.boundsMm.max[i]! - face.boundsMm.min[i]! > 1e-3).map((i) => Math.min(hit[i]! - face.boundsMm.min[i]!, face.boundsMm.max[i]! - hit[i]!)));
        crossings.push({ face, s, proof: "bounds", boundary });
      }
    }
  }
  return crossings;
}

function validateTransfer(input: TransferHolesInput): void {
  if ((input.select === undefined) === (input.axesMm === undefined)) throw new Error("transfer_holes needs exactly one of select or axesMm");
  if (input.sourceId === input.targetId) throw new Error("sourceId and targetId must be different bodies");
  const hole = input.hole;
  if (!(hole.diameterMm > 0)) throw new Error("hole.diameterMm must be positive");
  if ((hole.depthMm === undefined) === (hole.through === undefined)) throw new Error("hole needs exactly one of depthMm or through: true");
  if (hole.countersunk && hole.counterbore) throw new Error("hole takes countersunk or counterbore, not both");
  if ((hole.countersunk || hole.counterbore) && !hole.through) throw new Error("countersunk and counterbore holes are through holes: set through: true");
  if (hole.countersunk && !(hole.countersunk.headDiameterMm > hole.diameterMm)) throw new Error("countersunk.headDiameterMm must be larger than diameterMm");
  if (hole.counterbore && !(hole.counterbore.diameterMm > hole.diameterMm)) throw new Error("counterbore.diameterMm must be larger than diameterMm");
}

const entryRadius = (hole: TransferHoleSpec): number => (hole.counterbore ? hole.counterbore.diameterMm / 2 : hole.countersunk ? hole.countersunk.headDiameterMm / 2 : hole.diameterMm / 2);
const OVERSHOOT_MM = 0.5;

export interface TransferPlan { source: Body; target: Body; holes: PlannedHole[]; skipped: NonNullable<TransferHolesResult["skipped"]> }

export function planTransfer(state: RuntimeState, input: TransferHolesInput): TransferPlan {
  validateTransfer(input);
  if (state.revision !== input.revision) throw new Error(`Stale reference: expected revision ${input.revision}, current revision is ${state.revision}`);
  const source = state.bodies.find((body) => body.id === input.sourceId);
  if (!source) throw new Error(`Unknown source body ID: ${input.sourceId}`);
  const target = state.bodies.find((body) => body.id === input.targetId);
  if (!target) throw new Error(`Unknown target body ID: ${input.targetId}`);
  if (target.type !== "Solid") throw new Error(`transfer_holes target must be a Solid: ${input.targetId} is a ${target.type}`);
  let axes: SourceAxis[];
  if (input.select) {
    // Holes only by default: a boss (or a cylinder whose facing cannot be proven) is never transferred as a hole.
    const select = { ...input.select, kind: input.select.kind ?? "hole" };
    axes = selectSourceAxes(source, select);
    if (axes.length === 0) {
      throw new Error(`select matched no full-turn cylinder axis on source body ${source.id}: ${JSON.stringify({ ...select, toleranceMm: input.select.toleranceMm ?? 0.01 })}. Full-turn cylinder radii on the source: ${JSON.stringify(cylinderRadiiSummary(source))}`);
    }
  } else {
    axes = input.axesMm!.map((axis) => ({ pointMm: [...axis.pointMm] as Vector3, direction: unit(axis.axis, "axesMm axis"), faceIds: [] }));
    for (let a = 0; a < axes.length; a += 1) for (let b = a + 1; b < axes.length; b += 1) {
      if (coaxialOffset(axes[a]!.pointMm, axes[a]!.direction, axes[b]!.pointMm, axes[b]!.direction) <= COINCIDENT_MM) throw new Error(`axesMm ${a} and ${b} are the same axis`);
    }
  }
  if (axes.length > 64) throw new Error(`transfer_holes cuts at most 64 holes; the selection matched ${axes.length} axes`);
  const radius = entryRadius(input.hole);
  // Two parallel axes closer than the widest diameter of the hole (its countersink head or counterbore) would overlap.
  for (let a = 0; a < axes.length; a += 1) for (let b = a + 1; b < axes.length; b += 1) {
    const first = axes[a]!;
    const second = axes[b]!;
    if (parallelSine(first.direction, second.direction) > MATE_PARALLEL_SINE) continue;
    const apart = length(cross(sub(second.pointMm, first.pointMm), unit(first.direction)));
    if (apart < 2 * radius) throw new Error(`${describeAxis(a, first)} and ${describeAxis(b, second)} are ${apart.toFixed(4)} mm apart, closer than the Ø${2 * radius} mm ${input.hole.counterbore ? "counterbore" : input.hole.countersunk ? "countersink head" : "hole"}: the holes would overlap`);
  }
  const holes: PlannedHole[] = [];
  const skipped: TransferPlan["skipped"] = [];
  for (const [index, axis] of axes.entries()) {
    try {
      holes.push(planEntry(target, axis, index, radius));
    } catch (error) {
      if (!(error instanceof AxisRefusal) || error.code !== "miss" || input.onMiss !== "skip") throw error;
      skipped.push({ axisIndex: index, pointMm: round6(axis.pointMm), axis: round6(axis.direction), reason: error.message });
    }
  }
  if (holes.length === 0) throw new Error(`every axis misses the target body ${target.id}, so there is nothing to cut: ${skipped.slice(0, 4).map((entry) => entry.reason).join("; ")}`);
  for (const hole of holes) {
    const label = describeAxis(hole.index, hole.source);
    if (input.hole.depthMm !== undefined && input.hole.depthMm >= hole.farDistanceMm - 1e-6) throw new Error(`${label}: depthMm ${input.hole.depthMm} reaches the far side of the target (${hole.farDistanceMm.toFixed(4)} mm along the axis); use through: true`);
    // The local wall: the next target face on the axis. At least MIN_FEATURE_MM of material stays under a floor.
    const wall = hole.nextFaceMm;
    const wallText = wall === undefined ? "" : `the next target face on the axis is ${wall.toFixed(4)} mm from the entry (the local wall thickness)`;
    if (wall !== undefined && input.hole.depthMm !== undefined && input.hole.depthMm > wall - MIN_FEATURE_MM) throw new Error(`${label}: depthMm ${input.hole.depthMm} reaches the far side of the wall: ${wallText}, and at least ${MIN_FEATURE_MM} mm must stay under the floor; use a smaller depthMm or through: true`);
    if (input.hole.counterbore && input.hole.counterbore.depthMm >= hole.farDistanceMm - 1e-6) throw new Error(`${label}: counterbore depth reaches the far side of the target`);
    if (wall !== undefined && input.hole.counterbore && input.hole.counterbore.depthMm > wall - MIN_FEATURE_MM) throw new Error(`${label}: counterbore depth ${input.hole.counterbore.depthMm} reaches the far side of the wall: ${wallText}`);
    const sink = input.hole.countersunk ? (input.hole.countersunk.headDiameterMm - input.hole.diameterMm) / 2 : undefined;
    if (sink !== undefined && sink >= hole.farDistanceMm - 1e-6) throw new Error(`${label}: countersink depth reaches the far side of the target`);
    if (sink !== undefined && wall !== undefined && sink > wall - MIN_FEATURE_MM) throw new Error(`${label}: the ${sink} mm deep countersink reaches the far side of the wall: ${wallText}`);
  }
  return { source, target, holes, skipped };
}

// Pattern recipes share one axis and one material depth, so holes group by both.
function groupKey(hole: PlannedHole): string {
  return `${round6(hole.direction).join(",")}|${Math.round(hole.farDistanceMm * 1e6)}`;
}

/** Circle and boundary checks of one cylinder face cut by the tool: every end a full turn, no edge shared with a side wall. */
function breakoutProblem(face: Face, edgeById: Map<string, Edge>, direction: Vector3): string | undefined {
  const ends = new Map<number, number>();
  for (const id of face.edgeIds) {
    const edge = edgeById.get(id);
    if (!edge) return `edge ${id} of cylinder face ${face.id} is missing`;
    if (edge.circle) {
      const sweep = circleSweepDeg(edge);
      if (sweep === undefined) return `circle edge ${edge.id} of cylinder face ${face.id} carries no geometry, so the bore cannot be proven whole`;
      const key = Math.round(dot(edge.circleGeometry!.centerMm, direction) / AXIS_END_MM);
      ends.set(key, (ends.get(key) ?? 0) + sweep);
      continue;
    }
    // A seam line borders only its own face; any other edge borders a side wall the bore cuts into.
    const others = edge.faceIds.filter((other) => other !== face.id);
    if (others.length > 0) return `cylinder face ${face.id} has a ${edge.curveType} edge ${edge.id} on face ${others[0]}`;
  }
  for (const [key, sweep] of ends) if (sweep < FULL_TURN_DEG) return `cylinder face ${face.id} ends in a partial circle (${sweep.toFixed(1)} degrees) ${(key * AXIS_END_MM).toFixed(3)} mm along the axis`;
  if (ends.size < 2) return `cylinder face ${face.id} has ${ends.size} circle end(s), not two`;
  return undefined;
}

/** Separate bores of one radius on one axis: cylinder faces merged where their axial extents meet. */
function countBores(faces: Face[], edgeById: Map<string, Edge>, direction: Vector3): number {
  const spans = faces.map((face) => {
    const positions = face.edgeIds.map((id) => edgeById.get(id)).filter((edge): edge is Edge => !!edge?.circleGeometry).map((edge) => dot(edge.circleGeometry!.centerMm, direction));
    return positions.length > 0 ? [Math.min(...positions), Math.max(...positions)] as [number, number] : undefined;
  }).filter((span): span is [number, number] => !!span).sort((a, b) => a[0] - b[0]);
  let count = 0;
  let end = Number.NEGATIVE_INFINITY;
  for (const span of spans) {
    if (span[0] > end + AXIS_END_MM) count += 1;
    end = Math.max(end, span[1]);
  }
  return count;
}

export async function transferHoles(operations: TransferOperations, input: TransferHolesInput): Promise<TransferHolesResult> {
  const initial = await operations.state();
  const plan = planTransfer(initial, input);
  const spec = input.hole;
  const steps: MateStep[] = [];
  const recipes = new PlasticityRecipes(operations);
  const groups = new Map<string, PlannedHole[]>();
  for (const hole of plan.holes) groups.set(groupKey(hole), [...(groups.get(groupKey(hole)) ?? []), hole]);

  const done = await runGuarded(operations, "transfer_holes", initial, async () => {
    let target = input.targetId;
    let revision = initial.revision;
    for (const group of groups.values()) {
      const axis = group[0]!.direction;
      const depth = group[0]!.farDistanceMm;
      const centers = group.map((hole) => hole.entryPointMm);
      const common = { targetId: target, axis, overshootMm: OVERSHOOT_MM, revision };
      let result: { resultBodyIds: number[]; recipe: string; beforeRevision: string; afterRevision: string };
      if (spec.countersunk) {
        const shared = { ...common, radialDirection: perpendicular(axis), throughDiameterMm: spec.diameterMm, countersinkMajorDiameterMm: spec.countersunk.headDiameterMm, includedAngleDeg: 90, throughDepthMm: depth, keepProfile: false };
        result = centers.length === 1 ? await recipes.createCountersink({ ...shared, entryCenterMm: centers[0]! }) : await recipes.createCountersinkPattern({ ...shared, entryCentersMm: centers });
      } else if (spec.counterbore) {
        const shared = { ...common, throughDiameterMm: spec.diameterMm, counterboreDiameterMm: spec.counterbore.diameterMm, counterboreDepthMm: spec.counterbore.depthMm, throughDepthMm: depth };
        result = centers.length === 1 ? await recipes.createCounterbore({ ...shared, entryCenterMm: centers[0]! }) : await recipes.createCounterborePattern({ ...shared, entryCentersMm: centers });
      } else if (spec.through) {
        const shared = { ...common, holeDiameterMm: spec.diameterMm, throughDepthMm: depth };
        result = centers.length === 1 ? await recipes.createThroughHole({ ...shared, entryCenterMm: centers[0]! }) : await recipes.createThroughHolePattern({ ...shared, entryCentersMm: centers });
      } else {
        const shared = { ...common, holeDiameterMm: spec.diameterMm, holeDepthMm: spec.depthMm!, materialDepthMm: depth };
        result = centers.length === 1 ? await recipes.createBlindHole({ ...shared, entryCenterMm: centers[0]! }) : await recipes.createBlindHolePattern({ ...shared, entryCentersMm: centers });
      }
      target = result.resultBodyIds[0]!;
      revision = result.afterRevision;
      steps.push({ operation: result.recipe, beforeRevision: result.beforeRevision, afterRevision: result.afterRevision, affectedBodyIds: [target] });
    }

    // Read back: every axis has a full-turn hole of the requested diameter on the target, coaxial within 1e-6 mm, whose
    // entry circle is centred on the planned entry point and borders a planar face in the entry plane; every cylinder
    // face on the axis (all of them new: an existing one is refused before the cut) is whole (no side breakout); a
    // blind hole has a flat floor; the body is a closed, natively valid Solid. A mismatch undoes the steps above.
    const final = await operations.state();
    const body = final.bodies.find((candidate) => candidate.id === target);
    const problems: string[] = [];
    const holes: TransferHolesResult["holes"] = [];
    if (!body) problems.push(`target body ${target} is missing after the cut`);
    else {
      const cylinders = fullTurnCylinders(body).filter((cylinder) => cylinder.kind === "hole");
      const faceById = new Map(body.faces.map((face) => [face.id, face]));
      const edgeById = new Map(body.edges.map((edge) => [edge.id, edge]));
      for (const hole of plan.holes) {
        const label = `axis ${hole.index}`;
        const bore = cylinders.filter((cylinder) => Math.abs(cylinder.radiusMm - spec.diameterMm / 2) <= COINCIDENT_MM)
          .map((cylinder) => ({ cylinder, offset: coaxialOffset(hole.source.pointMm, hole.source.direction, cylinder.originMm, cylinder.direction) }))
          .filter((entry) => entry.offset <= COINCIDENT_MM)
          .sort((a, b) => a.offset - b.offset);
        if (bore.length === 0) { problems.push(`${label}: no full-turn Ø${spec.diameterMm} hole face on body ${body.id} is coaxial with the source axis within 1e-6 mm`); continue; }
        // The entry circle: on the bore, the counterbore or the countersink cone (any coaxial face of the body).
        const entryRadiusMm = entryRadius(spec);
        const coaxialFaces = body.faces.filter((face) => face.axisOriginMm && face.axisDirection && (face.surfaceType === "Cylinder" || face.surfaceType === "Cone")
          && coaxialOffset(hole.source.pointMm, hole.source.direction, face.axisOriginMm, face.axisDirection) <= COINCIDENT_MM);
        // The circle edges of one face at the entry, bordering a planar face in the entry plane, must close a full turn.
        const entryCircle = coaxialFaces.some((face) => {
          const sweep = face.edgeIds.map((id) => edgeById.get(id)).filter((edge): edge is Edge => !!edge?.circleGeometry
            && distance(edge.circleGeometry.centerMm, hole.entryPointMm) <= COINCIDENT_MM
            && Math.abs(edge.circleGeometry.radiusMm - entryRadiusMm) <= COINCIDENT_MM
            && edge.faceIds.some((other) => other !== face.id && faceById.get(other)?.planar === true && parallelSine(faceById.get(other)!.normal, hole.direction) <= PARALLEL_SINE
              && Math.abs(dot(sub(faceById.get(other)!.centerMm, hole.entryPointMm), unit(faceById.get(other)!.normal))) <= COINCIDENT_MM))
            .reduce((sum, edge) => sum + (circleSweepDeg(edge) ?? 0), 0);
          return sweep >= FULL_TURN_DEG;
        });
        if (!entryCircle) problems.push(`${label}: no full Ø${2 * entryRadiusMm} circle centred on the entry point ${JSON.stringify(round6(hole.entryPointMm))} borders a planar face in the entry plane`);
        // Side breakout: every circle boundary of every cylinder face the cut made on this axis is a full circle. An outward
        // face on the axis (a rod or boss the hole runs down the middle of) was there before and is no bore.
        for (const face of coaxialFaces.filter((candidate) => candidate.surfaceType === "Cylinder" && surfaceFacing(candidate) !== "boss")) {
          const breakout = breakoutProblem(face, edgeById, unit(hole.direction));
          if (breakout) { problems.push(`${label}: the bore breaks out of a side wall of the target (${breakout}); a hole must be a full cylinder along its whole length`); break; }
        }
        if (spec.depthMm !== undefined) {
          const floorPoint = add(hole.entryPointMm, scale(hole.direction, spec.depthMm));
          const floor = bore[0]!.cylinder.circleEdges.find((edge) => distance(edge.circleGeometry!.centerMm, floorPoint) <= COINCIDENT_MM
            && edge.faceIds.some((other) => { const face = faceById.get(other); return face !== undefined && other !== bore[0]!.cylinder.faceId && face.planar && face.edgeIds.every((id) => bore[0]!.cylinder.circleEdges.some((own) => own.id === id)); }));
          if (!floor) problems.push(`${label}: no flat floor closes the blind hole at depth ${spec.depthMm} mm`);
        }
        const boreFaces = coaxialFaces.filter((face) => face.surfaceType === "Cylinder" && surfaceFacing(face) !== "boss" && face.radiusMm !== null && Math.abs(face.radiusMm - spec.diameterMm / 2) <= COINCIDENT_MM);
        const best = bore[0]!;
        holes.push({ axisIndex: hole.index, holeFaceId: best.cylinder.faceId, axisOriginMm: round6(best.cylinder.originMm), axisDirection: round6(best.cylinder.direction), coaxialOffsetMm: best.offset, bores: countBores(boreFaces, edgeById, unit(hole.direction)) });
      }
      problems.push(...await validityProblems(operations, body.id, final.revision));
    }
    if (problems.length > 0) throw readBackError(problems);
    return { targetId: target, final, holes };
  });

  const { targetId, final, holes } = done;
  const holeCount = holes.reduce((sum, hole) => sum + hole.bores, 0);
  return {
    recipe: "transfer-holes",
    status: "completed",
    documentToken: final.documentToken,
    beforeRevision: initial.revision,
    afterRevision: final.revision,
    sourceId: input.sourceId,
    targetId,
    axesMm: plan.holes.map((hole) => ({ pointMm: round6(hole.source.pointMm), axis: round6(hole.direction), entryPointMm: round6(hole.entryPointMm), entryFaceId: hole.entryFaceId, ...(hole.source.faceIds.length > 0 ? { sourceFaceIds: hole.source.faceIds } : {}), kind: hole.source.kind ?? "explicit" })),
    axisCount: plan.holes.length,
    holeCount,
    targetHoleCount: holeCount,
    holes,
    ...(plan.skipped.length > 0 ? { skipped: plan.skipped } : {}),
    maxCoaxialOffsetMm: Math.max(0, ...holes.map((hole) => hole.coaxialOffsetMm)),
    undoSteps: final.undoDepth - initial.undoDepth,
    steps,
  };
}
