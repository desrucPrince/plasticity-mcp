// Gap 3: ExtendSheetFactory shape / bias / type=Target options and ExtendEdgeFactory.
import { connect, depth, undoTo, save, mcp, drive, newBodies, errText, TRACE, TRACED_COMMIT, lastReads } from "./harness.ts";
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
  const [arch] = await add("arch", "plasticity_create_nurbs_curve", { pointsMm: [[2500, 0, 0], [2520, 0, 10], [2540, 0, 0]] });
  const sheetAdded = await add("archSheet", "plasticity_extrude_curves", { ids: [arch.id], distanceMm: 20, direction: [0, 1, 0] });
  const sheet = sheetAdded.find((b) => b.type === "Sheet")!;
  const [target] = await add("targetBox", "plasticity_create_box", { originMm: [2555, -5, -30], sizeMm: [10, 30, 40] });
  const [solid] = await add("solidBox", "plasticity_create_box", { originMm: [2600, 0, 0], sizeMm: [20, 20, 20] });
  const info = await session.raw("plasticity_body_info", { id: sheet.id });
  const edges = info.body.edges as any[];
  log.sheetEdgeSample = edges[0];
  const boundary = edges.filter((e: any) => e.faceIds.length === 1);
  const endEdge = boundary.find((e: any) => JSON.stringify(e.boundsMm ?? e.midpointMm ?? e).match(/254\d/) && e.curveType !== "Nurbs") ?? boundary[0];
  log.endEdge = endEdge;
  const solidInfo = await session.raw("plasticity_body_info", { id: solid.id });
  const solidEdge = solidInfo.body.edges[0];
  log.solidEdge = solidEdge;
  const solidFace = solidInfo.body.faces[0];
  const geoDepth = (await depth(runtime)).undo;
  log.geoDepth = geoDepth;

  const variant = async (label: string, opts: Parameters<typeof drive>[1]) => {
    const entry: any = {};
    try {
      entry.commit = await drive(runtime, opts);
      entry.readBack = (await newBodies(session!, baseIds)).bodies.filter((b) => !geoIds.has(b.id) || b.id === sheet.id || b.id === solid.id);
    } catch (error) { entry.error = errText(error); }
    const reads = await lastReads(runtime);
    if (reads) entry.protoReads = reads;
    entry.depthAfter = await depth(runtime);
    await undoTo(runtime, geoDepth);
    entry.depthRestored = (await depth(runtime)).undo;
    log.variants[label] = entry;
    console.log(label, JSON.stringify(entry).slice(0, 700));
  };
  const ext = (extra: string, args: any = {}) => ({ command: { name: "ExtendSheetCommand" }, factory: "ExtendSheetFactory", bindings: ["ExtensionShape", "BodyExtensionType", "ExtensionLimit"],
    setup: `const view = find(args.sheet); const i = view.high.edges.versionIds.indexOf(args.edge); factory.edges = [view.high.edges.get(i)];
      factory.distance = 0.01; factory.shape = B.ExtensionShape.Linear; factory.type = B.BodyExtensionType.Distance; factory.limit = B.ExtensionLimit.Minimal; factory.modify = true; ${extra}`,
    args: { sheet: sheet.id, edge: endEdge.id, ...args } });
  for (const shape of ["Linear", "Soft", "Reflective", "Natural", "Arc"]) await variant("shape_" + shape, ext(`factory.shape = B.ExtensionShape.${shape};`));
  await variant("soft_bias_0.1", ext(`factory.shape = B.ExtensionShape.Soft; factory.bias = 0.1;`));
  await variant("soft_bias_0.9", ext(`factory.shape = B.ExtensionShape.Soft; factory.bias = 0.9;`));
  await variant("natural_bias_0.1", ext(`factory.shape = B.ExtensionShape.Natural; factory.bias = 0.1;`));
  await variant("modify_false", ext(`factory.modify = false;`));
  await variant("type_Target_box", ext(`factory.type = B.BodyExtensionType.Target; factory.target = find(args.target);`, { target: target.id }));
  await variant("type_Bbox", ext(`factory.type = B.BodyExtensionType.Bbox;`));
  // ExtendEdgeFactory: shell + edges, no distance field.
  await variant("extendEdge_sheet_traced", { command: { name: "ExtendCommand" }, factory: "ExtendEdgeFactory", setup: `${TRACE} factory.shell = find(args.sheet); factory.edges = [edgeOf(args.sheet, args.edge)];`, commit: TRACED_COMMIT, args: { sheet: sheet.id, edge: endEdge.id } });
  await variant("extendEdge_solid_traced", { command: { name: "ExtendCommand" }, factory: "ExtendEdgeFactory", setup: `${TRACE} factory.shell = find(args.solid); factory.edges = [edgeOf(args.solid, args.edge)];`, commit: TRACED_COMMIT, args: { solid: solid.id, edge: solidEdge.id } });
  await variant("extendEdge_sheet_distance10", { command: { name: "ExtendCommand" }, factory: "ExtendEdgeFactory", setup: `${TRACE} factory.shell = find(args.sheet); factory.edges = [edgeOf(args.sheet, args.edge)]; factory.distance = 0.01;`, commit: TRACED_COMMIT, args: { sheet: sheet.id, edge: endEdge.id } });
} catch (error) {
  log.fatal = errText(error);
  console.error(error);
} finally {
  try { await session?.close(); } catch {}
  log.end = await undoTo(runtime, start.undo);
  log.endOk = log.end.undo === start.undo && log.end.bodies === start.bodies;
  save("probe-extend.json", log);
  runtime.close();
  process.exit(0);
}
