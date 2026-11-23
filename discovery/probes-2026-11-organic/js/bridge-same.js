async function (Factory, Vector, BlendShape, BlendTrim, args) {
  const Command = this.commands.BridgeSurfaceCommand;
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; throw new Error('no ' + id); };
  const editor = this; const log = {};
  const face = ref => { const view = find(ref.bodyId); const i = view.high.faces.versionIds.indexOf(ref.faceId); if (i < 0) throw new Error('face ' + ref.faceId); return view.high.faces.get(i); };
  const command = new Command(editor); command.remember = false;
  command.execute = async function () {
    try {
      const f = new Factory(editor).resource(this);
      f.shape = BlendShape.G2; f.trimBlend = BlendTrim.Both; f.trimWalls = true; f.propagate = args.propagate ?? true;
      f.width = args.width; f.softness = 1;
      for (const [k, v] of Object.entries(args.set ?? {})) f[k] = v;
      f.push(face(args.faces[0]), !!args.flip?.[0], new Vector(...args.picks[0]));
      f.push(face(args.faces[1]), !!args.flip?.[1], new Vector(...args.picks[1]));
      log.enough = f.hasEnoughPoints; log.orig = (f.originalItems ?? []).map(x => x?.constructor?.name);
      if (!args.commit) { await f.update(); log.updated = true; f.cancel(); throw new Error('PROBE_CANCEL'); }
      const r = await f.commit(); log.result = Array.isArray(r) ? r.map(x => x?.constructor?.name) : r?.constructor?.name; return r;
    } catch (e) { log.error = String(e?.message ?? e); log.stack = String(e?.stack ?? '').slice(0, 500); throw e; }
  };
  try { await editor.exec(command); } catch (e) { log.execError = String(e?.message ?? e); }
  return log;
}
