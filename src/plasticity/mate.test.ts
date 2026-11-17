import assert from "node:assert/strict";
import { test } from "node:test";

import { CommittedChangeError } from "./operations.ts";
import type { RuntimeState } from "./runtime.ts";
import {
  ANCHOR_POINTS, AxisRefusal, axisRays, boundsAnchor, circleSweepDeg, cylinderRadiiSummary, fullTurnCylinders, GuardedRunError, lineBoxSpan, placeBody, planEntry, planPlacement, planTransfer,
  pointInPlanarFace, quarterTurnMatrix, rotateBounds, runGuarded, selectSourceAxes, transferHoles, type Vector3,
  CLEARANCE_RING_MM, FLOOR_RIM_INSET_MM, floorProblem, floorRays, RIM_RAYS, RIM_RAYS_LARGE, rimRayCount, unprovenRay, UNRESOLVED_CODE_RULE,
} from "./mate.ts";
import { PROBE_SURFACE_UNRESOLVED_CODES, probeOddParityReason, type ProbeRayResult } from "./surfacing.ts";

// ---------- a small geometric kernel: boxes, cylinder cutters, holes, quarter-turn rotations, undo ----------

type Vec = Vector3;
type Body = RuntimeState["bodies"][number];
type Face = Body["faces"][number];
type Edge = Body["edges"][number];
interface Hole { origin: Vec; dir: Vec; radius: number; from: number; to: number; blind: boolean; cone?: number }
// A pin is an outward cylinder face on a body (a boss, facing 1) or one whose normal runs along its axis (facing 0: its
// kind cannot be proven). Pins are faces only; they do not change the body's bounds.
// facing -1 with quarter: an inward quarter round (a pocket-corner fillet) whose circle edges are 90 degree arcs.
interface Pin { origin: Vec; dir: Vec; radius: number; from: number; to: number; facing: 1 | 0 | -1; quarter?: boolean }
interface KBody { id: number; type: string; name: string | null; min: Vec; max: Vec; holes: Hole[]; pins?: Pin[]; cutter?: { center: Vec; radius: number; height: number; axis: Vec; cone?: number }; points?: Vec[] }

const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
const dotv = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unitv = (a: Vec): Vec => mul(a, 1 / Math.hypot(...a));
const perp = (d: Vec): Vec => { const h: Vec = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; const c: Vec = [d[1] * h[2] - d[2] * h[1], d[2] * h[0] - d[0] * h[2], d[0] * h[1] - d[1] * h[0]]; return unitv(c); };
const matrixApply = (m: number[][], v: Vec): Vec => [0, 1, 2].map((r) => m[r]![0]! * v[0] + m[r]![1]! * v[1] + m[r]![2]! * v[2]) as Vec;

function kernel() {
  let bodies: KBody[] = [];
  let next = 1;
  let rev = 1;
  let undoDepth = 0;
  const history: string[] = [];
  const calls: Array<{ op: string; args: unknown[] }> = [];
  // halfExit: the exit circle of a through hole reads as a half arc; sideLine: the bore face also has a line edge on the
  // body's +X face (a side breakout); splitBore: a through bore reads as two separate cylinder faces (two walls).
  const control: { failOn?: string | undefined; uncertainOn?: string | undefined; tamper?: ((bodies: KBody[]) => void) | undefined; halfEntry?: boolean | undefined; invalid?: boolean | undefined; halfExit?: boolean | undefined; sideLine?: boolean | undefined; splitBore?: boolean | undefined; coneHalf?: boolean | undefined; floorLine?: boolean | undefined } = {};
  const find = (id: number) => { const body = bodies.find((candidate) => candidate.id === id); if (!body) throw new Error(`no body ${id}`); return body; };

  const faceId = (id: number, k: number, side: number) => `${id}:p${"xyz"[k]}${side > 0 ? "+" : "-"}`;
  function bodyState(body: KBody): Body {
    if (body.type === "Wire") return { id: body.id, versionId: body.id, type: "Wire", name: body.name, boundsMm: { min: body.min, max: body.max }, faceIds: [], edgeIds: [], faces: [], edges: [] } as unknown as Body;
    const faces: Face[] = [];
    const edges: Edge[] = [];
    const planeFaces = new Map<string, Face>();
    for (let k = 0; k < 3; k += 1) for (const side of [-1, 1]) {
      const center: Vec = [(body.min[0] + body.max[0]) / 2, (body.min[1] + body.max[1]) / 2, (body.min[2] + body.max[2]) / 2];
      center[k] = side < 0 ? body.min[k]! : body.max[k]!;
      const normal: Vec = [0, 0, 0]; normal[k] = side;
      const fmin: Vec = [...body.min]; const fmax: Vec = [...body.max]; fmin[k] = center[k]!; fmax[k] = center[k]!;
      const face = { id: faceId(body.id, k, side), surfaceType: "Plane", planar: true, centerMm: center, normal, radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: fmin, max: fmax }, edgeIds: [] as string[] } as Face;
      planeFaces.set(face.id, face);
      faces.push(face);
    }
    for (let k = 0; k < 3; k += 1) {
      const [i, j] = [0, 1, 2].filter((axis) => axis !== k) as [number, number];
      for (const si of [-1, 1]) for (const sj of [-1, 1]) {
        const center: Vec = [0, 0, 0];
        center[k] = (body.min[k]! + body.max[k]!) / 2; center[i] = si < 0 ? body.min[i]! : body.max[i]!; center[j] = sj < 0 ? body.min[j]! : body.max[j]!;
        const tangent: Vec = [0, 0, 0]; tangent[k] = 1;
        const edge = { id: `${body.id}:l${k}${si}${sj}`, curveType: "Line", line: true, circle: false, lengthMm: body.max[k]! - body.min[k]!, centerMm: center, tangent, boundsMm: { min: center, max: center }, faceIds: [faceId(body.id, i, si), faceId(body.id, j, sj)], vertexIds: [] } as Edge;
        edges.push(edge);
        planeFaces.get(faceId(body.id, i, si))!.edgeIds.push(edge.id);
        planeFaces.get(faceId(body.id, j, sj))!.edgeIds.push(edge.id);
      }
    }
    const planeAt = (point: Vec, dir: Vec): Face | undefined => faces.find((face) => face.planar && Math.abs(Math.abs(dotv(face.normal, dir)) - 1) < 1e-12 && Math.abs(dotv(sub(point, face.centerMm), face.normal)) < 1e-9);
    body.holes.forEach((hole, n) => {
      const p = perp(hole.dir);
      const circle = (s: number, radius: number, tag: string, owner: string, other?: Face): Edge => {
        const c = add(hole.origin, mul(hole.dir, s));
        // control.halfEntry: the entry circle reads back as a half arc (start, a quarter point, the opposite point).
        const q: Vec = [hole.dir[1] * p[2] - hole.dir[2] * p[1], hole.dir[2] * p[0] - hole.dir[0] * p[2], hole.dir[0] * p[1] - hole.dir[1] * p[0]];
        const half = (control.halfEntry === true && tag === "a") || (control.halfExit === true && tag === "b");
        const edge = { id: `${body.id}:c${n}${tag}`, curveType: "Circle", line: false, circle: true, lengthMm: 2 * Math.PI * radius, centerMm: add(c, mul(p, radius)), tangent: [0, 0, 1], boundsMm: { min: c, max: c }, faceIds: [owner, ...(other ? [other.id] : [])], vertexIds: [],
          circleGeometry: { centerMm: c, radiusMm: radius, normal: hole.dir, reference: p, startMm: add(c, mul(p, radius)), midpointMm: half ? add(c, mul(q, radius)) : sub(c, mul(p, radius)), endMm: half ? sub(c, mul(p, radius)) : add(c, mul(p, radius)) } } as Edge;
        edges.push(edge);
        if (other) other.edgeIds.push(edge.id);
        return edge;
      };
      const id = `${body.id}:h${n}`;
      const entryFace = planeAt(add(hole.origin, mul(hole.dir, hole.from)), hole.dir);
      const exitFace = hole.blind ? undefined : planeAt(add(hole.origin, mul(hole.dir, hole.to)), hole.dir);
      const floor = hole.blind ? { id: `${body.id}:fl${n}`, surfaceType: "Plane", planar: true, centerMm: add(hole.origin, mul(hole.dir, hole.to)), normal: mul(hole.dir, -1), radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: hole.origin, max: hole.origin }, edgeIds: [] as string[] } as Face : undefined;
      // The face bounds: the boxes of its two end circles.
      const circleBox = (s0: number, s1: number) => {
        const ends = [s0, s1].map((s) => add(hole.origin, mul(hole.dir, s)));
        const spread = [0, 1, 2].map((i) => hole.radius * Math.sqrt(Math.max(0, 1 - hole.dir[i]! ** 2)));
        return { min: [0, 1, 2].map((i) => Math.min(...ends.map((end) => end[i]!)) - spread[i]!) as Vec, max: [0, 1, 2].map((i) => Math.max(...ends.map((end) => end[i]!)) + spread[i]!) as Vec };
      };
      const bore = (faceIdText: string, s0: number, s1: number, edgeIds: string[]): Face => ({ id: faceIdText, surfaceType: "Cylinder", planar: false, centerMm: add(add(hole.origin, mul(hole.dir, (s0 + s1) / 2)), mul(p, hole.radius)), normal: mul(p, -1), radiusMm: hole.radius, blendRadiusMm: null, axisOriginMm: add(hole.origin, mul(hole.dir, hole.from)), axisDirection: hole.dir, boundsMm: circleBox(s0, s1), edgeIds } as Face);
      const c0 = circle(hole.from, hole.radius, "a", id, entryFace);
      if (control.splitBore === true && !hole.blind) {
        const quarter = (hole.to - hole.from) / 4;
        const inner0 = circle(hole.from + quarter, hole.radius, "m", id);
        const inner1 = circle(hole.to - quarter, hole.radius, "n", `${id}s`);
        const c1 = circle(hole.to, hole.radius, "b", `${id}s`, exitFace);
        faces.push(bore(id, hole.from, hole.from + quarter, [c0.id, inner0.id]), bore(`${id}s`, hole.to - quarter, hole.to, [inner1.id, c1.id]));
      } else {
        const c1 = circle(hole.to, hole.radius, "b", id, exitFace ?? floor);
        const own = [c0.id, c1.id];
        if (control.sideLine === true) {
          const side = { id: `${body.id}:sl${n}`, curveType: "Line", line: true, circle: false, lengthMm: hole.to - hole.from, centerMm: add(hole.origin, mul(hole.dir, (hole.from + hole.to) / 2)), tangent: hole.dir, boundsMm: { min: hole.origin, max: hole.origin }, faceIds: [id, faceId(body.id, 0, 1)], vertexIds: [] } as Edge;
          edges.push(side);
          own.push(side.id);
        }
        faces.push(bore(id, hole.from, hole.to, own));
      }
      if (floor) {
        if (control.floorLine === true) {
          const side = { id: `${body.id}:fl${n}line`, curveType: "Line", line: true, circle: false, lengthMm: hole.radius, centerMm: floor.centerMm, tangent: perp(hole.dir), boundsMm: { min: floor.centerMm, max: floor.centerMm }, faceIds: [floor.id, faceId(body.id, 0, 1)], vertexIds: [] } as Edge;
          edges.push(side);
          floor.edgeIds.push(side.id);
        }
        faces.push(floor);
      }
      if (hole.cone !== undefined) {
        const coneId = `${body.id}:k${n}`;
        const major = circle(hole.from, hole.cone, "k", coneId, entryFace);
        // The cone's small end: the bore radius, (head - bore) radius deep for 90 degrees.
        const minor = circle(hole.from + (hole.cone - hole.radius), hole.radius, "j", coneId);
        if (control.coneHalf) {
          const g = major.circleGeometry!;
          const q: Vec = [hole.dir[1] * p[2] - hole.dir[2] * p[1], hole.dir[2] * p[0] - hole.dir[0] * p[2], hole.dir[0] * p[1] - hole.dir[1] * p[0]];
          major.circleGeometry = { ...g, midpointMm: add(g.centerMm, mul(q, hole.cone)), endMm: sub(g.centerMm, mul(p, hole.cone)) };
        }
        faces.push({ id: coneId, surfaceType: "Cone", planar: false, centerMm: add(add(hole.origin, mul(hole.dir, hole.from + (hole.cone - hole.radius) / 2)), mul(p, (hole.cone + hole.radius) / 2)), normal: unitv(sub(mul(p, -1), hole.dir)), radiusMm: null, blendRadiusMm: null, axisOriginMm: add(hole.origin, mul(hole.dir, hole.from)), axisDirection: hole.dir, boundsMm: { min: hole.origin, max: hole.origin }, edgeIds: [major.id, minor.id] } as Face);
      }
    });
    (body.pins ?? []).forEach((pin, n) => {
      const p = perp(pin.dir);
      const id = `${body.id}:pin${n}`;
      const q: Vec = [pin.dir[1] * p[2] - pin.dir[2] * p[1], pin.dir[2] * p[0] - pin.dir[0] * p[2], pin.dir[0] * p[1] - pin.dir[1] * p[0]];
      const ring = (s: number, tag: string): Edge => {
        const c = add(pin.origin, mul(pin.dir, s));
        const edge = { id: `${id}${tag}`, curveType: "Circle", line: false, circle: true, lengthMm: 2 * Math.PI * pin.radius, centerMm: add(c, mul(p, pin.radius)), tangent: [0, 0, 1], boundsMm: { min: c, max: c }, faceIds: [id], vertexIds: [],
          circleGeometry: pin.quarter
            ? { centerMm: c, radiusMm: pin.radius, normal: pin.dir, reference: p, startMm: add(c, mul(p, pin.radius)), midpointMm: add(c, mul(unitv(add(p, q)), pin.radius)), endMm: add(c, mul(q, pin.radius)) }
            : { centerMm: c, radiusMm: pin.radius, normal: pin.dir, reference: p, startMm: add(c, mul(p, pin.radius)), midpointMm: sub(c, mul(p, pin.radius)), endMm: add(c, mul(p, pin.radius)) } } as Edge;
        edges.push(edge);
        return edge;
      };
      const ends = [pin.from, pin.to].map((s) => add(pin.origin, mul(pin.dir, s)));
      const spread = [0, 1, 2].map((i) => pin.radius * Math.sqrt(Math.max(0, 1 - pin.dir[i]! ** 2)));
      const boundsMm = { min: [0, 1, 2].map((i) => Math.min(...ends.map((end) => end[i]!)) - spread[i]!) as Vec, max: [0, 1, 2].map((i) => Math.max(...ends.map((end) => end[i]!)) + spread[i]!) as Vec };
      const edgeIds = [ring(pin.from, "a").id, ring(pin.to, "b").id];
      faces.push({ id, surfaceType: "Cylinder", planar: false, centerMm: add(add(pin.origin, mul(pin.dir, (pin.from + pin.to) / 2)), mul(p, pin.radius)), normal: pin.facing === 1 ? p : pin.facing === -1 ? mul(p, -1) : pin.dir, radiusMm: pin.radius, blendRadiusMm: null, axisOriginMm: add(pin.origin, mul(pin.dir, pin.from)), axisDirection: pin.dir, boundsMm, edgeIds } as Face);
    });
    return { id: body.id, versionId: body.id, type: body.type, name: body.name, boundsMm: { min: [...body.min], max: [...body.max] }, faceIds: faces.map((face) => face.id), edgeIds: edges.map((edge) => edge.id), faces, edges } as unknown as Body;
  }
  const state = (): RuntimeState => ({
    targetId: "t", title: "Untitled", documentToken: "doc", revision: `r${rev}`, dbVersion: rev, undoDepth, redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" }, bodies: bodies.map(bodyState),
  } as unknown as RuntimeState);
  const mutate = (op: string, args: unknown[], revision: string | undefined, apply: () => void) => {
    calls.push({ op, args });
    if (control.uncertainOn === op) throw new Error("CDP request timed out: test");
    if (control.failOn === op) throw new Error(`${op} failed in the test kernel`);
    if (revision !== undefined && revision !== `r${rev}`) throw new Error(`Stale reference: expected revision ${revision}, current revision is r${rev}`);
    history.push(JSON.stringify({ bodies, next }));
    apply();
    control.tamper?.(bodies);
    rev += 1; undoDepth += 1;
    return state();
  };
  const addBody = (body: Omit<KBody, "id">) => { const created = { ...body, id: next++ }; bodies.push(created); return created; };
  const operations = {
    async state() { return state(); },
    // The native B-Rep Check (read-only, not recorded in calls); control.invalid makes it report a defect.
    async validateBodies(ids: number[], revision: string) {
      if (revision !== `r${rev}`) throw new Error(`Stale reference: expected revision ${revision}, current revision is r${rev}`);
      return { documentToken: "doc", revision, measurementSource: "native-brep", bodies: ids.map((id) => ({ id, versionId: id, type: find(id).type, name: find(id).name, measurementSource: "native-brep", faceCount: 0, edgeCount: 0, boundaryEdgeIds: [], closed: !control.invalid, nativeCheckCodes: control.invalid ? [7] : [], nativeValid: !control.invalid, printableSolid: !control.invalid })) };
    },
    // The ray probe (read-only, not recorded in calls): exact hits on the read model.
    async probeSurface(request: { id: number; rays?: CastRay[] }, revision: string) {
      if (revision !== `r${rev}`) throw new Error(`Stale reference: expected revision ${revision}, current revision is r${rev}`);
      return await probeOf(() => state().bodies)(request);
    },
    async undo() {
      calls.push({ op: "undo", args: [] });
      const last = history.pop();
      if (!last) throw new Error("nothing to undo");
      ({ bodies, next } = JSON.parse(last));
      rev += 1; undoDepth -= 1;
      return state();
    },
    async createBox(origin: Vec, size: Vec, name: string | undefined, revision: string) {
      return mutate("createBox", [origin, size, name], revision, () => addBody({ type: "Solid", name: name ?? null, min: [...origin], max: add(origin, size), holes: [] }));
    },
    async createCylinder(center: Vec, radius: number, height: number, _name: string | undefined, revision: string, axis: Vec = [0, 0, 1]) {
      return mutate("createCylinder", [center, radius, height, axis], revision, () => {
        const d = unitv(axis);
        const top = add(center, mul(d, height));
        addBody({ type: "Solid", name: null, min: [0, 1, 2].map((i) => Math.min(center[i]!, top[i]!) - radius) as Vec, max: [0, 1, 2].map((i) => Math.max(center[i]!, top[i]!) + radius) as Vec, holes: [], cutter: { center, radius, height, axis: d } });
      });
    },
    async createPolyline(points: Vec[], _closed: boolean, revision: string) {
      return mutate("createPolyline", [points], revision, () => addBody({ type: "Wire", name: null, min: points[0]!, max: points[0]!, holes: [], points }));
    },
    async revolveProfile(id: number, origin: Vec, axis: Vec, _angle: number, revision: string) {
      return mutate("revolveProfile", [id, origin, axis], revision, () => {
        const wire = find(id);
        const d = unitv(axis);
        const major = Math.max(...wire.points!.map((point) => { const v = sub(point, origin); const along = dotv(v, d); return Math.hypot(...sub(v, mul(d, along))); }));
        addBody({ type: "Solid", name: null, min: origin, max: origin, holes: [], cutter: { center: origin, radius: 0, height: 0, axis: d, cone: major } });
      });
    },
    async boolean(targetIds: number[], toolIds: number[], operation: string, _keep: boolean, revision: string) {
      return mutate("boolean", [targetIds, toolIds, operation], revision, () => {
        const target = find(targetIds[0]!);
        for (const toolId of toolIds) {
          const tool = find(toolId);
          if (operation === "union") { target.min = [0, 1, 2].map((i) => Math.min(target.min[i]!, tool.min[i]!)) as Vec; target.max = [0, 1, 2].map((i) => Math.max(target.max[i]!, tool.max[i]!)) as Vec; continue; }
          const cutter = tool.cutter!;
          if (cutter.cone !== undefined) {
            const hole = target.holes.find((candidate) => Math.hypot(...sub(sub(candidate.origin, cutter.center), mul(candidate.dir, dotv(sub(candidate.origin, cutter.center), candidate.dir)))) < 1e-9);
            if (hole) { hole.cone = cutter.cone; const s = dotv(sub(cutter.center, hole.origin), hole.dir); if (Math.abs(s - hole.from) > 1e-9) throw new Error("cone not at the entry"); }
            continue;
          }
          const span = lineBoxSpan(cutter.center, cutter.axis, { min: target.min, max: target.max });
          if (!span) continue;
          const from = Math.max(0, span[0]);
          const to = Math.min(cutter.height, span[1]);
          if (to <= from) continue;
          target.holes.push({ origin: cutter.center, dir: cutter.axis, radius: cutter.radius, from, to, blind: to < span[1] - 1e-9 });
        }
        bodies = bodies.filter((body) => !toolIds.includes(body.id));
      });
    },
    async move(ids: number[], delta: Vec, revision: string) {
      return mutate("move", [ids, delta], revision, () => { for (const id of ids) { const body = find(id); body.min = add(body.min, delta); body.max = add(body.max, delta); body.holes.forEach((hole) => { hole.origin = add(hole.origin, delta); }); } });
    },
    async rotate(ids: number[], pivot: Vec, axis: Vec, degrees: number, revision: string) {
      return mutate("rotate", [ids, pivot, axis, degrees], revision, () => {
        const name = axis[0] ? "x" : axis[1] ? "y" : "z";
        const m = quarterTurnMatrix(name, Math.round(degrees / 90));
        for (const id of ids) {
          const body = find(id);
          const turned = rotateBounds(m, pivot, { min: body.min, max: body.max });
          body.min = turned.min; body.max = turned.max;
          body.holes.forEach((hole) => { hole.origin = add(pivot, matrixApply(m, sub(hole.origin, pivot))); hole.dir = matrixApply(m, hole.dir); });
        }
      });
    },
    async duplicateBodies(ids: number[], delta: Vec, revision: string) {
      return mutate("duplicateBodies", [ids, delta], revision, () => { for (const id of ids) { const body = find(id); const copy = JSON.parse(JSON.stringify(body)) as KBody; addBody({ ...copy, name: `${body.name}.001`, min: add(copy.min, delta), max: add(copy.max, delta), holes: copy.holes.map((hole) => ({ ...hole, origin: add(hole.origin, delta) })) }); } });
    },
    async remove(ids: number[], revision: string) {
      return mutate("remove", [ids], revision, () => { bodies = bodies.filter((body) => !ids.includes(body.id)); });
    },
    async fillet() { throw new Error("not in the test kernel"); },
    async extrudeRegions() { throw new Error("not in the test kernel"); },
    async rectangularPattern() { throw new Error("not in the test kernel"); },
    async createPipes() { throw new Error("not in the test kernel"); },
  };
  // Fixture only: adds a pin face to a body without an Undo step.
  const addPin = (id: number, pin: Pin) => { const body = find(id); body.pins = [...(body.pins ?? []), pin]; };
  return { operations: operations as unknown as Parameters<typeof transferHoles>[0] & Parameters<typeof placeBody>[0], calls, control, state, rev: () => `r${rev}`, bodies: () => bodies, addPin };
}

// ---------- an exact ray caster on the read model (the test stand-in for plasticity_probe_surface) ----------
// Planar faces are trimmed by their own edges (lines and circles, inner loops included, through pointInPlanarFace) or,
// for a hand-built face with other edges, by its polygon; cylinders by the axial span of their circle edges (or, without
// two measured circles, by the face bounds, exact for these test faces). Cones are not cast (no test casts through one).
type CastRay = { originMm: Vec; direction: Vec };
function castRays(body: Body, rays: CastRay[]) {
  const edgeById = new Map(body.edges.map((edge) => [edge.id, edge]));
  return rays.map((ray) => {
    const o = ray.originMm;
    const d = unitv(ray.direction);
    const hits: Array<{ t: number; faceId: string; normal: Vec }> = [];
    for (const face of body.faces) {
      if (face.planar) {
        const n = unitv(face.normal);
        const den = dotv(n, d);
        if (Math.abs(den) < 1e-12) continue;
        const t = dotv(sub(face.centerMm, o), n) / den;
        if (t < -1e-9) continue;
        const p = add(o, mul(d, t));
        const exact = pointInPlanarFace(body, face, p);
        const polygon = (face as Face & { points?: Vec[] }).points;
        const inside = exact ? exact.inside || exact.boundaryDistanceMm <= 1e-9 : polygon ? insidePolygon(polygon, n, p) : false;
        if (inside) hits.push({ t: Math.max(0, t), faceId: face.id, normal: n });
      } else if (face.surfaceType === "Cylinder" && face.radiusMm !== null && face.axisOriginMm && face.axisDirection) {
        const e = unitv(face.axisDirection);
        const w = sub(o, face.axisOriginMm);
        const dp = sub(d, mul(e, dotv(d, e)));
        const wp = sub(w, mul(e, dotv(w, e)));
        const a = dotv(dp, dp);
        if (a < 1e-15) continue;
        const b = 2 * dotv(dp, wp);
        const c = dotv(wp, wp) - face.radiusMm ** 2;
        const disc = b * b - 4 * a * c;
        if (disc < 0) continue;
        const circles = face.edgeIds.map((id) => edgeById.get(id)).filter((edge): edge is Edge => !!edge?.circleGeometry).map((edge) => dotv(sub(edge.circleGeometry!.centerMm, face.axisOriginMm!), e));
        const radialOut = dotv(face.normal, sub(face.centerMm, add(face.axisOriginMm, mul(e, dotv(sub(face.centerMm, face.axisOriginMm), e))))) > 0;
        for (const t of [(-b - Math.sqrt(disc)) / (2 * a), (-b + Math.sqrt(disc)) / (2 * a)]) {
          if (t < -1e-9) continue;
          const p = add(o, mul(d, t));
          const s = dotv(sub(p, face.axisOriginMm), e);
          const within = circles.length >= 2 ? s >= Math.min(...circles) - 1e-9 && s <= Math.max(...circles) + 1e-9
            : [0, 1, 2].every((i) => p[i]! >= face.boundsMm.min[i]! - 1e-9 && p[i]! <= face.boundsMm.max[i]! + 1e-9);
          if (!within) continue;
          const radial = unitv(sub(p, add(face.axisOriginMm, mul(e, s))));
          hits.push({ t: Math.max(0, t), faceId: face.id, normal: radialOut ? radial : mul(radial, -1) });
        }
      }
    }
    hits.sort((x, y) => x.t - y.t);
    const merged: Array<{ pointMm: Vec; faceId: string; otherFaceIds?: string[]; normal: Vec; distanceMm: number; residualMm: number }> = [];
    for (const hit of hits) {
      const last = merged.at(-1);
      if (last && Math.abs(last.distanceMm - hit.t) <= 1e-6) { last.otherFaceIds = [...(last.otherFaceIds ?? []), hit.faceId]; continue; }
      merged.push({ pointMm: add(o, mul(d, hit.t)), faceId: hit.faceId, normal: hit.normal, distanceMm: hit.t, residualMm: 0 });
    }
    return { originMm: o, direction: d, hits: merged.length, intersections: merged };
  });
}
function insidePolygon(points: Vec[], normal: Vec, p: Vec): boolean {
  const u = perp(normal);
  const v: Vec = [normal[1] * u[2] - normal[2] * u[1], normal[2] * u[0] - normal[0] * u[2], normal[0] * u[1] - normal[1] * u[0]];
  const q = [dotv(p, u), dotv(p, v)];
  const poly = points.map((point) => [dotv(point, u), dotv(point, v)]);
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!; const [xj, yj] = poly[j]!;
    if ((yi! > q[1]!) !== (yj! > q[1]!) && q[0]! < ((xj! - xi!) * (q[1]! - yi!)) / (yj! - yi!) + xi!) inside = !inside;
  }
  return inside;
}
const probeOf = (bodies: () => Body[]) => async (request: { id: number; rays?: CastRay[] }) => {
  const body = bodies().find((candidate) => candidate.id === request.id)!;
  return { id: body.id, bodyType: body.type, revision: "r", source: "native-brep-ray-newton", acceptResidualMm: 1e-6, rays: castRays(body, request.rays ?? []), note: "test caster" };
};
/** planEntry with the test caster: the rays planTransfer would cast, cast on this body. */
function entryOf(body: Body, axis: Parameters<typeof planEntry>[1], index: number, radius: number | number[]) {
  const radii = Array.isArray(radius) ? radius : [radius];
  const rays = axisRays(axis, radii);
  return planEntry(body, axis, index, radii, { plus: castRays(body, rays.plus) as never, minus: castRays(body, rays.minus) as never });
}
/** planTransfer against a fixed state, cast with the test caster. */
const planTransferOn = (state: RuntimeState, input: Parameters<typeof planTransfer>[2]) => planTransfer({ probeSurface: probeOf(() => state.bodies) as never }, state, input);

async function build(k: ReturnType<typeof kernel>, steps: Array<(revision: string) => Promise<RuntimeState>>) {
  for (const step of steps) await step(k.rev());
  k.calls.length = 0;
  return k.state();
}

// ---------- place_body: anchors and the rigid transform ----------

test("boundsAnchor gives every vocabulary point from the bounds", () => {
  const bounds = { min: [0, 10, 20] as Vec, max: [4, 16, 30] as Vec };
  const expected: Record<string, Vec> = {
    min: [0, 10, 20], max: [4, 16, 30], center: [2, 13, 25], "bottom-center": [2, 13, 20], "top-center": [2, 13, 30],
    "x--center": [0, 13, 25], "x+-center": [4, 13, 25], "y--center": [2, 10, 25], "y+-center": [2, 16, 25], "z--center": [2, 13, 20], "z+-center": [2, 13, 30],
  };
  assert.deepEqual([...ANCHOR_POINTS].sort(), Object.keys(expected).sort());
  for (const point of ANCHOR_POINTS) assert.deepEqual(boundsAnchor(bounds, point), expected[point], point);
});

test("quarter turns are exact right-hand rotations and four turns are the identity", () => {
  assert.deepEqual(quarterTurnMatrix("x", 1).map((row) => row.map((v) => v + 0)), [[1, 0, 0], [0, 0, -1], [0, 1, 0]]);
  assert.deepEqual(quarterTurnMatrix("z", 1).map((row) => row.map((v) => v + 0)), [[0, -1, 0], [1, 0, 0], [0, 0, 1]]);
  assert.deepEqual(quarterTurnMatrix("y", 1).map((row) => row.map((v) => v + 0)), [[0, 0, 1], [0, 1, 0], [-1, 0, 0]]);
  assert.deepEqual(quarterTurnMatrix("y", 4).map((row) => row.map((v) => v + 0)), [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  // A 10 x 2 x 4 box turned a quarter about z through its centre becomes 2 x 10 x 4 about the same centre.
  assert.deepEqual(rotateBounds(quarterTurnMatrix("z", 1), [5, 1, 2], { min: [0, 0, 0], max: [10, 2, 4] }), { min: [4, -4, 0], max: [6, 6, 4] });
});

test("place_body with every bounds anchor lands that point on the fixed anchor, in one move", async () => {
  for (const point of ANCHOR_POINTS) {
    const k = kernel();
    await build(k, [(r) => k.operations.createBox([0, 0, 0], [10, 20, 30], "moving", r), (r) => k.operations.createBox([100, 50, 0], [40, 40, 10], "fixed", r)]);
    const result = await placeBody(k.operations, { id: 1, anchor: { point }, to: { bodyId: 2, point }, revision: k.rev() });
    const moving = { min: [0, 0, 0] as Vec, max: [10, 20, 30] as Vec };
    const expectedDelta = sub(boundsAnchor({ min: [100, 50, 0], max: [140, 90, 10] }, point), boundsAnchor(moving, point));
    assert.deepEqual(result.deltaMm, expectedDelta, point);
    assert.deepEqual(k.calls.map((call) => call.op), ["move"], point);
    assert.deepEqual(result.anchorMm, boundsAnchor({ min: [100, 50, 0], max: [140, 90, 10] }, point), point);
    assert.equal(result.undoSteps, 1);
  }
});

test("face to face: mating faces meet with the gap along the fixed normal and offsetMm is added last", async () => {
  const k = kernel();
  await build(k, [(r) => k.operations.createBox([0, 0, 0], [10, 10, 4], "plate", r), (r) => k.operations.createBox([50, 50, 20], [30, 30, 10], "block", r)]);
  // plate top (+Z, centre 5,5,4) onto block bottom (-Z, centre 65,65,20), 0.5 apart, then 2 mm along x.
  const result = await placeBody(k.operations, { id: 1, anchor: { faceId: "1:pz+" }, to: { bodyId: 2, faceId: "2:pz-" }, gapMm: 0.5, offsetMm: [2, 0, 0], revision: k.rev() });
  assert.equal(result.relation, "mating");
  assert.deepEqual(result.deltaMm, [62, 60, 15.5]);
  assert.deepEqual(result.boundsMm, { min: [62, 60, 15.5], max: [72, 70, 19.5] });
  assert.equal(result.movedFaceId, "1:pz+");
  assert.deepEqual(k.calls.map((call) => call.op), ["move"]);
  // Parallel faces (same normal) are accepted with relation "aligned": the gap still runs along the fixed normal.
  const parallel = planPlacement(k.state(), { id: 1, anchor: { faceId: "1:pz-" }, to: { bodyId: 2, faceId: "2:pz-" }, gapMm: 1, relation: "aligned", revision: k.rev() });
  assert.equal(parallel.relation, "parallel");
  assert.deepEqual(parallel.target, [65, 65, 19]);
});

test("face to face rejects faces that are neither mating nor parallel, shows the normals and makes no native call", async () => {
  const k = kernel();
  await build(k, [(r) => k.operations.createBox([0, 0, 0], [10, 10, 4], "plate", r), (r) => k.operations.createBox([50, 50, 20], [30, 30, 10], "block", r)]);
  await assert.rejects(placeBody(k.operations, { id: 1, anchor: { faceId: "1:pz+" }, to: { bodyId: 2, faceId: "2:px+" }, revision: k.rev() }),
    (error: Error) => /neither mating nor parallel/.test(error.message) && /\[0,0,1\]/.test(error.message) && /\[1,0,0\]/.test(error.message) && /90\.000000 degrees/.test(error.message) && /does not turn bodies/.test(error.message));
  assert.deepEqual(k.calls, []);
});

test("rotate turns the body in quarter turns about its bounds centre before anchoring", async () => {
  for (const quarterTurns of [1, 2, 3] as const) {
    const k = kernel();
    await build(k, [(r) => k.operations.createBox([0, 0, 0], [10, 2, 4], "bar", r), (r) => k.operations.createBox([100, 0, 0], [10, 10, 10], "fixed", r)]);
    const result = await placeBody(k.operations, { id: 1, anchor: { point: "min" }, to: { bodyId: 2, point: "max" }, rotate: { axis: "z", quarterTurns }, revision: k.rev() });
    assert.deepEqual(k.calls.map((call) => call.op), ["rotate", "move"], `turns ${quarterTurns}`);
    assert.deepEqual(k.calls[0]!.args, [[1], [5, 1, 2], [0, 0, 1], quarterTurns * 90]);
    const size = quarterTurns === 2 ? [10, 2, 4] : [2, 10, 4];
    assert.deepEqual(result.boundsMm, { min: [110, 10, 10], max: [110 + size[0]!, 10 + size[1]!, 14] }, `turns ${quarterTurns}`);
    assert.equal(result.undoSteps, 2);
    assert.deepEqual(result.rotation, { axis: "z", quarterTurns, pivotMm: [5, 1, 2] });
  }
});

test("rotation turns the anchor face too: a face that mates only after a half turn is accepted", async () => {
  const k = kernel();
  await build(k, [(r) => k.operations.createBox([0, 0, 0], [10, 10, 4], "plate", r), (r) => k.operations.createBox([50, 50, 20], [30, 30, 10], "block", r)]);
  // The plate's bottom (-Z) faces the same way as the block bottom; after a half turn about x it faces +Z and mates.
  await assert.rejects(placeBody(k.operations, { id: 1, anchor: { faceId: "1:pz-" }, to: { bodyId: 2, faceId: "2:pz-" }, gapMm: 0, rotate: { axis: "y", quarterTurns: 1 }, revision: k.rev() }), /neither mating nor parallel after the rotation/);
  const result = await placeBody(k.operations, { id: 1, anchor: { faceId: "1:pz-" }, to: { bodyId: 2, faceId: "2:pz-" }, gapMm: 0, rotate: { axis: "x", quarterTurns: 2 }, revision: k.rev() });
  assert.equal(result.relation, "mating");
  assert.deepEqual(result.boundsMm, { min: [60, 60, 16], max: [70, 70, 20] });
});

test("copy places a copy and keeps the original: one duplicate step without rotation, duplicate-rotate-move with it", async () => {
  const k = kernel();
  await build(k, [(r) => k.operations.createBox([0, 0, 0], [10, 10, 10], "cube", r)]);
  const result = await placeBody(k.operations, { id: 1, anchor: { point: "x--center" }, to: { bodyId: 1, point: "x+-center" }, copy: true, revision: k.rev() });
  assert.deepEqual(k.calls.map((call) => call.op), ["duplicateBodies"]);
  assert.deepEqual(k.calls[0]!.args, [[1], [10, 0, 0]]);
  assert.equal(result.copiedFromId, 1);
  assert.equal(result.bodyId, 2);
  assert.deepEqual(result.boundsMm, { min: [10, 0, 0], max: [20, 10, 10] });
  assert.deepEqual(k.state().bodies.find((body) => body.id === 1)!.boundsMm, { min: [0, 0, 0], max: [10, 10, 10] });
  k.calls.length = 0;
  const turned = await placeBody(k.operations, { id: 1, anchor: { point: "min" }, to: { bodyId: 2, point: "max" }, copy: true, rotate: { axis: "x", quarterTurns: 1 }, revision: k.rev() });
  assert.deepEqual(k.calls.map((call) => call.op), ["duplicateBodies", "rotate", "move"]);
  assert.deepEqual(k.calls[0]!.args, [[1], [0, 0, 0]]);
  assert.equal(turned.undoSteps, 3);
  assert.equal(k.state().bodies.length, 3);
});

test("place_body input errors are found before any native call", async () => {
  const k = kernel();
  await build(k, [(r) => k.operations.createBox([0, 0, 0], [10, 10, 10], "a", r), (r) => k.operations.createBox([20, 0, 0], [10, 10, 10], "b", r)]);
  const cases: Array<[Parameters<typeof placeBody>[1], RegExp]> = [
    [{ id: 1, anchor: { point: "min" }, to: { bodyId: 2, point: "max" }, gapMm: 1, revision: k.rev() }, /gapMm needs a faceId on both/],
    [{ id: 1, anchor: { point: "min" }, to: { bodyId: 1, point: "max" }, revision: k.rev() }, /set copy: true/],
    [{ id: 1, anchor: { faceId: "nope" }, to: { bodyId: 2, point: "max" }, revision: k.rev() }, /not a current face/],
    [{ id: 9, anchor: { point: "min" }, to: { bodyId: 2, point: "max" }, revision: k.rev() }, /Unknown body ID to move: 9/],
    [{ id: 1, anchor: { point: "min", faceId: "1:px+" }, to: { bodyId: 2, point: "max" }, revision: k.rev() }, /exactly one of point or faceId/],
    [{ id: 1, anchor: { point: "min" }, to: { bodyId: 2, point: "max" }, revision: "r0" }, /Stale reference/],
  ];
  for (const [input, pattern] of cases) await assert.rejects(placeBody(k.operations, input), pattern);
  assert.deepEqual(k.calls, []);
});

test("place_body verifies from a fresh read: a body that did not land is rolled back, and the error says the document is unchanged", async () => {
  const k = kernel();
  await build(k, [(r) => k.operations.createBox([0, 0, 0], [10, 10, 10], "a", r), (r) => k.operations.createBox([20, 0, 0], [10, 10, 10], "b", r)]);
  const before = k.state();
  k.control.tamper = (bodies) => { const body = bodies.find((candidate) => candidate.id === 1)!; body.min = add(body.min, [0, 0, 1e-3]); body.max = add(body.max, [0, 0, 1e-3]); };
  await assert.rejects(placeBody(k.operations, { id: 1, anchor: { point: "x+-center" }, to: { bodyId: 2, point: "x--center" }, offsetMm: [0, 0, 5], revision: k.rev() }),
    (error: unknown) => error instanceof GuardedRunError && !(error instanceof CommittedChangeError) && error.undoneSteps === 1 && error.restored && /the document is unchanged/.test(error.message) && /bounds/.test(error.message));
  assert.deepEqual(k.calls.map((call) => call.op), ["move", "undo"], "its own step undone");
  assert.equal(k.state().undoDepth, before.undoDepth);
  assert.deepEqual(k.state().bodies.map((body) => body.boundsMm), before.bodies.map((body) => body.boundsMm));
});

test("a native failure after a completed step undoes it; an uncertain one undoes nothing", async () => {
  const k = kernel();
  await build(k, [(r) => k.operations.createBox([0, 0, 0], [10, 2, 4], "a", r), (r) => k.operations.createBox([20, 0, 0], [10, 10, 10], "b", r)]);
  const before = k.state();
  k.control.failOn = "move";
  await assert.rejects(placeBody(k.operations, { id: 1, anchor: { point: "min" }, to: { bodyId: 2, point: "max" }, rotate: { axis: "z", quarterTurns: 1 }, revision: k.rev() }),
    (error: unknown) => error instanceof GuardedRunError && error.undoneSteps === 1 && error.restored && /1 Undo step\(s\) were undone/.test(error.message));
  assert.equal(k.state().undoDepth, before.undoDepth);
  assert.deepEqual(k.state().bodies.find((body) => body.id === 1)!.boundsMm, before.bodies.find((body) => body.id === 1)!.boundsMm);
  k.control.failOn = undefined;
  k.control.uncertainOn = "move";
  k.calls.length = 0;
  await assert.rejects(placeBody(k.operations, { id: 1, anchor: { point: "min" }, to: { bodyId: 2, point: "max" }, rotate: { axis: "z", quarterTurns: 1 }, revision: k.rev() }),
    (error: unknown) => error instanceof GuardedRunError && error.uncertain && error.undoneSteps === 0 && /plasticity_reconcile/.test(error.message));
  assert.equal(k.calls.some((call) => call.op === "undo"), false);
});

// ---------- full-turn cylinders and selection ----------

function cylinderBody(faces: Face[], edges: Edge[]): Body {
  return { id: 5, versionId: 5, type: "Solid", name: "src", boundsMm: { min: [0, 0, 0], max: [50, 50, 20] }, faceIds: faces.map((face) => face.id), edgeIds: edges.map((edge) => edge.id), faces, edges } as unknown as Body;
}
function circleEdge(id: string, center: Vec, radius: number, start: Vec, middle: Vec, end: Vec, withGeometry = true): Edge {
  return { id, curveType: "Circle", line: false, circle: true, lengthMm: 1, centerMm: middle, tangent: [1, 0, 0], boundsMm: { min: center, max: center }, faceIds: [], vertexIds: [],
    ...(withGeometry ? { circleGeometry: { centerMm: center, radiusMm: radius, normal: [0, 0, 1], reference: [1, 0, 0], startMm: start, midpointMm: middle, endMm: end } } : {}) } as Edge;
}
function cylinderFace(id: string, axisOrigin: Vec, axis: Vec, radius: number, edgeIds: string[], hole = true, blend: number | null = null): Face {
  const p = perp(axis);
  return { id, surfaceType: "Cylinder", planar: false, centerMm: add(add(axisOrigin, mul(axis, 5)), mul(p, radius)), normal: mul(p, hole ? -1 : 1), radiusMm: radius, blendRadiusMm: blend, axisOriginMm: axisOrigin, axisDirection: axis, boundsMm: { min: axisOrigin, max: axisOrigin }, edgeIds } as Face;
}
const fullCircle = (id: string, c: Vec, r: number) => circleEdge(id, c, r, add(c, [r, 0, 0]), sub(c, [r, 0, 0]), add(c, [r, 0, 0]));

test("full-turn cylinders: closed circles count; arcs, blends and circles without geometry never do", () => {
  const edges = [
    fullCircle("a0", [10, 10, 0], 1.5), fullCircle("a1", [10, 10, 8], 1.5),
    circleEdge("arc0", [30, 10, 0], 2, [32, 10, 0], [30, 12, 0], [28, 10, 0]), circleEdge("arc1", [30, 10, 8], 2, [32, 10, 8], [30, 12, 8], [28, 10, 8]),
    fullCircle("b0", [10, 30, 0], 5), fullCircle("b1", [10, 30, 8], 5),
    circleEdge("g0", [30, 30, 0], 1.5, [31.5, 30, 0], [28.5, 30, 0], [31.5, 30, 0], false), fullCircle("g1", [30, 30, 8], 1.5),
    fullCircle("s0", [40, 40, 0], 3), fullCircle("s1", [40, 40, 8], 3),
  ];
  const faces = [
    cylinderFace("hole", [10, 10, 0], [0, 0, 1], 1.5, ["a0", "a1"]),
    cylinderFace("arc", [30, 10, 0], [0, 0, 1], 2, ["arc0", "arc1"]),
    cylinderFace("blend", [10, 30, 0], [0, 0, 1], 5, ["b0", "b1"], true, 5),
    cylinderFace("nogeom", [30, 30, 0], [0, 0, 1], 1.5, ["g0", "g1"]),
    cylinderFace("boss", [40, 40, 0], [0, 0, 1], 3, ["s0", "s1"], false),
  ];
  assert.equal(circleSweepDeg(edges[2]!), 180);
  const found = fullTurnCylinders(cylinderBody(faces, edges));
  assert.deepEqual(found.map((cylinder) => [cylinder.faceId, cylinder.kind]), [["hole", "hole"], ["boss", "boss"]]);
  assert.deepEqual(found[0]!.originMm, [10, 10, 5]);
});

test("selection by radius, tolerance, axis, kind and box; coaxial faces merge into one axis", () => {
  const edges = [fullCircle("a0", [10, 10, 0], 1.5), fullCircle("a1", [10, 10, 8], 1.5), fullCircle("a2", [10, 10, 12], 1.5), fullCircle("a3", [10, 10, 20], 1.5),
    fullCircle("c0", [20, 10, 0], 1.505), fullCircle("c1", [20, 10, 8], 1.505), fullCircle("x0", [0, 30, 10], 1.5), fullCircle("x1", [8, 30, 10], 1.5), fullCircle("s0", [40, 40, 0], 1.5), fullCircle("s1", [40, 40, 8], 1.5)];
  const faces = [
    cylinderFace("low", [10, 10, 0], [0, 0, 1], 1.5, ["a0", "a1"]), cylinderFace("high", [10, 10, 12], [0, 0, -1], 1.5, ["a2", "a3"]),
    cylinderFace("near", [20, 10, 0], [0, 0, 1], 1.505, ["c0", "c1"]), cylinderFace("side", [0, 30, 10], [1, 0, 0], 1.5, ["x0", "x1"]),
    cylinderFace("pin", [40, 40, 0], [0, 0, 1], 1.5, ["s0", "s1"], false),
  ];
  const body = cylinderBody(faces, edges);
  const ids = (select: Parameters<typeof selectSourceAxes>[1]) => selectSourceAxes(body, select).map((axis) => axis.faceIds);
  assert.deepEqual(ids({ radiusMm: 1.5, toleranceMm: 0 }), [["low", "high"], ["side"], ["pin"]], "exact radius; the two coaxial faces are one axis");
  assert.deepEqual(ids({ radiusMm: 1.5 }), [["low", "high"], ["near"], ["side"], ["pin"]], "default tolerance 0.01");
  assert.deepEqual(ids({ radiusMm: 1.5, toleranceMm: 0, axis: "z" }), [["low", "high"], ["pin"]]);
  assert.deepEqual(ids({ radiusMm: 1.5, toleranceMm: 0, axis: [-2, 0, 0] }), [["side"]], "a vector axis, either sign");
  assert.deepEqual(ids({ radiusMm: 1.5, toleranceMm: 0, kind: "boss" }), [["pin"]]);
  assert.deepEqual(ids({ radiusMm: 1.5, toleranceMm: 0, kind: "hole", withinMm: { min: [0, 0, 0], max: [15, 15, 20] } }), [["low", "high"]]);
  assert.deepEqual(cylinderRadiiSummary(body), [{ radiusMm: 1.5, kind: "boss", axes: 1 }, { radiusMm: 1.5, kind: "hole", axes: 2 }, { radiusMm: 1.505, kind: "hole", axes: 1 }]);
});

test("point in planar face uses the face's own lines and circles: a point inside a hole is outside the face", async () => {
  const k = kernel();
  await build(k, [(r) => k.operations.createBox([0, 0, 0], [40, 30, 4], "plate", r), (r) => k.operations.createCylinder([10, 10, -1], 3, 6, undefined, r, [0, 0, 1]),
    (r) => k.operations.boolean([1], [2], "difference", false, r)]);
  const body = k.state().bodies[0]!;
  const top = body.faces.find((face) => face.id === "1:pz+")!;
  assert.deepEqual(pointInPlanarFace(body, top, [20, 20, 4]), { inside: true, boundaryDistanceMm: 10 });
  assert.equal(pointInPlanarFace(body, top, [10, 10, 4])!.inside, false, "inside the hole loop");
  assert.ok(Math.abs(pointInPlanarFace(body, top, [10, 14, 4])!.boundaryDistanceMm - 1) < 1e-9, "1 mm from the hole rim");
  assert.equal(pointInPlanarFace(body, top, [45, 10, 4])!.inside, false, "beyond the outer loop");
});

// ---------- transfer_holes: entry side and the cut ----------

async function blockAndPlate(k: ReturnType<typeof kernel>, pilots: Vec[] = [[22, 12, 0], [38, 12, 0], [22, 28, 0], [38, 28, 0]]) {
  // A 60 x 40 x 20 block with Ø3 x 8 blind pilots up into its underside; a 40 x 30 x 4 plate under it, touching.
  await build(k, [
    (r) => k.operations.createBox([0, 0, 0], [60, 40, 20], "block", r),
    ...pilots.map((pilot) => (r: string) => k.operations.createCylinder(sub(pilot, [0, 0, 0.5]), 1.5, 8.5, undefined, r, [0, 0, 1])),
    (r) => k.operations.boolean([1], pilots.map((_, i) => i + 2), "difference", false, r),
    (r) => k.operations.createBox([10, 5, -4], [40, 30, 4], "plate", r),
  ]);
  return k.state().bodies.find((body) => body.name === "plate")!.id;
}

test("entry side: the drill runs from the source toward the target, the entry is the first planar face met, through runs to the far bounds", async () => {
  const k = kernel();
  const plate = await blockAndPlate(k);
  const state = k.state();
  const [axis] = selectSourceAxes(state.bodies[0]!, { radiusMm: 1.5, axis: "z", kind: "hole" });
  assert.deepEqual(axis!.pointMm, [22, 12, 4], "the pilot's axis point is mid-face");
  assert.deepEqual(axis!.direction, [0, 0, 1], "the source axis points up, away from the plate");
  const entry = entryOf(state.bodies.find((body) => body.id === plate)!, axis!, 0, 1.7);
  assert.deepEqual(entry.direction, [0, 0, -1], "the sign is ignored: the drill points to where the target is");
  assert.deepEqual(entry.entryPointMm, [22, 12, 0]);
  assert.equal(entry.entryFaceId, `${plate}:pz+`);
  assert.equal(entry.entryProof, "edges");
  assert.equal(entry.farDistanceMm, 4);
});

test("transfer through: one through-hole pattern per direction; every hole is read back coaxial with its pilot", async () => {
  const k = kernel();
  const plate = await blockAndPlate(k);
  const result = await transferHoles(k.operations, { sourceId: 1, targetId: plate, select: { radiusMm: 1.5, kind: "hole" }, hole: { diameterMm: 3.4, through: true }, revision: k.rev() });
  assert.deepEqual(k.calls.map((call) => call.op), ["createCylinder", "createCylinder", "createCylinder", "createCylinder", "boolean"]);
  assert.deepEqual(k.calls[0]!.args, [[22, 12, 0.5], 1.7, 5, [0, 0, -1]], "entry minus overshoot, depth plus two overshoots");
  assert.equal(result.targetHoleCount, 4);
  assert.equal(result.maxCoaxialOffsetMm, 0);
  assert.equal(result.undoSteps, 5);
  assert.deepEqual(result.axesMm.map((axis) => axis.entryPointMm), [[22, 12, 0], [38, 12, 0], [22, 28, 0], [38, 28, 0]]);
});

test("transfer from explicit axes, blind, countersunk and counterbore holes use the matching hole recipes", async () => {
  const explicit = kernel();
  const plate = await blockAndPlate(explicit, [[22, 12, 0]]);
  const blind = await transferHoles(explicit.operations, { sourceId: 1, targetId: plate, axesMm: [{ pointMm: [30, 20, 10], axis: [0, 0, 1] }], hole: { diameterMm: 2.5, depthMm: 3 }, revision: explicit.rev() });
  assert.deepEqual(explicit.calls.map((call) => call.op), ["createCylinder", "boolean"]);
  assert.deepEqual(explicit.calls[0]!.args, [[30, 20, 0.5], 1.25, 3.5, [0, 0, -1]], "a blind cutter is depth plus one overshoot");
  assert.equal(blind.targetHoleCount, 1);

  const sunk = kernel();
  const plate2 = await blockAndPlate(sunk, [[22, 12, 0], [38, 12, 0]]);
  await transferHoles(sunk.operations, { sourceId: 1, targetId: plate2, select: { radiusMm: 1.5 }, hole: { diameterMm: 3.4, through: true, countersunk: { headDiameterMm: 6.5 } }, revision: sunk.rev() });
  assert.deepEqual(sunk.calls.map((call) => call.op), ["createCylinder", "createPolyline", "revolveProfile", "createCylinder", "createPolyline", "revolveProfile", "boolean", "remove"], "countersink pattern with keepProfile false");

  const bored = kernel();
  const plate3 = await blockAndPlate(bored, [[22, 12, 0]]);
  await transferHoles(bored.operations, { sourceId: 1, targetId: plate3, select: { radiusMm: 1.5 }, hole: { diameterMm: 3.4, through: true, counterbore: { diameterMm: 6, depthMm: 1.5 } }, revision: bored.rev() });
  assert.deepEqual(bored.calls.map((call) => call.op), ["createCylinder", "createCylinder", "boolean"]);
});

test("a select that matches nothing echoes the selection and lists the source radii; no native call", async () => {
  const k = kernel();
  const plate = await blockAndPlate(k);
  await assert.rejects(transferHoles(k.operations, { sourceId: 1, targetId: plate, select: { radiusMm: 2, kind: "hole" }, hole: { diameterMm: 3.4, through: true }, revision: k.rev() }),
    (error: Error) => /select matched no full-turn cylinder axis on source body 1/.test(error.message) && /"radiusMm":2/.test(error.message) && /"toleranceMm":0.01/.test(error.message) && /\[\{"radiusMm":1.5,"kind":"hole","axes":4\}\]/.test(error.message));
  assert.deepEqual(k.calls, []);
});

test("entry rejections: an axis that misses the target, a point between target faces, an entry through a curved face, a rim that does not fit", async () => {
  const k = kernel();
  const plate = await blockAndPlate(k);
  const run = (axesMm: Array<{ pointMm: Vec; axis: Vec }>, diameterMm = 3.4) => transferHoles(k.operations, { sourceId: 1, targetId: plate, axesMm, hole: { diameterMm, through: true }, revision: k.rev() });
  await assert.rejects(run([{ pointMm: [200, 20, 10], axis: [0, 0, 1] }]), /axis 0 \(point \[200,20,10\], direction \[0,0,1\]\) misses the target body/);
  await assert.rejects(run([{ pointMm: [30, 20, -2], axis: [0, 0, 1] }]), /lies between target faces/);
  await assert.rejects(run([{ pointMm: [11, 6, 10], axis: [0, 0, 1] }]), /does not fit inside the entry face/);
  await assert.rejects(run([{ pointMm: [30, 20, 10], axis: [1, 1, 0] }]), /misses the target|crosses no planar face/);
  await assert.rejects(run([{ pointMm: [0, 20, 10], axis: [1, 0, 0] }]), /misses the target/);
  assert.deepEqual(k.calls, []);
});

test("a reference point on the target's own face (a touching part) makes that face the entry, drilled away from the rest of nothing", async () => {
  const k = kernel();
  const plate = await blockAndPlate(k, [[22, 12, 0]]);
  const body = k.state().bodies.find((candidate) => candidate.id === plate)!;
  // On the plate's top face, axis given either way: the plate is below, so the drill points down from the top face.
  for (const direction of [[0, 0, 1], [0, 0, -1]] as Vec[]) {
    const entry = entryOf(body, { pointMm: [30, 20, 0], direction, faceIds: [] }, 0, 1.7);
    assert.deepEqual([entry.direction, entry.entryPointMm, entry.entryFaceId, entry.farDistanceMm], [[0, 0, -1], [30, 20, 0], `${plate}:pz+`, 4], JSON.stringify(direction));
  }
  // On the plate's bottom face, pointing up into it: the bottom face is the entry.
  const up = entryOf(body, { pointMm: [30, 20, -4], direction: [0, 0, 1], faceIds: [] }, 0, 1.7);
  assert.deepEqual([up.direction, up.entryFaceId], [[0, 0, 1], `${plate}:pz-`]);
});

test("an entry through a non-planar face is rejected: the first planar face along the axis faces away", () => {
  // A plate whose top at the axis is a curved cap: the plane under it is reached from inside (an exit face).
  const k = kernel();
  const exitOnly = { id: 9, type: "Solid", name: "cap", boundsMm: { min: [0, 0, 0], max: [10, 10, 10] }, faceIds: ["bottom"], edgeIds: ["l1", "l2", "l3", "l4"],
    faces: [{ id: "bottom", surfaceType: "Plane", planar: true, centerMm: [5, 5, 0], normal: [0, 0, -1], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [0, 0, 0], max: [10, 10, 0] }, edgeIds: ["l1", "l2", "l3", "l4"] }],
    edges: [[5, 0, 0, 1, 0], [10, 5, 0, 0, 1], [5, 10, 0, 1, 0], [0, 5, 0, 0, 1]].map(([x, y, z, tx, ty], i) => ({ id: `l${i + 1}`, curveType: "Line", line: true, circle: false, lengthMm: 10, centerMm: [x, y, z], tangent: [tx, ty, 0], boundsMm: { min: [x, y, z], max: [x, y, z] }, faceIds: ["bottom"], vertexIds: [] })) } as unknown as Body;
  void k;
  assert.throws(() => entryOf(exitOnly, { pointMm: [5, 5, 20], direction: [0, 0, -1], faceIds: [] }, 0, 1), /faces away from the source, so the axis enters the target through a non-planar face/);
});

test("transfer read-back: a hole that is not coaxial within 1e-6 mm is rolled back (both steps undone); the document is unchanged", async () => {
  const k = kernel();
  const plate = await blockAndPlate(k, [[22, 12, 0]]);
  const before = k.state();
  k.control.tamper = (bodies) => { const target = bodies.find((body) => body.id === plate)!; target.holes.forEach((hole) => { hole.origin = add(hole.origin, [2e-6, 0, 0]); }); };
  await assert.rejects(transferHoles(k.operations, { sourceId: 1, targetId: plate, select: { radiusMm: 1.5 }, hole: { diameterMm: 3.4, through: true }, revision: k.rev() }),
    (error: unknown) => error instanceof GuardedRunError && error.undoneSteps === 2 && error.restored && /coaxial with the source axis within 1e-6 mm/.test(error.message) && /the document is unchanged/.test(error.message));
  assert.equal(k.calls.filter((call) => call.op === "undo").length, 2);
  assert.equal(k.state().undoDepth, before.undoDepth);
  assert.equal(k.state().bodies.find((body) => body.id === plate)!.faces.some((face) => face.surfaceType === "Cylinder"), false, "the cut is gone");
});

test("transfer read-back: an entry edge that is only a half arc does not prove the entry, even on a coaxial full-turn bore", async () => {
  const k = kernel();
  const plate = await blockAndPlate(k, [[22, 12, 0]]);
  k.control.halfEntry = true;
  await assert.rejects(transferHoles(k.operations, { sourceId: 1, targetId: plate, select: { radiusMm: 1.5 }, hole: { diameterMm: 3.4, through: true }, revision: k.rev() }),
    (error: unknown) => error instanceof GuardedRunError && error.restored && /no full Ø3.4 circle centred on the entry point \[22,12,0\] borders a planar face in the entry plane/.test(error.message));
});

test("transfer input rules: exactly one of select or axesMm, depth or through, and through for countersunk or counterbore", async () => {
  const k = kernel();
  const plate = await blockAndPlate(k, [[22, 12, 0]]);
  const base = { sourceId: 1, targetId: plate, revision: k.rev() };
  await assert.rejects(transferHoles(k.operations, { ...base, hole: { diameterMm: 3, through: true } }), /exactly one of select or axesMm/);
  await assert.rejects(transferHoles(k.operations, { ...base, select: { radiusMm: 1.5 }, hole: { diameterMm: 3 } }), /exactly one of depthMm or through/);
  await assert.rejects(transferHoles(k.operations, { ...base, select: { radiusMm: 1.5 }, hole: { diameterMm: 3, depthMm: 2, counterbore: { diameterMm: 6, depthMm: 1 } } }), /set through: true/);
  await assert.rejects(transferHoles(k.operations, { ...base, select: { radiusMm: 1.5 }, hole: { diameterMm: 3, depthMm: 4 } }), /reaches the far side of the target/);
  await assert.rejects(transferHoles(k.operations, { ...base, targetId: 1, select: { radiusMm: 1.5 }, hole: { diameterMm: 3, through: true } }), /must be different bodies/);
  assert.deepEqual(k.calls, []);
});

test("runGuarded passes a committed mismatch through untouched and reports an undo that itself fails", async () => {
  const k = kernel();
  await build(k, [(r) => k.operations.createBox([0, 0, 0], [1, 1, 1], "a", r)]);
  const initial = k.state();
  const mismatch = new CommittedChangeError("x", "r9", 1);
  await assert.rejects(runGuarded(k.operations, "test", initial, async () => { throw mismatch; }), (error) => error === mismatch);
  const broken = { ...k.operations, async undo() { throw new Error("undo refused"); } };
  await assert.rejects(runGuarded(broken, "test", initial, async () => { await k.operations.createBox([5, 5, 5], [1, 1, 1], undefined, k.rev()); throw new Error("step failed"); }),
    (error: unknown) => error instanceof GuardedRunError && error.uncertain && /undoing its steps failed after 0/.test(error.message) && /step failed/.test(error.message));
});

// ---------- review fixes (defects 1-13 of the bracket-mate review) ----------

// Hand-built planar bodies for the pure entry rules: a face is a polygon with line edges.
// A face spec: an outer polygon, optional inner polygons (holes) and full circles (round inner loops); curve marks the
// outer loop's first edge as another curve type (so the face's edges cannot be used exactly, only its polygon).
type FaceSpec = { id: string; normal: Vec; points: Vec[]; holes?: Vec[][]; circles?: Array<{ center: Vec; radius: number }>; curve?: string };
function circleEdgeOf(id: string, faceIds: string[], center: Vec, radius: number, normal: Vec): Edge {
  const p = perp(normal);
  return { id, curveType: "Circle", line: false, circle: true, lengthMm: 2 * Math.PI * radius, centerMm: add(center, mul(p, radius)), tangent: [0, 0, 1], boundsMm: { min: center, max: center }, faceIds, vertexIds: [],
    circleGeometry: { centerMm: center, radiusMm: radius, normal, reference: p, startMm: add(center, mul(p, radius)), midpointMm: sub(center, mul(p, radius)), endMm: add(center, mul(p, radius)) } } as Edge;
}
function polyBody(id: number, specs: FaceSpec[], extra: Face[] = [], extraEdges: Edge[] = []): Body {
  const faces: Face[] = [];
  const edges: Edge[] = [...extraEdges];
  for (const spec of specs) {
    const edgeIds: string[] = [];
    [spec.points, ...(spec.holes ?? [])].forEach((loop, l) => loop.forEach((point, i) => {
      const next = loop[(i + 1) % loop.length]!;
      const lengthMm = Math.hypot(...sub(next, point));
      const other = l === 0 && i === 0 && spec.curve;
      const edge = { id: `${spec.id}:e${l === 0 ? "" : `h${l}.`}${i}`, curveType: other || "Line", line: !other, circle: false, lengthMm, centerMm: mul(add(point, next), 0.5), tangent: unitv(sub(next, point)), boundsMm: { min: point, max: next }, faceIds: [spec.id], vertexIds: [] } as Edge;
      edges.push(edge);
      edgeIds.push(edge.id);
    }));
    (spec.circles ?? []).forEach((circle, i) => { const edge = circleEdgeOf(`${spec.id}:c${i}`, [spec.id], circle.center, circle.radius, spec.normal); edges.push(edge); edgeIds.push(edge.id); });
    const center = mul(spec.points.reduce((sum, point) => add(sum, point), [0, 0, 0] as Vec), 1 / spec.points.length);
    const min = [0, 1, 2].map((i) => Math.min(...spec.points.map((point) => point[i]!))) as Vec;
    const max = [0, 1, 2].map((i) => Math.max(...spec.points.map((point) => point[i]!))) as Vec;
    faces.push({ id: spec.id, surfaceType: "Plane", planar: true, centerMm: center, normal: spec.normal, radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min, max }, edgeIds, points: spec.points } as Face);
  }
  faces.push(...extra);
  const all = faces.flatMap((face) => [face.boundsMm.min, face.boundsMm.max]);
  const boundsMm = { min: [0, 1, 2].map((i) => Math.min(...all.map((point) => point[i]!))) as Vec, max: [0, 1, 2].map((i) => Math.max(...all.map((point) => point[i]!))) as Vec };
  return { id, versionId: id, type: "Solid", name: `body${id}`, boundsMm, faceIds: faces.map((face) => face.id), edgeIds: edges.map((edge) => edge.id), faces, edges } as unknown as Body;
}
const rect = (id: string, normal: Vec, a: Vec, b: Vec, c: Vec, d: Vec) => ({ id, normal, points: [a, b, c, d] });
// A flange 40 x 40 x 5 (z 10..15) on a stem 12 wide (x 0..12, z 0..10): the wall under x > 12 is 5 mm.
function steppedBody(id = 2, extra: Face[] = []): Body {
  return polyBody(id, [
    rect("top", [0, 0, 1], [0, 0, 15], [40, 0, 15], [40, 40, 15], [0, 40, 15]),
    rect("under", [0, 0, -1], [12, 0, 10], [40, 0, 10], [40, 40, 10], [12, 40, 10]),
    rect("foot", [0, 0, -1], [0, 0, 0], [12, 0, 0], [12, 40, 0], [0, 40, 0]),
    rect("stemside", [1, 0, 0], [12, 0, 0], [12, 40, 0], [12, 40, 10], [12, 0, 10]),
    rect("back", [-1, 0, 0], [0, 0, 0], [0, 40, 0], [0, 40, 15], [0, 0, 15]),
    rect("end", [1, 0, 0], [40, 0, 10], [40, 40, 10], [40, 40, 15], [40, 0, 15]),
    { id: "front", normal: [0, -1, 0], points: [[0, 0, 0], [12, 0, 0], [12, 0, 10], [40, 0, 10], [40, 0, 15], [0, 0, 15]] },
    { id: "rear", normal: [0, 1, 0], points: [[0, 40, 0], [12, 40, 0], [12, 40, 10], [40, 40, 10], [40, 40, 15], [0, 40, 15]] },
  ], extra);
}
const stateOf = (...bodies: Body[]) => ({ targetId: "t", title: "t", documentToken: "doc", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" }, bodies } as unknown as RuntimeState);
const sourceStub = () => polyBody(1, [rect("s", [0, 0, 1], [100, 100, 5], [105, 100, 5], [105, 105, 5], [100, 105, 5])]);

test("defect 1: select takes holes only by default; a boss of the same radius is left out, kind any takes it, and every axis reports its kind", async () => {
  const k = kernel();
  const plate = await blockAndPlate(k, [[22, 12, 0]]);
  k.addPin(1, { origin: [38, 28, 0], dir: [0, 0, 1], radius: 1.5, from: 0, to: 6, facing: 1 }); // a boss pin of the same radius
  k.addPin(1, { origin: [30, 28, 0], dir: [0, 0, 1], radius: 1.5, from: 0, to: 6, facing: 0 }); // its kind cannot be proven
  const holesOnly = await transferHoles(k.operations, { sourceId: 1, targetId: plate, select: { radiusMm: 1.5 }, hole: { diameterMm: 3.4, through: true }, revision: k.rev() });
  assert.deepEqual(holesOnly.axesMm.map((axis) => [axis.pointMm.slice(0, 2), axis.kind]), [[[22, 12], "hole"]], "the boss is not transferred as a hole");
  assert.equal(holesOnly.holeCount, 1);
  const k2 = kernel();
  const plate2 = await blockAndPlate(k2, [[22, 12, 0]]);
  k2.addPin(1, { origin: [38, 28, 0], dir: [0, 0, 1], radius: 1.5, from: 0, to: 6, facing: 1 });
  k2.addPin(1, { origin: [30, 28, 0], dir: [0, 0, 1], radius: 1.5, from: 0, to: 6, facing: 0 });
  const any = await transferHoles(k2.operations, { sourceId: 1, targetId: plate2, select: { radiusMm: 1.5, kind: "any" }, hole: { diameterMm: 3.4, through: true }, revision: k2.rev() });
  assert.deepEqual(any.axesMm.map((axis) => [axis.pointMm.slice(0, 2), axis.kind]), [[[22, 12], "hole"], [[38, 28], "boss"]], "the unproven cylinder is never taken, even with kind any");
  const explicit = await transferHoles(k2.operations, { sourceId: 1, targetId: any.targetId, axesMm: [{ pointMm: [30, 20, 10], axis: [0, 0, 1] }], hole: { diameterMm: 2, through: true }, revision: k2.rev() });
  assert.equal(explicit.axesMm[0]!.kind, "explicit");
});

test("defect 2: a bore that breaks out of a side wall (a partial circle) is rolled back and the error names the axis", async () => {
  const k = kernel();
  const plate = await blockAndPlate(k, [[22, 12, 0]]);
  const before = k.state();
  k.control.halfExit = true;
  await assert.rejects(transferHoles(k.operations, { sourceId: 1, targetId: plate, select: { radiusMm: 1.5 }, hole: { diameterMm: 3.4, through: true }, revision: k.rev() }),
    (error: unknown) => error instanceof GuardedRunError && error.restored && /axis 0: the bore breaks out of a side wall of the target/.test(error.message) && /partial circle \(180\.0 degrees\)/.test(error.message) && /the document is unchanged/.test(error.message));
  assert.equal(k.state().undoDepth, before.undoDepth);
});

test("defect 2: a bore face with an edge on a side face breaks out too, even when both of its circles are full", async () => {
  const k = kernel();
  const plate = await blockAndPlate(k, [[22, 12, 0]]);
  k.control.sideLine = true;
  await assert.rejects(transferHoles(k.operations, { sourceId: 1, targetId: plate, select: { radiusMm: 1.5 }, hole: { diameterMm: 3.4, through: true }, revision: k.rev() }),
    (error: unknown) => error instanceof GuardedRunError && error.restored && /axis 0: the bore breaks out of a side wall/.test(error.message) && new RegExp(`Line edge \\S+ on face ${plate}:px\\+`).test(error.message));
});

test("defect 3: a curved target face on the axis before the first planar face is refused before any native call", async () => {
  const k = kernel();
  const plate = await blockAndPlate(k, [[22, 12, 0]]);
  k.addPin(plate, { origin: [10, 20, 2], dir: [1, 0, 0], radius: 1.5, from: 0, to: 40, facing: 1 }); // a rod lying on the plate, across the axis
  await assert.rejects(transferHoles(k.operations, { sourceId: 1, targetId: plate, axesMm: [{ pointMm: [30, 20, 10], axis: [0, 0, -1] }], hole: { diameterMm: 4, through: true }, revision: k.rev() }),
    (error: unknown) => error instanceof AxisRefusal && error.code === "precedes" && /target face \S+:pin0 \(Cylinder\) may lie on the bore before the entry face/.test(error.message) && /material precedes the first planar face/.test(error.message));
  assert.deepEqual(k.calls, []);
  // The same rod 10 mm to the side does not reach the bore: the hole is cut.
  const k2 = kernel();
  const plate2 = await blockAndPlate(k2, [[22, 12, 0]]);
  k2.addPin(plate2, { origin: [10, 30, 2], dir: [1, 0, 0], radius: 1.5, from: 0, to: 40, facing: 1 });
  const cut = await transferHoles(k2.operations, { sourceId: 1, targetId: plate2, axesMm: [{ pointMm: [30, 20, 10], axis: [0, 0, -1] }], hole: { diameterMm: 4, through: true }, revision: k2.rev() });
  assert.equal(cut.holeCount, 1);
});

test("defect 7: blind depth is checked against the local wall (the next target face on the axis), not the bounds", async () => {
  const target = steppedBody();
  const state = stateOf(sourceStub(), target);
  const base = { sourceId: 1, targetId: 2, axesMm: [{ pointMm: [30, 20, 30] as Vec, axis: [0, 0, -1] as Vec }], revision: "r1" };
  const entry = entryOf(target, { pointMm: [30, 20, 30], direction: [0, 0, -1], faceIds: [] }, 0, 2.5);
  assert.deepEqual([entry.entryFaceId, entry.farDistanceMm, entry.nextFaceMm, entry.wallMm], ["top", 15, 5, 5], "the flange is 5 mm; the bounds are 15");
  await assert.rejects(planTransferOn(state, { ...base, hole: { diameterMm: 5, depthMm: 7 } }), /depthMm 7 reaches the far side of the wall: the next target face on the axis is 5\.0000 mm from the entry \(the local wall thickness\)/);
  await assert.rejects(planTransferOn(state, { ...base, hole: { diameterMm: 5, depthMm: 4.96 } }), /at least 0\.05 mm must stay under the floor/);
  await assert.doesNotReject(planTransferOn(state, { ...base, hole: { diameterMm: 5, depthMm: 4 } }));
  await assert.rejects(planTransferOn(state, { ...base, hole: { diameterMm: 3, through: true, counterbore: { diameterMm: 6, depthMm: 6 } } }), /counterbore depth 6 reaches the far side of the wall/);
});

test("defect 7: a cross hole inside the wall is found by the rays: the local wall ends at it", () => {
  const crossHole = { id: "cross", surfaceType: "Cylinder", planar: false, centerMm: [30, 20, 11.5], normal: [0, 0, -1], radiusMm: 1, blendRadiusMm: null, axisOriginMm: [30, 0, 12.5], axisDirection: [0, 1, 0], boundsMm: { min: [29, 0, 11.5], max: [31, 40, 13.5] }, edgeIds: [] } as unknown as Face;
  const entry = entryOf(steppedBody(2, [crossHole]), { pointMm: [30, 20, 30], direction: [0, 0, -1], faceIds: [] }, 0, 2.5);
  assert.equal(entry.nextFaceMm, 1.5, "the axis ray meets the cross hole at z 13.5, 1.5 mm under the entry");
  assert.equal(entry.wallMm, 1.5);
});

test("defect 8: place_body refuses same-facing faces unless relation aligned, and says to flip the body", async () => {
  const k = kernel();
  await build(k, [(r) => k.operations.createBox([0, 0, 0], [100, 60, 5], "plate", r), (r) => k.operations.createBox([200, 0, 0], [30, 20, 10], "block", r)]);
  // The block's top onto the plate's top: flush would put the block inside the plate.
  await assert.rejects(placeBody(k.operations, { id: 2, anchor: { faceId: "2:pz+" }, to: { bodyId: 1, faceId: "1:pz+" }, revision: k.rev() }),
    (error: Error) => /face the same way/.test(error.message) && /Flip the body/.test(error.message) && /relation: "aligned"/.test(error.message));
  assert.deepEqual(k.calls, []);
  const aligned = await placeBody(k.operations, { id: 2, anchor: { faceId: "2:pz+" }, to: { bodyId: 1, faceId: "1:pz+" }, relation: "aligned", revision: k.rev() });
  assert.equal(aligned.relation, "parallel");
  await assert.rejects(placeBody(k.operations, { id: 2, anchor: { faceId: "2:pz-" }, to: { bodyId: 1, faceId: "1:pz+" }, relation: "aligned", revision: k.rev() }), /relation "aligned" asks for same-facing faces/);
  await assert.rejects(placeBody(k.operations, { id: 2, anchor: { point: "min" }, to: { bodyId: 1, point: "max" }, relation: "aligned", revision: k.rev() }), /relation needs a faceId on both/);
});

test("defect 8: a negative gapMm is refused unless allowOverlap; with it the faces overlap by that much", async () => {
  const k = kernel();
  await build(k, [(r) => k.operations.createBox([0, 0, 0], [100, 60, 5], "plate", r), (r) => k.operations.createBox([200, 0, 0], [30, 20, 10], "block", r)]);
  await assert.rejects(placeBody(k.operations, { id: 2, anchor: { faceId: "2:pz-" }, to: { bodyId: 1, faceId: "1:pz+" }, gapMm: -1, revision: k.rev() }),
    /gapMm -1 pushes the faces 1 mm into each other, so the bodies would overlap; pass allowOverlap: true/);
  assert.deepEqual(k.calls, []);
  const overlap = await placeBody(k.operations, { id: 2, anchor: { faceId: "2:pz-" }, to: { bodyId: 1, faceId: "1:pz+" }, gapMm: -1, allowOverlap: true, revision: k.rev() });
  assert.deepEqual(overlap.boundsMm, { min: [35, 20, 4], max: [65, 40, 14] });
});

test("defect 8: faces within 1e-6 (sine) of parallel mate; beyond it the angle is printed so it is never shown as zero", () => {
  const k = kernel();
  const tilted = (sine: number): RuntimeState => {
    const state = k.state();
    const block = state.bodies.find((body) => body.id === 2)!;
    const bottom = block.faces.find((face) => face.id === "2:pz-")!;
    bottom.normal = unitv([0, sine, -1]);
    return state;
  };
  return (async () => {
    await build(k, [(r) => k.operations.createBox([0, 0, 0], [100, 60, 5], "plate", r), (r) => k.operations.createBox([200, 0, 0], [30, 20, 10], "block", r)]);
    const near = planPlacement(tilted(1e-7), { id: 2, anchor: { faceId: "2:pz-" }, to: { bodyId: 1, faceId: "1:pz+" }, revision: k.rev() });
    assert.equal(near.relation, "mating", "1e-7 off parallel (was refused at 1e-9)");
    assert.throws(() => planPlacement(tilted(2e-6), { id: 2, anchor: { faceId: "2:pz-" }, to: { bodyId: 1, faceId: "1:pz+" }, revision: k.rev() }),
      (error: Error) => /neither mating nor parallel/.test(error.message) && /179\.999885 degrees apart, 1\.146e-4 degrees off parallel; sine 2\.000e-6, limit 0\.000001/.test(error.message) && !/0\.000000 degrees/.test(error.message));
  })();
});

test("defect 9: two parallel axes closer than the hole (or its countersink head or counterbore) are refused before any native call", async () => {
  const k = kernel();
  const plate = await blockAndPlate(k);
  // The pilots are 16 mm apart.
  await assert.rejects(transferHoles(k.operations, { sourceId: 1, targetId: plate, select: { radiusMm: 1.5 }, hole: { diameterMm: 17, through: true }, revision: k.rev() }),
    /axis 0 \(point \[22,12,4\], direction \[0,0,1\]\) and axis 1 \(point \[38,12,4\], direction \[0,0,1\]\) are 16\.0000 mm apart, closer than the Ø17 mm hole: the holes would overlap/);
  await assert.rejects(transferHoles(k.operations, { sourceId: 1, targetId: plate, select: { radiusMm: 1.5 }, hole: { diameterMm: 3.4, through: true, countersunk: { headDiameterMm: 16.5 } }, revision: k.rev() }), /closer than the Ø16\.5 mm countersink head/);
  await assert.rejects(transferHoles(k.operations, { sourceId: 1, targetId: plate, select: { radiusMm: 1.5 }, hole: { diameterMm: 3.4, through: true, counterbore: { diameterMm: 16.2, depthMm: 1 } }, revision: k.rev() }), /closer than the Ø16\.2 mm counterbore/);
  assert.deepEqual(k.calls, []);
});

test("defect 10: holeCount counts separate bores proven by read-back: one axis through two walls is 2, axisCount 1", async () => {
  const k = kernel();
  const plate = await blockAndPlate(k, [[22, 12, 0]]);
  k.control.splitBore = true;
  const result = await transferHoles(k.operations, { sourceId: 1, targetId: plate, select: { radiusMm: 1.5 }, hole: { diameterMm: 3.4, through: true }, revision: k.rev() });
  assert.deepEqual([result.axisCount, result.holeCount, result.targetHoleCount, result.holes[0]!.bores], [1, 2, 2, 2]);
});

test("defect 11: a transfer that leaves the target natively invalid is rolled back", async () => {
  const k = kernel();
  const plate = await blockAndPlate(k, [[22, 12, 0]]);
  const before = k.state();
  k.control.invalid = true;
  await assert.rejects(transferHoles(k.operations, { sourceId: 1, targetId: plate, select: { radiusMm: 1.5 }, hole: { diameterMm: 3.4, through: true }, revision: k.rev() }),
    (error: unknown) => error instanceof GuardedRunError && error.restored && /is not a closed, natively valid Solid/.test(error.message) && /native Check codes \[7\]/.test(error.message));
  assert.equal(k.state().undoDepth, before.undoDepth);
});

test("defect 12: an existing hole on the axis has its own message, distinct from a miss and from a non-planar entry", async () => {
  const k = kernel();
  const plate = await blockAndPlate(k, [[22, 12, 0]]);
  const first = await transferHoles(k.operations, { sourceId: 1, targetId: plate, select: { radiusMm: 1.5 }, hole: { diameterMm: 3.4, through: true }, revision: k.rev() });
  k.calls.length = 0;
  for (const diameterMm of [3.4, 7]) {
    await assert.rejects(transferHoles(k.operations, { sourceId: 1, targetId: first.targetId, select: { radiusMm: 1.5 }, hole: { diameterMm, through: true }, revision: k.rev() }),
      (error: unknown) => error instanceof AxisRefusal && error.code === "existing-hole" && /the target already has a hole on this axis \(face \S+, radius 1\.7 mm\); transfer_holes cuts new holes only and does not re-cut or enlarge an existing one/.test(error.message));
  }
  assert.deepEqual(k.calls, []);
});

test("defect 12: inside the bounds but off every face is a miss; only curved or oblique faces on the axis is a non-planar entry", () => {
  // An L-shaped plate: the axis runs through the notch, inside the bounds.
  const notch: Vec[] = [[0, 0, 0], [40, 0, 0], [40, 20, 0], [20, 20, 0], [20, 40, 0], [0, 40, 0]];
  const lPlate = polyBody(2, [
    { id: "lt", normal: [0, 0, 1], points: notch.map((p) => [p[0], p[1], 5] as Vec) }, { id: "lb", normal: [0, 0, -1], points: notch },
    ...notch.map((p, i) => { const q = notch[(i + 1) % notch.length]!; const n = unitv([q[1] - p[1], p[0] - q[0], 0]); return rect(`ls${i}`, n, p, q, [q[0], q[1], 5], [p[0], p[1], 5]); }),
  ]);
  assert.throws(() => entryOf(lPlate, { pointMm: [30, 30, 20], direction: [0, 0, -1], faceIds: [] }, 0, 1), (error: unknown) => error instanceof AxisRefusal && error.code === "miss" && /misses the target body 2 \(no face of it lies on the axis\)/.test(error.message));
  // A rod: a radial axis meets only its curved side.
  const side = { id: "side", surfaceType: "Cylinder", planar: false, centerMm: [20, 0, 15], normal: [1, 0, 0], radiusMm: 20, blendRadiusMm: null, axisOriginMm: [0, 0, 0], axisDirection: [0, 0, 1], boundsMm: { min: [-20, -20, 0], max: [20, 20, 30] }, edgeIds: [] } as unknown as Face;
  const rod = polyBody(3, [rect("cap", [0, 0, 1], [-20, -20, 30], [20, -20, 30], [20, 20, 30], [-20, 20, 30]), rect("foot", [0, 0, -1], [-20, -20, 0], [20, -20, 0], [20, 20, 0], [-20, 20, 0])], [side]);
  assert.throws(() => entryOf(rod, { pointMm: [50, 0, 15], direction: [-1, 0, 0], faceIds: [] }, 0, 2.5),
    (error: unknown) => error instanceof AxisRefusal && error.code === "non-planar" && /crosses no planar face of the target normal to the axis: it meets the target only through non-planar, oblique or tangent faces \(side Cylinder\)/.test(error.message));
  // A tilted plate: its faces are oblique to the axis.
  const tilt = unitv([0.17, 0, 0.98]);
  const oblique = polyBody(4, [{ id: "slope", normal: tilt, points: [[0, 0, 0], [10, 0, -1.7347], [10, 10, -1.7347], [0, 10, 0]] }]);
  assert.throws(() => entryOf(oblique, { pointMm: [5, 5, 20], direction: [0, 0, -1], faceIds: [] }, 0, 1), (error: unknown) => error instanceof AxisRefusal && error.code === "non-planar" && /slope Plane/.test(error.message));
});

test("defect 13: onMiss skip lists the axes that miss and cuts the rest; the default refuses; all missing is refused", async () => {
  const k = kernel();
  // Three pilots; the one at x 55 lies past the plate (x 10..50).
  const plate = await blockAndPlate(k, [[22, 12, 0], [38, 28, 0], [55, 20, 0]]);
  const input = { sourceId: 1, targetId: plate, select: { radiusMm: 1.5 }, hole: { diameterMm: 3.4, through: true as const } };
  await assert.rejects(transferHoles(k.operations, { ...input, revision: k.rev() }), /axis 2 \(point \[55,20,4\], direction \[0,0,1\]\) misses the target body/);
  assert.deepEqual(k.calls, []);
  const skipped = await transferHoles(k.operations, { ...input, onMiss: "skip", revision: k.rev() });
  assert.deepEqual([skipped.axisCount, skipped.holeCount, skipped.axesMm.map((axis) => axis.entryPointMm)], [2, 2, [[22, 12, 0], [38, 28, 0]]]);
  assert.equal(skipped.skipped!.length, 1);
  assert.deepEqual([skipped.skipped![0]!.axisIndex, skipped.skipped![0]!.pointMm], [2, [55, 20, 4]]);
  assert.match(skipped.skipped![0]!.reason, /misses the target body/);
  await assert.rejects(transferHoles(k.operations, { sourceId: 1, targetId: plate, axesMm: [{ pointMm: [500, 0, 0], axis: [0, 0, 1] }], hole: { diameterMm: 3, through: true }, onMiss: "skip", revision: k.rev() }), /every axis misses the target body/);
  // onMiss does not skip other refusals: a rim that does not fit still refuses the call.
  await assert.rejects(transferHoles(k.operations, { sourceId: 1, targetId: skipped.targetId, axesMm: [{ pointMm: [11, 6, 10], axis: [0, 0, 1] }], hole: { diameterMm: 3.4, through: true }, onMiss: "skip", revision: k.rev() }), /does not fit inside the entry face/);
});

test("the rollback reports what remains when Undo stops lowering the Undo depth", async () => {
  const k = kernel();
  await build(k, [(r) => k.operations.createBox([0, 0, 0], [1, 1, 1], "a", r)]);
  const initial = k.state();
  const stuck = { ...k.operations, async undo() { return k.state(); } };
  await assert.rejects(runGuarded(stuck, "test", initial, async () => { await k.operations.createBox([5, 5, 5], [1, 1, 1], undefined, k.rev()); throw new Error("step failed"); }),
    (error: unknown) => error instanceof GuardedRunError && !error.restored && /Undo did not lower the Undo depth \(2 -> 2\)/.test(error.message) && /1 of its step\(s\) may remain; call plasticity_reconcile/.test(error.message));
});

test("defect 12: an outward face on the axis (a rod or boss drilled down its middle) is no existing hole; an unprovable one is refused", async () => {
  const k = kernel();
  const plate = await blockAndPlate(k, [[22, 12, 0]]);
  k.addPin(plate, { origin: [30, 20, -4], dir: [0, 0, -1], radius: 6, from: 0, to: 6, facing: 1 }); // a boss under the plate, on the axis
  const cut = await transferHoles(k.operations, { sourceId: 1, targetId: plate, axesMm: [{ pointMm: [30, 20, 10], axis: [0, 0, -1] }], hole: { diameterMm: 4, through: true }, revision: k.rev() });
  assert.deepEqual([cut.axisCount, cut.holeCount], [1, 1], "the boss is not a hole, and not a bore of the cut");
  const k2 = kernel();
  const plate2 = await blockAndPlate(k2, [[22, 12, 0]]);
  k2.addPin(plate2, { origin: [30, 20, -4], dir: [0, 0, -1], radius: 6, from: 0, to: 6, facing: 0 });
  await assert.rejects(transferHoles(k2.operations, { sourceId: 1, targetId: plate2, axesMm: [{ pointMm: [30, 20, 10], axis: [0, 0, -1] }], hole: { diameterMm: 4, through: true }, revision: k2.rev() }),
    (error: unknown) => error instanceof AxisRefusal && error.code === "existing-hole" && /a cylinder face on this axis \(face \S+, radius 6 mm\) whose facing cannot be proven, so it may be an existing hole/.test(error.message));
  assert.deepEqual(k2.calls, []);
});

test("defects 3 and 12: an oblique plate is entered (its faces are bounded by their edges, not their world bounds); outside a round corner is a miss", () => {
  // A 40 x 40 x 5 plate turned 30 degrees about x; the axis is its top normal through the middle.
  const c = Math.cos(Math.PI / 6), sn = Math.sin(Math.PI / 6);
  const turn = (p: Vec): Vec => [p[0], c * p[1] - sn * p[2], sn * p[1] + c * p[2]];
  const corner = (x: number, y: number, z: number) => turn([x, y, z]);
  const box = (lo: Vec, hi: Vec) => {
    const P = (x: number, y: number, z: number) => corner([lo[0], hi[0]][x]!, [lo[1], hi[1]][y]!, [lo[2], hi[2]][z]!);
    return [
      rect("top", turn([0, 0, 1]), P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1)), rect("bottom", turn([0, 0, -1]), P(0, 0, 0), P(0, 1, 0), P(1, 1, 0), P(1, 0, 0)),
      rect("x-", turn([-1, 0, 0]), P(0, 0, 0), P(0, 0, 1), P(0, 1, 1), P(0, 1, 0)), rect("x+", turn([1, 0, 0]), P(1, 0, 0), P(1, 1, 0), P(1, 1, 1), P(1, 0, 1)),
      rect("y-", turn([0, -1, 0]), P(0, 0, 0), P(1, 0, 0), P(1, 0, 1), P(0, 0, 1)), rect("y+", turn([0, 1, 0]), P(0, 1, 0), P(0, 1, 1), P(1, 1, 1), P(1, 1, 0)),
    ];
  };
  const plate = polyBody(2, box([0, 0, 0], [40, 40, 5]));
  const normal = turn([0, 0, 1]);
  const entry = entryOf(plate, { pointMm: add(turn([20, 20, 5]), mul(normal, 20)), direction: mul(normal, -1), faceIds: [] }, 0, 2);
  assert.equal(entry.entryFaceId, "top");
  assert.ok(Math.abs(entry.wallMm! - 5) < 1e-9, `wall ${entry.wallMm}`);
  // A plate whose (0, 0) corner is rounded 10 mm: an axis at (2, 2) lies outside the round, so it misses the plate.
  const arc = (z: number, id: string) => ({ id, curveType: "Circle", line: false, circle: true, lengthMm: 5 * Math.PI, centerMm: [2.93, 2.93, z], tangent: [1, -1, 0], boundsMm: { min: [0, 0, z], max: [10, 10, z] }, faceIds: [], vertexIds: [],
    circleGeometry: { centerMm: [10, 10, z], radiusMm: 10, normal: [0, 0, 1], reference: [-1, 0, 0], startMm: [0, 10, z], midpointMm: [10 - 5 * Math.SQRT2, 10 - 5 * Math.SQRT2, z], endMm: [10, 0, z] } } as unknown as Edge);
  const rounded = polyBody(3, [
    { id: "rt", normal: [0, 0, 1], points: [[10, 0, 5], [40, 0, 5], [40, 40, 5], [0, 40, 5], [0, 10, 5]] },
    { id: "rb", normal: [0, 0, -1], points: [[10, 0, 0], [40, 0, 0], [40, 40, 0], [0, 40, 0], [0, 10, 0]] },
  ], [{ id: "round", surfaceType: "Cylinder", planar: false, centerMm: [2.93, 2.93, 2.5], normal: [-0.7071, -0.7071, 0], radiusMm: 10, blendRadiusMm: 10, axisOriginMm: [10, 10, 0], axisDirection: [0, 0, 1], boundsMm: { min: [0, 0, 0], max: [10, 10, 5] }, edgeIds: [] } as unknown as Face]);
  // Close each polygon with its arc: drop the chord edge (0,10)-(10,0) and add the arc in its place.
  for (const [faceId, z] of [["rt", 5], ["rb", 0]] as const) {
    const face = rounded.faces.find((candidate) => candidate.id === faceId)!;
    face.edgeIds = face.edgeIds.filter((id) => id !== `${faceId}:e4`);
    const edge = arc(z, `${faceId}:arc`);
    rounded.edges.push(edge);
    face.edgeIds.push(edge.id);
  }
  assert.throws(() => entryOf(rounded, { pointMm: [2, 2, 20], direction: [0, 0, -1], faceIds: [] }, 0, 1), (error: unknown) => error instanceof AxisRefusal && error.code === "miss" && /no face of it lies on the axis/.test(error.message));
  assert.equal(entryOf(rounded, { pointMm: [5, 5, 20], direction: [0, 0, -1], faceIds: [] }, 0, 0.5).entryFaceId, "rt", "inside the round it enters the top face");
});

// ---------- round 2: entry, local wall, existing hole and breakout from exact rays ----------

function cylinderFaceOf(id: string, origin: Vec, dir: Vec, radius: number, s0: number, s1: number, inward: boolean): { face: Face; edges: Edge[] } {
  const e = unitv(dir);
  const p = perp(e);
  const ends = [add(origin, mul(e, s0)), add(origin, mul(e, s1))];
  const edges = ends.map((center, i) => circleEdgeOf(`${id}:${i ? "b" : "a"}`, [id], center, radius, e));
  const spread = [0, 1, 2].map((i) => radius * Math.sqrt(Math.max(0, 1 - e[i]! ** 2)));
  const boundsMm = { min: [0, 1, 2].map((i) => Math.min(ends[0]![i]!, ends[1]![i]!) - spread[i]!) as Vec, max: [0, 1, 2].map((i) => Math.max(ends[0]![i]!, ends[1]![i]!) + spread[i]!) as Vec };
  const face = { id, surfaceType: "Cylinder", planar: false, centerMm: add(mul(add(ends[0]!, ends[1]!), 0.5), mul(p, radius)), normal: inward ? mul(p, -1) : p, radiusMm: radius, blendRadiusMm: null, axisOriginMm: ends[0], axisDirection: e, boundsMm, edgeIds: edges.map((edge) => edge.id) } as unknown as Face;
  return { face, edges };
}
const box6 = (prefix: string, lo: Vec, hi: Vec, skip: string[] = []): FaceSpec[] => {
  const P = (x: number, y: number, z: number): Vec => [[lo[0], hi[0]][x]!, [lo[1], hi[1]][y]!, [lo[2], hi[2]][z]!];
  return [
    rect(`${prefix}z+`, [0, 0, 1], P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1)), rect(`${prefix}z-`, [0, 0, -1], P(0, 0, 0), P(0, 1, 0), P(1, 1, 0), P(1, 0, 0)),
    rect(`${prefix}x-`, [-1, 0, 0], P(0, 0, 0), P(0, 0, 1), P(0, 1, 1), P(0, 1, 0)), rect(`${prefix}x+`, [1, 0, 0], P(1, 0, 0), P(1, 1, 0), P(1, 1, 1), P(1, 0, 1)),
    rect(`${prefix}y-`, [0, -1, 0], P(0, 0, 0), P(1, 0, 0), P(1, 0, 1), P(0, 0, 1)), rect(`${prefix}y+`, [0, 1, 0], P(0, 1, 0), P(0, 1, 1), P(1, 1, 1), P(1, 1, 0)),
  ].filter((spec) => !skip.includes(spec.id));
};
/** Operations on fixed bodies that stop at the first native cut: a refusal stays a refusal, a planned cut throws "reached the cut". */
function polyOps(...bodies: Body[]) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const stop = (op: string) => async (...args: unknown[]) => { calls.push({ op, args }); throw new Error(`reached the cut (${op})`); };
  const operations = {
    async state() { return stateOf(...bodies); }, async undo() { return stateOf(...bodies); }, probeSurface: probeOf(() => bodies),
    async validateBodies() { throw new Error("not reached"); },
    createCylinder: stop("createCylinder"), createPolyline: stop("createPolyline"), revolveProfile: stop("revolveProfile"), boolean: stop("boolean"), remove: stop("remove"),
    createBox: stop("createBox"), fillet: stop("fillet"), extrudeRegions: stop("extrudeRegions"), rectangularPattern: stop("rectangularPattern"), createPipes: stop("createPipes"),
  };
  return { calls, operations: operations as unknown as Parameters<typeof transferHoles>[0] };
}
const turnZ = (deg: number, about: Vec) => (point: Vec): Vec => { const c = Math.cos((deg * Math.PI) / 180), sn = Math.sin((deg * Math.PI) / 180); const x = point[0] - about[0], y = point[1] - about[1]; return [about[0] + c * x - sn * y, about[1] + sn * x + c * y, point[2]]; };
const turnSpecs = (specs: FaceSpec[], turn: (p: Vec) => Vec): FaceSpec[] => specs.map((spec) => ({ ...spec, normal: sub(turn(spec.normal), turn([0, 0, 0])), points: spec.points.map(turn), ...(spec.holes ? { holes: spec.holes.map((loop) => loop.map(turn)) } : {}) }));
// The review's pocket: a 60 x 40 x 15 block with a 40 x 24 pocket 10 deep (floor 5 thick).
function pocketSpecs(): FaceSpec[] {
  const ring = (z: number): Vec[] => [[10, 8, z], [50, 8, z], [50, 32, z], [10, 32, z]];
  return [
    { id: "top", normal: [0, 0, 1], points: [[0, 0, 15], [60, 0, 15], [60, 40, 15], [0, 40, 15]], holes: [ring(15)] },
    rect("floor", [0, 0, 1], ...(ring(5) as [Vec, Vec, Vec, Vec])),
    rect("wx-", [1, 0, 0], [10, 8, 5], [10, 32, 5], [10, 32, 15], [10, 8, 15]), rect("wx+", [-1, 0, 0], [50, 8, 5], [50, 8, 15], [50, 32, 15], [50, 32, 5]),
    rect("wy-", [0, 1, 0], [10, 8, 5], [10, 8, 15], [50, 8, 15], [50, 8, 5]), rect("wy+", [0, -1, 0], [10, 32, 5], [50, 32, 5], [50, 32, 15], [10, 32, 15]),
    ...box6("o", [0, 0, 0], [60, 40, 15], ["oz+"]),
  ];
}
const T3 = { diameterMm: 3, through: true as const };
const cutStart = (calls: Array<{ op: string; args: unknown[] }>) => calls.find((call) => call.op === "createCylinder")!.args as [Vec, number, number, string | undefined, string, Vec];
const near6 = (a: Vec, b: Vec) => Math.hypot(...sub(a, b)) <= 1e-6;

test("round 2 (B1): a hole in the floor of a pocket (through and blind) is cut; material beside the rim is not on the bore", async () => {
  for (const hole of [T3, { diameterMm: 3, depthMm: 4 }]) {
    const { calls, operations } = polyOps(sourceStub(), polyBody(2, pocketSpecs()));
    await assert.rejects(transferHoles(operations, { sourceId: 1, targetId: 2, axesMm: [{ pointMm: [30, 20, 50], axis: [0, 0, -1] }], hole, revision: "r1" }), /reached the cut/);
    const [start, radius, height, , , axis] = cutStart(calls);
    assert.ok(near6(start, [30, 20, 5.5]) && radius === 1.5 && near6(axis, [0, 0, -1]), JSON.stringify(calls[0]));
    assert.equal(height, "through" in hole ? 6 : 4.5, "through to the bottom, or the blind depth");
  }
  // 1 mm from the pocket wall the rim runs into the wall (the top face, 10 mm above the floor): refused.
  const { operations } = polyOps(sourceStub(), polyBody(2, pocketSpecs()));
  await assert.rejects(transferHoles(operations, { sourceId: 1, targetId: 2, axesMm: [{ pointMm: [11, 20, 50], axis: [0, 0, -1] }], hole: T3, revision: "r1" }), /does not fit inside the entry face floor|material precedes the first planar face/);
});

test("round 2 (B1): the same pocket turned 30 degrees is cut at its centre and 4 mm from a wall", async () => {
  const turn = turnZ(30, [30, 20, 0]);
  for (const [u, v] of [[0, 0], [15, 8]] as const) {
    const at = turn([30 + u, 20 + v, 50]);
    const { calls, operations } = polyOps(sourceStub(), polyBody(2, turnSpecs(pocketSpecs(), turn)));
    await assert.rejects(transferHoles(operations, { sourceId: 1, targetId: 2, axesMm: [{ pointMm: at, axis: [0, 0, -1] }], hole: T3, revision: "r1" }), /reached the cut/, `offset ${u},${v}`);
    assert.ok(near6(cutStart(calls)[0], [at[0], at[1], 5.5]));
  }
});

test("round 2 (B1): select transfers an L bracket's base holes onto the floor of an open enclosure", async () => {
  const enclosure = polyBody(2, [
    { id: "rim", normal: [0, 0, 1], points: [[0, 0, 30], [80, 0, 30], [80, 60, 30], [0, 60, 30]], holes: [[[3, 3, 30], [77, 3, 30], [77, 57, 30], [3, 57, 30]]] },
    rect("floor", [0, 0, 1], [3, 3, 3], [77, 3, 3], [77, 57, 3], [3, 57, 3]),
    rect("ix-", [1, 0, 0], [3, 3, 3], [3, 57, 3], [3, 57, 30], [3, 3, 30]), rect("ix+", [-1, 0, 0], [77, 3, 3], [77, 3, 30], [77, 57, 30], [77, 57, 3]),
    rect("iy-", [0, 1, 0], [3, 3, 3], [3, 3, 30], [77, 3, 30], [77, 3, 3]), rect("iy+", [0, -1, 0], [3, 57, 3], [77, 57, 3], [77, 57, 30], [3, 57, 30]),
    ...box6("o", [0, 0, 0], [80, 60, 30], ["oz+"]),
  ]);
  const holes = [[36.5, 22], [36.5, 38]].map(([x, y], i) => cylinderFaceOf(`bh${i}`, [x!, y!, 3], [0, 0, 1], 1.7, 0, 3, true));
  const bracket = polyBody(1, box6("b", [20, 15, 3], [50, 45, 6]), holes.map((hole) => hole.face), holes.flatMap((hole) => hole.edges));
  const { calls, operations } = polyOps(bracket, enclosure);
  await assert.rejects(transferHoles(operations, { sourceId: 1, targetId: 2, select: { radiusMm: 1.7, axis: "z" }, hole: { diameterMm: 2.5, depthMm: 2 }, revision: "r1" }), /reached the cut/);
  const [start, radius, height, , , axis] = cutStart(calls);
  assert.ok(start[2] === 3.5 && radius === 1.25 && height === 2.5 && near6(axis, [0, 0, -1]), JSON.stringify(calls[0]!.args));
});

test("round 2 (B1): a pilot at the centre of a round recess is cut (the recess wall ends at the floor, it is no existing hole)", async () => {
  const wall = cylinderFaceOf("rwall", [20, 30, 3], [0, 0, 1], 6, 0, 3, true);
  const floorCircle = circleEdgeOf("rfloor:c", ["rfloor"], [20, 30, 3], 6, [0, 0, 1]);
  const floor = { id: "rfloor", surfaceType: "Plane", planar: true, centerMm: [20, 30, 3], normal: [0, 0, 1], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [14, 24, 3], max: [26, 36, 3] }, edgeIds: [floorCircle.id] } as unknown as Face;
  const plate = polyBody(2, [{ id: "top", normal: [0, 0, 1], points: [[0, 0, 6], [80, 0, 6], [80, 60, 6], [0, 60, 6]], circles: [{ center: [20, 30, 6], radius: 6 }] }, ...box6("o", [0, 0, 0], [80, 60, 6], ["oz+"])], [wall.face, floor], [...wall.edges, floorCircle]);
  const { calls, operations } = polyOps(sourceStub(), plate);
  await assert.rejects(transferHoles(operations, { sourceId: 1, targetId: 2, axesMm: [{ pointMm: [20, 30, 50], axis: [0, 0, -1] }], hole: T3, revision: "r1" }), /reached the cut/);
  assert.ok(near6(cutStart(calls)[0], [20, 30, 3.5]));
});

test("round 2 (B1): a hole 15 mm from a 45 degree rib is cut", async () => {
  const turn = turnZ(45, [40, 40, 0]);
  const foot = ([[10, 38.5, 0], [70, 38.5, 0], [70, 41.5, 0], [10, 41.5, 0]] as Vec[]).map(turn);
  const at = (z: number) => foot.map((p): Vec => [p[0], p[1], z]);
  const ribSides = foot.map((p, i) => { const q = foot[(i + 1) % 4]!; const n = unitv([q[1] - p[1], p[0] - q[0], 0]); return rect(`rib${i}`, n, [p[0], p[1], 5], [q[0], q[1], 5], [q[0], q[1], 15], [p[0], p[1], 15]); });
  const plate = polyBody(2, [
    { id: "top", normal: [0, 0, 1], points: [[0, 0, 5], [80, 0, 5], [80, 80, 5], [0, 80, 5]], holes: [at(5)] },
    { id: "ribtop", normal: [0, 0, 1], points: at(15) }, ...ribSides, ...box6("o", [0, 0, 0], [80, 80, 5], ["oz+"]),
  ]);
  const { calls, operations } = polyOps(sourceStub(), plate);
  await assert.rejects(transferHoles(operations, { sourceId: 1, targetId: 2, axesMm: [{ pointMm: [50.607, 29.393, 50], axis: [0, 0, -1] }], hole: { diameterMm: 5, through: true }, revision: "r1" }), /reached the cut/);
  assert.ok(near6(cutStart(calls)[0], [50.607, 29.393, 5.5]));
});

test("round 2 (B1): a rim ray that finds no material is 'the rim runs over an edge', where the entry face's own edges cannot say", async () => {
  // An L-shaped plate whose top face has a non-line edge: the exact edge test cannot run, the rim rays decide.
  const L: Vec[] = [[0, 0, 0], [40, 0, 0], [40, 20, 0], [20, 20, 0], [20, 40, 0], [0, 40, 0]];
  const plate = polyBody(2, [
    { id: "lt", normal: [0, 0, 1], points: L.map((p): Vec => [p[0], p[1], 5]), curve: "Ellipse" }, { id: "lb", normal: [0, 0, -1], points: L },
    ...L.map((p, i) => { const q = L[(i + 1) % L.length]!; return rect(`ls${i}`, unitv([q[1] - p[1], p[0] - q[0], 0]), p, q, [q[0], q[1], 5], [p[0], p[1], 5]); }),
  ]);
  const { calls, operations } = polyOps(sourceStub(), plate);
  await assert.rejects(transferHoles(operations, { sourceId: 1, targetId: 2, axesMm: [{ pointMm: [19, 19, 30], axis: [0, 0, -1] }], hole: { diameterMm: 4, through: true }, revision: "r1" }),
    (error: unknown) => error instanceof AxisRefusal && error.code === "rim" && /the rim runs over an edge of the entry face lt: the rim ray at radius 2 mm, \d+ degrees finds no material/.test(error.message));
  assert.deepEqual(calls, []);
});

test("round 2 (B1): an axis that finds no material where the rim does is an existing hole, though no face of it is coaxial", async () => {
  const k = kernel();
  const plate = await blockAndPlate(k, [[22, 12, 0]]);
  const first = await transferHoles(k.operations, { sourceId: 1, targetId: plate, axesMm: [{ pointMm: [30.5, 20, 10], axis: [0, 0, -1] }], hole: { diameterMm: 2, through: true }, revision: k.rev() });
  k.calls.length = 0;
  await assert.rejects(transferHoles(k.operations, { sourceId: 1, targetId: first.targetId, axesMm: [{ pointMm: [30, 20, 10], axis: [0, 0, -1] }], hole: { diameterMm: 4, through: true }, revision: k.rev() }),
    (error: unknown) => error instanceof AxisRefusal && error.code === "existing-hole" && /the axis finds no material where the bore would start/.test(error.message));
  assert.deepEqual(k.calls, []);
});

test("round 2 (B2): a countersink cone that breaks out is rolled back", async () => {
  const k = kernel();
  const plate = await blockAndPlate(k, [[22, 12, 0]]);
  const before = k.state();
  k.control.coneHalf = true;
  await assert.rejects(transferHoles(k.operations, { sourceId: 1, targetId: plate, select: { radiusMm: 1.5 }, hole: { diameterMm: 3.4, through: true, countersunk: { headDiameterMm: 6.5 } }, revision: k.rev() }),
    (error: unknown) => error instanceof GuardedRunError && error.restored && /axis 0: the countersink cone breaks out of a side wall of the target \(face \S+:k0 ends in a partial circle \(180\.0 degrees\)/.test(error.message) && /do not call plasticity_redo/.test(error.message));
  assert.equal(k.state().undoDepth, before.undoDepth);
});

test("round 2 (B2): a counterbore that reaches through a thin wall is refused before the edit; a counterbore floor that breaks out is rolled back", async () => {
  // The review's thin step: a 2 mm flange (z 10..12) on a 12 mm stem; the axis 3.5 mm inside the stem wall.
  const thin = polyBody(2, [
    rect("top", [0, 0, 1], [0, 0, 12], [40, 0, 12], [40, 40, 12], [0, 40, 12]), rect("under", [0, 0, -1], [12, 0, 10], [40, 0, 10], [40, 40, 10], [12, 40, 10]),
    rect("foot", [0, 0, -1], [0, 0, 0], [12, 0, 0], [12, 40, 0], [0, 40, 0]), rect("stemside", [1, 0, 0], [12, 0, 0], [12, 40, 0], [12, 40, 10], [12, 0, 10]),
    rect("back", [-1, 0, 0], [0, 0, 0], [0, 40, 0], [0, 40, 12], [0, 0, 12]), rect("end", [1, 0, 0], [40, 0, 10], [40, 40, 10], [40, 40, 12], [40, 0, 12]),
    { id: "front", normal: [0, -1, 0], points: [[0, 0, 0], [12, 0, 0], [12, 0, 10], [40, 0, 10], [40, 0, 12], [0, 0, 12]] },
    { id: "rear", normal: [0, 1, 0], points: [[0, 40, 0], [12, 40, 0], [12, 40, 10], [40, 40, 10], [40, 40, 12], [0, 40, 12]] },
  ]);
  const { calls, operations } = polyOps(sourceStub(), thin);
  await assert.rejects(transferHoles(operations, { sourceId: 1, targetId: 2, axesMm: [{ pointMm: [8.5, 20, 30], axis: [0, 0, -1] }], hole: { diameterMm: 4, through: true, counterbore: { diameterMm: 12, depthMm: 4 } }, revision: "r1" }),
    /counterbore depth 4 reaches the far side of the wall: the next target face is 2\.0000 mm from the entry within the counterbore radius/);
  assert.deepEqual(calls, []);
  const k = kernel();
  const plate = await blockAndPlate(k, [[22, 12, 0]]);
  k.control.floorLine = true;
  await assert.rejects(transferHoles(k.operations, { sourceId: 1, targetId: plate, select: { radiusMm: 1.5 }, hole: { diameterMm: 3.4, through: true, counterbore: { diameterMm: 6, depthMm: 1.5 } }, revision: k.rev() }),
    (error: unknown) => error instanceof GuardedRunError && error.restored && /axis 0: the counterbore floor breaks out of a side wall of the target/.test(error.message));
});

test("round 2 (B3): a through hole that leaves by a chamfer is refused before the edit, and the message says so", async () => {
  const block = polyBody(2, [
    rect("top", [0, 0, 1], [0, 0, 15], [40, 0, 15], [40, 40, 15], [0, 40, 15]), rect("bottom", [0, 0, -1], [0, 0, 0], [0, 40, 0], [30, 40, 0], [30, 0, 0]),
    rect("end", [1, 0, 0], [40, 0, 10], [40, 40, 10], [40, 40, 15], [40, 0, 15]), rect("chamfer", unitv([1, 0, -1]), [30, 0, 0], [30, 40, 0], [40, 40, 10], [40, 0, 10]),
    rect("back", [-1, 0, 0], [0, 0, 0], [0, 0, 15], [0, 40, 15], [0, 40, 0]),
    { id: "front", normal: [0, -1, 0], points: [[0, 0, 0], [30, 0, 0], [40, 0, 10], [40, 0, 15], [0, 0, 15]] },
    { id: "rear", normal: [0, 1, 0], points: [[0, 40, 0], [0, 40, 15], [40, 40, 15], [40, 40, 10], [30, 40, 0]] },
  ]);
  const { calls, operations } = polyOps(sourceStub(), block);
  await assert.rejects(transferHoles(operations, { sourceId: 1, targetId: 2, axesMm: [{ pointMm: [35, 20, 50], axis: [0, 0, -1] }], hole: { diameterMm: 4, through: true }, revision: "r1" }),
    (error: unknown) => error instanceof AxisRefusal && error.code === "breakout" && /axis 0 .*: the bore exits through an oblique face of the target \(face chamfer: a chamfer or slope\)/.test(error.message) && !/side wall/.test(error.message));
  assert.deepEqual(calls, []);
  // Away from the chamfer the same hole is cut.
  const away = polyOps(sourceStub(), block);
  await assert.rejects(transferHoles(away.operations, { sourceId: 1, targetId: 2, axesMm: [{ pointMm: [15, 20, 50], axis: [0, 0, -1] }], hole: { diameterMm: 4, through: true }, revision: "r1" }), /reached the cut/);
});

test("round 2 (B3): a through hole that crosses a cross hole is refused before the edit, and the message says so", async () => {
  const cross = cylinderFaceOf("xhole", [0, 20, 10], [1, 0, 0], 3, 0, 40, true);
  const block = polyBody(2, [
    ...box6("o", [0, 0, 0], [40, 40, 20], ["ox-", "ox+"]),
    { id: "ox-", normal: [-1, 0, 0], points: [[0, 0, 0], [0, 0, 20], [0, 40, 20], [0, 40, 0]], circles: [{ center: [0, 20, 10], radius: 3 }] },
    { id: "ox+", normal: [1, 0, 0], points: [[40, 0, 0], [40, 40, 0], [40, 40, 20], [40, 0, 20]], circles: [{ center: [40, 20, 10], radius: 3 }] },
  ], [cross.face], cross.edges);
  const { calls, operations } = polyOps(sourceStub(), block);
  await assert.rejects(transferHoles(operations, { sourceId: 1, targetId: 2, axesMm: [{ pointMm: [20, 20, 50], axis: [0, 0, -1] }], hole: { diameterMm: 4, through: true }, revision: "r1" }),
    (error: unknown) => error instanceof AxisRefusal && error.code === "breakout" && /the bore crosses a curved face of the target \(face xhole Cylinder: a cross hole or a fillet\)/.test(error.message));
  assert.deepEqual(calls, []);
  // A blind hole that stops above the cross hole is cut; one that reaches it is refused by the local wall.
  const blind = polyOps(sourceStub(), block);
  await assert.rejects(transferHoles(blind.operations, { sourceId: 1, targetId: 2, axesMm: [{ pointMm: [20, 20, 50], axis: [0, 0, -1] }], hole: { diameterMm: 4, depthMm: 6 }, revision: "r1" }), /reached the cut/);
  await assert.rejects(transferHoles(blind.operations, { sourceId: 1, targetId: 2, axesMm: [{ pointMm: [20, 20, 50], axis: [0, 0, -1] }], hole: { diameterMm: 4, depthMm: 7 }, revision: "r1" }), /depthMm 7 reaches the far side of the wall: the next target face on the axis is 7\.0000 mm/);
});

test("round 2: a blind hole in the near wall of a U whose far wall is drilled on the same axis is cut; a through hole there is an existing hole", async () => {
  // Near wall x 0..3, far wall x 37..40 with a Ø4 hole on the axis.
  const farHole = cylinderFaceOf("far", [37, 15, 20], [1, 0, 0], 2, 0, 3, true);
  const u = polyBody(2, [...box6("n", [0, 0, 0], [3, 30, 30]), ...box6("f", [37, 0, 0], [40, 30, 30])], [farHole.face], farHole.edges);
  const blind = polyOps(sourceStub(), u);
  await assert.rejects(transferHoles(blind.operations, { sourceId: 1, targetId: 2, axesMm: [{ pointMm: [-10, 15, 20], axis: [1, 0, 0] }], hole: { diameterMm: 4, depthMm: 2.9 }, revision: "r1" }), /reached the cut/);
  const through = polyOps(sourceStub(), u);
  await assert.rejects(transferHoles(through.operations, { sourceId: 1, targetId: 2, axesMm: [{ pointMm: [-10, 15, 20], axis: [1, 0, 0] }], hole: { diameterMm: 4, through: true }, revision: "r1" }), /already has a hole on this axis \(face far, radius 2 mm\)/);
});

test("round 2: a pocket-corner fillet coaxial with the hole ends at the entry plane: it is no existing hole and no part of the cut", async () => {
  const k = kernel();
  const plate = await blockAndPlate(k, [[22, 12, 0]]);
  // An inward quarter round of radius 5 standing on the plate's top face (z 0..10), on the hole's axis.
  k.addPin(plate, { origin: [30, 20, 0], dir: [0, 0, 1], radius: 5, from: 0, to: 10, facing: -1, quarter: true });
  const cut = await transferHoles(k.operations, { sourceId: 1, targetId: plate, axesMm: [{ pointMm: [30, 20, 10], axis: [0, 0, -1] }], hole: { diameterMm: 3, through: true }, revision: k.rev() });
  assert.deepEqual([cut.axisCount, cut.holeCount, cut.axesMm[0]!.entryPointMm], [1, 1, [30, 20, 0]]);
});

test("round 2: select drills toward the nearer target side when the target lies past both ends of the source hole", async () => {
  // A source hole z 3..6 between two slabs of one target: one touching below (z 0..3), one 14 mm above (z 20..25).
  const hole = cylinderFaceOf("sh", [30, 20, 3], [0, 0, 1], 1.7, 0, 3, true);
  const source = polyBody(1, box6("s", [20, 10, 3], [40, 30, 6]), [hole.face], hole.edges);
  const target = polyBody(2, [...box6("lo", [0, 0, 0], [60, 40, 3]), ...box6("hi", [0, 0, 20], [60, 40, 25])]);
  const { calls, operations } = polyOps(source, target);
  await assert.rejects(transferHoles(operations, { sourceId: 1, targetId: 2, select: { radiusMm: 1.7 }, hole: { diameterMm: 3.4, through: true }, revision: "r1" }), /reached the cut/);
  const [start, , , , , axis] = cutStart(calls);
  assert.ok(near6(start, [30, 20, 3.5]) && near6(axis, [0, 0, -1]), JSON.stringify(calls[0]!.args));
});

test("round 2: a blind hole on the axis of a hole past its floor is cut and read back alone (the far hole is not part of the cut)", async () => {
  const k = kernel();
  const plate = await blockAndPlate(k, [[22, 12, 0]]);
  // An inward bore of the same radius on the axis, 10 to 14 mm under the plate's top face (past a 2 mm blind floor).
  k.addPin(plate, { origin: [30, 20, -10], dir: [0, 0, -1], radius: 1.5, from: 0, to: 4, facing: -1 });
  const cut = await transferHoles(k.operations, { sourceId: 1, targetId: plate, axesMm: [{ pointMm: [30, 20, 10], axis: [0, 0, -1] }], hole: { diameterMm: 3, depthMm: 2 }, revision: k.rev() });
  assert.deepEqual([cut.axisCount, cut.holeCount, cut.holes[0]!.holeFaceId.includes("pin")], [1, 1, false]);
});

// ---------- final review T1: the clearance ring, 16 rays above Ø10, incomplete rays, the blind-floor rule ----------

const AX = (point: Vec, axis: Vec = [0, 0, -1]) => [{ pointMm: point, axis }];
const thinWall = (pattern: RegExp) => (error: unknown) => error instanceof AxisRefusal && error.code === "thin-wall" && /axis 0 \(point \[[^\]]+\], direction \[[^\]]+\]\): the hole leaves a wall thinner than 0\.05 mm beside the bore/.test(error.message) && pattern.test(error.message) && /refused before the edit/.test(error.message);
// A 40 x 40 x 20 block with a 10 x 10 x 6 internal void (x, y 15..25, z 7..13): the void's faces look into the void.
const voidedBlock = () => polyBody(2, [...box6("o", [0, 0, 0], [40, 40, 20]), ...box6("v", [15, 15, 7], [25, 25, 13]).map((spec) => ({ ...spec, normal: mul(spec.normal, -1) }))]);
// A 60 x 40 x 15 block with two pockets 10 deep (x 5..29.5 and 30.5..55, y 5..35): a 1 mm wall stands between them.
function twinPocketBlock(): Body {
  const ring = (x0: number, x1: number, z: number): Vec[] => [[x0, 5, z], [x1, 5, z], [x1, 35, z], [x0, 35, z]];
  const pocket = (tag: string, x0: number, x1: number): FaceSpec[] => [
    rect(`${tag}floor`, [0, 0, 1], ...(ring(x0, x1, 5) as [Vec, Vec, Vec, Vec])),
    rect(`${tag}x-`, [1, 0, 0], [x0, 5, 5], [x0, 35, 5], [x0, 35, 15], [x0, 5, 15]), rect(`${tag}x+`, [-1, 0, 0], [x1, 5, 5], [x1, 5, 15], [x1, 35, 15], [x1, 35, 5]),
    rect(`${tag}y-`, [0, 1, 0], [x0, 5, 5], [x0, 5, 15], [x1, 5, 15], [x1, 5, 5]), rect(`${tag}y+`, [0, -1, 0], [x0, 35, 5], [x1, 35, 5], [x1, 35, 15], [x0, 35, 15]),
  ];
  return polyBody(2, [
    { id: "top", normal: [0, 0, 1], points: [[0, 0, 15], [60, 0, 15], [60, 40, 15], [0, 40, 15]], holes: [ring(5, 29.5, 15), ring(30.5, 55, 15)] },
    ...pocket("a", 5, 29.5), ...pocket("b", 30.5, 55), ...box6("o", [0, 0, 0], [60, 40, 15], ["oz+"]),
  ]);
}
const transferOn = (body: Body, axes: ReturnType<typeof AX>, hole: Parameters<typeof transferHoles>[1]["hole"], extra: Partial<Parameters<typeof transferHoles>[1]> = {}) => {
  const ops = polyOps(sourceStub(), body);
  return { ops, run: transferHoles(ops.operations, { sourceId: 1, targetId: 2, axesMm: axes, hole, revision: "r1", ...extra }) };
};

test("T1 guard 1: a second ring 0.05 mm outside the bore: a bore 0.002 mm beside a pocket wall is refused before the edit; 0.06 mm away it is cut", async () => {
  // The review's input: Ø3 through the pocket floor, its rim 0.002 mm from the pocket wall at x 10.
  for (const gap of [0.002, 0.04]) {
    const { ops, run } = transferOn(polyBody(2, pocketSpecs()), AX([11.5 + gap, 20, 50]), T3);
    await assert.rejects(run, thinWall(/the ray at radius 1\.55 mm, \d+ degrees \(0\.05 mm outside the bore\) meets face top \(Plane\) -10 mm from the entry plane where the ray on the bore radius meets face floor \(Plane\) 0 mm from the entry plane/), `gap ${gap}`);
    assert.deepEqual(ops.calls, [], "no native call");
  }
  const { ops, run } = transferOn(polyBody(2, pocketSpecs()), AX([11.56, 20, 50]), T3);
  await assert.rejects(run, /reached the cut/);
  assert.ok(near6(cutStart(ops.calls)[0], [11.56, 20, 5.5]));
});

test("T1 guard 1: a bore 0.002 mm beside an internal void is refused; 1 mm beside it is cut", async () => {
  const beside = transferOn(voidedBlock(), AX([12.998, 20, 60]), { diameterMm: 4, through: true });
  await assert.rejects(beside.run, thinWall(/the ray at radius 2\.05 mm, \d+ degrees \(0\.05 mm outside the bore\) meets face vz\+ \(Plane\) 7 mm from the entry plane where the ray on the bore radius meets face oz- \(Plane\) 20 mm from the entry plane/));
  assert.deepEqual(beside.ops.calls, []);
  await assert.rejects(transferOn(voidedBlock(), AX([12, 20, 60]), { diameterMm: 4, through: true }).run, /reached the cut/);
});

test("T1 guard 1: a Ø0.99 hole up a 1 mm wall (0.005 mm left on each side) is refused; Ø0.8 (0.1 mm left) is cut", async () => {
  const up: Vec = [0, 0, 1];
  const thin = transferOn(twinPocketBlock(), AX([30, 20, -30], up), { diameterMm: 0.99, through: true });
  await assert.rejects(thin.run, thinWall(/the ray at radius 0\.545 mm, \d+ degrees \(0\.05 mm outside the bore\) meets face [ab]floor \(Plane\) 5 mm from the entry plane where the ray on the bore radius meets face top \(Plane\) 15 mm from the entry plane/));
  assert.deepEqual(thin.ops.calls, []);
  await assert.rejects(transferOn(twinPocketBlock(), AX([30, 20, -30], up), { diameterMm: 0.8, through: true }).run, /reached the cut/);
});

test("T1 guard 1: the ring is compared only as far as the cut reaches: a step past a blind hole's floor does not refuse it; a head has its own ring", async () => {
  // The stepped body: under x > 12 the flange is 5 mm; the stem (x < 12) goes down 15. Ø5 at x 14.52: the bore rays stay
  // 0.02 mm clear of the stem wall, the clearance ring crosses it.
  const at = AX([14.52, 20, 30]);
  await assert.rejects(transferOn(steppedBody(), at, { diameterMm: 5, through: true }).run, thinWall(/meets face foot \(Plane\) 15 mm from the entry plane where the ray on the bore radius meets face under \(Plane\) 5 mm from the entry plane/));
  // Blind 2 mm: the difference lies 5 mm down, past the floor and the 0.05 mm behind it.
  await assert.rejects(transferOn(steppedBody(), at, { diameterMm: 5, depthMm: 2 }).run, /reached the cut/);
  // A counterbore's head has its own clearance ring, compared down to the counterbore depth: Ø8 x 1 with its rim 0.03 mm
  // from the pocket wall is refused; the same Ø3 bore without the head is cut.
  const head = transferOn(polyBody(2, pocketSpecs()), AX([14.03, 20, 50]), { diameterMm: 3, through: true, counterbore: { diameterMm: 8, depthMm: 1 } });
  await assert.rejects(head.run, (error: unknown) => error instanceof AxisRefusal && error.code === "thin-wall" && /the hole leaves a wall thinner than 0\.05 mm beside the bore's head: the ray at radius 4\.05 mm, \d+ degrees \(0\.05 mm outside the head\) meets face top/.test(error.message));
  assert.deepEqual(head.ops.calls, []);
  await assert.rejects(transferOn(polyBody(2, pocketSpecs()), AX([14.03, 20, 50]), T3).run, /reached the cut/);
});

test("T1 guard 2: 16 rays per ring above Ø10 (the bore, its countersink head or counterbore), 8 up to Ø10; the clearance ring repeats the angles 0.05 mm out", async () => {
  assert.deepEqual([RIM_RAYS, RIM_RAYS_LARGE, CLEARANCE_RING_MM], [8, 16, 0.05]);
  assert.deepEqual([rimRayCount([5]), rimRayCount([5.005]), rimRayCount([6]), rimRayCount([2, 6]), rimRayCount([2, 5])], [8, 16, 16, 16, 8]);
  const axis = { pointMm: [0, 0, 10] as Vec, direction: [0, 0, -1] as Vec, faceIds: [] };
  for (const [radii, perRing] of [[[5], 8], [[6], 16], [[2, 6], 16]] as Array<[number[], number]>) {
    const rays = axisRays(axis, radii);
    assert.equal(rays.plus.length, 1 + 2 * radii.length * perRing, `radii ${radii}`);
    assert.equal(rays.minus.length, rays.plus.length);
    const offset = (k: number) => Math.hypot(rays.plus[k]!.originMm[0], rays.plus[k]!.originMm[1]);
    const angle = (k: number) => Math.atan2(rays.plus[k]!.originMm[1], rays.plus[k]!.originMm[0]);
    for (const [ring, radius] of radii.entries()) for (let k = 0; k < perRing; k += 1) {
      const inner = 1 + ring * perRing + k, outer = inner + radii.length * perRing;
      assert.ok(Math.abs(offset(inner) - radius) < 1e-12 && Math.abs(offset(outer) - radius - 0.05) < 1e-12, `ring ${ring} ray ${k}`);
      assert.ok(Math.abs(Math.sin(angle(inner) - angle(outer))) < 1e-12 && Math.cos(angle(inner) - angle(outer)) > 0, "same angle");
    }
  }
  // A Ø12 hole is planned with 2 x (1 + 2 x 16) rays, a Ø10 hole with 2 x (1 + 2 x 8).
  const plate = polyBody(2, box6("o", [0, 0, 0], [60, 60, 6]));
  const state = stateOf(sourceStub(), plate);
  const base = { sourceId: 1, targetId: 2, axesMm: AX([30, 30, 50]), revision: "r1" };
  assert.equal((await planTransferOn(state, { ...base, hole: { diameterMm: 12, through: true } })).probe.rays, 66);
  assert.equal((await planTransferOn(state, { ...base, hole: { diameterMm: 10, through: true } })).probe.rays, 34);
  assert.equal((await planTransferOn(state, { ...base, hole: { diameterMm: 4, through: true, counterbore: { diameterMm: 12, depthMm: 2 } } })).probe.rays, 130);
  // What the finer ring buys: a Ø0.8 cross hole 2.3 mm off the axis of a Ø12 bore lies between the 8 rays (45 degrees
  // apart) and on a ray of the 16 (at 67.5 degrees, 2.296 mm off).
  const cross = cylinderFaceOf("xhole", [0, 32.3, 3], [1, 0, 0], 0.4, 0, 60, true);
  const crossed = polyBody(2, box6("o", [0, 0, 0], [60, 60, 6]), [cross.face], cross.edges);
  const source = { pointMm: [30, 30, 50] as Vec, direction: [0, 0, -1] as Vec, faceIds: [] };
  const withRays = (perRing: number) => { const rays = axisRays(source, [6], perRing); return planEntry(crossed, source, 0, [6], { plus: castRays(crossed, rays.plus) as never, minus: castRays(crossed, rays.minus) as never }); };
  assert.equal(withRays(8).agree, true, "8 rays per ring do not meet the cross hole");
  assert.equal(withRays(16).agree, false, "16 do");
  await assert.rejects(planTransferOn(stateOf(sourceStub(), crossed), { ...base, hole: { diameterMm: 12, through: true } }), (error: unknown) => error instanceof AxisRefusal && error.code === "breakout" && /the bore crosses a curved face of the target \(face xhole Cylinder/.test(error.message));
});

// One ray of a probe answer, as plasticity_probe_surface returns it.
const rayOf = (distances: Array<[number, number]>, flags: Partial<ProbeRayResult> = {}): ProbeRayResult => ({
  originMm: [0, 0, 10], direction: [0, 0, -1], hits: distances.length,
  intersections: distances.map(([distanceMm, nz], i) => ({ pointMm: [0, 0, 10 - distanceMm] as Vec, faceId: `f${i}`, normal: [0, 0, nz] as Vec, distanceMm, residualMm: 0 })), ...flags,
});
// The parity flag as the probe reports it: the reason text, and the stable code the transfer decides on.
const PARITY = { unresolvedCrossings: 1, unresolvedReason: "odd number of crossings (3) on a closed Solid from an outside origin: at least one crossing is missing or a tangent touch was counted", unresolvedCode: "parity" as const, unresolvedCodes: ["parity" as const] };

test("T1 guard 3: a ray with unresolvedCrossings or grazing is complete only where the flag cannot matter", () => {
  const down: Vec = [0, 0, -1];
  // No flag: complete.
  assert.equal(unprovenRay(rayOf([[5, 1], [10, -1]]), down, Infinity), undefined);
  // grazing: refused within the limit, ignored past it.
  const graze = rayOf([[5, 1], [10, -1]], { grazing: [{ faceId: "wall", minDistanceMm: 0.0004, atMm: [0, 0, 3] }] });
  assert.match(unprovenRay(graze, down, 8)!, /it passes 0\.0004 mm from face wall without a crossing \(a grazing or tangent touch 7 mm along the ray\)/);
  assert.equal(unprovenRay(graze, down, 6.9), undefined);
  // A crossing the probe cannot place (a display-mesh crossing no exact hit explains): refused wherever the limit is.
  assert.match(unprovenRay(rayOf([[5, 1], [10, -1]], { unresolvedCrossings: 1 }), down, 0)!, /1 of its crossings could not be resolved \(the probe cannot say where\)/);
  assert.match(unprovenRay(rayOf([[5, 1], [10, -1], [20, 1]], { ...PARITY, unresolvedCrossings: 2, unresolvedCodes: ["parity", "mesh-crossing"] }), down, 0)!, /1 of its crossings could not be resolved/);
  // The parity guard alone (an odd count): placed by the crossings. Into the material at 5, out at 10, into it again at
  // 20 with no way out: the anomaly lies past 10, so a cut that reaches 7.05 mm is proven and a through cut is not.
  const odd = rayOf([[5, 1], [10, -1], [20, 1]], PARITY);
  assert.equal(unprovenRay(odd, down, 7.05), undefined);
  assert.match(unprovenRay(odd, down, Infinity)!, /odd number of crossings and ends inside the material: a crossing is missing/);
  // Two entries in a row (a rim counted on the way in, as live on a ray along an existing bore wall): the anomaly is at 9.48.
  const twice = rayOf([[5, 1], [9.48, 1], [20, -1]], PARITY);
  assert.match(unprovenRay(twice, down, 9.53)!, /they do not alternate at 9\.48 mm \(face f1\)/);
  assert.match(unprovenRay(twice, down, 5.5)!, /do not alternate at 9\.48 mm/, "the way out between 5 and 9.48 may lie within 5.5");
  assert.equal(unprovenRay(twice, down, 4.9), undefined, "nothing is decided past the first crossing");
  // A ray that starts on a face and leaves the body there (one crossing, at 0) is complete.
  assert.equal(unprovenRay(rayOf([[0, -1]], PARITY), down, 0), undefined);
  // Only the parity guard's own reason is placed this way: any other reason is refused, and so is a second reason
  // joined to it (the probe joins reasons with "; ").
  assert.match(unprovenRay(rayOf([[5, 1], [10, -1], [20, 1]], { unresolvedCrossings: 1, unresolvedReason: "a face could not be evaluated", unresolvedCode: "kernel-error", unresolvedCodes: ["kernel-error"] }), down, 7.05)!, /its crossings could not be resolved \(a face could not be evaluated\)/);
  assert.match(unprovenRay(rayOf([[5, 1], [10, -1], [20, 1]], { unresolvedCrossings: 2, unresolvedReason: `${PARITY.unresolvedReason}; a face could not be evaluated`, unresolvedCode: "kernel-error", unresolvedCodes: ["parity", "kernel-error"] }), down, 7.05)!, /its crossings could not be resolved \(odd number of crossings .*; a face could not be evaluated\)/);
  // An exit first (the entry is missing) is refused even with the limit at the origin.
  assert.match(unprovenRay(rayOf([[4, -1], [10, 1], [13, -1]], PARITY), down, 0)!, /do not alternate at 4 mm/);
});

test("the ray rule decides on the probe's codes, not on the text of unresolvedReason", () => {
  const down: Vec = [0, 0, -1];
  const hits: Array<[number, number]> = [[5, 1], [10, -1], [20, 1]];
  // Every code the probe exports has a rule; only parity is placed by the crossings.
  assert.deepEqual(Object.keys(UNRESOLVED_CODE_RULE).sort(), [...PROBE_SURFACE_UNRESOLVED_CODES].sort());
  assert.deepEqual(PROBE_SURFACE_UNRESOLVED_CODES.filter((code) => UNRESOLVED_CODE_RULE[code] === "alternation"), ["parity"]);
  // The probe's newer parity texts carry the same code and get the same rule: proven where the crossings alternate
  // through the first crossing past the reach, refused where they do not.
  const texts = [
    probeOddParityReason(3),
    "parity ambiguous on a closed Solid: a crossing is tangent or an edge touch (behind the origin | ahead: none | in out in)",
    "the crossings of this line with a closed Solid do not alternate entry and exit (behind the origin | ahead: out | in out in): at least one crossing is missing, or a tangent touch was counted",
  ];
  for (const unresolvedReason of texts) {
    const ray = rayOf(hits, { unresolvedCrossings: 1, unresolvedReason, unresolvedCode: "parity", unresolvedCodes: ["parity"] });
    assert.equal(unprovenRay(ray, down, 7.05), undefined, unresolvedReason);
    assert.match(unprovenRay(ray, down, Infinity)!, /ends inside the material: a crossing is missing/, unresolvedReason);
  }
  // An even count that fails the whole-line parity check: the alternation still places it, and the words follow the count.
  const even = rayOf([[5, 1], [9, 1], [12, -1], [20, -1]], { unresolvedCrossings: 1, unresolvedReason: texts[2]!, unresolvedCode: "parity", unresolvedCodes: ["parity"] });
  assert.equal(unprovenRay(even, down, 4.9), undefined);
  assert.match(unprovenRay(even, down, 6)!, /it fails the probe's parity check and its crossings do not alternate at 9 mm \(face f1\)/);
  // The same parity text under another code is refused: the code decides. So is every code but parity, with or without parity beside it.
  for (const code of PROBE_SURFACE_UNRESOLVED_CODES.filter((value) => value !== "parity" && value !== "mesh-crossing")) {
    assert.match(unprovenRay(rayOf(hits, { unresolvedCrossings: 1, unresolvedReason: probeOddParityReason(3), unresolvedCode: code, unresolvedCodes: [code] }), down, 7.05)!, new RegExp(`its crossings could not be resolved \\(odd number of crossings .*\\) \\[${code}\\]`), code);
    assert.match(unprovenRay(rayOf(hits, { unresolvedCrossings: 2, unresolvedReason: `${probeOddParityReason(3)}; face f9 is not settled for this ray: x`, unresolvedCode: code, unresolvedCodes: ["parity", code] }), down, 7.05)!, new RegExp(`\\[${code}\\]$`), code);
  }
  // A display-mesh crossing only adds to the count: one more than parity accounts for cannot be placed.
  assert.match(unprovenRay(rayOf(hits, { unresolvedCrossings: 2, unresolvedReason: probeOddParityReason(3), unresolvedCode: "parity", unresolvedCodes: ["parity", "mesh-crossing"] }), down, 7.05)!, /1 of its crossings could not be resolved \(the probe cannot say where\)/);
  // unresolvedCode alone (no list) is read the same way.
  assert.equal(unprovenRay(rayOf(hits, { unresolvedCrossings: 1, unresolvedReason: texts[1]!, unresolvedCode: "parity" }), down, 7.05), undefined);
  // A reason without a code (a record of the older probe) is refused even when its text is the parity text, and so is a code this table does not know.
  assert.match(unprovenRay(rayOf(hits, { unresolvedCrossings: 1, unresolvedReason: probeOddParityReason(3) }), down, 7.05)!, /its crossings could not be resolved \(odd number of crossings .*\) \[the probe gave no code\]/);
  assert.match(unprovenRay(rayOf(hits, { unresolvedCrossings: 1, unresolvedReason: probeOddParityReason(3), unresolvedCodes: ["new-code" as never] }), down, 7.05)!, /\[new-code\]$/);
});

test("a transfer accepts a ray whose only flag is the parity code, whatever its text, and refuses the same ray under another code", async () => {
  const pocket = () => polyBody(2, pocketSpecs());
  // A blind hole 1 mm deep from the pocket floor; ray 3 (bore ring, 90 degrees) carries the flag.
  const blind = { sourceId: 1, targetId: 2, axesMm: AX([30, 20, 50]), hole: { diameterMm: 3, depthMm: 1 }, revision: "r1" };
  const flagged = (flags: Partial<ProbeRayResult>) => flagProbe(polyOps(sourceStub(), pocket()), (index) => (index === 3 ? flags : undefined));
  const text = "the crossings of this line with a closed Solid do not alternate entry and exit (behind the origin | ahead: out | in out): at least one crossing is missing, or a tangent touch was counted";
  // Parity by code: the crossings of that ray alternate (into the floor, out of the bottom), so the cut goes ahead.
  await assert.rejects(transferHoles(flagged({ unresolvedCrossings: 1, unresolvedReason: text, unresolvedCode: "parity", unresolvedCodes: ["parity"] }).operations, blind), /reached the cut/);
  // The same ray and text under a face-not-settled code: refused before the edit.
  const refused = flagged({ unresolvedCrossings: 1, unresolvedReason: text, unresolvedCode: "search-limit", unresolvedCodes: ["search-limit"] });
  await assert.rejects(transferHoles(refused.operations, blind), unprovenRefusal(/the ray at radius 1\.5 mm, 90 degrees is not complete: its crossings could not be resolved \(.*\) \[search-limit\]/));
  assert.deepEqual(refused.calls, []);
});

// The probe of polyOps with flags added to chosen rays of the flat ray list (plus rays first, then minus, per axis).
const flagProbe = (ops: ReturnType<typeof polyOps>, flag: (index: number, ray: ProbeRayResult) => Partial<ProbeRayResult> | undefined) => {
  const plain = ops.operations.probeSurface;
  ops.operations.probeSurface = (async (request: never, revision: string) => { const evidence = await plain(request, revision); return { ...evidence, rays: evidence.rays.map((ray, index) => ({ ...ray, ...(flag(index, ray) ?? {}) })) }; }) as typeof plain;
  return ops;
};
const unprovenRefusal = (pattern: RegExp) => (error: unknown) => error instanceof AxisRefusal && error.code === "unproven" && /axis \d+ \(point [^)]*\): the entry could not be proven: /.test(error.message) && pattern.test(error.message) && /refused before the edit/.test(error.message);

test("T1 guard 3: a flagged ray the bore can reach refuses the cut before the edit and says the entry could not be proven", async () => {
  const pocket = () => polyBody(2, pocketSpecs());
  const through = { sourceId: 1, targetId: 2, axesMm: AX([30, 20, 50]), hole: T3, revision: "r1" };
  // Ø3: 17 rays down (the drill side: 0 the axis, 1-8 the bore ring, 9-16 the clearance ring), then 17 up.
  const unresolved = flagProbe(polyOps(sourceStub(), pocket()), (index) => (index === 3 ? { unresolvedCrossings: 1 } : undefined));
  await assert.rejects(transferHoles(unresolved.operations, through), unprovenRefusal(/the ray at radius 1\.5 mm, 90 degrees is not complete: 1 of its crossings could not be resolved/));
  assert.deepEqual(unresolved.calls, []);
  // On the far side of the reference point too: nothing nearer than the entry may be missed there.
  const behind = flagProbe(polyOps(sourceStub(), pocket()), (index) => (index === 17 ? { unresolvedCrossings: 1 } : undefined));
  await assert.rejects(transferHoles(behind.operations, through), unprovenRefusal(/the axis ray is not complete/));
  // grazing on the clearance ring, 2 mm past the entry (the pocket floor is at z 5): the through bore reaches it.
  const grazing = (ops: ReturnType<typeof polyOps>) => flagProbe(ops, (index) => (index === 9 ? { grazing: [{ faceId: "rib", minDistanceMm: 0.0002, atMm: [31.55, 20, 3] }] } : undefined));
  const grazed = grazing(polyOps(sourceStub(), pocket()));
  await assert.rejects(transferHoles(grazed.operations, through), unprovenRefusal(/the ray at radius 1\.55 mm, 0 degrees \(0\.05 mm outside the bore\) is not complete: it passes 0\.0002 mm from face rib without a crossing/));
  assert.deepEqual(grazed.calls, []);
  // A blind hole 1 mm deep does not reach it (1 mm + 0.05 mm): it is cut.
  const shallow = grazing(polyOps(sourceStub(), pocket()));
  await assert.rejects(transferHoles(shallow.operations, { ...through, hole: { diameterMm: 3, depthMm: 1 } }), /reached the cut/);
  // An axis with no crossing at all is a miss only when its rays are complete: with a flag it is refused, not skipped.
  const L: Vec[] = [[0, 0, 0], [40, 0, 0], [40, 20, 0], [20, 20, 0], [20, 40, 0], [0, 40, 0]];
  const plate = () => polyBody(2, [
    { id: "lt", normal: [0, 0, 1], points: L.map((p): Vec => [p[0], p[1], 5]) }, { id: "lb", normal: [0, 0, -1], points: L },
    ...L.map((p, i) => { const q = L[(i + 1) % L.length]!; return rect(`ls${i}`, unitv([q[1] - p[1], p[0] - q[0], 0]), p, q, [q[0], q[1], 5], [p[0], p[1], 5]); }),
  ]);
  const two = { sourceId: 1, targetId: 2, axesMm: [...AX([10, 10, 30]), ...AX([30, 30, 30])], hole: T3, onMiss: "skip" as const, revision: "r1" };
  await assert.rejects(transferHoles(polyOps(sourceStub(), plate()).operations, two), /reached the cut/, "the plain miss in the notch is skipped");
  const flaggedMiss = flagProbe(polyOps(sourceStub(), plate()), (index) => (index === 34 + 5 ? { unresolvedCrossings: 1 } : undefined));
  await assert.rejects(transferHoles(flaggedMiss.operations, two), unprovenRefusal(/axis 1 .*the ray at radius 1\.5 mm, 180 degrees is not complete/));
  assert.deepEqual(flaggedMiss.calls, []);
});

test("T1 guard 4: the floor rays start in front of each blind floor, one at the centre and one ring half a step off the planning rays", () => {
  const hole = { index: 0, source: { pointMm: [30, 20, 10] as Vec, direction: [0, 0, 1] as Vec, faceIds: [] }, entryPointMm: [30, 20, 0] as Vec, direction: [0, 0, -1] as Vec, entryFaceId: "top", entryProof: "edges" as const, farDistanceMm: 4, agree: true };
  const { rays, leadMm } = floorRays(hole, 2, 2);
  assert.equal(leadMm, 0.25, "half of min(depth, 0.5)");
  assert.equal(rays.length, 9);
  assert.deepEqual(rays[0], { originMm: [30, 20, -1.75], direction: [0, 0, -1] });
  const plan = axisRays(hole.source, [2]).plus.slice(1, 9).map((ray) => Math.atan2(ray.originMm[1] - 20, ray.originMm[0] - 30));
  for (const ray of rays.slice(1)) {
    assert.ok(Math.abs(Math.hypot(ray.originMm[0] - 30, ray.originMm[1] - 20) - (2 - FLOOR_RIM_INSET_MM)) < 1e-12 && ray.originMm[2] === -1.75, "0.01 mm inside the rim, 0.25 mm in front of the floor");
    const angle = Math.atan2(ray.originMm[1] - 20, ray.originMm[0] - 30);
    const nearest = Math.min(...plan.map((other) => Math.abs(Math.atan2(Math.sin(angle - other), Math.cos(angle - other)))));
    assert.ok(Math.abs(nearest - Math.PI / 8) < 1e-9, "22.5 degrees from the nearest planning ray");
  }
  assert.equal(floorRays(hole, 6, 2).rays.length, 17, "16 rim rays above Ø10");
  assert.equal(floorRays(hole, 2, 0.2).leadMm, 0.1);
});

test("T1 guard 4: a blind hole that leaves a 0.02 mm membrane over a cross hole lying between the planning rays is rolled back; 0.1 mm stays", async () => {
  // The review's input, on the plate (z -4..0): Ø4 blind 2 (floor at z -2); a Ø1 cross hole along x, 0.7 mm off the
  // axis, its top 0.02 mm under the floor. No planning ray (y offsets 0, 1.414, 1.45, 2, 2.05) meets it.
  const membrane = async (crossAxisZ: number) => {
    const k = kernel();
    const plate = await blockAndPlate(k, [[22, 12, 0]]);
    k.addPin(plate, { origin: [10, 20.7, crossAxisZ], dir: [1, 0, 0], radius: 0.5, from: 0, to: 40, facing: -1 });
    return { k, plate, before: k.state(), run: () => transferHoles(k.operations, { sourceId: 1, targetId: plate, axesMm: AX([30, 20, 10]), hole: { diameterMm: 4, depthMm: 2 }, revision: k.rev() }) };
  };
  const thin = await membrane(-2.52);
  const plan = await planTransfer(thin.k.operations, thin.before, { sourceId: 1, targetId: thin.plate, axesMm: AX([30, 20, 10]), hole: { diameterMm: 4, depthMm: 2 }, revision: thin.k.rev() });
  assert.deepEqual([plan.holes[0]!.nextFaceMm, plan.holes[0]!.thinWall, plan.holes[0]!.unproven], [4, undefined, undefined], "the plan sees a 4 mm wall and nothing beside the bore");
  await assert.rejects(thin.run(), (error: unknown) => error instanceof GuardedRunError && error.restored && error.undoneSteps === 2
    && /axis 0: the blind hole leaves a membrane thinner than 0\.05 mm under its floor: face \d+:pin0 \(Cylinder\) lies 0\.0238\d* mm behind the floor \(on floor rim ray \d\)/.test(error.message) && /the document is unchanged/.test(error.message));
  assert.equal(thin.k.state().undoDepth, thin.before.undoDepth);
  assert.deepEqual(thin.k.state().bodies.map((body) => body.id), thin.before.bodies.map((body) => body.id));
  assert.deepEqual(thin.k.calls.map((call) => call.op), ["createCylinder", "boolean", "undo", "undo"]);
  const thick = await membrane(-2.6);
  const cut = await thick.run();
  assert.deepEqual([cut.status, cut.holeCount, cut.floorProbe?.rays, cut.floorProbe?.calls], ["completed", 1, 9, 1]);
  // A through hole casts no floor rays.
  const k = kernel();
  const plate = await blockAndPlate(k, [[22, 12, 0]]);
  assert.equal((await transferHoles(k.operations, { sourceId: 1, targetId: plate, axesMm: AX([30, 20, 10]), hole: { diameterMm: 4, through: true }, revision: k.rev() })).floorProbe, undefined);
});

test("T1 guard 4: a floor ray that is not complete, misses the floor or finds nothing behind it does not prove the wall", () => {
  const hole = { index: 0, source: { pointMm: [0, 0, 10] as Vec, direction: [0, 0, -1] as Vec, faceIds: [] }, entryPointMm: [0, 0, 0] as Vec, direction: [0, 0, -1] as Vec, entryFaceId: "top", entryProof: "edges" as const, farDistanceMm: 4, agree: true };
  const body = polyBody(2, [rect("f0", [0, 0, 1], [-3, -3, -2], [3, -3, -2], [3, 3, -2], [-3, 3, -2]), rect("f1", [0, 0, -1], [-3, -3, -4], [-3, 3, -4], [3, 3, -4], [3, -3, -4])]);
  const good = () => rayOf([[0.25, 1], [2.25, -1]]);
  const rays = (special: ProbeRayResult) => [good(), special, ...Array.from({ length: 7 }, good)];
  assert.equal(floorProblem("axis 0", body, hole, 0.25, rays(good())), undefined);
  assert.match(floorProblem("axis 0", body, hole, 0.25, rays(rayOf([[0.25, 1], [0.27, -1]])))!, /axis 0: the blind hole leaves a membrane thinner than 0\.05 mm under its floor: face f1 \(Plane\) lies 0\.02 mm behind the floor \(on floor rim ray 1\)/);
  assert.equal(floorProblem("axis 0", body, hole, 0.25, rays(rayOf([[0.25, 1], [0.3, -1]]))), undefined, "0.05 mm stays");
  assert.match(floorProblem("axis 0", body, hole, 0.25, rays(rayOf([[0.25, 1], [2.25, -1]], { unresolvedCrossings: 1 })))!, /the wall behind the blind floor could not be proven: floor rim ray 1 of 8 is not complete: 1 of its crossings could not be resolved/);
  assert.match(floorProblem("axis 0", body, hole, 0.25, rays(rayOf([[0.25, 1], [2.25, -1]], { grazing: [{ faceId: "x", minDistanceMm: 0.0005, atMm: [0, 0, 9.74] }] })))!, /could not be proven: floor rim ray 1 of 8 is not complete: it passes 0\.0005 mm from face x/);
  assert.match(floorProblem("axis 0", body, hole, 0.25, rays(rayOf([[0.25, 1]])))!, /floor rim ray 1 of 8 finds no face behind the floor/);
  assert.match(floorProblem("axis 0", body, hole, 0.25, rays(rayOf([[0.9, 1], [2.25, -1]])))!, /floor rim ray 1 of 8 does not meet the flat floor 0\.25 mm ahead \(it meets face f0 at 0\.9 mm\)/);
});
