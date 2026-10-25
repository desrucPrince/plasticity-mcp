// After polish.ts: saves the editable, instanced state as RC1BaseMeshV4.plasticity (never overwriting), then turns
// the polish-pass instances into plain bodies for export (deletes the mirrored instances, realizes the +X ones,
// plain-mirrors every rc11_p_* body across X = 0), validates, and exports to discovery/neorc11/export/v4/ (STEP all,
// STEP hull, STL all solids and OBJ at 2 mm) and a 0.3 mm render mesh to discovery/neorc11/render/neorc11_render_v4.obj.
// Usage: PLASTICITY_CDP_URL=http://127.0.0.1:9223 node discovery/neorc11/user-half/finalize-v4.ts
import { mkdir, readdir, rename as mv, rmdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openSession } from "../../mcp-client.ts";

type Vec = [number, number, number];
type Body = { id: number; name: string | null; type: string; boundsMm: { min: Vec; max: Vec }; visible?: boolean; faceCount?: number };
const V4 = "/Users/neocortez/Library/Mobile Documents/com~apple~CloudDocs/ExportsJUN25/plasticity/RC1BaseMeshV4.plasticity";
const exportDir = resolve("discovery/neorc11/export/v4");
const renderDir = resolve("discovery/neorc11/render");
await mkdir(exportDir, { recursive: true });
const s = await openSession();
const raw = (name: string, args: Record<string, unknown> = {}) => s.raw(name, args);
const call = (toolName: string, args: Record<string, unknown> = {}) => raw("plasticity_call", { toolName, arguments: args });
const status = () => raw("plasticity_status", { bodyLimit: 200 });
const rev = async () => (await status()).revision as string;
// Every body, following the status pagination to the end (200 per page).
const bodies = async (): Promise<Body[]> => {
  const first = await status();
  const all = [...first.bodies];
  let next = first.bodyPagination?.nextOffset;
  while (next != null) {
    const page = await raw("plasticity_status", { bodyLimit: 200, bodyOffset: next, expectedRevision: first.revision });
    all.push(...page.bodies);
    next = page.bodyPagination?.nextOffset;
  }
  return all;
};
const instances = async () => ((await call("plasticity_list_instances")).instances ?? []) as Array<{ id: number; sourceBodyIds: number[]; scale: Vec }>;
const report: Record<string, unknown> = {};
// Move a tool's temporary OBJ material folder next to the OBJ (the export leaves geometry.mtl in a temp folder).
async function liftMtl(dir: string) {
  for (const d of (await readdir(dir)).filter((n) => n.startsWith(".plasticity-obj-"))) {
    for (const f of await readdir(resolve(dir, d))) await mv(resolve(dir, d, f), resolve(dir, f));
    await rmdir(resolve(dir, d));
  }
}

try {
  // ---- 1. checkpoint the editable state
  if (existsSync(V4)) throw new Error(`refusing to overwrite ${V4}`);
  report.saved = (await call("plasticity_save_copy", { path: V4 })).path;
  report.instancesAtSave = (await instances()).length;

  // ---- 2. plain bodies for export
  const mirrored = (await instances()).filter((i) => i.scale[0] < 0).map((i) => i.id);
  if (mirrored.length) await call("plasticity_delete_instances", { ids: mirrored, revision: await rev() });
  const names = new Map((await bodies()).map((b) => [b.id, b.name]));
  const positive = await instances();
  let realized = 0;
  // Realize per source so every new body can take its source's name.
  const bySource = new Map<number, number[]>();
  for (const i of positive) bySource.set(i.sourceBodyIds[0]!, [...(bySource.get(i.sourceBodyIds[0]!) ?? []), i.id]);
  for (const [source, group] of bySource) {
    const before = new Set((await bodies()).map((b) => b.id));
    await call("plasticity_realize_instances", { ids: group, revision: await rev() });
    const fresh = (await bodies()).filter((b) => !before.has(b.id));
    realized += fresh.length;
    const srcName = names.get(source) ?? "rc11_p_realized";
    for (const b of fresh) if (b.name !== srcName) await call("plasticity_rename", { id: b.id, name: srcName, revision: await rev() });
  }
  report.realized = { instances: positive.length, bodies: realized, left: (await instances()).length };
  const polish = (await bodies()).filter((b) => b.visible !== false && b.type !== "Wire" && (b.name ?? "").startsWith("rc11_p_"));
  const pre = new Set((await bodies()).map((b) => b.id));
  await raw("plasticity_mirror", { ids: polish.map((b) => b.id), planeOriginMm: [0, 0, 0], planeNormal: [1, 0, 0], keepOriginal: true, revision: await rev() });
  const after = await bodies();
  report.mirror = { sources: polish.length, copies: after.filter((b) => !pre.has(b.id)).length, sourcesKept: polish.every((p) => after.some((b) => b.id === p.id)) };

  // ---- 3. validate, bounds
  const final = after.filter((b) => b.visible !== false && b.type !== "Wire" && (b.name ?? "").startsWith("rc11_"));
  const solids = final.filter((b) => b.type === "Solid");
  const v = await call("plasticity_validate_bodies", { ids: solids.map((b) => b.id), revision: await rev() });
  const rows = (v.bodies ?? []) as Array<{ id: number; name: string; closed: boolean; nativeValid: boolean }>;
  const hull = final.find((b) => b.name === "rc11_hull")!;
  report.validate = { solids: rows.length, valid: rows.filter((r) => r.closed && r.nativeValid).length, invalid: rows.filter((r) => !r.closed || !r.nativeValid).map((r) => `${r.name}#${r.id}`), hull: rows.find((r) => r.id === hull.id) };
  const lo = [0, 1, 2].map((i) => Math.min(...final.map((b) => b.boundsMm.min[i]!)));
  const hi = [0, 1, 2].map((i) => Math.max(...final.map((b) => b.boundsMm.max[i]!)));
  report.bodies = { total: final.length, polish: final.filter((b) => (b.name ?? "").startsWith("rc11_p_")).length };
  report.boundsAllMm = { min: lo.map(Math.round), max: hi.map(Math.round) };

  // ---- 4. exports
  const ids = final.map((b) => b.id), solidIds = solids.map((b) => b.id);
  const r = await rev();
  const ex: Record<string, unknown> = {};
  ex.stepAll = (await call("plasticity_export_step", { ids, path: resolve(exportDir, "neoRC11-v4.step"), revision: r })).bytes;
  ex.stepHull = (await call("plasticity_export_step", { ids: [hull.id], path: resolve(exportDir, "neoRC11-v4-hull.step"), revision: r })).bytes;
  const stl = await call("plasticity_export_stl", { ids: solidIds, path: resolve(exportDir, "neoRC11-v4.stl"), chordToleranceMm: 2, angleToleranceDegrees: 10, revision: r });
  ex.stl = { bytes: stl.bytes, triangles: stl.triangles };
  const obj = await call("plasticity_export_obj", { ids, path: resolve(exportDir, "neoRC11-v4.obj"), chordToleranceMm: 2, angleToleranceDegrees: 10, revision: r });
  ex.obj = { bytes: obj.bytes, triangles: obj.triangles, boundsMm: obj.boundsMm };
  await liftMtl(exportDir);
  const ro = await call("plasticity_export_obj", { ids, path: resolve(renderDir, "neorc11_render_v4.obj"), chordToleranceMm: 0.3, angleToleranceDegrees: 5, revision: r });
  ex.renderObj = { bytes: ro.bytes, triangles: ro.triangles };
  await liftMtl(renderDir);
  report.exports = ex;
} finally {
  await writeFile(resolve("discovery/neorc11/user-half/finalize-v4-report.json"), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
  await s.close();
}
