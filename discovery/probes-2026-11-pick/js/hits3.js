async function (args) {
  const ed = this; const h = ed.selection.hits;
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; throw new Error('Unknown body ' + id); };
  const pt = () => h.clickPoint ? h.clickPoint.toArray() : null;
  const out = { before: { size: h.hits.size, cp: pt() } };
  ed.selection.selected.removeAll(); out.afterRemoveAll = { size: h.hits.size, cp: pt() };
  h.clear(); out.afterClear = { size: h.hits.size, cp: pt() };
  const view = find(args.bodyId);
  for (const id of args.faces) ed.selection.selected.add(view.high.faces.get(view.high.faces.versionIds.indexOf(id)));
  out.afterAdd = { size: h.hits.size, cp: pt(), faces: ed.selection.selected.faces.size };
  ed.selection.selected.removeAll();
  out.lens = { record: h.record.length, click: h.click.length, keep: h.keep.length, get: h.get.length, copy: h.copy.length };
  return out;
}
