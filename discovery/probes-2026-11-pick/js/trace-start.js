// Trace what a real command awaits after a programmatic selection (+ optional seeded click hit). Requires instrument.js.
// args: { command:'DimensionPolylineCommand'|..., select:[{kind:'body'|'face'|'segment'|'curveBody', bodyId, id?, index?}], hit:{kind, bodyId, id?, index?, point:[m], normal?}|null, waitMs }
async function (DDC, Other, args) {
  const ed = this; const g = globalThis;
  if (ed.executor.isBusy || ed.executor.active) throw new Error('busy before start: ' + ed.executor.active?.command?.constructor?.name);
  const B = { DDC };
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; throw new Error('Unknown body ' + id); };
  const resolve = s => {
    const view = find(s.bodyId);
    if (s.kind === 'body') return view;
    if (s.kind === 'face') return view.high.faces.get(view.high.faces.versionIds.indexOf(s.id));
    if (s.kind === 'edge') return view.high.edges.get(view.high.edges.versionIds.indexOf(s.id));
    if (s.kind === 'segment') { const segs = view.segments ?? view.underlying?.segments; return segs ? (segs.get ? segs.get(s.index ?? 0) : Array.from(segs)[s.index ?? 0]) : null; }
    if (s.kind === 'curveVertex') return Array.from(view._vertices ?? [])[s.index ?? 0] ?? null;
    throw new Error('kind ' + s.kind);
  };
  ed.selection.selected.removeAll(); ed.selection.hits.clear();
  for (const s of args.select) { const o = resolve(s); if (!o) throw new Error('unresolved ' + JSON.stringify(s)); ed.selection.selected.add(o); }
  const Vec = find(args.select[0].bodyId).position.constructor;
  if (args.hit) ed.selection.hits.record(resolve(args.hit), new Vec(...args.hit.point), args.hit.normal ? new Vec(...args.hit.normal) : undefined);
  const sel = { faces: ed.selection.selected.faces.size, solids: ed.selection.selected.solids.size, curves: ed.selection.selected.curves.size, segments: ed.selection.selected.segments?.size, edges: ed.selection.selected.edges.size, hits: ed.selection.hits.hits.size };
  const from = g.__pickLog.length;
  const Command = args.binding ? Other : args.command === 'DimensionDistanceCommand' ? DDC : (ed.commands[args.command] ?? null);
  if (!Command) throw new Error('no command class ' + args.command + '; editor.commands has: ' + Object.keys(ed.commands).filter(k => /Dimension/.test(k)).join(','));
  const command = new Command(ed);
  const run = { command, state: 'running' }; g.__pickRun = run;
  run.promise = ed.exec(command).then(() => { run.state = 'resolved'; }, e => { run.state = 'rejected'; run.error = String(e?.message ?? e); });
  await new Promise(r => setTimeout(r, args.waitMs ?? 600));
  let dialog = null; ed.helpers.scene.traverse(o => { if (!dialog && o.params && /Dialog/.test(o.constructor?.name ?? '')) dialog = o; });
  const f = dialog?.params;
  const show = v => v === null || v === undefined ? String(v) : v?.isVector3 ? v.toArray().map(x => +x.toFixed(6)) : Array.isArray(v) ? '[' + v.length + ']' : typeof v === 'object' ? v.constructor?.name : typeof v === 'function' ? 'fn' : v;
  return { sel, state: run.state, error: run.error, cmdState: command.state, active: ed.executor.active?.command?.constructor?.name ?? null,
    dialog: dialog?.constructor?.name ?? null, dialogGizmos: dialog ? (dialog.gizmos ?? []).map(x => x?.[0]?.constructor?.name ?? show(x)) : null,
    factory: f ? Object.fromEntries(Object.keys(f).filter(k => !['editor', 'changed', 'updated', 'refine', 'executor', '_state', 'partition', 'phantomPartition', 'temps', 'phantoms', 'diagnoses'].includes(k)).map(k => { try { return [k, show(f[k])]; } catch (e) { return [k, 'throws']; } })) : null,
    factoryClass: f?.constructor?.name ?? null,
    input: (() => { const el = document.querySelector('input.z-space-input-focused'); return el ? el.value : null; })(),
    log: g.__pickLog.slice(from).map(e => [e.ev, e.cls ?? '', (e.args ?? []).join(','), e.err ?? e.val ?? ''].join(' ').trim()) };
}
