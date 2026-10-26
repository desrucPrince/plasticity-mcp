import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try {
  const r = await s.raw("plasticity_call", { toolName: "plasticity_list_regions", arguments: {} });
  console.log(JSON.stringify(r).slice(0, 1500));
} finally { await s.close(); }
