// Re-runs only the validate + export part of finalize-v4.ts on the current document (every page of bodies).
import { mkdir, readdir, rename as mv, rmdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openSession } from "../../mcp-client.ts";
const exportDir = resolve("discovery/neorc11/export/v5"), renderDir = resolve("discovery/neorc11/render");
await mkdir(exportDir, { recursive: true });
const s = await openSession();
const raw = (n: string, a: Record<string, unknown> = {}) => s.raw(n, a);
const call = (t: string, a: Record<string, unknown> = {}) => raw("plasticity_call", { toolName: t, arguments: a });
async function liftMtl(dir: string) {
  for (const d of (await readdir(dir)).filter((n) => n.startsWith(".plasticity-obj-"))) {
    for (const f of await readdir(resolve(dir, d))) await mv(resolve(dir, d, f), resolve(dir, f));
    await rmdir(resolve(dir, d));
  }
}
try {
  const first = await raw("plasticity_status", { bodyLimit: 200 });
  const all: any[] = [...first.bodies];
  for (let next = first.bodyPagination?.nextOffset; next != null;) {
    const page = await raw("plasticity_status", { bodyLimit: 200, bodyOffset: next, expectedRevision: first.revision });
    all.push(...page.bodies); next = page.bodyPagination?.nextOffset;
  }
  const r = first.revision;
  const final = all.filter((b) => b.visible !== false && b.type !== "Wire" && (b.name ?? "").startsWith("rc11_"));
  const solids = final.filter((b) => b.type === "Solid");
  const hull = final.find((b) => b.name === "rc11_hull");
  const v = await call("plasticity_validate_bodies", { ids: solids.map((b) => b.id), revision: r });
  const rows = v.bodies ?? [];
  const sides: Record<string, [number, number]> = {};
  for (const b of final) { const k = b.name.replace(/\.\d+$/, ""); sides[k] ??= [0, 0]; sides[k][b.boundsMm.max[0] <= 0.5 ? 1 : 0]++; }
  const lo = [0, 1, 2].map((i) => Math.min(...final.map((b) => b.boundsMm.min[i])));
  const hi = [0, 1, 2].map((i) => Math.max(...final.map((b) => b.boundsMm.max[i])));
  const out: any = { totalBodiesInDoc: all.length, exported: final.length, solids: solids.length, valid: rows.filter((x: any) => x.closed && x.nativeValid).length,
    invalid: rows.filter((x: any) => !x.closed || !x.nativeValid).map((x: any) => `${x.name}#${x.id}`), boundsAllMm: { min: lo.map(Math.round), max: hi.map(Math.round) }, sides };
  const ids = final.map((b) => b.id);
  out.stepAll = (await call("plasticity_export_step", { ids, path: resolve(exportDir, "neoRC11-v5.step"), revision: r })).bytes;
  out.stepHull = (await call("plasticity_export_step", { ids: [hull.id], path: resolve(exportDir, "neoRC11-v5-hull.step"), revision: r })).bytes;
  const stl = await call("plasticity_export_stl", { ids: solids.map((b) => b.id), path: resolve(exportDir, "neoRC11-v5.stl"), chordToleranceMm: 2, angleToleranceDegrees: 10, revision: r });
  out.stl = { bytes: stl.bytes, triangles: stl.triangles };
  const obj = await call("plasticity_export_obj", { ids, path: resolve(exportDir, "neoRC11-v5.obj"), chordToleranceMm: 2, angleToleranceDegrees: 10, revision: r });
  out.obj = { bytes: obj.bytes, triangles: obj.triangles, objects: obj.objects, boundsMm: obj.boundsMm };
  await liftMtl(exportDir);
  const ro = await call("plasticity_export_obj", { ids, path: resolve(renderDir, "neorc11_render_v5.obj"), chordToleranceMm: 0.3, angleToleranceDegrees: 5, revision: r });
  out.renderObj = { bytes: ro.bytes, triangles: ro.triangles, objects: ro.objects };
  await liftMtl(renderDir);
  await writeFile(resolve("discovery/neorc11/user-half/export-v5-report.json"), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
} finally { await s.close(); }
