import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try {
  const st = await s.raw("plasticity_status", { bodyLimit: 200 });
  const hulls = st.bodies.filter((b: any) => (b.name ?? "").startsWith("rc11_hull") || (b.faceCount ?? 0) > 100);
  for (const h of hulls) console.log(h.id, h.name, h.type, h.faceCount, h.visible, JSON.stringify(h.boundsMm));
  console.log("bodies", st.bodies.length, "undo", st.undoDepth);
} finally { await s.close(); }
