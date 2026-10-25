import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try {
  const st = await s.raw("plasticity_status", { bodyLimit: 200 });
  console.log("undo", st.undoDepth, "bodies", st.bodies.length);
  const c: Record<string, number> = {};
  for (const b of st.bodies) { const k = `${b.name}|${b.type}|${b.visible === false ? "hidden" : "vis"}`; c[k] = (c[k] ?? 0) + 1; }
  for (const [k, v] of Object.entries(c)) console.log(v, k);
  const hull = st.bodies.filter((b: any) => ["rc11_hull", "Solid.001"].includes(b.name));
  for (const h of hull) console.log("HULL", h.id, h.name, h.faceCount, JSON.stringify(h.boundsMm));
  const inst = (await s.raw("plasticity_call", { toolName: "plasticity_list_instances", arguments: {} })).instances;
  console.log("instances left", inst.length);
} finally { await s.close(); }
