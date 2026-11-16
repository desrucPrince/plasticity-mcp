async function (DDC, args) {
  const ed = this; const c = new DDC(ed); const h = c.hits;
  const show = v => v === null || v === undefined ? String(v) : v?.isVector3 ? 'V3(' + v.toArray().map(x => +x.toFixed(6)).join(',') + ')' : Array.isArray(v) ? '[' + v.length + ']' : v instanceof Map ? 'Map(' + v.size + ')' : typeof v === 'object' ? v.constructor?.name : typeof v === 'function' ? 'fn' : v;
  const chain = o => { const out = []; let p = Object.getPrototypeOf(o); while (p && p !== Object.prototype) { out.push(p.constructor?.name + ':' + Object.getOwnPropertyNames(p).join(',')); p = Object.getPrototypeOf(p); } return out; };
  const fields = o => o && Object.fromEntries(Object.keys(o).map(k => { try { return [k, show(o[k])]; } catch (e) { return [k, 'throws']; } }));
  const out = { hits: fields(h), hitsChain: chain(h) };
  // look for a hits store on editor/selection
  for (const [k, v] of Object.entries(ed.selection)) out['selection.' + k] = show(v);
  const owner = Object.values(h).find(v => v && typeof v === 'object' && v.constructor?.name !== 'Editor');
  if (owner) { out.inner = fields(owner); out.innerChain = chain(owner).slice(0, 2); }
  return out;
}
