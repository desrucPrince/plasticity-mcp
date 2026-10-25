// Final join for the neoRC 11 build-on-mesh model (run after build-on-mesh.ts and the V3 checkpoint save).
// 1. Deletes every mirrored instance and realizes the +X translation/rotation instances into bodies (negative-scale
//    instances are never realized, so no inside-out shells).
// 2. Hull half = Solid.001 ∪ Solid.003 ∪ fin ∪ buttress ∪ strakes ∪ exhaust frame, with G2 root blends for the fin
//    and the buttress.
// 3. Plain-mirrors the hull half and every detail body across X = 0, unions the hull halves, joins visor sheets.
// 4. Validates, measures continuity, exports STEP / STL / OBJ (2 mm chord) into discovery/neorc11/export/.
// Detail bodies with their own materials (glass, lights, emitters, chrome, gunmetal) stay separate named bodies.
// Usage: PLASTICITY_CDP_URL=http://127.0.0.1:9223 node discovery/neorc11/user-half/join.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openSession } from "../../mcp-client.ts";

type Vec = [number, number, number];
type Box = { min: Vec; max: Vec };
type Body = { id: number; name: string | null; type: string; boundsMm: Box; faceCount?: number; visible?: boolean };
type Edge = { id: string; boundsMm: Box; lengthMm: number; faceIds: string[] };

const outDir = resolve("discovery/neorc11/user-half");
const exportDir = resolve("discovery/neorc11/export");
await mkdir(exportDir, { recursive: true });
const s = await openSession();
const raw = (name: string, args: Record<string, unknown> = {}) => s.raw(name, args);
const call = (toolName: string, args: Record<string, unknown> = {}) => raw("plasticity_call", { toolName, arguments: args });
const status = () => raw("plasticity_status", { bodyLimit: 200 });
const rev = async () => (await status()).revision as string;
const bodies = async (): Promise<Body[]> => (await status()).bodies;
const fmt = (b: Body) => `${b.name}#${b.id} [${b.boundsMm.min.map(Math.round)}]..[${b.boundsMm.max.map(Math.round)}]`;
const edgesOf = async (id: number) => ((await raw("plasticity_body_info", { id })).body.edges ?? []) as Edge[];
const instances = async () => ((await call("plasticity_list_instances")).instances ?? []) as Array<{ id: number; sourceBodyIds: number[]; scale: Vec }>;
const r = (v: number) => Math.round(v * 1000) / 1000;
const report: Record<string, unknown> = {};
const contPath = resolve(outDir, "continuity.json");
const continuity: Record<string, unknown> = existsSync(contPath) ? JSON.parse(await readFile(contPath, "utf8")) : {};
const say = (...x: unknown[]) => console.log(...x);

async function measure(label: string, id: number, edgeIds: string[], tangentOnly = true) {
  const two = new Set((await edgesOf(id)).filter((e) => e.faceIds.length === 2).map((e) => e.id));
  const ids = edgeIds.filter((e) => two.has(e));
  if (!ids.length) { continuity[label] = "no measurable edges"; return; }
  const res = await call("plasticity_analyze_surface_continuity", { edges: ids.slice(0, 400).map((edgeId) => ({ bodyId: id, edgeId })), revision: await rev() });
  const rows = (res.analyses ?? []).filter((a: any) => !tangentOnly || a.maximumNormalAngleDeviationDeg < 1);
  const max = (k: string) => Math.max(0, ...rows.map((a: any) => Number(a[k]) || 0));
  const g1 = max("maximumNormalAngleDeviationDeg"), g2 = max("maximumRelativeCurvatureDeviation");
  continuity[label] = { edges: rows.length, of: ids.length, maxG0mm: r(max("maximumPositionDeviationMm")), maxG1deg: r(g1), maxRelG2: r(g2), verdict: !rows.length ? "G0 (creases)" : g1 > 0.1 ? "G0" : g2 <= 0.05 ? "G2" : "G1" };
}
async function fillet(id: number, edgeIds: string[], radii: number[], label: string) {
  if (!edgeIds.length) { say(label, "no edges"); continuity[label] = "no edges found"; return; }
  for (const radius of radii) {
    const before = new Set((await edgesOf(id)).map((e) => e.id));
    try {
      await raw("plasticity_fillet", { id, edgeIds, radiusMm: radius, shape: "g2", revision: await rev() });
      say(label, `r${radius} g2 on ${edgeIds.length} edges`);
      await measure(`${label} (r${radius})`, id, (await edgesOf(id)).filter((e) => !before.has(e.id)).map((e) => e.id));
      return;
    } catch (error) { say(label, `r${radius} failed: ${String(error).slice(0, 160)}`); }
  }
  continuity[label] = "fillet failed at every radius (left as G0 crease)";
}
const byName = async (n: string) => (await bodies()).find((b) => b.name === n);

try {
  // ---- 1. instances: delete mirrored ones, realize the rest
  const inst = await instances();
  const mirrored = inst.filter((i) => i.scale[0] < 0).map((i) => i.id);
  if (mirrored.length) await call("plasticity_delete_instances", { ids: mirrored, revision: await rev() });
  // Realize one at a time so each new body can take its source's name (and so join/mirror/export find it).
  const names = new Map((await bodies()).map((b) => [b.id, b.name]));
  const realized: Body[] = [];
  for (const i of await instances()) {
    const before = new Set((await bodies()).map((b) => b.id));
    await call("plasticity_realize_instances", { ids: [i.id], revision: await rev() });
    for (const b of (await bodies()).filter((x) => !before.has(x.id))) {
      const name = names.get(i.sourceBodyIds[0]!) ?? "rc11_realized";
      if (b.name !== name) await call("plasticity_rename", { id: b.id, name, revision: await rev() });
      realized.push(b);
    }
  }
  report.instances = { mirroredDeleted: mirrored.length, realized: realized.length };
  say("instances", report.instances);

  // ---- 2. hull half
  const all = await bodies();
  const hull = all.find((b) => b.name === "Solid.001")!, pod = all.find((b) => b.name === "Solid.003")!;
  const isPart = (b: Body, prefix: string) => b.type === "Solid" && (b.name ?? "").startsWith(prefix) && b.visible !== false;
  const fin = all.filter((b) => isPart(b, "rc11_fin") && !(b.name ?? "").includes("section") && !(b.name ?? "").includes("planform"));
  const buttress = all.filter((b) => isPart(b, "rc11_buttress") && !(b.name ?? "").includes("profile"));
  const strakes = all.filter((b) => isPart(b, "rc11_strake") && !(b.name ?? "").includes("profile"));
  const frame = all.filter((b) => isPart(b, "rc11_exhaust_frame"));
  say("hull parts:", [pod, ...fin, ...buttress, ...strakes, ...frame].map(fmt).join(" | "));
  await raw("plasticity_boolean", { targetIds: [hull.id], toolIds: [pod.id], operation: "union", revision: await rev() });
  for (const [label, parts, radii, zone] of [
    ["fin root blend", fin, [80, 50, 30], (e: Edge) => e.boundsMm.min[0] > 3550 && e.boundsMm.max[0] < 3760 && e.boundsMm.min[1] > -5400 && e.boundsMm.max[1] < -1000],
    ["buttress root blend", buttress, [60, 40, 25], (e: Edge) => e.boundsMm.min[0] > 1990 && e.boundsMm.max[0] < 2310 && e.boundsMm.min[1] > -4800 && e.boundsMm.max[1] < -2200],
  ] as Array<[string, Body[], number[], (e: Edge) => boolean]>) {
    if (!parts.length) continue;
    const pre = new Set((await edgesOf(hull.id)).map((e) => e.id));
    await raw("plasticity_boolean", { targetIds: [hull.id], toolIds: parts.map((b) => b.id), operation: "union", revision: await rev() });
    const seam = (await edgesOf(hull.id)).filter((e) => !pre.has(e.id) && zone(e)).map((e) => e.id);
    await fillet(hull.id, seam, radii, label);
  }
  if (strakes.length || frame.length) await raw("plasticity_boolean", { targetIds: [hull.id], toolIds: [...strakes, ...frame].map((b) => b.id), operation: "union", revision: await rev() });
  await call("plasticity_rename", { id: hull.id, name: "rc11_hull", revision: await rev() });

  // ---- 3. mirror everything visible across X = 0
  const visible = (await bodies()).filter((b) => b.visible !== false && b.type !== "Wire" && ((b.name ?? "").startsWith("rc11_")));
  const preMirror = new Set((await bodies()).map((b) => b.id));
  await raw("plasticity_mirror", { ids: visible.map((b) => b.id), planeOriginMm: [0, 0, 0], planeNormal: [1, 0, 0], keepOriginal: true, revision: await rev() });
  const mirrors = (await bodies()).filter((b) => !preMirror.has(b.id));
  const hullMirror = mirrors.find((b) => Math.abs(b.boundsMm.max[0] + (visible.find((v) => v.id === hull.id)!.boundsMm.min[0])) < 1 && b.faceCount === (visible.find((v) => v.id === hull.id)!.faceCount))
    ?? mirrors.reduce((a, b) => ((a.faceCount ?? 0) > (b.faceCount ?? 0) ? a : b));
  const preUnion = new Set((await edgesOf(hull.id)).map((e) => e.id));
  await raw("plasticity_boolean", { targetIds: [hull.id], toolIds: [hullMirror.id], operation: "union", revision: await rev() });
  const seam = (await edgesOf(hull.id)).filter((e) => Math.abs(e.boundsMm.min[0]) < 0.5 && Math.abs(e.boundsMm.max[0]) < 0.5).map((e) => e.id);
  await measure("X=0 centre seam (all edges)", hull.id, seam, false);
  report.centreSeamEdges = seam.length;
  report.newEdgesFromCentreUnion = (await edgesOf(hull.id)).filter((e) => !preUnion.has(e.id)).length;
  // Centreline detail halves (core plate, rings, nose strip, exhaust glow/vanes, drive vanes along X = 0) unite with
  // their mirrors so each is one body.
  for (const half of visible.filter((b) => b.id !== hull.id && b.boundsMm.min[0] < 0.5)) {
    const twin = (await bodies()).find((b) => !preMirror.has(b.id) && b.name === half.name && Math.abs(b.boundsMm.max[0] + half.boundsMm.min[0]) < 0.5 && Math.abs(b.boundsMm.min[1] - half.boundsMm.min[1]) < 0.5 && Math.abs(b.boundsMm.min[2] - half.boundsMm.min[2]) < 0.5);
    if (!twin) continue;
    if (half.type === "Sheet") await call("plasticity_join_sheets", { ids: [half.id, twin.id], revision: await rev() }).catch((e: unknown) => say("sheet join", half.name, String(e).slice(0, 120)));
    else await raw("plasticity_boolean", { targetIds: [half.id], toolIds: [twin.id], operation: "union", revision: await rev() }).catch((e: unknown) => say("detail union", half.name, String(e).slice(0, 120)));
  }

  // ---- 4. validate, bounds, export
  const final = (await bodies()).filter((b) => b.visible !== false && b.type !== "Wire" && (b.name ?? "").startsWith("rc11_"));
  const hullNow = final.find((b) => b.id === hull.id)!;
  const solids = final.filter((b) => b.type === "Solid");
  const valid = await call("plasticity_validate_bodies", { ids: solids.map((b) => b.id), revision: await rev() });
  const bad = (valid.bodies ?? []).filter((v: any) => !v.closed || !v.nativeValid);
  const hullValid = (valid.bodies ?? []).find((v: any) => v.id === hull.id);
  report.hull = { body: fmt(hullNow), faces: hullNow.faceCount, closed: hullValid?.closed, nativeValid: hullValid?.nativeValid, checkCodes: hullValid?.nativeCheckCodes };
  report.invalidDetails = bad.filter((v: any) => v.id !== hull.id).map((v: any) => `${v.name}#${v.id}`);
  const lo = [0, 1, 2].map((i) => Math.min(...final.map((b) => b.boundsMm.min[i]!)));
  const hi = [0, 1, 2].map((i) => Math.max(...final.map((b) => b.boundsMm.max[i]!)));
  report.boundsAllMm = { min: lo.map(Math.round), max: hi.map(Math.round), size: hi.map((v, i) => Math.round(v - lo[i]!)) };
  report.boundsHullMm = { min: hullNow.boundsMm.min.map(Math.round), max: hullNow.boundsMm.max.map(Math.round) };
  const counts: Record<string, number> = {};
  for (const b of final) { const k = (b.name ?? "?").replace(/(_\d+)?(\.\d+)?$/, ""); counts[k] = (counts[k] ?? 0) + 1; }
  report.bodies = counts;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const ids = final.map((b) => b.id);
  const solidIds = solids.map((b) => b.id);
  const ex: Record<string, unknown> = {};
  ex.stepAll = (await raw("plasticity_export_step", { ids, path: resolve(exportDir, `neoRC11-${stamp}.step`), revision: await rev() })).path ?? "ok";
  ex.stepHull = (await raw("plasticity_export_step", { ids: [hull.id], path: resolve(exportDir, `neoRC11-hull-${stamp}.step`), revision: await rev() })).path ?? "ok";
  const stl = await call("plasticity_export_stl", { ids: solidIds, path: resolve(exportDir, `neoRC11-${stamp}.stl`), chordToleranceMm: 2, angleToleranceDegrees: 10, revision: await rev() });
  const obj = await call("plasticity_export_obj", { ids, path: resolve(exportDir, `neoRC11-${stamp}.obj`), chordToleranceMm: 2, angleToleranceDegrees: 10, revision: await rev() });
  ex.stl = { path: stl.path, triangles: stl.triangleCount ?? stl.triangles }; ex.obj = { path: obj.path, faces: obj.faceCount ?? obj.counts };
  report.exports = ex;
} finally {
  await writeFile(resolve(outDir, "join-report.json"), JSON.stringify(report, null, 1));
  await writeFile(contPath, JSON.stringify(continuity, null, 1));
  say(JSON.stringify(report, null, 1));
  say(JSON.stringify(continuity, null, 1));
  await s.close();
}
