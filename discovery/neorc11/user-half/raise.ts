// Raises the whole ship +800 mm in Z: every body (hidden ones and sketch curves included) except the 1.8 m scale
// figures, which stay on the ground. Linked and mirrored instances follow their moved sources (they are not moved
// themselves). Checks afterwards that instance transforms are unchanged and reports the new heights.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openSession } from "../../mcp-client.ts";
const DZ = 800;
const s = await openSession();
const raw = (n: string, a: Record<string, unknown> = {}) => s.raw(n, a);
const call = (t: string, a: Record<string, unknown> = {}) => raw("plasticity_call", { toolName: t, arguments: a });
const rev = async () => (await raw("plasticity_status", { bodyLimit: 1 })).revision as string;
async function bodies(): Promise<any[]> {
  const first = await raw("plasticity_status", { bodyLimit: 200 }); const all = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  return all;
}
try {
  const before = await bodies();
  const instBefore = ((await call("plasticity_list_instances")).instances ?? []) as any[];
  const move = before.filter((b) => b.name !== "rc11_ref_human");
  // move in chunks (one history step each)
  for (let k = 0; k < move.length; k += 60) await raw("plasticity_move", { ids: move.slice(k, k + 60).map((b) => b.id), deltaMm: [0, 0, DZ], revision: await rev() });
  const after = await bodies();
  const byId = new Map(after.map((b) => [b.id, b]));
  const wrong = move.filter((b) => { const a = byId.get(b.id); return !a || Math.abs(a.boundsMm.min[2] - b.boundsMm.min[2] - DZ) > 0.01; }).map((b) => `${b.name}#${b.id}`);
  const instAfter = ((await call("plasticity_list_instances")).instances ?? []) as any[];
  const changed = instAfter.filter((i) => { const o = instBefore.find((x) => x.id === i.id); return !o || o.matrixWorldMm.some((v: number, k: number) => Math.abs(v - i.matrixWorldMm[k]) > 1e-6); }).length;
  const vis = after.filter((b) => b.visible !== false && b.type !== "Wire" && b.name !== "rc11_ref_human");
  const hull = after.find((b) => b.name === "rc11_hull");
  const report = { moved: move.length, notMovedBy800: wrong, instances: instAfter.length, instanceTransformsChanged: changed,
    lowestZ: Math.round(Math.min(...vis.map((b) => b.boundsMm.min[2]))), hullZ: [Math.round(hull.boundsMm.min[2]), Math.round(hull.boundsMm.max[2])],
    gyroZ: [Math.round(Math.min(...vis.filter((b) => (b.name ?? "").startsWith("rc11_Gyro")).map((b) => b.boundsMm.min[2]))), Math.round(Math.max(...vis.filter((b) => (b.name ?? "").startsWith("rc11_Gyro")).map((b) => b.boundsMm.max[2])))] };
  await writeFile(resolve("discovery/neorc11/user-half/raise-report.json"), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
} finally { await s.close(); }
