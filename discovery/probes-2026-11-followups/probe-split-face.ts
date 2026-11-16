// Live check for Part 2 item 7: split an extruded-arc Sheet with a knife cut along y at the apex, so two faces lie on
// one B-Surface. Records each face's kernel grid and what plasticity_show_face_control_points and
// plasticity_hide_face_control_points do (the tool must refuse the show before any edit). Every step is undone.
// Run from this directory with env.sh sourced: node probe-split-face.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect, HERE, nativeFunction, save } from "./harness.ts";
import { call, startMcp, status, tryCall, undoTo } from "./mcp.ts";

const runtime = await connect();
const client = await startMcp();
const showSrc = readFileSync(join(HERE, "js", "show-points.js"), "utf8");
const start = await status(client);
const out: Record<string, unknown> = { start: { undo: start.undoDepth, bodies: start.bodies.length } };
const add = async (tool: string, args: Record<string, unknown>) => {
  const before = await status(client);
  await call(client, tool, { ...args, revision: before.revision });
  const after = await status(client);
  return after.bodies.filter((body: any) => !before.bodies.some((old: any) => old.id === body.id));
};
try {
  const [arch] = await add("plasticity_create_nurbs_curve", { pointsMm: [[2900, 0, 0], [2920, 0, 10], [2940, 0, 0]] });
  const sheet = (await add("plasticity_extrude_curves", { ids: [arch.id], distanceMm: 20, direction: [0, 1, 0] })).find((body: any) => body.type === "Sheet");
  const apex = sheet.boundsMm.max[2];
  out.apex = apex;
  out.knife = await tryCall(client, "plasticity_knife_curve", { targetId: sheet.id, pointsMm: [[2920, -1, apex], [2920, 21, apex]], revision: (await status(client)).revision });
  const info = (await call(client, "plasticity_body_info", { id: sheet.id })).body;
  out.faces = info.faces.map((face: any) => ({ id: face.id, surfaceType: face.surfaceType, centerMm: face.centerMm }));
  console.error("faces", JSON.stringify(out.faces));
  if (info.faces.length === 2) {
    const checkpoint = (await status(client)).undoDepth;
    out.showOne = await tryCall(client, "plasticity_show_face_control_points", { bodyId: sheet.id, faceIds: [info.faces[0].id], revision: (await status(client)).revision });
    out.showOneUndoDelta = (await status(client)).undoDepth - checkpoint;
    out.showBoth = await tryCall(client, "plasticity_show_face_control_points", { bodyId: sheet.id, faceIds: info.faces.map((face: any) => face.id), revision: (await status(client)).revision });
    out.showBothUndoDelta = (await status(client)).undoDepth - checkpoint;
    console.error("show", JSON.stringify({ one: out.showOne, two: out.showBoth, d1: out.showOneUndoDelta, d2: out.showBothUndoDelta }).slice(0, 1500));
    // Show one twin face the way the Plasticity UI would (raw Toggle Points), then use the tools on that body.
    const raw: any = await runtime.mutate(nativeFunction([showSrc] as any), ["ShowFacePointsFactory"], [{ bodyId: sheet.id, faceIds: [info.faces[0].id], show: true }], 30000);
    out.rawShow = { undoDelta: raw.undoDelta, failure: raw.failure, cvs: raw.after?.length };
    const shownDepth = (await status(client)).undoDepth;
    out.moveWhileAmbiguous = await tryCall(client, "plasticity_move_face_control_points", { bodyId: sheet.id, cvIds: ["x"], deltaMm: [0, 0, 1], revision: (await status(client)).revision });
    out.showWhileAmbiguous = await tryCall(client, "plasticity_show_face_control_points", { bodyId: sheet.id, faceIds: [info.faces[1].id], revision: (await status(client)).revision });
    const facesNow = (await call(client, "plasticity_body_info", { id: sheet.id })).body.faces;
    out.hideWhileAmbiguous = await tryCall(client, "plasticity_hide_face_control_points", { bodyId: sheet.id, faceIds: facesNow.map((face: any) => face.id), revision: (await status(client)).revision });
    out.hideUndoDelta = (await status(client)).undoDepth - shownDepth;
    console.error("ambiguous", JSON.stringify({ raw: out.rawShow, move: out.moveWhileAmbiguous, show: out.showWhileAmbiguous, hide: out.hideWhileAmbiguous?.ok ? { undoSteps: out.hideWhileAmbiguous.value.undoSteps, points: out.hideWhileAmbiguous.value.controlPoints.length, message: out.hideWhileAmbiguous.value.message } : out.hideWhileAmbiguous, d: out.hideUndoDelta }).slice(0, 2500));
  }
} catch (error) { out.failure = (error as Error).message; console.error("ERROR", (error as Error).message); }
finally {
  await undoTo(client, start.undoDepth);
  const end = await status(client);
  out.end = { undo: end.undoDepth, bodies: end.bodies.length };
  console.error("restored", out.start, out.end);
  save("probe-split-face.json", out);
  await client.close(); runtime.close(); process.exit(0);
}
