// Item 1, step 2: what the native continuity view holds beyond g0max/g1max/g2max, and which kernel
// calls give normals and curvature on both sides of an edge (for absolute 1/mm values).
// Fixture: 20 mm box with a round r5 fillet (plane tangent to cylinder, expected k 0 vs 1/5 mm).
import { connect, save, errText, nativeFunction } from "./harness.ts";
import { startMcp, status, undoTo } from "./mcp.ts";
import { filletedBox, info, edgeBetween, nonPlanar } from "./fixtures.ts";

const client = await startMcp();
const runtime = await connect();
const start = await status(client);
const out: any = { startUndo: start.undoDepth };
try {
  const round = await filletedBox(client, [5100, 0, 0], 5, "round");
  const rb = await info(client, round.solidId);
  const edges = edgeBetween(rb, nonPlanar, (f) => f.planar && Math.abs((f.normal?.[0] ?? 0) - 1) < 1e-6);
  out.edge = edges[0];
  out.native = await runtime.readNative<any>(nativeFunction`async function (Factory, ContinuityType, evalSurfaceContinuityMeasurements, args) {
    const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item; throw new Error('Unknown body ' + id); };
    const show = v => v === null || v === undefined ? String(v) : typeof v === 'object' ? (v.constructor?.name ?? 'object') + (Array.isArray(v) || ArrayBuffer.isView(v) ? '[' + v.length + ']' : '') : typeof v === 'function' ? 'fn' + v.length : v;
    const ownOf = o => { const r = {}; for (const k of Object.keys(o)) r[k] = show(o[k]); return r; };
    const chain = o => { const out = []; let p = Object.getPrototypeOf(o); while (p && p !== Object.prototype) { out.push(p.constructor?.name + ': ' + Object.getOwnPropertyNames(p).filter(k => k !== 'constructor').map(k => { const d = Object.getOwnPropertyDescriptor(p, k); return typeof d.value === 'function' ? k + '/' + d.value.length : k; }).join(',')); p = Object.getPrototypeOf(p); } return out; };
    const item = find(args.bodyId);
    const ev = item.view.high.edges.get(item.view.high.edges.versionIds.indexOf(args.edgeId));
    const f = new Factory(this);
    f.continuity = ContinuityType.G2;
    f.edges = [ev];
    const ms = await f.calculate();
    const evald = await evalSurfaceContinuityMeasurements(ms, [], this.analyzer, undefined, undefined);
    const m = evald.measurements[0], view = evald.views[0];
    const res = { measurementOwn: ownOf(m), measurementChain: chain(m), viewOwn: ownOf(view), viewChain: chain(view), evalKeys: Object.keys(evald) };
    // Peek array-valued fields of the view (first values).
    res.viewArrays = {};
    for (const k of Object.keys(view)) { const v = view[k]; if (ArrayBuffer.isView(v) || Array.isArray(v)) res.viewArrays[k] = { len: v.length, head: Array.from(v).slice(0, 12).map(x => typeof x === 'object' ? show(x) : x) }; }
    res.measurementJSON = JSON.stringify(m, (k, v) => (typeof v === 'object' && v && v.constructor && !['Object', 'Array'].includes(v.constructor.name) && !ArrayBuffer.isView(v)) ? show(v) : v).slice(0, 3000);
    // Kernel: edge model and face models.
    const coll = item.model.GetEdges();
    res.edgeCollChain = chain(coll);
    const allEdges = coll.GetEdges();
    res.edgeCollLen = coll.Size();
    const me = allEdges.find(x => Number(x.Id()) === Number(ev.entityId)) ?? null;
    res.laminarCount = coll.Laminar ? (() => { try { const l = coll.Laminar(); return l?.Size ? l.Size() : show(l); } catch (e) { return 'err ' + e.message; } })() : null;
    res.isLaminar = (() => { try { return show(coll.IsLaminar()); } catch (e) { return 'err ' + e.message; } })();
    res.isClosed = (() => { try { return show(coll.IsClosed()); } catch (e) { return 'err ' + e.message; } })();
    const an = view.analysis; res.analysisOwn = an ? ownOf(an) : null; res.analysisChain = an ? chain(an) : null;
    res.analysisArrays = {};
    if (an) for (const k of Object.keys(an)) { const v = an[k]; if (ArrayBuffer.isView(v) || Array.isArray(v)) res.analysisArrays[k] = { len: v.length, head: Array.from(v).slice(0, 12).map(x => typeof x === 'object' ? show(x) : x) }; }
    res.modelEdgeChain = me ? chain(me) : null;
    const faces = item.model.GetFaces();
    res.faceCollChain = chain(faces); res.faceCollOwn = ownOf(faces);
    const fc = faces.GetFaces(); res.faceCount = fc.length;
    const cyl = fc.find(x => x && !x.IsPlanar());
    if (!cyl) return res;
    res.cylFaceChain = cyl ? chain(cyl) : null;
    const s = cyl.GetSurface();
    res.surfaceType = show(s); res.surfaceOwn = s && typeof s === 'object' ? ownOf(s) : null; res.surfaceChain2 = s && typeof s === 'object' ? chain(s) : null;
    // Try evaluation calls with metre points on the cylinder at its mid height.
    const tries = {};
    const P = new (item.view.position.constructor)(args.pt[0], args.pt[1], args.pt[2]);
    const attempt = (name, fn) => { try { const r = fn(); tries[name] = r && typeof r === 'object' ? (r.x !== undefined ? [r.x, r.y, r.z] : JSON.stringify(r, (k, v) => (v && typeof v === 'object' && v.isVector3) ? [v.x, v.y, v.z] : v).slice(0, 800)) : show(r); } catch (e) { tries[name] = 'err ' + String(e.message).slice(0, 200); } };
    attempt('FindPointNear(P)', () => cyl.FindPointNear(P));
    attempt('EvalNormal(P)', () => cyl.EvalNormal(P));
    attempt('FindUVMidpoint()', () => cyl.FindUVMidpoint());
    attempt('GetPoint(0.5,0.5)', () => cyl.GetPoint(0.5, 0.5));
    attempt('EvalBasis(P)', () => cyl.EvalBasis(P));
    attempt('EvalBasis(0.5,0.5)', () => cyl.EvalBasis(0.5, 0.5));
    if (me) {
      attempt('edge.GetCurve()', () => show(me.GetCurve?.()));
      for (const k of ['FindPointNear', 'EvalTangent', 'GetPoint', 'EvalCurvature', 'Tangent', 'GetBoundingBox', 'FindPointAt', 'GetLength', 'Length']) if (typeof me[k] === 'function') attempt('edge.' + k, () => k === 'FindPointNear' || k === 'EvalTangent' || k === 'EvalCurvature' ? me[k](P) : me[k](0.5));
    }
    res.tries = tries;
    return res;
  }`, ["MeasureContinuityFactory", "ContinuityType", "evalSurfaceContinuityMeasurements"], [{ bodyId: round.solidId, edgeId: edges[0]!.id, pt: [5.12, 0.015, 0.01] }], 30000);
} catch (e) {
  out.error = errText(e);
} finally {
  await undoTo(client, start.undoDepth);
  out.endUndo = (await status(client)).undoDepth;
  save("probe-continuity-2.json", out);
  runtime.close(); await client.close();
}
process.exit(0);
