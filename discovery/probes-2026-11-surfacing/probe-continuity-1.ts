// Item 1, step 1: build the three validation cases and read the shipped analyzer
// (plasticity_analyze_surface_continuity = MeasureContinuityFactory.calculate + evalSurfaceContinuityMeasurements).
// Also lists the MeasureContinuityFactory fields and the kernel edge/face API names for the sampling recipe.
import { connect, save, errText, nativeFunction } from "./harness.ts";
import { startMcp, call, status, undoTo } from "./mcp.ts";
import { wedge30, filletedBox, info, edgeBetween, faceNormal, nonPlanar } from "./fixtures.ts";

const client = await startMcp();
const runtime = await connect();
const start = await status(client);
const out: any = { startUndo: start.undoDepth, startRevision: start.revision, cases: {} };
try {
  const wedge = await wedge30(client, 5000);
  const round = await filletedBox(client, [5100, 0, 0], 5, "round");
  const g2 = await filletedBox(client, [5200, 0, 0], 5, "g2");
  const wb = await info(client, wedge.solidId);
  const s = Math.sin(Math.PI / 6), c = Math.cos(Math.PI / 6);
  const e30 = edgeBetween(wb, faceNormal([0, -1, 0]), faceNormal([s, -c, 0]));
  const rb = await info(client, round.solidId);
  const gb = await info(client, g2.solidId);
  const tangentEdges = (b: any) => edgeBetween(b, nonPlanar, (f) => f.planar && (Math.abs(f.normal?.[0] - 1) < 1e-6 || Math.abs(f.normal?.[1] - 1) < 1e-6));
  const er = tangentEdges(rb), eg = tangentEdges(gb);
  out.fixtures = { wedge, round, g2, e30: e30.map((e) => e.id), roundEdges: er.map((e) => e.id), g2Edges: eg.map((e) => e.id),
    roundFace: rb.faces.filter(nonPlanar).map((f) => ({ id: f.id, surfaceType: f.surfaceType, radiusMm: f.radiusMm })),
    g2Face: gb.faces.filter(nonPlanar).map((f) => ({ id: f.id, surfaceType: f.surfaceType, radiusMm: f.radiusMm })) };
  const revision = (await status(client)).revision;
  const edges = [
    ...e30.map((e) => ({ bodyId: wedge.solidId, edgeId: e.id })),
    ...er.map((e) => ({ bodyId: round.solidId, edgeId: e.id })),
    ...eg.map((e) => ({ bodyId: g2.solidId, edgeId: e.id })),
  ];
  try {
    out.analyzer = await call(client, "plasticity_analyze_surface_continuity", { edges, revision });
  } catch (e) { out.analyzerError = errText(e); }

  // Native class shape of MeasureContinuityFactory and the kernel API of an edge and its faces.
  out.native = await runtime.readNative<any>(nativeFunction`function (MeasureContinuityFactory, ContinuityType, args) {
    const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item; throw new Error('Unknown body ' + id); };
    const show = v => v === null || v === undefined ? String(v) : typeof v === 'object' ? (v.constructor?.name ?? 'object') + (Array.isArray(v) ? '[' + v.length + ']' : '') : typeof v === 'function' ? 'fn' : v;
    const chain = o => { const out = []; let p = Object.getPrototypeOf(o); while (p && p !== Object.prototype) { const names = Object.getOwnPropertyNames(p).filter(k => k !== 'constructor'); out.push(p.constructor?.name + ': ' + names.join(',')); p = Object.getPrototypeOf(p); } return out; };
    const f = new MeasureContinuityFactory(this);
    const own = {}; for (const k of Object.keys(f)) own[k] = show(f[k]);
    const item = find(args.bodyId);
    const idx = item.view.high.edges.versionIds.indexOf(args.edgeId);
    const ev = item.view.high.edges.get(idx);
    const modelEdges = item.model.GetEdges ? item.model.GetEdges() : null;
    let me = null; if (modelEdges) { for (let i = 0; i < modelEdges.length; i++) { const x = modelEdges.Get ? modelEdges.Get(i) : modelEdges[i]; if (Number(x.Id?.() ?? x.id) === Number(ev.entityId)) { me = x; break; } } }
    const mf = item.model.GetFaces().Get ? item.model.GetFaces().Get(0) : item.model.GetFaces()[0];
    let curve = null, surf = null;
    try { curve = me?.GetCurve?.() ?? null; } catch (e) { curve = 'err ' + e.message; }
    try { surf = mf?.GetSurface?.() ?? null; } catch (e) { surf = 'err ' + e.message; }
    return { factoryOwn: own, factoryChain: chain(f), ContinuityType: Object.fromEntries(Object.entries(ContinuityType).filter(([k]) => isNaN(Number(k)))),
      edgeView: { keys: Object.keys(ev), entityId: ev.entityId }, modelEdgesType: show(modelEdges), modelEdgeChain: me ? chain(me) : null,
      modelFaceChain: mf ? chain(mf) : null, curveChain: curve && typeof curve === 'object' ? chain(curve) : show(curve), surfaceChain: surf && typeof surf === 'object' ? chain(surf) : show(surf),
      modelBodyChain: chain(item.model).map(s => s.slice(0, 4000)) };
  }`, ["MeasureContinuityFactory", "ContinuityType"], [{ bodyId: round.solidId, edgeId: er[0]!.id }], 30000);
} catch (e) {
  out.error = errText(e);
} finally {
  await undoTo(client, start.undoDepth);
  const end = await status(client);
  out.endUndo = end.undoDepth; out.endBodies = (end.bodies as any[]).map((b) => b.id);
  save("probe-continuity-1.json", out);
  runtime.close(); await client.close();
}
process.exit(0);
