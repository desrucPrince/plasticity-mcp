// Finishes the join from the state join.ts left (instances gone, hull half = rc11_hull with fin, buttress,
// strakes and exhaust frame unioned):
// 1. Restores array copies that realize_instances did not produce, as plain duplicates of their source at the
//    recorded offsets (the instance offsets from build-on-mesh.ts).
// 2. Tries the buttress-to-deck G2 blend once more on the deck edges only; measures the fin and buttress blends
//    from their blend faces.
// 3. Plain-mirrors the hull half and every visible rc11 detail across X = 0, unions the hull halves and the
//    centreline detail halves, joins the visor halves, validates, exports STEP / STL / OBJ at 2 mm.
// Usage: PLASTICITY_CDP_URL=http://127.0.0.1:9223 node discovery/neorc11/user-half/join2.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openSession } from "../../mcp-client.ts";

type Vec = [number, number, number];
type Box = { min: Vec; max: Vec };
type Body = { id: number; name: string | null; type: string; boundsMm: Box; faceCount?: number; visible?: boolean };
type Edge = { id: string; boundsMm: Box; lengthMm: number; faceIds: string[] };
type Face = { id: string; surfaceType: string; boundsMm: Box };

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
const body = async (id: number) => (await raw("plasticity_body_info", { id })).body as { edges: Edge[]; faces: Face[] };
const r = (v: number) => Math.round(v * 1000) / 1000;
const say = (...x: unknown[]) => console.log(...x);
const report: Record<string, unknown> = {};
const contPath = resolve(outDir, "continuity.json");
const continuity: Record<string, unknown> = existsSync(contPath) ? JSON.parse(await readFile(contPath, "utf8")) : {};
for (const k of Object.keys(continuity)) if (k.startsWith("fin root blend (")) delete continuity[k]; // noisy first measurement
const base = (n: string | null) => (n ?? "").replace(/\.\d+$/, "");
const inBox = (b: Box, lo: Vec, hi: Vec) => b.min.every((v, i) => v >= lo[i]! - 1) && b.max.every((v, i) => v <= hi[i]! + 1);

// Continuity on the edges of blend faces (B-spline faces from G2 fillets) inside a region of the hull.
async function measureBlend(label: string, id: number, lo: Vec, hi: Vec) {
  const b = await body(id);
  const blends = new Set(b.faces.filter((f) => f.surfaceType === "BSurf" && inBox(f.boundsMm, lo, hi)).map((f) => f.id));
  const edges = b.edges.filter((e) => e.faceIds.length === 2 && e.faceIds.some((f) => blends.has(f))).map((e) => ({ bodyId: id, edgeId: e.id }));
  if (!edges.length) { continuity[label] = `no blend faces in region (${blends.size})`; return; }
  const res = await call("plasticity_analyze_surface_continuity", { edges: edges.slice(0, 400), revision: await rev() });
  const rows = res.analyses ?? [];
  const tangent = rows.filter((a: any) => a.maximumNormalAngleDeviationDeg < 1);
  const g2 = tangent.filter((a: any) => Number(a.maximumRelativeCurvatureDeviation) <= 0.05).length;
  const max = (xs: any[], k: string) => Math.max(0, ...xs.map((a: any) => Number(a[k]) || 0));
  continuity[label] = { blendFaces: blends.size, edges: rows.length, tangentEdges: tangent.length, g2Edges: g2, g1OnlyEdges: tangent.length - g2, creaseEdges: rows.length - tangent.length,
    maxG0mm: r(max(tangent, "maximumPositionDeviationMm")), maxG1degTangent: r(max(tangent, "maximumNormalAngleDeviationDeg")), maxRelG2Tangent: r(max(tangent, "maximumRelativeCurvatureDeviation")) };
}

try {
  // ---- 0. drop linked instances (copies are made as plain duplicates below; mirrors come from the plain mirror)
  const inst = ((await call("plasticity_list_instances")).instances ?? []) as Array<{ id: number }>;
  if (inst.length) await call("plasticity_delete_instances", { ids: inst.map((i) => i.id), revision: await rev() });
  report.instancesDropped = inst.length;

  // ---- 1. restore missing array copies
  const offsets: Record<string, Vec[]> = {
    rc11_grille_bar: Array.from({ length: 13 }, (_, k) => [165 * (k + 1), 0, 0] as Vec),
    rc11_louvre: [1, 2, 3].map((k) => [0, 0, 85 * k] as Vec),
    rc11_hover_pad: [-5000, -2500, 2500, 4800].map((y) => [0, y, 0] as Vec),
    rc11_drive_vane: [-1100, -825, -550, -275, 275, 550, 825, 1100].map((y) => [0, y, 0] as Vec),
    rc11_exhaust_vane: [1, 2, 3].map((k) => [0, 0, 70 * k] as Vec),
    rc11_headlight: [[90, 0, 0]],
    rc11_taillight: [[0, 14, 100], [0, 28, 200]],
  };
  const restored: string[] = [];
  for (const [name, ts] of Object.entries(offsets)) {
    const all = (await bodies()).filter((b) => base(b.name) === name && b.type === "Solid");
    // Source: for one-sided arrays the copy lowest along the array axis; for the pads and drive vanes (copies on
    // both sides) the copy at the recorded centre (pads Y 0, vanes Y -500).
    const axis = [0, 1, 2].find((i) => ts.some((t) => t[i] !== 0))!;
    const centre = (x: Body) => (x.boundsMm.min[axis]! + x.boundsMm.max[axis]!) / 2;
    const middle = { rc11_hover_pad: 0, rc11_drive_vane: -500 } as Record<string, number>;
    const source = name in middle
      ? all.reduce((p, q) => (Math.abs(centre(q) - middle[name]!) < Math.abs(centre(p) - middle[name]!) ? q : p), all[0]!)
      : all.reduce((p, q) => (q.boundsMm.min[axis]! < p.boundsMm.min[axis]! ? q : p), all[0]!);
    if (!source) { say("no source for", name); continue; }
    for (const t of ts) {
      const want = source.boundsMm.min.map((v, i) => v + t[i]!);
      if (all.some((b) => [0, 1, 2].every((i) => Math.abs(b.boundsMm.min[i]! - want[i]!) < 1))) continue;
      await call("plasticity_duplicate_bodies", { ids: [source.id], translationMm: t, revision: await rev() });
      restored.push(`${name}+(${t})`);
    }
  }
  // Radial fan vanes at both ends of the drive bay: rotated duplicates about each end centre.
  for (const [name, yEnd, sign] of [["rc11_drive_vane_front", -500 + 1100, 1], ["rc11_drive_vane_rear", -500 - 1100, -1]] as Array<[string, number, number]>) {
    const all = (await bodies()).filter((b) => base(b.name) === name && b.type === "Solid");
    if (all.length >= 3) continue;
    const src = all.find((b) => Math.abs(b.boundsMm.min[0] - 300) < 1)!;
    for (const deg of [30 * sign, 60 * sign]) {
      const pre = new Set((await bodies()).map((b) => b.id));
      await call("plasticity_duplicate_bodies", { ids: [src.id], translationMm: [0, 0, 0], revision: await rev() });
      const copy = (await bodies()).find((b) => !pre.has(b.id))!;
      await raw("plasticity_rotate", { ids: [copy.id], pivotMm: [0, yEnd, 0], axis: [0, 0, 1], degrees: deg, revision: await rev() });
      restored.push(`${name} rot ${deg}`);
    }
  }
  report.restoredCopies = restored;
  say("restored", restored.length, restored.join(" "));

  // ---- 2. blends
  const hull = (await bodies()).find((b) => b.name === "rc11_hull")!;
  await measureBlend("fin root blend (G2 r80)", hull.id, [3400, -5500, 1700], [3900, -900, 2800]);
  const deckEdges = (await body(hull.id)).edges.filter((e) => e.faceIds.length === 2 && inBox(e.boundsMm, [1995, -4800, 3090], [2265, -2250, 3110]) && e.lengthMm > 50).map((e) => e.id);
  let buttressBlend = "not attempted";
  for (const radius of [40, 25]) {
    try { await raw("plasticity_fillet", { id: hull.id, edgeIds: deckEdges, radiusMm: radius, shape: "g2", revision: await rev() }); buttressBlend = `G2 r${radius} on ${deckEdges.length} deck edges`; break; }
    catch (error) { buttressBlend = `failed on ${deckEdges.length} deck edges: ${String(error).slice(0, 140)}`; }
  }
  report.buttressBlend = buttressBlend;
  say("buttress blend:", buttressBlend);
  if (buttressBlend.startsWith("G2")) await measureBlend("buttress root blend", hull.id, [1900, -4800, 3090], [2360, -2200, 3200]);
  else continuity["buttress root blend"] = "Parasolid refused the blend (error 16053) at r60/40/25: left as a G0 crease";
  await measureBlend("cabin-to-deck blend (G2 r300)", hull.id, [0, -3300, 3090], [2620, 4720, 3410]);

  // ---- 3. mirror, union, join
  const visible = (await bodies()).filter((b) => b.visible !== false && b.type !== "Wire" && (b.name ?? "").startsWith("rc11_"));
  const pre = new Set((await bodies()).map((b) => b.id));
  await raw("plasticity_mirror", { ids: visible.map((b) => b.id), planeOriginMm: [0, 0, 0], planeNormal: [1, 0, 0], keepOriginal: true, revision: await rev() });
  const mirrors = (await bodies()).filter((b) => !pre.has(b.id));
  const twinOf = (half: Body) => mirrors.find((b) => base(b.name) === base(half.name) && b.type === half.type
    && Math.abs(b.boundsMm.max[0] + half.boundsMm.min[0]) < 1 && Math.abs(b.boundsMm.min[0] + half.boundsMm.max[0]) < 1
    && Math.abs(b.boundsMm.min[1] - half.boundsMm.min[1]) < 1 && Math.abs(b.boundsMm.min[2] - half.boundsMm.min[2]) < 1);
  const hullTwin = twinOf(hull) ?? mirrors.reduce((a, b) => ((a.faceCount ?? 0) > (b.faceCount ?? 0) ? a : b));
  await raw("plasticity_boolean", { targetIds: [hull.id], toolIds: [hullTwin.id], operation: "union", revision: await rev() });
  const seam = (await body(hull.id)).edges.filter((e) => e.faceIds.length === 2 && Math.abs(e.boundsMm.min[0]) < 0.5 && Math.abs(e.boundsMm.max[0]) < 0.5).map((e) => ({ bodyId: hull.id, edgeId: e.id }));
  if (seam.length) {
    const res = await call("plasticity_analyze_surface_continuity", { edges: seam.slice(0, 400), revision: await rev() });
    const rows = res.analyses ?? [];
    const max = (k: string) => Math.max(0, ...rows.map((a: any) => Number(a[k]) || 0));
    continuity["X=0 centre seam"] = { edges: rows.length, maxG0mm: r(max("maximumPositionDeviationMm")), maxG1deg: r(max("maximumNormalAngleDeviationDeg")), maxRelG2: r(max("maximumRelativeCurvatureDeviation")) };
    await writeFile(resolve(outDir, "seam-continuity.json"), JSON.stringify(rows, null, 1));
  } else continuity["X=0 centre seam"] = "no edges left on X=0: the halves' faces merged across the centre";
  const centreline = visible.filter((b) => b.id !== hull.id && b.boundsMm.min[0] < 0.5);
  for (const half of centreline) {
    const twin = twinOf(half);
    if (!twin) { say("no twin for", fmt(half)); continue; }
    if (half.type === "Sheet") await call("plasticity_join_sheets", { ids: [half.id, twin.id], revision: await rev() }).catch((e: unknown) => say("sheet join", half.name, String(e).slice(0, 140)));
    else await raw("plasticity_boolean", { targetIds: [half.id], toolIds: [twin.id], operation: "union", revision: await rev() }).catch((e: unknown) => say("detail union", half.name, String(e).slice(0, 140)));
  }

  // ---- 4. validate, bounds, export
  const final = (await bodies()).filter((b) => b.visible !== false && b.type !== "Wire" && (b.name ?? "").startsWith("rc11_"));
  const hullNow = final.find((b) => b.id === hull.id)!;
  const solids = final.filter((b) => b.type === "Solid");
  const valid = await call("plasticity_validate_bodies", { ids: solids.map((b) => b.id), revision: await rev() });
  const rows = (valid.bodies ?? []) as Array<{ id: number; name: string; closed: boolean; nativeValid: boolean; nativeCheckCodes: unknown[] }>;
  const hv = rows.find((v) => v.id === hull.id);
  report.hull = { body: fmt(hullNow), faces: hullNow.faceCount, closed: hv?.closed, nativeValid: hv?.nativeValid, checkCodes: hv?.nativeCheckCodes };
  report.detailsValid = `${rows.filter((v) => v.id !== hull.id && v.closed && v.nativeValid).length}/${rows.length - 1}`;
  report.invalidDetails = rows.filter((v) => v.id !== hull.id && (!v.closed || !v.nativeValid)).map((v) => `${v.name}#${v.id}`);
  const lo = [0, 1, 2].map((i) => Math.min(...final.map((b) => b.boundsMm.min[i]!)));
  const hi = [0, 1, 2].map((i) => Math.max(...final.map((b) => b.boundsMm.max[i]!)));
  report.boundsAllMm = { min: lo.map(Math.round), max: hi.map(Math.round), size: hi.map((v, i) => Math.round(v - lo[i]!)) };
  report.boundsHullMm = { min: hullNow.boundsMm.min.map(Math.round), max: hullNow.boundsMm.max.map(Math.round), size: hullNow.boundsMm.max.map((v, i) => Math.round(v - hullNow.boundsMm.min[i]!)) };
  const counts: Record<string, number> = {};
  for (const b of final) counts[base(b.name)] = (counts[base(b.name)] ?? 0) + 1;
  report.bodies = counts;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const ex: Record<string, unknown> = {};
  ex.stepAll = (await raw("plasticity_export_step", { ids: final.map((b) => b.id), path: resolve(exportDir, `neoRC11-${stamp}.step`), revision: await rev() })).path ?? "ok";
  ex.stepHull = (await raw("plasticity_export_step", { ids: [hull.id], path: resolve(exportDir, `neoRC11-hull-${stamp}.step`), revision: await rev() })).path ?? "ok";
  const stl = await call("plasticity_export_stl", { ids: solids.map((b) => b.id), path: resolve(exportDir, `neoRC11-${stamp}.stl`), chordToleranceMm: 2, angleToleranceDegrees: 10, revision: await rev() });
  const obj = await call("plasticity_export_obj", { ids: final.map((b) => b.id), path: resolve(exportDir, `neoRC11-${stamp}.obj`), chordToleranceMm: 2, angleToleranceDegrees: 10, revision: await rev() });
  ex.stl = JSON.stringify(stl).slice(0, 300); ex.obj = JSON.stringify(obj).slice(0, 300);
  report.exports = ex;
} finally {
  await writeFile(resolve(outDir, "join-report.json"), JSON.stringify(report, null, 1));
  await writeFile(contPath, JSON.stringify(continuity, null, 1));
  say(JSON.stringify(report, null, 1));
  say(JSON.stringify(continuity, null, 1));
  await s.close();
}
