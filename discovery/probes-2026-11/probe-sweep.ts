// Gap 1: sweep variants. Open Wire profile -> Sheet, closed Wire profile, guide rails, SweepToolFactory.
// Builds probe geometry near x = 2000 mm, commits each variant, reads it back, undoes it, then restores the start depth.
import { connect, depth, undoTo, save, mcp, drive, newBodies, errText, TRACE, TRACED_COMMIT } from "./harness.ts";
const runtime = await connect();
const start = await depth(runtime);
const log: any = { start, geometry: {}, variants: {} };
let session: Awaited<ReturnType<typeof mcp>> | undefined;
const regionOf = `const regionById = id => {
  for (const [versionId, item] of nativeApi.geo.geometryModel) {
    if (!nativeApi.geo.automatics.has(versionId) || item.view?.constructor?.name !== 'SketchIsland') continue;
    for (let i = 0; i < (item.view.regions?.length ?? 0); i++) { const r = item.view.regions.get(i); if (String(r.versionId) === id) return r; }
  }
  throw new Error('region ' + id);
};`;
try {
  session = await mcp();
  const baseIds = new Set<number>((await session.raw("plasticity_status", { bodyLimit: 200 })).bodies.map((b: any) => b.id));
  const add = async (label: string, tool: string, args: any) => {
    const before = await newBodies(session!, baseIds);
    await session!.raw(tool, { ...args, revision: before.revision });
    const after = await newBodies(session!, baseIds);
    const added = after.bodies.filter((b) => !before.bodies.some((o) => o.id === b.id));
    log.geometry[label] = added;
    return added;
  };
  const [spine] = await add("spine", "plasticity_create_polyline", { pointsMm: [[2000, 0, 0], [2000, 0, 60]], closed: false });
  const [curvedSpine] = await add("curvedSpine", "plasticity_create_nurbs_curve", { pointsMm: [[2100, 0, 0], [2110, 0, 30], [2100, 0, 60]] });
  const [arc] = await add("openArcProfile", "plasticity_create_three_point_arc", { startMm: [1990, 0, 0], throughMm: [2000, 10, 0], endMm: [2010, 0, 0] });
  const [circle] = await add("circleProfile", "plasticity_create_circle", { centerMm: [2000, 0, 0], radiusMm: 5, normal: [0, 0, 1] });
  const [rail] = await add("rail", "plasticity_create_polyline", { pointsMm: [[2005, 0, 0], [2015, 0, 60]], closed: false });
  const [box] = await add("toolBox", "plasticity_create_box", { originMm: [2195, -5, -5], sizeMm: [10, 10, 10] });
  const [toolSpine] = await add("toolSpine", "plasticity_create_polyline", { pointsMm: [[2200, 0, 0], [2200, 40, 0]], closed: false });
  const regions = await session.raw("plasticity_list_regions");
  // Regions on the z = 0 world plane share one sketch island with document curves, so pick the circle's region by its bounds.
  const circleRegion = (regions.regions ?? regions).find((r: any) => Math.abs(r.displayBoundsMm.min[0] - 1995) < 0.01 && Math.abs(r.displayBoundsMm.max[1] - 5) < 0.01);
  log.geometry.circleRegion = circleRegion;
  const geoDepth = (await depth(runtime)).undo;
  log.geoDepth = geoDepth;

  const variant = async (label: string, opts: Parameters<typeof drive>[1]) => {
    const entry: any = {};
    try {
      entry.commit = await drive(runtime, opts);
      entry.readBack = (await newBodies(session!, baseIds)).bodies.filter((b) => !Object.values(log.geometry).flat().some((g: any) => g?.id === b.id));
    } catch (error) { entry.error = errText(error); }
    entry.depthAfter = await depth(runtime);
    await undoTo(runtime, geoDepth);
    entry.depthRestored = (await depth(runtime)).undo;
    log.variants[label] = entry;
    console.log(label, JSON.stringify(entry).slice(0, 400));
  };
  const sweep = (setup: string, args: any) => ({ command: { name: "SweepCommand" }, factory: "SweepFactory", bindings: ["SweepGuideMethod", "SweepAlignmentType"], setup, args });

  await variant("A_openWireProfile_curves", sweep(`factory.curves = [find(args.arc)]; factory.spine = find(args.spine);`, { arc: arc.id, spine: spine.id }));
  await variant("A2_openWireProfile_curvedSpine", sweep(`factory.curves = [find(args.arc)]; factory.spine = find(args.spine);`, { arc: arc.id, spine: curvedSpine.id }));
  await variant("B_closedWireProfile_curves", sweep(`factory.curves = [find(args.circle)]; factory.spine = find(args.spine);`, { circle: circle.id, spine: spine.id }));
  await variant("C0_region_noGuide", sweep(`${regionOf} factory.regions = [regionById(args.region)]; factory.spine = find(args.spine);`, { region: circleRegion?.id, spine: spine.id }));
  for (const method of ["Point", "Chord", "Curve"]) {
    await variant("C_region_guide_" + method, sweep(`${regionOf} factory.regions = [regionById(args.region)]; factory.spine = find(args.spine); factory.guides = [find(args.rail)]; factory.guideMethod = B.SweepGuideMethod[args.method]; result_guides = factory.guides.length;`.replace("result_guides = factory.guides.length;", ""), { region: circleRegion?.id, spine: spine.id, rail: rail.id, method }));
  }
  await variant("C4_openWire_guide_Curve", sweep(`factory.curves = [find(args.arc)]; factory.spine = find(args.spine); factory.guides = [find(args.rail)]; factory.guideMethod = B.SweepGuideMethod.Curve;`, { arc: arc.id, spine: spine.id, rail: rail.id }));
  await variant("D_thickness_openWire", sweep(`factory.curves = [find(args.arc)]; factory.spine = find(args.spine); factory.thickness = 0.001;`, { arc: arc.id, spine: spine.id }));
  await variant("E_sweepTool_box_traced", { command: { name: "SweepToolCommand" }, factory: "SweepToolFactory", setup: `${TRACE} factory.solid = find(args.box); factory.spine = find(args.spine);`, commit: TRACED_COMMIT, args: { box: box.id, spine: toolSpine.id } });
  await variant("E2_sweepTool_box_tangent", { command: { name: "SweepToolCommand" }, factory: "SweepToolFactory", bindings: ["Quaternion"], setup: `${TRACE} factory.solid = find(args.box); factory.spine = find(args.spine); factory.tangent.set(0, 1, 0); factory.orientation = new B.Quaternion(); factory.quaternion = new B.Quaternion();`, commit: TRACED_COMMIT, args: { box: box.id, spine: toolSpine.id } });
  // The traced runs above showed calculate() reads factory.origin and factory.originOrientation (both unset).
  await variant("E3_sweepTool_box_origin", { command: { name: "SweepToolCommand" }, factory: "SweepToolFactory", bindings: ["Quaternion", "Vector3"], setup: `${TRACE} factory.solid = find(args.box); factory.spine = find(args.spine); factory.origin = new B.Vector3(2.2, 0, 0); factory.originOrientation = new B.Quaternion();`, commit: TRACED_COMMIT, args: { box: box.id, spine: toolSpine.id } });
  await variant("E4_sweepTool_box_origin_angle90", { command: { name: "SweepToolCommand" }, factory: "SweepToolFactory", bindings: ["Quaternion", "Vector3"], setup: `factory.solid = find(args.box); factory.spine = find(args.spine); factory.origin = new B.Vector3(2.2, 0, 0); factory.originOrientation = new B.Quaternion(); factory.degrees = 90;`, args: { box: box.id, spine: toolSpine.id } });
} catch (error) {
  log.fatal = errText(error);
  console.error(error);
} finally {
  try { await session?.close(); } catch {}
  log.end = await undoTo(runtime, start.undo);
  log.endOk = log.end.undo === start.undo && log.end.bodies === start.bodies;
  save("probe-sweep.json", log);
  runtime.close();
  process.exit(0);
}
