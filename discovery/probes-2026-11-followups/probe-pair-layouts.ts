// Live check of other driving-distance pair layouts (re-review of 61b054e, Part 1 item 4), through the operations
// layer: (a) slot walls that face each other, (b) a stepped pair with the UPPER face as reference and the lower face
// moving, (c) single-face mode on the flat face of a half cylinder (the surface behind the hit is a cylinder, not a
// parallel plane). Records the tool result or error, the planes before and after, and the Undo delta; undoes every
// case. Run from this directory with env.sh sourced: node probe-pair-layouts.ts [outName]
import { connect, save } from "./harness.ts";
import { call, startMcp, status, undoTo } from "./mcp.ts";
import { PlasticityOperations } from "../../src/plasticity/operations.ts";

const runtime = await connect();
const client = await startMcp();
const start = await status(client);
const out: Record<string, unknown> = { start: { undo: start.undoDepth, bodies: start.bodies.length } };
const info = async (id: number) => (await call(client, "plasticity_body_info", { id })).body;
const add = async (tool: string, args: Record<string, unknown>) => {
  const before = await status(client);
  await call(client, tool, { ...args, revision: before.revision });
  const after = await status(client);
  return after.bodies.filter((body: any) => !before.bodies.some((old: any) => old.id === body.id));
};
const planes = (body: any) => body.faces.filter((face: any) => face.planar).map((face: any) => ({ id: face.id, normal: face.normal.map((v: number) => Math.round(v * 1e6) / 1e6), centerMm: face.centerMm.map((v: number) => Math.round(v * 1e6) / 1e6) }));
const one = (body: any, predicate: (face: any) => boolean, label: string) => {
  const matches = body.faces.filter(predicate);
  if (matches.length !== 1) throw new Error(`${label}: ${matches.length} matches`);
  return matches[0];
};

async function run(label: string, bodyId: number, input: { movingFaceId: string; referenceFaceId?: string; distanceMm: number }) {
  const before = await status(client);
  const facesBefore = planes(await info(bodyId));
  const operations = new PlasticityOperations(runtime);
  let result: any, error: string | null = null;
  try {
    const { state: _state, ...rest } = await operations.setDrivingDistance({ bodyId, ...input }, before.revision);
    result = rest;
  } catch (thrown) { error = (thrown as Error).message.slice(0, 1500); }
  const after = await status(client);
  const body = after.bodies.find((candidate: any) => candidate.id === bodyId);
  const record = { input, result, error, uncertain: runtime.isUncertain(), undo: [before.undoDepth, after.undoDepth], bounds: [before.bodies.find((b: any) => b.id === bodyId)?.boundsMm, body?.boundsMm], facesBefore, facesAfter: body ? planes(await info(bodyId)) : null };
  out[label] = record;
  console.error(label, JSON.stringify({ undo: record.undo, error, result: result && { previous: result.previousDistanceMm, offset: result.planeOffsetMm, moved: result.movedFaceId, changed: result.changed }, bounds: record.bounds[1] }));
  if (runtime.isUncertain()) await runtime.reconcile();
  await undoTo(client, before.undoDepth);
  return record;
}

try {
  // (a) slot: 40 x 20 x 10 block at x 2400 minus a 10 mm wide slot (x 2415..2425) 5 mm deep from the top.
  {
    const [block] = await add("plasticity_create_box", { originMm: [2400, 0, 0], sizeMm: [40, 20, 10] });
    const [cutter] = await add("plasticity_create_box", { originMm: [2415, -1, 5], sizeMm: [10, 22, 6] });
    const cur = await status(client);
    await call(client, "plasticity_boolean", { targetIds: [block.id], toolIds: [cutter.id], operation: "difference", revision: cur.revision });
    const body = await info(block.id);
    const left = one(body, (f) => f.planar && f.normal[0] > 0.999 && Math.abs(f.centerMm[0] - 2415) < 1e-6, "slot wall x2415 (+x)");
    const right = one(body, (f) => f.planar && f.normal[0] < -0.999 && Math.abs(f.centerMm[0] - 2425) < 1e-6, "slot wall x2425 (-x)");
    out.slot_faces = { left: left.id, right: right.id };
    await run("slot_width_right_moves_10_to_14", block.id, { movingFaceId: right.id, referenceFaceId: left.id, distanceMm: 14 });
    await run("slot_width_right_moves_10_to_6", block.id, { movingFaceId: right.id, referenceFaceId: left.id, distanceMm: 6 });
    await run("slot_single_face_right", block.id, { movingFaceId: right.id, distanceMm: 12 });
  }
  // (b) stepped block: high part z 0..10 (x 2500..2520) united with low part z 0..5 (x 2520..2540).
  {
    const [high] = await add("plasticity_create_box", { originMm: [2500, 0, 0], sizeMm: [20, 10, 10] });
    const [low] = await add("plasticity_create_box", { originMm: [2520, 0, 0], sizeMm: [20, 10, 5] });
    const cur = await status(client);
    await call(client, "plasticity_boolean", { targetIds: [high.id], toolIds: [low.id], operation: "union", revision: cur.revision });
    const body = await info(high.id);
    const upper = one(body, (f) => f.planar && f.normal[2] > 0.999 && f.centerMm[2] > 9, "upper +z");
    const lower = one(body, (f) => f.planar && f.normal[2] > 0.999 && f.centerMm[2] < 6, "lower +z");
    out.stepped_faces = { upper: upper.id, lower: lower.id };
    await run("stepped_reversed_lower_moves_5_to_8", high.id, { movingFaceId: lower.id, referenceFaceId: upper.id, distanceMm: 8 });
    await run("stepped_reversed_lower_moves_5_to_3", high.id, { movingFaceId: lower.id, referenceFaceId: upper.id, distanceMm: 3 });
    await run("stepped_reversed_lower_moves_5_to_12_past_zero", high.id, { movingFaceId: lower.id, referenceFaceId: upper.id, distanceMm: 12 });
  }
  // (c) half cylinder: r 10, h 10 cylinder at (2600, 0) minus the x < 2600 half; single-face mode on the flat face.
  {
    const [cylinder] = await add("plasticity_create_cylinder", { centerMm: [2600, 0, 0], radiusMm: 10, heightMm: 10 });
    const [cutter] = await add("plasticity_create_box", { originMm: [2585, -15, -1], sizeMm: [15, 30, 12] });
    const cur = await status(client);
    await call(client, "plasticity_boolean", { targetIds: [cylinder.id], toolIds: [cutter.id], operation: "difference", revision: cur.revision });
    const body = await info(cylinder.id);
    const flat = one(body, (f) => f.planar && f.normal[0] < -0.999, "flat face (-x)");
    out.half_cylinder_faces = { flat: flat.id, surfaces: body.faces.map((f: any) => f.surfaceType) };
    await run("half_cylinder_single_face_flat", cylinder.id, { movingFaceId: flat.id, distanceMm: 6 });
    const top = one(body, (f) => f.planar && f.normal[2] > 0.999, "top");
    await run("half_cylinder_single_face_top_control", cylinder.id, { movingFaceId: top.id, distanceMm: 12 });
  }
} catch (error) { out.failure = (error as Error).message; console.error("ERROR", (error as Error).message); }
finally {
  await undoTo(client, start.undoDepth);
  const end = await status(client);
  out.end = { undo: end.undoDepth, bodies: end.bodies.length };
  console.error("restored", out.start, out.end);
  save(process.argv[2] ?? "probe-pair-layouts.json", out);
  await client.close(); runtime.close(); process.exit(0);
}
