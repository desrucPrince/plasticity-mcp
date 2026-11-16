async function (args) {
  const ed = this; const m = ed.selection.mode;
  const snap = () => ({ keys: Object.keys(m), set: m.set ? Array.from(m.set) : null, arr: (() => { try { return Array.from(m); } catch (e) { return null; } })(), proto: Object.getOwnPropertyNames(Object.getPrototypeOf(m)) });
  const out = { before: snap() };
  if (args.event) { window.dispatchEvent(new CustomEvent(args.event)); await new Promise(r => setTimeout(r, 100)); out.after = snap(); }
  return out;
}
