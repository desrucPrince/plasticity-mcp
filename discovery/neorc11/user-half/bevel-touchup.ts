// Touch-up after bevel.ts: the 90 mm outboard stretch of each gear bay's front lip (belly meets the bay's front wall
// with no round) gets the 10 mm lip round; leftover rail joint seams get a 1.5 mm try (near-tangent post-in-rail
// intersections may refuse, which is reported).
import { openSession } from "../../mcp-client.ts";
const s = await openSession();
const raw = (n: string, a: Record<string, unknown> = {}) => s.raw(n, a);
const rev = async () => (await raw("plasticity_status", { bodyLimit: 1 })).revision as string;
const st = await raw("plasticity_status", { bodyLimit: 200 }); const all = [...st.bodies];
for (let n = st.bodyPagination?.nextOffset; n != null;) { const p = await raw("plasticity_status", { bodyLimit: 200, bodyOffset: n }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
const info = async (id: number) => (await raw("plasticity_body_info", { id })).body as { edges: any[]; faces: any[] };
const tryOps = async (id: number, pick: (e: any, F: Map<string, any>) => boolean, sizes: Array<[number, "fillet" | "chamfer"]>) => {
  const out: string[] = [];
  const keys = (await (async () => { const b = await info(id); const F = new Map(b.faces.map((f) => [f.id, f])); return b.edges.filter((e) => pick(e, F)).map((e) => `${e.centerMm.map(Math.round)}|${Math.round(e.lengthMm)}`); })());
  for (const k of keys) {
    const b = await info(id); const F = new Map(b.faces.map((f) => [f.id, f]));
    const e = b.edges.find((x) => pick(x, F) && `${x.centerMm.map(Math.round)}|${Math.round(x.lengthMm)}` === k); if (!e) { out.push(`${k}: gone`); continue; }
    let ok = "";
    for (const [r, kd] of sizes) { try { await raw(kd === "fillet" ? "plasticity_fillet" : "plasticity_chamfer", { id, edgeIds: [e.id], ...(kd === "fillet" ? { radiusMm: r } : { distanceMm: r }), revision: await rev() }); ok = `${kd} ${r}`; break; } catch { /* next */ } }
    out.push(`${k}: ${ok || "refused"}`);
  }
  return out;
};
try {
  const hull = all.find((b) => b.name === "rc11_hull").id;
  console.log("hull", await tryOps(hull, (e, F) => e.line && Math.abs(e.lengthMm - 90) < 2 && Math.abs(e.centerMm[2] - 2040) < 1 && [4550, -3050].some((y) => Math.abs(e.centerMm[1] - y) < 1) && e.faceIds.every((f: string) => F.get(f)?.planar), [[10, "fillet"], [6, "fillet"], [8, "chamfer"], [4, "chamfer"]]));
  const rail = all.find((b) => b.name === "rc11_hatch_rail").id;
  console.log("rail", await tryOps(rail, (e, F) => { const [a, c] = e.faceIds.map((f: string) => F.get(f)); return a && c && a !== c && a.blendRadiusMm == null && c.blendRadiusMm == null; }, [[1.5, "fillet"], [1, "chamfer"]]));
  const v = await raw("plasticity_call", { toolName: "plasticity_validate_bodies", arguments: { ids: [hull, rail], revision: await rev() } });
  console.log(JSON.stringify(v.bodies.map((x: any) => [x.name, x.closed, x.nativeValid])));
} finally { await s.close(); }
