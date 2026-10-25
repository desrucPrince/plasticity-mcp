import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try {
  const st = await s.raw("plasticity_status", { bodyLimit: 200 });
  for (const b of st.bodies.filter((b: any) => b.visible !== false)) console.log(b.id, (b.name ?? "").padEnd(26), "X", Math.round(b.boundsMm.min[0]), "..", Math.round(b.boundsMm.max[0]));
  console.log("redo", st.redoDepth, "undo", st.undoDepth);
} finally { await s.close(); }
