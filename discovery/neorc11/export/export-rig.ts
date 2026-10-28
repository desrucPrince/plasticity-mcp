// Exports the neoRC 11 (V18, live-mirrored document) for rigging in Blender: one OBJ with every visible source body
// (millimetres, Z up, nose +Y), plus bodies.json (id, name, bounds, material, groups) and instances.json (linked and
// mirrored copies with their world matrices) so the Blender build can recreate every copy. Also a STEP of the sources.
// Usage: PLASTICITY_CDP_URL=http://127.0.0.1:9223 node discovery/neorc11/export/export-rig.ts
import { readdir, rename, rmdir, writeFile, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openSession } from "../../mcp-client.ts";
const dir = resolve("discovery/neorc11/export/v18-rig");
const s = await openSession();
const raw = (n: string, a: Record<string, unknown> = {}) => s.raw(n, a);
const call = (t: string, a: Record<string, unknown> = {}) => raw("plasticity_call", { toolName: t, arguments: a });
async function bodies(): Promise<{ revision: string; all: any[] }> {
  const first = await raw("plasticity_status", { bodyLimit: 200 }); const all = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  return { revision: first.revision, all };
}
const flatten = async (sub: string) => {
  for (const d of (await readdir(dir)).filter((n) => n.startsWith(".plasticity-"))) {
    for (const f of await readdir(resolve(dir, d))) await rename(resolve(dir, d, f), resolve(dir, f));
    await rmdir(resolve(dir, d));
  }
  return sub;
};
try {
  const { revision, all } = await bodies();
  const keep = all.filter((b) => b.visible !== false && b.type !== "Wire" && !(b.name ?? "").startsWith("rc11_tmp"));
  const groups = ((await call("plasticity_list_groups")).groups ?? []) as any[];
  const groupOf = (key: "bodyIds" | "instanceIds", id: number) => groups.filter((g) => (g[key] ?? []).includes(id)).map((g) => g.name);
  const inst = (((await call("plasticity_list_instances")).instances ?? []) as any[]).filter((i) => i.visible !== false && !i.hidden && i.sourceBodyIds.every((x: number) => keep.some((b) => b.id === x)));
  await writeFile(resolve(dir, "bodies.json"), JSON.stringify(keep.map((b) => ({ id: b.id, name: b.name, type: b.type, boundsMm: b.boundsMm, groups: groupOf("bodyIds", b.id), material: b.material ?? b.appearance ?? null })), null, 1));
  await writeFile(resolve(dir, "instances.json"), JSON.stringify({ note: "matrixWorldMm is column-major (three.js); it maps the source body's world geometry to the copy's world geometry", instances: inst.map((i) => ({ id: i.id, source: i.sourceBodyIds[0], name: i.targetName, matrixWorldMm: i.matrixWorldMm, scale: i.scale, groups: groupOf("instanceIds", i.id) })) }, null, 1));
  const obj = await call("plasticity_export_obj", { ids: keep.map((b) => b.id), path: resolve(dir, "neorc11_v18.obj"), chordToleranceMm: 0.2, angleToleranceDegrees: 4, revision });
  await flatten("obj");
  const step = await call("plasticity_export_step", { ids: keep.filter((b) => b.type === "Solid").map((b) => b.id), path: resolve(dir, "neorc11_v18_sources.step"), revision }).catch((e: unknown) => ({ error: String(e).slice(0, 200) }));
  await flatten("step");
  for (const f of ["gear_pivots.json", "gyro_pivots.json"]) await copyFile(resolve("discovery/neorc11", f), resolve(dir, f));
  console.log(JSON.stringify({ bodies: keep.length, instances: inst.length, obj: JSON.stringify(obj).slice(0, 300), step: JSON.stringify(step).slice(0, 200), sampleBodyKeys: Object.keys(all[0]) }));
} finally { await s.close(); }
