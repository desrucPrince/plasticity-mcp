import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try {
  const st = await s.raw("plasticity_status", { bodyLimit: 1 });
  const groups = ((await s.raw("plasticity_call", { toolName: "plasticity_list_groups", arguments: {} })).groups ?? []) as any[];
  console.log("undo", st.undoDepth, "bodyCount", st.bodyCount ?? st.bodyPagination?.total);
  for (const g of groups) console.log(g.id, JSON.stringify(g.name), "parent", g.parentId, "bodies", g.bodyIds.length, "inst", g.instanceIds.length, "children", g.childGroupIds.length, g.hidden ? "hidden" : "");
} finally { await s.close(); }
