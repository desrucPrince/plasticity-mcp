async function (args) {
  const g = globalThis; const objs = g.__pickObjs;
  const show = v => v === null || v === undefined ? String(v) : v?.isVector3 ? 'V3(' + v.toArray().map(x => +x.toFixed(6)).join(',') + ')' : Array.isArray(v) ? '[' + v.length + ':' + v.slice(0,4).map(x => x?.constructor?.name ?? typeof x).join(',') + ']' : typeof v === 'object' ? (v.constructor?.name ?? 'obj') : typeof v === 'function' ? 'fn' : v;
  const fields = o => { const out = {}; if (!o) return null; for (const k of Object.keys(o)) { try { out[k] = show(o[k]); } catch (e) { out[k] = 'throws'; } } return out; };
  const protoKeys = o => { const out = []; let p = Object.getPrototypeOf(o); while (p && p !== Object.prototype) { out.push(p.constructor?.name + ':' + Object.getOwnPropertyNames(p).join(',')); p = Object.getPrototypeOf(p); } return out; };
  const dlg = objs.DDDlg?.[objs.DDDlg.length - 1];
  const cmd = g.__pickRun?.command;
  const out = { dlg: fields(dlg), cmd: fields(cmd) };
  // factory: find via command resources?
  const factory = (cmd && Object.values(cmd).find(v => v?.constructor?.name === 'DimensionDistanceFactory')) ?? null;
  out.factory = fields(factory);
  if (factory) { out.factoryGet = {}; for (const k of ['distance', 'to', 'direction', 'refDistance', 'containsRefEntity', 'clickPoint', 'length']) { try { out.factoryGet[k] = show(factory[k]); } catch (e) { out.factoryGet[k] = 'throws ' + e; } } }
  if (dlg) { out.dlgProto = protoKeys(dlg).slice(0, 3); const gz = Object.values(dlg).filter(v => v && typeof v === 'object' && /Input|Gizmo/.test(v.constructor?.name ?? '')); out.gizmos = gz.map(x => ({ cls: x.constructor.name, f: fields(x), proto: protoKeys(x).slice(0, 4) })); }
  // look for gizmos map in dialog fields
  for (const [k, v] of Object.entries(dlg ?? {})) if (v instanceof Map || Array.isArray(v)) out['dlg.' + k] = Array.from(v instanceof Map ? v.entries() : v).slice(0, 5).map(e => Array.isArray(e) ? e.map(show) : show(e));
  return out;
}
