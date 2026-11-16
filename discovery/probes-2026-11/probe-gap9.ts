// Gap 9 (list only): own fields of factories behind COVERAGE gaps #16-#23, plus one smoke commit of
// RemoveNominalSurfaceFactory and JoinFacesFactory on a box, undone afterwards.
import { connect, depth, undoTo, save, mcp, drive, newBodies, errText } from "./harness.ts";
const runtime = await connect();
const start = await depth(runtime);
const log: any = { start, fields: {}, commits: {} };
let session: Awaited<ReturnType<typeof mcp>> | undefined;
const names = ["SpiralFactory", "FilletShellFactory", "RefitTrimFactory", "RefitFaceFactory", "JoinFacesFactory", "AlignAndRebuildFactory", "RemoveNominalSurfaceFactory"];
try {
  log.fields = await runtime.readNative(`function (...bound) {
    const names = bound.pop(); const ChamferMode = bound.pop();
    const show = v => v === null || v === undefined ? String(v) : typeof v === 'object' ? v.constructor?.name : typeof v === 'function' ? 'fn' : v;
    const out = { ChamferMode: Object.fromEntries(Object.entries(ChamferMode).filter(([k, v]) => typeof v !== 'object')) };
    bound.forEach((C, i) => {
      let f; try { f = new C(this); const skip = new Set(['editor','changed','updated','refine','temps','phantoms','diagnoses','executor','_state','partition','phantomPartition','stages']);
        const acc = []; let p = C.prototype; for (let d = 0; d < 1; d++) { for (const k of Object.getOwnPropertyNames(p)) { const ds = Object.getOwnPropertyDescriptor(p, k); if (ds.set) acc.push(k); } p = Object.getPrototypeOf(p); }
        out[names[i]] = { fields: Object.fromEntries(Object.keys(f).filter(k => !skip.has(k)).map(k => [k, show(f[k])])), setters: acc };
      } catch (e) { out[names[i]] = 'construct error: ' + e.message; } finally { try { f?.cancel?.(); } catch {} }
    });
    return out;
  }`, [...names, "ChamferMode"], [names]);
  console.log(JSON.stringify(log.fields, null, 0).slice(0, 3000));
  session = await mcp();
  const baseIds = new Set<number>((await session.raw("plasticity_status", { bodyLimit: 200 })).bodies.map((b: any) => b.id));
  const st = await newBodies(session, baseIds);
  await session.raw("plasticity_create_box", { originMm: [3300, 0, 0], sizeMm: [10, 10, 10], revision: st.revision });
  const box = (await newBodies(session, baseIds)).bodies[0];
  const info = (await session.raw("plasticity_body_info", { id: box.id })).body;
  const geoDepth = (await depth(runtime)).undo;
  for (const [label, factory, command, setup] of [
    ["removeNominal_boxTopFace", "RemoveNominalSurfaceFactory", "RemoveNominalSurfaceCommand", `factory.shell = find(args.box); factory.faces = [faceOf(args.box, args.faces[0])];`],
    ["joinFaces_twoAdjacentBoxFaces", "JoinFacesFactory", "JoinFacesCommand", `factory.faces = args.faces.slice(0, 2).map(f => faceOf(args.box, f));`],
  ] as const) {
    const entry: any = {};
    try { entry.commit = await drive(runtime, { command: command === "JoinFacesCommand" ? { binding: command } : { name: command }, factory, setup, args: { box: box.id, faces: info.faces.map((f: any) => f.id) } }); }
    catch (error) { entry.error = errText(error); }
    entry.readBack = (await newBodies(session, baseIds)).bodies;
    entry.depthAfter = await depth(runtime);
    await undoTo(runtime, geoDepth);
    log.commits[label] = entry;
    console.log(label, JSON.stringify(entry).slice(0, 700));
  }
} catch (error) { log.fatal = errText(error); console.error(error); }
finally {
  try { await session?.close(); } catch {}
  log.end = await undoTo(runtime, start.undo);
  log.endOk = log.end.undo === start.undo && log.end.bodies === start.bodies;
  save("probe-gap9.json", log);
  runtime.close();
  process.exit(0);
}
