async function (args) {
  const ed = this; const h = ed.selection.hits;
  const show = v => v === null || v === undefined ? String(v) : v?.isVector3 ? 'V3(' + v.toArray().map(x => +x.toFixed(6)).join(',') + ')' : Array.isArray(v) ? '[' + v.length + ']' : v instanceof Map ? 'Map(' + v.size + ')' : typeof v === 'object' ? v.constructor?.name : typeof v === 'function' ? 'fn' : v;
  const fields = o => o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).slice(0, 30).map(k => { try { return [k, show(o[k])]; } catch (e) { return [k, 'throws']; } })) : show(o);
  return { entries: [...h.hits.entries()].map(([k, v]) => ({ key: show(k), keyFields: fields(k), val: fields(v), valInner: v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, fields(vv)])) : null })), clickPoint: show(h.clickPoint), clickNormal: show(h.clickNormal) };
}
