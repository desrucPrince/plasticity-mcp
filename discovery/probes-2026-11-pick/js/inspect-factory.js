async function (args) {
  const g = globalThis; const objs = g.__pickObjs;
  const show = v => v === null || v === undefined ? String(v) : v?.isVector3 ? 'V3(' + v.toArray().map(x => +x.toFixed(6)).join(',') + ')' : Array.isArray(v) ? '[' + v.length + ']' : typeof v === 'object' ? (v.constructor?.name ?? 'obj') + (v.constructor === Object ? JSON.stringify(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'object' ? x?.constructor?.name : typeof x === 'function' ? 'fn' : x]))).slice(0, 300) : '') : typeof v === 'function' ? 'fn' : v;
  const fields = o => { const out = {}; if (!o) return null; for (const k of Object.keys(o)) { try { out[k] = show(o[k]); } catch (e) { out[k] = 'throws'; } } return out; };
  const dlg = objs.DDDlg?.[objs.DDDlg.length - 1];
  const f = dlg.params; const inp = dlg.distance;
  const get = {}; for (const k of ['distance', 'to', 'direction', 'refDistance', 'containsRefEntity', 'clickPoint', 'selection', 'originalItems', 'originalItem', 'state']) { try { get[k] = show(f[k]); } catch (e) { get[k] = 'throws ' + e; } }
  return { factoryFields: fields(f), get, dlgState: show(dlg.state), inputState: show(inp.state), inputOptions: show(inp.options), inputText: (() => { try { return inp.text; } catch (e) { return 'throws'; } })(), inputQuantity: (() => { try { return show(inp.quantity); } catch (e) { return 'throws'; } })(), inputEl: (() => { try { const el = inp.element; return { tag: el?.tagName, html: el?.outerHTML?.slice(0, 400), connected: el?.isConnected }; } catch (e) { return 'throws ' + e; } })(), cbSrc: String(inp.cb).slice(0, 80) };
}
