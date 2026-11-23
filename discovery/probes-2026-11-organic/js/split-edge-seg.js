async function (Factory, Command, args) {
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; throw new Error('no ' + id); };
  const editor = this; const log = {};
  const view = find(args.id);
  const idx = view.high.edges.versionIds.indexOf(args.edgeId);
  const edgeView = view.high.edges.get(idx);
  log.edgeView = edgeView?.constructor?.name;
  let failure;
  const command = new Command(editor); command.remember = false;
  command.execute = async function () {
    try {
      const f = new Factory(editor).resource(this);
      try { f.edge = edgeView; log.setEdge = 'ok'; } catch (e) { log.setEdge = String(e.message); }
      try { const e = f._edge; log.underscoreEdge = typeof e === 'function' ? 'fn' : Object.keys(e ?? {}); log.underscoreEdgeModel = e?.model?.constructor?.name; } catch (e) { log.ue = String(e.message); }
      try { log.parentItem = f.parentItem?.constructor?.name; log.originalItem = f.originalItem?.constructor?.name; } catch (e) { log.pi = String(e.message); }
      const model = f._edge?.model;
      if (model && args.mode !== 'plain') f._edge.model = new Proxy(model, { get(t, k) { if (k === 'SplitAt') return () => { log.splitAtCalled = true; return t.SplitAt(args.t); }; const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v; } });
      if (!args.commit) { f.cancel(); throw new Error('PROBE_CANCEL'); }
      const r = await f.commit(); log.result = Array.isArray(r) ? r.map(x => x?.constructor?.name) : r?.constructor?.name; return r;
    } catch (e) { failure = e; log.error = String(e?.message ?? e); log.stack = String(e?.stack ?? '').slice(0, 600); throw e; }
  };
  try { await editor.exec(command); } catch (e) { log.execError = String(e?.message ?? e); }
  return log;
}
