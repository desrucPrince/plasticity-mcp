function (pk_default, OffsetVertexFactory, SplitSegmentFactory, args) {
  const k = pk_default.a ?? {};
  const out = {};
  out.kernelKeys = Object.keys(k).filter(n => /Oper|Context|Split|Imprint|Vertex|Edge/i.test(n)).slice(0, 80);
  const op = k.Operation;
  out.hasOperation = typeof op;
  if (op) {
    const names = new Set(); let p = op.prototype; while (p && p !== Object.prototype) { for (const n of Object.getOwnPropertyNames(p)) names.add(n); p = Object.getPrototypeOf(p); }
    out.opMethods = [...names].filter(n => /Split|Imprint|Vertex|Edge|Merge|Sew|Heal|Join/i.test(n));
    out.opStatic = Object.getOwnPropertyNames(op).filter(n => /Split|Imprint|Vertex|Edge/i.test(n));
  }
  const protoOf = C => { const r = []; let p = C?.prototype; while (p && p !== Object.prototype) { r.push((p.constructor?.name ?? '?') + ': ' + Object.getOwnPropertyNames(p).filter(x => x !== 'constructor').join(' ')); p = Object.getPrototypeOf(p); } return r.slice(0, 2); };
  out.offsetVertex = protoOf(OffsetVertexFactory);
  out.splitSegment = protoOf(SplitSegmentFactory);
  // Edge model methods
  for (const [v, item] of nativeApi.geo.geometryModel) {
    const view = item.view; if (!view?.high?.edges) continue;
    const e = nativeApi.db.lookupTopologyItem(view.high.edges.get(0));
    const names = new Set(); let p = Object.getPrototypeOf(e); while (p && p !== Object.prototype) { for (const n of Object.getOwnPropertyNames(p)) names.add(n); p = Object.getPrototypeOf(p); }
    out.edgeMethods = [...names].sort();
    const m = item.model ?? nativeApi.db.lookupTopologyItem?.(view);
    break;
  }
  return out;
}
