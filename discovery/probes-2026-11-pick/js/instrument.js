// Installs call logging on picker/dialog/factory prototypes. Idempotent. Stores originals in globalThis.__pickOrig.
async function (DDC, DDF, Dlg, PP, args) {
  const g = globalThis;
  if (g.__pickOrig) return { already: true };
  g.__pickLog = []; g.__pickOrig = []; g.__pickObjs = {};
  const show = v => v === null || v === undefined ? String(v) : v?.isVector3 ? 'V3(' + v.toArray().map(x => +x.toFixed(5)).join(',') + ')' : Array.isArray(v) ? '[' + v.length + ']' : typeof v === 'object' ? (v.constructor?.name ?? 'obj') : typeof v === 'function' ? 'fn' : v;
  const wrap = (proto, key, label) => {
    const d = Object.getOwnPropertyDescriptor(proto, key);
    if (!d) return;
    g.__pickOrig.push([proto, key, d]);
    if (typeof d.value === 'function') {
      const orig = d.value;
      Object.defineProperty(proto, key, { ...d, value: function (...a) {
        const entry = { t: Date.now(), ev: label + '.' + key, cls: this?.constructor?.name, args: a.map(show) };
        g.__pickLog.push(entry);
        (g.__pickObjs[label] ??= []).push(this);
        let r;
        try { r = orig.apply(this, a); } catch (e) { entry.threw = String(e?.message ?? e).slice(0, 200); throw e; }
        if (r && typeof r.then === 'function') { entry.async = true; Promise.resolve(r).then(x => g.__pickLog.push({ t: Date.now(), ev: label + '.' + key + ':resolved', val: show(x) }), e => g.__pickLog.push({ t: Date.now(), ev: label + '.' + key + ':rejected', err: String(e?.message ?? e).slice(0, 200) })); }
        else entry.ret = show(r);
        return r;
      } });
    } else if (d.set || d.get) {
      Object.defineProperty(proto, key, { ...d,
        set: d.set && function (v) { g.__pickLog.push({ t: Date.now(), ev: label + '.' + key + '=', val: show(v) }); return d.set.call(this, v); } });
    }
  };
  const protoChain = (cls) => { const out = []; let p = cls.prototype; while (p && p !== Object.prototype) { out.push(p); p = Object.getPrototypeOf(p); } return out; };
  const [ddcP, cmdP, regP] = protoChain(DDC);
  for (const k of ['execute']) wrap(ddcP, k, 'DDC');
  for (const k of ['finish', 'cancel', 'interrupt', 'register']) wrap(regP, k, 'Reg');
  const fchain = protoChain(DDF);
  for (const k of ['distance', 'calculate', 'selection']) wrap(fchain[0], k, 'DDF');
  for (const k of ['collection']) wrap(fchain[1], k, 'DimF');
  for (const k of ['update', 'commit', 'cancel']) wrap(fchain[2], k, 'GeoF');
  const dchain = protoChain(Dlg);
  for (const k of ['prepare', 'execute']) wrap(dchain[0], k, 'DDDlg');
  for (const k of ['prepare', 'addGizmo', 'execute', 'finish', 'cancel']) wrap(dchain[1], k, 'SpaceDlg');
  for (const k of ['execute', 'addPickedPoint', 'restrictToFaces', 'restrictToEdges', 'restrictToPlane', 'restrictToLine', 'addSnap', 'onClick', 'onHover']) wrap(PP.prototype, k, 'PP');
  return { installed: g.__pickOrig.length };
}
