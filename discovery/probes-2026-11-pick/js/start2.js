// Like start.js but: clears hits, records a hit on the moving face, wraps execute to clear selection in finally.
async function (DDC, Dlg, args) {
  const ed = this; const g = globalThis;
  if (ed.executor.isBusy) throw new Error('busy before start');
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; throw new Error('Unknown body ' + id); };
  const view = find(args.bodyId);
  const faceOf = id => { const i = view.high.faces.versionIds.indexOf(id); if (i < 0) throw new Error('face ' + id); return view.high.faces.get(i); };
  ed.selection.selected.removeAll(); ed.selection.hits.clear();
  for (const id of args.faces) ed.selection.selected.add(faceOf(id));
  const Vec = view.position.constructor;
  if (args.hit) ed.selection.hits.record(faceOf(args.hit.face), new Vec(...args.hit.point), args.hit.normal ? new Vec(...args.hit.normal) : undefined);
  const command = new DDC(ed);
  const orig = command.execute.bind(command);
  command.execute = async function () { try { return await orig(); } finally { if (args.clearInFinally) ed.selection.selected.removeAll(); } };
  const run = { command, state: 'running', t0: Date.now() };
  g.__pickRun = run;
  run.promise = ed.exec(command).then(r => { run.state = 'resolved'; }, e => { run.state = 'rejected'; run.error = String(e?.message ?? e).slice(0, 300); });
  await new Promise(r => setTimeout(r, args.waitMs ?? 500));
  // locate the dialog without instrumentation: scene graph search
  const scenes = { helpersScene: ed.helpers?.scene, scene: ed.scene?.scene ?? ed.scene, gizmosScene: ed.gizmos?.scene };
  const found = {};
  for (const [k, s] of Object.entries(scenes)) { let hit = null; try { s?.traverse?.(o => { if (o instanceof Dlg) hit = o; }); } catch (e) { found[k] = 'err ' + e; continue; } found[k] = hit ? 'found' : (s?.traverse ? 'none' : 'no scene'); }
  const inputEl = document.querySelector('input.z-space-input-focused');
  return { state: run.state, error: run.error, cmdState: command.state, busy: ed.executor.isBusy, undo: ed.history.undoStack.length, found, helpersKeys: Object.keys(ed.helpers ?? {}), inputEl: !!inputEl, inputValue: inputEl?.value };
}
