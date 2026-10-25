import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try {
  const st = await s.raw("plasticity_status");
  const ids = st.bodies.filter((b: any) => ["Solid.001", "Solid.003"].includes(b.name)).map((b: any) => b.id);
  const v = await s.raw("plasticity_call", { toolName: "plasticity_validate_bodies", arguments: { ids, revision: st.revision } }); console.log(JSON.stringify(v).slice(0, 900));
  const b = (await s.raw("plasticity_body_info", { id: ids[0] })).body;
  for (const e of b.edges.filter((e: any) => e.faceIds.length !== 2)) console.log(JSON.stringify(e).slice(0, 400));
  for (const f of b.faces.filter((f: any) => f.boundsMm.min[1] > 4680 && f.boundsMm.max[1] < 4720)) console.log("face", JSON.stringify(f).slice(0, 300));
} finally { await s.close(); }
