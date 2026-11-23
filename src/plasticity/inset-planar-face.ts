// plasticity_inset_planar_face (organic-tools-2 phase C, friction 8/9): an inward rim on a planar face in one call.
// offset_face_loops cannot do it (PK 5076 inward, outward over the neighbours), and offset_planar_curves refuses the
// face loop when its segments are SPCurves ("No basis found"). The recipe extracts the outer loop of the face (or of a
// connected set of coplanar faces, e.g. two mirrored halves with a seam), offsets it inward in the face plane (the plane
// is passed to the native factory, so SPCurve segments are fine), imprints it along -normal, optionally pushes the
// inner panel into the Solid (extrude_faces difference) or out of it (union), and removes its temporary Wires.
import type { RuntimeState } from "./runtime.ts";
import type { PlasticityOperations } from "./operations.ts";

type Vector3 = [number, number, number];
type Body = RuntimeState["bodies"][number];
type Face = Body["faces"][number];
type Edge = Body["edges"][number];

export interface InsetPlanarFaceInput {
  bodyId: number;
  faceIds: string[];
  distanceMm: number;
  depthMm?: number | undefined;
  revision: string;
}

export interface InsetPlanarFaceResult {
  recipe: "inset-planar-face";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  bodyId: number;
  sourceFaceIds: string[];
  plane: { originMm: Vector3; normal: Vector3 };
  outerLoop: { edgeIds: string[]; lengthMm: number };
  innerLoopLengthMm: number;
  ignoredHoleLoops: number;
  offsetSign: 1 | -1;
  rimFaceIds: string[];
  panelFaceIds: string[];
  panelDepthMm: number | null;
  depthMm: number | null;
  bodyCountBefore: number;
  bodyCountAfter: number;
  undoSteps: number;
  notes: string[];
}

type InsetOperations = Pick<PlasticityOperations, "state" | "extractEdges" | "offsetPlanarCurves" | "listCurveDirections" | "imprintCurvesOnBody" | "extrudeFaces" | "remove">;

const COPLANAR_NORMAL = 1 - 1e-9;
const COPLANAR_OFFSET_MM = 1e-3;

/** The faces must be planar, share one plane (same oriented normal) and be connected through shared edges. */
export function insetPlane(body: Body, faceIds: string[]): { faces: Face[]; normal: Vector3 } {
  if (faceIds.length === 0) throw new Error("Inset needs at least one face");
  if (new Set(faceIds).size !== faceIds.length) throw new Error("Inset face ids must be unique");
  const faces = faceIds.map((id) => {
    const face = body.faces.find((candidate) => candidate.id === id);
    if (!face) throw new Error(`Unknown current face ${id} on body ${body.id}`);
    if (!face.planar) throw new Error(`Inset needs planar faces; face ${id} is ${face.surfaceType}`);
    return face;
  });
  const normal = unit(faces[0]!.normal);
  for (const face of faces.slice(1)) {
    if (dot(unit(face.normal), normal) < COPLANAR_NORMAL) throw new Error(`Face ${face.id} is not parallel to face ${faces[0]!.id} (same oriented normal needed)`);
    if (Math.abs(dot(sub(face.centerMm, faces[0]!.centerMm), normal)) > COPLANAR_OFFSET_MM) throw new Error(`Face ${face.id} is parallel to face ${faces[0]!.id} but not in its plane`);
  }
  // Connected through shared edges.
  const listed = new Set(faceIds);
  const parent = new Map(faceIds.map((id) => [id, id]));
  const root = (id: string): string => { let at = id; while (parent.get(at) !== at) at = parent.get(at)!; return at; };
  for (const edge of body.edges) {
    const inSet = edge.faceIds.filter((id) => listed.has(id));
    if (inSet.length === 2) parent.set(root(inSet[0]!), root(inSet[1]!));
  }
  if (new Set(faceIds.map(root)).size !== 1) throw new Error("Inset faces must be connected through shared edges (one flat region)");
  return { faces, normal };
}

/** Boundary edges of the face set grouped into loops; the outer loop is the one with the largest extent. */
export function insetLoops(body: Body, faceIds: string[]): { outer: Edge[]; holes: Edge[][] } {
  const listed = new Set(faceIds);
  const boundary = body.edges.filter((edge) => edge.faceIds.filter((id) => listed.has(id)).length === 1);
  if (boundary.length === 0) throw new Error("The faces have no boundary edges");
  const parent = boundary.map((_, index) => index);
  const root = (index: number): number => { let at = index; while (parent[at] !== at) at = parent[at]!; return at; };
  const byVertex = new Map<number, number>();
  boundary.forEach((edge, index) => {
    for (const vertex of edge.vertexIds) {
      const other = byVertex.get(vertex);
      if (other === undefined) byVertex.set(vertex, index);
      else parent[root(index)] = root(other);
    }
  });
  const groups = new Map<number, Edge[]>();
  boundary.forEach((edge, index) => { const key = root(index); groups.set(key, [...(groups.get(key) ?? []), edge]); });
  const loops = [...groups.values()].sort((left, right) => extent(right) - extent(left));
  return { outer: loops[0]!, holes: loops.slice(1) };
}

/** In-plane frame (u, w) for a unit normal. */
export function planeFrame(normal: Vector3): { u: Vector3; w: Vector3 } {
  const seed: Vector3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const along = dot(seed, normal);
  const u = unit(sub(seed, scale(normal, along)));
  const w: Vector3 = [normal[1] * u[2] - normal[2] * u[1], normal[2] * u[0] - normal[0] * u[2], normal[0] * u[1] - normal[1] * u[0]];
  return { u, w };
}

/**
 * The original outer loop as a polygon in plane coordinates (C1): its vertices in loop order with each edge's midpoint
 * between them; a loop with no vertices (one closed edge) uses its circle samples or its edge bounds. Used to keep the
 * rim/panel scan to faces inside the inset region, not every coplanar face of the body.
 */
export function loopPolygon(body: Body, loop: Edge[], plane: { originMm: Vector3; normal: Vector3 }): Array<[number, number]> {
  const { u, w } = planeFrame(plane.normal);
  const to2d = (p: readonly number[]): [number, number] => { const r = sub(p, plane.originMm); return [dot(r, u), dot(r, w)]; };
  const position = new Map((body.vertices ?? []).map((vertex) => [vertex.id, vertex.positionMm as Vector3]));
  const withVertices = loop.filter((edge) => edge.vertexIds.length === 2 && edge.vertexIds.every((id) => position.has(id)));
  const points: Array<[number, number]> = [];
  if (withVertices.length === loop.length && loop.length > 0) {
    const unused = new Set(loop.map((edge) => edge.id));
    let at = loop[0]!.vertexIds[0]!;
    while (unused.size > 0) {
      const next = loop.find((edge) => unused.has(edge.id) && edge.vertexIds.includes(at));
      if (!next) break;
      unused.delete(next.id);
      points.push(to2d(position.get(at)!), to2d(next.centerMm));
      at = next.vertexIds[0] === at ? next.vertexIds[1]! : next.vertexIds[0]!;
    }
    if (unused.size === 0) return points;
    points.length = 0;
  }
  for (const edge of loop) {
    const circle = edge.circleGeometry;
    if (circle && loop.length === 1) {
      const { u: cu, w: cw } = planeFrame(unit(circle.normal));
      for (let k = 0; k < 32; k += 1) {
        const a = (2 * Math.PI * k) / 32;
        points.push(to2d([0, 1, 2].map((i) => circle.centerMm[i]! + circle.radiusMm * (Math.cos(a) * cu[i]! + Math.sin(a) * cw[i]!))));
      }
      return points;
    }
  }
  // Fallback: the bounding rectangle of the loop edges in plane coordinates.
  const corners = loop.flatMap((edge) => [0, 1].flatMap((i) => [0, 1].flatMap((j) => [0, 1].map((k) => to2d([[edge.boundsMm.min[0], edge.boundsMm.max[0]][i]!, [edge.boundsMm.min[1], edge.boundsMm.max[1]][j]!, [edge.boundsMm.min[2], edge.boundsMm.max[2]][k]!])))));
  const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
  return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)], [Math.min(...xs), Math.max(...ys)]];
}

export function insidePolygon(point: [number, number], polygon: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i]!, [xj, yj] = polygon[j]!;
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * After the imprint: coplanar faces split into rim faces (they still carry an edge of the original outer loop, so
 * they touch its points) and panel faces (every edge at least half the inset away from the original outer loop).
 */
export function classifyInsetFaces(body: Body, plane: { originMm: Vector3; normal: Vector3 }, outerPointsMm: Vector3[], distanceMm: number, planeOffsetMm: number, region: Array<[number, number]>): { panel: string[]; rim: string[] } {
  const panel: string[] = [], rim: string[] = [];
  const { u, w } = planeFrame(plane.normal);
  for (const face of body.faces) {
    if (!face.planar || dot(unit(face.normal), plane.normal) < COPLANAR_NORMAL) continue;
    if (Math.abs(dot(sub(face.centerMm, plane.originMm), plane.normal) - planeOffsetMm) > COPLANAR_OFFSET_MM) continue;
    // Only faces inside the original outer loop (C1: another coplanar face elsewhere on the body is not part of it).
    const r = sub(face.centerMm, plane.originMm);
    if (!insidePolygon([dot(r, u), dot(r, w)], region)) continue;
    const points = face.edgeIds.flatMap((id) => {
      const edge = body.edges.find((candidate) => candidate.id === id);
      if (!edge) return [];
      const vertices = (body.vertices ?? []).filter((vertex) => edge.vertexIds.includes(vertex.id)).map((vertex) => vertex.positionMm as Vector3);
      return [edge.centerMm, ...vertices];
    });
    if (points.length === 0) continue;
    const nearest = Math.min(...points.map((point) => Math.min(...outerPointsMm.map((other) => Math.hypot(...sub(point, other))))));
    (nearest > distanceMm / 2 ? panel : rim).push(face.id);
  }
  return { panel, rim };
}

export class InsetPlanarFaceRecipe {
  private readonly operations: InsetOperations;
  constructor(operations: InsetOperations) { this.operations = operations; }

  async inset(input: InsetPlanarFaceInput): Promise<InsetPlanarFaceResult> {
    if (!(Number.isFinite(input.distanceMm) && input.distanceMm > 0)) throw new Error("Inset distanceMm must be a positive millimeter distance (inward)");
    if (input.depthMm !== undefined && !(Number.isFinite(input.depthMm) && input.depthMm !== 0)) throw new Error("depthMm must be nonzero (positive: recess into the Solid, negative: raised panel)");
    const initial = await this.operations.state();
    if (initial.revision !== input.revision) throw new Error(`Stale reference: expected revision ${input.revision}, current revision is ${initial.revision}`);
    const body = initial.bodies.find((candidate) => candidate.id === input.bodyId);
    if (!body || (body.type !== "Solid" && body.type !== "Sheet")) throw new Error(`Inset needs a current Solid or Sheet: ${input.bodyId}`);
    if (input.depthMm !== undefined && body.type !== "Solid") throw new Error("depthMm (recess or raised panel) needs a Solid; leave it out on a Sheet");
    const { faces, normal } = insetPlane(body, input.faceIds);
    const { outer, holes } = insetLoops(body, input.faceIds);
    // The face midpoint lies on the face (runtime reads it at the face's parameter midpoint).
    const plane = { originMm: faces[0]!.centerMm.slice() as Vector3, normal };
    const outerPoints: Vector3[] = [
      ...outer.map((edge) => edge.centerMm),
      ...(body.vertices ?? []).filter((vertex) => outer.some((edge) => edge.vertexIds.includes(vertex.id))).map((vertex) => vertex.positionMm as Vector3),
    ];
    const region = loopPolygon(body, outer, plane);
    const notes: string[] = [];
    if (holes.length > 0) notes.push(`${holes.length} inner loop(s) (holes) of the face were left as they are; only the outer loop is inset`);
    let current = initial;
    const committed: string[] = [];
    const temporary: number[] = [];
    const added = (before: RuntimeState, after: RuntimeState, type: string) => after.bodies.filter((candidate) => candidate.type === type && !before.bodies.some((old) => old.id === candidate.id)).map((candidate) => candidate.id);
    try {
      let before = current;
      current = await this.operations.extractEdges(outer.map((edge) => ({ bodyId: body.id, edgeId: edge.id })), current.revision);
      const loopWires = added(before, current, "Wire");
      committed.push(`extracted the outer loop (Wire ${loopWires.join(", ") || "none"})`);
      temporary.push(...loopWires);
      if (loopWires.length !== 1) throw new Error(`Extracting the outer loop made ${loopWires.length} Wires, expected 1`);
      const lengths = async () => new Map((await this.operations.listCurveDirections()).curves.map((curve) => [curve.id, { length: curve.segments.reduce((sum, segment) => sum + segment.lengthMm, 0), closed: curve.closed }]));
      const loopLength = (await lengths()).get(loopWires[0]!);
      if (!loopLength?.closed) throw new Error("The extracted outer loop is not one closed Wire");
      // Inward is decided from the result: an inward offset of a closed loop is shorter (by 2 pi d when nothing is
      // trimmed). The first try uses +d; if that came out longer it is removed and -d is used.
      let sign: 1 | -1 = 1;
      let inner: number | undefined;
      let innerLength = 0;
      for (const trial of [1, -1] as const) {
        before = current;
        current = await this.operations.offsetPlanarCurves([loopWires[0]!], trial * input.distanceMm, current.revision, plane);
        const made = added(before, current, "Wire");
        committed.push(`offset it by ${trial * input.distanceMm} mm (Wire ${made.join(", ") || "none"})`);
        temporary.push(...made);
        if (made.length !== 1) throw new Error(`Offsetting the loop made ${made.length} Wires, expected 1 (the inset may be wider than the face)`);
        const measured = (await lengths()).get(made[0]!);
        if (measured && measured.closed && measured.length < loopLength.length) { sign = trial; inner = made[0]; innerLength = measured.length; break; }
        if (trial === -1) throw new Error(`Neither offset sign shortened the loop (${loopLength.length.toFixed(3)} mm); the inset is not inward`);
        current = await this.operations.remove(made, current.revision);
        committed.push(`removed the outward offset (Wire ${made.join(", ")})`);
        temporary.splice(temporary.indexOf(made[0]!), 1);
        notes.push("the first offset sign went outward; it was removed and the opposite sign used");
      }
      const bodyCountBefore = initial.bodies.length;
      // Bidirectional: the loop lies in the face plane, so a one-sided projection can miss the face by rounding.
      current = await this.operations.imprintCurvesOnBody(body.id, [inner!], scale(normal, -1), { projectionMethod: "vector", bidirectional: true }, current.revision);
      committed.push(`imprinted the inner loop on body ${body.id}`);
      let split = classifyInsetFaces(current.bodies.find((candidate) => candidate.id === body.id)!, plane, outerPoints, input.distanceMm, 0, region);
      if (split.panel.length === 0) {
        const after = current.bodies.find((candidate) => candidate.id === body.id)!;
        const coplanar = after.faces.filter((face) => face.planar && dot(unit(face.normal), normal) >= COPLANAR_NORMAL).map((face) => `${face.id} at ${dot(sub(face.centerMm, plane.originMm), normal).toFixed(4)} mm`);
        throw new Error(`The imprint made no inner panel face on the plane (body ${body.id} has ${after.faces.length} faces; parallel faces: ${coplanar.join(", ") || "none"}; rim faces: ${split.rim.join(", ") || "none"})`);
      }
      const rimFaceIds = split.rim;
      let panelFaceIds = split.panel;
      let panelDepthMm: number | null = null;
      if (input.depthMm !== undefined) {
        current = await this.operations.extrudeFaces(body.id, panelFaceIds, -input.depthMm, current.revision, input.depthMm > 0 ? "difference" : "union");
        committed.push(`${input.depthMm > 0 ? "recessed" : "raised"} the panel by ${Math.abs(input.depthMm)} mm`);
        const after = current.bodies.find((candidate) => candidate.id === body.id);
        if (!after) throw new Error("The recess removed the source body");
        split = classifyInsetFaces(after, plane, outerPoints, input.distanceMm, -input.depthMm, region);
        panelFaceIds = split.panel;
        if (panelFaceIds.length === 0) throw new Error(`No panel face found ${input.depthMm} mm below the face plane after the recess`);
        const panel = after.faces.find((face) => face.id === panelFaceIds[0]);
        panelDepthMm = panel ? -dot(sub(panel.centerMm, plane.originMm), normal) : null;
      }
      current = await this.operations.remove([...temporary], current.revision);
      temporary.length = 0;
      const finalBody = current.bodies.find((candidate) => candidate.id === body.id)!;
      const rimAfter = input.depthMm === undefined ? rimFaceIds : classifyInsetFaces(finalBody, plane, outerPoints, input.distanceMm, 0, region).rim;
      return {
        recipe: "inset-planar-face", status: "completed", documentToken: current.documentToken,
        beforeRevision: initial.revision, afterRevision: current.revision, bodyId: body.id, sourceFaceIds: input.faceIds,
        plane, outerLoop: { edgeIds: outer.map((edge) => edge.id), lengthMm: loopLength.length }, innerLoopLengthMm: innerLength,
        ignoredHoleLoops: holes.length, offsetSign: sign, rimFaceIds: rimAfter, panelFaceIds, panelDepthMm,
        depthMm: input.depthMm ?? null, bodyCountBefore, bodyCountAfter: current.bodies.length, undoSteps: current.undoDepth - initial.undoDepth, notes,
      };
    } catch (error) {
      // C2: say exactly what was committed and how many Undo steps that is (measured, not counted).
      let cleaned = "";
      if (temporary.length > 0) {
        try {
          await this.operations.remove([...temporary], (await this.operations.state()).revision);
          committed.push(`removed the temporary Wires ${temporary.join(", ")}`);
          cleaned = "";
        } catch { cleaned = `; temporary Wires ${temporary.join(", ")} may remain`; }
      }
      let steps: number | null = null;
      try { steps = (await this.operations.state()).undoDepth - initial.undoDepth; } catch { steps = null; }
      const detail = error instanceof Error ? error.message : String(error);
      const done = committed.length > 0 ? `committed: ${committed.join("; ")}` : "nothing was committed";
      const undo = steps === null ? "the Undo depth could not be read; read the document before you continue" : steps === 0 ? "the document is unchanged" : `the document is ${steps} Undo step${steps === 1 ? "" : "s"} past revision ${initial.revision}: undo ${steps} with plasticity_undo to return to it`;
      throw new Error(`Inset failed: ${detail}. Before the failure it ${done}${cleaned}; ${undo}.`, { cause: error });
    }
  }
}

function extent(edges: Edge[]): number {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const edge of edges) for (let axis = 0; axis < 3; axis += 1) { min[axis] = Math.min(min[axis]!, edge.boundsMm.min[axis]!); max[axis] = Math.max(max[axis]!, edge.boundsMm.max[axis]!); }
  return Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
}
function dot(a: readonly number[], b: readonly number[]): number { return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!; }
function sub(a: readonly number[], b: readonly number[]): Vector3 { return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!]; }
function add(a: readonly number[], b: readonly number[]): Vector3 { return [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!]; }
function scale(a: readonly number[], f: number): Vector3 { return [a[0]! * f, a[1]! * f, a[2]! * f]; }
function unit(a: readonly number[]): Vector3 { const l = Math.hypot(a[0]!, a[1]!, a[2]!); if (!(l > 0)) throw new Error("Face normal is zero"); return [a[0]! / l, a[1]! / l, a[2]! / l]; }
