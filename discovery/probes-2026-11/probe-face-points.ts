// Gap 5: surface control points. ShowFacePointsFactory (TogglePointsCommand) shows a face's CVs;
// then try MultiMoveControlPointFactory on the shown ShellCVs.
import { connect, depth, undoTo, save, mcp, drive, newBodies, errText, nativeFunction, TRACE, TRACED_COMMIT, lastReads } from "./harness.ts";
const runtime = await connect();
const start = await depth(runtime);
const log: any = { start, steps: {} };
let session: Awaited<ReturnType<typeof mcp>> | undefined;
const inspectCVs = (runtime: any, sheetId: number) => runtime.read(nativeFunction`function (args) {
  let item;
  for (const [v, it] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === args.id) item = it;
  if (!item) return { missing: true };
  const keysWith = (o, re) => o ? Object.keys(o).filter(k => re.test(k)) : null;
  const view = item.view;
  const out = { itemKeys: Object.keys(item), viewCvKeys: keysWith(view, /cv|point|control/i), highKeys: view.high ? Object.keys(view.high) : null };
  const cvs = view.cvs ?? view.high?.cvs ?? item.cvs;
  out.cvsType = cvs?.constructor?.name;
  try { out.cvsCount = cvs?.length ?? cvs?.size ?? (cvs ? Array.from(cvs).length : null); } catch (e) { out.cvsCount = 'throws ' + e.message; }
  try { const first = cvs && Array.from(cvs)[0]; out.firstCv = first ? { ctor: first.constructor?.name, keys: Object.keys(first).slice(0, 20), position: first.position?.toArray?.() } : null; } catch (e) { out.firstCv = 'throws ' + e.message; }
  out.editorCvKeys = keysWith(this, /cv|point/i);
  out.dbCvKeys = keysWith(this.db, /cv|point/i);
  out.geoCvKeys = keysWith(this.geo?.read ?? this.geo, /cv|point/i);
  return out;
}`, [{ id: sheetId }]);
try {
  session = await mcp();
  const baseIds = new Set<number>((await session.raw("plasticity_status", { bodyLimit: 200 })).bodies.map((b: any) => b.id));
  let st = await newBodies(session, baseIds);
  await session.raw("plasticity_create_nurbs_curve", { pointsMm: [[2900, 0, 0], [2920, 0, 10], [2940, 0, 0]], revision: st.revision });
  st = await newBodies(session, baseIds);
  const arch = st.bodies[0];
  await session.raw("plasticity_extrude_curves", { ids: [arch.id], distanceMm: 20, direction: [0, 1, 0], revision: st.revision });
  st = await newBodies(session, baseIds);
  const sheet = st.bodies.find((b) => b.type === "Sheet")!;
  const info = (await session.raw("plasticity_body_info", { id: sheet.id })).body;
  const face = info.faces[0];
  log.sheet = sheet; log.face = { id: face.id, surfaceType: face.surfaceType };
  log.surfaceStructureBefore = await session.raw("plasticity_inspect_surface_structure", { faces: [{ bodyId: sheet.id, faceId: face.id }], revision: st.revision });
  const geoDepth = (await depth(runtime)).undo;
  log.geoDepth = geoDepth;
  log.steps.cvsBeforeShow = await inspectCVs(runtime, sheet.id);
  // 1. Show the face points.
  try {
    log.steps.show = await drive(runtime, { command: { name: "TogglePointsCommand" }, factory: "ShowFacePointsFactory", setup: `${TRACE} factory.faces = [faceOf(args.sheet, args.face)];`, commit: TRACED_COMMIT, args: { sheet: sheet.id, face: face.id } });
  } catch (error) { log.steps.showError = errText(error); }
  log.steps.showReads = await lastReads(runtime);
  log.steps.depthAfterShow = await depth(runtime);
  log.steps.bodiesAfterShow = (await newBodies(session, baseIds)).bodies;
  // The sheet may have been replaced: re-find it by bounds.
  const shown = log.steps.bodiesAfterShow.find((b: any) => b.type === "Sheet") ?? sheet;
  log.steps.cvsAfterShow = await inspectCVs(runtime, shown.id);
  log.steps.cvList = await runtime.read(nativeFunction`function (args) {
    for (const [v, it] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === args.id) return Array.from(it.view.high.cvs).map(cv => ({ id: cv.id, versionId: cv.versionId, position: cv.position.toArray().map(x => x * 1000) }));
  }`, [{ id: shown.id }]);
  const showDepth = (await depth(runtime)).undo;
  const moveVariant = async (label: string, setup: string, factoryName = "MultiMoveControlPointFactory", commandBinding = "MoveControlPointCommand") => {
    const entry: any = {};
    try {
      entry.commit = await drive(runtime, { command: { binding: commandBinding }, factory: factoryName, setup: `${TRACE}
        let item; for (const [v, it] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === args.sheet) item = it;
        const cvs = Array.from(item.view.high.cvs);
        const top = cvs.reduce((a, b) => (b.position.z > a.position.z ? b : a));
        ${setup}`, commit: TRACED_COMMIT, args: { sheet: shown.id } });
    } catch (error) { entry.error = errText(error); }
    entry.reads = await lastReads(runtime);
    entry.depthAfter = await depth(runtime);
    const after = await newBodies(session!, baseIds);
    entry.readBack = after.bodies;
    const s2 = after.bodies.find((b: any) => b.type === "Sheet");
    if (s2 && !entry.error) {
      const fi = (await session!.raw("plasticity_body_info", { id: s2.id })).body.faces[0];
      entry.surfaceStructureAfter = await session!.raw("plasticity_inspect_surface_structure", { faces: [{ bodyId: s2.id, faceId: fi.id }], revision: after.revision });
    }
    await undoTo(runtime, showDepth);
    log.steps[label] = entry;
    console.log(label, JSON.stringify({ error: entry.error, readBack: entry.readBack, depth: entry.depthAfter }).slice(0, 900));
  };
  await moveVariant("move_topCV_up10_cvsField", `factory.cvs = [top]; factory.move.set(0, 0, 0.01);`);
  await moveVariant("move_topCV_up10_controlPoints", `factory.controlPoints = [top]; factory.move.set(0, 0, 0.01);`);
  await moveVariant("move_topCV_up10_selection", `editor.selection.selected.removeAll(); nativeApi.selection.addCurveCV ? 0 : 0; editor.selection.selected.add(top); factory.cvs = [top]; factory.move.set(0, 0, 0.01);`);
} catch (error) { log.fatal = errText(error); console.error(error); }
finally {
  try { await session?.close(); } catch {}
  log.end = await undoTo(runtime, start.undo);
  log.endOk = log.end.undo === start.undo && log.end.bodies === start.bodies;
  save("probe-face-points.json", log);
  runtime.close();
  process.exit(0);
}
