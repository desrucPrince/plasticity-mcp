// Fixture builders and topology finders for the surfacing probes. All geometry sits at x >= 5000 mm,
// clear of the baseline bodies (x 0..80 mm). Every builder goes through the MCP server (mm, degrees).
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { call, status } from "./mcp.ts";

export const rev = async (client: Client) => (await status(client)).revision as string;

export async function info(client: Client, id: number) {
  return (await call(client, "plasticity_body_info", { id })).body as BodyInfo;
}

export interface FaceInfo { id: string; surfaceType: string; planar: boolean; centerMm: number[]; normal: number[] | null; radiusMm: number | null; edgeIds: string[] }
export interface EdgeInfo { id: string; curveType: string; line: boolean; circle: boolean; lengthMm: number; centerMm: number[]; tangent: number[] | null; faceIds: string[]; vertexIds: number[] }
export interface BodyInfo { id: number; type: string; faces: FaceInfo[]; edges: EdgeInfo[]; boundsMm: { min: number[]; max: number[] } }

const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
export const near = (a: number[] | null | undefined, b: number[], tol = 1e-3) => !!a && Math.abs(a[0]! - b[0]!) < tol && Math.abs(a[1]! - b[1]!) < tol && Math.abs(a[2]! - b[2]!) < tol;

/** Edge shared by two faces matching the two predicates (in either order). */
export function edgeBetween(body: BodyInfo, a: (f: FaceInfo) => boolean, b: (f: FaceInfo) => boolean, extra: (e: EdgeInfo) => boolean = () => true) {
  const face = (id: string) => body.faces.find((f) => f.id === id)!;
  return body.edges.filter((e) => e.faceIds.length === 2 && extra(e)).filter((e) => {
    const [f, g] = e.faceIds.map(face);
    return (a(f!) && b(g!)) || (a(g!) && b(f!));
  });
}

export const faceNormal = (n: number[]) => (f: FaceInfo) => f.planar && near(f.normal, n);
export const nonPlanar = (f: FaceInfo) => !f.planar;

export async function created(client: Client, before: Set<number>) {
  const st = await status(client);
  return (st.bodies as any[]).filter((b) => !before.has(b.id));
}

/** (a) Prism whose -y face meets a slanted face at a 30 degree normal change. Extruded 10 mm along +z. */
export async function wedge30(client: Client, x0 = 5000) {
  const before = new Set(((await status(client)).bodies as any[]).map((b) => b.id));
  const c = Math.cos(Math.PI / 6) * 20, s = Math.sin(Math.PI / 6) * 20;
  const pts = [[x0, 0, 0], [x0 + 20, 0, 0], [x0 + 20 + c, s, 0], [x0 + 20 + c, 30, 0], [x0, 30, 0]];
  await call(client, "plasticity_create_polyline", { pointsMm: pts, closed: true, intent: "probe wedge profile", revision: await rev(client) });
  const wire = (await created(client, before))[0];
  await call(client, "plasticity_extrude_profile", { id: wire.id, distanceMm: 10, intent: "probe wedge", revision: await rev(client) });
  const solid = (await created(client, before)).find((b) => b.type === "Solid");
  return { wireId: wire.id, solidId: solid.id as number };
}

/** Box 20 mm cube at origin, with its +x/+y vertical edge filleted (shape round or g2). */
export async function filletedBox(client: Client, origin: number[], radiusMm: number, shape: "round" | "g2") {
  const before = new Set(((await status(client)).bodies as any[]).map((b) => b.id));
  await call(client, "plasticity_create_box", { originMm: origin, sizeMm: [20, 20, 20], intent: "probe box", revision: await rev(client) });
  const box = (await created(client, before))[0];
  const body = await info(client, box.id);
  const corner = edgeBetween(body, faceNormal([1, 0, 0]), faceNormal([0, 1, 0]));
  if (corner.length !== 1) throw new Error("corner edge not found");
  await call(client, "plasticity_fillet", { id: box.id, edgeIds: [corner[0]!.id], radiusMm, shape, intent: "probe fillet", revision: await rev(client) });
  return { solidId: box.id as number };
}

export { dot };
