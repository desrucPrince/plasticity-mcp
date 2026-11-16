async function (name2shader, args) {
  const show = v => v === null || v === undefined ? String(v) : typeof v === 'object' ? (v.constructor?.name ?? 'object') + (v.name ? ':' + v.name : '') : typeof v === 'function' ? 'fn:' + v.name : v;
  const sh = this.shading;
  const P = Object.getPrototypeOf(sh);
  const info = { setShaderLen: P.setShader.length, setMatcapLen: P.setMatcap.length, isUsingShaderLen: P.isUsingShader.length, restoreLen: P.restoreFromMemento.length };
  const mem = sh.saveToMemento();
  info.memShaderProps = JSON.stringify(mem.shaderProperties).slice(0, 600);
  const undo0 = this.history.undoStack.length;
  const trials = [];
  for (const arg of args.tries) {
    const t = { arg };
    try {
      const value = arg.kind === 'name' ? arg.v : name2shader[arg.v];
      const r = sh.setShader(value);
      t.ret = show(r);
      t.shader = show(sh.shader); t.tag = sh.mode.tag; t.usingZ = sh.isUsingShader(arg.v);
      t.modeMaterials = Object.keys(sh.mode.materials ?? {}).map(k => k + '=' + show(sh.mode.materials[k]));
    } catch (e) { t.error = String(e.message).slice(0, 300); }
    t.undo = this.history.undoStack.length;
    trials.push(t);
    sh.restoreFromMemento(mem);
    t.afterRestore = { shader: show(sh.shader), tag: sh.mode.tag };
  }
  return { info, undo0, trials, final: { shader: show(sh.shader), tag: sh.mode.tag, undo: this.history.undoStack.length } };
}
