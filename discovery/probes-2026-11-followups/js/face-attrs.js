function (args) {
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item; throw new Error('Unknown body ' + id); };
  const item = find(args.bodyId);
  const view = item.view;
  const idByEntity = new Map();
  for (let i = 0; i < view.high.faces.versionIds.length; i++) idByEntity.set(view.high.faces.get(i).entityId, view.high.faces.versionIds[i]);
  const fs = item.model.GetFaces();
  const faces = [];
  const showAttr = o => { try { return JSON.stringify(o, (k, v) => typeof v === 'bigint' ? String(v) : v).slice(0, 300); } catch (e) { return 'unser ' + Object.keys(o ?? {}).join(','); } };
  for (let i = 0; i < fs.Size(); i++) {
    const f = fs.Get(i);
    const rec = { kernelIndex: i, entity: f.Id(), id: idByEntity.get(f.Id()) };
    try { const a = f.GetAttributes(); rec.attrsType = a?.constructor?.name; rec.attrs = showAttr(a); rec.attrKeys = a ? Object.keys(a) : null; if (a?.Size) { rec.attrList = []; for (let j = 0; j < a.Size(); j++) { const x = a.Get(j); rec.attrList.push({ name: x?.constructor?.name, keys: Object.keys(x ?? {}), proto: Object.getOwnPropertyNames(Object.getPrototypeOf(x ?? {})).join(','), s: showAttr(x) }); } } } catch (e) { rec.attrs = 'ERR ' + e.message; }
    try { const s = f.GetSurface().surface; rec.surface = s?.constructor?.name; const info = s.GetInfo?.(); rec.infoKeys = info ? Object.keys(info) : null; rec.uv = info ? [info.uVertices, info.vVertices] : null; rec.surfProto = Object.getOwnPropertyNames(Object.getPrototypeOf(s)).join(','); if (info?.vertices || info?.controlPoints || info?.poles) { const arr = info.vertices ?? info.controlPoints ?? info.poles; rec.cpType = arr?.constructor?.name; rec.cpLen = arr?.length; rec.cpFirst = Array.from(arr).slice(0, 12); } } catch (e) { rec.surface = 'ERR ' + e.message; }
    faces.push(rec);
  }
  const viewOrder = Array.from(view.high.faces.versionIds);
  return { viewOrder, faces, cvs: Array.from(view.high?.cvs ?? []).map(cv => [cv.id, Math.round(cv.position.x * 1e6) / 1e3, Math.round(cv.position.y * 1e6) / 1e3, Math.round(cv.position.z * 1e6) / 1e3]) };
}
