// PolySplines options on an open 3x3 quad grid and a triangle mesh; X-sided patch with edges on a Solid and guides
// with edges. Uses the MCP tools. Isolated instance only; undoes everything.
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { save } from "./harness.ts";
import { call, startMcp, status, tryCall, undoTo } from "./mcp.ts";
const client = await startMcp();
const start = await status(client);
const meshes0 = (await call(client, "plasticity_list_reference_meshes", {})).referenceMeshes.length;
const out: Record<string, unknown> = { start: { undo: start.undoDepth, bodies: start.bodies.length, meshes: meshes0 } };
const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "followups-mesh-"));
const mutate = async (tool: string, args: Record<string, unknown>) => {
  const before = await status(client);
  const r = await tryCall(client, tool, { ...args, revision: before.revision });
  const after = await status(client);
  const added = after.bodies.filter((body: any) => !before.bodies.some((old: any) => old.id === body.id));
  return { r, added, undo: [before.undoDepth, after.undoDepth] };
};
const summary = (body: any) => body && ({ id: body.id, type: body.type, faces: body.faceCount, edges: body.edgeCount, vertices: body.vertexCount, boundsMm: body.boundsMm });
// 4 x 4 vertices, 3 x 3 quads, 30 mm square at x 3200, with a 6 mm bump on the four inner vertices.
const grid = () => {
  const v: string[] = []; const f: string[] = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) v.push(`v ${3200 + i * 10} ${j * 10} ${(i === 1 || i === 2) && (j === 1 || j === 2) ? 6 : 0}`);
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) { const a = j * 4 + i + 1; f.push(`f ${a} ${a + 1} ${a + 5} ${a + 4}`); }
  return `${v.join("\n")}\n${f.join("\n")}\n`;
};
const triangles = () => {
  const v = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]].map(([x, y, z]) => `v ${3300 + x!} ${y} ${z}`);
  const quads = [[1, 4, 3, 2], [5, 6, 7, 8], [1, 2, 6, 5], [3, 4, 8, 7], [1, 5, 8, 4], [2, 3, 7, 6]];
  const f = quads.flatMap(([a, b, c, d]) => [`f ${a} ${b} ${c}`, `f ${a} ${c} ${d}`]);
  return `${v.join("\n")}\n${f.join("\n")}\n`;
};
const polyCase = async (label: string, file: string, options: Record<string, unknown>) => {
  const checkpoint = (await status(client)).undoDepth;
  await mutate("plasticity_import_reference_mesh", { path: file, sourceUnit: "millimeter" });
  const meshes = (await call(client, "plasticity_list_reference_meshes", {})).referenceMeshes;
  const mesh = meshes[meshes.length - 1];
  const converted = await mutate("plasticity_convert_reference_mesh_to_polysplines", { referenceMeshId: mesh.id, ...options });
  const meshesAfter = (await call(client, "plasticity_list_reference_meshes", {})).referenceMeshes.length;
  out[`poly_${label}`] = { options, ok: converted.r.ok, error: converted.r.error, undo: converted.undo, added: converted.added.map(summary), meshesAfter, meshTriangles: mesh.triangles };
  console.error(label, JSON.stringify(out[`poly_${label}`]).slice(0, 500));
  await undoTo(client, checkpoint);
};
try {
  const gridFile = join(dir, "grid3x3.obj"); writeFileSync(gridFile, grid());
  const triFile = join(dir, "tri-cube.obj"); writeFileSync(triFile, triangles());
  await polyCase("grid_default", gridFile, {});
  await polyCase("grid_interp_true", gridFile, { interpolateBoundary: true });
  await polyCase("grid_interp_false", gridFile, { interpolateBoundary: false });
  await polyCase("grid_merge_false", gridFile, { mergePatches: false });
  await polyCase("grid_merge_false_interp_true", gridFile, { mergePatches: false, interpolateBoundary: true });
  await polyCase("tri_cube_default", triFile, {});

  // ---- X-sided patch with edges of a Solid: the top-face loop of a box (each edge has two faces).
  const box = (await mutate("plasticity_create_box", { originMm: [3400, 0, 0], sizeMm: [20, 20, 10] })).added[0];
  const boxInfo = (await call(client, "plasticity_body_info", { id: box.id })).body;
  const top = boxInfo.faces.find((f: any) => f.normal[2] > 0.999);
  const solidLoop = await mutate("plasticity_xsided_patch", { edges: { bodyId: box.id, edgeIds: top.edgeIds } });
  out.xsided_solid_box_top_loop = { ok: solidLoop.r.ok, error: solidLoop.r.error, undo: solidLoop.undo, added: solidLoop.added.map(summary) };
  console.error("solid box loop", JSON.stringify(out.xsided_solid_box_top_loop).slice(0, 500));
  if (solidLoop.undo[1] > solidLoop.undo[0]) await undoTo(client, solidLoop.undo[0]);
  // Through-hole rim on a Solid plate.
  const plate = (await mutate("plasticity_create_box", { originMm: [3500, 0, 0], sizeMm: [30, 30, 5] })).added[0];
  const hole = (await mutate("plasticity_create_cylinder", { centerMm: [3515, 15, -1], radiusMm: 6, heightMm: 7 })).added[0];
  await mutate("plasticity_boolean", { targetIds: [plate.id], toolIds: [hole.id], operation: "difference" });
  const plateInfo = (await call(client, "plasticity_body_info", { id: plate.id })).body;
  const rims = plateInfo.edges.filter((e: any) => e.circle && Math.abs(e.centerMm[2] - 5) < 0.01);
  out.plate_rims = rims.map((e: any) => ({ id: e.id, centerMm: e.centerMm, faceIds: e.faceIds }));
  for (const continuity of [undefined, "g1"]) {
    const rim = await mutate("plasticity_xsided_patch", { edges: { bodyId: plate.id, edgeIds: rims.map((e: any) => e.id) }, ...(continuity ? { continuity } : {}) });
    out[`xsided_solid_hole_rim_${continuity ?? "default"}`] = { ok: rim.r.ok, error: rim.r.error, undo: rim.undo, added: rim.added.map(summary) };
    console.error("hole rim", continuity, JSON.stringify(out[`xsided_solid_hole_rim_${continuity ?? "default"}`]).slice(0, 500));
    if (rim.undo[1] > rim.undo[0]) await undoTo(client, rim.undo[0]);
  }
  // Guides with edges: an open cylinder (top face deleted) rim plus an interior guide curve.
  const cyl = (await mutate("plasticity_create_cylinder", { centerMm: [3600, 0, 0], radiusMm: 10, heightMm: 20 })).added[0];
  const cylInfo = (await call(client, "plasticity_body_info", { id: cyl.id })).body;
  const cap = cylInfo.faces.find((f: any) => f.planar && f.normal[2] > 0.999);
  await mutate("plasticity_delete_faces", { faces: [{ bodyId: cyl.id, faceId: cap.id }] });
  const st = await status(client);
  const open = st.bodies.find((b: any) => b.type === "Sheet" && b.boundsMm && b.boundsMm.min[0] > 3580 && b.boundsMm.max[0] < 3620);
  const openInfo = (await call(client, "plasticity_body_info", { id: open.id })).body;
  const openRim = openInfo.edges.filter((e: any) => e.faceIds.length === 1);
  const guide = (await mutate("plasticity_create_nurbs_curve", { pointsMm: [[3590, 0, 20], [3600, 0, 30], [3610, 0, 20]] })).added[0];
  const plain = await mutate("plasticity_xsided_patch", { edges: { bodyId: open.id, edgeIds: openRim.map((e: any) => e.id) } });
  out.xsided_open_rim_plain = { ok: plain.r.ok, error: plain.r.error, undo: plain.undo, added: plain.added.map(summary) };
  if (plain.undo[1] > plain.undo[0]) await undoTo(client, plain.undo[0]);
  const guided = await mutate("plasticity_xsided_patch", { edges: { bodyId: open.id, edgeIds: openRim.map((e: any) => e.id) }, guideIds: [guide.id] });
  out.xsided_open_rim_with_guide = { ok: guided.r.ok, error: guided.r.error, undo: guided.undo, added: guided.added.map(summary) };
  if (guided.undo[1] > guided.undo[0]) await undoTo(client, guided.undo[0]);
  const guidedG1 = await mutate("plasticity_xsided_patch", { edges: { bodyId: open.id, edgeIds: openRim.map((e: any) => e.id) }, guideIds: [guide.id], continuity: "g1" });
  out.xsided_open_rim_with_guide_g1 = { ok: guidedG1.r.ok, error: guidedG1.r.error, undo: guidedG1.undo, added: guidedG1.added.map(summary) };
  if (guidedG1.undo[1] > guidedG1.undo[0]) await undoTo(client, guidedG1.undo[0]);
  console.error("guides", JSON.stringify([out.xsided_open_rim_plain, out.xsided_open_rim_with_guide, out.xsided_open_rim_with_guide_g1]).slice(0, 1500));
  // Guide with edges on a Solid (box top loop) too.
  const box2 = (await mutate("plasticity_create_box", { originMm: [3700, 0, 0], sizeMm: [20, 20, 10] })).added[0];
  const box2Info = (await call(client, "plasticity_body_info", { id: box2.id })).body;
  const top2 = box2Info.faces.find((f: any) => f.normal[2] > 0.999);
  const guide2 = (await mutate("plasticity_create_nurbs_curve", { pointsMm: [[3700, 10, 10], [3710, 10, 18], [3720, 10, 10]] })).added[0];
  const solidGuided = await mutate("plasticity_xsided_patch", { edges: { bodyId: box2.id, edgeIds: top2.edgeIds }, guideIds: [guide2.id] });
  out.xsided_solid_box_top_loop_with_guide = { ok: solidGuided.r.ok, error: solidGuided.r.error, undo: solidGuided.undo, added: solidGuided.added.map(summary) };
  console.error("solid guided", JSON.stringify(out.xsided_solid_box_top_loop_with_guide).slice(0, 600));
  const lic = await tryCall(client, "plasticity_status", {});
  out.licenceNote = "see FINDINGS gap 6: hasXNurbs true, isStudioLicense true on this machine";
  void lic;
} catch (error) { out.failure = (error as Error).message; console.error("ERROR", (error as Error).message.slice(0, 3000)); }
finally {
  await undoTo(client, start.undoDepth);
  const end = await status(client);
  const meshes = (await call(client, "plasticity_list_reference_meshes", {})).referenceMeshes.length;
  out.end = { undo: end.undoDepth, bodies: end.bodies.length, meshes };
  console.error("restored", out.start, out.end);
  save("probe-patch-poly.json", out);
  await client.close(); process.exit(0);
}
