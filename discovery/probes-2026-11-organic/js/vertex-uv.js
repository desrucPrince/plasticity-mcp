function (args) {
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; throw new Error('no ' + id); };
  const view = find(args.id);
  const fi = view.high.faces.versionIds.indexOf(args.faceId);
  const face = nativeApi.db.lookupTopologyItem(view.high.faces.get(fi));
  const anyEdge = nativeApi.db.lookupTopologyItem(view.high.edges.get(0));
  const K = anyEdge.GetPointAndTangent(0.5).position.constructor;
  const s = face.GetSurface();
  const plain = o => { if (!o || typeof o !== 'object') return o; const r = {}; for (const k of ['x', 'y', 'z', 'u', 'v']) if (k in o) r[k] = o[k]; for (const k of Object.keys(o)) r[k] = typeof o[k] === 'object' ? plain(o[k]) : o[k]; return r; };
  const out = { range: [s.uMin, s.uMax, s.vMin, s.vMax], orientation: s.orientation, uvbox: plain(s.surface.GetUVBox()) };
  out.pts = args.points.map(p => { const r = face.FindPointNear(new K(...p)); const b = face.EvalBasis(r.u, r.v); return { u: r.u, v: r.v, basisKeys: Object.keys(b), basis: plain(b) }; });
  return out;
}
