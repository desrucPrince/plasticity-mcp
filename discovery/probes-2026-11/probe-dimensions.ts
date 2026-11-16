// Gap 4: DimensionDistance / DimensionPolyline (dimension-driven edits) and MoveMeasurement (label offset).
// Dimension factories take a DimensionCollection that the native Command builds from the selection.
// We capture it by trapping the DimensionFactory.collection setter during command.execute(), as setBlockDimensions does.
import { connect, depth, undoTo, save, mcp, newBodies, errText, nativeFunction } from "./harness.ts";
const runtime = await connect();
const start = await depth(runtime);
const log: any = { start, geometry: {}, variants: {} };
let session: Awaited<ReturnType<typeof mcp>> | undefined;

const SELECT = `
  const editor = this;
  ${"" /* selection helpers */}
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; throw new Error('Unknown body ' + id); };
  this.selection.selected.removeAll();
  for (const s of args.select) {
    const view = find(s.bodyId);
    if (s.kind === 'body') this.selection.selected.add(view);
    if (s.kind === 'face') nativeApi.selection.addFace(view.high.faces.get(view.high.faces.versionIds.indexOf(s.id)));
    if (s.kind === 'edge') nativeApi.selection.addEdge(view.high.edges.get(view.high.edges.versionIds.indexOf(s.id)));
    if (s.kind === 'curve') nativeApi.selection.addCurve(view.segments ? Array.from(view.segments)[s.index ?? 0] : view);
  }
  const selectedSummary = { faces: this.selection.selected.faces?.size, edges: this.selection.selected.edges?.size, solids: this.selection.selected.solids?.size, curves: this.selection.selected.curves?.size };
  let collection = null, captureError = null, timedOut = false;
  const base = Object.getPrototypeOf(Factory.prototype);
  const descriptor = Object.getOwnPropertyDescriptor(base, 'collection');
  const marker = '__PROBE_DIMENSION_COLLECTION__';
  Object.defineProperty(base, 'collection', { ...descriptor, set(value) { collection = value; routedFactory = this.constructor.name; throw new Error(marker); } });
  const probe = new this.commands.DimensionCommand(editor);
  let routedFactory = null;
  try {
    await Promise.race([probe.execute(), new Promise((_, reject) => setTimeout(() => { timedOut = true; reject(new Error('probe timeout')); }, 3000))]);
  } catch (error) { if (String(error?.message ?? error) !== marker) captureError = String(error?.message ?? error); }
  finally { Object.defineProperty(base, 'collection', descriptor); try { probe.cancel(); } catch {} }
  const has = {};
  if (collection) {
    let p = Object.getPrototypeOf(collection);
    while (p && p !== Object.prototype) { for (const k of Object.getOwnPropertyNames(p)) if (/^(Has|Get|Is|Count)/.test(k) && typeof collection[k] === 'function' && collection[k].length === 0) { try { const v = collection[k](); has[k] = typeof v === 'object' ? (v?.constructor?.name ?? String(v)) : v; } catch (e) { has[k] = 'throws'; } } p = Object.getPrototypeOf(p); }
  }`;

async function dimension(label: string, commandBinding: string, factoryBinding: string, select: any[], commitSetup: string | null, extra: any = {}) {
  const entry: any = { select };
  const d0 = (await depth(runtime)).undo;
  try {
    entry.native = await runtime.mutate(nativeFunction`async function (Command, Factory, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      ${SELECT}
      const out = { selectedSummary, routedFactory, captured: !!collection, collectionType: collection?.constructor?.name, captureError, timedOut, has };
      if (!collection || !args.commit) { this.selection.selected.removeAll(); return out; }
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.collection = collection;
          out.afterCollection = Object.fromEntries(['distance', 'refDistance', 'containsRefEntity', 'length', 'clickPoint'].map(k => { try { const v = factory[k]; return [k, v?.isVector3 ? v.toArray() : Array.isArray(v) ? v.length : v]; } catch (e) { return [k, 'throws']; } }));
          out.afterCollection.to = factory.to?.toArray?.(); out.afterCollection.direction = factory.direction?.toArray?.();
          ${commitSetup ?? ""}
          out.factoryBefore = Object.fromEntries(Object.keys(factory).filter(k => typeof factory[k] !== 'object' || factory[k]?.isVector3).map(k => [k, factory[k]?.isVector3 ? factory[k].toArray() : factory[k]]));
          const r = await factory.commit();
          out.result = Array.isArray(r) ? r.map(x => x?.constructor?.name) : r?.constructor?.name;
          return r;
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      this.selection.selected.removeAll();
      if (failure) throw failure;
      return out;
    }`, [commandBinding, factoryBinding], [{ select, commit: commitSetup !== null, ...extra }], 20000);
  } catch (error) { entry.error = errText(error); }
  entry.readBack = (await newBodies(session!, new Set())).bodies.filter((b: any) => b.boundsMm.min[0] > 2690 && b.boundsMm.min[0] < 2800);
  entry.depthAfter = await depth(runtime);
  await undoTo(runtime, d0);
  log.variants[label] = entry;
  console.log(label, JSON.stringify(entry).slice(0, 900));
}

try {
  session = await mcp();
  const baseIds = new Set<number>((await session.raw("plasticity_status", { bodyLimit: 200 })).bodies.map((b: any) => b.id));
  const add = async (label: string, tool: string, args: any) => {
    const before = await newBodies(session!, baseIds);
    const r = await session!.raw(tool, { ...args, revision: before.revision });
    const after = await newBodies(session!, baseIds);
    const added = after.bodies.filter((b) => !before.bodies.some((o) => o.id === b.id));
    log.geometry[label] = added.length ? added : (r?.measurements ?? r);
    return added;
  };
  const [box] = await add("box", "plasticity_create_box", { originMm: [2700, 0, 0], sizeMm: [20, 10, 5] });
  const [wire] = await add("polyline", "plasticity_create_polyline", { pointsMm: [[2700, 50, 0], [2720, 50, 0], [2720, 70, 0]], closed: false });
  const info = (await session.raw("plasticity_body_info", { id: box.id })).body;
  const faceX0 = info.faces.find((f: any) => f.normal?.[0] === -1);
  const faceX1 = info.faces.find((f: any) => f.normal?.[0] === 1);
  const faceZ1 = info.faces.find((f: any) => f.normal?.[2] === 1);
  const edgeX = info.edges.find((e: any) => e.line && Math.abs(e.tangent[0]) === 1);
  log.picked = { faceX0: faceX0?.id, faceX1: faceX1?.id, faceZ1: faceZ1?.id, edgeX: edgeX && { id: edgeX.id, lengthMm: edgeX.lengthMm } };
  const geoDepth = (await depth(runtime)).undo;
  log.geoDepth = geoDepth;

  const [tri] = await add("closedTriangle", "plasticity_create_polyline", { pointsMm: [[2700, 100, 0], [2730, 100, 0], [2710, 120, 0]], closed: true });
  const DD = ["DimensionDistanceCommand", "DimensionDistanceFactory"] as const;
  const DP = ["DimensionPolylineCommand", "DimensionPolylineFactory"] as const;
  // 4a. Capture only (no commit) to see what the generic DimensionCommand routes to.
  await dimension("capture_oneFace", ...DD, [{ kind: "face", bodyId: box.id, id: faceX1.id }], null);
  await dimension("capture_closedTriangle", ...DP, [{ kind: "body", bodyId: tri.id }], null);
  // 4b. Commit DimensionDistance: x+ face of a 20 mm box, distance 30 mm.
  await dimension("dist_commit_oneFace_30mm", ...DD, [{ kind: "face", bodyId: box.id, id: faceX1.id }], `factory.distance = 0.03;`);
  await dimension("dist_commit_twoFaces_30mm", ...DD, [{ kind: "face", bodyId: box.id, id: faceX0.id }, { kind: "face", bodyId: box.id, id: faceX1.id }], `factory.distance = 0.03;`);
  await dimension("dist_commit_topFace_12mm", ...DD, [{ kind: "face", bodyId: box.id, id: faceZ1.id }], `factory.distance = 0.012;`);
  // 4b'. The collection setter leaves to/direction/refDistance at zero (the UI fills them from a picked point).
  // Fill them explicitly: reference point on the x- face, direction +x, current distance 20 mm.
  await dimension("dist_commit_oneFace_ref_to_dir", ...DD, [{ kind: "face", bodyId: box.id, id: faceX1.id }], `factory.to.set(2.700, 0.005, 0.0025); factory.direction.set(1, 0, 0); factory.refDistance = 0.02; factory.distance = 0.03;`);
  await dimension("dist_commit_oneFace_to_dir_only", ...DD, [{ kind: "face", bodyId: box.id, id: faceX1.id }], `factory.to.set(2.700, 0.005, 0.0025); factory.direction.set(1, 0, 0); factory.distance = 0.03;`);
  await dimension("dist_commit_oneFace_clickPoint", ...DD, [{ kind: "face", bodyId: box.id, id: faceX1.id }], `factory.clickPoint = new (factory.to.constructor)(2.720, 0.005, 0.0025); factory.to.set(2.700, 0.005, 0.0025); factory.direction.set(1, 0, 0); factory.refDistance = 0.02; factory.distance = 0.03;`);
  // 4c. DimensionPolyline on a closed triangle.
  await dimension("poly_commit_triangle_length40", ...DP, [{ kind: "body", bodyId: tri.id }], `out.positionsBefore = factory.positions?.length; factory.length = 0.04;`);
} catch (error) {
  log.fatal = errText(error);
  console.error(error);
} finally {
  try { await session?.close(); } catch {}
  log.end = await undoTo(runtime, start.undo);
  log.endOk = log.end.undo === start.undo && log.end.bodies === start.bodies;
  save("probe-dimensions.json", log);
  runtime.close();
  process.exit(0);
}
