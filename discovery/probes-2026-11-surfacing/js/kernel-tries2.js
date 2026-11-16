function (args) {
  // Second round: kernel vectors read through x/y/z getters; FindPointNear with the kernel's own point object.
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item; throw new Error('Unknown body ' + id); };
  const vec = v => (v && typeof v === 'object' && 'x' in v) ? [Number(v.x), Number(v.y), Number(v.z)] : v;
  const deep = r => { if (r === null || typeof r !== 'object') return r; if ('x' in r && 'y' in r && 'z' in r) return vec(r); if (Array.isArray(r)) return r.map(deep); const o = {}; for (const k of Object.keys(r)) o[k] = typeof r[k] === 'object' ? (r[k]?.constructor?.name === 'Face' || r[k]?.constructor?.name === 'Edge' ? r[k].constructor.name : deep(r[k])) : r[k]; return o; };
  const item = find(args.bodyId);
  const ev = item.view.high.edges.get(item.view.high.edges.versionIds.indexOf(args.edgeId));
  const me = item.model.GetEdges().GetEdges().find(x => Number(x.Id()) === Number(ev.entityId));
  const fl = me.GetFaces().GetFaces();
  const T = {};
  const attempt = (name, fn) => { try { T[name] = deep(fn()); } catch (e) { T[name] = 'err ' + String(e.message).slice(0, 160); } };
  const pt = me.GetPointAndTangent(0.5);
  T.pointCtor = pt.position?.constructor?.name;
  attempt('edge.GetPointAndTangent(0.5)', () => pt);
  attempt('edge.GetPoint(0)', () => me.GetPoint(0));
  attempt('edge.GetPoint(1)', () => me.GetPoint(1));
  attempt('edge.GetPoint(0.01) (actual t?)', () => me.GetPoint(0.01));
  attempt('edge.EvalFaceNormal(0.5)', () => me.EvalFaceNormal(0.5));
  attempt('edge.EvalFaceNormal(0.01)', () => me.EvalFaceNormal(0.01));
  attempt('edge.EvalBasis(0.5)', () => me.EvalBasis(0.5));
  attempt('edge.EvalDerivatives(0.5,2)', () => me.EvalDerivatives(0.5, 2));
  attempt('edge.FindPointNear(kernelPoint)', () => me.FindPointNear(pt.position));
  for (let i = 0; i < fl.length; i++) {
    attempt('face' + i + '.Id', () => fl[i].Id());
    attempt('face' + i + '.FindPointNear(kernelPoint)', () => fl[i].FindPointNear(pt.position));
    attempt('face' + i + '.EvalBasis(0.5,0.5)', () => fl[i].EvalBasis(0.5, 0.5));
    attempt('face' + i + '.EvalNormal(0.5,0.5)', () => fl[i].EvalNormal(0.5, 0.5));
    attempt('face' + i + '.GetPoint(0,0)', () => fl[i].GetPoint(0, 0));
    attempt('face' + i + '.GetPoint(1,1)', () => fl[i].GetPoint(1, 1));
    attempt('face' + i + '.EvalGrid.length', () => fl[i].EvalGrid.length);
  }
  return { faceEntityIds: fl.map(f => Number(f.Id())), tries: T };
}
