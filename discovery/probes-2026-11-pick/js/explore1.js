async function (DDC, DDF, Dlg, PP, args) {
  const ed = this;
  const fnSrc = f => { try { return String(f).slice(0, 300); } catch (e) { return 'err ' + e; } };
  const chain = (o) => { const out = []; let p = o; while (p && p !== Object.prototype) { out.push({ name: p.constructor?.name, keys: Object.getOwnPropertyNames(p).slice(0, 80) }); p = Object.getPrototypeOf(p); } return out; };
  return {
    undo: ed.history.undoStack.length, busy: ed.executor.isBusy,
    editorKeys: Object.keys(ed).slice(0, 200),
    ddcExecute: fnSrc(DDC.prototype.execute),
    ddcChain: chain(DDC.prototype),
    ddfChain: chain(DDF.prototype),
    dlgChain: chain(Dlg.prototype),
    ppChain: chain(PP.prototype),
  };
}
