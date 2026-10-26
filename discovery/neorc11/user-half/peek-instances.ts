import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try {
  const inst = (await s.raw("plasticity_call", { toolName: "plasticity_list_instances", arguments: {} })).instances ?? [];
  const st = await s.raw("plasticity_status", { bodyLimit: 1 });
  const mirrored = inst.filter((i: any) => i.scale[0] < 0);
  console.log("doc", st.title, "undo", st.undoDepth, "instances", inst.length, "mirrored", mirrored.length, "sources", [...new Set(inst.map((i: any) => i.targetName ?? i.sourceBodyIds[0]))].slice(0, 15).join(", "));
} finally { await s.close(); }
