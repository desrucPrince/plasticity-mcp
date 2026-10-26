import { openSession } from "../../mcp-client.ts";
const s = await openSession();
const call = (t: string, a: Record<string, unknown> = {}) => s.raw("plasticity_call", { toolName: t, arguments: a });
try {
  const first = await s.raw("plasticity_status", { bodyLimit: 200 }); const all = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await s.raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  const groups = ((await call("plasticity_list_groups")).groups ?? []) as any[];
  const inst = ((await call("plasticity_list_instances")).instances ?? []) as any[];
  for (const b of all.filter((x) => /ref_human/.test(x.name ?? ""))) console.log("body", b.id, b.name, JSON.stringify(b.boundsMm.min.map(Math.round)), "groups", groups.filter((g) => g.bodyIds.includes(b.id)).map((g) => g.name).join(","), "instances", inst.filter((i) => i.sourceBodyIds.includes(b.id)).map((i) => i.id).join(","));
  for (const g of groups.filter((x) => /SCALE|HATCH/.test(x.name))) console.log("group", g.id, g.name, "bodies", g.bodyIds.join(","), "inst", g.instanceIds.join(","));
} finally { await s.close(); }
