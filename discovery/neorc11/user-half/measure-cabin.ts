// Read-only: continuity at the tangent edges of the cabin-to-deck fillet (blend faces touching Z 3100 on the body).
import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try {
  const st = await s.raw("plasticity_status", { bodyLimit: 200 });
  const body = st.bodies.find((b: any) => b.name === "Solid.001");
  const b = (await s.raw("plasticity_body_info", { id: body.id })).body;
  const blends = new Set(b.faces.filter((f: any) => f.surfaceType === "BSurf" && f.boundsMm.min[2] < 3101 && f.boundsMm.max[2] <= 3401).map((f: any) => f.id));
  const edges = b.edges.filter((e: any) => e.faceIds.length === 2 && e.faceIds.some((f: string) => blends.has(f)));
  const res = await s.raw("plasticity_call", { toolName: "plasticity_analyze_surface_continuity", arguments: { edges: edges.map((e: any) => ({ bodyId: body.id, edgeId: e.id })), revision: st.revision } });
  for (const a of res.analyses) console.log(a.edge.edgeId, "G0", a.maximumPositionDeviationMm.toExponential(1), "G1deg", a.maximumNormalAngleDeviationDeg.toFixed(4), "relG2", Number(a.maximumRelativeCurvatureDeviation).toFixed(3));
  console.log("blend faces", blends.size, "edges", edges.length);
} finally { await s.close(); }
