function (args) {
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; throw new Error('no ' + id); };
  const view = find(args.id);
  const names = o => { const s = new Set(); let p = Object.getPrototypeOf(o); while (p && p !== Object.prototype) { for (const n of Object.getOwnPropertyNames(p)) s.add(n); p = Object.getPrototypeOf(p); } return [...s].sort(); };
  const fi = view.high.faces.versionIds.indexOf(args.faceId);
  const face = nativeApi.db.lookupTopologyItem(view.high.faces.get(fi));
  const out = { face: names(face) };
  try { const s = face.GetSurface(); out.surfaceRet = Object.keys(s ?? {}); const surf = s?.surface ?? s; out.surface = names(surf); out.surfCtor = surf?.constructor?.name; } catch (e) { out.surfErr = String(e.message); }
  try { out.uvbox = face.GetUVBox?.(); } catch (e) { out.uvboxErr = String(e.message); }
  return out;
}
