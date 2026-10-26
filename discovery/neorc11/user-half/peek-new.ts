import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try {
  const all: any[] = [];
  const first = await s.raw("plasticity_status", { bodyLimit: 200 }); all.push(...first.bodies);
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await s.raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  for (const b of all.filter((b) => b.id >= 830 || !(b.name ?? "").startsWith("rc11_"))) console.log(b.id, JSON.stringify(b.name), b.type, b.visible, "faces", b.faceCount, b.boundsMm.min.map(Math.round).join(","), "→", b.boundsMm.max.map(Math.round).join(","));
} finally { await s.close(); }
