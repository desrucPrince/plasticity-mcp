function (args) {
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item; throw new Error('Unknown body ' + id); };
  const item = find(args.bodyId);
  const Vec = item.view.position.constructor;
  const mf = item.model.GetFaces();
  const out = [];
  for (let i = 0; i < mf.Size(); i++) {
    const f = mf.Get(i);
    if (!f.IsPlanar()) continue;
    const mid = f.FindMidpoint().position;
    const rec = { mid: [mid.x, mid.y, mid.z] };
    for (const [label, p] of [['mid', mid], ['off', new Vec(mid.x + 0.1, mid.y, mid.z)]]) {
      try {
        const near = f.FindPointNear(p);
        rec[label] = { u: near.u, v: near.v, exact: near.exact, exactType: typeof near.exact };
        try { const g = f.GetPoint(near.u, near.v); rec[label].getPoint = g?.x !== undefined ? [g.x, g.y, g.z] : (g?.position ? [g.position.x, g.position.y, g.position.z] : Object.keys(g ?? {})); } catch (e) { rec[label].getPoint = 'ERR ' + e.message; }
        try { const n = f.EvalNormal(near.u, near.v); rec[label].normal = [n.x, n.y, n.z]; } catch (e) { rec[label].normal = 'ERR ' + e.message; }
      } catch (e) { rec[label] = 'ERR ' + String(e.message ?? e).slice(0, 200); }
    }
    out.push(rec);
  }
  return out;
}
