function (pk_default, args) {
  const k = pk_default.a ?? {};
  const out = {};
  out.names = Object.keys(k).filter(n => /Fill|Hole|Patch|Continuity/i.test(n));
  out.methods = {};
  for (const [n, C] of Object.entries(k)) {
    if (typeof C !== 'function') continue;
    const hits = [];
    for (const src of [C, C.prototype]) { if (!src) continue; for (const m of Object.getOwnPropertyNames(src)) if (/Fill|Hole|Patch/i.test(m)) hits.push((src === C ? 'static ' : '') + m); }
    if (hits.length) out.methods[n] = hits;
  }
  for (const n of out.names) { const C = k[n]; if (C && typeof C === 'object') out[n] = Object.fromEntries(Object.entries(C).filter(([a, b]) => typeof b === 'number')); else if (typeof C === 'function') { try { const o = new C(); out[n + '.fields'] = Object.keys(o); } catch (e) { out[n + '.fields'] = 'ctor ' + e.message; } } }
  return out;
}
