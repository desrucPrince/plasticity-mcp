async function (args) {
  const ed = this; const h = ed.selection.hits;
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; throw new Error('Unknown body ' + id); };
  const view = find(args.bodyId); const face = view.high.faces.get(view.high.faces.versionIds.indexOf(args.face));
  const V = ed.selection.hits.constructor; // placeholder
  const Vec = view.position.constructor;
  const dump = () => [...h.hits.entries()].map(([k, v]) => ({ key: k?.constructor?.name, vid: k?.versionId, val: v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, vv?.isVector3 ? vv.toArray() : vv?.constructor?.name ?? vv])) : v }));
  const out = {};
  const tries = {
    a: () => h.record(face, new Vec(...args.point)),
    b: () => h.record(face, new Vec(...args.point), new Vec(...args.normal)),
    c: () => h.record({ object: face, point: new Vec(...args.point) }),
    d: () => h.record(face, { point: new Vec(...args.point), normal: new Vec(...args.normal), intersected: face }),
  };
  for (const [k, f] of Object.entries(tries)) { h.clear(); try { out[k] = { ret: String(f()), map: dump(), cp: h.clickPoint?.toArray?.() ?? null, cn: h.clickNormal?.toArray?.() ?? null }; } catch (e) { out[k] = { err: String(e?.message ?? e).slice(0, 200), map: dump() }; } }
  h.clear();
  return out;
}
