async function (args) {
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; throw new Error('Unknown body ' + id); };
  const view = find(args.bodyId);
  const show = v => v === null || v === undefined ? String(v) : Array.isArray(v) ? '[' + v.length + ']' : typeof v === 'object' ? v.constructor?.name : typeof v === 'function' ? 'fn' : v;
  const fields = o => o && Object.fromEntries(Object.keys(o).filter(k => !/^(matrix|up|layers|quaternion|rotation|scale|uuid|is|cast|receive|frustum|render|animations|custom|static|userData|pivot|matrixWorld)/.test(k)).map(k => [k, show(o[k])]));
  const out = { cls: view.constructor.name, fields: fields(view) };
  for (const k of ['underlying', 'segments', 'line', 'points']) if (view[k]) { out[k] = fields(view[k]); out[k + 'Cls'] = view[k].constructor?.name; }
  const segs = view.segments ?? view.underlying?.segments;
  if (segs) { out.segs = Array.from(segs.children ?? segs).slice(0, 4).map(s => ({ cls: s.constructor.name, f: fields(s) })); out.segsProto = Object.getOwnPropertyNames(Object.getPrototypeOf(segs)).slice(0, 30); }
  return out;
}
