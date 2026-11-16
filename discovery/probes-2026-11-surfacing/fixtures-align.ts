// Two separate NURBS sheets for Surface Align: A (reference) and B (to move), extruded 20 mm along +z from
// control-point curves. B's start edge sits 0.5 mm from A's end edge and leaves at a different angle.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { call, status } from "./mcp.ts";
import { rev, created, info } from "./fixtures.ts";

export async function alignSheets(client: Client, x0 = 5000) {
  const ids = async () => new Set(((await status(client)).bodies as any[]).map((b) => b.id));
  let before = await ids();
  await call(client, "plasticity_create_control_point_curve", { pointsMm: [[x0, 0, 0], [x0 + 10, 0, 0], [x0 + 20, 2, 0], [x0 + 30, 5, 0]], intent: "probe curve A", revision: await rev(client) });
  const ca = (await created(client, before))[0];
  await call(client, "plasticity_extrude_curves", { ids: [ca.id], distanceMm: 20, direction: [0, 0, 1], intent: "probe sheet A", revision: await rev(client) });
  const sa = (await created(client, before)).find((b) => b.type === "Sheet");
  before = await ids();
  await call(client, "plasticity_create_control_point_curve", { pointsMm: [[x0 + 30.5, 5.3, 0], [x0 + 38, 12, 0], [x0 + 46, 20, 0], [x0 + 54, 30, 0]], intent: "probe curve B", revision: await rev(client) });
  const cb = (await created(client, before))[0];
  await call(client, "plasticity_extrude_curves", { ids: [cb.id], distanceMm: 20, direction: [0, 0, 1], intent: "probe sheet B", revision: await rev(client) });
  const sb = (await created(client, before)).find((b) => b.type === "Sheet");
  const A = await info(client, sa.id), B = await info(client, sb.id);
  // A's end edge: the straight vertical edge with the larger x. B's start edge: the vertical edge with the smaller x.
  const vertical = (b: typeof A) => b.edges.filter((e) => e.tangent && Math.abs(Math.abs(e.tangent[2]!) - 1) < 1e-6);
  const edgeA = vertical(A).sort((p, q) => q.centerMm[0]! - p.centerMm[0]!)[0]!;
  const edgeB = vertical(B).sort((p, q) => p.centerMm[0]! - q.centerMm[0]!)[0]!;
  return { sheetA: sa.id as number, sheetB: sb.id as number, curveA: ca.id as number, curveB: cb.id as number, edgeA, edgeB, faceA: A.faces[0], faceB: B.faces[0], boundsB: B.boundsMm };
}
