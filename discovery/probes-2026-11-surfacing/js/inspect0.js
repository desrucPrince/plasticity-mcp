function () {
  const bodies = [];
  for (const [versionId, item] of nativeApi.geo.geometryModel) bodies.push({ versionId, auto: nativeApi.geo.automatics.has(versionId), view: item.view?.constructor?.name, stable: nativeApi.db.lookupStableId(versionId) });
  const sh = this.shading;
  const own = o => { const r = {}; for (const k of Object.keys(o)) { const v = o[k]; r[k] = v === null || v === undefined ? String(v) : typeof v === 'object' ? (v.constructor?.name ?? 'object') : typeof v === 'function' ? 'fn' : v; } return r; };
  const protoNames = o => { const out = []; let p = Object.getPrototypeOf(o); while (p && p !== Object.prototype) { out.push(p.constructor?.name + ':' + Object.getOwnPropertyNames(p).filter(k => k !== 'constructor').join(',')); p = Object.getPrototypeOf(p); } return out; };
  return { bodies, shading: own(sh), shadingProto: protoNames(sh), mode: sh.mode, modeType: typeof sh.mode, modeOwn: sh.mode && typeof sh.mode === 'object' ? own(sh.mode) : null };
}
