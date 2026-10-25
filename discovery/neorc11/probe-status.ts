import { openSession } from "../mcp-client.ts";
const s = await openSession();
try {
  const st = await s.raw("plasticity_status", { bodyLimit: 200 });
  console.log(st.revision, "undo", st.undoDepth, "bodies", st.bodies.length);
  for (const b of st.bodies) console.log(b.id, b.name, b.type, b.visible ?? "", b.faceCount, b.boundsMm.min.map(Math.round).join(","), "→", b.boundsMm.max.map(Math.round).join(","));
  const inst = await s.raw("plasticity_list_instances").catch((e: any) => String(e));
  console.log("instances", JSON.stringify(inst).slice(0, 800));
} finally { await s.close(); }
