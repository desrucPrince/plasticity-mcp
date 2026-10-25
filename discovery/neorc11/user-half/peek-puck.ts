import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try {
  const all: any[] = [];
  const first = await s.raw("plasticity_status", { bodyLimit: 200 }); all.push(...first.bodies);
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await s.raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  console.log("undo", first.undoDepth, "bodies", all.length, "non-rc11 visible:", all.filter((b) => b.visible !== false && !(b.name ?? "").startsWith("rc11_") && b.type !== "Wire").map((b) => `${b.name}#${b.id}`).join(", ") || "none");
  for (const b of all.filter((b) => /puck|hull/.test(b.name ?? ""))) console.log(b.id, b.name, JSON.stringify(b.boundsMm));
} finally { await s.close(); }
