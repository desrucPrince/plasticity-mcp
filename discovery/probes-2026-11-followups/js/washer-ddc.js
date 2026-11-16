async function (DDC, Dlg, args) {
  const ed = this, ex = ed.executor;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item; throw new Error('Unknown body ' + id); };
  const results = {};
  for (const trial of args.trials) {
    const item = find(args.bodyId);
    const view = item.view;
    const Vec = view.position.constructor;
    const faceOf = id => { const i = view.high.faces.versionIds.indexOf(id); return view.high.faces.get(i); };
    const kernelFace = fv => { const fs = item.model.GetFaces(); for (let i = 0; i < fs.Size(); i++) if (fs.Get(i).Id() === fv.entityId) return fs.Get(i); };
    const moving = faceOf(trial.faces[trial.faces.length - 1]);
    let point;
    if (trial.hit === 'any') { const p = kernelFace(moving).GetAnyPointOn().position; point = [p.x, p.y, p.z]; }
    else if (trial.hit === 'mid') { const p = kernelFace(moving).FindMidpoint().position; point = [p.x, p.y, p.z]; }
    const undo0 = ed.history.undoStack.length;
    ed.selection.selected.removeAll(); ed.selection.hits.clear();
    for (const id of trial.faces) ed.selection.selected.add(faceOf(id));
    ed.selection.hits.record(moving, new Vec(...point), new Vec(0, 0, 1));
    const command = new DDC(ed); command.remember = false;
    let execError = null, settled = false;
    const orig = command.execute.bind(command);
    command.execute = async function () { try { return await orig(); } catch (e) { execError = String(e?.message ?? e); throw e; } finally { ed.selection.selected.removeAll(); } };
    ed.exec(command).then(() => { settled = true; }, () => { settled = true; });
    let dialog = null; const dl = Date.now() + 2000;
    while (!dialog && !settled && Date.now() < dl) { ed.helpers.scene.traverse(o => { if (!dialog && o instanceof Dlg && o.params) dialog = o; }); if (!dialog) await sleep(10); }
    let ref = null;
    if (dialog) { ref = dialog.params.refDistance; dialog.params.distance = trial.distanceM; dialog.finish(); }
    const fd = Date.now() + 4000; while (!settled && Date.now() < fd) await sleep(10);
    if (!settled && ex.active) { ex.cancelActiveCommand(); const cd = Date.now() + 3000; while (!settled && Date.now() < cd) await sleep(10); }
    ed.selection.selected.removeAll(); ed.selection.hits.clear();
    const delta = ed.history.undoStack.length - undo0;
    results[trial.label] = { point, dialog: !!dialog, refDistance: ref, execError, settled, undoDelta: delta, active: ex.active?.command?.constructor?.name ?? null };
    if (delta > 0) { await ed.undo(); const ud = Date.now() + 3000; while (ed.history.undoStack.length > undo0 && Date.now() < ud) await sleep(20); }
  }
  return results;
}
