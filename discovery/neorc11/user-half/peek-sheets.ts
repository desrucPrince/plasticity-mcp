import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try {
  const all: any[] = [];
  const first = await s.raw("plasticity_status", { bodyLimit: 200 }); all.push(...first.bodies);
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await s.raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  for (const b of all.filter((b) => b.type === "Sheet" || (b.boundsMm.max[2] > 4495 && b.visible !== false))) console.log(b.id, b.name, b.type, b.visible, b.boundsMm.min.map(Math.round).join(","), "→", b.boundsMm.max.map(Math.round).join(","));
  const sel = await s.raw("plasticity_current_selection").catch((e: unknown) => String(e).slice(0, 100));
  console.log("selection", JSON.stringify(sel).slice(0, 300));
} finally { await s.close(); }
