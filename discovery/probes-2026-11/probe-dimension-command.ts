// Gap 4 follow-up: which selection makes the generic DimensionCommand (editor.commands) build a collection,
// and which Dimension*Factory it routes to. Traps every Dimension*Factory collection setter; never commits.
import { connect, depth, undoTo, save, mcp, newBodies, errText, nativeFunction } from "./harness.ts";
const runtime = await connect();
const start = await depth(runtime);
const log: any = { start, runs: {} };
let session: Awaited<ReturnType<typeof mcp>> | undefined;
async function capture(label: string, commandSpec: { name?: string; binding?: string }, select: any[]) {
  const entry: any = { select, command: commandSpec };
  try {
    entry.native = await runtime.mutate(nativeFunction`async function (DimensionFactoryBase, BindingCommand, args) {
      const editor = this;
      const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item; throw new Error('Unknown body ' + id); };
      this.selection.selected.removeAll();
      for (const s of args.select) {
        const item = find(s.bodyId); const view = item.view;
        if (s.kind === 'body') this.selection.selected.add(view);
        if (s.kind === 'face') nativeApi.selection.addFace(view.high.faces.get(view.high.faces.versionIds.indexOf(s.id)));
        if (s.kind === 'edge') nativeApi.selection.addEdge(view.high.edges.get(view.high.edges.versionIds.indexOf(s.id)));
        if (s.kind === 'vertex') { const vs = view.high.vertices ?? view.vertices; const i = vs.versionIds ? vs.versionIds.indexOf(s.id) : -1; nativeApi.selection.addVertex(i >= 0 ? vs.get(i) : Array.from(vs)[s.index ?? 0]); }
      }
      const base = Object.getPrototypeOf(DimensionFactoryBase.prototype);
      const descriptor = Object.getOwnPropertyDescriptor(base, 'collection');
      const marker = '__PROBE__';
      let collection = null, factoryClass = null, err = null;
      Object.defineProperty(base, 'collection', { ...descriptor, set(value) { collection = value; factoryClass = this.constructor.name; throw new Error(marker); } });
      const Command = args.command.binding ? BindingCommand : this.commands[args.command.name];
      const probe = new Command(editor);
      try { await Promise.race([probe.execute(), new Promise((_, r) => setTimeout(() => r(new Error('probe timeout 3s')), 3000))]); }
      catch (e) { if (String(e?.message ?? e) !== marker) err = String(e?.message ?? e).slice(0, 300); }
      finally { Object.defineProperty(base, 'collection', descriptor); try { probe.cancel(); } catch {} }
      const has = {};
      if (collection) { let p = Object.getPrototypeOf(collection); while (p && p !== Object.prototype) { for (const k of Object.getOwnPropertyNames(p)) if (/^(Has|Is|Count|Get)/.test(k) && typeof collection[k] === 'function' && collection[k].length === 0) { try { const v = collection[k](); has[k] = typeof v === 'object' ? (v?.constructor?.name + (v?.length !== undefined ? '[' + v.length + ']' : '')) : v; } catch { has[k] = 'throws'; } } p = Object.getPrototypeOf(p); } }
      this.selection.selected.removeAll();
      return { captured: !!collection, factoryClass, collectionType: collection?.constructor?.name, err, has, busy: this.executor.isBusy };
    }`, ["DimensionDistanceFactory", commandSpec.binding ?? "DimensionDistanceCommand"], [{ select, command: commandSpec }], 15000);
  } catch (error) { entry.error = errText(error); }
  entry.depthAfter = await depth(runtime);
  log.runs[label] = entry;
  console.log(label, JSON.stringify(entry).slice(0, 700));
}
try {
  session = await mcp();
  const baseIds = new Set<number>((await session.raw("plasticity_status", { bodyLimit: 200 })).bodies.map((b: any) => b.id));
  const st = await newBodies(session, baseIds);
  await session.raw("plasticity_create_box", { originMm: [2700, 0, 0], sizeMm: [20, 10, 5], revision: st.revision });
  let st2 = await newBodies(session, baseIds);
  await session.raw("plasticity_create_polyline", { pointsMm: [[2700, 50, 0], [2720, 50, 0], [2720, 70, 0]], closed: false, revision: st2.revision });
  st2 = await newBodies(session, baseIds);
  await session.raw("plasticity_create_rectangle", { centerMm: [2750, 60, 0], widthMm: 20, heightMm: 10, revision: st2.revision });
  st2 = await newBodies(session, baseIds);
  await session.raw("plasticity_create_cylinder", { centerMm: [2780, 0, 0], radiusMm: 5, heightMm: 10, revision: st2.revision });
  const all = await newBodies(session, baseIds);
  log.geometry = all.bodies;
  const box = all.bodies.find((b) => b.type === "Solid" && b.boundsMm.min[0] < 2710)!;
  const wire = all.bodies.find((b) => b.name?.startsWith("Polyline"))!;
  const rect = all.bodies.find((b) => b.type === "Wire" && b.boundsMm.min[0] > 2735)!;
  const cyl = all.bodies.find((b) => b.type === "Solid" && b.boundsMm.min[0] > 2770)!;
  const info = (await session.raw("plasticity_body_info", { id: box.id })).body;
  const fx0 = info.faces.find((f: any) => f.normal?.[0] === -1), fx1 = info.faces.find((f: any) => f.normal?.[0] === 1);
  const edge = info.edges.find((e: any) => e.line && Math.abs(e.tangent[0]) === 1);
  const v = info.vertices ?? [];
  log.boxVertexSample = v.slice(0, 2);
  const dc = { name: "DimensionCommand" };
  await capture("generic_body_box", dc, [{ kind: "body", bodyId: box.id }]);
  await capture("generic_twoFaces", dc, [{ kind: "face", bodyId: box.id, id: fx0.id }, { kind: "face", bodyId: box.id, id: fx1.id }]);
  await capture("generic_face", dc, [{ kind: "face", bodyId: box.id, id: fx1.id }]);
  await capture("generic_edge", dc, [{ kind: "edge", bodyId: box.id, id: edge.id }]);
  await capture("generic_polyline", dc, [{ kind: "body", bodyId: wire.id }]);
  await capture("generic_rectangle", dc, [{ kind: "body", bodyId: rect.id }]);
  await capture("generic_cylinder", dc, [{ kind: "body", bodyId: cyl.id }]);
  await capture("generic_box_and_cylinder", dc, [{ kind: "body", bodyId: box.id }, { kind: "body", bodyId: cyl.id }]);
  if (v.length >= 2) {
    await capture("generic_twoVertices", dc, [{ kind: "vertex", bodyId: box.id, id: v[0].id, index: 0 }, { kind: "vertex", bodyId: box.id, id: v[6]?.id ?? v[1].id, index: 6 }]);
    await capture("distanceBinding_twoVertices", { binding: "DimensionDistanceCommand" }, [{ kind: "vertex", bodyId: box.id, id: v[0].id, index: 0 }, { kind: "vertex", bodyId: box.id, id: v[6]?.id ?? v[1].id, index: 6 }]);
  }
  await capture("polylineBinding_polyline", { binding: "DimensionPolylineCommand" }, [{ kind: "body", bodyId: wire.id }]);
  await capture("distanceBinding_box_and_cylinder", { binding: "DimensionDistanceCommand" }, [{ kind: "body", bodyId: box.id }, { kind: "body", bodyId: cyl.id }]);
} catch (error) { log.fatal = errText(error); console.error(error); }
finally {
  try { await session?.close(); } catch {}
  log.end = await undoTo(runtime, start.undo);
  log.endOk = log.end.undo === start.undo && log.end.bodies === start.bodies;
  save("probe-dimension-command.json", log);
  runtime.close();
  process.exit(0);
}
