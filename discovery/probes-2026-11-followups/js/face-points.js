function (args) {
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item; throw new Error('Unknown body ' + id); };
  const item = find(args.bodyId);
  const view = item.view;
  const mf = item.model.GetFaces();
  const v = p => p ? (p.x !== undefined ? [p.x * 1000, p.y * 1000, p.z * 1000] : p.position ? { position: [p.position.x*1000, p.position.y*1000, p.position.z*1000], normal: p.normal ? [p.normal.x, p.normal.y, p.normal.z] : null } : (Array.isArray(p) ? p : Object.keys(p))) : p;
  const out = [];
  const idByEntity = new Map();
  for (let i = 0; i < view.high.faces.versionIds.length; i++) idByEntity.set(view.high.faces.get(i).entityId, view.high.faces.versionIds[i]);
  for (let i = 0; i < mf.Size(); i++) {
    const f = mf.Get(i);
    const rec = { id: idByEntity.get(f.Id()), planar: f.IsPlanar() };
    for (const name of ['FindMidpoint', 'GetAnyPointOn', 'FindPolygonalMidpoint', 'FindUVMidpoint']) {
      try { const r = f[name](); rec[name] = v(r); rec[name + 'Type'] = r?.constructor?.name; } catch (e) { rec[name] = 'ERR ' + String(e.message ?? e).slice(0, 200); }
    }
    try { const mid = f.FindMidpoint(); const r = f.FindPointNear(mid.position); rec.FindPointNearMid = v(r); rec.FindPointNearType = r?.constructor?.name; } catch (e) { rec.FindPointNearMid = 'ERR ' + String(e.message ?? e).slice(0, 200); }
    out.push(rec);
  }
  return out;
}
