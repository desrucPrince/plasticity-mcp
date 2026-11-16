// Face control points on multi-face bodies, second show, hide, zero-CV faces. Isolated instance only; undoes everything.
import { readFileSync } from "node:fs";
import { connect, nativeFunction, save } from "./harness.ts";
import { call, startMcp, status, undoTo } from "./mcp.ts";
const runtime = await connect();
const client = await startMcp();
const start = await status(client);
const out: Record<string, unknown> = { start: { undo: start.undoDepth, bodies: start.bodies.length } };
const src = readFileSync("js/show-points.js", "utf8");
const show = async (label: string, bodyId: number, faceIds: string[] | null, showFlag: boolean | null = null) => {
  const before = await status(client);
  const r = await runtime.mutate<any>(nativeFunction([src] as any), ["ShowFacePointsFactory"], [{ bodyId, faceIds, show: showFlag }], 30000);
  const after = await status(client);
  out[label] = { ...r, mcpUndo: [before.undoDepth, after.undoDepth], bodyStill: after.bodies.some((b: any) => b.id === bodyId) };
  console.error(label, JSON.stringify({ undoDelta: r.undoDelta, failure: r.failure, n: r.after.length, ids: r.after.map((cv: any) => cv.id), sameView: r.sameView }).slice(0, 600));
  return r;
};
const add = async (tool: string, args: Record<string, unknown>) => {
  const before = await status(client);
  await call(client, tool, { ...args, revision: before.revision });
  const after = await status(client);
  return after.bodies.filter((body: any) => !before.bodies.some((old: any) => old.id === body.id));
};
try {
  const mode = process.argv[2] ?? "sheet";
  if (mode === "sheet") {
    const [a] = await add("plasticity_create_nurbs_curve", { pointsMm: [[2900, 0, 0], [2910, 0, 8], [2920, 0, 0]] });
    const [b] = await add("plasticity_create_nurbs_curve", { pointsMm: [[2920, 0, 0], [2930, 0, 8], [2940, 0, 0]] });
    const sa = (await add("plasticity_extrude_curves", { ids: [a.id], distanceMm: 20, direction: [0, 1, 0] })).find((x: any) => x.type === "Sheet");
    const sb = (await add("plasticity_extrude_curves", { ids: [b.id], distanceMm: 20, direction: [0, 1, 0] })).find((x: any) => x.type === "Sheet");
    await add("plasticity_join_sheets", { ids: [sa.id, sb.id] });
    const st = await status(client);
    const sheet = st.bodies.find((x: any) => x.type === "Sheet" && x.faceCount === 2);
    out.sheet = { id: sheet?.id, faceCount: sheet?.faceCount, types: st.bodies.map((x: any) => [x.id, x.type, x.faceCount]) };
    const info = (await call(client, "plasticity_body_info", { id: sheet.id })).body;
    const [fA, fB] = info.faces.map((f: any) => f.id);
    out.sheetFaces = info.faces.map((f: any) => ({ id: f.id, surfaceType: f.surfaceType, centerMm: f.centerMm }));
    await show("read_initial", sheet.id, null);
    await show("show_A", sheet.id, [fA]);
    await show("show_B", sheet.id, [fB]);
    await show("show_A_again", sheet.id, [fA]);
    await show("hide_A", sheet.id, [fA], false);
    await show("hide_B", sheet.id, [fB], false);
    await show("show_AB", sheet.id, [fA, fB], true);
    const s2 = await status(client);
    out.after_all = s2.bodies.filter((x: any) => x.type === "Sheet").map((x: any) => [x.id, x.faceCount]);
  } else if (mode === "zero") {
    const [box] = await add("plasticity_create_box", { originMm: [2800, 0, 0], sizeMm: [10, 10, 10] });
    const bi = (await call(client, "plasticity_body_info", { id: box.id })).body;
    await show("box_planar_top", box.id, [bi.faces.find((f: any) => f.normal[2] > 0.999).id], true);
    const [cyl] = await add("plasticity_create_cylinder", { centerMm: [2850, 0, 0], radiusMm: 5, heightMm: 10 });
    const ci = (await call(client, "plasticity_body_info", { id: cyl.id })).body;
    const side = ci.faces.find((f: any) => !f.planar);
    out.cylSide = { surfaceType: side.surfaceType };
    await show("cylinder_side", cyl.id, [side.id], true);
    // Solid with two NURBS side faces: a closed wire of two NURBS arcs, extruded.
    const [u] = await add("plasticity_create_nurbs_curve", { pointsMm: [[2900, 0, 0], [2910, 6, 0], [2920, 0, 0]] });
    const [l] = await add("plasticity_create_nurbs_curve", { pointsMm: [[2920, 0, 0], [2910, -6, 0], [2900, 0, 0]] });
    await add("plasticity_join_curves", { ids: [u.id, l.id] });
    const st = await status(client);
    const wire = st.bodies.find((x: any) => x.type === "Wire" && !start.bodies.some((o: any) => o.id === x.id));
    const solids = await add("plasticity_extrude_curves", { ids: [wire.id], distanceMm: 10, direction: [0, 0, 1] });
    out.extruded = solids.map((x: any) => [x.id, x.type, x.faceCount]);
    const solid = solids.find((x: any) => x.type === "Solid") ?? solids[0];
    const si = (await call(client, "plasticity_body_info", { id: solid.id })).body;
    out.solidFaces = si.faces.map((f: any) => ({ id: f.id, surfaceType: f.surfaceType, planar: f.planar }));
    const curved = si.faces.filter((f: any) => !f.planar).map((f: any) => f.id);
    if (curved.length >= 2) {
      await show("solid_show_A", solid.id, [curved[0]]);
      await show("solid_show_B", solid.id, [curved[1]]);
    }
  }
} catch (error) { out.failure = (error as Error).message; console.error("ERROR", (error as Error).message.slice(0, 3000)); }
finally {
  await undoTo(client, start.undoDepth);
  const end = await status(client);
  out.end = { undo: end.undoDepth, bodies: end.bodies.length };
  console.error("restored", out.start, out.end);
  save(`probe-facepoints-${process.argv[2] ?? "sheet"}.json`, out);
  await client.close(); runtime.close(); process.exit(0);
}
