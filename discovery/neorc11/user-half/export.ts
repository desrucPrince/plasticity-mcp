// Exports the joined neoRC 11 (rc11_hull + every visible rc11 detail body) to discovery/neorc11/export/:
// STEP of everything, STEP of the hull alone, STL of all solids and OBJ of everything at 2 mm chord tolerance.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openSession } from "../../mcp-client.ts";
const exportDir = resolve("discovery/neorc11/export");
await mkdir(exportDir, { recursive: true });
const s = await openSession();
const call = (toolName: string, args: Record<string, unknown> = {}) => s.raw("plasticity_call", { toolName, arguments: args });
try {
  const st = await s.raw("plasticity_status", { bodyLimit: 200 });
  const final = st.bodies.filter((b: any) => b.visible !== false && b.type !== "Wire" && (b.name ?? "").startsWith("rc11_"));
  const hull = final.find((b: any) => b.name === "rc11_hull");
  const solids = final.filter((b: any) => b.type === "Solid");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out: Record<string, unknown> = { bodies: final.length, solids: solids.length };
  out.stepAll = await call("plasticity_export_step", { ids: final.map((b: any) => b.id), path: resolve(exportDir, `neoRC11-${stamp}.step`), revision: st.revision });
  out.stepHull = await call("plasticity_export_step", { ids: [hull.id], path: resolve(exportDir, `neoRC11-hull-${stamp}.step`), revision: st.revision });
  out.stl = await call("plasticity_export_stl", { ids: solids.map((b: any) => b.id), path: resolve(exportDir, `neoRC11-${stamp}.stl`), chordToleranceMm: 2, angleToleranceDegrees: 10, revision: st.revision });
  out.stlHull = await call("plasticity_export_stl", { ids: [hull.id], path: resolve(exportDir, `neoRC11-hull-${stamp}.stl`), chordToleranceMm: 2, angleToleranceDegrees: 10, revision: st.revision });
  out.obj = await call("plasticity_export_obj", { ids: final.map((b: any) => b.id), path: resolve(exportDir, `neoRC11-${stamp}.obj`), chordToleranceMm: 2, angleToleranceDegrees: 10, revision: st.revision });
  const rp = resolve("discovery/neorc11/user-half/join-report.json");
  const report = JSON.parse(await readFile(rp, "utf8"));
  report.exports = JSON.parse(JSON.stringify(out, (k, v) => (k === "documentToken" || k === "revision" ? undefined : v)));
  await writeFile(rp, JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report.exports).slice(0, 1500));
} finally { await s.close(); }
