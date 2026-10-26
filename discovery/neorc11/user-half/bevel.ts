// Rounds the exposed sharp edges of the gear and lift sources (linked copies and mirrors follow). A sharp edge joins
// two non-blend faces at more than ~10°. Each part has a size (fillet, or chamfer for telescope lips); a failed
// group retries edge by edge at the size, then half, then a chamfer. Then: hull cut lips checked for their 10 mm
// rounds, validity, retract and lift-flush checks on temporary copies, and a sharp-edge recount.
// Usage: PLASTICITY_CDP_URL=http://127.0.0.1:9223 node discovery/neorc11/user-half/bevel.ts
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openSession } from "../../mcp-client.ts";
const s = await openSession();
const raw = (n: string, a: Record<string, unknown> = {}) => s.raw(n, a);
const call = (t: string, a: Record<string, unknown> = {}) => raw("plasticity_call", { toolName: t, arguments: a });
const rev = async () => (await raw("plasticity_status", { bodyLimit: 1 })).revision as string;
async function bodies(): Promise<any[]> {
  const first = await raw("plasticity_status", { bodyLimit: 200 }); const all = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  return all;
}
const info = async (id: number) => (await raw("plasticity_body_info", { id })).body as { edges: any[]; faces: any[] };
const r1 = (v: number) => Math.round(v * 10) / 10;
async function sharp(id: number) {
  const b = await info(id); const F = new Map(b.faces.map((f) => [f.id, f]));
  return b.edges.filter((e) => {
    const [a, c] = (e.faceIds as string[]).map((x) => F.get(x));
    if (!a || !c || a === c || a.blendRadiusMm != null || c.blendRadiusMm != null) return false;
    if (a.planar && c.planar) return Math.abs(a.normal[0] * c.normal[0] + a.normal[1] * c.normal[1] + a.normal[2] * c.normal[2]) < 0.985;
    return true;
  });
}
type Spec = { r: number; kind?: "fillet" | "chamfer"; g2?: boolean; pick?: (e: any) => boolean };
const op = async (id: number, edgeIds: string[], r: number, kind: "fillet" | "chamfer", g2 = false) => kind === "fillet"
  ? raw("plasticity_fillet", { id, edgeIds, radiusMm: r, ...(g2 ? { shape: "g2" } : {}), revision: await rev() })
  : raw("plasticity_chamfer", { id, edgeIds, distanceMm: r, revision: await rev() });
const key = (e: any) => `${e.centerMm.map(Math.round)}|${Math.round(e.lengthMm)}`;
const log: Record<string, unknown>[] = [];
async function round(name: string, id: number, specs: Spec[]) {
  const row: Record<string, unknown> = { part: name, id, before: (await sharp(id)).length, done: [] as string[], fallbacks: [] as string[] };
  for (const sp of specs) {
    const kind = sp.kind ?? "fillet";
    const edges = (await sharp(id)).filter(sp.pick ?? (() => true));
    if (!edges.length) continue;
    try { await op(id, edges.map((e) => e.id), sp.r, kind, sp.g2); (row.done as string[]).push(`${edges.length} × ${kind} ${sp.r}${sp.g2 ? " G2" : ""}`); continue; } catch { /* edge by edge */ }
    for (const k of edges.map(key)) {
      const e = (await sharp(id)).find((x) => key(x) === k); if (!e) continue;
      const tries: Array<[number, "fillet" | "chamfer"]> = [[sp.r, kind], [sp.r / 2, kind], [Math.max(0.5, sp.r / 2), "chamfer"]];
      let ok = "";
      for (const [r, kd] of tries) { try { await op(id, [e.id], r, kd); ok = `${kd} ${r}`; break; } catch { /* next */ } }
      (row.fallbacks as string[]).push(`${k}: ${ok || "FAILED"}`);
    }
  }
  row.after = (await sharp(id)).length;
  log.push(row); console.log(JSON.stringify(row));
}
const isCircle = (r: number) => (e: any) => e.circle && Math.abs(e.circleGeometry.radiusMm - r) < 1;
try {
  const all = await bodies();
  const src = (n: string) => all.find((b) => b.name === n)?.id as number;
  const plan: Array<[string, Spec[]]> = [
    ["rc11_lg_trunnion", [{ r: 5 }]],
    ["rc11_lg_strut", [{ r: 6 }]],
    ["rc11_lg_stage", [{ r: 3, kind: "chamfer" }]],
    ["rc11_lg_slider", [{ r: 4 }]],
    ["rc11_lg_fork", [{ r: 5, pick: (e) => !isCircle(75)(e) }, { r: 3 }]],
    ["rc11_lg_knuckle", [{ r: 5 }]],
    ["rc11_lg_foot", [{ r: 12, pick: isCircle(400) }, { r: 4, pick: isCircle(310) }, { r: 1.5 }]],
    ["rc11_lg_brace", [{ r: 4 }]],
    ["rc11_lg_actuator", [{ r: 4 }]],
    ["rc11_lg_actuator_rod", [{ r: 3 }]],
    ["rc11_lg_door_inner", [{ r: 4 }]], ["rc11_lg_door_outer", [{ r: 4 }]],
    ["rc11_lg_liner", [{ r: 3 }]],
    ["rc11_hatch_liner_side", [{ r: 3 }]], ["rc11_hatch_liner_front", [{ r: 3 }]], ["rc11_hatch_liner_rear", [{ r: 3 }]], ["rc11_hatch_liner_ceiling", [{ r: 3 }]],
    ["rc11_hatch_ceiling_light", [{ r: 1.5 }]], ["rc11_hatch_light", [{ r: 1.5 }]],
    ["rc11_hatch_ram_housing", [{ r: 8 }]],
    ["rc11_hatch_ram_stage_1", [{ r: 2, kind: "chamfer" }]], ["rc11_hatch_ram_stage_2", [{ r: 2, kind: "chamfer" }]], ["rc11_hatch_ram_stage_3", [{ r: 2, kind: "chamfer" }]],
    ["rc11_hatch_platform", [{ r: 6 }]],
    ["rc11_hatch_rib", [{ r: 2 }]], ["rc11_hatch_platform_light", [{ r: 1.5 }]],
    ["rc11_hatch_rail", [{ r: 5, pick: (e) => e.circle && e.faceIds && e.circleGeometry.radiusMm >= 13 }, { r: 3 }]],
  ];
  for (const [n, sp] of plan) await round(n, src(n), sp);
  // ---- hull cut lips: rounded faces along the belly openings
  const hull = all.find((b) => b.name === "rc11_hull");
  const hf = (await info(hull.id)).faces;
  const near = (lo: number[], hi: number[]) => hf.filter((f) => f.blendRadiusMm != null && f.boundsMm.min[2] > 2000 && f.boundsMm.max[2] < 2080 && f.boundsMm.max[0] > lo[0]! && f.boundsMm.min[0] < hi[0]! && f.boundsMm.max[1] > lo[1]! && f.boundsMm.min[1] < hi[1]!);
  const lips = { frontBay: near([1150, 2600], [2050, 4560]), rearBay: near([1150, -5000], [2050, -3040]), hatch: near([-10, 1690], [660, 3910]) };
  const hullSharp = (await sharp(hull.id)).filter((e) => e.boundsMm.min[2] > 2000 && e.boundsMm.max[2] < 2080 && e.boundsMm.max[0] > 0 && ((e.boundsMm.min[0] > 1150 && e.boundsMm.max[0] < 2050) || e.boundsMm.max[0] < 660) && ((e.boundsMm.min[1] > 1690 && e.boundsMm.max[1] < 4560) || (e.boundsMm.min[1] > -5000 && e.boundsMm.max[1] < -3040)));
  const lipReport = Object.fromEntries(Object.entries(lips).map(([k, v]) => [k, { roundFaces: v.length, radii: [...new Set(v.map((f) => r1(f.blendRadiusMm)))] }]));
  console.log("hull lips", JSON.stringify(lipReport), "sharp lip edges", hullSharp.length);
  // ---- validity
  const now = await bodies();
  const mine = now.filter((b) => /^rc11_(lg|hatch)_/.test(b.name ?? "") && b.type === "Solid");
  const v = await call("plasticity_validate_bodies", { ids: [hull.id, ...mine.map((b) => b.id)], revision: await rev() });
  const rows = (v.bodies ?? []) as any[];
  // ---- retract fit (one leg) and lift flush on temporary copies
  const id = (n: string) => now.find((b) => b.name === n)!.id as number;
  const moving = ["rc11_lg_strut", "rc11_lg_stage", "rc11_lg_slider", "rc11_lg_fork", "rc11_lg_knuckle", "rc11_lg_foot"].map(id);
  let pre = new Set(now.map((b) => b.id));
  await call("plasticity_duplicate_bodies", { ids: moving, revision: await rev() });
  const temps = (await bodies()).filter((b) => !pre.has(b.id));
  const tn = (re: RegExp) => temps.filter((b) => re.test(b.name ?? "")).map((b) => b.id);
  await raw("plasticity_move", { ids: tn(/^rc11_lg_stage/), deltaMm: [0, 0, 570], revision: await rev() });
  await raw("plasticity_move", { ids: tn(/^rc11_lg_(slider|fork|knuckle|foot)/), deltaMm: [0, 0, 800], revision: await rev() });
  await raw("plasticity_rotate", { ids: temps.map((b) => b.id), pivotMm: [1600, 4400, 2250], axis: [1, 0, 0], degrees: -90, revision: await rev() });
  const kn = (await bodies()).find((b) => b.id === tn(/^rc11_lg_knuckle/)[0]);
  await raw("plasticity_rotate", { ids: tn(/^rc11_lg_foot/), pivotMm: [0, 1, 2].map((i) => (kn.boundsMm.min[i] + kn.boundsMm.max[i]) / 2), axis: [1, 0, 0], degrees: 90, revision: await rev() });
  const st = (await bodies()).filter((b) => temps.some((t) => t.id === b.id));
  const lo = [0, 1, 2].map((i) => Math.min(...st.map((b) => b.boundsMm.min[i]))), hi = [0, 1, 2].map((i) => Math.max(...st.map((b) => b.boundsMm.max[i])));
  const clear = { xIn: lo[0]! - 1160, xOut: 2040 - hi[0]!, yFront: 4550 - hi[1]!, yRear: lo[1]! - 2610, aboveClosedDoors: lo[2]! - 2058, belowCeiling: 2429.5 - hi[2]! };
  await raw("plasticity_delete", { ids: temps.map((b) => b.id), revision: await rev() });
  pre = new Set((await bodies()).map((b) => b.id));
  await call("plasticity_duplicate_bodies", { ids: [id("rc11_hatch_platform"), id("rc11_hatch_rail")], revision: await rev() });
  const tl = (await bodies()).filter((b) => !pre.has(b.id));
  await raw("plasticity_move", { ids: tl.map((b) => b.id), deltaMm: [0, 0, 2040], revision: await rev() });
  const lifted = (await bodies()).filter((b) => tl.some((t) => t.id === b.id));
  const tp = lifted.find((b) => (b.name ?? "").startsWith("rc11_hatch_platform"))!, tr = lifted.find((b) => (b.name ?? "").startsWith("rc11_hatch_rail"))!;
  const lift = { flushErrorMm: r1(Math.abs(tp.boundsMm.min[2] - 2040)), railClearToCeilingMm: r1(4290 - tr.boundsMm.max[2]) };
  await raw("plasticity_delete", { ids: tl.map((b) => b.id), revision: await rev() });
  const report = { parts: log, hullLips: lipReport, hullSharpLipEdges: hullSharp.length, validity: { valid: rows.filter((x) => x.closed && x.nativeValid).length, of: rows.length, invalid: rows.filter((x) => !x.closed || !x.nativeValid).map((x) => x.name) },
    retract: { clearanceMm: Object.fromEntries(Object.entries(clear).map(([k, v]) => [k, Math.round(v)])), fits: Object.values(clear).every((x) => x >= 20) }, lift,
    sharpLeft: log.reduce((n, r) => n + (r.after as number), 0) };
  await writeFile(resolve("discovery/neorc11/bevel-report.json"), JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ ...report, parts: undefined }, null, 1));
} finally { await s.close(); }
