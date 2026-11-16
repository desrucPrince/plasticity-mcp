// Runs the REAL DimensionDistanceCommand with a programmatic selection plus a seeded selection click point
// (editor.selection.hits.record), drives its DimensionDistanceSpaceDialog, and waits for the command to finish.
// this = editor. Bindings: DimensionDistanceCommand, DimensionDistanceSpaceDialog. Units: native meters.
// args: { bodyId, faces:[refFaceId, movingFaceId], hit:{face, point:[m], normal:[..]}|null, mode:'factory'|'keys'|'hang',
//         distanceM, text, dialogTimeoutMs, finishTimeoutMs, hangMs }
async function (DDC, Dlg, args) {
  const ed = this;
  const ex = ed.executor;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const env = () => ({ hasFocus: document.hasFocus(), visibility: document.visibilityState });
  const activeName = () => ex.active?.command?.constructor?.name ?? null;
  const inputLeft = () => !!document.querySelector('input.z-space-input-focused');
  if (ex.isBusy || ex.active) throw new Error('Plasticity is busy: ' + activeName());
  const undo0 = ed.history.undoStack.length;
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; throw new Error('Unknown body ' + id); };
  const view = find(args.bodyId);
  const faceOf = id => { const i = view.high.faces.versionIds.indexOf(id); if (i < 0) throw new Error('Unknown face ' + id); return view.high.faces.get(i); };
  const Vec = view.position.constructor;
  const out = { env0: env(), undo0, timeline: [] };
  const mark = (ev, extra) => out.timeline.push({ ms: Date.now() - t0, ev, ...extra });
  const t0 = Date.now();

  ed.selection.selected.removeAll();
  ed.selection.hits.clear();
  for (const id of args.faces) ed.selection.selected.add(faceOf(id));
  if (args.hit) ed.selection.hits.record(faceOf(args.hit.face), new Vec(...args.hit.point), args.hit.normal ? new Vec(...args.hit.normal) : undefined);

  const command = new DDC(ed);
  command.remember = false;
  let execError = null;
  const original = command.execute.bind(command);
  // Clearing the selection before execute() returns stops the executor from chaining the default command for the
  // still-selected faces (PushFace -> OffsetFace), which would keep ed.exec() pending.
  command.execute = async function () {
    try { return await original(); }
    catch (error) { execError = String(error?.message ?? error); throw error; }
    finally { ed.selection.selected.removeAll(); }
  };
  let settled = false, execRejected = null;
  const execP = ed.exec(command).then(() => { settled = true; }, e => { settled = true; execRejected = String(e?.message ?? e); });
  mark('exec started');

  // Wait for the space dialog (found through the helpers scene; no prototype patching).
  let dialog = null;
  const dialogDeadline = Date.now() + (args.dialogTimeoutMs ?? 2000);
  while (!dialog && !settled && Date.now() < dialogDeadline) {
    ed.helpers.scene.traverse(o => { if (!dialog && o instanceof Dlg && o.params) dialog = o; });
    if (!dialog) await sleep(10);
  }
  mark(dialog ? 'dialog found' : 'no dialog', { commandState: command.state, settled, execError });

  const cancel = async (why) => {
    mark('cancel: ' + why, { active: activeName() });
    if (ex.active) ex.cancelActiveCommand();
    const d = Date.now() + 3000;
    while (!settled && Date.now() < d) await sleep(10);
  };

  if (dialog) {
    const f = dialog.params;
    const v3 = v => v?.toArray ? v.toArray() : v;
    out.factoryAtDialog = { clickPoint: v3(f.clickPoint), to: v3(f.to), direction: v3(f.direction), refDistance: f.refDistance, distance: f.distance, containsRefEntity: f.containsRefEntity, refEntity: f.refEntity?.constructor?.name };
    if (args.mode === 'factory') {
      f.distance = args.distanceM;
      mark('factory.distance set', { distance: f.distance });
      dialog.finish();
      mark('dialog.finish called');
    } else if (args.mode === 'keys') {
      const input = dialog.distance;
      const el = input.element;
      el.value = args.text;
      const last = args.text.at(-1);
      el.dispatchEvent(new KeyboardEvent('keydown', { key: last, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: last, bubbles: true }));
      const d = Date.now() + 2000;
      while (Math.abs(f.distance - args.distanceM) > 1e-9 && Date.now() < d) await sleep(10);
      mark('typed', { distance: f.distance, currentText: input.state?.currentText });
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
      mark('enter dispatched');
    } else if (args.mode === 'hang') {
      f.distance = args.distanceM;
      await f.update();
      mark('preview updated, not finishing', { distance: f.distance, undo: ed.history.undoStack.length });
      await sleep(args.hangMs ?? 1000);
    }
    const finishDeadline = Date.now() + (args.finishTimeoutMs ?? 5000);
    while (!settled && Date.now() < finishDeadline) await sleep(10);
    if (!settled) await cancel('finish timeout');
  } else if (!settled) {
    await cancel('dialog timeout');
  }
  await execP.catch(() => {});
  ed.selection.selected.removeAll();
  ed.selection.hits.clear();
  out.end = { settled, execError, execRejected, commandState: command.state, active: activeName(), inputLeft: inputLeft(), busy: ex.isBusy, undo: ed.history.undoStack.length, undoDelta: ed.history.undoStack.length - undo0, ms: Date.now() - t0, env: env() };
  return out;
}
