import { mutationOutcomeIsUncertain, type RuntimeState } from "./runtime.ts";
import type { PlasticityOperations } from "./operations.ts";

type Vector3 = [number, number, number];

export interface SplitSolidByPlaneInput {
  targetId: number;
  originMm: Vector3;
  normal: Vector3;
  xDirection: Vector3;
  revision: string;
}

export interface SplitSolidByPlaneResult {
  recipe: "split-solid-by-plane";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  sourceBodyId: number;
  resultBodyIds: number[];
  cutPlane: { originMm: Vector3; normal: Vector3; xDirection: Vector3; yDirection: Vector3 };
  cutterSizeMm: [number, number];
  cutterMarginMm: number;
  inputVolumeMm3: number;
  resultVolumeMm3: number;
  volumeDifferenceMm3: number;
  temporaryBodyIds: number[];
  undoSteps: number;
  /** Present when the native volume moved more than the conservation tolerance but stayed within the gross limit. */
  warnings?: string[];
}

/** Relative conservation tolerance (1e-6 of the source volume, at least 0.01 mm³) and the gross limit (1 %). */
export const SPLIT_VOLUME_RELATIVE_TOLERANCE = 1e-6;
export const SPLIT_VOLUME_MIN_TOLERANCE_MM3 = 0.01;
export const SPLIT_VOLUME_GROSS_LIMIT = 0.01;

export interface SplitVolumeCheck { differenceMm3: number; toleranceMm3: number; grossLimitMm3: number; status: "ok" | "warning" | "error"; message?: string }

/**
 * Volume conservation of a native split. Native mass properties of B-spline Solids carry integration error
 * (live 26.1.3: 4.9 to 136 mm³ on 777 to 804 cm³ bodies, up to 1.8e-4 relative), so a difference above the tolerance
 * but within the gross limit is a warning on a split that otherwise succeeded; above the gross limit it is an error.
 */
export function checkSplitVolume(inputMm3: number, resultMm3: number, label = "Split"): SplitVolumeCheck {
  const differenceMm3 = Math.abs(resultMm3 - inputMm3);
  const toleranceMm3 = Math.max(SPLIT_VOLUME_MIN_TOLERANCE_MM3, Math.abs(inputMm3) * SPLIT_VOLUME_RELATIVE_TOLERANCE);
  const grossLimitMm3 = Math.max(toleranceMm3, Math.abs(inputMm3) * SPLIT_VOLUME_GROSS_LIMIT);
  if (!Number.isFinite(resultMm3) || !Number.isFinite(differenceMm3) || differenceMm3 > grossLimitMm3) {
    return { differenceMm3, toleranceMm3, grossLimitMm3, status: "error", message: `${label} changed native volume by ${differenceMm3} mm³ (${relative(differenceMm3, inputMm3)}); the limit is ${grossLimitMm3} mm³ (1 % of ${inputMm3} mm³)` };
  }
  if (differenceMm3 > toleranceMm3) {
    return { differenceMm3, toleranceMm3, grossLimitMm3, status: "warning", message: `${label} changed native volume by ${differenceMm3} mm³ (${relative(differenceMm3, inputMm3)}), above the conservation tolerance ${toleranceMm3} mm³ but within 1 %; native volume of curved (B-spline) Solids is an integration with this order of error. The parts are valid; check them if the difference matters` };
  }
  return { differenceMm3, toleranceMm3, grossLimitMm3, status: "ok" };
}

function relative(difference: number, input: number): string {
  return `${(difference / Math.abs(input)).toExponential(2)} of the source volume`;
}

export class SplitSolidByPlaneRecipeError extends Error {
  readonly completedSteps: number;
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: number, lastConfirmedRevision: string) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Solid split recipe failed after ${completedSteps}/4 confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "SplitSolidByPlaneRecipeError";
    this.completedSteps = completedSteps;
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

type SplitOperations = Pick<PlasticityOperations,
  "state" | "measureSolidProperties" | "validateBodies" | "createRectangle" | "patchClosedWires" | "cutWithFaces" | "remove">;

export class SplitSolidByPlaneRecipe {
  private readonly operations: SplitOperations;

  constructor(operations: SplitOperations) {
    this.operations = operations;
  }

  async split(input: SplitSolidByPlaneInput): Promise<SplitSolidByPlaneResult> {
    const initial = await this.operations.state();
    if (initial.revision !== input.revision) {
      throw new Error(`Stale reference: expected revision ${input.revision}, current revision is ${initial.revision}`);
    }
    const target = initial.bodies.find((body) => body.id === input.targetId);
    if (!target) throw new Error(`Unknown split target body ID: ${input.targetId}`);
    if (target.type !== "Solid") throw new Error(`Plane splitting requires a current Solid: ${input.targetId}`);
    if (!target.boundsMm) throw new Error(`Plane splitting requires exact native bounds for Solid ${input.targetId}`);
    const frame = resolveFrame(input.normal, input.xDirection);
    const cutter = cutterRectangle(target.boundsMm, input.originMm, frame.normal, frame.x, frame.y);
    const sourceProperties = await this.operations.measureSolidProperties([input.targetId], input.revision);
    const inputVolumeMm3 = sourceProperties.bodies[0]?.volumeMm3;
    if (!(inputVolumeMm3 && Number.isFinite(inputVolumeMm3))) throw new Error("Native source Solid volume is unavailable");

    const contextVersions = new Map(initial.bodies.filter((body) => body.id !== input.targetId).map((body) => [body.id, body.versionId]));
    let current = initial;
    let profileId: number | undefined;
    let sheetId: number | undefined;
    let completedSteps = 0;
    try {
      const beforeProfile = current;
      current = await this.operations.createRectangle(cutter.centerMm, cutter.widthMm, cutter.heightMm, current.revision, frame.normal, frame.x);
      completedSteps += 1;
      profileId = oneAddedBody(beforeProfile, current, "split cutter profile", "Wire");
      const profileRegions = current.regions.filter((region) => region.sketchWireIds.includes(profileId!));
      if (profileRegions.length !== 1) throw new Error(`Split cutter profile must form exactly one planar Region; found ${profileRegions.length}`);

      const beforePatch = current;
      current = await this.operations.patchClosedWires([profileId], current.revision);
      completedSteps += 1;
      sheetId = oneAddedBody(beforePatch, current, "split cutter Sheet", "Sheet");
      const sheet = current.bodies.find((body) => body.id === sheetId)!;
      const cutterFace = sheet.faces.filter((face) => face.planar && face.surfaceType === "Plane");
      if (cutterFace.length !== 1) throw new Error(`Split cutter must be one exact planar face; found ${cutterFace.length}`);
      const face = cutterFace[0]!;
      if (Math.abs(Math.abs(dot(face.normal, frame.normal)) - 1) > 1e-6) {
        throw new Error("Split cutter face normal does not match the requested plane");
      }
      if (Math.abs(dot(subtract(face.centerMm, input.originMm), frame.normal)) > 0.01) {
        throw new Error("Split cutter face is not located on the requested plane");
      }

      current = await this.operations.cutWithFaces([input.targetId], [{ bodyId: sheetId, faceId: face.id }], current.revision);
      completedSteps += 1;
      const resultBodyIds = splitResultIds(initial, current, input.targetId);
      const validation = await this.operations.validateBodies(resultBodyIds, current.revision);
      if (validation.bodies.length !== 2 || validation.bodies.some((body) => body.type !== "Solid" || !body.closed || !body.nativeValid || !body.printableSolid || body.nativeCheckCodes.length > 0)) {
        throw new Error("Native cut did not return two closed, valid, printable Solid parts");
      }
      const measured = await this.operations.measureSolidProperties(resultBodyIds, current.revision);
      const resultVolumeMm3 = measured.totals.volumeMm3;
      const cutCheck = checkSplitVolume(inputVolumeMm3, resultVolumeMm3);
      if (cutCheck.status === "error") throw new Error(cutCheck.message);
      assertUnrelatedBodiesPreserved(contextVersions, current);

      const temporaryBodyIds = [profileId, sheetId];
      current = await this.operations.remove(temporaryBodyIds, current.revision);
      completedSteps += 1;
      requireBodiesAbsent(current, temporaryBodyIds);
      if (current.regions.length !== initial.regions.length) throw new Error("Removing split tools did not restore the original Region count");
      const afterCleanup = await this.operations.measureSolidProperties(resultBodyIds, current.revision);
      const cleanupCheck = checkSplitVolume(inputVolumeMm3, afterCleanup.totals.volumeMm3, "Split (after temporary-tool cleanup)");
      if (cleanupCheck.status === "error") throw new Error(cleanupCheck.message);
      const cleanupVolumeDifferenceMm3 = cleanupCheck.differenceMm3;
      // A cleanup that moved the volume by more than the cut did is its own finding; otherwise one warning covers both.
      const warnings = [cutCheck, cleanupCheck].filter((check) => check.status === "warning").map((check) => check.message!);
      const uniqueWarning = warnings.length === 2 && Math.abs(cleanupCheck.differenceMm3 - cutCheck.differenceMm3) <= cutCheck.toleranceMm3 ? [warnings[1]!] : warnings;
      assertUnrelatedBodiesPreserved(contextVersions, current);
      return {
        recipe: "split-solid-by-plane",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        sourceBodyId: input.targetId,
        resultBodyIds,
        cutPlane: { originMm: [...input.originMm], normal: frame.normal, xDirection: frame.x, yDirection: frame.y },
        cutterSizeMm: [cutter.widthMm, cutter.heightMm],
        cutterMarginMm: cutter.marginMm,
        inputVolumeMm3,
        resultVolumeMm3: afterCleanup.totals.volumeMm3,
        volumeDifferenceMm3: cleanupVolumeDifferenceMm3,
        temporaryBodyIds,
        undoSteps: completedSteps,
        ...(uniqueWarning.length > 0 ? { warnings: uniqueWarning } : {}),
      };
    } catch (error) {
      throw new SplitSolidByPlaneRecipeError(error, completedSteps, current.revision);
    }
  }
}

function resolveFrame(normalInput: Vector3, xInput: Vector3): { normal: Vector3; x: Vector3; y: Vector3 } {
  const normal = normalize(normalInput, "Split plane normal");
  const projectedX = subtract(xInput, scale(normal, dot(xInput, normal)));
  const x = normalize(projectedX, "Split plane x direction must be nonzero and perpendicular to its normal");
  const y = normalize(cross(normal, x), "Split plane basis is degenerate");
  return { normal, x, y };
}

function cutterRectangle(
  bounds: NonNullable<RuntimeState["bodies"][number]["boundsMm"]>,
  originMm: Vector3,
  normal: Vector3,
  x: Vector3,
  y: Vector3,
): { centerMm: Vector3; widthMm: number; heightMm: number; marginMm: number } {
  if (!originMm.every(Number.isFinite)) throw new Error("Split plane origin must contain finite millimeter coordinates");
  const corners: Vector3[] = [];
  for (const xMm of [bounds.min[0], bounds.max[0]]) {
    for (const yMm of [bounds.min[1], bounds.max[1]]) {
      for (const zMm of [bounds.min[2], bounds.max[2]]) corners.push([xMm, yMm, zMm]);
    }
  }
  const signedDistances = corners.map((corner) => dot(subtract(corner, originMm), normal));
  if (Math.min(...signedDistances) >= -1e-6 || Math.max(...signedDistances) <= 1e-6) {
    throw new Error("Split plane must cross the interior of the target Solid; a tangent or exterior plane is not a split");
  }
  const xCoordinates = corners.map((corner) => dot(subtract(corner, originMm), x));
  const yCoordinates = corners.map((corner) => dot(subtract(corner, originMm), y));
  const diagonal = Math.hypot(...bounds.max.map((value, axis) => value - bounds.min[axis]!));
  const marginMm = Math.max(1, diagonal * 0.05);
  const xMin = Math.min(...xCoordinates);
  const xMax = Math.max(...xCoordinates);
  const yMin = Math.min(...yCoordinates);
  const yMax = Math.max(...yCoordinates);
  const widthMm = xMax - xMin + marginMm * 2;
  const heightMm = yMax - yMin + marginMm * 2;
  const centerMm = add(originMm, add(scale(x, (xMin + xMax) / 2), scale(y, (yMin + yMax) / 2)));
  return { centerMm, widthMm, heightMm, marginMm };
}

function oneAddedBody(before: RuntimeState, after: RuntimeState, label: string, type: string): number {
  requireSameDocument(before, after);
  const prior = new Set(before.bodies.map((body) => body.id));
  const added = after.bodies.filter((body) => !prior.has(body.id));
  if (added.length !== 1 || added[0]!.type !== type) {
    throw new Error(`Expected one new ${type} for ${label}, found ${added.length} bodies: ${added.map((body) => `${body.id}:${body.type}`).join(", ")}`);
  }
  return added[0]!.id;
}

function splitResultIds(initial: RuntimeState, after: RuntimeState, targetId: number): number[] {
  requireSameDocument(initial, after);
  const initialContextIds = new Set(initial.bodies.filter((body) => body.id !== targetId).map((body) => body.id));
  const results = after.bodies.filter((body) => body.type === "Solid" && (body.id === targetId || !initialContextIds.has(body.id)));
  if (results.length !== 2) throw new Error(`Native cut must produce exactly two Solid parts for body ${targetId}; found ${results.length}`);
  return results.map((body) => body.id);
}

function assertUnrelatedBodiesPreserved(versions: Map<number, number>, state: RuntimeState): void {
  for (const [id, versionId] of versions) {
    const current = state.bodies.find((body) => body.id === id);
    if (!current || current.versionId !== versionId) throw new Error(`Solid split changed unrelated body ${id}`);
  }
}

function requireBodiesAbsent(state: RuntimeState, ids: number[]): void {
  const present = ids.filter((id) => state.bodies.some((body) => body.id === id));
  if (present.length > 0) throw new Error(`Split cutter bodies remain after cleanup: ${present.join(", ")}`);
}

function requireSameDocument(before: RuntimeState, after: RuntimeState): void {
  if (before.documentToken !== after.documentToken) throw new Error("Plasticity document changed during Solid split");
}

function normalize(vector: Vector3, label: string): Vector3 {
  if (!vector.every(Number.isFinite)) throw new Error(`${label} must contain finite coordinates`);
  const length = Math.hypot(...vector);
  if (!(length > 1e-9)) throw new Error(`${label} must be nonzero`);
  return vector.map((value) => value / length) as Vector3;
}

function dot(left: Vector3, right: Vector3): number {
  return left.reduce((sum, value, index) => sum + value * right[index]!, 0);
}

function cross(left: Vector3, right: Vector3): Vector3 {
  return [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]];
}

function add(left: Vector3, right: Vector3): Vector3 {
  return left.map((value, index) => value + right[index]!) as Vector3;
}

function subtract(left: Vector3, right: Vector3): Vector3 {
  return left.map((value, index) => value - right[index]!) as Vector3;
}

function scale(vector: Vector3, factor: number): Vector3 {
  return vector.map((value) => value * factor) as Vector3;
}
