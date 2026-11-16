async function (DDC, args) {
  const ed = this; const c = new DDC(ed);
  const show = v => v === null || v === undefined ? String(v) : v?.isVector3 ? 'V3(' + v.toArray().map(x => +x.toFixed(6)).join(',') + ')' : Array.isArray(v) ? '[' + v.length + ':' + v.slice(0, 3).map(x => x?.constructor?.name).join(',') + ']' : typeof v === 'object' ? v.constructor?.name : v;
  const out = {};
  for (const k of ['hits', 'clickPoint', 'clickNormal', 'title', 'identifier']) { try { out[k] = show(c[k]); } catch (e) { out[k] = 'throws ' + e; } }
  const cmdProto = Object.getPrototypeOf(DDC.prototype);
  out.descr = Object.fromEntries(['hits', 'clickPoint', 'clickNormal'].map(k => { const d = Object.getOwnPropertyDescriptor(cmdProto, k); return [k, d ? (d.get ? 'get' : '') + (d.set ? 'set' : '') + (typeof d.value) : 'none']; }));
  out.editorClick = Object.keys(ed.click ?? {}); out.editorHover = Object.keys(ed.hover ?? {});
  out.clickProto = Object.getOwnPropertyNames(Object.getPrototypeOf(ed.click ?? {}));
  const h = c.hits; if (Array.isArray(h) && h[0]) out.hit0 = Object.fromEntries(Object.entries(h[0]).map(([k, v]) => [k, show(v)]));
  out.selectedKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(ed.selection.selected)).slice(0, 80);
  return out;
}
