// Two-face sheet: show both, move CVs of both faces in one step, hide a face that is not shown. Undoes everything.
import { readFileSync } from "node:fs";
import { connect, nativeFunction, save } from "./harness.ts";
import { call, startMcp, status, undoTo } from "./mcp.ts";
const runtime = await connect();
const client = await startMcp();
const start = await status(client);
const out: Record<string, unknown> = { start: { undo: start.undoDepth, bodies: start.bodies.length } };
const showSrc = readFileSync("js/show-points.js", "utf8");
const attrSrc = readFileSync("js/face-attrs.js", "utf8");
const moveSrc = readFileSync("js/move-cvs.js", "utf8");
const add = async (tool: string, args: Record<string, unknown>) => {
  const before = await status(client);
  await call(client, tool, { ...args, revision: before.revision });
  const after = await status(client);
  return after.bodies.filter((body: any) => !before.bodies.some((old: any) => old.id === body.id));
};
const attrs = async (label: string, bodyId: number) => { const r = await runtime.read<any>(nativeFunction([attrSrc] as any), [{ bodyId }]); out[label] = { revision: (await status(client)).revision, viewOrder: r.viewOrder, entities: r.faces.map((f: any) => [f.id, f.entity]), kernel: r.faces.map((f: any) => [f.id, f.cpFirst]), cvs: r.cvs }; return r; };
try {
  const [a] = await add("plasticity_create_nurbs_curve", { pointsMm: [[2900, 0, 0], [2910, 0, 8], [2920, 0, 0]] });
  const [b] = await add("plasticity_create_nurbs_curve", { pointsMm: [[2920, 0, 0], [2930, 0, 8], [2940, 0, 0]] });
  const sa = (await add("plasticity_extrude_curves", { ids: [a.id], distanceMm: 20, direction: [0, 1, 0] })).find((x: any) => x.type === "Sheet");
  const sb = (await add("plasticity_extrude_curves", { ids: [b.id], distanceMm: 20, direction: [0, 1, 0] })).find((x: any) => x.type === "Sheet");
  await add("plasticity_join_sheets", { ids: [sa.id, sb.id] });
  const sheet = (await status(client)).bodies.find((x: any) => x.type === "Sheet" && x.faceCount === 2);
  const info = (await call(client, "plasticity_body_info", { id: sheet.id })).body;
  const faceA = info.faces.find((f: any) => f.centerMm[0] < 2920).id;
  const faceB = info.faces.find((f: any) => f.centerMm[0] > 2920).id;
  await attrs("initial", sheet.id);
  out.hide_unshown = await runtime.mutate(nativeFunction([showSrc] as any), ["ShowFacePointsFactory"], [{ bodyId: sheet.id, faceIds: [faceA], show: false }], 30000).then((r: any) => ({ undoDelta: r.undoDelta, failure: r.failure, n: r.after.length }));
  const both = await runtime.mutate<any>(nativeFunction([showSrc] as any), ["ShowFacePointsFactory"], [{ bodyId: sheet.id, faceIds: [faceA, faceB], show: true }], 30000);
  out.show_both = { undoDelta: both.undoDelta, n: both.after.length };
  await attrs("after_show", sheet.id);
  out.move = await runtime.mutate(nativeFunction([moveSrc] as any), ["MultiMoveControlPointFactory"], [{ bodyId: sheet.id, cvIds: [2, 12], delta: [0, 0, 0.005] }], 30000);
  await attrs("after_move", sheet.id);
  await runtime.mutate(nativeFunction([showSrc] as any), ["ShowFacePointsFactory"], [{ bodyId: sheet.id, faceIds: [faceA], show: false }], 30000);
  await attrs("after_hide_A", sheet.id);
  const st = await status(client);
  out.bodyAfterMove = st.bodies.find((x: any) => x.id === sheet.id) ? { id: sheet.id, bounds: st.bodies.find((x: any) => x.id === sheet.id).boundsMm, faces: st.bodies.find((x: any) => x.id === sheet.id).faceCount } : "body id gone";
  console.log(JSON.stringify(out, null, 1).slice(0, 8000));
} catch (error) { out.failure = (error as Error).message; console.error("ERROR", (error as Error).message.slice(0, 3000)); }
finally {
  await undoTo(client, start.undoDepth);
  const end = await status(client);
  out.end = { undo: end.undoDepth, bodies: end.bodies.length };
  console.error("restored", out.start, out.end);
  save("probe-facepoints-move.json", out);
  await client.close(); runtime.close(); process.exit(0);
}
