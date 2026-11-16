(async () => {
  const g = globalThis; const ed = g.__pickRun.command.editor; const run = g.__pickRun; const el = g.__pickObjs.DDDlg.at(-1).distance.element;
  const u0 = ed.history.undoStack.length;
  const kd = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
  el.dispatchEvent(kd);
  el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  const deadline = Date.now() + 5000;
  while (run.state === 'running' && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  await new Promise(r => setTimeout(r, 200));
  return { state: run.state, error: run.error, result: run.result, u0, u1: ed.history.undoStack.length, busy: ed.executor.isBusy, ms: Date.now() - (deadline - 5000), log: g.__pickLog.slice(-12).map(e => e.ev + (e.err ? ' ERR ' + e.err : '') + (e.val !== undefined ? ' ' + e.val : '')) };
})()
