// args: { bodyId, faceIds, show: true|false|null } -> runs TogglePointsCommand + ShowFacePointsFactory, dumps view.high.cvs.
async function (Factory, args) {
  const ed = this;
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; throw new Error('Unknown body ' + id); };
  const dump = view => Array.from(view.high?.cvs ?? []).map(cv => {
    const own = {};
    for (const key of Object.keys(cv)) { const v = cv[key]; own[key] = v === null || v === undefined ? v : typeof v === 'object' ? (v.constructor?.name ?? 'obj') + (v.x !== undefined ? '(' + [v.x, v.y, v.z].map(n => Math.round(n * 1e6) / 1e3).join(',') + ')' : '') : v; }
    return own;
  });
  const view0 = find(args.bodyId);
  const before = dump(view0);
  const undo0 = ed.history.undoStack.length;
  let failure = null, factorySnapshot = null;
  if (args.faceIds) {
    const command = new ed.commands.TogglePointsCommand(ed);
    command.remember = false;
    command.execute = async function () {
      try {
        const factory = new Factory(ed).resource(this);
        const view = find(args.bodyId);
        const resolve = id => { let i = view.high.faces.versionIds.indexOf(id); if (i < 0) { const suffix = id.slice(id.indexOf('f')); i = view.high.faces.versionIds.findIndex(v => String(v).endsWith(suffix)); } if (i < 0) throw new Error('face ' + id); return view.high.faces.get(i); };
        factory.faces = args.faceIds.map(resolve);
        if (args.show !== null && args.show !== undefined) factory.show = args.show;
        factorySnapshot = { show: factory.show };
        return await factory.commit();
      } catch (e) { failure = String(e?.message ?? e); throw e; }
    };
    try { await ed.exec(command); } catch (e) { failure = failure ?? String(e?.message ?? e); }
  }
  const view1 = find(args.bodyId);
  const cvsProto = view1.high?.cvs ? (() => { const out = []; let p = Object.getPrototypeOf(view1.high.cvs); while (p && p !== Object.prototype) { out.push(p.constructor?.name + ':' + Object.getOwnPropertyNames(p).filter(k => k !== 'constructor').join(',')); p = Object.getPrototypeOf(p); } return out; })() : null;
  const cvProto = (() => { const cv = Array.from(view1.high?.cvs ?? [])[0]; if (!cv) return null; const out = []; let p = Object.getPrototypeOf(cv); while (p && p !== Object.prototype) { out.push(p.constructor?.name + ':' + Object.getOwnPropertyNames(p).filter(k => k !== 'constructor').join(',')); p = Object.getPrototypeOf(p); } return out; })();
  const cvs = view1.high?.cvs;
  let groupInfo = null;
  try {
    groupInfo = { ids: cvs?.ids ? Array.from(cvs.ids).slice(0, 64) : null, length: cvs?.length,
      segments: Array.from(cvs ?? []).map(cv => { try { const s = cvs.segment(cv.id); return s === undefined ? 'undef' : (s?.constructor?.name ?? typeof s) + ':' + JSON.stringify(typeof s === 'object' ? Object.keys(s).slice(0, 8) : s); } catch (e) { return 'ERR ' + String(e.message).slice(0, 80); } }),
      getIds: Array.from(cvs ?? []).map(cv => { try { return cvs.getId(cv.id); } catch (e) { return 'ERR ' + String(e.message).slice(0, 60); } }),
      lookup0: (() => { try { const r = cvs.lookup(0); return r?.constructor?.name ?? String(r); } catch (e) { return 'ERR ' + String(e.message).slice(0, 80); } })(),
      segmentSrc: String(cvs?.segment).slice(0, 400), getIdSrc: String(cvs?.getId).slice(0, 300), lookupSrc: String(cvs?.lookup).slice(0, 300) };
  } catch (e) { groupInfo = 'ERR ' + e.message; }
  return { groupInfo, undoDelta: ed.history.undoStack.length - undo0, failure, factorySnapshot, sameView: view0 === view1, faceIds: Array.from(view1.high.faces.versionIds), before: before.length, after: dump(view1), cvsProto, cvProto, cvsKeys: view1.high?.cvs ? Object.keys(view1.high.cvs) : null };
}
