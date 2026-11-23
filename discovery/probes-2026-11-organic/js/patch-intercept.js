async function (Factory, Continuity, pk_default, args) {
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; throw new Error('no ' + id); };
  const editor = this; const log = { calls: [] };
  const k = pk_default.a;
  const describe = (v, depth = 0) => {
    if (v === null || v === undefined || typeof v !== 'object') return v;
    if (ArrayBuffer.isView(v)) return { typed: v.constructor.name, values: Array.from(v).slice(0, 40) };
    if (Array.isArray(v)) return v.slice(0, 40).map(x => depth < 3 ? describe(x, depth + 1) : String(x?.constructor?.name));
    const out = { ctor: v.constructor?.name };
    if (typeof v.Id === 'function') { try { out.Id = v.Id(); } catch {} }
    if (depth < 3) { for (const key of Object.keys(v).slice(0, 40)) out[key] = describe(v[key], depth + 1);
      let p = Object.getPrototypeOf(v); const acc = [];
      while (p && p !== Object.prototype) { for (const n of Object.getOwnPropertyNames(p)) { const d = Object.getOwnPropertyDescriptor(p, n); if (d.get) { try { acc.push([n, describe(v[n], depth + 1)]); } catch (e) { acc.push([n, 'ERR']); } } } p = Object.getPrototypeOf(p); }
      if (acc.length) out.accessors = Object.fromEntries(acc.slice(0, 40)); }
    return out;
  };
  const originals = [];
  const wrapMethod = (proto, name, label) => { const d = Object.getOwnPropertyDescriptor(proto, name); if (!d || !d.configurable) { log.notConfigurable = (log.notConfigurable ?? []).concat(label); return; } originals.push([proto, name, d]);
    Object.defineProperty(proto, name, { ...d, value: function (...a) { log.calls.push({ label, self: (() => { try { return this?.Id?.(); } catch { return null; } })(), args: a.map(x => describe(x)) }); return d.value.apply(this, a); } }); };
  const wrapSetter = (proto, name) => { const d = Object.getOwnPropertyDescriptor(proto, name); if (!d?.set || !d.configurable) { log.notConfigurable = (log.notConfigurable ?? []).concat(name); return; } originals.push([proto, name, d]);
    Object.defineProperty(proto, name, { ...d, set(v) { log.calls.push({ set: name, value: describe(v) }); return d.set.call(this, v); } }); };
  for (const cls of ['SheetBody', 'WireBody', 'RegionBody']) for (const m of ['FillHole', 'FillHole_async']) if (k[cls]?.prototype) wrapMethod(k[cls].prototype, m, cls + '.' + m);
  for (const n of ['FillPreference', 'Smoothness', 'InternalSmoothness', 'Topology', 'Method', 'Tolerance', 'Attach', 'SupportBodies', 'EdgesG0', 'EdgesG1', 'FillSheet']) wrapSetter(k.FillHoleOptions.prototype, n);
  log.wrapped = originals.length;
  try {
    const command = new editor.commands.PatchCommand(editor); command.remember = false;
    command.execute = async function () {
      try {
        const f = new Factory(editor).resource(this);
        const view = find(args.id); f.sheet = view;
        try { const sh = f._sheet; log.sheetShape = Object.keys(sh ?? {}); const model = sh?.model; log.modelCtor = model?.constructor?.name;
          if (model) sh.model = new Proxy(model, { get(t, key) { const v = Reflect.get(t, key, t); if (typeof v !== 'function') return v;
            return (...a) => { if (/Fill/.test(String(key))) { log.calls.push({ key: String(key), args: a.map(x => describe(x)) }); if (args.override) { const o = a.find(x => x?.constructor?.name === 'FillHoleOptions'); if (o) { const E = view => view; for (const [kk, vv] of Object.entries(args.override)) { if (kk === 'EdgesG0' || kk === 'EdgesG1') o[kk] = vv.map(i => a[0][i]); else o[kk] = vv; } log.overridden = describe(o); } } } return v.apply(t, a); }; } }); } catch (e) { log.proxyError = String(e.message); }
        const edge = e => view.high.edges.get(view.high.edges.versionIds.indexOf(e));
        const edges = args.edges.map(edge); f.edges = edges;
        if (args.continuity) f.continuity = Continuity[args.continuity];
        for (const [i, c] of (args.per ?? []).entries()) if (c) f.setContinuityForEdge(edges[i], Continuity[c]);
        log.map = Array.from(f.edge2continuity?.entries?.() ?? []).map(([kk, v]) => [String(kk?.versionId ?? kk), v]);
        if (args.commit) { const r = await f.commit(); log.committed = true; return r; }
        await f.update(); f.cancel(); throw new Error('PROBE_CANCEL');
      } catch (e) { log.error = String(e?.message ?? e); throw e; }
    };
    try { await editor.exec(command); } catch (e) { log.execError = String(e?.message ?? e); }
  } finally { for (const [proto, name, d] of originals) Object.defineProperty(proto, name, d); }
  return log;
}
