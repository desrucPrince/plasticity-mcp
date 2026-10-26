import { openSession } from "../../mcp-client.ts";
const s = await openSession();
const call = (t: string, a: Record<string, unknown> = {}) => s.raw("plasticity_call", { toolName: t, arguments: a });
try {
  const inst = (await call("plasticity_list_instances")).instances ?? [];
  const groups = (await call("plasticity_list_groups")).groups ?? [];
  const sheetInst = inst.filter((i: any) => /Face sheet/.test(i.targetName ?? ""));
  console.log("instances", inst.length, "sheet instances", JSON.stringify(sheetInst.map((i: any) => ({ id: i.id, src: i.sourceBodyIds, scale: i.scale }))));
  for (const g of groups) console.log("group", g.id, JSON.stringify(g.name), "bodies", g.bodyIds.length, "instances", g.instanceIds.length, "parent", g.parentId);
  console.log("scratch left:", inst.filter((i: any) => /propagation/.test(i.targetName ?? "")).length);
} finally { await s.close(); }
