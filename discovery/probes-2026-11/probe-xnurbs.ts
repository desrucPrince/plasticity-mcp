// Gap 6: XNurbs. XNurbsFactory is not a binding; it is the base class of XSidedFactory / RefitSurfaceFactory.
// Drive it from XNurbsCommand with boundary-curve segment constraints and guides.
import { connect, depth, undoTo, save, mcp, newBodies, errText, nativeFunction, TRACE, TRACED_COMMIT, lastReads } from "./harness.ts";
const runtime = await connect();
const start = await depth(runtime);
const log: any = { start, variants: {} };
let session: Awaited<ReturnType<typeof mcp>> | undefined;
try {
  log.classInfo = await runtime.readNative(`function (XSidedFactory, hasXNurbs) {
    const X = Object.getPrototypeOf(XSidedFactory);
    const p = X.prototype;
    const arity = {};
    for (const k of ['addEdgeConstraint', 'addSegmentConstraint', 'setContinuityForEdge', 'setContinuityForSegment', 'setContinuityForConstraint', 'solve', 'calculate', 'cycle']) arity[k] = p[k]?.length;
    const f = new X(this);
    const fields = Object.keys(f);
    try { f.cancel(); } catch {}
    return { base: X.name, baseOfBase: Object.getPrototypeOf(X).name, arity, hasXNurbs: hasXNurbs(), ownFieldCount: fields.length, guidesSetter: !!Object.getOwnPropertyDescriptor(p, 'guides')?.set };
  }`, ["XSidedFactory", "hasXNurbs"]);
  console.log(JSON.stringify(log.classInfo));
  session = await mcp();
  const baseIds = new Set<number>((await session.raw("plasticity_status", { bodyLimit: 200 })).bodies.map((b: any) => b.id));
  const geo: number[] = [];
  const add = async (tool: string, args: any) => {
    const before = await newBodies(session!, baseIds);
    await session!.raw(tool, { ...args, revision: before.revision });
    const after = await newBodies(session!, baseIds);
    const added = after.bodies.filter((b) => !before.bodies.some((o) => o.id === b.id));
    geo.push(...added.map((b) => b.id));
    return added[0];
  };
  const P = [[3000, 0, 0], [3040, 0, 10], [3040, 40, 0], [3000, 40, 10]];
  const quad = [];
  for (let i = 0; i < 4; i++) quad.push(await add("plasticity_create_polyline", { pointsMm: [P[i], P[(i + 1) % 4]], closed: false }));
  const guide = await add("plasticity_create_nurbs_curve", { pointsMm: [[3000, 20, 5], [3020, 20, 20], [3040, 20, 5]] });
  log.geometry = { quad, guide };
  const geoDepth = (await depth(runtime)).undo;
  log.geoDepth = geoDepth;
  const variant = async (label: string, setup: string) => {
    const entry: any = {};
    try {
      entry.native = await runtime.mutate(nativeFunction`async function (XSidedFactory, ContinuityType, ConstraintPriority, args) {
        if (this.executor.isBusy) throw new Error('Plasticity is busy');
        const editor = this;
        const XNurbsFactory = Object.getPrototypeOf(XSidedFactory);
        const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; throw new Error('Unknown body ' + id); };
        let failure; const out = {};
        const command = new this.commands.XNurbsCommand(editor);
        command.remember = false;
        command.execute = async function () {
          try {
            const factory = new XNurbsFactory(editor).resource(this);
            ${TRACE}
            ${setup}
            const r = ${TRACED_COMMIT};
            out.result = Array.isArray(r) ? r.map(x => x?.constructor?.name) : r?.constructor?.name;
            return r;
          } catch (error) { failure = error; throw error; }
        };
        await Promise.race([this.exec(command), new Promise((_, rej) => setTimeout(() => rej(new Error('exec timeout 20s')), 20000))]);
        if (failure) throw failure;
        return out;
      }`, ["XSidedFactory", "ContinuityType", "ConstraintPriority"], [{ quad: quad.map((b) => b.id), guide: guide.id }], 30000);
    } catch (error) { entry.error = errText(error); }
    entry.reads = await lastReads(runtime);
    entry.readBack = (await newBodies(session!, baseIds)).bodies.filter((b) => !geo.includes(b.id));
    entry.depthAfter = await depth(runtime);
    entry.busy = entry.depthAfter.busy;
    await undoTo(runtime, geoDepth);
    log.variants[label] = entry;
    console.log(label, JSON.stringify({ e: entry.error?.slice(0, 300), r: entry.readBack, d: entry.depthAfter }).slice(0, 900));
  };
  // How does XSidedFactory feed its base class? Shadow the constraint methods on an XSided instance and set curves.
  log.xsidedFeed = await runtime.mutate(nativeFunction`async function (XSidedFactory, args) {
    const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; };
    const f = new XSidedFactory(this);
    const calls = [];
    const describe = a => a && typeof a === 'object' ? { ctor: a.constructor?.name, keys: Object.keys(a).slice(0, 12) } : a;
    for (const m of ['addSegmentConstraint', 'addEdgeConstraint', 'setContinuityForSegment', 'setContinuityForConstraint']) {
      const orig = Object.getPrototypeOf(XSidedFactory).prototype[m];
      f[m] = function (...a) { calls.push({ m, args: a.map(describe) }); return orig.apply(this, a); };
    }
    f.curves = args.quad.map(find);
    const seg = Array.from(find(args.quad[0]).segments)[0];
    try { f.cancel(); } catch {}
    return { calls, segment: describe(seg), segment2constraintSize: f.segment2constraint?.size };
  }`, ["XSidedFactory"], [{ quad: quad.map((b) => b.id) }]);
  console.log("xsidedFeed", JSON.stringify(log.xsidedFeed).slice(0, 1500));
  await variant("empty", ``);
  await variant("segmentConstraints_quad", `for (const id of args.quad) for (const seg of find(id).segments) factory.addSegmentConstraint(seg);`);
  await variant("segmentConstraints_quad_plus_guide", `for (const id of args.quad) for (const seg of find(id).segments) factory.addSegmentConstraint(seg); factory.guides = [find(args.guide)];`);
  await variant("segmentConstraints_wireViews", `for (const id of args.quad) factory.addSegmentConstraint(find(id));`);
  await variant("segmentConstraints_segmentModels", `for (const id of args.quad) for (const seg of find(id).segments) factory.addSegmentConstraint(nativeApi.db.lookupTopologyItem(seg));`);
  // addSegmentConstraint takes an XNurbsEdgeConstraint (seen in xsidedFeed). Borrow them from a temporary XSided instance.
  const borrow = `const temp = new XSidedFactory(editor); temp.curves = args.quad.map(find); const constraints = Array.from(temp.segment2constraint.values()); for (const c of constraints) factory.addSegmentConstraint(c);`;
  await variant("borrowedConstraints_quad", borrow);
  await variant("borrowedConstraints_quad_plus_guide", borrow + ` factory.guides = [find(args.guide)];`);
  await variant("xsidedFactory_quad_plus_guide", `factory = null;`.replace("factory = null;", "") + `const xs = new XSidedFactory(editor).resource(this); xs.curves = args.quad.map(find); xs.guides = [find(args.guide)]; const r2 = await xs.commit(); out.result = Array.isArray(r2) ? r2.map(x => x?.constructor?.name) : r2?.constructor?.name; out.xsidedWithGuide = true; factory.cancel(); return r2;`);
  await variant("guides_only_quad", `factory.guides = args.quad.map(find);`);
} catch (error) { log.fatal = errText(error); console.error(error); }
finally {
  try { await session?.close(); } catch {}
  log.end = await undoTo(runtime, start.undo);
  log.endOk = log.end.undo === start.undo && log.end.bodies === start.bodies;
  save("probe-xnurbs.json", log);
  runtime.close();
  process.exit(0);
}
