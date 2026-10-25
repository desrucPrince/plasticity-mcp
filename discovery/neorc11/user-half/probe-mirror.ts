// Live check of plasticity_mirror (keepOriginal true): the source must stay; the copy (identified by the reply's
// change.added ids) is deleted afterwards.
import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try {
  let st = await s.raw("plasticity_status", { bodyLimit: 200 });
  const src = st.bodies.find((b: any) => b.name === (process.argv[2] ?? "rc11_headlight"));
  const out = await s.raw("plasticity_mirror", { ids: [src.id], planeOriginMm: [0, 0, 0], planeNormal: [1, 0, 0], keepOriginal: true, revision: st.revision });
  st = await s.raw("plasticity_status", { bodyLimit: 200 });
  const kept = st.bodies.find((b: any) => b.id === src.id);
  const added = (out.change?.added ?? []).map((b: any) => b.id);
  const copies = st.bodies.filter((b: any) => added.includes(b.id));
  console.log("source kept:", !!kept, kept ? Math.round(kept.boundsMm.min[0]) : "", "| copies:", copies.map((b: any) => `${b.name}#${b.id} X ${Math.round(b.boundsMm.min[0])}..${Math.round(b.boundsMm.max[0])}`).join(" "));
  if (copies.length === 1 && copies[0].boundsMm.max[0] < 0) await s.raw("plasticity_delete", { ids: [copies[0].id], revision: st.revision });
} finally { await s.close(); }
