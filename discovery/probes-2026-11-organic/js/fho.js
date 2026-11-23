function (pk_default, args) {
  const k = pk_default.a;
  const list = C => { const r = []; let p = C?.prototype; while (p && p !== Object.prototype) { r.push((p.constructor?.name) + ': ' + Object.getOwnPropertyNames(p).map(n => { const d = Object.getOwnPropertyDescriptor(p, n); return n + (d.get || d.set ? '{' + (d.get ? 'g' : '') + (d.set ? 's' : '') + '}' : ''); }).join(' ')); p = Object.getPrototypeOf(p); } return r; };
  const o = new k.FillHoleOptions();
  const vals = {}; let p = Object.getPrototypeOf(o); for (const n of Object.getOwnPropertyNames(p)) { const d = Object.getOwnPropertyDescriptor(p, n); if (d.get) { try { const v = o[n]; vals[n] = v && typeof v === 'object' ? (v.constructor?.name + (typeof v.Size === 'function' ? '#' + v.Size() : '')) : v; } catch (e) { vals[n] = 'ERR'; } } }
  return { fho: list(k.FillHoleOptions), vals, sheetFill: String(k.SheetBody.prototype.FillHole).slice(0, 300), fillDesc: Object.getOwnPropertyDescriptor(k.SheetBody.prototype, 'FillHole_async') ? 'own' : 'none', writable: Object.getOwnPropertyDescriptor(k.SheetBody.prototype, 'FillHole_async')?.writable };
}
