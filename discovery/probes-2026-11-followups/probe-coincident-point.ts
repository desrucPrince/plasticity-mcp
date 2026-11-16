// Live question (re-review of 61b054e, Part 2 item 11): two BSurf faces of one Sheet share an edge, so each shows a
// control point at the same position on that edge. Move ONE of the two coincident points: does the other follow,
// and does the body stay valid (kernel Check codes, face and edge counts, sheet count)? A second trial moves both
// points together. Every step is undone. Run from this directory with env.sh sourced: node probe-coincident-point.ts
import { connect, nativeFunction, save } from "./harness.ts";
import { call, startMcp, status, undoTo } from "./mcp.ts";

const runtime = await connect();
const client = await startMcp();
const start = await status(client);
const out: Record<string, unknown> = { start: { undo: start.undoDepth, bodies: start.bodies.length } };

const CHECK = nativeFunction`function (args) {
  let item = null;
  for (const [versionId, candidate] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(versionId) === args.bodyId) item = candidate;
  if (!item) return { exists: false };
  const model = item.model;
  const faces = model.GetFaces(), edges = model.GetEdges?.();
  const cvs = Array.from(item.view.high?.cvs ?? []).map(cv => [cv.position.x * 1000, cv.position.y * 1000, cv.position.z * 1000].map(v => Math.round(v * 1000) / 1000));
  const grids = [];
  for (let index = 0; index < faces.Size(); index += 1) {
    const face = faces.Get(index);
    let info = null;
    try { const surface = face.GetSurface()?.surface; info = surface?.constructor?.name === 'BSurf' ? surface.GetInfo() : null; } catch (error) { info = { error: String(error?.message ?? error) }; }
    const stride = info?.vertices ? info.vertices.length / (info.uVertices * info.vVertices) : null;
    grids.push({ entity: face.Id(), u: info?.uVertices ?? null, v: info?.vVertices ?? null, stride, vertices: info?.vertices ? Array.from({ length: info.uVertices * info.vVertices }, (_, i) => [0, 1, 2].map(axis => Math.round(info.vertices[i * stride + axis] * 1e6) / 1000)) : null, error: info?.error ?? null });
  }
  return { exists: true, type: item.view.constructor.name, checkCodes: Array.from(model.Check(), Number), faceCount: faces.Size(), edgeCount: edges?.Size?.() ?? null, cvs, grids, faceViews: Array.from(item.view.high.faces.versionIds) };
}`;

const add = async (tool: string, args: Record<string, unknown>) => {
  const before = await status(client);
  await call(client, tool, { ...args, revision: before.revision });
  const after = await status(client);
  return after.bodies.filter((body: any) => !before.bodies.some((old: any) => old.id === body.id));
};
const same = (a: number[], b: number[]) => a.every((value, axis) => Math.abs(value - b[axis]!) < 1e-6);

try {
  const [arcA] = await add("plasticity_create_nurbs_curve", { pointsMm: [[2900, 0, 0], [2910, 0, 8], [2920, 0, 0]] });
  const [arcB] = await add("plasticity_create_nurbs_curve", { pointsMm: [[2920, 0, 0], [2930, 0, 8], [2940, 0, 0]] });
  const sheetA = (await add("plasticity_extrude_curves", { ids: [arcA.id], distanceMm: 20, direction: [0, 1, 0] })).find((body: any) => body.type === "Sheet");
  const sheetB = (await add("plasticity_extrude_curves", { ids: [arcB.id], distanceMm: 20, direction: [0, 1, 0] })).find((body: any) => body.type === "Sheet");
  await add("plasticity_join_sheets", { ids: [sheetA.id, sheetB.id] });
  const two = (await status(client)).bodies.find((body: any) => body.type === "Sheet" && body.faceCount === 2 && body.boundsMm.min[0] > 2890 && body.boundsMm.max[0] < 2950);
  const faces = (await call(client, "plasticity_body_info", { id: two.id })).body.faces as any[];
  const faceA = faces.find((face) => face.centerMm[0] < 2920).id;
  const faceB = faces.find((face) => face.centerMm[0] > 2920).id;
  const shown = await call(client, "plasticity_show_face_control_points", { bodyId: two.id, faceIds: [faceA, faceB], revision: (await status(client)).revision });
  const points = shown.controlPoints as Array<{ cvId: string; faceId: string; index: number; positionMm: number[] }>;
  const [newA, newB] = shown.faces.map((face: any) => face.faceId);
  const pairs = points.filter((p) => p.faceId === newA).flatMap((p) => points.filter((q) => q.faceId === newB && same(p.positionMm, q.positionMm)).map((q) => [p, q]));
  out.coincidentPairs = pairs.map(([p, q]) => ({ a: p, b: q }));
  out.beforeMove = await runtime.read(CHECK, [{ bodyId: two.id }]);
  const checkpoint = (await status(client)).undoDepth;
  const [a0, b0] = pairs[0]!;
  // Trial 1: move only A's coincident point.
  let single: any;
  try {
    single = await call(client, "plasticity_move_face_control_points", { bodyId: two.id, cvIds: [a0.cvId], deltaMm: [0, 0, 5], revision: (await status(client)).revision });
  } catch (error) { single = { error: (error as Error).message.slice(0, 1500) }; }
  const afterSingle = await status(client);
  const nativeSingle: any = await runtime.read(CHECK, [{ bodyId: two.id }]);
  out.moveOne = {
    result: single, undoDelta: afterSingle.undoDepth - checkpoint, native: nativeSingle,
    bodies: afterSingle.bodies.filter((body: any) => body.boundsMm && body.boundsMm.min[0] > 2890 && body.boundsMm.max[0] < 2950).map((body: any) => ({ id: body.id, type: body.type, faces: body.faceCount, bounds: body.boundsMm })),
    // Did B's coincident point follow? B's point sat at b0.positionMm before the move.
    bPointStillAtOld: nativeSingle.cvs?.some((cv: number[]) => same(cv, b0.positionMm)) ?? null,
    pointsAtNew: nativeSingle.cvs?.filter((cv: number[]) => same(cv, [b0.positionMm[0]!, b0.positionMm[1]!, b0.positionMm[2]! + 5])).length ?? null,
  };
  console.error("moveOne", JSON.stringify({ undo: (out.moveOne as any).undoDelta, check: nativeSingle.checkCodes, faces: nativeSingle.faceCount, edges: nativeSingle.edgeCount, bStill: (out.moveOne as any).bPointStillAtOld, atNew: (out.moveOne as any).pointsAtNew, error: single.error }));
  await undoTo(client, checkpoint);
  // Trial 2: move both coincident points together.
  let both: any;
  try {
    both = await call(client, "plasticity_move_face_control_points", { bodyId: two.id, cvIds: [a0.cvId, b0.cvId], deltaMm: [0, 0, 5], revision: (await status(client)).revision });
  } catch (error) { both = { error: (error as Error).message.slice(0, 1500) }; }
  const nativeBoth: any = await runtime.read(CHECK, [{ bodyId: two.id }]);
  out.moveBoth = { result: both, undoDelta: (await status(client)).undoDepth - checkpoint, native: nativeBoth, pointsAtNew: nativeBoth.cvs?.filter((cv: number[]) => same(cv, [b0.positionMm[0]!, b0.positionMm[1]!, b0.positionMm[2]! + 5])).length ?? null };
  console.error("moveBoth", JSON.stringify({ check: nativeBoth.checkCodes, faces: nativeBoth.faceCount, edges: nativeBoth.edgeCount, atNew: (out.moveBoth as any).pointsAtNew, error: both.error }));
  await undoTo(client, checkpoint);
} catch (error) { out.failure = (error as Error).message; console.error("ERROR", (error as Error).message); }
finally {
  await undoTo(client, start.undoDepth);
  const end = await status(client);
  out.end = { undo: end.undoDepth, bodies: end.bodies.length };
  console.error("restored", out.start, out.end);
  save("probe-coincident-point.json", out);
  await client.close(); runtime.close(); process.exit(0);
}
