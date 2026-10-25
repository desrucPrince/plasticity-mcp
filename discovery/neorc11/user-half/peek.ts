import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try {
  const st = await s.raw("plasticity_status");
  const body = st.bodies.find((b: any) => b.name === process.argv[2]);
  const b = (await s.raw("plasticity_body_info", { id: body.id })).body;
  console.log(body.id, "faces", b.faces.length, "edges", b.edges.length, "undo", st.undoDepth);
  for (const f of b.faces) if (!f.planar) console.log(" ", f.id, f.surfaceType, f.blendRadiusMm, f.boundsMm.min.map(Math.round).join(","), "→", f.boundsMm.max.map(Math.round).join(","));
  const odd = b.edges.filter((e: any) => e.faceIds.length !== 2);
  console.log("edges without exactly 2 faces:", odd.map((e: any) => `${e.id}(${e.faceIds.length}) [${e.boundsMm.min.map(Math.round)}]..[${e.boundsMm.max.map(Math.round)}]`).join("; "));
} finally { await s.close(); }
