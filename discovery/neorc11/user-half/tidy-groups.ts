// Dissolves empty duplicate "HATCH (centreline)" groups left by a rerun (only empty ones).
import { openSession } from "../../mcp-client.ts";
const s = await openSession();
const call = (t: string, a: Record<string, unknown> = {}) => s.raw("plasticity_call", { toolName: t, arguments: a });
try {
  const groups = ((await call("plasticity_list_groups")).groups ?? []) as any[];
  const empty = groups.filter((g) => g.name === "HATCH (centreline)" && !g.bodyIds.length && !g.instanceIds.length && !g.childGroupIds.length);
  console.log("hatch groups:", groups.filter((g) => g.name === "HATCH (centreline)").map((g) => `${g.id}: ${g.bodyIds.length} bodies, ${g.instanceIds.length} instances`).join("; "));
  if (empty.length) await call("plasticity_dissolve_groups", { ids: empty.map((g) => g.id), revision: (await s.raw("plasticity_status", { bodyLimit: 1 })).revision });
  console.log("dissolved", empty.length);
} finally { await s.close(); }
