(async () => { const g = globalThis; const run = g.__pickRun; const ed = run.command.editor; const ex = ed.executor;
  const how = HOW;
  const before = { state: run.state, cmd: run.command.state, active: ex.active?.command?.constructor?.name ?? null, undo: ed.history.undoStack.length };
  const t0 = Date.now();
  if (how === 'cancelActiveCommand') ex.cancelActiveCommand();
  if (how === 'command.cancel') run.command.cancel();
  if (how === 'escape') { const el = document.querySelector('input.z-space-input-focused'); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true })); }
  if (how === 'abortEvent') window.dispatchEvent(new CustomEvent('command:abort'));
  const deadline = Date.now() + 3000;
  while (run.state === 'running' && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  await new Promise(r => setTimeout(r, 200));
  return { how, before, after: { state: run.state, error: run.error, cmd: run.command.state, active: ex.active?.command?.constructor?.name ?? null, undo: ed.history.undoStack.length, busy: ex.isBusy, sel: ed.selection.selected.faces.size, dialogLeft: !!document.querySelector('input.z-space-input-focused') }, ms: Date.now() - t0 };
})()
