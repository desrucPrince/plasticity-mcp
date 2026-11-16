// Gap 2: X-sided patch (XSidedFactory, subclass of XNurbsFactory) from boundary curves and from sheet boundary edges.
import { connect, depth, undoTo, save, mcp, drive, newBodies, errText, TRACE, TRACED_COMMIT } from "./harness.ts";
const runtime = await connect();
const start = await depth(runtime);
const log: any = { start, geometry: {}, variants: {} };
let session: Awaited<ReturnType<typeof mcp>> | undefined;
try {
  session = await mcp();
  const baseIds = new Set<number>((await session.raw("plasticity_status", { bodyLimit: 200 })).bodies.map((b: any) => b.id));
  const geoIds = new Set<number>();
  const add = async (label: string, tool: string, args: any) => {
    const before = await newBodies(session!, baseIds);
    await session!.raw(tool, { ...args, revision: before.revision });
    const after = await newBodies(session!, baseIds);
    const added = after.bodies.filter((b) => !before.bodies.some((o) => o.id === b.id));
    added.forEach((b) => geoIds.add(b.id));
    log.geometry[label] = added;
    return added;
  };
  // Skew quad (4 straight Wires, corners alternate z = 0 / 10).
  const P = [[2300, 0, 0], [2340, 0, 10], [2340, 40, 0], [2300, 40, 10]];
  const quad = [];
  for (let i = 0; i < 4; i++) quad.push((await add("quad" + i, "plasticity_create_polyline", { pointsMm: [P[i], P[(i + 1) % 4]], closed: false }))[0]);
  // Curved triangle (3 interpolating NURBS Wires).
  const T = [[2300, 100, 0], [2340, 100, 0], [2320, 135, 0]];
  const mid = (a: number[], b: number[]) => a.map((v, i) => (v + b[i]) / 2 + (i === 2 ? 8 : 0));
  const tri = [];
  for (let i = 0; i < 3; i++) tri.push((await add("tri" + i, "plasticity_create_nurbs_curve", { pointsMm: [T[i], mid(T[i], T[(i + 1) % 3]), T[(i + 1) % 3]] }))[0]);
  // Five-sided planar-ish loop.
  const F = [0, 1, 2, 3, 4].map((k) => [2320 + 20 * Math.cos((2 * Math.PI * k) / 5), 220 + 20 * Math.sin((2 * Math.PI * k) / 5), k % 2 ? 4 : 0]);
  const pent = [];
  for (let i = 0; i < 5; i++) pent.push((await add("pent" + i, "plasticity_create_polyline", { pointsMm: [F[i], F[(i + 1) % 5]], closed: false }))[0]);
  // Open cylinder sheet: cylinder at (2400, 0, 0), r 10, h 20, top cap deleted.
  const [cyl] = await add("cylinder", "plasticity_create_cylinder", { centerMm: [2400, 0, 0], radiusMm: 10, heightMm: 20 });
  const info = await session.raw("plasticity_body_info", { id: cyl.id });
  log.cylInfoKeys = Object.keys(info);
  const faces = (info.faces ?? info.body?.faces) as any[];
  log.cylFaces = faces.map((f: any) => ({ id: f.id, surfaceType: f.surfaceType, center: f.centerMm ?? f.centroidMm, normal: f.normal }));
  const top = faces.find((f: any) => f.surfaceType === "Plane" && JSON.stringify(f).includes("20"));
  const st0 = await newBodies(session, baseIds);
  await session.raw("plasticity_delete_faces", { faces: [{ bodyId: cyl.id, faceId: top.id }], revision: st0.revision });
  const st1 = await newBodies(session, baseIds);
  const sheet = st1.bodies.find((b) => b.type === "Sheet" && b.boundsMm.min[0] > 2380);
  log.geometry.openCylinder = sheet;
  if (sheet) geoIds.add(sheet.id);
  const sheetInfo = await session.raw("plasticity_body_info", { id: sheet!.id });
  const boundary = ((sheetInfo.edges ?? sheetInfo.body?.edges) as any[]).filter((e: any) => (e.faceIds ?? []).length === 1);
  log.boundaryEdges = boundary.map((e: any) => ({ id: e.id, curveType: e.curveType, faceIds: e.faceIds }));
  const topEdge = boundary.find((e: any) => JSON.stringify(e).includes("20")) ?? boundary[0];
  const geoDepth = (await depth(runtime)).undo;
  log.geoDepth = geoDepth;

  const variant = async (label: string, opts: Parameters<typeof drive>[1]) => {
    const entry: any = {};
    try {
      entry.commit = await drive(runtime, opts);
      entry.readBack = (await newBodies(session!, baseIds)).bodies.filter((b) => !geoIds.has(b.id));
    } catch (error) { entry.error = errText(error); }
    entry.depthAfter = await depth(runtime);
    await undoTo(runtime, geoDepth);
    entry.depthRestored = (await depth(runtime)).undo;
    log.variants[label] = entry;
    console.log(label, JSON.stringify(entry).slice(0, 600));
  };
  const xs = (setup: string, args: any, extra: Partial<Parameters<typeof drive>[1]> = {}) => ({ command: { name: "PatchCommand" }, factory: "XSidedFactory", bindings: ["ContinuityType"], setup, args, ...extra });
  await variant("A_quad_curves", xs(`factory.curves = args.ids.map(find);`, { ids: quad.map((b) => b.id) }));
  await variant("B_triangle_curves", xs(`factory.curves = args.ids.map(find);`, { ids: tri.map((b) => b.id) }));
  await variant("C_pentagon_curves", xs(`factory.curves = args.ids.map(find);`, { ids: pent.map((b) => b.id) }));
  await variant("D_openCylinder_edge_G0", xs(`factory.edges = [edgeOf(args.sheet, args.edge)];`, { sheet: sheet!.id, edge: topEdge.id }));
  await variant("E_openCylinder_edge_G1", xs(`const e = edgeOf(args.sheet, args.edge); factory.edges = [e]; factory.setContinuityForEdge(e, B.ContinuityType.G1);`, { sheet: sheet!.id, edge: topEdge.id }));
  await variant("F_openCylinder_edge_G2", xs(`const e = edgeOf(args.sheet, args.edge); factory.edges = [e]; factory.setContinuityForEdge(e, B.ContinuityType.G2);`, { sheet: sheet!.id, edge: topEdge.id }));
  await variant("G_openCylinder_edge_continuityAll_G1", xs(`factory.edges = [edgeOf(args.sheet, args.edge)]; factory.continuity = B.ContinuityType.G1;`, { sheet: sheet!.id, edge: topEdge.id }));
  await variant("H_quad_curves_spans4_degree5", xs(`factory.curves = args.ids.map(find); factory.uSpans = 4; factory.vSpans = 4; factory.uDegree = 5; factory.vDegree = 5;`, { ids: quad.map((b) => b.id) }));
} catch (error) {
  log.fatal = errText(error);
  console.error(error);
} finally {
  try { await session?.close(); } catch {}
  log.end = await undoTo(runtime, start.undo);
  log.endOk = log.end.undo === start.undo && log.end.bodies === start.bodies;
  save("probe-xsided.json", log);
  runtime.close();
  process.exit(0);
}
