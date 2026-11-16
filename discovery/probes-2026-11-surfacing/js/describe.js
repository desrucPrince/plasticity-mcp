function (...bound) {
  const args = bound.pop();
  const show = v => v === null || v === undefined ? String(v) : typeof v === 'object' ? (v.constructor?.name ?? 'object') + (Array.isArray(v) ? '[' + v.length + ']' : '') : typeof v === 'function' ? 'fn' + v.length : (typeof v === 'number' || typeof v === 'boolean' ? v : String(v).slice(0, 60));
  const out = {};
  bound.forEach((cls, i) => {
    const name = args.names[i];
    if (typeof cls !== 'function') { out[name] = { exists: false, value: show(cls), own: cls && typeof cls === 'object' ? Object.fromEntries(Object.entries(cls).slice(0, 40).map(([k, v]) => [k, show(v)])) : null }; return; }
    const chain = []; let p = cls.prototype;
    while (p && p !== Object.prototype) { const e = { name: p.constructor?.name, methods: [], accessors: [] }; for (const k of Object.getOwnPropertyNames(p)) { if (k === 'constructor') continue; const d = Object.getOwnPropertyDescriptor(p, k); if (d.get || d.set) e.accessors.push(k + (d.get ? 'g' : '') + (d.set ? 's' : '')); else if (typeof d.value === 'function') e.methods.push(k + '/' + d.value.length); } chain.push(e); if (['AbstractFactory', 'GeometryFactory', 'Command'].includes(e.name)) break; p = Object.getPrototypeOf(p); }
    let own = null;
    if (args.instantiate.includes(name)) { try { const inst = new cls(this); own = {}; for (const k of Object.keys(inst)) own[k] = show(inst[k]); const acc = {}; for (const e of chain) for (const a of e.accessors) { const k = a.replace(/[gs]+$/, ''); if (a.endsWith('g') || a.endsWith('gs')) { try { acc[k] = show(inst[k]); } catch (er) { acc[k] = 'err'; } } } own.__accessorValues = acc; } catch (e) { own = 'err ' + e.message; } }
    out[name] = { chain, own, statics: Object.getOwnPropertyNames(cls).filter(k => !['length', 'name', 'prototype'].includes(k)) };
  });
  return out;
}
