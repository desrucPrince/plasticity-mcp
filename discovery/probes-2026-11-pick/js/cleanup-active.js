(async () => { const g = globalThis; const ed = g.__pickRun?.command?.editor; const run = g.__pickRun; const ex = ed.executor;
  const before = { active: ex.active?.command?.constructor?.name, run: run?.state };
  ed.selection.selected.removeAll();
  try { ex.cancelActiveCommand(); } catch (e) { before.cancelErr = String(e); }
  const deadline = Date.now() + 3000;
  while (run && run.state === 'running' && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  await new Promise(r => setTimeout(r, 300));
  return { before, after: { active: ex.active?.command?.constructor?.name ?? null, run: run?.state, err: run?.error, undo: ed.history.undoStack.length, busy: ex.isBusy, sel: ed.selection.selected.faces.size }, log: g.__pickLog.slice(-8).map(e => e.ev + ' ' + (e.cls ?? '') + ' ' + (e.args ?? []).join(',')) };
})()
