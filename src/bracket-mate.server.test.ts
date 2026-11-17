import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createCompactServer, type SessionLike } from "./server.ts";
import type { PlasticityOperations } from "./plasticity/operations.ts";
import type { RuntimeState } from "./plasticity/runtime.ts";
import { lineBoxSpan, pointInPlanarFace, type Vector3 } from "./plasticity/mate.ts";

// plasticity_create_bracket, plasticity_place_body and plasticity_transfer_holes through the MCP server: registration,
// strict schemas, plasticity_call dispatch and one lean batch chained with $n references, on a small box kernel.

type Vec = Vector3;
type Body = RuntimeState["bodies"][number];
type Face = Body["faces"][number];
type Edge = Body["edges"][number];
interface Hole { origin: Vec; dir: Vec; radius: number; from: number; to: number; blind: boolean }
interface KBody { id: number; type: string; name: string | null; min: Vec; max: Vec; holes: Hole[]; cutter?: { center: Vec; radius: number; height: number; axis: Vec } }
const TOOLS = ["plasticity_create_bracket", "plasticity_place_body", "plasticity_transfer_holes"] as const;

const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
const unitv = (a: Vec): Vec => mul(a, 1 / Math.hypot(...a));
const perp = (d: Vec): Vec => { const h: Vec = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; return unitv([d[1] * h[2] - d[2] * h[1], d[2] * h[0] - d[0] * h[2], d[0] * h[1] - d[1] * h[0]]); };

const dotv = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// An exact ray caster on the read model, the stand-in for plasticity_probe_surface (the same one as mate.test.ts).
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

function boxKernel() {
  let bodies: KBody[] = [];
  let next = 1;
  let rev = 1;
  let undoDepth = 0;
  const history: string[] = [];
  const calls: string[] = [];
  const find = (id: number) => bodies.find((body) => body.id === id)!;
  const faceId = (id: number, k: number, side: number) => `${id}:p${"xyz"[k]}${side > 0 ? "+" : "-"}`;
  function bodyState(body: KBody): Body {
    const faces: Face[] = [];
    const edges: Edge[] = [];
    const byId = new Map<string, Face>();
    for (let k = 0; k < 3; k += 1) for (const side of [-1, 1]) {
      const center: Vec = [(body.min[0] + body.max[0]) / 2, (body.min[1] + body.max[1]) / 2, (body.min[2] + body.max[2]) / 2];
      center[k] = side < 0 ? body.min[k]! : body.max[k]!;
      const normal: Vec = [0, 0, 0]; normal[k] = side;
      const face = { id: faceId(body.id, k, side), surfaceType: "Plane", planar: true, centerMm: center, normal, radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: center, max: center }, edgeIds: [] as string[] } as Face;
      faces.push(face); byId.set(face.id, face);
    }
    for (let k = 0; k < 3; k += 1) {
      const [i, j] = [0, 1, 2].filter((axis) => axis !== k) as [number, number];
      for (const si of [-1, 1]) for (const sj of [-1, 1]) {
        const center: Vec = [0, 0, 0];
        center[k] = (body.min[k]! + body.max[k]!) / 2; center[i] = si < 0 ? body.min[i]! : body.max[i]!; center[j] = sj < 0 ? body.min[j]! : body.max[j]!;
        const tangent: Vec = [0, 0, 0]; tangent[k] = 1;
        const edge = { id: `${body.id}:l${k}${si}${sj}`, curveType: "Line", line: true, circle: false, lengthMm: body.max[k]! - body.min[k]!, centerMm: center, tangent, boundsMm: { min: center, max: center }, faceIds: [faceId(body.id, i, si), faceId(body.id, j, sj)], vertexIds: [] } as Edge;
        edges.push(edge);
        byId.get(faceId(body.id, i, si))!.edgeIds.push(edge.id);
        byId.get(faceId(body.id, j, sj))!.edgeIds.push(edge.id);
      }
    }
    const planeAt = (point: Vec, dir: Vec) => faces.find((face) => Math.abs(Math.abs(face.normal[0] * dir[0] + face.normal[1] * dir[1] + face.normal[2] * dir[2]) - 1) < 1e-12
      && Math.abs((point[0] - face.centerMm[0]) * face.normal[0] + (point[1] - face.centerMm[1]) * face.normal[1] + (point[2] - face.centerMm[2]) * face.normal[2]) < 1e-9);
    body.holes.forEach((hole, n) => {
      const p = perp(hole.dir);
      const id = `${body.id}:h${n}`;
      const floor = hole.blind ? { id: `${body.id}:fl${n}`, surfaceType: "Plane", planar: true, centerMm: add(hole.origin, mul(hole.dir, hole.to)), normal: mul(hole.dir, -1), radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: hole.origin, max: hole.origin }, edgeIds: [] as string[] } as Face : undefined;
      const circle = (s: number, tag: string, other?: Face): Edge => {
        const c = add(hole.origin, mul(hole.dir, s));
        const edge = { id: `${id}${tag}`, curveType: "Circle", line: false, circle: true, lengthMm: 2 * Math.PI * hole.radius, centerMm: add(c, mul(p, hole.radius)), tangent: [0, 0, 1], boundsMm: { min: c, max: c }, faceIds: [id, ...(other ? [other.id] : [])], vertexIds: [],
          circleGeometry: { centerMm: c, radiusMm: hole.radius, normal: hole.dir, reference: p, startMm: add(c, mul(p, hole.radius)), midpointMm: sub(c, mul(p, hole.radius)), endMm: add(c, mul(p, hole.radius)) } } as Edge;
        edges.push(edge); other?.edgeIds.push(edge.id);
        return edge;
      };
      const a = circle(hole.from, "a", planeAt(add(hole.origin, mul(hole.dir, hole.from)), hole.dir));
      const b = circle(hole.to, "b", hole.blind ? floor : planeAt(add(hole.origin, mul(hole.dir, hole.to)), hole.dir));
      faces.push({ id, surfaceType: "Cylinder", planar: false, centerMm: add(add(hole.origin, mul(hole.dir, (hole.from + hole.to) / 2)), mul(p, hole.radius)), normal: mul(p, -1), radiusMm: hole.radius, blendRadiusMm: null, axisOriginMm: add(hole.origin, mul(hole.dir, hole.from)), axisDirection: hole.dir, boundsMm: { min: hole.origin, max: hole.origin }, edgeIds: [a.id, b.id] } as Face);
      if (floor) faces.push(floor);
    });
    return { id: body.id, versionId: body.id, type: body.type, name: body.name, boundsMm: { min: [...body.min], max: [...body.max] }, faceIds: faces.map((face) => face.id), edgeIds: edges.map((edge) => edge.id), faces, edges } as unknown as Body;
  }
  const state = (): RuntimeState => ({
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: `r${rev}`, dbVersion: rev, undoDepth, redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" }, bodies: bodies.map(bodyState),
  } as unknown as RuntimeState);
  const mutate = (op: string, revision: string | undefined, apply: () => void) => {
    calls.push(op);
    if (revision !== undefined && revision !== `r${rev}`) throw new Error(`Stale reference: expected revision ${revision}, current revision is r${rev}`);
    history.push(JSON.stringify({ bodies, next }));
    apply();
    rev += 1; undoDepth += 1;
    return state();
  };
  const operations = {
    async state() { return state(); },
    // The native B-Rep Check (read-only, not recorded in calls): every box-kernel body is a closed, valid Solid.
    async validateBodies(ids: number[], revision: string) {
      return { documentToken: "doc-1", revision, measurementSource: "native-brep", bodies: ids.map((id) => ({ id, versionId: id, type: find(id).type, name: find(id).name, measurementSource: "native-brep", faceCount: 0, edgeCount: 0, boundaryEdgeIds: [], closed: true, nativeCheckCodes: [], nativeValid: true, printableSolid: true })) };
    },
    // The ray probe (read-only, not recorded in calls).
    async probeSurface(request: { id: number; rays?: CastRay[] }, revision: string) {
      const body = state().bodies.find((candidate) => candidate.id === request.id)!;
      return { id: body.id, bodyType: body.type, revision, source: "native-brep-ray-newton", acceptResidualMm: 1e-6, rays: castRays(body, request.rays ?? []), note: "test caster" };
    },
    async undo() { calls.push("undo"); ({ bodies, next } = JSON.parse(history.pop()!)); rev += 1; undoDepth -= 1; return state(); },
    async createBox(origin: Vec, size: Vec, name: string | undefined, revision: string) {
      return mutate("createBox", revision, () => { bodies.push({ id: next++, type: "Solid", name: name ?? null, min: [...origin], max: add(origin, size), holes: [] }); });
    },
    async createCylinder(center: Vec, radius: number, height: number, _name: string | undefined, revision: string, axis: Vec = [0, 0, 1]) {
      return mutate("createCylinder", revision, () => { const d = unitv(axis); const top = add(center, mul(d, height)); bodies.push({ id: next++, type: "Solid", name: null, min: [0, 1, 2].map((i) => Math.min(center[i]!, top[i]!) - radius) as Vec, max: [0, 1, 2].map((i) => Math.max(center[i]!, top[i]!) + radius) as Vec, holes: [], cutter: { center, radius, height, axis: d } }); });
    },
    async boolean(targetIds: number[], toolIds: number[], operation: string, _keep: boolean, revision: string) {
      return mutate("boolean", revision, () => {
        const target = find(targetIds[0]!);
        for (const tool of toolIds.map(find)) {
          if (operation !== "difference" || !tool.cutter) throw new Error("the box kernel only cuts holes");
          const span = lineBoxSpan(tool.cutter.center, tool.cutter.axis, { min: target.min, max: target.max });
          if (!span) continue;
          const from = Math.max(0, span[0]);
          const to = Math.min(tool.cutter.height, span[1]);
          if (to > from) target.holes.push({ origin: tool.cutter.center, dir: tool.cutter.axis, radius: tool.cutter.radius, from, to, blind: to < span[1] - 1e-9 });
        }
        bodies = bodies.filter((body) => !toolIds.includes(body.id));
      });
    },
    async move(ids: number[], delta: Vec, revision: string) {
      return mutate("move", revision, () => { for (const body of ids.map(find)) { body.min = add(body.min, delta); body.max = add(body.max, delta); body.holes.forEach((hole) => { hole.origin = add(hole.origin, delta); }); } });
    },
    async remove(ids: number[], revision: string) { return mutate("remove", revision, () => { bodies = bodies.filter((body) => !ids.includes(body.id)); }); },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state(); }, get() { return operations; },
    capabilities() { return { bindings: [], operations: { constructionPlanes: { available: false, reason: "test" }, activeWorkplane: { available: false, reason: "test" } } }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  return { fake, calls, state };
}

async function connect(fake: SessionLike) {
  const server = createCompactServer(fake, undefined, undefined, undefined, null);
  const client = new Client({ name: "bracket-mate-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const text = (response: unknown): string => (response as { content: Array<{ type: string; text?: string }> }).content.find((entry) => entry.type === "text")!.text!;
const json = (response: unknown): any => JSON.parse(text(response));
const FLAT = { originMm: [100, 0, 0], profile: "flat", widthMm: 30, thicknessMm: 4, legs: { lengthMm: 40 }, name: "plate" };

test("the three tools are registered once, listed in the compact catalog, strict, and described in 600 characters or fewer", async () => {
  const kernel = boxKernel();
  const { client, close } = await connect(kernel.fake);
  const listed = (await client.listTools()).tools;
  for (const name of TOOLS) {
    assert.equal(listed.filter((tool) => tool.name === name).length, 1, `${name} once in the compact list`);
    const description = listed.find((tool) => tool.name === name)!.description!;
    assert.ok(description.length <= 600, `${name}: ${description.length} characters`);
    const catalog = json(await client.callTool({ name: "plasticity_call", arguments: { toolName: "catalog", query: name } }));
    assert.equal(catalog.total, 1);
    assert.equal(catalog.tools[0].name, name);
    assert.equal(typeof catalog.tools[0].inputSchema, "object");
  }
  const strict = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: { revision: "r1", ...args, notAField: 1 } });
    assert.equal(response.isError, true, `${name} refuses an unknown key`);
    assert.match(text(response), /notAField|Unrecognized key/);
  };
  await strict("plasticity_create_bracket", FLAT);
  await strict("plasticity_place_body", { id: 1, anchor: { point: "min" }, to: { bodyId: 2, point: "max" } });
  await strict("plasticity_transfer_holes", { sourceId: 1, targetId: 2, select: { radiusMm: 1 }, hole: { diameterMm: 2, through: true } });
  assert.deepEqual(kernel.calls, [], "no native call for a refused input");
  await close();
});

test("schema rules: legs follow the profile, an anchor has exactly one of point or faceId, transfer has exactly one of select or axesMm", async () => {
  const kernel = boxKernel();
  const { client, close } = await connect(kernel.fake);
  const refused = async (name: string, args: Record<string, unknown>, pattern: RegExp) => {
    const response = await client.callTool({ name: "plasticity_call", arguments: { toolName: name, arguments: { revision: "r1", ...args } } });
    assert.equal(response.isError, true, JSON.stringify(args));
    assert.match(text(response), pattern);
  };
  await refused("plasticity_create_bracket", { ...FLAT, legs: { baseMm: 40, uprightMm: 40 } }, /lengthMm|Unrecognized key/);
  await refused("plasticity_create_bracket", { ...FLAT, profile: "flat", gussets: { count: 1, thicknessMm: 3, sizeMm: 10 } }, /gussets|Unrecognized key/);
  await refused("plasticity_place_body", { id: 1, anchor: { point: "min", faceId: "f" }, to: { bodyId: 2, point: "max" } }, /exactly one of point or faceId/);
  await refused("plasticity_place_body", { id: 1, anchor: {}, to: { bodyId: 2, point: "max" } }, /exactly one of point or faceId/);
  await refused("plasticity_transfer_holes", { sourceId: 1, targetId: 2, hole: { diameterMm: 2, through: true } }, /exactly one of select or axesMm/);
  await refused("plasticity_transfer_holes", { sourceId: 1, targetId: 2, select: { radiusMm: 1 }, hole: { diameterMm: 2 } }, /exactly one of depthMm or through/);
  assert.deepEqual(kernel.calls, []);
  await close();
});

test("plasticity_call dispatches create_bracket with its own schema and the reply carries bodyId, derived and faceIds", async () => {
  const kernel = boxKernel();
  const { client, close } = await connect(kernel.fake);
  const response = await client.callTool({ name: "plasticity_call", arguments: { toolName: "plasticity_create_bracket", arguments: { ...FLAT, revision: "r1" } } });
  assert.equal(response.isError, undefined, text(response));
  const reply = json(response);
  assert.equal(reply.recipe, "bracket");
  assert.equal(reply.bodyId, 1);
  assert.deepEqual(reply.derived.boundsMm, { min: [100, 0, 0], max: [140, 30, 4] });
  assert.deepEqual(reply.faceIds, { flat: { outerFaceId: "1:pz-", innerFaceId: "1:pz+" } });
  assert.equal(reply.undoSteps, 1);
  await close();
});

test("plasticity_call dispatches place_body and transfer_holes with their own schemas", async () => {
  const kernel = boxKernel();
  const { client, close } = await connect(kernel.fake);
  const call = async (toolName: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name: "plasticity_call", arguments: { toolName, arguments: { ...args, revision: kernel.state().revision } } });
    assert.equal(response.isError, undefined, text(response));
    return json(response);
  };
  await call("plasticity_create_box", { originMm: [0, 0, 0], sizeMm: [60, 40, 20], name: "block" });
  await call("plasticity_create_blind_hole_pattern", { targetId: 1, entryCentersMm: [[22, 12, 0], [38, 28, 0]], axis: [0, 0, 1], holeDiameterMm: 3, holeDepthMm: 8, materialDepthMm: 20, overshootMm: 0.5 });
  const bracket = await call("plasticity_create_bracket", FLAT);
  const place = await call("plasticity_place_body", { id: bracket.bodyId, anchor: { point: "top-center" }, to: { bodyId: 1, point: "bottom-center" } });
  assert.deepEqual([place.recipe, place.deltaMm, place.boundsMm, place.undoSteps], ["place-body", [-90, 5, -4], { min: [10, 5, -4], max: [50, 35, 0] }, 1]);
  const transfer = await call("plasticity_transfer_holes", { sourceId: 1, targetId: bracket.bodyId, select: { radiusMm: 1.5, kind: "hole" }, hole: { diameterMm: 3.4, through: true } });
  assert.deepEqual([transfer.recipe, transfer.targetHoleCount, transfer.maxCoaxialOffsetMm, transfer.undoSteps], ["transfer-holes", 2, 0, 3]);
  await close();
});

test("one lean batch: block with pilots, a bracket, place_body with $2.result.bodyId, transfer_holes into it", async () => {
  const kernel = boxKernel();
  const { client, close } = await connect(kernel.fake);
  const pilots = [[22, 12, 0], [38, 12, 0], [22, 28, 0], [38, 28, 0]];
  const steps = [
    { toolName: "plasticity_create_box", arguments: { originMm: [0, 0, 0], sizeMm: [60, 40, 20], name: "block" } },
    { toolName: "plasticity_create_blind_hole_pattern", arguments: { targetId: "$0.added[0]", entryCentersMm: pilots, axis: [0, 0, 1], holeDiameterMm: 3, holeDepthMm: 8, materialDepthMm: 20, overshootMm: 0.5 } },
    { toolName: "plasticity_create_bracket", arguments: FLAT },
    { toolName: "plasticity_find_faces", arguments: { query: { bodyIds: ["$0.added[0]"], planar: true, normal: { vector: [0, 0, -1], toleranceDeg: 0.001 }, center: { pointMm: [30, 20, 0], toleranceMm: 0.001 } }, limit: 1000 }, return: ["matches[*].id"] },
    { toolName: "plasticity_place_body", arguments: { id: "$2.result.bodyId", anchor: { faceId: "$2.result.faceIds.flat.innerFaceId" }, to: { bodyId: "$0.added[0]", faceId: "$3.result.matches[0].id" }, gapMm: 0 }, return: ["relation", "deltaMm", "boundsMm"] },
    { toolName: "plasticity_transfer_holes", arguments: { sourceId: "$0.added[0]", targetId: "$2.result.bodyId", select: { radiusMm: 1.5, axis: "z", kind: "hole" }, hole: { diameterMm: 3.4, through: true } }, return: ["targetHoleCount", "maxCoaxialOffsetMm", "axesMm[*].entryPointMm"] },
  ];
  const response = await client.callTool({ name: "plasticity_batch", arguments: { detail: "lean", steps } });
  assert.equal(response.isError, undefined, text(response));
  const out = json(response);
  assert.deepEqual(out.steps[2].result, { status: "completed", omitted: ["recipe", "beforeRevision", "afterRevision", "bodyId", "name", "profile", "derived", "faceIds", "undoSteps", "steps"] }, "a lean recipe step shows its status");
  assert.deepEqual(out.steps[4].result, { relation: "mating", deltaMm: [-90, 5, -4], boundsMm: { min: [10, 5, -4], max: [50, 35, 0] } });
  assert.deepEqual(out.steps[5].result, { targetHoleCount: 4, maxCoaxialOffsetMm: 0, "axesMm[*].entryPointMm": [[22, 12, 0], [38, 12, 0], [22, 28, 0], [38, 28, 0]] });
  assert.equal(out.summary.undoSteps, 1 + 5 + 1 + 1 + 5, "box, pilot pattern (4 cutters + boolean), bracket box, move, through pattern (4 + 1)");
  await close();
});

test("derived.holeAxesMm items pass as transfer axesMm as they are, and an axis that misses the target is refused by name", async () => {
  const kernel = boxKernel();
  const { client, close } = await connect(kernel.fake);
  const steps = [
    { toolName: "plasticity_create_bracket", arguments: { ...FLAT, originMm: [0, 0, 10], holes: [{ leg: "flat", diameterMm: 4, count: 2, layout: "line-across", marginMm: 8 }] } },
    { toolName: "plasticity_create_box", arguments: { originMm: [-5, -5, 4], sizeMm: [50, 40, 6], name: "plate" } },
    { toolName: "plasticity_transfer_holes", arguments: { sourceId: "$0.result.bodyId", targetId: "$1.added[0]", axesMm: "$0.result.derived.holeAxesMm", hole: { diameterMm: 3, depthMm: 2 } }, return: ["targetHoleCount", "axesMm[*].entryPointMm", "axesMm[*].axis"] },
  ];
  const response = await client.callTool({ name: "plasticity_batch", arguments: { detail: "lean", steps } });
  assert.equal(response.isError, undefined, text(response));
  const out = json(response);
  assert.deepEqual(out.steps[2].result, { targetHoleCount: 2, "axesMm[*].entryPointMm": [[20, 8, 10], [20, 22, 10]], "axesMm[*].axis": [[0, 0, -1], [0, 0, -1]] }, "the plate touches the bracket's outer face: the entry is that plane");
  const plateId = out.steps[1].added[0];
  const miss = await client.callTool({ name: "plasticity_transfer_holes", arguments: { sourceId: 1, targetId: plateId, axesMm: [{ pointMm: [500, 0, 0], axis: [0, 0, 1] }], hole: { diameterMm: 3, through: true }, revision: kernel.state().revision } });
  assert.equal(miss.isError, true);
  assert.match(text(miss), new RegExp(`axis 0 \\(point \\[500,0,0\\], direction \\[0,0,1\\]\\) misses the target body ${plateId}`));
  await close();
});

test("review fixes through the server: kind, onMiss, relation and allowOverlap are in the schemas; replies carry axisCount, holeCount and kind", async () => {
  const kernel = boxKernel();
  const { client, close } = await connect(kernel.fake);
  const call = async (toolName: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name: "plasticity_call", arguments: { toolName, arguments: { ...args, revision: kernel.state().revision } } });
    return { isError: response.isError === true, text: text(response) };
  };
  await call("plasticity_create_box", { originMm: [0, 0, 0], sizeMm: [60, 40, 20], name: "block" });
  await call("plasticity_create_blind_hole_pattern", { targetId: 1, entryCentersMm: [[22, 12, 0], [38, 28, 0]], axis: [0, 0, 1], holeDiameterMm: 3, holeDepthMm: 8, materialDepthMm: 20, overshootMm: 0.5 });
  const plate = JSON.parse((await call("plasticity_create_box", { originMm: [10, 5, -4], sizeMm: [40, 30, 4], name: "plate" })).text).change.added[0].id;
  const refused = await call("plasticity_place_body", { id: plate, anchor: { faceId: `${plate}:pz-` }, to: { bodyId: 1, faceId: "1:pz-" } });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /face the same way.*relation: "aligned"/);
  const overlap = await call("plasticity_place_body", { id: plate, anchor: { faceId: `${plate}:pz+` }, to: { bodyId: 1, faceId: "1:pz-" }, gapMm: -1 });
  assert.match(overlap.text, /allowOverlap: true/);
  assert.equal((await call("plasticity_place_body", { id: plate, anchor: { point: "min" }, to: { bodyId: 1, point: "max" }, relation: "parallel" })).isError, true, "relation takes mating or aligned only");
  const transfer = await call("plasticity_transfer_holes", { sourceId: 1, targetId: plate, select: { radiusMm: 1.5, kind: "any" }, axesMm: undefined, hole: { diameterMm: 3.4, through: true }, onMiss: "skip" });
  assert.equal(transfer.isError, false, transfer.text);
  const reply = JSON.parse(transfer.text);
  assert.deepEqual([reply.axisCount, reply.holeCount, reply.targetHoleCount, reply.axesMm.map((axis: { kind: string }) => axis.kind)], [2, 2, 2, ["hole", "hole"]]);
  assert.equal(kernel.calls.filter((name) => name === "undo").length, 0);
  await close();
});

test("final review T1 through the server: a rim within 0.05 mm of the plate edge is refused with the revision unchanged; a blind hole reports its floor rays", async () => {
  const kernel = boxKernel();
  const { client, close } = await connect(kernel.fake);
  const description = (await client.listTools()).tools.find((tool) => tool.name === "plasticity_transfer_holes")!.description!;
  assert.match(description, /walls under 0\.05 mm beside the bore or under a blind floor/);
  const call = async (toolName: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name: "plasticity_call", arguments: { toolName, arguments: { ...args, revision: kernel.state().revision } } });
    return { isError: response.isError === true, text: text(response) };
  };
  await call("plasticity_create_box", { originMm: [0, 0, 0], sizeMm: [5, 5, 5], name: "source" });
  const plate = JSON.parse((await call("plasticity_create_box", { originMm: [10, 5, -4], sizeMm: [40, 30, 4], name: "plate" })).text).change.added[0].id;
  const before = kernel.state();
  const mutations = kernel.calls.length;
  // Ø3 with its axis 1.52 mm from the plate's x- side: the rim is 0.02 mm inside the top face, the clearance ring leaves it.
  const thin = await call("plasticity_transfer_holes", { sourceId: 1, targetId: plate, axesMm: [{ pointMm: [11.52, 20, 30], axis: [0, 0, -1] }], hole: { diameterMm: 3, through: true } });
  assert.equal(thin.isError, true);
  assert.match(thin.text, /axis 0 \(point \[11\.52,20,30\], direction \[0,0,-1\]\): the hole leaves a wall thinner than 0\.05 mm beside the bore: the ray at radius 1\.55 mm, \d+ degrees \(0\.05 mm outside the bore\) meets no further face where the ray on the bore radius meets face \d+:pz\+ \(Plane\) 0 mm from the entry plane/);
  assert.equal(kernel.state().revision, before.revision, "refused before the edit: the revision did not move");
  assert.equal(kernel.calls.length, mutations, "no native mutation");
  // 0.06 mm of wall is cut, and a blind hole comes back with the floor rays it cast.
  const cut = await call("plasticity_transfer_holes", { sourceId: 1, targetId: plate, axesMm: [{ pointMm: [11.56, 20, 30], axis: [0, 0, -1] }], hole: { diameterMm: 3, through: true } });
  assert.equal(cut.isError, false, cut.text);
  const blind = await call("plasticity_transfer_holes", { sourceId: 1, targetId: JSON.parse(cut.text).targetId, axesMm: [{ pointMm: [30, 20, 30], axis: [0, 0, -1] }], hole: { diameterMm: 3, depthMm: 2 } });
  assert.equal(blind.isError, false, blind.text);
  const reply = JSON.parse(blind.text);
  assert.deepEqual([reply.holeCount, reply.probe.rays, reply.floorProbe.rays, reply.floorProbe.calls], [1, 34, 9, 1]);
  await close();
});
