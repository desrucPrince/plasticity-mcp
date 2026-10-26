// Read-only: matches the hull's face centres across X = 0 and lists faces with no mirrored partner (one-sided edits).
import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try {
  const first = await s.raw("plasticity_status", { bodyLimit: 200 });
  const all: any[] = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await s.raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  for (const name of ["rc11_hull", "Face sheet.001"]) {
    const h = all.find((b) => b.name === name);
    const faces = (await s.raw("plasticity_body_info", { id: h.id })).body.faces as any[];
    const key = (c: number[]) => c.map((v) => Math.round(v / 2));
    const unmatched = faces.filter((f) => Math.abs(f.centerMm[0]) > 1 && !faces.some((g) => g !== f && Math.abs(g.centerMm[0] + f.centerMm[0]) < 2 && Math.abs(g.centerMm[1] - f.centerMm[1]) < 2 && Math.abs(g.centerMm[2] - f.centerMm[2]) < 2));
    console.log(name, "faces", faces.length, "one-sided faces", unmatched.length);
    for (const f of unmatched.slice(0, 20)) console.log("  ", f.surfaceType, "centre", f.centerMm.map(Math.round).join(","), "bounds", f.boundsMm.min.map(Math.round).join(","), "→", f.boundsMm.max.map(Math.round).join(","));
  }
  const ties = all.filter((b) => (b.name ?? "").startsWith("rc11_p_tiedown"));
  for (const t of ties) console.log("tiedown", t.id, t.name, t.boundsMm.min.map(Math.round).join(","), "→", t.boundsMm.max.map(Math.round).join(","));
} finally { await s.close(); }
