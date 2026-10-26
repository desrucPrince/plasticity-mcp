// Read-only z-fighting scan: planar faces of every visible detail body that lie in the same plane as a planar hull
// face (same facing direction, offset < 0.05 mm, overlapping bounds); also +X sources whose faces cross X = 0.
import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try {
  const first = await s.raw("plasticity_status", { bodyLimit: 200 }); const all = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await s.raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  const vis = all.filter((b) => b.visible !== false && b.type !== "Wire");
  const hull = vis.find((b) => b.name === "rc11_hull");
  const hf = ((await s.raw("plasticity_body_info", { id: hull.id })).body.faces as any[]).filter((f) => f.planar);
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const overlap = (a: any, b: any) => [0, 1, 2].every((i) => a.boundsMm.min[i] <= b.boundsMm.max[i] + 0.05 && b.boundsMm.min[i] <= a.boundsMm.max[i] + 0.05);
  const hits: string[] = [], crossing: string[] = [];
  for (const b of vis.filter((x) => x.id !== hull.id)) {
    const faces = (await s.raw("plasticity_body_info", { id: b.id })).body.faces as any[];
    if (b.boundsMm.max[0] > 0.5 && Math.min(...faces.map((f) => f.boundsMm.min[0])) < -0.01 && !(b.name ?? "").startsWith("rc11_Gyro")) crossing.push(`${b.name}#${b.id}`);
    for (const f of faces.filter((x) => x.planar)) {
      for (const h of hf) {
        if (dot(f.normal, h.normal) < 0.9999) continue;
        if (Math.abs(dot(f.normal, [f.centerMm[0] - h.centerMm[0], f.centerMm[1] - h.centerMm[1], f.centerMm[2] - h.centerMm[2]])) > 0.05) continue;
        if (!overlap(f, h)) continue;
        hits.push(`${b.name}#${b.id} face ${f.id} on hull face ${h.id} (normal ${f.normal.map((v: number) => v.toFixed(2))}, centre ${f.centerMm.map(Math.round)})`);
      }
    }
  }
  console.log("coplanar same-facing detail/hull faces:", hits.length); for (const h of hits) console.log("  ", h);
  console.log("+X sources crossing X=0:", crossing.join(", ") || "none");
} finally { await s.close(); }
