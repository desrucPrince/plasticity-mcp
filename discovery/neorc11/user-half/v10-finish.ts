// Validates every EDIT SIDE and GYRO body, saves RC1BaseMeshV10.plasticity (never overwriting), and takes top and
// rear 3/4 screenshots of the live-mirrored ship.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openSession } from "../../mcp-client.ts";
const V10 = "/Users/neocortez/Library/Mobile Documents/com~apple~CloudDocs/ExportsJUN25/plasticity/RC1BaseMeshV10.plasticity";
const s = await openSession();
const call = (t: string, a: Record<string, unknown> = {}) => s.raw("plasticity_call", { toolName: t, arguments: a });
try {
  const groups = (await call("plasticity_list_groups")).groups ?? [];
  const ids = groups.filter((g: any) => g.name === "EDIT SIDE" || g.name === "GYRO (centreline)").flatMap((g: any) => g.bodyIds);
  const first = await s.raw("plasticity_status", { bodyLimit: 200 }); const all = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await s.raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  const solids = all.filter((b) => ids.includes(b.id) && b.type === "Solid").map((b) => b.id);
  const v = await call("plasticity_validate_bodies", { ids: solids, revision: first.revision });
  const rows = v.bodies ?? [];
  console.log(`validate ${rows.filter((x: any) => x.closed && x.nativeValid).length}/${rows.length}`, rows.filter((x: any) => !x.closed || !x.nativeValid).map((x: any) => x.name).join(","));
  if (existsSync(V10)) throw new Error("V10 exists");
  console.log("saved", (await call("plasticity_save_copy", { path: V10 })).path);
  await call("plasticity_set_view", { view: "top", fit: true });
  await new Promise((r) => setTimeout(r, 1200));
  await s.raw("plasticity_screenshot", { path: resolve(`discovery/neorc11/user-half/review-v10/top-${Date.now()}.png`) });
  await call("plasticity_set_camera", { eyeMm: [11000, -19000, 11000], targetMm: [0, -500, 2800], frameRadiusMm: 9000 });
  await new Promise((r) => setTimeout(r, 1200));
  await s.raw("plasticity_screenshot", { path: resolve(`discovery/neorc11/user-half/review-v10/rear34-${Date.now()}.png`) });
} finally { await s.close(); }
