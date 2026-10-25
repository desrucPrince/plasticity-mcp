// Exports a fine render mesh (OBJ, one object per body) of the joined neoRC 11 for Blender.
import { resolve } from "node:path";
import { rename, readdir, rmdir } from "node:fs/promises";
import { openSession } from "../../mcp-client.ts";
const dir = resolve("discovery/neorc11/render");
const s = await openSession();
try {
  const st = await s.raw("plasticity_status", { bodyLimit: 200 });
  const ids = st.bodies.filter((b: any) => b.visible !== false && b.type !== "Wire" && (b.name ?? "").startsWith("rc11_")).map((b: any) => b.id);
  const out = await s.raw("plasticity_call", { toolName: "plasticity_export_obj", arguments: { ids, path: resolve(dir, "neorc11_render.obj"), chordToleranceMm: 0.3, angleToleranceDegrees: 5, revision: st.revision } });
  console.log(JSON.stringify(out).slice(0, 400));
  for (const d of (await readdir(dir)).filter((n) => n.startsWith(".plasticity-obj-"))) {
    for (const f of await readdir(resolve(dir, d))) await rename(resolve(dir, d, f), resolve(dir, f));
    await rmdir(resolve(dir, d));
  }
} finally { await s.close(); }
