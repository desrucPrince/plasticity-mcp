import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try {
  const st = await s.raw("plasticity_status", { bodyLimit: 200 });
  const names = new Map(st.bodies.map((b: any) => [b.id, b.name]));
  const inst = (await s.raw("plasticity_call", { toolName: "plasticity_list_instances", arguments: {} })).instances;
  const by: Record<string, string[]> = {};
  for (const i of inst) (by[String(names.get(i.sourceBodyIds[0]))] ??= []).push(`${i.scale[0] < 0 ? "M" : "+"}(${i.translationMm.map(Math.round).join(",")})${i.visible ? "" : " HIDDEN"}`);
  for (const [k, v] of Object.entries(by)) console.log(k, v.length, v.join(" "));
} finally { await s.close(); }
