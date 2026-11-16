// Extra wrappers: generic DimensionCommand.execute, Command.run/forward/embed, SpaceInput.execute/finish, executor.exec/enqueueDefaultCommand.
async function (DDC, args) {
  const g = globalThis; const ed = this;
  if (!g.__pickOrig) throw new Error('run instrument.js first');
  if (g.__pick2) return { already: true };
  g.__pick2 = true;
  const show = v => v === null || v === undefined ? String(v) : v?.isVector3 ? 'V3' : Array.isArray(v) ? '[' + v.length + ']' : typeof v === 'object' ? (v.constructor?.name ?? 'obj') : typeof v === 'function' ? (v.name || 'fn') : v;
  const wrap = (proto, key, label) => {
    const d = Object.getOwnPropertyDescriptor(proto, key); if (!d || typeof d.value !== 'function') return 0;
    g.__pickOrig.push([proto, key, d]); const orig = d.value;
    Object.defineProperty(proto, key, { ...d, value: function (...a) {
      const entry = { t: Date.now(), ev: label + '.' + key, cls: this?.constructor?.name, args: a.map(show) }; g.__pickLog.push(entry); (g.__pickObjs[label] ??= []).push(this);
      const r = orig.apply(this, a);
      if (r && typeof r.then === 'function') Promise.resolve(r).then(x => g.__pickLog.push({ t: Date.now(), ev: label + '.' + key + ':resolved', cls: this?.constructor?.name, val: show(x) }), e => g.__pickLog.push({ t: Date.now(), ev: label + '.' + key + ':rejected', cls: this?.constructor?.name, err: String(e?.message ?? e).slice(0, 200) }));
      return r; } });
    return 1;
  };
  let n = 0;
  const cmdP = Object.getPrototypeOf(DDC.prototype);
  for (const k of ['run', 'forward', 'embed', 'repeat']) n += wrap(cmdP, k, 'Cmd');
  n += wrap(ed.commands.DimensionCommand.prototype, 'execute', 'GenDim');
  const exP = Object.getPrototypeOf(ed.executor);
  for (const k of ['exec', 'enqueueDefaultCommand', 'cancelActiveCommand', 'execute', 'dequeue']) n += wrap(exP, k, 'Exec');
  // SpaceInput base: find via a dialog gizmo class prototype chain at runtime later; wrap PointPicker-like classes by name in bindings not available here.
  return { wrapped: n };
}
