import { openSession } from "../mcp-client.ts";
const s = await openSession();
try {
  for (const id of [7, 6]) {
    const b = (await s.raw("plasticity_body_info", { id })).body;
    const neg = b.faces.filter((f: any) => f.boundsMm.min[0] < -1);
    console.log(id, b.name, "faces", b.faces.length, "edges", b.edges.length, "faces reaching X<0:", neg.length);
    for (const f of neg) console.log("  ", f.id, f.surfaceType, f.boundsMm.min.map(Math.round).join(","), "→", f.boundsMm.max.map(Math.round).join(","));
    const types = b.faces.reduce((m: any, f: any) => (m[f.surfaceType] = (m[f.surfaceType] ?? 0) + 1, m), {});
    console.log("   surface types", JSON.stringify(types));
    const onPlane = b.faces.filter((f: any) => f.planar && Math.abs(f.boundsMm.min[0]) < 1 && Math.abs(f.boundsMm.max[0]) < 1);
    console.log("   planar faces in X=0:", onPlane.length);
  }
} finally { await s.close(); }
