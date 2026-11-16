// Select faces/bodies and start a real command without awaiting it. Stores command + exec promise on globalThis.__pickRun.
async function (DDC, args) {
  const ed = this; const g = globalThis;
  if (ed.executor.isBusy) throw new Error('busy before start');
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; throw new Error('Unknown body ' + id); };
  ed.selection.selected.removeAll();
  for (const s of args.select ?? []) {
    const view = find(s.bodyId);
    if (s.kind === 'body') ed.selection.selected.add(view);
    if (s.kind === 'face') nativeApi.selection.addFace(view.high.faces.get(view.high.faces.versionIds.indexOf(s.id)));
    if (s.kind === 'edge') nativeApi.selection.addEdge(view.high.edges.get(view.high.edges.versionIds.indexOf(s.id)));
  }
  const sel = { faces: ed.selection.selected.faces?.size, solids: ed.selection.selected.solids?.size, edges: ed.selection.selected.edges?.size, curves: ed.selection.selected.curves?.size };
  const Command = args.command === 'binding' ? DDC : ed.commands[args.command];
  const command = new Command(ed);
  const run = { command, state: 'running', t0: Date.now() };
  g.__pickRun = run;
  run.promise = ed.exec(command).then(r => { run.state = 'resolved'; run.result = String(r?.constructor?.name ?? r); }, e => { run.state = 'rejected'; run.error = String(e?.message ?? e).slice(0, 300); });
  await new Promise(r => setTimeout(r, args.waitMs ?? 800));
  return { sel, state: run.state, error: run.error, busy: ed.executor.isBusy, undo: ed.history.undoStack.length, cmdState: (() => { try { return command.state; } catch (e) { return 'throws'; } })() };
}
