// Recovery: deletes every linked instance and every visible rc11 detail body except rc11_hull and the +X visor,
// so the details can be rebuilt cleanly. Hidden bodies (blockout_ref, construction curves) are untouched.
import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try {
  const call = (toolName: string, args: Record<string, unknown> = {}) => s.raw("plasticity_call", { toolName, arguments: args });
  const inst = (await call("plasticity_list_instances")).instances ?? [];
  if (inst.length) await call("plasticity_delete_instances", { ids: inst.map((i: any) => i.id), revision: (await s.raw("plasticity_status", { bodyLimit: 200 })).revision });
  const st = await s.raw("plasticity_status", { bodyLimit: 200 });
  const drop = st.bodies.filter((b: any) => b.visible !== false && b.type !== "Wire" && (b.name ?? "").startsWith("rc11_") && b.name !== "rc11_hull"
    && !((b.name ?? "").startsWith("rc11_Visor") && b.boundsMm.min[0] > -1));
  if (drop.length) await s.raw("plasticity_delete", { ids: drop.map((b: any) => b.id), revision: st.revision });
  const after = await s.raw("plasticity_status", { bodyLimit: 200 });
  console.log("instances deleted", inst.length, "bodies deleted", drop.length, "bodies now", after.bodies.length, "visible rc11:", after.bodies.filter((b: any) => b.visible !== false && (b.name ?? "").startsWith("rc11_")).map((b: any) => b.name).join(", "));
} finally { await s.close(); }
