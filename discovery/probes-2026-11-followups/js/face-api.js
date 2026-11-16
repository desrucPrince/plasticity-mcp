function (args) {
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item; throw new Error('Unknown body ' + id); };
  const item = find(args.bodyId);
  const view = item.view;
  const faces = view.high.faces;
  const names = o => { const out = []; let p = Object.getPrototypeOf(o); while (p && p !== Object.prototype) { out.push(p.constructor?.name + ':' + Object.getOwnPropertyNames(p).filter(k => k !== 'constructor').join(',')); p = Object.getPrototypeOf(p); } return out; };
  const fv = faces.get(0);
  const model = item.model;
  const mf = model.GetFaces();
  const f0 = mf.Get(0);
  return { faceViewKeys: Object.keys(fv), faceViewProto: names(fv), modelFaceProto: names(f0).map(s => s.slice(0, 3000)), facesCollectionProto: names(faces).map(s => s.slice(0, 600)) };
}
