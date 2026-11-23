function (args) {
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; throw new Error('no ' + id); };
  const view = find(args.id); const ev = view.high.edges.get(view.high.edges.versionIds.indexOf(args.edgeId));
  const e = nativeApi.db.lookupTopologyItem(ev);
  const K = e.GetPointAndTangent(0.5).position.constructor;
  const r = e.FindPointNear(new K(...args.p));
  const plain = o => { if (!o || typeof o !== 'object') return o; const out = {}; for (const k of Object.keys(o)) out[k] = plain(o[k]); for (const k of ['x','y','z']) if (k in o) out[k] = o[k]; return out; };
  const c = e.GetCurve(); const curve = c?.curve ?? c;
  return { near: plain(r), p0: plain(e.GetPointAndTangent(0).position), p1: plain(e.GetPointAndTangent(1).position), d0: e.Denormalize(0), d1: e.Denormalize(1), interval: plain(e.GetInterval?.()), len: e.FindLength().length, glen: curve.GetLength(e.Denormalize(0), e.Denormalize(0.3)), verts: (() => { const v = e.GetVertices(); return [v.left?.Id?.(), v.right?.Id?.()]; })(), periodic: e.IsPeriodic() };
}
