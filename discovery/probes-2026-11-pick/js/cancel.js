async function (args) {
  const ed = this; const g = globalThis; const run = g.__pickRun;
  const out = { had: !!run, stateBefore: run?.state };
  if (run && run.state === 'running') {
    try { run.command.cancel(); out.cancelled = true; } catch (e) { out.cancelErr = String(e?.message ?? e); }
    const deadline = Date.now() + 5000;
    while (run.state === 'running' && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  }
  out.stateAfter = run?.state; out.error = run?.error; out.busy = ed.executor.isBusy; out.undo = ed.history.undoStack.length;
  ed.selection.selected.removeAll();
  delete g.__pickRun;
  return out;
}
