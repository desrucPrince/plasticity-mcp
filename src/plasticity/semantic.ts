import type { RuntimeState } from "./runtime.ts";
import {
  frameFromOriginNormalX,
  frameFromThreePoints,
  normalize,
  offsetFrame,
  rotateFrameAboutAxis,
  subtract,
  type AxisLine,
  type PlaneFrame,
  type Vector3,
} from "./construction.ts";
import type { AxisDefinition, DatumRegistry, PlaneDefinition, PointDefinition } from "./references.ts";

type Bounds = { min: Vector3; max: Vector3 };

export type Resolution<T> =
  | { status: "resolved"; value: T }
  | { status: "ambiguous"; matches: number }
  | { status: "unresolved"; reason: string };

export interface ScalarMatch {
  value: number;
  tolerance: number;
}

export interface PointMatch {
  pointMm: Vector3;
  toleranceMm: number;
}

export interface DirectionMatch {
  vector: Vector3;
  toleranceDeg: number;
  oriented?: boolean | undefined;
}

export interface FaceQuery {
  bodyIds?: number[] | undefined;
  surfaceTypes?: string[] | undefined;
  planar?: boolean | undefined;
  normal?: DirectionMatch | undefined;
  radiusMm?: ScalarMatch | undefined;
  blendRadiusMm?: ScalarMatch | undefined;
  center?: PointMatch | undefined;
  boundsMm?: Bounds | undefined;
  edgeCount?: number | undefined;
  adjacentEdgeIds?: string[] | undefined;
}

export interface EdgeQuery {
  bodyIds?: number[] | undefined;
  curveTypes?: string[] | undefined;
  line?: boolean | undefined;
  circle?: boolean | undefined;
  direction?: DirectionMatch | undefined;
  lengthMm?: ScalarMatch | undefined;
  center?: PointMatch | undefined;
  boundsMm?: Bounds | undefined;
  adjacentFaceIds?: string[] | undefined;
  edgeIds?: string[] | undefined;
}

export type FaceMatch = RuntimeState["bodies"][number]["faces"][number] & { bodyId: number };
export type EdgeMatch = RuntimeState["bodies"][number]["edges"][number] & { bodyId: number };

export function findFaces(state: RuntimeState, query: FaceQuery): FaceMatch[] {
  return state.bodies
    .filter((body) => !query.bodyIds || query.bodyIds.includes(body.id))
    .flatMap((body) => body.faces.map((face) => ({ bodyId: body.id, ...face })))
    .filter((face) => {
      if (query.surfaceTypes && !query.surfaceTypes.some((type) => equalType(type, face.surfaceType))) return false;
      if (query.planar !== undefined && face.planar !== query.planar) return false;
      if (query.normal && !matchesDirection(face.normal, { ...query.normal, oriented: query.normal.oriented ?? true })) return false;
      if (query.radiusMm && !matchesNullableScalar(face.radiusMm, query.radiusMm)) return false;
      if (query.blendRadiusMm && !matchesNullableScalar(face.blendRadiusMm, query.blendRadiusMm)) return false;
      if (query.center && !matchesPoint(face.centerMm, query.center)) return false;
      if (query.boundsMm && !boundsOverlap(face.boundsMm, query.boundsMm)) return false;
      if (query.edgeCount !== undefined && face.edgeIds.length !== query.edgeCount) return false;
      if (query.adjacentEdgeIds && !query.adjacentEdgeIds.every((id) => face.edgeIds.includes(id))) return false;
      return true;
    });
}

export function findEdges(state: RuntimeState, query: EdgeQuery): EdgeMatch[] {
  return state.bodies
    .filter((body) => !query.bodyIds || query.bodyIds.includes(body.id))
    .flatMap((body) => body.edges.map((edge) => ({ bodyId: body.id, ...edge })))
    .filter((edge) => {
      if (query.edgeIds && !query.edgeIds.includes(edge.id)) return false;
      if (query.curveTypes && !query.curveTypes.some((type) => equalType(type, edge.curveType))) return false;
      if (query.line !== undefined && edge.line !== query.line) return false;
      if (query.circle !== undefined && edge.circle !== query.circle) return false;
      if (query.direction && !matchesDirection(edge.tangent, query.direction)) return false;
      if (query.lengthMm && !matchesScalar(edge.lengthMm, query.lengthMm)) return false;
      if (query.center && !matchesPoint(edge.centerMm, query.center)) return false;
      if (query.boundsMm && !boundsOverlap(edge.boundsMm, query.boundsMm)) return false;
      if (query.adjacentFaceIds && !query.adjacentFaceIds.every((id) => edge.faceIds.includes(id))) return false;
      return true;
    });
}

export function resolvePoint(state: RuntimeState, definition: PointDefinition): Resolution<Vector3> {
  if (definition.type === "coordinates") return resolveGeometry(() => normalizePoint(definition.pointMm));
  if (definition.type === "face-center") {
    const matches = topologyMatches(state, definition.bodyId, "faces", definition.faceId);
    if (matches.length !== 1) return matchFailure("face", matches.length);
    return { status: "resolved", value: [...matches[0]!.centerMm] };
  }
  const matches = topologyMatches(state, definition.bodyId, "edges", definition.edgeId);
  if (matches.length !== 1) return matchFailure("edge", matches.length);
  return { status: "resolved", value: [...matches[0]!.centerMm] };
}

export function resolveAxis(
  state: RuntimeState,
  definition: AxisDefinition,
  registry: DatumRegistry,
  refreshDependencies = false,
): Resolution<AxisLine> {
  if (definition.type === "origin-direction") {
    return resolveGeometry(() => ({ originMm: normalizePoint(definition.originMm), direction: normalize(definition.direction, "Axis direction") }));
  }
  if (definition.type === "two-points") {
    return resolveGeometry(() => {
      const first = refreshDependencies
        ? pointForDerivedAxis(registry, definition.firstId, state)
        : currentPoint(registry, definition.firstId, state);
      const second = refreshDependencies
        ? pointForDerivedAxis(registry, definition.secondId, state)
        : currentPoint(registry, definition.secondId, state);
      return { originMm: [...first.pointMm], direction: normalize(subtract(second.pointMm, first.pointMm), "Two-point axis direction") };
    });
  }
  if (definition.type === "linear-edge") {
    const matches = topologyMatches(state, definition.bodyId, "edges", definition.edgeId);
    if (matches.length !== 1) return matchFailure("edge", matches.length);
    const edge = matches[0]!;
    if (!edge.line) return { status: "unresolved", reason: `Edge ${definition.edgeId} is not linear` };
    return resolveGeometry(() => ({ originMm: [...edge.centerMm], direction: normalize(edge.tangent, "Linear edge direction") }));
  }
  const matches = topologyMatches(state, definition.bodyId, "faces", definition.faceId);
  if (matches.length !== 1) return matchFailure("face", matches.length);
  const face = matches[0]!;
  if (face.axisOriginMm === null || face.axisDirection === null || !/cylinder/i.test(face.surfaceType)) {
    return { status: "unresolved", reason: `Face ${definition.faceId} does not expose an exact cylindrical axis` };
  }
  return resolveGeometry(() => ({ originMm: [...face.axisOriginMm!], direction: normalize(face.axisDirection!, "Cylindrical face axis") }));
}

export function resolvePlaneFrame(
  state: RuntimeState,
  definition: PlaneDefinition,
  registry: DatumRegistry,
): Resolution<PlaneFrame> {
  return resolveGeometry(() => {
    if (definition.type === "explicit") {
      return frameFromOriginNormalX(definition.originMm, definition.normal, definition.xDirection);
    }
    if (definition.type === "three-points") {
      return frameFromThreePoints(
        currentPoint(registry, definition.firstId, state).pointMm,
        currentPoint(registry, definition.secondId, state).pointMm,
        currentPoint(registry, definition.thirdId, state).pointMm,
      );
    }
    if (definition.type === "planar-face") {
      const matches = topologyMatches(state, definition.bodyId, "faces", definition.faceId);
      if (matches.length > 1) throw new AmbiguousResolution(matches.length);
      const face = matches[0];
      if (!face) throw new Error(`Face ${definition.faceId} was not found on body ${definition.bodyId}`);
      if (!face.planar) throw new Error(`Face ${definition.faceId} is not planar`);
      const reference: Vector3 = Math.abs(face.normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      return offsetFrame(frameFromOriginNormalX(face.centerMm, face.normal, reference), definition.offsetMm);
    }
    if (definition.type === "offset") {
      return offsetFrame(currentPlane(registry, definition.planeId, state), definition.offsetMm);
    }
    return rotateFrameAboutAxis(
      currentPlane(registry, definition.planeId, state),
      currentAxis(registry, definition.axisId, state),
      definition.angleDegrees,
    );
  });
}

function topologyMatches<K extends "faces" | "edges">(
  state: RuntimeState,
  bodyId: number,
  kind: K,
  topologyId: string,
): RuntimeState["bodies"][number][K] {
  return state.bodies.filter((body) => body.id === bodyId).flatMap((body) => body[kind].filter((item) => item.id === topologyId)) as RuntimeState["bodies"][number][K];
}

function matchFailure(kind: string, matches: number): Resolution<never> {
  return matches > 1
    ? { status: "ambiguous", matches }
    : { status: "unresolved", reason: `The requested ${kind} was not found` };
}

class AmbiguousResolution extends Error {
  readonly matches: number;

  constructor(matches: number) {
    super(`Geometry reference matched ${matches} topology items`);
    this.matches = matches;
  }
}

function resolveGeometry<T>(operation: () => T): Resolution<T> {
  try {
    return { status: "resolved", value: operation() };
  } catch (error) {
    if (error instanceof AmbiguousResolution) return { status: "ambiguous", matches: error.matches };
    return { status: "unresolved", reason: error instanceof Error ? error.message : String(error) };
  }
}

function normalizePoint(point: Vector3): Vector3 {
  if (point.length !== 3 || point.some((value) => !Number.isFinite(value))) throw new Error("Point coordinates must be finite numbers");
  return [...point];
}

function currentPoint(registry: DatumRegistry, id: string, state: RuntimeState) {
  const record = registry.get(id);
  if (record.kind !== "datum-point") throw new Error(`Datum reference is not a point: ${id}`);
  return registry.requireCurrentPoint(record.identity, state.documentToken, state.revision);
}

function pointForDerivedAxis(registry: DatumRegistry, id: string, state: RuntimeState): { pointMm: Vector3 } {
  const record = registry.get(id);
  if (record.kind !== "datum-point") throw new Error(`Datum reference is not a point: ${id}`);
  if (record.documentToken !== state.documentToken) throw new Error(`Datum point belongs to another Plasticity document: ${id}`);
  if (record.revision === state.revision) return record;
  const resolved = resolvePoint(state, record.definition);
  if (resolved.status === "ambiguous") throw new AmbiguousResolution(resolved.matches);
  if (resolved.status === "unresolved") throw new Error(resolved.reason);
  return { pointMm: resolved.value };
}

function currentAxis(registry: DatumRegistry, id: string, state: RuntimeState) {
  const record = registry.get(id);
  if (record.kind !== "datum-axis") throw new Error(`Datum reference is not an axis: ${id}`);
  return registry.requireCurrentAxis(record.identity, state.documentToken, state.revision);
}

function currentPlane(registry: DatumRegistry, id: string, state: RuntimeState): PlaneFrame {
  const record = registry.get(id);
  if (record.kind !== "construction-plane") throw new Error(`Datum reference is not a plane: ${id}`);
  return registry.requireCurrentPlane(record.identity, state.documentToken, state.revision);
}

function equalType(expected: string, actual: string): boolean {
  return expected.localeCompare(actual, undefined, { sensitivity: "accent" }) === 0;
}

function matchesNullableScalar(actual: number | null, expected: ScalarMatch): boolean {
  return actual !== null && matchesScalar(actual, expected);
}

function matchesScalar(actual: number, expected: ScalarMatch): boolean {
  return Math.abs(actual - expected.value) <= expected.tolerance;
}

function matchesPoint(actual: Vector3, expected: PointMatch): boolean {
  return distance(actual, expected.pointMm) <= expected.toleranceMm;
}

function matchesDirection(actual: Vector3, expected: DirectionMatch): boolean {
  const actualLength = magnitude(actual);
  const expectedLength = magnitude(expected.vector);
  if (actualLength === 0 || expectedLength === 0) return false;
  let cosine = dot(actual, expected.vector) / (actualLength * expectedLength);
  if (!expected.oriented) cosine = Math.abs(cosine);
  cosine = Math.max(-1, Math.min(1, cosine));
  return Math.acos(cosine) * 180 / Math.PI <= expected.toleranceDeg;
}

function boundsOverlap(left: Bounds, right: Bounds): boolean {
  return left.min.every((value, axis) => value <= right.max[axis]!) &&
    right.min.every((value, axis) => value <= left.max[axis]!);
}

function magnitude(value: Vector3): number {
  return Math.sqrt(dot(value, value));
}

function dot(left: Vector3, right: Vector3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function distance(left: Vector3, right: Vector3): number {
  return Math.sqrt(
    (left[0] - right[0]) ** 2 +
    (left[1] - right[1]) ** 2 +
    (left[2] - right[2]) ** 2,
  );
}

// ---------- plasticity_describe_body ----------
// A compact, decision-ready summary of one body from the read model: where its walls, floors, hole and boss axes and
// blend radii are, without per-face topology. Pure: no native call.
type DescribedBody = RuntimeState["bodies"][number];
const DESCRIBE_DECIMALS = 4;
const DESCRIBE_MAX_BYTES = 4_096;
const DESCRIBE_MAX_OFFSETS = 12;
const DESCRIBE_MAX_AXES = 16;
const AXIS_NAMES = ["x", "y", "z"] as const;
const AXIS_ALIGNED = 1 - 1e-6;

const round4 = (value: number): number => {
  const scale = 10 ** DESCRIBE_DECIMALS;
  const rounded = Math.round(value * scale) / scale;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const round4Vector = (value: readonly number[]): number[] => value.map(round4);
const dot3 = (left: readonly number[], right: readonly number[]): number => left[0]! * right[0]! + left[1]! * right[1]! + left[2]! * right[2]!;

// "xPos", "zNeg" for a principal normal; undefined for a slanted one. Plain keys so batch `return` paths can name them.
function principalKey(direction: readonly number[]): string | undefined {
  for (let index = 0; index < 3; index += 1) {
    if (Math.abs(direction[index]!) >= AXIS_ALIGNED) return `${AXIS_NAMES[index]}${direction[index]! > 0 ? "Pos" : "Neg"}`;
  }
  return undefined;
}

// Face area is not in the read model; the half surface of the bounding box stands in for ranking faces of one plane.
function boundsArea(face: DescribedBody["faces"][number]): number {
  const dx = face.boundsMm.max[0] - face.boundsMm.min[0];
  const dy = face.boundsMm.max[1] - face.boundsMm.min[1];
  const dz = face.boundsMm.max[2] - face.boundsMm.min[2];
  return dx * dy + dy * dz + dz * dx;
}

type PlaneOffset = { mm: number; count: number; face: string; area: number };
type AxisPoint = { point: number[]; lo: number; hi: number; index: number | undefined };
type CylinderGroup = {
  radiusMm: number; rep: number; axis: string | number[]; kind?: "hole" | "boss" | "arc"; sweepDeg?: number; faces: number;
  // Distinct axes (within 0.001 mm across the axis). For an axis-aligned one, lo and hi are the faces' extent along it.
  points: AxisPoint[]; grid: Map<string, number[]>; across: number[][];
  // Full-turn faces only (two circle edges): their axial extent, and for holes whether a floor closes one end.
  closed: number; extents: Array<[number, number] | undefined>; floored: boolean[];
};
type DescribedEdge = DescribedBody["edges"][number];

const AXIS_ZERO = 1e-6; // direction components below this count as 0 before the sign is chosen
const AXIS_POINT_TOLERANCE = 1e-3; // mm: axis points closer than this are one axis
const RADIUS_TOLERANCE = 1e-4; // mm: radii closer than this to a group's first radius join it
const DESCRIBE_MAX_NAME = 120;
const DESCRIBE_MAX_BLENDS = 12;
const DESCRIBE_MAX_HALF_ANGLES = 8;
const DESCRIBE_MAX_GROUPS = 50; // a cylinder group needs about 75 bytes: more than this never fits 4 KB

type PlaneEntry = { normal?: number[]; mm: number; count?: number; face: string }; // count is left out when it is 1
export interface BodyDescription {
  id: number;
  type: string;
  name: string | null; // cut to 120 characters
  revision: string;
  boundsMm: { min: number[]; max: number[] } | null;
  sizeMm: number[] | null;
  faceCount: number;
  edgeCount: number;
  vertexCount: number;
  // xPos, xNeg, yPos, yNeg, zPos, zNeg and slanted each hold a list of plane entries; `more` maps a direction to the number of offsets left out.
  planes: { [direction: string]: PlaneEntry[] | Record<string, number> | undefined; more?: Record<string, number> };
  // count is the number of distinct axes; faces appears only when it differs. kind is hole or boss for full-turn faces (two circle edges)
  // and arc for a part turn, with sweepDeg when the circle edges give it. through and extentMm appear only when every face of the group
  // is a full-turn face and they agree.
  cylinders: Array<{ radiusMm: number; axis: string | number[]; kind?: "hole" | "boss" | "arc"; sweepDeg?: number; count: number; faces?: number; axisPointsMm: number[][]; more?: number; through?: boolean; extentMm?: number[] }>;
  cylindersMore?: number; // groups left out (the groups with the fewest faces go first)
  otherSurfaces: Record<string, { count: number; halfAngleDeg?: number[]; more?: number }>;
  otherSurfacesMore?: number;
  blendRadii: Record<string, number>; // radius mm -> face count
  blendRadiiMore?: number;
  // An open-top pocket read from the planes: the widest inward-facing wall pair on x and on y, and the floor z. Left out when not clear.
  cavity?: { xMm: number[]; yMm: number[]; floorZMm: number };
  planesMore?: number; // every plane offset, when the planes section itself was left out
  truncated?: true;
}

const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const distance3 = (left: readonly number[], right: readonly number[]): number => Math.hypot(left[0]! - right[0]!, left[1]! - right[1]!, left[2]! - right[2]!);

// The angle an arc edge sweeps about its circle's centre, from its start, midpoint and end; 360 for a closed circle.
function circleSweepDeg(edge: DescribedEdge): number | undefined {
  const geometry = edge.circleGeometry;
  if (!geometry) return undefined;
  const { centerMm: center, startMm: start, midpointMm: middle, endMm: end } = geometry;
  if (distance3(start, end) < AXIS_POINT_TOLERANCE) return 360;
  const first = [0, 1, 2].map((index) => start[index]! - center[index]!);
  const last = [0, 1, 2].map((index) => end[index]! - center[index]!);
  const mid = [0, 1, 2].map((index) => middle[index]! - center[index]!);
  const lengths = Math.hypot(first[0]!, first[1]!, first[2]!) * Math.hypot(last[0]!, last[1]!, last[2]!);
  if (lengths < 1e-12) return undefined;
  const short = Math.acos(Math.max(-1, Math.min(1, dot3(first, last) / lengths))) * 180 / Math.PI;
  // The midpoint lies on the short side of the chord for an arc of 180 degrees or less.
  const onShortSide = dot3(mid, [first[0]! + last[0]!, first[1]! + last[1]!, first[2]! + last[2]!]) >= 0;
  return Math.round((onShortSide || short > 179.95 ? short : 360 - short) * 10) / 10;
}

export function describeBody(body: DescribedBody, revision: string): BodyDescription {
  const planes = new Map<string, { slanted?: number[]; offsets: Map<number, PlaneOffset> }>();
  const cylinderGroups: CylinderGroup[] = [];
  // Groups of one axis, kind and sweep, found by their first radius: radii within 0.0001 mm of it join, whatever bucket they fall in.
  const groupsBySubKey = new Map<string, Map<number, CylinderGroup[]>>();
  const others = new Map<string, { count: number; halfAngles: Set<number> }>();
  const blends = new Map<number, number>();
  const edgeById = new Map((body.edges ?? []).map((edge) => [edge.id, edge]));
  const faceById = new Map(body.faces.map((candidate) => [candidate.id, candidate]));

  for (const face of body.faces) {
    const blend = face.blendRadiusMm !== null && face.blendRadiusMm > 0 ? round4(face.blendRadiusMm) : undefined;
    if (blend !== undefined) blends.set(blend, (blends.get(blend) ?? 0) + 1);

    if (face.surfaceType === "Plane" || face.planar) {
      const key = principalKey(face.normal) ?? `n${round4Vector(face.normal).join(",")}`;
      const entry = planes.get(key) ?? { ...(principalKey(face.normal) ? {} : { slanted: round4Vector(face.normal) }), offsets: new Map<number, PlaneOffset>() };
      planes.set(key, entry);
      // An axis-aligned plane is placed by its coordinate on that axis (x for xPos and xNeg); a slanted one by its offset along its normal.
      const principalAxis = [0, 1, 2].find((index) => Math.abs(face.normal[index]!) >= AXIS_ALIGNED);
      const offsetMm = round4(principalAxis === undefined ? dot3(face.centerMm, face.normal) : face.centerMm[principalAxis]!);
      const area = boundsArea(face);
      const at = entry.offsets.get(offsetMm);
      if (!at) entry.offsets.set(offsetMm, { mm: offsetMm, count: 1, face: face.id, area });
      else {
        at.count += 1;
        if (area > at.area) { at.face = face.id; at.area = area; }
      }
      continue;
    }

    // A cylindrical blend is reported under blendRadii only, not as a hole or boss.
    if (face.surfaceType === "Cylinder" && blend !== undefined) continue;
    if (face.surfaceType === "Cylinder" && face.radiusMm !== null && face.axisOriginMm && face.axisDirection) {
      // One sign per axis, so a hole and its mirrored description group together; components near zero count as zero before the sign is chosen.
      const zeroed = face.axisDirection.map((component) => (Math.abs(component) < AXIS_ZERO ? 0 : component));
      const first = zeroed.find((component) => component !== 0) ?? 1;
      const direction = (first < 0 ? zeroed.map((component) => (component === 0 ? 0 : -component)) : zeroed) as [number, number, number];
      const offset = [0, 1, 2].map((index) => face.centerMm[index]! - face.axisOriginMm![index]!);
      const along = dot3(offset, direction);
      const point = [0, 1, 2].map((index) => face.axisOriginMm![index]! + along * direction[index]!);
      const radial = [0, 1, 2].map((index) => face.centerMm[index]! - point[index]!);
      const radialLength = Math.hypot(radial[0]!, radial[1]!, radial[2]!);
      const facing = radialLength > 1e-9 ? dot3(face.normal, radial) / radialLength : 0;
      // A full turn has two circle edges (or one closed circle). One circle edge and no more is a part turn: an arc, never a hole or boss.
      // With no circle edge at all the faces cannot say, so the facing decides, as before.
      const circleEdges = face.edgeIds.map((edgeId) => edgeById.get(edgeId)).filter((edge): edge is DescribedEdge => edge?.circle === true);
      const fullTurn = circleEdges.length >= 2 || circleEdges.some((edge) => (circleSweepDeg(edge) ?? 0) >= 360);
      const partial = circleEdges.length >= 1 && !fullTurn;
      const kind = partial ? "arc" as const : facing > 0.5 ? "boss" as const : facing < -0.5 ? "hole" as const : undefined;
      const sweeps = partial ? circleEdges.map(circleSweepDeg).filter((value): value is number => value !== undefined) : [];
      const sweepDeg = sweeps.length > 0 ? Math.max(...sweeps) : undefined;
      const principal = principalKey(direction);
      const axis: string | number[] = principal ? principal.slice(0, 1) : round4Vector(direction);
      const subKey = `${Array.isArray(axis) ? axis.join(",") : axis}|${kind ?? ""}|${kind === "arc" ? (sweepDeg === undefined ? "?" : Math.round(sweepDeg)) : ""}`;
      const buckets = groupsBySubKey.get(subKey) ?? new Map<number, CylinderGroup[]>();
      groupsBySubKey.set(subKey, buckets);
      const bucket = Math.round(face.radiusMm / RADIUS_TOLERANCE);
      let group: CylinderGroup | undefined;
      for (let neighbour = bucket - 1; neighbour <= bucket + 1 && !group; neighbour += 1) {
        group = buckets.get(neighbour)?.find((candidate) => Math.abs(candidate.rep - face.radiusMm!) <= RADIUS_TOLERANCE + 1e-9);
      }
      if (!group) {
        group = { radiusMm: round4(face.radiusMm), rep: face.radiusMm, axis, ...(kind ? { kind } : {}), ...(kind === "arc" && sweepDeg !== undefined ? { sweepDeg } : {}), faces: 0, points: [], grid: new Map(), across: [], closed: 0, extents: [], floored: [] };
        buckets.set(bucket, [...(buckets.get(bucket) ?? []), group]);
        cylinderGroups.push(group);
      }
      group.faces += 1;
      if (circleEdges.length >= 2) {
        group.closed += 1;
        const axisIndex = [0, 1, 2].find((candidate) => Math.abs(direction[candidate]!) >= AXIS_ALIGNED);
        group.extents.push(axisIndex === undefined ? undefined : [round4(face.boundsMm.min[axisIndex]!), round4(face.boundsMm.max[axisIndex]!)]);
        if (kind === "hole") {
          // A flat floor (one edge) or an apex closes a blind hole; anything else at both ends leaves it through.
          group.floored.push(circleEdges.some((edge) => edge.faceIds.some((otherId) => {
            const other = otherId === face.id ? undefined : faceById.get(otherId);
            if (!other) return false;
            if (other.planar) return other.edgeIds.length === 1;
            return (other.surfaceType === "Cone" || other.surfaceType === "Sphere") && other.edgeIds.filter((edgeId) => edgeById.get(edgeId)?.circle === true).length === 1;
          })));
        }
      }
      // Distinct axes by their position across the axis (within 0.001 mm, found through a grid so the cost stays linear), not along it.
      const alongPoint = dot3(point, direction);
      const across = point.map((value, index) => value - alongPoint * direction[index]!);
      const cell = across.map((value) => Math.floor(value / AXIS_POINT_TOLERANCE));
      let known: AxisPoint | undefined;
      for (let dx = -1; dx <= 1 && !known; dx += 1) for (let dy = -1; dy <= 1 && !known; dy += 1) for (let dz = -1; dz <= 1 && !known; dz += 1) {
        const found = group.grid.get(`${cell[0]! + dx},${cell[1]! + dy},${cell[2]! + dz}`)?.find((at) => distance3(group!.across[at]!, across) <= AXIS_POINT_TOLERANCE);
        if (found !== undefined) known = group.points[found];
      }
      const index = [0, 1, 2].find((candidate) => Math.abs(direction[candidate]!) >= AXIS_ALIGNED);
      const lo = index === undefined ? 0 : face.boundsMm.min[index]!;
      const hi = index === undefined ? 0 : face.boundsMm.max[index]!;
      if (!known) {
        const at = group.points.push({ point, lo, hi, index }) - 1;
        group.across.push(across);
        const cellKey = cell.join(",");
        group.grid.set(cellKey, [...(group.grid.get(cellKey) ?? []), at]);
      } else { known.lo = Math.min(known.lo, lo); known.hi = Math.max(known.hi, hi); }
      continue;
    }

    const entry = others.get(face.surfaceType) ?? { count: 0, halfAngles: new Set<number>() };
    others.set(face.surfaceType, entry);
    entry.count += 1;
    if (face.surfaceType === "Cone" && face.coneSemiAngleRad !== undefined) entry.halfAngles.add(round4(face.coneSemiAngleRad * 180 / Math.PI));
  }

  const header = {
    id: body.id,
    type: body.type,
    name: body.name === null || body.name === undefined || body.name.length <= DESCRIBE_MAX_NAME ? body.name : Array.from(body.name).slice(0, DESCRIBE_MAX_NAME).join(""),
    revision,
    boundsMm: body.boundsMm ? { min: round4Vector(body.boundsMm.min), max: round4Vector(body.boundsMm.max) } : null,
    sizeMm: body.boundsMm ? [0, 1, 2].map((index) => round4(body.boundsMm!.max[index]! - body.boundsMm!.min[index]!)) : null,
    faceCount: body.faceIds.length,
    edgeCount: body.edgeIds.length,
    vertexCount: body.vertices?.length ?? new Set(body.edges.flatMap((edge) => edge.vertexIds)).size,
  };

  // Plane offsets per direction, ascending. Slanted planes keep their own normal on each entry.
  const directions = new Map<string, PlaneEntry[]>();
  const slanted: PlaneEntry[] = [];
  for (const [key, entry] of [...planes].sort((left, right) => left[0].localeCompare(right[0]))) {
    const offsets = [...entry.offsets.values()].sort((left, right) => left.mm - right.mm)
      .map(({ mm, count, face }): PlaneEntry => ({ ...(entry.slanted ? { normal: entry.slanted } : {}), mm, ...(count > 1 ? { count } : {}), face }));
    if (entry.slanted) slanted.push(...offsets); else directions.set(key, offsets);
  }
  if (slanted.length > 0) directions.set("slanted", slanted);

  // One entry per cylinder group, shown by radius; `ranked` is the same list with the most faces first (the keepers when space runs out).
  const describedGroups = [...cylinderGroups]
    .sort((left, right) => left.radiusMm - right.radiusMm || String(left.axis).localeCompare(String(right.axis)) || (left.kind ?? "").localeCompare(right.kind ?? "") || (left.sweepDeg ?? 0) - (right.sweepDeg ?? 0))
    .map((group) => {
      const count = group.points.length;
      const described = {
        radiusMm: group.radiusMm, axis: group.axis, ...(group.kind ? { kind: group.kind } : {}), ...(group.sweepDeg !== undefined ? { sweepDeg: group.sweepDeg } : {}),
        count, ...(group.faces !== count ? { faces: group.faces } : {}),
        axisPointsMm: group.points.map((entry) => {
          // An axis-aligned axis is placed at the middle of its faces' extent, so a hole through a wall reads at mid-wall.
          const at = [...entry.point];
          if (entry.index !== undefined) at[entry.index] = (entry.lo + entry.hi) / 2;
          return round4Vector(at);
        }).sort((left, right) => left[0]! - right[0]! || left[1]! - right[1]! || left[2]! - right[2]!),
      } as BodyDescription["cylinders"][number];
      // Reported only when every face of the group is a full-turn face and they all agree.
      if (group.closed === group.faces) {
        if (group.kind === "hole" && group.floored.length === group.closed && group.floored.every((value) => value === group.floored[0])) described.through = !group.floored[0];
        const firstExtent = group.extents[0];
        if (firstExtent && group.extents.length === group.closed && group.extents.every((extent) => extent && Math.abs(extent[0] - firstExtent[0]) < 1e-3 && Math.abs(extent[1] - firstExtent[1]) < 1e-3)) described.extentMm = [...firstExtent];
      }
      return { described, faces: group.faces };
    });
  let shownGroups = describedGroups;
  let cylindersMore = 0;
  const dropGroups = (keep: ReadonlyArray<(typeof describedGroups)[number]>) => {
    const kept = new Set(keep);
    cylindersMore += shownGroups.length - kept.size;
    shownGroups = shownGroups.filter((group) => kept.has(group));
  };
  const rank = (): typeof describedGroups => [...shownGroups].sort((left, right) => right.faces - left.faces || left.described.radiusMm - right.described.radiusMm);
  if (shownGroups.length > DESCRIBE_MAX_GROUPS) dropGroups(rank().slice(0, DESCRIBE_MAX_GROUPS));

  const otherSurfaces: BodyDescription["otherSurfaces"] = {};
  for (const [type, entry] of [...others].sort((left, right) => left[0].localeCompare(right[0]))) {
    const angles = [...entry.halfAngles].sort((left, right) => left - right);
    otherSurfaces[type] = {
      count: entry.count,
      ...(angles.length > 0 ? { halfAngleDeg: angles.slice(0, DESCRIBE_MAX_HALF_ANGLES) } : {}),
      ...(angles.length > DESCRIBE_MAX_HALF_ANGLES ? { more: angles.length - DESCRIBE_MAX_HALF_ANGLES } : {}),
    };
  }
  // Blend radii: the radii with the most faces stay, shown by radius.
  const allBlends = [...blends];
  const blendEntries = (allBlends.length > DESCRIBE_MAX_BLENDS ? [...allBlends].sort((left, right) => right[1] - left[1] || left[0] - right[0]).slice(0, DESCRIBE_MAX_BLENDS) : allBlends)
    .sort((left, right) => left[0] - right[0]);
  const blendMoreAtStart = allBlends.length - blendEntries.length;
  const cavity = body.boundsMm ? cavityFromPlanes(planes, body.boundsMm) : undefined;

  // Caps: at most 12 offsets per direction and 16 axis points per group, each with a `more` count.
  const planeMore = new Map<string, number>();
  const cutOffsets = (direction: string, keep: number): number => {
    const list = directions.get(direction)!;
    // The bytes freed, less the `more` entry a first cut adds.
    const freed = list.slice(keep).reduce((sum, entry) => sum + sizeOf(entry) + 1, 0) - (planeMore.has(direction) ? 0 : direction.length + 8);
    planeMore.set(direction, (planeMore.get(direction) ?? 0) + list.length - keep);
    list.length = keep;
    return freed;
  };
  for (const [direction, list] of directions) if (list.length > DESCRIBE_MAX_OFFSETS) cutOffsets(direction, DESCRIBE_MAX_OFFSETS);
  for (const { described } of shownGroups) {
    if (described.axisPointsMm.length > DESCRIBE_MAX_AXES) { described.more = described.axisPointsMm.length - DESCRIBE_MAX_AXES; described.axisPointsMm.length = DESCRIBE_MAX_AXES; }
  }

  let keptBlends = blendEntries.length;
  let leftOut: { otherSurfaces?: number; blendRadii?: number; cylinders?: number; planes?: number } = {};
  const assemble = (): BodyDescription => {
    const planesMore = leftOut.planes;
    const blendMore = leftOut.blendRadii !== undefined ? leftOut.blendRadii : blendMoreAtStart + (blendEntries.length - keptBlends);
    const groupsMore = leftOut.cylinders !== undefined ? leftOut.cylinders : cylindersMore;
    const otherMore = leftOut.otherSurfaces;
    const out: BodyDescription = {
      ...header,
      planes: planesMore !== undefined ? {} : {
        ...Object.fromEntries(directions),
        ...(planeMore.size > 0 ? { more: Object.fromEntries(planeMore) } : {}),
      },
      cylinders: leftOut.cylinders !== undefined ? [] : shownGroups.map((group) => group.described),
      ...(groupsMore > 0 ? { cylindersMore: groupsMore } : {}),
      otherSurfaces: otherMore !== undefined ? {} : otherSurfaces,
      blendRadii: leftOut.blendRadii !== undefined ? {} : Object.fromEntries(blendEntries.slice(0, keptBlends).map(([radius, count]) => [String(radius), count])),
      ...(blendMore > 0 ? { blendRadiiMore: blendMore } : {}),
      ...(cavity ? { cavity } : {}),
      ...(otherMore !== undefined ? { otherSurfacesMore: otherMore } : {}),
      ...(planesMore !== undefined ? { planesMore } : {}),
    };
    if (out.cylindersMore || out.blendRadiiMore || out.otherSurfacesMore || out.planesMore) out.truncated = true;
    return out;
  };

  // Hard cap 4 KB. One serialisation tells the size; after that item sizes are subtracted, so the work stays linear.
  // The tail of the longest list goes first (the groups with the fewest faces last of all), keeping every `more` count true.
  let total = sizeOf(assemble());
  if (total > DESCRIBE_MAX_BYTES) {
    let moreKeyCost = (planeMore.size > 0 ? 0 : 10) + (blendMoreAtStart > 0 ? 0 : 24) + (cylindersMore > 0 ? 0 : 24) + 17;
    total += moreKeyCost; // reserved once for the keys and flag that trimming may add
    let guard = 0;
    while (total > DESCRIBE_MAX_BYTES && guard++ < 100_000) {
      const lists: Array<{ length: number; drop: () => number }> = [];
      for (const [direction, list] of directions) {
        if (list.length > 1) lists.push({ length: list.length, drop: () => cutOffsets(direction, list.length - 1) });
      }
      for (const { described } of shownGroups) {
        if (described.axisPointsMm.length > 1) {
          lists.push({ length: described.axisPointsMm.length, drop: () => {
            const freed = sizeOf(described.axisPointsMm[described.axisPointsMm.length - 1]) + 1;
            described.axisPointsMm.pop();
            const costs = described.more === undefined ? 12 : 0;
            described.more = (described.more ?? 0) + 1;
            return freed - costs;
          } });
        }
      }
      if (keptBlends > 1) lists.push({ length: keptBlends, drop: () => { const [radius, count] = blendEntries[keptBlends - 1]!; keptBlends -= 1; return String(radius).length + String(count).length + 5; } });
      if (shownGroups.length > 1) {
        lists.push({ length: 1, drop: () => {
          const lowest = rank().at(-1)!;
          shownGroups = shownGroups.filter((group) => group !== lowest);
          cylindersMore += 1;
          return sizeOf(lowest.described) + 1;
        } });
      }
      if (lists.length === 0) break;
      total -= lists.sort((left, right) => right.length - left.length)[0]!.drop();
    }
    // Last resort: leave whole sections out, least useful first, each as <section>More: <count>.
    const sections: Array<[keyof typeof leftOut, () => number]> = [
      ["otherSurfaces", () => Object.keys(otherSurfaces).length],
      ["blendRadii", () => allBlends.length],
      ["cylinders", () => shownGroups.length + cylindersMore],
      ["planes", () => [...directions.values()].reduce((sum, list) => sum + list.length, 0) + [...planeMore.values()].reduce((sum, value) => sum + value, 0)],
    ];
    let result = assemble();
    for (const [section, count] of sections) {
      if (sizeOf(result) <= DESCRIBE_MAX_BYTES) break;
      leftOut = { ...leftOut, [section]: count() };
      result = assemble();
    }
    return result;
  }
  return assemble();
}

// An open-top pocket from the planes alone. The walls are the widest pair of inward-facing planes on x and on y
// (xPos left of xNeg, both strictly inside the bounds, ranked by the smaller face); the floor is the widest zPos plane
// strictly inside the bounds, and it must cover at least half of the walls' footprint. Anything less clear is left out.
function cavityFromPlanes(planes: Map<string, { offsets: Map<number, PlaneOffset> }>, bounds: { min: readonly number[]; max: readonly number[] }): BodyDescription["cavity"] | undefined {
  const inside = (value: number, axis: number) => value > bounds.min[axis]! + 1e-3 && value < bounds.max[axis]! - 1e-3;
  const wallPair = (axis: number): { lo: number; hi: number } | undefined => {
    const low = planes.get(`${AXIS_NAMES[axis]}Pos`)?.offsets;
    const high = planes.get(`${AXIS_NAMES[axis]}Neg`)?.offsets;
    if (!low || !high) return undefined;
    let best: { lo: number; hi: number; score: number } | undefined;
    for (const lo of low.values()) {
      for (const hi of high.values()) {
        if (!(lo.mm < hi.mm) || !inside(lo.mm, axis) || !inside(hi.mm, axis)) continue;
        const score = Math.min(lo.area, hi.area);
        if (!best || score > best.score) best = { lo: lo.mm, hi: hi.mm, score };
      }
    }
    return best;
  };
  const x = wallPair(0);
  const y = wallPair(1);
  const floors = planes.get("zPos")?.offsets;
  if (!x || !y || !floors) return undefined;
  let floor: PlaneOffset | undefined;
  for (const candidate of floors.values()) {
    if (inside(candidate.mm, 2) && (!floor || candidate.area > floor.area)) floor = candidate;
  }
  if (!floor || floor.area < 0.5 * (x.hi - x.lo) * (y.hi - y.lo)) return undefined;
  return { xMm: [x.lo, x.hi], yMm: [y.lo, y.hi], floorZMm: floor.mm };
}
