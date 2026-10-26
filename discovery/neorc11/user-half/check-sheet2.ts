import { openSession } from "../../mcp-client.ts";
const s = await openSession();
const call = (t: string, a: Record<string, unknown> = {}) => s.raw("plasticity_call", { toolName: t, arguments: a });
try {
  const first = await s.raw("plasticity_status", { bodyLimit: 200 }); const all = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await s.raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  const inst = (await call("plasticity_list_instances")).instances ?? [];
  const groups = (await call("plasticity_list_groups")).groups ?? [];
  for (const id of [7, 855]) {
    const b = all.find((x) => x.id === id);
    console.log(id, b?.name, b?.type, "visible", b?.visible, JSON.stringify(b?.boundsMm), "instance", inst.some((i: any) => i.sourceBodyIds.includes(id)), "groups", groups.filter((g: any) => g.bodyIds.includes(id)).map((g: any) => g.name).join(","));
  }
} finally { await s.close(); }
