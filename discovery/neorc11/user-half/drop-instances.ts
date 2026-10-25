// Deletes every linked instance in the document (sources stay); used before the join, which copies by duplicate.
import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try {
  const inst = (await s.raw("plasticity_call", { toolName: "plasticity_list_instances", arguments: {} })).instances ?? [];
  if (inst.length) await s.raw("plasticity_call", { toolName: "plasticity_delete_instances", arguments: { ids: inst.map((i: any) => i.id), revision: (await s.raw("plasticity_status", { bodyLimit: 200 })).revision } });
  console.log("deleted instances", inst.length);
} finally { await s.close(); }
