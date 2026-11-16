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
type CylinderGroup = {
  radiusMm: number; axis: string | number[]; kind?: "hole" | "boss"; count: number;
  // Distinct axes, keyed by their position across the axis. For an axis-aligned one, lo and hi are the faces' extent along it.
  points: Map<string, { point: number[]; lo: number; hi: number; index: number | undefined }>;
};

type PlaneEntry = { normal?: number[]; mm: number; count?: number; face: string }; // count is left out when it is 1
export interface BodyDescription {
  id: number;
  type: string;
  name: string | null;
  revision: string;
  boundsMm: { min: number[]; max: number[] } | null;
  sizeMm: number[] | null;
  faceCount: number;
  edgeCount: number;
  vertexCount: number;
  // xPos, xNeg, yPos, yNeg, zPos, zNeg and slanted each hold a list of plane entries; `more` maps a direction to the number of offsets left out.
  planes: { [direction: string]: PlaneEntry[] | Record<string, number> | undefined; more?: Record<string, number> };
  cylinders: Array<{ radiusMm: number; axis: string | number[]; kind?: "hole" | "boss"; count: number; axisPointsMm: number[][]; more?: number }>;
  otherSurfaces: Record<string, { count: number; halfAngleDeg?: number[] }>;
  blendRadii: Record<string, number>; // radius mm -> face count
  truncated?: true;
}

export function describeBody(body: DescribedBody, revision: string): BodyDescription {
  const planes = new Map<string, { slanted?: number[]; offsets: Map<number, PlaneOffset> }>();
  const cylinders = new Map<string, CylinderGroup>();
  const others = new Map<string, { count: number; halfAngles: Set<number> }>();
  const blends = new Map<number, number>();

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
      // One sign per axis, so a hole and its mirrored description group together.
      const first = face.axisDirection.find((component) => Math.abs(component) > 1e-9) ?? 1;
      const direction = (first < 0 ? face.axisDirection.map((component) => -component) : face.axisDirection) as [number, number, number];
      const offset = [0, 1, 2].map((index) => face.centerMm[index]! - face.axisOriginMm![index]!);
      const along = dot3(offset, direction);
      const point = [0, 1, 2].map((index) => face.axisOriginMm![index]! + along * direction[index]!);
      const radial = [0, 1, 2].map((index) => face.centerMm[index]! - point[index]!);
      const radialLength = Math.hypot(radial[0]!, radial[1]!, radial[2]!);
      const facing = radialLength > 1e-9 ? dot3(face.normal, radial) / radialLength : 0;
      const kind = facing > 0.5 ? "boss" : facing < -0.5 ? "hole" : undefined;
      const principal = principalKey(direction);
      const axis: string | number[] = principal ? principal.slice(0, 1) : round4Vector(direction);
      const radiusMm = round4(face.radiusMm);
      const key = `${radiusMm}|${Array.isArray(axis) ? axis.join(",") : axis}|${kind ?? ""}`;
      const group = cylinders.get(key) ?? { radiusMm, axis, ...(kind ? { kind } : {}), count: 0, points: new Map() };
      cylinders.set(key, group);
      group.count += 1;
      // Distinct axes by their position across the axis (0.001 mm), not along it.
      const alongPoint = dot3(point, direction);
      const across = point.map((value, index) => value - alongPoint * direction[index]!);
      const pointKey = across.map((value) => Math.round(value * 1000)).join(",");
      const index = [0, 1, 2].find((candidate) => Math.abs(direction[candidate]!) >= AXIS_ALIGNED);
      const known = group.points.get(pointKey);
      const lo = index === undefined ? 0 : face.boundsMm.min[index]!;
      const hi = index === undefined ? 0 : face.boundsMm.max[index]!;
      if (!known) group.points.set(pointKey, { point, lo, hi, index });
      else { known.lo = Math.min(known.lo, lo); known.hi = Math.max(known.hi, hi); }
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
    name: body.name,
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

  const cylinderGroups = [...cylinders.values()]
    .sort((left, right) => left.radiusMm - right.radiusMm || String(left.axis).localeCompare(String(right.axis)) || (left.kind ?? "").localeCompare(right.kind ?? ""))
    .map(({ points, ...group }) => ({ ...group, axisPointsMm: [...points.values()].map((entry) => {
      // An axis-aligned axis is placed at the middle of its faces' extent, so a hole through a wall reads at mid-wall.
      const at = [...entry.point];
      if (entry.index !== undefined) at[entry.index] = (entry.lo + entry.hi) / 2;
      return round4Vector(at);
    }).sort((left, right) => left[0]! - right[0]! || left[1]! - right[1]! || left[2]! - right[2]!) } as BodyDescription["cylinders"][number]));

  const otherSurfaces: BodyDescription["otherSurfaces"] = {};
  for (const [type, entry] of [...others].sort((left, right) => left[0].localeCompare(right[0]))) {
    otherSurfaces[type] = { count: entry.count, ...(entry.halfAngles.size > 0 ? { halfAngleDeg: [...entry.halfAngles].sort((left, right) => left - right) } : {}) };
  }
  const blendEntries = [...blends].sort((left, right) => left[0] - right[0]);

  // Caps: at most 12 offsets per direction and 16 axis points per group, each with a `more` count.
  const planeMore = new Map<string, number>();
  const cutOffsets = (direction: string, keep: number) => {
    const list = directions.get(direction)!;
    planeMore.set(direction, (planeMore.get(direction) ?? 0) + list.length - keep);
    list.length = keep;
  };
  for (const [direction, list] of directions) if (list.length > DESCRIBE_MAX_OFFSETS) cutOffsets(direction, DESCRIBE_MAX_OFFSETS);
  for (const group of cylinderGroups) {
    if (group.axisPointsMm.length > DESCRIBE_MAX_AXES) { group.more = group.axisPointsMm.length - DESCRIBE_MAX_AXES; group.axisPointsMm.length = DESCRIBE_MAX_AXES; }
  }

  let truncated = false;
  let keptBlends = blendEntries.length;
  const assemble = (): BodyDescription => ({
    ...header,
    planes: {
      ...Object.fromEntries(directions),
      ...(planeMore.size > 0 ? { more: Object.fromEntries(planeMore) } : {}),
    },
    cylinders: cylinderGroups,
    otherSurfaces,
    blendRadii: Object.fromEntries(blendEntries.slice(0, keptBlends).map(([radius, count]) => [String(radius), count])),
    ...(truncated ? { truncated: true as const } : {}),
  });

  // Hard cap 4 KB: drop the tail of the longest list first, keeping the `more` counts true.
  while (Buffer.byteLength(JSON.stringify(assemble())) > DESCRIBE_MAX_BYTES) {
    const lists: Array<{ length: number; drop: () => void }> = [];
    for (const [direction, list] of directions) {
      if (list.length > 1) lists.push({ length: list.length, drop: () => cutOffsets(direction, list.length - 1) });
    }
    for (const group of cylinderGroups) {
      if (group.axisPointsMm.length > 1) lists.push({ length: group.axisPointsMm.length, drop: () => { group.axisPointsMm.pop(); group.more = (group.more ?? 0) + 1; } });
    }
    if (keptBlends > 1) lists.push({ length: keptBlends, drop: () => { keptBlends -= 1; truncated = true; } });
    if (cylinderGroups.length > 1) lists.push({ length: 1, drop: () => { cylinderGroups.pop(); truncated = true; } });
    if (lists.length === 0) break;
    lists.sort((left, right) => right.length - left.length)[0]!.drop();
  }
  return assemble();
}
