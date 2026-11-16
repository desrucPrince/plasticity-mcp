async function (Factory, ContinuityType, evalSurfaceContinuityMeasurements, args) {
  // Try argument forms for the kernel edge/face evaluators, and read the ContinuityAnalysis accessors.
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item; throw new Error('Unknown body ' + id); };
  const show = v => v === null || v === undefined ? String(v) : typeof v === 'object' ? (v.constructor?.name ?? 'object') + (Array.isArray(v) || ArrayBuffer.isView(v) ? '[' + v.length + ']' : '') : typeof v === 'function' ? 'fn' + v.length : v;
  const ser = r => JSON.stringify(r, (k, v) => (v && typeof v === 'object' && v.isVector3) ? [v.x, v.y, v.z] : (ArrayBuffer.isView(v) ? Array.from(v).slice(0, 24) : v));
  const item = find(args.bodyId);
  const V3 = item.view.position.constructor;
  const ev = item.view.high.edges.get(item.view.high.edges.versionIds.indexOf(args.edgeId));
  const me = item.model.GetEdges().GetEdges().find(x => Number(x.Id()) === Number(ev.entityId));
  const faces = me.GetFaces();
  const fl = Array.isArray(faces) ? faces : (faces.GetFaces ? faces.GetFaces() : []);
  const res = { edgeFaces: show(faces), nFaces: fl.length, tries: {} };
  const T = res.tries;
  const attempt = (name, fn) => { try { const r = fn(); T[name] = r && typeof r === 'object' ? ser(r).slice(0, 600) : show(r); } catch (e) { T[name] = 'err ' + String(e.message).slice(0, 160); } };
  const p = me.GetPoint(0.5);
  const forms = { v3: new V3(p.x, p.y, p.z), arr: [p.x, p.y, p.z], obj: { x: p.x, y: p.y, z: p.z } };
  for (const [fk, P] of Object.entries(forms)) {
    attempt('edge.FindPointNear/' + fk, () => me.FindPointNear(P));
    attempt('face0.FindPointNear/' + fk, () => fl[0].FindPointNear(P));
  }
  attempt('edge.GetPointAndTangent(0.5)', () => me.GetPointAndTangent(0.5));
  attempt('edge.EvalBasis(0.5)', () => me.EvalBasis(0.5));
  attempt('edge.EvalDerivatives(0.5)', () => me.EvalDerivatives(0.5));
  attempt('edge.EvalDerivatives(0.5,2)', () => me.EvalDerivatives(0.5, 2));
  attempt('edge.EvalFaceNormal(0.5)', () => me.EvalFaceNormal(0.5));
  for (let i = 0; i < fl.length; i++) {
    attempt('edge.EvalFaceNormal(0.5,face' + i + ')', () => me.EvalFaceNormal(0.5, fl[i]));
    attempt('edge.EvalFaceNormal(face' + i + ',0.5)', () => me.EvalFaceNormal(fl[i], 0.5));
    attempt('face' + i + '.planar', () => fl[i].IsPlanar());
    attempt('face' + i + '.EvalBasis(0.5,0.5)', () => fl[i].EvalBasis(0.5, 0.5));
    attempt('face' + i + '.GetSurface', () => fl[i].GetSurface());
  }
  attempt('edge.GetInterval()', () => me.GetInterval());
  attempt('edge.GetCurve()', () => me.GetCurve());
  attempt('edge.AngleTo', () => me.AngleTo.length);
  attempt('edge.GetOppositeFace(face0)', () => show(me.GetOppositeFace(fl[0])));
  attempt('edge.IsLaminar()', () => me.IsLaminar());
  // ContinuityAnalysis accessors.
  const f = new Factory(this); f.continuity = ContinuityType.G2; f.edges = [ev];
  const evald = await evalSurfaceContinuityMeasurements(await f.calculate(), [], this.analyzer, undefined, undefined);
  const an = evald.views[0].analysis;
  res.analysis = {};
  for (const k of ['g0spikes', 'g1spikes', 'g2spikes', 'maxes', 'maxCounts', 'maxPositions', 'boxMin', 'boxMax', 'sphereCenter', 'sphereRadius']) {
    try { const v = an[k]; res.analysis[k] = ArrayBuffer.isView(v) || Array.isArray(v) ? { type: show(v), head: Array.from(v).slice(0, 18) } : (v && typeof v === 'object' ? ser(v).slice(0, 300) : show(v)); } catch (e) { res.analysis[k] = 'err ' + e.message; }
  }
  return res;
}
