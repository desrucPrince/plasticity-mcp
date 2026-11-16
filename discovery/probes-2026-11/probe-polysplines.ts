// Gap 7: PolySplines. Capture which factory PolySplinesCommand builds for a selected Solid / reference mesh,
// and commit ConvertMeshToPolySplinesFactory on an imported 10 mm quad cube (OBJ in the scratch dir).
import { connect, depth, undoTo, save, mcp, newBodies, errText, nativeFunction, TRACE, TRACED_COMMIT, lastReads } from "./harness.ts";
const runtime = await connect();
const start = await depth(runtime);
const log: any = { start, steps: {} };
let session: Awaited<ReturnType<typeof mcp>> | undefined;
const OBJ = "/private/tmp/claude-501/plasticity-probe-state/probe-cube.obj";
const captureFactory = (select: string) => runtime.mutate(nativeFunction`async function (SweepFactory, args) {
  if (this.executor.isBusy) throw new Error('Plasticity is busy');
  const editor = this;
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; throw new Error('Unknown body ' + id); };
  this.selection.selected.removeAll();
  ${select}
  let owner = SweepFactory.prototype; while (!Object.prototype.hasOwnProperty.call(owner, 'resource')) owner = Object.getPrototypeOf(owner);
  const original = owner.resource; const marker = '__PROBE_FACTORY__'; const seen = [];
  owner.resource = function () { const chain = []; let p = Object.getPrototypeOf(this); while (p && p !== Object.prototype && chain.length < 4) { chain.push(p.constructor?.name); p = Object.getPrototypeOf(p); } seen.push({ chain, fields: Object.keys(this) }); throw new Error(marker); };
  const command = new this.commands.PolySplinesCommand(this);
  let error = null;
  try { await Promise.race([command.execute(), new Promise((_, r) => setTimeout(() => r(new Error('timeout 3s')), 3000))]); }
  catch (e) { if (String(e?.message ?? e) !== marker) error = String(e?.message ?? e).slice(0, 300); }
  finally { owner.resource = original; try { command.cancel(); } catch {} this.selection.selected.removeAll(); }
  return { factories: seen, error, busy: this.executor.isBusy };
}`, ["SweepFactory"], [{ ...JSON.parse(process.env.__ARGS ?? "{}") }], 15000);
try {
  session = await mcp();
  const baseIds = new Set<number>((await session.raw("plasticity_status", { bodyLimit: 200 })).bodies.map((b: any) => b.id));
  let st = await newBodies(session, baseIds);
  await session.raw("plasticity_create_box", { originMm: [3050, 0, 0], sizeMm: [10, 10, 10], revision: st.revision });
  st = await newBodies(session, baseIds);
  const box = st.bodies[0];
  const meshesBefore = (await session.raw("plasticity_list_reference_meshes")).referenceMeshes ?? [];
  try { log.steps.importMesh = await session.raw("plasticity_import_reference_mesh", { path: OBJ, sourceUnit: "millimeter", revision: st.revision }); }
  catch (error) { log.steps.importMeshError = errText(error); }
  const meshes = (await session.raw("plasticity_list_reference_meshes"));
  log.steps.referenceMeshes = meshes;
  const mesh = (meshes.referenceMeshes ?? meshes.meshes ?? []).find((m: any) => !meshesBefore.some((o: any) => o.id === m.id));
  const geoDepth = (await depth(runtime)).undo;
  log.geoDepth = geoDepth;
  log.steps.capture_solid = await runtime.mutate(nativeFunction`async function (args) { return 0; }`, [], [{}]).then(() => null);
  process.env.__ARGS = JSON.stringify({ box: box.id, mesh: mesh?.id });
  try { log.steps.capture_solid = await captureFactory(`this.selection.selected.add(find(args.box));`); } catch (e) { log.steps.capture_solid = errText(e); }
  if (mesh) {
    try { log.steps.capture_mesh = await captureFactory(`nativeApi.selection.addEmpty ? nativeApi.selection.addEmpty(nativeApi.db.lookupEmptyById(args.mesh)) : this.selection.selected.add(nativeApi.db.lookupEmptyById(args.mesh));`); } catch (e) { log.steps.capture_mesh = errText(e); }
    const convert = async (label: string, setup: string, commandName = "PolySplinesCommand") => {
      const entry: any = {};
      try {
        entry.native = await runtime.mutate(nativeFunction`async function (Factory, args) {
          if (this.executor.isBusy) throw new Error('Plasticity is busy');
          const editor = this; let failure; const out = {};
          const command = new this.commands[args.commandName](editor);
          command.remember = false;
          command.execute = async function () {
            try {
              const factory = new Factory(editor).resource(this);
              ${TRACE}
              factory.empties = [nativeApi.db.lookupEmptyById(args.mesh)];
              ${setup}
              const r = ${TRACED_COMMIT};
              out.result = Array.isArray(r) ? r.map(x => x?.constructor?.name) : r?.constructor?.name;
              return r;
            } catch (error) { failure = error; throw error; }
          };
          await Promise.race([this.exec(command), new Promise((_, rej) => setTimeout(() => rej(new Error('exec timeout 30s')), 30000))]);
          if (failure) throw failure;
          return out;
        }`, ["ConvertMeshToPolySplinesFactory"], [{ mesh: mesh.id, commandName }], 45000);
      } catch (error) { entry.error = errText(error); }
      entry.reads = await lastReads(runtime);
      entry.readBack = (await newBodies(session!, baseIds)).bodies.filter((b) => b.id !== box.id);
      entry.meshesAfter = (await session!.raw("plasticity_list_reference_meshes"));
      entry.depthAfter = await depth(runtime);
      await undoTo(runtime, geoDepth);
      log.steps[label] = entry;
      console.log(label, JSON.stringify({ e: entry.error, r: entry.readBack, d: entry.depthAfter }).slice(0, 1200));
    };
    await convert("convert_default", ``);
    await convert("convert_roundedCorners", `factory.roundedCorners = true;`);
  }
  console.log(JSON.stringify({ capture_solid: log.steps.capture_solid, capture_mesh: log.steps.capture_mesh, importMeshError: log.steps.importMeshError, mesh }).slice(0, 2500));
} catch (error) { log.fatal = errText(error); console.error(error); }
finally {
  try { await session?.close(); } catch {}
  log.end = await undoTo(runtime, start.undo);
  log.endOk = log.end.undo === start.undo && log.end.bodies === start.bodies;
  save("probe-polysplines.json", log);
  runtime.close();
  process.exit(0);
}
