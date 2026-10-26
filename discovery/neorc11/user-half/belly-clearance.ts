// Read-only: lists visible bodies whose bounds intersect each planned belly cut-out (landing-gear bays, hatch).
import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try {
  const first = await s.raw("plasticity_status", { bodyLimit: 200 }); const all = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await s.raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  const vis = all.filter((b) => b.visible !== false && b.type !== "Wire" && b.name !== "rc11_hull");
  const zones: Record<string, [number[], number[]]> = {
    "front gear bay +X": [[1300, 3350, 900], [1900, 4250, 1300]],
    "rear gear bay +X": [[1300, -4650, 900], [1900, -3750, 1300]],
    "hatch +X half": [[0, 1700, 900], [520, 3720, 1300]],
  };
  for (const [name, [lo, hi]] of Object.entries(zones)) {
    const hits = vis.filter((b) => [0, 1, 2].every((i) => b.boundsMm.min[i] < hi[i]! && b.boundsMm.max[i] > lo[i]!));
    console.log(name, "→", hits.map((b) => `${b.name}#${b.id} [${b.boundsMm.min.map(Math.round)}]..[${b.boundsMm.max.map(Math.round)}]`).join(" | ") || "clear");
  }
  const hull = all.find((b) => b.name === "rc11_hull");
  const faces = (await s.raw("plasticity_body_info", { id: hull.id })).body.faces as any[];
  const belly = faces.filter((f) => f.planar && f.normal[2] < -0.99).map((f) => `z ${Math.round(f.boundsMm.min[2])} x ${Math.round(f.boundsMm.min[0])}..${Math.round(f.boundsMm.max[0])} y ${Math.round(f.boundsMm.min[1])}..${Math.round(f.boundsMm.max[1])}`);
  console.log("downward planar hull faces:", belly.join(" | "));
} finally { await s.close(); }
