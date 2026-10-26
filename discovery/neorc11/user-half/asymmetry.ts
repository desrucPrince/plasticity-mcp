// Read-only: classifies every visible body as straddling X = 0, +X only or -X only, pairs one-sided bodies with a
// mirrored twin (bounds mirrored within 1 mm, same type and face count), and lists the unpaired ones.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try {
  const all: any[] = [];
  const first = await s.raw("plasticity_status", { bodyLimit: 200 }); all.push(...first.bodies);
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await s.raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  const vis = all.filter((b) => b.visible !== false);
  const tol = 1;
  const side = (b: any) => b.boundsMm.min[0] < -tol && b.boundsMm.max[0] > tol ? "both" : b.boundsMm.min[0] >= -tol ? "+X" : "-X";
  const pos = vis.filter((b) => side(b) === "+X"), neg = vis.filter((b) => side(b) === "-X"), both = vis.filter((b) => side(b) === "both");
  const twin = (a: any, pool: any[]) => pool.find((b) => b.type === a.type && b.faceCount === a.faceCount
    && Math.abs(b.boundsMm.max[0] + a.boundsMm.min[0]) < tol && Math.abs(b.boundsMm.min[0] + a.boundsMm.max[0]) < tol
    && [1, 2].every((i) => Math.abs(b.boundsMm.min[i] - a.boundsMm.min[i]) < tol && Math.abs(b.boundsMm.max[i] - a.boundsMm.max[i]) < tol));
  const negLeft = new Set(neg.map((b) => b.id));
  const posUnpaired: any[] = [];
  for (const a of pos) { const t = twin(a, neg.filter((b) => negLeft.has(b.id))); if (t) negLeft.delete(t.id); else posUnpaired.push(a); }
  const negUnpaired = neg.filter((b) => negLeft.has(b.id));
  const f = (b: any) => `${b.name ?? "(unnamed)"}#${b.id} ${b.type} faces ${b.faceCount} [${b.boundsMm.min.map(Math.round)}]..[${b.boundsMm.max.map(Math.round)}]`;
  const report = { doc: first.title, undo: first.undoDepth, total: all.length, visible: vis.length, hidden: all.length - vis.length,
    plusX: pos.length, minusX: neg.length, straddling: both.map(f), pairs: pos.length - posUnpaired.length, plusUnpaired: posUnpaired.map(f), minusUnpaired: negUnpaired.map(f),
    nonRc11: vis.filter((b) => !(b.name ?? "").startsWith("rc11_")).map(f) };
  await writeFile(resolve("discovery/neorc11/user-half/asymmetry.json"), JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ ...report, straddling: report.straddling.length, plusUnpaired: report.plusUnpaired, minusUnpaired: report.minusUnpaired }, null, 1).slice(0, 6000));
  console.log("STRADDLING:\n" + report.straddling.join("\n"));
} finally { await s.close(); }
