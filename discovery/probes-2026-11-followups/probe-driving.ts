// Driving-distance follow-up probes (review of aff5fb3): equal distance, which input decides the moving face,
// a washer face midpoint, and a same-direction (stepped) face pair. Isolated instance 127.0.0.1:58932 only.
// Every case is undone; the script ends at the starting Undo depth and body count.
import { readFileSync } from "node:fs";
import { connect, HERE, nativeFunction, save } from "./harness.ts";
import { call, startMcp, status, undoTo } from "./mcp.ts";
import { join } from "node:path";

const runtime = await connect();
const client = await startMcp();
const out: Record<string, unknown> = {};
const ddc = readFileSync(join(HERE, "js", "driving-distance.js"), "utf8");
const start = await status(client);
out.start = { undoDepth: start.undoDepth, bodies: start.bodies.length };

const info = async (id: number) => (await call(client, "plasticity_body_info", { id })).body;
const add = async (tool: string, args: Record<string, unknown>) => {
  const before = await status(client);
  await call(client, tool, { ...args, revision: before.revision });
  const after = await status(client);
  return after.bodies.filter((body: any) => !before.bodies.some((old: any) => old.id === body.id));
};
const faceBy = (body: any, predicate: (face: any) => boolean, label: string) => {
  const matches = body.faces.filter(predicate);
  if (matches.length !== 1) throw new Error(`${label}: ${matches.length} matches`);
  return matches[0];
};
const planes = (body: any) => body.faces.filter((face: any) => face.planar).map((face: any) => ({ id: face.id, normal: face.normal.map((v: number) => Math.round(v * 1e6) / 1e6), centerMm: face.centerMm }));

async function run(label: string, bodyId: number, faces: string[], hit: { face: string; point: number[]; normal: number[] } | null, distanceM: number) {
  const before = await status(client);
  const facesBefore = planes(await info(bodyId));
  let native: any;
  try {
    native = await runtime.mutate<any>(nativeFunction([ddc] as any), ["DimensionDistanceCommand", "DimensionDistanceSpaceDialog"], [{ bodyId, faces, hit, mode: "factory", distanceM, dialogTimeoutMs: 2000, finishTimeoutMs: 4000 }], 20000);
  } catch (error) { native = { thrown: (error as Error).message.slice(0, 1000) }; }
  const after = await status(client);
  const body = after.bodies.find((candidate: any) => candidate.id === bodyId);
  const facesAfter = body ? planes(await info(bodyId)) : null;
  const record = { faces, hit, distanceM, undo: [before.undoDepth, after.undoDepth], bounds: [before.bodies.find((b: any) => b.id === bodyId)?.boundsMm, body?.boundsMm], facesBefore, facesAfter, native: { factoryAtDialog: native.factoryAtDialog, end: native.end, timeline: native.timeline, thrown: native.thrown } };
  out[label] = record;
  console.error(label, JSON.stringify({ undo: record.undo, end: native.end, dialog: native.factoryAtDialog, bounds: record.bounds }));
  await undoTo(client, before.undoDepth);
  return record;
}

try {
  // ---- box 20 x 10 x 5 at x 2400
  const [box] = await add("plasticity_create_box", { originMm: [2400, 0, 0], sizeMm: [20, 10, 5] });
  const boxInfo = await info(box.id);
  const px = faceBy(boxInfo, (face) => face.normal[0] > 0.999, "+x");
  const nx = faceBy(boxInfo, (face) => face.normal[0] < -0.999, "-x");
  const pz = faceBy(boxInfo, (face) => face.normal[2] > 0.999, "+z");
  const m = (v: number[]) => v.map((x) => x / 1000);
  // Equal distance, single face mode and pair mode.
  await run("equal_single_face_pz_5mm", box.id, [pz.id], { face: pz.id, point: m(pz.centerMm), normal: pz.normal }, 0.005);
  await run("equal_pair_px_ref_nx_20mm", box.id, [nx.id, px.id], { face: px.id, point: m(px.centerMm), normal: px.normal }, 0.02);
  // Which input decides: selection order [nx, px] (px last) but hit on nx.
  await run("order_px_last_hit_on_nx", box.id, [nx.id, px.id], { face: nx.id, point: m(nx.centerMm), normal: nx.normal }, 0.03);
  // Selection order [px, nx] (nx last), hit on px.
  await run("order_nx_last_hit_on_px", box.id, [px.id, nx.id], { face: px.id, point: m(px.centerMm), normal: px.normal }, 0.03);

  // ---- washer: 40 x 40 x 5 plate with a centred through hole r 8
  const [plate] = await add("plasticity_create_box", { originMm: [2500, 0, 0], sizeMm: [40, 40, 5] });
  const [hole] = await add("plasticity_create_cylinder", { centerMm: [2520, 20, -1], radiusMm: 8, heightMm: 7 });
  {
    const current = await status(client);
    await call(client, "plasticity_boolean", { targetIds: [plate.id], toolIds: [hole.id], operation: "difference", revision: current.revision });
  }
  const washer = await info(plate.id);
  const top = faceBy(washer, (face) => face.planar && face.normal[2] > 0.999, "washer top");
  out.washer_top_face = { centerMm: top.centerMm, boundsMm: top.boundsMm, edgeIds: top.edgeIds };
  const distFromAxis = Math.hypot(top.centerMm[0] - 2520, top.centerMm[1] - 20);
  console.error("washer top FindMidpoint", top.centerMm, "distance from hole axis", distFromAxis);
  out.washer_midpoint_radius_mm = distFromAxis;
  await run("washer_single_face_top_hit_at_midpoint", plate.id, [top.id], { face: top.id, point: m(top.centerMm), normal: top.normal }, 0.008);
  // Also with a hit at the geometric centre, inside the hole (off the face).
  await run("washer_single_face_top_hit_in_hole", plate.id, [top.id], { face: top.id, point: m([2520, 20, 5]), normal: top.normal }, 0.008);

  // ---- stepped block: 20 x 10 x 10 union 20 x 10 x 5 next to it, two +z faces at z 10 and z 5
  const [high] = await add("plasticity_create_box", { originMm: [2600, 0, 0], sizeMm: [20, 10, 10] });
  const [low] = await add("plasticity_create_box", { originMm: [2620, 0, 0], sizeMm: [20, 10, 5] });
  {
    const current = await status(client);
    await call(client, "plasticity_boolean", { targetIds: [high.id], toolIds: [low.id], operation: "union", revision: current.revision });
  }
  const stepped = await info(high.id);
  const tops = stepped.faces.filter((face: any) => face.planar && face.normal[2] > 0.999);
  out.stepped_tops = tops.map((face: any) => ({ id: face.id, centerMm: face.centerMm }));
  const upper = tops.find((face: any) => face.centerMm[2] > 9);
  const lower = tops.find((face: any) => face.centerMm[2] < 6);
  await run("stepped_same_direction_ref_lower_moving_upper_8mm", high.id, [lower.id, upper.id], { face: upper.id, point: m(upper.centerMm), normal: upper.normal }, 0.008);
} catch (error) {
  out.failure = (error as Error).message;
  console.error("FAILED", (error as Error).message);
} finally {
  await undoTo(client, start.undoDepth);
  const end = await status(client);
  out.end = { undoDepth: end.undoDepth, bodies: end.bodies.length };
  console.error("restored", out.start, out.end);
  save("probe-driving.json", out);
  await client.close();
  runtime.close();
  process.exit(0);
}
