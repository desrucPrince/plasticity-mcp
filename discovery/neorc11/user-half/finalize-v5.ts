// Saves the gyro state as RC1BaseMeshV5.plasticity (never overwriting), then makes the gyro instances plain bodies
// for export: the mirrored trunnion instance is replaced by a plain mirror, the bolt-ring and spoke instances are
// realized and named after their sources. Run export-v5.ts afterwards.
import { existsSync } from "node:fs";
import { openSession } from "../../mcp-client.ts";
const V5 = "/Users/neocortez/Library/Mobile Documents/com~apple~CloudDocs/ExportsJUN25/plasticity/RC1BaseMeshV5.plasticity";
const s = await openSession();
const raw = (n: string, a: Record<string, unknown> = {}) => s.raw(n, a);
const call = (t: string, a: Record<string, unknown> = {}) => raw("plasticity_call", { toolName: t, arguments: a });
const rev = async () => (await raw("plasticity_status", { bodyLimit: 1 })).revision as string;
async function bodies(): Promise<any[]> {
  const first = await raw("plasticity_status", { bodyLimit: 200 });
  const all = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  return all;
}
try {
  if (existsSync(V5)) throw new Error(`refusing to overwrite ${V5}`);
  console.log("saved", (await call("plasticity_save_copy", { path: V5 })).path);
  const inst = ((await call("plasticity_list_instances")).instances ?? []) as Array<{ id: number; sourceBodyIds: number[]; scale: number[] }>;
  const names = new Map((await bodies()).map((b) => [b.id, b.name]));
  const mirrored = inst.filter((i) => i.scale[0] < 0);
  if (mirrored.length) {
    await call("plasticity_delete_instances", { ids: mirrored.map((i) => i.id), revision: await rev() });
    const sources = [...new Set(mirrored.map((i) => i.sourceBodyIds[0]!))];
    await raw("plasticity_mirror", { ids: sources, planeOriginMm: [0, 0, 0], planeNormal: [1, 0, 0], keepOriginal: true, revision: await rev() });
    console.log("plain-mirrored", sources.map((id) => names.get(id)).join(", "));
  }
  const bySource = new Map<number, number[]>();
  for (const i of inst.filter((i) => i.scale[0] > 0)) bySource.set(i.sourceBodyIds[0]!, [...(bySource.get(i.sourceBodyIds[0]!) ?? []), i.id]);
  for (const [src, ids] of bySource) {
    const before = new Set((await bodies()).map((b) => b.id));
    await call("plasticity_realize_instances", { ids, revision: await rev() });
    const fresh = (await bodies()).filter((b) => !before.has(b.id));
    for (const b of fresh) if (b.name !== names.get(src)) await call("plasticity_rename", { id: b.id, name: names.get(src), revision: await rev() });
    console.log("realized", names.get(src), fresh.length);
  }
  console.log("instances left", ((await call("plasticity_list_instances")).instances ?? []).length);
} finally { await s.close(); }
